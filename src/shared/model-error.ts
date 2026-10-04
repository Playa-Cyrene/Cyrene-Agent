export type ModelErrorCategory =
  | "AUTH" | "PERMISSION" | "BILLING" | "QUOTA" | "RATE_LIMIT" | "INVALID_REQUEST"
  | "NOT_FOUND" | "CONTEXT_LIMIT" | "PAYLOAD_TOO_LARGE" | "CONTENT_POLICY" | "CONFLICT"
  | "TIMEOUT" | "NETWORK" | "OVERLOADED" | "SERVER_ERROR" | "UNAVAILABLE" | "CANCELLED" | "UNKNOWN";

export interface ModelFailureInfo {
  provider: string;
  model: string;
  category: ModelErrorCategory;
  status?: number;
  vendorCode?: string;
  vendorType?: string;
  requestId?: string;
  /** Bounded, credential-redacted vendor message for the error details dialog. */
  providerMessage?: string;
  docsUrl?: string;
  retryable?: boolean | "conditional";
}

export function isModelFailureInfo(value: unknown): value is ModelFailureInfo {
  if (typeof value !== "object" || value === null) return false;
  const info = value as Record<string, unknown>;
  return typeof info.provider === "string" && typeof info.model === "string"
    && typeof info.category === "string" && ["AUTH", "PERMISSION", "BILLING", "QUOTA", "RATE_LIMIT", "INVALID_REQUEST", "NOT_FOUND", "CONTEXT_LIMIT", "PAYLOAD_TOO_LARGE", "CONTENT_POLICY", "CONFLICT", "TIMEOUT", "NETWORK", "OVERLOADED", "SERVER_ERROR", "UNAVAILABLE", "CANCELLED", "UNKNOWN"].includes(info.category)
    && (info.status === undefined || (typeof info.status === "number" && Number.isInteger(info.status)))
    && ["vendorCode", "vendorType", "requestId", "docsUrl", "providerMessage"].every((key) => info[key] === undefined || typeof info[key] === "string");
}

export function sanitizeModelErrorMessage(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  // Never display HTML challenges or a dumped request/response with credential headers.
  if (/<(?:!doctype|html|script|body)\b/i.test(value)) return undefined;
  const message = value.slice(0, 4096)
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [redacted]")
    .replace(/\bsk-[A-Za-z0-9_-]+/g, "[redacted-key]")
    .replace(/((?:access[_-]?token|refresh[_-]?token|id[_-]?token|api[_-]?key|client[_-]?secret|authorization|cookie|set-cookie|account[_-]?id|user[_-]?id)\b\s*["']?\s*[:=]\s*["']?)[^\r\n"',;}\]]+/gi, "$1[redacted]")
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "[redacted-email]")
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .trim().slice(0, 1000);
  return message || undefined;
}
