// Token 用量面板：指标卡片 + 柱状图 + Chart.js 波浪图
// 从 settings.ts 抽离。依赖 chart.js + tokensState。
// 副作用导入：模块加载时执行事件绑定 + 初始渲染。

import { Chart, registerables, type ChartConfiguration } from "chart.js";
import { tokensState } from "./state";
import { formatCacheRate } from "./cache-statistics";
import { showConfirm } from "../shared/modal";

Chart.register(...registerables);

interface TokenDayData {
  date: string;       // ISO 日期 "06-15"
  weekday: string;    // "周日"
  input: number;
  output: number;
  hit: number;
  miss: number;
  cacheCreation: number;
  requests: number;
  attemptedRequests: number;
  /** 厂商实际返回缓存统计的请求数；0 表示暂无数据。 */
  cacheUsageRequests: number;
}

interface TokenModelData {
  model: string;
  input: number;
  output: number;
  hit: number;
  miss: number;
  cacheCreation?: number;
  cacheUsageRequests?: number;
  requests: number;
  attemptedRequests?: number;
}

interface TokenUsageReport {
  days: TokenDayData[];
  models: TokenModelData[];
}

declare global {
interface Window {
    tokenUsage?: {
      get: (days: number) => Promise<TokenUsageReport>;
      clear: () => Promise<void>;
    };
  }
}

function formatCacheMetric(value: number, data: TokenDayData): string {
  if (data.cacheUsageRequests <= 0) return "暂无数据";
  const suffix = data.cacheUsageRequests < data.requests ? "（部分请求未提供）" : "";
  return `${value.toLocaleString()}${suffix}`;
}

// 柱状图：根据数据动态生成柱子（复用 chart.css 的 .chart-bar 样式）
function renderTokenBarChart(data: TokenDayData[]): void {
  const container = document.getElementById("token-bar-chart");
  if (!container) return;
  container.innerHTML = "";

  const maxVal = Math.max(...data.map((d) => d.input + d.output), 1);
  const peakIdx = data.reduce((peak, d, i, arr) =>
    (d.input + d.output) > (arr[peak].input + arr[peak].output) ? i : peak, 0);

  // 柱状图最多显示 14 根（30d 时隔天显示），避免太挤
  const displayData = data.length > 14
    ? data.filter((_, i) => i % 2 === 0)
    : data;

  // 容器实际可用高度（mini-chart 高度 112px - padding-top 18px - 底部 label 区 18px ≈ 76px）
  // 用固定像素高度，避免 flex 百分比高度在 padding 容器里不可靠
  const chartHeight = 76;

  for (let i = 0; i < displayData.length; i++) {
    const d = displayData[i];
    const total = d.input + d.output;
    const barH = Math.max(6, Math.round((total / maxVal) * chartHeight));
    const bar = document.createElement("div");
    bar.className = "token-bar";
    // 峰值柱加标记
    const origIdx = data.indexOf(d);
    if (origIdx === peakIdx) bar.classList.add("token-bar--peak");

    // 真实 fill div（不用伪元素，直接控制像素高度）
    const fill = document.createElement("div");
    fill.className = "token-bar__fill";
    fill.style.height = barH + "px";

    const label = document.createElement("span");
    label.className = "token-bar__label";
    label.textContent = d.date.split("-")[1]; // 只显示日
    bar.appendChild(fill);
    bar.appendChild(label);

    // hover tooltip
    bar.addEventListener("mouseenter", (e) => showTokenTooltip(e, d));
    bar.addEventListener("mousemove", (e) => moveTokenTooltip(e));
    bar.addEventListener("mouseleave", hideTokenTooltip);

    container.appendChild(bar);
  }

  // 日均标签
  const avgEl = document.getElementById("token-avg-label");
  if (avgEl) {
    const avg = Math.round(data.reduce((s, d) => s + d.input + d.output, 0) / data.length);
    avgEl.textContent = `日均 ${formatTokenShort(avg)}`;
  }
}

function formatTokenShort(n: number): string {
  if (n >= 1000) return (n / 1000).toFixed(1) + "K";
  return String(n);
}

// tooltip 显示/移动/隐藏
function showTokenTooltip(e: MouseEvent, d: TokenDayData): void {
  const tip = document.getElementById("token-tooltip");
  if (!tip) return;
  tip.innerHTML = `
    <div class="token-tooltip__date">${d.date} ${d.weekday}</div>
    <div class="token-tooltip__row"><span>📥 输入</span><span>${d.input.toLocaleString()}</span></div>
    <div class="token-tooltip__row"><span>📤 输出</span><span>${d.output.toLocaleString()}</span></div>
    <div class="token-tooltip__row"><span>🎯 缓存命中</span><span>${formatCacheMetric(d.hit, d)}</span></div>
    <div class="token-tooltip__row"><span>❌ 缓存未命中</span><span>${formatCacheMetric(d.miss, d)}</span></div>
    <div class="token-tooltip__row"><span>📝 缓存创建</span><span>${d.cacheCreation > 0 ? d.cacheCreation.toLocaleString() : "暂无数据"}</span></div>
    <div class="token-tooltip__row"><span>🔢 请求</span><span>${d.requests.toLocaleString()} / ${d.attemptedRequests.toLocaleString()}</span></div>
  `;
  tip.hidden = false;
  moveTokenTooltip(e);
}

function moveTokenTooltip(e: MouseEvent): void {
  const tip = document.getElementById("token-tooltip");
  if (!tip || tip.hidden) return;
  const offset = 14;
  let x = e.clientX + offset;
  let y = e.clientY + offset;
  // 防止超出视口右边
  const tipW = tip.offsetWidth;
  if (x + tipW > window.innerWidth) x = e.clientX - tipW - offset;
  tip.style.left = x + "px";
  tip.style.top = y + "px";
}

function hideTokenTooltip(): void {
  const tip = document.getElementById("token-tooltip");
  if (tip) tip.hidden = true;
}

// Chart.js 波浪面积图

function renderTokenTrendChart(data: TokenDayData[]): void {
  const canvas = document.getElementById("token-trend-chart") as HTMLCanvasElement | null;
  if (!canvas) return;

  // 销毁旧实例避免重叠
  if (tokensState.trendChart) { tokensState.trendChart.destroy(); tokensState.trendChart = null; }

  const labels = data.map((d) => d.date);
  const inputData = data.map((d) => d.input);
  const outputData = data.map((d) => d.output);

  const config: ChartConfiguration = {
    type: "line",
    data: {
      labels,
      datasets: [
        {
          label: "📥 输入",
          data: inputData,
          borderColor: "#3b82f6",
          backgroundColor: "rgba(59, 130, 246, 0.15)",
          fill: true,
          tension: 0.4,
          borderWidth: 2,
          pointRadius: 0,
          pointHoverRadius: 5,
          pointHoverBackgroundColor: "#3b82f6",
        },
        {
          label: "📤 输出",
          data: outputData,
          borderColor: "#ff8ccc",
          backgroundColor: "rgba(255, 140, 204, 0.15)",
          fill: true,
          tension: 0.4,
          borderWidth: 2,
          pointRadius: 0,
          pointHoverRadius: 5,
          pointHoverBackgroundColor: "#ff8ccc",
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: "index", intersect: false },
      plugins: {
        legend: {
          display: true,
          position: "top",
          labels: { color: "rgba(235, 229, 245, 0.7)", font: { size: 11 }, boxWidth: 12, boxHeight: 12 },
        },
        tooltip: {
          // 用 Chart.js 自带 tooltip，显示输入/输出/命中/未命中
          backgroundColor: "rgba(30, 20, 45, 0.95)",
          borderColor: "rgba(255, 182, 220, 0.3)",
          borderWidth: 1,
          titleColor: "rgba(254, 247, 255, 0.95)",
          bodyColor: "rgba(235, 229, 245, 0.85)",
          padding: 10,
          cornerRadius: 10,
          displayColors: true,
          callbacks: {
            title: (items) => {
              const idx = items[0].dataIndex;
              const d = data[idx];
              return `${d.date} ${d.weekday}`;
            },
            label: (item) => {
              const idx = item.dataIndex;
              const d = data[idx];
              const which = item.datasetIndex === 0 ? "input" : "output";
              const val = which === "input" ? d.input : d.output;
              return `${which === "input" ? "📥 输入" : "📤 输出"}: ${val.toLocaleString()}`;
            },
            afterBody: (items) => {
              const idx = items[0].dataIndex;
              const d = data[idx];
              return [
                `🎯 缓存命中: ${formatCacheMetric(d.hit, d)}`,
                `❌ 缓存未命中: ${formatCacheMetric(d.miss, d)}`,
                `📝 缓存创建: ${d.cacheCreation > 0 ? d.cacheCreation.toLocaleString() : "暂无数据"}`,
                `🔢 请求: ${d.requests} / ${d.attemptedRequests}`,
              ];
            },
          },
        },
      },
      scales: {
        x: {
          grid: { display: false },
          ticks: { color: "rgba(235, 229, 245, 0.45)", font: { size: 10 }, maxRotation: 0, autoSkip: true, maxTicksLimit: 10 },
        },
        y: {
          grid: { color: "rgba(255, 182, 220, 0.08)" },
          ticks: {
            color: "rgba(235, 229, 245, 0.45)",
            font: { size: 10 },
            callback: (v) => formatTokenShort(Number(v)),
          },
          beginAtZero: true,
        },
      },
    },
  };

  tokensState.trendChart = new Chart(canvas, config);
}

const modelColors = ["#ff7eb7", "#8b7cf6", "#4db6ac", "#f4a261", "#5b8def", "#94a3b8"];

function renderModelUsage(models: TokenModelData[]): void {
  const canvas = document.getElementById("token-model-chart") as HTMLCanvasElement | null;
  const list = document.getElementById("token-model-list");
  if (!canvas || !list) return;
  tokensState.modelChart?.destroy();
  tokensState.modelChart = null;
  list.innerHTML = "";
  const visible = models.slice(0, 6);
  const total = visible.reduce((sum, item) => sum + item.input + item.output, 0);
  if (total <= 0) {
    list.innerHTML = '<p class="token-models__empty">暂无可归类的模型用量</p>';
    return;
  }
  tokensState.modelChart = new Chart(canvas, {
    type: "doughnut",
    data: {
      labels: visible.map((item) => item.model),
      datasets: [{ data: visible.map((item) => item.input + item.output), backgroundColor: modelColors, borderWidth: 2, borderColor: "rgba(255,255,255,.76)" }],
    },
    options: { responsive: true, maintainAspectRatio: false, cutout: "68%", plugins: { legend: { display: false }, tooltip: { callbacks: { label: (item) => `${item.label}: ${(item.raw as number).toLocaleString()} Token` } } } },
  });
  for (const [index, item] of visible.entries()) {
    const used = item.input + item.output;
    const row = document.createElement("div");
    row.className = "token-model-row";
    row.innerHTML = `<span class="token-model-row__dot" style="background:${modelColors[index]}"></span><span class="token-model-row__name"></span><span class="token-model-row__value">${used.toLocaleString()} · ${(used / total * 100).toFixed(1)}%</span>`;
    row.querySelector(".token-model-row__name")!.textContent = item.model;
    list.appendChild(row);
  }
}

// 更新指标卡片
function updateTokenStats(data: TokenDayData[]): void {
  const totalInput = data.reduce((s, d) => s + d.input, 0);
  const totalOutput = data.reduce((s, d) => s + d.output, 0);
  const total = totalInput + totalOutput;
  const requests = data.reduce((s, d) => s + d.requests, 0);
  const attemptedRequests = data.reduce((s, d) => s + d.attemptedRequests, 0);
  const cacheUsageRequests = data.reduce((s, d) => s + d.cacheUsageRequests, 0);
  const totalCacheHit = data.reduce((s, d) => s + d.hit, 0);

  const set = (id: string, val: string) => {
    const el = document.getElementById(id);
    if (el) el.textContent = val;
  };
  set("token-total", total.toLocaleString());
  // 展示"有 usage 的请求数 / 总请求数"，让用户一眼看到统计覆盖率
  set("token-requests", attemptedRequests > 0
    ? `${requests.toLocaleString()} / ${attemptedRequests.toLocaleString()}`
    : requests.toLocaleString());
  set("token-input", totalInput.toLocaleString());
  set("token-output", totalOutput.toLocaleString());
  set("token-hit", cacheUsageRequests > 0
    ? `${totalCacheHit.toLocaleString()}${cacheUsageRequests < requests ? "（部分）" : ""}`
    : "暂无数据");

  set("token-cache-requests", requests.toLocaleString());
  set("token-cache-total", total.toLocaleString());
  set("token-cache-hit", totalCacheHit.toLocaleString());
  set("token-cache-rate", formatCacheRate({
    hit: totalCacheHit,
    miss: data.reduce((s, d) => s + d.miss, 0),
    requests,
    cacheUsageRequests,
  }));
}

// 刷新整个面板：调 IPC 拉真实数据 → 有数据渲染图表，无数据显示空态
async function refreshTokenPanel(days: number): Promise<void> {
  let report: TokenUsageReport = { days: [], models: [] };
  try {
    report = await window.tokenUsage?.get(days) ?? report;
  } catch (err) {
    console.warn("[settings] 拉取 Token 用量失败:", err);
  }

  const data = report.days;
  const hasData = data.some((d) => d.input > 0 || d.output > 0 || d.requests > 0 || d.attemptedRequests > 0);
  const emptyEl = document.getElementById("token-empty");
  const chartsEl = document.getElementById("token-charts");

  if (!hasData) {
    // 空态：隐藏图表区，显示空态提示，指标卡片归零
    if (emptyEl) emptyEl.classList.remove("is-hidden");
    if (chartsEl) chartsEl.classList.add("is-hidden");
    const set = (id: string, val: string) => { const el = document.getElementById(id); if (el) el.textContent = val; };
    set("token-total", "0");
    set("token-requests", "0");
    set("token-input", "0");
    set("token-output", "0");
    set("token-hit", "暂无数据");
    set("token-cache-requests", "0");
    set("token-cache-total", "0");
    set("token-cache-hit", "0");
    set("token-cache-rate", "模型未提供缓存统计");
    return;
  }

  // 有数据：显示图表区，隐藏空态
  if (emptyEl) emptyEl.classList.add("is-hidden");
  if (chartsEl) chartsEl.classList.remove("is-hidden");
  updateTokenStats(data);
  renderTokenBarChart(data);
  renderTokenTrendChart(data);
  renderModelUsage(report.models);
}

// 时间范围按钮交互
document.querySelectorAll<HTMLButtonElement>(".token-range__btn").forEach((btn) => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".token-range__btn").forEach((b) => {
      b.classList.remove("is-active");
      b.setAttribute("aria-selected", "false");
    });
    btn.classList.add("is-active");
    btn.setAttribute("aria-selected", "true");
    const days = Number(btn.dataset.range) || 7;
    void refreshTokenPanel(days);
  });
});

document.getElementById("token-usage-clear")?.addEventListener("click", async () => {
  // 统计清空不可恢复：危险确认，默认聚焦取消
  const confirmed = await showConfirm({
    title: "重置 Token 统计",
    message: "这会清空全部本地 Token、请求数和缓存统计，且无法恢复。",
    confirmText: "全部清空",
    dangerous: true,
  });
  if (!confirmed) return;
  const button = document.getElementById("token-usage-clear") as HTMLButtonElement | null;
  if (button) button.disabled = true;
  try {
    await window.tokenUsage?.clear();
    const days = Number(document.querySelector<HTMLButtonElement>(".token-range__btn.is-active")?.dataset.range) || 7;
    await refreshTokenPanel(days);
  } catch (err) {
    console.warn("[settings] 清空 Token 用量失败:", err);
  } finally {
    if (button) button.disabled = false;
  }
});

// 初始渲染
void refreshTokenPanel(7);
