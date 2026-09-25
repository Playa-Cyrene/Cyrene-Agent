import type { ModelSettings } from "../../settings/model-settings";
import { getAdapterForConfig, createSseReader } from "../../orchestrator/vendors";
import type {
  StructuredOutputRequest,
  VendorConfig,
} from "../../orchestrator/vendors";
import {
  createVisibleStreamFilter,
  stripThinkBlocks,
} from "../../chat-stream-utils";
import { recordUsage, recordRequest } from "../../token-usage-store";
import { appendApiLog } from "../../chat-api-utils";

export interface LlmClient {
  chat(
    settings: ModelSettings,
    messages: Array<{ role: "system" | "user" | "assistant"; content: string }>,
    temperature: number | undefined,
    timeoutMs: number,
    label: string,
    logTiming?: boolean,
  ): Promise<string>;

  stream(
    settings: ModelSettings,
    messages: Array<{ role: "system" | "user" | "assistant"; content: string }>,
    temperature: number | undefined,
    timeoutMs: number,
    label: string,
    onChunk: (text: string) => void,
    logTiming?: boolean,
  ): Promise<string>;

  chatNonStream(
    settings: LlmRequestSettings,
    messages: Array<{ role: "system" | "user" | "assistant"; content: string }>,
    temperature: number | undefined,
    timeoutMs: number,
    label: string,
    reasoningOverride?: ModelSettings["reasoning"],
    options?: {
      structuredOutput?: StructuredOutputRequest;
      maxTokens?: number;
      extraBody?: Record<string, unknown>;
    },
    signal?: AbortSignal,
  ): Promise<{
    text: string;
    thinking?: string;
    finishReason: string;
    refusal?: string;
    structuredValue?: unknown;
  }>;
}

/** 模型请求所需的已解析配置子集；供非聊天业务复用同一套厂商请求实现。 */
export type LlmRequestSettings = Pick<
  ModelSettings,
  "provider" | "baseUrl" | "model" | "apiKey" | "explicitTransport" | "reasoning" | "manualReasoning"
>;

function buildVendorConfig(settings: LlmRequestSettings): VendorConfig {
  return {
    provider: settings.provider,
    baseUrl: settings.baseUrl,
    model: settings.model,
    apiKey: settings.apiKey,
    explicitTransport: settings.explicitTransport,
    reasoning: settings.reasoning,
    manualReasoning: settings.manualReasoning,
  };
}

export function createLlmClient(): LlmClient {
  async function stream(
    settings: ModelSettings,
    messages: Array<{ role: "system" | "user" | "assistant"; content: string }>,
    temperature: number | undefined,
    timeoutMs: number,
    label: string,
    onChunk: (text: string) => void,
    logTiming = true,
  ): Promise<string> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const startTime = Date.now();
    if (logTiming) {
      console.log(
        `[TIMING] ${label} START timeout=${timeoutMs}ms msgLen=${messages.length} sysLen=${messages[0]?.content?.length ?? 0}`,
      );
    }

    const cfg = buildVendorConfig(settings);

    try {
      const adapter = getAdapterForConfig(cfg);
      const http = adapter.buildStreamRequest(
        {
          model: cfg.model,
          messages,
          ...(temperature !== undefined ? { temperature } : {}),
          stream: true,
        },
        cfg,
      );

      const response = await fetch(http.url, {
        method: "POST",
        signal: controller.signal,
        headers: http.headers,
        body: http.body,
      });

      if (!response.ok) {
        const errorData = (await response.json().catch(() => ({}))) as Record<string, unknown>;
        const errMsg = (errorData as { error?: { message?: string } }).error?.message;
        throw new Error(errMsg || `模型请求失败：HTTP ${response.status}`);
      }

      if (!response.body) {
        throw new Error("响应体为空，不支持流式读取");
      }

      recordRequest(settings.model);
      let fullText = "";
      const visibleFilter = createVisibleStreamFilter();
      // anthropic 流式 usage 分散在 message_start（input）和 message_delta（output）两个事件里，
      // 逐 chunk 记会重复计数；改为逐字段取最大值合并，循环结束记一次。
      let sawUsage = false;
      let usageInput = 0;
      let usageOutput = 0;
      let usageCached: number | undefined;
      let usageCacheCreation: number | undefined;

      for await (const event of createSseReader(adapter, response.body)) {
        const chunk = adapter.parseStreamEvent(event);
        if (!chunk) continue;
        if (chunk.deltaText) {
          fullText += chunk.deltaText;
          const visibleDelta = visibleFilter.push(chunk.deltaText);
          if (visibleDelta) onChunk(visibleDelta);
        }
        if (chunk.usage) {
          sawUsage = true;
          usageInput = Math.max(usageInput, chunk.usage.input ?? 0);
          usageOutput = Math.max(usageOutput, chunk.usage.output ?? 0);
          if (chunk.usage.cachedInput !== undefined) {
            usageCached = Math.max(usageCached ?? 0, chunk.usage.cachedInput);
          }
          if (chunk.usage.cacheCreation !== undefined) {
            usageCacheCreation = Math.max(usageCacheCreation ?? 0, chunk.usage.cacheCreation);
          }
        }
        if (chunk.done) break;
      }
      if (sawUsage) {
        recordUsage(usageInput, usageOutput, 1, usageCached, settings.model, usageCacheCreation);
      }

      const visibleTail = visibleFilter.flush();
      if (visibleTail) {
        onChunk(visibleTail);
      }

      const result = stripThinkBlocks(fullText);
      if (logTiming) {
        console.log(`[TIMING] ${label} OK in ${Date.now() - startTime}ms resultLen=${result.length}`);
      }
      appendApiLog(label, messages, fullText, result);
      return result;
    } catch (err) {
      if (err instanceof Error && err.name === "AbortError") {
        if (logTiming) {
          console.log(`[TIMING] ${label} TIMEOUT at ${Date.now() - startTime}ms`);
        }
        throw new Error("模型请求超时，请稍后重试。");
      }
      if (logTiming) {
        console.log(
          `[TIMING] ${label} ERROR at ${Date.now() - startTime}ms: ${err instanceof Error ? err.message : err}`,
        );
      }
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }

  async function chat(
    settings: ModelSettings,
    messages: Array<{ role: "system" | "user" | "assistant"; content: string }>,
    temperature: number | undefined,
    timeoutMs: number,
    label: string,
    logTiming = true,
  ): Promise<string> {
    return stream(settings, messages, temperature, timeoutMs, label, () => {}, logTiming);
  }

  async function chatNonStream(
    settings: LlmRequestSettings,
    messages: Array<{ role: "system" | "user" | "assistant"; content: string }>,
    temperature: number | undefined,
    timeoutMs: number,
    label: string,
    reasoningOverride?: ModelSettings["reasoning"],
    options?: {
      structuredOutput?: StructuredOutputRequest;
      maxTokens?: number;
      extraBody?: Record<string, unknown>;
    },
    signal?: AbortSignal,
  ): Promise<{
    text: string;
    thinking?: string;
    finishReason: string;
    refusal?: string;
    structuredValue?: unknown;
  }> {
    const cfg: VendorConfig = {
      provider: settings.provider,
      baseUrl: settings.baseUrl,
      model: settings.model,
      apiKey: settings.apiKey,
      explicitTransport: settings.explicitTransport,
      reasoning: reasoningOverride ?? settings.reasoning,
      manualReasoning: settings.manualReasoning,
    };
    const adapter = getAdapterForConfig(cfg);
    const chatRequest = {
      model: cfg.model,
      messages,
      ...(temperature !== undefined ? { temperature } : {}),
      stream: false,
      ...(options?.structuredOutput ? { structuredOutput: options.structuredOutput } : {}),
      ...(options?.maxTokens !== undefined ? { maxTokens: options.maxTokens } : {}),
      ...(options?.extraBody ? { extraBody: options.extraBody } : {}),
    };

    const controller = new AbortController();
    const abort = (): void => controller.abort(signal?.reason);
    signal?.addEventListener("abort", abort, { once: true });
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const startTime = Date.now();
    console.log(
      `[TIMING] ${label} START (non-stream) timeout=${timeoutMs}ms msgLen=${messages.length} sysLen=${messages[0]?.content?.length ?? 0}`,
    );

    try {
      const http = adapter.buildRequest(chatRequest, cfg);
      const response = await fetch(http.url, {
        method: "POST",
        headers: http.headers,
        body: http.body,
        signal: controller.signal,
      });
      if (!response.ok) {
        const errorData = (await response.json().catch(() => ({}))) as Record<string, unknown>;
        const errMsg = (errorData as { error?: { message?: string } }).error?.message;
        throw new Error(errMsg || `模型请求失败：HTTP ${response.status}`);
      }
      const parsed = adapter.parseResponse(await response.json());
      recordRequest(settings.model);
      if (parsed.usage) {
        recordUsage(parsed.usage.input, parsed.usage.output, 1, parsed.usage.cachedInput, settings.model, parsed.usage.cacheCreation);
      }
      const totalTime = Date.now() - startTime;
      console.log(`[TIMING] ${label} OK in ${totalTime}ms resultLen=${parsed.text.length}`);
      return {
        text: parsed.text,
        thinking: parsed.thinking,
        finishReason: parsed.finishReason,
        refusal: parsed.refusal,
        structuredValue: parsed.structuredValue,
      };
    } catch (error) {
      const totalTime = Date.now() - startTime;
      if (error instanceof Error && error.name === "AbortError") {
        console.log(`[TIMING] ${label} TIMEOUT at ${totalTime}ms`);
      } else {
        console.log(`[TIMING] ${label} ERROR at ${totalTime}ms: ${error}`);
      }
      throw error;
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
    }
  }

  return { chat, stream, chatNonStream };
}
