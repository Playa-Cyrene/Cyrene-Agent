import type { Live2DModel } from "pixi-live2d-display/cubism4";

export interface ExpressionResetOptions {
  intervalMs?: number;
  expressionName?: string;
}

/** Periodically returns the model to its neutral expression. */
export class ExpressionResetController {
  private readonly model: Live2DModel;
  private readonly intervalMs: number;
  private readonly expressionName: string;
  private timer: number | null = null;
  private disposed = false;

  constructor(model: Live2DModel, options: ExpressionResetOptions = {}) {
    this.model = model;
    this.intervalMs = options.intervalMs ?? 3 * 60 * 1000;
    this.expressionName = options.expressionName ?? "表情回正";
    this.start();
  }

  restart(): void {
    if (this.disposed) return;
    this.stop();
    this.start();
  }

  async resetNow(): Promise<boolean> {
    if (this.disposed) return false;
    try {
      return await this.model.expression(this.expressionName);
    } catch (err) {
      console.warn("[Cyrene] expression reset failed", this.expressionName, err);
      return false;
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.stop();
  }

  private start(): void {
    if (this.timer !== null) return;
    this.timer = window.setInterval(() => {
      void this.resetNow();
    }, this.intervalMs);
  }

  private stop(): void {
    if (this.timer === null) return;
    window.clearInterval(this.timer);
    this.timer = null;
  }
}
