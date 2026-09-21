import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
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
import { ConversationTranscriptStore } from "../../../../../../main/orchestrator/conversation-transcript-store";
import { ConversationJournalService } from "../../../../../../main/orchestrator/conversation-journal-service";

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

/** 假会话存储：记录每次 presentation checkpoint 的快照供顺序断言。 */
function createFakeStore() {
  const store = {
    upsert: vi.fn(async () => ({ id: "session-1" } as never)),
    append: vi.fn(async () => null),
    checkpointPresentation: vi.fn(async (_sessionId: string, _messageId: string, _revision: number, patch: Record<string, unknown>) => {
      await store.upsert("session-1", { id: "assistant-1", role: "model", at: 0, ...patch } as never);
      return { ok: true as const };
    }),
    pendingCompleteDispatch: vi.fn(async () => ({ ok: true })),
  } as unknown as ChatStoreApi & {
    upsert: ReturnType<typeof vi.fn>;
    append: ReturnType<typeof vi.fn>;
    pendingCompleteDispatch: ReturnType<typeof vi.fn>;
  };
  return store;
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

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

function installManualAnimationFrame() {
  let nextId = 1;
  let now = performance.now();
  const frames = new Map<number, FrameRequestCallback>();
  Object.assign(window, {
    requestAnimationFrame: vi.fn((callback: FrameRequestCallback) => {
      const id = nextId++;
      frames.set(id, callback);
      return id;
    }),
    cancelAnimationFrame: vi.fn((id: number) => {
      frames.delete(id);
    }),
  });
  return {
    flushFrames() {
      now = Math.max(now + 40, performance.now() + 50);
      const pending = [...frames.values()];
      frames.clear();
      pending.forEach((callback) => callback(now));
    },
    async flushAllFrames() {
      for (let index = 0; frames.size > 0 && index < 200; index += 1) {
        now = Math.max(now + 40, performance.now() + 50);
        const pending = [...frames.values()];
        frames.clear();
        pending.forEach((callback) => callback(now));
        await Promise.resolve();
        await Promise.resolve();
        await Promise.resolve();
      }
    },
  };
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
  it("awaits the presentation checkpoint before reporting run persistence", async () => {
    const api = createFakeApi({ success: true, runId: "run-1" });
    const store = createFakeStore();
    const { host } = createRecordingHost();
    const order: string[] = [];
    store.checkpointPresentation.mockImplementation(async (...args: unknown[]) => {
      order.push(`checkpoint:${String(args[2])}`);
      return { ok: true };
    });
    (api.reportRunPersisted as ReturnType<typeof vi.fn>).mockImplementation(() => {
      order.push("report");
    });
    const { promise } = launch(createInput(), { api, store, host, registries: createRegistries() });
    await flush();
    api.emit(RUN_STARTED_EVENT);
    api.emit({ type: "TEXT_MESSAGE_START", runId: "run-1" });
    api.emit({ type: "TEXT_MESSAGE_CONTENT", runId: "run-1", delta: "完成" });
    api.emit({ type: "TEXT_MESSAGE_END", runId: "run-1" });
    api.emit({ type: "RUN_FINISHED", runId: "run-1", result: { status: "success" } });
    await promise;

    expect(order.at(-1)).toBe("report");
    expect(order.slice(0, -1).every((entry) => entry.startsWith("checkpoint:"))).toBe(true);
  });

  it("derives the mutation key from the exact queued patch", async () => {
    const api = createFakeApi({ success: true, runId: "run-key" });
    const store = createFakeStore();
    const { host } = createRecordingHost();
    const { promise } = launch(createInput(), { api, store, host, registries: createRegistries() });
    await flush();
    const firstCall = store.checkpointPresentation.mock.calls[0] as [string, string, string, Record<string, unknown>];
    const encoded = firstCall[2].split(":").slice(3).join(":");
    expect(JSON.parse(decodeURIComponent(encoded))).toEqual(firstCall[3]);
    api.emit({ type: "RUN_STARTED", runId: "run-key" });
    api.emit({ type: "TEXT_MESSAGE_START", runId: "run-key" });
    api.emit({ type: "TEXT_MESSAGE_CONTENT", runId: "run-key", delta: "ok" });
    api.emit({ type: "TEXT_MESSAGE_END", runId: "run-key" });
    api.emit({ type: "RUN_FINISHED", runId: "run-key", result: { status: "success" } });
    await promise;
  });

  it("keeps pre-ack RUN_STARTED buffered until the acknowledged run is bound", async () => {
    const api = createFakeApi({ success: true, runId: "run-pre-ack" });
    const ack = deferred<{ success: boolean; runId: string }>();
    (api.run as ReturnType<typeof vi.fn>).mockImplementation(() => ack.promise);
    const store = createFakeStore();
    const { host } = createRecordingHost();
    const registries = createRegistries();
    const { promise } = launch(createInput(), { api, store, host, registries });
    await flush();
    api.emit({ type: "RUN_STARTED", runId: "run-pre-ack" });
    expect(registries.activeRuns.current["session-1"]?.runId).toBeUndefined();
    ack.resolve({ success: true, runId: "run-pre-ack" });
    await flush();
    expect(registries.activeRuns.current["session-1"]?.runId).toBe("run-pre-ack");
    api.emit({ type: "RUN_FINISHED", runId: "run-pre-ack", result: { status: "success" } });
    await promise;
    expect(store.checkpointPresentation.mock.calls.some((call) => (
      (call[3] as { runSnapshot?: { runId?: string } }).runSnapshot?.runId === "run-pre-ack"
    ))).toBe(true);
  });

  it("does not report persistence when the terminal presentation checkpoint fails", async () => {
    const api = createFakeApi({ success: true, runId: "run-1" });
    const store = createFakeStore();
    const { host } = createRecordingHost();
    store.checkpointPresentation.mockImplementation(async (...args: unknown[]) => {
      if ((args[3] as { runSnapshot?: { status?: string } })?.runSnapshot?.status === "terminal") {
        throw new Error("journal unavailable");
      }
      return { ok: true };
    });
    const { promise } = launch(createInput(), { api, store, host, registries: createRegistries() });
    await flush();
    api.emit(RUN_STARTED_EVENT);
    api.emit({ type: "TEXT_MESSAGE_START", runId: "run-1" });
    api.emit({ type: "TEXT_MESSAGE_CONTENT", runId: "run-1", delta: "完成" });
    api.emit({ type: "TEXT_MESSAGE_END", runId: "run-1" });
    api.emit({ type: "RUN_FINISHED", runId: "run-1", result: { status: "success" } });

    await expect(promise).rejects.toThrow("journal unavailable");
    expect(api.reportRunPersisted).not.toHaveBeenCalled();
  });

  it("writes the first running checkpoint to the real journal before invoking api.run", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "cta-controller-journal-"));
    try {
      const transcript = new ConversationTranscriptStore(root, { now: () => 1_000 });
      const journal = new ConversationJournalService(transcript);
      const api = createFakeApi({ success: true, runId: "run-real" });
      (api.run as ReturnType<typeof vi.fn>).mockImplementation(async () => {
        const snapshot = await journal.readProjection("session-1");
        expect(snapshot.messages.find((message) => message.id === "assistant-1")?.runSnapshot?.status).toBe("running");
        return { success: true, runId: "run-real" };
      });
      const realStore = {
        checkpointPresentation: async (sessionId: string, messageId: string, mutationKey: string, patch: Record<string, unknown>) => {
          await journal.appendPresentationNext(sessionId, messageId, mutationKey, patch as never);
          return { ok: true as const };
        },
        pendingCompleteDispatch: vi.fn(async () => ({ ok: true })),
      } as unknown as ChatStoreApi;
      const { host } = createRecordingHost();
      const { promise } = launch(createInput(), { api, store: realStore, host, registries: createRegistries() });
      await flush();
      await vi.waitFor(() => expect(api.run).toHaveBeenCalledTimes(1));
      api.emit(RUN_STARTED_EVENT);
      api.emit({ type: "RUN_FINISHED", runId: "run-real", result: { status: "success" } });
      await promise;
      expect(api.run).toHaveBeenCalledTimes(1);
      expect((await transcript.read("session-1")).entries.filter((entry) => entry.kind === "presentation_patch").length).toBeGreaterThan(0);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("persists a delegation without an active round as a valid presentation patch", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "cta-controller-delegation-"));
    try {
      const transcript = new ConversationTranscriptStore(root, { now: () => 1_000 });
      const journal = new ConversationJournalService(transcript);
      await transcript.append("session-1", {
        id: "assistant-1",
        at: 1,
        kind: "assistant",
        payload: { role: "assistant", content: "" },
      });
      const api = createFakeApi({ success: true, runId: "run-1" });
      const realStore = {
        checkpointPresentation: async (sessionId: string, messageId: string, mutationKey: string, patch: Record<string, unknown>) => {
          await journal.appendPresentationNext(sessionId, messageId, mutationKey, patch as never);
          return { ok: true as const };
        },
        pendingCompleteDispatch: vi.fn(async () => ({ ok: true })),
      } as unknown as ChatStoreApi;
      const { host } = createRecordingHost();
      const { promise } = launch(createInput(), { api, store: realStore, host, registries: createRegistries() });
      await flush();
      await vi.waitFor(() => expect(api.run).toHaveBeenCalledTimes(1));
      api.emit(RUN_STARTED_EVENT);
      await flush();
      api.emit({ type: "CUSTOM", name: "cyrene.task", runId: "run-1", value: {
        invocationId: "inv-1", taskId: "task-1", description: "整理资料", nickname: "风堇", assetFileName: "风堇.png", status: "running",
      } });
      api.emit({ type: "CUSTOM", name: "cyrene.task", runId: "run-1", value: {
        invocationId: "inv-1", taskId: "task-1", description: "整理资料", nickname: "风堇", assetFileName: "风堇.png", status: "completed",
      } });
      await flush();
      api.emit({ type: "RUN_FINISHED", runId: "run-1", result: { status: "success" } });
      await promise;
      const message = (await journal.readProjection("session-1")).messages.find((item) => item.id === "assistant-1");
      expect(message?.taskDelegations).toEqual([expect.objectContaining({ invocationId: "inv-1", status: "completed" })]);
      expect(Object.prototype.hasOwnProperty.call(message?.taskDelegations?.[0] ?? {}, "roundId")).toBe(false);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("只发送结构化当前 user，不上传 renderer 的完整历史", async () => {
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
      currentUser: expect.objectContaining({ turnId: "user-1", text: "继续说", visibleContent: "继续说" }),
    }));
    const runInput = (api.run as unknown as ReturnType<typeof vi.fn>).mock.calls[0][0] as Record<string, unknown>;
    expect(runInput).not.toHaveProperty("messages");

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
    expect(store.append).not.toHaveBeenCalled();
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
      currentUser: expect.objectContaining({ turnId: "user-1" }),
      assistantTurnId: "assistant-1",
      sessionId: "session-1",
    }));
    // runId 随 ack 写入注册表（cancel 依赖此行为），mid-run 落盘的快照会带上它
    const runIds = store.upsert.mock.calls.map((call) => call[1].runSnapshot?.runId);
    expect(runIds).toContain("run-1");
    // 展示补丁只允许 presentation 白名单字段，不回写 canonical-only 锚点。
    for (const call of store.upsert.mock.calls) {
      expect(call[1].answersUserMessageId).toBeUndefined();
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

  it("候选正文首组立即显示，后续积压按小组继续显示，且不进检查点或早播语音", async () => {
    const { flushFrames } = installManualAnimationFrame();
    const api = createFakeApi({ success: true, runId: "run-1" });
    const store = createFakeStore();
    const { host, earlyTtsQueue } = createRecordingHost();
    const { promise } = launch(createInput(), { api, store, host, registries: createRegistries() });
    await flush();

    api.emit(RUN_STARTED_EVENT);
    api.emit({ type: "CUSTOM", name: "cyrene.round", runId: "run-1", value: { action: "start", roundId: "round-0" } });
    api.emit({ type: "CUSTOM", name: "cyrene.candidate_text", runId: "run-1", value: { action: "delta", roundId: "round-0", delta: "你好，" } });
    expect(host.patchMessage).toHaveBeenCalledWith("session-1", "assistant-1", expect.objectContaining({ transientText: "你好，" }));
    api.emit({ type: "CUSTOM", name: "cyrene.candidate_text", runId: "run-1", value: { action: "delta", roundId: "round-0", delta: "世界" } });
    flushFrames();

    api.emit({ type: "TEXT_MESSAGE_START", runId: "run-1", messageId: "m-1" });
    api.emit({ type: "TEXT_MESSAGE_CONTENT", runId: "run-1", delta: "你好，世界" });
    api.emit({ type: "TEXT_MESSAGE_END", runId: "run-1", messageId: "m-1" });
    api.emit({ type: "RUN_FINISHED", runId: "run-1", result: { status: "success" } });
    await promise;

    const candidatePatches = host.patchMessage.mock.calls
      .map((call) => call[2] as { transientText?: string; waitingForFirstEvent?: boolean })
      .filter((patch) => patch.transientText);
    expect(candidatePatches.map((patch) => patch.transientText)).toEqual(["你好，", "你好，世界"]);
    expect(store.upsert.mock.calls.slice(0, -1).every((call) => call[1].content === "")).toBe(true);
    expect(earlyTtsQueue.append).not.toHaveBeenCalled();
  });

  it("跨绘制帧到达的候选正文会按小组平滑追加到界面", async () => {
    const { flushFrames, flushAllFrames } = installManualAnimationFrame();
    const api = createFakeApi({ success: true, runId: "run-1" });
    const store = createFakeStore();
    const { host } = createRecordingHost();
    const { promise } = launch(createInput(), { api, store, host, registries: createRegistries() });
    await flush();

    api.emit(RUN_STARTED_EVENT);
    api.emit({ type: "CUSTOM", name: "cyrene.round", runId: "run-1", value: { action: "start", roundId: "round-0" } });

    api.emit({ type: "CUSTOM", name: "cyrene.candidate_text", runId: "run-1", value: { action: "delta", roundId: "round-0", delta: "好的伙伴，" } });
    expect(host.patchMessage).toHaveBeenCalledWith("session-1", "assistant-1", expect.objectContaining({ transientText: "好的伙" }));
    await flushAllFrames();

    api.emit({ type: "CUSTOM", name: "cyrene.candidate_text", runId: "run-1", value: { action: "delta", roundId: "round-0", delta: "人家先去摸清这边项目的底，" } });
    flushFrames();
    const partialSecond = host.patchMessage.mock.calls
      .map((call) => call[2]?.transientText as string | undefined)
      .filter(Boolean).at(-1)!;
    expect(partialSecond.startsWith("好的伙伴，")).toBe(true);
    expect(partialSecond.length).toBeLessThan("好的伙伴，人家先去摸清这边项目的底，".length);
    await flushAllFrames();

    api.emit({ type: "CUSTOM", name: "cyrene.candidate_text", runId: "run-1", value: { action: "delta", roundId: "round-0", delta: "再决定怎么跑测试♪" } });
    await flushAllFrames();

    const candidatePatches = host.patchMessage.mock.calls
      .map((call) => call[2] as { transientText?: string })
      .filter((patch) => patch.transientText);
    expect(candidatePatches.at(-1)?.transientText).toBe("好的伙伴，人家先去摸清这边项目的底，再决定怎么跑测试♪");
    expect(candidatePatches.length).toBeGreaterThan(3);

    api.emit({ type: "RUN_FINISHED", runId: "run-1", result: { status: "cancelled" } });
    await promise;
  });

  it("工具轮等待候选队列显完后再归类，不突然整段替换或播放第二遍", async () => {
    const { flushAllFrames } = installManualAnimationFrame();
    const api = createFakeApi({ success: true, runId: "run-1" });
    const store = createFakeStore();
    const { host } = createRecordingHost();
    const { promise } = launch(createInput(), { api, store, host, registries: createRegistries() });
    await flush();

    api.emit(RUN_STARTED_EVENT);
    api.emit({ type: "CUSTOM", name: "cyrene.round", runId: "run-1", value: { action: "start", roundId: "round-0" } });
    api.emit({ type: "CUSTOM", name: "cyrene.candidate_text", runId: "run-1", value: { action: "delta", roundId: "round-0", delta: "我先读取文件。" } });
    api.emit({
      type: "CUSTOM",
      name: "cyrene.process_text",
      runId: "run-1",
      value: { content: "我先读取文件。" },
    });
    expect(host.patchMessage.mock.calls.some((call) => call[2]?.processMessages?.some(
      (message: { content?: string }) => message.content === "我先读取文件。",
    ))).toBe(false);
    await flushAllFrames();
    await Promise.resolve();
    const processPatchAtClassification = host.patchMessage.mock.calls.at(-1)?.[2];

    api.emit({ type: "CUSTOM", name: "cyrene.round", runId: "run-1", value: { action: "end", roundId: "round-0" } });
    api.emit({ type: "RUN_FINISHED", runId: "run-1", result: { status: "cancelled" } });
    await promise;

    expect(processPatchAtClassification).toEqual(expect.objectContaining({
      transientText: undefined,
      processMessages: [expect.objectContaining({ content: "我先读取文件。", roundId: "round-0" })],
    }));
  });

  it("discard 归类也等待显示队列排空", async () => {
    const { flushAllFrames } = installManualAnimationFrame();
    const api = createFakeApi({ success: true, runId: "run-1" });
    const store = createFakeStore();
    const { host } = createRecordingHost();
    const { promise } = launch(createInput(), { api, store, host, registries: createRegistries() });
    await flush();

    api.emit(RUN_STARTED_EVENT);
    api.emit({ type: "CUSTOM", name: "cyrene.round", runId: "run-1", value: { action: "start", roundId: "round-0" } });
    api.emit({ type: "CUSTOM", name: "cyrene.candidate_text", runId: "run-1", value: { action: "delta", roundId: "round-0", delta: "先确认项目结构再继续处理。" } });
    api.emit({ type: "CUSTOM", name: "cyrene.candidate_text", runId: "run-1", value: { action: "discard", roundId: "round-0" } });

    expect(host.patchMessage.mock.calls.some((call) => call[2]?.processMessages?.some(
      (message: { content?: string }) => message.content === "先确认项目结构再继续处理。",
    ))).toBe(false);
    await flushAllFrames();
    expect(host.patchMessage).toHaveBeenCalledWith("session-1", "assistant-1", expect.objectContaining({
      transientText: undefined,
      processMessages: [expect.objectContaining({ content: "先确认项目结构再继续处理。", roundId: "round-0" })],
    }));

    api.emit({ type: "RUN_FINISHED", runId: "run-1", result: { status: "cancelled" } });
    await promise;
  });

  it("已有候选预览时先收齐权威最终全文，只在成功终态原地提交", async () => {
    const { flushAllFrames } = installManualAnimationFrame();
    const api = createFakeApi({ success: true, runId: "run-1" });
    const store = createFakeStore();
    const { host, earlyTtsQueue } = createRecordingHost();
    const { promise } = launch(createInput(), { api, store, host, registries: createRegistries() });
    await flush();

    api.emit(RUN_STARTED_EVENT);
    api.emit({ type: "CUSTOM", name: "cyrene.round", runId: "run-1", value: { action: "start", roundId: "round-0" } });
    api.emit({ type: "CUSTOM", name: "cyrene.candidate_text", runId: "run-1", value: { action: "delta", roundId: "round-0", delta: "预览草稿" } });
    await flushAllFrames();
    api.emit({ type: "TEXT_MESSAGE_START", runId: "run-1", messageId: "m-1" });
    api.emit({ type: "TEXT_MESSAGE_CONTENT", runId: "run-1", delta: "权威最终答案" });
    api.emit({ type: "TEXT_MESSAGE_END", runId: "run-1", messageId: "m-1" });
    const committedBeforeTerminal = host.patchMessage.mock.calls.some((call) => call[2]?.content === "权威最终答案");
    api.emit({ type: "RUN_FINISHED", runId: "run-1", result: { status: "success" } });
    await promise;

    expect(committedBeforeTerminal).toBe(false);
    expect(host.patchMessage).toHaveBeenCalledWith("session-1", "assistant-1", expect.objectContaining({
      content: "权威最终答案",
      transientText: undefined,
      responseStarted: true,
      streaming: false,
    }));
    expect(earlyTtsQueue.append).not.toHaveBeenCalled();
    expect(host.earlyTts.finish).toHaveBeenCalledWith(earlyTtsQueue, "权威最终答案");
  });

  it("忽略旧轮次候选；discard 仅闭合当前轮，正文保留为过程消息（ask_user 不丢字）", async () => {
    const { flushAllFrames } = installManualAnimationFrame();
    const api = createFakeApi({ success: true, runId: "run-1" });
    const store = createFakeStore();
    const { host } = createRecordingHost();
    const { promise } = launch(createInput(), { api, store, host, registries: createRegistries() });
    await flush();

    api.emit(RUN_STARTED_EVENT);
    api.emit({ type: "CUSTOM", name: "cyrene.round", runId: "run-1", value: { action: "start", roundId: "round-1" } });
    api.emit({ type: "CUSTOM", name: "cyrene.candidate_text", runId: "run-1", value: { action: "delta", roundId: "round-0", delta: "迟到旧文字" } });
    api.emit({ type: "CUSTOM", name: "cyrene.candidate_text", runId: "run-1", value: { action: "delta", roundId: "round-1", delta: "当前文字" } });
    await flushAllFrames();
    api.emit({ type: "CUSTOM", name: "cyrene.candidate_text", runId: "run-1", value: { action: "discard", roundId: "round-1" } });
    api.emit({ type: "RUN_FINISHED", runId: "run-1", result: { status: "cancelled" } });
    await promise;

    expect(host.patchMessage).not.toHaveBeenCalledWith(
      "session-1", "assistant-1", expect.objectContaining({ transientText: expect.stringContaining("迟到旧文字") }),
    );
    // discard 是历史协议名：语义是「闭合该轮候选」而非删除——正文保留为过程消息
    expect(host.patchMessage).toHaveBeenCalledWith("session-1", "assistant-1", expect.objectContaining({
      transientText: undefined,
      processMessages: [expect.objectContaining({ content: "当前文字", roundId: "round-1" })],
    }));
  });

  it("新轮开始时防御性闭合上一轮候选正文，不依赖 progress_text", async () => {
    const { flushAllFrames } = installManualAnimationFrame();
    const api = createFakeApi({ success: true, runId: "run-1" });
    const store = createFakeStore();
    const { host } = createRecordingHost();
    const { promise } = launch(createInput(), { api, store, host, registries: createRegistries() });
    await flush();

    api.emit(RUN_STARTED_EVENT);
    api.emit({ type: "CUSTOM", name: "cyrene.round", runId: "run-1", value: { action: "start", roundId: "round-0" } });
    api.emit({ type: "CUSTOM", name: "cyrene.candidate_text", runId: "run-1", value: { action: "delta", roundId: "round-0", delta: "上一轮的正文" } });
    await flushAllFrames();
    // 没有 progress_text / discard，直接开始下一轮：上一轮候选必须被闭合保留
    api.emit({ type: "CUSTOM", name: "cyrene.round", runId: "run-1", value: { action: "start", roundId: "round-1" } });
    api.emit({ type: "RUN_FINISHED", runId: "run-1", result: { status: "cancelled" } });
    await promise;

    expect(host.patchMessage).toHaveBeenCalledWith("session-1", "assistant-1", expect.objectContaining({
      transientText: undefined,
      processMessages: [expect.objectContaining({ content: "上一轮的正文", roundId: "round-0" })],
    }));
  });

  it("时间线序号：过程消息、推理块、工具记录按事件发生顺序获得单调递增 seq", async () => {
    const { flushFrames } = installManualAnimationFrame();
    const api = createFakeApi({ success: true, runId: "run-1" });
    const store = createFakeStore();
    const { host } = createRecordingHost();
    const { promise } = launch(createInput(), { api, store, host, registries: createRegistries() });
    await flush();

    api.emit(RUN_STARTED_EVENT);
    api.emit({ type: "CUSTOM", name: "cyrene.round", runId: "run-1", value: { action: "start", roundId: "round-0" } });
    api.emit({ type: "REASONING_MESSAGE_START", runId: "run-1", messageId: "r-0" });
    api.emit({ type: "REASONING_MESSAGE_CONTENT", runId: "run-1", messageId: "r-0", delta: "先想一下" });
    api.emit({ type: "CUSTOM", name: "cyrene.candidate_text", runId: "run-1", value: { action: "delta", roundId: "round-0", delta: "我先看结构。" } });
    flushFrames();
    api.emit({ type: "CUSTOM", name: "cyrene.process_text", runId: "run-1", value: { content: "我先看结构。" } });
    api.emit({ type: "TOOL_CALL_START", runId: "run-1", toolCallId: "t-0", toolCallName: "list_dir" });
    api.emit({ type: "TOOL_CALL_END", runId: "run-1", toolCallId: "t-0" });
    api.emit({ type: "CUSTOM", name: "cyrene.round", runId: "run-1", value: { action: "end", roundId: "round-0" } });
    api.emit({ type: "CUSTOM", name: "cyrene.round", runId: "run-1", value: { action: "start", roundId: "round-1" } });
    api.emit({ type: "REASONING_MESSAGE_START", runId: "run-1", messageId: "r-1" });
    api.emit({ type: "REASONING_MESSAGE_CONTENT", runId: "run-1", messageId: "r-1", delta: "接着找入口" });
    api.emit({ type: "RUN_FINISHED", runId: "run-1", result: { status: "cancelled" } });
    await promise;

    const finalUpsert = store.upsert.mock.calls.at(-1)?.[1] as {
      processMessages?: Array<{ content: string; seq?: number }>;
      reasoningBlocks?: Array<{ content: string; seq?: number }>;
      toolExecutions?: Array<{ name: string; seq?: number }>;
    };
    const seqOf = (record: { seq?: number }) => {
      expect(record.seq).toBeDefined();
      return record.seq!;
    };
    const reasoning0 = finalUpsert.reasoningBlocks?.find((block) => block.content === "先想一下");
    const reasoning1 = finalUpsert.reasoningBlocks?.find((block) => block.content === "接着找入口");
    const process0 = finalUpsert.processMessages?.find((message) => message.content === "我先看结构。");
    const tool0 = finalUpsert.toolExecutions?.find((tool) => tool.name === "list_dir");
    expect(reasoning0 && reasoning1 && process0 && tool0).toBeTruthy();
    // 事件顺序：推理 → 正文 → 工具 → 下一轮推理；seq 必须单调
    expect(seqOf(reasoning0!)).toBeLessThan(seqOf(process0!));
    expect(seqOf(process0!)).toBeLessThan(seqOf(tool0!));
    expect(seqOf(tool0!)).toBeLessThan(seqOf(reasoning1!));
  });

  it("长正文后出现工具轮：闭合时正文只保留一份，不双显不丢失", async () => {
    const { flushFrames } = installManualAnimationFrame();
    const api = createFakeApi({ success: true, runId: "run-1" });
    const store = createFakeStore();
    const { host } = createRecordingHost();
    const { promise } = launch(createInput(), { api, store, host, registries: createRegistries() });
    await flush();

    const longText = "已经流式输出了很长的一段正文。".repeat(24);
    api.emit(RUN_STARTED_EVENT);
    api.emit({ type: "CUSTOM", name: "cyrene.round", runId: "run-1", value: { action: "start", roundId: "round-0" } });
    api.emit({ type: "CUSTOM", name: "cyrene.candidate_text", runId: "run-1", value: { action: "delta", roundId: "round-0", delta: longText } });
    flushFrames();
    api.emit({ type: "CUSTOM", name: "cyrene.process_text", runId: "run-1", value: { content: longText } });
    api.emit({ type: "CUSTOM", name: "cyrene.round", runId: "run-1", value: { action: "end", roundId: "round-0" } });
    api.emit({ type: "RUN_FINISHED", runId: "run-1", result: { status: "cancelled" } });
    await promise;

    const finalUpsert = store.upsert.mock.calls.at(-1)?.[1] as { processMessages?: Array<{ content: string }> };
    const matches = finalUpsert.processMessages?.filter((message) => message.content === longText) ?? [];
    expect(matches).toHaveLength(1);
  });

  it("success 但权威正文为空：不提交正式回答，候选保留为中断过程", async () => {
    const { flushAllFrames } = installManualAnimationFrame();
    const api = createFakeApi({ success: true, runId: "run-1" });
    const store = createFakeStore();
    const { host } = createRecordingHost();
    const { promise } = launch(createInput(), { api, store, host, registries: createRegistries() });
    await flush();

    api.emit(RUN_STARTED_EVENT);
    api.emit({ type: "CUSTOM", name: "cyrene.round", runId: "run-1", value: { action: "start", roundId: "round-0" } });
    api.emit({ type: "CUSTOM", name: "cyrene.candidate_text", runId: "run-1", value: { action: "delta", roundId: "round-0", delta: "只有预览没有权威" } });
    await flushAllFrames();
    api.emit({ type: "TEXT_MESSAGE_START", runId: "run-1", messageId: "m-1" });
    api.emit({ type: "TEXT_MESSAGE_END", runId: "run-1", messageId: "m-1" });
    api.emit({ type: "RUN_FINISHED", runId: "run-1", result: { status: "success" } });
    await promise;

    expect(host.patchMessage).toHaveBeenCalledWith("session-1", "assistant-1", expect.objectContaining({
      content: "",
      processMessages: [expect.objectContaining({ content: "只有预览没有权威", interrupted: true })],
    }));
    expect(store.upsert.mock.calls.at(-1)?.[1].content).toBe("");
  });

  it("权威全文与候选预览不一致时以权威为准，同一消息原地替换", async () => {
    const { flushAllFrames } = installManualAnimationFrame();
    const api = createFakeApi({ success: true, runId: "run-1" });
    const store = createFakeStore();
    const { host, earlyTtsQueue } = createRecordingHost();
    const { promise } = launch(createInput(), { api, store, host, registries: createRegistries() });
    await flush();

    api.emit(RUN_STARTED_EVENT);
    api.emit({ type: "CUSTOM", name: "cyrene.round", runId: "run-1", value: { action: "start", roundId: "round-0" } });
    api.emit({ type: "CUSTOM", name: "cyrene.candidate_text", runId: "run-1", value: { action: "delta", roundId: "round-0", delta: "ABCDEF" } });
    await flushAllFrames();
    api.emit({ type: "TEXT_MESSAGE_START", runId: "run-1", messageId: "m-1" });
    api.emit({ type: "TEXT_MESSAGE_CONTENT", runId: "run-1", delta: "ABCDE" });
    api.emit({ type: "TEXT_MESSAGE_END", runId: "run-1", messageId: "m-1" });
    api.emit({ type: "RUN_FINISHED", runId: "run-1", result: { status: "success" } });
    await promise;

    // 权威只有 ABCDE：终态以权威全文提交，不是预览的 ABCDEF
    expect(host.patchMessage).toHaveBeenCalledWith("session-1", "assistant-1", expect.objectContaining({
      content: "ABCDE",
      transientText: undefined,
    }));
    expect(store.upsert.mock.calls.at(-1)?.[1].content).toBe("ABCDE");
    expect(host.earlyTts.finish).toHaveBeenCalledWith(earlyTtsQueue, "ABCDE");
  });

  it.each(["cancelled", "timeout"] as const)("%s 时把尚未归类的候选正文转成中断过程片段，不提交正式回答", async (status) => {
    const { flushFrames } = installManualAnimationFrame();
    const api = createFakeApi({ success: true, runId: "run-1" });
    const store = createFakeStore();
    const { host } = createRecordingHost();
    const { promise } = launch(createInput(), { api, store, host, registries: createRegistries() });
    await flush();

    api.emit(RUN_STARTED_EVENT);
    api.emit({ type: "CUSTOM", name: "cyrene.round", runId: "run-1", value: { action: "start", roundId: "round-0" } });
    api.emit({ type: "CUSTOM", name: "cyrene.candidate_text", runId: "run-1", value: { action: "delta", roundId: "round-0", delta: "做到一半" } });
    flushFrames();
    api.emit({ type: "RUN_FINISHED", runId: "run-1", result: { status } });
    await promise;

    expect(host.patchMessage).toHaveBeenCalledWith("session-1", "assistant-1", expect.objectContaining({
      content: "",
      transientText: undefined,
      responseStarted: false,
      processMessages: [expect.objectContaining({ content: "做到一半", interrupted: true })],
    }));
    expect(store.upsert.mock.calls.at(-1)?.[1].content).toBe("");
  });

  it("运行错误时把候选正文保留为中断过程片段，并继续显示错误信息", async () => {
    const { flushFrames } = installManualAnimationFrame();
    const api = createFakeApi({ success: true, runId: "run-1" });
    const store = createFakeStore();
    const { host } = createRecordingHost();
    const { promise } = launch(createInput(), { api, store, host, registries: createRegistries() });
    await flush();

    api.emit(RUN_STARTED_EVENT);
    api.emit({ type: "CUSTOM", name: "cyrene.round", runId: "run-1", value: { action: "start", roundId: "round-0" } });
    api.emit({ type: "CUSTOM", name: "cyrene.candidate_text", runId: "run-1", value: { action: "delta", roundId: "round-0", delta: "正在处理到这里" } });
    flushFrames();
    api.emit({ type: "RUN_ERROR", runId: "run-1", message: "连接中断" });
    await promise;

    const finalPatch = host.patchMessage.mock.calls.at(-1)?.[2];
    expect(finalPatch).toEqual(expect.objectContaining({
      content: "",
      transientText: undefined,
      responseStarted: false,
      processMessages: expect.arrayContaining([
        expect.objectContaining({ content: "正在处理到这里", interrupted: true }),
        expect.objectContaining({ content: expect.stringContaining("连接中断") }),
      ]),
    }));
    expect(store.upsert.mock.calls.at(-1)?.[1].content).toBe("");
  });

  it("过程归类等待期间发生运行错误时不会重复保留候选正文", async () => {
    installManualAnimationFrame();
    const api = createFakeApi({ success: true, runId: "run-1" });
    const store = createFakeStore();
    const { host } = createRecordingHost();
    const { promise } = launch(createInput(), { api, store, host, registries: createRegistries() });
    await flush();

    api.emit(RUN_STARTED_EVENT);
    api.emit({ type: "CUSTOM", name: "cyrene.round", runId: "run-1", value: { action: "start", roundId: "round-0" } });
    api.emit({ type: "CUSTOM", name: "cyrene.candidate_text", runId: "run-1", value: { action: "delta", roundId: "round-0", delta: "正在检查关键文件。" } });
    api.emit({ type: "CUSTOM", name: "cyrene.process_text", runId: "run-1", value: { content: "正在检查关键文件。" } });
    api.emit({ type: "RUN_ERROR", runId: "run-1", message: "连接中断" });
    await promise;

    const finalUpsert = store.upsert.mock.calls.at(-1)?.[1] as { processMessages?: Array<{ content: string }> };
    expect(finalUpsert.processMessages?.filter((message) => message.content === "正在检查关键文件。")).toHaveLength(1);
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

  it("把轨迹回退元数据透传进派发请求", async () => {
    const api = createFakeApi({ success: true, runId: "run-1" });
    const store = createFakeStore();
    const { host } = createRecordingHost();
    const input = createInput({
      transcriptRewind: { anchorUserTurnId: "user-1", disposition: "replace_user" },
    });
    const { promise } = launch(input, { api, store, host, registries: createRegistries() });
    await flush();

    expect(api.run).toHaveBeenCalledWith(expect.objectContaining({
      currentUser: expect.objectContaining({ turnId: "user-1" }),
      transcriptRewind: { anchorUserTurnId: "user-1", disposition: "replace_user" },
    }));

    api.emit(RUN_STARTED_EVENT);
    api.emit({ type: "RUN_FINISHED", runId: "run-1", result: { status: "success" } });
    await promise;
  });

  it("即使 renderer 内存有完整历史，dispatch 也不携带 messages", async () => {
    const api = createFakeApi({ success: true, runId: "run-1" });
    const store = createFakeStore();
    const { host } = createRecordingHost();
    const messages = Array.from({ length: 20 }, (_, index) => ({
      id: `m-${index}`,
      role: index % 2 === 0 ? "user" as const : "model" as const,
      content: `消息${index}`,
      at: index + 1,
    }));
    const input = createInput({
      session: { id: "session-1", messages } as unknown as ChatSession,
    });
    const { promise } = launch(input, { api, store, host, registries: createRegistries() });
    await flush();

    const runInput = (api.run as unknown as ReturnType<typeof vi.fn>).mock.calls[0][0] as Record<string, unknown>;
    expect(runInput).not.toHaveProperty("messages");
    expect(runInput.currentUser).toEqual(expect.objectContaining({ turnId: "user-1" }));

    api.emit(RUN_STARTED_EVENT);
    api.emit({ type: "RUN_FINISHED", runId: "run-1", result: { status: "success" } });
    await promise;
  });
});
