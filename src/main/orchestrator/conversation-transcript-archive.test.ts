import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ConversationTranscriptArchive } from "./conversation-transcript-archive";
import { ConversationTranscriptStore, transcriptStorageKey } from "./conversation-transcript-store";
import type { TranscriptAppendInput, TranscriptEntry } from "./conversation-transcript-types";
import { createHash } from "node:crypto";
import { ConversationJournalService } from "./conversation-journal-service";

describe("ConversationTranscriptArchive", () => {
  const roots: string[] = [];

  afterEach(() => {
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
    const dir = path.join(root, "transcripts", transcriptStorageKey("c1"));
    expect(fs.existsSync(path.join(dir, "generation.json"))).toBe(true);
    expect(fs.readdirSync(path.join(dir, "segments"))).toHaveLength(1);
  });

  it("归档边界必须由已提交 checkpoint 覆盖", async () => {
    const { store, archive } = fixture();
    await store.append("c1", user("e1", 1));
    await expect(archive.archiveThrough("c1", 1)).rejects.toThrow("TRANSCRIPT_ARCHIVE_BOUNDARY_NOT_COMMITTED");
  });

  it("投影快照损坏且前缀已归档时从 audit segments 重建 UI", async () => {
    const { store, archive, root } = fixture();
    await seedCheckpoint(store);
    await archive.archiveThrough("c1", 40);
    const snapshotPath = path.join(root, "transcripts", transcriptStorageKey("c1"), "snapshot.json");
    const snapshot = JSON.parse(await fs.promises.readFile(snapshotPath, "utf8")) as Record<string, unknown>;
    snapshot.projection = { throughSeq: 0, messages: [] };
    await fs.promises.writeFile(snapshotPath, JSON.stringify(snapshot), "utf8");
    const projection = await new ConversationJournalService(store).readProjection("c1");
    expect(projection.messages).toHaveLength(42);
    expect(projection.messages[0]?.content).toBe("message-1");
  });
});
