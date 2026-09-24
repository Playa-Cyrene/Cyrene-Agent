// 用量统计面板：汇总条 + Token 活动热力图 + 用量趋势 + 模型占比。
// 热力图为纯 DOM 自绘（参考 GitHub 贡献图），趋势图与甜甜圈复用 chart.js；
// 数据来自 window.tokenUsage.get(days)（主进程 token-usage.json）。

import Chart from "chart.js/auto";
import type { ChartConfiguration, ChartOptions } from "chart.js";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Alert, Button, Modal, Spin } from "antd";
import { BarChart3, Info, RefreshCcw } from "lucide-react";
import { useTranslation } from "../../i18n";
import { SettingsSegmented } from "../../components/ui/SettingsControls";
import {
  buildDailyModelSeries,
  buildHeatmap,
  buildModelSlices,
  computeSummary,
  dayTotalTokens,
  filledRowsForValue,
  formatFullDate,
  formatPercent,
  formatTokenCompact,
  levelForValue,
  type UsageDay,
  type UsageReport,
} from "./usageStatsViewModel";
import "./UsageStatsPanel.css";

// 52 周热力图需要一整年数据；主进程按 366 天上限裁剪。
const USAGE_FETCH_DAYS = 366;
const TREND_RANGES = [
  { value: "7", days: 7 },
  { value: "30", days: 30 },
  { value: "90", days: 90 },
] as const;
type TrendRange = (typeof TREND_RANGES)[number]["value"];

interface TokenUsageApi {
  get: (days: number) => Promise<UsageReport>;
  clear: () => Promise<void>;
}

function tokenUsageApi(): TokenUsageApi | undefined {
  return (window as unknown as { tokenUsage?: TokenUsageApi }).tokenUsage;
}

function formatFullNumber(value: number): string {
  return Math.round(value).toLocaleString();
}

function useChart(canvasRef: React.RefObject<HTMLCanvasElement | null>, config: ChartConfiguration | null): void {
  const chartRef = useRef<Chart | null>(null);
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !config) return;
    chartRef.current = new Chart(canvas, config);
    return () => {
      chartRef.current?.destroy();
      chartRef.current = null;
    };
  }, [canvasRef, config]);
}

export function UsageStatsPanel() {
  const { t, locale: i18nLocale } = useTranslation();
  const locale = i18nLocale || "zh-CN";
  const [report, setReport] = useState<UsageReport | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const [range, setRange] = useState<TrendRange>("30");
  const [heatMode, setHeatMode] = useState<"daily" | "weekly" | "cumulative">("daily");
  const [clearOpen, setClearOpen] = useState(false);
  const [clearing, setClearing] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const api = tokenUsageApi();
      if (!api) throw new Error("tokenUsage API unavailable");
      setReport(await api.get(USAGE_FETCH_DAYS));
      setLoadError(false);
    } catch {
      setLoadError(true);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const days = report?.days ?? [];
  const rangeDays = useMemo(() => days.slice(-Number(range)), [days, range]);
  const summary = useMemo(() => computeSummary(days), [days]);
  const heat = useMemo(() => buildHeatmap(days, locale), [days, locale]);
  const hasAnyData = days.some((day) => dayTotalTokens(day) > 0 || day.requests > 0 || day.attemptedRequests > 0);

  const cacheHitRate = useMemo(() => {
    if (summary.cacheUsageRequests <= 0 || summary.cacheHit + summary.cacheMiss <= 0) return null;
    return summary.cacheHit / (summary.cacheHit + summary.cacheMiss);
  }, [summary]);

  const summaryItems = [
    { label: t("settingsPage.usage.summaryTotalTokens"), value: formatTokenCompact(summary.totalTokens) },
    {
      label: t("settingsPage.usage.summaryPeakDay"),
      value: summary.peakDayTokens > 0 ? formatTokenCompact(summary.peakDayTokens) : "--",
      hint: summary.peakDayIso ? formatFullDate(locale, summary.peakDayIso) : undefined,
    },
    {
      label: t("settingsPage.usage.summaryRequests"),
      value: summary.attemptedRequests > 0
        ? `${formatFullNumber(summary.requests)} / ${formatFullNumber(summary.attemptedRequests)}`
        : formatFullNumber(summary.requests),
      hint: summary.attemptedRequests > 0 ? t("settingsPage.usage.requestsCoverage") : undefined,
    },
    {
      label: t("settingsPage.usage.summaryCacheHitRate"),
      value: cacheHitRate === null ? t("settingsPage.usage.cacheUnavailable") : formatPercent(locale, cacheHitRate),
      hint: cacheHitRate !== null && summary.cacheUsageRequests < summary.requests
        ? t("settingsPage.usage.cachePartial")
        : undefined,
    },
    { label: t("settingsPage.usage.summaryCurrentStreak"), value: `${summary.currentStreakDays} ${t("settingsPage.usage.unitDays")}` },
    { label: t("settingsPage.usage.summaryLongestStreak"), value: `${summary.longestStreakDays} ${t("settingsPage.usage.unitDays")}` },
  ];

  // 周/累计模式下重算列色阶：一列自底向上填充 filledRows 行。
  const displayColumns = useMemo(() => {
    if (heatMode === "daily") {
      return heat.columns.map((column) => ({
        key: column.key,
        cells: column.cells.map((cell) => ({ ...cell })),
        tooltip: null as string | null,
      }));
    }
    const weekly = heat.columns.map((column) => column.weeklyTokens);
    const values = heatMode === "weekly"
      ? weekly
      : weekly.reduce<number[]>((acc, value) => {
          acc.push((acc.at(-1) ?? 0) + value);
          return acc;
        }, []);
    const max = Math.max(0, ...values);
    return heat.columns.map((column, index) => {
      const value = values[index] ?? 0;
      const filled = filledRowsForValue(value, max);
      const level = levelForValue(value, max);
      const rangeStart = column.cells[0]?.iso ?? "";
      const rangeEnd = column.cells.at(-1)?.iso ?? "";
      return {
        key: column.key,
        cells: column.cells.map((cell, offset) => ({
          ...cell,
          level: offset >= 7 - filled ? level : 0,
          hasUsage: offset >= 7 - filled && value > 0,
        })),
        tooltip: `${formatFullDate(locale, rangeStart)} ~ ${formatFullDate(locale, rangeEnd)}：${formatTokenCompact(value)} Token`,
      };
    });
  }, [heat, heatMode, locale]);

  return (
    <div className="cy-usage">
      <h1>{t("settingsPage.usage.title")}</h1>
      <p className="cy-settings-intro">{t("settingsPage.usage.description")}</p>

      {loadError && <Alert className="cy-settings-alert" type="error" showIcon message={t("settingsPage.usage.loadFailed")} />}

      {loading && !report ? (
        <div className="cy-settings-loading"><Spin /></div>
      ) : !hasAnyData ? (
        <section className="cy-settings-section">
          <div className="cy-usage-empty">
            <BarChart3 size={36} aria-hidden="true" />
            <strong>{t("settingsPage.usage.emptyTitle")}</strong>
            <span>{t("settingsPage.usage.emptyDescription")}</span>
          </div>
        </section>
      ) : (
        <>
          <section className="cy-settings-section">
            <div className="cy-usage-summary" role="list">
              {summaryItems.map((item) => (
                <div key={item.label} className="cy-usage-summary__item" role="listitem">
                  <div className="cy-usage-summary__value">
                    {item.value}
                    {item.hint ? (
                      <span className="cy-usage-summary__hint" title={item.hint} tabIndex={0} aria-label={item.hint}>
                        <Info size={13} aria-hidden="true" />
                      </span>
                    ) : null}
                  </div>
                  <div className="cy-usage-summary__label">{item.label}</div>
                </div>
              ))}
            </div>
          </section>

          <section className="cy-settings-section">
            <div className="cy-settings-section__heading">
              <h2>{t("settingsPage.usage.heatmapTitle")}</h2>
            </div>
            <div className="cy-settings-card cy-usage-heatmap">
              <div className="cy-usage-heatmap__toolbar">
                <SettingsSegmented
                  className="cy-usage-heatmap__mode-selector"
                  size="small"
                  value={heatMode}
                  onChange={(value) => setHeatMode(value as typeof heatMode)}
                  options={[
                    { value: "daily", label: t("settingsPage.usage.heatmapModeDaily") },
                    { value: "weekly", label: t("settingsPage.usage.heatmapModeWeekly") },
                    { value: "cumulative", label: t("settingsPage.usage.heatmapModeCumulative") },
                  ]}
                />
                <div className="cy-usage-heatmap__legend" aria-hidden="true">
                  <span>{t("settingsPage.usage.heatmapLess")}</span>
                  {[0, 1, 2, 3, 4].map((level) => (
                    <span key={level} className={`cy-usage-heat-cell cy-usage-heat-cell--level-${level}`} />
                  ))}
                  <span>{t("settingsPage.usage.heatmapMore")}</span>
                </div>
              </div>
              <div className="cy-usage-heatmap__scroll">
                <div className="cy-usage-heatmap__grid" data-testid="usage-heatmap">
                  {displayColumns.map((column) => (
                    <div
                      key={column.key}
                      className={`cy-usage-heatmap__column ${heatMode !== "daily" ? "is-column-hover" : ""}`}
                      title={column.tooltip ?? undefined}
                    >
                      {column.cells.map((cell) => {
                        const title = cell.hasUsage
                          ? `${formatFullDate(locale, cell.iso)}：${formatFullNumber(cell.tokens)} Token · ${formatFullNumber(cell.requests)} ${t("settingsPage.usage.unitRequests")}`
                          : formatFullDate(locale, cell.iso);
                        return (
                          <span
                            key={cell.key}
                            className={`cy-usage-heat-cell cy-usage-heat-cell--level-${cell.level} ${cell.hasUsage ? "cy-usage-heat-cell--used" : ""}`}
                            title={title}
                          />
                        );
                      })}
                    </div>
                  ))}
                </div>
                <div className="cy-usage-heatmap__months">
                  {heat.monthLabels.map((label) => (
                    <span
                      key={label.key}
                      className="cy-usage-heatmap__month"
                      style={{ gridColumn: `span ${label.span}` }}
                    >
                      {label.hidden ? "" : label.label}
                    </span>
                  ))}
                </div>
              </div>
            </div>
          </section>

          <section className="cy-settings-section">
            <div className="cy-settings-section__heading">
              <h2>{t("settingsPage.usage.trendsTitle")}</h2>
            </div>
            <div className="cy-settings-card cy-usage-card">
              <div className="cy-usage-card__toolbar">
                <SettingsSegmented
                  size="small"
                  value={range}
                  onChange={(value) => setRange(value as TrendRange)}
                  options={TREND_RANGES.map((item) => ({ value: item.value, label: t(`settingsPage.usage.range${item.value}`) }))}
                />
              </div>
              <TrendChart days={rangeDays} t={t} />
            </div>
          </section>

          <section className="cy-settings-section">
            <div className="cy-settings-section__heading">
              <h2>{t("settingsPage.usage.modelsTitle")}</h2>
            </div>
            <div className="cy-settings-card cy-usage-card">
              <ModelDonut models={report?.models ?? []} locale={locale} t={t} />
            </div>
          </section>
        </>
      )}

      <div className="cy-settings-form-footer cy-usage-footer">
        <Button icon={<RefreshCcw size={14} />} loading={loading} onClick={() => void load()}>
          {t("settingsPage.usage.refresh")}
        </Button>
        <Button danger disabled={!hasAnyData} loading={clearing} onClick={() => setClearOpen(true)}>
          {t("settingsPage.usage.clear")}
        </Button>
      </div>

      <Modal
        open={clearOpen}
        title={t("settingsPage.usage.clearTitle")}
        okText={t("settingsPage.usage.clearConfirm")}
        cancelText={t("settingsPage.usage.cancel")}
        okButtonProps={{ danger: true, loading: clearing }}
        onOk={async () => {
          setClearing(true);
          try {
            await tokenUsageApi()?.clear();
            setClearOpen(false);
            await load();
          } finally {
            setClearing(false);
          }
        }}
        onCancel={() => setClearOpen(false)}
      >
        <p>{t("settingsPage.usage.clearMessage")}</p>
      </Modal>
    </div>
  );
}

const CHART_TICK_COLOR = "rgba(120, 110, 130, 0.75)";
const CHART_GRID_COLOR = "rgba(120, 110, 130, 0.14)";

// chart.js 动画上下文运行时带 index 字段（官方 Progressive Line 示例的用法，类型定义里没声明），此处收窄。
interface LineAnimCtx {
  type?: string;
  index?: number;
  datasetIndex?: number;
  xStarted?: boolean;
  yStarted?: boolean;
  chart?: Chart;
}

/**
 * 从左到右逐点生长的线条动画（对齐 ZCode/recharts 的折线出场观感，
 * 思路来自 chart.js 官方 Progressive Line 示例）：每个点的动画等前一点
 * 画完才开始（按 index 递增 delay），整条线在总时长内从左画到右。
 */
function progressiveLineAnimation(pointCount: number, totalDuration = 600): ChartOptions["animation"] {
  const delayBetweenPoints = totalDuration / Math.max(pointCount, 1);
  const asAnimCtx = (ctx: unknown): LineAnimCtx => ctx as LineAnimCtx;
  // chart.js 运行时支持按 x/y 像素属性定义动画（官方示例用法），但类型定义未声明这两个 key，需要断言。
  return {
    x: {
      type: "number" as const,
      easing: "linear" as const,
      duration: delayBetweenPoints,
      // NaN 表示沿用前一个点的 x 像素作为起点，线段向右续接。
      from: Number.NaN,
      delay(ctx: unknown) {
        const anim = asAnimCtx(ctx);
        if (anim.type !== "data" || anim.xStarted) return 0;
        anim.xStarted = true;
        return (anim.index ?? 0) * delayBetweenPoints;
      },
    },
    y: {
      type: "number" as const,
      easing: "linear" as const,
      duration: delayBetweenPoints,
      // 每个点从它前一个点的 y 位置出发，第一个点直接就位。
      from(ctx: unknown) {
        const anim = asAnimCtx(ctx);
        if (anim.type !== "data" || !anim.chart || (anim.index ?? 0) === 0) return undefined;
        const previous = anim.chart.getDatasetMeta(anim.datasetIndex ?? 0).data[(anim.index ?? 0) - 1];
        return previous ? previous.getProps(["y"], true).y : undefined;
      },
      delay(ctx: unknown) {
        const anim = asAnimCtx(ctx);
        if (anim.type !== "data" || anim.yStarted) return 0;
        anim.yStarted = true;
        return (anim.index ?? 0) * delayBetweenPoints;
      },
    },
  } as unknown as ChartOptions["animation"];
}

/**
 * X 轴刻度显示规则（对齐 ZCode）：首尾必显示——最右侧永远是今天；
 * 中间按点数每隔 5 或 7 个取一个，14 个点以内全部显示。
 */
function shouldShowTrendAxisLabel(index: number, total: number): boolean {
  if (total <= 14) return true;
  const step = total > 45 ? 7 : 5;
  return index === 0 || index === total - 1 || index % step === 0;
}

function TrendChart({ days, t }: { days: UsageDay[]; t: (key: string) => string }) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const series = useMemo(() => buildDailyModelSeries(days), [days]);
  const config = useMemo<ChartConfiguration | null>(() => {
    if (series.models.length === 0 || series.maxTokens <= 0) return null;
    return {
      type: "line",
      data: {
        labels: series.rows.map((row) => row.label),
        datasets: series.models.map((model) => ({
          label: model.name,
          data: series.rows.map((row) => row.values[model.key] ?? 0),
          borderColor: model.color,
          backgroundColor: model.color,
          fill: false,
          tension: 0.35,
          borderWidth: 2,
          pointRadius: 0,
          pointHoverRadius: 4,
        })),
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        // 线条从左到右逐点生长（ZCode 同款出场动画）。
        animation: progressiveLineAnimation(series.rows.length),
        interaction: { mode: "index", intersect: false },
        plugins: {
          legend: { display: false },
          tooltip: {
            // 0 用量的模型没有可见趋势点，进 tooltip 只会误导（对齐 ZCode 的过滤逻辑）。
            filter: (item) => Number(item.parsed?.y) > 0,
            callbacks: {
              title: (items) => {
                const row = series.rows[items[0]?.dataIndex ?? 0];
                return row ? `${row.label} ${row.weekday} · ${formatTokenCompact(row.total)} Token` : "";
              },
              label: (item) => {
                const model = series.models[item.datasetIndex];
                return model ? `${model.name}: ${formatTokenCompact(Number(item.parsed?.y ?? 0))}` : "";
              },
              labelColor: (item) => {
                const color = series.models[item.datasetIndex]?.color ?? "#ec4899";
                return { borderColor: color, backgroundColor: color, borderWidth: 0, borderRadius: 2 };
              },
            },
          },
        },
        scales: {
          x: {
            grid: { display: false },
            // 关掉 chart.js 的 autoSkip（它挑的最后一个标签会落在今天之前），
            // 用 ZCode 的首尾必显示规则，保证最右侧标签始终是今天。
            ticks: {
              color: CHART_TICK_COLOR,
              font: { size: 10 },
              maxRotation: 0,
              autoSkip: false,
              callback: (_value: string | number, index: number) => {
                const row = series.rows[index];
                return row && shouldShowTrendAxisLabel(index, series.rows.length) ? row.label : "";
              },
            },
          },
          y: {
            // 左侧不显示挡位刻度（对齐 ZCode 的 YAxis hide），只保留横向虚线网格。
            beginAtZero: true,
            max: series.maxTokens,
            ticks: { display: false },
            border: { display: false },
            grid: { color: CHART_GRID_COLOR, borderDash: [3, 3] },
          },
        },
      },
    };
  }, [series]);
  useChart(canvasRef, config);

  if (series.models.length === 0 || series.maxTokens <= 0) {
    return <p className="cy-usage-models__empty">{t("settingsPage.usage.modelsEmpty")}</p>;
  }

  return (
    <>
      <div className="cy-usage-chart__legend" role="list">
        {series.models.map((model) => (
          <div key={model.key} role="listitem">
            <span className="cy-usage-chart__legend-dot" style={{ backgroundColor: model.color }} aria-hidden="true" />
            <span className="cy-usage-chart__legend-name" title={model.name}>{model.name}</span>
          </div>
        ))}
      </div>
      <div className="cy-usage-chart">
        <canvas ref={canvasRef} aria-label={t("settingsPage.usage.trendsTitle")} role="img" />
      </div>
    </>
  );
}

const DONUT_CENTER_TEXT_COLOR = "var(--rb-text-primary, #0d0d0d)";

function ModelDonut({ models, locale, t }: { models: UsageReport["models"]; locale: string; t: (key: string) => string }) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const slices = useMemo(() => buildModelSlices(models, t("settingsPage.usage.modelsOther")), [models, t]);
  const config = useMemo<ChartConfiguration | null>(() => {
    if (slices.length === 0) return null;
    return {
      type: "doughnut",
      data: {
        labels: slices.map((slice) => slice.model),
        datasets: [{
          data: slices.map((slice) => slice.tokens),
          backgroundColor: slices.map((slice) => slice.color),
          borderWidth: 2,
          // 透明描边透出卡片底色，扇区间形成跟主题无关的缝隙（对齐 ZCode 的 stroke=surface）。
          borderColor: "transparent",
        }],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        cutout: "68%",
        plugins: {
          legend: { display: false },
          tooltip: {
            callbacks: {
              label: (item) => `${item.label}: ${formatTokenCompact(Number(item.raw))} Token (${formatPercent(locale, slices[item.dataIndex]?.share ?? 0)})`,
            },
          },
        },
      },
    };
  }, [slices, locale]);
  useChart(canvasRef, config);
  const total = slices.reduce((sum, slice) => sum + slice.tokens, 0);

  if (slices.length === 0) {
    return <p className="cy-usage-models__empty">{t("settingsPage.usage.modelsEmpty")}</p>;
  }

  return (
    <div className="cy-usage-models">
      <div className="cy-usage-models__donut">
        <canvas ref={canvasRef} aria-label={t("settingsPage.usage.modelsTitle")} role="img" />
        <div className="cy-usage-models__center" style={{ color: DONUT_CENTER_TEXT_COLOR }}>
          <strong>{formatTokenCompact(total)}</strong>
          <span>Token</span>
        </div>
      </div>
      <div className="cy-usage-models__list" role="list">
        {slices.map((slice) => (
          <div key={slice.model} className="cy-usage-models__row" role="listitem">
            <span className="cy-usage-models__dot" style={{ backgroundColor: slice.color }} aria-hidden="true" />
            <span className="cy-usage-models__name" title={slice.model}>{slice.model}</span>
            <span className="cy-usage-models__share">{formatPercent(locale, slice.share)}</span>
            <span className="cy-usage-models__tokens">{formatTokenCompact(slice.tokens)} Token</span>
          </div>
        ))}
      </div>
    </div>
  );
}
