import map from "./model-error-map.json";
import type { ModelErrorCategory, ModelFailureInfo } from "../../../shared/model-error";

type Entry = { category: ModelErrorCategory; retryable?: boolean | "conditional" };
type ProviderMap = {
  http?: Record<string, Entry>;
  business_codes?: Record<string, Entry>;
  codes?: Record<string, Entry>;
  types?: Record<string, Entry>;
  structured_codes?: Record<string, ModelErrorCategory>;
  http_fallback?: Record<string, ModelErrorCategory>;
  message_overrides?: Array<{ code?: string; contains: string[]; category: ModelErrorCategory; retryable?: boolean | "conditional" }>;
  docsUrl?: string;
};

const providers = (map as { providers: Record<string, ProviderMap> }).providers;
const providerAliases: Record<string, string> = { openai: "chatgpt", anthropic: "claude", doubao_seed: "doubao", xai_grok: "grok" };

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}
function safeString(value: unknown): string | undefined {
  if (typeof value !== "string" && typeof value !== "number") return undefined;
  const result = String(value).trim();
  return result && result.length <= 160 && !/[\r\n]/.test(result) ? result : undefined;
}

/** SDK 会包装 fetch 错误；只提取稳定的网络错误标识，不读取底层异常原文。 */
function networkFailure(error: unknown): { category: "NETWORK" | "TIMEOUT"; code?: string } | undefined {
  const seen = new Set<unknown>();
  let current = record(error);
  for (let depth = 0; current && depth < 8 && !seen.has(current); depth++) {
    seen.add(current);
    const name = safeString(current.name)?.toLowerCase();
    const code = safeString(current.code);
    if (name?.includes("timeout") || code === "ETIMEDOUT") return { category: "TIMEOUT", code };
    if (name?.includes("connection") || ["ECONNRESET", "ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN"].includes(code ?? "")) {
      return { category: "NETWORK", code };
    }
    current = record(current.cause);
  }
  return undefined;
}

export function classifyModelFailure(input: {
  provider: string; model: string; status?: number; error?: unknown;
}): ModelFailureInfo {
  const provider = providerAliases[input.provider.toLowerCase()] ?? input.provider.toLowerCase();
  const table = providers[provider];
  const root = record(input.error);
  const protocolDetails = record(root?.providerDetails);
  const network = networkFailure(input.error);
  const response = record(root?.response);
  const responseData = record(response?.data);
  let sdkBody: Record<string, unknown> | undefined;
  if (typeof root?.responseBody === "string") {
    try { sdkBody = record(JSON.parse(root.responseBody)); } catch { /* 非 JSON 错误体没有可提取的字段 */ }
  }
  const bodyError = record(root?.error) ?? record(responseData?.error) ?? record(sdkBody?.error);
  const status = input.status ?? (typeof root?.status === "number" ? root.status : undefined)
    ?? (typeof protocolDetails?.status === "number" ? protocolDetails.status : undefined)
    ?? (typeof root?.statusCode === "number" ? root.statusCode : undefined);
  const vendorCode = safeString(bodyError?.code ?? protocolDetails?.vendorCode ?? root?.vendorCode ?? root?.code ?? root?.error_code ?? root?.errorCode) ?? network?.code;
  const vendorType = safeString(bodyError?.type ?? bodyError?.status ?? protocolDetails?.vendorType ?? root?.vendorType ?? root?.type ?? root?.error_type);
  const sdkHeaders = record(root?.responseHeaders);
  const requestId = safeString(root?.request_id ?? root?.requestId ?? root?.["x-request-id"] ?? protocolDetails?.requestId ?? root?.id
    ?? sdkHeaders?.["x-request-id"] ?? sdkHeaders?.["request-id"]);
  let entry: Entry | undefined = vendorCode
    ? table?.business_codes?.[vendorCode] ?? table?.codes?.[vendorCode]
    : undefined;
  const providerMessage = safeString(bodyError?.message ?? root?.message)?.toLowerCase();
  const messageOverride = table?.message_overrides?.find((override) =>
    (!override.code || override.code === vendorCode)
    && providerMessage
    && override.contains.some((needle) => providerMessage.includes(needle.toLowerCase())));
  if (messageOverride) entry = { category: messageOverride.category, retryable: messageOverride.retryable };
  if (!entry && vendorCode && table?.structured_codes?.[vendorCode]) {
    entry = { category: table.structured_codes[vendorCode] };
  }
  if (!entry && vendorType) entry = table?.types?.[vendorType];
  if (!entry && status) entry = table?.http?.[String(status)];
  if (!entry && status) {
    const category = table?.http_fallback?.[String(status)];
    if (category) entry = { category, retryable: status === 429 || status >= 500 };
  }
  // Message heuristics are intentionally disabled: provider text is not a stable code surface.
  const category = entry?.category
    ?? (status === 408 || status === 504 ? "TIMEOUT" : network?.category ?? networkFailure({ code: vendorCode })?.category ?? "UNKNOWN");
  return {
    provider, model: input.model, category,
    ...(Number.isInteger(status) ? { status } : {}),
    ...(vendorCode ? { vendorCode } : {}), ...(vendorType ? { vendorType } : {}),
    ...(requestId ? { requestId } : {}), ...(table?.docsUrl ? { docsUrl: table.docsUrl } : {}),
    ...(entry?.retryable !== undefined ? { retryable: entry.retryable } : {}),
  };
}
