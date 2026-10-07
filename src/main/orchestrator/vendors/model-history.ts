import { createHash } from "node:crypto";
import { modelMessageSchema, type AssistantContent, type ModelMessage } from "ai";
import type { ChatMessage, ChatMessageContent, ChatVendorAdapter, ModelMessageOrigin, ToolCall, VendorConfig } from "./types";
import { AgentRuntimeError } from "../agent-runtime-error";
import { resolveApiEndpoint } from "../../../shared/api-endpoint";

export interface HistoryProjectionDiagnostic {
  code: "HISTORY_PORTABLE_PROJECTION";
  transport: ModelMessageOrigin["transport"];
  nativeMessages: number;
  portableMessages: number;
  omittedPrivateParts: number;
  legacyMessages: number;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

export function originDigest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function modelMessageOrigin(adapter: ChatVendorAdapter, config: VendorConfig): ModelMessageOrigin {
  return { transport: adapter.transport, provider: adapter.id, model: config.model,
    endpoint: originDigest(resolveApiEndpoint(config.baseUrl, adapter.transport).url),
    credentialScope: originDigest(config.apiKey) };
}

export function sameMessageOrigin(left: ModelMessageOrigin, right: ModelMessageOrigin): boolean {
  return left.transport === right.transport && left.provider === right.provider && left.model === right.model
    && left.endpoint === right.endpoint && left.credentialScope === right.credentialScope;
}

/** 统一校验来源和内容，返回副本，避免请求编码修改已保存的历史。 */
export function readAssistantReplay(message: ChatMessage, target: ModelMessageOrigin): Exclude<AssistantContent, string> | undefined {
  const replay = message.providerReplay;
  if (replay?.version !== 1 || !replay.origin || !sameMessageOrigin(replay.origin, target)) return undefined;
  const parsed = modelMessageSchema.safeParse({ role: "assistant", content: replay.content });
  return parsed.success && parsed.data.role === "assistant" && Array.isArray(parsed.data.content)
    ? structuredClone(parsed.data.content) : undefined;
}

/** 旧版兼容接口只保存 thinking；仅为 DeepSeek 恢复纯文本，不猜测原始块或签名。 */
export function legacyDeepSeekReasoning(message: ChatMessage, target: ModelMessageOrigin): string | undefined {
  return target.transport === "openai" && target.provider === "deepseek"
    && message.role === "assistant" && message.providerReplay === undefined && message.rawAssistant === undefined
    && typeof message.thinking === "string" ? message.thinking : undefined;
}

/** 旧消息只恢复已知的正文和工具语义；不猜测签名所属账号和模型。 */
export function recoverPortableMessage(message: ChatMessage): ChatMessage {
  if (message.role !== "assistant" || !Array.isArray(message.rawAssistant)) return message;
  let text = "";
  const calls: ToolCall[] = [];
  for (const value of message.rawAssistant) {
    const item = record(value);
    if (!item) continue;
    if (item.type === "text" && typeof item.text === "string") text += item.text;
    if (item.type === "message" && Array.isArray(item.content)) {
      for (const value of item.content) {
        const part = record(value);
        if (part?.type === "output_text" && typeof part.text === "string") text += part.text;
        if (part?.type === "refusal" && typeof part.refusal === "string") text += part.refusal;
      }
    }
    if (item.type === "tool_use" && typeof item.id === "string" && typeof item.name === "string") {
      calls.push({ id: item.id, name: item.name, arguments: JSON.stringify(item.input ?? {}) });
    }
    if (item.type === "function_call" && typeof item.call_id === "string" && typeof item.name === "string" && typeof item.arguments === "string") {
      calls.push({ id: item.call_id, name: item.name, arguments: item.arguments });
    }
  }
  return { ...message, content: message.content === undefined || message.content === "" ? text : message.content,
    toolCalls: message.toolCalls ?? (calls.length ? calls : undefined) };
}

export function contentText(content?: ChatMessageContent): string {
  return typeof content === "string" ? content : (content ?? []).filter(part => part.type === "text").map(part => part.text).join("");
}

function toolInput(call: ToolCall): unknown {
  try {
    const input: unknown = JSON.parse(call.arguments);
    if (!record(input)) throw new Error("工具参数必须是对象");
    return input;
  } catch (cause) {
    throw new AgentRuntimeError("E_MODEL_RESPONSE_PARSE_FAILED", `历史工具参数无效：${call.name}`, { cause });
  }
}

type AssistantPart = Exclude<AssistantContent, string>[number];

/** 从通用消息生成请求副本；签名等私有内容仅在完全兼容的来源重放。 */
export function projectModelHistory(
  history: ChatMessage[], target: ModelMessageOrigin,
  onDiagnostic?: (diagnostic: HistoryProjectionDiagnostic) => void,
): ModelMessage[] {
  const diagnostic: HistoryProjectionDiagnostic = { code: "HISTORY_PORTABLE_PROJECTION", transport: target.transport,
    nativeMessages: 0, portableMessages: 0, omittedPrivateParts: 0, legacyMessages: 0 };
  const result: ModelMessage[] = [];
  const callNames = new Map<string, string>();
  const ids = new Map<string, string>();
  const reserved = new Set(history.map(recoverPortableMessage).flatMap(message => (message.toolCalls ?? []).map(call => call.id)));
  const wireId = (id: string): string => {
    if (/^[a-zA-Z0-9_-]{1,64}$/.test(id)) return id;
    const existing = ids.get(id);
    if (existing) return existing;
    let replacement = `call_${originDigest(id).slice(0, 40)}`;
    while (reserved.has(replacement)) replacement += "_";
    ids.set(id, replacement);
    reserved.add(replacement);
    return replacement;
  };
  for (const original of history) {
    const message = recoverPortableMessage(original);
    if (message.role === "system") {
      result.push({ role: "system", content: contentText(message.content) });
    } else if (message.role === "user") {
      const content = message.content;
      result.push({ role: "user", content: typeof content === "string" || content === undefined ? content ?? ""
        : content.map(part => {
          if (part.type === "text") return { ...part };
          const url = part.image_url.url;
          const match = /^data:([^;]+);base64,(.*)$/s.exec(url);
          return { type: "file" as const, mediaType: match?.[1] ?? "image",
            data: match ? { type: "data" as const, data: match[2] } : { type: "url" as const, url: new URL(url) } };
        }) });
    } else if (message.role === "tool") {
      const id = message.toolCallId;
      const name = id ? callNames.get(id) : undefined;
      if (!id || !name) throw new AgentRuntimeError("E_MODEL_RESPONSE_PARSE_FAILED", "历史工具结果缺少配对的调用");
      result.push({ role: "tool", content: [{ type: "tool-result", toolCallId: wireId(id), toolName: name,
        output: { type: "text", value: contentText(message.content) } }] });
    } else {
      const calls = message.toolCalls ?? [];
      const portable: AssistantPart[] = [];
      const generatedImages = (message.attachments ?? []).filter(attachment =>
        attachment.kind === "image" && attachment.source === "model");
      const text = [contentText(message.content), ...generatedImages.map(image => `已生成图片：${image.name}`)]
        .filter(Boolean).join("\n");
      if (text) portable.push({ type: "text", text });
      for (const call of calls) {
        callNames.set(call.id, call.name);
        portable.push({ type: "tool-call", toolCallId: wireId(call.id), toolName: call.name, input: toolInput(call) });
      }
      const replay = message.providerReplay;
      const native = readAssistantReplay(message, target);
      let content = portable;
      if (native) {
        content = native;
        // 展示过滤、正文修订和工具修复后，通用语义始终优先于重放副本。
        const nativeText = content.filter(part => part.type === "text").map(part => part.text).join("");
        if (nativeText !== text) {
          let inserted = false;
          content = content.flatMap<AssistantPart>(part => {
            if (part.type !== "text") return [part];
            if (inserted || !text) return [];
            inserted = true;
            return [{ type: "text" as const, text }];
          });
          if (!inserted && text) content.push({ type: "text", text });
        }
        const seen = new Set<string>();
        content = content.flatMap<AssistantPart>(part => {
          if (part.type !== "tool-call") return [part];
          const call = calls.find(call => call.id === part.toolCallId);
          if (!call) return [];
          seen.add(wireId(call.id));
          return [{ ...part, toolCallId: wireId(call.id), toolName: call.name, input: toolInput(call) }];
        });
        for (const part of portable) if (part.type === "tool-call" && !seen.has(part.toolCallId)) content.push(part);
        diagnostic.nativeMessages++;
      } else {
        diagnostic.portableMessages++;
        if (original.rawAssistant !== undefined) diagnostic.legacyMessages++;
        const legacyReasoning = legacyDeepSeekReasoning(message, target);
        if (legacyReasoning && portable.length) {
          content = [{ type: "reasoning", text: legacyReasoning }, ...portable];
          diagnostic.legacyMessages++;
        }
        diagnostic.omittedPrivateParts += Array.isArray(replay?.content)
          ? replay.content.filter(part => record(part)?.type !== "text" && record(part)?.type !== "tool-call").length
          : !legacyReasoning && (original.thinking || original.rawAssistant !== undefined) ? 1 : 0;
      }
      // 中断遗留的纯思考空回复，即使来源匹配也不能作为完成的 assistant 回传。
      // 只过滤请求副本，保留原轨迹供展示和排查。
      if (portable.length && content.length) result.push({ role: "assistant", content });
    }
  }
  onDiagnostic?.(diagnostic);
  return result;
}
