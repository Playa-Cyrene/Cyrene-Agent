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
import { chunkText } from "./chunk";
import { feedEntityNamesToJieba } from "../memory/entity-graph";
import { isL2LocallyRecallable } from "../memory/memory-types";
import type { DocumentImportControl } from "./file-ingest";
import { findPromptPath } from "../external-content-paths";

// ── Global RAG instances ──
let store: JsonVectorStore | null = null;
let retriever: HybridRetriever | null = null;
let worldbook: WorldbookManager | null = null;
let provider: EmbeddingProvider | null = null;
// 每轮对话递增，用于 DMAE repeatWindow 统计（worldbook 状态不持久化，重启回 0 可接受）
let worldbookTurnCounter = 0;

function getDataDir(): string {
  return path.join(app.getPath("userData"), "rag-data");
}

// ── Init ──
export async function initRAG(
  ragMode: "auto" | "local" | "cloud" = "auto",
  cloudBaseUrl?: string,
  cloudApiKey?: string,
  embeddingModel?: string,
  cloudDimensions?: number,
): Promise<void> {
  const dataDir = getDataDir();
  provider = getEmbeddingProvider(ragMode, cloudBaseUrl, cloudApiKey, embeddingModel, cloudDimensions);
  store = new JsonVectorStore(dataDir);
  // 只有 provider 存在时才创建 retriever（向量检索依赖 embedding）
  if (provider) {
    retriever = new HybridRetriever(store, provider);
  }
  worldbook = new WorldbookManager(
    findPromptPath("worldbook") ?? path.join(app.getPath("userData"), "empty-worldbook"),
    { stateFile: path.join(app.getPath("userData"), "worldbook-state.json") }
  );
  await worldbook.loadFromDirectory();

  // 把实体图谱中的已有实体名灌入 jieba 自定义词典
  // 防止 "昔涟"、"小鹿" 等 AI 伴侣核心名词被错误切分
  await feedEntityNamesToJieba();

  logger.info(
    LogTag.RAG,
    "initialized. Mode:", ragMode,
    "Provider:", provider?.name ?? "none",
    "Dims:", provider?.dims ?? "N/A",
    "Memories:", store.stats.total,
    provider ? "" : " [Vector retrieval disabled]"
  );
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
  if (!store || !provider) throw new Error("RAG not initialized");
  const entry = await store.add(text, source, provider, metadata);
  return entry.id;
}

export async function addL2MemoryVector(
  text: string,
  l2Id: string,
  metadata?: Record<string, unknown>,
): Promise<string> {
  if (!store || !provider) throw new Error("RAG not initialized");
  if (!l2Id.trim()) throw new Error("l2Id is required");
  const entry = await store.addUnique(text, "user_memory", provider, { ...metadata, l2Id });
  return entry.id;
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
  if (!retriever) return [];
  let allowedEntryIds: string[] | undefined;
  if (source === "user_memory") {
    try {
      const { memoryStore } = await import("../memory/memory-store");
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
    const { memoryStore } = await import("../memory/memory-store");
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
  if (!retriever) return [];
  const results = await retriever.retrieve(query, "chat_history", topK);
  return results.map((r) => ({
    text: r.entry.text,
    createdAt: r.entry.createdAt,
    score: r.score,
    metadata: r.entry.metadata,
  }));
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

// ── Import document ──
export type ImportedDocumentResult = {
  importId: string;
  chunkCount: number;
};

export type ImportedDocumentChunk = {
  text: string;
  score: number;
  fileName?: string;
  chunkIndex?: number;
  importId?: string;
};

export type PreparedDocumentEmbedding = {
  text: string;
  chunkIndex: number;
  embedding: number[];
};

export async function appendPreparedDocumentBatch(
  fileName: string,
  importId: string,
  prepared: PreparedDocumentEmbedding[],
): Promise<void> {
  if (!store) throw new Error("RAG not initialized");
  const added = store.addPreparedBatch(prepared.map((entry) => ({
    text: entry.text,
    embedding: entry.embedding,
    source: "imported_doc",
    metadata: { fileName, chunkIndex: entry.chunkIndex, importId },
  })));
  // 后台预热新条目的 BM25 分词，避免首次检索才付出冷启动成本；不阻塞导入返回
  void retriever?.warmupBm25Tokens(added);
}

export async function importPreparedDocumentForTurn(
  fileName: string,
  prepared: PreparedDocumentEmbedding[],
): Promise<ImportedDocumentResult> {
  if (!store) throw new Error("RAG not initialized");
  const id = typeof crypto !== "undefined" && crypto.randomUUID
    ? crypto.randomUUID()
    : Math.random().toString(36).slice(2, 8);
  const importId = `import-${Date.now()}-${id}`;
  await appendPreparedDocumentBatch(fileName, importId, prepared);
  // 导入是高成本操作（全部 chunk 已完成嵌入），立即落盘保证持久性
  await store.flush();
  return { importId, chunkCount: prepared.length };
}

export async function importDocumentForTurn(
  text: string,
  fileName: string,
  control?: DocumentImportControl,
): Promise<ImportedDocumentResult> {
  if (!store || !provider) throw new Error("RAG not initialized");
  const chunks = chunkText(text, "doc_" + fileName);
  control?.onProgress?.({ status: "chunking", completedChunks: chunks.length, totalChunks: chunks.length });
  if (control?.isCancelled?.()) throw new Error("cancelled");
  const id = typeof crypto !== "undefined" && crypto.randomUUID
    ? crypto.randomUUID()
    : Math.random().toString(36).slice(2, 8);
  const importId = `import-${Date.now()}-${id}`;
  control?.onProgress?.({ status: "embedding", completedChunks: 0, totalChunks: chunks.length });
  const added = await store.addBatch(
    chunks.map((c) => ({ text: c.text, source: "imported_doc", metadata: { fileName, chunkIndex: c.index, importId } })),
    provider,
    { isCancelled: control?.isCancelled },
  );
  // 导入是高成本操作（全部 chunk 已完成嵌入），立即落盘保证持久性
  await store.flush();
  // 后台预热新条目的 BM25 分词，避免首次检索才付出冷启动成本；不阻塞导入返回
  void retriever?.warmupBm25Tokens(added);
  return { importId, chunkCount: chunks.length };
}

export async function importDocument(text: string, fileName: string): Promise<number> {
  const result = await importDocumentForTurn(text, fileName);
  return result.chunkCount;
}

export async function searchImportedDocumentChunksForImportIds(
  query: string,
  importIds: string[],
  topK = 6,
): Promise<ImportedDocumentChunk[]> {
  if (!retriever || !query.trim() || importIds.length === 0) return [];
  const results = await retriever.retrieve(query, "imported_doc", topK, { importIds });
  return results.map((result) => ({
    text: result.entry.text,
    score: result.score,
    fileName: typeof result.entry.metadata?.fileName === "string" ? result.entry.metadata.fileName : undefined,
    chunkIndex: typeof result.entry.metadata?.chunkIndex === "number" ? result.entry.metadata.chunkIndex : undefined,
    importId: typeof result.entry.metadata?.importId === "string" ? result.entry.metadata.importId : undefined,
  }));
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

  // 2. Imported docs
  const docResults = await searchMemory(userInput, "imported_doc", 5);
  if (docResults.length > 0) {
    parts.push("\u3010\u76f8\u5173\u6587\u4ef6\u7247\u6bb5\u3011\n" + docResults.map((m) => "- " + m).join("\n"));
  }

  // 3. User memory
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

export function deleteImportedDoc(importId: string, fileName?: string): number {
  if (!store) throw new Error("RAG not initialized");
  return store.deleteImportedDoc(importId, fileName);
}

export function hasImportedDocumentChunks(importId: string): boolean {
  return store?.hasImportedDocumentChunks(importId) ?? false;
}
