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
  /** 待审批用户列表（Phase 1 接入 OpenClaw pairing 后实装） */
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

export interface DiscordChannelConfig extends ChannelRuntimeConfig {
  /**
   * Discord Bot Token。**以明文（plain: 前綴）儲存**，不依賴 safeStorage / 機器指紋，
   * 確保在各種啟動方式/環境下都能可靠讀回。load/save 一律以明文 round-trip。
   */
  token?: string;
  /**
   * `/start` 綁定的伺服器文字頻道 ID（讓 Bot 在這個頻道 @ 即觸發對話）。
   * 空白 = 未綁定，需要在某頻道輸入 `/start` 綁定。
   */
  boundChannelId?: string;
  /** 綁定頻道的顯示名稱，僅供 UI/日誌展示。 */
  boundChannelName?: string;
  /** work 模式（toolSandbox=all）的對話 session id。供對應/定位用。 */
  workSessionId?: string;
  /** chat 模式（toolSandbox=off）的對話 session id。供對應/定位用。 */
  chatSessionId?: string;
  mode?: "work" | "chat";
  fallbackModelProfileId?: string;
  fallbackUserIds?: string[];
}

export type ChannelToolSandbox = "off" | "all";

export interface ChannelsSettings {
  wechat: WechatChannelConfig;
  feishu: FeishuChannelConfig;
  discord: DiscordChannelConfig;
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
  discord: { enabled: false },
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
  const d: Partial<DiscordChannelConfig> | undefined = input?.discord;

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
    discord: {
      enabled: safeBool(d?.enabled, false),
      manualCliPath: typeof d?.manualCliPath === "string" ? d?.manualCliPath : undefined,
      publicWebhookUrl: typeof d?.publicWebhookUrl === "string" ? d?.publicWebhookUrl : undefined,
      token: typeof d?.token === "string" ? d?.token : undefined,
      boundChannelId: typeof d?.boundChannelId === "string" ? d?.boundChannelId : undefined,
      boundChannelName: typeof d?.boundChannelName === "string" ? d?.boundChannelName : undefined,
      workSessionId: typeof d?.workSessionId === "string" ? d?.workSessionId : undefined,
      chatSessionId: typeof d?.chatSessionId === "string" ? d?.chatSessionId : undefined,
      mode: d?.mode === "work" || d?.mode === "chat" ? d.mode : undefined,
      fallbackModelProfileId: safeStr(d?.fallbackModelProfileId).trim() || undefined,
      fallbackUserIds: Array.isArray(d?.fallbackUserIds)
        ? [...new Set(d.fallbackUserIds.filter((id) => typeof id === "string" && /^\d{17,20}$/.test(id)))].slice(0, 100)
        : [],
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
    if (loaded.discord.token) {
      loaded.discord.token = decryptField(loaded.discord.token);
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
  if (patch.discord) merged.discord = { ...existing.discord, ...patch.discord };

  // 私密字段加密边界：UI 传来的是明文，写盘前要 wrap
  // 避开"密文回传"场景：检测 enc:/obf:/plain: 前缀，避免重复加密。
  if (typeof merged.feishu?.appSecret === "string" && merged.feishu.appSecret) {
    const v = merged.feishu.appSecret;
    if (!v.startsWith(ENC_PREFIX) && !v.startsWith(OBF_PREFIX) && !v.startsWith(PLAIN_PREFIX)) {
      merged.feishu.appSecret = encryptField(v);
    }
  }
  if (typeof merged.discord?.token === "string" && merged.discord.token) {
    // Discord token 一律以明文（plain: 前綴）儲存，不依賴 safeStorage / 機器指紋，
    // 確保各種啟動方式/環境都能可靠讀回。已帶 plain: 前綴則原樣保留。
    const v = merged.discord.token.trim();
    if (!v.startsWith(PLAIN_PREFIX)) merged.discord.token = PLAIN_PREFIX + v;
  }

  const final = normalize(merged);
  // 写盘时私密字段已经是密文形态（带 enc: 前缀）
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
    discord: {
      ...final.discord,
      token: decryptField(final.discord.token ?? ""),
    },
  };
  return out;
}

/** 渠道字段补丁类型（用于上层调用 saveChannelsSettings 时类型安全）。 */
export type ChannelConfigPatch = Partial<{
  wechat: Partial<WechatChannelConfig>;
  feishu: Partial<FeishuChannelConfig>;
  discord: Partial<DiscordChannelConfig>;
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
export type ChannelSessionConfig =
  | WechatChannelConfig
  | FeishuChannelConfig
  | DiscordChannelConfig;

export function getChannelConfig(settings: ChannelsSettings, channel: ChannelId): ChannelSessionConfig {
  return settings[channel] as ChannelSessionConfig;
}
