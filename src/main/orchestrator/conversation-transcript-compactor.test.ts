import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ConversationTranscriptCompactor } from "./conversation-transcript-compactor";
import { ConversationTranscriptArchive } from "./conversation-transcript-archive";
import { ConversationJournalService } from "./conversation-journal-service";
import { ConversationTranscriptStore } from "./conversation-transcript-store";
import type { ChatMessage } from "./vendors/types";

function assertNoOrphanToolPairs(messages: ChatMessage[]): boolean {
  const calls = new Set(messages.flatMap((message) =>
    message.role === "assistant" ? (message.toolCalls ?? []).map((call) => call.id) : []));
  return messages.every((message) => message.role !== "tool" || calls.has(message.toolCallId ?? ""));
}

describe("ConversationTranscriptCompactor", () => {
  const roots: string[] = [];

  function createFixture() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "cyrene-transcript-compactor-"));
    roots.push(root);
    const store = new ConversationTranscriptStore(root, { now: () => 1_000 });
    const journal = new ConversationJournalService(store);
    let releaseSummary!: (value: string) => void;
    let shouldReject = false;
    let paused = false;
    const summarize = async () => {
      if (shouldReject) throw new Error("provider down");
      if (!paused) return "保留的摘要";
      return new Promise<string>((resolve, reject) => {
        releaseSummary = resolve;
        void reject;
      });
    };
    const compactor = new ConversationTranscriptCompactor({ store, summarize });
    return {
      store,
      journal,
      compactor,
      pause: () => { paused = true; },
      resume: (summary: string) => releaseSummary(summary),
      reject: () => { shouldReject = true; },
    };
  }

  afterEach(() => {
    for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
  });

  async function seed(fixture: ReturnType<typeof createFixture>) {
    await fixture.journal.appendUser("c1", { turnId: "u1", id: "u1", text: "旧任务".repeat(20) });
    const sink = fixture.journal.createRunSink({ conversationId: "c1", runId: "run-1" });
    const assistantEntryId = await sink.appendAssistant({
      message: {
        role: "assistant",
        content: "读取文件",
        toolCalls: [{ id: "call-1", name: "read_file", arguments: "{}" }],
      },
    });
    await sink.appendToolResult({
      assistantEntryId,
      message: { role: "tool", toolCallId: "call-1", name: "read_file", content: "文件内容" },
      outcome: "success",
    });
    await fixture.journal.appendUser("c1", { turnId: "u2", id: "u2", text: "最新问题" });
  }

  it("压缩边界不切断 assistant tool call 与 tool result", async () => {
    const fixture = createFixture();
    await seed(fixture);

    const result = await fixture.compactor.compact({
      conversationId: "c1",
      trigger: "manual",
      retainTokens: 1,
    });

    expect(assertNoOrphanToolPairs(result.compactedMessages)).toBe(true);
    expect(result.checkpointEntryId).toBeTruthy();
  });

  it("摘要期间的新后缀不进入 sourceThroughSeq 也不丢失", async () => {
    const fixture = createFixture();
    await seed(fixture);
    fixture.pause();
    const pending = fixture.compactor.compact({ conversationId: "c1", trigger: "automatic", retainTokens: 1 });
    await fixture.journal.appendUser("c1", { turnId: "u-new", id: "u-new", text: "arrived during summary" });
    fixture.resume("summary");
    const result = await pending;

    const context = await fixture.journal.buildModelContext("c1");
    expect(context.messages.at(-1)?.content).toBe("arrived during summary");
    expect(result.sourceThroughSeq).toBeLessThan((await fixture.store.read("c1")).throughSeq);
  });

  it("摘要失败时不追加 checkpoint 且旧上下文完整", async () => {
    const fixture = createFixture();
    await seed(fixture);
    const original = (await fixture.store.read("c1")).entries;
    fixture.reject(new Error("provider down"));
    const pending = fixture.compactor.compact({ conversationId: "c1", trigger: "manual", retainTokens: 1 });

    await expect(pending).rejects.toThrow("TRANSCRIPT_COMPACTION_REQUIRED");
    const entries = (await fixture.store.read("c1")).entries;
    expect(entries).toEqual(original);
    expect(entries.some((entry) => entry.kind === "compaction_checkpoint")).toBe(false);
  });

  it("没有安全切点时显式要求 TRANSCRIPT_COMPACTION_REQUIRED 且不写 checkpoint", async () => {
    const fixture = createFixture();
    await seed(fixture);
    const original = (await fixture.store.read("c1")).entries;

    await expect(fixture.compactor.compact({
      conversationId: "c1", trigger: "automatic", retainTokens: 1_000_000,
    })).rejects.toThrow("TRANSCRIPT_COMPACTION_REQUIRED");
    expect((await fixture.store.read("c1")).entries).toEqual(original);
  });

  it("并发 compaction 只允许一个 checkpoint 通过 CAS", async () => {
    const fixture = createFixture();
    await seed(fixture);
    let release!: (summary: string) => void;
    const gate = new Promise<string>((resolve) => { release = resolve; });
    const first = new ConversationTranscriptCompactor({ store: fixture.store, summarize: async () => gate });
    const second = new ConversationTranscriptCompactor({ store: fixture.store, summarize: async () => gate });
    const a = first.compact({ conversationId: "c1", trigger: "automatic", retainTokens: 1 });
    const b = second.compact({ conversationId: "c1", trigger: "automatic", retainTokens: 1 });
    release("summary");

    const results = await Promise.allSettled([a, b]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.find((result) => result.status === "rejected")).toEqual(
      expect.objectContaining({ reason: expect.objectContaining({ message: "TRANSCRIPT_COMPACTION_REQUIRED" }) }),
    );
    expect((await fixture.store.read("c1")).entries.filter((entry) => entry.kind === "compaction_checkpoint")).toHaveLength(1);
  });

  it("按活动分支 source seq 压缩同文本 replace_user，且模型上下文命中 checkpoint", async () => {
    const fixture = createFixture();
    await fixture.store.append("c1", {
      id: "u-old", at: 1, kind: "user", turnId: "turn-1", revision: 1,
      payload: { text: "相同文本".repeat(20) },
    });
    await fixture.store.append("c1", {
      id: "a-old", at: 1, kind: "assistant", payload: { role: "assistant", content: "旧回答".repeat(20) },
    });
    await fixture.store.append("c1", {
      id: "rewind", at: 1, kind: "turn_rewind", turnId: "turn-1", revision: 2,
      payload: {
        anchorUserTurnId: "turn-1", disposition: "replace_user", reason: "edit",
        replacementUser: { text: "相同文本".repeat(20) },
      },
    });
    await fixture.store.append("c1", {
      id: "a-new", at: 1, kind: "assistant", payload: { role: "assistant", content: "新回答".repeat(20) },
    });
    await fixture.store.append("c1", {
      id: "u-latest", at: 1, kind: "user", turnId: "turn-2", revision: 1,
      payload: { text: "最新问题" },
    });

    const branchCompactor = new ConversationTranscriptCompactor({ store: fixture.store, summarize: async () => "x" });
    const result = await branchCompactor.compact({ conversationId: "c1", trigger: "automatic", retainTokens: 50 });
    expect(result.sourceThroughSeq).toBe(3);
    expect(result.compactedMessages[0]?.content).toContain("<cyrene_compaction_checkpoint>");
    expect((await fixture.journal.buildModelContext("c1")).messages.map((message) => message.content))
      .toEqual([expect.stringContaining("<cyrene_compaction_checkpoint>"), "新回答".repeat(20), "最新问题"]);
  });

  it("checkpoint durable 后 archive IO 失败只隔离归档且压缩仍成功", async () => {
    const fixture = createFixture();
    await seed(fixture);
    const archive = new ConversationTranscriptArchive(fixture.store);
    vi.spyOn(archive, "archiveThrough").mockRejectedValue(new Error("ARCHIVE_IO_FAILURE"));
    const compactor = new ConversationTranscriptCompactor({
      store: fixture.store,
      summarize: async () => "summary",
      archive,
    });
    const result = await compactor.compact({ conversationId: "c1", trigger: "automatic", retainTokens: 1 });
    expect(result.checkpointEntryId).toBeTruthy();
    expect((await fixture.journal.buildModelContext("c1")).messages[0]?.content)
      .toContain("<cyrene_compaction_checkpoint>");
  });

  it("第一次压缩归档后仍可按热分支完成第二次压缩", async () => {
    const fixture = createFixture();
    await seed(fixture);
    await fixture.compactor.compact({ conversationId: "c1", trigger: "manual", retainTokens: 1 });
    await fixture.journal.appendUser("c1", { turnId: "u3", id: "u3", text: "第二轮问题".repeat(30) });
    await fixture.journal.appendUser("c1", { turnId: "u4", id: "u4", text: "第三轮问题".repeat(30) });
    // 记录每次摘要输入，验证二次压缩不会静默丢弃第一次摘要
    const summarizeInputs: string[] = [];
    const recordingCompactor = new ConversationTranscriptCompactor({
      store: fixture.store,
      summarize: async (history) => {
        summarizeInputs.push(history.map((message) => String(message.content ?? "")).join("\n"));
        return "二次摘要";
      },
    });
    const second = await recordingCompactor.compact({ conversationId: "c1", trigger: "manual", retainTokens: 1 });
    expect(second.checkpointEntryId).toBeTruthy();
    // 第二次摘要输入必须包含第一次摘要文本：旧摘要代表的历史不能从模型视图消失
    expect(summarizeInputs.at(-1)).toContain("保留的摘要");
    const finalContext = await fixture.journal.buildModelContext("c1");
    expect(finalContext.messages[0]?.content).toContain("<cyrene_compaction_checkpoint>");
    expect(finalContext.messages[0]?.content).toContain("二次摘要");
  });
});
