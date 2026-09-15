import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  AgentRunController,
  type AgentRunDeps,
  type AgentRunHost,
  type AgentRunInput,
  type AgentRunRegistries,
} from "./AgentRunController";
import type { AguiApi, AguiEvent, ChatStoreApi } from "../chat-page-bridge";
import type { ChatSession } from "../../../../../../shared/chat-types";
import type { TodoStateBySession } from "../session-runtime-state";
import type { EarlyTtsPlaybackQueue } from "../../tts/early-tts-queue";

/**
 * AgentRunController 全流程单测：注入假桥、记录型宿主与真实注册表，
 * 驱动一次 run 从派发到终态，验证事件归约、检查点顺序与终态结算。
 */

interface FakeApi extends AguiApi {
  emit: (event: AguiEvent) => void;
}

/** 假桥：onEvent 注册监听器，run 返回测试控制的 ack，emit 广播事件。 */
function createFakeApi(ack: { success: boolean; runId: string; error?: string }): FakeApi {
  const listeners = new Set<(event: AguiEvent) => void>();
  return {
    run: vi.fn(async () => ack),
    onEvent: vi.fn((callback: (event: AguiEvent) => void) => {
      listeners.add(callback);
      return () => listeners.delete(callback);
    }),
    cancel: vi.fn(async () => undefined),
    reportRunPersisted: vi.fn(),
    emit: (event: AguiEvent) => {
      for (const listener of listeners) listener(event);
    },
  };
}

/** 假会话存储：记录每次 upsert 的快照供顺序断言。 */
function createFakeStore() {
  return {
    upsert: vi.fn(async () => ({ id: "session-1" } as never)),
    append: vi.fn(async () => null),
    pendingCompleteDispatch: vi.fn(async () => ({ ok: true })),
  } as unknown as ChatStoreApi & {
    upsert: ReturnType<typeof vi.fn>;
    append: ReturnType<typeof vi.fn>;
    pendingCompleteDispatch: ReturnType<typeof vi.fn>;
  };
}

/** 记录型宿主：全部端口为 vi.fn，Todo 状态按函数式更新真实维护。 */
function createRecordingHost() {
  let todoState: TodoStateBySession = {};
  const earlyTtsQueue = { append: vi.fn(), cancel: vi.fn() } as unknown as EarlyTtsPlaybackQueue;
  const host: AgentRunHost & Record<string, ReturnType<typeof vi.fn>> = {
    patchMessage: vi.fn(),
    setInteraction: vi.fn(),
    clearInteraction: vi.fn(),
    dismissAskIfMatched: vi.fn(),
    updateTodos: vi.fn((_sessionId: string, updater: (current: TodoStateBySession) => TodoStateBySession) => {
      todoState = updater(todoState);
    }),
    updateContextUsage: vi.fn(),
    setCompressingContext: vi.fn(),
    setModeBusy: vi.fn(),
    requestTakeover: vi.fn(),
    clearTakeover: vi.fn(),
    earlyTts: { start: vi.fn(() => earlyTtsQueue), finish: vi.fn() },
    onRunFinished: vi.fn(),
  };
  return { host, earlyTtsQueue, readTodoState: () => todoState };
}

function createRegistries(): AgentRunRegistries {
  return {
    activeRuns: { current: {} },
    checkpointTriggers: { current: {} },
    cancelRequestedSessions: { current: new Set<string>() },
    eventUnsubscribers: { current: new Set<() => void>() },
  };
}

function createInput(overrides: Partial<AgentRunInput> = {}): AgentRunInput {
  const sessionId = overrides.sessionId ?? "session-1";
  return {
    targetMode: "chat",
    sessionId,
    userMessageId: "user-1",
    assistantId: "assistant-1",
    session: {
      id: sessionId,
      messages: [{ id: "user-1", role: "user", content: "你好", at: 1 }],
    } as unknown as ChatSession,
    attachments: [],
    ...overrides,
  };
}

/** 组装控制器并启动；返回完成 promise 供 await。 */
function launch(input: AgentRunInput, deps: Omit<AgentRunDeps, "startRun"> & { startRun?: AgentRunDeps["startRun"] }) {
  const controller = new AgentRunController(input, {
    ...deps,
    startRun: deps.startRun ?? vi.fn(async () => undefined),
  } as AgentRunDeps);
  return { controller, promise: controller.start() };
}

const RUN_STARTED_EVENT: AguiEvent = { type: "RUN_STARTED", runId: "run-1" };

/** 让渡一轮事件循环：等控制器完成监听器注册与首次检查点后再驱动事件。 */
async function flush() {
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
}

beforeEach(() => {
  // node 环境没有 window：补上控制器用到的 setTimeout/clearTimeout 与 chat 桥占位
  vi.stubGlobal("window", {
    chat: undefined,
    setTimeout,
    clearTimeout,
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("AgentRunController", () => {
  it("uses hidden channel model context when continuing a bound conversation from desktop", async () => {
    const api = createFakeApi({ success: true, runId: "run-1" });
    const store = createFakeStore();
    const { host } = createRecordingHost();
    const input = createInput({
      session: {
        id: "session-1",
        messages: [
          {
            id: "channel-user",
            role: "user",
            content: "大家好",
            modelContext: "[QQ群发送者：伙伴]\n大家好",
            channelSource: { channel: "qq", senderName: "伙伴" },
            at: 1,
          },
          { id: "channel-model", role: "model", content: "你好", channelSource: { channel: "qq" }, at: 2 },
          { id: "user-1", role: "user", content: "继续说", at: 3 },
        ],
      } as unknown as ChatSession,
    });
    const { promise } = launch(input, { api, store, host, registries: createRegistries() });
    await flush();

    expect(api.run).toHaveBeenCalledWith(expect.objectContaining({
      messages: [
        expect.objectContaining({ role: "user", content: "[QQ群发送者：伙伴]\n大家好" }),
        expect.objectContaining({ role: "model", content: "你好" }),
        expect.objectContaining({ role: "user", content: "继续说" }),
      ],
    }));

    api.emit(RUN_STARTED_EVENT);
    api.emit({ type: "RUN_FINISHED", runId: "run-1", result: { status: "success" } });
    await promise;
  });

  it("桥或存储未就绪时直接把错误写进消息并落盘，不进入 run 流程", async () => {
    const input = createInput();
    const store = createFakeStore();
    const { host } = createRecordingHost();
    const controller = new AgentRunController(input, {
      api: undefined,
      store,
      host,
      registries: createRegistries(),
      startRun: vi.fn(async () => undefined),
    });
    await controller.start();

    expect(host.patchMessage).toHaveBeenCalledWith("session-1", "assistant-1", expect.objectContaining({
      loading: false,
      streaming: false,
    }));
    expect(store.append).toHaveBeenCalled();
    // run 未被主进程接受：仍要通知宿主（queuePaused 暂停队列消费），但不进入 busy 流程
    expect(host.onRunFinished).toHaveBeenCalledWith({ mode: "chat", sessionId: "session-1", queuePaused: true });
    expect(host.setModeBusy).not.toHaveBeenCalled();
  });

  it("认领派发的 run：ack 成功后确认派发清除 pendingDispatch，queuePaused=false", async () => {
    const api = createFakeApi({ success: true, runId: "run-1" });
    const store = createFakeStore();
    const { host } = createRecordingHost();
    const input = createInput({ claimedPendingMessageId: "q-claim" });
    const { promise } = launch(input, { api, store, host, registries: createRegistries() });
    await flush();

    api.emit(RUN_STARTED_EVENT);
    api.emit({ type: "RUN_FINISHED", runId: "run-1", result: { status: "success" } });
    await promise;

    // run 被主进程接受后立即确认派发：按会话与认领消息标识调用一次
    expect(store.pendingCompleteDispatch).toHaveBeenCalledTimes(1);
    expect(store.pendingCompleteDispatch).toHaveBeenCalledWith("session-1", "q-claim");
    // run 已接受：队列消费不暂停
    expect(host.onRunFinished).toHaveBeenCalledWith({ mode: "chat", sessionId: "session-1", queuePaused: false });
  });

  it("认领派发的 run：ack 失败不确认派发，pendingDispatch 保留供恢复，queuePaused=true", async () => {
    const api = createFakeApi({ success: false, runId: "", error: "AGUI_NOT_READY" });
    const store = createFakeStore();
    const { host } = createRecordingHost();
    const input = createInput({ claimedPendingMessageId: "q-claim" });
    const { promise } = launch(input, { api, store, host, registries: createRegistries() });
    await promise;

    // run 未被接受：绝不确认派发（主进程 pendingDispatch 残留，恢复逻辑据此续派）
    expect(store.pendingCompleteDispatch).not.toHaveBeenCalled();
    expect(host.onRunFinished).toHaveBeenCalledWith({ mode: "chat", sessionId: "session-1", queuePaused: true });
  });

  it("认领派发的 run：模型启动成功后派发确认异常，不进入模型失败分支，run 正常完成", async () => {
    const api = createFakeApi({ success: true, runId: "run-1" });
    const store = createFakeStore();
    // 派发状态清理失败（IPC 异常）：run 已被接受，不得污染为失败终态
    store.pendingCompleteDispatch.mockRejectedValueOnce(new Error("ipc broken"));
    const { host } = createRecordingHost();
    const input = createInput({ claimedPendingMessageId: "q-claim" });
    const { promise } = launch(input, { api, store, host, registries: createRegistries() });
    await flush();

    api.emit(RUN_STARTED_EVENT);
    api.emit({ type: "TEXT_MESSAGE_START", runId: "run-1", messageId: "m-1" });
    api.emit({ type: "TEXT_MESSAGE_CONTENT", runId: "run-1", delta: "最终回答" });
    api.emit({ type: "TEXT_MESSAGE_END", runId: "run-1", messageId: "m-1" });
    api.emit({ type: "RUN_FINISHED", runId: "run-1", result: { status: "success" } });
    await promise;

    // 终态仍按成功结算：正式回答提交、不报失败、队列消费不暂停
    expect(store.pendingCompleteDispatch).toHaveBeenCalledTimes(1);
    const terminalUpsert = store.upsert.mock.calls.at(-1)?.[1] as { content: string; runSnapshot?: { terminalStatus?: string } };
    expect(terminalUpsert.content).toBe("最终回答");
    expect(terminalUpsert.runSnapshot?.terminalStatus).toBe("success");
    expect(host.onRunFinished).toHaveBeenCalledWith({ mode: "chat", sessionId: "session-1", queuePaused: false });
  });

  it("成功流：事件序列归约、终态提交正式回答并按顺序落盘", async () => {
    const api = createFakeApi({ success: true, runId: "run-1" });
    const store = createFakeStore();
    const { host, earlyTtsQueue } = createRecordingHost();
    const registries = createRegistries();
    const input = createInput();
    const { promise } = launch(input, { api, store, host, registries });
    await flush();

    api.emit(RUN_STARTED_EVENT);
    api.emit({ type: "TEXT_MESSAGE_START", runId: "run-1", messageId: "m-1" });
    api.emit({ type: "TEXT_MESSAGE_CONTENT", runId: "run-1", delta: "你好，" });
    api.emit({ type: "TEXT_MESSAGE_CONTENT", runId: "run-1", delta: "世界" });
    api.emit({ type: "TEXT_MESSAGE_END", runId: "run-1", messageId: "m-1" });
    api.emit({ type: "RUN_FINISHED", runId: "run-1", result: { status: "success" } });
    await promise;

    // 派发请求带上本轮的轮次标识与会话标识
    expect(api.run).toHaveBeenCalledWith(expect.objectContaining({
      userTurnId: "user-1",
      assistantTurnId: "assistant-1",
      sessionId: "session-1",
    }));
    // runId 随 ack 写入注册表（cancel 依赖此行为），mid-run 落盘的快照会带上它
    const runIds = store.upsert.mock.calls.map((call) => call[1].runSnapshot?.runId);
    expect(runIds).toContain("run-1");
    // 检查点携带关联锚点：残留认领的恢复判定据此对账「认领 ↔ 对应模型运行」
    for (const call of store.upsert.mock.calls) {
      expect(call[1].answersUserMessageId).toBe("user-1");
    }
    // 流式内容逐步发布，chat 模式整段直发
    expect(host.patchMessage).toHaveBeenCalledWith("session-1", "assistant-1", expect.objectContaining({
      content: "你好，",
      streaming: true,
    }));
    // 终态：提交正式回答、结束流式标记
    expect(host.patchMessage).toHaveBeenCalledWith("session-1", "assistant-1", expect.objectContaining({
      content: "你好，世界",
      streaming: false,
      responseStarted: true,
      loading: false,
    }));
    // 检查点顺序：首尾分别是 running 与 terminal(success)
    const statuses = store.upsert.mock.calls.map((call) => call[1].runSnapshot?.status);
    expect(statuses[0]).toBe("running");
    expect(statuses[statuses.length - 1]).toBe("terminal");
    expect(store.upsert.mock.calls.at(-1)?.[1].runSnapshot).toMatchObject({
      status: "terminal",
      terminalStatus: "success",
    });
    // 终态消息 content 为正式回答（非空），落盘确认上报
    expect(store.upsert.mock.calls.at(-1)?.[1].content).toBe("你好，世界");
    expect(api.reportRunPersisted).toHaveBeenCalledWith({ runId: "run-1", finalMessageId: "assistant-1" });
    // 成功且提交正式回答：早播队列用完整正文收尾
    expect(host.earlyTts.finish).toHaveBeenCalledWith(earlyTtsQueue, "你好，世界");
    // 收尾：清 busy、清注册表、通知宿主
    expect(host.setModeBusy).toHaveBeenCalledWith("chat", false);
    expect(registries.activeRuns.current["session-1"]).toBeUndefined();
    expect(registries.checkpointTriggers.current["session-1"]).toBeUndefined();
    expect(registries.eventUnsubscribers.current.size).toBe(0);
    expect(host.onRunFinished).toHaveBeenCalledWith({ mode: "chat", sessionId: "session-1", queuePaused: false });
  });

  it("其他 run 的事件被门控忽略，不污染本轮消息", async () => {
    const api = createFakeApi({ success: true, runId: "run-1" });
    const store = createFakeStore();
    const { host } = createRecordingHost();
    const input = createInput();
    const { promise } = launch(input, { api, store, host, registries: createRegistries() });
    await flush();

    api.emit(RUN_STARTED_EVENT);
    api.emit({ type: "TEXT_MESSAGE_CONTENT", runId: "run-other", delta: "串台内容" });
    api.emit({ type: "RUN_FINISHED", runId: "run-1", result: { status: "success" } });
    await promise;

    // 终态正文为空：串台 delta 从未进入流式累积
    expect(store.upsert.mock.calls.at(-1)?.[1].content).toBe("");
    expect(host.patchMessage).not.toHaveBeenCalledWith(
      "session-1", "assistant-1", expect.objectContaining({ content: "串台内容" }),
    );
  });

  it("ack 前已请求取消的会话：ack 返回后立即对新 runId 发起 cancel", async () => {
    const api = createFakeApi({ success: true, runId: "run-1" });
    const store = createFakeStore();
    const { host } = createRecordingHost();
    const registries = createRegistries();
    registries.cancelRequestedSessions.current.add("session-1");
    const input = createInput();
    const { promise } = launch(input, { api, store, host, registries });
    await flush();
    api.emit(RUN_STARTED_EVENT);
    api.emit({ type: "RUN_FINISHED", runId: "run-1", result: { status: "success" } });
    await promise;

    expect(api.cancel).toHaveBeenCalledWith("run-1");
    expect(registries.cancelRequestedSessions.current.has("session-1")).toBe(false);
  });

  it("cancelled 终态：不提交正式回答，早播队列取消而非收尾", async () => {
    const api = createFakeApi({ success: true, runId: "run-1" });
    const store = createFakeStore();
    const { host, earlyTtsQueue } = createRecordingHost();
    const input = createInput();
    const { promise } = launch(input, { api, store, host, registries: createRegistries() });
    await flush();

    api.emit(RUN_STARTED_EVENT);
    api.emit({ type: "TEXT_MESSAGE_CONTENT", runId: "run-1", delta: "半截输出" });
    api.emit({ type: "TEXT_MESSAGE_END", runId: "run-1", messageId: "m-1" });
    api.emit({ type: "RUN_FINISHED", runId: "run-1", result: { status: "cancelled" } });
    await promise;

    // 取消终态不提交正式回答：content 置空、responseStarted 复位
    expect(host.patchMessage).toHaveBeenCalledWith("session-1", "assistant-1", expect.objectContaining({
      content: "",
      responseStarted: false,
      streaming: false,
    }));
    expect(store.upsert.mock.calls.at(-1)?.[1].runSnapshot).toMatchObject({
      status: "terminal",
      terminalStatus: "cancelled",
    });
    expect(host.earlyTts.finish).not.toHaveBeenCalled();
    expect(earlyTtsQueue.cancel).toHaveBeenCalled();
    expect(host.onRunFinished).toHaveBeenCalled();
  });

  it("RUN_ERROR：走错误路径落盘并上报，收尾仍清理 busy 与注册表", async () => {
    const api = createFakeApi({ success: true, runId: "run-1" });
    const store = createFakeStore();
    const { host } = createRecordingHost();
    const input = createInput();
    const { promise } = launch(input, { api, store, host, registries: createRegistries() });
    await flush();

    api.emit(RUN_STARTED_EVENT);
    api.emit({ type: "RUN_ERROR", runId: "run-1", message: "boom" });
    await promise;

    // 错误信息进入过程消息区，正式回答置空
    expect(host.patchMessage).toHaveBeenCalledWith("session-1", "assistant-1", expect.objectContaining({
      content: "",
      loading: false,
      streaming: false,
      responseStarted: false,
    }));
    expect(store.upsert.mock.calls.at(-1)?.[1].runSnapshot).toMatchObject({
      status: "terminal",
      terminalStatus: "runtime_error",
    });
    expect(api.reportRunPersisted).toHaveBeenCalledWith({ runId: "run-1", finalMessageId: "assistant-1" });
    expect(host.setModeBusy).toHaveBeenCalledWith("chat", false);
    expect(host.onRunFinished).toHaveBeenCalled();
  });

  it("会话守卫冲突：挂起接管操作卡，重试时带 takeoverFromRunId 复用派发入口", async () => {
    const api = createFakeApi({ success: false, runId: "", error: "SESSION_RUN_ACTIVE:run-old" });
    const store = createFakeStore();
    const { host } = createRecordingHost();
    const registries = createRegistries();
    const startRun = vi.fn(async () => undefined);
    const input = createInput();
    const { promise } = launch(input, { api, store, host, registries, startRun });
    await flush();
    await promise;

    // 冲突不写通用错误文案，而是挂起接管卡等待用户决定
    expect(host.requestTakeover).toHaveBeenCalledTimes(1);
    const [sessionId, conflictRunId] = host.requestTakeover.mock.calls[0];
    expect(sessionId).toBe("session-1");
    expect(conflictRunId).toBe("run-old");
    expect(store.upsert.mock.calls.at(-1)?.[1].runSnapshot?.status).toBe("terminal");
    expect(host.onRunFinished).toHaveBeenCalled();

    // 用户选择重开：占位消息回到 loading，并以 takeoverFromRunId 重发
    const retry = host.requestTakeover.mock.calls[0][2];
    await retry();
    expect(host.patchMessage).toHaveBeenCalledWith("session-1", "assistant-1", expect.objectContaining({
      loading: true,
      waitingForFirstEvent: true,
    }));
    expect(startRun).toHaveBeenCalledWith(expect.objectContaining({ takeoverFromRunId: "run-old" }));
  });

  it("ask 选择卡：展示交互卡并落 waiting_user 检查点，检查点触发器可复写状态", async () => {
    const api = createFakeApi({ success: true, runId: "run-1" });
    const store = createFakeStore();
    const { host } = createRecordingHost();
    const registries = createRegistries();
    const input = createInput();
    const { promise } = launch(input, { api, store, host, registries });
    await flush();

    api.emit(RUN_STARTED_EVENT);
    api.emit({
      type: "CUSTOM",
      name: "cyrene.choice",
      runId: "run-1",
      value: {
        interactionId: "ix-1",
        runId: "run-1",
        revision: 1,
        questions: [{ id: "q1", prompt: "选一个", customInput: { enabled: true } }],
      },
    });
    // 卡片出现后等待用户：外部（审批结算路径）可通过注册的触发器把状态落为 waiting_user
    const trigger = registries.checkpointTriggers.current["session-1"];
    expect(trigger).toBeTypeOf("function");
    await trigger?.("waiting_user");

    api.emit({ type: "RUN_FINISHED", runId: "run-1", result: { status: "success" } });
    await promise;

    expect(host.setInteraction).toHaveBeenCalledTimes(1);
    const statuses = store.upsert.mock.calls.map((call) => call[1].runSnapshot?.status);
    expect(statuses).toContain("waiting_user");
    // 终态（runId 一致）清除 composer 交互卡
    expect(host.clearInteraction).toHaveBeenCalledWith("session-1");
  });

  it("run 启动即注册检查点触发器，run 结束后注销", async () => {
    const api = createFakeApi({ success: true, runId: "run-1" });
    const store = createFakeStore();
    const { host } = createRecordingHost();
    const registries = createRegistries();
    const input = createInput();
    const { promise } = launch(input, { api, store, host, registries });
    await flush();
    // run 进行中：触发器已注册，可供审批结算路径复写 waiting_user 状态
    expect(registries.checkpointTriggers.current["session-1"]).toBeTypeOf("function");
    api.emit(RUN_STARTED_EVENT);
    api.emit({ type: "RUN_FINISHED", runId: "run-1", result: { status: "success" } });
    await promise;

    expect(registries.checkpointTriggers.current["session-1"]).toBeUndefined();
  });

  it("关闭切分时把 off 模式透传给 earlyTts.start", async () => {
    vi.stubGlobal("window", {
      chat: {
        getGeneralSettings: vi.fn(async () => ({
          ttsEarlyReadSplitEnabled: false,
          ttsEarlyReadSplitMode: "paragraph",
        })),
      },
      setTimeout,
      clearTimeout,
    });
    const api = createFakeApi({ success: true, runId: "run-1" });
    const store = createFakeStore();
    const { host } = createRecordingHost();
    const { promise } = launch(createInput(), { api, store, host, registries: createRegistries() });
    await flush();
    api.emit(RUN_STARTED_EVENT);
    api.emit({ type: "RUN_FINISHED", runId: "run-1", result: { status: "success" } });
    await promise;

    expect(host.earlyTts.start).toHaveBeenCalledWith("chat", "session-1", "assistant-1", "off");
  });

  it("开启切分且选择一段一切时把 paragraph 透传给 earlyTts.start", async () => {
    vi.stubGlobal("window", {
      chat: {
        getGeneralSettings: vi.fn(async () => ({
          ttsEarlyReadSplitEnabled: true,
          ttsEarlyReadSplitMode: "paragraph",
        })),
      },
      setTimeout,
      clearTimeout,
    });
    const api = createFakeApi({ success: true, runId: "run-1" });
    const store = createFakeStore();
    const { host } = createRecordingHost();
    const { promise } = launch(createInput(), { api, store, host, registries: createRegistries() });
    await flush();
    api.emit(RUN_STARTED_EVENT);
    api.emit({ type: "RUN_FINISHED", runId: "run-1", result: { status: "success" } });
    await promise;

    expect(host.earlyTts.start).toHaveBeenCalledWith("chat", "session-1", "assistant-1", "paragraph");
  });
});
