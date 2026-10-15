import { closeConversationDatabases } from "../storage/conversation-database-client";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ConversationTranscriptArchive } from "./conversation-transcript-archive";
import { ConversationTranscriptStore, transcriptStorageKey } from "./conversation-transcript-store";
import type { TranscriptAppendInput, TranscriptEntry } from "./conversation-transcript-types";
import { createHash } from "node:crypto";
import { ConversationJournalService } from "./conversation-journal-service";
import { reduceTranscriptProjection } from "./conversation-transcript-projection";

describe("ConversationTranscriptArchive", () => {
  const roots: string[] = [];

  afterEach(async () => {
  await closeConversationDatabases();
    for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
  });

  function fixture() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "cyrene-transcript-archive-"));
    roots.push(root);
    const store = new ConversationTranscriptStore(root, { now: () => 1_000 });
    const archive = new ConversationTranscriptArchive(store);
    return { root, store, archive };
  }

  function user(id: string, seq: number): TranscriptAppendInput {
    return {
      id,
      at: 1_000,
      kind: "user",
      turnId: id,
      revision: 1,
      payload: { text: `message-${seq}` },
    };
  }

  async function seedCheckpoint(store: ConversationTranscriptStore) {
    for (let index = 1; index <= 40; index++) await store.append("c1", user(`e${index}`, index));
    const before = await store.read("c1");
    const sourceDigest = createHash("sha256")
      .update(JSON.stringify(before.entries), "utf8")
      .digest("hex");
    await store.appendCompactionCheckpoint("c1", {
      id: "checkpoint-1",
      at: 1_000,
      kind: "compaction_checkpoint",
      payload: {
        baseThroughSeq: 40,
        sourceThroughSeq: 40,
        sourceDigest,
        replacement: { role: "system", content: "summary" },
        trigger: "manual",
      },
    });
    await store.append("c1", user("e42", 42));
    await store.append("c1", user("e43", 43));
  }

  it("新 generation 写完但 manifest 提交前崩溃时仍读旧 generation", async () => {
    const { store, archive } = fixture();
    await seedCheckpoint(store);
    const allEntries = (await store.read("c1")).entries;
    archive.failBeforeManifestOnce();
    await expect(archive.archiveThrough("c1", 40)).rejects.toThrow("TEST_CRASH");
    expect((await store.read("c1")).entries).toEqual(allEntries);
    await archive.archiveThrough("c1", 40);
    expect((await archive.readAuditEntries("c1")).map((entry) => entry.seq)).toEqual(
      Array.from({ length: 43 }, (_, index) => index + 1),
    );
  });

  it("归档完成后热日志只含 checkpoint 与 suffix，审计仍可读全量", async () => {
    const { store, archive, root } = fixture();
    await seedCheckpoint(store);
    await archive.archiveThrough("c1", 40);
    expect((await store.read("c1")).entries.map((entry) => entry.seq)).toEqual([41, 42, 43]);
    expect((await archive.readAuditEntries("c1")).map((entry) => entry.seq)).toEqual(
      Array.from({ length: 43 }, (_, index) => index + 1),
    );
    expect(fs.existsSync(path.join(root, "cyrene.sqlite"))).toBe(true);
  });

  it("归档边界必须由已提交 checkpoint 覆盖", async () => {
    const { store, archive } = fixture();
    await store.append("c1", user("e1", 1));
    await expect(archive.archiveThrough("c1", 1)).rejects.toThrow("TRANSCRIPT_ARCHIVE_BOUNDARY_NOT_COMMITTED");
  });



  it("归档后重放已归档 entryId 与 user revision 不会生成新序号", async () => {
    const { store, archive } = fixture();
    await seedCheckpoint(store);
    await archive.archiveThrough("c1", 40);
    expect(await store.append("c1", user("e1", 1))).toMatchObject({ seq: 1 });
    expect(await store.append("c1", { ...user("new-id", 1), turnId: "e1" })).toMatchObject({ seq: 1 });
    expect((await store.read("c1")).throughSeq).toBe(43);
  });

  it("checkpoint 后投影 seed 未覆盖归档边界时从 audit 重建完整 UI", async () => {
    const { store, archive } = fixture();
    const journal = new ConversationJournalService(store);
    await journal.appendUser("c1", { id: "u1", turnId: "u1", text: "first" });
    await store.append("c1", {
      id: "a1", at: 1_000, kind: "assistant", turnId: "t1",
      payload: { role: "assistant", content: "answer" },
    });
    const before = await store.read("c1");
    const sourceDigest = createHash("sha256").update(JSON.stringify(before.entries), "utf8").digest("hex");
    await store.appendCompactionCheckpoint("c1", {
      id: "checkpoint-timing", at: 1_000, kind: "compaction_checkpoint",
      payload: {
        baseThroughSeq: 2, sourceThroughSeq: 2, sourceDigest,
        replacement: { role: "system", content: "summary" }, trigger: "manual",
      },
    });
    await archive.archiveThrough("c1", 2);
    const projection = await journal.readProjection("c1");
    // 归档边界之后紧跟压缩分隔标记（marker），UI 历史完整保留。
    expect(projection.messages.map((message) => message.content)).toEqual(["first", "answer", ""]);
    expect(projection.messages[2]?.compaction).toEqual({ trigger: "manual" });
  });








});
