import { screen } from "electron";

export interface PanelLayout { x: number; y: number; }

/**
 * 将窗口位置 clamp 到 workArea 内，保证至少 minVisibleW × minVisibleH 可见。
 * 允许窗口部分超出屏幕（可正可负），但可见区域不少于指定阈值。
 */
export function clampWindowToWorkArea(
  pos: PanelLayout,
  size: { width: number; height: number },
  workArea: { x: number; y: number; width: number; height: number },
  minVisibleW = 120,
  minVisibleH = 80,
): PanelLayout {
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

/**
 * 计算多面板自适应布局。
 *
 * 策略：
 * - 水平排列：totalWidth <= workArea.width → 工作区与侧栏水平居中
 * - 阶梯排列：totalWidth > workArea.width → 工作区居中，侧栏贴右
 *
 * 所有窗口均 clampWindowToWorkArea 保证至少 120×80 可见。
 */
export function computePanelLayout(
  workArea: { x: number; y: number; width: number; height: number },
  panels: Array<{ width: number; height: number }>,
  gap = 8,
): PanelLayout[] {
  const totalWidth = panels.reduce((sum, p, i) => sum + p.width + (i > 0 ? gap : 0), 0);
  const maxPanelHeight = Math.max(...panels.map(p => p.height));
  const baseY =
    workArea.height >= maxPanelHeight
      ? workArea.y + Math.floor((workArea.height - maxPanelHeight) / 2)
      : workArea.y;

  if (totalWidth <= workArea.width) {
    // 水平居中排列
    const startX = workArea.x + Math.floor((workArea.width - totalWidth) / 2);
    const positions: PanelLayout[] = [];
    let curX = startX;
    for (let i = 0; i < panels.length; i++) {
      const pos = clampWindowToWorkArea({ x: curX, y: baseY }, panels[i], workArea);
      positions.push(pos);
      curX += panels[i].width + gap;
    }
    return positions;
  }

  // 阶梯排列：总宽超屏
  // chat: 居中（clamp 后）
  const chatPos = clampWindowToWorkArea(
    { x: workArea.x + Math.floor((workArea.width - panels[0].width) / 2), y: baseY },
    panels[0],
    workArea,
  );

  // sidebar: 优先 chat 右侧有 gap；不够则贴 workArea 右边缘
  const sidebarMaxX = workArea.x + workArea.width - panels[1].width;
  const sidebarX = Math.min(chatPos.x + panels[0].width + gap, sidebarMaxX);
  const sidebarPos = clampWindowToWorkArea({ x: sidebarX, y: baseY }, panels[1], workArea);
  return [chatPos, sidebarPos];
}

// 计算 chat / sidebar 两个窗口的初始位置。
// 规则：优先鼠标所在 display；窗口自适应 workArea，保证至少 120×80 可见。
export function computeLayout(): {
  chat: PanelLayout;
  sidebar: PanelLayout;
} {
  const cursor = screen.getCursorScreenPoint();
  const displays = screen.getAllDisplays();
  const display =
    displays.find(d => {
      const { x, y, width, height } = d.workArea;
      return cursor.x >= x && cursor.x < x + width && cursor.y >= y && cursor.y < y + height;
    }) ?? screen.getPrimaryDisplay();

  const { workArea } = display;
  const panels = [
    { width: 1280, height: 760 }, // chat
    { width: 320, height: 760 },  // sidebar
  ];
  const [chatPos, sidebarPos] = computePanelLayout(workArea, panels, 8);
  return { chat: chatPos, sidebar: sidebarPos };
}
