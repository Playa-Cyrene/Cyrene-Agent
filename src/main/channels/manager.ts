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

const LOG = "[ChannelManager]";

/** dispatcher 给 manager 的回调 —— 拿到入站消息后返回一个 outgoing 消息 */
export type DispatchFn = (msg: IncomingMessage) => Promise<OutgoingMessage | null>;

/** 普通插件只拿到这一窄端口；保留身份与注册归属由宿主强制检查。 */
export interface PluginChannelRegistrationPort {
  has(id: ChannelId): boolean;
  register(adapter: ChannelAdapter): void;
  unregister(id: ChannelId): Promise<boolean>;
  startOne(id: ChannelId): Promise<void>;
}

export class ChannelManager {
  private adapters = new Map<ChannelId, ChannelAdapter>();
  private readonly hostOwner = Symbol("host-channels");
  private readonly owners = new Map<ChannelId, symbol>();
  private dispatchFn: DispatchFn | null = null;
  /** 启动后已开启的 adapter（start 成功的才会调 stop） */
  private startedAdapters = new Set<ChannelId>();
  private stopGeneration = 0;
  private handlerLeases = new WeakMap<ChannelAdapter, object>();
  private startingAdapters = new Map<ChannelAdapter, { promise: Promise<void>; cancelled: boolean; cancel: () => void; settled: Promise<void> }>();
  private stoppingAdapters = new Map<ChannelAdapter, Promise<void>>();

  has(id: ChannelId): boolean {
    return this.adapters.has(id);
  }

  /** 注册 adapter（必须在 startAll 之前调用；重复 id 一律拒绝） */
  register(adapter: ChannelAdapter, options: { bindBeforeStart?: boolean } = {}): void {
    this.registerOwned(adapter, this.hostOwner);
    // Some host-controlled routes have an explicit activation path outside startAll.
    if (options.bindBeforeStart && this.dispatchFn) setAdapterHandler(adapter, this.makeAdapterHandler(adapter.id, adapter));
  }

  hasLiveDispatcher(adapter: ChannelAdapter): boolean {
    return !!this.dispatchFn && this.adapters.get(adapter.id) === adapter && this.handlerLeases.has(adapter);
  }

  /**
   * 普通插件端口永远不能获得 qq/qqbot，包括尚未安装 QQ 模块的空槽。
   * 端口持有不可由 adapter 自报的归属令牌，不能启停/注销宿主或其他端口的渠道。
   * 这只是 API 边界，不把同进程普通插件宣称为安全沙箱。
   */
  createPluginPort(): PluginChannelRegistrationPort {
    const owner = Symbol("plugin-channels");
    return {
      has: (id) => this.has(id),
      register: (adapter) => this.registerOwned(adapter, owner),
      unregister: (id) => this.unregisterOwned(id, owner),
      startOne: (id) => this.startOwned(id, owner),
    };
  }

  private assertOwner(id: ChannelId, owner: symbol): void {
    if (owner !== this.hostOwner && (id === "qq" || id === "qqbot")) {
      throw new Error(`渠道 ${id} 是宿主保留身份，普通插件不可管理`);
    }
    const registeredOwner = this.owners.get(id);
    if (registeredOwner && registeredOwner !== owner) {
      throw new Error(`不能管理不属于当前注册端口的渠道: ${id}`);
    }
  }

  private registerOwned(adapter: ChannelAdapter, owner: symbol): void {
    this.assertOwner(adapter.id, owner);
    if (this.adapters.has(adapter.id)) {
      throw new Error(`渠道 ${adapter.id} 已注册，禁止覆盖现有实例`);
    }
    this.adapters.set(adapter.id, adapter);
    this.owners.set(adapter.id, owner);
  }

  /** 设置 dispatcher 入口。注册 adapter 时机不限，dispatcher 注入必须早于 startAll。 */
  setDispatcher(fn: DispatchFn): void {
    this.dispatchFn = fn;
    // 给所有已注册的 adapter 注入 handler
    for (const [id, adapter] of this.adapters) {
      setAdapterHandler(adapter, this.makeAdapterHandler(id, adapter));
    }
  }

  /** 启动所有已注册 adapter（失败的跳过、记 log） */
  async startAll(): Promise<void> {
    await this.startAdapters(() => false);
  }

  private async startAdapters(preserve: (id: ChannelId) => boolean, signal?: AbortSignal): Promise<void> {
    const generation = this.stopGeneration;
    const canStart = () => generation === this.stopGeneration && !signal?.aborted;
    for (const [id, adapter] of this.adapters) {
      if (!canStart()) break;
      if (preserve(id)) continue;
      try {
        await this.startAdapter(id, adapter, canStart, signal);
      } catch (err) {
        console.error(LOG, `渠道启动失败 [${adapter.id}]:`, err instanceof Error ? err.message : err);
      }
    }
  }

  /** 注销 adapter：若已启动先 stop，再移除（运行时禁用插件渠道用） */
  async unregister(id: ChannelId): Promise<boolean> {
    return this.unregisterOwned(id, this.hostOwner);
  }

  private async unregisterOwned(id: ChannelId, owner: symbol): Promise<boolean> {
    this.assertOwner(id, owner);
    const adapter = this.adapters.get(id);
    if (!adapter) return false;
    this.cancelStartingAdapter(adapter);
    setAdapterHandler(adapter, null);
    this.adapters.delete(id);
    this.owners.delete(id);
    if (this.startedAdapters.delete(id)) {
      try {
        await adapter.stop();
      } catch (err) {
        console.warn(LOG, `渠道停止失败 [${id}]:`, err instanceof Error ? err.message : err);
      }
    }
    logger.info(LogTag.Channels, `unregistered: ${id}`);
    return true;
  }

  /** 启动单个 adapter（运行时启用插件渠道用） */
  async startOne(id: ChannelId): Promise<void> {
    return this.startOwned(id, this.hostOwner);
  }

  private async startOwned(id: ChannelId, owner: symbol): Promise<void> {
    this.assertOwner(id, owner);
    const adapter = this.adapters.get(id);
    if (!adapter) return;
    const generation = this.stopGeneration;
    return this.startAdapter(id, adapter, () => generation === this.stopGeneration);
  }

  private async startAdapter(id: ChannelId, adapter: ChannelAdapter, canStart: () => boolean, signal?: AbortSignal): Promise<void> {
    if (!canStart()) return;
    const stopping = this.stoppingAdapters.get(adapter);
    if (stopping) {
      await stopping.catch(() => undefined);
      return this.startAdapter(id, adapter, canStart, signal);
    }
    const pending = this.startingAdapters.get(adapter);
    if (pending) {
      if (!pending.cancelled) return pending.promise;
      // 显式重启等待旧启动完成清理，再重新启动同一实例。
      await pending.settled.catch(() => undefined);
      return this.startAdapter(id, adapter, canStart, signal);
    }
    if (this.adapters.get(id) !== adapter || this.startedAdapters.has(id)) return;
    let cancel!: () => void;
    const cancelled = new Promise<void>((_, reject) => { cancel = () => reject(new Error(`channel startup cancelled: ${id}`)); });
    const entry = { promise: Promise.resolve(), settled: Promise.resolve(), cancelled: false, cancel };
    const abortStart = () => this.cancelStartingAdapter(adapter);
    entry.settled = Promise.resolve().then(async () => {
      if (entry.cancelled || !canStart()) throw new Error(`channel startup cancelled: ${id}`);
      if (this.dispatchFn) setAdapterHandler(adapter, this.makeAdapterHandler(id, adapter));
      try {
        await adapter.start();
      } finally {
        if (entry.cancelled || this.adapters.get(id) !== adapter) await adapter.stop();
      }
      if (entry.cancelled || this.adapters.get(id) !== adapter) {
        throw new Error(`channel startup cancelled: ${id}`);
      }
      this.startedAdapters.add(id);
      logger.info(LogTag.Channels, `started: ${id} (${adapter.displayName})`);
    }).finally(() => {
      signal?.removeEventListener("abort", abortStart);
      this.startingAdapters.delete(adapter);
    });
    entry.promise = Promise.race([entry.settled, cancelled]);
    this.startingAdapters.set(adapter, entry);
    signal?.addEventListener("abort", abortStart, { once: true });
    return entry.promise;
  }

  private cancelStartingAdapter(adapter: ChannelAdapter): void {
    const entry = this.startingAdapters.get(adapter);
    if (!entry || entry.cancelled) return;
    entry.cancelled = true;
    entry.cancel();
    this.handlerLeases.delete(adapter);
    setAdapterHandler(adapter, null);
  }

  /** 普通设置重启保留由独立显式生命周期管理的渠道。其余渠道仍先全停再全启。 */
  async restartAll(preserve: (id: ChannelId) => boolean = () => false, signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) return;
    // stopAdapters increments synchronously; a later stop owns the lifecycle.
    // Capture this stop generation before waiting, not after the stop phase.
    const generation = this.stopGeneration + 1;
    const canRestart = () => generation === this.stopGeneration && !signal?.aborted;
    // Once preserved during this restart, do not start it later even if its state changes.
    const preserved = new Set<ChannelId>();
    const suspended = new Set<ChannelAdapter>();
    const shouldPreserve = (id: ChannelId): boolean => {
      if (preserve(id)) preserved.add(id);
      if (!preserved.has(id)) return false;
      const adapter = this.adapters.get(id);
      // An independently protected route discovered during teardown can keep
      // its connection if not yet stopped, but its revoked callback stays dead.
      if (canRestart() && adapter && suspended.delete(adapter) && this.dispatchFn && !this.handlerLeases.has(adapter)) {
        setAdapterHandler(adapter, this.makeAdapterHandler(id, adapter));
      }
      return true;
    };
    await this.stopAdapters(shouldPreserve, canRestart, suspended);
    if (canRestart()) await this.startAdapters(shouldPreserve, signal);
  }

  /** 关闭所有已启动的 adapter；应用退出不采用普通重启的保留策略。 */
  async stopAll(): Promise<void> {
    // An ordinary restart may already be stopping one adapter. Join the same
    // work without calling stop twice or holding up cancellation of other starts.
    const stopping = [...this.stoppingAdapters.values()];
    await Promise.all([this.stopAdapters(), Promise.allSettled(stopping)]);
  }

  private stopAdapter(adapter: ChannelAdapter): Promise<void> {
    const stopping = this.stoppingAdapters.get(adapter);
    if (stopping) return stopping;
    const work = Promise.resolve().then(() => adapter.stop()).finally(() => { this.stoppingAdapters.delete(adapter); });
    this.stoppingAdapters.set(adapter, work);
    return work;
  }

  private async stopAdapters(preserve?: (id: ChannelId) => boolean, canContinue: () => boolean = () => true,
    suspended?: Set<ChannelAdapter>): Promise<void> {
    this.stopGeneration++;
    // Revoke ingress for all affected adapters before awaiting any network stop.
    // Leave the started set intact until each adapter's own stop is initiated.
    if (!preserve) this.handlerLeases = new WeakMap();
    else {
      for (const [id, adapter] of this.adapters) {
        if (!preserve(id) && this.handlerLeases.delete(adapter)) suspended?.add(adapter);
      }
    }
    for (const adapter of this.startingAdapters.keys()) {
      if (preserve?.(adapter.id)) continue;
      suspended?.delete(adapter);
      this.cancelStartingAdapter(adapter);
    }
    const started = [...this.startedAdapters];
    if (!preserve) this.startedAdapters.clear();
    for (const id of started) {
      if (!canContinue()) break;
      if (preserve?.(id)) continue;
      if (preserve && !this.startedAdapters.delete(id)) continue;
      const adapter = this.adapters.get(id);
      if (!adapter) continue;
      suspended?.delete(adapter);
      this.handlerLeases.delete(adapter);
      try {
        await this.stopAdapter(adapter);
      } catch (err) {
        console.warn(LOG, `渠道停止失败 [${id}]:`, err instanceof Error ? err.message : err);
      }
    }
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

  private makeAdapterHandler(channel: ChannelId, adapter: ChannelAdapter) {
    const lease = {};
    this.handlerLeases.set(adapter, lease);
    return async (msg: IncomingMessage): Promise<OutgoingMessage | null> => {
      // 消息身份来自注册者，不能由普通插件冒充 qq/qqbot 绕过宿主路由。
      // 旧实例即使保留了回调，也不能在注销/替换后继续注入消息。
      if (this.handlerLeases.get(adapter) !== lease || this.adapters.get(channel) !== adapter || msg.channel !== channel) {
        console.warn(LOG, `拒绝渠道身份不匹配或已注销的入站消息 [${channel}]`);
        return null;
      }
      if (!this.dispatchFn) {
        console.warn(LOG, `收到入站消息但 dispatcher 未注册 [${channel}]`);
        return null;
      }
      try {
        return await this.dispatchFn(msg);
      } catch (err) {
        console.error(LOG, `dispatcher 处理失败 [${channel}]:`, err);
        return null;
      }
    };
  }
}

/** 进程级单例。index.ts 在 app.whenReady() 里实例化一次。 */
export const channelManager = new ChannelManager();
