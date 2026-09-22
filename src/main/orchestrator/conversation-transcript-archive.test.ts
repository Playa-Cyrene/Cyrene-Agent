import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ConversationTranscriptArchive } from "./conversation-transcript-archive";
import { ConversationTranscriptStore, syncDirectoryForTests, transcriptStorageKey } from "./conversation-transcript-store";
import type { TranscriptAppendInput, TranscriptEntry } from "./conversation-transcript-types";
import { createHash } from "node:crypto";
import { ConversationJournalService } from "./conversation-journal-service";
import { reduceTranscriptProjection } from "./conversation-transcript-projection";

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

  it("manifest 不得把 active 指向 identity，且 active 缺失时 fail-closed", async () => {
    const { store, archive, root } = fixture();
    await seedCheckpoint(store);
    await archive.archiveThrough("c1", 40);
    const dir = path.join(root, "transcripts", transcriptStorageKey("c1"));
    const manifestPath = path.join(dir, "generation.json");
    const manifest = JSON.parse(await fs.promises.readFile(manifestPath, "utf8")) as Record<string, unknown>;
    manifest.activeFile = "identity.json";
    await fs.promises.writeFile(manifestPath, JSON.stringify(manifest), "utf8");
    await expect(store.read("c1")).rejects.toThrow("TRANSCRIPT_ARCHIVE_CORRUPT_MANIFEST");
    await expect(store.append("c1", user("e44", 44))).rejects.toThrow("TRANSCRIPT_ARCHIVE_CORRUPT_MANIFEST");
    // Restore a valid manifest, then remove its active target: ENOENT must not
    // be treated as an empty log that starts sequence numbers over.
    const valid = JSON.parse(await fs.promises.readFile(manifestPath, "utf8")) as { activeFile: string };
    valid.activeFile = "active/missing.jsonl";
    await fs.promises.writeFile(manifestPath, JSON.stringify({ ...manifest, activeFile: valid.activeFile }), "utf8");
    await expect(store.read("c1")).rejects.toThrow("TRANSCRIPT_ARCHIVE_CORRUPT_ACTIVE");
    await expect(store.append("c1", user("e44", 44))).rejects.toThrow("TRANSCRIPT_ARCHIVE_CORRUPT_ACTIVE");
  });

  it("归档后重放已归档 entryId 与 user revision 不会生成新序号", async () => {
    const { store, archive } = fixture();
    await seedCheckpoint(store);
    await archive.archiveThrough("c1", 40);
    await expect(store.append("c1", user("e1", 1))).rejects.toThrow("TRANSCRIPT_IDEMPOTENCY_CONFLICT");
    await expect(store.append("c1", {
      ...user("new-id", 1), turnId: "e1",
    })).rejects.toThrow("TRANSCRIPT_IDEMPOTENCY_CONFLICT");
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
    expect(projection.messages.map((message) => message.content)).toEqual(["first", "answer"]);
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

  it("健康完整 projection 不扫描 audit segments，非零残缺则按 digest 重建", async () => {
    const { store, archive, root } = fixture();
    await seedCheckpoint(store);
    const all = await store.read("c1");
    await store.checkpoint("c1", reduceTranscriptProjection(all.entries));
    await archive.archiveThrough("c1", 40);
    const journal = new ConversationJournalService(store);
    const auditSpy = vi.spyOn(store, "readAuditEntries");
    const healthy = await journal.readProjection("c1");
    expect(healthy.messages).toHaveLength(42);
    expect(auditSpy).not.toHaveBeenCalled();

    const snapshotPath = path.join(root, "transcripts", transcriptStorageKey("c1"), "snapshot.json");
    const snapshot = JSON.parse(await fs.promises.readFile(snapshotPath, "utf8")) as {
      projection: { messages: unknown[]; state?: unknown; throughSeq: number };
    };
    snapshot.projection.messages = snapshot.projection.messages.slice(1);
    await fs.promises.writeFile(snapshotPath, JSON.stringify(snapshot), "utf8");
    const repaired = await new ConversationJournalService(store).readProjection("c1");
    expect(repaired.messages).toHaveLength(42);
    expect(auditSpy).toHaveBeenCalled();
  });

  it("checkpoint active 文件 sync 失败时不返回成功", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "cyrene-transcript-sync-"));
    roots.push(root);
    let failSync = false;
    const store = new ConversationTranscriptStore(root, {
      now: () => 1_000,
      syncFile: async (file) => {
        if (failSync && file.endsWith("transcript.jsonl")) throw new Error("SYNC_FAILURE");
      },
    });
    await store.append("c1", user("e1", 1));
    failSync = true;
    const source = await store.read("c1");
    const sourceDigest = createHash("sha256").update(JSON.stringify(source.entries), "utf8").digest("hex");
    await expect(store.appendCompactionCheckpoint("c1", {
      id: "checkpoint-sync", at: 1_000, kind: "compaction_checkpoint",
      payload: {
        baseThroughSeq: 1, sourceThroughSeq: 1, sourceDigest,
        replacement: { role: "system", content: "summary" }, trigger: "manual",
      },
    })).rejects.toThrow("SYNC_FAILURE");
  });

  it("目录 sync 的 Windows 兼容不会吞掉非 Windows I/O 错误", async () => {
    const open = vi.spyOn(fs.promises, "open").mockRejectedValueOnce(
      Object.assign(new Error("directory sync unsupported"), { code: "EPERM" }),
    );
    await expect(syncDirectoryForTests("C:/transcript", "linux")).rejects.toThrow("directory sync unsupported");
    open.mockRestore();
  });
});
