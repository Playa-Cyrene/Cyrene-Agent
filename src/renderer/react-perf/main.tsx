// 阶段 0 性能基线 harness 入口。
// 流程：挂载前安装假桥与探针 → 真实挂载 AppProviders + ChatPage（与 src/renderer/react/main.tsx 同构）
// → 等待会话水合 → 驱动一次完整流式 run（固定 seed 事件重放，走真实 AgentRunController 管线）
// → 双通道采集后经 window.__perfDone 暴露给 Playwright runner。
// 通道 A（React Profiler onRender + 组件探针）只在 react-dom/profiling 构建下生效；
// 通道 B（Long Task / 帧时间 / 事件到绘制延迟 / heap / DOM 数）在普通生产构建下同样有效。

import React, { Profiler, type ProfilerOnRenderCallback } from "react";
import { createRoot } from "react-dom/client";
import "../ui/theme";
import { App } from "../react/App";
import { AppProviders } from "../react/app/providers/AppProviders";
import { initUiLocale } from "../react/i18n";
import { installFakeBridges } from "./fake-bridges";
import type { PerfDataset } from "./fixture";
import type { ChatPerfProbeCounters } from "../react/features/chat/components/chat-perf-probe";

// ── 参数 ──

interface HarnessParams {
  dataset: PerfDataset;
  count: number;
  seed: number;
  durationMs: number;
  scrollMode: "bottom" | "top";
}

function parseParams(): HarnessParams {
  const params = new URLSearchParams(window.location.search);
  const dataset = params.get("dataset");
  const count = Number(params.get("count") ?? 200);
  const durationMs = Number(params.get("duration") ?? 30_000);
  return {
    dataset: dataset === "markdown" || dataset === "mixed" ? dataset : "plain",
    // 0 为 A0 空历史档（隔离流式消息本体成本与历史条目成本），基线矩阵只用 200/500
    count: count === 0 || count === 500 ? count : 200,
    seed: Number(params.get("seed") ?? 42),
    durationMs: Math.min(120_000, Math.max(2_000, durationMs)),
    scrollMode: params.get("scroll") === "top" ? "top" : "bottom",
  };
}

// ── 统计工具 ──

function median(values: number[]): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

function p95(values: number[]): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.95) - 1)]!;
}

function stats(values: number[]) {
  return {
    count: values.length,
    median: Math.round(median(values) * 100) / 100,
    p95: Math.round(p95(values) * 100) / 100,
    max: values.length ? Math.round(Math.max(...values) * 100) / 100 : 0,
    total: Math.round(values.reduce((sum, value) => sum + value, 0) * 100) / 100,
  };
}

const sleep = (ms: number) => new Promise<void>((resolve) => window.setTimeout(resolve, ms));

// ── 采集状态 ──

const params = parseParams();

interface CommitRecord {
  atMs: number;
  phase: string;
  actualDuration: number;
}

const commits: CommitRecord[] = [];
const longtasks: Array<{ atMs: number; duration: number }> = [];
// 帧记录带时间戳：流式窗口内与全程分别统计，避免把启动阶段的大帧混进验收指标
const frameRecords: Array<{ atMs: number; delta: number }> = [];
const eventToPaintLatencies: number[] = [];
const heapSamples: number[] = [];

let streamStartAt = 0;
let streamEndAt = 0;
let phase: "booting" | "hydrated" | "streaming" | "done" = "booting";
let lastEventAt: number | null = null;
let lastProcessedEventAt = 0;
let lastFrameAt: number | null = null;
let rafStopped = false;
// 壳层探针（导航/侧栏）增长事件与快照：诊断 memo 穿透时机用
let activeProbe: ChatPerfProbeCounters | null = null;
const lastShellProbeSnapshot: ChatPerfProbeCounters = {
  markdownRenders: 0,
  navigationRenders: 0,
  sidebarRenders: 0,
  listRenders: 0,
};
const shellProbeEvents: Array<{
  atMs: number;
  sinceStreamStartMs: number | null;
  key: keyof ChatPerfProbeCounters;
  count: number;
  phase: string;
}> = [];
// 事件到达时间线：与壳层探针增长时刻对照，定位是哪类事件触发穿透
const eventTimeline: Array<{ atMs: number; type: string }> = [];

const perfWindow = window as typeof window & {
  __perfState?: string;
  __perfHydrated?: boolean;
  __perfDone?: unknown;
  __cyreneChatPerfProbe?: ChatPerfProbeCounters;
};

perfWindow.__perfState = phase;

const onProfilerRender: ProfilerOnRenderCallback = (_id, renderPhase, actualDuration) => {
  commits.push({ atMs: performance.now(), phase: renderPhase, actualDuration });
};

// 帧循环：帧间隔 + 事件到下一帧（≈下一帧绘制）延迟
function frameLoop() {
  if (rafStopped) return;
  const now = performance.now();
  if (lastFrameAt !== null) frameRecords.push({ atMs: now, delta: now - lastFrameAt });
  lastFrameAt = now;
  if (lastEventAt !== null && lastEventAt > lastProcessedEventAt) {
    eventToPaintLatencies.push(now - lastEventAt);
    lastProcessedEventAt = lastEventAt;
  }
  // 壳层探针增长事件：定位导航/侧栏 memo 被穿透的具体时刻（markdownRenders 高频，不记录）
  if (activeProbe) {
    for (const key of ["navigationRenders", "sidebarRenders"] as const) {
      const count = activeProbe[key];
      if (count > lastShellProbeSnapshot[key]) {
        shellProbeEvents.push({
          atMs: now,
          sinceStreamStartMs: streamStartAt > 0 ? now - streamStartAt : null,
          key,
          count,
          phase,
        });
        lastShellProbeSnapshot[key] = count;
      }
    }
  }
  window.requestAnimationFrame(frameLoop);
}

// ── 主流程 ──

async function main() {
  const runtime = installFakeBridges({
    dataset: params.dataset,
    count: params.count,
    seed: params.seed,
    durationMs: params.durationMs,
  });

  // 探针注册必须发生在 React 挂载之前
  const probe: ChatPerfProbeCounters = {
    markdownRenders: 0,
    navigationRenders: 0,
    sidebarRenders: 0,
    listRenders: 0,
  };
  perfWindow.__cyreneChatPerfProbe = probe;
  activeProbe = probe;
  runtime.onEmit((event) => {
    lastEventAt = performance.now();
    // AguiEvent.type 声明为可选：诊断时间线用 unknown 兜底，避免类型噪声
    eventTimeline.push({ atMs: lastEventAt, type: event.type ?? "unknown" });
  });

  // Long Task 观察者（Chromium）
  if ("PerformanceObserver" in window) {
    try {
      const observer = new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          longtasks.push({ atMs: entry.startTime, duration: entry.duration });
        }
      });
      observer.observe({ entryTypes: ["longtask"] } as PerformanceObserverInit);
    } catch {
      // 环境不支持 longtask 时跳过（其余指标不受影响）
    }
  }

  // heap 采样（Chromium 非标准 API）
  const memory = (performance as Performance & { memory?: { usedJSHeapSize: number } }).memory;
  const heapTimer = memory
    ? window.setInterval(() => heapSamples.push(memory.usedJSHeapSize), 2_000)
    : undefined;

  window.requestAnimationFrame(frameLoop);

  await initUiLocale().catch(() => {});
  const container = document.getElementById("cyrene-react-root");
  if (!container) throw new Error("Root element #cyrene-react-root not found");
  const root = createRoot(container);
  root.render(
    <React.StrictMode>
      <Profiler id="chat-page" onRender={onProfilerRender}>
        <AppProviders>
          <App />
        </AppProviders>
      </Profiler>
    </React.StrictMode>,
  );

  // ── 等待水合完成：消息列表出现且气泡数稳定 ──
  const expectedBubbles = params.count;
  let firstBubbleAt: number | null = null;
  let stableCount = 0;
  let lastBubbleCount = -1;
  const hydrateDeadline = performance.now() + 60_000;
  while (performance.now() < hydrateDeadline) {
    const list = document.querySelector<HTMLElement>(".cy-message-list");
    const bubbles = list ? list.querySelectorAll(".cy-message").length : 0;
    if (bubbles > 0 && firstBubbleAt === null) firstBubbleAt = performance.now();
    if (bubbles >= expectedBubbles && bubbles === lastBubbleCount) {
      stableCount += 1;
      if (stableCount >= 4) break;
    } else {
      stableCount = 0;
    }
    lastBubbleCount = bubbles;
    await sleep(100);
  }
  const hydratedAt = performance.now();
  const probeAfterHydration = { ...probe };
  const domNodeCountAfterHydration = document.getElementsByTagName("*").length;
  const heapUsedAfterHydrationBytes = memory ? memory.usedJSHeapSize : null;
  // 粘性标记：runner 据此对 CDP Performance 指标取水合后差值（覆盖流式窗口）
  perfWindow.__perfHydrated = true;
  phase = "hydrated";
  perfWindow.__perfState = phase;

  await sleep(600);

  // ── 滚离底部（autoScroll 关闭场景）：用户翻阅历史，不跟随滚动 ──
  const list = document.querySelector<HTMLElement>(".cy-message-list");
  if (params.scrollMode === "top" && list) {
    list.scrollTop = 0;
    await sleep(300);
  }

  // ── 驱动发送：填入草稿并回车，走真实 sendMessage → 待发队列 → runModel 链路 ──
  const textarea = document.querySelector<HTMLTextAreaElement>(".cy-workspace-composer textarea");
  if (!textarea) {
    finishWithError("未找到输入框，驱动失败");
    return;
  }
  textarea.focus();
  const valueSetter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
  valueSetter?.call(textarea, "性能基线测试消息");
  textarea.dispatchEvent(new Event("input", { bubbles: true }));
  await sleep(150);
  textarea.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));

  // 等待 run 启动（发送链路完整走通的判定）
  const runDeadline = performance.now() + 15_000;
  while (runtime.getRunCalls() === 0 && performance.now() < runDeadline) {
    await sleep(100);
  }
  if (runtime.getRunCalls() === 0) {
    finishWithError("发送后 15s 内未观测到 agui.run 调用");
    return;
  }

  phase = "streaming";
  perfWindow.__perfState = phase;
  streamStartAt = performance.now();
  const probeAtStreamStart = { ...probe };

  // ── 等待流式脚本结束 + 终态渲染沉降 ──
  const streamDeadline = streamStartAt + params.durationMs + 60_000;
  while (!runtime.isScriptFinished() && performance.now() < streamDeadline) {
    await sleep(200);
  }
  await sleep(2_500);
  streamEndAt = performance.now();

  phase = "done";
  perfWindow.__perfState = phase;
  rafStopped = true;
  if (heapTimer !== undefined) window.clearInterval(heapTimer);

  // ── 汇总报告 ──
  const streamingCommits = commits.filter(
    (commit) => commit.atMs >= streamStartAt && commit.atMs <= streamEndAt,
  );
  const streamingFrames = frameRecords.filter(
    (frame) => frame.atMs >= streamStartAt && frame.atMs <= streamEndAt,
  );
  const streamingLongtasks = longtasks.filter(
    (task) => task.atMs >= streamStartAt && task.atMs <= streamEndAt,
  );

  perfWindow.__perfDone = {
    ok: true,
    params,
    timings: {
      firstBubbleMs: firstBubbleAt === null ? null : Math.round(firstBubbleAt),
      hydratedMs: Math.round(hydratedAt),
      streamStartAt: Math.round(streamStartAt),
      streamEndAt: Math.round(streamEndAt),
      streamDurationMs: Math.round(streamEndAt - streamStartAt),
    },
    reactChannel: {
      profilerActive: commits.length > 0,
      commitsDuringStreaming: {
        ...stats(streamingCommits.map((commit) => commit.actualDuration)),
        commitCount: streamingCommits.length,
        commitsPerSecond:
          streamingCommits.length / Math.max(0.001, (streamEndAt - streamStartAt) / 1000),
      },
      probeAfterHydration,
      probeDeltaDuringStreaming: {
        markdownRenders: probe.markdownRenders - probeAtStreamStart.markdownRenders,
        navigationRenders: probe.navigationRenders - probeAtStreamStart.navigationRenders,
        sidebarRenders: probe.sidebarRenders - probeAtStreamStart.sidebarRenders,
        listRenders: probe.listRenders - probeAtStreamStart.listRenders,
      },
      // 事件流到达期间（streamStart → 最后事件到达）的壳层渲染：nav/side 验收口径。
      // RUN_FINISHED 后 handleRunFinished 会刷新会话列表，此时 messageCount 已真实变化
      // （claim 用户消息 + 控制器写入助手消息），属合法单次数据更新而非流式渲染成本，
      // 不计入流式指标；mdDelta / 帧指标仍按含沉降的完整流式窗口统计。
      probeDeltaDuringEventStream: (() => {
        const lastEventAtMs = eventTimeline.length > 0 ? eventTimeline[eventTimeline.length - 1]!.atMs : streamEndAt;
        const inEventStream = (event: (typeof shellProbeEvents)[number]) =>
          event.atMs >= streamStartAt && event.atMs <= lastEventAtMs;
        return {
          navigationRenders: shellProbeEvents.filter((event) => event.key === "navigationRenders" && inEventStream(event)).length,
          sidebarRenders: shellProbeEvents.filter((event) => event.key === "sidebarRenders" && inEventStream(event)).length,
        };
      })(),
      expectedDeltaEvents: runtime.script.deltaCount,
    },
    userChannel: {
      // 全程帧间隔（含启动大帧），仅作参考
      frameTimesOverall: stats(frameRecords.map((frame) => frame.delta)),
      // 流式窗口内帧间隔：掉帧验收的主指标
      frameTimesDuringStreaming: stats(streamingFrames.map((frame) => frame.delta)),
      longTasks: {
        ...stats(streamingLongtasks.map((task) => task.duration)),
        countOver32ms: streamingLongtasks.filter((task) => task.duration > 32).length,
        countOver100ms: streamingLongtasks.filter((task) => task.duration > 100).length,
      },
      // 事件到下一帧延迟只会在流式期间产生（事件源仅来自脚本重放），无需按窗口过滤
      eventToPaint: stats(eventToPaintLatencies),
    },
    memory: {
      heapUsedAfterHydrationBytes,
      heapUsedFinalBytes: heapSamples.length ? heapSamples[heapSamples.length - 1] : null,
      heapUsedMaxBytes: heapSamples.length ? Math.max(...heapSamples) : null,
      domNodeCountAfterHydration,
      domNodeCountFinal: document.getElementsByTagName("*").length,
    },
    // 诊断：导航/侧栏探针增长的具体时刻（定位 memo 穿透原因用）
    diagnostics: {
      shellProbeEvents,
      eventTimeline,
    },
  };
}

function finishWithError(message: string) {
  phase = "done";
  perfWindow.__perfState = phase;
  rafStopped = true;
  perfWindow.__perfDone = { ok: false, error: message, params };
}

void main().catch((error) => {
  finishWithError(`harness 异常: ${error instanceof Error ? error.message : String(error)}`);
});
