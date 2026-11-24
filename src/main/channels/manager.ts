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
  private startingAdapters = new Map<ChannelAdapter, { promise: Promise<void>; cancelled: boolean; cancel: () => void; settled: Promise<void> }>();

  has(id: ChannelId): boolean {
    return this.adapters.has(id);
  }

  /** 注册 adapter（必须在 startAll 之前调用；重复 id 一律拒绝） */
  register(adapter: ChannelAdapter): void {
    this.registerOwned(adapter, this.hostOwner);
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
    const generation = this.stopGeneration;
    for (const [id, adapter] of this.adapters) {
      if (generation !== this.stopGeneration) break;
      try {
        await this.startAdapter(id, adapter);
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
    const starting = this.startingAdapters.get(adapter);
    if (starting) { starting.cancelled = true; starting.cancel(); }
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
    return this.startAdapter(id, adapter);
  }

  private async startAdapter(id: ChannelId, adapter: ChannelAdapter): Promise<void> {
    const pending = this.startingAdapters.get(adapter);
    if (pending) {
      if (!pending.cancelled) return pending.promise;
      // 显式重启等待旧启动完成清理，再重新启动同一实例。
      await pending.settled.catch(() => undefined);
      return this.startAdapter(id, adapter);
    }
    if (this.adapters.get(id) !== adapter || this.startedAdapters.has(id)) return;
    let cancel!: () => void;
    const cancelled = new Promise<void>((_, reject) => { cancel = () => reject(new Error(`channel startup cancelled: ${id}`)); });
    const entry = { promise: Promise.resolve(), settled: Promise.resolve(), cancelled: false, cancel };
    entry.settled = Promise.resolve().then(async () => {
      if (entry.cancelled) throw new Error(`channel startup cancelled: ${id}`);
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
    }).finally(() => { this.startingAdapters.delete(adapter); });
    entry.promise = Promise.race([entry.settled, cancelled]);
    this.startingAdapters.set(adapter, entry);
    return entry.promise;
  }

  /** 关闭所有已启动的 adapter */
  async stopAll(): Promise<void> {
    this.stopGeneration++;
    for (const [adapter, entry] of this.startingAdapters) {
      entry.cancelled = true;
      entry.cancel();
      setAdapterHandler(adapter, null);
    }
    const started = [...this.startedAdapters];
    this.startedAdapters.clear();
    for (const id of started) {
      const adapter = this.adapters.get(id);
      if (!adapter) continue;
      try {
        await adapter.stop();
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
    const generation = this.stopGeneration;
    return async (msg: IncomingMessage): Promise<OutgoingMessage | null> => {
      // 消息身份来自注册者，不能由普通插件冒充 qq/qqbot 绕过宿主路由。
      // 旧实例即使保留了回调，也不能在注销/替换后继续注入消息。
      if (generation !== this.stopGeneration || this.adapters.get(channel) !== adapter || msg.channel !== channel) {
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
