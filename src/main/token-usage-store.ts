// Token 用量持久化存储（SQLite facade）
//
// 自 v6 迁移起，数据按 (day, model) 聚合存于 cyrene.sqlite 的 token_usage 表，
// 与会话轨迹共用同一 worker 连接、迁移与导入机制。
// 旧 token-usage.json 由 worker 启动时一次性只读导入，源文件保留。
//
// 写入策略：record() 计算按调用钳制的增量，fire-and-forget 交给 worker 做单语句
// 原子 UPSERT（WAL + FULL 同步，提交即持久）——不再需要防抖与全量重写。
// 读取策略：getUsageReport 直接查询数据库，按天聚合。

import { app } from "electron";
import { getConversationDatabase } from "./storage/conversation-database-client";
import type { TokenUsageDelta } from "./storage/conversation-usage-repository";

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

function database() {
  return getConversationDatabase(app.getPath("userData"));
}

export function todayKey(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/** 最近 N 天的日期 key，升序（最旧在前）。 */
function dayKeys(days: number): string[] {
  const keys: string[] = [];
  const now = new Date();
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(now);
    d.setDate(d.getDate() - i);
    keys.push(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`);
  }
  return keys;
}

// ── 纯聚合逻辑（测试与导入复用，不触 IO）──

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
  const delta = buildUsageDelta(input, output, requests, cachedInput, cacheCreation);
  day.input += delta.input;
  day.output += delta.output;
  day.requests += delta.requests;
  day.hit += delta.hit;
  day.miss += delta.miss;
  if (delta.cacheUsageRequests > 0) {
    day.cacheUsageRequests = (day.cacheUsageRequests ?? 0) + delta.cacheUsageRequests;
  }
  if (delta.cacheCreation > 0) {
    day.cacheCreation = (day.cacheCreation ?? 0) + delta.cacheCreation;
  }
  const modelName = model?.trim() || "未归类";
  const byModel = day.models ?? {};
  const modelDay = byModel[modelName] ?? { input: 0, output: 0, hit: 0, miss: 0, cacheCreation: 0, requests: 0 };
  modelDay.input += delta.input;
  modelDay.output += delta.output;
  modelDay.requests += delta.requests;
  modelDay.hit += delta.hit;
  modelDay.miss += delta.miss;
  if (delta.cacheUsageRequests > 0) {
    modelDay.cacheUsageRequests = (modelDay.cacheUsageRequests ?? 0) + delta.cacheUsageRequests;
  }
  if (delta.cacheCreation > 0) {
    modelDay.cacheCreation = (modelDay.cacheCreation ?? 0) + delta.cacheCreation;
  }
  byModel[modelName] = modelDay;
  day.models = byModel;
}

/** 一次模型调用的按调用钳制增量：hit/miss 只在厂商返回缓存明细时才计入。 */
function buildUsageDelta(
  input: number,
  output: number,
  requests: number,
  cachedInput?: number,
  cacheCreation?: number,
): { input: number; output: number; hit: number; miss: number; cacheCreation: number; cacheUsageRequests: number; requests: number } {
  const normalizedInput = Math.max(0, Math.round(input || 0));
  let hit = 0;
  let miss = 0;
  let cacheUsageRequests = 0;
  if (typeof cachedInput === "number" && Number.isFinite(cachedInput)) {
    const normalizedCachedInput = Math.max(0, Math.min(normalizedInput, Math.round(cachedInput)));
    hit = normalizedCachedInput;
    miss = normalizedInput - normalizedCachedInput;
    cacheUsageRequests = Math.max(0, requests);
  }
  return {
    input: normalizedInput,
    output: Math.max(0, Math.round(output || 0)),
    hit,
    miss,
    cacheCreation: typeof cacheCreation === "number" && Number.isFinite(cacheCreation)
      ? Math.max(0, Math.round(cacheCreation))
      : 0,
    cacheUsageRequests,
    requests: Math.max(0, requests),
  };
}

// ── public API ──

/** 记录一次 API 调用的 token 用量（增量 UPSERT，fire-and-forget）。 */
export function recordUsage(input: number, output: number, requests = 1, cachedInput?: number, model?: string, cacheCreation?: number): void {
  const delta = buildUsageDelta(input, output, requests, cachedInput, cacheCreation);
  void database().call("usage.record", {
    day: todayKey(),
    model: model?.trim() || "未归类",
    ...delta,
    attemptedRequests: 0,
  } satisfies TokenUsageDelta);
}

/** 记录一次模型请求的发生（不依赖厂商是否返回 usage）。用于统计请求覆盖率。 */
export function recordRequest(model?: string): void {
  void database().call("usage.record", {
    day: todayKey(),
    model: model?.trim() || "未归类",
    input: 0, output: 0, hit: 0, miss: 0, cacheCreation: 0, cacheUsageRequests: 0, requests: 0,
    attemptedRequests: 1,
  } satisfies TokenUsageDelta);
}

/** 清空所有本地 Token 用量记录；传入 days 时仅清空该对象，供纯逻辑测试使用。 */
export function clearUsage(days?: Record<string, TokenUsageDay>): void | Promise<void> {
  if (days) {
    for (const key of Object.keys(days)) delete days[key];
    return;
  }
  return database().call("usage.clear");
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

interface TokenUsageRow {
  day: string;
  model: string;
  input: number;
  output: number;
  hit: number;
  miss: number;
  cache_creation: number;
  cache_usage_requests: number;
  requests: number;
  attempted_requests: number;
}

/** 查询最近 N 天的用量数据，按日期升序返回（无数据的天填 0）。 */
export async function getUsage(days: number): Promise<TokenUsageDayReport[]> {
  const keys = dayKeys(days);
  const rows = await database().call<TokenUsageRow[]>("usage.range", keys);
  const byDay = new Map<string, { totals: TokenUsageDay; models: Record<string, TokenUsageModel> }>();
  for (const row of rows) {
    const entry = byDay.get(row.day) ?? {
      totals: { input: 0, output: 0, hit: 0, miss: 0, cacheCreation: 0, cacheUsageRequests: 0, requests: 0, attemptedRequests: 0 },
      models: {},
    };
    entry.totals.input += row.input;
    entry.totals.output += row.output;
    entry.totals.hit += row.hit;
    entry.totals.miss += row.miss;
    entry.totals.cacheCreation += row.cache_creation;
    entry.totals.cacheUsageRequests = (entry.totals.cacheUsageRequests ?? 0) + row.cache_usage_requests;
    entry.totals.requests += row.requests;
    entry.totals.attemptedRequests = (entry.totals.attemptedRequests ?? 0) + row.attempted_requests;
    entry.models[row.model] = {
      input: row.input, output: row.output, hit: row.hit, miss: row.miss,
      cacheCreation: row.cache_creation,
      ...(row.cache_usage_requests > 0 ? { cacheUsageRequests: row.cache_usage_requests } : {}),
      requests: row.requests,
      ...(row.attempted_requests > 0 ? { attemptedRequests: row.attempted_requests } : {}),
    };
    byDay.set(row.day, entry);
  }

  const result: TokenUsageDayReport[] = [];
  const weekdays = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];
  const now = new Date();
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(now);
    d.setDate(d.getDate() - i);
    const key = keys[keys.length - 1 - i]!;
    const entry = byDay.get(key);
    const mm = String(d.getMonth() + 1).padStart(2, "0");
    const dd = String(d.getDate()).padStart(2, "0");
    result.push({
      date: `${mm}-${dd}`,
      weekday: weekdays[d.getDay()],
      input: entry?.totals.input ?? 0,
      output: entry?.totals.output ?? 0,
      hit: entry?.totals.hit ?? 0,
      miss: entry?.totals.miss ?? 0,
      cacheCreation: entry?.totals.cacheCreation ?? 0,
      requests: entry?.totals.requests ?? 0,
      attemptedRequests: entry?.totals.attemptedRequests ?? 0,
      cacheUsageRequests: entry?.totals.cacheUsageRequests ?? 0,
      models: entry && Object.keys(entry.models).length > 0 ? entry.models : undefined,
    });
  }
  return result;
}

export interface TokenUsageReport {
  days: TokenUsageDayReport[];
  models: Array<TokenUsageModel & { model: string }>;
}

/** 查询某个时间范围的日统计和真实模型占比；历史 v1 记录归入"未归类"。 */
export async function getUsageReport(days: number): Promise<TokenUsageReport> {
  const daily = await getUsage(days);
  const models = new Map<string, TokenUsageModel>();
  for (const day of daily) {
    const entries = day.models && Object.keys(day.models).length > 0
      ? Object.entries(day.models)
      : day.requests > 0 || day.attemptedRequests > 0
        ? [["未归类", day] as const]
        : [];
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

/** 兼容保留：SQLite 每次提交即持久（WAL + FULL 同步），无批量落盘需求。 */
export function flush(): void { /* no-op */ }
