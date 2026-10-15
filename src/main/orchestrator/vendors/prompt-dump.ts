// LLM 调用原文 dump —— 排查"模型变痴傻"用。
// 开启方式：set CYRENE_PROMPT_DUMP=1
// 落盘目录：E:\cyrene-prompt-dump\<YYYYMMDD>\<HHMMSS-mmm>_<transport>_<shortId>.json
//
// 设计原则：
//   - 单文件、零依赖、可随时删除
//   - 默认关闭；开启后 fire-and-forget 异步写盘，绝不阻塞 LLM 调用
//   - 不抛错；任何异常只在 console.warn 吞掉

import * as fs from "fs";
import * as path from "path";

const DUMP_ROOT = "E:\\cyrene-prompt-dump";
const ENV_FLAG = "CYRENE_PROMPT_DUMP";

let enabledCache: boolean | null = null;
let seqCounter = 0;

function isEnabled(): boolean {
  if (enabledCache !== null) return enabledCache;
  try {
    enabledCache = process.env[ENV_FLAG] === "1";
  } catch {
    enabledCache = false;
  }
  return enabledCache;
}

function pad(n: number, len = 2): string {
  return String(n).padStart(len, "0");
}

function buildTimestamp(): string {
  const d = new Date();
  const ms = pad(d.getMilliseconds(), 3);
  return `${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}-${ms}`;
}

function shortId(): string {
  seqCounter += 1;
  return seqCounter.toString(36).padStart(3, "0");
}

function safeDir(p: string): boolean {
  try {
    fs.mkdirSync(p, { recursive: true });
    return true;
  } catch {
    return false;
  }
}

export interface DumpRequestMeta {
  transport: "openai" | "anthropic" | "responses";
  endpoint: string;
  body: Record<string, unknown>;
}

export interface DumpResponseMeta {
  transport: "openai" | "anthropic" | "responses";
  ok: boolean;
  /** 抽取出来的可见文本/思考/工具调用，便于快速浏览 */
  text?: string;
  thinking?: string;
  toolCalls?: unknown[];
  usage?: unknown;
  /** Generated image metadata only; image bytes are deliberately never dumped. */
  generatedImages?: Array<{ id: string; mime: string; byteLength: number }>;
  /** 厂商原始返回（SDK finalMessage / OpenAI lastChunk 等） */
  raw: unknown;
  error?: string;
}

function writeFile(folder: string, name: string, payload: unknown): void {
  const target = path.join(folder, name);
  try {
    fs.writeFile(target, JSON.stringify(payload, null, 2), (err) => {
      if (err) console.warn(`[prompt-dump] write failed: ${target}`, err.message);
    });
  } catch (err) {
    console.warn(`[prompt-dump] queue failed: ${target}`, (err as Error).message);
  }
}

function dayFolder(): string {
  const d = new Date();
  return path.join(DUMP_ROOT, `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}`);
}

/** 请求发出前调用。返回本次调用的唯一 traceId（即使关闭也返回，方便上层 log）。 */
export function dumpRequest(meta: DumpRequestMeta): string {
  const traceId = `${buildTimestamp()}_${meta.transport}_${shortId()}`;
  if (!isEnabled()) return traceId;

  const folder = dayFolder();
  if (!safeDir(folder)) return traceId;

  const payload = {
    traceId,
    ts: new Date().toISOString(),
    phase: "request",
    transport: meta.transport,
    endpoint: meta.endpoint,
    body: meta.body,
  };
  writeFile(folder, `${traceId}_req.json`, payload);
  return traceId;
}

/** 响应拿到后调用（成功或失败都调用）。traceId 来自 dumpRequest 返回。 */
export function dumpResponse(traceId: string, meta: DumpResponseMeta): void {
  if (!isEnabled()) return;

  const folder = dayFolder();
  if (!safeDir(folder)) return;

  const payload = {
    traceId,
    ts: new Date().toISOString(),
    phase: "response",
    transport: meta.transport,
    ok: meta.ok,
    text: meta.text,
    thinking: meta.thinking,
    toolCalls: meta.toolCalls,
    usage: meta.usage,
    generatedImages: meta.generatedImages,
    raw: meta.raw,
    error: meta.error,
  };
  writeFile(folder, `${traceId}_res.json`, payload);
}
