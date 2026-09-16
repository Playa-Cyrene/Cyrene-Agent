// 工具注册表 — 统一管理所有可被 LLM Router 调度的工具
// Worldbook 不在此注册，它走独立常驻检索路径

import { searchMemory } from "../../../rag/index";
import type { ToolRiskLevel } from "../../../permission";
import type { ToolContext } from "./tool-context";
import type { ConversationMode } from "../../../../shared/chat-types";

/** 工具效果类型：决定工具对系统状态的影响分类。未配置默认 "unknown"。 */
export type ToolEffectKind =
  | "read"
  | "mutation"
  | "verification"
  | "external_side_effect"
  | "unknown";

/** 验证策略：决定 mutation 工具需要何种验证。 */
export type VerificationPolicy = "none" | "artifact" | "code" | "unknown";

/** 动态效果解析器：根据参数判断效果类型（如 run_shell 根据 purpose）。 */
export type ToolEffectResolver = (args: Record<string, unknown>) => ToolEffectKind;

/** 工具并发安全判定：只返回严格 true 时，当前参数才可进入 Harness 并发池。 */
export type ToolConcurrencyClassifier = (args: Record<string, unknown>) => boolean;

/** 动态验证策略解析器：根据参数判断验证策略（如 write_file 根据文件扩展名）。 */
export type VerificationPolicyResolver = (args: Record<string, unknown>) => VerificationPolicy;

/** JSON Schema 片段：参数可以是简单类型，也可以是 array/object（含 items/properties）。 */
export type JsonSchemaProp =
  | { type: string; description?: string; enum?: string[]; default?: unknown; askAliases?: Record<string, unknown> }
  | { type: "array"; description?: string; items: JsonSchemaProp; default?: unknown; askAliases?: Record<string, unknown> }
  | { type: "object"; description?: string; properties: Record<string, JsonSchemaProp>; required?: string[]; default?: unknown; askAliases?: Record<string, unknown> };

/** 控制输入策略：简单字符串或带 kind 的对象形式 */
export type ControlledInputPolicy =
  | "context_ref"
  | "context_ref_array"
  | "tool_result"
  | { type: "context_ref"; kind: string }
  | { type: "context_ref_array"; kind: string }
  | { type: "tool_result" };

/** 从 ControlledInputPolicy 提取底层策略类型字符串 */
export function controlledInputType(policy: ControlledInputPolicy): string {
  return typeof policy === "string" ? policy : policy.type;
}

/** 从 ControlledInputPolicy 提取 expectedKind（如有） */
export function controlledInputKind(policy: ControlledInputPolicy): string | undefined {
  return typeof policy === "object" && "kind" in policy ? policy.kind : undefined;
}

export interface ToolDefinition {
  id: string;           // 工具唯一标识，如 "imported_docs"
  name: string;         // 展示名，如 "导入文档"
  description: string;  // 一句话描述，供 LLM Router 的 Prompt 使用
  /** 工具目录里展示的一句话用途（可选）。未填时回落 description 第一行。
   *  只用于运行时生成的工具目录，完整参数仍走 tools Schema。 */
  catalogHint?: string;
  /** 可选分类标签，第一期暂不强制使用。 */
  category?: string;
  /** 权限审批与执行记账使用的稳定能力标识；未填时回落到工具 id。 */
  capability?: string;
  /** Runtime 校验受控参数来源；这些值不能由模型自由编造。支持带 kind 的对象形式用于类型化引用验证。 */
  controlledInput?: Record<string, ControlledInputPolicy>;
  enabled: boolean;     // 用户是否启用（对应设置面板的开关）
  // 危险等级：决定该工具在哪些权限档位下可调用；不填默认 "safe"
  risk?: ToolRiskLevel;
  /** 工具暴露的会话模式白名单。未设置 = 全模式通用（向后兼容，行为不变）。
   *  仅 learn/code/work 三种模式参与过滤；chat 模式不暴露任何工具。
   *  注意：modes 是"默认推荐"，可被 ToolModeOverrides 覆盖。 */
  modes?: ConversationMode[];
  /** chat 模式内置人格工具：不依赖 Chat 工具增强总开关、不需要 Chat tab
   *  显式勾选，默认对 chat 会话可见（用户 override.chat === false 仍可关闭）。
   *  语义是"这是昔涟人格的一部分"——朋友圈等生活能力不应要求用户先翻工具开关。 */
  chatBuiltin?: boolean;
  // MCP 兼容字段：参数 schema，后续接 MCP 时直接复用
  inputSchema: {
    type: "object";
    properties: Record<string, JsonSchemaProp>;
    required?: string[];
  };
  /** 工具若声明 needsContext，调度层执行时会传入 ToolContext。默认不声明=不传。 */
  needsContext?: boolean;
  /** Ledger 策略：success_terminal 缓存终态成功（默认），bypass 不缓存。 */
  ledgerPolicy?: "success_terminal" | "bypass";
  /** 标记为已废弃：从新运行的模型可用工具列表中隐藏，但保留注册用于旧会话兼容。 */
  deprecated?: boolean;
  /** 工具效果类型。未配置默认 "unknown"，不静默放行。 */
  effectKind?: ToolEffectKind;
  /** 动态效果解析器（覆盖 effectKind）。用于 run_shell 等根据参数判断效果的工具。 */
  effectResolver?: ToolEffectResolver;
  /**
   * 当前参数是否可与其他明确安全的调用并发。未声明、抛错或非 true 一律串行。
   * 此元数据仅供 Runtime 使用，不进入模型可见 Tool Schema。
   */
  isConcurrencySafe?: ToolConcurrencyClassifier;
  /** 验证策略。mutation 工具必须显式配置；未配置视为 "unknown"。 */
  verificationPolicy?: VerificationPolicy;
  /** 动态验证策略解析器（覆盖 verificationPolicy）。用于 write_file 根据文件扩展名判断。 */
  verificationPolicyResolver?: VerificationPolicyResolver;
  // 执行器：内置工具指向本地函数，外部 MCP 工具指向 transport 调用
  execute: (args: Record<string, unknown>, ctx?: ToolContext) => Promise<string>;
}

/** 工具-模式覆盖层：用户自定义每个工具在每个会话模式下的可见性。
 *  key = toolId，value = { mode: enabled }。
 *  运行时优先级：覆盖层 > ToolDefinition.modes > 全模式可见。
 *  持久化在 general-settings.toolModeOverrides，由 UI 写入。 */
export type ToolModeOverrides = Record<string, Partial<Record<ConversationMode, boolean>>>;

export class ToolRegistry {
  private tools: Map<string, ToolDefinition> = new Map();

  register(tool: ToolDefinition): void {
    this.tools.set(tool.id, tool);
  }

  unregister(id: string): boolean {
    return this.tools.delete(id);
  }

  setEnabled(id: string, enabled: boolean): void {
    const tool = this.tools.get(id);
    if (tool) {
      tool.enabled = enabled;
    }
  }

  getEnabledTools(): ToolDefinition[] {
    return Array.from(this.tools.values()).filter(t => t.enabled && !t.deprecated);
  }

  /** 按会话模式过滤的启用工具列表。
   *  过滤规则（优先级从高到低）：
   *    1. tool.enabled && !deprecated（总开关 + 废弃过滤）
   *    2. 若 overrides[toolId][mode] 存在：用覆盖值（true=可见，false=隐藏）
   *    3. 否则按 modes 字段：!modes || modes.includes(mode)
   *  未声明 modes 且无覆盖的工具默认全模式可见——保持现有行为不变。 */
  getEnabledToolsForMode(mode: ConversationMode, overrides?: ToolModeOverrides): ToolDefinition[] {
    return Array.from(this.tools.values()).filter((t) => {
      if (!t.enabled || t.deprecated) return false;
      const override = overrides?.[t.id]?.[mode];
      if (override !== undefined) return override;
      return !t.modes || t.modes.includes(mode);
    });
  }

  getAllTools(): ToolDefinition[] {
    return Array.from(this.tools.values());
  }

  getById(id: string): ToolDefinition | undefined {
    return this.tools.get(id);
  }
}

// 全局单例
export const toolRegistry = new ToolRegistry();

// ── 效果与验证策略解析 ────────────────────────────────────

/** 解析工具效果类型：优先使用 effectResolver，其次 effectKind，默认 "unknown"。 */
export function resolveEffectKind(
  tool: ToolDefinition | undefined,
  args: Record<string, unknown>,
): ToolEffectKind {
  if (!tool) return "unknown";
  if (tool.effectResolver) return tool.effectResolver(args);
  return tool.effectKind ?? "unknown";
}

/** 解析验证策略：优先使用 verificationPolicyResolver，其次 verificationPolicy，默认 "none"。 */
export function resolveVerificationPolicy(
  tool: ToolDefinition | undefined,
  args: Record<string, unknown>,
): VerificationPolicy {
  if (!tool) return "none";
  if (tool.verificationPolicyResolver) return tool.verificationPolicyResolver(args);
  return tool.verificationPolicy ?? "none";
}

// ── 注册内置工具 ──────────────────────────────────────────

function formatMemoryResult(result: unknown): string {
  if (typeof result === "string") return result;
  if (!result || typeof result !== "object") return "";
  const record = result as { text?: unknown; entry?: { text?: unknown } };
  if (typeof record.entry?.text === "string") return record.entry.text;
  if (typeof record.text === "string") return record.text;
  return "";
}

toolRegistry.register({
  id: 'imported_docs',
  name: '导入文档',
  description:
    '在用户上传导入的文档/小说/文件范围内做语义检索，返回相关片段。\n\n' +
    '何时用：\n' +
    '- 用户提到「文件」「文档」「小说」，或消息包含「已上传文件」标记\n' +
    '- 用户问的内容可能在导入的文档里\n' +
    '- 用户要「在文档里找 xxx」「小说里有没有写到 yyy」\n\n' +
    '不要用于：\n' +
    '- 本机任意路径的文件（那是 read_file）\n' +
    '- 用户的历史对话记忆（那是 user_memory）\n' +
    '- 联网信息（那是 web_search）\n\n' +
    '参数：query (必填，搜索关键词)，topK (可选，返回条数，默认5)。',
  enabled: true,
  effectKind: "read",
  verificationPolicy: "none",
  inputSchema: {
    type: 'object',
    properties: {
      query: { type: 'string', description: '搜索关键词' },
      topK:  { type: 'number', description: '返回条数，默认5' },
    },
    required: ['query'],
  },
  execute: async (args) => {
    const results = await searchMemory(String(args.query), 'imported_doc', Number(args.topK) || 5);
    return results.map((r: unknown) => String(r)).join('\n');
  },
});

toolRegistry.register({
  id: 'user_memory',
  name: '用户记忆',
  description:
    '查询用户的历史记忆、个人信息、过往对话中提到的事实。\n\n' +
    '何时用：\n' +
    '- 用户说「你还记得」「我之前说过」「以前」「上次」等指代词\n' +
    '- 用户问自己的偏好/习惯/背景（「我喜欢什么」「我是做什么的」）\n' +
    '- 需要确认用户曾经提过的具体信息\n\n' +
    '不要用于：\n' +
    '- 当前对话最近几轮能看到的内容\n' +
    '- 导入文档内容（那是 imported_docs）\n' +
    '- 用户从没提过的信息（查不到就老实说不知道）\n\n' +
    '参数：query (必填，搜索关键词)，topK (可选，返回条数，默认5)。',
  enabled: true,
  effectKind: "read",
  verificationPolicy: "none",
  inputSchema: {
    type: 'object',
    properties: {
      query: { type: 'string', description: '搜索关键词' },
      topK:  { type: 'number', description: '返回条数，默认5' },
    },
    required: ['query'],
  },
  execute: async (args) => {
    const results = await searchMemory(String(args.query), 'user_memory', Number(args.topK) || 5);
    return results.map(formatMemoryResult).filter(Boolean).join('\n');
  },
});

// ── 主动记忆读写（直读 memory.json，不走 RAG）──
// user_memory 是语义抽查（像 grep），read_memory 是通读（像 cat）：
// 概览看「我记得哪些事」，按 id 读单条全文；write_memory 由用户主动要求触发。

/** L2 概览最多列出的条数（防止几百条 L2 撑爆上下文，按时间倒序取最新）。 */
const MEMORY_OVERVIEW_LIMIT = 50;

interface L2OverviewItem {
  id: string;
  title: string;
  createdAt: number;
  status: string;
}

/** 纯函数：把 L0/L1/L2 目录格式化为概览文本（可测试）。 */
export function formatMemoryOverview(
  l0: Record<string, unknown>,
  l1: Record<string, unknown>,
  l2Items: L2OverviewItem[],
): string {
  const lines: string[] = [];

  lines.push("== 核心画像（L0）==");
  const l0Fields = ["preferredName", "occupation", "longTermInterests", "language", "permanentNote"];
  const l0Labels: Record<string, string> = {
    preferredName: "称呼", occupation: "职业", longTermInterests: "长期兴趣",
    language: "语言习惯", permanentNote: "固定备注",
  };
  let l0Any = false;
  for (const f of l0Fields) {
    const v = String(l0[f] ?? "").trim();
    if (v) { lines.push(`- ${l0Labels[f]}: ${v}`); l0Any = true; }
  }
  if (!l0Any) lines.push("- （空）");
  if (l0.isPinned === true) lines.push("（画像已被用户锁定，工具写入会被跳过）");

  lines.push("");
  lines.push("== 近期状态（L1）==");
  const l1Fields: Array<[string, string]> = [
    ["recentGoals", "近期目标"], ["recentPreferences", "近期偏好"], ["currentProject", "当前项目"],
  ];
  let l1Any = false;
  for (const [f, label] of l1Fields) {
    const v = String(l1[f] ?? "").trim();
    if (v) { lines.push(`- ${label}: ${v}`); l1Any = true; }
  }
  if (!l1Any) lines.push("- （空）");

  lines.push("");
  const total = l2Items.length;
  lines.push(`== 对话记忆（L2，共 ${total} 条，列出最新 ${Math.min(total, MEMORY_OVERVIEW_LIMIT)} 条）==`);
  if (total === 0) {
    lines.push("- （空）");
  } else {
    const sorted = [...l2Items].sort((a, b) => b.createdAt - a.createdAt).slice(0, MEMORY_OVERVIEW_LIMIT);
    for (const item of sorted) {
      const date = new Date(item.createdAt).toISOString().slice(0, 10);
      lines.push(`- [${item.id}] ${item.title} · ${item.status} · ${date}`);
    }
  }
  lines.push("");
  lines.push("带 id 参数可读取单条 L2 全文。");

  return lines.join('\n');
}

/** 纯函数：构造 write_memory 的 MemoryCandidate（可测试）。 */
export function buildWriteCandidate(args: {
  layer: string;
  content: string;
  field?: string;
  slug?: string;
  sourceQuote?: string;
  triggerText: string;
}): {
  layer: "L0" | "L1" | "L2";
  content: string;
  field?: string;
  slug?: string;
  sourceQuote?: string;
  confidence: number;
  certainty: "explicit";
  attribution: "user_explicit";
  shouldWrite: true;
  triggerText: string;
} | null {
  const layer = args.layer.toUpperCase();
  if (layer !== "L0" && layer !== "L1" && layer !== "L2") return null;
  if (!args.content.trim()) return null;
  return {
    layer,
    content: args.content.trim(),
    field: args.field?.trim() || undefined,
    slug: layer === "L2" ? args.slug?.trim() || undefined : undefined,
    sourceQuote: layer === "L2" ? args.sourceQuote?.trim() || undefined : undefined,
    // 工具只在用户主动要求时被调用，按用户明确事实走（通过 writeMemory 全部既有校验）
    confidence: 1,
    certainty: "explicit",
    attribution: "user_explicit",
    shouldWrite: true,
    triggerText: args.triggerText,
  };
}

toolRegistry.register({
  id: 'read_memory',
  name: '通读记忆',
  description:
    '完整读取自己的三层记忆（核心画像 L0 / 近期状态 L1 / 对话记忆 L2），直接读存储、不走语义检索。\n\n' +
    '何时用：\n' +
    '- 用户说「你到底记得我什么」「看看你的记忆」「你都记了些啥」\n' +
    '- user_memory 检索没命中但用户坚称说过（检索是抽查，这个是通读）\n' +
    '- 需要核对记忆内容是否准确/过时（用户说「你记错了」）\n\n' +
    '不要用于：\n' +
    '- 语义模糊的主题查询（「我喜欢的颜色」→ 用 user_memory 更省 token）\n' +
    '- 导入文档内容（那是 imported_docs）\n\n' +
    '参数：无参 = 概览（L0/L1 全量 + L2 目录最新 50 条）；id (可选，L2 条目 id) = 读该条全文。',
  enabled: true,
  effectKind: "read",
  verificationPolicy: "none",
  inputSchema: {
    type: 'object',
    properties: {
      id: { type: 'string', description: 'L2 条目 id（来自概览列表），传入则读该条全文' },
    },
  },
  execute: async (args) => {
    // 懒加载避开注册期副作用（与 fs-tools 的视觉配置懒加载同模式）
    const { memoryStore } = require("../../../memory/memory-store") as
      typeof import("../../../memory/memory-store");

    const id = String(args.id || "").trim();
    if (id) {
      const all = await memoryStore.getAllL2();
      const hit = all.find((m) => m.id === id);
      if (!hit) return `[错误] 找不到 L2 条目: ${id}（先无参调用拿概览列表）`;
      const lines = [
        `id: ${hit.id}`,
        `标题: ${hit.slug || "（无）"}`,
        `内容: ${hit.content}`,
      ];
      if (hit.sourceQuote) lines.push(`用户原话: ${hit.sourceQuote}`);
      lines.push(
        `状态: ${hit.status}${hit.isPinned ? " · 已置顶" : ""}`,
        `创建: ${new Date(hit.createdAt).toISOString().slice(0, 10)} · 最近使用: ${new Date(hit.lastAccessedAt).toISOString().slice(0, 10)} · 使用 ${hit.accessCount} 次`,
      );
      return lines.join('\n');
    }

    const [l0, l1, l2All] = await Promise.all([
      memoryStore.getL0(),
      memoryStore.getL1(),
      memoryStore.getAllL2(),
    ]);
    const items: L2OverviewItem[] = l2All.map((m) => ({
      id: m.id,
      title: m.slug || (m.content.length > 40 ? m.content.slice(0, 40) + "…" : m.content),
      createdAt: m.createdAt,
      status: m.status,
    }));
    return formatMemoryOverview(l0 as unknown as Record<string, unknown>, l1 as unknown as Record<string, unknown>, items);
  },
});

toolRegistry.register({
  id: 'write_memory',
  name: '更新记忆',
  description:
    '把用户明确要求记住的信息写入记忆（L0 核心画像 / L1 近期状态 / L2 对话记忆）。\n\n' +
    '何时用（仅限用户主动要求）：\n' +
    '- 用户说「记住……」「更新你的记忆」「把这个记下来」「别忘了……」\n' +
    '- 用户纠正旧记忆：「不是 X，是 Y」\n\n' +
    '不要用于：\n' +
    '- 普通对话中自行判断值得记的信息（那是后台反思系统的事，不要主动调用本工具）\n' +
    '- 当前对话里临时记的东西（对话上下文本身就是记忆）\n\n' +
    '参数：layer (必填，L0/L1/L2)，content (必填，要记住的内容)；\n' +
    'field (L0 可选：preferredName/occupation/longTermInterests/language/permanentNote；L1 可选：recentGoals/recentPreferences/currentProject，缺省按内容自动分流)；\n' +
    'slug (L2 可选，≤20 字标题)，sourceQuote (L2 可选，用户原话)。',
  enabled: true,
  effectKind: "mutation",
  verificationPolicy: "none",
  inputSchema: {
    type: 'object',
    properties: {
      layer: { type: 'string', description: '目标层级：L0（核心画像）/ L1（近期状态）/ L2（对话记忆）' },
      content: { type: 'string', description: '要写入的内容' },
      field: { type: 'string', description: 'L0/L1 目标字段（可选，缺省自动判定）' },
      slug: { type: 'string', description: 'L2 标题（可选，≤20 字）' },
      sourceQuote: { type: 'string', description: 'L2 用户原话（可选）' },
    },
    required: ['layer', 'content'],
  },
  execute: async (args, ctx) => {
    const candidate = buildWriteCandidate({
      layer: String(args.layer || ""),
      content: String(args.content || ""),
      field: args.field ? String(args.field) : undefined,
      slug: args.slug ? String(args.slug) : undefined,
      sourceQuote: args.sourceQuote ? String(args.sourceQuote) : undefined,
      triggerText: ctx?.userQuery || String(args.content).slice(0, 50),
    });
    if (!candidate) return "[错误] 参数无效：layer 必须是 L0/L1/L2，content 不能为空";

    // 懒加载走 memoryManager.writeMemory 既有校验链（L0 锁定/字段白名单/L1 分流/L2 写入+RAG 同步）
    const { memoryManager } = require("../../../memory/memory-manager") as
      typeof import("../../../memory/memory-manager");
    const { memoryStore } = require("../../../memory/memory-store") as
      typeof import("../../../memory/memory-store");

    if (candidate.layer === "L0") {
      const l0 = await memoryStore.getL0();
      if (l0.isPinned) return "[跳过] 核心画像已被用户锁定（记忆面板里可解锁），本次未写入";
    }

    await memoryManager.writeMemory([candidate]);
    return `已写入 ${candidate.layer}${candidate.field ? `（字段 ${candidate.field}）` : ""}: ${candidate.content.slice(0, 60)}${candidate.content.length > 60 ? "…" : ""}`;
  },
});

