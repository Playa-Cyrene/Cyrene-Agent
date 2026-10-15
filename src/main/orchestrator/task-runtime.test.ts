import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TaskSessionStore } from "../tasks/task-session-store";
import { buildChildPromptLayers, createTaskExecutor } from "./task-runtime";
import { getConversationTranscriptStore } from "./conversation-transcript-store";
import { getHarnessRunStore } from "./harness/run-store";
import { closeConversationDatabases } from "../storage/conversation-database-client";
import type { ToolDefinition } from "./tools/registry/tool-registry";
import { TaskCharacterLeasePool } from "../tasks/task-character-pool";
import type { TaskDelegationPresentation } from "../../shared/task-session";

const roots: string[] = [];

function createStore() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cyrene-task-runtime-"));
  roots.push(root);
  return new TaskSessionStore(root, {
    createId: () => "task-1",
    createChildRunId: () => "child-run-1",
  });
}

function tool(id: string): ToolDefinition {
  return { id, name: id, description: id, enabled: true, inputSchema: { type: "object", properties: {} }, execute: async () => "ok" };
}

const parent = {
  parentConversationId: "conversation-1",
  parentRunId: "parent-run-1",
  mode: "code" as const,
  systemPrompt: "parent persona must not be copied",
  vendorConfig: { provider: "fake", model: "fake" } as never,
  tools: [tool("Read"), tool("task"), tool("ask_user")],
  permissionMode: "normal" as const,
  resolvedWorkspaceRoot: "E:\\project",
  checkPermission: vi.fn(async () => true),
};

afterEach(async () => {
  vi.restoreAllMocks();
  // 先关 DB worker（Windows 下打开的 sqlite 文件不能删），再清临时目录。
  await closeConversationDatabases().catch(() => {});
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("TaskRuntime", () => {
  it("keeps the child role stable and workspace metadata session-scoped", () => {
    const layers = buildChildPromptLayers(parent, "SUBAGENT_PROFILE");
    expect(layers.stablePrefix.startsWith("SUBAGENT_PROFILE\n")).toBe(true);
    expect(layers.sessionPrefix).toContain("E:\\project");
    expect(layers.sessionPrefix).toContain("会话模式：code");
  });

  it("creates an isolated child Harness run and persists its final result", async () => {
    const store = createStore();
    const runHarness = vi.fn(async (input: any) => ({
      finalAnswer: "检查完成。",
      finalState: { todoItems: [], uncertainEffects: [] },
      terminated: false,
      rounds: 1,
      terminal: { status: "success" as const, externalEffectsMayContinue: false },
    }));
    const execute = createTaskExecutor({ parent, store, runHarness });

    const result = await execute({
      description: "检查取消链路",
      prompt: "检查取消传播并报告证据。",
      subagentType: "general",
      companionId: "风堇",
    });

    expect(result).toEqual({ taskId: "task-1", status: "completed", text: "检查完成。" });
    expect(runHarness).toHaveBeenCalledWith(expect.objectContaining({
      messages: [{ role: "user", content: "检查取消传播并报告证据。" }],
      tools: [expect.objectContaining({ id: "Read" })],
      config: expect.not.objectContaining({ maxRounds: expect.anything() }),
      toolContext: expect.objectContaining({
        runId: "child-run-1",
        resolvedWorkspaceRoot: "E:\\project",
        permissionMode: "normal",
        readOnly: false,
      }),
    }));
    expect(await store.get("task-1")).toMatchObject({ status: "completed", resultText: "检查完成。" });
  });

  it("writes the task session incrementally to SQLite and drops the messages snapshot", async () => {
    const dbRoot = fs.mkdtempSync(path.join(os.tmpdir(), "cyrene-task-runtime-db-"));
    roots.push(dbRoot);
    const store = createStore();
    const runHarness = vi.fn(async (input: any) => {
      const assistantEntryId = await input.transcriptSink.appendAssistant({
        message: { role: "assistant", content: "开始检查", toolCalls: [] },
      });
      await input.transcriptSink.appendToolResult({
        assistantEntryId,
        message: { role: "tool", toolCallId: "t1", content: "ok" },
        outcome: "success",
      });
      // todoItems 经 update_todo 落 task_state 条目；checkpoint 快照通道已退役，harness 输入不再有 onCheckpoint
      await input.transcriptSink.appendTaskState?.({
        assistantEntryId,
        toolCallId: "t1",
        items: [{ id: "t1", content: "核对完成", status: "completed" }],
      });
      return {
        finalAnswer: "检查完成。",
        finalState: { todoItems: [{ id: "t1", content: "核对完成", status: "completed" }], uncertainEffects: [] },
        terminated: false,
        rounds: 1,
        terminal: { status: "success" as const, externalEffectsMayContinue: false },
      };
    });
    const execute = createTaskExecutor({ parent: { ...parent, transcriptRoot: dbRoot }, store, runHarness });

    const result = await execute({
      description: "检查落库",
      prompt: "检查增量落库并报告证据。",
      subagentType: "general",
      companionId: "风堇",
    });
    expect(result.status).toBe("completed");

    const transcript = getConversationTranscriptStore(dbRoot);
    const snapshot = await transcript.read("task-1");
    expect(snapshot.entries.map((entry) => entry.kind)).toEqual(["user", "assistant", "tool_result", "task_state"]);
    const userEntry = snapshot.entries[0]!;
    expect(userEntry).toMatchObject({
      kind: "user",
      runId: "child-run-1",
      payload: { text: "检查增量落库并报告证据。" },
    });

    const run = getHarnessRunStore(dbRoot).get("child-run-1");
    expect(run).toMatchObject({ conversationId: "task-1", status: "completed" });

    const session = (await store.get("task-1"))!;
    expect(session.messages.map((message) => message.content)).not.toContain("SNAPSHOT-MUST-NOT-PERSIST");
    await closeConversationDatabases();
  });

  it("resumes with projected transcript history instead of the messages snapshot", async () => {
    const dbRoot = fs.mkdtempSync(path.join(os.tmpdir(), "cyrene-task-runtime-hist-"));
    roots.push(dbRoot);
    let childCounter = 0;
    const store = new TaskSessionStore(dbRoot, {
      createId: () => "task-hist",
      createChildRunId: () => `child-run-${++childCounter}`,
    });
    const runHarness = vi.fn(async (input: any) => {
      await input.transcriptSink.appendAssistant({
        message: { role: "assistant", content: `第 ${childCounter} 轮结论`, toolCalls: [] },
      });
      return {
        finalAnswer: "完成。",
        finalState: { todoItems: [], uncertainEffects: [] },
        terminated: false,
        rounds: 1,
        terminal: { status: "success" as const, externalEffectsMayContinue: false },
      };
    });
    const execute = createTaskExecutor({ parent: { ...parent, transcriptRoot: dbRoot }, store, runHarness });

    await execute({ description: "首轮", prompt: "第一轮提示", subagentType: "general", companionId: "风堇" });
    await execute({ taskId: "task-hist", prompt: "第二轮提示", subagentType: "general", companionId: "风堇" });

    const secondCallInput = runHarness.mock.calls[1]![0] as { messages: Array<{ role: string; content: string; toolCalls?: unknown[] }> };
    expect(secondCallInput.messages).toEqual([
      { role: "user", content: "第一轮提示" },
      { role: "assistant", content: "第 1 轮结论", toolCalls: [] },
      { role: "user", content: "第二轮提示" },
    ]);
    await closeConversationDatabases();
  });

  it("inherits a mobile parent's non-interactive Harness policy", async () => {    const store = createStore();
    const runHarness = vi.fn(async () => ({
      finalAnswer: "完成。",
      finalState: { todoItems: [], uncertainEffects: [] },
      terminated: false,
      rounds: 1,
      terminal: { status: "success" as const, externalEffectsMayContinue: false },
    }));
    const execute = createTaskExecutor({
      parent: { ...parent, includeInteractiveTools: false, permissionMode: "allow_all" },
      store,
      runHarness,
    });

    await execute({
      description: "检查文件",
      prompt: "检查文件。",
      subagentType: "general",
      companionId: "风堇",
    });

    expect(runHarness).toHaveBeenCalledWith(expect.objectContaining({
      includeInteractiveTools: false,
      toolContext: expect.objectContaining({ permissionMode: "allow_all" }),
    }));
  });

  it("rejects a resume request whose task belongs to another parent conversation", async () => {
    const store = createStore();
    const foreign = await store.create({
      parentConversationId: "other-conversation",
      parentRunId: "other-run",
      description: "已有任务",
      prompt: "先前内容",
      subagentType: "general",
      mode: "code",
    });
    const execute = createTaskExecutor({ parent, store, runHarness: vi.fn() as never });

    await expect(execute({
      description: "继续已有任务",
      prompt: "继续。",
      subagentType: "general",
      companionId: "风堇",
      taskId: foreign.id,
    })).rejects.toThrow("TASK_PARENT_MISMATCH");
  });

  it("restores the private Todo notebook when resuming the same task", async () => {
    const store = createStore();
    const task = await store.create({
      parentConversationId: "conversation-1",
      parentRunId: "parent-run-0",
      description: "检查取消链路",
      prompt: "检查取消传播。",
      subagentType: "general",
      mode: "code",
      resolvedWorkspaceRoot: "E:\\project",
    });
    await store.checkpoint(task.id, {
      status: "completed",
      todoItems: [{ id: "inspect", content: "检查取消链路", status: "in_progress" }],
    });
    const runHarness = vi.fn(async () => ({
      finalAnswer: "继续完成。",
      finalState: { todoItems: [], uncertainEffects: [] },
      terminated: false,
      rounds: 1,
      terminal: { status: "success" as const, externalEffectsMayContinue: false },
    }));
    const execute = createTaskExecutor({ parent, store, runHarness });

    await execute({
      description: "继续检查取消链路",
      prompt: "继续。",
      subagentType: "general",
      companionId: "风堇",
      taskId: task.id,
    });

    expect(runHarness).toHaveBeenCalledWith(expect.objectContaining({
      initialState: {
        todoItems: [{ id: "inspect", content: "检查取消链路", status: "in_progress" }],
        uncertainEffects: [],
      },
    }));
  });

  it("persists the final Todo notebook even when no intermediate checkpoint arrives", async () => {
    const store = createStore();
    const runHarness = vi.fn(async () => ({
      finalAnswer: "检查完成。",
      finalState: {
        todoItems: [{ id: "report", content: "整理检查结果", status: "completed" as const }],
        uncertainEffects: [],
      },
      terminated: false,
      rounds: 1,
      terminal: { status: "success" as const, externalEffectsMayContinue: false },
    }));
    const execute = createTaskExecutor({ parent, store, runHarness });

    const result = await execute({
      description: "检查取消链路",
      prompt: "检查取消传播并报告证据。",
      subagentType: "general",
      companionId: "风堇",
    });

    expect((await store.get(result.taskId))?.todoItems).toEqual([
      { id: "report", content: "整理检查结果", status: "completed" },
    ]);
  });

  it("emits a sanitized running/terminal lifecycle and releases the nickname", async () => {
    const store = createStore();
    const characterPool = new TaskCharacterLeasePool();
    const lifecycle: TaskDelegationPresentation[] = [];
    const runHarness = vi.fn(async () => ({
      finalAnswer: "检查完成。", finalState: { todoItems: [], uncertainEffects: [] },
      terminated: false, rounds: 1, terminal: { status: "success" as const, externalEffectsMayContinue: false },
    }));
    const execute = createTaskExecutor({ parent, store, runHarness, characterPool, onLifecycle: (event) => lifecycle.push(event) });

    await execute({ description: "检查取消链路", prompt: "这是不能出现在父事件里的私密指令", subagentType: "general", companionId: "风堇" });
    const next = characterPool.acquire("conversation-1", "风堇");

    expect(lifecycle).toEqual([
      { invocationId: "child-run-1", taskId: "task-1", description: "检查取消链路", nickname: "风堇", assetFileName: "风堇.png", status: "running" },
      { invocationId: "child-run-1", taskId: "task-1", description: "检查取消链路", nickname: "风堇", assetFileName: "风堇.png", status: "completed" },
    ]);
    expect(JSON.stringify(lifecycle)).not.toContain("私密指令");
    expect(next.nickname).toBe("风堇");
  });

  it.each([
    { terminal: { status: "runtime_error" as const, externalEffectsMayContinue: true }, expected: "failed" },
    { terminal: { status: "cancelled" as const, externalEffectsMayContinue: true }, expected: "cancelled" },
  ])("releases the nickname after $expected settlement", async ({ terminal, expected }) => {
    const store = createStore();
    const characterPool = new TaskCharacterLeasePool();
    const lifecycle: Array<{ status: string }> = [];
    const execute = createTaskExecutor({
      parent, store, characterPool, onLifecycle: (event) => lifecycle.push(event),
      runHarness: vi.fn(async () => ({ finalAnswer: "", finalState: { todoItems: [], uncertainEffects: [] }, terminated: true, rounds: 1, terminal })),
    });

    await execute({ description: "检查异常结算", prompt: "执行", subagentType: "general", companionId: "风堇" });

    expect(lifecycle.at(-1)?.status).toBe(expected);
    expect(characterPool.acquire("conversation-1", "风堇").nickname).toBe("风堇");
  });
});
