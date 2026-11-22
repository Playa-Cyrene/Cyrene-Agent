// scheduler/bootstrap 生命周期测试。
// 核心回归点（Task 1）：createSchedulerSubsystem 在构造期不加载 store、不注册 IPC、
// 不启动 engine —— initialize / start / stop 必须显式调用。
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("electron", () => ({
  app: { getPath: () => "/tmp" },
  BrowserWindow: { getAllWindows: () => [] },
  ipcMain: { handle: vi.fn(), removeHandler: vi.fn() },
}));

vi.mock("./scheduler-store", () => ({
  getSchedulerStore: vi.fn(),
}));

vi.mock("./scheduler-ipc", () => ({
  registerSchedulerIpc: vi.fn(),
}));

// 避免拉起真实 tool registry / CyreneAgent（级联重依赖）
vi.mock("../orchestrator/tools/registry/tool-registry", () => ({
  toolRegistry: { getEnabledTools: () => [], getAllTools: () => [] },
}));
vi.mock("../orchestrator/cyrene-agent", () => ({
  CyreneAgent: class {},
}));

// eslint-disable-next-line import/first
import {
  createSchedulerSubsystem,
  type SchedulerSubsystemDeps,
} from "./bootstrap";

function makeSchedulerDeps(
  overrides: Partial<SchedulerSubsystemDeps> = {},
): SchedulerSubsystemDeps {
  return {
    waitForTools: vi.fn(async () => {}),
    agentRuntime: {} as SchedulerSubsystemDeps["agentRuntime"],
    getReactChatWindow: () => null,
    ...overrides,
  };
}

function makeFakeStore() {
  return {
    load: vi.fn(),
    onChange: vi.fn(),
    getTasks: vi.fn(() => []),
    updateTask: vi.fn(),
    recordHistory: vi.fn(),
  };
}

function makeFakeEngine() {
  return { start: vi.fn(), stop: vi.fn() };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("createSchedulerSubsystem lifecycle", () => {
  it("does not load the store, register IPC, or start the engine in createSchedulerSubsystem", () => {
    const store = makeFakeStore();
    const engine = makeFakeEngine();
    const createEngine = vi.fn(() => engine);
    const registerIpc = vi.fn();
    const subsystem = createSchedulerSubsystem(
      makeSchedulerDeps({
        store: store as unknown as SchedulerSubsystemDeps["store"],
        createEngine: createEngine as unknown as NonNullable<SchedulerSubsystemDeps["createEngine"]>,
        registerIpc: registerIpc as unknown as NonNullable<SchedulerSubsystemDeps["registerIpc"]>,
      }),
    );
    expect(store.load).not.toHaveBeenCalled();
    expect(registerIpc).not.toHaveBeenCalled();
    expect(engine.start).not.toHaveBeenCalled();
    subsystem.initialize();
    expect(store.load).toHaveBeenCalledOnce();
    expect(registerIpc).toHaveBeenCalledOnce();
    expect(engine.start).not.toHaveBeenCalled();
  });

  it("start() and stop() only drive the engine", () => {
    const store = makeFakeStore();
    const engine = makeFakeEngine();
    const subsystem = createSchedulerSubsystem(
      makeSchedulerDeps({
        store: store as unknown as SchedulerSubsystemDeps["store"],
        createEngine: (() => engine) as unknown as NonNullable<SchedulerSubsystemDeps["createEngine"]>,
      }),
    );
    subsystem.initialize();
    subsystem.start();
    expect(engine.start).toHaveBeenCalledOnce();
    expect(engine.stop).not.toHaveBeenCalled();
    subsystem.stop();
    expect(engine.stop).toHaveBeenCalledOnce();
    expect(engine.start).toHaveBeenCalledOnce();
  });

  it("initialize() is idempotent", () => {
    const store = makeFakeStore();
    const registerIpc = vi.fn();
    const subsystem = createSchedulerSubsystem(
      makeSchedulerDeps({
        store: store as unknown as SchedulerSubsystemDeps["store"],
        registerIpc: registerIpc as unknown as NonNullable<SchedulerSubsystemDeps["registerIpc"]>,
      }),
    );
    subsystem.initialize();
    subsystem.initialize();
    expect(store.load).toHaveBeenCalledOnce();
    expect(registerIpc).toHaveBeenCalledOnce();
  });
});
