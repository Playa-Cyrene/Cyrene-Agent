import { describe, expect, it } from "vitest";
import { prepareHarnessRecoveryState } from "./run-recovery";
import type { HarnessRunSession } from "./run-store";

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
    const recovered = prepareHarnessRecoveryState(session([
      { toolCallId: "mail-1", toolName: "send_email", sideEffect: "non_idempotent_side_effect", status: "started", updatedAt: 2 },
    ]), { workspaceRoot: "E:\\project" });

    expect(recovered.state.uncertainEffects).toEqual([
      expect.objectContaining({ toolCallId: "mail-1", toolName: "send_email" }),
    ]);
    expect(recovered).not.toHaveProperty("messages");
    expect(recovered.uncertainEffects).toEqual(recovered.state.uncertainEffects);
    expect(recovered.recoveryContext).toContain("不得自动重放");
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
