// 厂商注册表的类型层 —— 推理系纯类型（自 shared/reasoning.ts 迁入）
// + 厂商能力系类型（自 main/orchestrator/vendors/types.ts 迁入）+ entry 接口。
//
// 本文件是注册表依赖图的叶子：不 import 任何运行时模块。
// shared/reasoning.ts 与 main/orchestrator/vendors/types.ts 对外仍
// re-export 这些类型，既有 import 路径全部不变；类型的事实源在此。
//
// 规则里的 providerId 必须与 entry.capability.id 完全一致：
// chatgpt / claude / deepseek / glm / kimi / qwen / minimax / mimo / doubao。

export type ReasoningMode = "auto" | "off" | "on";

export type ReasoningEffort =
  | "minimal"
  | "low"
  | "medium"
  | "high"
  | "xhigh"
  | "max";

export type ReasoningControl =
  | "none"
  | "toggle"
  | "effort"
  | "toggle-effort"
  | "fixed-on"
  | "dynamic";

export type ReasoningRequestStyle =
  | "openai-effort"
  | "thinking-type"
  | "anthropic-adaptive"
  | "qwen-enable-thinking"
  | "none";

export interface ReasoningCapability {
  control: ReasoningControl;
  supportedEfforts?: readonly ReasoningEffort[];
  defaultEffort?: ReasoningEffort;
  requestStyle: ReasoningRequestStyle;
  /**
   * 该 capability 是否支持显式关闭（off）。
   * OpenAI 各型号按具体规则声明（gpt-5.6 = true，o1 = true，gpt-4o 兜底 = false）。
   * supportsDisable=false 时 UI 不显示"关闭"按钮，请求也不发 reasoning_effort:"none"。
   */
  supportsDisable: boolean;
  /**
   * 仅 thinking-type 适用：是否在 on + hasTools 时附加 thinking.keep="all"。
   * Kimi K2.6 = true；K2.5 = false。
   */
  keepOnTools?: boolean;
  /**
   * 是否支持 Responses API 的 reasoning.mode:"pro"（GPT-5.6 系列，2026-07 GA）。
   * pro 与 effort 正交；仅 Responses 协议生效 —— Chat Completions 无该字段，
   * openai 路径静默忽略 proMode。
   */
  supportsProMode?: boolean;
  /**
   * auto 档显式映射的 effort。不设置时 auto = 不发字段（交给服务端默认）。
   * 用于服务端默认档不可控/过重的模型：GLM-5.3 服务端默认 effort=max，
   * auto 不发字段 ≡ max，多步任务思考会吃穿输出预算。
   * 设置后 auto 在 wire 层按 { mode: "on", effort: autoEffort } 发送。
   */
  autoEffort?: ReasoningEffort;
}

export interface ReasoningPreference {
  mode: ReasoningMode;
  effort?: ReasoningEffort;
  /** Responses 专属 pro 模式（reasoning.mode="pro"）。仅 mode="on" 且 capability.supportsProMode 时生效 */
  proMode?: boolean;
}

export interface ModelReasoningRule {
  providerId: string;
  modelPattern: RegExp;
  capability: ReasoningCapability;
}

// ── 厂商能力系类型（自 main/orchestrator/vendors/types.ts 原样迁入）──

export type Transport = "openai" | "anthropic" | "responses";
export type AuthStyle = "bearer" | "x-api-key";
export type ThinkingField = "reasoning_content" | "thinking" | "reasoning_details" | null;
export type CacheStrategy = "prompt_cache_key" | "cache_control" | "auto" | "none";
export type TestStrategy = "text" | "text+tool";

/**
 * 厂商能力表的一条记录。是 vendor adapter 的"事实来源"，
 * 避免调度层散落 if (provider === "kimi")。
 */
export interface ProviderCapability {
  id: string;
  displayName: string;
  transport: Transport;
  baseUrl: string;
  authStyle: AuthStyle;
  /** Anthropic-compatible endpoints sometimes require a different auth header. */
  anthropicAuthStyle?: AuthStyle;
  defaultModel: string;
  supportsTools: boolean;
  supportsThinking: boolean;
  thinkingField: ThinkingField;
  cacheStrategy: CacheStrategy;
  testStrategy: TestStrategy;
  /** 是否支持视觉（图片）输入。非多模态模型禁止走 read_image。 */
  supportsVision: boolean;
  /** Supported must-call wire policies; Adapter maps required to OpenAI required / Anthropic any. */
  toolChoiceModes?: ReadonlyArray<"named" | "required" | "auto" | "omit">;
  /**
   * 该厂商支持的协议清单（来自 docs/vendors 协议矩阵）。
   * 仅用于新建档案时预填默认值 + UI 提示文案，**不拦截**用户在下拉框的选择——
   * 用户填什么协议就走什么协议（自定义端点/中转站自行负责兼容性）。
   * 不标 = 未核实，UI 按"仅 capability.transport"提示。
   */
  supportedTransports?: readonly Transport[];
  /**
   * Responses transport：端点是否按 OpenAI 官方语义支持
   * `include: ["reasoning.encrypted_content"]`（store:false 下多轮回放加密 reasoning）。
   * capability 标记只是必要条件；运行时还需 baseUrl 为 OpenAI 官方域名（api.openai.com）
   * 才真正下发 include——中转站/第三方兼容端不发，避免报参数错误。
   */
  responsesEncryptedReasoning?: boolean;
  /**
   * 视觉模型的 OpenAI 兼容 baseUrl。仅当主聊天走 Anthropic 入口、视觉需走 OpenAI 入口时才需要标
   * （如 MiniMax 主配 /anthropic，视觉要走 /v1）。不标 = 视觉用主配置 baseUrl。
   */
  visionBaseUrl?: string;
  /** UI 是否允许选择（Claude 等 Anthropic adapter 未就绪前先禁用）。 */
  disabled?: boolean;
}

/**
 * 厂商 tool_choice 怪癖：只描述"厂商事实"（布尔/枚举开关），
 * 决策算法留在 tool-choice-policy 代码。preferred 仍走 choose() 的
 * supportedModes 降级链，不是硬结果；不再为它发明条件语言
 * （未来出现 unless/exceptWhen 需求时回 policy 写 if，不给 quirk 加字段）。
 */
export interface ToolChoiceQuirk {
  /**
   * must-call 意图的首选档位及其生效条件：
   * - when "always"：无论思考与否（如 MiniMax 文档仅支持 auto/none）
   * - when "thinking-only"：仅思考开启时（如 DeepSeek 思考拒绝一切 tool_choice）
   * 条件不满足时落到 policy 的协议级/通用分支。
   */
  mustCall: {
    preferred: "named" | "required" | "auto" | "omit";
    when: "always" | "thinking-only";
  };
  /** 思考开启时普通 FC 轮（无 must-call 意图）也省略 tool_choice（DeepSeek）。 */
  omitAutoTurnWhenThinking?: boolean;
}

/**
 * 厂商注册表条目：一厂商一 entry，聚合该厂商的全部运行时语义
 * 与短名展示字段。capability 是必填的关联锚点，entry.capability.id
 * 即该厂商的静态关联键（presets / 一致性测试都按它对齐）。
 * toolChoiceQuirk 只声明有怪癖的厂商；不写 = 走通用规则。
 */
export interface VendorRegistryEntry {
  capability: ProviderCapability;
  /** 推理规则：厂商内 first-match-wins，具体型号在前，表尾通配兜底引用共享单例 */
  reasoningRules: readonly ModelReasoningRule[];
  /** 厂商短名（去括号后缀），状态栏"正在喂养"与昵称默认值兜底；与 presets.shortName 一致 */
  shortName: string;
  /** tool_choice 厂商怪癖（可选；无怪癖厂商不写，走 policy 通用规则） */
  toolChoiceQuirk?: ToolChoiceQuirk;
}

/**
 * entry 的唯一书写入口：结构完整性交给接口约束，字面量信息交给 const 泛型。
 * 注意显式类型标注（const x: VendorRegistryEntry = {...}）会把 capability.id
 * 等字面量擦成 string，导致后续 BuiltinProviderId 推导退化 —— entry 一律走本函数，
 * 不裸写对象、不写标注。
 */
export function defineVendor<const T extends VendorRegistryEntry>(entry: T): T {
  return entry;
}
