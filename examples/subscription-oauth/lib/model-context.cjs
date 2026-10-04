"use strict";

/**
 * 模型上下文长度解析。
 *
 * 优先用订阅目录返回的真实值（不同目录字段名不同，见 CATALOG_FIELDS）；
 * 目录缺失时按模型族兜底（官方公开规格），避免所有模型都写同一个默认值。
 * 兜底表只做"合理近似"，用户可以随时在 Cyrene 设置里手动改。
 */

/** 目录里可能出现的上下文字段名（按可信度排序）。 */
const CATALOG_FIELDS = [
  "context_window",
  "contextWindow",
  "context_length",
  "contextLength",
  "max_context_tokens",
  "maxContextTokens",
  "max_input_tokens",
  "maxInputTokens",
];

/**
 * 模型族兜底表（官方公开规格，粗粒度到型号族）。
 * 顺序敏感：具体型号在前，宽泛族在后，第一条命中生效。
 */
const CONTEXT_BY_PATTERN = [
  // ── ChatGPT / Codex ──
  [/^gpt-6/, 512000],
  [/^gpt-5\.6/, 512000],
  [/^gpt-5\.5/, 400000],
  [/^gpt-5\.4/, 400000],
  [/^gpt-5/, 400000],
  [/^o[1-9]/, 200000],
  // ── Claude ──
  [/^claude-opus-4/, 200000],
  [/^claude-sonnet-4/, 200000],
  [/^claude-haiku-4/, 200000],
  [/^claude-fable/, 200000],
  [/^claude-/, 200000],
  // ── Grok ──
  [/^grok-4/, 256000],
  [/^grok-3/, 131072],
  [/^grok-/, 131072],
];

const FALLBACK_CONTEXT = 256000;

function asNumber(value) {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }
  return undefined;
}

/** 从目录条目里取上下文长度（多字段名兼容）。 */
function contextFromCatalogEntry(entry) {
  if (!entry || typeof entry !== "object") return undefined;
  for (const field of CATALOG_FIELDS) {
    const value = asNumber(entry[field]);
    if (value !== undefined) return value;
  }
  return undefined;
}

/** 按模型族兜底。 */
function contextByPattern(modelId) {
  const id = String(modelId || "").toLowerCase();
  for (const [pattern, value] of CONTEXT_BY_PATTERN) {
    if (pattern.test(id)) return value;
  }
  return undefined;
}

/**
 * 解析模型上下文长度：目录值 > 模型族兜底 > 全局兜底。
 * @param {string} modelId
 * @param {number|undefined} catalogValue 目录直接给的值（可选）
 * @param {object|undefined} catalogEntry 目录原始条目（可选，多字段名兼容）
 */
function resolveContextWindow(modelId, catalogValue, catalogEntry) {
  const direct = asNumber(catalogValue);
  if (direct !== undefined) return direct;
  const fromEntry = contextFromCatalogEntry(catalogEntry);
  if (fromEntry !== undefined) return fromEntry;
  return contextByPattern(modelId) ?? FALLBACK_CONTEXT;
}

module.exports = {
  CATALOG_FIELDS,
  CONTEXT_BY_PATTERN,
  FALLBACK_CONTEXT,
  contextFromCatalogEntry,
  contextByPattern,
  resolveContextWindow,
};
