// channels/dispatcher —— 入站消息处理核心。
//
// 设计原则：
//   - 不知道任何具体平台。platform 信息只用于查找 adapter / 落日志 / 写 sessionId。
//   - 完全无副作用：UI 广播、记忆写入、sticker 推断都在外部注入的回调里完成。
//   - Phase 0 只搭骨架 + sessionId hash + 限速 + capability 降级工具函数。
//     Phase 1 填入完整的 agent 调用（handleIncoming → CyreneAgent）。
//
// sessionId 生成规则：
//   `channel:<channel>:<sha256(channel:senderId).slice(0,16)>`
//   加 channel 前缀防止跨平台 ID 冲突；hash 截断 16 字符节约空间且日志脱敏。
//
// capability 降级：
//   把 OutgoingMessage 按目标渠道的 cap 翻译 —— image→text 描述 / card→markdown / sticker 跳过。
import { createHash, randomUUID } from "crypto";
import * as fs from "fs";
import * as path from "path";
import { app } from "electron";
import type {
  ChannelCapability,
  ChannelId,
  IncomingMessage,
  OutgoingMessage,
  OutgoingPart,
} from "./types";
import { channelManager, type ChannelManager } from "./manager";
import { loadChannelsSettings, type ChannelsSettings } from "./settings-store";
import { appendLog, reloadLogFromDisk } from "./message-log";
import { appendHistory as appendChannelHistory } from "./history-log";
import { resolveLocalStickerPath } from "../sticker-protocol";
import { getStickersDir, loadUserStickerManifest } from "../sticker-storage";
import { BUILT_IN_STICKER_FILES } from "../sticker-descriptions";
import { BUILT_IN_STICKER_IDS } from "../../shared/sticker-types";
import { splitTextBySentenceBreaks } from "../../shared/message-segmentation";
import {
  normalizeMobileMessageSegmentationMode,
  type MobileMessageSegmentationMode,
} from "../../shared/preferences";
import { rememberProactiveChannelRecipient } from "./proactive-delivery";
import { getDiscordMessageAccess, isDiscordOwnerDm } from "./adapters/discord/access";

/** Phase A：用于拼接历史对话的轻量 ChatMessage 形状（与 orchestrator ChatMessage 兼容）。 */
interface ChatMessage {
  role: "user" | "assistant" | "system" | "tool";
  content?: string;
}

type TtsAudioFormat = "mp3" | "wav" | "pcm";

interface DispatcherTtsContext {
  channel: ChannelId;
}

interface DispatcherTtsResult {
  audio: Buffer;
  format: TtsAudioFormat;
  mime: string;
  extension: ".mp3" | ".wav" | ".pcm";
}

const LOG = "[ChannelDispatcher]";

/** sessionId 缓存（用于查重 / 调试 / 上限管理） */
const sessionIndex = new Map<string, { channel: ChannelId; senderId: string; lastAt: number }>();

/** 限速：单用户每分钟最多 N 条 */
class RateLimiter {
  private buckets = new Map<string, number[]>(); // key = channel:senderId → timestamp[]
  constructor(private settings: ChannelsSettings) {}

  /** 检查并记录一次命中。返回 true = 通过；false = 超限。 */
  hit(channel: ChannelId, senderId: string): boolean {
    const key = `${channel}:${senderId}`;
    const now = Date.now();
    const arr = this.buckets.get(key) ?? [];
    // 砍掉 60s 之外的
    const fresh = arr.filter((t) => now - t < 60_000);
    if (fresh.length >= this.settings.rateLimitPerUser) {
      this.buckets.set(key, fresh);
      return false;
    }
    fresh.push(now);
    this.buckets.set(key, fresh);

    // 渠道级全局限速
    const chKey = `__channel__:${channel}`;
    const chArr = this.buckets.get(chKey) ?? [];
    const chFresh = chArr.filter((t) => now - t < 60_000);
    if (chFresh.length >= this.settings.rateLimitPerChannel) {
      this.buckets.set(chKey, chFresh);
      return false;
    }
    chFresh.push(now);
    this.buckets.set(chKey, chFresh);

    return true;
  }

  /** 测试用：重置所有桶 */
  reset(): void {
    this.buckets.clear();
  }
}

/** 计算一个稳定、匿名的 sessionId。Discord 按发送者、对话和执行模式隔离历史。 */
export function makeSessionId(
  channel: ChannelId,
  senderId: string,
  mode?: "work" | "chat",
  chatId?: string,
): string {
  const label = (channel === "discord" && mode) ? `:${mode}` : "";
  const scope = channel === "discord" && chatId !== undefined ? `:${chatId === senderId ? "dm" : "guild"}:${chatId}` : "";
  const hash = createHash("sha256")
    .update(`${channel}:${senderId}${label}${scope}`)
    .digest("hex")
    .slice(0, 16);
  return `channel:${channel}${label}:${hash}`;
}

/** 记录 sessionId → 原始 senderId（用于调试 / 反查；不影响正常运行） */
function recordSession(channel: ChannelId, senderId: string, sessionId: string): void {
  sessionIndex.set(sessionId, { channel, senderId, lastAt: Date.now() });
  // 上限管理：超过 5000 个 sessionId 就丢弃最老的（LRU 近似）
  if (sessionIndex.size > 5000) {
    const oldest = [...sessionIndex.entries()].sort((a, b) => a[1].lastAt - b[1].lastAt)[0];
    if (oldest) sessionIndex.delete(oldest[0]);
  }
}

/** 把原始 senderId 反查回 sessionId。调试用，不依赖也能跑。 */
export function lookupOriginalSender(sessionId: string): { channel: ChannelId; senderId: string } | null {
  const entry = sessionIndex.get(sessionId);
  return entry ? { channel: entry.channel, senderId: entry.senderId } : null;
}

/**
 * 把 sticker id 解析成本地绝对路径（用于 OutgoingPart sticker.imagePath）。
 *
 * - 内置 sticker（BUILT_IN_STICKER_IDS）：从 app.getAppPath() 下找 public/stickers/<file>
 *   - dev 模式：<appPath>/src/renderer/public/stickers
 *   - built 模式：<appPath>/dist/renderer/stickers
 *   两个路径都尝试，第一个命中即返回。
 * - 用户 sticker：从 userData/stickers/<file>（通过 manifest 拿到 file 字段）。
 * - 解析失败（文件不存在、路径穿越、未知 id）→ 返回 null，调用方跳过此 part。
 */
export function resolveStickerImagePath(stickerId: string): string | null {
  if (!stickerId) return null;

  // 内置 sticker：直接用 BUILT_IN_STICKER_FILES 映射到 public 目录
  if ((BUILT_IN_STICKER_IDS as readonly string[]).includes(stickerId)) {
    const file = BUILT_IN_STICKER_FILES[stickerId];
    if (!file) return null;
    const appPath = app.getAppPath();
    // 优先 built 路径（生产），其次 dev 路径（开发模式）
    const candidates = [
      path.join(appPath, "dist", "renderer", "stickers", file),
      path.join(appPath, "src", "renderer", "public", "stickers", file),
    ];
    for (const candidate of candidates) {
      if (fs.existsSync(candidate)) return candidate;
    }
    return null;
  }

  // 用户 sticker：从 manifest 拿 file 字段，再走 sticker-protocol 的安全解析
  // （resolveLocalStickerPath 已做路径穿越防护）
  const manifest = loadUserStickerManifest();
  const meta = manifest[stickerId];
  if (!meta) return null;
  return resolveLocalStickerPath(getStickersDir(), meta.file);
}

/** Dispatcher 配置（依赖注入）。 */
export interface DispatcherDeps {
  manager: ChannelManager;
  /** 渲染端 chatWindow 用于镜像显示（可选） */
  getChatWindow?: () => { webContents: { isDestroyed(): boolean; send: (channel: string, ...args: unknown[]) => void }; isDestroyed(): boolean } | null;
  /** Phase 1+：完整 agent 调用。Phase 0 留空，返回纯 echo。
   *  返回 text（必填）+ sticker（可选 sticker id，由 dispatcher 解析成本地路径后纳入 OutgoingMessage.parts）。
   *  sticker 解析失败的会静默跳过（不会把坏数据塞进 parts）。 */
  buildAndRunAgent?: (msg: IncomingMessage, sessionId: string, priorMessages?: ChatMessage[]) => Promise<{ text: string; sticker: string | null }>;
  /** Phase A：读这个 sessionId 最近 N 条对话历史（按时间顺序）。不提供时不拼历史，行为同 Phase 0。 */
  loadRecentChannelHistory?: (sessionId: string, limit: number) => Promise<ChatMessage[]>;
  /** Phase 3：可选 — 把文本合成成音频。失败返回 null，dispatcher 会跳过 audio。 */
  synthesizeTts?: (text: string, context: DispatcherTtsContext) => Promise<Buffer | DispatcherTtsResult | null>;
  /** Phase 3：可选 — 桌面端镜像广播：bot 入站/出站消息通知给 chatWindow。 */
  broadcastChat?: (event: {
    type: "bot:incoming" | "bot:outgoing";
    channel: string;
    senderId: string;
    senderName?: string;
    chatId: string;
    text: string;
    at: number;
  }) => void;
  /** 读取通用设置中与渠道发送有关的偏好。 */
  loadGeneralSettings?: () => { mobileMessageSegmentation?: MobileMessageSegmentationMode };
}

export function buildTextOutgoingParts(
  replyText: string,
  mobileMessageSegmentation: MobileMessageSegmentationMode,
): OutgoingPart[] {
  const mode = normalizeMobileMessageSegmentationMode(mobileMessageSegmentation);
  const texts = mode === "on" ? splitTextBySentenceBreaks(replyText) : [replyText];
  return texts.map((text) => ({ kind: "text", text }));
}

export function shouldAppendChannelTtsAudio(
  channel: ChannelId,
  ttsEnabled: boolean,
  hasSynthesizeTts: boolean,
  adapterSupportsAudio: boolean | undefined,
): boolean {
  if (channel === "wechat") return false;
  return ttsEnabled && hasSynthesizeTts && adapterSupportsAudio === true;
}

export class ChannelDispatcher {
  private settings: ChannelsSettings;
  private limiter: RateLimiter;
  deps: DispatcherDeps;

  constructor(deps: DispatcherDeps) {
    this.deps = deps;
    this.settings = loadChannelsSettings();
    this.limiter = new RateLimiter(this.settings);
    reloadLogFromDisk();
  }

  /** 重新加载 settings（UI 改了限速配置时调） */
  reloadSettings(): void {
    this.settings = loadChannelsSettings();
    this.limiter = new RateLimiter(this.settings);
  }

  /**
   * 处理一条入站消息。这是 manager 注入到 adapter.onMessage 的回调。
   *
   * Phase 0 行为：限速 → 计算 sessionId → 调 buildAndRunAgent（如果有）→ 构造 OutgoingMessage。
   * 如果没注入 buildAndRunAgent，返回 echo 作为占位（仅 Phase 0 用于联调）。
   */
  async handleIncoming(msg: IncomingMessage): Promise<OutgoingMessage | null> {
    if (!this.limiter.hit(msg.channel, msg.senderId)) {
      console.warn(LOG, `限速: ${msg.channel}:${msg.senderId}`);
      return null;
    }

    // 使用收到消息时的模式。会话范围防止把私信和服务器频道历史混在一起。
    const discordAccess = msg.channel === "discord" ? getDiscordMessageAccess(msg) : undefined;
    const sessionId = discordAccess
      ? makeSessionId(msg.channel, msg.senderId, discordAccess.mode, msg.chatId)
      : makeSessionId(msg.channel, msg.senderId);
    recordSession(msg.channel, msg.senderId, sessionId);
    if (!discordAccess || isDiscordOwnerDm(msg)) rememberProactiveChannelRecipient(msg, sessionId);

    // Phase 3：入站消息广播到桌面端 chatWindow（让用户看到 bot 在和谁聊天）
    if (this.settings.mirrorToDesktop) {
      try {
        this.deps.broadcastChat?.({
          type: "bot:incoming",
          channel: msg.channel,
          senderId: msg.senderId,
          senderName: msg.senderName,
          chatId: msg.chatId,
          text: msg.text,
          at: msg.at.getTime(),
        });
      } catch (err) {
        console.warn(LOG, "broadcastChat (incoming) 失败:", err);
      }
    }

    // Phase 3.4：入站消息写日志
    try {
      appendLog({
        dir: "incoming",
        channel: msg.channel,
        senderId: msg.senderId,
        senderName: msg.senderName,
        chatId: msg.chatId,
        text: msg.text,
        hasAttachments: (msg.attachments?.length ?? 0) > 0,
      });
    } catch (err) {
      console.warn(LOG, "appendLog (incoming) 失败:", err);
    }

    const voiceReplyText = discordAccess?.isGatewayMessage ? msg.voiceReplyText : undefined;
    let priorMessages: ChatMessage[] | undefined;
    if (!voiceReplyText && this.deps.buildAndRunAgent && this.deps.loadRecentChannelHistory) {
      try {
        priorMessages = await this.deps.loadRecentChannelHistory(sessionId, 16);
      } catch (err) {
        console.warn(LOG, "loadRecentChannelHistory 失败 (继续不带历史):", err);
      }
    }

    // 先读取历史再追加本轮，避免把当前消息发送给模型两次。
    try {
      appendChannelHistory(sessionId, "user", msg.text);
    } catch (err) {
      console.warn(LOG, "appendHistory (incoming) 失败:", err);
    }

    // Phase 1 实装的 agent 调用；Phase 0 没有 → echo
    let replyText: string;
    let sticker: string | null = null;
    if (voiceReplyText) {
      replyText = voiceReplyText;
    } else if (this.deps.buildAndRunAgent) {
      try {
        const result = await this.deps.buildAndRunAgent(msg, sessionId, priorMessages);
        replyText = result.text;
        sticker = result.sticker;
      } catch (err) {
        console.error(LOG, "agent 调用失败:", err instanceof Error ? err.message : err);
        if (msg.channel === "discord") {
          replyText = "我處理你的訊息時出了點問題，請稍後重試。";
        } else {
          const detail = (err as { code?: unknown } | null)?.code;
          replyText = `⚠️ Agent 處理失敗${typeof detail === "string" && detail ? `（${detail}）` : ""}：` +
            (err instanceof Error ? err.message : String(err)) +
            "\n你可以輸入 `/status` 查看目前模型/API 設定與詳細錯誤。";
        }
      }
    } else {
      replyText = `[echo][${msg.channel}][${msg.senderId}] ${msg.text}`;
      console.log(LOG, "Phase 0 echo (无 buildAndRunAgent):", replyText);
    }

    // 构造 OutgoingMessage parts
    const mobileMessageSegmentation = normalizeMobileMessageSegmentationMode(
      this.deps.loadGeneralSettings?.().mobileMessageSegmentation,
    );
    const parts: OutgoingPart[] = buildTextOutgoingParts(replyText, mobileMessageSegmentation);

    // Phase 3：TTS 音频自动追加（如果启用且适配器支持 audio）
    console.log(LOG, `TTS 决策: ttsEnabled=${this.settings.ttsEnabled} hasFn=${!!this.deps.synthesizeTts}`);
    const adapterCap = this.deps.manager.getAdapter(msg.channel)?.capability;
    console.log(LOG, `TTS 决策: adapterCap.audio=${adapterCap?.audio}`);
    if (shouldAppendChannelTtsAudio(msg.channel, this.settings.ttsEnabled, !!this.deps.synthesizeTts, adapterCap?.audio)) {
      if (this.deps.synthesizeTts) {
        try {
          const audioResult = normalizeTtsResult(await this.deps.synthesizeTts(replyText, { channel: msg.channel }));
          console.log(LOG, `TTS 决策: 合成结果 length=${audioResult?.audio.length ?? "null"} format=${audioResult?.format ?? "null"}`);
          if (audioResult && audioResult.audio.length > 0) {
            // 写到 userData/channels/audio/<messageId>.<ext> 缓存
            const audioDir = path.join(app.getPath("userData"), "channels", "audio");
            fs.mkdirSync(audioDir, { recursive: true });
            const audioPath = path.join(audioDir, `${msg.channel}-${randomUUID()}${audioResult.extension}`);
            fs.writeFileSync(audioPath, audioResult.audio);
            console.log(LOG, `TTS verify: written path=${audioPath} ext=${audioResult.extension} mime=${audioResult.mime}`);
            parts.push({ kind: "audio", filePath: audioPath, mime: audioResult.mime });
            console.log(LOG, `TTS 合成完成: ${audioResult.audio.length} bytes → ${audioPath}`);
          }
        } catch (err) {
          console.warn(LOG, "TTS 合成失败（跳过音频）:", err instanceof Error ? err.message : err);
        }
      }
    }

    // Phase 4：sticker 决定纳入 OutgoingMessage.parts（统一消息模型）。
    // 由 onAgentRunFinished 计算（同一个 embedding 匹配结果，避免重复计算），
    // dispatcher 只负责解析本地路径 + 按 cap 降级。
    // 桌面聊天窗的 sticker 由 onAgentRunFinished 内部 IPC 广播承担，此处不重复。
    if (sticker && this.settings.stickerEnabled) {
      const stickerPath = resolveStickerImagePath(sticker);
      if (stickerPath) {
        parts.push({ kind: "sticker", stickerId: sticker, imagePath: stickerPath });
        console.log(LOG, `sticker 决定: id=${sticker} → ${stickerPath}`);
      } else {
        console.warn(LOG, `sticker 解析失败（跳过）: id=${sticker}`);
      }
    }

    // Phase 3：出站消息广播到桌面端
    if (this.settings.mirrorToDesktop) {
      try {
        this.deps.broadcastChat?.({
          type: "bot:outgoing",
          channel: msg.channel,
          senderId: msg.senderId,
          senderName: msg.senderName,
          chatId: msg.chatId,
          text: replyText,
          at: Date.now(),
        });
      } catch (err) {
        console.warn(LOG, "broadcastChat (outgoing) 失败:", err);
    }
    }

    // Phase 3.4：出站消息写日志（仅文本 part，附件路径不写进 JSONL）
    try {
      appendLog({
        dir: "outgoing",
        channel: msg.channel,
        senderId: msg.senderId,
        senderName: msg.senderName,
        chatId: msg.chatId,
        text: replyText,
        hasAttachments: parts.some((p) => p.kind === "audio"),
      });
    } catch (err) {
      console.warn(LOG, "appendLog (outgoing) 失败:", err);
    }

    // Phase A2：出站消息落对话历史（assistant 角色）
    try {
      appendChannelHistory(sessionId, "assistant", replyText);
    } catch (err) {
      console.warn(LOG, "appendHistory (outgoing) 失败:", err);
    }

    // 构造 OutgoingMessage，capability 降级
    const outgoing: OutgoingMessage = {
      channel: msg.channel,
      targetId: msg.chatId,
      threadId: msg.threadId,
      parts,
    };
    return this.downgradeToCapability(outgoing, this.deps.manager.getAdapter(msg.channel)?.capability);
  }

  /** 按目标渠道 cap 做降级。返回新对象不修改原对象。 */
  downgradeToCapability(msg: OutgoingMessage, cap: ChannelCapability | undefined): OutgoingMessage {
    if (!cap) return msg;
    const parts: OutgoingPart[] = [];
    for (const p of msg.parts) {
      if (p.kind === "text") {
        if (cap.maxTextLength > 0 && p.text.length > cap.maxTextLength) {
          parts.push({
            kind: "text",
            text: p.text.slice(0, Math.max(0, cap.maxTextLength - 20)) + "\n...(过长已截断)",
          });
        } else {
          parts.push(p);
        }
      } else if (p.kind === "image" && !cap.image) {
        parts.push({ kind: "text", text: `[图片] ${p.caption ?? p.url ?? p.filePath ?? ""}` });
      } else if (p.kind === "audio" && !cap.audio) {
        parts.push({ kind: "text", text: `[语音消息 ${p.mime}, 见桌面端]` });
      } else if (p.kind === "file" && !cap.file) {
        parts.push({ kind: "text", text: `[文件] ${p.name ?? p.filePath}` });
      } else if (p.kind === "video" && !cap.video) {
        parts.push({ kind: "text", text: `[视频] ${p.name ?? p.filePath}` });
      } else if (p.kind === "card" && !cap.card) {
        const lines: string[] = [p.title];
        if (p.markdown) lines.push(p.markdown);
        if (p.fields && p.fields.length > 0) {
          lines.push(...p.fields.map((f) => `${f.key}: ${f.value}`));
        }
        parts.push({ kind: "text", text: lines.join(cap.markdown ? "\n" : "\n") });
      } else if (p.kind === "sticker" && !cap.sticker) {
        // skip
      } else {
        parts.push(p);
      }
    }
    return { ...msg, parts };
  }
}

function normalizeTtsResult(result: Buffer | DispatcherTtsResult | null): DispatcherTtsResult | null {
  if (!result) return null;
  if (Buffer.isBuffer(result)) {
    return {
      audio: result,
      format: "mp3",
      mime: "audio/mpeg",
      extension: ".mp3",
    };
  }
  return result;
}

/** 进程级单例 —— Phase 1 注入 buildAndRunAgent 后才会真正干活。 */
export const channelDispatcher = new ChannelDispatcher({
  manager: channelManager,
});

/** 给 index.ts 调：注入 buildAndRunAgent（让 dispatcher 真正跑 agent）
 *  返回 text + sticker：text 直接做 reply；sticker 由 dispatcher 解析成本地路径后纳入 OutgoingMessage.parts。 */
export function setDispatcherBuildAndRunAgent(
  fn: (msg: IncomingMessage, sessionId: string, priorMessages?: ChatMessage[]) => Promise<{ text: string; sticker: string | null }>,
): void {
  channelDispatcher.deps.buildAndRunAgent = fn;
}

/** Phase 3.1：注入 TTS 合成（返回音频或 null） */
export function setDispatcherSynthesizeTts(
  fn: (text: string, context: DispatcherTtsContext) => Promise<Buffer | DispatcherTtsResult | null>,
): void {
  channelDispatcher.deps.synthesizeTts = fn;
}

/** Phase A：注入最近对话历史读取（index.ts 注入一个用 history-log 实现的闭包） */
export function setDispatcherLoadRecentHistory(
  fn: (sessionId: string, limit: number) => Promise<{ role: "user" | "assistant"; content?: string }[]>,
): void {
  channelDispatcher.deps.loadRecentChannelHistory = fn;
}

/** Phase 3.2：注入桌面端镜像广播（chatWindow 推送 bot 入站/出站消息） */
export function setDispatcherBroadcastChat(
  fn: (event: {
    type: "bot:incoming" | "bot:outgoing";
    channel: string;
    senderId: string;
    senderName?: string;
    chatId: string;
    text: string;
    at: number;
  }) => void,
): void {
  channelDispatcher.deps.broadcastChat = fn;
}

/** 注入通用设置读取器（渠道发送时实时读取偏好）。 */
export function setDispatcherLoadGeneralSettings(
  fn: () => { mobileMessageSegmentation?: MobileMessageSegmentationMode },
): void {
  channelDispatcher.deps.loadGeneralSettings = fn;
}
