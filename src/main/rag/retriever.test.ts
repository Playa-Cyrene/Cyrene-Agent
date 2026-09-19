import { afterEach, describe, expect, it, vi } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { HybridRetriever } from "./retriever";
import { JsonVectorStore } from "./vectorstore";
import type { EmbeddingProvider } from "./embedding";

const provider: EmbeddingProvider = {
  name: "deterministic",
  dims: 2,
  async embed(text: string): Promise<number[]> {
    return text.includes("beta") || text.includes("deadline") ? [0, 1] : [1, 0];
  },
  async embedBatch(texts: string[]): Promise<number[][]> {
    return Promise.all(texts.map((text) => this.embed(text)));
  },
};

const tempDirs: string[] = [];

function createStore(): JsonVectorStore {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rag-retriever-test-"));
  tempDirs.push(dir);
  return new JsonVectorStore(dir);
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("HybridRetriever", () => {
  it("embeds document imports in bounded batches", async () => {
    const store = createStore();
    const embedBatch = vi.fn(async (texts: string[]) => texts.map(() => [1, 0]));
    const items = Array.from({ length: 17 }, (_, index) => ({ text: `chunk-${index}`, source: "imported_doc" }));

    await store.addBatch(items, { ...provider, embedBatch });

    expect(embedBatch).toHaveBeenCalledTimes(2);
    expect(embedBatch.mock.calls.map(([texts]) => texts.length)).toEqual([16, 1]);
  });

  it("limits imported document retrieval to the current turn importIds", async () => {
    const store = createStore();
    await store.addBatch(
      [
        {
          text: "alpha contract renewal date is April",
          source: "imported_doc",
          metadata: { importId: "turn-alpha", fileName: "alpha.md", chunkIndex: 0 },
        },
        {
          text: "beta budget deadline is May",
          source: "imported_doc",
          metadata: { importId: "turn-beta", fileName: "beta.md", chunkIndex: 0 },
        },
      ],
      provider,
    );

    const retriever = new HybridRetriever(store, provider);
    const results = await retriever.retrieve("deadline", "imported_doc", 5, {
      importIds: ["turn-beta"],
    });

    expect(results.map((result) => result.entry.text)).toEqual(["beta budget deadline is May"]);
  });

  it("filters disallowed entries before scoring or recall side effects", async () => {
    const store = createStore();
    const [active, stale] = store.addPreparedBatch([
      { text: "alpha active memory", source: "user_memory", embedding: [1, 0] },
      { text: "alpha stale memory", source: "user_memory", embedding: [0.99, 0.1] },
    ]);
    const staleWeight = stale.weight;
    const staleLastRecalledAt = stale.lastRecalledAt;
    const retriever = new HybridRetriever(store, provider);

    const results = await retriever.retrieve("alpha memory", "user_memory", 5, {
      allowedEntryIds: [active.id],
    });

    expect(results.map((result) => result.entry.id)).toEqual([active.id]);
    expect(stale.weight).toBe(staleWeight);
    expect(stale.lastRecalledAt).toBe(staleLastRecalledAt);
  });

  it("retrieves distinct entries with identical embeddings without IVF failure", async () => {
    const store = createStore();
    const entries = store.addPreparedBatch([
      { text: "same memory", source: "user_memory", embedding: [1, 0] },
      { text: "same memory", source: "user_memory", embedding: [1, 0] },
    ]);
    const retriever = new HybridRetriever(store, provider);

    const results = await retriever.retrieve("same memory", "user_memory", 5, {
      allowedEntryIds: entries.map((entry) => entry.id),
    });

    expect(results.map((result) => result.entry.id).sort()).toEqual(entries.map((entry) => entry.id).sort());
  });

  it("warmupBm25Tokens fills token cache across slice boundaries and keeps retrieval correct", async () => {
    const store = createStore();
    // 120 条：超过预热单片 50 条，跨三个分片执行
    const entries = store.addPreparedBatch(
      Array.from({ length: 120 }, (_, index) => ({
        text: index % 2 === 0 ? `alpha note ${index} with beta content` : `other note ${index}`,
        source: "imported_doc",
        embedding: [1, 0],
        metadata: { importId: "warm-import", chunkIndex: index },
      })),
    );
    const retriever = new HybridRetriever(store, provider);

    await retriever.warmupBm25Tokens(entries);

    // query 嵌入为 [0,1]，与全部条目的 [1,0] 正交，向量路径零命中——
    // 能拿到结果说明命中的是预热过的 BM25 缓存路径
    const results = await retriever.retrieve("beta content", "imported_doc", 5, {
      importIds: ["warm-import"],
    });
    expect(results.length).toBeGreaterThan(0);
    expect(results.every((result) => result.entry.text.includes("beta"))).toBe(true);
  });
});
