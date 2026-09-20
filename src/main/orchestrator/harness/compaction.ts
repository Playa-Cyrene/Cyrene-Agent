/**
 * 循环内上下文压缩：在 Agent Loop 中途、而非仅入口处，防止循环内上下文膨胀。
 *
 * 三件事：
 * 1. 循环内检查点（每轮 callLLM 前检查，阈值 0.7）
 * 2. 配对安全切点（不切断 tool_call / tool_result 配对）
 * 3. agent 导向压缩 prompt
 *
 * 底座复用 context-manager.ts 的 estimateTokens / estimateMessageTokens。
 */

import type { ChatMessage } from "../vendors/types";
import { estimateTokens, estimateMessageTokens } from "../context-manager";

// ── Token 预算计算 ────────────────────────────────────────

export interface TokenBudget {
  /** 可用输入预算 = contextWindow - reservedOutput - safetyMargin */
  usableInputBudget: number;
  /** 估算的输入 token（system + toolSchemas + messages） */
  estimatedInput: number;
  /** 是否需要压缩 */
  needsCompaction: boolean;
}

/**
 * 计算 token 预算并判断是否需要压缩。
 *
 * @param systemPrompt 系统提示词
 * @param toolSchemas 工具 schema 列表
 * @param messages 消息列表
 * @param contextWindow 上下文窗口大小
 * @param reservedOutput 为 LLM 回复预留的 token
 * @param safetyMargin 固定安全余量
 * @param threshold 压缩触发阈值（默认 0.7）
 */
export function computeTokenBudget(
  systemPrompt: string,
  toolSchemas: Array<{ name: string; description: string; parameters: object }>,
  messages: ChatMessage[],
  contextWindow: number,
  reservedOutput: number,
  safetyMargin: number,
  threshold = 0.7,
): TokenBudget {
  const systemTokens = estimateTokens(systemPrompt);
  const schemaTokens = toolSchemas.reduce(
    (sum, s) => sum + estimateTokens(s.name + s.description + JSON.stringify(s.parameters)),
    0,
  );
  const messageTokens = estimateMessageTokens(messages);

  const usableInputBudget = contextWindow - reservedOutput - safetyMargin;
  const estimatedInput = systemTokens + schemaTokens + messageTokens;

  return {
    usableInputBudget,
    estimatedInput,
    needsCompaction: estimatedInput >= usableInputBudget * threshold,
  };
}

// ── 配对安全切点 ─────────────────────────────────────────

/**
 * 找到配对安全的压缩切点。
 *
 * 规则：从保留边界往前退，直到落在 "user 消息" 或 "无 tool_calls 的 assistant" 上。
 * 保证 assistant.tool_calls 和对应的 tool result 永远在同一块里。
 *
 * @param messages 完整消息列表
 * @param keepRecentCount 保留最近 N 条消息
 * @returns 被压缩段的结束索引（ exclusive），messages[0:cutIndex] 被压缩
 */
export function findSafeCutPoint(
  messages: ChatMessage[],
  keepRecentCount: number,
): number {
  if (messages.length <= keepRecentCount) return 0;

  // 初始切点：保留最近 keepRecentCount 条
  let cutIndex = messages.length - keepRecentCount;

  // 往前退，直到落在安全位置
  while (cutIndex > 0) {
    const msg = messages[cutIndex];

    // 安全位置 1: user 消息
    if (msg.role === "user") break;

    // 安全位置 2: 无 tool_calls 的 assistant 消息
    if (msg.role === "assistant" && (!msg.toolCalls || msg.toolCalls.length === 0)) break;

    // 安全位置 3: system 消息（不太可能，但理论上安全）
    if (msg.role === "system") break;

    // 不安全：tool 消息或带 tool_calls 的 assistant → 继续往前退
    cutIndex--;
  }

  return cutIndex;
}

/**
 * 判断一个 transcript 边界是否完整保留了每个 tool call / tool result 配对。
 * `cutIndex` 左边会被压缩、右边原样保留；任何一对不得跨越该边界。
 * 会话轨迹（CTA）的模型上下文物化复用同一安全语义。
 */
export function isToolPairSafeBoundary(messages: ChatMessage[], cutIndex: number): boolean {
  const toolCallIndexes = new Map<string, number>();
  for (let index = 0; index < messages.length; index++) {
    const entry = messages[index];
    if (entry?.role !== "assistant") continue;
    for (const call of entry.toolCalls ?? []) toolCallIndexes.set(call.id, index);
  }

  for (let resultIndex = 0; resultIndex < messages.length; resultIndex++) {
    const entry = messages[resultIndex];
    if (entry?.role !== "tool" || !entry.toolCallId) continue;
    const callIndex = toolCallIndexes.get(entry.toolCallId);
    if (callIndex !== undefined && callIndex < cutIndex && resultIndex >= cutIndex) return false;
  }
  return true;
}

/**
 * 按 token 预算保留近期尾部，并将边界回退到不会拆开工具配对的位置。
 * 返回 0 表示没有足够安全、可压缩的旧历史。
 */
export function findSafeCutPointForRetainedTokens(
  messages: ChatMessage[],
  retainTokens: number,
): number {
  if (messages.length === 0 || retainTokens <= 0) return 0;

  let cutIndex = messages.length;
  let retainedTokens = 0;
  while (cutIndex > 0 && retainedTokens < retainTokens) {
    cutIndex--;
    retainedTokens += estimateMessageTokens([messages[cutIndex]!]);
  }

  while (cutIndex > 0 && !isToolPairSafeBoundary(messages, cutIndex)) cutIndex--;
  return cutIndex;
}

// ── Agent 导向压缩 prompt ────────────────────────────────

export const AGENT_COMPACTION_PROMPT = `你正在为 CyreneHarness 生成可恢复的执行历史检查点。请将上方较早的对话历史压缩为以下固定 Markdown 结构；每个标题都必须保留，没有内容时写“无”。

## 原始任务与意图
## 已确认事实
## 文件与改动
## 工具结果与引用
## Todo 与未完成事项
## 不确定副作用
## 当前进度
## 下一步

规则：
1. 保留用户目标、明确约束、精确路径、命令、错误、标识符、数值和已经确认的结论。
2. 工具结果只写必要事实；若消息里已有 tool-result:// 引用，保留该引用，不要编造完整输出。
3. 合并先前的检查点，只保留仍然有效的事实，删除模型自言自语与重复过渡语。
4. 使用简洁中文项目符号；不要调用工具，不要解释你正在生成摘要。
5. 摘要必须明显短于被压缩的历史。`;

const COMPACTION_CHECKPOINT_OPEN = "<cyrene_compaction_checkpoint>";
const COMPACTION_CHECKPOINT_CLOSE = "</cyrene_compaction_checkpoint>";

/** 判定消息是否为压缩检查点（单一事实源；context-usage 分类等消费方复用，禁止重复实现标记匹配）。 */
export function isCompactionCheckpointMessage(
  message: Pick<ChatMessage, "role" | "content">,
): boolean {
  return message.role === "system"
    && typeof message.content === "string"
    && message.content.includes(COMPACTION_CHECKPOINT_OPEN);
}

/** 将已验证的摘要包装为可持久化、可识别的 transcript 检查点。 */
export function buildCompactionCheckpoint(summary: string): ChatMessage {
  return {
    role: "system",
    content: `${COMPACTION_CHECKPOINT_OPEN}\n${summary.trim()}\n${COMPACTION_CHECKPOINT_CLOSE}`,
  };
}

// ── 压缩执行 ─────────────────────────────────────────────

export interface CompactionOptions {
  messages: ChatMessage[];
  /** 压缩后至少原样保留的近期 transcript token 估算值。 */
  retainTokens: number;
  /** 压缩回调：把待压缩的原始消息序列摘要成一段。 */
  summarize: (history: ChatMessage[]) => Promise<string>;
}

/**
 * 执行循环内压缩。
 *
 * 1. 找配对安全切点
 * 2. 被压缩段走摘要
 * 3. 保留段原样
 * 4. 永远不存在孤儿 tool_call 或孤儿 tool result
 */
export async function compressForAgentLoop(
  options: CompactionOptions,
): Promise<ChatMessage[]> {
  const { messages, retainTokens, summarize } = options;

  const cutIndex = findSafeCutPointForRetainedTokens(messages, retainTokens);
  if (cutIndex === 0) return messages; // 无法安全切分

  const toCompress = messages.slice(0, cutIndex);
  const toKeep = messages.slice(cutIndex);

  try {
    const summary = await summarize(toCompress);
    if (!summary.trim()) return messages;
    const summaryMessage = buildCompactionCheckpoint(summary);
    if (estimateMessageTokens([summaryMessage]) >= estimateMessageTokens(toCompress)) {
      return messages;
    }
    return [summaryMessage, ...toKeep];
  } catch {
    // 摘要失败绝不丢弃历史；下轮可重试或由上层处理模型窗口溢出。
    return messages;
  }
}
