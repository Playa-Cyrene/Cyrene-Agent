import * as path from "path";
import * as fs from "fs";
import { app } from "electron";
import { getEmbeddingProvider, resetEmbeddingProvider, EmbeddingProvider, switchEmbeddingModel as switchModel, getCurrentModelDims, EmbeddingDimensionMismatchError } from "./embedding";
import type { EmbeddingIndexMetadata } from "./vectorstore";
import { JsonVectorStore } from "./vectorstore";
import type { MemoryEntry } from "./vectorstore";
import { HybridRetriever } from "./retriever";
import { WorldbookManager } from "./worldbook";
import { logger, LogTag } from "../logger";
export { INJECTION_HEADER, INJECTION_PREAMBLE } from "./worldbook-constants";
import { feedEntityNamesToJieba } from "../memory/entity-graph";
import { isL2LocallyRecallable } from "../memory/memory-types";
import { findPromptPath } from "../external-content-paths";
import { isMemoryEnabled } from "../memory/memory-mode";

// ── Global RAG instances ──
let store: JsonVectorStore | null = null;
let retriever: HybridRetriever | null = null;
let worldbook: WorldbookManager | null = null;
let provider: EmbeddingProvider | null = null;
let activeVectorOperations = 0;
const vectorOperationsDrained = new Set<() => void>();
// 每轮对话递增，用于 DMAE repeatWindow 统计（worldbook 状态不持久化，重启回 0 可接受）
let worldbookTurnCounter = 0;

function getDataDir(): string {
  return path.join(app.getPath("userData"), "rag-data");
}

function stripImportedDocumentEntries(filePath: string): number {
  if (!fs.existsSync(filePath)) return 0;
  const parsed = JSON.parse(fs.readFileSync(filePath, "utf8")) as unknown;
  if (!Array.isArray(parsed)) return 0;
  const filtered = parsed.filter((entry) =>
    !entry || typeof entry !== "object" || (entry as { source?: unknown }).source !== "imported_doc",
  );
  const deleted = parsed.length - filtered.length;
  if (deleted === 0) return 0;
  const temporaryPath = `${filePath}.cleanup`;
  fs.writeFileSync(temporaryPath, JSON.stringify(filtered, null, 2), "utf8");
  fs.renameSync(temporaryPath, filePath);
  return deleted;
}

async function removeImportedDocumentData(dataDir: string): Promise<number> {
  let removed = 0;

  for (const filePath of [
    path.join(dataDir, "memory-store.json"),
    path.join(dataDir, "memory-store.json.tmp"),
  ]) {
    try {
      removed += stripImportedDocumentEntries(filePath);
    } catch (error) {
      logger.warn(LogTag.RAG, "failed to remove imported document vectors from pending store:", filePath, error);
    }
  }

  for (const filePath of [
    path.join(dataDir, "memory-store.json.tmp.cleanup"),
    path.join(dataDir, "document-cache.json"),
    path.join(dataDir, "document-cache.json.tmp"),
  ]) {
    try {
      fs.rmSync(filePath, { force: true });
    } catch (error) {
      logger.warn(LogTag.RAG, "failed to remove imported document cache:", filePath, error);
    }
  }

  const backupDir = path.join(path.dirname(dataDir), "memory-reconcile-backups");
  try {
    for (const name of fs.readdirSync(backupDir)) {
      if (!name.startsWith("memory-store.") || !name.endsWith(".json")) continue;
      const filePath = path.join(backupDir, name);
      try {
        removed += stripImportedDocumentEntries(filePath);
      } catch (error) {
        logger.warn(LogTag.RAG, "failed to remove imported document vectors from backup:", filePath, error);
      }
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      logger.warn(LogTag.RAG, "failed to scan memory reconciliation backups:", error);
    }
  }

  return removed;
}

// ── Init ──
export async function initRAG(
  ragMode: "auto" | "local" | "cloud" = "auto",
  cloudBaseUrl?: string,
  cloudApiKey?: string,
  embeddingModel?: string,
  cloudDimensions?: number,
): Promise<void> {
  if (isMemoryEnabled()) {
    await initVectorMemory(ragMode, cloudBaseUrl, cloudApiKey, embeddingModel, cloudDimensions);
  }
  await initWorldbook();
}

async function trackVectorOperation<T>(operation: () => Promise<T>): Promise<T> {
  activeVectorOperations++;
  try {
    return await operation();
  } finally {
    activeVectorOperations--;
    if (activeVectorOperations === 0) {
      for (const resolve of vectorOperationsDrained) resolve();
      vectorOperationsDrained.clear();
    }
  }
}

async function waitForVectorOperations(): Promise<void> {
  if (activeVectorOperations === 0) return;
  await new Promise<void>((resolve) => { vectorOperationsDrained.add(resolve); });
}

export async function initVectorMemory(
  ragMode: "auto" | "local" | "cloud" = "auto",
  cloudBaseUrl?: string,
  cloudApiKey?: string,
  embeddingModel?: string,
  cloudDimensions?: number,
): Promise<void> {
  const dataDir = getDataDir();
  provider = getEmbeddingProvider(ragMode, cloudBaseUrl, cloudApiKey, embeddingModel, cloudDimensions);
  const removedImportedDocumentVectors = await removeImportedDocumentData(dataDir);
  store = new JsonVectorStore(dataDir);
  if (removedImportedDocumentVectors > 0) {
    logger.info(LogTag.RAG, `removed ${removedImportedDocumentVectors} imported document vectors`);
  }
  // 只有 provider 存在时才创建 retriever（向量检索依赖 embedding）
  if (provider) {
    retriever = new HybridRetriever(store, provider);
  }
  logger.info(
    LogTag.RAG,
    "vector memory initialized. Mode:", ragMode,
    "Provider:", provider?.name ?? "none",
    "Dims:", provider?.dims ?? "N/A",
    "Memories:", store.stats.total,
    provider ? "" : " [Vector retrieval disabled]"
  );
}

export async function initWorldbook(): Promise<void> {
  worldbook = new WorldbookManager(
    findPromptPath("worldbook") ?? path.join(app.getPath("userData"), "empty-worldbook"),
    { stateFile: path.join(app.getPath("userData"), "worldbook-state.json") }
  );
  await worldbook.loadFromDirectory();

  // 把实体图谱中的已有实体名灌入 jieba 自定义词典
  // 防止 "昔涟"、"小鹿" 等 AI 伴侣核心名词被错误切分
  await feedEntityNamesToJieba();
  logger.info(LogTag.RAG, "worldbook initialized");
}

/** 关闭向量记忆并释放当前进程持有的索引和嵌入模型引用；不删除磁盘数据。 */
export async function disposeVectorMemory(): Promise<void> {
  await waitForVectorOperations();
  await store?.flush();
  store = null;
  retriever = null;
  provider = null;
  resetEmbeddingProvider();
}

/** 受控退出（before-quit 链路）时调用：把防抖中的记忆数据刷盘。 */
export async function flushRAGStore(): Promise<void> {
  await store?.flush();
}

/** 会话紧急结束（Windows session-end）时调用：同步落盘，不等待异步 I/O。 */
export function flushRAGStoreSync(): void {
  store?.flushSync();
}

// ── Switch embedding model (hot-swap) ──
export async function switchEmbeddingModel(modelKey: string): Promise<{ ok: boolean; clearedEntries: number; error?: string }> {
  if (!isMemoryEnabled()) return { ok: false, clearedEntries: 0, error: "记忆模式已关闭" };
  try {
    // Switch the embedding pipeline first
    switchModel(modelKey);
    const newProvider = getEmbeddingProvider("auto", undefined, undefined, modelKey);

    // 模型不存在时无法切换 — 输出详细诊断帮助排查"放到 models/ 却检测不到"
    if (!newProvider) {
      try {
        // require to avoid circular import at module load
        const { getModelInstallStatusDetail } = require("./model-status") as typeof import("./model-status");
        const detail = getModelInstallStatusDetail("embedding", modelKey);
        if (detail.existingProjectDir) {
          console.error(
            `[Cyrene] embedding model "${modelKey}" project directory exists but is incomplete.\n` +
            `  existingProjectDir: ${detail.existingProjectDir}\n` +
            `  requiredFiles:      ${JSON.stringify(detail.requiredFiles)}\n` +
            `  missingFiles:       ${JSON.stringify(detail.missingFiles)}\n` +
            `  HF cache fallback suppressed. Fix the files above, then retry.`,
          );
        } else {
          console.error(
            `[Cyrene] embedding model "${modelKey}" not detected anywhere.\n` +
            `  modelDirCandidates: ${JSON.stringify(detail.modelDirCandidates)}\n` +
            `  subPathCandidates:  ${JSON.stringify(detail.subPathCandidates)}\n` +
            `  requiredFiles:      ${JSON.stringify(detail.requiredFiles)}\n` +
            `  Drop the model files into one of the candidates above.`,
          );
        }
      } catch (diagErr) {
        console.error("[Cyrene] model diagnostic log failed:", diagErr);
      }
      return { ok: false, clearedEntries: 0, error: "Local embedding model not found. Cannot switch." };
    }

    const newDims = newProvider.dims;

    // Check existing entries for dimension mismatch
    let clearedEntries = 0;
    if (store) {
      const entries = (store as any).entries as Array<{ embedding: number[] }> | undefined;
      if (entries && entries.length > 0) {
        const oldDims = entries[0].embedding.length;
        if (oldDims !== newDims) {
          clearedEntries = entries.length;
          // 清空内存与磁盘（含取消防抖中的待写落盘），防止旧维度向量被写回刚清空的文件
          store.clearForRebuild();
          console.log("[RAG] dimension mismatch (" + oldDims + " → " + newDims + "), cleared " + clearedEntries + " entries");
          // 清除旧的索引元数据，下次写入时会自动创建新的
          const metaPath = path.join(getDataDir(), "memory-store-meta.json");
          if (fs.existsSync(metaPath)) {
            fs.unlinkSync(metaPath);
          }
        }
      }
    }

    // Update provider reference and retriever
    provider = newProvider;
    if (store) {
      retriever = new HybridRetriever(store, provider);
    }

    console.log("[RAG] switched embedding model to", modelKey, "dims:", newDims, "cleared:", clearedEntries);
    return { ok: true, clearedEntries };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[RAG] switch embedding model failed:", message);
    return { ok: false, clearedEntries: 0, error: message };
  }
}

/**
 * 获取当前向量索引的元数据（只读）。
 * 用于设置 UI 展示或诊断。
 */
export function getIndexMetadata(): Readonly<EmbeddingIndexMetadata> | null {
  return store?.getIndexMeta() ?? null;
}

// ── Memory write ──
export async function addMemory(
  text: string,
  source = "user_memory",
  metadata?: Record<string, unknown>
): Promise<string> {
  if (!isMemoryEnabled()) throw new Error("记忆模式已关闭");
  if (!store || !provider) throw new Error("RAG not initialized");
  const currentStore = store;
  const currentProvider = provider;
  return trackVectorOperation(async () => {
    const entry = await currentStore.add(text, source, currentProvider, metadata);
    return entry.id;
  });
}

export async function addL2MemoryVector(
  text: string,
  l2Id: string,
  metadata?: Record<string, unknown>,
): Promise<string> {
  if (!isMemoryEnabled()) throw new Error("记忆模式已关闭");
  if (!store || !provider) throw new Error("RAG not initialized");
  if (!l2Id.trim()) throw new Error("l2Id is required");
  const currentStore = store;
  const currentProvider = provider;
  return trackVectorOperation(async () => {
    const entry = await currentStore.addUnique(text, "user_memory", currentProvider, { ...metadata, l2Id });
    return entry.id;
  });
}

// ── Memory search ──
export async function searchMemory(
  query: string,
  source?: string,
  topK = 5,
  options?: { recordRecall?: boolean }
): Promise<string[]> {
  const results = await searchMemoryEntries(query, source, topK, options);
  return results.map((r) => r.text);
}

export async function searchMemoryEntries(
  query: string,
  source?: string,
  topK = 5,
  options?: { recordRecall?: boolean }
): Promise<Array<{ id: string; text: string; createdAt: number; score: number; metadata?: Record<string, unknown> }>> {
  if (!isMemoryEnabled()) return [];
  return trackVectorOperation(() => searchMemoryEntriesEnabled(query, source, topK, options));
}

async function searchMemoryEntriesEnabled(
  query: string,
  source?: string,
  topK = 5,
  options?: { recordRecall?: boolean },
): Promise<Array<{ id: string; text: string; createdAt: number; score: number; metadata?: Record<string, unknown> }>> {
  if (!retriever) return [];
  let allowedEntryIds: string[] | undefined;
  if (source === "user_memory") {
    try {
      const { memoryStore } = await import("../memory/memory-store.js");
      const memories = await memoryStore.getAllL2();
      const recallableById = new Map(
        memories.filter(isL2LocallyRecallable).map((memory) => [memory.id, memory]),
      );
      allowedEntryIds = getEntriesBySource("user_memory")
        .filter((entry) => {
          const l2Id = entry.metadata?.l2Id;
          if (typeof l2Id !== "string") return false;
          return recallableById.get(l2Id)?.ragId === entry.id;
        })
        .map((entry) => entry.id);
    } catch (err) {
      console.warn("[RAG] failed to resolve recallable user memories:", err);
      return [];
    }
  }
  const results = await retriever.retrieve(query, source, topK, { allowedEntryIds });
  if (options?.recordRecall !== false) {
    await recordUserMemoryRecalls(results);
  }
  return results.map((r) => ({
    id: r.entry.id,
    text: r.entry.text,
    createdAt: r.entry.createdAt,
    score: r.score,
    metadata: r.entry.metadata,
  }));
}

async function recordUserMemoryRecalls(results: Array<{ entry: MemoryEntry }>): Promise<void> {
  const l2Ids = results
    .filter((r) => r.entry.source === "user_memory")
    .map((r) => r.entry.metadata?.l2Id)
    .filter((id): id is string => typeof id === "string" && id.length > 0);
  if (l2Ids.length === 0) return;
  try {
    const { memoryStore } = await import("../memory/memory-store.js");
    for (const l2Id of new Set(l2Ids)) {
      await memoryStore.updateL2RecallStats(l2Id, 1);
    }
  } catch (err) {
    console.warn("[RAG] failed to record user memory recall:", err);
  }
}

// ── History search with metadata（供 recall_history 工具用）──
// 跟 searchMemory 的区别：返回完整 entry（含 createdAt / metadata），
// 让召回工具能按时间排序、展示时间戳。
export async function searchHistoryEntries(
  query: string,
  topK = 5
): Promise<Array<{ text: string; createdAt: number; score: number; metadata?: Record<string, unknown> }>> {
  if (!isMemoryEnabled()) return [];
  return trackVectorOperation(async () => {
    if (!retriever) return [];
    const results = await retriever.retrieve(query, "chat_history", topK);
    return results.map((r) => ({
      text: r.entry.text,
      createdAt: r.entry.createdAt,
      score: r.score,
      metadata: r.entry.metadata,
    }));
  });
}

// ── Worldbook DMAE：每轮打分（本轮用户输入 + 上轮模型回复）──
export function updateWorldbookActivation(userText: string, modelText: string, turn?: number): void {
  if (!worldbook) return;
  const t = turn ?? ++worldbookTurnCounter;
  worldbook.updateActivation(userText, modelText, t);
}

// ── Worldbook DMAE：取 Active 条目内容（阈值门控 + 注入）──
export function getActiveWorldbookEntries(): string[] {
  if (!worldbook) return [];
  return worldbook.getActiveEntries();
}

// ── Worldbook One-Shot：取本轮 cascade 触发的条目（不入 DMAE 状态表）──
// 返回带条目标题的完整内容（与 getActiveWorldbookEntries 一致格式，便于合并注入）
export function getCascadeWorldbookEntries(): string[] {
  if (!worldbook) return [];
  return worldbook.getCascadeEntries().map(e => {
    const title = e.id.replace(/^wb_[^_]+_/, "").replace(/_/g, " ");
    return `【${title}】\n${e.content}`;
  });
}

// ── Get permanent worldbook entries ──
export function getPermanentWorldbookEntries(): string[] {
  if (!worldbook) return [];
  return worldbook.getPermanentEntries();
}

// ── Worldbook 关键词直查：后台轻量调用（Moments 反应/发帖等）用，不经 DMAE 状态机 ──
// 文本命中任一触发词即注入该条目，调用方自行决定合并常驻条目。
export function getKeywordMatchedWorldbookEntries(text: string): string[] {
  if (!worldbook) return [];
  const t = text ?? "";
  if (!t.trim()) return [];
  return worldbook.getEntries()
    .filter((e) => e.enabled && !e.permanent && e.keywords.length > 0)
    .filter((e) => e.keywords.some((kw) => t.includes(kw)))
    .sort((a, b) => b.priority - a.priority)
    .map((e) => {
      const title = e.id.replace(/^wb_[^_]+_/, "").replace(/_/g, " ");
      return `【${title}】\n${e.content}`;
    });
}

// ── Build memory context (legacy, kept for compatibility) ──
// 注意：单参签名无 modelText，故 model 奖励不触发（降级行为）。
// 主流程已改用 orchestrator 的 buildAlwaysOnContext（会传上轮模型回复）。
export async function buildMemoryContext(userInput: string): Promise<string> {
  const parts: string[] = [];

  // 1. Worldbook（DMAE：打分 + 取 Active）
  updateWorldbookActivation(userInput, "");
  const wbResults = getActiveWorldbookEntries();
  if (wbResults.length > 0) {
    parts.push("\u3010\u76f8\u5173\u80cc\u666f\u3011\n" + wbResults.join("\n\n"));
  }

  // 2. User memory
  const memResults = await searchMemory(userInput, "user_memory", 3);
  if (memResults.length > 0) {
    parts.push("\u3010\u5173\u4e8e\u7528\u6237\u7684\u8bb0\u5fc6\u3011\n" + memResults.map((m) => "- " + m).join("\n"));
  }

  return parts.join("\n\n");
}

// ── Reset ──
export function resetRAG(): void {
  store = null;
  retriever = null;
  worldbook = null;
  provider = null;
  resetEmbeddingProvider();
}

export function getRAGStats() {
  return store?.stats ?? { total: 0, sources: {} };
}

export function isUserMemoryVectorStoreReady(): boolean {
  return store !== null && provider !== null;
}

/**
 * 获取指定 source 的所有向量条目（含 embedding），用于片段压缩 / 聚类。
 * 返回浅拷贝，调用方不应修改返回的 embedding。
 */
export function getEntriesBySource(source: string): Array<{ id: string; text: string; embedding: number[]; createdAt: number; weight: number; metadata?: Record<string, unknown> }> {
  if (!store) return [];
  return ((store as any).entries as MemoryEntry[])
    .filter((e) => e.source === source)
    .map((e) => ({ id: e.id, text: e.text, embedding: e.embedding, createdAt: e.createdAt, weight: e.weight, metadata: e.metadata }));
}

export function deleteUserMemoryVectors(ragIds: string[]): number {
  if (!store) throw new Error("RAG not initialized");
  return store.deleteEntriesByIds(ragIds, "user_memory");
}
