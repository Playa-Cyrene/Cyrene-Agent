// 运行插话轮询单元测试：注入替身存储，验证"标记 → 提交 → 注入"的核心不变量。
// 覆盖：无标记同步快速路径、按入队顺序提交、跨运行隔离、
// 提交失败跳过且保留标记（不注入未可靠记录的消息）、提交成功后不重复注入。

import { describe, expect, it, vi } from "vitest";
import type { PendingChatMessage } from "../../shared/chat-types";

// chats-store 被 pending-adjustment 静态引用（默认存储端口），测试全部注入替身，
// 但模块加载仍会求值 electron 导入，这里给最小 mock。
vi.mock("electron", () => ({
  app: { getPath: () => "" },
  shell: { openPath: vi.fn() },
}));

import { createRunAdjustmentPoller, type PendingAdjustmentStore } from "./pending-adjustment";

interface FakeStore {
  queue: Map<string, PendingChatMessage[]>;
  commits: Array<{ sessionId: string; messageId: string; runId: string }>;
  /** 按 messageId 指定提交结果（默认成功）。 */
  failIds: Set<string>;
  store: PendingAdjustmentStore;
}

function makeItem(id: string, adjustRunId?: string): PendingChatMessage {
  return { id, rawContent: `内容-${id}`, visibleContent: `内容-${id}`, enqueuedAt: 1, ...(adjustRunId ? { adjustRunId } : {}) };
}

function createFakeStore(): FakeStore {
  const queue = new Map<string, PendingChatMessage[]>();
  const commits: Array<{ sessionId: string; messageId: string; runId: string }> = [];
  const failIds = new Set<string>();
  const store: PendingAdjustmentStore = {
    getPendingMessages: (sessionId) => queue.get(sessionId) ?? null,
    commitPendingAdjust: (sessionId, messageId, runId) => {
      commits.push({ sessionId, messageId, runId });
      if (failIds.has(messageId)) return { ok: false, error: "write-failed" };
      const items = queue.get(sessionId) ?? [];
      const target = items.find((item) => item.id === messageId);
      if (!target || target.adjustRunId !== runId) return { ok: false, error: "run-mismatch" };
      // 提交成功：移出队列（转正式消息由真实 store 负责，替身只模拟队列收缩）
      queue.set(sessionId, items.filter((item) => item.id !== messageId));
      return {
        ok: true,
        userMessage: { id: messageId },
        remainingQueue: queue.get(sessionId)!.map((item) => ({ ...item })),
      };
    },
  };
  return { queue, commits, failIds, store };
}

describe("createRunAdjustmentPoller", () => {
  it("无本运行标记时同步返回 undefined（不产生 await 挂起点）", () => {
    const fake = createFakeStore();
    fake.queue.set("s1", [makeItem("q-1"), makeItem("q-2", "run-other")]);
    const poll = createRunAdjustmentPoller("s1", "run-1", fake.store);

    const result = poll();
    expect(result).toBeUndefined();
    expect(fake.commits).toEqual([]);
  });

  it("会话不存在同样返回 undefined", () => {
    const fake = createFakeStore();
    const poll = createRunAdjustmentPoller("missing", "run-1", fake.store);
    expect(poll()).toBeUndefined();
  });

  it("核心事件顺序：工具/请求结束后轮询 → 按入队顺序提交 → 返回注入消息", async () => {
    const fake = createFakeStore();
    fake.queue.set("s1", [
      makeItem("q-1", "run-1"),
      makeItem("q-2", "run-1"),
      makeItem("q-3", "run-1"),
    ]);
    const poll = createRunAdjustmentPoller("s1", "run-1", fake.store);

    const promise = poll();
    expect(promise).toBeInstanceOf(Promise);
    const injected = await promise;

    // 注入顺序 = 入队顺序
    expect(injected.map((item) => item.id)).toEqual(["q-1", "q-2", "q-3"]);
    expect(injected[0]).toMatchObject({ id: "q-1", rawContent: "内容-q-1" });
    // 每条都以 (sessionId, messageId, runId) 提交且只提交一次
    expect(fake.commits).toEqual([
      { sessionId: "s1", messageId: "q-1", runId: "run-1" },
      { sessionId: "s1", messageId: "q-2", runId: "run-1" },
      { sessionId: "s1", messageId: "q-3", runId: "run-1" },
    ]);
    // 队列已清空（条目全部转正式消息）
    expect(fake.queue.get("s1")).toEqual([]);
  });

  it("跨运行隔离：只提交标记为本运行的条目，其他运行的标记不被取走", async () => {
    const fake = createFakeStore();
    fake.queue.set("s1", [
      makeItem("q-mine", "run-1"),
      makeItem("q-theirs", "run-2"),
    ]);
    const poll = createRunAdjustmentPoller("s1", "run-1", fake.store);

    const injected = await poll();
    expect(injected.map((item) => item.id)).toEqual(["q-mine"]);
    // 其他运行的标记条目原样保留在队列
    expect(fake.queue.get("s1")?.map((item) => item.id)).toEqual(["q-theirs"]);
  });

  it("提交失败的条目跳过不注入：保留标记等下个边界重试，成功的照常注入", async () => {
    const fake = createFakeStore();
    fake.failIds.add("q-broken");
    fake.queue.set("s1", [
      makeItem("q-ok", "run-1"),
      makeItem("q-broken", "run-1"),
    ]);
    const poll = createRunAdjustmentPoller("s1", "run-1", fake.store);

    const injected = await poll();
    // 绝不注入未可靠记录的消息
    expect(injected.map((item) => item.id)).toEqual(["q-ok"]);
    // 提交失败的条目仍在队列（替身模拟：failIds 分支未移除）
    expect(fake.queue.get("s1")?.map((item) => item.id)).toEqual(["q-broken"]);

    // 恢复后下个边界重试：成功注入
    fake.failIds.delete("q-broken");
    const retry = await poll();
    expect(retry.map((item) => item.id)).toEqual(["q-broken"]);
  });

  it("提交成功后条目已移出：再次轮询无标记（绝不重复注入）", async () => {
    const fake = createFakeStore();
    fake.queue.set("s1", [makeItem("q-1", "run-1")]);
    const poll = createRunAdjustmentPoller("s1", "run-1", fake.store);

    await poll();
    expect(poll()).toBeUndefined();
    expect(fake.commits).toHaveLength(1);
  });
});
