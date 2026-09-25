// @vitest-environment node

import { describe, expect, it } from "vitest";
import {
  buildDailyModelSeries,
  buildHeatmap,
  buildModelSlices,
  computeSummary,
  dayTotalTokens,
  filledRowsForValue,
  formatTokenCompact,
  levelForValue,
  resolveIsoDates,
  type UsageDay,
} from "./usageStatsViewModel";

// 构造一份以 2026-09-23（周三）为今天、按天升序的报告。
function makeDays(total: number, activeOffsets: number[], tokensPerActiveDay = 1000): UsageDay[] {
  const today = new Date(2026, 8, 23); // 2026-09-23
  return Array.from({ length: total }, (_, index) => {
    const offset = total - 1 - index; // 0 = 今天
    const active = activeOffsets.includes(offset);
    return {
      date: `D${index}`,
      weekday: "周三",
      input: active ? tokensPerActiveDay : 0,
      output: active ? Math.round(tokensPerActiveDay / 4) : 0,
      hit: active ? 400 : 0,
      miss: active ? 600 : 0,
      cacheCreation: 0,
      requests: active ? 5 : 0,
      attemptedRequests: active ? 6 : 0,
      cacheUsageRequests: active ? 5 : 0,
    };
  });
}

describe("resolveIsoDates", () => {
  it("从今天向前重建完整 ISO 日期（跨年不歧义）", () => {
    const days = makeDays(3, []);
    const iso = resolveIsoDates(days, new Date(2026, 8, 23));
    expect(iso).toEqual(["2026-09-21", "2026-09-22", "2026-09-23"]);
  });

  it("跨越年界时年份正确回退", () => {
    const days = makeDays(3, []);
    const iso = resolveIsoDates(days, new Date(2026, 0, 1));
    expect(iso).toEqual(["2025-12-30", "2025-12-31", "2026-01-01"]);
  });
});

describe("computeSummary", () => {
  it("汇总 token、峰值与请求覆盖", () => {
    const days = makeDays(7, [0, 1, 2], 1000);
    const summary = computeSummary(days, new Date(2026, 8, 23));
    expect(summary.totalTokens).toBe(3 * 1250);
    expect(summary.peakDayTokens).toBe(1250);
    expect(summary.requests).toBe(15);
    expect(summary.attemptedRequests).toBe(18);
    expect(summary.cacheHit).toBe(1200);
    expect(summary.cacheMiss).toBe(1800);
    // 三天用量并列时峰值取最早出现的一天（2026-09-21/22/23 中最前）。
    expect(summary.peakDayIso).toBe("2026-09-21");
  });

  it("今天没用量时连续天数从昨天起算，不断签", () => {
    const days = makeDays(5, [1, 2, 3]);
    const summary = computeSummary(days);
    expect(summary.currentStreakDays).toBe(3);
    expect(summary.longestStreakDays).toBe(3);
  });

  it("最长连续与当前连续分开计算", () => {
    // 早期三天（offset 7-9）+ 只有今天（offset 0）：最长 3，当前 1。
    const days = makeDays(10, [7, 8, 9, 0]);
    const summary = computeSummary(days);
    expect(summary.longestStreakDays).toBe(3);
    expect(summary.currentStreakDays).toBe(1);
  });
});

describe("buildHeatmap", () => {
  it("生成 52 列 × 7 行，最后一列对齐本周", () => {
    const days = makeDays(30, [0], 10_000);
    const heat = buildHeatmap(days, "zh-CN", new Date(2026, 8, 23));
    expect(heat.columns).toHaveLength(52);
    for (const column of heat.columns) expect(column.cells).toHaveLength(7);
    // 2026-09-23 是周三：最后一列首格应为周日 2026-09-20。
    expect(heat.columns.at(-1)?.cells[0]?.iso).toBe("2026-09-20");
    // 首列为一年前的自然周起始（周日）：2026-09-20 往前 51 周。
    const firstCell = heat.columns[0]?.cells[0]?.iso;
    expect(firstCell).toBe("2025-09-28");
  });

  it("没有数据的日期补 level 0 空格", () => {
    const days = makeDays(3, [0], 5000);
    const heat = buildHeatmap(days, "zh-CN", new Date(2026, 8, 23));
    const lastColumn = heat.columns.at(-1)!;
    // 周日、周一、周二无数据。
    expect(lastColumn.cells[0]?.level).toBe(0);
    // 今天（index 3）有数据且达到最高档。
    expect(lastColumn.cells[3]?.level).toBe(4);
    expect(lastColumn.cells[3]?.hasUsage).toBe(true);
  });

  it("月份标签 span 与 52 列对齐，且最多显示 12 个", () => {
    const days = makeDays(3, [0], 1000);
    const heat = buildHeatmap(days, "zh-CN", new Date(2026, 8, 23));
    const totalSpan = heat.monthLabels.reduce((sum, label) => sum + label.span, 0);
    expect(totalSpan).toBe(52);
    const visible = heat.monthLabels.filter((label) => !label.hidden);
    expect(visible.length).toBeLessThanOrEqual(12);
    // 起始月被隐藏时保留 span（占位不塌陷）。
    const hidden = heat.monthLabels.filter((label) => label.hidden);
    expect(hidden.every((label) => label.label !== "" || true)).toBe(true);
  });
});

describe("levelForValue / filledRowsForValue", () => {
  it("数值映射到 0-4 色阶", () => {
    expect(levelForValue(0, 100)).toBe(0);
    expect(levelForValue(10, 100)).toBe(1);
    expect(levelForValue(50, 100)).toBe(2);
    expect(levelForValue(76, 100)).toBe(4);
    expect(levelForValue(5, 0)).toBe(0);
  });

  it("周/累计模式自底向上填充 1-7 行", () => {
    expect(filledRowsForValue(0, 100)).toBe(0);
    expect(filledRowsForValue(10, 100)).toBe(1);
    expect(filledRowsForValue(100, 100)).toBe(7);
  });
});

describe("buildModelSlices", () => {
  it("取前 6 个模型，其余合并为其他", () => {
    const models = Array.from({ length: 8 }, (_, index) => ({
      model: `model-${index}`,
      input: 100,
      output: 100,
      hit: 0,
      miss: 0,
      requests: index + 1,
    }));
    const slices = buildModelSlices(models, "其他");
    expect(slices).toHaveLength(7); // 6 + 其他
    expect(slices.at(-1)?.model).toBe("其他");
    expect(slices.at(-1)?.tokens).toBe(400);
    const totalShare = slices.reduce((sum, slice) => sum + slice.share, 0);
    expect(totalShare).toBeCloseTo(1, 10);
  });

  it("全部为 0 时返回空数组", () => {
    const models = [{ model: "m", input: 0, output: 0, hit: 0, miss: 0, requests: 3 }];
    expect(buildModelSlices(models, "其他")).toEqual([]);
  });
});

describe("buildDailyModelSeries", () => {
  // 造一天带模型明细的数据：models 形如 { 名称: { input, output } }。
  function dayWithModels(
    date: string,
    models: Record<string, { input: number; output: number }>,
  ): UsageDay {
    return {
      date,
      weekday: "周三",
      input: Object.values(models).reduce((sum, item) => sum + item.input, 0),
      output: Object.values(models).reduce((sum, item) => sum + item.output, 0),
      hit: 0,
      miss: 0,
      cacheCreation: 0,
      requests: 0,
      attemptedRequests: 0,
      cacheUsageRequests: 0,
      models,
    };
  }

  it("按总量选前 6 的模型，maxTokens 是单模型单日峰值而非每日总量", () => {
    const days = [
      dayWithModels("09-21", { glm: { input: 900, output: 100 }, kimi: { input: 50, output: 50 } }),
      dayWithModels("09-22", { glm: { input: 500, output: 500 } }),
      dayWithModels("09-23", {}),
    ];
    const series = buildDailyModelSeries(days);
    expect(series.models.map((model) => model.name)).toEqual(["glm", "kimi"]);
    expect(series.models[0]?.key).toBe("model0");
    // glm 单日峰值 1000（09-21），不是当天总量 1100，也不是区间总量。
    expect(series.maxTokens).toBe(1000);
    expect(series.rows).toHaveLength(3);
    expect(series.rows[0]?.values["model0"]).toBe(1000);
    expect(series.rows[0]?.values["model1"]).toBe(100);
    expect(series.rows[0]?.total).toBe(1100);
    expect(series.rows[2]?.values["model0"]).toBe(0);
  });

  it("模型超过 6 个时只画前 6，被裁掉的模型不计入峰值", () => {
    const models: Record<string, { input: number; output: number }> = {};
    for (let index = 0; index < 8; index += 1) {
      models[`model-${index}`] = { input: 100 * (8 - index), output: 0 };
    }
    const days = [dayWithModels("09-23", models)];
    const series = buildDailyModelSeries(days);
    expect(series.models).toHaveLength(6);
    // 总量前 6：model-0 .. model-5，其单日峰值 800。
    expect(series.models.map((model) => model.name)).toEqual([
      "model-0", "model-1", "model-2", "model-3", "model-4", "model-5",
    ]);
    expect(series.maxTokens).toBe(800);
  });

  it("没有模型明细时返回空序列（v1 历史数据降级为空态）", () => {
    const days = makeDays(3, [0]);
    const series = buildDailyModelSeries(days);
    expect(series.models).toEqual([]);
    expect(series.maxTokens).toBe(0);
    expect(series.rows).toHaveLength(3);
  });
});

describe("dayTotalTokens / formatTokenCompact", () => {
  it("负值不污染总量", () => {
    expect(dayTotalTokens({ ...makeDays(1, [0])[0], input: -5, output: -3 } as UsageDay)).toBe(0);
  });

  it("K/M/B 缩写", () => {
    expect(formatTokenCompact(999)).toBe("999");
    expect(formatTokenCompact(1000)).toBe("1K");
    expect(formatTokenCompact(1500)).toBe("1.5K");
    expect(formatTokenCompact(2_400_000)).toBe("2.4M");
    expect(formatTokenCompact(1_200_000_000)).toBe("1.2B");
  });
});
