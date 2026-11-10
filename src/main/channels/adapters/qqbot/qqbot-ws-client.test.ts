import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import { QqBotWsClient, QQBOT_INTENT_GROUP_AND_C2C } from "./qqbot-ws-client";

class FakeWebSocket extends EventEmitter {
  static OPEN = 1;
  readyState = 1;
  sent: unknown[] = [];
  terminated = false;
  closed = false;

  send(data: string): void {
    this.sent.push(JSON.parse(data));
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.readyState = 3;
    this.emit("close");
  }

  terminate(): void {
    this.terminated = true;
    this.readyState = 3;
    this.emit("close");
  }

  /** 模拟服务端下发 */
  receive(payload: unknown): void {
    this.emit("message", JSON.stringify(payload));
  }
}

const clients: QqBotWsClient[] = [];
const sockets: FakeWebSocket[] = [];

afterEach(async () => {
  vi.useRealTimers();
  for (const client of clients.splice(0)) await client.stop();
  sockets.length = 0;
});

function createClient(): { client: QqBotWsClient; socket: FakeWebSocket } {
  const socket = new FakeWebSocket();
  sockets.push(socket);
  const client = new QqBotWsClient({
    gatewayUrl: "wss://fake",
    getAccessToken: async () => "fake-token",
    onDispatch: () => undefined,
    onReadyChange: () => undefined,
    onError: () => undefined,
    websocketFactory: () => socket,
  });
  clients.push(client);
  return { client, socket };
}

function sentOp(socket: FakeWebSocket, op: number): Record<string, unknown> | undefined {
  const payload = socket.sent.find((p) => (p as { op?: number }).op === op);
  return payload as Record<string, unknown> | undefined;
}

describe("QqBotWsClient protocol", () => {
  it.each([false, true])("连接撤销后迟到的鉴权不会创建连接或重试 cancelledWithError=%s", async (reject) => {
    vi.useFakeTimers();
    const activity = new AbortController();
    const token = Promise.withResolvers<string>();
    const factory = vi.fn(() => new FakeWebSocket() as never);
    const onError = vi.fn();
    const client = new QqBotWsClient({
      gatewayUrl: "wss://synthetic.invalid", signal: activity.signal,
      getAccessToken: () => token.promise,
      onDispatch: () => {}, onReadyChange: () => {}, onError,
      websocketFactory: factory,
    });
    clients.push(client);
    const starting = client.start();
    activity.abort(new Error("channel_stopped"));
    if (reject) token.reject(activity.signal.reason);
    else token.resolve("synthetic");
    await starting;
    expect(factory).not.toHaveBeenCalled();
    expect(onError).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("sends Identify with QQBot token and C2C/group intents after Hello", async () => {
    const { client, socket } = createClient();
    await client.start();
    socket.receive({ op: 10, d: { heartbeat_interval: 30_000 } });
    const identify = sentOp(socket, 2);
    expect(identify).toBeDefined();
    expect((identify!.d as { token: string }).token).toBe("QQBot fake-token");
    expect((identify!.d as { intents: number }).intents).toBe(QQBOT_INTENT_GROUP_AND_C2C);
  });

  it("marks ready on READY and forwards message events with seq tracking", async () => {
    const events: Array<{ type: string; data: Record<string, unknown> }> = [];
    const socket = new FakeWebSocket();
    sockets.push(socket);
    const client = new QqBotWsClient({
      gatewayUrl: "wss://fake",
      getAccessToken: async () => "fake-token",
      onDispatch: (type, data) => events.push({ type, data }),
      onReadyChange: () => undefined,
      onError: () => undefined,
      websocketFactory: () => socket,
    });
    clients.push(client);
    await client.start();
    socket.receive({ op: 10, d: { heartbeat_interval: 30_000 } });
    socket.receive({ op: 0, t: "READY", s: 1, d: { session_id: "sess-1" } });
    expect(client.isReady).toBe(true);

    socket.receive({ op: 0, t: "C2C_MESSAGE_CREATE", s: 2, d: { id: "m1", content: "hi" } });
    socket.receive({ op: 0, t: "GROUP_AT_MESSAGE_CREATE", s: 3, d: { group_openid: "g1" } });
    expect(events.map((e) => e.type)).toEqual(["C2C_MESSAGE_CREATE", "GROUP_AT_MESSAGE_CREATE"]);
  });

  it("sends heartbeats carrying the latest seq and terminates when ACK is missing", async () => {
    vi.useFakeTimers();
    const { socket } = createClient();
    const client = clients[clients.length - 1];
    await client.start();
    socket.receive({ op: 10, d: { heartbeat_interval: 1_000 } });
    socket.receive({ op: 0, t: "READY", s: 42, d: { session_id: "sess-1" } });

    vi.advanceTimersByTime(1_000);
    const heartbeat = sentOp(socket, 1);
    expect(heartbeat).toMatchObject({ op: 1, d: 42 });

    // 无 ACK 的下一次心跳 → terminate 触发重连
    vi.advanceTimersByTime(1_000);
    vi.advanceTimersByTime(1_000);
    expect(socket.terminated).toBe(true);
  });

  it("reconnects and Resumes with session_id and seq after server-requested reconnect", async () => {
    vi.useFakeTimers();
    const sockets: FakeWebSocket[] = [];
    let client: QqBotWsClient;
    client = new QqBotWsClient({
      gatewayUrl: "wss://fake",
      getAccessToken: async () => "fake-token",
      onDispatch: () => undefined,
      onReadyChange: () => undefined,
      onError: () => undefined,
      websocketFactory: () => {
        const socket = new FakeWebSocket();
        sockets.push(socket);
        return socket;
      },
    });
    clients.push(client);
    await client.start();
    sockets[0].receive({ op: 10, d: { heartbeat_interval: 30_000 } });
    sockets[0].receive({ op: 0, t: "READY", s: 7, d: { session_id: "sess-9" } });

    sockets[0].receive({ op: 7 });
    expect(sockets[0].closed).toBe(true);

    // 退避 1s 后用新连接 Resume
    await vi.advanceTimersByTimeAsync(1_100);
    expect(sockets).toHaveLength(2);
    sockets[1].receive({ op: 10, d: { heartbeat_interval: 30_000 } });
    const resume = sentOp(sockets[1], 6);
    expect(resume).toMatchObject({
      op: 6,
      d: { token: "QQBot fake-token", session_id: "sess-9", seq: 7 },
    });
  });
});
