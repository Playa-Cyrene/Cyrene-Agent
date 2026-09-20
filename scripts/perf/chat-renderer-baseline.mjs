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
//   npm run perf:chat-baseline -- --headed --record-video <dir>  # 将每次可见窗口回放录为 WebM

import { spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { dirname, extname, join, normalize, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { createRecordingContextOptions, installLiveMessageFollow, recordingFileName } from "./chat-renderer-recording.mjs";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));

// ── 参数 ──

const args = process.argv.slice(2);
const smoke = args.includes("--smoke");
const skipBuild = args.includes("--skip-build");
const onlyB = args.includes("--only-b");
const headed = args.includes("--headed");
const runsIndex = args.indexOf("--runs");
const runsOverride = runsIndex >= 0 ? Number.parseInt(args[runsIndex + 1] ?? "", 10) : undefined;
const outIndex = args.indexOf("--out");
const outOverride = outIndex >= 0 ? args[outIndex + 1] : undefined;
const recordVideoIndex = args.indexOf("--record-video");
const recordVideoArg = recordVideoIndex >= 0 ? args[recordVideoIndex + 1] : undefined;
if (recordVideoIndex >= 0 && !recordVideoArg) {
  throw new Error("--record-video 后必须提供输出目录");
}
const recordVideoDir = recordVideoArg ? resolve(recordVideoArg) : undefined;

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
// ── 矩阵 ──

const SEED = 42;
// 流式脚本时长：完整基线 15s（几百个 delta，接近真实长回复）；冒烟 6s 只验证链路
const DURATION_MS = smoke ? 6_000 : 15_000;

const B_MATRIX = smoke
  ? { datasets: ["mixed"], counts: [200], scrolls: ["bottom"], runs: 1 }
  : {
      datasets: datasetsOverride ?? ["plain", "markdown", "mixed"],
      counts: countsOverride ?? [200, 500],
      scrolls: scrollsOverride ?? ["bottom", "top"],
      runs: Number.isFinite(runsOverride) && runsOverride > 0 ? runsOverride : 5,
    };

// A 通道（profiling 构建）有额外开销，绝对时长偏慢，只用于 React 侧指标（commit 频率/时长、探针计数），
// 矩阵缩减到最重配置
const A_MATRIX = smoke
  ? { datasets: ["mixed"], counts: [200], scrolls: ["bottom"], runs: 1 }
  : { datasets: ["plain", "markdown", "mixed"], counts: [500], scrolls: ["bottom"], runs: 3 };

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

async function runCase(context, baseUrl, { dataset, count, scroll }, recordingName) {
  const page = await context.newPage();
  const video = page.video();
  if (recordVideoDir) await page.addInitScript(installLiveMessageFollow);
  const cdp = await context.newCDPSession(page);
  await cdp.send("Performance.enable");
  const url = `${baseUrl}/react-perf/index.html?dataset=${dataset}&count=${count}&seed=${SEED}&duration=${DURATION_MS}&scroll=${scroll}`;
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
  let videoPath;
  if (video && recordingName && recordVideoDir) {
    videoPath = join(recordVideoDir, recordingName);
    renameSync(await video.path(), videoPath);
  }
  return { ...report, cdp: diffMetrics(metricsBefore, metricsAfter), ...(videoPath ? { videoPath } : {}) };
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
        const config = { dataset, count, scroll };
        const runs = [];
        for (let i = 0; i < matrix.runs; i++) {
          const context = await browser.newContext(createRecordingContextOptions(recordVideoDir));
          const recordingName = recordVideoDir ? recordingFileName(config, i + 1) : undefined;
          try {
            // 失败重试一次：偶发调度抖动不至于废掉整轮基线
            try {
              runs.push(await runCase(context, baseUrl, config, recordingName));
            } catch (error) {
              console.log(`  [${channelLabel}] ${configLabel} #${i + 1} 失败，重试: ${error.message}`);
              runs.push(await runCase(context, baseUrl, config, recordingName));
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
        `${p.dataset}/${p.count}/${p.scroll}`,
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
  if (recordVideoDir) mkdirSync(recordVideoDir, { recursive: true });
  console.log(
    `[perf] 模式: ${smoke ? "冒烟" : "完整基线"}，${headed ? "可见窗口" : "headless"}，seed=${SEED}，流式时长 ${DURATION_MS}ms`,
  );

  const effectiveOnlyB = onlyB;
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
      headed,
      recordVideoDir,
      seed: SEED,
      durationMs: DURATION_MS,
      bMatrix: B_MATRIX,
      aMatrix: A_MATRIX,
      note: "frameTimesDuringStreaming/LT/eventToPaint 为流式窗口统计；cdp.* 为水合后差值；探针 delta 为流式期间历史组件执行次数",
    },
    channelB: { perConfig: [] },
    channelA: { perConfig: [] },
  };

  try {
    browser = await chromium.launch({ headless: !headed });

    console.log(`\n[perf] 通道 B：${countConfigs(B_MATRIX)} 配置 × ${B_MATRIX.runs} 次`);
    report.channelB.perConfig = await runMatrix(browser, `http://127.0.0.1:${PORT_B}`, B_MATRIX, "B");

    if (!effectiveOnlyB) {
      console.log(`\n[perf] 通道 A：${countConfigs(A_MATRIX)} 配置 × ${A_MATRIX.runs} 次`);
      report.channelA.perConfig = await runMatrix(browser, `http://127.0.0.1:${PORT_A}`, A_MATRIX, "A");
    } else {
      console.log("\n[perf] 跳过通道 A（profiling 构建）");
    }

  } finally {
    if (browser) await browser.close().catch(() => {});
    serverB.close();
    serverA?.close();
  }

  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, JSON.stringify(report, null, 2), "utf8");
  printSummary(report, outPath);
}

function countConfigs(matrix) {
  return matrix.datasets.length * matrix.counts.length * matrix.scrolls.length;
}

main().catch((error) => {
  console.error(`[perf] 基线执行失败: ${error instanceof Error ? error.stack : String(error)}`);
  process.exitCode = 1;
});
