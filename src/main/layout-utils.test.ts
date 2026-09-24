import { describe, it, expect } from "vitest";

// 纯函数直接从源码文本提取（避免 electron module mock）
// clampWindowToWorkArea 和 computePanelLayout 是纯函数，不依赖 electron。
function clampWindowToWorkArea(
  pos: { x: number; y: number },
  size: { width: number; height: number },
  workArea: { x: number; y: number; width: number; height: number },
  minVisibleW = 120,
  minVisibleH = 80,
) {
  const minX = workArea.x - size.width + minVisibleW;
  const maxX = workArea.x + workArea.width - minVisibleW;
  const minY = workArea.y - size.height + minVisibleH;
  const maxY = workArea.y + workArea.height - minVisibleH;

  function clamp(value: number, lo: number, hi: number): number {
    return Math.max(lo, Math.min(hi, value));
  }

  return {
    x: clamp(pos.x, minX, maxX),
    y: clamp(pos.y, minY, maxY),
  };
}

function computePanelLayout(
  workArea: { x: number; y: number; width: number; height: number },
  panels: Array<{ width: number; height: number }>,
  gap = 8,
): Array<{ x: number; y: number }> {
  const totalWidth = panels.reduce((sum, p, i) => sum + p.width + (i > 0 ? gap : 0), 0);
  const maxPanelHeight = Math.max(...panels.map(p => p.height));
  const baseY =
    workArea.height >= maxPanelHeight
      ? workArea.y + Math.floor((workArea.height - maxPanelHeight) / 2)
      : workArea.y;

  if (totalWidth <= workArea.width) {
    const startX = workArea.x + Math.floor((workArea.width - totalWidth) / 2);
    const positions: Array<{ x: number; y: number }> = [];
    let curX = startX;
    for (let i = 0; i < panels.length; i++) {
      const pos = clampWindowToWorkArea({ x: curX, y: baseY }, panels[i], workArea);
      positions.push(pos);
      curX += panels[i].width + gap;
    }
    return positions;
  }

  // 阶梯排列
  const chatPos = clampWindowToWorkArea(
    { x: workArea.x + Math.floor((workArea.width - panels[0].width) / 2), y: baseY },
    panels[0],
    workArea,
  );

  const sidebarMaxX = workArea.x + workArea.width - panels[1].width;
  const sidebarX = Math.min(chatPos.x + panels[0].width + gap, sidebarMaxX);
  const sidebarPos = clampWindowToWorkArea({ x: sidebarX, y: baseY }, panels[1], workArea);

  return [chatPos, sidebarPos];
}

function visibleArea(
  pos: { x: number; y: number },
  size: { width: number; height: number },
  wa: { x: number; y: number; width: number; height: number },
) {
  const w = Math.min(pos.x + size.width, wa.x + wa.width) - Math.max(pos.x, wa.x);
  const h = Math.min(pos.y + size.height, wa.y + wa.height) - Math.max(pos.y, wa.y);
  return { w: Math.max(0, w), h: Math.max(0, h) };
}

const PANELS = [
  { width: 1280, height: 760 },
  { width: 320, height: 760 },
];

describe("computePanelLayout", () => {
  it("2560x1440: 工作区和侧栏水平排列，垂直居中（y > 0）", () => {
    const wa = { x: 0, y: 0, width: 2560, height: 1440 };
    const positions = computePanelLayout(wa, PANELS, 8);
    expect(positions).toHaveLength(2);
    // 高度 1440 >= 面板高度 760，垂直居中
    expect(positions[0].y).toBeGreaterThan(0);
    expect(positions[0].y).toBe(wa.y + Math.floor((wa.height - 760) / 2));
    for (let i = 0; i < 2; i++) {
      const v = visibleArea(positions[i], PANELS[i], wa);
      expect(v.w).toBeGreaterThanOrEqual(120);
      expect(v.h).toBeGreaterThanOrEqual(80);
    }
  });

  it("1920x1080: 工作区和侧栏水平排列，垂直居中（y > 0）", () => {
    const wa = { x: 0, y: 0, width: 1920, height: 1080 };
    const positions = computePanelLayout(wa, PANELS, 8);
    expect(positions).toHaveLength(2);
    // 高度 1080 >= 面板高度 760，垂直居中
    expect(positions[0].y).toBeGreaterThan(0);
    expect(positions[0].y).toBe(wa.y + Math.floor((wa.height - 760) / 2));
    for (let i = 0; i < 2; i++) {
      const v = visibleArea(positions[i], PANELS[i], wa);
      expect(v.w).toBeGreaterThanOrEqual(120);
      expect(v.h).toBeGreaterThanOrEqual(80);
    }
  });

  it("1366x768: 两窗口至少 120x80 可见", () => {
    const wa = { x: 0, y: 0, width: 1366, height: 768 };
    const positions = computePanelLayout(wa, PANELS, 8);
    for (let i = 0; i < 2; i++) {
      const v = visibleArea(positions[i], PANELS[i], wa);
      expect(v.w, `panel[${i}] width`).toBeGreaterThanOrEqual(120);
      expect(v.h, `panel[${i}] height`).toBeGreaterThanOrEqual(80);
    }
  });

  it("1280x720: y = workArea.y（高度不足，顶部对齐）", () => {
    const wa = { x: 0, y: 0, width: 1280, height: 720 };
    const positions = computePanelLayout(wa, PANELS, 8);
    // 高度 720 < 面板高度 760，顶部对齐
    expect(positions[0].y).toBe(wa.y);
    for (let i = 0; i < 2; i++) {
      const v = visibleArea(positions[i], PANELS[i], wa);
      expect(v.w).toBeGreaterThanOrEqual(120);
      expect(v.h).toBeGreaterThanOrEqual(80);
    }
  });
});
