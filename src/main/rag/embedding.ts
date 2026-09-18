// @xenova/transformers is ESM-only, use dynamic import in CJS context
import { checkEmbeddingModelInstalled, getProjectModelBaseDir } from "./model-status";
import * as path from "path";
import * as os from "os";

// ── 错误类型 ──
export class EmbeddingDimensionMismatchError extends Error {
  constructor(
    public readonly declared: number,
    public readonly actual: number,
    public readonly context: string,
  ) {
    super(`Embedding dimension mismatch: ${context} — declared ${declared}, got ${actual}`);
    this.name = "EmbeddingDimensionMismatchError";
  }
}

export class EmbeddingBatchDimensionInconsistencyError extends Error {
  constructor(
    public readonly expected: number,
    public readonly actual: number,
    public readonly index: number,
  ) {
    super(`Embedding batch inconsistency at index ${index}: expected ${expected} dimensions, got ${actual}`);
    this.name = "EmbeddingBatchDimensionInconsistencyError";
  }
}

// ── 类型 ──
export type EmbeddingProviderIdentity = {
  provider: string;
  model: string;
  dimensions: number;
  endpoint?: string;
};

/**
 * 索引元数据 — 写入向量索引时记录，用于后续一致性校验。
 */
export interface EmbeddingIndexMetadata {
  provider: string;
  model: string;
  dimensions: number;
  cacheIdentity: string;
}

export type EmbeddingWorkerConfig =
  | { provider: "local"; modelKey: string }
  | { provider: "openai-compat"; baseUrl: string; apiKey: string; model: string };

export interface EmbeddingProvider {
  embed(text: string): Promise<number[]>;
  embedBatch(texts: string[]): Promise<number[][]>;
  readonly dims: number;
  readonly name: string;
  readonly cacheIdentity?: EmbeddingProviderIdentity;
  readonly workerConfig?: EmbeddingWorkerConfig;
  /** 用户声明的维度（可能为 undefined，表示未配置） */
  readonly declaredDimensions?: number;
  /** 实际探测到的维度（首次 embed 后才有值） */
  readonly resolvedDimensions?: number;
}

// ── 模型注册表 ──
interface ModelConfig {
  key: string;
  hfName: string;
  dims: number;
}

const LOCAL_MODELS: Record<string, ModelConfig> = {
  bgem3: { key: "bgem3", hfName: "Xenova/bge-m3", dims: 1024 },
};

const DEFAULT_MODEL_KEY = "bgem3";

// ── 本地 Pipeline ──
// bge-m3 是唯一的 embedding 模型，同时服务于 RAG 记忆/文档检索和场景识别
const localPipelines: Map<string, any> = new Map();
const localPipelineLoads: Map<string, Promise<any>> = new Map();
let currentModelKey: string = DEFAULT_MODEL_KEY;
let localPipelineInitCount = 0;

const importEsm = new Function("moduleName", "return import(moduleName)") as (moduleName: string) => Promise<any>;

async function getLocalPipeline(modelKey?: string): Promise<any> {
  const key = modelKey || currentModelKey;
  const config = LOCAL_MODELS[key];
  if (!config) throw new Error("Unknown embedding model: " + key);

  const cached = localPipelines.get(key);
  if (cached) return cached;
  const loading = localPipelineLoads.get(key);
  if (loading) return loading;

  const load = (async () => {
    localPipelineInitCount += 1;
    const { pipeline, env } = await importEsm("@xenova/transformers");
    env.allowLocalModels = true;
    env.allowRemoteModels = false;
    env.useBrowserCache = false;
    // 主路径：项目根 models/（用户实际放模型的地方）。
    // 兜底：HF cache，通过 cache_dir 选项传给 pipeline。
    // transformers 内部会按 (localModelPath, cache_dir) 顺序查找文件。
    const modelBaseDir = getProjectModelBaseDir("embedding", key);
    if (!modelBaseDir) throw new Error(`Local embedding model "${key}" is not installed`);
    env.localModelPath = modelBaseDir;
    const pipe = await pipeline("feature-extraction", config.hfName, {
      cache_dir: path.join(os.homedir(), ".cache", "huggingface"),
    });
    localPipelines.set(key, pipe);
    return pipe;
  })();
  localPipelineLoads.set(key, load);
  try {
    return await load;
  } finally {
    localPipelineLoads.delete(key);
  }
}

export function createLocalEmbeddingProvider(modelKey?: string): EmbeddingProvider | null {
  const key = modelKey || DEFAULT_MODEL_KEY;
  const config = LOCAL_MODELS[key];
  if (!config) throw new Error("Unknown embedding model: " + key);

  // 模型缺失返回 null，调用方决定如何处理
  if (!checkEmbeddingModelInstalled(key)) {
    return null;
  }

  return {
    name: "local-" + config.hfName.split("/").pop(),
    dims: config.dims,
    declaredDimensions: config.dims,
    resolvedDimensions: config.dims,
    cacheIdentity: {
      provider: "local",
      model: config.hfName,
      dimensions: config.dims,
    },
    workerConfig: { provider: "local", modelKey: key },

    async embed(text: string): Promise<number[]> {
      const pipe = await getLocalPipeline(key);
      const result: any = await pipe(text, { pooling: "mean", normalize: true });
      return Array.from(result.data as Float32Array);
    },

    async embedBatch(texts: string[]): Promise<number[][]> {
      const pipe = await getLocalPipeline(key);
      const results: number[][] = [];
      for (const text of texts) {
        const result: any = await pipe(text, { pooling: "mean", normalize: true });
        results.push(Array.from(result.data as Float32Array));
      }
      return results;
    },
  };
}

// ── OpenAI 兼容 Provider ──
/**
 * 创建 OpenAI 兼容的 embedding provider。
 *
 * @param baseUrl - API 基础 URL
 * @param apiKey - API 密钥
 * @param model - 模型名称
 * @param declaredDimensions - 用户声明的维度（可选）。
 *   留空时首次 embed 自动探测；填写时与实际响应严格校验。
 */
export function createOpenAIEmbeddingProvider(
  baseUrl: string,
  apiKey: string,
  model = "text-embedding-ada-002",
  declaredDimensions?: number,
): EmbeddingProvider {
  const normalizedBaseUrl = baseUrl.replace(/\/+$/, "");
  const endpoint = normalizedBaseUrl + "/embeddings";

  // 维度状态：可能由用户声明，也可能在首次调用后自动探测
  let resolvedDims: number | undefined = declaredDimensions;
  let resolved = false;

  function getDims(): number {
    if (resolvedDims !== undefined) return resolvedDims;
    throw new Error("Embedding dimensions not yet resolved — call embed() first");
  }

  function validateAndResolveDimensions(embedding: number[], context: string): void {
    const actual = embedding.length;
    if (declaredDimensions !== undefined && declaredDimensions !== actual) {
      throw new EmbeddingDimensionMismatchError(declaredDimensions, actual, context);
    }
    if (!resolved) {
      resolvedDims = actual;
      resolved = true;
    } else if (resolvedDims !== actual) {
      throw new EmbeddingDimensionMismatchError(resolvedDims!, actual, context);
    }
  }

  function validateBatchConsistency(embeddings: number[][]): void {
    if (embeddings.length === 0) return;
    const firstDim = embeddings[0].length;
    for (let i = 1; i < embeddings.length; i++) {
      if (embeddings[i].length !== firstDim) {
        throw new EmbeddingBatchDimensionInconsistencyError(firstDim, embeddings[i].length, i);
      }
    }
  }

  return {
    name: "openai-compat-" + model,

    get dims() {
      return getDims();
    },

    get declaredDimensions() {
      return declaredDimensions;
    },

    get resolvedDimensions() {
      return resolvedDims;
    },

    get cacheIdentity(): EmbeddingProviderIdentity | undefined {
      // 维度未探测前返回 base identity（不含 dimensions）
      // 维度已探测后返回完整 identity
      if (resolvedDims === undefined) return undefined;
      return {
        provider: "openai-compat",
        model,
        dimensions: resolvedDims,
        endpoint: normalizedBaseUrl,
      };
    },

    get workerConfig(): EmbeddingWorkerConfig {
      return {
        provider: "openai-compat",
        baseUrl: normalizedBaseUrl,
        apiKey,
        model,
      };
    },

    async embed(text: string): Promise<number[]> {
      const res = await fetch(endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer " + apiKey,
        },
        body: JSON.stringify({ model, input: text }),
      });
      if (!res.ok) {
        throw new Error("Embedding API error: " + res.status + " " + await res.text());
      }
      const data = await res.json() as { data: Array<{ embedding: number[] }> };
      const embedding = data.data[0].embedding;
      validateAndResolveDimensions(embedding, `embed() for model "${model}"`);
      return embedding;
    },

    async embedBatch(texts: string[]): Promise<number[][]> {
      const res = await fetch(endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer " + apiKey,
        },
        body: JSON.stringify({ model, input: texts }),
      });
      if (!res.ok) {
        throw new Error("Embedding API error: " + res.status + " " + await res.text());
      }
      const data = await res.json() as { data: Array<{ embedding: number[] }> };
      const embeddings = data.data.map((d) => d.embedding);
      validateBatchConsistency(embeddings);
      for (const emb of embeddings) {
        validateAndResolveDimensions(emb, `embedBatch() for model "${model}"`);
      }
      return embeddings;
    },
  };
}

// ── 自动选择 Provider ──
let cachedProvider: EmbeddingProvider | null = null;

export function getEmbeddingProvider(
  mode: "auto" | "local" | "cloud" = "auto",
  cloudBaseUrl?: string,
  cloudApiKey?: string,
  modelKey?: string,
  cloudDimensions?: number,
): EmbeddingProvider | null {
  if (cachedProvider) return cachedProvider;

  if (mode === "local") {
    cachedProvider = createLocalEmbeddingProvider(modelKey);
  } else if (mode === "cloud" && cloudBaseUrl && cloudApiKey) {
    cachedProvider = createOpenAIEmbeddingProvider(cloudBaseUrl, cloudApiKey, modelKey, cloudDimensions);
  } else {
    // auto 模式：优先 local，local 不存在且 cloud 配置完整时用 cloud，否则 null
    const local = createLocalEmbeddingProvider(modelKey);
    if (local) {
      cachedProvider = local;
    } else if (cloudBaseUrl && cloudApiKey) {
      cachedProvider = createOpenAIEmbeddingProvider(cloudBaseUrl, cloudApiKey, modelKey, cloudDimensions);
    } else {
      cachedProvider = null;
    }
  }

  return cachedProvider;
}

/**
 * 获取当前 embedding provider 的 identity。
 * 注意：对于 cloud provider 且未声明维度的情况，需要先调用 embed() 解析维度。
 * 此函数要求 provider 的维度已解析（resolvedDimensions !== undefined）。
 */
export async function getEmbeddingProviderIdentity(): Promise<EmbeddingProviderIdentity> {
  const provider = getEmbeddingProvider();
  if (!provider) throw new Error("Embedding provider is not available");

  if (provider.cacheIdentity) return provider.cacheIdentity;

  // 对于 local provider，dims 始终已知
  const localModel = Object.values(LOCAL_MODELS).find(
    (model) => provider.name === "local-" + model.hfName.split("/").pop(),
  );
  if (localModel) {
    return {
      provider: "local",
      model: localModel.hfName,
      dimensions: provider.dims,
    };
  }

  // cloud provider：如果维度已解析，返回 identity
  const cloudModelPrefix = "openai-compat-";
  if (provider.name.startsWith(cloudModelPrefix)) {
    const dims = provider.resolvedDimensions ?? provider.declaredDimensions;
    if (dims === undefined) {
      throw new Error(
        "Embedding dimensions not yet resolved for cloud provider. " +
        "Call embed() first, or declare dimensions in settings."
      );
    }
    return {
      provider: "openai-compat",
      model: provider.name.slice(cloudModelPrefix.length),
      dimensions: dims,
    };
  }

  const dims = provider.resolvedDimensions ?? provider.declaredDimensions;
  if (dims === undefined) {
    throw new Error("Embedding dimensions not yet resolved for provider: " + provider.name);
  }
  return {
    provider: provider.name,
    model: provider.name,
    dimensions: dims,
  };
}

export function getEmbeddingWorkerConfig(): EmbeddingWorkerConfig {
  const provider = getEmbeddingProvider();
  if (!provider) throw new Error("Embedding provider is not available");
  if (provider.workerConfig) return provider.workerConfig;
  return { provider: "local", modelKey: currentModelKey };
}

export function getCurrentModelKey(): string {
  return currentModelKey;
}

export function getCurrentModelDims(): number {
  const config = LOCAL_MODELS[currentModelKey];
  return config ? config.dims : 1024;
}

export function switchEmbeddingModel(modelKey: string): void {
  if (modelKey !== "bgem3") {
    console.warn(`[Embedding] ignoring model switch to "${modelKey}" — bge-m3 is the only supported model`);
    return;
  }
  cachedProvider = null;
  localPipelines.delete(currentModelKey);
  localPipelineLoads.delete(currentModelKey);
  currentModelKey = modelKey;
}

export function resetEmbeddingProvider(): void {
  cachedProvider = null;
  localPipelines.clear();
  localPipelineLoads.clear();
  currentModelKey = DEFAULT_MODEL_KEY;
  localPipelineInitCount = 0;
}

export function getEmbeddingDiagnostics(): {
  currentModelKey: string;
  cachedPipelineKeys: string[];
  loadingPipelineKeys: string[];
  localPipelineInitCount: number;
} {
  return {
    currentModelKey,
    cachedPipelineKeys: Array.from(localPipelines.keys()),
    loadingPipelineKeys: Array.from(localPipelineLoads.keys()),
    localPipelineInitCount,
  };
}

export { checkEmbeddingModelInstalled };
