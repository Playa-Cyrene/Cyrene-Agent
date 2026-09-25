import type { ChatVendorAdapter, ChatMessage, ChatRequest, OpenAIContentBlock } from "./vendors/types";
import type { AgentLoopSettings, AgentLoopEvent } from "./cyrene-agent";
import { recordRequest, recordUsage } from "../token-usage-store";

const COMPRESSION_PROMPT = `你正在帮"昔涟"整理对话记忆。请把下面这段较早的对话历史总结成一段简洁的摘要，供后续回复参考。

要求：
1. 保留用户的核心目标、当前任务、未完成的待办事项。
2. 保留用户明确表达过的偏好、禁忌、格式要求。
3. 保留已确认的事实和数据（如路径、文件名、参数值）。
4. 删除具体的寒暄、重复确认、过渡性语句。
5. 如果对话中包含代码/命令，只保留最终生效的版本和用途说明，不保留中间试错。
6. 摘要控制在 400~600 字以内，用中文输出。

对话历史：
{history}

请直接输出摘要内容，不要加任何前缀说明。`;

/** 每轮对话 = user + assistant 两条消息。 */
function keepRecentCount(mode: string): number {
  switch (mode) {
    case "work":
    case "code":
      return 6;
    case "learn":
      return 10;
    case "chat":
      return 20;
    default:
      return 6;
  }
}

/** 简单 token 估算：中文字符按 1 token / 1.5 字符，英文按 4 字符 / token。 */
export function estimateTokens(text: string): number {
  if (!text) return 0;
  let nonAscii = 0;
  let ascii = 0;
  for (const char of text) {
    if (char.charCodeAt(0) > 127) nonAscii++;
    else ascii++;
  }
  return Math.ceil(nonAscii / 1.5 + ascii / 4);
}

/**
 * 保守固定回退值。协议 ≠ tokenizer：MiniMax 模型走 Anthropic 协议并不会因此
 * 使用 Claude 的视觉计费算法，故不绑定任何厂商公式。
 * 现实区间：主流多模态模型单图 1k~5k token；取 4096 保守偏高——
 * 压缩安全判定宁可高估，不可低估撞穿 context window。
 */
export const DEFAULT_IMAGE_TOKEN_ESTIMATE = 4096;

/**
 * 图片块不计 base64 字符串（按 DEFAULT_IMAGE_TOKEN_ESTIMATE 估算），text 块照常估算。
 * estimateMessageTokens 与 buildContextUsageSnapshot 共用此函数，防止计量与
 * 压缩判定口径分裂（见 docs/design/2026-08-26-image-context-screenshot-known-issues.md 问题 2）。
 */
export function estimateMessageContentTokens(
  content: string | OpenAIContentBlock[],
): number {
  if (typeof content === "string") return estimateTokens(content);
  let sum = 0;
  for (const block of content) {
    if (block.type === "text") sum += estimateTokens(block.text);
    else sum += DEFAULT_IMAGE_TOKEN_ESTIMATE; // image_url 块
  }
  return sum;
}

export function estimateMessageTokens(messages: ChatMessage[]): number {
  return messages.reduce((sum, m) => {
    return sum + estimateMessageContentTokens(m.content ?? "") + 4; // +4 为角色/格式开销
  }, 0);
}

function formatConversation(messages: ChatMessage[]): string {
  return messages
    .map((m) => {
      const prefix = m.role === "user" ? "用户" : m.role === "assistant" ? "昔涟" : m.role;
      const text = typeof m.content === "string" ? m.content : JSON.stringify(m.content);
      return `--- ${prefix} ---\n${text}`;
    })
    .join("\n\n");
}

function splitMessages(messages: ChatMessage[]): { systems: ChatMessage[]; conversation: ChatMessage[] } {
  const systems: ChatMessage[] = [];
  const conversation: ChatMessage[] = [];
  for (const m of messages) {
    if (m.role === "system") systems.push(m);
    else conversation.push(m);
  }
  return { systems, conversation };
}

export interface CompressOptions {
  messages: ChatMessage[];
  adapter: ChatVendorAdapter;
  settings: AgentLoopSettings;
  /** 当前要附加到请求里的 system prompt（chat 模式为 soulSystemBaseContent）。 */
  systemContent: string;
  mode?: string;
  onEvent?: (event: AgentLoopEvent) => void;
  signal?: AbortSignal;
}

export async function compressConversation(options: CompressOptions): Promise<ChatMessage[]> {
  const { messages, adapter, settings, systemContent, mode = "work", onEvent, signal } = options;
  const contextWindow = settings.contextWindowTokens ?? 256000;
  const threshold = Math.floor(contextWindow * 0.8);

  const { systems, conversation } = splitMessages(messages);
  const keepCount = keepRecentCount(mode) * 2;

  // 消息太少，不需要压缩
  if (conversation.length <= keepCount) return messages;

  const systemTokens = estimateTokens(systemContent) + estimateMessageTokens(systems);
  const conversationTokens = estimateMessageTokens(conversation);
  const totalTokens = systemTokens + conversationTokens;

  // 未超过阈值，不压缩
  if (totalTokens < threshold) return messages;

  const compressible = conversation.slice(0, -keepCount);
  const recent = conversation.slice(-keepCount);

  onEvent?.({ type: "compressing_context" });

  try {
    const summary = await callSummarizeModel(compressible, adapter, settings, signal);
    const summaryMessage: ChatMessage = {
      role: "assistant",
      content: `[此前对话已压缩为记忆摘要]\n${summary}`,
    };
    return [...systems, summaryMessage, ...recent];
  } catch (err) {
    console.warn("[ContextManager] 模型压缩失败，回退到截断:", err);
    // 压缩失败时兜底：直接丢弃最旧的消息，不调用模型
    return [...systems, ...recent];
  }
}

/**
 * 独立的 LLM 摘要调用：把一段历史消息摘要成文本。
 * Chat 模式循环内压缩与「主动压缩」IPC（chats:compact）共用；失败直接 throw，由调用方决定兜底。
 */
export async function callSummarizeModel(
  messages: ChatMessage[],
  adapter: ChatVendorAdapter,
  settings: AgentLoopSettings,
  signal?: AbortSignal,
): Promise<string> {
  const prompt = COMPRESSION_PROMPT.replace("{history}", formatConversation(messages));
  const request: ChatRequest = {
    model: settings.model,
    messages: [
      { role: "system", content: prompt },
      { role: "user", content: "请总结上面的对话历史。" },
    ],
    stream: false,
  };

  const vendorConfig = {
    provider: settings.provider,
    baseUrl: settings.baseUrl,
    model: settings.model,
    apiKey: settings.apiKey,
    explicitTransport: settings.explicitTransport,
    reasoning: settings.reasoning,
    manualReasoning: settings.manualReasoning,
  };

  const effectiveRequest = adapter.applyCacheHints?.(request, vendorConfig) ?? request;
  const http = adapter.buildRequest(effectiveRequest, settings);
  const controller = new AbortController();
  const abort = () => controller.abort();
  signal?.addEventListener("abort", abort, { once: true });

  try {
    const response = await fetch(http.url, {
      method: "POST",
      headers: http.headers,
      body: http.body,
      signal: controller.signal,
    });
    if (!response.ok) {
      const body = await response.text().catch(() => "");
      throw new Error(`压缩请求失败：HTTP ${response.status}${body ? ` - ${body.slice(0, 200)}` : ""}`);
    }
    const parsed = adapter.parseResponse(await response.json());
    // 压缩是一次真实 LLM 请求，与其他调用一样记入 Token 用量统计
    recordRequest(settings.model);
    if (parsed.usage) {
      recordUsage(parsed.usage.input, parsed.usage.output, 1, parsed.usage.cachedInput, settings.model, parsed.usage.cacheCreation);
    }
    return parsed.text.trim() || "[压缩结果为空]";
  } finally {
    signal?.removeEventListener("abort", abort);
  }
}
