import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ConversationTranscriptCompactor } from "./conversation-transcript-compactor";
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

    await expect(pending).rejects.toThrow("provider down");
    const entries = (await fixture.store.read("c1")).entries;
    expect(entries).toEqual(original);
    expect(entries.some((entry) => entry.kind === "compaction_checkpoint")).toBe(false);
  });
});
