import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TaskSessionStore } from "../tasks/task-session-store";
import { closeConversationDatabases } from "../storage/conversation-database-client";
import { createTaskExecutor } from "./task-runtime";
import { getConversationTranscriptStore } from "./conversation-transcript-store";
import type { HarnessInput } from "./harness/types";
import type { ToolDefinition } from "./tools/registry/tool-registry";
import { getHarnessRunStore } from "./harness/run-store";

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

describe("子任务准备失败恢复", () => {
  it.each(["create", "append", "read"] as const)("准备阶段 %s 单次失败后可在同一进程重试，且不执行工具", async (operation) => {
    const root = createRoot();
    let child = 0;
    const store = new TaskSessionStore(root, { createId: () => "preparation-task", createChildRunId: () => `preparation-${++child}` });
    const transcript = getConversationTranscriptStore(root);
    const runs = getHarnessRunStore(root);
    await runs.ready;
    const failure = new Error(`temporary ${operation} failure`);
    if (operation === "create") vi.spyOn(runs, "create").mockRejectedValueOnce(failure);
    else vi.spyOn(transcript, operation).mockRejectedValueOnce(failure);
    const runHarness = vi.fn(async (input: HarnessInput) => completed(input));
    const execute = createTaskExecutor({ parent: { ...parent, transcriptRoot: root }, store, runHarness });
    const request = { description: "prepare", prompt: "perform", subagentType: "general" as const, companionId: "风堇" };
    await expect(execute(request)).rejects.toThrow(failure.message);
    expect(runHarness).not.toHaveBeenCalled();
    expect(await store.get("preparation-task")).toMatchObject({ status: "failed", childRunId: "preparation-1" });
    if (operation !== "create") expect(runs.get("preparation-1")?.status).toBe("failed");
    await expect(execute({ ...request, taskId: "preparation-task", prompt: "retry" })).resolves.toMatchObject({ status: "completed" });
    expect(runHarness).toHaveBeenCalledOnce();
  });

  it("准备阶段取消会结束本轮记录，已在运行的其他请求不会被错误结束", async () => {
    const root = createRoot();
    let child = 0;
    const store = new TaskSessionStore(root, { createId: () => "cancel-prepare", createChildRunId: () => `cancel-${++child}` });
    const transcript = getConversationTranscriptStore(root);
    const controller = new AbortController();
    vi.spyOn(transcript, "append").mockImplementationOnce(async () => {
      controller.abort();
      throw new Error("cancelled while appending prompt");
    });
    const runHarness = vi.fn(async (input: HarnessInput) => completed(input));
    const execute = createTaskExecutor({ parent: { ...parent, transcriptRoot: root, signal: controller.signal }, store, runHarness });
    const request = { description: "cancel", prompt: "perform", subagentType: "general" as const, companionId: "风堇" };
    await expect(execute(request)).rejects.toThrow("cancelled while appending prompt");
    expect(await store.get("cancel-prepare")).toMatchObject({ status: "cancelled", error: { code: "TASK_CANCELLED" } });
    expect(getHarnessRunStore(root).get("cancel-1")?.status).toBe("cancelled");
    await store.resume("cancel-prepare", { ...parent, subagentType: "general", prompt: "another request already running" });
    await expect(execute({ ...request, taskId: "cancel-prepare" })).rejects.toThrow("TASK_ALREADY_RUNNING");
    expect(await store.get("cancel-prepare")).toMatchObject({ status: "running", childRunId: "cancel-2" });
    expect(runHarness).not.toHaveBeenCalled();
  });

});
