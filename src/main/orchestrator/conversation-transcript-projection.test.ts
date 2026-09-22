import { describe, expect, it } from "vitest";
import {
  buildFullModelContext,
  buildModelContextFromCompactedView,
  reduceTranscriptProjection,
  type TranscriptRunReader,
} from "./conversation-transcript-projection";
import type { TranscriptEntry } from "./conversation-transcript-types";
import type { ToolCall } from "./vendors/types";

let nextSeq = 0;
const noRuns: TranscriptRunReader = { get: () => null };

function user(turnId: string, content: string): TranscriptEntry {
  const seq = ++nextSeq;
  return { seq, id: `user-${seq}`, at: seq, kind: "user", turnId, revision: 1, payload: { text: content } };
}

function assistant(
  assistantTurnId: string,
  content: string,
  toolCalls?: ToolCall[],
  runId?: string,
): TranscriptEntry {
  const seq = ++nextSeq;
  return {
    seq,
    id: `assistant-${seq}`,
    at: seq,
    kind: "assistant",
    turnId: assistantTurnId,
    ...(runId ? { runId } : {}),
    payload: { role: "assistant", content, ...(toolCalls ? { toolCalls } : {}) },
  };
}

function patch(messageId: string, patchRevision: number, content: string): TranscriptEntry {
  const seq = ++nextSeq;
  return {
    seq,
    id: `patch-${seq}`,
    at: seq,
    kind: "presentation_patch",
    payload: { messageId, patchRevision, patch: { content } },
  };
}

function tombstone(targetUserTurnId: string): TranscriptEntry {
  const seq = ++nextSeq;
  return {
    seq,
    id: `tombstone-${seq}`,
    at: seq,
    kind: "turn_tombstone",
    payload: { targetUserTurnId, reason: "pending_withdrawn" },
  };
}

function compactedFixture(): TranscriptEntry[] {
  const entries: TranscriptEntry[] = [
    user("u1", "old user"),
    assistant("a1", "old answer"),
  ];
  const checkpointSeq = ++nextSeq;
  entries.push({
    seq: checkpointSeq,
    id: "checkpoint-1",
    at: checkpointSeq,
    kind: "compaction_checkpoint",
    payload: {
      baseThroughSeq: 0,
      sourceThroughSeq: checkpointSeq - 1,
      sourceDigest: "digest",
      replacement: { role: "system", content: "summary" },
      trigger: "automatic",
    },
  });
  entries.push(user("u2", "recent user"), assistant("a2", "recent answer"));
  return entries;
}

describe("conversation transcript projection", () => {
  it("墓碑移除目标 user 及其尾部但不删除更早 UI 历史", () => {
    nextSeq = 0;
    const result = reduceTranscriptProjection([
      user("u1", "first"), assistant("a1", "answer"),
      user("u2", "ghost"), tombstone("u2"),
    ]);
    expect(result.messages.map((item) => item.id)).toEqual(["user-1", "a1"]);
  });

  it("展示补丁不能改写 canonical 模型正文", () => {
    nextSeq = 0;
    const entries = [user("u1", "hello"), patch("user-1", 1, "rendered")];
    expect(reduceTranscriptProjection(entries).messages[0].content).toBe("rendered");
    expect(buildFullModelContext(entries, noRuns).messages[0].content).toBe("hello");
  });

  it("最新压缩点替换模型前缀但 UI 仍保留完整历史", () => {
    nextSeq = 0;
    const entries = compactedFixture();
    expect(buildModelContextFromCompactedView(entries, noRuns).messages.map((m) => m.content))
      .toEqual(["summary", "recent user", "recent answer"]);
    expect(reduceTranscriptProjection(entries).messages).toHaveLength(4);
  });

  it.each([
    ["rewind", "keep_user"],
    ["tombstone", "tombstone"],
  ] as const)("discards a compaction checkpoint invalidated by a later %s", (_name, mutation) => {
    nextSeq = 0;
    const entries: TranscriptEntry[] = [
      user("u1", "first"),
      assistant("a1", "answer"),
      user("u2", "second"),
      assistant("a2", "second answer"),
    ];
    const checkpointSeq = ++nextSeq;
    entries.push({
      seq: checkpointSeq,
      id: "checkpoint-1",
      at: checkpointSeq,
      kind: "compaction_checkpoint",
      payload: {
        baseThroughSeq: 0,
        sourceThroughSeq: checkpointSeq - 1,
        sourceDigest: "digest",
        replacement: { role: "system", content: "stale summary" },
        trigger: "automatic",
      },
    });
    const mutationSeq = ++nextSeq;
    entries.push(mutation === "keep_user"
      ? {
        seq: mutationSeq,
        id: "rewind-1",
        at: mutationSeq,
        kind: "turn_rewind",
        turnId: "u1",
        payload: { anchorUserTurnId: "u1", disposition: "keep_user", reason: "regenerate" },
      }
      : {
        seq: mutationSeq,
        id: "tombstone-1",
        at: mutationSeq,
        kind: "turn_tombstone",
        payload: { targetUserTurnId: "u2", reason: "pending_withdrawn" },
      });
    expect(buildModelContextFromCompactedView(entries, noRuns).messages.map((message) => message.content))
      .toEqual(mutation === "keep_user" ? ["first"] : ["first", "answer"]);
  });

  it("compaction keeps uncertain effects from the compacted canonical prefix", () => {
    nextSeq = 0;
    const oldCall = assistant("a1", "send", [{ id: "mail-1", name: "send_email", arguments: "{}" }], "run-1");
    const checkpointSeq = ++nextSeq;
    const entries: TranscriptEntry[] = [
      oldCall,
      {
        seq: checkpointSeq,
        id: "checkpoint-1",
        at: checkpointSeq,
        kind: "compaction_checkpoint",
        payload: {
          baseThroughSeq: 0,
          sourceThroughSeq: checkpointSeq - 1,
          sourceDigest: "digest",
          replacement: { role: "system", content: "summary" },
          trigger: "automatic",
        },
      },
    ];
    const runReader: TranscriptRunReader = {
      get: () => ({
        toolCalls: [{
          toolCallId: "mail-1", toolName: "send_email", sideEffect: "non_idempotent_side_effect",
          status: "started", updatedAt: 1,
        }],
      }),
    };
    expect(buildFullModelContext(entries, runReader).uncertainEffects)
      .toEqual([expect.objectContaining({ toolCallId: "mail-1" })]);
    expect(buildModelContextFromCompactedView(entries, runReader).uncertainEffects)
      .toEqual([expect.objectContaining({ toolCallId: "mail-1" })]);
  });

  it("同一 assistant turn 的 assistant/tool rounds 合并为一条 UI 消息", () => {
    nextSeq = 0;
    const entries: TranscriptEntry[] = [
      user("u1", "question"),
      assistant("a1", "first", [{ id: "call-1", name: "read_file", arguments: "{}" }]),
      {
        seq: ++nextSeq,
        id: "tool-1",
        at: nextSeq,
        kind: "tool_result",
        payload: {
          assistantEntryId: "assistant-2",
          toolCallId: "call-1",
          outcome: "success",
          message: { role: "tool", toolCallId: "call-1", name: "read_file", content: "result" },
        },
      },
      assistant("a1", "second"),
    ];
    const result = reduceTranscriptProjection(entries);
    expect(result.messages.filter((item) => item.id === "a1")).toHaveLength(1);
    expect(result.messages[1].content).toBe("second");
  });

  it("buffers a presentation patch until its canonical target exists and keeps the newest revision", () => {
    nextSeq = 0;
    const entries: TranscriptEntry[] = [
      patch("late", 2, "new"),
      patch("late", 1, "old"),
      { seq: ++nextSeq, id: "late", at: nextSeq, kind: "assistant", turnId: "a1", payload: { role: "assistant", content: "canonical" } },
    ];
    expect(reduceTranscriptProjection(entries).messages[0].content).toBe("new");
  });

  it("continues from a projection seed without duplicating previously materialized messages", () => {
    nextSeq = 0;
    const first = user("u1", "first");
    const seed = reduceTranscriptProjection([first]);
    const second = assistant("a1", "answer");
    expect(reduceTranscriptProjection([second], seed).messages.map((item) => item.content))
      .toEqual(["first", "answer"]);
  });

  it("does not let a post-seed older patch revision overwrite revision five", () => {
    nextSeq = 0;
    const first = user("u1", "first");
    const seed = reduceTranscriptProjection([first, patch("user-1", 5, "revision five")]);
    const olderPatch = patch("user-1", 4, "revision four");
    expect(reduceTranscriptProjection([olderPatch], seed).messages[0].content).toBe("revision five");
  });

  it("keeps a patch-before-canonical pending across a seed boundary", () => {
    nextSeq = 0;
    const pending = patch("late", 2, "pending display");
    const seed = reduceTranscriptProjection([pending]);
    const canonical: TranscriptEntry = {
      seq: ++nextSeq,
      id: "late",
      at: nextSeq,
      kind: "assistant",
      turnId: "a1",
      payload: { role: "assistant", content: "canonical" },
    };
    expect(reduceTranscriptProjection([canonical], seed).messages[0].content).toBe("pending display");
  });

  it("delivery receipt failure adds an internal context note without changing history", () => {
    nextSeq = 0;
    const assistantEntry = assistant("a1", "answer");
    const receiptSeq = ++nextSeq;
    const receipt: TranscriptEntry = {
      seq: receiptSeq,
      id: "receipt-1",
      at: receiptSeq,
      kind: "delivery_receipt",
      payload: { assistantTurnId: "a1", channel: "wechat", status: "failed", errorCode: "OFFLINE" },
    };
    const nextUser = user("u2", "retry");
    const model = buildFullModelContext([assistantEntry, receipt, nextUser], noRuns);
    expect(model.messages).toHaveLength(3);
    expect(model.messages[0]).toEqual(assistantEntry.payload);
    expect(model.messages[1]).toEqual(expect.objectContaining({ role: "system", internal: expect.any(Object) }));
    expect(model.messages[2]).toEqual({ role: "user", content: "retry" });
  });

  it("delivery receipt uses latest-wins and consumes the failure before the next user once", () => {
    const entries: TranscriptEntry[] = [
      user("u1", "question"),
      assistant("a1", "answer"),
      {
        seq: 3, id: "receipt-a1-r1", at: 3, kind: "delivery_receipt",
        revision: 1,
        payload: { assistantTurnId: "a1", channel: "wechat", status: "failed", errorCode: "DELIVERY_UNCONFIRMED" },
      },
      user("u2", "next"),
      assistant("a2", "second answer"),
      {
        seq: 6, id: "receipt-a2-r2", at: 6, kind: "delivery_receipt",
        revision: 2,
        payload: { assistantTurnId: "a2", channel: "wechat", status: "delivered" },
      },
      user("u3", "third"),
    ];
    const model = buildFullModelContext(entries, noRuns);
    const systemMessages = model.messages.filter((message) => message.role === "system");
    expect(systemMessages).toHaveLength(0);

    const beforeSecondReply = buildFullModelContext(entries.slice(0, 4), noRuns);
    const beforeSecondSystem = beforeSecondReply.messages.filter((message) => message.role === "system");
    expect(beforeSecondSystem).toHaveLength(1);
    expect(beforeSecondReply.messages.findIndex((message) => message.role === "system"))
      .toBeLessThan(beforeSecondReply.messages.findIndex((message) => message.content === "next"));
  });

  it("同一 assistant 的多条 receipt 只保留最新 failed 状态", () => {
    const entries: TranscriptEntry[] = [
      user("u1", "question"),
      assistant("a1", "answer"),
      {
        seq: 3, id: "receipt-a1-r1", at: 3, kind: "delivery_receipt", revision: 1,
        payload: { assistantTurnId: "a1", channel: "wechat", status: "failed", errorCode: "DELIVERY_UNCONFIRMED" },
      },
      {
        seq: 4, id: "receipt-a1-r2", at: 4, kind: "delivery_receipt", revision: 2,
        payload: { assistantTurnId: "a1", channel: "wechat", status: "failed", errorCode: "OFFLINE" },
      },
      user("u2", "next"),
    ];
    const model = buildFullModelContext(entries, noRuns);
    const notes = model.messages.filter((message) => message.role === "system");
    expect(notes).toHaveLength(1);
    expect(notes[0].content).toContain("OFFLINE");
    expect(notes[0].content).not.toContain("DELIVERY_UNCONFIRMED");
  });

  it("keeps a failed receipt for an active assistant before the compaction boundary", () => {
    nextSeq = 0;
    const assistantEntry = assistant("a1", "answer");
    const checkpointSeq = ++nextSeq;
    const receiptSeq = ++nextSeq;
    const entries: TranscriptEntry[] = [
      assistantEntry,
      {
        seq: checkpointSeq,
        id: "checkpoint-1",
        at: checkpointSeq,
        kind: "compaction_checkpoint",
        payload: {
          baseThroughSeq: 0,
          sourceThroughSeq: checkpointSeq - 1,
          sourceDigest: "digest",
          replacement: { role: "system", content: "summary" },
          trigger: "automatic",
        },
      },
      {
        seq: receiptSeq,
        id: "receipt-1",
        at: receiptSeq,
        kind: "delivery_receipt",
        payload: { assistantTurnId: "a1", channel: "wechat", status: "failed" },
      },
      user("u2", "retry"),
    ];
    const model = buildModelContextFromCompactedView(entries, noRuns);
    expect(model.messages.filter((message) => message.role === "system")).toHaveLength(2);
    expect(model.messages.find((message) => message.visibility === "internal"))
      .toEqual(expect.objectContaining({ visibility: "internal" }));
  });

  it("未闭合中断注入一次性内部提示：插在中断后第一个 user 之前，文案按 reason 区分", () => {
    nextSeq = 0;
    const entries: TranscriptEntry[] = [
      user("u1", "question"),
      assistant("a1", "partial answer"),
      {
        seq: ++nextSeq,
        id: "run-1:interruption:user_cancel",
        at: nextSeq,
        kind: "interruption",
        runId: "run-1",
        payload: { reason: "user_cancel" },
      },
      user("u2", "换个方向"),
    ];
    const model = buildFullModelContext(entries, noRuns);
    const notes = model.messages.filter((message) => message.visibility === "internal");
    expect(notes).toHaveLength(1);
    expect(notes[0].content).toContain("用户主动停止");
    expect(notes[0].content).toContain("以用户最新消息为准");
    expect(notes[0].internal).toMatchObject({
      kind: "recovery",
      id: "interruption-note:run-1:interruption:user_cancel",
      runId: "run-1",
    });
    // 提示必须紧贴在「中断后第一个 user」之前
    expect(model.messages[model.messages.indexOf(notes[0]) + 1]).toEqual({ role: "user", content: "换个方向" });
  });

  it("runtime_error 中断提示使用系统失败语义", () => {
    nextSeq = 0;
    const entries: TranscriptEntry[] = [
      user("u1", "question"),
      {
        seq: ++nextSeq,
        id: "run-1:interruption:runtime_error",
        at: nextSeq,
        kind: "interruption",
        runId: "run-1",
        payload: { reason: "runtime_error" },
      },
      user("u2", "再试一次"),
    ];
    const model = buildFullModelContext(entries, noRuns);
    const notes = model.messages.filter((message) => message.visibility === "internal");
    expect(notes).toHaveLength(1);
    expect(notes[0].content).toContain("系统错误");
    expect(notes[0].content).toContain("决定是否继续");
    expect(notes[0].content).not.toContain("用户主动停止");
  });

  it("中断后的 user 产生 assistant 即闭合：后续轮次不再注入提示", () => {
    nextSeq = 0;
    const entries: TranscriptEntry[] = [
      user("u1", "question"),
      assistant("a1", "partial"),
      {
        seq: ++nextSeq,
        id: "run-1:interruption:runtime_error",
        at: nextSeq,
        kind: "interruption",
        runId: "run-1",
        payload: { reason: "runtime_error" },
      },
      user("u2", "重试"),
      assistant("a2", "complete answer"),
      user("u3", "下一个问题"),
    ];
    const model = buildFullModelContext(entries, noRuns);
    expect(model.messages.filter((message) => message.visibility === "internal")).toHaveLength(0);
  });

  it("中断前带工具调用的 assistant 不误判为闭合，取消提示仍注入", () => {
    nextSeq = 0;
    const entries: TranscriptEntry[] = [
      user("u1", "帮我发邮件"),
      assistant("a1", "正在处理", [{ id: "call-1", name: "send_email", arguments: "{}" }], "run-1"),
      {
        seq: ++nextSeq,
        id: "run-1:interruption:user_cancel",
        at: nextSeq,
        kind: "interruption",
        runId: "run-1",
        payload: { reason: "user_cancel" },
      },
      user("u2", "算了，改成先整理要点"),
    ];
    const model = buildFullModelContext(entries, noRuns);
    const notes = model.messages.filter((message) => message.visibility === "internal");
    // 中断前的 assistant（含工具调用）不算闭合证据：提示仍要注入
    expect(notes).toHaveLength(1);
    expect(notes[0].content).toContain("用户主动停止");
    expect(model.messages[model.messages.indexOf(notes[0]) + 1]).toEqual({ role: "user", content: "算了，改成先整理要点" });
  });

  it("中断后尚无新 user 时暂不注入：下一个 user 到达前的窗口保持干净", () => {
    nextSeq = 0;
    const entries: TranscriptEntry[] = [
      user("u1", "question"),
      assistant("a1", "partial"),
      {
        seq: ++nextSeq,
        id: "run-1:interruption:user_cancel",
        at: nextSeq,
        kind: "interruption",
        runId: "run-1",
        payload: { reason: "user_cancel" },
      },
    ];
    const model = buildFullModelContext(entries, noRuns);
    expect(model.messages.filter((message) => message.visibility === "internal")).toHaveLength(0);
  });

  it("applies a tombstone to seeded messages and preserves original assistant aliases", () => {
    nextSeq = 0;
    const seededEntries: TranscriptEntry[] = [
      user("u1", "first"), assistant("a1", "answer"),
      user("u2", "second"), assistant("a2", "second answer"),
    ];
    const seed = reduceTranscriptProjection(seededEntries);
    const tombstoneEntry = tombstone("u2");
    const result = reduceTranscriptProjection([tombstoneEntry], seed);
    expect(result.messages.map((message) => message.content)).toEqual(["first", "answer"]);

    const patchEntry: TranscriptEntry = {
      seq: ++nextSeq,
      id: "patch-after-seed",
      at: nextSeq,
      kind: "presentation_patch",
      payload: { messageId: "assistant-2", patchRevision: 2, patch: { content: "patched" } },
    };
    expect(reduceTranscriptProjection([patchEntry], seed).messages[1].content).toBe("patched");
  });
});
