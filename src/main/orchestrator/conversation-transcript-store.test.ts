import { closeConversationDatabases } from "../storage/conversation-database-client";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ConversationTranscriptStore, transcriptStorageKey } from "./conversation-transcript-store";
import type { TranscriptAppendInput, TranscriptEntry } from "./conversation-transcript-types";

// 测试根目录回收列表
const roots: string[] = [];

function createStore() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cyrene-transcript-"));
  roots.push(root);
  return {
    root,
    store: new ConversationTranscriptStore(root, { now: () => 1_000 }),
    jsonlPath: (conversationId: string) =>
      path.join(root, "transcripts", transcriptStorageKey(conversationId), "transcript.jsonl"),
    snapshotPath: (conversationId: string) =>
      path.join(root, "transcripts", transcriptStorageKey(conversationId), "snapshot.json"),
  };
}

// 构造一条 user 轨迹追加草稿（信封字段 + 文本载荷）
function userDraft(id: string, turnId: string, revision: number, text: string): TranscriptAppendInput {
  return { id, at: 1_000, kind: "user", turnId, revision, payload: { text } };
}

async function writeV1Snapshot(
  root: string,
  conversationId: string,
  input: { throughSeq: number; entries: TranscriptEntry[] },
): Promise<void> {
  const dir = path.join(root, "transcripts", conversationId);
  await fs.promises.mkdir(dir, { recursive: true });
  await fs.promises.writeFile(
    path.join(dir, "snapshot.json"),
    JSON.stringify({
      schemaVersion: 1,
      ...input,
      seenEntryIds: input.entries.map((entry) => entry.id),
      seenUserRevisions: input.entries
        .filter((entry) => entry.kind === "user" && entry.turnId && entry.revision)
        .map((entry) => `${entry.turnId}\u0000${entry.revision}`),
    }),
    "utf8",
  );
}

afterEach(async () => {
  await closeConversationDatabases();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("ConversationTranscriptStore SQLite", () => {
it("stores presentation deltas and replays them after restart", async () => {
    const { root, store } = createStore();
    const patch = { delta: { processMessageUpserts: [{ id: "process-1", content: "继续检查" }] } };
    const first = await store.appendPresentationNext("c1", "assistant-1", "mutation-1", patch);
    expect(first.payload.patchRevision).toBe(1);
    expect(await store.appendPresentationNext("c1", "assistant-1", "mutation-1", patch)).toEqual(first);

    const restarted = new ConversationTranscriptStore(root, { now: () => 1_000 });
    const entries = (await restarted.read("c1")).entries;
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ kind: "presentation_patch", payload: { patch } });
    const second = await restarted.appendPresentationNext("c1", "assistant-1", "mutation-2", { content: "完成" });
    expect(second.payload.patchRevision).toBe(2);
  });
it("终态补丁清除写缓存后，同键原样重试仍返回已写入条目", async () => {
    const { store } = createStore();
    const patch = {
      content: "已完成",
      runSnapshot: { status: "terminal" as const, updatedAt: 1_000 },
    };

    const first = await store.appendPresentationNext("c1", "assistant-1", "terminal-run-1", patch);
    const retry = await store.appendPresentationNext("c1", "assistant-1", "terminal-run-1", patch);

    expect(retry).toEqual(first);
    expect((await store.read("c1")).entries).toHaveLength(1);
  });
it("refreshes presentation indexes after another store writes to the journal", async () => {
    const { root, store } = createStore();
    await store.appendPresentationNext("c1", "assistant-1", "mutation-1", { content: "一" });
    const other = new ConversationTranscriptStore(root, { now: () => 1_000 });
    await other.appendPresentationNext("c1", "assistant-1", "mutation-2", { content: "二" });
    const third = await store.appendPresentationNext("c1", "assistant-1", "mutation-3", { content: "三" });
    expect(third.seq).toBe(3);
    expect(third.payload.patchRevision).toBe(3);
  });
it("同一逻辑会话得到稳定且 Windows 安全的目录键", () => {
    expect(transcriptStorageKey("channel:wechat:user/42"))
      .toMatch(/^v2-[a-f0-9]{64}$/);
    expect(transcriptStorageKey("channel:wechat:user/42"))
      .toBe(transcriptStorageKey("channel:wechat:user/42"));
  });
it("读取 v1 快照后仍从原 throughSeq 继续追加", async () => {
    const { root, store } = createStore();
    const seedEntries: TranscriptEntry[] = [
      { seq: 1, id: "e1", at: 1_000, kind: "user", turnId: "u-1", revision: 1, payload: { text: "one" } },
      { seq: 2, id: "e2", at: 1_000, kind: "user", turnId: "u-2", revision: 1, payload: { text: "two" } },
    ];
    await writeV1Snapshot(root, "desktop-1", { throughSeq: 2, entries: seedEntries });
    const appended = await store.append("desktop-1", userDraft("e3", "u-3", 1, "three"));
    expect(appended.seq).toBe(3);
  });
it("assigns monotonic seq and deduplicates entryId plus user turn revision", async () => {
    const { store } = createStore();
    const first = await store.append("c1", userDraft("e1", "u1", 1, "hello"));
    const retried = await store.append("c1", userDraft("e1", "u1", 1, "hello"));
    expect(first.seq).toBe(1);
    expect(retried.id).toBe("e1");
    expect((await store.read("c1")).entries).toHaveLength(1);
    await expect(store.append("c1", userDraft("e2", "u1", 1, "changed")))
      .rejects.toThrow("TRANSCRIPT_ENTRY_CONFLICT");
  });
it("serializes concurrent appends for one conversation", async () => {
    const { store } = createStore();
    await Promise.all(Array.from({ length: 20 }, (_, index) =>
      store.append("c1", userDraft(`e${index}`, `u${index}`, 1, String(index))),
    ));
    expect((await store.read("c1")).entries.map((entry) => entry.seq))
      .toEqual(Array.from({ length: 20 }, (_, index) => index + 1));
  });
it("interruption 边界接受 user_cancel / runtime_error / crashed 三种 reason", async () => {
    const { store } = createStore();
    for (const reason of ["user_cancel", "runtime_error", "crashed"] as const) {
      await store.append("c1", {
        id: `c1:interruption:${reason}`,
        at: 1_000,
        kind: "interruption",
        runId: "run-1",
        payload: { reason },
      });
    }
    const snapshot = await store.read("c1");
    const interruptions = snapshot.entries.filter((entry) => entry.kind === "interruption");
    expect(interruptions.map((entry) => entry.payload.reason)).toEqual([
      "user_cancel", "runtime_error", "crashed",
    ]);
  });
it("accepts stable generated image references but rejects encoded image bytes", async () => {
    const { root, store } = createStore();
    const attachment = {
      id: "image-1",
      kind: "image",
      name: "generated-1.png",
      filePath: path.join(root, "generated-1.png"),
      mime: "image/png",
      source: "model",
      byteLength: 20,
      status: "done",
    };
    await store.append("c1", {
      id: "assistant-1", at: 1_000, kind: "assistant",
      payload: { role: "assistant", content: "", attachments: [attachment] },
    });
    expect((await store.read("c1")).entries[0]).toMatchObject({
      kind: "assistant", payload: { attachments: [attachment] },
    });

    await expect(store.append("c2", {
      id: "assistant-2", at: 1_000, kind: "assistant",
      payload: { role: "assistant", content: "", attachments: [{ ...attachment, base64: "encoded-image" }] as never },
    })).rejects.toThrow("TRANSCRIPT_CORRUPT_ROW");
  });
});
