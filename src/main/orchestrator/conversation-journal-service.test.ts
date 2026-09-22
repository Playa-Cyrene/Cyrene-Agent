import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ConversationJournalService,
  type JournalUserInput,
} from "./conversation-journal-service";
import { ConversationTranscriptCompactor } from "./conversation-transcript-compactor";
import {
  ConversationTranscriptStore,
  transcriptStorageKey,
} from "./conversation-transcript-store";

const roots: string[] = [];

function createJournal() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cyrene-journal-"));
  roots.push(root);
  const store = new ConversationTranscriptStore(root, { now: () => 1_000 });
  return {
    root,
    store,
    journal: new ConversationJournalService(store, { runReader: { get: () => null } }),
  };
}

function userInput(turnId: string, text: string): JournalUserInput {
  return { id: `user:${turnId}`, turnId, text, revision: 1, at: 1_000 };
}

async function corruptSnapshotProjection(root: string, conversationId: string): Promise<void> {
  const snapshotPath = path.join(
    root,
    "transcripts",
    transcriptStorageKey(conversationId),
    "snapshot.json",
  );
  const snapshot = JSON.parse(await fs.promises.readFile(snapshotPath, "utf8")) as {
    projection: unknown;
  };
  snapshot.projection = { throughSeq: "corrupt", messages: null };
  await fs.promises.writeFile(snapshotPath, JSON.stringify(snapshot), "utf8");
}

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("ConversationJournalService", () => {
  it("待发撤回先落 withdrawing，墓碑后崩溃可由重启对账完成", async () => {
    const { root, journal } = createJournal();
    await journal.appendUser("c1", userInput("p1", "hidden ghost"));
    let withdrawing = false;
    const pendingStore = {
      beginPendingWithdrawal: async () => {
        withdrawing = true;
        return { ok: true as const, withdrawalId: "withdraw:c1:p1" };
      },
      commitPendingWithdrawal: async () => {
        withdrawing = false;
        return { ok: true as const, removed: true };
      },
      listPendingWithdrawals: async () => withdrawing ? [{
        sessionId: "c1", messageId: "p1", withdrawalId: "withdraw:c1:p1",
      }] : [],
    };
    const coordinator = new ConversationJournalService({
      store: new ConversationTranscriptStore(root, { now: () => 1_000 }),
      pendingStore,
    });
    coordinator.failAfterTombstoneOnce();
    await expect(coordinator.withdrawPendingMessage("c1", "p1")).rejects.toThrow("TEST_CRASH");
    expect((await coordinator.readProjection("c1")).messages).toEqual([]);
    const reopened = new ConversationJournalService({
      store: new ConversationTranscriptStore(root, { now: () => 1_000 }),
      pendingStore,
    });
    await reopened.reconcilePendingWithdrawals();
    expect(withdrawing).toBe(false);
    expect(await reopened.withdrawPendingMessage("c1", "p1")).toEqual({ ok: true, removed: true });
  });

  it("canonical user 不存在时不预埋墓碑但仍提交 pending", async () => {
    const { root } = createJournal();
    let removed = false;
    const pendingStore = {
      beginPendingWithdrawal: () => ({ ok: true as const, withdrawalId: "withdraw:c1:p1" }),
      commitPendingWithdrawal: () => {
        removed = true;
        return { ok: true as const, removed: true };
      },
      listPendingWithdrawals: () => [],
    };
    const coordinator = new ConversationJournalService({
      store: new ConversationTranscriptStore(root, { now: () => 1_000 }),
      pendingStore,
    });
    expect(await coordinator.withdrawPendingMessage("c1", "p1")).toEqual({ ok: true, removed: true });
    expect(removed).toBe(true);
    expect((await coordinator.readProjection("c1")).messages).toEqual([]);
    expect((await new ConversationTranscriptStore(root, { now: () => 1_000 }).read("c1")).entries).toEqual([]);
  });

  it("journal 失败时保留 withdrawing，重复撤回共享确定结果", async () => {
    const { root } = createJournal();
    let begun = 0;
    let committed = 0;
    const pendingStore = {
      beginPendingWithdrawal: () => {
        begun++;
        return { ok: true as const, withdrawalId: "withdraw:c1:p1" };
      },
      commitPendingWithdrawal: () => {
        committed++;
        return { ok: true as const, removed: true };
      },
      listPendingWithdrawals: () => [],
    };
    const coordinator = new ConversationJournalService({
      store: new ConversationTranscriptStore(root, { now: () => 1_000 }),
      pendingStore,
    });
    vi.spyOn(coordinator, "withdrawUserTurn").mockRejectedValue(new Error("journal down"));
    expect(await coordinator.withdrawPendingMessage("c1", "p1")).toEqual({ ok: false, error: "write-failed" });
    expect(await Promise.all([
      coordinator.withdrawPendingMessage("c1", "p1"),
      coordinator.withdrawPendingMessage("c1", "p1"),
    ])).toEqual([
      { ok: false, error: "write-failed" },
      { ok: false, error: "write-failed" },
    ]);
    expect(begun).toBe(2);
    expect(committed).toBe(0);
  });

  it("投影快照损坏时从日志重建且模型上下文不变", async () => {
    const { root, journal } = createJournal();
    await journal.appendUser("c1", userInput("u1", "hello"));
    await journal.appendPresentation("c1", "user:u1", 1, { sticker: "calm" });
    await corruptSnapshotProjection(root, "c1");

    const reopened = new ConversationJournalService(
      new ConversationTranscriptStore(root, { now: () => 1_000 }),
      { runReader: { get: () => null } },
    );
    expect((await reopened.readProjection("c1")).messages[0].sticker).toBe("calm");
    expect((await reopened.buildModelContext("c1")).messages[0].content).toBe("hello");
  });

  it("canonical 行损坏时保持 fail-closed", async () => {
    const { root, journal } = createJournal();
    await journal.appendUser("c1", userInput("u1", "hello"));
    const jsonlPath = path.join(
      root,
      "transcripts",
      transcriptStorageKey("c1"),
      "transcript.jsonl",
    );
    await fs.promises.appendFile(jsonlPath, '{"seq":2,"id":"broken"}\nnot-json\n', "utf8");
    await expect(journal.readProjection("c1")).rejects.toThrow("TRANSCRIPT_CORRUPT_ROW");
  });

  it("展示补丁使用确定性 ID 并按投影尾部分页", async () => {
    const { journal } = createJournal();
    const user = await journal.appendUser("c1", userInput("u1", "hello"));
    const first = await journal.appendPresentation("c1", user.id, 1, { sticker: "calm" });
    const retry = await journal.appendPresentation("c1", user.id, 1, { sticker: "calm" });
    expect(retry.id).toBe(first.id);

    await journal.appendUser("c1", userInput("u2", "world"));
    const page = await journal.readProjectionPage("c1", null, 1);
    expect(page.messages.map((message) => message.content)).toEqual(["world"]);
    expect(page.hasMore).toBe(true);
    expect((await journal.readProjectionPage("c1", 1, 1)).messages[0].sticker).toBe("calm");
  });

  it("按 canonical 顺序查询渠道 turn，并按 assistant receipt revision 取最新状态", async () => {
    const { journal } = createJournal();
    await journal.appendUser("c1", userInput("u1", "hello"));
    expect(await journal.getChannelTurnState("c1", {
      userTurnId: "u1",
      assistantTurnId: "a1",
    })).toMatchObject({ userEntry: { turnId: "u1" } });

    const sink = journal.createRunSink({ conversationId: "c1", runId: "run-1", assistantTurnId: "a1" });
    await sink.appendAssistant({ message: { role: "assistant", content: "reply" } });
    expect(await journal.getChannelTurnState("c1", { userTurnId: "u1", assistantTurnId: "a1" }))
      .toMatchObject({ assistantEntry: { turnId: "a1" } });

    await journal.appendDeliveryReceipt("c1", {
      assistantTurnId: "a1", channel: "qq", status: "failed", errorCode: "DELIVERY_UNCONFIRMED", revision: 1,
    });
    await journal.appendDeliveryReceipt("c1", {
      assistantTurnId: "a1", channel: "qq", status: "delivered", revision: 2,
    });
    expect(await journal.getChannelTurnState("c1", { userTurnId: "u1", assistantTurnId: "a1" }))
      .toMatchObject({ latestReceipt: { payload: { status: "delivered", revision: 2 } } });
  });

  it("由主进程队列分配单调 presentation revision 并按 mutation key 幂等", async () => {
    const { journal } = createJournal();
    await journal.appendUser("c1", userInput("u1", "hello"));
    const first = await journal.appendPresentationNext("c1", "user:u1", "run:r1", { sticker: "calm" });
    const retry = await journal.appendPresentationNext("c1", "user:u1", "run:r1", { sticker: "calm" });
    const [tts, activity] = await Promise.all([
      journal.appendPresentationNext("c1", "user:u1", "tts:k1:v1", { ttsCacheKey: "k1", ttsCacheVersion: "v1" }),
      journal.appendPresentationNext("c1", "user:u1", "run:activity", { reasoning: "thinking" }),
    ]);
    expect(first.payload.patchRevision).toBe(1);
    expect(retry.id).toBe(first.id);
    expect([tts.payload.patchRevision, activity.payload.patchRevision].sort()).toEqual([2, 3]);
    await expect(journal.appendPresentationNext("c1", "user:u1", "run:r1", { sticker: "different" }))
      .rejects.toThrow("TRANSCRIPT_IDEMPOTENCY_CONFLICT");
    expect((await journal.readProjection("c1")).messages[0]).toMatchObject({
      sticker: "calm",
      ttsCacheKey: "k1",
      ttsCacheVersion: "v1",
      reasoning: "thinking",
    });
  });

  it("同一 store 的多个 JournalService 共享 revision 写队列", async () => {
    const { root } = createJournal();
    const store = new ConversationTranscriptStore(root, { now: () => 1_000 });
    const first = new ConversationJournalService(store);
    const second = new ConversationJournalService(store);
    await first.appendUser("c1", userInput("u1", "hello"));
    const entries = await Promise.all([
      first.appendPresentationNext("c1", "user:u1", "writer-a", { reasoning: "a" }),
      second.appendPresentationNext("c1", "user:u1", "writer-b", { reasoningBlocks: [] }),
    ]);
    expect(entries.map((entry) => entry.payload.patchRevision).sort()).toEqual([1, 2]);
    expect((await second.readProjection("c1")).messages[0]).toMatchObject({ reasoning: "a", reasoningBlocks: [] });
  });

  it("编辑/重新生成不能穿过已归档的压缩边界", async () => {
    const { store, journal } = createJournal();
    await journal.appendUser("c1", userInput("u1", "旧问题".repeat(20)));
    const sink = journal.createRunSink({ conversationId: "c1", runId: "run-1" });
    await sink.appendAssistant({ message: { role: "assistant", content: "旧回答".repeat(20) } });
    await sink.checkpoint();
    // 手动压缩并归档：u1 进入压缩前缀，热日志只剩检查点与后缀
    const compactor = new ConversationTranscriptCompactor({ store, summarize: async () => "摘要" });
    await compactor.compact({ conversationId: "c1", trigger: "manual", retainTokens: 1 });

    // UI 投影仍保留完整历史，但锚点已位于压缩边界之前：必须拒绝，
    // 否则 UI 截断旧尾部而模型视图仍保留摘要与旧回答，造成分支分裂
    await expect(journal.appendRewind("c1", {
      anchorUserTurnId: "u1", disposition: "replace_user", runId: "run-edit",
      replacementUser: { turnId: "u1", text: "编辑后的新问题" },
    })).rejects.toThrow("TRANSCRIPT_REWIND_ACROSS_COMPACTION");

    // 压缩边界之后的新 user 轮次仍可正常编辑/重新生成
    await journal.appendUser("c1", userInput("u2", "新问题"));
    const rewind = await journal.appendRewind("c1", {
      anchorUserTurnId: "u2", disposition: "keep_user", runId: "run-regenerate",
    });
    expect(rewind.kind).toBe("turn_rewind");
  });

  it("拒绝空展示补丁和未知字段而不写入轨迹", async () => {
    const { journal } = createJournal();
    await journal.appendUser("c1", userInput("u1", "hello"));
    await expect(journal.appendPresentationNext("c1", "user:u1", "bad-empty", {}))
      .rejects.toThrow("TRANSCRIPT_INVALID_PRESENTATION_PATCH");
    await expect(journal.appendPresentationNext("c1", "user:u1", "bad-field", { answersUserMessageId: "u1" } as never))
      .rejects.toThrow("TRANSCRIPT_INVALID_PRESENTATION_PATCH");
    expect((await journal.readProjection("c1")).messages[0]).toMatchObject({ content: "hello" });
  });

  it("深度校验展示字段并拒绝非法子结构", async () => {
    const { journal } = createJournal();
    await journal.appendUser("c1", userInput("u1", "hello"));
    const invalidPatches = [
      { runSnapshot: {} },
      { runSnapshot: { status: "terminal", updatedAt: "now" } },
      { toolExecutions: [null] },
      { agentRounds: [{ id: "r1", status: "unknown", startedAt: 1 }] },
      { contextUsage: { phase: "terminal", updatedAt: 1 } },
      { musicCard: { setId: "s", source: "search", tracks: [{ id: "t", name: "n", artists: [1] }] } },
      { runSnapshot: { status: "running", updatedAt: 1, runId: undefined } },
      { toolExecutions: [{ id: "tool", name: "tool", status: "running", changes: [{ file: "a", kind: "bad" }] }] },
    ];
    for (const patch of invalidPatches) {
      await expect(journal.appendPresentationNext("c1", "user:u1", `invalid:${JSON.stringify(patch)}`, patch as never))
        .rejects.toThrow("TRANSCRIPT_INVALID_PRESENTATION_PATCH");
    }
    expect((await journal.readProjection("c1")).messages[0]).toMatchObject({ content: "hello" });
  });

  it("使用绝对 before 游标分页时连续返回完整投影尾部", async () => {
    const { journal } = createJournal();
    for (let index = 1; index <= 5; index++) {
      await journal.appendUser("c1", userInput(`u${index}`, String(index)));
    }

    const first = await journal.readProjectionPage("c1", null, 2);
    const second = await journal.readProjectionPage("c1", first.nextBefore, 2);
    const third = await journal.readProjectionPage("c1", second.nextBefore, 2);
    expect(first.messages.map((message) => message.content)).toEqual(["4", "5"]);
    expect(second.messages.map((message) => message.content)).toEqual(["2", "3"]);
    expect(third.messages.map((message) => message.content)).toEqual(["1"]);
    expect(first).toMatchObject({ messageCount: 5, hasMore: true, nextBefore: 3 });
    expect(second).toMatchObject({ messageCount: 5, hasMore: true, nextBefore: 1 });
    expect(third).toMatchObject({ messageCount: 5, hasMore: false, nextBefore: null });
  });

  it("withdrawUserTurn 写入墓碑且重复撤回为 absent", async () => {
    const { journal } = createJournal();
    await journal.appendUser("c1", userInput("u1", "hello"));
    expect(await journal.withdrawUserTurn("c1", "u1")).toBe("written");
    expect(await journal.withdrawUserTurn("c1", "u1")).toBe("absent");
    expect((await journal.readProjection("c1")).messages).toEqual([]);
  });
});
