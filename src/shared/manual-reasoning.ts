import { resolveEffectiveReasoning, resolveReasoningCapability } from "./reasoning";
import type { ReasoningCapability, ReasoningEffort, ReasoningPreference, ReasoningRequestStyle } from "./vendor-registry/types";

export type ManualReasoningStyle = Exclude<ReasoningRequestStyle, "none"> | "custom";

export interface ManualReasoningConfig {
  style: ManualReasoningStyle;
  supportedEfforts: ReasoningEffort[];
  defaultEffort?: ReasoningEffort;
  supportsDisable: boolean;
  customBodies?: Partial<Record<ReasoningEffort | "on" | "off", Record<string, unknown>>>;
}

const EFFORT_ORDER: readonly ReasoningEffort[] = ["minimal", "low", "medium", "high", "xhigh", "max"];
const STYLE_SET = new Set<ManualReasoningStyle>([
  "openai-effort", "thinking-type", "anthropic-adaptive", "qwen-enable-thinking", "custom",
]);
const RESERVED_BODY_KEYS = new Set([
  "model", "messages", "input", "system", "tools", "tool_choice", "stream",
  "max_tokens", "max_output_tokens", "temperature", "top_p", "response_format", "text",
]);
const UNSAFE_KEYS = new Set(["__proto__", "prototype", "constructor"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function isSafeJson(value: unknown, depth = 0, ancestors = new Set<object>()): boolean {
  if (depth > 8) return false;
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (typeof value !== "object") return false;
  if (ancestors.has(value)) return false;
  ancestors.add(value);
  const valid = Array.isArray(value)
    ? value.every((item) => isSafeJson(item, depth + 1, ancestors))
    : isRecord(value) && Object.entries(value).every(([key, item]) =>
      !UNSAFE_KEYS.has(key) && isSafeJson(item, depth + 1, ancestors));
  ancestors.delete(value);
  return valid;
}

export function normalizeManualReasoningConfig(input: unknown): ManualReasoningConfig | undefined {
  if (!isRecord(input) || !STYLE_SET.has(input.style as ManualReasoningStyle)) return undefined;
  if (!Array.isArray(input.supportedEfforts) || typeof input.supportsDisable !== "boolean") return undefined;
  const supportedEfforts = [...new Set(input.supportedEfforts)];
  if (supportedEfforts.some((effort) => !EFFORT_ORDER.includes(effort as ReasoningEffort))) return undefined;
  supportedEfforts.sort((a, b) => EFFORT_ORDER.indexOf(a as ReasoningEffort) - EFFORT_ORDER.indexOf(b as ReasoningEffort));
  const style = input.style as ManualReasoningStyle;
  if (style === "openai-effort" && supportedEfforts.length === 0) return undefined;
  if (style === "qwen-enable-thinking" && supportedEfforts.length > 0) return undefined;
  const defaultEffort = supportedEfforts.length > 0 ? input.defaultEffort : undefined;
  if (supportedEfforts.length > 0 && !supportedEfforts.includes(defaultEffort)) return undefined;
  const normalized: ManualReasoningConfig = {
    style,
    supportedEfforts: supportedEfforts as ReasoningEffort[],
    ...(defaultEffort ? { defaultEffort: defaultEffort as ReasoningEffort } : {}),
    supportsDisable: input.supportsDisable,
  };
  if (style !== "custom") return normalized;
  if (!isRecord(input.customBodies)) return undefined;
  const required = supportedEfforts.length > 0 ? [...supportedEfforts] : ["on"];
  if (input.supportsDisable) required.push("off");
  const customBodies: NonNullable<ManualReasoningConfig["customBodies"]> = {};
  for (const level of required) {
    const body = input.customBodies[level];
    if (!isRecord(body) || Object.keys(body).some((key) => RESERVED_BODY_KEYS.has(key)) || !isSafeJson(body)) return undefined;
    const encoded = JSON.stringify(body);
    if (encoded.length > 8192) return undefined;
    customBodies[level as ReasoningEffort | "on" | "off"] = JSON.parse(encoded) as Record<string, unknown>;
  }
  return { ...normalized, customBodies };
}

function capabilityForManual(config: ManualReasoningConfig): ReasoningCapability {
  return {
    control: config.supportedEfforts.length > 0
      ? "toggle-effort"
      : config.supportsDisable ? "toggle" : "fixed-on",
    ...(config.supportedEfforts.length > 0 ? { supportedEfforts: config.supportedEfforts } : {}),
    ...(config.defaultEffort ? { defaultEffort: config.defaultEffort } : {}),
    requestStyle: config.style === "custom" ? "none" : config.style,
    supportsDisable: config.supportsDisable,
    defaultMode: "on",
  };
}

export function resolveConfiguredReasoningCapability(
  providerId: string,
  model: string,
  manual: ManualReasoningConfig | undefined,
): ReasoningCapability {
  const config = normalizeManualReasoningConfig(manual);
  return config ? capabilityForManual(config) : resolveReasoningCapability(providerId, model);
}

export function applyManualReasoningBody(
  body: Record<string, unknown>,
  manual: ManualReasoningConfig | undefined,
  preference: ReasoningPreference,
): Record<string, unknown> {
  const config = normalizeManualReasoningConfig(manual);
  if (!config || config.style !== "custom") return { ...body };
  const effective = resolveEffectiveReasoning(preference, capabilityForManual(config), 0);
  const level = effective.mode === "off" ? "off" : effective.effort ?? "on";
  return { ...body, ...config.customBodies?.[level] };
}
