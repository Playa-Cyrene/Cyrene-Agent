import { describe, expect, it, vi } from "vitest";
import { prepareHarnessRecoveryState } from "./run-recovery";
import type { HarnessRunSession } from "./run-store";
import { dispatchToolCall } from "./tool-dispatcher";
import { toolCallFingerprint } from "./types";
import type { ToolDefinition } from "../../tools/registry/tool-registry";

function session(toolCalls: HarnessRunSession["toolCalls"]): HarnessRunSession {
  return {
    schemaVersion: 1,
    conversationId: "chat-1",
    runId: "run-old",
    status: "interrupted",
    messages: [{
      role: "assistant",
      content: "我会执行工具。",
      toolCalls: toolCalls.map((call) => ({ id: call.toolCallId, name: call.toolName, arguments: JSON.stringify({ path: "a.txt" }) })),
    }],
    state: { todoItems: [{ id: "work", content: "继续处理", status: "in_progress" }], uncertainEffects: [] },
    toolOutputs: [],
    toolCalls,
    rounds: 3,
    cache: { cacheEpoch: 3, epochReason: "compaction" },
    request: { provider: "openai", model: "old", contextWindowTokens: 128_000, mode: "work", promptFingerprint: "p", toolSchemaFingerprint: "t", workspaceRoot: "E:\\project" },
    createdAt: 1,
    updatedAt: 2,
  };
}

describe("prepareHarnessRecoveryState", () => {
  it("turns an interrupted non-idempotent invocation into an unknown fact without replaying it", () => {
    const interrupted = session([
      { toolCallId: "mail-1", toolName: "send_email", sideEffect: "non_idempotent_side_effect", status: "started", updatedAt: 2 },
    ]);
    interrupted.messages = [{
      role: "assistant",
      content: "我会发送邮件。",
      toolCalls: [{ id: "mail-1", name: "send_email", arguments: JSON.stringify({ to: "a@example.com", body: "hello" }) }],
    }];
    const recovered = prepareHarnessRecoveryState(interrupted, { workspaceRoot: "E:\\project" });

    expect(recovered.state.uncertainEffects).toEqual([
      expect.objectContaining({ toolCallId: "mail-1", toolName: "send_email" }),
    ]);
    expect(recovered).not.toHaveProperty("messages");
    expect(recovered.uncertainEffects).toEqual(recovered.state.uncertainEffects);
    expect(recovered.uncertainEffects[0]?.fingerprint).toBe(
      toolCallFingerprint("send_email", { to: "a@example.com", body: "hello" }),
    );
    expect(recovered.recoveryContext).toContain("不得自动重放");
  });

  it("reuses the exact recovered arguments to block the same dispatcher invocation", async () => {
    const interrupted = session([
      { toolCallId: "mail-1", toolName: "send_email", sideEffect: "non_idempotent_side_effect", status: "unknown", updatedAt: 2 },
    ]);
    interrupted.messages = [{
      role: "assistant",
      content: "发送中断。",
      toolCalls: [{ id: "mail-1", name: "send_email", arguments: JSON.stringify({ body: "hello", to: "a@example.com" }) }],
    }];
    const recovered = prepareHarnessRecoveryState(interrupted, { workspaceRoot: "E:\\project" });
    const execute = vi.fn(async () => "sent");
    const sendEmail: ToolDefinition = {
      id: "send_email",
      name: "Send email",
      description: "send",
      enabled: true,
      inputSchema: { type: "object", properties: {} },
      effectKind: "external_side_effect",
      execute,
    };

    const result = await dispatchToolCall({
      id: "mail-retry",
      name: "send_email",
      arguments: JSON.stringify({ to: "a@example.com", body: "hello" }),
    }, { state: recovered.state, tools: [sendEmail] });

    expect(result).toMatchObject({ outcome: "not_executed", category: "runtime_safety" });
    expect(execute).not.toHaveBeenCalled();
  });

  it("uses a fail-safe wildcard when old call arguments are missing or invalid", async () => {
    const interrupted = session([
      { toolCallId: "mail-1", toolName: "send_email", sideEffect: "non_idempotent_side_effect", status: "started", updatedAt: 2 },
    ]);
    interrupted.messages = [{
      role: "assistant",
      content: "参数损坏。",
      toolCalls: [{ id: "mail-1", name: "send_email", arguments: "not-json" }],
    }];
    const recovered = prepareHarnessRecoveryState(interrupted, { workspaceRoot: "E:\\project" });
    const execute = vi.fn(async () => "sent");
    const sendEmail: ToolDefinition = {
      id: "send_email",
      name: "Send email",
      description: "send",
      enabled: true,
      inputSchema: { type: "object", properties: {} },
      effectKind: "external_side_effect",
      execute,
    };

    const result = await dispatchToolCall({
      id: "mail-retry",
      name: "send_email",
      arguments: JSON.stringify({ to: "a@example.com", body: "hello" }),
    }, { state: recovered.state, tools: [sendEmail] });

    expect(recovered.uncertainEffects[0]?.fingerprint).toBe("send_email(*)");
    expect(result).toMatchObject({ outcome: "not_executed", category: "runtime_safety" });
    expect(execute).not.toHaveBeenCalled();
  });

  it("uses the same fail-safe wildcard when the old call is absent", () => {
    const interrupted = session([
      { toolCallId: "mail-1", toolName: "send_email", sideEffect: "non_idempotent_side_effect", status: "started", updatedAt: 2 },
    ]);
    interrupted.messages = [];

    const recovered = prepareHarnessRecoveryState(interrupted, { workspaceRoot: "E:\\project" });

    expect(recovered.uncertainEffects[0]?.fingerprint).toBe("send_email(*)");
  });

  it("leaves interrupted read calls out of execution recovery so the model chooses whether to read again", () => {
    const recovered = prepareHarnessRecoveryState(session([
      { toolCallId: "read-1", toolName: "read_file", sideEffect: "read_only", status: "started", updatedAt: 2 },
    ]), { workspaceRoot: "E:\\project" });

    expect(recovered.state.uncertainEffects).toEqual([]);
    expect(recovered).not.toHaveProperty("messages");
  });

  it("does not turn planned calls into uncertain effects", () => {
    const recovered = prepareHarnessRecoveryState(session([
      { toolCallId: "read-1", toolName: "read_file", sideEffect: "read_only", status: "planned", updatedAt: 2 },
    ]), { workspaceRoot: "E:\\project" });

    expect(recovered.uncertainEffects).toEqual([]);
    expect(recovered.recoveryContext).toContain("尚未启动");
  });

  it("rejects recovery when the bound workspace changed", () => {
    expect(() => prepareHarnessRecoveryState(session([]), { workspaceRoot: "E:\\another-project" }))
      .toThrow("HARNESS_RECOVERY_WORKSPACE_MISMATCH");
  });

  it("keeps recovery explicit about a changed model and unavailable old tools", () => {
    const interrupted = session([]);
    interrupted.request.enabledToolIds = ["read_file", "removed_tool"];
    const recovered = prepareHarnessRecoveryState(interrupted, {
      workspaceRoot: "E:\\project",
      provider: "anthropic",
      model: "new-model",
      enabledToolIds: ["read_file"],
    });

    expect(recovered.recoveryContext).toContain("模型已变化");
    expect(recovered.recoveryContext).toContain("removed_tool");
  });

  it("starts recovery in the next cache epoch without mutating the old transcript", () => {
    const interrupted = session([]);
    const originalMessages = JSON.parse(JSON.stringify(interrupted.messages));

    const recovered = prepareHarnessRecoveryState(interrupted, { workspaceRoot: "E:\\project" });

    expect(recovered.cacheState).toEqual({ cacheEpoch: 4, epochReason: "recovery" });
    expect(interrupted.messages).toEqual(originalMessages);
  });

  it("rejects recovery when the conversation identity changed", () => {
    expect(() => prepareHarnessRecoveryState(session([]), {
      conversationId: "another-chat",
      workspaceRoot: "E:\\project",
    })).toThrow("HARNESS_RECOVERY_CONVERSATION_MISMATCH");
  });
});
