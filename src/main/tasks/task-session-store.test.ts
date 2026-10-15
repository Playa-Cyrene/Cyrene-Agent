import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { TaskSessionStore } from "./task-session-store";
import { closeConversationDatabases } from "../storage/conversation-database-client";

const temporaryRoots: string[] = [];

function createStore() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cyrene-task-session-"));
  temporaryRoots.push(root);
  let now = 1_000;
  let nextId = 1;
  return {
    root,
    tick: () => { now += 1; },
    store: new TaskSessionStore(root, {
      now: () => now,
      createId: () => `task-${nextId++}`,
      createChildRunId: () => `child-run-${nextId}`,
    }),
  };
}

function createInput() {
  return {
    parentConversationId: "chat-1",
    parentRunId: "run-1",
    description: "检查取消链路",
    prompt: "检查取消传播并列出证据。",
    subagentType: "general" as const,
    mode: "code" as const,
    resolvedWorkspaceRoot: "E:\\project",
  };
}

afterEach(async () => {
  // 先关 DB worker（Windows 下打开的 sqlite 文件不能删），再清临时目录。
  await closeConversationDatabases().catch(() => {});
  for (const root of temporaryRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe("TaskSessionStore", () => {
  it("persists a running child session scoped to its parent conversation", async () => {
    const { store } = createStore();

    const created = await store.create(createInput());

    expect(created).toMatchObject({
      id: "task-1",
      parentConversationId: "chat-1",
      parentRunId: "run-1",
      childRunId: "child-run-2",
      status: "running",
      contextOpen: true,
      messages: [{ role: "user", content: "检查取消传播并列出证据。" }],
      trace: [],
    });
    expect(await store.get("task-1")).toMatchObject({ id: "task-1" });
    expect(await store.listForParent("chat-2")).toEqual([]);
  });

  it("resumes only a task owned by the same conversation and profile", async () => {
    const { store, tick } = createStore();
    const created = await store.create(createInput());
    await store.checkpoint(created.id, { status: "completed", resultText: "首轮检查完成" });
    tick();

    const resumed = await store.resume(created.id, {
      parentConversationId: "chat-1",
      parentRunId: "run-2",
      subagentType: "general",
      prompt: "继续检查权限等待时的取消。",
    });

    expect(resumed).toMatchObject({ status: "running", parentRunId: "run-2" });
    expect(resumed.messages).toEqual([
      { role: "user", content: "检查取消传播并列出证据。" },
      { role: "user", content: "继续检查权限等待时的取消。" },
    ]);
    expect(resumed.resultText).toBeUndefined();
    await expect(store.resume(created.id, {
      parentConversationId: "chat-2",
      parentRunId: "run-3",
      subagentType: "general",
      prompt: "不应访问。",
    })).rejects.toThrow("TASK_PARENT_MISMATCH");
    await expect(store.resume(created.id, {
      parentConversationId: "chat-1",
      parentRunId: "run-3",
      subagentType: "search",
      prompt: "不应改变类型。",
    })).rejects.toThrow("TASK_PROFILE_MISMATCH");
  });

  it("marks a persisted running task as interrupted after restart", async () => {
    const { root, store } = createStore();
    const created = await store.create(createInput());

    // 模拟进程重启：关闭 worker 再开新 store，对账把 running 翻转为 interrupted。
    await closeConversationDatabases();
    const restarted = new TaskSessionStore(root);

    expect(await restarted.get(created.id)).toMatchObject({
      id: created.id,
      status: "interrupted",
      messages: [{ role: "user", content: "检查取消传播并列出证据。" }],
    });
  });

  it("persists a task Todo notebook across restart without exposing mutable storage", async () => {
    const { root, store } = createStore();
    const created = await store.create(createInput());

    await store.checkpoint(created.id, {
      todoItems: [{ id: "inspect", content: "检查取消链路", status: "in_progress" }],
    });

    await closeConversationDatabases();
    const restarted = new TaskSessionStore(root);
    const restored = await restarted.get(created.id);

    expect(restored?.todoItems).toEqual([
      { id: "inspect", content: "检查取消链路", status: "in_progress" },
    ]);

    restored?.todoItems.push({ id: "report", content: "整理报告", status: "pending" });
    expect((await restarted.get(created.id))?.todoItems).toEqual([
      { id: "inspect", content: "检查取消链路", status: "in_progress" },
    ]);

    const sibling = await restarted.create({ ...createInput(), description: "另一个子任务" });
    expect(sibling.todoItems).toEqual([]);
  });

  it("finds and closes an open companion context per parent conversation", async () => {
    const { store } = createStore();
    const created = await store.create({ ...createInput(), companionId: "风堇" });

    expect(await store.findOpenByCompanion("chat-1", "风堇")).toMatchObject({ id: created.id });
    expect(await store.listOpenCompanions("chat-1")).toEqual(["风堇"]);

    await expect(store.closeByCompanion("chat-1", "风堇")).rejects.toThrow("TASK_ALREADY_RUNNING");
    await store.checkpoint(created.id, { status: "completed" });
    const closed = await store.closeByCompanion("chat-1", "风堇");
    expect(closed).toMatchObject({ status: "completed", contextOpen: false });
    expect(await store.findOpenByCompanion("chat-1", "风堇")).toBeNull();
    expect(await store.listOpenCompanions("chat-1")).toEqual([]);
  });

  it("round-trips a bounded trace through checkpoint", async () => {
    const { store } = createStore();
    const created = await store.create(createInput());

    await store.checkpoint(created.id, {
      trace: [
        { id: "trace-1", at: 1, kind: "candidate", phase: "delta", label: "a", roundId: "round-0", content: "x" },
        { id: "trace-2", at: 2, kind: "tool", phase: "end", label: "read_file", roundId: "round-0", status: "success" },
      ],
    });

    const restored = await store.get(created.id);
    expect(restored?.trace.map((record) => record.id)).toEqual(["trace-1", "trace-2"]);
  });
});
