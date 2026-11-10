// QQ 官方机器人（QQ 开放平台）渠道适配器。
//
// 与 NapCat 渠道（"qq"）的区别：
//   - 走官方 API：AppID + AppSecret → access_token → WebSocket 网关收事件、REST 被动回复。
//   - 身份是"机器人"而非真实 QQ 号；用户/群以 openid 标识（非 QQ 号）。
//   - 官方 2025-04-21 后停止主动推送 → 只支持被动回复（必须在触发消息窗口内带 msg_id）。
//   - 出站仅文本（富媒体需分片上传接口，后续版本再做）。
//
// 白名单模型：openid 用户事先不知道，所以提供两种方式——
//   allowAnyPrivate（默认关）：所有单聊放行；
//   拒绝时把 openid 记入状态（UI 展示），用户复制进白名单即可放行。
import * as fs from "node:fs";
import * as path from "node:path";
import { app } from "electron";
import type { ChannelAdapter } from "../base";
import type {
  ChannelAttachment,
  ChannelCapability,
  ChannelStatus,
  IncomingMessage,
  MessageHandler,
  OutgoingMessage,
  OutgoingPart,
} from "../../types";
import { loadChannelsSettings, type QqBotChannelConfig } from "../../settings-store";
import { QqBotApiClient, QqBotApiError } from "./qqbot-api-client";
import { QqBotWsClient, type QqBotEventType } from "./qqbot-ws-client";
import { splitQqText } from "../qq/napcat-adapter";
import { AdapterActivity } from "../../adapter-activity";

const CAPABILITY: ChannelCapability = {
  text: true,
  image: false,
  audio: false,
  file: false,
  video: false,
  markdown: false,
  card: false,
  sticker: false,
  maxTextLength: 0,
};

const DEDUPE_TTL_MS = 10 * 60_000;
/** 入站附件下载上限：8 MiB（与 OneBot downloadUrl 限流一致） */
const MAX_ATTACHMENT_BYTES = 8 * 1024 * 1024;
/** 被动回复窗口：单聊 60 分钟、群聊 5 分钟；次数上限：单聊 4、群 5 */
const REPLY_WINDOW_MS = { private: 60 * 60_000, group: 5 * 60_000 } as const;
const REPLY_SEQ_LIMIT = { private: 4, group: 5 } as const;

interface InboundReplyContext {
  messageId: string;
  chatType: "private" | "group";
  receivedAt: number;
  /** 已用掉的 msg_seq 次数 */
  seqUsed: number;
}

/** 事件体 → 是否在白名单内（导出便于测试） */
export function isQqBotEventAllowed(
  data: {
    chatType: "private" | "group";
    senderId: string;
    chatId: string;
  },
  config: QqBotChannelConfig,
): boolean {
  if (data.chatType === "private") {
    return config.allowAnyPrivate || config.allowedUserOpenids.includes(data.senderId);
  }
  return config.allowedGroupOpenids.includes(data.chatId);
}

/** 事件体 → IncomingMessage（导出便于测试；attachments 由 adapter 侧下载后补 filePath） */
export function normalizeQqBotEvent(
  type: QqBotEventType,
  data: Record<string, unknown>,
): IncomingMessage | null {
  if (type !== "C2C_MESSAGE_CREATE" && type !== "GROUP_AT_MESSAGE_CREATE" && type !== "GROUP_MESSAGE_CREATE") {
    return null;
  }
  const author = (data.author ?? {}) as Record<string, unknown>;
  const isGroup = type !== "C2C_MESSAGE_CREATE";
  const senderId = String(author[isGroup ? "member_openid" : "user_openid"] ?? "");
  const chatId = isGroup ? String(data.group_openid ?? "") : senderId;
  if (!senderId || !chatId) return null;
  const content = String(data.content ?? "").trim();
  const attachments = parseAttachments(data.attachments);
  if (!content && attachments.length === 0) return null;
  const at = parseTimestamp(String(data.timestamp ?? ""));
  return {
    channel: "qqbot",
    chatType: isGroup ? "group" : "private",
    messageId: String(data.id ?? ""),
    senderId,
    senderName: typeof author.username === "string" && author.username ? author.username : undefined,
    chatId,
    text: content,
    attachments: attachments.length > 0 ? attachments : undefined,
    at,
    _raw: data,
  };
}

function parseAttachments(raw: unknown): ChannelAttachment[] {
  if (!Array.isArray(raw)) return [];
  const out: ChannelAttachment[] = [];
  for (const item of raw) {
    const a = (item ?? {}) as Record<string, unknown>;
    const contentType = String(a.content_type ?? "");
    const url = String(a.voice_wav_url ?? a.url ?? "");
    if (!url) continue;
    let kind: ChannelAttachment["kind"] = "file";
    if (contentType.startsWith("image/")) kind = "image";
    else if (contentType === "voice") kind = "audio";
    else if (contentType.startsWith("video/")) kind = "video";
    out.push({
      kind,
      url,
      mime: contentType || undefined,
      caption: typeof a.filename === "string" && a.filename ? a.filename : undefined,
    });
  }
  return out;
}

function parseTimestamp(value: string): Date {
  if (value) {
    const t = Date.parse(value);
    if (Number.isFinite(t)) return new Date(t);
  }
  return new Date();
}

export class QqBotAdapter implements ChannelAdapter {
  readonly id = "qqbot" as const;
  readonly displayName = "QQ 机器人（官方）";
  readonly capability = CAPABILITY;
  onMessage: MessageHandler | null = null;
  private activity = new AdapterActivity();

  private api: QqBotApiClient | null = null;
  private ws: QqBotWsClient | null = null;
  private status: ChannelStatus = { enabled: false, phase: "offline", message: "未启用" };
  private botNickname = "";
  private wsReady = false;
  private lastRejected: { openid: string; chatType: "private" | "group"; at: number } | null = null;
  private dedupe = new Map<string, number>();
  /** chatId → 最近一条入站消息（被动回复窗口跟踪） */
  private lastInbound = new Map<string, InboundReplyContext>();

  constructor(private readonly onStatusChanged?: () => void) {}

  async start(parent?: AbortSignal): Promise<void> {
    const signal = this.activity.start(parent);
    const config = loadChannelsSettings().qqbot;
    if (!config.enabled || signal.aborted) {
      this.setStatus({ enabled: false, phase: "offline", message: "未启用" });
      return;
    }
    if (!config.appId || !config.appSecret) {
      this.setStatus({
        enabled: true,
        phase: "config_missing",
        message: "缺少 AppID / AppSecret，请到 q.qq.com 创建机器人后填写",
      });
      return;
    }
    this.setStatus({ enabled: true, phase: "starting", message: "正在连接 QQ 开放平台网关" });
    this.api = new QqBotApiClient({ appId: config.appId, clientSecret: config.appSecret });
    try {
      const gatewayUrl = await this.api.getGatewayUrl();
      if (signal.aborted) return;
      this.ws = new QqBotWsClient({
        gatewayUrl,
        getAccessToken: () => this.api!.getAccessToken(),
        onDispatch: (type, data) => { if (!signal.aborted) this.handleDispatch(type, data); },
        onReadyChange: (ready) => {
          if (signal.aborted) return;
          this.wsReady = ready;
          this.setStatus({
            enabled: true,
            phase: ready ? "running" : "starting",
            message: ready ? `网关已连接${this.botNickname ? `（${this.botNickname}）` : ""}` : "网关重连中",
            detail: this.statusDetail(),
          });
        },
        onError: (error) => {
          if (signal.aborted) return;
          if (this.status.phase === "running" && !this.wsReady) return; // 重连过程中的已知错误不覆盖状态
          this.setStatus({
            enabled: true,
            phase: this.ws?.isReady ? "running" : "error",
            message: error.message,
            detail: this.statusDetail(),
          });
        },
      });
      await this.ws.start();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.setStatus({ enabled: true, phase: "error", message });
      throw error;
    }
  }

  async stop(): Promise<void> {
    this.activity.stop();
    await this.ws?.stop();
    this.ws = null;
    this.api = null;
    this.wsReady = false;
    this.botNickname = "";
    this.lastRejected = null;
    this.dedupe.clear();
    this.lastInbound.clear();
    this.setStatus({ enabled: false, phase: "offline", message: "已停止" });
  }

  getStatus(): ChannelStatus {
    const config = loadChannelsSettings().qqbot;
    if (!config.enabled) return { enabled: false, phase: "offline", message: "未启用" };
    return this.status;
  }

  async testConnection(): Promise<{ ok: boolean; error?: string; detail?: Record<string, unknown> }> {
    const config = loadChannelsSettings().qqbot;
    if (!config.appId || !config.appSecret) return { ok: false, error: "AppID / AppSecret 未配置" };
    try {
      const api = new QqBotApiClient({ appId: config.appId, clientSecret: config.appSecret });
      await api.getGatewayUrl();
      return { ok: true, detail: { appId: config.appId } };
    } catch (error) {
      const err = error instanceof QqBotApiError ? error : error instanceof Error ? error : new Error(String(error));
      return { ok: false, error: err.message };
    }
  }

  async send(msg: OutgoingMessage): Promise<{ ok: boolean; error?: string }> {
    const signal = msg.signal ? AbortSignal.any([msg.signal, this.activity.signal]) : this.activity.signal;
    if (signal.aborted) return { ok: false, error: "channel_stopped" };
    const api = this.api;
    if (!api || !this.wsReady) return { ok: false, error: "QQ 机器人网关未连接" };
    const chatType = msg.chatType ?? "private";
    const inbound = this.lastInbound.get(msg.targetId);
    if (!inbound) return { ok: false, error: "官方 QQ Bot 仅支持被动回复（没有可引用的入站消息）" };
    const windowMs = REPLY_WINDOW_MS[chatType];
    if (Date.now() - inbound.receivedAt > windowMs) {
      return { ok: false, error: `被动回复窗口已过（${chatType === "private" ? "60 分钟" : "5 分钟"}）` };
    }
    const seqLimit = REPLY_SEQ_LIMIT[chatType];
    if (inbound.seqUsed >= seqLimit) {
      return { ok: false, error: `该消息回复次数已达上限（${seqLimit} 次）` };
    }

    const chunks: string[] = [];
    let lastError: string | undefined;
    for (const part of msg.parts) {
      try {
        chunks.push(...this.partToChunks(part));
      } catch (error) {
        lastError = error instanceof Error ? error.message : String(error);
      }
    }
    if (chunks.length === 0) return { ok: false, error: lastError || "没有可发送的 QQ Bot 内容" };

    let sent = 0;
    for (const chunk of chunks) {
      if (signal.aborted) return { ok: false, error: "channel_stopped" };
      if (inbound.seqUsed >= seqLimit) {
        lastError = `回复次数达上限，余下 ${chunks.length - sent} 段未发送`;
        break;
      }
      inbound.seqUsed++;
      try {
        await api.sendText(
          { openid: msg.targetId, chatType },
          chunk,
          { msgId: inbound.messageId, msgSeq: inbound.seqUsed, signal },
        );
        sent++;
      } catch (error) {
        lastError = error instanceof Error ? error.message : String(error);
      }
    }
    if (sent > 0 && lastError) {
      console.warn("[QqBotAdapter] QQ Bot 消息部分发送失败:", lastError);
    }
    return sent > 0 ? { ok: true } : { ok: false, error: lastError || "QQ Bot 发送失败" };
  }

  getConnectionInfo(): Record<string, unknown> {
    return this.statusDetail();
  }

  private handleDispatch(type: QqBotEventType, data: Record<string, unknown>): void {
    if (this.activity.signal.aborted) return;
    if (type === "READY") {
      const user = (data.user ?? {}) as Record<string, unknown>;
      this.botNickname = typeof user.username === "string" ? user.username : "";
      return;
    }
    const incoming = normalizeQqBotEvent(type, data);
    if (!incoming) return;

    const config = loadChannelsSettings().qqbot;
    if (!isQqBotEventAllowed(
      { chatType: incoming.chatType ?? "private", senderId: incoming.senderId, chatId: incoming.chatId },
      config,
    )) {
      this.lastRejected = {
        openid: incoming.chatType === "group" ? incoming.chatId : incoming.senderId,
        chatType: incoming.chatType ?? "private",
        at: Date.now(),
      };
      // 刷新状态快照，让 UI 能看到被拒的 openid（加白名单引导）
      this.setStatus({ ...this.status, detail: this.statusDetail() });
      return;
    }

    const dedupeKey = `${incoming.messageId}`;
    if (dedupeKey) {
      const now = Date.now();
      for (const [key, expiresAt] of this.dedupe) if (expiresAt <= now) this.dedupe.delete(key);
      if (this.dedupe.has(dedupeKey)) return;
      this.dedupe.set(dedupeKey, now + DEDUPE_TTL_MS);
    }

    // 记录被动回复上下文（同一 chatId 的后续 send 都引用这条消息）
    if (incoming.messageId) {
      this.lastInbound.set(incoming.chatId, {
        messageId: incoming.messageId,
        chatType: incoming.chatType ?? "private",
        receivedAt: Date.now(),
        seqUsed: 0,
      });
    }

    void this.deliverIncoming(incoming);
  }

  private async deliverIncoming(incoming: IncomingMessage): Promise<void> {
    const signal = this.activity.signal;
    const onMessage = this.onMessage;
    incoming.signal = signal;
    try {
      await this.downloadAttachments(incoming);
      if (!signal.aborted) await onMessage?.(incoming);
    } catch (error) {
      console.warn("[QqBotAdapter] QQ Bot 消息处理失败:", error instanceof Error ? error.message : String(error));
    }
  }

  private partToChunks(part: OutgoingPart): string[] {
    if (part.kind === "text") return splitQqText(part.text);
    if (part.kind === "card") {
      const text = [part.title, part.markdown, ...(part.fields ?? []).map((f) => `${f.key}: ${f.value}`)]
        .filter(Boolean)
        .join("\n");
      return splitQqText(text);
    }
    throw new Error(`QQ Bot 官方渠道暂不支持发送 ${part.kind} 类型内容`);
  }

  /** 入站附件流式下载到本地缓存（超 8 MiB 中止，避免无界内存）。 */
  private async downloadAttachments(msg: IncomingMessage): Promise<void> {
    if (!msg.attachments?.length) return;
    const dir = path.join(app.getPath("userData"), "channels", "cache", "qqbot");
    fs.mkdirSync(dir, { recursive: true });
    for (const attachment of msg.attachments) {
      if (msg.signal?.aborted) return;
      if (!attachment.url) continue;
      try {
        const res = await fetch(attachment.url, { signal: msg.signal });
        if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
        const reader = res.body.getReader();
        const chunks: Uint8Array[] = [];
        let total = 0;
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          total += value.byteLength;
          if (total > MAX_ATTACHMENT_BYTES) {
            await reader.cancel().catch(() => undefined);
            throw new Error("附件超过 8 MiB 限制");
          }
          chunks.push(value);
        }
        msg.signal?.throwIfAborted();
        const ext = attachment.kind === "image"
          ? (attachment.mime?.split("/")[1] ?? "jpg")
          : attachment.kind === "audio" ? "wav" : attachment.kind === "video" ? "mp4" : "bin";
        const filePath = path.join(dir, `${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`);
        fs.writeFileSync(filePath, Buffer.concat(chunks));
        attachment.filePath = filePath;
        attachment.url = undefined;
      } catch (error) {
        console.warn("[QqBotAdapter] 附件下载失败（保留 URL 占位）:", error instanceof Error ? error.message : String(error));
      }
    }
  }

  private statusDetail(): Record<string, unknown> {
    return {
      appId: loadChannelsSettings().qqbot.appId || undefined,
      botNickname: this.botNickname || undefined,
      wsReady: this.wsReady,
      lastRejectedOpenid: this.lastRejected?.openid,
      lastRejectedChatType: this.lastRejected?.chatType,
      lastRejectedAt: this.lastRejected ? new Date(this.lastRejected.at).toISOString() : undefined,
    };
  }

  private setStatus(status: ChannelStatus): void {
    this.status = status;
    this.onStatusChanged?.();
  }
}
