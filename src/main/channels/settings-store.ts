// channels 配置存取：userData/channels-settings.json
//
// 照 index.ts 的 GeneralSettings 模式：load / save / normalize 三件套。
// 唯一碰 electron（app.getPath）。
//
// 字段安全分级：
//   - 公开字段（开关、端口、白名单）：明文存
//   - 私密字段（飞书 AppSecret/Token/Encrypt Key）：加密落盘。
//
// 加密策略（按优先级）：
//   1. safeStorage（OS 钥匙串：Windows DPAPI / macOS Keychain / Linux libsecret）
//      → 存储前缀 `enc:<base64>`
//   2. safeStorage 不可用时（headless / 沙盒 / libsecret 没装）：用机器指纹 XOR 混淆
//      → 存储前缀 `obf:<base64>` —— 不是真加密，但能挡住 cat / grep 这种偷窥
//
// 为什么这样：
//   - 单纯回退到明文会让"重启后 secret 丢失"成为静默 bug（用户根本不知道）
//   - 混淆虽然不抗逆向，但保证 secret 至少能 round-trip（重启后能恢复）
//   - 如果将来发现 safeStorage 不可用且用户在意安全，加一个设置项让他们输口令加密
import * as fs from "fs";
import * as path from "path";
import { app, safeStorage } from "electron";
import type { ChannelId } from "./types";
import { normalizeQqListenMode, type QqListenMode } from "../../shared/qq-listen";

/** safeStorage 加密后的前缀。读取时遇到这个前缀就解密 */
const ENC_PREFIX = "enc:";
/** base64 混淆前缀（safeStorage 不可用时的兜底，可 round-trip 但不抗逆向） */
const OBF_PREFIX = "obf:";
/** 明文兜底标记（旧版数据迁移用） */
const PLAIN_PREFIX = "plain:";

/** 检测当前环境 safeStorage 是否可用。Linux 无 DISPLAY 时不可用。 */
let safeStorageAvailable: boolean | null = null;
function isSafeStorageAvailable(): boolean {
  if (safeStorageAvailable !== null) return safeStorageAvailable;
  // safeStorage 在 app ready 之前不可用（Windows：ready 后才返回 true）。
  // ready 前直接返回 false 且【不写缓存】——否则模块加载期的早期调用会把
  // false 永久缓存，导致之后 enc: 字段全部解密失败、加密全部降级为混淆。
  if (!app.isReady()) return false;
  try {
    safeStorageAvailable = safeStorage.isEncryptionAvailable();
  } catch {
    safeStorageAvailable = false;
  }
  return safeStorageAvailable;
}

/** 机器指纹 XOR 混淆 key —— 不抗逆向但保证 round-trip。
 *  用 userData 绝对路径 + 包名做 SHA256 → 16 字节。 */
function getMachineKey(): Buffer {
  const seed = `${app.getPath("userData")}::${app.getName()}::cyrene-bot-secret`;
  // 用 node 内置 crypto（避免依赖冲突）
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { createHash } = require("crypto") as typeof import("crypto");
  return createHash("sha256").update(seed).digest().subarray(0, 16);
}

/** XOR 混淆（不是真加密，仅挡 casual 偷窥）。 */
function obfuscate(plain: string): string {
  const key = getMachineKey();
  const buf = Buffer.from(plain, "utf8");
  const out = Buffer.alloc(buf.length);
  for (let i = 0; i < buf.length; i++) {
    // eslint-disable-next-line no-bitwise
    out[i] = buf[i] ^ key[i % key.length];
  }
  return OBF_PREFIX + out.toString("base64");
}

/** XOR 解混淆（必须和 obfuscate 用同一台机器 —— key 派生自 userData 路径）。 */
function deobfuscate(stored: string): string {
  const key = getMachineKey();
  const b64 = stored.slice(OBF_PREFIX.length);
  const buf = Buffer.from(b64, "base64");
  const out = Buffer.alloc(buf.length);
  for (let i = 0; i < buf.length; i++) {
    // eslint-disable-next-line no-bitwise
    out[i] = buf[i] ^ key[i % key.length];
  }
  return out.toString("utf8");
}

/** 加密一个字符串。优先级: safeStorage > 机器指纹混淆 > 明文 */
function encryptField(plain: string): string {
  if (!plain) return "";
  if (isSafeStorageAvailable()) {
    try {
      const buf = safeStorage.encryptString(plain);
      return ENC_PREFIX + buf.toString("base64");
    } catch (err) {
      console.warn("[ChannelsSettings] safeStorage.encryptString 失败, 回退混淆:", err);
    }
  }
  return obfuscate(plain);
}

/** 解密一个字符串。识别 enc:/obf:/plain: 前缀。空字符串返回空。 */
function decryptField(stored: string): string {
  if (!stored) return "";
  if (stored.startsWith(ENC_PREFIX)) {
    if (!isSafeStorageAvailable()) {
      // safeStorage 不可用时 enc: 解不开 —— 这种情况通常意味着首次加密时也没用 safeStorage
      // 兜底：直接 base64 解码（会拿到乱码但不会让用户丢失 secret）
      console.warn("[ChannelsSettings] safeStorage 不可用, 无法解密 enc: 字段");
      return "";
    }
    try {
      const buf = Buffer.from(stored.slice(ENC_PREFIX.length), "base64");
      return safeStorage.decryptString(buf);
    } catch (err) {
      console.warn("[ChannelsSettings] safeStorage.decryptString 失败:", err);
      return "";
    }
  }
  if (stored.startsWith(OBF_PREFIX)) {
    try {
      return deobfuscate(stored);
    } catch (err) {
      console.warn("[ChannelsSettings] deobfuscate 失败:", err);
      return "";
    }
  }
  if (stored.startsWith(PLAIN_PREFIX)) {
    return stored.slice(PLAIN_PREFIX.length);
  }
  // 旧数据 / 兜底：当作明文
  return stored;
}

export interface ChannelRuntimeConfig {
  /** 是否启用本渠道 */
  enabled: boolean;
  /** 自定义 CLI 路径（用户手动指定时填，否则空走探测） */
  manualCliPath?: string;
  /** 用户填的公网回调 URL（飞书等需要公网回调的渠道用） */
  publicWebhookUrl?: string;
}

export interface WechatChannelConfig extends ChannelRuntimeConfig {
  /** 待审批用户列表。TODO：当前微信 iLink 模式无 pairing 概念（pairing IPC 为空实现），字段暂未使用，保留给将来需要审批流的接入。 */
  pairingPending?: Array<{ code: string; senderId: string; createdAt: number }>;
  /** 当前扫码登录二维码（base64 PNG），会话级不持久化 */
}

export interface FeishuChannelConfig extends ChannelRuntimeConfig {
  appId?: string;
  /**
   * AppSecret。**已用 safeStorage 加密**。读取时直接用，不要再 decrypt。
   * 这是 loadChannelsSettings 返回"密文形态"——上游业务层想拿明文，调 decryptFeishuSecret(cfg.appSecret)。
   * 设置层（UI）保存时：把用户输入的明文先用 encryptField() 包裹再写。
   */
  appSecret?: string;
}

/**
 * 监听模式的唯一声明位于 shared（主进程与渲染端共用），从本模块再导出，
 * 保持既有引用方（如 adapters/qq/onebot-reverse-ws.ts）不变。
 */
export type { QqListenMode };

export interface QqChannelConfig extends ChannelRuntimeConfig {
  listenMode: QqListenMode;
  customHost?: string;
  port: number;
  accessToken?: string;
  allowedPrivateUserIds: string[];
  allowedGroupIds: string[];
  groupRequireMention: true;
  groupReplyStyle: "reply-and-mention";
  groupToolPolicy: "off";
  groupMemoryPolicy: "shared-personal";
}

/** QQ 官方机器人渠道（QQ 开放平台 API v2）。appSecret 加密落盘，规则同飞书。 */
export interface QqBotChannelConfig extends ChannelRuntimeConfig {
  appId?: string;
  /** AppSecret（ClientSecret）。磁盘密文，运行时明文，规则同飞书 appSecret。 */
  appSecret?: string;
  /** 所有单聊放行（openid 无法提前知道，首次联系被拒时会展示 openid 供加白） */
  allowAnyPrivate: boolean;
  /** 单聊用户 openid 白名单 */
  allowedUserOpenids: string[];
  /** 群 openid 白名单（群内事件仅 @ 机器人触发） */
  allowedGroupOpenids: string[];
}

/** 给上层用的明文 AppSecret 读取器 */
export function decryptFeishuSecret(cfg: FeishuChannelConfig | undefined): string {
  return decryptField(cfg?.appSecret ?? "");
}

export type ChannelToolSandbox = "off" | "all";

export interface ChannelsSettings {
  wechat: WechatChannelConfig;
  feishu: FeishuChannelConfig;
  qq: QqChannelConfig;
  qqbot: QqBotChannelConfig;
  /** 入站 HTTP server 绑定的端口。0 = 随机空闲。 */
  inboundPort: number;
  /** HMAC 共享密钥。启动时若为空则自动生成。 */
  sharedSecret: string;
  /** 全局：每用户每分钟最多消息数 */
  rateLimitPerUser: number;
  /** 全局：单渠道每分钟最多消息数 */
  rateLimitPerChannel: number;
  /** 全局：是否发送 TTS 音频消息 */
  ttsEnabled: boolean;
  /** 全局：是否发送 sticker */
  stickerEnabled: boolean;
  /** 全局：是否把 bot 会话镜像到桌面端 chatWindow */
  mirrorToDesktop: boolean;
  /** 全局：关闭时走 Chat；全部开启时走无交互审批的 Harness。 */
  toolSandbox: ChannelToolSandbox;
}

const DEFAULT_SETTINGS: ChannelsSettings = {
  wechat: { enabled: false },
  feishu: { enabled: false },
  qq: {
    enabled: false,
    listenMode: "auto",
    port: 6200,
    allowedPrivateUserIds: [],
    allowedGroupIds: [],
    groupRequireMention: true,
    groupReplyStyle: "reply-and-mention",
    groupToolPolicy: "off",
    groupMemoryPolicy: "shared-personal",
  },
  qqbot: {
    enabled: false,
    allowAnyPrivate: false,
    allowedUserOpenids: [],
    allowedGroupOpenids: [],
  },
  inboundPort: 0,
  sharedSecret: "",
  rateLimitPerUser: 10,
  rateLimitPerChannel: 100,
  ttsEnabled: true,
  stickerEnabled: true,
  mirrorToDesktop: true,
  toolSandbox: "all",
};

function filePath(): string {
  return path.join(app.getPath("userData"), "channels-settings.json");
}

function normalize(input: Partial<ChannelsSettings> | null | undefined): ChannelsSettings {
  const safeNum = (v: unknown, fallback: number, min = 0, max = Number.MAX_SAFE_INTEGER): number => {
    const n = Number(v);
    if (!Number.isFinite(n)) return fallback;
    return Math.min(max, Math.max(min, Math.floor(n)));
  };
  const safeBool = (v: unknown, fallback: boolean): boolean =>
    typeof v === "boolean" ? v : fallback;

  const safeStr = (v: unknown): string => (typeof v === "string" ? v : "");
  const safeToolSandbox = (v: unknown): ChannelToolSandbox => {
    if (v === "all") return "all";
    if (v === "off" || v === "safe-only") return "off";
    return DEFAULT_SETTINGS.toolSandbox;
  };

  const w: Partial<WechatChannelConfig> | undefined = input?.wechat;
  const f: Partial<FeishuChannelConfig> | undefined = input?.feishu;
  const q: Partial<QqChannelConfig> | undefined = input?.qq;
  const b: Partial<QqBotChannelConfig> | undefined = input?.qqbot;
  const normalizeIds = (value: unknown): string[] => {
    if (!Array.isArray(value)) return [];
    return Array.from(new Set(value
      .map((item) => String(item).trim())
      .filter((item) => /^\d+$/.test(item))));
  };
  // openid 是大小写十六进制串，与 QQ 号白名单（纯数字）校验规则不同
  const normalizeOpenids = (value: unknown): string[] => {
    if (!Array.isArray(value)) return [];
    return Array.from(new Set(value
      .map((item) => String(item).trim())
      .filter((item) => /^[A-Za-z0-9_-]{8,64}$/.test(item))));
  };
  // 收敛规则与渲染端共用同一份实现（shared/qq-listen），不再各写一遍枚举判定
  const normalizeListenMode = normalizeQqListenMode;

  return {
    wechat: {
      enabled: safeBool(w?.enabled, false),
      manualCliPath: typeof w?.manualCliPath === "string" ? w.manualCliPath : undefined,
      publicWebhookUrl: typeof w?.publicWebhookUrl === "string" ? w.publicWebhookUrl : undefined,
      pairingPending: Array.isArray(w?.pairingPending)
        ? w!.pairingPending!.map((p) => ({
            code: safeStr((p as { code?: unknown }).code),
            senderId: safeStr((p as { senderId?: unknown }).senderId),
            createdAt: safeNum((p as { createdAt?: unknown }).createdAt, Date.now()),
          }))
        : [],
    },
feishu: {
      enabled: safeBool(f?.enabled, false),
      manualCliPath: typeof f?.manualCliPath === "string" ? f?.manualCliPath : undefined,
      publicWebhookUrl: typeof f?.publicWebhookUrl === "string" ? f?.publicWebhookUrl : undefined,
      appId: typeof f?.appId === "string" ? f?.appId : undefined,
      // appSecret 字段：对外 API 是明文，磁盘存储是 enc: 前缀密文。
      // load 函数会先 decrypt 再返回；save 函数会自动 encrypt。
      appSecret: typeof f?.appSecret === "string" ? f?.appSecret : undefined,
    },
    qq: {
      enabled: safeBool(q?.enabled, false),
      listenMode: normalizeListenMode(q?.listenMode),
      customHost: typeof q?.customHost === "string" && q.customHost.trim()
        ? q.customHost.trim()
        : undefined,
      port: safeNum(q?.port, 6200, 1, 65535),
      accessToken: typeof q?.accessToken === "string" ? q.accessToken : undefined,
      allowedPrivateUserIds: normalizeIds(q?.allowedPrivateUserIds),
      allowedGroupIds: normalizeIds(q?.allowedGroupIds),
      groupRequireMention: true,
      groupReplyStyle: "reply-and-mention",
      groupToolPolicy: "off",
      groupMemoryPolicy: "shared-personal",
    },
    qqbot: {
      enabled: safeBool(b?.enabled, false),
      manualCliPath: typeof b?.manualCliPath === "string" ? b?.manualCliPath : undefined,
      publicWebhookUrl: typeof b?.publicWebhookUrl === "string" ? b?.publicWebhookUrl : undefined,
      appId: typeof b?.appId === "string" ? b.appId.trim() : undefined,
      appSecret: typeof b?.appSecret === "string" ? b?.appSecret : undefined,
      allowAnyPrivate: safeBool(b?.allowAnyPrivate, false),
      allowedUserOpenids: normalizeOpenids(b?.allowedUserOpenids),
      allowedGroupOpenids: normalizeOpenids(b?.allowedGroupOpenids),
    },
    inboundPort: safeNum(input?.inboundPort, 0, 0, 65535),
    sharedSecret: typeof input?.sharedSecret === "string" ? input.sharedSecret : "",
    rateLimitPerUser: safeNum(input?.rateLimitPerUser, 10, 1, 1000),
    rateLimitPerChannel: safeNum(input?.rateLimitPerChannel, 100, 1, 10000),
    ttsEnabled: safeBool(input?.ttsEnabled, true),
    stickerEnabled: safeBool(input?.stickerEnabled, true),
    mirrorToDesktop: safeBool(input?.mirrorToDesktop, true),
    toolSandbox: safeToolSandbox(input?.toolSandbox),
  };
}

export function loadChannelsSettings(): ChannelsSettings {
  try {
    const p = filePath();
    if (!fs.existsSync(p)) return { ...DEFAULT_SETTINGS };
    const raw = JSON.parse(fs.readFileSync(p, "utf8")) as Partial<ChannelsSettings>;
    const loaded = normalize(raw);
    // 私密字段解密边界：磁盘上是 enc: 前缀密文，运行时 API 暴露明文
    if (loaded.feishu.appSecret) {
      loaded.feishu.appSecret = decryptField(loaded.feishu.appSecret);
    }
    if (loaded.qq.accessToken) {
      loaded.qq.accessToken = decryptField(loaded.qq.accessToken);
    }
    if (loaded.qqbot.appSecret) {
      loaded.qqbot.appSecret = decryptField(loaded.qqbot.appSecret);
    }
    return loaded;
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

export function saveChannelsSettings(patch: Partial<ChannelsSettings>): ChannelsSettings {
  const existing = loadChannelsSettings();
  const merged: Partial<ChannelsSettings> = { ...existing, ...patch };
  if (patch.wechat) merged.wechat = { ...existing.wechat, ...patch.wechat };
  if (patch.feishu) merged.feishu = { ...existing.feishu, ...patch.feishu };
  if (patch.qq) merged.qq = { ...existing.qq, ...patch.qq };
  if (patch.qqbot) merged.qqbot = { ...existing.qqbot, ...patch.qqbot };

  // 私密字段加密边界：UI 传来的是明文，写盘前要 wrap
  // 避开"密文回传"场景：检测 enc:/obf:/plain: 前缀，避免重复加密。
  if (typeof merged.feishu?.appSecret === "string" && merged.feishu.appSecret) {
    const v = merged.feishu.appSecret;
    if (!v.startsWith(ENC_PREFIX) && !v.startsWith(OBF_PREFIX) && !v.startsWith(PLAIN_PREFIX)) {
      merged.feishu.appSecret = encryptField(v);
    }
  }
  if (typeof merged.qq?.accessToken === "string" && merged.qq.accessToken) {
    const v = merged.qq.accessToken;
    if (!v.startsWith(ENC_PREFIX) && !v.startsWith(OBF_PREFIX) && !v.startsWith(PLAIN_PREFIX)) {
      merged.qq.accessToken = encryptField(v);
    }
  }
  if (typeof merged.qqbot?.appSecret === "string" && merged.qqbot.appSecret) {
    const v = merged.qqbot.appSecret;
    if (!v.startsWith(ENC_PREFIX) && !v.startsWith(OBF_PREFIX) && !v.startsWith(PLAIN_PREFIX)) {
      merged.qqbot.appSecret = encryptField(v);
    }
  }

  const final = normalize(merged);
  // 写盘时 final.appSecret / final.encryptKey 已经是密文形态（带 enc: 前缀）
  // load 时解密，运行时给上层看到明文。
  fs.mkdirSync(path.dirname(filePath()), { recursive: true });
  fs.writeFileSync(filePath(), JSON.stringify(final, null, 2), "utf8");

  // 返回给上层时再解密一次，让 API 用户拿到明文
  const out: ChannelsSettings = {
    ...final,
    feishu: {
      ...final.feishu,
      appSecret: decryptField(final.feishu.appSecret ?? ""),
    },
    qq: {
      ...final.qq,
      accessToken: decryptField(final.qq.accessToken ?? ""),
    },
    qqbot: {
      ...final.qqbot,
      appSecret: decryptField(final.qqbot.appSecret ?? ""),
    },
  };
  return out;
}

/** 渠道字段补丁类型（用于上层调用 saveChannelsSettings 时类型安全）。 */
export type ChannelConfigPatch = Partial<{
  wechat: Partial<WechatChannelConfig>;
  feishu: Partial<FeishuChannelConfig>;
  qq: Partial<QqChannelConfig>;
  qqbot: Partial<QqBotChannelConfig>;
  inboundPort: number;
  sharedSecret: string;
  rateLimitPerUser: number;
  rateLimitPerChannel: number;
  ttsEnabled: boolean;
  stickerEnabled: boolean;
  mirrorToDesktop: boolean;
  toolSandbox: ChannelToolSandbox;
}>;

/** 给定 channelId 返回对应的配置子集（用于 adapter 内部读取自己的开关）。 */
interface ChannelConfigMap {
  wechat: WechatChannelConfig;
  feishu: FeishuChannelConfig;
  qq: QqChannelConfig;
  qqbot: QqBotChannelConfig;
}

export function getChannelConfig<K extends ChannelId>(settings: ChannelsSettings, channel: K): ChannelConfigMap[K] {
  return settings[channel] as ChannelConfigMap[K];
}
