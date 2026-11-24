/**
 * 主进程 IPC 注册 Scope：统一登记 handle/on 注册并在 dispose() 时整体注销。
 * - 同一 scope 内重复注册同一 channel 直接报错，避免重复注册污染。
 * - dispose() 幂等，按注册的逆序移除（仅为注销顺序，与退出清理阶段无关）。
 */

import { ipcMain } from "electron";

export interface IpcScope {
  handle(channel: string, listener: (...args: any[]) => unknown): void;
  removeHandler(channel: string): void;
  on(channel: string, listener: (...args: any[]) => void): void;
  dispose(): void;
}

/** 延迟首个调用，不延迟 handler 注册；退出仍由原 scope 统一注销。 */
export function afterStartup(
  scope: IpcScope, ready: (channel: string, payload: unknown) => Promise<unknown> | void,
): IpcScope {
  return {
    ...scope,
    handle: (channel, listener) => scope.handle(channel, async (event, ...args) => {
      await ready(channel, args[0]);
      return listener(event, ...args);
    }),
  };
}

export interface IpcScopeMainLike {
  handle(channel: string, listener: (...args: any[]) => unknown): unknown;
  on(channel: string, listener: (...args: any[]) => void): unknown;
  removeHandler(channel: string): unknown;
  removeListener(channel: string, listener: (...args: any[]) => void): unknown;
}

type TrackedRegistration =
  | { kind: "handle"; channel: string; listener: (...args: any[]) => unknown }
  | { kind: "on"; channel: string; listener: (...args: any[]) => void };

export function createIpcScope(main: IpcScopeMainLike = ipcMain as IpcScopeMainLike): IpcScope {
  const registrations: TrackedRegistration[] = [];
  const handledChannels = new Set<string>();
  let disposed = false;

  function assertActive(): void {
    if (disposed) {
      throw new Error("IPC scope already disposed");
    }
  }

  return {
    handle(channel, listener) {
      assertActive();
      if (handledChannels.has(channel)) {
        throw new Error(`IPC channel already registered: ${channel}`);
      }
      handledChannels.add(channel);
      registrations.push({ kind: "handle", channel, listener });
      main.handle(channel, listener);
    },

    removeHandler(channel) {
      assertActive();
      if (!handledChannels.delete(channel)) return;
      const index = registrations.findIndex(
        (registration) => registration.kind === "handle" && registration.channel === channel,
      );
      if (index >= 0) registrations.splice(index, 1);
      main.removeHandler(channel);
    },

    on(channel, listener) {
      assertActive();
      registrations.push({ kind: "on", channel, listener });
      main.on(channel, listener);
    },

    dispose() {
      if (disposed) return;
      disposed = true;
      // 逆序移除：后注册的先注销，保持与注册路径一致的对称性。
      for (const registration of registrations.reverse()) {
        try {
          if (registration.kind === "handle") main.removeHandler(registration.channel);
          else main.removeListener(registration.channel, registration.listener);
        } catch (error) {
          console.error(`[IpcScope] dispose failed for ${registration.kind} ${registration.channel}:`, error);
        }
      }
      registrations.length = 0;
      handledChannels.clear();
    },
  };
}
