import { resolveEffectiveReasoning, resolveReasoningCapability, type ReasoningPreference } from "../../../shared/reasoning";
import { getVendorRuntimeSettings } from "./runtime-settings";
import { VENDOR_REGISTRY } from "../../../shared/vendor-registry";
import type { ToolChoiceQuirk, VendorRegistryEntry } from "../../../shared/vendor-registry/types";
import type { Transport } from "./types";

export type ToolChoicePolicy =
  | { kind: "named"; name: string }
  | { kind: "required" }
  | { kind: "auto" }
  | { kind: "omit" };

export interface ToolChoicePolicyInput {
  providerId: string;
  model: string;
  transport: Transport;
  reasoning: ReasoningPreference;
  requestedToolName: string;
  supportedModes?: ReadonlyArray<ToolChoicePolicy["kind"]>;
}

export type AutomaticToolChoicePolicyInput = Omit<ToolChoicePolicyInput, "requestedToolName">;

// 厂商 tool_choice 怪癖查表：数据事实源在注册表 entries/ 各厂商文件，
// 此处只按 capability.id 查找；无怪癖的厂商不进 Map，走下方通用规则。
// VENDOR_REGISTRY 的 satisfies 保留各 entry 字面量的精确形状——没写 quirk 的
// 厂商连可选属性都不在类型上；此处按接口放宽后再访问可选字段
// （BuiltinProviderId 的字面量推导不受影响，只在本循环放宽）。
const quirkById = new Map<string, ToolChoiceQuirk>();
for (const entry of VENDOR_REGISTRY as readonly VendorRegistryEntry[]) {
  if (entry.toolChoiceQuirk) {
    quirkById.set(entry.capability.id, entry.toolChoiceQuirk);
  }
}

function isThinkingEnabled(input: AutomaticToolChoicePolicyInput): boolean {
  // reasoning=auto 时不排除 thinking -- 服务端可能默认开启
  // 只有明确 mode="off" 才认为 thinking 关闭
  const resolved = resolveEffectiveReasoning(
    input.reasoning,
    resolveReasoningCapability(input.providerId, input.model),
    getVendorRuntimeSettings().thinkingOverride,
  );
  return resolved.mode === "on" || resolved.mode === "auto";
}

/** Map an ordinary optional Function Calling turn to auto, unless the active mode rejects tool_choice. */
export function resolveAutomaticToolChoicePolicy(input: AutomaticToolChoicePolicyInput): "auto" | "omit" {
  if (quirkById.get(input.providerId)?.omitAutoTurnWhenThinking && isThinkingEnabled(input)) return "omit";
  if (input.supportedModes && !input.supportedModes.includes("auto")) return "omit";
  return "auto";
}

/** Resolve a must-call intent into the strongest wire policy supported by the active model mode. */
export function resolveToolChoicePolicy(input: ToolChoicePolicyInput): ToolChoicePolicy {
  const thinkingEnabled = isThinkingEnabled(input);
  const supported = input.supportedModes;
  const result = (kind: ToolChoicePolicy["kind"]): ToolChoicePolicy => (
    kind === "named" ? { kind, name: input.requestedToolName } : { kind }
  );
  const choose = (preferred: ToolChoicePolicy["kind"]): ToolChoicePolicy => {
    if (!supported?.length || supported.includes(preferred)) return result(preferred);
    for (const fallback of ["named", "required", "auto", "omit"] as const) {
      if (supported.includes(fallback)) return result(fallback);
    }
    return { kind: "omit" };
  };

  // 厂商怪癖：must-call 首选档位按注册表声明；when 条件不满足时
  // 落到下方协议级/通用分支（preferred 仍走 choose 的 supportedModes 降级链）。
  const quirk = quirkById.get(input.providerId);
  if (quirk && (quirk.mustCall.when === "always" || thinkingEnabled)) {
    return choose(quirk.mustCall.preferred);
  }
  // anySearch 是网页搜索后端标识（search-backend-filter.ts 的 SearchBackend），
  // 非聊天厂商、无注册表 entry，must-call 固定首选 auto。
  if (input.providerId === "anySearch") return choose("auto");
  // Anthropic extended thinking supports auto/none, not any/tool.
  if (input.transport === "anthropic" && thinkingEnabled) return choose("auto");
  // thinking 可能开启时，所有 vendor 默认降级到 auto
  // （Native FC 只暴露一个工具，auto 不会选错，但 named + thinking 会被很多 vendor 拒绝）
  if (thinkingEnabled) return choose("auto");
  return choose("named");
}
