import { describe, expect, it, vi } from "vitest";
import { createShutdownCoordinator } from "./shutdown";
import { createStartupReadiness } from "./readiness";
import { createWindowActivationBroker } from "./window-activation";
import { startShell, type ShellDependencies } from "./shell-bootstrap";

function createFakeBrowserWindow() {
  return {
    isDestroyed: vi.fn(() => false),
    show: vi.fn(),
    focus: vi.fn(),
    close: vi.fn(),
    on: vi.fn(),
  };
}

function makeShellDeps(overrides: Partial<ShellDependencies> = {}): ShellDependencies & {
  readiness: ReturnType<typeof createStartupReadiness>;
  activation: ReturnType<typeof createWindowActivationBroker>;
  fireTrayChat(): void;
  splashWindow: ReturnType<typeof createFakeBrowserWindow>;
  chatWindow: ReturnType<typeof createFakeBrowserWindow>;
  windowManager: { createPetWindow: ReturnType<typeof vi.fn>; openReactChatWindow: ReturnType<typeof vi.fn> };
} {
  const readiness = createStartupReadiness();
  const activation = createWindowActivationBroker();
  const splashWindow = createFakeBrowserWindow();
  const chatWindow = createFakeBrowserWindow();
  const windowManager = {
    createPetWindow: vi.fn(),
    openReactChatWindow: vi.fn(async () => chatWindow),
  };
  let trayChatRequest: ((request: { kind: string }) => void) | null = null;

  const deps: ShellDependencies = {
    readiness,
    activation,
    shutdown: createShutdownCoordinator({ readiness, timeoutMs: 1000 }),
    createIpcScope: () => ({
      handle: vi.fn(),
      on: vi.fn(),
      dispose: vi.fn(),
    }),
    createSplashWindow: vi.fn(({ onShown }) => {
      onShown(1234);
      return splashWindow as never;
    }),
    createWindowManager: vi.fn(() => windowManager as never),
    createChatShell: vi.fn(() => ({
      window: chatWindow as never,
      load: vi.fn(async () => undefined),
      show: vi.fn(),
    })),
    registerProtocolHandlers: vi.fn(),
    registerShellIpc: vi.fn(),
    createTray: vi.fn((input) => {
      trayChatRequest = input.requestActivation;
      return { isDestroyed: () => false, destroy: vi.fn() } as never;
    }),
    flushTokenUsage: vi.fn(),
    writeStartupLog: vi.fn(),
    ...overrides,
  };

  return {
    ...deps,
    readiness,
    activation,
    splashWindow,
    chatWindow,
    windowManager,
    fireTrayChat: () => {
      trayChatRequest?.({ kind: "chat" });
    },
  } as never;
}

describe("startShell", () => {
  it("shows Loading but leaves the chat renderer unloaded", async () => {
    const deps = makeShellDeps();
    const shell = await startShell(deps);

    expect(deps.createSplashWindow).toHaveBeenCalledBefore(deps.createChatShell);
    expect(shell.chat.load).not.toHaveBeenCalled();
    expect(deps.windowManager.createPetWindow).not.toHaveBeenCalled();
    expect(deps.readiness.getPhase()).toBe("shell-ready");
    expect(shell.loadingShownAt).toBe(1234);
  });

  it("exposes loadingShownAt recorded after startShell returned", async () => {
    // Loading 的 ready-to-show 是异步事件：onShown 晚于 startShell resolve 才触发。
    // ShellResult 必须用 getter 实时读取，否则 core 阶段拿到 undefined 快照，
    // 最短展示时长会被整体跳过（回归测试）。
    const deps = makeShellDeps();
    let fireShown: ((at: number) => void) | undefined;
    vi.mocked(deps.createSplashWindow).mockImplementation(({ onShown }) => {
      fireShown = onShown;
      return deps.splashWindow as never;
    });

    const shell = await startShell(deps);
    expect(shell.loadingShownAt).toBeUndefined();

    fireShown?.(5678);
    expect(shell.loadingShownAt).toBe(5678);
  });

  it("routes tray actions through the activation broker", async () => {
    const deps = makeShellDeps();
    await startShell(deps);
    const spy = vi.spyOn(deps.activation, "request");
    deps.fireTrayChat();
    expect(spy).toHaveBeenCalledWith({ kind: "chat", source: "tray" });
    await deps.activation.markReady();
    expect(deps.windowManager.openReactChatWindow).toHaveBeenCalledWith(undefined, "tray");
  });

  it("focuses Loading instead of opening windows before markReady", async () => {
    const deps = makeShellDeps();
    await startShell(deps);

    deps.activation.request({ kind: "settings" });
    expect(deps.splashWindow.focus).toHaveBeenCalled();
    expect(deps.windowManager.openReactChatWindow).not.toHaveBeenCalled();
  });

  it("drains queued activation through the window manager after markReady", async () => {
    const deps = makeShellDeps();
    await startShell(deps);

    deps.activation.request({ kind: "chat", sessionId: "s1" });
    expect(deps.windowManager.openReactChatWindow).not.toHaveBeenCalled();

    await deps.activation.markReady();
    expect(deps.windowManager.openReactChatWindow).toHaveBeenCalledWith("s1", undefined);
  });

  it("attaches Windows session-end handlers to the chat shell window", async () => {
    const deps = makeShellDeps();
    await startShell(deps);
    const events = deps.chatWindow.on.mock.calls.map((call) => call[0]);
    expect(events).toContain("query-session-end");
    expect(events).toContain("session-end");
  });

  it("registers token usage as both persistence flush and emergency flush", async () => {
    const deps = makeShellDeps();
    await startShell(deps);

    deps.shutdown.emergencyFlush();
    expect(deps.flushTokenUsage).toHaveBeenCalledTimes(1);
    deps.shutdown.emergencyFlush();
    expect(deps.flushTokenUsage).toHaveBeenCalledTimes(1);
  });
});
