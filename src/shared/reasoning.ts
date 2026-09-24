// 厂商无关的推理控制层 —— resolver + normalize（类型与规则表已迁至 vendor-registry）
//
// 适用范围：仅推理模式 auto/off/on + 真实存在的 effort 档位。
// 不涉及温度 / Top-P / max_tokens / verbosity / thinking_budget / Responses API。
//
// 调用方：
//   - renderer/settings.ts：UI 显示与状态文案（调 resolveEffectiveReasoning）
//   - main/orchestrator/vendors/*-adapter.ts：buildRequest 内转换请求体
//     （调 resolveReasoningCapability + applyReasoningPreference）
//   - main/orchestrator/vendors/reasoning.ts：纯函数 applyReasoningPreference
//
// 规则表维护入口：src/shared/vendor-registry/entries/（一厂商一文件）。
// 本文件 re-export 类型与 MODEL_REASONING_RULES，既有 import 路径不变。
//
// 规则优先级：第一条匹配的 capability 生效（find() + first-match-wins）。
// 排序原则：具体型号在前，宽泛系列在后（Qwen /-thinking$/ 必须在 /^qwen3/ 之前；
// Kimi K2.5/K2.6/K2.7-Code/K2.7-Code-HighSpeed 必须用精确正则，且 K2.7 系列
// 必须在通用 kimi-k2-thinking 系列之前）——顺序只在各厂商自己的 entry 文件内维护。

export type {
  ReasoningMode,
  ReasoningEffort,
  ReasoningControl,
  ReasoningRequestStyle,
  ReasoningCapability,
  ReasoningPreference,
  ModelReasoningRule,
} from "./vendor-registry/types";

import type {
  ReasoningCapability,
  ReasoningEffort,
  ReasoningMode,
  ReasoningPreference,
} from "./vendor-registry/types";
import { MODEL_REASONING_RULES } from "./vendor-registry";
import { UNKNOWN_REASONING_CAPABILITY } from "./vendor-registry/fallback";

export { MODEL_REASONING_RULES } from "./vendor-registry";
export { UNKNOWN_REASONING_CAPABILITY } from "./vendor-registry/fallback";

/**
 * 按 (providerId, model) 解析推理 capability。
 * 未命中任何规则时返回兜底 { control: "none", requestStyle: "none", supportsDisable: false }。
 *
 * 模型名推断兜底：厂商家族与模型家族不一致时（自定义端点 / 托管场景，如方舟
 * coding plan 上跑 glm-5.3-flash，档案厂商登记为「豆包（火山方舟）」），第一轮
 * 同厂商匹配只能命中表尾通配兜底。此时按模型名跨家族找回真正的推理规则，
 * 使推理控制在托管端点上同样可用。各家族表尾的通配兜底规则均引用同一个
 * UNKNOWN_REASONING_CAPABILITY 常量（vendor-registry/fallback.ts 全局单例），
 * 用恒等判断跳过即可，不会误匹配。
 */
export function resolveReasoningCapability(
  providerId: string,
  model: string,
): ReasoningCapability {
  // 第一轮：同厂商精确规则（表尾通配兜底不算命中，留给第二轮）
  for (const rule of MODEL_REASONING_RULES) {
    if (rule.providerId === providerId && rule.modelPattern.test(model)
        && rule.capability !== UNKNOWN_REASONING_CAPABILITY) {
      return rule.capability;
    }
  }
  // 第二轮：模型名跨家族推断（第一轮未出真实规则时兜底）
  for (const rule of MODEL_REASONING_RULES) {
    if (rule.modelPattern.test(model) && rule.capability !== UNKNOWN_REASONING_CAPABILITY) {
      return rule.capability;
    }
  }
  return UNKNOWN_REASONING_CAPABILITY;
}

/**
 * 把用户 preference 解析为 effective preference。
 *
 * 决策顺序（用户第三轮修订 #3）：
 * 1. control = none / dynamic → 强制 auto
 * 2. control = fixed-on → 永远返 { mode: "on" }，不读 pref.mode、不读 pref.effort
 * 3. control ∈ {toggle, effort, toggle-effort}：
 *    - mode !== "on" → 直接返 { mode }，不保留 effort
 *    - mode === "on"：effort 不在 supportedEfforts → 退回 defaultEffort；
 *      effort 缺省时填 defaultEffort；defaultEffort 也不在列 → 丢弃 effort
 *
 * 注意：saved 永远不动（用户修订 #5），effective 仅用于运行时请求与 UI 当前显示。
 */
export function resolveEffectiveReasoning(
  preference: ReasoningPreference | undefined,
  capability: ReasoningCapability,
  thinkingOverride?: -1 | 0 | 1,
): ReasoningPreference {
  const pref = preference ?? { mode: "auto" };

  // 1. 不支持 / 动态路由 → 强制 auto
  if (thinkingOverride === -1 || (thinkingOverride !== 1 && (capability.control === "none" || capability.control === "dynamic"))) {
    return { mode: "auto" };
  }

  // 2. fixed-on：effective 永远 on
  if (capability.control === "fixed-on") {
    return { mode: "on" };
  }

  // 3. toggle / effort / toggle-effort
  const { mode } = pref;

  // mode !== "on" → 不保留 effort（第三轮修订 #3）
  if (mode !== "on") {
    return { mode };
  }

  let { effort } = pref;

  // effort 不在 supportedEfforts → 退回 defaultEffort
  if (effort !== undefined && capability.supportedEfforts && !capability.supportedEfforts.includes(effort)) {
    effort = capability.defaultEffort;
  }

  // effort 缺省时填 defaultEffort
  if (effort === undefined && capability.defaultEffort) {
    effort = capability.defaultEffort;
  }

  // proMode 仅在 capability 声明支持且显式为 true 时保留
  const proMode = capability.supportsProMode === true && pref.proMode === true;

  return { mode, ...(effort !== undefined ? { effort } : {}), ...(proMode ? { proMode: true } : {}) };
}

// ── normalize 白名单（用户修订 #4：白名单，不 trim）──

const MODE_SET: ReadonlySet<ReasoningMode> = new Set(["auto", "off", "on"]);
const EFFORT_SET: ReadonlySet<ReasoningEffort> = new Set([
  "minimal", "low", "medium", "high", "xhigh", "max",
]);

/**
 * 把任意 input 归一化为合法 { mode, effort?, proMode? }。
 * - 完全非法对象 → undefined
 * - mode 非法 → undefined
 * - mode 合法但 effort 非法 → 返 { mode }，effort 字段丢弃
 * - mode 合法但 proMode 非布尔 → 返 { mode, ... }，proMode 字段丢弃
 * - 完全合法 → 原样
 */
export function normalizeReasoningPreference(
  input: unknown,
): ReasoningPreference | undefined {
  if (!input || typeof input !== "object") return undefined;
  const obj = input as { mode?: unknown; effort?: unknown; proMode?: unknown };
  if (typeof obj.mode !== "string" || !MODE_SET.has(obj.mode as ReasoningMode)) {
    return undefined;
  }
  const mode = obj.mode as ReasoningMode;
  let effort: ReasoningEffort | undefined;
  if (obj.effort !== undefined && obj.effort !== null) {
    if (typeof obj.effort !== "string" || !EFFORT_SET.has(obj.effort as ReasoningEffort)) {
      effort = undefined;
    } else {
      effort = obj.effort as ReasoningEffort;
    }
  }
  const proMode = obj.proMode === true ? true : undefined;
  return {
    mode,
    ...(effort !== undefined ? { effort } : {}),
    ...(proMode !== undefined ? { proMode } : {}),
  };
}

/**
 * 持久化折叠（用户第三轮修订 #4）：
 *
 * 语义：
 * - hasIncomingKey=false（字段缺失）→ 保留旧值（不覆盖）
 * - hasIncomingKey=true 且 incomingRaw 为 undefined / null → 视作"用户主动清空" → 返 undefined
 * - hasIncomingKey=true 且 incomingRaw 为非法对象 → normalize 后 undefined → 保留旧值（防覆盖）
 * - hasIncomingKey=true 且合法对象 → 用新值
 *
 * 调用方负责传入正确的 hasIncomingKey（区分 "settings 里没这个字段" vs "settings 里显式 undefined"）。
 * hasOwnProperty 是判断字段缺失的标准方式。
 */
export function foldReasoning(
  incomingRaw: unknown,
  existing: ReasoningPreference | undefined,
  hasIncomingKey: boolean,
): ReasoningPreference | undefined {
  if (!hasIncomingKey) return existing;
  if (incomingRaw === undefined || incomingRaw === null) return undefined;
  const normalized = normalizeReasoningPreference(incomingRaw);
  if (normalized === undefined) return existing;
  return normalized;
}
