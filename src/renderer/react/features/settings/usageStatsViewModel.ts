// 用量统计视图模型：把 token-usage 报告折叠成热力图 / 摘要 / 趋势 / 模型占比。
// 全部为纯函数，日期一律走本地时区的 ISO "YYYY-MM-DD"，方便单测。

export interface UsageDay {
  date: string; // "MM-DD"
  weekday: string;
  input: number;
  output: number;
  hit: number;
  miss: number;
  cacheCreation: number;
  requests: number;
  attemptedRequests: number;
  cacheUsageRequests: number;
  /** 当天按真实模型名聚合的明细（v2 起记录），趋势图按模型拆线用。 */
  models?: Record<string, { input: number; output: number }>;
}

export interface UsageModel {
  model: string;
  input: number;
  output: number;
  hit: number;
  miss: number;
  cacheCreation?: number;
  requests: number;
  attemptedRequests?: number;
  cacheUsageRequests?: number;
}

export interface UsageReport {
  days: UsageDay[];
  models: UsageModel[];
}

/** 每天进入热力图的量：input 已包含缓存命中/未命中，cacheCreation 单独计费不重复算。 */
export function dayTotalTokens(day: UsageDay): number {
  return Math.max(0, day.input) + Math.max(0, day.output);
}

export function dayTotalRequests(day: UsageDay): number {
  return Math.max(0, day.attemptedRequests) > 0 ? Math.max(0, day.attemptedRequests) : Math.max(0, day.requests);
}

function isoDate(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

/**
 * IPC 返回的 date 只有 "MM-DD"，跨年会歧义。
 * 好在数组按天升序且最后一项是今天，这里按位置从今天往前重建完整 ISO 日期。
 */
export function resolveIsoDates(days: UsageDay[], today = new Date()): string[] {
  const result: string[] = [];
  const cursor = new Date(today.getFullYear(), today.getMonth(), today.getDate());
  for (let index = days.length - 1; index >= 0; index -= 1) {
    result[index] = isoDate(cursor);
    cursor.setDate(cursor.getDate() - 1);
  }
  return result;
}

export interface HeatmapCell {
  key: string;
  iso: string;
  level: 0 | 1 | 2 | 3 | 4;
  hasUsage: boolean;
  tokens: number;
  requests: number;
}

export interface HeatmapColumn {
  key: string;
  monthIso: string;
  cells: HeatmapCell[];
  weeklyTokens: number;
  weeklyRequests: number;
}

export interface HeatmapModel {
  columns: HeatmapColumn[];
  monthLabels: Array<{ key: string; label: string; span: number; hidden: boolean }>;
  maxDaily: number;
  maxWeekly: number;
}

const DAY_MS = 86_400_000;
export const HEATMAP_WEEKS = 52;
const DAYS_PER_WEEK = 7;
const HEATMAP_MAX_MONTH_LABELS = 12;

export function levelForValue(value: number, max: number): 0 | 1 | 2 | 3 | 4 {
  if (value <= 0 || max <= 0) return 0;
  return Math.min(4, Math.max(1, Math.ceil((value / max) * 4))) as 0 | 1 | 2 | 3 | 4;
}

function monthLabelOf(locale: string, iso: string): string {
  const date = new Date(`${iso}T00:00:00`);
  if (Number.isNaN(date.getTime())) return "";
  return new Intl.DateTimeFormat(locale, { month: "short" }).format(date);
}

/**
 * GitHub 风格 52 周网格：列是自然周（行从周日开始），最后一列是本周，
 * 未来日期与缺数据日期都补 level 0。周/累计模式的色阶由调用方按 mode 重算，
 * 这里同时给出 weekly / cumulative 基准值避免二次遍历。
 */
export function buildHeatmap(days: UsageDay[], locale: string, today = new Date()): HeatmapModel {
  const isoDates = resolveIsoDates(days, today);
  const byIso = new Map<string, UsageDay>();
  days.forEach((day, index) => {
    const iso = isoDates[index];
    if (iso) byIso.set(iso, day);
  });

  const todayLocal = new Date(today.getFullYear(), today.getMonth(), today.getDate());
  // 最后一列从本周周日开始，整体再向前补满 52 列，保证首行都是周日。
  const endWeekStart = todayLocal.getTime() - todayLocal.getDay() * DAY_MS;
  const startDayMs = endWeekStart - (HEATMAP_WEEKS - 1) * DAYS_PER_WEEK * DAY_MS;

  const dailyValues: number[] = [];
  const columns: HeatmapColumn[] = [];
  for (let week = 0; week < HEATMAP_WEEKS; week += 1) {
    const cells: HeatmapCell[] = [];
    for (let dayOffset = 0; dayOffset < DAYS_PER_WEEK; dayOffset += 1) {
      const dayMs = startDayMs + (week * DAYS_PER_WEEK + dayOffset) * DAY_MS;
      const iso = isoDate(new Date(dayMs));
      const day = byIso.get(iso);
      const tokens = day ? dayTotalTokens(day) : 0;
      dailyValues.push(tokens);
      cells.push({
        key: iso,
        iso,
        level: 0,
        hasUsage: tokens > 0,
        tokens,
        requests: day ? dayTotalRequests(day) : 0,
      });
    }
    // 列所属月份：包含当月 1 日时优先归入新月份，避免月初标签错位一列。
    const firstOfMonth = cells.find((cell) => cell.iso.endsWith("-01"));
    columns.push({
      key: `week-${week}`,
      monthIso: firstOfMonth?.iso ?? cells[0].iso,
      cells,
      weeklyTokens: cells.reduce((sum, cell) => sum + cell.tokens, 0),
      weeklyRequests: cells.reduce((sum, cell) => sum + cell.requests, 0),
    });
  }

  const maxDaily = Math.max(0, ...dailyValues);
  for (const column of columns) {
    for (const cell of column.cells) {
      cell.level = levelForValue(cell.tokens, maxDaily);
    }
  }

  const maxWeekly = Math.max(0, ...columns.map((column) => column.weeklyTokens));

  // 52 周可能跨 13 个月：多余起始月的 span 保留以维持对齐，只隐藏文字。
  const monthLabels: HeatmapModel["monthLabels"] = [];
  for (const column of columns) {
    const key = column.monthIso.slice(0, 7);
    const last = monthLabels.at(-1);
    if (last && last.key === key) {
      last.span += 1;
      continue;
    }
    monthLabels.push({ key, label: monthLabelOf(locale, column.monthIso), span: 1, hidden: false });
  }
  const hiddenCount = Math.max(0, monthLabels.length - HEATMAP_MAX_MONTH_LABELS);
  for (let index = 0; index < hiddenCount; index += 1) {
    const label = monthLabels[index];
    if (label) label.hidden = true;
  }

  return { columns, monthLabels, maxDaily, maxWeekly };
}

/** 周/累计模式下一列从底部向上填充的行数。 */
export function filledRowsForValue(value: number, max: number): number {
  if (value <= 0 || max <= 0) return 0;
  return Math.min(DAYS_PER_WEEK, Math.max(1, Math.ceil((value / max) * DAYS_PER_WEEK)));
}

export interface UsageSummary {
  totalTokens: number;
  peakDayTokens: number;
  peakDayIso: string | null;
  requests: number;
  attemptedRequests: number;
  cacheHit: number;
  cacheMiss: number;
  /** 厂商返回缓存明细的请求数；0 表示该范围内没有可用缓存数据。 */
  cacheUsageRequests: number;
  currentStreakDays: number;
  longestStreakDays: number;
}

function isActiveDay(day: UsageDay): boolean {
  return dayTotalTokens(day) > 0 || day.requests > 0 || day.attemptedRequests > 0;
}

/**
 * 汇总指标。days 必须是按天升序、以今天（或最近可得日期）结尾的连续切片；
 * 连续天数按"当天有用量或请求"判定，今天没用量时允许从昨天起算（GitHub 语义）。
 */
export function computeSummary(days: UsageDay[]): UsageSummary {
  let totalTokens = 0;
  let peakDayTokens = 0;
  let peakDayIso: string | null = null;
  let requests = 0;
  let attemptedRequests = 0;
  let cacheHit = 0;
  let cacheMiss = 0;
  let cacheUsageRequests = 0;

  const isoDates = resolveIsoDates(days);
  days.forEach((day, index) => {
    const tokens = dayTotalTokens(day);
    totalTokens += tokens;
    if (tokens > peakDayTokens) {
      peakDayTokens = tokens;
      peakDayIso = isoDates[index] ?? null;
    }
    requests += Math.max(0, day.requests);
    attemptedRequests += Math.max(0, day.attemptedRequests);
    cacheHit += Math.max(0, day.hit);
    cacheMiss += Math.max(0, day.miss);
    cacheUsageRequests += Math.max(0, day.cacheUsageRequests);
  });

  let currentStreakDays = 0;
  for (let index = days.length - 1; index >= 0; index -= 1) {
    if (!isActiveDay(days[index])) break;
    currentStreakDays += 1;
  }
  // 今天还没用量不算断签：回退一格，从昨天开始重新计。
  if (currentStreakDays === 0 && days.length >= 2 && isActiveDay(days[days.length - 2])) {
    for (let index = days.length - 2; index >= 0; index -= 1) {
      if (!isActiveDay(days[index])) break;
      currentStreakDays += 1;
    }
  }

  let longestStreakDays = 0;
  let runningStreak = 0;
  for (const day of days) {
    if (isActiveDay(day)) {
      runningStreak += 1;
      longestStreakDays = Math.max(longestStreakDays, runningStreak);
    } else {
      runningStreak = 0;
    }
  }

  return {
    totalTokens,
    peakDayTokens,
    peakDayIso,
    requests,
    attemptedRequests,
    cacheHit,
    cacheMiss,
    cacheUsageRequests,
    currentStreakDays,
    longestStreakDays,
  };
}

export interface ModelSlice {
  model: string;
  tokens: number;
  requests: number;
  share: number;
  color: string;
}

const MODEL_COLORS = ["#ec4899", "#8b7cf6", "#4db6ac", "#f4a261", "#5b8def", "#f88fbc"];

/** 取前 6 个模型，其余合并为"其他"；share 基于 input+output。 */
export function buildModelSlices(models: UsageModel[], otherLabel: string): ModelSlice[] {
  const usable = models.filter((item) => item.input + item.output > 0);
  const total = usable.reduce((sum, item) => sum + item.input + item.output, 0);
  if (total <= 0) return [];
  const top = usable.slice(0, MODEL_COLORS.length);
  const restTokens = usable.slice(MODEL_COLORS.length).reduce((sum, item) => sum + item.input + item.output, 0);
  const slices: ModelSlice[] = top.map((item, index) => ({
    model: item.model,
    tokens: item.input + item.output,
    requests: item.requests,
    share: (item.input + item.output) / total,
    color: MODEL_COLORS[index % MODEL_COLORS.length],
  }));
  if (restTokens > 0) {
    slices.push({ model: otherLabel, tokens: restTokens, requests: 0, share: restTokens / total, color: "#94a3b8" });
  }
  return slices;
}

export interface DailyModelSeriesModel {
  /** 数据列 key（如 "model0"），折线 dataset 与行数据靠它对齐。 */
  key: string;
  name: string;
  color: string;
}

export interface DailyModelSeriesRow {
  label: string;
  weekday: string;
  /** 当天所有模型 input+output 之和，tooltip 标题用。 */
  total: number;
  values: Record<string, number>;
}

export interface DailyModelSeries {
  models: DailyModelSeriesModel[];
  rows: DailyModelSeriesRow[];
  /** 可见序列的单点峰值（不是每日总量），作为 Y 轴上限。 */
  maxTokens: number;
}

/**
 * 每日多模型趋势：取范围内总量前 6 的模型各拆一条折线（对齐 ZCode 的
 * "每天看用了哪些模型"），其余模型不画线但保留在当天总量里。
 */
export function buildDailyModelSeries(days: UsageDay[]): DailyModelSeries {
  const totals = new Map<string, number>();
  for (const day of days) {
    for (const [name, usage] of Object.entries(day.models ?? {})) {
      const tokens = Math.max(0, usage?.input ?? 0) + Math.max(0, usage?.output ?? 0);
      if (tokens <= 0) continue;
      totals.set(name, (totals.get(name) ?? 0) + tokens);
    }
  }

  const top = [...totals.entries()]
    .sort(([, left], [, right]) => right - left)
    .slice(0, MODEL_COLORS.length)
    .map(([name], index) => ({
      key: `model${index}`,
      name,
      color: MODEL_COLORS[index],
    }));

  const rows: DailyModelSeriesRow[] = days.map((day) => {
    const values: Record<string, number> = {};
    for (const model of top) {
      const usage = day.models?.[model.name];
      values[model.key] = Math.max(0, usage?.input ?? 0) + Math.max(0, usage?.output ?? 0);
    }
    return { label: day.date, weekday: day.weekday, total: dayTotalTokens(day), values };
  });

  let maxTokens = 0;
  for (const row of rows) {
    for (const model of top) {
      maxTokens = Math.max(maxTokens, row.values[model.key] ?? 0);
    }
  }

  return { models: top, rows, maxTokens };
}

const TOKEN_UNITS = [
  { limit: 1_000_000_000, divisor: 1_000_000_000, suffix: "B" },
  { limit: 1_000_000, divisor: 1_000_000, suffix: "M" },
  { limit: 1_000, divisor: 1_000, suffix: "K" },
];

export function formatTokenCompact(value: number): string {
  const magnitude = Math.abs(value);
  for (const unit of TOKEN_UNITS) {
    if (magnitude >= unit.limit) {
      const scaled = value / unit.divisor;
      return `${scaled >= 100 ? Math.round(scaled) : scaled.toFixed(1).replace(/\.0$/, "")}${unit.suffix}`;
    }
  }
  return String(Math.round(value));
}

export function formatPercent(locale: string, share: number): string {
  return new Intl.NumberFormat(locale, { style: "percent", maximumFractionDigits: 1 }).format(share);
}

export function formatFullDate(locale: string, iso: string): string {
  const date = new Date(`${iso}T00:00:00`);
  if (Number.isNaN(date.getTime())) return iso;
  return new Intl.DateTimeFormat(locale, { year: "numeric", month: "long", day: "numeric" }).format(date);
}
