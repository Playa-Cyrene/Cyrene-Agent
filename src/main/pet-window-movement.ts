import type { Rectangle, Size } from "electron";
import { normalizeWindowCoordinate, normalizeWindowPosition, type WindowPosition } from "./window-position";

export interface PetWindowLike {
  isDestroyed(): boolean;
  getPosition(): number[];
  setBounds(bounds: Rectangle, animate?: boolean): void;
}

type PositionLogger = (message: string, error: unknown) => void;

export class PetWindowMoveController {
  private pendingPosition: WindowPosition | null = null;
  private moveTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly getWindow: () => PetWindowLike | null,
    private readonly getWindowSize: () => Size,
    private readonly persistPosition: (position: WindowPosition) => void,
    private readonly logWarning: PositionLogger = (message, error) => console.warn(message, error),
  ) {}

  moveRelative(dx: unknown, dy: unknown): void {
    const normalizedDx = normalizeWindowCoordinate(dx);
    const normalizedDy = normalizeWindowCoordinate(dy);
    if (normalizedDx === null || normalizedDy === null) return;

    const window = this.getUsableWindow();
    if (!window) return;
    try {
      const [x, y] = window.getPosition();
      const position = normalizeWindowPosition(x + normalizedDx, y + normalizedDy);
      if (!position) return;
      this.applyPosition(window, position);
    } catch (error) {
      this.logWarning("[Cyrene] Failed to move pet window relatively:", error);
    }
  }

  queueAbsolute(x: unknown, y: unknown): void {
    const position = normalizeWindowPosition(x, y);
    if (!position) return;
    this.pendingPosition = position;
    if (this.moveTimer !== null) return;
    this.moveTimer = setTimeout(() => {
      this.moveTimer = null;
      this.flushPending();
    }, 16);
  }

  finishDragging(): void {
    if (this.moveTimer !== null) {
      clearTimeout(this.moveTimer);
      this.moveTimer = null;
    }
    this.flushPending();

    const window = this.getUsableWindow();
    if (!window) return;
    try {
      const [x, y] = window.getPosition();
      const position = normalizeWindowPosition(x, y);
      if (position) this.persistPosition(position);
    } catch (error) {
      this.logWarning("[Cyrene] Failed to persist the pet window position:", error);
    }
  }

  dispose(): void {
    if (this.moveTimer !== null) clearTimeout(this.moveTimer);
    this.moveTimer = null;
    this.pendingPosition = null;
  }

  private flushPending(): void {
    const position = this.pendingPosition;
    this.pendingPosition = null;
    if (!position) return;

    const window = this.getUsableWindow();
    if (!window) return;
    try {
      this.applyPosition(window, position);
    } catch (error) {
      this.logWarning("[Cyrene] Failed to move pet window:", error);
    }
  }

  private applyPosition(window: PetWindowLike, position: WindowPosition): void {
    const currentPosition = window.getPosition();
    const current = normalizeWindowPosition(currentPosition[0], currentPosition[1]);
    if (current?.x === position.x && current.y === position.y) return;
    // 固定配置中的逻辑尺寸，避免分数缩放下连续移动时累积像素取整误差。
    window.setBounds({ ...position, ...this.getWindowSize() }, false);
  }

  private getUsableWindow(): PetWindowLike | null {
    const window = this.getWindow();
    return window && !window.isDestroyed() ? window : null;
  }
}
