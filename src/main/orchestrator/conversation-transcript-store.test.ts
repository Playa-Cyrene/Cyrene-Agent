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

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("ConversationTranscriptStore", () => {
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

  it("legacy 迁移在 identity 写入失败后可由重启恢复", async () => {
    const { root, store } = createStore();
    const seedEntries: TranscriptEntry[] = [
      { seq: 1, id: "e1", at: 1_000, kind: "user", turnId: "u-1", revision: 1, payload: { text: "one" } },
    ];
    await writeV1Snapshot(root, "desktop-crash-recovery", { throughSeq: 1, entries: seedEntries });

    const identityWrite = vi.spyOn(fs.promises, "writeFile")
      .mockRejectedValueOnce(new Error("simulated-crash"));
    await expect(store.append("desktop-crash-recovery", userDraft("e2", "u-2", 1, "two")))
      .rejects.toThrow("simulated-crash");
    identityWrite.mockRestore();

    const restarted = new ConversationTranscriptStore(root, { now: () => 1_000 });
    const appended = await restarted.append(
      "desktop-crash-recovery",
      userDraft("e2", "u-2", 1, "two"),
    );
    expect(appended.seq).toBe(2);
    expect((await restarted.read("desktop-crash-recovery")).entries.map((entry) => entry.id))
      .toEqual(["e1", "e2"]);
  });

  it("冒号渠道 ID 不直接成为目录名", async () => {
    const { store, root } = createStore();
    await store.append("channel:wechat:abc", userDraft("e1", "u-1", 1, "one"));
    expect(fs.existsSync(path.join(root, "transcripts", "channel:wechat:abc"))).toBe(false);
  });

  it("哈希目录身份不匹配时拒绝打开", async () => {
    const { store, root } = createStore();
    await store.append("desktop-identity", userDraft("e1", "u-1", 1, "one"));
    await fs.promises.writeFile(
      path.join(root, "transcripts", transcriptStorageKey("desktop-identity"), "identity.json"),
      JSON.stringify({ schemaVersion: 1, conversationId: "another-conversation" }),
      "utf8",
    );
    await expect(store.read("desktop-identity")).rejects.toThrow("TRANSCRIPT_IDENTITY_MISMATCH");
  });

  it("哈希目录优先于同名 legacy 目录且保留 legacy 审计副本", async () => {
    const { store, root } = createStore();
    await store.append("desktop-priority", userDraft("e1", "u-1", 1, "one"));
    const legacyDir = path.join(root, "transcripts", "desktop-priority");
    await fs.promises.mkdir(legacyDir, { recursive: true });
    await fs.promises.writeFile(path.join(legacyDir, "audit.txt"), "legacy", "utf8");
    expect((await store.read("desktop-priority")).entries.map((entry) => entry.id)).toEqual(["e1"]);
    expect(fs.existsSync(path.join(legacyDir, "audit.txt"))).toBe(true);
  });

  it("assigns monotonic seq and deduplicates entryId plus user turn revision", async () => {
    const { store } = createStore();
    const first = await store.append("c1", userDraft("e1", "u1", 1, "hello"));
    const retried = await store.append("c1", userDraft("e1", "u1", 1, "hello"));
    expect(first.seq).toBe(1);
    expect(retried.id).toBe("e1");
    expect((await store.read("c1")).entries).toHaveLength(1);
    await expect(store.append("c1", userDraft("e2", "u1", 1, "changed")))
      .rejects.toThrow("TRANSCRIPT_IDEMPOTENCY_CONFLICT");
  });

  it("repairs only a truncated final JSONL line", async () => {
    const { store, jsonlPath } = createStore();
    await store.append("c1", userDraft("e1", "u1", 1, "one"));
    // 模拟进程死亡留下的半行：无换行结尾且 JSON 不完整
    await fs.promises.appendFile(jsonlPath("c1"), '{"seq":2,"id":"broken"', "utf8");
    await store.append("c1", userDraft("e2", "u2", 1, "two"));
    expect((await store.read("c1")).entries.map((entry) => entry.id)).toEqual(["e1", "e2"]);
  });

  it("serializes concurrent appends for one conversation", async () => {
    const { store } = createStore();
    await Promise.all(Array.from({ length: 20 }, (_, index) =>
      store.append("c1", userDraft(`e${index}`, `u${index}`, 1, String(index))),
    ));
    expect((await store.read("c1")).entries.map((entry) => entry.seq))
      .toEqual(Array.from({ length: 20 }, (_, index) => index + 1));
  });

  it("replays only rows after snapshot throughSeq and remembers old idempotency keys", async () => {
    const { store } = createStore();
    await store.append("c1", userDraft("e1", "u1", 1, "one"));
    await store.checkpoint("c1");
    await store.append("c1", userDraft("e2", "u2", 1, "two"));
    const replayed = await store.read("c1");
    expect(replayed.throughSeq).toBe(2);
    expect(replayed.entries.map((entry) => entry.id)).toEqual(["e1", "e2"]);
    // 快照恢复后重试旧 entryId：仍被幂等识别吸收，不重复写入
    expect((await store.append("c1", userDraft("e1", "u1", 1, "retry"))).id).toBe("e1");
  });

  it("checkpoint can replace only the recoverable projection while retaining canonical rows", async () => {
    const { store } = createStore();
    await store.append("c1", userDraft("e1", "u1", 1, "one"));
    const snapshot = await store.checkpoint("c1", {
      throughSeq: 1,
      messages: [{ id: "e1", role: "user", content: "one", at: 1_000 }],
    });
    expect(snapshot.entries.map((entry) => entry.id)).toEqual(["e1"]);
    expect(snapshot.projection.messages[0].content).toBe("one");
    expect((await store.read("c1")).entries.map((entry) => entry.id)).toEqual(["e1"]);
  });

  it("rejects malformed canonical user and assistant rows", async () => {
    const { store, jsonlPath } = createStore();
    await store.append("c1", userDraft("e1", "u1", 1, "one"));
    await fs.promises.writeFile(
      jsonlPath("c1"),
      `${JSON.stringify({ seq: 1, id: "e1", at: 1_000, kind: "user", payload: {} })}\n`,
      "utf8",
    );
    await expect(store.read("c1")).rejects.toThrow("TRANSCRIPT_CORRUPT_ROW");

    await fs.promises.writeFile(
      jsonlPath("c1"),
      `${JSON.stringify({ seq: 1, id: "e1", at: 1_000, kind: "assistant", payload: { role: "assistant", content: 42 } })}\n`,
      "utf8",
    );
    await expect(store.read("c1")).rejects.toThrow("TRANSCRIPT_CORRUPT_ROW");
  });

  it("rejects malformed canonical tool result rows", async () => {
    const { store, jsonlPath } = createStore();
    await store.append("c1", userDraft("e1", "u1", 1, "one"));
    await fs.promises.writeFile(
      jsonlPath("c1"),
      `${JSON.stringify({ seq: 1, id: "e1", at: 1_000, kind: "tool_result", payload: { assistantEntryId: "a1" } })}\n`,
      "utf8",
    );
    await expect(store.read("c1")).rejects.toThrow("TRANSCRIPT_CORRUPT_ROW");
  });

  it("fails closed on malformed v2 snapshot metadata", async () => {
    const { store, snapshotPath } = createStore();
    await store.append("c1", userDraft("e1", "u1", 1, "one"));
    const valid = {
      schemaVersion: 2,
      throughSeq: 1,
      entries: [{ seq: 1, id: "e1", at: 1_000, kind: "user", turnId: "u1", revision: 1, payload: { text: "one" } }],
      projection: { throughSeq: 1, messages: [] },
      archives: [],
      seenEntryIds: ["e1"],
      seenUserRevisions: ["u1\u00001"],
    };
    for (const corrupt of [
      { ...valid, throughSeq: "one" },
      { ...valid, seenEntryIds: "e1" },
      { ...valid, archives: {} },
    ]) {
      await fs.promises.writeFile(snapshotPath("c1"), JSON.stringify(corrupt), "utf8");
      await expect(store.read("c1")).rejects.toThrow("TRANSCRIPT_CORRUPT_SNAPSHOT");
    }
  });

  it("hashes conversation ids that contain path separators", async () => {
    const { store, root } = createStore();
    await store.append("../escape", userDraft("e1", "u1", 1, "x"));
    await store.append("a/b", userDraft("e2", "u2", 1, "y"));
    expect(fs.existsSync(path.join(root, "transcripts", "..", "escape"))).toBe(false);
    expect(fs.existsSync(path.join(root, "transcripts", transcriptStorageKey("../escape")))).toBe(true);
    expect(fs.existsSync(path.join(root, "transcripts", transcriptStorageKey("a/b")))).toBe(true);
  });

  it("deletes only the targeted conversation directory", async () => {
    const { store, root } = createStore();
    await store.append("c1", userDraft("e1", "u1", 1, "one"));
    await store.append("c2", userDraft("e2", "u2", 1, "two"));
    await store.deleteConversation("c1");
    expect(fs.existsSync(path.join(root, "transcripts", "c1"))).toBe(false);
    expect((await store.read("c2")).entries).toHaveLength(1);
  });
});
