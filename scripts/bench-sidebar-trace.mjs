/**
 * 侧栏开关点击路径的 CDP 追踪基准：拿 trace 文件并聚合耗时分解。
 *
 * 跑法（项目根目录，需 5173 端口的 vite dev server，没有会自动拉起）：
 *   node scripts/bench-sidebar-trace.mjs
 *
 * 两轮各连点 5 次开关并录制 Chromium trace：
 *   1. animated  现状（width 0.25s 过渡）
 *   2. notrans   禁过渡（隔离动画变量，看点击本身的成本）
 * 输出：每轮 top 耗时事件聚合（layout / paint / React 渲染等），
 * 以及 trace 文件路径（可手工拖进 chrome://tracing 查看）。
 */
import { spawn } from "node:child_process";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { _electron as electron } from "playwright";

const CLICK_COUNT = 5;
const CLICK_INTERVAL_MS = 350;
const TAIL_MS = 700;

async function ensureVite() {
  const probe = await fetch("http://localhost:5173/react/index.html", { method: "HEAD" })
    .then((r) => r.ok)
    .catch(() => false);
  if (probe) return null;
  console.log("vite dev server 未运行，自动拉起…");
  const child = spawn("npx", ["vite"], { shell: true, stdio: "ignore" });
  for (let i = 0; i < 120; i++) {
    await new Promise((r) => setTimeout(r, 1000));
    const ok = await fetch("http://localhost:5173/react/index.html", { method: "HEAD" })
      .then((r) => r.ok)
      .catch(() => false);
    if (ok) return child;
  }
  child.kill();
  throw new Error("vite dev server 60s 内未就绪");
}

/** 聚合 trace 里的 Complete 事件：按 name 统计总时长/次数/最大值，输出 top */
function summarizeTrace(tracePath, label) {
  const events = JSON.parse(readFileSync(tracePath, "utf8")).traceEvents ?? [];
  const agg = new Map();
  for (const e of events) {
    if (e.ph !== "X" || typeof e.dur !== "number" || e.dur < 5) continue;
    const key = `${e.cat}::${e.name}`;
    const cur = agg.get(key) ?? { count: 0, total: 0, max: 0 };
    cur.count += 1;
    cur.total += e.dur;
    cur.max = Math.max(cur.max, e.dur);
    agg.set(key, cur);
  }
  const rows = [...agg.entries()]
    .map(([key, v]) => ({ key, ...v }))
    .sort((a, b) => b.total - a.total)
    .slice(0, 25);
  console.log(`\n----- ${label}：top 耗时事件（dur≥5ms 聚合）-----`);
  console.log("总时长ms   次数  最大ms  类别::名称");
  for (const r of rows) {
    console.log(String(r.total.toFixed(0)).padStart(7), String(r.count).padStart(6), String(r.max.toFixed(0)).padStart(7), ` ${r.key}`);
  }
  return rows;
}

async function main() {
  const viteChild = await ensureVite();
  console.log("启动 Electron（VITE_DEV=1）…");
  const app = await electron.launch({
    args: ["."],
    env: { ...process.env, VITE_DEV: "1" },
  });

  let page = null;
  for (let i = 0; i < 60 && !page; i++) {
    for (const w of app.windows()) {
      if (w.url().includes("/react/")) { page = w; break; }
    }
    if (!page) await new Promise((r) => setTimeout(r, 1000));
  }
  if (!page) throw new Error("60s 内未找到 react 聊天窗口");
  await page.waitForSelector(".cy-sidebar-toggle", { timeout: 60000 });
  console.log("聊天窗口就绪");

  const traceDir = "node_modules/.cache/bench-traces";
  const { mkdirSync } = await import("node:fs");
  if (!existsSync(traceDir)) mkdirSync(traceDir, { recursive: true });

  // Electron 的 Page 没有 page.tracing，走 CDP Tracing domain 手动录制
  const session = await page.context().newCDPSession(page);
  const TRACE_CATEGORIES = "devtools.timeline,v8.execute,blink.user_timing";

  for (const round of [
    { label: "animated(现状)", css: "", file: `${traceDir}/trace-animated.json` },
    { label: "notrans(禁过渡)", css: ".cy-page-sidebar { transition: none !important; }", file: `${traceDir}/trace-notrans.json` },
  ]) {
    if (round.css) {
      await page.addStyleTag({ content: round.css });
      await new Promise((r) => setTimeout(r, 300));
    }
    const chunks = [];
    const done = new Promise((resolve) => {
      session.once("Tracing.tracingComplete", () => resolve());
    });
    session.on("Tracing.dataCollected", (data) => {
      if (data?.value) chunks.push(...data.value);
    });
    await session.send("Tracing.start", { transferMode: "ReportEvents", categories: TRACE_CATEGORIES });
    for (let i = 0; i < CLICK_COUNT; i++) {
      await page.click(".cy-sidebar-toggle");
      await new Promise((r) => setTimeout(r, CLICK_INTERVAL_MS));
    }
    await new Promise((r) => setTimeout(r, TAIL_MS));
    await session.send("Tracing.end");
    await done;
    writeFileSync(round.file, JSON.stringify({ traceEvents: chunks }));
    summarizeTrace(round.file, round.label);
  }

  console.log(`\ntrace 文件已保存，可拖进 chrome://tracing 人工查看：`);
  console.log(`  ${traceDir}/trace-animated.json`);
  console.log(`  ${traceDir}/trace-notrans.json`);

  await app.close();
  if (viteChild) viteChild.kill();
}

main().catch((err) => { console.error(err); process.exit(1); });
