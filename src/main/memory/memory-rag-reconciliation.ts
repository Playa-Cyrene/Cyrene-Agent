import * as fs from "fs";
import * as path from "path";
import type { L2Memory } from "./memory-types";

export interface ReconciliationVector {
  id: string;
  text: string;
  metadata?: Record<string, unknown>;
}

export interface MemoryRagReconciliationDeps {
  getMemories(): Promise<L2Memory[]>;
  getVectors(): ReconciliationVector[];
  backup(): Promise<void>;
  addVector(text: string, l2Id: string, metadata: Record<string, unknown>): Promise<string>;
  markSynced(l2Id: string, ragId: string): Promise<unknown>;
  markSyncFailed(l2Id: string, error: unknown): Promise<unknown>;
  deleteVectors(ids: string[]): Promise<unknown> | unknown;
  warn(message: string, error: unknown): void;
}

export interface MemoryRagReconciliationReport {
  rebuilt: number;
  relinked: number;
  deleted: number;
  failed: number;
  changed: boolean;
}

export function backupMemoryRagFiles(userDataDir: string, timestamp = Date.now(), retention = 3): void {
  const sources = [
    { path: path.join(userDataDir, "memory.json"), prefix: "memory" },
    { path: path.join(userDataDir, "rag-data", "memory-store.json"), prefix: "memory-store" },
  ].filter((source) => fs.existsSync(source.path));
  if (sources.length === 0) return;

  const backupDir = path.join(userDataDir, "memory-reconcile-backups");
  fs.mkdirSync(backupDir, { recursive: true });
  for (const source of sources) {
    fs.copyFileSync(source.path, path.join(backupDir, `${source.prefix}.${timestamp}.json`));
    const backups = fs.readdirSync(backupDir)
      .filter((name) => name.startsWith(`${source.prefix}.`) && name.endsWith(".json"))
      .sort();
    for (const stale of backups.slice(0, Math.max(0, backups.length - Math.max(1, retention)))) {
      fs.rmSync(path.join(backupDir, stale));
    }
  }
}

function isSemanticallyRecallable(memory: L2Memory): boolean {
  return memory.status === "active" || memory.status === "aging";
}

export async function reconcileMemoryRag(
  deps: MemoryRagReconciliationDeps,
  signal?: AbortSignal,
): Promise<MemoryRagReconciliationReport> {
  const memories = await deps.getMemories();
  signal?.throwIfAborted();
  const vectors = deps.getVectors();
  const vectorsById = new Map(vectors.map((vector) => [vector.id, vector]));
  const validVectorIds = new Set<string>();
  const relink: Array<{ l2Id: string; ragId: string }> = [];
  const rebuild: L2Memory[] = [];

  for (const memory of memories) {
    if (!isSemanticallyRecallable(memory)) continue;
    const vector = memory.ragId ? vectorsById.get(memory.ragId) : undefined;
    const mappingMatches = vector?.metadata?.l2Id === memory.id;
    // 映射正确但正文与向量文本不一致（如历史 Obsidian 回流未重建向量），同样需要重建
    const contentMatches = vector?.text === memory.content;
    if (vector && mappingMatches && contentMatches) {
      validVectorIds.add(vector.id);
      if (memory.syncStatus !== "synced") relink.push({ l2Id: memory.id, ragId: vector.id });
    } else {
      rebuild.push(memory);
    }
  }

  const staleVectorIds = vectors
    .filter((vector) => !validVectorIds.has(vector.id))
    .map((vector) => vector.id);
  const changed = relink.length > 0 || rebuild.length > 0 || staleVectorIds.length > 0;
  const report: MemoryRagReconciliationReport = {
    rebuilt: 0,
    relinked: 0,
    deleted: 0,
    failed: 0,
    changed,
  };
  if (!changed) return report;

  await deps.backup();

  for (const item of relink) {
    signal?.throwIfAborted();
    try {
      await deps.markSynced(item.l2Id, item.ragId);
      report.relinked += 1;
    } catch (error) {
      report.failed += 1;
      deps.warn(`Failed to relink memory ${item.l2Id}`, error);
    }
  }

  for (const memory of rebuild) {
    signal?.throwIfAborted();
    try {
      const ragId = await deps.addVector(memory.content, memory.id, {
        source: "memory_reconciliation",
        isSummary: memory.isSummary === true,
        subEntryIds: memory.subEntryIds ?? [],
      });
      signal?.throwIfAborted();
      await deps.markSynced(memory.id, ragId);
      report.rebuilt += 1;
    } catch (error) {
      report.failed += 1;
      signal?.throwIfAborted();
      await deps.markSyncFailed(memory.id, error);
      deps.warn(`Failed to rebuild memory vector ${memory.id}`, error);
    }
  }

  signal?.throwIfAborted();
  if (staleVectorIds.length > 0) {
    try {
      await deps.deleteVectors(staleVectorIds);
      report.deleted = staleVectorIds.length;
    } catch (error) {
      report.failed += 1;
      deps.warn("Failed to delete stale user memory vectors", error);
    }
  }

  return report;
}
