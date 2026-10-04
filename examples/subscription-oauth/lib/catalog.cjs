"use strict";

/**
 * 三家订阅的模型目录拉取。移植自 Cyrene 内置 catalog.ts（备份提交 803d3eca）。
 */
const { authHeaders, PROVIDERS, decodeJwtPayload } = require("./vendor-http.cjs");
const { contextFromCatalogEntry } = require("./model-context.cjs");

const CODEX_MODELS_BASE = "https://chatgpt.com/backend-api/codex/models";
/**
 * Codex 目录按 client_version 过滤：版本太低会拿不到新模型（甚至空列表）。
 * 依次探测多个版本并取并集，避免新旗舰模型（如 gpt-6-astra）因版本门槛缺失。
 * 第一个版本是主版本（失败即整体失败），其余版本尽力而为。
 */
const CODEX_CLIENT_VERSIONS = ["0.147.0", "0.152.0", "0.160.0", "0.170.0"];
const CLAUDE_MODELS_URL = "https://api.anthropic.com/v1/models?beta=true";
const GROK_MODELS_URL = "https://api.x.ai/v1/models";
const GROK_CLI_MODELS_URL = "https://cli-chat-proxy.grok.com/v1/models";

function asRecord(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : undefined;
}
function asString(value) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}
function asNumber(value) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

function uniqueModels(models) {
  const seen = new Set();
  const out = [];
  for (const m of models) {
    if (!m.id || seen.has(m.id)) continue;
    seen.add(m.id);
    out.push(m);
  }
  return out;
}

async function fetchJson(url, headers) {
  const response = await fetch(url, { method: "GET", headers, signal: AbortSignal.timeout(15_000) });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }
  return JSON.parse(text);
}

/** 解析单个 Codex 目录响应，拆成可见 / 隐藏两组。 */
function parseCodexModels(list) {
  const models = [];
  const hidden = [];
  for (const raw of list) {
    const entry = asRecord(raw);
    const id = asString(entry && entry.slug);
    if (!id) continue;
    const visibility = asString(entry && entry.visibility);
    const efforts = Array.isArray(entry && entry.supported_reasoning_levels)
      ? entry.supported_reasoning_levels
          .map((level) => asString(asRecord(level) && asRecord(level).effort))
          .filter(Boolean)
      : undefined;
    const model = {
      id,
      name: asString(entry && entry.display_name) || id,
      description: asString(entry && entry.description),
      contextWindow: asNumber(entry && entry.context_window),
      efforts,
    };
    // codex-rs ModelVisibility：只有 list 才在选择器可见；hide/none 单独收集，
    // 供 UI「包含隐藏模型」开关使用（新旗舰模型常先以 hide 下发）。
    if (visibility === "hide" || visibility === "none") {
      hidden.push({ ...model, visibility });
      continue;
    }
    models.push(model);
  }
  return { models, hidden };
}

async function chatgptCatalog(tokens) {
  const headers = authHeaders("chatgpt", tokens);
  const perVersion = {};
  const models = [];
  const hidden = [];

  for (let i = 0; i < CODEX_CLIENT_VERSIONS.length; i += 1) {
    const version = CODEX_CLIENT_VERSIONS[i];
    try {
      const json = await fetchJson(`${CODEX_MODELS_BASE}?client_version=${version}`, headers);
      const list = Array.isArray(json.models) ? json.models : [];
      const parsed = parseCodexModels(list);
      perVersion[version] = {
        total: list.length,
        visible: parsed.models.map((m) => m.id),
        hidden: parsed.hidden.map((m) => m.id),
      };
      models.push(...parsed.models);
      hidden.push(...parsed.hidden);
    } catch (error) {
      perVersion[version] = { error: error.message };
      // 主版本（第一个）失败即视为整体失败，其余版本失败只记录
      if (i === 0) throw error;
    }
  }

  // 原始目录落盘，便于排查「某模型缺失」类问题（不含 token）
  dumpRawCatalog("chatgpt", perVersion);

  const uniqueVisible = uniqueModels(models);
  const visibleIds = new Set(uniqueVisible.map((m) => m.id));
  // 同一模型可能在某些版本是 hide、另一些版本是 list：可见优先，从隐藏组剔除
  const uniqueHidden = uniqueModels(hidden).filter((m) => !visibleIds.has(m.id));
  return { models: uniqueVisible, hidden: uniqueHidden };
}

/** 把目录探测结果写到 plugin-data 下（调试用，不含任何凭证）。 */
function dumpRawCatalog(providerId, payload) {
  try {
    const fs = require("node:fs");
    const path = require("node:path");
    const { app } = require("electron");
    const dir = path.join(app.getPath("userData"), "plugin-data", "subscription-oauth");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, `catalog-${providerId}-raw.json`),
      JSON.stringify({ fetchedAt: new Date().toISOString(), versions: payload }, null, 2),
      "utf8",
    );
  } catch {
    // 调试产物失败不影响主流程
  }
}

async function claudeCatalog(tokens) {
  const json = await fetchJson(CLAUDE_MODELS_URL, {
    ...authHeaders("claude", tokens),
    "anthropic-version": "2023-06-01",
  });
  const list = Array.isArray(json.data) ? json.data : [];
  return uniqueModels(list
    .map((raw) => {
      const entry = asRecord(raw);
      const id = asString(entry && entry.id) || "";
      if (!id) return undefined;
      return {
        id,
        name: asString(entry && entry.display_name) || id,
        // Anthropic /v1/models 的上下文字段名随版本变化，用多字段兼容提取
        contextWindow: contextFromCatalogEntry(entry),
      };
    })
    .filter((m) => m && m.id));
}

async function grokCatalog(tokens) {
  const [apiJson, cliJson] = await Promise.all([
    fetchJson(GROK_MODELS_URL, authHeaders("grok", tokens)).catch(() => null),
    fetchJson(GROK_CLI_MODELS_URL, authHeaders("grok", tokens)).catch(() => null),
  ]);
  const cli = new Map();
  const cliRoot = asRecord(cliJson) || {};
  if (Array.isArray(cliRoot.data)) {
    for (const raw of cliRoot.data) {
      const entry = asRecord(raw);
      const id = asString(entry && entry.id);
      if (!id) continue;
      const efforts = Array.isArray(entry && entry.reasoning_efforts)
        ? entry.reasoning_efforts
            .map((level) => asString(asRecord(level) && asRecord(level).value))
            .filter(Boolean)
        : undefined;
      cli.set(id, {
        id,
        name: asString(entry && entry.name) || id,
        description: asString(entry && entry.description),
        contextWindow: asNumber(entry && entry.context_window),
        efforts,
      });
    }
  }
  const apiRoot = asRecord(apiJson) || {};
  const list = Array.isArray(apiRoot.data) ? apiRoot.data : [];
  const models = [];
  for (const raw of list) {
    const entry = asRecord(raw);
    const id = asString(entry && entry.id);
    if (!id || /imagine|image-|video|embed/i.test(id)) continue;
    const extra = cli.get(id) || {};
    models.push({
      id,
      name: extra.name || id,
      description: extra.description,
      // 优先 api.x.ai 目录自带值，缺失时用 CLI 目录的值
      contextWindow: contextFromCatalogEntry(entry) ?? extra.contextWindow,
      efforts: extra.efforts,
    });
  }
  return uniqueModels(models);
}

/**
 * 拉某订阅的模型目录。
 * @param {string} providerId
 * @param {object} tokens
 * @returns {Promise<{ok: boolean, models: Array, hidden: Array, error?: string}>}
 *   models：可见模型；hidden：目录里 visibility=hide/none 的模型（UI 可选展示）。
 */
async function fetchCatalog(providerId, tokens) {
  try {
    let result;
    if (providerId === "chatgpt") result = await chatgptCatalog(tokens);
    else if (providerId === "claude") result = await claudeCatalog(tokens);
    else result = await grokCatalog(tokens);

    // 各 catalog 返回数组或 { models, hidden }
    const models = Array.isArray(result) ? result : (result.models || []);
    const hidden = Array.isArray(result) ? [] : (result.hidden || []);
    if (!models.length) throw new Error("订阅未返回可用模型");
    return { ok: true, models, hidden };
  } catch (error) {
    return { ok: false, models: [], hidden: [], error: error instanceof Error ? error.message : String(error) };
  }
}

module.exports = { fetchCatalog };
