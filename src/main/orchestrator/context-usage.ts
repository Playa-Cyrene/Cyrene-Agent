// 上下文容量快照计算：把一轮请求的上下文按 5 类拆分 token 估算。
//
// 设计要点（docs/context-usage-viewer-construction-plan.md）：
// - 复用 context-manager 的 estimateTokens，与 computeTokenBudget 同公式，不做精确 tokenizer；
//   快照仅用于展示，不参与任何截断/压缩决策。
// - 消息分类判定优先级（钉死，勿改顺序）：
//   1. compaction checkpoint → conversation（优先级最高，杜绝与 internal 规则打架）
//   2. role === "tool" → runtimeAndToolLogs
//   3. visibility === "internal" → runtimeAndToolLogs
//   4. user / assistant / 其余 system → conversation
//   5. 未识别形状 → other（仅格式开销兜底计入）
// - chat 模式不变量：messages 不得包含 composePromptLayers 追加的 <runtime_context>
//   尾部消息，runtimeContext 由独立参数计量，否则双重计数。

import type { ChatMessage } from "./vendors/types";
import { estimateTokens, estimateMessageContentTokens } from "./context-manager";
import { isCompactionCheckpointMessage } from "./harness/compaction";
import type {
  ContextUsageCategory,
  ContextUsageCategoryKey,
  ContextUsagePhase,
  ContextUsageSnapshot,
} from "../../shared/context-usage";

const CATEGORY_KEYS: readonly ContextUsageCategoryKey[] = [
  "systemPrompt",
  "tools",
  "skills",
  "runtimeAndToolLogs",
  "conversation",
  "other",
];

export interface ContextUsageSnapshotInput {
  phase: ContextUsagePhase;
  runId?: string;
  round?: number;
  contextWindowTokens: number;
  /** 人设层文本（系统提示词类）。 */
  personaContent: string;
  /** 工具规则/目录/使用规范文本（含 Skill 目录段）；缺省为空。 */
  toolLayerContent?: string;
  /** toolLayerContent 中 Skill 目录段（skillCatalog + 自动注入 skill 上下文）的独立副本；
   *  快照把这一段从"工具"里拆出单独计"技能"类；缺省不拆。 */
  skillLayerContent?: string;
  /** 工具 schema 列表；chat 模式不传。 */
  toolSpecs?: Array<{ name: string; description: string; parameters: object }>;
  /** chat 模式请求尾部注入的 runtime context 文本；harness 模式不传（已物化进消息）。 */
  runtimeContext?: string;
  /**
   * 本轮基础消息列表。
   * 不变量：chat 模式不得包含 composePromptLayers 追加的 <runtime_context> 尾部消息，
   * runtimeContext 由独立参数计量，避免双重计数。
   */
  messages: ChatMessage[];
}

function classifyMessage(message: ChatMessage): ContextUsageCategoryKey {
  if (isCompactionCheckpointMessage(message)) return "conversation";
  if (message.role === "tool") return "runtimeAndToolLogs";
  if (message.visibility === "internal") return "runtimeAndToolLogs";
  if (message.role === "user" || message.role === "assistant" || message.role === "system") {
    return "conversation";
  }
  return "other";
}

export function buildContextUsageSnapshot(input: ContextUsageSnapshotInput): ContextUsageSnapshot {
  const buckets: Record<ContextUsageCategoryKey, number> = {
    systemPrompt: 0,
    tools: 0,
    skills: 0,
    runtimeAndToolLogs: 0,
    conversation: 0,
    other: 0,
    // 旧兼容 key 恒 0：计算端不再产出，仅为满足 Record 全键。
    toolDefinitions: 0,
  };

  buckets.systemPrompt += estimateTokens(input.personaContent);
  // Skill 目录段先单独计量，再从工具层总量中扣除（skill 段嵌在 toolSystemContent 里，
  // 前后分隔符 \n\n---\n\n 的几 token 留在工具类，属估算容差）。
  buckets.skills += estimateTokens(input.skillLayerContent ?? "");
  buckets.tools += Math.max(0, estimateTokens(input.toolLayerContent ?? "") - buckets.skills);
  for (const spec of input.toolSpecs ?? []) {
    // 与 computeTokenBudget 同公式。
    buckets.tools += estimateTokens(spec.name + spec.description + JSON.stringify(spec.parameters));
  }
  if (input.runtimeContext?.trim()) {
    // 与 composePromptLayers 的 wire 包装一致，含标签开销。
    buckets.runtimeAndToolLogs += estimateTokens(
      `<runtime_context>\n${input.runtimeContext.trim()}\n</runtime_context>`,
    );
  }

  for (const message of input.messages) {
    // 图片块按 DEFAULT_IMAGE_TOKEN_ESTIMATE 计量（不计 base64 全长），
    // 与 estimateMessageTokens 同口径，防止计量与压缩判定分裂。
    // +4 为角色/格式开销，与 estimateMessageTokens 一致。
    buckets[classifyMessage(message)] += estimateMessageContentTokens(message.content ?? "") + 4;
  }

  const categories: ContextUsageCategory[] = CATEGORY_KEYS.map((key) => ({ key, tokens: buckets[key] }));
  return {
    phase: input.phase,
    ...(input.runId ? { runId: input.runId } : {}),
    ...(typeof input.round === "number" ? { round: input.round } : {}),
    contextWindowTokens: input.contextWindowTokens,
    totalTokens: categories.reduce((sum, category) => sum + category.tokens, 0),
    categories,
    messageCount: input.messages.length,
    updatedAt: Date.now(),
  };
}

/** 压缩只改消息历史：系统、工具与技能沿用最近一次请求的计量。 */
export function buildCompactionContextUsageSnapshot(input: {
  phase: ContextUsagePhase;
  contextWindowTokens: number;
  messages: ChatMessage[];
  previous?: ContextUsageSnapshot;
}): ContextUsageSnapshot {
  const computed = buildContextUsageSnapshot({ ...input, personaContent: "" });
  const inheritable = new Map(
    (input.previous?.categories ?? [])
      .filter((category) => category.key === "systemPrompt" || category.key === "tools" || category.key === "skills")
      .map((category) => [category.key, category.tokens]),
  );
  const categories = computed.categories.map((category) => ({
    ...category,
    tokens: inheritable.get(category.key) ?? category.tokens,
  }));
  return { ...computed, categories, totalTokens: categories.reduce((sum, category) => sum + category.tokens, 0) };
}
