import type { BrowserWindow } from "electron";
import type { IpcScope } from "../application/ipc-scope";
import type { AgentRuntime } from "../orchestrator/agent-runtime";
import type { LifecyclePublisher } from "../plugin-host/lifecycle-publisher";
import type { ConversationJournalService } from "../orchestrator/conversation-journal-service";
import type { ActiveConversationSelection } from "../chats/active-conversation-registry";
import { toolRegistry } from "../orchestrator/tools/registry/tool-registry";
import type { ScheduledTask } from "./types";
import { SchedulerEngine, type SchedulerEngineDeps } from "./scheduler-engine";
import { getSchedulerStore } from "./scheduler-store";
import { registerSchedulerIpc } from "./scheduler-ipc";
import { createSchedulerRunner } from "./scheduler-runner";

export interface SchedulerSubsystemDeps {
  agentRuntime: AgentRuntime;
  getReactChatWindow(): BrowserWindow | null;
  store?: ReturnType<typeof getSchedulerStore>;
  createEngine?: (deps: SchedulerEngineDeps) => SchedulerEngine;
  registerIpc?: typeof registerSchedulerIpc;
  /** 共享 IPC scope；传入后 scheduler IPC 由组合根统一注销。 */
  ipc?: IpcScope;
  /**
   * 运行条件检查（在有效启用状态之上）：宿主注入"插件是否正在运行"，
   * 插件停用时定时触发和手动触发都被跳过。
   */
  canRunTask?: (task: ScheduledTask) => boolean;
  /** 生命周期事件发布器：调度轮次事件与 scheduler:finished 由此发布。 */
  publishLifecycle?: LifecyclePublisher;
  conversationJournal?: ConversationJournalService;
  getActiveConversation?: () => ActiveConversationSelection | null;
}

export interface SchedulerSubsystem {
  store: ReturnType<typeof getSchedulerStore>;
  engine: SchedulerEngine;
  initialize(): void;
  start(): void;
  stop(): void;
}

/**
 * 组装 scheduler 子系统。构造期只创建 store 引用 / runner / engine，
 * 不加载 store、不注册 IPC、不启动定时器 —— initialize / start / stop 必须显式调用。
 */
export function createSchedulerSubsystem(deps: SchedulerSubsystemDeps): SchedulerSubsystem {
  const store = deps.store ?? getSchedulerStore();

  const runner = createSchedulerRunner({
    buildOptions: (task) => deps.agentRuntime.buildSchedulerOptions(task),
    getChatWebContents: () => {
      const win = deps.getReactChatWindow();
      return win && !win.isDestroyed() ? win.webContents : null;
    },
    recordHistory: (entry) => store.recordHistory(entry),
    id: () => `hist-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    now: () => new Date(),
    ...(deps.publishLifecycle ? { publishLifecycle: deps.publishLifecycle } : {}),
    ...(deps.conversationJournal ? { conversationJournal: deps.conversationJournal } : {}),
    ...(deps.getActiveConversation ? { getActiveConversation: deps.getActiveConversation } : {}),
  });

  const engineDeps: SchedulerEngineDeps = {
    store,
    runTask: runner.runScheduledTask,
    ...(deps.canRunTask ? { canRunTask: deps.canRunTask } : {}),
  };
  const engine = deps.createEngine
    ? deps.createEngine(engineDeps)
    : new SchedulerEngine(engineDeps);
  const registerIpc = deps.registerIpc ?? registerSchedulerIpc;

  let initialized = false;
  return {
    store,
    engine,
    /** 加载持久化 store + 注册 IPC。idempotent。 */
    initialize(): void {
      if (initialized) return;
      initialized = true;
      store.load();
      registerIpc(store, engine, () => toolRegistry.getAllTools(), deps.ipc);
    },
    /** 只启动 engine 定时器（必须在 MCP 恢复之后调用）。 */
    start(): void {
      engine.start();
    },
    /** 只停止 engine 定时器。 */
    stop(): void {
      engine.stop();
    },
  };
}
