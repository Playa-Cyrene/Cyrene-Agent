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
    const model = buildFullModelContext([assistantEntry, receipt], noRuns);
    expect(model.messages).toHaveLength(2);
    expect(model.messages[0]).toEqual(assistantEntry.payload);
    expect(model.messages[1]).toEqual(expect.objectContaining({ role: "system", internal: expect.any(Object) }));
  });
});
