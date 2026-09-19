import * as fs from "fs";
import * as path from "path";
import { getEmbeddingProvider, EmbeddingProvider, type EmbeddingIndexMetadata } from "./embedding";

export type { EmbeddingIndexMetadata };

// ── 类型 ──
export interface MemoryEntry {
  id: string;
  text: string;
  embedding: number[];
  source: string;       // "user_memory" | "worldbook" | "imported_doc"
  weight: number;       // 1.0 初始，每次召回 +0.1，24h 未提 ×0.95
  createdAt: number;    // timestamp
  lastRecalledAt: number;
  metadata?: Record<string, unknown>;
}

export interface SearchResult {
  entry: MemoryEntry;
  score: number;        // 加权后的综合分数（余弦 × weight × 衰减）
}

export interface VectorSearchOptions {
  importIds?: string[];
  allowedEntryIds?: string[];
}

// ── 余弦相似度（嵌入已归一化，等价于点积） ──
export function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
  }
  return dot;
}

// ── JSON 向量存储 ──
export class JsonVectorStore {
  private filePath: string;
  private metaFilePath: string;
  private entries: MemoryEntry[] = [];
  private dirty = false;
  private indexMeta: EmbeddingIndexMetadata | null = null;

  constructor(dbPath: string) {
    this.filePath = path.join(dbPath, "memory-store.json");
    this.metaFilePath = path.join(dbPath, "memory-store-meta.json");
    this.load();
    this.loadIndexMeta();
  }

  private load(): void {
    try {
      if (fs.existsSync(this.filePath)) {
        const raw = fs.readFileSync(this.filePath, "utf8");
        this.entries = JSON.parse(raw) as MemoryEntry[];
      }
    } catch (err) {
      console.warn("[RAG] failed to load vector store:", err);
      this.entries = [];
    }
  }

  private loadIndexMeta(): void {
    try {
      if (fs.existsSync(this.metaFilePath)) {
        const raw = fs.readFileSync(this.metaFilePath, "utf8");
        this.indexMeta = JSON.parse(raw) as EmbeddingIndexMetadata;
      }
    } catch {
      this.indexMeta = null;
    }
  }

  private saveIndexMeta(): void {
    try {
      const dir = path.dirname(this.metaFilePath);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      const tmp = this.metaFilePath + ".tmp";
      fs.writeFileSync(tmp, JSON.stringify(this.indexMeta, null, 2), "utf8");
      fs.renameSync(tmp, this.metaFilePath);
    } catch (err) {
      console.warn("[RAG] failed to save index metadata:", err);
    }
  }

  private save(): void {
    try {
      const dir = path.dirname(this.filePath);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(this.filePath, JSON.stringify(this.entries, null, 2), "utf8");
      this.dirty = false;
    } catch (err) {
      console.warn("[RAG] failed to save vector store:", err);
    }
  }

  // ── 索引元数据校验 ──

  /**
   * 校验 provider 的维度与索引元数据是否一致。
   * - 无元数据 + 有旧数据：尝试从现有向量推断并补写元数据（兼容迁移）
   * - 无元数据 + 无数据：首次写入时创建元数据
   * - 有元数据：严格校验维度一致性
   */
  private validateDimensionsForProvider(provider: EmbeddingProvider): void {
    const providerDims = provider.resolvedDimensions ?? provider.declaredDimensions;
    if (providerDims === undefined) {
      // 维度尚未解析（cloud provider 首次调用前），允许通过
      // 后续 embed() 调用会自行解析并校验
      return;
    }

    if (!this.indexMeta) {
      // 无元数据：尝试兼容迁移
      if (this.entries.length > 0) {
        const inferredDims = this.entries[0].embedding.length;
        if (inferredDims !== providerDims) {
          throw new Error(
            `[RAG] Index dimension mismatch: existing index has ${inferredDims}-dim vectors, ` +
            `but provider declares ${providerDims}-dim. Rebuild the index first.`
          );
        }
        // 维度一致，补写元数据
        this.indexMeta = this.buildIndexMeta(provider, providerDims);
        this.saveIndexMeta();
        console.log("[RAG] migrated index metadata (inferred from existing vectors):", this.indexMeta);
      }
      return;
    }

    // 有元数据：严格校验
    if (this.indexMeta.dimensions !== providerDims) {
      throw new Error(
        `[RAG] Index dimension mismatch: index was built with ${this.indexMeta.dimensions}-dim ` +
        `(model: ${this.indexMeta.model}), but current provider declares ${providerDims}-dim. ` +
        `Rebuild the index or switch back to the original model.`
      );
    }
  }

  /**
   * 首次写入时，如果还没有元数据，根据 provider 创建并保存。
   */
  private ensureIndexMeta(provider: EmbeddingProvider, resolvedDims: number): void {
    if (this.indexMeta) return;
    this.indexMeta = this.buildIndexMeta(provider, resolvedDims);
    this.saveIndexMeta();
    console.log("[RAG] created index metadata:", this.indexMeta);
  }

  private buildIndexMeta(provider: EmbeddingProvider, dimensions: number): EmbeddingIndexMetadata {
    const identity = provider.cacheIdentity;
    return {
      provider: identity?.provider ?? provider.name,
      model: identity?.model ?? provider.name,
      dimensions,
      cacheIdentity: identity ? JSON.stringify(identity) : provider.name,
    };
  }

  /**
   * 获取当前索引元数据（只读）。
   */
  getIndexMeta(): Readonly<EmbeddingIndexMetadata> | null {
    return this.indexMeta;
  }

  // ── CRUD ──

  // 添加记忆（自动去重）
  async add(
    text: string,
    source: string,
    provider: EmbeddingProvider,
    metadata?: Record<string, unknown>
  ): Promise<MemoryEntry> {
    this.validateDimensionsForProvider(provider);

    // 去重检查
    const existing = await this.search(text, source, provider, 1, 0.95);
    if (existing.length > 0) {
      // 更新权重和时间
      existing[0].entry.weight = Math.min(existing[0].entry.weight + 0.1, 5.0);
      existing[0].entry.lastRecalledAt = Date.now();
      this.dirty = true;
      this.save();
      return existing[0].entry;
    }

    const embedding = await provider.embed(text);
    // 首次成功写入后记录索引元数据
    this.ensureIndexMeta(provider, embedding.length);
    const entry: MemoryEntry = {
      id: `${source}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      text,
      embedding,
      source,
      weight: 1.0,
      createdAt: Date.now(),
      lastRecalledAt: Date.now(),
      metadata,
    };

    this.entries.push(entry);
    this.dirty = true;
    this.save();
    return entry;
  }

  async addUnique(
    text: string,
    source: string,
    provider: EmbeddingProvider,
    metadata?: Record<string, unknown>,
  ): Promise<MemoryEntry> {
    this.validateDimensionsForProvider(provider);
    const embedding = await provider.embed(text);
    this.ensureIndexMeta(provider, embedding.length);
    return this.addPreparedBatch([{ text, source, embedding, metadata }])[0];
  }

  // 批量添加（用于导入文档 chunk）
  async addBatch(
    items: Array<{ text: string; source: string; metadata?: Record<string, unknown> }>,
    provider: EmbeddingProvider,
    options?: { isCancelled?: () => boolean },
  ): Promise<MemoryEntry[]> {
    this.validateDimensionsForProvider(provider);
    const results: MemoryEntry[] = [];
    const batchSize = 16;
    for (let start = 0; start < items.length; start += batchSize) {
      if (options?.isCancelled?.()) throw new Error("cancelled");
      const batch = items.slice(start, start + batchSize);
      const embeddings = await provider.embedBatch(batch.map((item) => item.text));
      if (options?.isCancelled?.()) throw new Error("cancelled");
      // 首次成功批量写入后记录索引元数据
      if (embeddings.length > 0) {
        this.ensureIndexMeta(provider, embeddings[0].length);
      }
      results.push(...this.addPreparedBatch(batch.map((item, index) => ({ ...item, embedding: embeddings[index] }))));
    }
    return results;
  }

  addPreparedBatch(
    items: Array<{ text: string; source: string; embedding: number[]; metadata?: Record<string, unknown> }>,
  ): MemoryEntry[] {
    const results: MemoryEntry[] = [];

    for (let i = 0; i < items.length; i++) {
      const entry: MemoryEntry = {
        id: `${items[i].source}_${Date.now()}_${i}_${Math.random().toString(36).slice(2, 6)}`,
        text: items[i].text,
        embedding: items[i].embedding,
        source: items[i].source,
        weight: 1.0,
        createdAt: Date.now(),
        lastRecalledAt: Date.now(),
        metadata: items[i].metadata,
      };
      this.entries.push(entry);
      results.push(entry);
    }

    this.dirty = true;
    this.save();
    return results;
  }

  // 搜索（全量余弦扫描，实测 1 万条约 9ms，无需近似索引）
  async search(
    query: string,
    source?: string,
    provider?: EmbeddingProvider,
    topK = 5,
    minScore = 0.3,
    options: VectorSearchOptions = {},
  ): Promise<SearchResult[]> {
    if (this.entries.length === 0) return [];

    const embeddingProvider = provider ?? getEmbeddingProvider();
    if (!embeddingProvider) return [];

    this.validateDimensionsForProvider(embeddingProvider);

    const queryEmbedding = await embeddingProvider.embed(query);

    const now = Date.now();
    const results: SearchResult[] = [];
    const allowedImportIds = new Set(options.importIds ?? []);
    const allowedEntryIds = options.allowedEntryIds ? new Set(options.allowedEntryIds) : null;
    const shouldKeep = (entry: MemoryEntry) =>
      (!allowedImportIds.size || allowedImportIds.has(String(entry.metadata?.importId ?? ""))) &&
      (!allowedEntryIds || allowedEntryIds.has(entry.id));

    // 全量扫描：实测 1 万条仅约 9ms，无需近似索引（IVF 已移除）
    for (const entry of this.entries) {
      if (source && entry.source !== source) continue;
      if (!shouldKeep(entry)) continue;

      const sim = cosineSimilarity(queryEmbedding, entry.embedding);
      // 时间衰减：24h 未提及权重 ×0.95
      const hoursSinceRecall = (now - entry.lastRecalledAt) / (1000 * 60 * 60);
      const decayFactor = Math.pow(0.95, hoursSinceRecall / 24);
      const weightedScore = sim * entry.weight * decayFactor;

      if (weightedScore >= minScore) {
        results.push({ entry, score: weightedScore });
      }
    }

    // 排序并取 topK
    results.sort((a, b) => b.score - a.score);
    const top = results.slice(0, topK);

    // 更新召回时间（仅对 topK 结果）
    for (const r of top) {
      r.entry.lastRecalledAt = now;
      r.entry.weight = Math.min(r.entry.weight + 0.05, 5.0);
    }
    if (top.length > 0) {
      this.dirty = true;
      this.save();
    }

    return top;
  }

  // 清理低权重记忆
  prune(minWeight = 0.1): number {
    const before = this.entries.length;
    this.entries = this.entries.filter((e) => e.weight >= minWeight);
    this.dirty = true;
    this.save();
    return before - this.entries.length;
  }

  deleteEntriesByIds(ids: string[], source?: string): number {
    const idSet = new Set(ids);
    if (idSet.size === 0) return 0;
    const before = this.entries.length;
    this.entries = this.entries.filter((entry) => !idSet.has(entry.id) || (source !== undefined && entry.source !== source));
    const deleted = before - this.entries.length;
    if (deleted > 0) {
      this.dirty = true;
      this.save();
    }
    return deleted;
  }

  // 删除导入文档
  deleteImportedDoc(importId: string, fileName?: string): number {
    const before = this.entries.length;
    this.entries = this.entries.filter((e) => {
      if (e.source !== "imported_doc") return true;
      // 新数据：按 importId 精确匹配
      if (e.metadata?.importId) {
        return e.metadata.importId !== importId;
      }
      // 旧数据：按 fileName 匹配
      if (fileName && e.metadata?.fileName === fileName) {
        return false;
      }
      return true;
    });
    const deleted = before - this.entries.length;
    if (deleted > 0) {
      this.dirty = true;
      this.save();
    }
    return deleted;
  }

  hasImportedDocumentChunks(importId: string): boolean {
    return this.entries.some(
      (entry) => entry.source === "imported_doc" && String(entry.metadata?.importId ?? "") === importId,
    );
  }

  // 统计
  get stats() {
    const sources: Record<string, number> = {};
    for (const e of this.entries) {
      sources[e.source] = (sources[e.source] || 0) + 1;
    }
    return { total: this.entries.length, sources };
  }
}
