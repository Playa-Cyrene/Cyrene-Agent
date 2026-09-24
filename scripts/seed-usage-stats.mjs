// scripts/seed-usage-stats.mjs
// 给 token-usage.json 注入测试数据，覆盖 2026-06-23 → 至今（默认 92 天）。
// 真实数据若已存在，仅覆盖本脚本的日期范围；窗口外的数据原样保留。
// 总 token 量约 100 亿，分布按工作日/周末、突发日/冷清日、模型权重混合。
//
// 用法：
//   node scripts/seed-usage-stats.mjs                    # 默认注入 2026-06-23 ~ today，96.6 亿 token
//   node scripts/seed-usage-stats.mjs --target 9660000000
//   node scripts/seed-usage-stats.mjs --start 2026-06-23 --end 2026-09-23
//   node scripts/seed-usage-stats.mjs --app-dir <name>   # 自定义 userData 子目录
//   node scripts/seed-usage-stats.mjs --file <absolute-path>
//   node scripts/seed-usage-stats.mjs --seed 12345       # 换一组随机数据

import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const APP_NAME = "live2d-cyrene"; // app.getName() 缺省返回 package.json#name
const FILE_NAME = "token-usage.json";

const args = parseArgs(process.argv.slice(2));
const targetTokens = Number.isFinite(Number(args.target)) ? Number(args.target) : 9_660_000_000;
const startDate = new Date(args.start ?? "2026-06-23T00:00:00");
const endDate = args.end ? new Date(`${args.end}T23:59:59`) : new Date();

// 模型分布（百分比为用户指定，总和 100%）。所有模型均标记为 rich，以满足
// 命中率 96% 的目标；MiniMax-M3 / glm-* 系列在缓存命中率与 cacheCreation 表现上更突出。
const MODELS = [
  { name: "MiniMax-M3",        weight: 0.334, cacheTone: "rich" },
  { name: "glm-5.2",           weight: 0.273, cacheTone: "rich" },
  { name: "glm-5.3",           weight: 0.226, cacheTone: "rich" },
  { name: "gpt-5.6-luna",      weight: 0.070, cacheTone: "rich" },
  { name: "deepseek-v4-flash", weight: 0.053, cacheTone: "rich" },
  { name: "mimo-2.5pro",       weight: 0.024, cacheTone: "rich" },
  { name: "gpt-5.6-sol",       weight: 0.020, cacheTone: "rich" },
];

// 把空时长按"4 天间隙 / 27 天活跃"周期铺：93 天 = 3 周期 = 81 活跃 + 12 空。
// 长期连续天数固定为 27。
const ACTIVE_STREAK_DAYS = 27;
const GAP_STREAK_DAYS = 4;
const CYCLE_DAYS = ACTIVE_STREAK_DAYS + GAP_STREAK_DAYS;

const filePath = resolveFilePath(args);
const existing = readExisting(filePath);
const seeded = generateDays(startDate, endDate, targetTokens, Number(args.seed) ?? 0xC0FFEE);

mergeAndWrite(filePath, existing, seeded);

printSummary(filePath, existing, seeded);

function parseArgs(argv) {
  const out = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith("--")) continue;
    const key = token.slice(2);
    const next = argv[index + 1];
    if (next && !next.startsWith("--")) {
      out[key] = next;
      index += 1;
    } else {
      out[key] = true;
    }
  }
  return out;
}

function resolveFilePath(args) {
  if (typeof args.file === "string") return args.file;
  const appDir = typeof args["app-dir"] === "string" ? args["app-dir"] : APP_NAME;
  const baseDir = process.platform === "win32"
    ? path.join(process.env.APPDATA || path.join(os.homedir(), "AppData/Roaming"), appDir)
    : process.platform === "darwin"
      ? path.join(os.homedir(), "Library/Application Support", appDir)
      : path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config"), appDir);
  return path.join(baseDir, FILE_NAME);
}

function readExisting(filePath) {
  try {
    const raw = fs.readFileSync(filePath, "utf8");
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && parsed.days && typeof parsed.days === "object") {
      return parsed;
    }
  } catch (err) {
    if (err && err.code !== "ENOENT") {
      console.warn("[seed] 读取已有 token-usage.json 失败，按空数据继续:", err.message);
    }
  }
  return { schemaVersion: 2, days: {} };
}

function mergeAndWrite(filePath, existing, seeded) {
  const preserved = { ...existing.days };
  let overwritten = 0;
  let added = 0;
  for (const [key, day] of Object.entries(seeded)) {
    if (key in preserved) overwritten += 1;
    else added += 1;
    preserved[key] = day;
  }
  const next = { schemaVersion: 2, days: preserved };
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const tmpPath = filePath + ".tmp";
  fs.writeFileSync(tmpPath, JSON.stringify(next, null, 2), "utf8");
  fs.renameSync(tmpPath, filePath);
  console.log(`[seed] 写入 ${filePath}`);
  console.log(`[seed] 新增 ${added} 天，覆盖 ${overwritten} 天，保留窗口外 ${Object.keys(preserved).length - added - overwritten} 天`);
}

function printSummary(filePath, existing, seeded) {
  const totalTokens = Object.values(seeded).reduce((sum, day) => sum + day.input + day.output, 0);
  const totalRequests = Object.values(seeded).reduce((sum, day) => sum + day.requests, 0);
  const totalHit = Object.values(seeded).reduce((sum, day) => sum + day.hit, 0);
  const totalMiss = Object.values(seeded).reduce((sum, day) => sum + day.miss, 0);
  const totalCacheRequests = Object.values(seeded).reduce((sum, day) => sum + (day.cacheUsageRequests ?? 0), 0);
  const days = Object.keys(seeded).sort();
  console.log(`[seed] 时间窗：${days[0]} ~ ${days.at(-1)}，共 ${days.length} 天`);
  console.log(`[seed] 累计 Token：${formatToken(totalTokens)}（输入 ${formatToken(Object.values(seeded).reduce((s, d) => s + d.input, 0))} / 输出 ${formatToken(Object.values(seeded).reduce((s, d) => s + d.output, 0))}）`);
  console.log(`[seed] 请求数：${totalRequests.toLocaleString()}（含未返回 usage 的 attempted：${Object.values(seeded).reduce((s, d) => s + (d.attemptedRequests ?? 0), 0).toLocaleString()}）`);
  console.log(`[seed] 缓存命中：${formatToken(totalHit)}（命中率 ${totalCacheRequests > 0 ? (totalHit / (totalHit + totalMiss) * 100).toFixed(1) : "--"}%）`);
  const modelTotals = new Map();
  for (const day of Object.values(seeded)) {
    if (!day.models) continue;
    for (const [model, value] of Object.entries(day.models)) {
      const entry = modelTotals.get(model) ?? { input: 0, output: 0 };
      entry.input += value.input;
      entry.output += value.output;
      modelTotals.set(model, entry);
    }
  }
  console.log("[seed] 模型分布：");
  const totalAll = [...modelTotals.values()].reduce((s, v) => s + v.input + v.output, 0);
  for (const [model, value] of [...modelTotals.entries()].sort((a, b) => (b[1].input + b[1].output) - (a[1].input + a[1].output))) {
    const share = totalAll > 0 ? (value.input + value.output) / totalAll * 100 : 0;
    console.log(`  - ${model.padEnd(20)} ${formatToken(value.input + value.output).padStart(10)}  (${share.toFixed(1)}%)`);
  }
}

function formatToken(value) {
  const magnitude = Math.abs(value);
  if (magnitude >= 1e9) return (value / 1e9).toFixed(2) + "B";
  if (magnitude >= 1e6) return (value / 1e6).toFixed(2) + "M";
  if (magnitude >= 1e3) return (value / 1e3).toFixed(1) + "K";
  return String(Math.round(value));
}

// ── 数据生成 ──────────────────────────────────────────

function generateDays(startDate, endDate, targetTokens, seedValue) {
  const days = listDates(startDate, endDate);
  const rng = mulberry32(seedValue);
  // 每个模型的每日基线 token 数，由模型权重 × 平均请求量推导。
  const modelDailyAvg = computeModelDailyBaseline(days, targetTokens);
  const out = {};
  for (let index = 0; index < days.length; index += 1) {
    const iso = days[index];
    // 间隙日：把当月所有输入输出写为 0，确保最长连续天数严格等于 ACTIVE_STREAK_DAYS。
    if (isGapDay(index)) {
      out[iso] = emptyDay();
      continue;
    }
    out[iso] = generateDay(iso, modelDailyAvg, rng);
  }
  // 把抖动带来的总量偏差收掉，按比例缩放活跃日的 token/请求计数，
  // 缓存命中率/模型分布等比例保持。
  normalizeTotals(out, targetTokens);
  return out;
}

function normalizeTotals(days, targetTokens) {
  let actual = 0;
  for (const day of Object.values(days)) actual += day.input + day.output;
  if (actual <= 0) return;
  const scale = targetTokens / actual;
  if (Math.abs(scale - 1) < 1e-6) return;
  for (const day of Object.values(days)) {
    if (day.input === 0 && day.output === 0 && day.requests === 0) continue; // gap 日不动
    day.input = Math.round(day.input * scale);
    day.output = Math.round(day.output * scale);
    day.hit = Math.round(day.hit * scale);
    day.miss = Math.round(day.miss * scale);
    day.cacheCreation = Math.round(day.cacheCreation * scale);
    day.requests = Math.max(1, Math.round(day.requests * scale));
    day.attemptedRequests = Math.max(day.requests, Math.round(day.attemptedRequests * scale));
    day.cacheUsageRequests = Math.round(day.cacheUsageRequests * scale);
    if (day.models) {
      for (const value of Object.values(day.models)) {
        value.input = Math.round(value.input * scale);
        value.output = Math.round(value.output * scale);
        value.hit = Math.round(value.hit * scale);
        value.miss = Math.round(value.miss * scale);
        value.cacheCreation = Math.round(value.cacheCreation * scale);
        value.requests = Math.max(1, Math.round(value.requests * scale));
        value.cacheUsageRequests = Math.round(value.cacheUsageRequests * scale);
        value.attemptedRequests = Math.max(value.requests, Math.round(value.attemptedRequests * scale));
      }
    }
  }
}

function isGapDay(index) {
  return index % CYCLE_DAYS >= ACTIVE_STREAK_DAYS;
}

function emptyDay() {
  return {
    input: 0,
    output: 0,
    hit: 0,
    miss: 0,
    cacheCreation: 0,
    requests: 0,
    attemptedRequests: 0,
    cacheUsageRequests: 0,
    models: {},
  };
}

function listDates(startDate, endDate) {
  const result = [];
  const cursor = new Date(startDate.getFullYear(), startDate.getMonth(), startDate.getDate());
  const end = new Date(endDate.getFullYear(), endDate.getMonth(), endDate.getDate());
  while (cursor.getTime() <= end.getTime()) {
    const y = cursor.getFullYear();
    const m = String(cursor.getMonth() + 1).padStart(2, "0");
    const d = String(cursor.getDate()).padStart(2, "0");
    result.push(`${y}-${m}-${d}`);
    cursor.setDate(cursor.getDate() + 1);
  }
  return result;
}

function computeModelDailyBaseline(days, targetTokens) {
  // 工作日总体比周末高 ~30%；叠加少量"突发日"和"冷清日"打散单调。
  // 分母只计活跃日（gap 日不算权重），避免活跃日被稀释导致总量低于目标。
  const perDay = {};
  const totalDayWeight = days.reduce(
    (sum, iso, index) =>
      isGapDay(index) ? sum : sum + (isWeekend(iso) ? 0.7 : 1.0) * dayAmplitude(iso),
    0,
  );
  const perDayAvg = targetTokens / totalDayWeight;
  for (let index = 0; index < days.length; index += 1) {
    const iso = days[index];
    if (isGapDay(index)) {
      perDay[iso] = 0;
      continue;
    }
    const weekday = isWeekend(iso) ? 0.7 : 1.0;
    perDay[iso] = perDayAvg * weekday * dayAmplitude(iso);
  }
  // 按模型权重拆到每个模型，但保持每个模型也随日浮动。
  const modelBaseline = {};
  for (const model of MODELS) {
    modelBaseline[model.name] = {};
    for (const iso of days) {
      modelBaseline[model.name][iso] = perDay[iso] * model.weight;
    }
  }
  return { perDay, modelBaseline };
}

function isWeekend(iso) {
  const date = new Date(`${iso}T00:00:00`);
  const day = date.getDay();
  return day === 0 || day === 6;
}

// 日级浮动：~70% 正常日、~15% 突发日（×2.5–4）、~15% 冷清日（×0.1–0.3）。
function dayAmplitude(iso) {
  // 用日期数字做种子，保证每次跑出来一致（脚本带 seed 参数可改）。
  const date = new Date(`${iso}T00:00:00`);
  const seed = date.getDate() * 31 + date.getMonth() * 131 + (date.getFullYear() - 2020);
  const r = mulberry32(seed)();
  if (r < 0.15) return 0.15 + mulberry32(seed + 1)() * 0.15; // 冷清
  if (r < 0.30) return 2.5 + mulberry32(seed + 2)() * 1.5;    // 突发
  return 0.75 + mulberry32(seed + 3)() * 0.5;                 // 正常
}

function generateDay(iso, baseline, rng) {
  const dayTotal = baseline.perDay[iso];
  let totalInput = 0;
  let totalOutput = 0;
  let totalHit = 0;
  let totalMiss = 0;
  let totalCacheCreation = 0;
  let totalRequests = 0;
  let totalAttemptedRequests = 0;
  let totalCacheUsageRequests = 0;
  const models = {};

  for (const model of MODELS) {
    // 单模型日内再撒点抖动。
    const jitter = 0.85 + rng() * 0.3;
    const modelDayTarget = baseline.modelBaseline[model.name][iso] * jitter;
    if (modelDayTarget <= 0) continue;

    const avgInputPerRequest = randIn(rng, 800, 2200);
    const avgOutputPerRequest = randIn(rng, 300, 900);
    const avgTokensPerRequest = avgInputPerRequest + avgOutputPerRequest;
    const modelRequests = Math.max(1, Math.round(modelDayTarget / avgTokensPerRequest));
    // 5% 概率请求未返回 usage。
    const coverageLoss = rng() < 0.05 ? randIn(rng, 5, 25) : 0;
    const modelAttempted = modelRequests + Math.round(coverageLoss);

    const modelInput = Math.round(modelRequests * avgInputPerRequest * (0.9 + rng() * 0.2));
    const modelOutput = Math.round(modelRequests * avgOutputPerRequest * (0.9 + rng() * 0.2));

    // 缓存命中：rich 模型全部固定在 96%（围绕 ±0.5% 抖动，整体仍稳定在 96%）。
    let modelHit = 0;
    let modelMiss = modelInput;
    let modelCacheCreation = 0;
    let modelCacheUsageRequests = 0;
    if (model.cacheTone !== "none") {
      const hitRate = 0.96 + (rng() - 0.5) * 0.01;
      modelHit = Math.round(modelInput * hitRate);
      modelMiss = modelInput - modelHit;
      modelCacheUsageRequests = modelRequests;
      // rich 模型上 35% 概率出现 cacheCreation（命中后被复用）。
      if (model.cacheTone === "rich" && rng() < 0.35) {
        modelCacheCreation = Math.round(modelHit * randIn(rng, 25, 55) / 100);
      }
    }

    models[model.name] = {
      input: modelInput,
      output: modelOutput,
      hit: modelHit,
      miss: modelMiss,
      cacheCreation: modelCacheCreation,
      requests: modelRequests,
      cacheUsageRequests: modelCacheUsageRequests,
      attemptedRequests: modelAttempted,
    };

    totalInput += modelInput;
    totalOutput += modelOutput;
    totalHit += modelHit;
    totalMiss += modelMiss;
    totalCacheCreation += modelCacheCreation;
    totalRequests += modelRequests;
    totalAttemptedRequests += modelAttempted;
    totalCacheUsageRequests += modelCacheUsageRequests;
  }

  return {
    input: totalInput,
    output: totalOutput,
    hit: totalHit,
    miss: totalMiss,
    cacheCreation: totalCacheCreation,
    requests: totalRequests,
    attemptedRequests: totalAttemptedRequests,
    cacheUsageRequests: totalCacheUsageRequests,
    models,
  };
}

function randIn(rng, min, max) {
  return rng() * (max - min) + min;
}

function mulberry32(seed) {
  let value = seed >>> 0;
  return function () {
    value = (value + 0x6D2B79F5) >>> 0;
    let t = value;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}