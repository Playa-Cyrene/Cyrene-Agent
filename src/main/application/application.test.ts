import { describe, expect, it, vi } from "vitest";
import { createShutdownCoordinator } from "./shutdown";
import { createStartupReadiness } from "./readiness";
import { createWindowActivationBroker } from "./window-activation";
import { createApplication, type ApplicationDependencies } from "./application";
import type { ShellResult } from "./shell-bootstrap";
import type { CoreResult } from "./core-bootstrap";
import type { BackgroundHandle } from "./background";

function makeShell(): ShellResult {
  return {
    ipc: { handle: vi.fn(), on: vi.fn(), dispose: vi.fn() },
    splashWindow: null,
    loadingShownAt: 1,
    windowManager: {} as never,
    chat: { window: {} as never, load: vi.fn(async () => undefined), show: vi.fn() },
    tray: {} as never,
    live2dWindowLifecycle: {} as never,
  };
}

function makeCore(): CoreResult {
  return {
    runtime: {} as never,
    services: {} as never,
    channels: {} as never,
    plugins: {} as never,
    scheduler: {} as never,
  };
}

function makeApplicationDeps(calls: string[], overrides: Partial<ApplicationDependencies> = {}): ApplicationDependencies & {
  readiness: ReturnType<typeof createStartupReadiness>;
  shutdown: ReturnType<typeof createShutdownCoordinator>;
  activation: ReturnType<typeof createWindowActivationBroker>;
} {
  const readiness = createStartupReadiness();
  const activation = createWindowActivationBroker();
  const shutdown = createShutdownCoordinator({ readiness, timeoutMs: 1000 });

  const deps: ApplicationDependencies = {
    app: {
      whenReady: vi.fn(async () => undefined),
      quit: vi.fn(),
      on: vi.fn(),
      removeListener: vi.fn(),
    },
    dialog: { showErrorBox: vi.fn() },
    readiness,
    activation,
    shutdown,
    prepare: vi.fn(() => { calls.push("pre-ready"); return { isPrimaryProcess: true }; }),
    // 生产中 shell/core 阶段各自推进 readiness；fake 依赖保持同一契约
    startShell: vi.fn(async () => {
      readiness.transition("shell-ready");
      calls.push("shell");
      return makeShell();
    }),
    startCore: vi.fn(async () => {
      calls.push("core");
      readiness.transition("core-ready");
      return makeCore();
    }),
    startBackground: vi.fn((): BackgroundHandle => {
      calls.push("background");
      return { settled: Promise.resolve(), stop: vi.fn(async () => undefined) };
    }),
    logFatal: vi.fn(),
    ...overrides,
  };

  return { ...deps, readiness, activation, shutdown } as never;
}

describe("createApplication", () => {
  it("reports and quits on pre-ready failure without starting business services", async () => {
    const error = new Error("用户数据迁移未完成");
    const deps = makeApplicationDeps([], { prepare: () => { throw error; } });
    const application = createApplication(deps);
    application.prepareBeforeReady();
    if (application.isPrimaryProcess()) await application.start();
    await vi.waitFor(() => expect(deps.app.quit).toHaveBeenCalledOnce());
    expect(deps.dialog.showErrorBox).toHaveBeenCalledWith("Cyrene 启动失败", expect.stringContaining(error.message));
    expect(deps.startShell).not.toHaveBeenCalled();
    expect(deps.startCore).not.toHaveBeenCalled();
    expect(deps.startBackground).not.toHaveBeenCalled();
  });
  it("runs shell, core, and background in order", async () => {
    const calls: string[] = [];
    const app = createApplication(makeApplicationDeps(calls));
    app.prepareBeforeReady();
    await app.start();
    expect(calls).toEqual(["pre-ready", "shell", "core", "background"]);
  });

  it("reports primary process only after prepare", () => {
    const deps = makeApplicationDeps([]);
    const app = createApplication(deps);
    expect(app.isPrimaryProcess()).toBe(false);
    app.prepareBeforeReady();
    expect(app.isPrimaryProcess()).toBe(true);
  });

  it("closes Loading, shows the error box, and quits exactly once on fatal", async () => {
    const showErrorBox = vi.fn();
    const quit = vi.fn();
    const splash = { isDestroyed: () => false, close: vi.fn() };
    const deps = makeApplicationDeps([], {
      dialog: { showErrorBox },
      app: {
        whenReady: vi.fn(async () => undefined),
        quit,
        on: vi.fn(),
        removeListener: vi.fn(),
      },
      startShell: vi.fn(async () => {
        deps.readiness.transition("shell-ready");
        return { ...makeShell(), splashWindow: splash as never };
      }),
      startCore: vi.fn(async () => { throw new Error("core exploded"); }),
    });
    const app = createApplication(deps);
    app.prepareBeforeReady();
    await expect(app.start()).rejects.toThrow("core exploded");
    await app.handleFatalStartup(new Error("core exploded"));
    await app.handleFatalStartup(new Error("second call ignored"));

    expect(splash.close).toHaveBeenCalledOnce();
    expect(showErrorBox).toHaveBeenCalledOnce();
    expect(quit).toHaveBeenCalledOnce();
    expect(deps.logFatal).toHaveBeenCalled();
    // failed → stopping → stopped：受控退出完成后的终态
    expect(deps.readiness.getPhase()).toBe("stopped");
  });

  it("installs before-quit fallback and activate activation on install", () => {
    const on = vi.fn();
    const deps = makeApplicationDeps([], {
      app: { whenReady: vi.fn(), quit: vi.fn(), on, removeListener: vi.fn() },
    });
    const app = createApplication(deps);
    app.installLifecycleHandlers();
    const events = on.mock.calls.map((call) => call[0]);
    expect(events).toContain("before-quit");
    expect(events).toContain("window-all-closed");
    expect(events).toContain("activate");
  });
});

describe("application startup cancellation", () => {
  it("does not start the shell if exit was already requested", async () => {
    const deps = makeApplicationDeps([]);
    await deps.shutdown.requestControlledShutdown({ reason: "exit", finalAction: vi.fn() });
    await createApplication(deps).start();
    expect(deps.startShell).not.toHaveBeenCalled();
    expect(deps.dialog.showErrorBox).not.toHaveBeenCalled();
  });

  it("does not start background work after core resolves during shutdown", async () => {
    const deps = makeApplicationDeps([]);
    deps.startCore = vi.fn(async () => {
      await deps.shutdown.requestControlledShutdown({ reason: "exit", finalAction: vi.fn() });
      return makeCore();
    });
    const app = createApplication(deps);
    await app.start().catch((error) => app.handleFatalStartup(error));
    expect(deps.startBackground).not.toHaveBeenCalled();
    expect(deps.dialog.showErrorBox).not.toHaveBeenCalled();
    expect(deps.logFatal).not.toHaveBeenCalled();
  });

  it("still reports genuine initialization failures even when shutdown was requested", async () => {
    const deps = makeApplicationDeps([]);
    const failure = new Error("database corrupt");
    deps.startCore = vi.fn(async () => {
      await deps.shutdown.requestControlledShutdown({ reason: "exit", finalAction: vi.fn() });
      throw failure;
    });
    const app = createApplication(deps);
    await app.start().catch((error) => app.handleFatalStartup(error));
    expect(deps.logFatal).toHaveBeenCalledWith(failure);
    expect(deps.dialog.showErrorBox).toHaveBeenCalledOnce();
    expect(deps.startBackground).not.toHaveBeenCalled();
  });
});
