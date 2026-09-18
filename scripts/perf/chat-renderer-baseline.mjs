// 阶段 0 聊天渲染性能基线 runner。
// 流程：按需构建两版产物（B=普通生产构建 / A=react-dom/profiling 构建，经 vite env 门控）
// → 本地静态服务器 → Playwright 驱动 fixture 矩阵（固定 seed 可重放）
// → 每页等待 window.__perfDone 报告 + CDP Performance 指标水合后差值
// → 每配置取中位数聚合，写 JSON 报告并打印控制台摘要。
//
// 用法：
//   npm run perf:chat-baseline                    # 完整基线（B: 3数据集×2规模×2滚动×5次；A: 缩减矩阵×3次）
//   npm run perf:chat-baseline -- --smoke         # 冒烟：单配置验证全链路（构建+驱动+报告）
//   npm run perf:chat-baseline -- --runs 1 --only-b  # 快速验证：B 通道 12 配置各 1 次（探针计数确定性高，阶段间验证用）
//   npm run perf:chat-baseline -- --skip-build    # 复用已有 dist/perf-* 产物（调试 harness 用）
//   npm run perf:chat-baseline -- --out <file>    # 指定报告输出路径
//   # A0 归因实验：覆盖矩阵 + 流式渲染形态对照组（animated=现状 / static=关动画 / plain=纯文本绕过 XMarkdown）
//   npm run perf:chat-baseline -- --skip-build --only-b --runs 3 --datasets markdown,mixed --counts 0,200,500 --scrolls bottom --stream-render static --out docs/internal-issue/perf/a0-static-report.json
//   # A1-S 成对对照：animated 与 streamdown 交替同场各 3 次（先跑顺序逐轮互换），只跑通道 B
//   npm run perf:chat-baseline -- --paired-control --out docs/internal-issue/perf/a1-s-streamdown-report.json

import { spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, extname, join, normalize, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));

// ── 参数 ──

const args = process.argv.slice(2);
const smoke = args.includes("--smoke");
const skipBuild = args.includes("--skip-build");
const onlyB = args.includes("--only-b");
const runsIndex = args.indexOf("--runs");
const runsOverride = runsIndex >= 0 ? Number.parseInt(args[runsIndex + 1] ?? "", 10) : undefined;
const outIndex = args.indexOf("--out");
const outOverride = outIndex >= 0 ? args[outIndex + 1] : undefined;

// A0 归因实验：覆盖默认矩阵与流式渲染形态（经 URL 参数传给 harness，见 react-perf/main.tsx）
const listArg = (flag) => {
  const index = args.indexOf(flag);
  return index >= 0 ? (args[index + 1] ?? "").split(",").map((s) => s.trim()).filter(Boolean) : undefined;
};
const datasetsOverride = listArg("--datasets");
const scrollsOverride = listArg("--scrolls");
const countsIndex = args.indexOf("--counts");
const countsOverride = countsIndex >= 0
  ? (args[countsIndex + 1] ?? "").split(",").map((s) => Number.parseInt(s.trim(), 10)).filter((n) => Number.isFinite(n) && n >= 0)
  : undefined;
const streamRenderIndex = args.indexOf("--stream-render");
const streamRenderOverride = streamRenderIndex >= 0 ? args[streamRenderIndex + 1] : undefined;
const STREAM_RENDER_MODES = new Set(["animated", "static", "plain", "streamdown"]);
if (streamRenderOverride !== undefined && !STREAM_RENDER_MODES.has(streamRenderOverride)) {
  throw new Error(`--stream-render 仅支持 animated/static/plain/streamdown，收到: ${streamRenderOverride}`);
}
const STREAM_RENDER = streamRenderOverride ?? "animated";

// A1-S 成对对照：同一 (dataset,count) 内 animated 与 streamdown 交替同场跑（每轮先跑的渲染器互换），
// 抵制后台负载与时间漂移污染——A0 已证明顺序执行跨数小时的对比不可靠
const pairedControl = args.includes("--paired-control");
const PAIRED_MODES = ["animated", "streamdown"];

// ── 矩阵 ──

const SEED = 42;
// 流式脚本时长：完整基线 15s（几百个 delta，接近真实长回复）；冒烟 6s 只验证链路
const DURATION_MS = smoke ? 6_000 : 15_000;

// A1-S 成对对照矩阵：markdown/mixed × 0/200/500 × bottom × 3 轮交替（--datasets/--counts 可覆盖）。
// 只跑通道 B（profiling 构建的开销会污染对照；帧/CDP/探针指标 B 通道齐全）
const B_MATRIX = pairedControl
  ? {
      datasets: datasetsOverride ?? ["markdown", "mixed"],
      counts: countsOverride ?? [0, 200, 500],
      scrolls: ["bottom"],
      runs: 3,
      pairedControl: true,
    }
  : smoke
    ? { datasets: ["mixed"], counts: [200], scrolls: ["bottom"], runs: 1, streamRender: STREAM_RENDER }
    : {
        // A0 归因实验经 --datasets/--counts/--scrolls 覆盖（例：markdown,mixed × 0,200,500 × bottom）
        datasets: datasetsOverride ?? ["plain", "markdown", "mixed"],
        counts: countsOverride ?? [200, 500],
        scrolls: scrollsOverride ?? ["bottom", "top"],
        runs: Number.isFinite(runsOverride) && runsOverride > 0 ? runsOverride : 5,
        streamRender: STREAM_RENDER,
      };

// A 通道（profiling 构建）有额外开销，绝对时长偏慢，只用于 React 侧指标（commit 频率/时长、探针计数），
// 矩阵缩减到最重配置
const A_MATRIX = smoke
  ? { datasets: ["mixed"], counts: [200], scrolls: ["bottom"], runs: 1, streamRender: STREAM_RENDER }
  : { datasets: ["plain", "markdown", "mixed"], counts: [500], scrolls: ["bottom"], runs: 3, streamRender: STREAM_RENDER };

const B_OUT_DIR = "dist/perf-normal";
const A_OUT_DIR = "dist/perf-profiling";
const PORT_B = 5199;
const PORT_A = 5200;

// ── 构建 ──

function buildChannel(outDirRelative, profile) {
  console.log(`[build] 通道 ${profile ? "A（react-dom/profiling）" : "B（普通生产）"} → ${outDirRelative}`);
  const viteBin = join(ROOT, "node_modules", "vite", "bin", "vite.js");
  if (!existsSync(viteBin)) throw new Error(`未找到 vite：${viteBin}`);
  const env = {
    ...process.env,
    CYRENE_PERF_HARNESS: "1",
    CYRENE_PERF_OUT_DIR: outDirRelative,
    ...(profile ? { CYRENE_PERF_PROFILE: "1" } : {}),
  };
  const result = spawnSync(process.execPath, [viteBin, "build"], { cwd: ROOT, stdio: "inherit", env });
  if (result.status !== 0) throw new Error(`vite build 失败（${outDirRelative}）`);
}

// ── 静态服务器 ──

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript",
  ".mjs": "text/javascript",
  ".css": "text/css",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".otf": "font/otf",
  ".ico": "image/x-icon",
  ".txt": "text/plain; charset=utf-8",
};

function startStaticServer(rootDir, port) {
  const normalizedRoot = normalize(rootDir);
  const server = createServer((req, res) => {
    try {
      const url = new URL(req.url ?? "/", "http://localhost");
      let filePath = normalize(join(rootDir, decodeURIComponent(url.pathname)));
      if (!filePath.startsWith(normalizedRoot)) {
        res.writeHead(403).end("forbidden");
        return;
      }
      if (url.pathname.endsWith("/")) filePath = join(filePath, "index.html");
      if (!existsSync(filePath) || !statSync(filePath).isFile()) {
        res.writeHead(404).end("not found");
        return;
      }
      res
        .writeHead(200, { "content-type": MIME[extname(filePath).toLowerCase()] ?? "application/octet-stream" })
        .end(readFileSync(filePath));
    } catch {
      res.writeHead(500).end();
    }
  });
  return new Promise((resolveStart, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => resolveStart(server));
  });
}

// ── CDP 指标 ──

const CDP_METRICS = [
  "TaskDuration",
  "ScriptDuration",
  "LayoutDuration",
  "RecalcStyleDuration",
  "LayoutCount",
  "RecalcStyleCount",
];

function toMetricMap(result) {
  const map = {};
  for (const metric of result.metrics) map[metric.name] = metric.value;
  return map;
}

/** 水合后差值：只统计流式窗口内（含发送驱动）的任务/布局/样式开销 */
function diffMetrics(before, after) {
  const diff = {};
  for (const name of CDP_METRICS) {
    if (typeof before[name] === "number" && typeof after[name] === "number") {
      diff[name] = Math.round((after[name] - before[name]) * 1000) / 1000;
    }
  }
  return diff;
}

// ── 单页执行 ──

async function runCase(context, baseUrl, { dataset, count, scroll, streamRender }) {
  const page = await context.newPage();
  const cdp = await context.newCDPSession(page);
  await cdp.send("Performance.enable");
  const url = `${baseUrl}/react-perf/index.html?dataset=${dataset}&count=${count}&seed=${SEED}&duration=${DURATION_MS}&scroll=${scroll}&streamRender=${streamRender ?? "animated"}`;
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60_000 });

  await page.waitForFunction(() => window.__perfHydrated === true, null, { timeout: 120_000 });
  const metricsBefore = toMetricMap(await cdp.send("Performance.getMetrics"));

  const doneHandle = await page.waitForFunction(
    () => (window.__perfDone !== undefined && window.__perfDone !== null ? window.__perfDone : null),
    null,
    { timeout: DURATION_MS + 150_000 },
  );
  const report = await doneHandle.jsonValue();
  const metricsAfter = toMetricMap(await cdp.send("Performance.getMetrics"));
  await page.close();

  if (!report || report.ok !== true) {
    throw new Error(`harness 报告失败: ${report && typeof report === "object" ? report.error : "无报告"}`);
  }
  return { ...report, cdp: diffMetrics(metricsBefore, metricsAfter) };
}

// ── 聚合 ──

function pick(obj, path) {
  return path.split(".").reduce((acc, key) => (acc == null ? undefined : acc[key]), obj);
}

function median(values) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

// 聚合指标路径：每配置对 5（或 3）次 run 取中位数
const AGG_PATHS = [
  "timings.firstBubbleMs",
  "timings.hydratedMs",
  "userChannel.frameTimesDuringStreaming.median",
  "userChannel.frameTimesDuringStreaming.p95",
  "userChannel.frameTimesDuringStreaming.max",
  "userChannel.longTasks.median",
  "userChannel.longTasks.max",
  "userChannel.longTasks.countOver32ms",
  "userChannel.longTasks.countOver100ms",
  "userChannel.eventToPaint.median",
  "userChannel.eventToPaint.p95",
  "userChannel.eventToPaint.max",
  "reactChannel.commitsDuringStreaming.commitCount",
  "reactChannel.commitsDuringStreaming.commitsPerSecond",
  "reactChannel.commitsDuringStreaming.median",
  "reactChannel.commitsDuringStreaming.p95",
  "reactChannel.probeDeltaDuringStreaming.markdownRenders",
  // A0 归因实验：列表外壳（Bubble.List + 全部 footer）执行次数，补 markdownRenders 覆盖不到的路径
  "reactChannel.probeDeltaDuringStreaming.listRenders",
  // nav/side 验收口径：事件流到达期间（RUN_FINISHED 后的合法列表刷新不计入流式成本）
  "reactChannel.probeDeltaDuringEventStream.navigationRenders",
  "reactChannel.probeDeltaDuringEventStream.sidebarRenders",
  "reactChannel.expectedDeltaEvents",
  "memory.heapUsedAfterHydrationBytes",
  "memory.heapUsedFinalBytes",
  "memory.domNodeCountFinal",
  "cdp.TaskDuration",
  "cdp.ScriptDuration",
  "cdp.LayoutDuration",
  "cdp.RecalcStyleDuration",
  "cdp.LayoutCount",
  "cdp.RecalcStyleCount",
];

function aggregateRuns(runs) {
  const aggregated = {};
  for (const path of AGG_PATHS) {
    const values = runs.map((run) => pick(run, path)).filter((value) => typeof value === "number");
    aggregated[path] = median(values);
  }
  return aggregated;
}

// ── 矩阵执行 ──

async function runMatrix(browser, baseUrl, matrix, channelLabel) {
  const perConfig = [];
  for (const dataset of matrix.datasets) {
    for (const count of matrix.counts) {
      for (const scroll of matrix.scrolls) {
        const configLabel = `${dataset}/${count}/${scroll}`;
        if (matrix.pairedControl) {
          // A1-S 成对对照：每轮内两个渲染器先后各跑一次，奇偶轮互换先跑顺序，
          // 两组各自凑满 matrix.runs 次后取中位数——同构建/同 seed/同浏览器的同场对比
          const runsByMode = { animated: [], streamdown: [] };
          for (let round = 0; round < matrix.runs; round++) {
            const order = round % 2 === 0 ? PAIRED_MODES : [...PAIRED_MODES].reverse();
            for (const mode of order) {
              const context = await browser.newContext();
              const pairedConfig = { dataset, count, scroll, streamRender: mode };
              try {
                try {
                  runsByMode[mode].push(await runCase(context, baseUrl, pairedConfig));
                } catch (error) {
                  console.log(`  [${channelLabel}] ${configLabel} ${mode} 轮 ${round + 1} 失败，重试: ${error.message}`);
                  runsByMode[mode].push(await runCase(context, baseUrl, pairedConfig));
                }
                console.log(`  [${channelLabel}] ${configLabel} ${mode} 轮 ${round + 1}/${matrix.runs} 完成`);
              } finally {
                await context.close();
              }
            }
          }
          for (const mode of PAIRED_MODES) {
            perConfig.push({
              params: { dataset, count, scroll, streamRender: mode },
              aggregated: aggregateRuns(runsByMode[mode]),
              runs: runsByMode[mode],
            });
          }
          continue;
        }
        const config = { dataset, count, scroll, streamRender: matrix.streamRender ?? "animated" };
        const runs = [];
        for (let i = 0; i < matrix.runs; i++) {
          const context = await browser.newContext();
          try {
            // 失败重试一次：偶发调度抖动不至于废掉整轮基线
            try {
              runs.push(await runCase(context, baseUrl, config));
            } catch (error) {
              console.log(`  [${channelLabel}] ${configLabel} #${i + 1} 失败，重试: ${error.message}`);
              runs.push(await runCase(context, baseUrl, config));
            }
            console.log(`  [${channelLabel}] ${configLabel} #${i + 1}/${matrix.runs} 完成`);
          } finally {
            await context.close();
          }
        }
        perConfig.push({ params: config, aggregated: aggregateRuns(runs), runs });
      }
    }
  }
  return perConfig;
}

/** A1-S 成对对照汇总：每配置输出 animated/streamdown 关键指标中位数与相对降幅 */
function buildPairedComparisons(perConfig) {
  const byConfig = new Map();
  for (const entry of perConfig) {
    const key = `${entry.params.dataset}/${entry.params.count}/${entry.params.scroll}`;
    if (!byConfig.has(key)) byConfig.set(key, {});
    byConfig.get(key)[entry.params.streamRender ?? "animated"] = entry.aggregated;
  }
  const metrics = [
    ["frameP95ms", "userChannel.frameTimesDuringStreaming.p95"],
    ["evtP95ms", "userChannel.eventToPaint.p95"],
    ["scriptS", "cdp.ScriptDuration"],
    ["mdDelta", "reactChannel.probeDeltaDuringStreaming.markdownRenders"],
    ["domFinal", "memory.domNodeCountFinal"],
  ];
  const comparisons = [];
  for (const [key, agg] of byConfig) {
    const animated = agg.animated;
    const streamdown = agg.streamdown;
    if (!animated || !streamdown) continue;
    const entry = { config: key };
    for (const [label, path] of metrics) {
      const a = animated[path];
      const s = streamdown[path];
      entry[label] = { animated: a, streamdown: s };
      if (typeof a === "number" && typeof s === "number" && a > 0) {
        entry[label].reductionPct = Math.round(((a - s) / a) * 1000) / 10;
      }
    }
    comparisons.push(entry);
  }
  return comparisons;
}

function printPairedSummary(report, outPath) {
  console.log("\n================ A1-S 成对对照摘要（animated vs streamdown，各 3 次中位数） ================");
  const header = ["config", "frameP95 anim", "frameP95 sd", "frame降幅%", "evtP95 anim", "evtP95 sd", "scriptS anim", "scriptS sd", "script降幅%"];
  const widths = [18, 13, 12, 10, 12, 11, 13, 12, 11];
  console.log(header.map((h, i) => h.padEnd(widths[i])).join(" "));
  for (const c of report.pairedComparisons ?? []) {
    const cells = [
      c.config,
      fmt(c.frameP95ms?.animated, 1),
      fmt(c.frameP95ms?.streamdown, 1),
      fmt(c.frameP95ms?.reductionPct, 1),
      fmt(c.evtP95ms?.animated, 1),
      fmt(c.evtP95ms?.streamdown, 1),
      fmt(c.scriptS?.animated, 2),
      fmt(c.scriptS?.streamdown, 2),
      fmt(c.scriptS?.reductionPct, 1),
    ];
    console.log(cells.map((v, i) => String(v ?? "-").padEnd(widths[i])).join(" "));
  }
  console.log(`\n报告已写入: ${outPath}`);
}

// ── 摘要输出 ──

function fmt(value, digits) {
  return typeof value === "number" ? value.toFixed(digits) : "-";
}

function printSummary(report, outPath) {
  console.log("\n================ 聊天渲染性能基线摘要（每配置取中位数） ================");
  // A0 归因实验核心列：scriptS/layoutS（CDP 脚本与布局耗时）、mdDelta/listDelta（正文与列表外壳执行次数）
  const rows = [
    ["config", "frameP95ms", "LT>32", "LT>100", "mdDelta", "listDelta", "navDelta", "sideDelta", "commit/s", "cmtP95ms", "scriptS", "layoutS", "evtP95ms"],
  ];
  const widths = [26, 10, 6, 7, 8, 10, 9, 10, 9, 9, 8, 8, 9];
  for (const [key, label] of [
    ["channelB", "通道 B（普通生产构建）"],
    ["channelA", "通道 A（react-dom/profiling）"],
  ]) {
    console.log(`\n-- ${label} --`);
    console.log(rows[0].map((h, i) => h.padEnd(widths[i])).join(" "));
    for (const config of report[key].perConfig) {
      const p = config.params;
      const a = config.aggregated;
      const cells = [
        `${p.dataset}/${p.count}/${p.scroll}${p.streamRender && p.streamRender !== "animated" ? `/${p.streamRender}` : ""}`,
        fmt(a["userChannel.frameTimesDuringStreaming.p95"], 1),
        fmt(a["userChannel.longTasks.countOver32ms"], 0),
        fmt(a["userChannel.longTasks.countOver100ms"], 0),
        fmt(a["reactChannel.probeDeltaDuringStreaming.markdownRenders"], 0),
        fmt(a["reactChannel.probeDeltaDuringStreaming.listRenders"], 0),
        fmt(a["reactChannel.probeDeltaDuringEventStream.navigationRenders"], 0),
        fmt(a["reactChannel.probeDeltaDuringEventStream.sidebarRenders"], 0),
        fmt(a["reactChannel.commitsDuringStreaming.commitsPerSecond"], 1),
        fmt(a["reactChannel.commitsDuringStreaming.p95"], 1),
        fmt(a["cdp.ScriptDuration"], 2),
        fmt(a["cdp.LayoutDuration"], 2),
        fmt(a["userChannel.eventToPaint.p95"], 1),
      ];
      console.log(cells.map((c, i) => c.padEnd(widths[i])).join(" "));
    }
  }
  console.log(`\n报告已写入: ${outPath}`);
}

// ── 主流程 ──

async function main() {
  const outPath = resolve(ROOT, outOverride ?? "docs/internal-issue/perf/baseline-report.json");
  console.log(
    `[perf] 模式: ${pairedControl ? "A1-S 成对对照" : smoke ? "冒烟" : "完整基线"}，seed=${SEED}，流式时长 ${DURATION_MS}ms`,
  );

  // 成对对照只跑通道 B；A 通道（profiling 构建）的额外开销会污染同场对照
  const effectiveOnlyB = onlyB || pairedControl;
  if (!skipBuild) {
    buildChannel(B_OUT_DIR, false);
    if (!effectiveOnlyB) buildChannel(A_OUT_DIR, true);
  }

  const serverB = await startStaticServer(resolve(ROOT, B_OUT_DIR), PORT_B);
  const serverA = effectiveOnlyB ? null : await startStaticServer(resolve(ROOT, A_OUT_DIR), PORT_A);
  let browser;
  const report = {
    meta: {
      generatedAt: new Date().toISOString(),
      smoke,
      pairedControl,
      seed: SEED,
      durationMs: DURATION_MS,
      bMatrix: B_MATRIX,
      aMatrix: A_MATRIX,
      note: pairedControl
        ? "A1-S 成对对照：同一 (dataset,count) 内 animated/streamdown 交替同场各 3 次，先跑顺序逐轮互换；帧/事件/CDP/探针指标取各自中位数，reductionPct 为相对降幅"
        : "frameTimesDuringStreaming/LT/eventToPaint 为流式窗口统计；cdp.* 为水合后差值；探针 delta 为流式期间历史组件执行次数",
    },
    channelB: { perConfig: [] },
    channelA: { perConfig: [] },
  };

  try {
    browser = await chromium.launch({ headless: true });

    console.log(`\n[perf] 通道 B：${countConfigs(B_MATRIX)} 配置 × ${B_MATRIX.runs} 次`);
    report.channelB.perConfig = await runMatrix(browser, `http://127.0.0.1:${PORT_B}`, B_MATRIX, "B");

    if (!effectiveOnlyB) {
      console.log(`\n[perf] 通道 A：${countConfigs(A_MATRIX)} 配置 × ${A_MATRIX.runs} 次`);
      report.channelA.perConfig = await runMatrix(browser, `http://127.0.0.1:${PORT_A}`, A_MATRIX, "A");
    } else {
      console.log("\n[perf] 跳过通道 A（profiling 构建）");
    }

    if (pairedControl) {
      report.pairedComparisons = buildPairedComparisons(report.channelB.perConfig);
    }
  } finally {
    if (browser) await browser.close().catch(() => {});
    serverB.close();
    serverA?.close();
  }

  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, JSON.stringify(report, null, 2), "utf8");
  if (pairedControl) {
    printPairedSummary(report, outPath);
  } else {
    printSummary(report, outPath);
  }
}

function countConfigs(matrix) {
  return matrix.datasets.length * matrix.counts.length * matrix.scrolls.length;
}

main().catch((error) => {
  console.error(`[perf] 基线执行失败: ${error instanceof Error ? error.stack : String(error)}`);
  process.exitCode = 1;
});
