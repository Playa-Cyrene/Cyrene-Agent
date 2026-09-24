// 厂商注册表的类型层 —— 推理系纯类型（自 shared/reasoning.ts 迁入）+ entry 接口。
//
// 本文件是注册表依赖图的叶子：不 import 任何运行时模块。
// reasoning.ts 对外仍 re-export 这些类型，既有 import 路径全部不变；
// 但类型的事实源在此，shared/reasoning.ts 只剩 resolver 与 normalize 逻辑。
//
// providerId 必须与 main/orchestrator/vendors/capabilities.ts 的 ProviderCapability.id
// 完全一致：chatgpt / claude / deepseek / glm / kimi / qwen / minimax / mimo / doubao / unknown。

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

/**
 * 厂商注册表条目（迁移期形态：先承载推理规则；厂商能力 capability 与
 * shortName 等字段随迁移阶段逐步加入，最终形态见 VendorRegistryEntry 的完整定义）。
 *
 * id 与 capability.id 同值；分开放顶层是为了在 capability 尚未迁入时
 * 一致性测试就能按 id 校验规则归属。
 */
export interface VendorReasoningEntry {
  id: string;
  /** 推理规则：厂商内 first-match-wins，具体型号在前，表尾通配兜底引用共享单例 */
  reasoningRules: readonly ModelReasoningRule[];
}

/**
 * entry 的唯一书写入口：结构完整性交给接口约束，字面量信息交给 const 泛型。
 * 注意显式类型标注（const x: VendorReasoningEntry = {...}）会把 id 等字面量
 * 擦成 string，导致后续 BuiltinProviderId 推导退化 —— entry 一律走本函数，
 * 不裸写对象、不写标注。
 */
export function defineVendor<const T extends VendorReasoningEntry>(entry: T): T {
  return entry;
}
