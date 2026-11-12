import * as http from "node:http";
import { timingSafeEqual } from "node:crypto";
import { WebSocketServer, type WebSocket } from "ws";
import { OneBotActionClient } from "./onebot-action-client";
import type { OneBotEvent } from "./onebot-types";
import type { QqListenMode } from "../../../../shared/qq-listen";
import { isLoopbackHost, resolveOneBotListenHost } from "../../qq-listen-policy";

// 保留既有导出，调用方与宿主预检共享同一份策略实现。
export {
  isLoopbackHost,
  resolveOneBotListenHost,
  resolveQqListenAuthRequirement,
} from "../../qq-listen-policy";

export const ONEBOT_WS_PATH = "/onebot/v11/ws";

export interface OneBotReverseWsOptions {
  listenMode: QqListenMode;
  customHost?: string;
  port: number;
  accessToken?: string;
  path?: string;
  heartbeatTimeoutMs?: number;
  onEvent: (event: OneBotEvent, client: OneBotActionClient) => void | Promise<void>;
  onClientConnected: (
    client: OneBotActionClient,
    info: { headerSelfId?: string; remoteAddress?: string },
  ) => void | Promise<void>;
  onClientDisconnected?: (reason?: string) => void;
  onError?: (error: Error) => void;
}

export interface OneBotListeningInfo {
  host: string;
  port: number;
  path: string;
  url: string;
  mode: QqListenMode;
}

function tokenMatches(header: string | undefined, expected: string): boolean {
  if (!expected) return true;
  const actual = header?.startsWith("Bearer ") ? header.slice(7) : "";
  const expectedBuffer = Buffer.from(expected, "utf8");
  const actualBuffer = Buffer.from(actual, "utf8");
  return expectedBuffer.length === actualBuffer.length
    && timingSafeEqual(expectedBuffer, actualBuffer);
}

export class OneBotReverseWsServer {
  private httpServer: http.Server | null = null;
  private wsServer: WebSocketServer | null = null;
  private socket: WebSocket | null = null;
  private actionClient: OneBotActionClient | null = null;
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private lastSeenAt = 0;
  private activeHeaderSelfId: string | undefined;
  private listeningInfo: OneBotListeningInfo | null = null;

  constructor(private readonly options: OneBotReverseWsOptions) {}

  async start(): Promise<OneBotListeningInfo> {
    if (this.httpServer) return this.listeningInfo!;
    const { host, resolvedMode } = resolveOneBotListenHost(
      this.options.listenMode,
      this.options.customHost,
    );
    const token = this.options.accessToken?.trim() ?? "";
    if (!isLoopbackHost(host) && !token) {
      throw new Error(`QQ 监听非回环地址 ${host} 时必须配置 Access Token（该网络上任意进程都可冒充 NapCat 注入消息）`);
    }
    const path = this.options.path ?? ONEBOT_WS_PATH;
    const httpServer = http.createServer((_req, res) => {
      res.writeHead(404, { "content-type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ ok: false, error: "not_found" }));
    });
    const wsServer = new WebSocketServer({ noServer: true, maxPayload: 110 * 1024 * 1024 });
    wsServer.on("error", (error) => this.options.onError?.(error));

    httpServer.on("upgrade", (req, socket, head) => {
      const requestPath = new URL(req.url ?? "/", "http://localhost").pathname;
      if (requestPath !== path) {
        socket.write("HTTP/1.1 404 Not Found\r\n\r\n");
        socket.destroy();
        return;
      }
      if (!tokenMatches(req.headers.authorization, token)) {
        socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
        socket.destroy();
        return;
      }
      wsServer.handleUpgrade(req, socket, head, (webSocket) => {
        wsServer.emit("connection", webSocket, req);
      });
    });

    wsServer.on("connection", (socket, req) => {
      const headerSelfId = Array.isArray(req.headers["x-self-id"])
        ? req.headers["x-self-id"][0]
        : req.headers["x-self-id"];
      if (!headerSelfId) {
        socket.close(4002, "X-Self-ID is required");
        return;
      }
      if (this.socket && this.socket.readyState === 1) {
        if (this.activeHeaderSelfId && headerSelfId && this.activeHeaderSelfId !== headerSelfId) {
          socket.close(4003, "another QQ account is already connected");
          return;
        }
        this.socket.close(4001, "replaced by reconnect");
      }

      const client = new OneBotActionClient(socket);
      this.socket = socket;
      this.actionClient = client;
      this.activeHeaderSelfId = headerSelfId;
      this.lastSeenAt = Date.now();

      socket.on("message", (raw) => {
        this.lastSeenAt = Date.now();
        let value: unknown;
        try {
          value = JSON.parse(raw.toString("utf8"));
        } catch {
          return;
        }
        if (client.handleResponse(value)) return;
        void Promise.resolve(this.options.onEvent(value as OneBotEvent, client)).catch((error) => {
          this.options.onError?.(error instanceof Error ? error : new Error(String(error)));
        });
      });
      socket.once("close", (_code, reason) => {
        client.rejectAll();
        if (this.socket === socket) {
          this.socket = null;
          this.actionClient = null;
          this.activeHeaderSelfId = undefined;
          this.options.onClientDisconnected?.(reason.toString("utf8") || undefined);
        }
      });
      socket.on("error", (error) => this.options.onError?.(error));
      void Promise.resolve(this.options.onClientConnected(client, {
        headerSelfId,
        remoteAddress: req.socket.remoteAddress,
      })).catch((error) => {
        this.options.onError?.(error instanceof Error ? error : new Error(String(error)));
        socket.close(1011, "OneBot handshake failed");
      });
    });

    try {
      await new Promise<void>((resolve, reject) => {
        const onError = (error: Error) => reject(error);
        httpServer.once("error", onError);
        httpServer.listen(this.options.port, host, () => {
          httpServer.off("error", onError);
          resolve();
        });
      });
    } catch (error) {
      wsServer.close();
      httpServer.close();
      throw error;
    }

    this.httpServer = httpServer;
    this.wsServer = wsServer;
    const displayHost = host.includes(":") ? `[${host}]` : host;
    const address = httpServer.address();
    const actualPort = typeof address === "object" && address ? address.port : this.options.port;
    this.listeningInfo = {
      host,
      port: actualPort,
      path,
      url: `ws://${displayHost}:${actualPort}${path}`,
      mode: resolvedMode,
    };
    const heartbeatTimeoutMs = this.options.heartbeatTimeoutMs ?? 90_000;
    this.heartbeatTimer = setInterval(() => {
      if (this.socket && Date.now() - this.lastSeenAt > heartbeatTimeoutMs) {
        this.socket.close(4000, "heartbeat timeout");
      }
    }, Math.min(30_000, Math.max(50, Math.floor(heartbeatTimeoutMs / 3))));
    this.heartbeatTimer.unref?.();
    return this.listeningInfo;
  }

  async stop(): Promise<void> {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = null;
    this.actionClient?.rejectAll("OneBot reverse WebSocket stopped");
    this.socket?.terminate();
    this.socket = null;
    this.actionClient = null;
    this.activeHeaderSelfId = undefined;
    this.wsServer?.close();
    this.wsServer = null;
    if (this.httpServer) {
      const server = this.httpServer;
      this.httpServer = null;
      // 404 handler 返回的是 keep-alive 响应，浏览器/端口扫描器摸一下端口就会留下空闲连接，
      // server.close() 要等所有连接自然断开才回调 → 应用退出被永久阻塞。
      // 强制断开全部连接（Node ≥ 18.2），并加 3s 兜底超时。
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, 3_000);
        timer.unref?.();
        server.close(() => {
          clearTimeout(timer);
          resolve();
        });
        server.closeAllConnections?.();
      });
    }
    this.listeningInfo = null;
  }

  get client(): OneBotActionClient | null {
    return this.actionClient;
  }

  get info(): OneBotListeningInfo | null {
    return this.listeningInfo;
  }
}
