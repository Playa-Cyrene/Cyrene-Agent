/**
 * 侧栏展开/收起按钮连点卡顿的根因基准（四阶段对照实验）。
 *
 * 跑法（项目根目录）：
 *   1. 先起渲染端 dev server：npx vite            （或直接 npm run dev 后另开终端跑本脚本）
 *   2. node scripts/bench-sidebar-toggle.mjs
 *
 * 四个阶段都在真实 Electron 聊天窗口里执行：
 *   A baseline    静置不动，采集本机帧率/长任务基线
 *   B animated    现状：连点 5 次侧栏开关（默认 width 0.25s 过渡动画运行中）
 *   C notrans     注入 CSS 禁掉侧栏过渡后同样连点 5 次（隔离「动画」变量）
 *   D notrans-nodrag 再禁掉整窗 app-region: drag（隔离「Windows 拖拽区重建」变量）
 *
 * 指标：
 *   - rAF 帧间隔 p50/p95/max：渲染主线程是否掉帧
 *   - longtask 数量与总时长：主线程长任务
 *   - mousemove 到达间隔 p95：模拟真实鼠标连点+移动，量化「鼠标卡」
 * 若 B 明显差于 A：动画期间主线程饱和实锤；
 * 若 C≈B（都差）：说明卡的不是 CSS 过渡本身；
 * 若 D 明显好于 C：Windows drag region 重建是主因。
 */
import { spawn } from "node:child_process";
import { _electron as electron } from "playwright";

const CLICK_COUNT = 5;
const CLICK_INTERVAL_MS = 350;
const TAIL_MS = 700; // 最后一次点击后等待动画收尾的时间

/** 等待 5173 端口的 vite dev server 就绪（未就绪时自己拉一个） */
async function ensureVite() {
  const probe = await fetch("http://localhost:5173/react/index.html", { method: "HEAD" })
    .then((r) => r.ok)
    .catch(() => false);
  if (probe) return null;
  console.log("vite dev server 未运行，自动拉起（首次编译需等待）…");
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

/** 统计辅助：分位数 */
function quantile(sorted, q) {
  if (!sorted.length) return 0;
  const idx = Math.min(sorted.length - 1, Math.floor(q * sorted.length));
  return sorted[idx];
}

/** 在页面里挂一个持续采集器（rAF 帧间隔 / longtask / mousemove 到达间隔），返回读取+复位函数 */
async function installHarness(page) {
  await page.evaluate(() => {
    window.__bench = {
      frames: [],
      longtasks: [],
      moves: [],
      lastFrame: 0,
      lastMove: 0,
      po: new PerformanceObserver((list) => {
        for (const e of list.getEntries()) window.__bench.longtasks.push(Math.round(e.duration));
      }),
    };
    window.__bench.po.observe({ entryTypes: ["longtask"] });
    document.addEventListener("mousemove", () => {
      const b = window.__bench;
      const now = performance.now();
      if (b.lastMove) b.moves.push(Math.round(now - b.lastMove));
      b.lastMove = now;
    });
    const loop = (t) => {
      const b = window.__bench;
      if (b.lastFrame) b.frames.push(Math.round(t - b.lastFrame));
      b.lastFrame = t;
      requestAnimationFrame(loop);
    };
    requestAnimationFrame(loop);
  });
}

/** 读走并复位采集数据，返回本阶段统计 */
async function collect(page, label) {
  const raw = await page.evaluate(() => {
    const b = window.__bench;
    const out = { frames: [...b.frames], longtasks: [...b.longtasks], moves: [...b.moves] };
    b.frames = [];
    b.longtasks = [];
    b.moves = [];
    return out;
  });
  const frames = raw.frames.sort((a, b) => a - b);
  const moves = raw.moves.sort((a, b) => a - b);
  const ltTotal = raw.longtasks.reduce((s, v) => s + v, 0);
  return {
    label,
    frameCount: frames.length,
    frameP50: quantile(frames, 0.5),
    frameP95: quantile(frames, 0.95),
    frameMax: frames.at(-1) ?? 0,
    longtaskCount: raw.longtasks.length,
    longtaskTotalMs: ltTotal,
    moveCount: moves.length,
    moveP95: quantile(moves, 0.95),
    moveMax: moves.at(-1) ?? 0,
  };
}

/** 执行一个阶段：连点 N 次侧栏开关，期间持续画圈移动鼠标模拟真实操作 */
async function runPhase(page, toggleSel, box) {
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;
  for (let i = 0; i < CLICK_COUNT; i++) {
    // 点击前在按钮附近小幅画圈，模拟「连点时手在动」的真实场景
    for (let step = 0; step < 24; step++) {
      const angle = (step / 24) * Math.PI * 2;
      await page.mouse.move(cx + 40 + 30 * Math.cos(angle), cy + 30 * Math.sin(angle));
    }
    await page.click(toggleSel);
    await new Promise((r) => setTimeout(r, CLICK_INTERVAL_MS));
  }
  await new Promise((r) => setTimeout(r, TAIL_MS));
}

async function main() {
  const viteChild = await ensureVite();

  console.log("启动 Electron（VITE_DEV=1）…");
  const app = await electron.launch({
    args: ["."],
    env: { ...process.env, VITE_DEV: "1" },
  });

  // 找 react 聊天窗口（第一个窗口可能是桌面宠物）
  let page = null;
  for (let i = 0; i < 60 && !page; i++) {
    for (const w of app.windows()) {
      if (w.url().includes("/react/")) { page = w; break; }
    }
    if (!page) await new Promise((r) => setTimeout(r, 1000));
  }
  if (!page) throw new Error("60s 内未找到 react 聊天窗口");
  await page.waitForSelector(".cy-sidebar-toggle", { timeout: 60000 });
  const toggleSel = ".cy-sidebar-toggle";
  const box = await page.locator(toggleSel).boundingBox();
  console.log(`聊天窗口就绪：${page.url()}`);

  await installHarness(page);
  const results = [];

  // A 基线：静置状态下同样画圈移动鼠标（隔离「纯鼠标移动」的成本，不点击）
  console.log("阶段 A：baseline 静置采样…");
  {
    const cx = box.x + box.width / 2;
    const cy = box.y + box.height / 2;
    for (let i = 0; i < CLICK_COUNT; i++) {
      for (let step = 0; step < 24; step++) {
        const angle = (step / 24) * Math.PI * 2;
        await page.mouse.move(cx + 40 + 30 * Math.cos(angle), cy + 30 * Math.sin(angle));
      }
      await new Promise((r) => setTimeout(r, CLICK_INTERVAL_MS));
    }
    await new Promise((r) => setTimeout(r, TAIL_MS));
  }
  results.push(await collect(page, "A baseline"));

  // B 现状：默认动画
  console.log("阶段 B：animated 连点 5 次…");
  await runPhase(page, toggleSel, box);
  results.push(await collect(page, "B animated(现状)"));

  // C 禁侧栏过渡
  console.log("阶段 C：notrans 禁过渡后连点 5 次…");
  await page.addStyleTag({ content: ".cy-page-sidebar { transition: none !important; }" });
  await new Promise((r) => setTimeout(r, 300));
  await runPhase(page, toggleSel, box);
  results.push(await collect(page, "C notrans(禁过渡)"));

  // D 再禁 drag region
  console.log("阶段 D：notrans-nodrag 再禁拖拽区后连点 5 次…");
  await page.addStyleTag({ content: ".cy-page { app-region: no-drag !important; }" });
  await new Promise((r) => setTimeout(r, 300));
  await runPhase(page, toggleSel, box);
  results.push(await collect(page, "D notrans+nodrag(禁过渡+禁拖拽区)"));

  // 汇总
  console.log("\n================ 基准结果 ================");
  const pad = (s, n) => String(s).padEnd(n, " ");
  console.log([pad("阶段", 28), pad("帧p50", 6), pad("帧p95", 6), pad("帧max", 7), pad("长任务数", 8), pad("长任务ms", 8), pad("move数", 7), pad("moveP95", 8), "moveMax"].join(" "));
  for (const r of results) {
    console.log([pad(r.label, 28), pad(r.frameP50, 6), pad(r.frameP95, 6), pad(r.frameMax, 7), pad(r.longtaskCount, 8), pad(r.longtaskTotalMs, 8), pad(r.moveCount, 7), pad(r.moveP95, 8), r.moveMax].join(" "));
  }
  console.log("说明：帧间隔单位 ms（60Hz 正常约 16.7）；move 为 mousemove 到达间隔 p95（正常应 <50ms）。");
  console.log("对比规则：B 明显差于 A → 动画期间主线程饱和；C≈B → 与 CSS 过渡无关；D 明显好于 C → drag region 重建是主因。");

  await app.close();
  if (viteChild) {
    viteChild.kill();
    console.log("\n（基准自动拉起的 vite 已停止；若你自己起过 npm run dev 请手动关闭）");
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
