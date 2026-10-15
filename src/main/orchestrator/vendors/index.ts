// 厂商适配器工厂：按 provider 显示名或 VendorConfig 返回对应 transport 的 adapter 实例。
// 调度层只需 getAdapter(provider) 或 getAdapterForConfig(cfg)，不关心 transport 细节。
import { OpenAICompatAdapter } from "./openai-adapter";
import { AnthropicAdapter } from "./anthropic-adapter";
import { ResponsesAdapter } from "./responses-adapter";
import { getCapability, getCapabilityOrOpenAI, PROVIDER_CAPABILITIES } from "./capabilities";
import { resolveTransport } from "./transport-detector";
import { resolveApiEndpoint } from "../../../shared/api-endpoint";
import type {
  ChatMessage, ChatRequest, ChatResponse, ChatVendorAdapter, HttpRequest,
  ProviderCapability, StreamChunk, StreamEvent, TestConnectionResult, ToolCall, ToolExecutionResult,
  StructuredOutputRequest, ToolSpec, Transport, VendorConfig,
} from "./types";

export type {
  ChatMessage, ChatRequest, ChatResponse, ChatVendorAdapter, HttpRequest,
  ProviderCapability, StreamChunk, StreamEvent, TestConnectionResult, ToolCall, ToolExecutionResult,
  StructuredOutputRequest, ToolSpec, Transport, VendorConfig,
};
export { getCapability, getCapabilityOrOpenAI, PROVIDER_CAPABILITIES };
export { resolveTransport } from "./transport-detector";
export { CyreneStreamAccumulator } from "./sdk-stream/accumulator";
export { streamChatWithSdk } from "./sdk-stream/runtime";
export { generateChatWithAiSdk } from "./model-runtime";
export { ProviderProtocolError } from "./sdk-stream/types";
export type { StreamDiagnostic, UnifiedStreamDelta } from "./sdk-stream/types";

const cache = new Map<string, ChatVendorAdapter>();

/** 按 provider 显示名取适配器实例（同一 provider 复用同一实例）—— 旧路径，按 capabilities 表 transport 取。 */
export function getAdapter(provider: string): ChatVendorAdapter {
  const existing = cache.get(provider);
  if (existing) return existing;
  const cap = getCapabilityOrOpenAI(provider);
  const adapter: ChatVendorAdapter =
    cap.transport === "anthropic"
      ? new AnthropicAdapter(cap.id, cap)
      : new OpenAICompatAdapter(cap.id, cap);
  cache.set(provider, adapter);
  return adapter;
}

/**
 * 按运行时配置取适配器实例。协议由用户显式选择；旧配置才回退厂商默认。
 * cache key 用 `${provider}::${transport}`，避免显式切 transport 后命中旧实例。
 */
export function getAdapterForConfig(cfg: VendorConfig): ChatVendorAdapter {
  const transport = resolveTransport({
    baseUrl: cfg.baseUrl,
    explicitTransport: cfg.explicitTransport,
    provider: cfg.provider,
  });
  const cacheKey = `${cfg.provider}::${transport}`;
  const existing = cache.get(cacheKey);
  if (existing) return existing;
  const cap = getCapabilityOrOpenAI(cfg.provider);
  const adapter: ChatVendorAdapter =
    transport === "anthropic"
      ? new AnthropicAdapter(cap.id, cap)
      : transport === "responses"
        ? new ResponsesAdapter(cap.id, cap)
        : new OpenAICompatAdapter(cap.id, cap);
  cache.set(cacheKey, adapter);
  return adapter;
}

/**
 * 厂商无关的 URL 构建器 —— transport 由调用方传入（已走 resolveTransport）。
 * - OpenAI transport → {baseUrl}/chat/completions
 * - Anthropic transport → {baseUrl}/v1/messages（baseUrl 已含 /v1 时只加 /messages）
 */
export function buildVendorUrl(baseUrl: string, transport: Transport): string {
  return resolveApiEndpoint(baseUrl, transport).url;
}

/**
 * 旧签名（保留兼容）：根据 provider 名查 transport 再调 buildVendorUrl。
 * 已有调用点（memory-judge / memory-compressor 之前的 buildVendorUrl(provider, baseUrl)）仍可用，
 * 但**新代码**建议直接用 buildVendorUrl(baseUrl, transport) + getAdapterForConfig(cfg)。
 */
export function buildVendorUrlByProvider(provider: string, baseUrl: string): string {
  const cap = getCapabilityOrOpenAI(provider);
  return buildVendorUrl(baseUrl, cap.transport);
}

/**
 * 创建一个 AsyncIterable<StreamEvent>，按 transport 协议切分 HTTP body 字节流。
 *
 * - OpenAI SSE 格式：每条 event 由单个 `data: {...}` 行组成（行间用 \n\n 分隔）。
 *   → 产出 StreamEvent{ eventType: "data", data: "{...}" }
 * - Anthropic event-stream 格式：每条 event 由 `event: <type>\ndata: {...}` 两行组成。
 *   → 产出 StreamEvent{ eventType: "<type>", data: "{...}" }
 *
 * 切分规则都是按 \n\n（空行）分隔 event 块，所以两种协议可以共用同一套状态机。
 * Adapter 的 parseStreamEvent 是纯函数、无状态；所有"半行拼接"逻辑都在这里维护。
 */
export function createSseReader(
  _adapter: ChatVendorAdapter,
  body: ReadableStream<Uint8Array>,
): AsyncIterable<StreamEvent> {
  const decoder = new TextDecoder("utf-8");
  const reader = body.getReader();
  let buffer = "";

  return {
    [Symbol.asyncIterator](): AsyncIterator<StreamEvent> {
      return {
        async next(): Promise<IteratorResult<StreamEvent>> {
          // 循环：一直读到能切出一个完整 event 块为止
          // （半行数据跨多个 chunk 时会继续 read + append buffer）
          while (true) {
            const boundary = findSseBoundary(buffer);
            if (boundary) {
              const raw = buffer.slice(0, boundary.index);
              buffer = buffer.slice(boundary.index + boundary.length);
              const event = parseSseBlock(raw);
              if (event) return { value: event, done: false };
              // 空注释块（OpenAI 心跳）跳过，继续找下一个
              continue;
            }
            // buffer 里没有完整 event 块，需要更多字节
            const { value, done } = await reader.read();
            if (done) {
              buffer += decoder.decode();
              // 流结束：把 buffer 残余（如果有）当最后一个 event 处理；否则返回 done
              if (buffer.trim().length > 0) {
                const event = parseSseBlock(buffer);
                buffer = "";
                if (event) return { value: event, done: false };
              }
              return { value: undefined, done: true };
            }
            buffer += decoder.decode(value, { stream: true });
          }
        },
        async return(): Promise<IteratorResult<StreamEvent>> {
          try { await reader.cancel(); } catch { /* ignore */ }
          return { value: undefined, done: true };
        },
      };
    },
  };
}

/**
 * 把一个 SSE event 块（一组行，可能是 `data: ...` 单行，也可能是 `event: ...\ndata: ...` 两行）
 * 解析成 StreamEvent。返回 null 表示这一块是注释（OpenAI 心跳 `: ...`）或空块。
 */
function parseSseBlock(block: string): StreamEvent | null {
  let eventType = "data"; // OpenAI 默认
  const dataLines: string[] = [];
  for (const rawLine of block.split("\n")) {
    const line = rawLine.replace(/\r$/, "");
    if (!line || line.startsWith(":")) continue; // 空行 / 注释行
    if (line.startsWith("event:")) {
      eventType = line.slice(6).trim();
      continue;
    }
    if (line.startsWith("data:")) {
      dataLines.push(line.slice(5).replace(/^ /, ""));
    }
    // 其他字段（id: / retry:）当前用不到，忽略
  }
  if (dataLines.length === 0) return null;
  return { eventType, data: dataLines.join("\n") };
}

function findSseBoundary(buffer: string): { index: number; length: number } | null {
  const match = /\r?\n\r?\n/.exec(buffer);
  return match ? { index: match.index, length: match[0].length } : null;
}
