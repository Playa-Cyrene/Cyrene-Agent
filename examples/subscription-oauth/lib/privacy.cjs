"use strict";

/**
 * 日志与诊断文件的隐私防线。
 *
 * 账号标签、平台 accountId 与 OAuth 凭据只能用于本地认证流程，不能进入
 * 主进程日志、AI 工具输出或未加密的诊断文件。调用方仍应避免主动拼接这些
 * 字段；这里的清洗是最后一道兜底。
 */

const EMAIL_RE = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;
const BEARER_RE = /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi;
const UUID_RE = /\b[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/gi;
const ACCOUNT_VALUE_RE = /\b(?:acct|account)[_-][A-Za-z0-9_-]{6,}\b/gi;
const SECRET_FIELD_RE = /(\b(?:access[_-]?token|refresh[_-]?token|id[_-]?token|client[_-]?secret|api[_-]?key)\b\s*["']?\s*[:=]\s*["']?)([^"',\s}\]]+)/gi;
const ACCOUNT_FIELD_RE = /(\b(?:account[_-]?id|chatgpt[_-]?account[_-]?id|user[_-]?id|org(?:anization)?[_-]?id)\b\s*["']?\s*[:=]\s*["']?)([^"',\s}\]]+)/gi;

function sanitizeLogText(value) {
  return String(value)
    .replace(BEARER_RE, "Bearer [redacted]")
    .replace(SECRET_FIELD_RE, "$1[redacted]")
    .replace(ACCOUNT_FIELD_RE, "$1[redacted]")
    .replace(EMAIL_RE, "[redacted-email]")
    .replace(ACCOUNT_VALUE_RE, "[redacted-account]")
    .replace(UUID_RE, "[redacted-id]");
}

function sanitizeLogArg(value) {
  if (typeof value === "string") return sanitizeLogText(value);
  if (value instanceof Error) return sanitizeLogText(value.message);
  if (value === null || value === undefined || typeof value === "number" || typeof value === "boolean") {
    return value;
  }
  // 不让未来误传入的 token/account 对象被日志框架展开。
  return "[redacted-object]";
}

function normalizedKey(key) {
  return String(key)
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/[.\s-]+/g, "_")
    .toLowerCase();
}

function sensitiveDiagnosticKey(key) {
  const normalized = normalizedKey(key);
  return /^(?:access_token|refresh_token|id_token|token|authorization|cookie|set_cookie|secret|client_secret|api_key|account_id|chatgpt_account_id|email|user_id|org_id|organization_id|sub|subject)$/.test(normalized)
    || /^(?:account|user|org|organization)_(?:uuid|identifier)$/.test(normalized);
}

/** 返回可安全写入未加密诊断 JSON 的深拷贝。 */
function sanitizeDiagnosticPayload(value, seen = new WeakSet()) {
  if (typeof value === "string") return sanitizeLogText(value);
  if (value === null || value === undefined || typeof value === "number" || typeof value === "boolean") {
    return value;
  }
  if (Array.isArray(value)) return value.map((item) => sanitizeDiagnosticPayload(item, seen));
  if (typeof value !== "object") return String(value);
  if (seen.has(value)) return "[circular]";
  seen.add(value);
  const output = {};
  for (const [key, item] of Object.entries(value)) {
    output[key] = sensitiveDiagnosticKey(key) ? "[redacted]" : sanitizeDiagnosticPayload(item, seen);
  }
  seen.delete(value);
  return output;
}

module.exports = { sanitizeLogText, sanitizeLogArg, sanitizeDiagnosticPayload, sensitiveDiagnosticKey };
