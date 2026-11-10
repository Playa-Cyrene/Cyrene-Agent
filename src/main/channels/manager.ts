// ChannelManager —— 渠道注册表 + 生命周期管理。
//
// 设计原则：
//   - Manager 只做"哪个渠道注册了、它们的启停状态"。不知道任何平台协议细节。
//   - 入站消息路径：adapters.onMessage → manager.handleIncoming(msg) → dispatcher。
//     实际转发由 dispatcher 负责；manager 只持有 dispatcher 的入口引用。
//   - 出站消息路径：dispatcher 拿到 outgoing 后调 adapter.send(outgoing)。
//   - Manager 不感知 sessionId、不感知 cap 降级、不感知 tool 调用 —— 全部下放。
import type { ChannelAdapter } from "./adapters/base";
import type { ChannelId, ChannelStatus, IncomingMessage, OutgoingMessage } from "./types";
import { setAdapterHandler } from "./adapters/base";
import { logger, LogTag } from "../logger";
import { createKeyedQueue } from "./keyed-queue";

const LOG = "[ChannelManager]";

/** dispatcher 给 manager 的回调 —— 拿到入站消息后返回一个 outgoing 消息 */
export type DispatchFn = (msg: IncomingMessage) => Promise<OutgoingMessage | null>;

export class ChannelManager {
  private adapters = new Map<ChannelId, ChannelAdapter>();
  private dispatchFn: DispatchFn | null = null;
  /** 启动后已开启的 adapter（start 成功的才会调 stop） */
  private startedAdapters = new Set<ChannelId>();
  private activities = new Map<ChannelId, AbortController>();
  private revisions = new Map<ChannelId, number>();
  private lifecycleQueue = createKeyedQueue();

  has(id: ChannelId): boolean {
    return this.adapters.has(id);
  }

  /** 注册 adapter（必须在 startAll 之前调用；重复 id 一律拒绝） */
  register(adapter: ChannelAdapter): void {
    if (this.adapters.has(adapter.id)) {
      throw new Error(`渠道 ${adapter.id} 已注册，禁止覆盖现有实例`);
    }
    this.adapters.set(adapter.id, adapter);
  }

  /** 设置 dispatcher 入口。注册 adapter 时机不限，dispatcher 注入必须早于 startAll。 */
  setDispatcher(fn: DispatchFn): void {
    this.dispatchFn = fn;
  }

  /** 启动所有已注册 adapter（失败的跳过、记 log） */
  async startAll(): Promise<void> {
    for (const adapter of this.adapters.values()) {
      try {
        await this.startOne(adapter.id);
      } catch (err) {
        console.error(LOG, `渠道启动失败 [${adapter.id}]:`, err instanceof Error ? err.message : err);
      }
    }
  }

  /** 注销 adapter：若已启动先 stop，再移除（运行时禁用插件渠道用） */
  async unregister(id: ChannelId): Promise<boolean> {
    const adapter = this.adapters.get(id);
    if (!adapter) return false;
    this.revisions.set(id, (this.revisions.get(id) ?? 0) + 1);
    this.activities.get(id)?.abort(new Error("channel_stopped"));
    await this.lifecycleQueue.run(id, async () => {
      if (this.adapters.get(id) !== adapter) return;
      try {
        if (this.activities.has(id)) await adapter.stop();
      } catch (err) {
        console.warn(LOG, `渠道停止失败 [${id}]:`, err instanceof Error ? err.message : err);
      } finally {
        this.activities.delete(id);
        this.startedAdapters.delete(id);
        setAdapterHandler(adapter, null);
        this.adapters.delete(id);
      }
    });
    logger.info(LogTag.Channels, `unregistered: ${id}`);
    return true;
  }

  /** 启动单个 adapter（运行时启用插件渠道用） */
  async startOne(id: ChannelId): Promise<void> {
    const adapter = this.adapters.get(id);
    if (!adapter) return;
    const revision = this.revisions.get(id);
    return this.lifecycleQueue.run(id, async () => {
      if (this.adapters.get(id) !== adapter || this.revisions.get(id) !== revision) return;
      if (this.startedAdapters.has(id)) return;
      const activity = new AbortController();
      this.activities.set(id, activity);
      setAdapterHandler(adapter, this.makeAdapterHandler(id, activity.signal));
      try {
        await adapter.start(activity.signal);
        if (!activity.signal.aborted) this.startedAdapters.add(id);
        logger.info(LogTag.Channels, `started: ${id} (${adapter.displayName})`);
      } catch (error) {
        activity.abort(error);
        try { await adapter.stop(); } catch (stopError) { console.warn(LOG, stopError); }
        throw error;
      }
    });
  }

  /** 先同步撤销业务处理，再等待连接释放；不会停止其他渠道。 */
  async stopOne(id: ChannelId): Promise<void> {
    const adapter = this.adapters.get(id);
    if (!adapter) return;
    this.revisions.set(id, (this.revisions.get(id) ?? 0) + 1);
    this.activities.get(id)?.abort(new Error("channel_stopped"));
    return this.lifecycleQueue.run(id, async () => {
      if (this.adapters.get(id) !== adapter) return;
      try {
        if (adapter && this.activities.has(id)) await adapter.stop();
      } finally {
        this.activities.delete(id);
        this.startedAdapters.delete(id);
        if (adapter) setAdapterHandler(adapter, null);
      }
    });
  }

  getActivitySignal(id: ChannelId): AbortSignal | undefined {
    return this.activities.get(id)?.signal;
  }

  /** 关闭所有已启动的 adapter */
  async stopAll(): Promise<void> {
    const stopping = [...this.adapters.keys()].map(async (id) => {
      try {
        await this.stopOne(id);
      } catch (err) {
        console.warn(LOG, `渠道停止失败 [${id}]:`, err instanceof Error ? err.message : err);
      }
    });
    await Promise.all(stopping);
  }

  getAdapter(channel: ChannelId): ChannelAdapter | undefined {
    return this.adapters.get(channel);
  }

  listChannels(): ChannelId[] {
    return Array.from(this.adapters.keys());
  }

  /** 给 UI 用：所有渠道的实时状态 */
  getAllStatus(): Record<ChannelId, ChannelStatus> {
    const out: Partial<Record<ChannelId, ChannelStatus>> = {};
    for (const [id, adapter] of this.adapters.entries()) {
      out[id] = adapter.getStatus();
    }
    return out as Record<ChannelId, ChannelStatus>;
  }

  private makeAdapterHandler(channel: ChannelId, signal: AbortSignal) {
    return async (msg: IncomingMessage): Promise<OutgoingMessage | null> => {
      if (signal.aborted || msg.signal?.aborted || msg.channel !== channel) return null;
      if (!this.dispatchFn) {
        console.warn(LOG, `收到入站消息但 dispatcher 未注册 [${channel}]`);
        return null;
      }
      try {
        return await this.dispatchFn({
          ...msg,
          signal: msg.signal ? AbortSignal.any([signal, msg.signal]) : signal,
        });
      } catch (err) {
        console.error(LOG, `dispatcher 处理失败 [${channel}]:`, err);
        return null;
      }
    };
  }
}

/** 进程级单例。index.ts 在 app.whenReady() 里实例化一次。 */
export const channelManager = new ChannelManager();
