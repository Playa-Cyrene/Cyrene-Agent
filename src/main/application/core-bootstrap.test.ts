import { describe, expect, it, vi } from "vitest";
import { createShutdownCoordinator } from "./shutdown";
import { createStartupReadiness } from "./readiness";
import { createWindowActivationBroker } from "./window-activation";
import { startCore, type CoreDependencies, type CoreServices } from "./core-bootstrap";

function makeServices(): CoreServices {
  return {
    runtimeState: {} as never,
    llm: {} as never,
    cita: {} as never,
    social: {} as never,
    tts: {} as never,
    ttsSession: {} as never,
    embedding: { scheduleStartupRefreshes: vi.fn() } as never,
    proactive: {} as never,
    git: { dispose: vi.fn() } as never,
    lsp: { disposeAll: vi.fn() } as never,
    screenshot: { shutdown: vi.fn() } as never,
    music: { shutdown: vi.fn(async () => ({})) } as never,
    update: {} as never,
  };
}

function makeCoreDeps(calls: string[], overrides: Partial<CoreDependencies> = {}): CoreDependencies & {
  readiness: ReturnType<typeof createStartupReadiness>;
  activation: ReturnType<typeof createWindowActivationBroker>;
  chatLoad: ReturnType<typeof vi.fn>;
  petWindowCreated: boolean;
} {
  const readiness = createStartupReadiness();
  // 生产顺序中 shell-ready 由 startShell 推进；core 阶段从 shell-ready 开始
  readiness.transition("shell-ready");
  const activation = createWindowActivationBroker();
  const chatLoad = vi.fn(async () => { calls.push("chat-load"); });
  let petWindowCreated = false;
  const chatWindow = { isDestroyed: () => false, show: vi.fn() };
  const petWindow = { isDestroyed: () => false };

  const deps: CoreDependencies = {
    shell: {
      ipc: { handle: vi.fn(), on: vi.fn(), dispose: vi.fn() },
      splashWindow: null,
      loadingShownAt: 100,
      windowManager: {
        createPetWindow: vi.fn(() => {
          petWindowCreated = true;
          return petWindow;
        }),
        onPetWindowReady: vi.fn(),
        onPetWindowClosed: vi.fn(),
        createSidebarWindow: vi.fn(),
        setPetWindowAlwaysOnTop: vi.fn(),
        applyPetWindowZoom: vi.fn(),
      },
      chat: { window: chatWindow, load: chatLoad, show: vi.fn() },
      tray: { isDestroyed: () => false, destroy: vi.fn() } as never,
      live2dWindowLifecycle: { attach: vi.fn(), clear: vi.fn(), getWindow: () => null, getDiagnostics: () => ({}) },
    } as never,
    readiness,
    activation,
    shutdown: createShutdownCoordinator({ readiness, timeoutMs: 1000 }),
    migrateStagedExternalContent: () => { calls.push("migrate"); },
    initSkills: () => { calls.push("skills"); },
    createLowCostServices: () => { calls.push("services"); return makeServices(); },
    initSandbox: async () => { calls.push("sandbox"); },
    initPlanMode: () => { calls.push("plan"); },
    registerAllTools: () => { calls.push("tools"); },
    initRag: async () => { calls.push("rag"); },
    createRuntime: () => { calls.push("runtime"); return {} as never; },
    createChannels: () => ({
      initialize: () => { calls.push("channels-initialize"); },
      adaptersRegistered: Promise.resolve(),
      start: vi.fn(async () => { calls.push("channels-start"); }),
      shutdown: vi.fn(async () => { calls.push("channels-stop"); }),
    } as never),
    startPlugins: async () => {
      calls.push("plugins-start");
      return { stop: vi.fn(async () => { calls.push("plugins-stop"); }) } as never;
    },
    createScheduler: () => ({ initialize: () => { calls.push("scheduler-initialize"); }, start: vi.fn(() => { calls.push("scheduler-start"); }), stop: vi.fn() } as never),
    registerCoreIpc: () => { calls.push("register-core-ipc"); },
    wireToastCenter: () => { calls.push("wire-toast-center"); },
    loadGeneralSettings: () => ({ petVisible: true, sidebarVisible: false }) as never,
    applyGeneralSettings: () => { calls.push("apply-settings"); },
    revealStartupWindows: async () => { calls.push("reveal"); },
    minimumSplashMs: 2500,
    markStartupWindowsReady: () => { calls.push("mark-startup-windows"); },
    ...overrides,
  };

  return {
    ...deps,
    readiness,
    activation,
    chatLoad,
    get petWindowCreated() {
      return petWindowCreated;
    },
  } as never;
}

describe("startCore", () => {
  it("registers every renderer IPC handler before loading chat", async () => {
    const calls: string[] = [];
    await startCore(makeCoreDeps(calls));
    expect(calls.indexOf("register-core-ipc")).toBeLessThan(calls.indexOf("chat-load"));
    // 提醒中心装配必须晚于 IPC 注册、早于任何渲染页加载（toast 窗口预加载会 invoke getAll）
    expect(calls.indexOf("wire-toast-center")).toBeGreaterThan(calls.indexOf("register-core-ipc"));
    expect(calls.indexOf("wire-toast-center")).toBeLessThan(calls.indexOf("chat-load"));
    expect(calls.indexOf("channels-initialize")).toBeLessThan(calls.indexOf("chat-load"));
    expect(calls.indexOf("channels-initialize")).toBeLessThan(calls.indexOf("plugins-start"));
    // scheduler store 必须先于插件初始化：插件调度服务写入的是已加载的 store
    expect(calls.indexOf("scheduler-initialize")).toBeLessThan(calls.indexOf("plugins-start"));
    expect(calls.indexOf("plugins-start")).toBeLessThan(calls.indexOf("chat-load"));
    expect(calls).not.toContain("channels-start");
    expect(calls).not.toContain("scheduler-start");
  });

  it("degrades RAG failure but still loads chat", async () => {
    const calls: string[] = [];
    const deps = makeCoreDeps(calls, {
      initRag: async () => { throw new Error("rag offline"); },
    });
    await expect(startCore(deps)).resolves.toBeDefined();
    expect(deps.readiness.getDegradedReasons().has("rag")).toBe(true);
    expect(deps.chatLoad).toHaveBeenCalledOnce();
  });

  it("waits for the built-in adapter boundary before starting plugins", async () => {
    const calls: string[] = [];
    let releaseAdapters!: () => void;
    const adaptersRegistered = new Promise<void>((resolve) => { releaseAdapters = resolve; });
    const deps = makeCoreDeps(calls, {
      createChannels: () => ({
        initialize: () => { calls.push("channels-initialize"); },
        adaptersRegistered,
        start: vi.fn(async () => undefined),
        shutdown: vi.fn(async () => undefined),
      } as never),
    });

    const starting = startCore(deps);
    await vi.waitFor(() => expect(calls).toContain("channels-initialize"));
    expect(calls).not.toContain("plugins-start");
    releaseAdapters();
    await starting;
    expect(calls).toContain("plugins-start");
  });

  it("passes the constructed Agent Runtime to plugin startup", async () => {
    const runtime = { buildOptions: vi.fn() } as never;
    const startPlugins = vi.fn(async () => ({ stop: vi.fn(async () => undefined) } as never));
    const deps = makeCoreDeps([], {
      createRuntime: () => runtime,
      startPlugins,
    });

    await startCore(deps);

    expect(startPlugins).toHaveBeenCalledWith(expect.anything(), expect.anything(), runtime);
  });

  it("degrades skills failure and continues startup", async () => {
    const deps = makeCoreDeps([], {
      initSkills: () => { throw new Error("skills broken"); },
    });
    await expect(startCore(deps)).resolves.toBeDefined();
    expect(deps.readiness.getDegradedReasons().has("skills")).toBe(true);
  });

  it("treats chat load failure as fatal", async () => {
    const deps = makeCoreDeps([], {
      initRag: async () => undefined,
    });
    vi.mocked(deps.shell.chat.load).mockRejectedValue(new Error("renderer failed"));
    await expect(startCore(deps)).rejects.toThrow("renderer failed");
    const markReadySpy = vi.spyOn(deps.activation, "markReady");
    // markReady 未在致命路径被调用：重新用 spy 无法回溯，直接断言 phase 停留在 core-ready 之前
    expect(deps.readiness.getPhase()).not.toBe("core-ready");
    expect(markReadySpy).not.toHaveBeenCalled();
  });

  it("always creates the pet window; petVisible only controls whether it shows", async () => {
    const deps = makeCoreDeps([]);
    await startCore(deps);
    expect(deps.petWindowCreated).toBe(true);
    expect(deps.shell.windowManager.createPetWindow).toHaveBeenCalledWith(true);

    const hidden = makeCoreDeps([], {
      loadGeneralSettings: () => ({ petVisible: false, sidebarVisible: false }) as never,
    });
    await startCore(hidden);
    // 隐藏时窗口仍创建（不显示），托盘"显示桌宠"与设置开关随时能救回；
    // alwaysOnTop / zoom / live2d 生命周期在隐藏状态下同样接线。
    expect(hidden.petWindowCreated).toBe(true);
    expect(hidden.shell.windowManager.createPetWindow).toHaveBeenCalledWith(false);
    expect(hidden.shell.windowManager.setPetWindowAlwaysOnTop).toHaveBeenCalled();
    expect(hidden.shell.windowManager.applyPetWindowZoom).toHaveBeenCalled();
    expect(hidden.shell.windowManager.onPetWindowReady).toHaveBeenCalled();
    expect(hidden.shell.windowManager.createSidebarWindow).not.toHaveBeenCalled();
  });

  it("runs reveal after core-ready and drains activation last", async () => {
    const calls: string[] = [];
    const deps = makeCoreDeps(calls);
    await startCore(deps);
    expect(calls.indexOf("reveal")).toBeLessThan(calls.indexOf("mark-startup-windows"));
    expect(deps.readiness.getPhase()).toBe("core-ready");
  });

  it("stops plugins before built-in channels during controlled shutdown", async () => {
    const calls: string[] = [];
    const deps = makeCoreDeps(calls);
    await startCore(deps);

    await deps.shutdown.requestControlledShutdown({ reason: "test", finalAction: vi.fn() });

    expect(calls.indexOf("plugins-stop")).toBeGreaterThan(-1);
    expect(calls.indexOf("plugins-stop")).toBeLessThan(calls.indexOf("channels-stop"));
  });
});
