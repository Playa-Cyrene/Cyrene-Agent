import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { backupMemoryRagFiles, reconcileMemoryRag, type MemoryRagReconciliationDeps } from "./memory-rag-reconciliation";
import { JsonVectorStore } from "../rag/vectorstore";
import type { L2Memory } from "./memory-types";

function memory(overrides: Partial<L2Memory> & Pick<L2Memory, "id" | "content">): L2Memory {
  return {
    triggerText: "trigger",
    sourceConversationId: "test",
    createdAt: 1,
    lastAccessedAt: 1,
    accessCount: 0,
    weight: 0,
    isPinned: false,
    status: "active",
    syncStatus: "synced",
    ...overrides,
  };
}

function createDeps(
  memories: L2Memory[],
  vectors: Array<{ id: string; text: string; metadata?: Record<string, unknown> }>,
): MemoryRagReconciliationDeps {
  return {
    getMemories: vi.fn(async () => memories),
    getVectors: vi.fn(() => vectors),
    backup: vi.fn(async () => undefined),
    addVector: vi.fn(async (_text, l2Id) => `rag_rebuilt_${l2Id}`),
    markSynced: vi.fn(async (l2Id, ragId) => {
      const target = memories.find((item) => item.id === l2Id)!;
      target.syncStatus = "synced";
      target.ragId = ragId;
    }),
    markSyncFailed: vi.fn(async (l2Id) => {
      memories.find((item) => item.id === l2Id)!.syncStatus = "sync_failed";
    }),
    deleteVectors: vi.fn(() => 0),
    warn: vi.fn(),
  };
}

describe("memory/RAG reconciliation", () => {
  it("discards an embedding that finishes after shutdown without updating either store", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "memory-rag-stop-"));
    backupTempDirs.push(dir);
    const vectors = new JsonVectorStore(dir);
    const controller = new AbortController();
    const deps = createDeps([memory({ id: "pending", content: "pending" })], []);
    const provider = {
      name: "test", dims: 2, embedBatch: vi.fn(),
      embed: vi.fn(async () => {
        controller.abort();
        return [0, 1];
      }),
    };
    deps.addVector = async (text, l2Id) =>
      (await vectors.addUnique(text, "user_memory", provider, { l2Id }, controller.signal)).id;

    await expect(reconcileMemoryRag(deps, controller.signal)).rejects.toThrow();
    expect(provider.embed).toHaveBeenCalledOnce();
    expect(vectors.stats.total).toBe(0);
    expect(vectors.getIndexMeta()).toBeNull();
    expect(deps.markSynced).not.toHaveBeenCalled();
    expect(deps.markSyncFailed).not.toHaveBeenCalled();
    expect(deps.deleteVectors).not.toHaveBeenCalled();
  });

  it("repairs recallable memories and removes terminal, orphaned, and mismatched vectors", async () => {
    const memories = [
      memory({ id: "l2_valid", content: "valid", ragId: "rag_valid" }),
      memory({ id: "l2_missing", content: "missing", ragId: "rag_missing" }),
      memory({ id: "l2_pending", content: "pending", ragId: "rag_pending", syncStatus: "pending_sync" }),
      memory({ id: "l2_archived", content: "archived", ragId: "rag_archived", status: "archived" }),
      memory({ id: "l2_mismatch", content: "mismatch", ragId: "rag_mismatch" }),
    ];
    const vectors = [
      { id: "rag_valid", text: "valid", metadata: { l2Id: "l2_valid" } },
      { id: "rag_pending", text: "pending", metadata: { l2Id: "l2_pending" } },
      { id: "rag_archived", text: "archived", metadata: { l2Id: "l2_archived" } },
      { id: "rag_mismatch", text: "mismatch", metadata: { l2Id: "someone_else" } },
      { id: "rag_orphan", text: "orphan", metadata: { l2Id: "missing_l2" } },
    ];
    const deps = createDeps(memories, vectors);

    const report = await reconcileMemoryRag(deps);

    expect(deps.backup).toHaveBeenCalledTimes(1);
    expect(deps.addVector).toHaveBeenCalledTimes(2);
    expect(deps.addVector).toHaveBeenCalledWith("missing", "l2_missing", expect.any(Object));
    expect(deps.addVector).toHaveBeenCalledWith("mismatch", "l2_mismatch", expect.any(Object));
    expect(deps.markSynced).toHaveBeenCalledWith("l2_pending", "rag_pending");
    expect(deps.deleteVectors).toHaveBeenCalledWith(expect.arrayContaining([
      "rag_archived",
      "rag_mismatch",
      "rag_orphan",
    ]));
    expect(report).toMatchObject({ rebuilt: 2, relinked: 1, deleted: 3, failed: 0, changed: true });
  });

  it("does nothing and creates no backup when both stores are already consistent", async () => {
    const memories = [memory({ id: "l2_valid", content: "valid", ragId: "rag_valid" })];
    const vectors = [{ id: "rag_valid", text: "valid", metadata: { l2Id: "l2_valid" } }];
    const deps = createDeps(memories, vectors);

    const report = await reconcileMemoryRag(deps);

    expect(report.changed).toBe(false);
    expect(deps.backup).not.toHaveBeenCalled();
    expect(deps.addVector).not.toHaveBeenCalled();
    expect(deps.deleteVectors).not.toHaveBeenCalled();
  });

  it("rebuilds when vector mapping is correct but text diverges from memory content", async () => {
    // 历史存量脏数据：Obsidian 回流改了正文但向量未重建，映射和状态看起来都正常
    const memories = [memory({ id: "l2_stale", content: "用户改成了每周游泳三次", ragId: "rag_stale", syncStatus: "synced" })];
    const vectors = [{ id: "rag_stale", text: "用户喜欢跑步", metadata: { l2Id: "l2_stale" } }];
    const deps = createDeps(memories, vectors);

    const report = await reconcileMemoryRag(deps);

    // 按新正文重建向量并切换 ragId，旧向量作为 stale 被清理
    expect(deps.addVector).toHaveBeenCalledWith("用户改成了每周游泳三次", "l2_stale", expect.any(Object));
    expect(deps.markSynced).toHaveBeenCalledWith("l2_stale", "rag_rebuilt_l2_stale");
    expect(deps.deleteVectors).toHaveBeenCalledWith(["rag_stale"]);
    expect(report).toMatchObject({ rebuilt: 1, relinked: 0, deleted: 1, failed: 0, changed: true });
  });

  it("marks a memory sync_failed without blocking other repairs", async () => {
    const memories = [
      memory({ id: "l2_fail", content: "fail", ragId: "rag_gone" }),
      memory({ id: "l2_ok", content: "ok", ragId: "rag_gone_too" }),
    ];
    const deps = createDeps(memories, []);
    vi.mocked(deps.addVector)
      .mockRejectedValueOnce(new Error("embedding failed"))
      .mockResolvedValueOnce("rag_rebuilt_ok");

    const report = await reconcileMemoryRag(deps);

    expect(deps.markSyncFailed).toHaveBeenCalledWith("l2_fail", expect.any(Error));
    expect(deps.markSynced).toHaveBeenCalledWith("l2_ok", "rag_rebuilt_ok");
    expect(report).toMatchObject({ rebuilt: 1, failed: 1, changed: true });
  });
});

const backupTempDirs: string[] = [];

afterEach(() => {
  for (const dir of backupTempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("memory/RAG reconciliation backups", () => {
  it("backs up both stores and caps retained snapshots", () => {
    const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "memory-rag-backup-"));
    backupTempDirs.push(userDataDir);
    fs.mkdirSync(path.join(userDataDir, "rag-data"), { recursive: true });
    fs.writeFileSync(path.join(userDataDir, "memory.json"), "memory", "utf8");
    fs.writeFileSync(path.join(userDataDir, "rag-data", "memory-store.json"), "vectors", "utf8");

    backupMemoryRagFiles(userDataDir, 100, 2);
    backupMemoryRagFiles(userDataDir, 200, 2);
    backupMemoryRagFiles(userDataDir, 300, 2);

    const backups = fs.readdirSync(path.join(userDataDir, "memory-reconcile-backups")).sort();
    expect(backups).toEqual([
      "memory-store.200.json",
      "memory-store.300.json",
      "memory.200.json",
      "memory.300.json",
    ]);
  });
});
