import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ConversationTranscriptStore } from "./conversation-transcript-store";
import {
  buildFullModelContext,
  buildModelContext,
  materializeTranscript,
  resolveTranscriptRetainTokens,
  type TranscriptRunReader,
} from "./conversation-transcript-context";
import { prepareTranscriptDispatch } from "./conversation-transcript-coordinator";
import { createTranscriptSink } from "./transcript-sink";
import type { TranscriptAppendInput, TranscriptEntry } from "./conversation-transcript-types";
import type { HarnessRunSession } from "./harness/run-store";
import type { ChatMessage, ToolCall } from "./vendors/types";

// ── 条目工厂：每条目一行，seq 单调递增 ──────────────────────

function createEntries() {
  let seq = 0;
  const next = () => (seq += 1);
  return {
    user: (id: string, turnId: string, revision: number, text: string): TranscriptEntry =>
      ({ seq: next(), id, at: 1_000, kind: "user", turnId, revision, payload: { text } }),
    assistant: (id: string, content: string): TranscriptEntry =>
      ({ seq: next(), id, at: 1_000, kind: "assistant", payload: { role: "assistant", content } }),
    assistantWithCalls: (id: string, calls: ToolCall[], runId?: string): TranscriptEntry =>
      ({
        seq: next(), id, at: 1_000, kind: "assistant", runId,
        payload: { role: "assistant", content: "calling", toolCalls: calls },
      }),
    toolResult: (
      id: string, assistantEntryId: string, toolCallId: string,
      message: ChatMessage, runId?: string,
    ): TranscriptEntry =>
      ({
        seq: next(), id, at: 1_000, kind: "tool_result", runId,
        payload: { assistantEntryId, toolCallId, outcome: "success", message },
      }),
    replaceUser: (id: string, turnId: string, revision: number, text: string): TranscriptEntry =>
      ({
        seq: next(), id, at: 1_000, kind: "turn_rewind", turnId, revision,
        payload: {
          anchorUserTurnId: turnId, disposition: "replace_user", reason: "edit",
          replacementUser: { text },
        },
      }),
  };
}

const noRuns: TranscriptRunReader = { get: () => null };

/** 从物化消息里取某个工具调用的合成 outcome。 */
function outcomeFor(messages: ChatMessage[], toolCallId: string): string {
  const message = messages.find((item) => item.role === "tool" && item.toolCallId === toolCallId);
  return JSON.parse(String(message?.content)).outcome;
}

// ── 活动视图与 rewind 语义 ─────────────────────────────────

describe("materializeTranscript", () => {
  it("exposes the split canonical materializer without presentation fields", () => {
    const e = createEntries();
    const entries: TranscriptEntry[] = [
      e.user("u1", "turn-1", 1, "canonical"),
      ({
        seq: 2, id: "patch-1", at: 1_000, kind: "presentation_patch",
        payload: { messageId: "u1", patchRevision: 1, patch: { content: "rendered" } },
      }),
    ];
    expect(buildFullModelContext(entries, noRuns).messages).toEqual([
      { role: "user", content: "canonical" },
    ]);
  });

  it("applies repeated replace_user against the highest active revision", () => {
    const e = createEntries();
    const active = materializeTranscript([
      e.user("u1-r1", "turn-1", 1, "first"),
      e.assistant("a1", "old answer"),
      e.replaceUser("rw1", "turn-1", 2, "second"),
      e.assistant("a2", "second answer"),
      e.replaceUser("rw2", "turn-1", 3, "third"),
    ], noRuns);
    expect(active.messages.filter((message) => message.role === "user"))
      .toEqual([{ role: "user", content: "third" }]);
    expect(active.messages.some((message) => message.content === "old answer")).toBe(false);
  });

  it("replays the original canonical tool message instead of rebuilding it from preview", () => {
    const e = createEntries();
    const toolMessage: ChatMessage = {
      role: "tool",
      toolCallId: "call-1",
      name: "ask_user",
      content: JSON.stringify({ outcome: "success", output: { answers: ["完整答案"] } }),
    };
    const built = materializeTranscript([
      e.assistantWithCalls("a1", [{ id: "call-1", name: "ask_user", arguments: "{}" }]),
      e.toolResult("tr1", "a1", "call-1", toolMessage),
    ], noRuns);
    expect(built.messages).toEqual([expect.objectContaining({ role: "assistant" }), toolMessage]);
  });

  it("classifies started non-idempotent as unknown and absent queued call as not_executed", () => {
    const e = createEntries();
    const runReader: TranscriptRunReader = {
      get: () => ({
        toolCalls: [{
          toolCallId: "mail-1",
          toolName: "send_email",
          sideEffect: "non_idempotent_side_effect",
          status: "started",
          updatedAt: 2,
        }],
      }) as HarnessRunSession,
    };
    const built = materializeTranscript([
      e.assistantWithCalls("a1", [
        { id: "mail-1", name: "send_email", arguments: '{"to":"a@example.com"}' },
        { id: "read-1", name: "read_file", arguments: '{"path":"a.txt"}' },
      ], "run-1"),
    ], runReader);
    expect(outcomeFor(built.messages, "mail-1")).toBe("unknown");
    expect(outcomeFor(built.messages, "read-1")).toBe("not_executed");
    expect(built.uncertainEffects).toEqual([expect.objectContaining({ toolCallId: "mail-1" })]);
  });

  it("treats a read-only started orphan as unknown without uncertain effects", () => {
    const e = createEntries();
    const runReader: TranscriptRunReader = {
      get: () => ({
        toolCalls: [{
          toolCallId: "read-1",
          toolName: "read_file",
          sideEffect: "read_only",
          status: "started",
          updatedAt: 2,
        }],
      }) as HarnessRunSession,
    };
    const built = materializeTranscript([
      e.assistantWithCalls("a1", [{ id: "read-1", name: "read_file", arguments: "{}" }], "run-1"),
    ], runReader);
    expect(outcomeFor(built.messages, "read-1")).toBe("unknown");
    expect(built.uncertainEffects).toEqual([]);
  });
});

// ── 读取路径与 token 尾窗 ─────────────────────────────────

describe("buildModelContext", () => {
  const roots: string[] = [];

  function createStore() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "cyrene-transcript-ctx-"));
    roots.push(root);
    return { root, store: new ConversationTranscriptStore(root, { now: () => 1_000 }) };
  }

  afterEach(() => {
    for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
  });

  it("cuts only after materialization and preserves every tool declaration/result pair", async () => {
    const { store } = createStore();
    let seq = 0;
    const at = 1_000;
    const calls = [
      { id: "call-a", name: "read_file", arguments: "{}" },
      { id: "call-b", name: "read_file", arguments: "{}" },
    ];
    await store.append("c1", { id: `e${++seq}`, at, kind: "user", turnId: "u1", revision: 1, payload: { text: "旧任务背景".repeat(40) } });
    await store.append("c1", { id: `e${++seq}`, at, kind: "assistant", payload: { role: "assistant", content: "旧回答".repeat(40) } });
    await store.append("c1", { id: `e${++seq}`, at, kind: "user", turnId: "u2", revision: 1, payload: { text: "中间问题".repeat(40) } });
    await store.append("c1", { id: "e${++seq}", at, kind: "assistant", payload: { role: "assistant", content: "中间回答".repeat(40) } });
    await store.append("c1", { id: "a-tool", at, kind: "assistant", runId: "run-1", payload: { role: "assistant", content: "读两个文件", toolCalls: calls } });
    await store.append("c1", { id: "tr-a", at, kind: "tool_result", runId: "run-1", payload: { assistantEntryId: "a-tool", toolCallId: "call-a", outcome: "success", message: { role: "tool", toolCallId: "call-a", name: "read_file", content: "文件 A 内容" } } });
    await store.append("c1", { id: "tr-b", at, kind: "tool_result", runId: "run-1", payload: { assistantEntryId: "a-tool", toolCallId: "call-b", outcome: "success", message: { role: "tool", toolCallId: "call-b", name: "read_file", content: "文件 B 内容" } } });
    await store.append("c1", { id: `e${++seq}`, at, kind: "user", turnId: "u3", revision: 1, payload: { text: "最终问题" } });

    const result = await buildModelContext({
      store, conversationId: "c1", retainTokens: 30, runReader: noRuns,
    });

    // 保留的每个 tool 消息必须能在保留窗口内找到其 assistant 声明（配对不被拆开）
    for (const message of result.messages.filter((item) => item.role === "tool")) {
      expect(result.messages.some((item) => item.role === "assistant"
        && item.toolCalls?.some((call) => call.id === message.toolCallId))).toBe(true);
    }
    // 尾窗必须包含最新 user
    expect(result.messages.some((item) => item.role === "user" && item.content === "最终问题")).toBe(true);
  });

  it("returns the complete active view instead of silently dropping the old prefix", async () => {
    const { store } = createStore();
    await store.append("c1", {
      id: "old", at: 1_000, kind: "user", turnId: "old", revision: 1,
      payload: { text: "必须保留的旧上下文" },
    });
    await store.append("c1", {
      id: "new", at: 1_000, kind: "user", turnId: "new", revision: 1,
      payload: { text: "最新问题" },
    });

    const result = await buildModelContext({ store, conversationId: "c1", retainTokens: 1, runReader: noRuns });
    expect(result.messages.map((message) => message.content)).toEqual(["必须保留的旧上下文", "最新问题"]);
  });
});

// ── 预算计算 ─────────────────────────────────────────────

describe("resolveTranscriptRetainTokens", () => {
  it("derives the retain window from the harness budget constants", () => {
    expect(resolveTranscriptRetainTokens(256_000))
      .toBe(Math.floor((256_000 - 8_192 - 512) * 0.7));
    expect(resolveTranscriptRetainTokens(0)).toBe(1);
  });
});

// ── 完整失败矩阵：每个轨迹写入断点的 fail-closed 语义（CTA Phase 1 验收）──

describe("transcript failure matrix", () => {
  const roots: string[] = [];

  afterEach(() => {
    for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
  });

  /** 按条目 kind 注入 append 失败的 store 视图（只覆盖协议用到的方法）。 */
  function withRejectedKinds(store: ConversationTranscriptStore, kinds: TranscriptEntry["kind"][]) {
    const rejected = new Set<string>(kinds);
    return {
      append: (conversationId: string, input: TranscriptAppendInput) =>
        rejected.has(input.kind)
          ? Promise.reject(new Error(`injected ${input.kind} failure`))
          : store.append(conversationId, input),
      read: (conversationId: string) => store.read(conversationId),
      checkpoint: (conversationId: string) => store.checkpoint(conversationId),
      waitForIdle: (conversationId: string) => store.waitForIdle(conversationId),
    } as unknown as ConversationTranscriptStore;
  }

  it("每个轨迹写入断点失败时保持各自的 fail-closed 语义", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "cyrene-transcript-matrix-"));
    roots.push(root);
    const store = new ConversationTranscriptStore(root, { now: () => 1_000 });
    const conversationId = "c-matrix";
    const session = {
      id: conversationId,
      messages: [{ id: "u1", role: "user", content: "问题", at: 1 }],
    } as unknown as Parameters<typeof prepareTranscriptDispatch>[0]["session"];
    const matrix: Record<string, string> = {};

    // userWrite：dispatch 前 user 落盘失败 → 协议上抛，模型不启动
    try {
      await prepareTranscriptDispatch({
        store: withRejectedKinds(store, ["user"]),
        session, userTurnId: "u1", runId: "run-x",
      });
      matrix.userWrite = "unexpected_success";
    } catch {
      matrix.userWrite = "model_not_started";
    }

    // rewindWrite：turn_rewind 落盘失败 → 同一 fail-closed 断点
    try {
      await prepareTranscriptDispatch({
        store: withRejectedKinds(store, ["turn_rewind"]),
        session, userTurnId: "u1", runId: "run-x",
        rewind: { anchorUserTurnId: "u1", disposition: "replace_user" },
      });
      matrix.rewindWrite = "unexpected_success";
    } catch {
      matrix.rewindWrite = "model_not_started";
    }

    // assistantWrite：assistant 声明落盘失败 → sink 上抛，工具不启动
    try {
      await createTranscriptSink({ store: withRejectedKinds(store, ["assistant"]), conversationId, runId: "run-a" })
        .appendAssistant({ message: { role: "assistant", content: "calling" } });
      matrix.assistantWrite = "unexpected_success";
    } catch {
      matrix.assistantWrite = "tool_not_started";
    }

    // toolResultWrite：canonical 工具结果落盘失败 → 上抛，下一次模型请求被阻断
    const anchorSink = createTranscriptSink({ store, conversationId, runId: "run-b" });
    const anchorEntryId = await anchorSink.appendAssistant({
      message: {
        role: "assistant", content: "calling",
        toolCalls: [{ id: "call-1", name: "read_file", arguments: "{}" }],
      },
    });
    try {
      await createTranscriptSink({ store: withRejectedKinds(store, ["tool_result"]), conversationId, runId: "run-b" })
        .appendToolResult({
          assistantEntryId: anchorEntryId,
          message: { role: "tool", toolCallId: "call-1", name: "read_file", content: "文件内容" },
          outcome: "success",
        });
      matrix.toolResultWrite = "unexpected_success";
    } catch {
      matrix.toolResultWrite = "next_model_request_blocked";
    }

    // interruptionWrite：取消闭合落盘失败 → 读侧孤儿分类兜底修复
    try {
      await createTranscriptSink({ store: withRejectedKinds(store, ["interruption"]), conversationId, runId: "run-c" })
        .closeInterruption({ reason: "user_cancel", runSession: null });
      matrix.interruptionWrite = "unexpected_success";
    } catch {
      matrix.interruptionWrite = "read_side_orphan_repair_required";
    }

    // readDuringPendingWrite：写入队列未排空时读取 → 排队等待后读到一致状态
    const pendingAppend = store.append(conversationId, {
      id: "pending-user", at: 1, kind: "user", turnId: "u9", revision: 1, payload: { text: "并发写入" },
    });
    const readDuringWrite = await store.read(conversationId);
    matrix.readDuringPendingWrite = readDuringWrite.entries.some((entry) => entry.id === "pending-user")
      ? "waited_for_queue"
      : "read_raced_ahead";
    await pendingAppend;

    expect(matrix).toEqual({
      userWrite: "model_not_started",
      rewindWrite: "model_not_started",
      assistantWrite: "tool_not_started",
      toolResultWrite: "next_model_request_blocked",
      interruptionWrite: "read_side_orphan_repair_required",
      readDuringPendingWrite: "waited_for_queue",
    });
  });
});
