import { describe, expect, it, vi } from "vitest";
import { ExecutionLedger } from "../execution-ledger";
import { ToolExecutionError } from "../tools/registry/tool-execution-error";
import type { ToolDefinition } from "../tools/registry/tool-registry";
import type { AgentState } from "./types";
import { dispatchToolCall, DEFAULT_TRUNCATION, truncateOutput } from "./tool-dispatcher";
import { resolveUncertainEffect } from "./uncertain-effect-guard";
import type { ToolOutputStore } from "./tool-output/tool-output-store";
import { ToolOutputPersistenceError } from "./tool-output/file-tool-output-store";

function state(): AgentState {
  return { todoItems: [], uncertainEffects: [] };
}

function tool(
  execute: ToolDefinition["execute"],
  effectKind: ToolDefinition["effectKind"] = "read",
): ToolDefinition {
  return {
    id: "send_email",
    name: "Send Email",
    description: "send",
    enabled: true,
    inputSchema: { type: "object", properties: {} },
    effectKind,
    execute,
  };
}

function call(id: string, args: Record<string, unknown> = { to: "a@example.com" }) {
  return { id, name: "send_email", arguments: JSON.stringify(args) };
}

describe("dispatchToolCall truthful execution", () => {
  it("binds shell output to the invocation ID without changing the tool result", async () => {
    const events: Array<{ type: string; toolCallId?: string; text?: string }> = [];
    const shellTool = {
      ...tool(async (_args, context) => {
        context?.onShellOutput?.({ action: "append", text: "ready" });
        return "done";
      }),
      id: "run_shell",
      name: "执行命令",
    };
    const result = await dispatchToolCall(
      { id: "shell-7", name: "run_shell", arguments: '{"command":"echo ready"}' },
      {
        state: state(),
        tools: [shellTool],
        toolContext: { userQuery: "", runId: "run-1" },
        onEvent: (event) => events.push(event),
      },
    );
    expect(events).toContainEqual(expect.objectContaining({
      type: "tool_output", toolCallId: "shell-7", action: "append", text: "ready",
    }));
    expect(result.output).toBe("done");
  });

  it("preserves both the head and tail when pruning output above 30000 characters", () => {
    const output = [
      "HEAD_MARKER",
      "a".repeat(31_000),
      "TAIL_MARKER",
    ].join("\n");

    const result = truncateOutput(output, DEFAULT_TRUNCATION, "call-1");

    expect(result.truncated).toBe(true);
    expect(result.preview).toContain("HEAD_MARKER");
    expect(result.preview).toContain("[... tool result middle pruned ...]");
    expect(result.preview).toContain("TAIL_MARKER");
    // 预览预算 = 头 12K + 尾 8K + 剪枝标记
    expect(result.preview.length).toBeLessThanOrEqual(12_000 + 8_000 + 100);
  });

  it("returns medium output (between 8K and 30K) untruncated", () => {
    const output = "b".repeat(20_000);
    const result = truncateOutput(output, DEFAULT_TRUNCATION, "call-1");
    expect(result.truncated).toBe(false);
    expect(result.preview).toBe(output);
  });

  it("preserves typed error facts in the failure observation", async () => {
    const result = await dispatchToolCall(call("call-1"), {
      state: state(),
      tools: [tool(vi.fn(async () => {
        throw new ToolExecutionError("E_TIMEOUT", "unknown", "timeout", false, "unknown");
      }))],
      toolContext: { userQuery: "", runId: "run-1" },
    });

    expect(result).toMatchObject({ outcome: "failure", category: "timeout" });
    expect(result.rawResult).toMatchObject({
      status: "failed",
      errorCode: "E_TIMEOUT",
      category: "timeout",
      effectState: "unknown",
    });
  });

  it("rethrows AbortError", async () => {
    const error = new Error("cancelled");
    error.name = "AbortError";
    await expect(dispatchToolCall(call("call-1"), {
      state: state(),
      tools: [tool(vi.fn(async () => { throw error; }))],
    })).rejects.toMatchObject({ name: "AbortError" });
  });

  it("replays only the same logical invocation", async () => {
    const execute = vi.fn(async () => "sent");
    const ledger = new ExecutionLedger();
    const current = state();
    const context = {
      state: current,
      tools: [tool(execute, "external_side_effect")],
      toolContext: { userQuery: "", runId: "run-1" },
      executionLedger: ledger,
    };

    const first = await dispatchToolCall(call("call-123"), context);
    const replay = await dispatchToolCall(call("call-123"), context);
    const newIntent = await dispatchToolCall(call("call-456"), context);

    expect(first.rawResult?.deduplicated).not.toBe(true);
    expect(replay.rawResult?.deduplicated).toBe(true);
    expect(newIntent.rawResult?.deduplicated).not.toBe(true);
    expect(execute).toHaveBeenCalledTimes(2);
  });

  it("separately guards an unresolved non-idempotent unknown effect", async () => {
    const execute = vi.fn()
      .mockRejectedValueOnce(new ToolExecutionError("E_TIMEOUT", "unknown", "timeout", false, "unknown"))
      .mockResolvedValueOnce("sent after approval");
    const current = state();
    const context = {
      state: current,
      tools: [tool(execute, "external_side_effect")],
      toolContext: { userQuery: "", runId: "run-1" },
      executionLedger: new ExecutionLedger(),
    };

    const unknown = await dispatchToolCall(call("call-old"), context);
    expect(unknown.outcome).toBe("unknown");
    expect(current.uncertainEffects).toHaveLength(1);

    const blocked = await dispatchToolCall(call("call-new"), context);
    expect(blocked).toMatchObject({ outcome: "not_executed", category: "runtime_safety" });
    expect(blocked.message).toContain(current.uncertainEffects[0].id);
    expect(execute).toHaveBeenCalledTimes(1);

    resolveUncertainEffect(current, current.uncertainEffects[0].toolCallId);
    const allowed = await dispatchToolCall(call("call-approved"), context);
    expect(allowed.outcome).toBe("success");
    expect(current.uncertainEffects).toHaveLength(0);
    expect(execute).toHaveBeenCalledTimes(2);
  });

  it("does not guard a different request fingerprint", async () => {
    const execute = vi.fn()
      .mockRejectedValueOnce(new ToolExecutionError("E_TIMEOUT", "unknown", "timeout", false, "unknown"))
      .mockResolvedValueOnce("sent elsewhere");
    const current = state();
    const context = {
      state: current,
      tools: [tool(execute, "external_side_effect")],
      toolContext: { userQuery: "", runId: "run-1" },
    };
    await dispatchToolCall(call("call-old"), context);
    const result = await dispatchToolCall(call("call-new", { to: "b@example.com" }), context);
    expect(result.outcome).toBe("success");
  });

  it("persists the complete normal-tool result before exposing its pruned preview", async () => {
    const output = `HEAD\n${"MIDDLE".repeat(6_000)}\nTAIL`;
    const put = vi.fn(async () => ({
      recordId: "a".repeat(64),
      resultRef: `tool-result://v1/${"a".repeat(64)}`,
      runId: "run-1",
      toolCallId: "call-1",
      toolName: "send_email",
      bytes: Buffer.byteLength(output),
      codePoints: Array.from(output).length,
      truncatedForModel: true,
      createdAt: 1,
    }));
    const store: ToolOutputStore = {
      put,
      read: vi.fn(),
      find: vi.fn(),
      deleteConversation: vi.fn(),
    };

    const result = await dispatchToolCall(call("call-1"), {
      state: state(),
      tools: [tool(async () => output)],
      toolContext: { userQuery: "", conversationId: "conversation-1", runId: "run-1" },
      toolOutputStore: store,
    });

    expect(put).toHaveBeenCalledWith(expect.objectContaining({
      conversationId: "conversation-1",
      runId: "run-1",
      toolCallId: "call-1",
      output,
    }));
    expect(result.fullOutputRef).toBe(`tool-result://v1/${"a".repeat(64)}`);
    expect(result.preview).toContain("HEAD");
    expect(result.preview).toContain("TAIL");
    expect(result.preview).not.toBe(output);
    // 预览预算 = 头 12K + 尾 8K + 剪枝标记
    expect(result.preview?.length).toBeLessThanOrEqual(12_000 + 8_000 + 100);
  });

  it("persists short normal-tool results too", async () => {
    const put = vi.fn(async () => ({
      recordId: "b".repeat(64), resultRef: `tool-result://v1/${"b".repeat(64)}`,
      runId: "run-1", toolCallId: "call-1", toolName: "send_email",
      bytes: 2, codePoints: 2, truncatedForModel: false, createdAt: 1,
    }));
    const store: ToolOutputStore = { put, read: vi.fn(), find: vi.fn(), deleteConversation: vi.fn() };

    const result = await dispatchToolCall(call("call-1"), {
      state: state(), tools: [tool(async () => "ok")],
      toolContext: { userQuery: "", conversationId: "conversation-1", runId: "run-1" }, toolOutputStore: store,
    });

    expect(put).toHaveBeenCalledWith(expect.objectContaining({ output: "ok", truncatedForModel: false }));
    expect(result).toMatchObject({ output: "ok", fullOutputRef: `tool-result://v1/${"b".repeat(64)}` });
  });

  it("does not turn a persistence failure into a false tool failure", async () => {
    const persistenceError = new ToolOutputPersistenceError("disk unavailable");
    const store: ToolOutputStore = {
      put: vi.fn(async () => { throw persistenceError; }),
      read: vi.fn(), find: vi.fn(), deleteConversation: vi.fn(),
    };

    await expect(dispatchToolCall(call("call-1"), {
      state: state(), tools: [tool(async () => "email sent")],
      toolContext: { userQuery: "", conversationId: "conversation-1", runId: "run-1" }, toolOutputStore: store,
    })).rejects.toBe(persistenceError);
  });

  it("persists a task final observation but not ordinary Harness control builtins", async () => {
    const output = JSON.stringify({ taskId: "task-1", status: "completed", text: "子代理完整报告" });
    const put = vi.fn(async () => ({
      recordId: "d".repeat(64), resultRef: `tool-result://v1/${"d".repeat(64)}`,
      runId: "run-1", toolCallId: "task-call", toolName: "task",
      bytes: Buffer.byteLength(output), codePoints: Array.from(output).length, truncatedForModel: false, createdAt: 1,
    }));
    const store: ToolOutputStore = { put, read: vi.fn(), find: vi.fn(), deleteConversation: vi.fn() };

    const result = await dispatchToolCall({ id: "task-call", name: "task", arguments: JSON.stringify({
      description: "检查子任务", prompt: "给出完整报告", subagent_type: "general", companion_id: "风堇",
    }) }, {
      state: state(), tools: [], toolOutputStore: store,
      toolContext: { userQuery: "", conversationId: "conversation-1", runId: "run-1" },
      taskExecutor: async () => ({ taskId: "task-1", status: "completed", text: "子代理完整报告" }),
    });

    expect(put).toHaveBeenCalledWith(expect.objectContaining({ toolName: "task", output }));
    expect(result.fullOutputRef).toBe(`tool-result://v1/${"d".repeat(64)}`);
  });
});
