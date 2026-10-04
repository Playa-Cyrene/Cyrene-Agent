"use strict";

/**
 * 三家订阅的用量查询与解析。移植自 Cyrene 内置 usage.ts（备份提交 803d3eca）。
 */
const { authHeaders, PROVIDERS, decodeJwtPayload } = require("./vendor-http.cjs");
const { sanitizeDiagnosticPayload } = require("./privacy.cjs");

function asRecord(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : undefined;
}
function asNumber(value) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}
function asString(value) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function clampPercent(value) {
  if (value > 0 && value < 1) return Math.round(value * 1000) / 10;
  return Math.max(0, Math.min(100, Math.round(value * 10) / 10));
}

function timestampFrom(value, fallbackSeconds) {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value < 10_000_000_000 ? value * 1000 : value;
  }
  if (typeof value === "string" && value.trim()) {
    const parsed = Date.parse(value);
    if (!Number.isNaN(parsed)) return parsed;
  }
  if (typeof fallbackSeconds === "number" && Number.isFinite(fallbackSeconds)) {
    return Date.now() + Math.max(0, fallbackSeconds) * 1000;
  }
  return undefined;
}

function windowFrom(id, label, source) {
  if (!source) return undefined;
  // 注意：必须用 ?? 而非 || —— used_percent=0（全新周期）是合法值，
  // 用 || 会把 0 当假值跳过，导致"用量为 0 的窗口"整条被丢弃。
  const rawPercent =
    asNumber(source.used_percent) ?? asNumber(source.usedPercent) ?? asNumber(source.utilization) ??
    asNumber(source.percentage) ?? asNumber(source.percent);
  if (rawPercent === undefined) {
    const used = asNumber(source.used) ?? asNumber(source.consumed);
    const limit = asNumber(source.limit) ?? asNumber(source.allowed) ?? asNumber(source.quota);
    if (used === undefined || !limit) return undefined;
    return {
      id, label,
      usedPercent: clampPercent((used / limit) * 100),
      resetsAt: timestampFrom(
        source.resets_at ?? source.reset_at ?? source.resetAt ?? source.reset,
        asNumber(source.reset_after_seconds),
      ),
    };
  }
  return {
    id, label,
    usedPercent: clampPercent(rawPercent),
    resetsAt: timestampFrom(
      source.resets_at ?? source.reset_at ?? source.resetAt ?? source.reset,
      asNumber(source.reset_after_seconds),
    ),
  };
}

function parseChatgptUsage(json) {
  const root = asRecord(json) || {};
  const rateLimit =
    asRecord(root.rate_limit) || asRecord(root.rateLimit) || asRecord(root.rate_limits) ||
    asRecord(root.rateLimits) || asRecord(asRecord(root.rate_limits) && asRecord(root.rate_limits).codex) || root;
  const windows = [
    windowFrom("primary", "5 小时窗口",
      asRecord(rateLimit.primary_window) || asRecord(rateLimit.primaryWindow) ||
      asRecord(rateLimit.primary) || asRecord(root.primary_window)),
    windowFrom("secondary", "每周",
      asRecord(rateLimit.secondary_window) || asRecord(rateLimit.secondaryWindow) ||
      asRecord(rateLimit.secondary) || asRecord(root.secondary_window)),
  ].filter(Boolean);
  return {
    plan: asString(root.plan_type) || asString(root.planType) || asString(root.plan),
    windows,
    fetchedAt: Date.now(),
    error: windows.length === 0 ? "未返回用量窗口" : undefined,
  };
}

function claudeLimitsWindows(value) {
  if (!Array.isArray(value)) return [];
  const windows = [];
  for (const raw of value) {
    const entry = asRecord(raw);
    if (!entry) continue;
    const percent = asNumber(entry.percent);
    if (percent === undefined) continue;
    const kind = entry.kind === "session" ? "five_hour"
      : (entry.kind === "weekly_all" || entry.kind === "weekly_scoped") ? "seven_day"
        : (asString(entry.kind) || "other");
    const scopeObj = asRecord(entry.scope);
    const modelObj = scopeObj ? asRecord(scopeObj.model) : undefined;
    const scope = modelObj ? asString(modelObj.display_name) : undefined;
    windows.push({
      id: scope ? `${kind}:${scope}` : kind,
      label: kind === "five_hour" ? "5 小时窗口" : kind === "seven_day" ? (scope ? `每周 · ${scope}` : "每周") : (scope || "窗口"),
      usedPercent: clampPercent(percent),
      resetsAt: timestampFrom(entry.resets_at),
    });
  }
  return windows;
}

function parseClaudeUsage(json) {
  const root = asRecord(json) || {};
  const modern = claudeLimitsWindows(root.limits);
  if (modern.length > 0) {
    return { plan: asString(root.plan), windows: modern, fetchedAt: Date.now() };
  }
  const extra = asRecord(root.extra_usage) || asRecord(root.extraUsage);
  const windows = [
    windowFrom("five_hour", "5 小时窗口",
      asRecord(root.five_hour) || asRecord(root.fiveHour) || asRecord(extra && extra.five_hour)),
    windowFrom("seven_day", "每周",
      asRecord(root.seven_day) || asRecord(root.sevenDay) || asRecord(extra && extra.seven_day)),
  ].filter(Boolean);
  return {
    plan: asString(root.plan) || asString(root.subscription_type) || asString(root.subscriptionType),
    windows,
    fetchedAt: Date.now(),
    error: windows.length === 0 ? "未返回用量窗口" : undefined,
  };
}

function remainingWindow(id, label, source) {
  if (!source) return undefined;
  // 同上：剩余量为 0 是合法值，不能用 || 跳过
  const remaining = asNumber(source.remaining) ?? asNumber(source.credits_remaining);
  const limit = asNumber(source.limit) ?? asNumber(source.credits_limit) ?? asNumber(source.quota);
  if (remaining === undefined || !limit) return undefined;
  return {
    id, label,
    usedPercent: clampPercent(((limit - remaining) / limit) * 100),
    resetsAt: timestampFrom(source.resets_at ?? source.reset_at ?? source.reset, asNumber(source.reset_after_seconds)),
  };
}

const GROK_TIER_NAMES = {
  0: "Free", 1: "SuperGrok", 2: "X Basic", 3: "X Premium",
  4: "X Premium+", 5: "SuperGrok Heavy", 6: "SuperGrok Lite", 7: "SuperGrok Plus",
};

function grokTierName(accessToken) {
  const tier = decodeJwtPayload(accessToken) && decodeJwtPayload(accessToken).tier;
  if (typeof tier !== "number" || !Number.isInteger(tier)) return undefined;
  return GROK_TIER_NAMES[tier] || String(tier);
}

function parseGrokUsage(json, accessToken) {
  const root = asRecord(json) || {};
  const config = asRecord(root.config) || {};
  const windows = [];
  const creditPercent = asNumber(config.creditUsagePercent);
  if (creditPercent !== undefined) {
    const period = asRecord(config.currentPeriod);
    windows.push({
      id: "weekly",
      label: period && period.type === "USAGE_PERIOD_TYPE_WEEKLY" ? "每周" : "额度",
      usedPercent: clampPercent(creditPercent),
      resetsAt: timestampFrom(period && period.end),
    });
  } else {
    const monthlyLimit = asNumber(asRecord(config.monthlyLimit) && asRecord(config.monthlyLimit).val);
    if (monthlyLimit) {
      const used = asNumber(asRecord(config.used) && asRecord(config.used).val) || 0;
      windows.push({
        id: "weekly",
        label: "额度",
        usedPercent: clampPercent((used / monthlyLimit) * 100),
        resetsAt: timestampFrom(config.billingPeriodEnd),
      });
    }
  }
  if (windows.length === 0) {
    const usage = asRecord(root.usage) || asRecord(root.quota) || asRecord(root.limits) || root;
    const weeklySource =
      asRecord(root.weekly) || asRecord(root.week) || asRecord(usage.weekly) ||
      asRecord(usage.requests) || asRecord(root.rate_limit) || usage;
    const fallback = [
      windowFrom("weekly", "每周", weeklySource),
      remainingWindow("weekly", "每周", weeklySource),
      remainingWindow("weekly", "每周", root),
    ].filter(Boolean);
    for (const item of fallback) {
      if (item && !windows.some((w) => w.id === item.id)) windows.push(item);
    }
  }
  return {
    plan: asString(root.subscriptionTier) || asString(root.plan) || asString(root.plan_type) || grokTierName(accessToken),
    windows,
    fetchedAt: Date.now(),
    error: windows.length === 0 ? "未返回用量窗口" : undefined,
  };
}

async function fetchJson(url, headers) {
  const response = await fetch(url, { method: "GET", headers, signal: AbortSignal.timeout(15_000) });
  const text = await response.text();
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return JSON.parse(text);
}

/** 把用量响应的脱敏副本写到 plugin-data 下（诊断用，不含凭据或账号标识）。 */
function dumpRawUsage(providerId, json) {
  try {
    const fs = require("node:fs");
    const path = require("node:path");
    const { app } = require("electron");
    const dir = path.join(app.getPath("userData"), "plugin-data", "subscription-oauth");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, `usage-${providerId}-raw.json`),
      JSON.stringify({ fetchedAt: new Date().toISOString(), payload: sanitizeDiagnosticPayload(json) }, null, 2),
      "utf8",
    );
  } catch {
    // 诊断产物失败不影响主流程
  }
}

/**
 * 拉某订阅的用量。
 * @returns {Promise<{ok: boolean, usage?: object, error?: string}>}
 */
async function fetchUsage(providerId, tokens) {
  try {
    let usage;
    let raw;
    if (providerId === "chatgpt") {
      raw = await fetchJson("https://chatgpt.com/backend-api/wham/usage", authHeaders("chatgpt", tokens));
      usage = parseChatgptUsage(raw);
    } else if (providerId === "claude") {
      raw = await fetchJson("https://api.anthropic.com/api/oauth/usage", {
        ...authHeaders("claude", tokens),
        "anthropic-beta": "oauth-2025-04-20",
      });
      usage = parseClaudeUsage(raw);
    } else {
      raw = await fetchJson("https://cli-chat-proxy.grok.com/v1/billing?format=credits", authHeaders("grok", tokens));
      usage = parseGrokUsage(raw, tokens.accessToken);
    }
    // 窗口为空时落盘原始响应，便于确认是"后端确实没数据"还是"字段解析遗漏"
    if (!usage.windows || usage.windows.length === 0) dumpRawUsage(providerId, raw);
    return { ok: true, usage };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

module.exports = { fetchUsage, parseChatgptUsage, parseClaudeUsage, parseGrokUsage, grokTierName };
