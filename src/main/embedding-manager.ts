import * as path from "path";
import * as fs from "fs";
import * as os from "os";

// --- Model definitions ---

interface ModelInfo {
  key: string;
  name: string;
  dir: string;
  onnx: string;
}

const MODELS: ModelInfo[] = [
  { key: "bgem3", name: "Xenova/bge-m3", dir: "Xenova\\bge-m3", onnx: "onnx\\model_quantized.onnx" },
];

function getCacheDir(): string {
  return path.join(os.homedir(), ".cache", "huggingface");
}

// --- Status check ---

export function getEmbeddingStatus(): Record<string, { installed: boolean; sizeBytes: number }> {
  const cacheDir = getCacheDir();
  const result: Record<string, { installed: boolean; sizeBytes: number }> = {};
  for (const m of MODELS) {
    const onnxPath = path.join(cacheDir, m.dir, m.onnx);
    const installed = fs.existsSync(onnxPath);
    let sizeBytes = 0;
    if (installed) {
      try { sizeBytes = fs.statSync(onnxPath).size; } catch {}
    }
    result[m.key] = { installed, sizeBytes };
  }
  return result;
}

// --- Download ---

/**
 * 下载并装配 embedding 模型。
 *
 * 曾经带一个 onProgress 回调，把进度经 IPC.EMBEDDING_PROGRESS 推给渲染端；但该通道
 * 从来没有接收端（preload 与渲染端都未监听），属于未接线的残留，已连同常量一起删除。
 * 若将来要做下载进度 UI，重新引入时应同时补上 preload 监听与设置页展示。
 */
export async function downloadEmbeddingModel(
  modelKey: string,
  mirror: string,
): Promise<void> {
  const model = MODELS.find((m) => m.key === modelKey);
  if (!model) throw new Error("Unknown model: " + modelKey);

  // Dynamic import ESM module
  const importEsm = new Function("moduleName", "return import(moduleName)") as (moduleName: string) => Promise<any>;
  const { pipeline, env } = await importEsm("@xenova/transformers");

  if (mirror === "hf-mirror") {
    env.remoteHost = "https://hf-mirror.com";
  }
  env.cacheDir = getCacheDir();
  env.allowLocalModels = false;

  await pipeline("feature-extraction", model.name);
}

// --- Delete ---

export function deleteEmbeddingModel(modelKey: string): void {
  const model = MODELS.find((m) => m.key === modelKey);
  if (!model) throw new Error("Unknown model: " + modelKey);
  const cacheDir = getCacheDir();
  const modelDir = path.join(cacheDir, model.dir);
  if (fs.existsSync(modelDir)) {
    fs.rmSync(modelDir, { recursive: true, force: true });
  }
}