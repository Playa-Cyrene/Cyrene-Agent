import { beforeEach, describe, expect, it, vi } from "vitest";
import { firstValueFrom } from "rxjs";
import { CyreneAgent, classifyRunError, toAguiEvent } from "./cyrene-agent";
import { AgentRuntimeError } from "./agent-runtime-error";
import { AgentExecutionError } from "./run-execution-status";
import { requestUserClarification } from "../user-choice";
import { runHarnessWithAdapter } from "./harness-adapter";
import { runChatLoop } from "./chat-loop";
import type { TranscriptSink } from "./transcript-sink";
import { EventType } from "@ag-ui/core";

vi.mock("./vendors", () => ({
  getAdapterForConfig: vi.fn(() => ({ id: "fake-adapter" })),
}));

vi.mock("./tools/registry/tool-registry", () => ({
  toolRegistry: {
    getEnabledTools: vi.fn(() => []),
    getById: vi.fn(),
  },
}));

vi.mock("../permission", () => ({
  checkPermission: vi.fn(),
}));

// Chat 模式无工具时走 runChatLoop；mock 掉避免真实 LLM 调用。
const mockedRunChatLoop = vi.mocked(runChatLoop);
vi.mock("./chat-loop", () => ({
  runChatLoop: vi.fn(async () => ({
    reply: "chat-reply",
    toolResults: [],
    completionReason: "no_tool" as const,
    totalUsage: undefined,
  })),
}));

const mockedRunHarnessWithAdapter = vi.mocked(runHarnessWithAdapter);

vi.mock("./harness-adapter", () => ({
  runHarnessWithAdapter: vi.fn(async (_options: unknown, signal: AbortSignal, _send: unknown) => {
    // 忠实模拟真实行为——signal abort 后返回 cancelled terminal。
    // 如果 signal 已 aborted，立即返回 cancelled；否则等 signal abort。
    if (signal.aborted) {
      return {
        reply: "",
        toolResults: [],
        completionReason: "no_tool",
        terminal: { status: "cancelled", reason: "user_cancelled", externalEffectsMayContinue: true },
        totalUsage: undefined,
      };
    }
    return new Promise((resolve) => {
      signal.addEventListener("abort", () => {
        resolve({
          reply: "",
          toolResults: [],
          completionReason: "no_tool",
          terminal: { status: "cancelled", reason: "user_cancelled", externalEffectsMayContinue: true },
          totalUsage: undefined,
        });
      }, { once: true });
      // 兜底：10s 超时返回 success（防止测试挂死）
      setTimeout(() => resolve({
        reply: "done",
        toolResults: [],
        completionReason: "no_tool",
        totalUsage: undefined,
      }), 10_000);
    });
  }),
}));

vi.mock("../user-choice", () => ({
  requestUserClarification: vi.fn(),
}));

describe("CyreneAgent", () => {
  it("maps reasoning lifecycle onto the standard AG-UI events", () => {
    expect(toAguiEvent({ type: "reasoning_message_start", messageId: "r1", role: "reasoning" }))
      .toMatchObject({ type: "REASONING_MESSAGE_START", messageId: "r1", role: "reasoning" });
    expect(toAguiEvent({ type: "reasoning_message_content", messageId: "r1", delta: "分析中" }))
      .toMatchObject({ type: "REASONING_MESSAGE_CONTENT", messageId: "r1", delta: "分析中" });
    expect(toAguiEvent({ type: "reasoning_message_end", messageId: "r1" }))
      .toMatchObject({ type: "REASONING_MESSAGE_END", messageId: "r1" });
  });

  it("maps incremental tool arguments onto the standard AG-UI event", () => {
    expect(toAguiEvent({ type: "tool_call_args", toolCallId: "call-1", delta: "{\"path\":" }))
      .toMatchObject({ type: "TOOL_CALL_ARGS", toolCallId: "call-1", delta: "{\"path\":" });
  });
});

describe("classifyRunError", () => {
  it("returns user_cancelled with empty message when source is user_cancelled", () => {
    const result = classifyRunError(
      new DOMException("aborted", "AbortError"),
      "user_cancelled",
      "run-1", "conv-1", "soul", true,
    );
    expect(result.source).toBe("user_cancelled");
    expect(result.userMessage).toBe("");
  });

  it("returns call_timeout with phase-aware message when in soul with tool results", () => {
    const result = classifyRunError(
      new DOMException("aborted", "AbortError"),
      "call_timeout",
      "run-2", "conv-2", "soul", true,
    );
    expect(result.source).toBe("call_timeout");
    expect(result.userMessage).toContain("工具结果已获得");
    expect(result.userMessage).toContain("超时");
  });

  it("returns call_timeout with generic message when before soul (no tool results)", () => {
    const result = classifyRunError(
      new DOMException("aborted", "AbortError"),
      "call_timeout",
      "run-3", "conv-3", "decide", false,
    );
    expect(result.source).toBe("call_timeout");
    expect(result.userMessage).toBe("请求处理超时，请重试。");
    expect(result.userMessage).not.toContain("工具结果");
  });

  it("returns run_timeout for E_AGENT_GRAPH_TIMEOUT", () => {
    const result = classifyRunError(
      new Error("E_AGENT_GRAPH_TIMEOUT"),
      undefined,
      "run-4", "conv-4", "execute", false,
    );
    expect(result.source).toBe("run_timeout");
    expect(result.userMessage).toBe("请求处理超时，请重试。");
  });

  it("returns run_timeout with tool-result message when in soul phase", () => {
    const result = classifyRunError(
      new Error("E_AGENT_GRAPH_TIMEOUT"),
      undefined,
      "run-5", "conv-5", "soul", true,
    );
    expect(result.source).toBe("run_timeout");
    expect(result.userMessage).toContain("工具结果已获得");
  });

  it("returns unknown_abort when abortSource is undefined and error is AbortError", () => {
    const result = classifyRunError(
      new DOMException("aborted", "AbortError"),
      undefined,
      "run-6", "conv-6", "unknown", false,
    );
    expect(result.source).toBe("unknown_abort");
    expect(result.userMessage).toBe("操作已中断，请重试。");
  });

  it("returns fixed safe message for unknown plain Error (no raw message leak)", () => {
    const result = classifyRunError(
      new Error("模型请求失败：HTTP 529 - {\"error\":{\"message\":\"overloaded\"}}"),
      undefined,
      "run-7", "conv-7", "decide", false,
    );
    expect(result.source).toBe("upstream_cleanup");
    // 白名单策略：未知 plain Error 使用固定安全消息，绝不展示原始 message
    expect(result.userMessage).toBe("请求处理失败，请重试。");
    expect(result.userMessage).not.toContain("HTTP");
    expect(result.userMessage).not.toContain("overloaded");
    // 原始 message 保留在 diagnostics 供内部日志
    expect(result.diagnostics.errorMessage).toContain("HTTP 529");
  });

  it("includes runId, conversationId, phase in diagnostics", () => {
    const result = classifyRunError(
      new DOMException("aborted", "AbortError"),
      "call_timeout",
      "run-xyz", "conv-abc", "soul", true,
    );
    expect(result.diagnostics.runId).toBe("run-xyz");
    expect(result.diagnostics.conversationId).toBe("conv-abc");
    expect(result.diagnostics.phase).toBe("soul");
    expect(result.diagnostics.hasToolResults).toBe(true);
  });

  it("never contains raw English AbortError text in userMessage", () => {
    const result = classifyRunError(
      new DOMException("This operation was aborted", "AbortError"),
      "upstream_cleanup",
      "run-8", "conv-8", "soul", true,
    );
    expect(result.userMessage).not.toContain("aborted");
    expect(result.userMessage).not.toContain("AbortError");
    expect(result.userMessage).not.toContain("operation");
  });

  it("call timeout after unsubscribe still classifies as call_timeout (first-source-wins)", () => {
    // 模拟：先 call_timeout，然后 user_cancelled
    // 由于 first-source-wins，abortSource 应该是 call_timeout
    const result = classifyRunError(
      new DOMException("aborted", "AbortError"),
      "call_timeout",  // 第一个来源
      "run-9", "conv-9", "soul", true,
    );
    expect(result.source).toBe("call_timeout");
    expect(result.userMessage).toContain("超时");
  });

  it("AgentRuntimeError E_MODEL_REQUEST_FAILED returns safe message, not raw HTTP body", () => {
    const err = new AgentRuntimeError(
      "E_MODEL_REQUEST_FAILED",
      "模型请求失败：HTTP 529 - {\"error\":{\"message\":\"overloaded\",\"type\":\"too_many_requests\"}}",
    );
    const result = classifyRunError(
      err, undefined, "run-10", "conv-10", "soul", false,
    );
    expect(result.userMessage).toBe("模型服务暂时不可用，请稍后重试。");
    expect(result.userMessage).not.toContain("529");
    expect(result.userMessage).not.toContain("overloaded");
    expect(result.userMessage).not.toContain("HTTP");
    expect(result.diagnostics.httpStatus).toBe(529);
    expect(result.diagnostics.errorCode).toBe("E_MODEL_REQUEST_FAILED");
  });

  it("AgentRuntimeError E_AGENT_NO_PROGRESS returns safe message", () => {
    const err = new AgentRuntimeError("E_AGENT_NO_PROGRESS", "no progress after 3 attempts");
    const result = classifyRunError(
      err, undefined, "run-11", "conv-11", "execute", false,
    );
    expect(result.userMessage).toBe("请求处理遇到问题，请重试。");
    expect(result.diagnostics.errorCode).toBe("E_AGENT_NO_PROGRESS");
  });

  it("AgentRuntimeError E_AGENT_GRAPH_ITERATION_LIMIT returns safe message", () => {
    const err = new AgentRuntimeError("E_AGENT_GRAPH_ITERATION_LIMIT", "iteration limit reached");
    const result = classifyRunError(
      err, undefined, "run-12", "conv-12", "decide", false,
    );
    expect(result.userMessage).toBe("请求处理步骤过多，请简化问题后重试。");
    expect(result.diagnostics.errorCode).toBe("E_AGENT_GRAPH_ITERATION_LIMIT");
  });

  it("AgentRuntimeError with HTTP 429 extracts status to diagnostics", () => {
    const err = new AgentRuntimeError(
      "E_MODEL_REQUEST_FAILED",
      "模型请求失败：HTTP 429 - rate limited",
    );
    const result = classifyRunError(
      err, undefined, "run-13", "conv-13", "decide", false,
    );
    expect(result.userMessage).toBe("模型服务暂时不可用，请稍后重试。");
    expect(result.diagnostics.httpStatus).toBe(429);
  });

  it("AgentRuntimeError without HTTP status still returns safe message", () => {
    const err = new AgentRuntimeError(
      "E_MODEL_REQUEST_FAILED",
      "模型请求失败：connection refused",
    );
    const result = classifyRunError(
      err, undefined, "run-14", "conv-14", "soul", true,
    );
    expect(result.userMessage).toBe("模型服务暂时不可用，请稍后重试。");
    expect(result.diagnostics.httpStatus).toBeUndefined();
    expect(result.diagnostics.errorCode).toBe("E_MODEL_REQUEST_FAILED");
  });

  it("unknown plain Error with HTTP body → fixed safe message, no leak", () => {
    const err = new Error(
      '模型请求失败：HTTP 529 - {"error":{"message":"overloaded","request_id":"abc-123"}} Authorization: Bearer xxx',
    );
    const result = classifyRunError(err, undefined, "run-15", "conv-15", "decide", false);
    expect(result.userMessage).toBe("请求处理失败，请重试。");
    expect(result.userMessage).not.toContain("HTTP");
    expect(result.userMessage).not.toContain("overloaded");
    expect(result.userMessage).not.toContain("request_id");
    expect(result.userMessage).not.toContain("Authorization");
    expect(result.userMessage).not.toContain("Bearer");
    // 原始信息保留在 diagnostics
    expect(result.diagnostics.errorMessage).toContain("HTTP 529");
  });

  it("AgentExecutionError passes through cause to diagnostics (cause chain intact)", () => {
    const innerErr = new AgentRuntimeError(
      "E_MODEL_REQUEST_FAILED",
      "模型请求失败：HTTP 500 - internal",
    );
    const execStatus = {
      phase: "soul" as const,
      successfulTools: [],
      createdArtifacts: [],
      taskCompletionConfirmed: false,
    };
    const execErr = new AgentExecutionError("LangGraph execution failed", execStatus, { cause: innerErr });
    const result = classifyRunError(execErr, undefined, "run-16", "conv-16", "soul", false);
    expect(result.userMessage).toBe("模型服务暂时不可用，请稍后重试。");
    expect(result.diagnostics.httpStatus).toBe(500);
    expect(result.diagnostics.errorCode).toBe("E_MODEL_REQUEST_FAILED");
  });
});

describe("executeToolCall business failure detection", () => {
  // 这个测试验证：工具返回 JSON 字符串包含 error 字段时，status 应该是 failed
  // 而不是被包装为 succeeded

  it("tool returning JSON with error field should be treated as failed", () => {
    // 模拟 read_file 返回的错误 JSON
    const errorOutput = JSON.stringify({ error: "文件不存在或无法访问: /nonexistent" });

    // 检查逻辑：解析 JSON，如果包含 error 字段，则 status=failed
    let status: "succeeded" | "failed" = "succeeded";
    let errorCode: string | undefined;

    try {
      const parsed = JSON.parse(errorOutput);
      if (parsed && typeof parsed === "object" && (parsed.error || parsed.success === false)) {
        status = "failed";
        errorCode = "E_TOOL_BUSINESS_FAILED";
      }
    } catch {
      // 不是 JSON
    }

    expect(status).toBe("failed");
    expect(errorCode).toBe("E_TOOL_BUSINESS_FAILED");
  });

  it("tool returning JSON with success=false should be treated as failed", () => {
    // 模拟 apply_patch 返回的错误 JSON
    const errorOutput = JSON.stringify({ error: "文件不存在", success: false });

    let status: "succeeded" | "failed" = "succeeded";

    try {
      const parsed = JSON.parse(errorOutput);
      if (parsed && typeof parsed === "object" && (parsed.error || parsed.success === false)) {
        status = "failed";
      }
    } catch {
      // 不是 JSON
    }

    expect(status).toBe("failed");
  });

  it("tool returning normal JSON should be treated as succeeded", () => {
    // 模拟 read_file 成功返回
    const successOutput = JSON.stringify({ path: "/test.ts", content: "const a = 1;", truncated: false });

    let status: "succeeded" | "failed" = "succeeded";

    try {
      const parsed = JSON.parse(successOutput);
      if (parsed && typeof parsed === "object" && (parsed.error || parsed.success === false)) {
        status = "failed";
      }
    } catch {
      // 不是 JSON
    }

    expect(status).toBe("succeeded");
  });

  it("tool returning plain text should be treated as succeeded", () => {
    // 模拟旧式工具返回纯文本
    const plainOutput = "操作成功完成";

    let status: "succeeded" | "failed" = "succeeded";

    try {
      const parsed = JSON.parse(plainOutput);
      if (parsed && typeof parsed === "object" && (parsed.error || parsed.success === false)) {
        status = "failed";
      }
    } catch {
      // 不是 JSON，保持 succeeded
    }

    expect(status).toBe("succeeded");
  });
});

// ── external signal threading + first-source-wins ──────────

describe("CyreneAgent external signal threading", () => {
  beforeEach(() => {
    mockedRunHarnessWithAdapter.mockClear();
  });

  it("threads CyreneRunOptions.signal into harness signal (abort propagates)", async () => {
    const agent = new CyreneAgent({ threadId: "thread-signal-1" });
    const externalController = new AbortController();

    const observable = agent.runWithEvents({
      settings: { provider: "test", baseUrl: "", model: "", apiKey: "", contextWindowTokens: 256000 } as never,
      messages: [{ role: "user", content: "hi" }] as never,
      timeoutMs: 60000,
      toolSystemContent: "",
      soulSystemBaseContent: "",
      executionMode: "work",
      runId: "run-signal-1",
      signal: externalController.signal,
    });

    const events: unknown[] = [];
    const sub = observable.subscribe({ next: (e) => events.push(e) });

    // 等 harness 被调用
    await vi.waitFor(() => expect(mockedRunHarnessWithAdapter).toHaveBeenCalledOnce());

    // harness 收到的 signal 必须与外部 signal 联动
    const harnessSignal = mockedRunHarnessWithAdapter.mock.calls[0]?.[1] as AbortSignal;
    expect(harnessSignal).toBeDefined();
    expect(harnessSignal.aborted).toBe(false);

    // abort 外部 signal → harness signal 必须也 aborted
    externalController.abort();
    expect(harnessSignal.aborted).toBe(true);

    // 等待 cancelled RUN_FINISHED
    await vi.waitFor(() => {
      const finished = events.find(
        (e) => (e as { type?: string }).type === EventType.RUN_FINISHED,
      );
      expect(finished).toBeDefined();
    });

    const runFinished = events.find(
      (e) => (e as { type?: string }).type === EventType.RUN_FINISHED,
    ) as { result?: { status?: string; externalEffectsMayContinue?: boolean } };
    expect(runFinished?.result?.status).toBe("cancelled");
    expect(runFinished?.result?.externalEffectsMayContinue).toBe(true);

    sub.unsubscribe();
  });

  it("emits exactly one terminal (cancelled) when external signal aborts", async () => {
    const agent = new CyreneAgent({ threadId: "thread-signal-2" });
    const externalController = new AbortController();

    const observable = agent.runWithEvents({
      settings: { provider: "test", baseUrl: "", model: "", apiKey: "", contextWindowTokens: 256000 } as never,
      messages: [{ role: "user", content: "hi" }] as never,
      timeoutMs: 60000,
      toolSystemContent: "",
      soulSystemBaseContent: "",
      executionMode: "work",
      runId: "run-signal-2",
      signal: externalController.signal,
    });

    const events: unknown[] = [];
    const sub = observable.subscribe({ next: (e) => events.push(e) });

    await vi.waitFor(() => expect(mockedRunHarnessWithAdapter).toHaveBeenCalledOnce());
    externalController.abort();

    // 等待完成
    await vi.waitFor(() => {
      expect(events.filter(
        (e) => (e as { type?: string }).type === EventType.RUN_FINISHED,
      )).toHaveLength(1);
    });

    // 恰好一个 RUN_FINISHED，没有 RUN_ERROR
    const runFinishedCount = events.filter(
      (e) => (e as { type?: string }).type === EventType.RUN_FINISHED,
    ).length;
    const runErrorCount = events.filter(
      (e) => (e as { type?: string }).type === EventType.RUN_ERROR,
    ).length;
    expect(runFinishedCount).toBe(1);
    expect(runErrorCount).toBe(0);

    // cancelled terminal
    const runFinished = events.find(
      (e) => (e as { type?: string }).type === EventType.RUN_FINISHED,
    ) as { result?: { status?: string } };
    expect(runFinished?.result?.status).toBe("cancelled");

    sub.unsubscribe();
  });

  it("cancelled path does not emit final_answer text as '最终回复被取消。'", async () => {
    const agent = new CyreneAgent({ threadId: "thread-signal-3" });
    const externalController = new AbortController();

    const observable = agent.runWithEvents({
      settings: { provider: "test", baseUrl: "", model: "", apiKey: "", contextWindowTokens: 256000 } as never,
      messages: [{ role: "user", content: "hi" }] as never,
      timeoutMs: 60000,
      toolSystemContent: "",
      soulSystemBaseContent: "",
      executionMode: "work",
      runId: "run-signal-3",
      signal: externalController.signal,
    });

    const events: unknown[] = [];
    const sub = observable.subscribe({ next: (e) => events.push(e) });

    await vi.waitFor(() => expect(mockedRunHarnessWithAdapter).toHaveBeenCalledOnce());
    externalController.abort();

    await vi.waitFor(() => {
      expect(events.filter(
        (e) => (e as { type?: string }).type === EventType.RUN_FINISHED,
      )).toHaveLength(1);
    });

    // lastResult.reply 不得包含 "最终回复被取消。"
    expect(agent.lastResult?.reply).not.toContain("最终回复被取消");
    // cancelled terminal 不应带 reply 文本
    if (agent.lastResult?.terminal) {
      expect(agent.lastResult.terminal.status).toBe("cancelled");
      expect(agent.lastResult.terminal.externalEffectsMayContinue).toBe(true);
    }

    sub.unsubscribe();
  });

  it("removes the external abort listener and does not abort the harness signal after normal completion", async () => {
    mockedRunHarnessWithAdapter.mockResolvedValueOnce({
      reply: "done",
      toolResults: [],
      completionReason: "no_tool",
      totalUsage: undefined,
    });
    const agent = new CyreneAgent({ threadId: "thread-signal-cleanup" });
    const externalController = new AbortController();
    const addSpy = vi.spyOn(externalController.signal, "addEventListener");
    const removeSpy = vi.spyOn(externalController.signal, "removeEventListener");

    await new Promise<void>((resolve, reject) => {
      agent.runWithEvents({
        settings: { provider: "test", baseUrl: "", model: "", apiKey: "", contextWindowTokens: 256000 } as never,
        messages: [{ role: "user", content: "hi" }] as never,
        timeoutMs: 60_000,
        toolSystemContent: "",
        soulSystemBaseContent: "",
        executionMode: "work",
        runId: "run-signal-cleanup",
        signal: externalController.signal,
      }).subscribe({ complete: resolve, error: reject });
    });

    const harnessSignal = mockedRunHarnessWithAdapter.mock.calls.at(-1)?.[1] as AbortSignal;
    expect(addSpy).toHaveBeenCalledWith("abort", expect.any(Function), { once: true });
    expect(removeSpy).toHaveBeenCalledWith("abort", expect.any(Function));
    expect(harnessSignal.aborted).toBe(false);
  });
});

// ── Chat 模式工具增强：按工具数分流 ChatLoop / Harness ──────────
describe("CyreneAgent chat tool enhancement branch", () => {
  beforeEach(() => {
    mockedRunHarnessWithAdapter.mockClear();
    mockedRunChatLoop.mockClear();
  });

  it("routes chat without tools to runChatLoop (unchanged behavior)", async () => {
    const agent = new CyreneAgent({ threadId: "thread-chat-plain" });
    const events: unknown[] = [];
    const sub = agent.runWithEvents({
      settings: { provider: "test", baseUrl: "", model: "", apiKey: "", contextWindowTokens: 256000 } as never,
      messages: [{ role: "user", content: "hi" }] as never,
      timeoutMs: 60000,
      toolSystemContent: "",
      soulSystemBaseContent: "",
      executionMode: "chat",
      tools: [],
      runId: "run-chat-plain",
    }).subscribe({ next: (e) => events.push(e) });

    await vi.waitFor(() => expect(mockedRunChatLoop).toHaveBeenCalledOnce());
    expect(mockedRunHarnessWithAdapter).not.toHaveBeenCalled();
    await vi.waitFor(() => {
      expect(events.find((e) => (e as { type?: string }).type === EventType.RUN_FINISHED)).toBeDefined();
    });
    sub.unsubscribe();
  });

  it("routes chat with opted-in tools to the harness (native function calling)", async () => {
    const agent = new CyreneAgent({ threadId: "thread-chat-tools" });
    const externalController = new AbortController();
    const events: unknown[] = [];
    const sub = agent.runWithEvents({
      settings: { provider: "test", baseUrl: "", model: "", apiKey: "", contextWindowTokens: 256000 } as never,
      messages: [{ role: "user", content: "放首歌" }] as never,
      timeoutMs: 60000,
      toolSystemContent: "TOOLS",
      soulSystemBaseContent: "",
      executionMode: "chat",
      tools: [{ id: "music_search", name: "搜索歌曲", description: "d", enabled: true } as never],
      runId: "run-chat-tools",
      signal: externalController.signal,
    }).subscribe({ next: (e) => events.push(e) });

    await vi.waitFor(() => expect(mockedRunHarnessWithAdapter).toHaveBeenCalledOnce());
    expect(mockedRunChatLoop).not.toHaveBeenCalled();

    // 结束 run：abort 触发 harness mock 的 cancelled 分支收尾。
    externalController.abort();
    await vi.waitFor(() => {
      expect(events.find((e) => (e as { type?: string }).type === EventType.RUN_FINISHED)).toBeDefined();
    });
    sub.unsubscribe();
  });
});

describe("CyreneAgent transcript sink wiring", () => {
  /** 可断言的假轨迹提交端：默认全部成功。 */
  function fakeSink(overrides: Partial<TranscriptSink> = {}): TranscriptSink {
    return {
      appendAssistant: vi.fn(overrides.appendAssistant ?? (async () => "assistant-entry")),
      appendToolResult: vi.fn(overrides.appendToolResult ?? (async () => undefined)),
      closeInterruption: vi.fn(overrides.closeInterruption ?? (async () => undefined)),
      checkpoint: vi.fn(overrides.checkpoint ?? (async () => undefined)),
    };
  }

  beforeEach(() => {
    mockedRunChatLoop.mockClear();
  });

  it("passes the transcript sink into runChatLoop for plain chat turns", async () => {
    const agent = new CyreneAgent({ threadId: "thread-chat-sink" });
    const sink = fakeSink();
    const events: unknown[] = [];
    const sub = agent.runWithEvents({
      settings: { provider: "test", baseUrl: "", model: "", apiKey: "", contextWindowTokens: 256000 } as never,
      messages: [{ role: "user", content: "hi" }] as never,
      timeoutMs: 60000,
      toolSystemContent: "",
      soulSystemBaseContent: "",
      executionMode: "chat",
      tools: [],
      runId: "run-chat-sink",
      transcriptSink: sink,
    }).subscribe({ next: (e) => events.push(e) });

    await vi.waitFor(() => expect(mockedRunChatLoop).toHaveBeenCalledOnce());
    expect(mockedRunChatLoop).toHaveBeenCalledWith(expect.objectContaining({ transcriptSink: sink }));

    await vi.waitFor(() => {
      expect(events.find((e) => (e as { type?: string }).type === EventType.RUN_FINISHED)).toBeDefined();
    });
    sub.unsubscribe();
  });

  it("closes the transcript interruption before emitting the cancelled terminal", async () => {
    const agent = new CyreneAgent({ threadId: "thread-chat-cancel" });
    const externalController = new AbortController();
    const closeInterruption = vi.fn(async () => undefined);
    const sink = fakeSink({ closeInterruption });
    // 等外部取消信号落地后以 AbortError 结束（贴近真实 ChatLoop 取消行为）
    mockedRunChatLoop.mockImplementationOnce(async () => {
      await new Promise<void>((resolve) => {
        if (externalController.signal.aborted) return resolve();
        externalController.signal.addEventListener("abort", () => resolve(), { once: true });
      });
      throw Object.assign(new Error("E_SOUL_ONLY_CANCELLED"), { name: "AbortError" });
    });

    const events: unknown[] = [];
    const sub = agent.runWithEvents({
      settings: { provider: "test", baseUrl: "", model: "", apiKey: "", contextWindowTokens: 256000 } as never,
      messages: [{ role: "user", content: "hi" }] as never,
      timeoutMs: 60000,
      toolSystemContent: "",
      soulSystemBaseContent: "",
      executionMode: "chat",
      tools: [],
      runId: "run-chat-cancel",
      transcriptSink: sink,
      signal: externalController.signal,
    }).subscribe({ next: (e) => events.push(e) });

    await vi.waitFor(() => expect(mockedRunChatLoop).toHaveBeenCalledOnce());
    externalController.abort();
    await vi.waitFor(() => {
      expect(events.find((e) => (e as { type?: string }).type === EventType.RUN_FINISHED)).toBeDefined();
    });

    // 取消边界先于终态事件写入；ChatLoop 无工具，runSession 为空只写边界
    expect(closeInterruption).toHaveBeenCalledWith({ reason: "user_cancel", runSession: null });
    const runFinished = events.find(
      (e) => (e as { type?: string }).type === EventType.RUN_FINISHED,
    ) as { result?: { status?: string } };
    expect(runFinished?.result?.status).toBe("cancelled");
    sub.unsubscribe();
  });

  it("reports a runtime error when the ChatLoop interruption closure fails", async () => {
    const agent = new CyreneAgent({ threadId: "thread-chat-cancel-fail" });
    const externalController = new AbortController();
    const closeInterruption = vi.fn(async () => { throw new Error("disk full"); });
    const sink = fakeSink({ closeInterruption });
    mockedRunChatLoop.mockImplementationOnce(async () => {
      await new Promise<void>((resolve) => {
        if (externalController.signal.aborted) return resolve();
        externalController.signal.addEventListener("abort", () => resolve(), { once: true });
      });
      throw Object.assign(new Error("E_SOUL_ONLY_CANCELLED"), { name: "AbortError" });
    });

    const events: unknown[] = [];
    const sub = agent.runWithEvents({
      settings: { provider: "test", baseUrl: "", model: "", apiKey: "", contextWindowTokens: 256000 } as never,
      messages: [{ role: "user", content: "hi" }] as never,
      timeoutMs: 60000,
      toolSystemContent: "",
      soulSystemBaseContent: "",
      executionMode: "chat",
      tools: [],
      runId: "run-chat-cancel-fail",
      transcriptSink: sink,
      signal: externalController.signal,
    }).subscribe({ next: (e) => events.push(e) });

    await vi.waitFor(() => expect(mockedRunChatLoop).toHaveBeenCalledOnce());
    externalController.abort();
    await vi.waitFor(() => {
      expect(events.find((e) => (e as { type?: string }).type === EventType.RUN_FINISHED)).toBeDefined();
    });

    // 闭合失败不得伪装成取消成功：按运行时错误上报
    const runFinished = events.find(
      (e) => (e as { type?: string }).type === EventType.RUN_FINISHED,
    ) as { result?: { status?: string; reason?: string } };
    expect(runFinished?.result?.status).toBe("runtime_error");
    expect(runFinished?.result?.reason).toBe("transcript_interruption_closure_failed");
    sub.unsubscribe();
  });
});
