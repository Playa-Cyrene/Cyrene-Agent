// Token 用量持久化存储
//
// 存储位置：<userData>/token-usage.json
// 数据结构：按天 ISO 日期聚合，方便查询任意时间段。
//
// 写入策略：record() 立即更新内存缓存，1 秒防抖落盘（避免高频写）。
// 读取策略：首次访问时从磁盘加载到内存，后续直接读缓存。

import { app } from "electron";
import * as fs from "fs";
import * as path from "path";

export interface TokenUsageDay {
  input: number;
  output: number;
  /** 厂商明确上报的缓存读取 token。 */
  hit: number;
  /** 同一批已上报缓存明细的输入中，未命中缓存的 token。 */
  miss: number;
  /** 厂商明确上报的缓存创建 token（cache_creation_input_tokens）。 */
  cacheCreation: number;
  /** 返回了缓存明细的请求数；0 表示该日没有可用的缓存数据。 */
  cacheUsageRequests?: number;
  requests: number;
  /** 所有发出的模型请求数（含厂商未返回 usage 的）；用于统计覆盖率。 */
  attemptedRequests?: number;
  /** 从 v2 起按真实模型名聚合；旧数据不具备此维度。 */
  models?: Record<string, TokenUsageModel>;
}

export interface TokenUsageModel {
  input: number;
  output: number;
  hit: number;
  miss: number;
  /** 厂商明确上报的缓存创建 token（cache_creation_input_tokens）。 */
  cacheCreation: number;
  /** 厂商实际返回缓存统计的请求数；缺失代表历史数据或暂无可用数据。 */
  cacheUsageRequests?: number;
  requests: number;
  /** 所有发出的模型请求数（含厂商未返回 usage 的）；用于统计覆盖率。 */
  attemptedRequests?: number;
}

interface TokenUsageStore {
  schemaVersion: 2;
  days: Record<string, TokenUsageDay>; // key = "2026-06-19"
}


const DEFAULT_STORE: TokenUsageStore = { schemaVersion: 2, days: {} };
const DEBOUNCE_MS = 1000;
const MAX_WAIT_MS = 5000;

function getFilePath(): string {
  return path.join(app.getPath("userData"), "token-usage.json");
}

function todayKey(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

let cache: TokenUsageStore | null = null;
let saveTimer: ReturnType<typeof setTimeout> | null = null;
let maxWaitTimer: ReturnType<typeof setTimeout> | null = null;

function clearTimers(): void {
  if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
  if (maxWaitTimer) { clearTimeout(maxWaitTimer); maxWaitTimer = null; }
}

function loadFromDisk(): TokenUsageStore {
  const filePath = getFilePath();
  try {
    if (fs.existsSync(filePath)) {
      const raw = fs.readFileSync(filePath, "utf8");
      const parsed = JSON.parse(raw) as Partial<TokenUsageStore>;
      return {
        schemaVersion: 2,
        days: parsed.days && typeof parsed.days === "object" ? parsed.days : {},
      };
    }
  } catch (err) {
    console.warn("[token-usage] 加载失败，重置为空:", err);
  }
  return { ...DEFAULT_STORE, days: {} };
}

function ensureLoaded(): TokenUsageStore {
  if (!cache) cache = loadFromDisk();
  return cache;
}

function scheduleFlush(): void {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    if (maxWaitTimer) { clearTimeout(maxWaitTimer); maxWaitTimer = null; }
    flushNow();
  }, DEBOUNCE_MS);
  if (!maxWaitTimer) {
    maxWaitTimer = setTimeout(() => {
      maxWaitTimer = null;
      if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
      flushNow();
    }, MAX_WAIT_MS);
  }
}

function flushNow(): void {
  if (!cache) return;
  const filePath = getFilePath();
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  // 原子写：先写 .tmp 再 rename
  const tmpPath = filePath + ".tmp";
  try {
    fs.writeFileSync(tmpPath, JSON.stringify(cache, null, 2), "utf8");
    fs.renameSync(tmpPath, filePath);
  } catch (err) {
    console.warn("[token-usage] 落盘失败:", err);
  }
}

// ── public API ──

/** 将一次模型调用累加到指定日期；导出供统计逻辑测试与复用。 */
export function applyUsageToDay(
  day: TokenUsageDay,
  input: number,
  output: number,
  requests = 1,
  cachedInput?: number,
  model?: string,
  cacheCreation?: number,
): void {
  day.input += Math.max(0, Math.round(input || 0));
  day.output += Math.max(0, Math.round(output || 0));
  day.requests += Math.max(0, requests);
  if (typeof cachedInput === "number" && Number.isFinite(cachedInput)) {
    const normalizedInput = Math.max(0, Math.round(input || 0));
    const normalizedCachedInput = Math.max(0, Math.min(normalizedInput, Math.round(cachedInput)));
    day.hit += normalizedCachedInput;
    day.miss += normalizedInput - normalizedCachedInput;
    day.cacheUsageRequests = (day.cacheUsageRequests ?? 0) + Math.max(0, requests);
  }
  if (typeof cacheCreation === "number" && Number.isFinite(cacheCreation)) {
    day.cacheCreation = (day.cacheCreation ?? 0) + Math.max(0, Math.round(cacheCreation));
  }
  const modelName = model?.trim() || "未归类";
  const byModel = day.models ?? {};
  const modelDay = byModel[modelName] ?? { input: 0, output: 0, hit: 0, miss: 0, cacheCreation: 0, requests: 0 };
  modelDay.input += Math.max(0, Math.round(input || 0));
  modelDay.output += Math.max(0, Math.round(output || 0));
  modelDay.requests += Math.max(0, requests);
  if (typeof cachedInput === "number" && Number.isFinite(cachedInput)) {
    const normalizedInput = Math.max(0, Math.round(input || 0));
    const normalizedCachedInput = Math.max(0, Math.min(normalizedInput, Math.round(cachedInput)));
    modelDay.hit += normalizedCachedInput;
    modelDay.miss += normalizedInput - normalizedCachedInput;
    modelDay.cacheUsageRequests = (modelDay.cacheUsageRequests ?? 0) + Math.max(0, requests);
  }
  if (typeof cacheCreation === "number" && Number.isFinite(cacheCreation)) {
    modelDay.cacheCreation = (modelDay.cacheCreation ?? 0) + Math.max(0, Math.round(cacheCreation));
  }
  byModel[modelName] = modelDay;
  day.models = byModel;
}

/** 记录一次 API 调用的 token 用量（异步累加到当天）。 */
export function recordUsage(input: number, output: number, requests = 1, cachedInput?: number, model?: string, cacheCreation?: number): void {
  const store = ensureLoaded();
  const key = todayKey();
  const day = store.days[key] ?? { input: 0, output: 0, hit: 0, miss: 0, cacheCreation: 0, requests: 0 };
  applyUsageToDay(day, input, output, requests, cachedInput, model, cacheCreation);
  store.days[key] = day;
  scheduleFlush();
}

/** 记录一次模型请求的发生（不依赖厂商是否返回 usage）。用于统计请求覆盖率。 */
export function recordRequest(model?: string): void {
  const store = ensureLoaded();
  const key = todayKey();
  const day = store.days[key] ?? { input: 0, output: 0, hit: 0, miss: 0, cacheCreation: 0, requests: 0 };
  day.attemptedRequests = (day.attemptedRequests ?? 0) + 1;
  const modelName = model?.trim() || "未归类";
  const byModel = day.models ?? {};
  const modelDay = byModel[modelName] ?? { input: 0, output: 0, hit: 0, miss: 0, cacheCreation: 0, requests: 0 };
  modelDay.attemptedRequests = (modelDay.attemptedRequests ?? 0) + 1;
  byModel[modelName] = modelDay;
  day.models = byModel;
  store.days[key] = day;
  scheduleFlush();
}

/** 清空所有本地 Token 用量记录；传入 days 时仅清空该对象，供纯逻辑测试使用。 */
export function clearUsage(days?: Record<string, TokenUsageDay>): void {
  if (days) {
    for (const key of Object.keys(days)) delete days[key];
    return;
  }
  if (saveTimer) {
    clearTimeout(saveTimer);
    saveTimer = null;
  }
  if (maxWaitTimer) {
    clearTimeout(maxWaitTimer);
    maxWaitTimer = null;
  }
  cache = { ...DEFAULT_STORE, days: {} };
  flushNow();
}

export interface TokenUsageDayReport {
  date: string;
  weekday: string;
  input: number;
  output: number;
  hit: number;
  miss: number;
  cacheCreation: number;
  requests: number;
  attemptedRequests: number;
  cacheUsageRequests: number;
  /** 当天按真实模型名聚合的明细（v2 起记录）；趋势图按模型拆线用。 */
  models?: Record<string, TokenUsageModel>;
}

/** 查询最近 N 天的用量数据，按日期升序返回（无数据的天填 0）。 */
export function getUsage(days: number): TokenUsageDayReport[] {
  const store = ensureLoaded();
  const result: TokenUsageDayReport[] = [];
  const weekdays = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];
  const now = new Date();

  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(now);
    d.setDate(d.getDate() - i);
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    const day = store.days[key];
    const mm = String(d.getMonth() + 1).padStart(2, "0");
    const dd = String(d.getDate()).padStart(2, "0");
    result.push({
      date: `${mm}-${dd}`,
      weekday: weekdays[d.getDay()],
      input: day?.input ?? 0,
      output: day?.output ?? 0,
      hit: day?.hit ?? 0,
      miss: day?.miss ?? 0,
      cacheCreation: day?.cacheCreation ?? 0,
      requests: day?.requests ?? 0,
      attemptedRequests: day?.attemptedRequests ?? 0,
      cacheUsageRequests: day?.cacheUsageRequests ?? 0,
      models: day?.models,
    });
  }
  return result;
}

export interface TokenUsageReport {
  days: ReturnType<typeof getUsage>;
  models: Array<TokenUsageModel & { model: string }>;
}

/** 查询某个时间范围的日统计和真实模型占比；历史 v1 记录归入"未归类"。 */
export function getUsageReport(days: number): TokenUsageReport {
  const daily = getUsage(days);
  const store = ensureLoaded();
  const models = new Map<string, TokenUsageModel>();
  const today = new Date();
  for (let offset = days - 1; offset >= 0; offset -= 1) {
    const date = new Date(today);
    date.setDate(date.getDate() - offset);
    const key = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
    const day = store.days[key];
    if (!day) continue;
    const entries = day.models && Object.keys(day.models).length > 0
      ? Object.entries(day.models)
      : [["未归类", day] as const];
    for (const [model, value] of entries) {
      const target = models.get(model) ?? { input: 0, output: 0, hit: 0, miss: 0, cacheCreation: 0, requests: 0 };
      target.input += value.input ?? 0;
      target.output += value.output ?? 0;
      target.hit += value.hit ?? 0;
      target.miss += value.miss ?? 0;
      target.cacheCreation += value.cacheCreation ?? 0;
      target.requests += value.requests ?? 0;
      target.attemptedRequests = (target.attemptedRequests ?? 0) + (value.attemptedRequests ?? 0);
      models.set(model, target);
    }
  }
  return {
    days: daily,
    models: [...models.entries()]
      .map(([model, value]) => ({ model, ...value }))
      // attemptedRequests > 0 也保留：端点不回 usage 的模型可见（显示 0 token），而不是从列表消失
      .filter((item) => item.input > 0 || item.output > 0 || item.requests > 0 || (item.attemptedRequests ?? 0) > 0)
      .sort((left, right) => (right.input + right.output) - (left.input + left.output)),
  };
}

/** 立即落盘（应用退出时调用）。 */
export function flush(): void {
  clearTimers();
  flushNow();
}
