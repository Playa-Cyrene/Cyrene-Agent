import { beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { applyScheduledExecutionPolicy, createSchedulerRunner } from "./scheduler-runner";
import type { ScheduledTask } from "./types";
import { ConversationTranscriptStore } from "../orchestrator/conversation-transcript-store";
import { ConversationJournalService } from "../orchestrator/conversation-journal-service";

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

    runWithEvents(options: any) {
      // 异步派发终态，避免订阅者解引用尚未完成赋值的 sub（TDZ）
      return {
        subscribe: ({ next, complete, error }: { next?: (event: any) => void; complete: () => void; error: (err: Error) => void }) => {
          queueMicrotask(() => {
            if (runnerMocks.agentError) {
              error(runnerMocks.agentError);
              return;
            }
            const sink = options.transcriptSink;
            if (!sink) {
              next?.({ type: "RUN_FINISHED", runId: "hist-1", result: { status: "success" } });
              complete();
              return;
            }
            next?.({ type: "TOOL_CALL_START", runId: "hist-1", toolCallId: "tool-1", toolCallName: "disk_usage", result: { status: "success" } });
            void sink.appendAssistant({
              message: { role: "assistant", content: "调度回复", toolCalls: [{ id: "tool-1", name: "disk_usage", arguments: "{}" }] },
            }).then((assistantEntryId) => sink.appendToolResult({
              assistantEntryId,
              message: { role: "tool", toolCallId: "tool-1", content: "C: 80%" },
              outcome: "success",
            })).then(() => {
              next?.({ type: "TOOL_CALL_RESULT", runId: "hist-1", toolCallId: "tool-1", content: "C: 80%", status: "success" });
              next?.({ type: "RUN_FINISHED", runId: "hist-1", result: { status: "success" } });
              complete();
            }, error);
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
      getLastAssistantEntryId: vi.fn(() => "assistant-entry"),
    };
    const journal = {
      appendUser: vi.fn(async () => undefined),
      createRunSink: vi.fn(() => sink),
      appendPresentationNext: vi.fn(async () => undefined),
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
    expect(journal.createRunSink).toHaveBeenCalledWith({ conversationId: "session-1", runId: "hist-1", assistantTurnId: "scheduler-reply-hist-1" });
    expect(sink.checkpoint).not.toHaveBeenCalled();
    expect(journal.appendPresentationNext).toHaveBeenCalledWith(
      "session-1",
      "scheduler-reply-hist-1",
      expect.stringContaining("scheduler:hist-1:reply"),
      expect.objectContaining({ content: "调度回复" }),
    );
    expect(send).toHaveBeenCalledWith("scheduler:event", expect.objectContaining({ conversationId: "session-1" }));
    expect(publishLifecycle.publishTurnStarted).toHaveBeenCalledWith(expect.objectContaining({ conversationId: "session-1" }));
    expect(publishLifecycle.publishTurnFinished).toHaveBeenCalledWith(expect.objectContaining({ conversationId: "session-1" }));
  });

  it("real journal reload preserves stable notice/reply IDs and tool presentation", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "cta-scheduler-reload-"));
    try {
      const journal = new ConversationJournalService(new ConversationTranscriptStore(root, { now: () => 1_000 }));
      const deps = makeRunnerDeps({
        conversationJournal: journal,
        getActiveConversation: () => ({ sessionId: "session-reload", mode: "work" }),
      });
      const result = await createSchedulerRunner(deps as never).runScheduledTask(makeTask(), new Date(), false);
      expect(result.ok).toBe(true);
      const projection = await journal.readProjection("session-reload");
      expect(projection.messages).toEqual(expect.arrayContaining([
        expect.objectContaining({ id: "scheduler-notice-hist-1", role: "user", content: "定时任务「每日整理」已触发" }),
        expect.objectContaining({
          id: "scheduler-reply-hist-1",
          content: "调度回复",
          toolExecutions: [expect.objectContaining({ id: "tool-1", status: "success", result: "C: 80%" })],
        }),
      ]));
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("closes the journal when scheduler presentation checkpoint fails", async () => {
    const sink = {
      checkpoint: vi.fn(async () => { throw new Error("journal unavailable"); }),
      appendAssistant: vi.fn(async () => "assistant-entry"),
      appendToolResult: vi.fn(async () => undefined),
      closeInterruption: vi.fn(async () => undefined),
      getLastAssistantEntryId: vi.fn(() => "assistant-entry"),
    };
    const journal = {
      appendUser: vi.fn(async () => undefined),
      createRunSink: vi.fn(() => sink),
      appendPresentationNext: vi.fn(async () => { throw new Error("presentation refresh failed"); }),
    };
    const deps = makeRunnerDeps({
      conversationJournal: journal,
      getActiveConversation: () => ({ sessionId: "session-1", mode: "work" }),
    });

    const runner = createSchedulerRunner(deps as never);
    const result = await runner.runScheduledTask(makeTask(), new Date(), false);

    expect(result.ok).toBe(false);
    expect(journal.appendPresentationNext).toHaveBeenCalledTimes(2);
    expect(sink.closeInterruption).not.toHaveBeenCalled();
  });

  it("retries a refresh failure with the exact presentation mutation", async () => {
    const sink = {
      appendAssistant: vi.fn(async () => "assistant-entry"),
      appendToolResult: vi.fn(async () => undefined),
      closeInterruption: vi.fn(async () => undefined),
      getLastAssistantEntryId: vi.fn(() => "assistant-entry"),
    };
    const appendPresentationNext = vi.fn()
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error("projection refresh failed"))
      .mockResolvedValueOnce(undefined);
    const journal = {
      appendUser: vi.fn(async () => undefined),
      createRunSink: vi.fn(() => sink),
      appendPresentationNext,
    };
    const deps = makeRunnerDeps({
      conversationJournal: journal,
      getActiveConversation: () => ({ sessionId: "session-1", mode: "work" }),
    });

    const result = await createSchedulerRunner(deps as never).runScheduledTask(makeTask(), new Date(), false);

    expect(result.ok).toBe(true);
    expect(appendPresentationNext).toHaveBeenCalledTimes(3);
    expect(appendPresentationNext.mock.calls[1]).toEqual(appendPresentationNext.mock.calls[2]);
  });

  it("成功执行发布 started/finished/scheduler:finished 且不伪造 conversationId", async () => {
    const publishLifecycle = {
      publishTurnStarted: vi.fn(),
      publishTurnFinished: vi.fn(),
      publishSchedulerFinished: vi.fn(),
    };
    const send = vi.fn();
    const deps = makeRunnerDeps({ publishLifecycle, getChatWebContents: () => ({ isDestroyed: () => false, send } as never) });
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
    const send = vi.fn();
    const deps = makeRunnerDeps({ publishLifecycle, getChatWebContents: () => ({ isDestroyed: () => false, send } as never) });
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
    const send = vi.fn();
    const deps = makeRunnerDeps({ publishLifecycle, getChatWebContents: () => ({ isDestroyed: () => false, send } as never) });
    const runner = createSchedulerRunner(deps as never);
    const result = await runner.runScheduledTask(makeTask(), new Date(), false);

    expect(result.ok).toBe(false);
    const events = (publishLifecycle.publishTurnFinished.mock.invocationCallOrder as number[]);
    expect(events.length).toBe(1);

    expect(publishLifecycle.publishTurnFinished).toHaveBeenCalledWith(
      expect.objectContaining({ status: "timeout" }),
    );
    expect(publishLifecycle.publishSchedulerFinished).toHaveBeenCalledWith(
      expect.objectContaining({ status: "timeout" }),
    );
    const terminalEvents = send.mock.calls.map((call) => call[1] as Record<string, unknown>);
    expect(terminalEvents.filter((event) => event.type === "RUN_FINISHED")).toHaveLength(0);
    expect(terminalEvents.filter((event) => event.type === "RUN_ERROR")).toHaveLength(1);
    expect(terminalEvents.find((event) => event.type === "RUN_ERROR")).toMatchObject({ status: "timeout", reason: "timeout" });
  });

  it("tool-only runs persist and stream the same deterministic display reply", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "cta-scheduler-tool-only-"));
    try {
      runnerMocks.agentResult = { reply: "", terminal: undefined };
      const journal = new ConversationJournalService(new ConversationTranscriptStore(root, { now: () => 1_000 }));
      const send = vi.fn();
      const deps = makeRunnerDeps({
        conversationJournal: journal,
        getActiveConversation: () => ({ sessionId: "session-tool-only", mode: "work" }),
        getChatWebContents: () => ({ isDestroyed: () => false, send } as never),
      });
      const result = await createSchedulerRunner(deps as never).runScheduledTask(makeTask(), new Date(), false);
      expect(result).toMatchObject({ ok: true, reply: "disk_usage：完成" });
      const projection = await journal.readProjection("session-tool-only");
      expect(projection.messages).toEqual(expect.arrayContaining([
        expect.objectContaining({ id: "scheduler-reply-hist-1", content: "disk_usage：完成", toolExecutions: [expect.objectContaining({ id: "tool-1" })] }),
      ]));
      const reloaded = projection.messages.find((message) => message.id === "scheduler-reply-hist-1");
      const live = send.mock.calls
        .map((call) => call[1] as Record<string, unknown>)
        .find((event) => event.type === "RUN_FINISHED");
      expect(live).toMatchObject({ type: "RUN_FINISHED", content: "disk_usage：完成", messageId: "scheduler-reply-hist-1" });
      expect({
        id: live?.messageId,
        content: live?.content,
        toolExecutions: live?.toolExecutions,
        runSnapshot: live?.runSnapshot,
      }).toEqual({
        id: reloaded?.id,
        content: reloaded?.content,
        toolExecutions: reloaded?.toolExecutions,
        runSnapshot: reloaded?.runSnapshot,
      });
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("history failure leaves the stream open for one RUN_ERROR and never sends RUN_FINISHED", async () => {
    const send = vi.fn();
    let historyCalls = 0;
    const deps = makeRunnerDeps({
      getChatWebContents: () => ({ isDestroyed: () => false, send } as never),
      recordHistory: vi.fn(() => {
        historyCalls += 1;
        if (historyCalls > 1) throw new Error("history unavailable");
      }),
    });
    const result = await createSchedulerRunner(deps as never).runScheduledTask(makeTask(), new Date(), false);
    expect(result.ok).toBe(false);
    const events = send.mock.calls.map((call) => call[1] as Record<string, unknown>);
    expect(events.filter((event) => event.type === "RUN_FINISHED")).toHaveLength(0);
    expect(events.filter((event) => event.type === "RUN_ERROR")).toHaveLength(1);
    expect(events.find((event) => event.type === "RUN_ERROR")).toMatchObject({ reason: "runtime_error" });
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
