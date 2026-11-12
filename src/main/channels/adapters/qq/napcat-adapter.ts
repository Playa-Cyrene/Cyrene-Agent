import { AsyncLocalStorage } from "node:async_hooks";
import type { Server as HttpServer } from "node:http";
import type { ChannelAdapter } from "../base";
import type {
  ChannelCapability,
  ChannelStatus,
  IncomingMessage,
  MessageHandler,
  OutgoingMessage,
  OutgoingPart,
} from "../../types";
import { loadChannelsSettings } from "../../settings-store";
import { OneBotActionClient } from "./onebot-action-client";
import { OneBotMediaManager, versionAtLeast, ONEBOT_STREAM_MIN_VERSION } from "./onebot-media";
import { normalizeOneBotMessage } from "./onebot-normalizer";
import { OneBotReverseWsServer, type OneBotListeningInfo } from "./onebot-reverse-ws";
import {
  isOneBotMessageEvent,
  oneBotId,
  type OneBotEvent,
  type OneBotLoginInfo,
  type OneBotSegment,
  type OneBotVersionInfo,
} from "./onebot-types";
import type { QqChannelConfig } from "../../settings-store";

const CAPABILITY: ChannelCapability = {
  text: true,
  image: true,
  audio: true,
  file: true,
  video: true,
  markdown: false,
  card: false,
  sticker: true,
  maxTextLength: 0,
};

const DEDUPE_TTL_MS = 10 * 60_000;
const TEXT_CHUNK_CODEPOINTS = 1500;

export function splitQqText(text: string, maxCodepoints = TEXT_CHUNK_CODEPOINTS): string[] {
  const source = text.trim();
  if (!source) return [];
  const result: string[] = [];
  let rest = Array.from(source);
  while (rest.length > maxCodepoints) {
    const window = rest.slice(0, maxCodepoints);
    let splitAt = -1;
    for (let i = window.length - 1; i >= Math.floor(maxCodepoints * 0.55); i--) {
      if (/[。！？!?；;…\n]/u.test(window[i])) {
        splitAt = i + 1;
        break;
      }
    }
    if (splitAt < 0) splitAt = maxCodepoints;
    result.push(window.slice(0, splitAt).join("").trim());
    rest = rest.slice(splitAt);
  }
  const tail = rest.join("").trim();
  if (tail) result.push(tail);
  return result.filter(Boolean);
}

export function isQqEventAllowed(
  event: { message_type: "private" | "group"; user_id: string | number; group_id?: string | number; message: OneBotSegment[] },
  config: QqChannelConfig,
  selfId: string,
): boolean {
  const senderId = oneBotId(event.user_id);
  if (event.message_type === "private") return config.allowedPrivateUserIds.includes(senderId);
  const groupId = oneBotId(event.group_id);
  if (!config.allowedGroupIds.includes(groupId)) return false;
  return !config.groupRequireMention || event.message.some((segment) =>
    segment.type === "at" && oneBotId(segment.data.qq) === selfId,
  );
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export interface NapCatMigrationIdentity {
  readonly accountId: string;
  readonly connectionEpoch: number;
}

export interface NapCatMigrationStopResult {
  readonly safeToSwitch: boolean;
  readonly drained: boolean;
  readonly stopped: boolean;
  readonly reason?: string;
}

type ConnectionScope = { client: OneBotActionClient; epoch: number; active: boolean };

export class NapCatAdapter implements ChannelAdapter {
  readonly id = "qq" as const;
  readonly displayName = "QQ（NapCat）";
  readonly capability = CAPABILITY;
  onMessage: MessageHandler | null = null;

  private server: OneBotReverseWsServer | null = null;
  private client: OneBotActionClient | null = null;
  private media = new OneBotMediaManager(() => this.scopedClient(), undefined, () => {
    this.supportsStream = false;
    this.setStatus({
      enabled: true,
      phase: "running",
      message: `NapCat Stream API 不可用；请升级到 ${ONEBOT_STREAM_MIN_VERSION}+`,
      detail: this.statusDetail(),
    });
  });
  private status: ChannelStatus = { enabled: false, phase: "offline", message: "未启用" };
  private selfId = "";
  private nickname = "";
  private appVersion = "";
  private supportsStream = false;
  private listeningInfo: OneBotListeningInfo | null = null;
  private connectionEpoch = 0;
  private acceptingInbound = false;
  private quiescing = false;
  private starting: Promise<void> | null = null;
  private stopping: Promise<void> | null = null;
  private migration: Promise<NapCatMigrationStopResult> | null = null;
  private migrationIdentity: NapCatMigrationIdentity | null = null;
  private readonly scope = new AsyncLocalStorage<ConnectionScope>();
  private readonly pending = new Set<Promise<unknown>>();
  private dedupe = new Map<string, number>();

  constructor(private readonly onStatusChanged?: () => void) {}

  start(): Promise<void> {
    if (this.quiescing || this.stopping) return Promise.reject(new Error("QQ 正在停收，不能启动"));
    if (this.starting) return this.starting;
    if (this.server) return Promise.resolve();
    this.starting = this.startImpl().finally(() => { this.starting = null; });
    return this.starting;
  }

  private async startImpl(): Promise<void> {
    const config = loadChannelsSettings().qq;
    if (!config.enabled) {
      this.setStatus({ enabled: false, phase: "offline", message: "未启用" });
      return;
    }
    this.acceptingInbound = true;
    this.setStatus({ enabled: true, phase: "starting", message: "正在启动 OneBot 监听" });
    await this.media.start();
    this.server = new OneBotReverseWsServer({
      listenMode: config.listenMode,
      customHost: config.customHost,
      port: config.port,
      accessToken: config.accessToken,
      onEvent: (event, client) => this.acceptEvent(event, client),
      onClientConnected: (client, info) => this.handleConnected(client, info.headerSelfId),
      onClientDisconnected: () => {
        this.connectionEpoch++;
        this.client = null;
        this.selfId = "";
        this.setStatus({
          enabled: true,
          phase: "starting",
          message: "监听中，等待 NapCat 重连",
          detail: this.statusDetail(),
        });
      },
      onError: (error) => {
        this.setStatus({
          enabled: true,
          phase: "error",
          message: error.message,
          detail: this.statusDetail(),
        });
      },
    });
    try {
      this.listeningInfo = await this.server.start();
      this.setStatus({
        enabled: true,
        phase: "starting",
        message: "监听中，等待 NapCat 连接",
        detail: this.statusDetail(),
      });
    } catch (error) {
      this.media.stop();
      this.server = null;
      const message = error instanceof Error ? error.message : String(error);
      this.setStatus({ enabled: true, phase: "error", message });
      throw error;
    }
  }

  stop(): Promise<void> {
    this.acceptingInbound = false;
    this.connectionEpoch++;
    this.client = null;
    this.selfId = "";
    if (this.stopping) return this.stopping;
    this.stopping = this.stopImpl().finally(() => { this.stopping = null; });
    return this.stopping;
  }

  private async stopImpl(): Promise<void> {
    await this.starting?.catch(() => undefined);
    this.media.stop();
    await this.server?.stop();
    this.server = null;
    this.client = null;
    this.selfId = "";
    this.nickname = "";
    this.appVersion = "";
    this.supportsStream = false;
    this.listeningInfo = null;
    this.dedupe.clear();
    this.setStatus({ enabled: false, phase: "offline", message: "已停止" });
  }

  getStatus(): ChannelStatus {
    const config = loadChannelsSettings().qq;
    if (!config.enabled) return { enabled: false, phase: "offline", message: "未启用" };
    return this.status;
  }

  getConnectionInfo(): Record<string, unknown> {
    return this.statusDetail();
  }

  async testConnection(): Promise<{ ok: boolean; error?: string; detail?: Record<string, unknown> }> {
    if (!this.client || !this.selfId) return { ok: false, error: "NapCat 尚未连接" };
    try {
      const status = await this.client.call<Record<string, unknown>>("get_status");
      return { ok: true, detail: { ...this.statusDetail(), protocolStatus: status } };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  }

  send(msg: OutgoingMessage): Promise<{ ok: boolean; error?: string }> {
    const inherited = this.scope.getStore();
    const client = this.scopedClient();
    if (!client || (this.quiescing && !inherited)) {
      return Promise.resolve({ ok: false, error: "QQ 连接已变化或正在停收" });
    }
    const scope = inherited ?? { client, epoch: this.connectionEpoch, active: true };
    return this.track(this.scope.run(scope, () => this.sendImpl(msg))).finally(() => {
      if (!inherited) scope.active = false;
    });
  }

  private async sendImpl(msg: OutgoingMessage): Promise<{ ok: boolean; error?: string }> {
    const client = this.scopedClient();
    if (!client || !this.selfId) return { ok: false, error: "NapCat 未连接" };
    const payloads: OneBotSegment[][] = [];
    let lastError: string | undefined;

    for (const part of msg.parts) {
      try {
        payloads.push(...await this.partToPayloads(part));
      } catch (error) {
        lastError = error instanceof Error ? error.message : String(error);
      }
    }
    if (payloads.length === 0) return { ok: false, error: lastError || "没有可发送的 QQ 内容" };

    let sent = 0;
    for (let index = 0; index < payloads.length; index++) {
      const segments = [...payloads[index]];
      if (index === 0 && msg.chatType === "group" && msg.replyContext) {
        const prefix: OneBotSegment[] = [{ type: "reply", data: { id: msg.replyContext.messageId } }];
        if (msg.replyContext.mentionUserId) {
          prefix.push(
            { type: "at", data: { qq: msg.replyContext.mentionUserId } },
            { type: "text", data: { text: " " } },
          );
        }
        segments.unshift(...prefix);
      }
      try {
        if (this.scopedClient() !== client) throw new Error("QQ 连接轮次已变化，拒绝发送");
        if (msg.chatType === "group") {
          await client.call("send_group_msg", { group_id: msg.targetId, message: segments });
        } else {
          await client.call("send_private_msg", { user_id: msg.targetId, message: segments });
        }
        sent++;
      } catch (error) {
        lastError = error instanceof Error ? error.message : String(error);
      }
      if (index < payloads.length - 1) await delay(500);
    }
    if (sent > 0 && lastError) {
      console.warn("[NapCatAdapter] QQ 消息部分发送失败:", lastError);
    }
    return sent > 0 ? { ok: true } : { ok: false, error: lastError || "QQ 发送失败" };
  }

  private async handleConnected(client: OneBotActionClient, headerSelfId?: string): Promise<void> {
    const epoch = ++this.connectionEpoch;
    this.client = null;
    this.selfId = "";
    if (!this.acceptingInbound || this.quiescing) throw new Error("QQ 已停收");
    const login = await client.call<OneBotLoginInfo>("get_login_info");
    const version = await client.call<OneBotVersionInfo>("get_version_info");
    const selfId = oneBotId(login.user_id);
    if (!selfId) throw new Error("NapCat get_login_info 未返回 user_id");
    if (headerSelfId && headerSelfId !== selfId) throw new Error("NapCat X-Self-ID 与 get_login_info 不一致");
    if (epoch !== this.connectionEpoch || !this.acceptingInbound || this.quiescing) {
      throw new Error("QQ 握手期间连接已变化或停收");
    }
    this.client = client;
    this.selfId = selfId;
    this.nickname = login.nickname ?? "";
    this.appVersion = version.app_version ?? "";
    this.supportsStream = versionAtLeast(this.appVersion, ONEBOT_STREAM_MIN_VERSION);
    this.setStatus({
      enabled: true,
      phase: "running",
      message: this.supportsStream ? "NapCat 已连接" : `NapCat 已连接；媒体流需要 ${ONEBOT_STREAM_MIN_VERSION}+`,
      detail: this.statusDetail(),
    });
  }

  private scopedClient(): OneBotActionClient | null {
    const scope = this.scope.getStore();
    if (scope && (!scope.active || scope.epoch !== this.connectionEpoch || scope.client !== this.client)) return null;
    return this.client;
  }

  private track<T>(promise: Promise<T>): Promise<T> {
    this.pending.add(promise);
    void promise.then(() => this.pending.delete(promise), () => this.pending.delete(promise));
    return promise;
  }

  private acceptEvent(event: OneBotEvent, client: OneBotActionClient): Promise<void> {
    if (!this.acceptingInbound || this.quiescing || client !== this.client) return Promise.resolve();
    const scope = { client, epoch: this.connectionEpoch, active: true };
    return this.track(this.scope.run(scope, () => this.handleEvent(event, client)))
      .finally(() => { scope.active = false; });
  }

  /** 只暴露已完成登录校验的身份，配置值和握手头不能作为账号证明。 */
  getMigrationIdentity(): Readonly<NapCatMigrationIdentity> | null {
    return this.client && this.selfId && !this.quiescing
      ? Object.freeze({ accountId: this.selfId, connectionEpoch: this.connectionEpoch })
      : null;
  }

  /** 尚无生产调用点。停收后的失败尝试保持关闭，绝不授权切换；恢复须创建新实例。 */
  prepareMigrationStop(options: NapCatMigrationIdentity & { timeoutMs?: number }): Promise<NapCatMigrationStopResult> {
    if (this.migration) {
      if (this.migrationIdentity?.accountId !== options.accountId
        || this.migrationIdentity.connectionEpoch !== options.connectionEpoch) {
        return Promise.resolve({ safeToSwitch: false, drained: false, stopped: false, reason: "identity-changed" });
      }
      return this.migration;
    }
    const identity = this.getMigrationIdentity();
    if (!identity || identity.accountId !== options.accountId || identity.connectionEpoch !== options.connectionEpoch) {
      return Promise.resolve({ safeToSwitch: false, drained: false, stopped: false, reason: "identity-changed" });
    }
    const timeoutMs = options.timeoutMs ?? 10_000;
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > 120_000) {
      return Promise.resolve({ safeToSwitch: false, drained: false, stopped: false, reason: "invalid-timeout" });
    }
    this.quiescing = true;
    this.acceptingInbound = false;
    this.migrationIdentity = identity;
    this.migration = this.drainAndStop(identity, timeoutMs);
    return this.migration;
  }

  private async drainAndStop(identity: NapCatMigrationIdentity, timeoutMs: number): Promise<NapCatMigrationStopResult> {
    let drained = false;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const work = async (): Promise<NapCatMigrationStopResult> => {
      while (this.pending.size) await Promise.allSettled([...this.pending]);
      drained = true;
      const unchanged = this.connectionEpoch === identity.connectionEpoch && this.selfId === identity.accountId;
      // 旧 server.stop() 即使尚未关闭也可能在兜底超时后 resolve，必须独立观察 close。
      // 为保持旧服务器实现不变，此处只读其 listener；结构变化时保守拒绝切换。
      const httpServer = (this.server as unknown as { httpServer?: HttpServer } | null)?.httpServer;
      if (!httpServer) {
        await this.stop();
        return { safeToSwitch: false, drained, stopped: false, reason: "stop-unverifiable" };
      }
      const closed = new Promise<void>((resolve) => httpServer.once("close", resolve));
      await this.stop();
      await closed;
      stopped = true;
      return { safeToSwitch: unchanged, drained, stopped, ...(unchanged ? {} : { reason: "connection-changed" }) };
    };
    try {
      return await Promise.race([
        work().catch((error): NapCatMigrationStopResult => ({
          safeToSwitch: false, drained, stopped, reason: error instanceof Error ? error.message : String(error),
        })),
        new Promise<NapCatMigrationStopResult>((resolve) => {
          timer = setTimeout(() => {
            // 立即撤销在途连接上下文。清理继续进行，但本次超时结果永远不能升级为成功。
            void this.stop().catch(() => undefined);
            resolve({ safeToSwitch: false, drained, stopped, reason: "timeout" });
          }, timeoutMs);
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  private async handleEvent(event: OneBotEvent, client: OneBotActionClient): Promise<void> {
    if (!isOneBotMessageEvent(event) || event.post_type !== "message") return;
    if (!this.selfId || oneBotId(event.self_id) !== this.selfId || oneBotId(event.user_id) === this.selfId) return;

    const config = loadChannelsSettings().qq;
    const senderId = oneBotId(event.user_id);
    const chatId = event.message_type === "group" ? oneBotId(event.group_id) : senderId;
    if (!chatId) return;
    if (!isQqEventAllowed(event, config, this.selfId)) return;

    const dedupeKey = `${this.selfId}:${oneBotId(event.message_id)}`;
    const now = Date.now();
    for (const [key, expiresAt] of this.dedupe) if (expiresAt <= now) this.dedupe.delete(key);
    if (this.dedupe.has(dedupeKey)) return;
    this.dedupe.set(dedupeKey, now + DEDUPE_TTL_MS);

    try {
      const incoming = await normalizeOneBotMessage(event, {
        selfId: this.selfId,
        client,
        media: this.media,
        supportsStream: this.supportsStream,
      });
      if (this.scopedClient() !== client) return;
      await this.onMessage?.(incoming);
    } catch (error) {
      console.warn("[NapCatAdapter] QQ 消息处理失败:", error instanceof Error ? error.message : String(error));
    }
  }

  private async partToPayloads(part: OutgoingPart): Promise<OneBotSegment[][]> {
    if (part.kind === "text") {
      return splitQqText(part.text).map((text) => [{ type: "text", data: { text } }]);
    }
    if (part.kind === "card") {
      const text = [part.title, part.markdown, ...(part.fields ?? []).map((field) => `${field.key}: ${field.value}`)]
        .filter(Boolean)
        .join("\n");
      return splitQqText(text).map((value) => [{ type: "text", data: { text: value } }]);
    }
    if (part.kind === "image") {
      const file = part.filePath
        ? await this.media.encodeOutbound(part.filePath, "image", this.supportsStream)
        : part.url;
      if (!file) throw new Error("QQ 图片缺少 filePath/url");
      return [[{ type: "image", data: { file } }]];
    }
    if (part.kind === "sticker") {
      const file = await this.media.encodeOutbound(part.imagePath, "image", this.supportsStream);
      return [[{ type: "image", data: { file } }]];
    }
    if (part.kind === "audio") {
      const file = await this.media.encodeOutbound(part.filePath, "audio", this.supportsStream);
      return [[{ type: "record", data: { file } }]];
    }
    if (part.kind === "file") {
      const file = await this.media.encodeOutbound(part.filePath, "file", this.supportsStream);
      return [[{ type: "file", data: { file, name: part.name } }]];
    }
    const file = await this.media.encodeOutbound(part.filePath, "video", this.supportsStream);
    return [[{ type: "video", data: { file } }]];
  }

  private statusDetail(): Record<string, unknown> {
    return {
      listenUrl: this.listeningInfo?.url,
      listenHost: this.listeningInfo?.host,
      listenMode: this.listeningInfo?.mode,
      selfId: this.selfId || undefined,
      nickname: this.nickname || undefined,
      appVersion: this.appVersion || undefined,
      supportsStream: this.supportsStream,
      streamMinimumVersion: ONEBOT_STREAM_MIN_VERSION,
    };
  }

  private setStatus(status: ChannelStatus): void {
    this.status = status;
    this.onStatusChanged?.();
  }
}
