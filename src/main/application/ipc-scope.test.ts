import { describe, expect, it, vi } from "vitest";
import { afterStartup, createIpcScope, type IpcScopeMainLike } from "./ipc-scope";

function createFakeIpcMain(): IpcScopeMainLike & {
  handlers: Map<string, (...args: any[]) => unknown>;
  listeners: Array<[string, (...args: any[]) => void]>;
} {
  const handlers = new Map<string, (...args: any[]) => unknown>();
  const listeners: Array<[string, (...args: any[]) => void]> = [];
  return {
    handlers,
    listeners,
    handle: vi.fn((channel: string, listener: (...args: any[]) => unknown) => {
      handlers.set(channel, listener);
    }),
    on: vi.fn((channel: string, listener: (...args: any[]) => void) => {
      listeners.push([channel, listener]);
    }),
    removeHandler: vi.fn((channel: string) => {
      handlers.delete(channel);
    }),
    removeListener: vi.fn((channel: string, listener: (...args: any[]) => void) => {
      const index = listeners.findIndex(([ch, l]) => ch === channel && l === listener);
      if (index >= 0) listeners.splice(index, 1);
    }),
  };
}

describe("createIpcScope", () => {
  it("removes every handler and listener registered through the scope", () => {
    const main = createFakeIpcMain();
    const scope = createIpcScope(main);
    const listener = vi.fn();
    scope.handle("a", listener);
    scope.on("b", listener);
    scope.dispose();
    expect(main.removeHandler).toHaveBeenCalledWith("a");
    expect(main.removeListener).toHaveBeenCalledWith("b", listener);
    expect(main.handlers.size).toBe(0);
    expect(main.listeners).toHaveLength(0);
  });

  it("registers immediately and waits before entering a deferred handler", async () => {
    const main = createFakeIpcMain();
    let release!: () => void;
    const ready = new Promise<void>(resolve => { release = resolve; });
    const scope = afterStartup(createIpcScope(main), () => ready);
    const listener = vi.fn(() => "ok");
    scope.handle("test", listener);
    const result = main.handlers.get("test")!("sender", "payload");
    expect(listener).not.toHaveBeenCalled();
    release();
    await expect(result).resolves.toBe("ok");
    expect(listener).toHaveBeenCalledWith("sender", "payload");
    scope.dispose();
    expect(main.handlers.size).toBe(0);
  });

  it("rejects duplicate registration inside one scope", () => {
    const scope = createIpcScope(createFakeIpcMain());
    scope.handle("a", vi.fn());
    expect(() => scope.handle("a", vi.fn())).toThrow("IPC channel already registered: a");
  });

  it("supports dynamic handler removal without removing it again on dispose", () => {
    const main = createFakeIpcMain();
    const scope = createIpcScope(main);
    scope.handle("plugin:demo:ping", vi.fn());
    scope.removeHandler("plugin:demo:ping");
    scope.dispose();
    expect(main.removeHandler).toHaveBeenCalledTimes(1);
    expect(main.handlers.has("plugin:demo:ping")).toBe(false);
  });

  it("dispose is idempotent", () => {
    const main = createFakeIpcMain();
    const scope = createIpcScope(main);
    scope.handle("a", vi.fn());
    scope.dispose();
    scope.dispose();
    expect(main.removeHandler).toHaveBeenCalledTimes(1);
  });

  it("forwards registrations to the underlying ipc main", () => {
    const main = createFakeIpcMain();
    const scope = createIpcScope(main);
    const handler = vi.fn();
    const listener = vi.fn();
    scope.handle("ch1", handler);
    scope.on("ch2", listener);
    expect(main.handle).toHaveBeenCalledWith("ch1", handler);
    expect(main.on).toHaveBeenCalledWith("ch2", listener);
  });
});
