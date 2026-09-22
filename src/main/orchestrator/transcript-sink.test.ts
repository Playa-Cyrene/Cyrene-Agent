/**
 * TranscriptSink 契约测试（CTA Phase 1 Task 4）。
 *
 * 验收不变量：
 * - appendAssistant 落盘 canonical assistant 条目并返回其 entryId；
 * - closeInterruption 只为 started（unknown）/ planned（not_executed）调用补确定性闭合，
 *   已有结果的调用不重复补写，interruption 边界恰好一条（重试幂等）。
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ConversationTranscriptStore } from "./conversation-transcript-store";
import { createTranscriptSink } from "./transcript-sink";
import type { HarnessRunSession, PersistedToolCall } from "./harness/run-store";
import type { ToolCallOutcome } from "./harness/types";
import type { ChatMessage } from "./vendors/types";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function makeStore(): ConversationTranscriptStore {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cyrene-sink-"));
  roots.push(root);
  return new ConversationTranscriptStore(root);
}

function makeRunSession(toolCalls: PersistedToolCall[]): HarnessRunSession {
  return {
    schemaVersion: 1,
    conversationId: "c1",
    runId: "run-1",
    status: "interrupted",
    messages: [],
    state: { todoItems: [], uncertainEffects: [] },
    toolOutputs: [],
    toolCalls,
    rounds: 1,
    cache: { cacheEpoch: 1, epochReason: "run_start" },
    request: {
      provider: "fake",
      model: "fake-model",
      contextWindowTokens: 100_000,
      promptFingerprint: "p",
      toolSchemaFingerprint: "t",
    },
    createdAt: 0,
    updatedAt: 0,
  };
}

/** 从轨迹读取 toolCallId → outcome 映射（只看 tool_result 条目）。 */
async function outcomes(store: ConversationTranscriptStore): Promise<Record<string, ToolCallOutcome>> {
  const snapshot = await store.read("c1");
  const map: Record<string, ToolCallOutcome> = {};
  for (const entry of snapshot.entries) {
    if (entry.kind === "tool_result") map[entry.payload.toolCallId] = entry.payload.outcome;
  }
  return map;
}

describe("TranscriptSink", () => {
  it("commits an assistant group and returns its entry id", async () => {
    const store = makeStore();
    const sink = createTranscriptSink({ store, conversationId: "c1", runId: "run-1" });
    const id = await sink.appendAssistant({
      message: {
        role: "assistant",
        content: "checking",
        toolCalls: [{ id: "call-1", name: "write_file", arguments: "{}" }],
      },
      roundId: "round-0",
    });
    expect((await store.read("c1")).entries).toContainEqual(expect.objectContaining({
      id,
      kind: "assistant",
      runId: "run-1",
      roundId: "round-0",
    }));
  });

  it("closes cancellation with unknown only for started calls", async () => {
    const store = makeStore();
    const sink = createTranscriptSink({ store, conversationId: "c1", runId: "run-1" });
    const assistantWithTwoCalls: ChatMessage = {
      role: "assistant",
      content: "checking",
      toolCalls: [
        { id: "startedCall", name: "send_email", arguments: "{}" },
        { id: "queuedCall", name: "write_file", arguments: "{}" },
      ],
    };
    await sink.appendAssistant({ message: assistantWithTwoCalls, roundId: "round-0" });
    const runSession = makeRunSession([
      { toolCallId: "startedCall", toolName: "send_email", sideEffect: "non_idempotent_side_effect", status: "started", updatedAt: 0 },
      { toolCallId: "queuedCall", toolName: "write_file", sideEffect: "idempotent_mutation", status: "planned", updatedAt: 0 },
    ]);

    await sink.closeInterruption({ reason: "user_cancel", runSession });

    expect(await outcomes(store)).toEqual({ startedCall: "unknown", queuedCall: "not_executed" });
    const entries = (await store.read("c1")).entries;
    expect(entries.filter((entry) => entry.kind === "interruption")).toHaveLength(1);

    // 确定性 entryId：不确定确认后的重试闭合不会复制合成结果或边界
    await sink.closeInterruption({ reason: "user_cancel", runSession });
    expect((await store.read("c1")).entries).toHaveLength(entries.length);
  });

  it("closes runtime_error with system-failure wording, reason kept in the boundary, retry idempotent", async () => {
    const store = makeStore();
    const sink = createTranscriptSink({ store, conversationId: "c1", runId: "run-1" });
    await sink.appendAssistant({
      message: {
        role: "assistant",
        content: "working",
        toolCalls: [
          { id: "startedCall", name: "send_email", arguments: "{}" },
          { id: "queuedCall", name: "write_file", arguments: "{}" },
        ],
      },
      roundId: "round-0",
    });
    const runSession = makeRunSession([
      { toolCallId: "startedCall", toolName: "send_email", sideEffect: "non_idempotent_side_effect", status: "started", updatedAt: 0 },
      { toolCallId: "queuedCall", toolName: "write_file", sideEffect: "idempotent_mutation", status: "planned", updatedAt: 0 },
    ]);

    await sink.closeInterruption({ reason: "runtime_error", runSession });

    expect(await outcomes(store)).toEqual({ startedCall: "unknown", queuedCall: "not_executed" });
    const entries = (await store.read("c1")).entries;
    expect(entries.filter((entry) => entry.kind === "interruption")).toEqual([
      expect.objectContaining({ payload: { reason: "runtime_error" } }),
    ]);
    // 系统错误路径的合成文案区分于取消路径（下一轮上下文可分辨两种语义）
    const toolClose = entries.find((entry) => entry.kind === "tool_result" && entry.payload.toolCallId === "startedCall");
    expect(String(toolClose?.payload.message.content)).toContain("上一轮系统错误");
    // 确定性 entryId：runtime_error 重试闭合同样幂等
    await sink.closeInterruption({ reason: "runtime_error", runSession });
    expect((await store.read("c1")).entries).toHaveLength(entries.length);
  });

  it("skips calls whose results are already committed to the transcript", async () => {
    const store = makeStore();
    const sink = createTranscriptSink({ store, conversationId: "c1", runId: "run-1" });
    const assistant = await sink.appendAssistant({
      message: {
        role: "assistant",
        content: "checking",
        toolCalls: [{ id: "doneCall", name: "write_file", arguments: "{}" }],
      },
      roundId: "round-0",
    });
    await sink.appendToolResult({
      assistantEntryId: assistant,
      message: { role: "tool", toolCallId: "doneCall", name: "write_file", content: "{\"outcome\":\"success\"}" },
      outcome: "success",
      roundId: "round-0",
    });

    // runStore 状态落后于轨迹（committed 但轨迹已闭合）：不得改写既有结果
    const runSession = makeRunSession([
      { toolCallId: "doneCall", toolName: "write_file", sideEffect: "idempotent_mutation", status: "committed", updatedAt: 0 },
    ]);
    await sink.closeInterruption({ reason: "user_cancel", runSession });

    expect(await outcomes(store)).toEqual({ doneCall: "success" });
  });
});
