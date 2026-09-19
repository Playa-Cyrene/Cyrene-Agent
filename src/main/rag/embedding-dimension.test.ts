import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  createOpenAIEmbeddingProvider,
  EmbeddingDimensionMismatchError,
  EmbeddingBatchDimensionInconsistencyError,
} from "./embedding";
import type { EmbeddingProvider, EmbeddingIndexMetadata } from "./embedding";
import { JsonVectorStore } from "./vectorstore";

// ── helpers ──

function makeProvider(opts?: {
  declared?: number;
  responseDims?: number;
  batchResponseDims?: number[];
}): EmbeddingProvider {
  const responseDims = opts?.responseDims ?? 1024;
  const batchDims = opts?.batchResponseDims;

  // We test createOpenAIEmbeddingProvider by mocking global fetch
  const declared = opts?.declared;

  const provider = createOpenAIEmbeddingProvider(
    "https://fake.api/v1",
    "sk-test",
    "test-model",
    declared,
  );

  return provider;
}

/** Create a mock provider that returns embeddings of specified dimensions */
function mockFetchForDims(dims: number): void {
  vi.stubGlobal("fetch", vi.fn(async () => ({
    ok: true,
    json: async () => ({
      data: [{ embedding: new Array(dims).fill(0.1) }],
    }),
  })));
}

function mockFetchForBatch(dimsPerItem: number[]): void {
  vi.stubGlobal("fetch", vi.fn(async () => ({
    ok: true,
    json: async () => ({
      data: dimsPerItem.map((d) => ({ embedding: new Array(d).fill(0.1) })),
    }),
  })));
}

describe("createOpenAIEmbeddingProvider — dimension detection", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  // Test 1: 未配置维度，首次返回 1024，成功探测并保存
  it("auto-detects dimensions from first embed response when not declared", async () => {
    mockFetchForDims(1024);
    const provider = makeProvider({ declared: undefined, responseDims: 1024 });

    expect(provider.declaredDimensions).toBeUndefined();
    expect(provider.resolvedDimensions).toBeUndefined();

    const embedding = await provider.embed("hello");

    expect(embedding.length).toBe(1024);
    expect(provider.resolvedDimensions).toBe(1024);
    expect(provider.dims).toBe(1024);
    expect(provider.cacheIdentity).toEqual({
      provider: "openai-compat",
      model: "test-model",
      dimensions: 1024,
      endpoint: "https://fake.api/v1",
    });
  });

  // Test 2: 配置 1536，实际返回 1024，明确报错
  it("throws EMBEDDING_DIMENSION_MISMATCH when declared 1536 but actual is 1024", async () => {
    mockFetchForDims(1024);
    const provider = makeProvider({ declared: 1536 });

    expect(provider.declaredDimensions).toBe(1536);

    await expect(provider.embed("hello")).rejects.toThrow(EmbeddingDimensionMismatchError);
    await expect(provider.embed("hello")).rejects.toThrow("declared 1536, got 1024");
  });

  // Test 3: 同一批响应出现 1024 和 1536，明确报错
  it("throws EMBEDDING_BATCH_INCONSISTENCY when batch has mixed dimensions", async () => {
    mockFetchForBatch([1024, 1536, 1024]);
    const provider = makeProvider({ declared: undefined });

    await expect(provider.embedBatch(["a", "b", "c"])).rejects.toThrow(
      EmbeddingBatchDimensionInconsistencyError,
    );
    await expect(provider.embedBatch(["a", "b", "c"])).rejects.toThrow(
      "at index 1",
    );
  });

  // Test 5: 后续响应维度发生变化，阻止继续写入
  it("throws when a subsequent embed returns a different dimension than previously resolved", async () => {
    // First call: 1024
    mockFetchForDims(1024);
    const provider = makeProvider({ declared: undefined });

    await provider.embed("first");
    expect(provider.resolvedDimensions).toBe(1024);

    // Second call: 768 (dimension changed upstream)
    mockFetchForDims(768);

    await expect(provider.embed("second")).rejects.toThrow(EmbeddingDimensionMismatchError);
    await expect(provider.embed("second")).rejects.toThrow("got 768");
  });

  it("cacheIdentity is undefined before first embed when dimensions are not declared", () => {
    const provider = makeProvider({ declared: undefined });
    expect(provider.cacheIdentity).toBeUndefined();
  });

  it("cacheIdentity is immediately available when dimensions are declared", () => {
    const provider = makeProvider({ declared: 768 });
    expect(provider.cacheIdentity).toEqual({
      provider: "openai-compat",
      model: "test-model",
      dimensions: 768,
      endpoint: "https://fake.api/v1",
    });
  });
});

// ── VectorStore dimension validation tests ──

describe("JsonVectorStore — index metadata and dimension validation", () => {
  let tmpDir: string;

  function makeLocalProvider(dims: number): EmbeddingProvider {
    return {
      name: "local-test",
      dims,
      declaredDimensions: dims,
      resolvedDimensions: dims,
      cacheIdentity: {
        provider: "local",
        model: "test-model",
        dimensions: dims,
      },
      async embed(text: string) {
        return new Array(dims).fill(0.1);
      },
      async embedBatch(texts: string[]) {
        return texts.map(() => new Array(dims).fill(0.1));
      },
    };
  }

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "rag-dim-test-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  // Test 4: 已有 1536 维索引，切换到 1024 维模型，阻止查询并要求重建
  it("blocks add/search when provider dimensions mismatch existing index metadata", async () => {
    const store = new JsonVectorStore(tmpDir);
    const provider1536 = makeLocalProvider(1536);

    // Write with 1536-dim provider
    await store.add("hello world", "test", provider1536);
    const meta1 = store.getIndexMeta();
    expect(meta1).not.toBeNull();
    expect(meta1!.dimensions).toBe(1536);

    // Now try to use a 1024-dim provider — should throw
    const provider1024 = makeLocalProvider(1024);
    await expect(store.add("new text", "test", provider1024)).rejects.toThrow(
      /Index dimension mismatch.*1536.*1024/,
    );
    await expect(store.search("query", "test", provider1024)).rejects.toThrow(
      /Index dimension mismatch.*1536.*1024/,
    );
  });

  // Test 6: 旧索引元数据迁移测试
  it("migrates index metadata from existing vectors when dimensions match", async () => {
    // Create a store, add entries, then delete the metadata file to simulate old index
    const store1 = new JsonVectorStore(tmpDir);
    const provider = makeLocalProvider(384);
    await store1.add("first entry", "test", provider);
    // 落盘是 5 秒防抖，重新打开前先刷盘
    await store1.flush();

    // Verify metadata was created
    const metaPath = path.join(tmpDir, "memory-store-meta.json");
    expect(fs.existsSync(metaPath)).toBe(true);

    // Delete metadata to simulate old index
    fs.unlinkSync(metaPath);
    expect(fs.existsSync(metaPath)).toBe(false);

    // Re-open store — should migrate metadata on next operation
    const store2 = new JsonVectorStore(tmpDir);
    expect(store2.getIndexMeta()).toBeNull();

    // Using same-dimension provider should trigger migration
    const provider2 = makeLocalProvider(384);
    await store2.add("second entry", "test", provider2);

    // Metadata should have been recreated via migration
    const migratedMeta = store2.getIndexMeta();
    expect(migratedMeta).not.toBeNull();
    expect(migratedMeta!.dimensions).toBe(384);
  });

  it("blocks operations when old index has different dimensions than provider", async () => {
    // Create store with 1024-dim
    const store1 = new JsonVectorStore(tmpDir);
    const provider1024 = makeLocalProvider(1024);
    await store1.add("old entry", "test", provider1024);
    // 落盘是 5 秒防抖，重新打开前先刷盘
    await store1.flush();

    // Delete metadata to simulate old index
    const metaPath = path.join(tmpDir, "memory-store-meta.json");
    fs.unlinkSync(metaPath);

    // Re-open with different-dimension provider
    const store2 = new JsonVectorStore(tmpDir);
    const provider768 = makeLocalProvider(768);

    // Should block because existing vectors are 1024-dim but provider is 768
    await expect(store2.add("new entry", "test", provider768)).rejects.toThrow(
      /Index dimension mismatch.*1024.*768/,
    );
  });

  it("creates metadata on first add when no existing data or metadata", async () => {
    const store = new JsonVectorStore(tmpDir);
    expect(store.getIndexMeta()).toBeNull();

    const provider = makeLocalProvider(512);
    await store.add("first", "test", provider);

    const meta = store.getIndexMeta();
    expect(meta).not.toBeNull();
    expect(meta!.dimensions).toBe(512);
    expect(meta!.provider).toBe("local");
    expect(meta!.model).toBe("test-model");
  });
});
