// QQ 官方机器人 WebSocket 网关客户端。
//
// 协议（官方 opcode 约定，参考 bot.q.qq.com/wiki 事件订阅文档）：
//   op 10 Hello      —— 连上后第一条，d.heartbeat_interval(ms) 指定心跳周期
//   op 2  Identify   —— 客户端鉴权 {token: "QQBot <access_token>", intents, shard, properties}
//   op 0  Dispatch   —— 服务端事件推送 {t: 事件名, s: 序号, d: 事件体}
//   op 1  Heartbeat  —— 客户端心跳，d = 最近收到的 s
//   op 11 Heartbeat ACK
//   op 7  Reconnect  —— 服务端要求重连（优先 Resume）
//   op 6  Resume     —— 断线恢复 {token, session_id, seq}
//   op 9  Invalid Session —— identify/resume 参数错，d=false 时必须重新 Identify
//
// intents：GROUP_AND_C2C_EVENT = 1<<25，覆盖 C2C_MESSAGE_CREATE /
// GROUP_AT_MESSAGE_CREATE / GROUP_MESSAGE_CREATE（群全量，需群主开启）。
import WebSocket from "ws";

/** 单聊 + 群聊（含群 @）事件 */
export const QQBOT_INTENT_GROUP_AND_C2C = 1 << 25;

export type QqBotEventType =
  | "C2C_MESSAGE_CREATE"
  | "GROUP_AT_MESSAGE_CREATE"
  | "GROUP_MESSAGE_CREATE"
  | "READY"
  | "RESUMED";

export interface QqBotWsEvents {
  onDispatch: (type: QqBotEventType, data: Record<string, unknown>) => void;
  /** 连接状态变化（true = 已通过鉴权收到 READY/RESUMED） */
  onReadyChange: (ready: boolean) => void;
  onError: (error: Error) => void;
}

export interface QqBotWsClientOptions extends QqBotWsEvents {
  signal?: AbortSignal;
  /** 网关地址（wss://api.sgroup.qq.com/websocket） */
  gatewayUrl: string;
  /** 返回有效 access_token（过期自动刷新由 ApiClient 负责） */
  getAccessToken: () => Promise<string>;
  /** 只订阅的事件集合，默认单聊 + 群 @ */
  intents?: number;
  /** 重连退避上限（ms），测试可调小 */
  maxBackoffMs?: number;
  /** 测试注入 WebSocket 构造器 */
  websocketFactory?: (url: string) => WebSocket;
}

interface WsPayload {
  op?: number;
  s?: number;
  t?: string;
  d?: unknown;
}

const DEFAULT_MAX_BACKOFF_MS = 60_000;

export class QqBotWsClient {
  private ws: WebSocket | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private stopped = false;
  private seq = 0;
  private sessionId = "";
  private ready = false;
  private backoffMs = 1_000;
  private heartbeatAcked = true;
  private lastError: Error | null = null;
  private readonly onAbort = () => { void this.stop(); };

  constructor(private readonly options: QqBotWsClientOptions) {}

  get isReady(): boolean {
    return this.ready;
  }

  getLastError(): Error | null {
    return this.lastError;
  }

  async start(): Promise<void> {
    if (this.options.signal?.aborted) return;
    this.stopped = false;
    this.options.signal?.addEventListener("abort", this.onAbort, { once: true });
    await this.connect(false);
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.options.signal?.removeEventListener("abort", this.onAbort);
    this.clearTimers();
    const ws = this.ws;
    this.ws = null;
    if (ws && ws.readyState <= WebSocket.OPEN) {
      ws.removeAllListeners();
      try {
        ws.close(1000, "client shutdown");
      } catch {
        // 已断开时 close 会抛错，忽略
      }
    }
    this.setReady(false);
  }

  private async connect(resume: boolean): Promise<void> {
    if (this.stopped) return;
    let token: string;
    try {
      token = await this.options.getAccessToken();
    } catch (error) {
      if (this.stopped) return;
      const err = error instanceof Error ? error : new Error(String(error));
      this.lastError = err;
      this.options.onError(err);
      this.scheduleReconnect();
      return;
    }
    if (this.stopped) return;
    const ws = this.options.websocketFactory
      ? this.options.websocketFactory(this.options.gatewayUrl)
      : new WebSocket(this.options.gatewayUrl);
    this.ws = ws;
    this.heartbeatAcked = true;

    ws.on("message", (raw: unknown) => {
      try {
        this.handlePayload(JSON.parse(String(raw)) as WsPayload, token, resume);
      } catch (error) {
        this.options.onError(error instanceof Error ? error : new Error(String(error)));
      }
    });
    ws.on("error", (error: Error) => {
      this.lastError = error;
      this.options.onError(error);
    });
    ws.on("close", () => {
      this.clearHeartbeat();
      if (this.stopped) return;
      // close 后统一走重连；是否可 Resume 由 connect 内决定
      this.setReady(false);
      this.scheduleReconnect();
    });
  }

  private handlePayload(payload: WsPayload, token: string, resume: boolean): void {
    switch (payload.op) {
      case 10: {
        // Hello：按服务端指定周期发心跳，然后鉴权
        const interval = Number(
          (payload.d as { heartbeat_interval?: number } | null)?.heartbeat_interval ?? 30_000,
        );
        this.startHeartbeat(interval);
        if (resume && this.sessionId && this.seq > 0) {
          this.send({
            op: 6,
            d: { token: `QQBot ${token}`, session_id: this.sessionId, seq: this.seq },
          });
        } else {
          this.sendIdentify(token);
        }
        break;
      }
      case 0: {
        // Dispatch：记录序号 + 抛事件
        if (typeof payload.s === "number") this.seq = payload.s;
        const type = (payload.t ?? "") as QqBotEventType;
        const data = (payload.d ?? {}) as Record<string, unknown>;
        if (type === "READY") {
          this.sessionId = String(data.session_id ?? "");
          this.backoffMs = 1_000;
          this.setReady(true);
        } else if (type === "RESUMED") {
          this.backoffMs = 1_000;
          this.setReady(true);
        } else {
          this.options.onDispatch(type, data);
        }
        break;
      }
      case 11:
        // Heartbeat ACK
        this.heartbeatAcked = true;
        break;
      case 7:
        // 服务端要求重连：优先 Resume
        if (this.ws) {
          try {
            this.ws.close(4000, "server requested reconnect");
          } catch {
            // 忽略
          }
        }
        break;
      case 9: {
        // Invalid Session：重新 Identify（丢弃旧 session）
        this.sessionId = "";
        this.seq = 0;
        setTimeout(() => {
          if (!this.stopped) this.sendIdentify(token);
        }, 3_000);
        break;
      }
      default:
        break;
    }
  }

  private sendIdentify(token: string): void {
    this.send({
      op: 2,
      d: {
        token: `QQBot ${token}`,
        intents: this.options.intents ?? QQBOT_INTENT_GROUP_AND_C2C,
        shard: [0, 1],
        properties: { $os: process.platform, $browser: "cyrene", $device: "cyrene" },
      },
    });
  }

  private startHeartbeat(intervalMs: number): void {
    this.clearHeartbeat();
    this.heartbeatAcked = true;
    this.heartbeatTimer = setInterval(() => {
      if (!this.heartbeatAcked) {
        // 两次心跳没 ACK：连接假死，强制断开触发重连
        this.options.onError(new Error("QQ Bot 心跳超时，重连"));
        try {
          this.ws?.terminate();
        } catch {
          // 忽略
        }
        return;
      }
      this.heartbeatAcked = false;
      this.send({ op: 1, d: this.seq > 0 ? this.seq : null });
    }, Math.max(1_000, intervalMs));
  }

  private send(payload: WsPayload): void {
    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    try {
      ws.send(JSON.stringify(payload));
    } catch (error) {
      this.options.onError(error instanceof Error ? error : new Error(String(error)));
    }
  }

  private scheduleReconnect(): void {
    if (this.stopped || this.reconnectTimer) return;
    const delay = this.backoffMs;
    this.backoffMs = Math.min(this.backoffMs * 2, this.options.maxBackoffMs ?? DEFAULT_MAX_BACKOFF_MS);
    const canResume = Boolean(this.sessionId) && this.seq > 0;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.connect(canResume);
    }, delay);
  }

  private clearHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  private clearTimers(): void {
    this.clearHeartbeat();
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  private setReady(ready: boolean): void {
    if (this.ready === ready) return;
    this.ready = ready;
    this.options.onReadyChange(ready);
  }
}
