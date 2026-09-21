import { beforeEach, describe, expect, it, vi } from "vitest";
import { applyScheduledExecutionPolicy, createSchedulerRunner } from "./scheduler-runner";
import type { ScheduledTask } from "./types";

const runnerMocks = vi.hoisted(() => ({
  agentResult: {
    reply: "调度回复",
    terminal: undefined as undefined | { status: "success" | "timeout" | "cancelled" | "runtime_error" },
  },
  agentError: undefined as Error | undefined,
}));

vi.mock("../orchestrator/cyrene-agent", () => ({
  CyreneAgent: class {
    get lastResult() {
      return runnerMocks.agentResult;
    }

    runWithEvents() {
      // 异步派发终态，避免订阅者解引用尚未完成赋值的 sub（TDZ）
      return {
        subscribe: ({ complete, error }: { complete: () => void; error: (err: Error) => void }) => {
          queueMicrotask(() => {
            if (runnerMocks.agentError) error(runnerMocks.agentError);
            else complete();
          });
          return { unsubscribe: () => undefined };
        },
      };
    }
  },
}));

vi.mock("../orchestrator/tools/registry/tool-registry", () => ({
  toolRegistry: { getAllTools: () => [] },
}));

function makeTask(overrides: Partial<ScheduledTask> = {}): ScheduledTask {
  return {
    id: "task-1",
    title: "每日整理",
    prompt: "整理资料",
    enabled: true,
    schedule: { kind: "daily", at: "08:00" } as ScheduledTask["schedule"],
    nextFireAt: null,
    toolMode: "allow-list",
    allowedToolIds: [],
    createdAt: "2026-09-01T00:00:00Z",
    updatedAt: "2026-09-01T00:00:00Z",
    ...overrides,
  };
}

function makeRunnerDeps(overrides: Record<string, unknown> = {}) {
  return {
    buildOptions: vi.fn(async () => ({
      messages: [{ role: "user", content: "整理资料" }],
      settings: {
        provider: "test",
        baseUrl: "",
        model: "test-model",
        apiKey: "",
        contextWindowTokens: 256_000,
      },
      timeoutMs: 60_000,
    })),
    getChatWebContents: () => null,
    recordHistory: vi.fn(),
    id: () => "hist-1",
    now: (() => {
      let tick = 0;
      return () => {
        tick += 1000;
        return new Date(Date.UTC(2026, 8, 3, 10, 0, 0) + tick);
      };
    })(),
    ...overrides,
  };
}

beforeEach(() => {
  runnerMocks.agentResult = { reply: "调度回复", terminal: undefined };
  runnerMocks.agentError = undefined;
});

describe("scheduled Cyrene execution policy", () => {
  it("runs unattended Work Harness with no interactive tools or approval", () => {
    const options = applyScheduledExecutionPolicy({
      settings: {
        provider: "test",
        baseUrl: "",
        model: "test-model",
        apiKey: "",
        contextWindowTokens: 256_000,
      },
      messages: [{ role: "user", content: "整理今天的资料" }],
      timeoutMs: 60_000,
      toolSystemContent: "work tools",
      soulSystemBaseContent: "work persona",
    });

    expect(options).toMatchObject({
      executionMode: "work",
      conversationMode: "work",
      harnessInteractiveTools: false,
      permissionMode: "allow_all",
    });
    expect(options.messages).toEqual([{ role: "user", content: "整理今天的资料" }]);
  });
});

describe("createSchedulerRunner lifecycle events", () => {
  it("freezes the selected conversation and writes scheduler facts through the journal", async () => {
    const sink = {
      checkpoint: vi.fn(async () => undefined),
      appendAssistant: vi.fn(async () => "assistant-entry"),
      appendToolResult: vi.fn(async () => undefined),
      closeInterruption: vi.fn(async () => undefined),
    };
    const journal = {
      appendUser: vi.fn(async () => undefined),
      createRunSink: vi.fn(() => sink),
    };
    let active = { sessionId: "session-1", mode: "work" as const };
    const send = vi.fn();
    const publishLifecycle = {
      publishTurnStarted: vi.fn(),
      publishTurnFinished: vi.fn(),
      publishSchedulerFinished: vi.fn(),
    };
    const deps = makeRunnerDeps({
      getChatWebContents: () => ({ isDestroyed: () => false, send } as never),
      getActiveConversation: () => {
        const selected = active;
        active = { sessionId: "session-2", mode: "work" };
        return selected;
      },
      conversationJournal: journal,
      publishLifecycle,
    });

    const runner = createSchedulerRunner(deps as never);
    await runner.runScheduledTask(makeTask(), new Date(), false);

    expect(journal.appendUser).toHaveBeenCalledWith("session-1", expect.objectContaining({ text: "整理资料" }));
    expect(journal.createRunSink).toHaveBeenCalledWith({ conversationId: "session-1", runId: "hist-1" });
    expect(sink.checkpoint).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith("scheduler:event", expect.objectContaining({ conversationId: "session-1" }));
    expect(publishLifecycle.publishTurnStarted).toHaveBeenCalledWith(expect.objectContaining({ conversationId: "session-1" }));
    expect(publishLifecycle.publishTurnFinished).toHaveBeenCalledWith(expect.objectContaining({ conversationId: "session-1" }));
  });

  it("closes the journal when scheduler presentation checkpoint fails", async () => {
    const sink = {
      checkpoint: vi.fn(async () => { throw new Error("journal unavailable"); }),
      appendAssistant: vi.fn(async () => "assistant-entry"),
      appendToolResult: vi.fn(async () => undefined),
      closeInterruption: vi.fn(async () => undefined),
    };
    const journal = {
      appendUser: vi.fn(async () => undefined),
      createRunSink: vi.fn(() => sink),
    };
    const deps = makeRunnerDeps({
      conversationJournal: journal,
      getActiveConversation: () => ({ sessionId: "session-1", mode: "work" }),
    });

    const runner = createSchedulerRunner(deps as never);
    const result = await runner.runScheduledTask(makeTask(), new Date(), false);

    expect(result.ok).toBe(false);
    expect(sink.closeInterruption).toHaveBeenCalledWith({ reason: "user_cancel", runSession: null });
  });

  it("成功执行发布 started/finished/scheduler:finished 且不伪造 conversationId", async () => {
    const publishLifecycle = {
      publishTurnStarted: vi.fn(),
      publishTurnFinished: vi.fn(),
      publishSchedulerFinished: vi.fn(),
    };
    const deps = makeRunnerDeps({ publishLifecycle });
    const runner = createSchedulerRunner(deps as never);
    const result = await runner.runScheduledTask(makeTask(), new Date(), false);

    expect(result.ok).toBe(true);
    expect(publishLifecycle.publishTurnStarted).toHaveBeenCalledWith({
      source: "scheduler",
      runId: "hist-1",
      mode: "work",
      taskId: "task-1",
      schedulerRunId: "hist-1",
    });
    expect(publishLifecycle.publishTurnFinished).toHaveBeenCalledTimes(1);
    expect(publishLifecycle.publishTurnFinished).toHaveBeenCalledWith({
      source: "scheduler",
      runId: "hist-1",
      mode: "work",
      taskId: "task-1",
      schedulerRunId: "hist-1",
      status: "success",
      durationMs: 1000,
    });
    expect(publishLifecycle.publishSchedulerFinished).toHaveBeenCalledWith({
      taskId: "task-1",
      schedulerRunId: "hist-1",
      status: "success",
      durationMs: 1000,
    });
    // 调度执行没有桌面会话，事件负载中不得出现 conversationId
    const startedPayload = publishLifecycle.publishTurnStarted.mock.calls[0][0] as Record<string, unknown>;
    expect("conversationId" in startedPayload).toBe(false);
  });

  it("任务冻结的 mode 传入轮次事件", async () => {
    const publishLifecycle = {
      publishTurnStarted: vi.fn(),
      publishTurnFinished: vi.fn(),
      publishSchedulerFinished: vi.fn(),
    };
    const deps = makeRunnerDeps({ publishLifecycle });
    const runner = createSchedulerRunner(deps as never);
    await runner.runScheduledTask(makeTask({ mode: "chat" }), new Date(), false);

    const startedPayload = publishLifecycle.publishTurnStarted.mock.calls[0][0] as { mode: string };
    expect(startedPayload.mode).toBe("chat");
    const finishedPayload = publishLifecycle.publishTurnFinished.mock.calls[0][0] as { mode: string };
    expect(finishedPayload.mode).toBe("chat");
  });

  it("agent 终态为 timeout 时轮次结束事件携带 timeout 而非 success", async () => {
    runnerMocks.agentResult = {
      reply: "部分回复",
      terminal: { status: "timeout" },
    };
    const publishLifecycle = {
      publishTurnStarted: vi.fn(),
      publishTurnFinished: vi.fn(),
      publishSchedulerFinished: vi.fn(),
    };
    const deps = makeRunnerDeps({ publishLifecycle });
    const runner = createSchedulerRunner(deps as never);
    await runner.runScheduledTask(makeTask(), new Date(), false);

    expect(publishLifecycle.publishTurnFinished).toHaveBeenCalledWith(
      expect.objectContaining({ status: "timeout" }),
    );
    expect(publishLifecycle.publishSchedulerFinished).toHaveBeenCalledWith(
      expect.objectContaining({ status: "timeout" }),
    );
  });

  it("执行抛错时发布 runtime_error 终态事件", async () => {
    runnerMocks.agentError = new Error("模型请求失败");
    const publishLifecycle = {
      publishTurnStarted: vi.fn(),
      publishTurnFinished: vi.fn(),
      publishSchedulerFinished: vi.fn(),
    };
    const deps = makeRunnerDeps({ publishLifecycle });
    const runner = createSchedulerRunner(deps as never);
    const result = await runner.runScheduledTask(makeTask(), new Date(), false);

    expect(result.ok).toBe(false);
    expect(publishLifecycle.publishTurnStarted).toHaveBeenCalledTimes(1);
    expect(publishLifecycle.publishTurnFinished).toHaveBeenCalledWith(
      expect.objectContaining({ status: "runtime_error", schedulerRunId: "hist-1" }),
    );
    expect(publishLifecycle.publishSchedulerFinished).toHaveBeenCalledWith(
      expect.objectContaining({ status: "runtime_error" }),
    );
  });

  it("未注入发布器时不发布任何事件也不报错", async () => {
    const deps = makeRunnerDeps();
    const runner = createSchedulerRunner(deps as never);
    const result = await runner.runScheduledTask(makeTask(), new Date(), false);
    expect(result.ok).toBe(true);
  });
});
