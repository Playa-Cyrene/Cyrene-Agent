import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ConversationJournalService,
  type JournalUserInput,
} from "./conversation-journal-service";
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
