import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TaskSessionStore } from "../tasks/task-session-store";
import { closeConversationDatabases } from "../storage/conversation-database-client";
import { createTaskExecutor } from "./task-runtime";
import { getConversationTranscriptStore } from "./conversation-transcript-store";
import { createTranscriptSink } from "./transcript-sink";
import { dispatchToolCall } from "./harness/tool-dispatcher";
import { toolCallFingerprint, type HarnessInput } from "./harness/types";
import type { ToolDefinition } from "./tools/registry/tool-registry";

const roots: string[] = [];
function createRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cyrene-task-recovery-"));
  roots.push(root);
  return root;
}
const parent = {
  parentConversationId: "parent", parentRunId: "parent-new", mode: "code" as const,
  systemPrompt: "", vendorConfig: { provider: "fake", model: "fake", apiKey: "", baseUrl: "" },
  tools: [] as ToolDefinition[], permissionMode: "normal" as const,
};
function completed(input: HarnessInput) {
  return { finalAnswer: "done", finalState: { todoItems: [], uncertainEffects: [], ...input.initialState },
    terminated: false, rounds: 1, terminal: { status: "success" as const, externalEffectsMayContinue: false } };
}
afterEach(async () => {
  vi.restoreAllMocks();
  await closeConversationDatabases();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("子任务不确定副作用恢复", () => {
  it.each([true, false])("恢复后阻止重复执行不确定副作用（已有结果记录：%s）", async (hasResult) => {
    const root = createRoot();
    let child = 0;
    const store = new TaskSessionStore(root, { createId: () => "task", createChildRunId: () => `child-${++child}` });
    const session = await store.create({ ...parent, description: "effect", prompt: "perform", subagentType: "general", companionId: "风堇" });
    const transcript = getConversationTranscriptStore(root);
    await transcript.append(session.id, { id: "old-user", kind: "user", turnId: "old-user", revision: 1, at: 1, payload: { text: "perform" } });
    const sink = createTranscriptSink({ store: transcript, conversationId: session.id, runId: session.childRunId });
    const args = { command: "counter-only-test" };
    const call = { id: "original", name: "run_shell", arguments: JSON.stringify(args) };
    const assistantEntryId = await sink.appendAssistant({ message: { role: "assistant", content: "", toolCalls: [call] } });
    await sink.appendToolStarted!({ assistantEntryId, toolCallId: call.id, toolName: call.name,
      sideEffect: "non_idempotent_side_effect", fingerprint: toolCallFingerprint(call.name, args) });
    if (hasResult) await sink.appendToolResult({ assistantEntryId, message: { role: "tool", toolCallId: call.id, content: "Result unknown" }, outcome: "unknown" });
    await store.checkpoint(session.id, { status: "failed" });
    const executeEffect = vi.fn(async () => "ok");
    const shell: ToolDefinition = { id: "run_shell", name: "shell", enabled: true, description: "counter",
      inputSchema: { type: "object", properties: { command: { type: "string" } } }, effectKind: "mutation", execute: executeEffect };
    const execute = createTaskExecutor({ parent: { ...parent, tools: [shell], transcriptRoot: root }, store,
      runHarness: async (input) => {
        expect(input.initialState?.uncertainEffects).toHaveLength(1);
        expect(input.messages.some(message => message.role === "tool" && message.toolCallId === call.id)).toBe(true);
        const outcome = await dispatchToolCall({ ...call, id: "repeat" }, { state: input.initialState!, tools: input.tools,
          toolContext: input.toolContext!, checkPermission: async () => true, deferOutputPersistence: true });
        expect(outcome).toMatchObject({ outcome: "not_executed", category: "runtime_safety" });
        return completed(input);
      } });
    await execute({ taskId: session.id, description: "resume", prompt: "continue", subagentType: "general", companionId: "风堇" });
    expect(executeEffect).not.toHaveBeenCalled();
  });

});
