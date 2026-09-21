// 运行插话轮询单元测试：注入替身存储，验证"标记 → 提交 → 注入"的核心不变量。
// 覆盖：无标记同步快速路径、按入队顺序提交、跨运行隔离、
// 双写顺序（权威轨迹先写 → 聊天历史后写）、任一步失败抛错且保留标记
// （fail-closed：不注入未可靠记录的消息，重试时轨迹幂等命中只补聊天历史）。

import { describe, expect, it, vi } from "vitest";
import type { PendingChatAttachment, PendingChatMessage } from "../../shared/chat-types";

// chats-store 被 pending-adjustment 静态引用（默认存储端口），测试全部注入替身，
// 但模块加载仍会求值 electron 导入，这里给最小 mock。
vi.mock("electron", () => ({
  app: { getPath: () => "" },
  shell: { openPath: vi.fn() },
}));

import { createRunAdjustmentPoller, type PendingAdjustmentStore, type TranscriptUserWritePort } from "./pending-adjustment";

interface FakeStore {
  queue: Map<string, PendingChatMessage[]>;
  commits: Array<{ sessionId: string; messageId: string; runId: string }>;
  /** 按 messageId 指定提交结果（默认成功）。 */
  failIds: Set<string>;
  store: PendingAdjustmentStore;
}

function makeItem(
  id: string,
  adjustRunId?: string,
  attachments?: PendingChatAttachment[],
): PendingChatMessage {
  return {
    id,
    rawContent: `内容-${id}`,
    visibleContent: `内容-${id}`,
    enqueuedAt: 1,
    ...(adjustRunId ? { adjustRunId } : {}),
    ...(attachments ? { attachments } : {}),
  };
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

interface FakeTranscript {
  /** 全部 appendUser 调用记录（含重试；生产 store 同 entryId 幂等吸收）。 */
  calls: Array<{ turnId: string; text: string; attachments?: PendingChatAttachment[] }>;
  /** 剩余连续失败次数：> 0 时 appendUser reject（模拟轨迹写失败）。 */
  failWrites: number;
  port: TranscriptUserWritePort;
}

function createFakeTranscript(): FakeTranscript {
  const calls: FakeTranscript["calls"] = [];
  const transcript: FakeTranscript = {
    calls,
    failWrites: 0,
    port: {
      appendUser: async (input) => {
        calls.push({ turnId: input.turnId, text: input.text, ...(input.attachments ? { attachments: input.attachments } : {}) });
        if (transcript.failWrites > 0) {
          transcript.failWrites -= 1;
          throw new Error("transcript-write-failed");
        }
      },
    },
  };
  return transcript;
}

describe("createRunAdjustmentPoller", () => {
  it("无本运行标记时同步返回 undefined（不产生 await 挂起点）", () => {
    const fake = createFakeStore();
    const transcript = createFakeTranscript();
    fake.queue.set("s1", [makeItem("q-1"), makeItem("q-2", "run-other")]);
    const poll = createRunAdjustmentPoller("s1", "run-1", fake.store, transcript.port);

    const result = poll();
    expect(result).toBeUndefined();
    expect(fake.commits).toEqual([]);
    expect(transcript.calls).toEqual([]);
  });

  it("会话不存在同样返回 undefined", () => {
    const fake = createFakeStore();
    const transcript = createFakeTranscript();
    const poll = createRunAdjustmentPoller("missing", "run-1", fake.store, transcript.port);
    expect(poll()).toBeUndefined();
  });

  it("双写顺序：轨迹先写（含附件元数据）→ 聊天历史后写，逐条交错且都成功才返回", async () => {
    const fake = createFakeStore();
    const transcript = createFakeTranscript();
    const attachments: PendingChatAttachment[] = [{ kind: "file", name: "spec.md", filePath: "E:\\tmp\\spec.md" }];
    fake.queue.set("s1", [
      makeItem("q-1", "run-1", attachments),
      makeItem("q-2", "run-1"),
      makeItem("q-3", "run-1"),
    ]);
    const order: string[] = [];
    const tracedStore: PendingAdjustmentStore = {
      getPendingMessages: fake.store.getPendingMessages,
      commitPendingAdjust: (sessionId, messageId, runId) => {
        const result = fake.store.commitPendingAdjust(sessionId, messageId, runId);
        order.push(`commit:${messageId}`);
        return result;
      },
    };
    const tracedTranscript: TranscriptUserWritePort = {
      appendUser: async (input) => {
        order.push(`transcript:${input.turnId}`);
        return transcript.port.appendUser(input);
      },
    };
    const poll = createRunAdjustmentPoller("s1", "run-1", tracedStore, tracedTranscript);

    const promise = poll();
    expect(promise).toBeInstanceOf(Promise);
    const injected = await promise;

    // 注入顺序 = 入队顺序
    expect(injected.map((item) => item.id)).toEqual(["q-1", "q-2", "q-3"]);
    expect(injected[0]).toMatchObject({ id: "q-1", rawContent: "内容-q-1" });
    // 每条插话都是：先写权威轨迹，后提交聊天历史
    expect(order).toEqual([
      "transcript:q-1", "commit:q-1",
      "transcript:q-2", "commit:q-2",
      "transcript:q-3", "commit:q-3",
    ]);
    // 轨迹 user 写入携带附件元数据（不能只传 rawContent）
    expect(transcript.calls[0]).toMatchObject({
      turnId: "q-1",
      text: "内容-q-1",
      attachments: [{ kind: "file", name: "spec.md", filePath: "E:\\tmp\\spec.md" }],
    });
    expect(transcript.calls[1]).toMatchObject({ turnId: "q-2", text: "内容-q-2" });
    // 队列已清空（条目全部转正式消息）
    expect(fake.queue.get("s1")).toEqual([]);
  });

  it("跨运行隔离：只提交标记为本运行的条目，其他运行的标记不被取走", async () => {
    const fake = createFakeStore();
    const transcript = createFakeTranscript();
    fake.queue.set("s1", [
      makeItem("q-mine", "run-1"),
      makeItem("q-theirs", "run-2"),
    ]);
    const poll = createRunAdjustmentPoller("s1", "run-1", fake.store, transcript.port);

    const injected = await poll();
    expect(injected.map((item) => item.id)).toEqual(["q-mine"]);
    // 其他运行的标记条目原样保留在队列
    expect(fake.queue.get("s1")?.map((item) => item.id)).toEqual(["q-theirs"]);
    expect(transcript.calls.map((call) => call.turnId)).toEqual(["q-mine"]);
  });

  it("轨迹写失败：抛错，pending 保留且聊天历史未提交（fail-closed）", async () => {
    const fake = createFakeStore();
    const transcript = createFakeTranscript();
    transcript.failWrites = 1;
    fake.queue.set("s1", [makeItem("q-1", "run-1")]);
    const poll = createRunAdjustmentPoller("s1", "run-1", fake.store, transcript.port);

    await expect(poll()).rejects.toThrow("transcript-write-failed");
    // 聊天历史未提交：pending 标记保留，等下个边界重试
    expect(fake.commits).toEqual([]);
    expect(fake.queue.get("s1")?.map((item) => item.id)).toEqual(["q-1"]);
  });

  it("聊天历史写失败：同样抛错且 pending 保留；重试时轨迹幂等命中只补聊天历史", async () => {
    const fake = createFakeStore();
    const transcript = createFakeTranscript();
    fake.failIds.add("q-1");
    fake.queue.set("s1", [makeItem("q-1", "run-1")]);
    const poll = createRunAdjustmentPoller("s1", "run-1", fake.store, transcript.port);

    // 第一次：轨迹已写、聊天历史提交失败 → 抛错
    await expect(poll()).rejects.toThrow();
    expect(fake.commits).toHaveLength(1);
    expect(fake.queue.get("s1")?.map((item) => item.id)).toEqual(["q-1"]);

    // 恢复后重试：轨迹 appendUser 再次调用（生产 store 同 entryId 幂等命中），聊天历史补交成功
    fake.failIds.delete("q-1");
    const retry = await poll();
    expect(retry.map((item) => item.id)).toEqual(["q-1"]);
    expect(fake.commits).toHaveLength(2);
    expect(fake.queue.get("s1")).toEqual([]);
    expect(transcript.calls.map((call) => call.turnId)).toEqual(["q-1", "q-1"]);
  });

  it("无轨迹端口（缺 userTurnId 的兼容调用）：只提交聊天历史，不写轨迹", async () => {
    const fake = createFakeStore();
    fake.queue.set("s1", [makeItem("q-1", "run-1")]);
    // 兼容调用不传轨迹端口：插话仍注入并提交聊天历史（CTA 之前的旧行为），轨迹零写入
    const poll = createRunAdjustmentPoller("s1", "run-1", fake.store, undefined);

    const injected = await poll();
    expect(injected.map((item) => item.id)).toEqual(["q-1"]);
    expect(fake.commits).toEqual([{ sessionId: "s1", messageId: "q-1", runId: "run-1" }]);
    expect(fake.queue.get("s1")).toEqual([]);
  });

  it("提交成功后条目已移出：再次轮询无标记（绝不重复注入）", async () => {
    const fake = createFakeStore();
    const transcript = createFakeTranscript();
    fake.queue.set("s1", [makeItem("q-1", "run-1")]);
    const poll = createRunAdjustmentPoller("s1", "run-1", fake.store, transcript.port);

    await poll();
    expect(poll()).toBeUndefined();
    expect(fake.commits).toHaveLength(1);
    expect(transcript.calls).toHaveLength(1);
  });
});
