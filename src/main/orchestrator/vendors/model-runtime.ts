import { generateText, streamText, stepCountIs, NoSuchToolError, type AssistantContent, type LanguageModelUsage, type ModelMessage } from "ai";
import { createThinkFilter } from "../../chat/think-filter";
import { AgentRuntimeError } from "../agent-runtime-error";
import { prepareModelCall } from "./model-factory";
import { recoverPortableMessage, type HistoryProjectionDiagnostic } from "./model-history";
import { classifyModelFailure } from "./model-error-classifier";
import { readRetryAfterMs } from "./model-retry-policy";
import { dumpResponse } from "./prompt-dump";
import type { ChatRequest, ChatResponse, ChatVendorAdapter, VendorConfig } from "./types";
import { CyreneStreamAccumulator } from "./sdk-stream/accumulator";
import { ResponsesOutputTracker } from "./sdk-stream/responses-output";
import type { StreamDiagnostic, UnifiedStreamDelta } from "./sdk-stream/types";
import { collectGeneratedImages, sanitizeGeneratedImageRaw, stripGeneratedImageReplay } from "./generated-image-output";
import type { GeneratedImageOutput } from "../../../shared/generated-image";

export interface ModelRunInput {
  adapter: ChatVendorAdapter;
  request: ChatRequest;
  config: VendorConfig;
  timeoutMs: number;
  signal?: AbortSignal;
  onStreamActivity?: () => void;
  onDelta?: (delta: UnifiedStreamDelta) => void;
  onDiagnostic?: (diagnostic: StreamDiagnostic) => void;
  onHistoryDiagnostic?: (diagnostic: HistoryProjectionDiagnostic) => void;
}

function usageDelta(usage: LanguageModelUsage): UnifiedStreamDelta {
  return { type: "usage", inputTokens: usage.inputTokens, outputTokens: usage.outputTokens,
    cachedInputTokens: usage.inputTokenDetails.cacheReadTokens, cacheCreationTokens: usage.inputTokenDetails.cacheWriteTokens };
}

export const streamChatWithAiSdk = (input: ModelRunInput): Promise<ChatResponse> => runModel(input, true);
export const generateChatWithAiSdk = (input: ModelRunInput): Promise<ChatResponse> => runModel(input, false);

async function runModel(input: ModelRunInput, streaming: boolean): Promise<ChatResponse> {
  const controller = new AbortController();
  const callerAbort = () => controller.abort(input.signal?.reason);
  if (input.signal?.aborted) callerAbort();
  else input.signal?.addEventListener("abort", callerAbort, { once: true });
  let timedOut = false;
  const timer = input.timeoutMs > 0 && Number.isFinite(input.timeoutMs) ? setTimeout(() => {
    timedOut = true;
    controller.abort(new DOMException("模型响应超时", "TimeoutError"));
  }, input.timeoutMs) : undefined;
  let traceId = "";
  const accumulator = new CyreneStreamAccumulator();
  const filter = createThinkFilter("leading-only");
  const commit = (delta: UnifiedStreamDelta) => { accumulator.apply(delta); if (streaming) input.onDelta?.(delta); };
  const text = (value: string) => {
    const visible = filter.push(value);
    const thinking = filter.takeThinking();
    if (thinking) commit({ type: "reasoning_delta", delta: thinking });
    if (visible) commit({ type: "text_delta", delta: visible });
  };
  const flush = () => {
    const visible = filter.flush();
    const thinking = filter.takeThinking();
    if (thinking) commit({ type: "reasoning_delta", delta: thinking });
    if (visible) commit({ type: "text_delta", delta: visible });
  };
  try {
    if (controller.signal.aborted) throw controller.signal.reason;
    const prepared = prepareModelCall({ ...input, stream: streaming, onRequest: id => { traceId = id; },
      onHistoryDiagnostic: diagnostic => {
        input.onHistoryDiagnostic?.(diagnostic);
        if (diagnostic.omittedPrivateParts || diagnostic.legacyMessages) console.info("[model-history]", diagnostic);
      } });
    const { origin, ...options } = prepared;
    const common = { ...options, allowSystemInMessages: true, maxRetries: 0, stopWhen: stepCountIs(1), abortSignal: controller.signal,
      ...(Object.keys(options.tools).length ? { toolOrder: Object.keys(options.tools) } : {}) };
    let responseMessages: ModelMessage[];
    let raw: unknown;
    let aliasReasoning = "";
    let generatedImages: GeneratedImageOutput[] = [];
    let responsesTerminal: Record<string, unknown> | undefined;
    if (streaming) {
      const result = streamText({ ...common, streamRetries: 0, includeRawChunks: true });
      const toolIndices = new Map<string, number>();
      const toolIndex = (id: string): number => {
        if (!toolIndices.has(id)) toolIndices.set(id, toolIndices.size);
        return toolIndices.get(id)!;
      };
      let finish: UnifiedStreamDelta | undefined;
      const outputTracker = new ResponsesOutputTracker();
      // 消费一次完整事件流；错误不能被 onError 吞掉后当作成功历史保存。
      for await (const part of result.stream) {
        if (controller.signal.aborted) throw controller.signal.reason;
        switch (part.type) {
          case "raw": {
            const event = asRecord(part.rawValue);
            if (input.adapter.transport === "openai") {
              const delta = chatChoice(event, "delta");
              // 仅补 SDK 未识别的兼容端别名，不重复处理标准推理增量。
              if (delta?.reasoning_content == null && delta?.reasoning == null && typeof delta?.thinking === "string") {
                aliasReasoning += delta.thinking;
                commit({ type: "reasoning_delta", delta: delta.thinking });
              }
              break;
            }
            if (input.adapter.transport !== "responses") break;
            outputTracker.observe(event);
            if (event?.type === "response.completed" || event?.type === "response.incomplete") {
              responsesTerminal = asRecord(event.response);
            }
            break;
          }
          case "text-delta": text(part.text); break;
          case "reasoning-delta": commit({ type: "reasoning_delta", delta: part.text }); break;
          case "tool-input-start": flush(); commit({ type: "tool_call_start", index: toolIndex(part.id), id: part.id, nameDelta: part.toolName }); break;
          case "tool-input-delta": commit({ type: "tool_call_arguments_delta", index: toolIndex(part.id), id: part.id, delta: part.delta }); break;
          case "tool-call": {
            if (isGeneratedImageTool(part.toolName)) break;
            const argumentsJson = toolArguments(part);
            flush();
            commit({ type: "tool_call_end", index: toolIndex(part.toolCallId), id: part.toolCallId,
              terminalSnapshot: true, name: part.toolName, arguments: argumentsJson });
            break;
          }
          case "tool-result":
            generatedImages = collectGeneratedImages([part], generatedImages);
            break;
          case "error": throw part.error;
          case "abort": throw controller.signal.reason ?? new DOMException("模型请求已取消", "AbortError");
          case "finish":
            flush();
            if (part.finishReason === "error" || part.finishReason === "other") throw new AgentRuntimeError("E_MODEL_RESPONSE_PARSE_FAILED", "模型流缺少有效终态");
            commit(usageDelta(part.totalUsage));
            finish = { type: "finish", reason: part.finishReason === "tool-calls" ? "tool_calls" : part.finishReason };
            break;
        }
      }
      if (!finish) throw new AgentRuntimeError("E_MODEL_RESPONSE_PARSE_FAILED", "模型流没有完成");
      generatedImages = collectGeneratedImages(await result.staticToolResults, generatedImages);
      if (input.adapter.transport === "responses") {
        if (!responsesTerminal || !Array.isArray(responsesTerminal.output)) {
          throw new AgentRuntimeError("E_MODEL_RESPONSE_PARSE_FAILED", "Responses 终态缺少完整输出");
        }
        responsesTerminal = outputTracker.reconcile(responsesTerminal, accumulator.snapshot(), responsesTerminal.status === "completed");
        for (const value of responsesTerminal.output as unknown[]) {
          const item = asRecord(value);
          if (item?.type !== "function_call") continue;
          if (!item.call_id || !item.name || item.status === "incomplete" || item.status === "in_progress") {
            throw new AgentRuntimeError("E_MODEL_RESPONSE_PARSE_FAILED", "Responses 工具调用尚未完成");
          }
        }
        const terminalMessage = recoverPortableMessage({ role: "assistant", rawAssistant: responsesTerminal.output });
        for (const call of terminalMessage.toolCalls ?? []) {
          if (isGeneratedImageTool(call.name)) continue;
          const argumentsJson = toolArguments({ input: JSON.parse(call.arguments) });
          commit({ type: "tool_call_end", index: toolIndex(call.id), id: call.id, terminalSnapshot: true,
            name: call.name, arguments: argumentsJson });
        }
      }
      responseMessages = await result.responseMessages;
      raw = await result.response;
      reportWarnings(await result.warnings);
      commit(finish);
    } else {
      const result = await generateText({ ...common, include: { responseBody: true } });
      if (result.finishReason === "error" || result.finishReason === "other") {
        throw new AgentRuntimeError("E_MODEL_RESPONSE_PARSE_FAILED", "模型响应缺少有效终态");
      }
      text(result.text);
      if (result.reasoningText) commit({ type: "reasoning_delta", delta: result.reasoningText });
      else if (input.adapter.transport === "openai") {
        const message = chatChoice(asRecord(result.response.body), "message");
        if (typeof message?.thinking === "string") {
          aliasReasoning = message.thinking;
          commit({ type: "reasoning_delta", delta: aliasReasoning });
        }
      }
      result.toolCalls.forEach((call, index) => {
        if (isGeneratedImageTool(call.toolName)) return;
        const argumentsJson = toolArguments(call);
        commit({ type: "tool_call_end", index, id: call.toolCallId, terminalSnapshot: true,
          name: call.toolName, arguments: argumentsJson });
      });
      generatedImages = collectGeneratedImages(result.staticToolResults);
      flush();
      commit(usageDelta(result.usage));
      commit({ type: "finish", reason: result.finishReason === "tool-calls" ? "tool_calls" : result.finishReason });
      responseMessages = result.responseMessages;
      raw = result.response;
      reportWarnings(result.warnings);
    }
    if (controller.signal.aborted) throw controller.signal.reason;
    const finalized = accumulator.finalize(raw);
    if (finalized.thinking && !finalized.text && !finalized.toolCalls.length && !generatedImages.length && !finalized.refusal) {
      throw new AgentRuntimeError("E_MODEL_RESPONSE_PARSE_FAILED", "模型只返回思考内容，没有正常回复或工具调用");
    }
    let content: Exclude<AssistantContent, string> = responseMessages.flatMap(message => message.role === "assistant"
      ? typeof message.content === "string" ? [{ type: "text" as const, text: message.content }] : message.content : []);
    if (responsesTerminal) content = reconcileResponsesReplay(content, responsesTerminal);
    if (aliasReasoning) content.unshift({ type: "reasoning", text: aliasReasoning });
    const replayContent = stripGeneratedImageReplay(content);
    const response: ChatResponse = { ...finalized, raw: sanitizeGeneratedImageRaw(finalized.raw),
      ...(generatedImages.length ? { generatedImages } : {}),
      assistantMessage: { ...finalized.assistantMessage,
        providerReplay: { version: 1, origin, content: JSON.parse(JSON.stringify(replayContent)) as typeof content } } };
    if (traceId) dumpResponse(traceId, { transport: input.adapter.transport, ok: true, ...response,
      generatedImages: generatedImages.map(image => ({ id: image.id, mime: image.mime,
        byteLength: Math.max(0, Math.floor(image.base64.length * 3 / 4)
          - (image.base64.endsWith("==") ? 2 : image.base64.endsWith("=") ? 1 : 0)) })) });
    return response;
  } catch (error) {
    if (traceId) dumpResponse(traceId, { transport: input.adapter.transport, ok: false, raw: null,
      error: error instanceof Error ? error.name : "ModelError" });
    if (input.signal?.aborted) throw input.signal.reason instanceof Error ? input.signal.reason : new DOMException("模型请求已取消", "AbortError");
    if (error instanceof AgentRuntimeError && !timedOut) throw error;
    const failure = classifyModelFailure({ provider: input.adapter.id, model: input.request.model, error });
    throw new AgentRuntimeError(timedOut ? "E_MODEL_REQUEST_TIMEOUT" : "E_MODEL_REQUEST_FAILED", timedOut ? "模型响应超时，请稍后重试。"
      : failure.status ? `模型请求失败：HTTP ${failure.status}` : "模型服务请求失败。", {
      cause: error, modelFailure: timedOut ? { ...failure, category: "TIMEOUT" } : failure,
      retryAfterMs: readRetryAfterMs(error),
    });
  } finally {
    if (timer) clearTimeout(timer);
    input.signal?.removeEventListener("abort", callerAbort);
  }
}

function reportWarnings(warnings: ReadonlyArray<{ type: string }> | undefined): void {
  if (warnings?.length) console.warn("[model-sdk]", { code: "MODEL_PROVIDER_WARNINGS", types: warnings.map(warning => warning.type) });
}

function isGeneratedImageTool(name: string): boolean {
  return name === "image_generation" || name.endsWith(".image_generation");
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function chatChoice(body: Record<string, unknown> | undefined, field: "message" | "delta"): Record<string, unknown> | undefined {
  return Array.isArray(body?.choices) ? asRecord(asRecord(body.choices[0])?.[field]) : undefined;
}

/** 工具是否开放由调度层反馈；生成与重放接受同样的参数对象范围。 */
function toolArguments(call: { input: unknown; invalid?: boolean; error?: unknown }): string {
  if (call.invalid && !NoSuchToolError.isInstance(call.error)) throw call.error;
  if (!asRecord(call.input)) throw new AgentRuntimeError("E_MODEL_RESPONSE_PARSE_FAILED", "工具参数必须是 JSON 对象");
  return JSON.stringify(call.input);
}

/** 只补 SDK 未覆盖的终态内容，并按完整输出顺序排列；沿用既有兼容端终态补全语义。 */
function reconcileResponsesReplay(content: Exclude<AssistantContent, string>, terminal: Record<string, unknown>): Exclude<AssistantContent, string> {
  const ordered: typeof content = [];
  const consumed = new Set<(typeof content)[number]>();
  for (const value of terminal.output as unknown[]) {
    const item = asRecord(value);
    if (!item) continue;
    const matches = content.filter(part => part.type === "tool-call" ? part.toolCallId === item.call_id
      : typeof item.id === "string" && "providerOptions" in part && part.providerOptions?.openai?.itemId === item.id);
    matches.forEach(part => consumed.add(part));
    if (matches.length) {
      ordered.push(...matches.map(part => part.type === "reasoning" && item.type === "reasoning" && typeof item.encrypted_content === "string"
        ? { ...part, providerOptions: { ...part.providerOptions, openai: {
          ...part.providerOptions?.openai, reasoningEncryptedContent: item.encrypted_content,
        } } } : part));
      continue;
    }
    const nativeId = typeof item.id === "string" && item.id ? { itemId: item.id } : {};
    const providerOptions = { openai: nativeId };
    if (item.type === "function_call") {
      ordered.push({ type: "tool-call", toolCallId: String(item.call_id), toolName: String(item.name),
        input: JSON.parse(String(item.arguments)), providerOptions });
    } else if (item.type === "reasoning" && typeof item.encrypted_content === "string") {
      const text = Array.isArray(item.summary) ? item.summary.map(part => String(asRecord(part)?.text ?? "")).join("\n") : "";
      ordered.push({ type: "reasoning", text, providerOptions: { openai: {
        ...nativeId, reasoningEncryptedContent: item.encrypted_content,
      } } });
    }
  }
  ordered.push(...content.filter(part => !consumed.has(part)));
  return ordered;
}
