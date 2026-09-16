import type { Live2DModel } from "pixi-live2d-display/cubism4";

const MAX_MOUTH_DURATION_MS = 5 * 60 * 1000;
const MOUTH_TICK_MS = 180;
const MIN_MOUTH_VALUE = 0.15;
const MAX_MOUTH_VALUE = 0.85;
/** Exponential smoothing time constant; keeps the open/close transitions soft. */
const SMOOTHING_TAU_MS = 70;
/** Once closing, detach the hook when the mouth is visually shut. */
const CLOSE_THRESHOLD = 0.02;
/** Clamp inter-frame gaps (tab throttling) so smoothing cannot jump. */
const MAX_FRAME_DELTA_MS = 100;

type CoreModelWithParameters = {
  setParameterValueById?: (id: string, value: number) => void;
  setParameterValueByIndex?: (index: number, value: number) => void;
  getParameterIndex?: (id: string) => number;
};

type InternalModelLike = {
  on?: (event: string, cb: () => void) => unknown;
  off?: (event: string, cb: () => void) => unknown;
  coreModel?: CoreModelWithParameters;
};

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

/**
 * Fake lip-sync driven per rendered frame.
 *
 * The parameter is written from the `beforeModelUpdate` hook, which runs after
 * motions/expressions/physics have applied their values and right before the
 * model is submitted for rendering — so the mouth always wins over any motion
 * curve, and the open/close target changes are exponentially smoothed instead
 * of snapping every 180ms.
 */
export class MouthSyncController {
  private readonly model: Live2DModel;
  private hook: (() => void) | null = null;
  private disposed = false;
  private endTime = 0;
  private lastToggleAt = 0;
  private lastFrameAt = 0;
  private closing = true;
  private mouthOpen = false;
  private target = 0;
  private current = 0;

  constructor(model: Live2DModel) {
    this.model = model;
  }

  start(durationMs: number): void {
    if (this.disposed) return;
    this.detach();
    const safeDuration = clamp(Number.isFinite(durationMs) ? durationMs : 0, 0, MAX_MOUTH_DURATION_MS);
    const now = performance.now();
    if (safeDuration <= 0) {
      this.beginClosing();
      return;
    }

    this.closing = false;
    this.endTime = now + safeDuration;
    this.lastToggleAt = now;
    this.lastFrameAt = now;
    this.mouthOpen = false;
    this.pickTarget();
    this.attach();
  }

  stop(): void {
    if (this.disposed || this.closing) return;
    this.beginClosing();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.detach();
  }

  private beginClosing(): void {
    this.detach();
    this.closing = true;
    this.target = 0;
    if (this.current < CLOSE_THRESHOLD) {
      this.setMouth(0);
      this.current = 0;
      return;
    }
    const now = performance.now();
    this.lastFrameAt = now;
    this.attach();
  }

  private pickTarget(): void {
    this.mouthOpen = !this.mouthOpen;
    const random = Math.random() * 0.18;
    this.target = this.mouthOpen
      ? MAX_MOUTH_VALUE - random
      : MIN_MOUTH_VALUE + random;
  }

  private attach(): void {
    if (this.disposed || this.hook !== null) return;
    const internal = this.model.internalModel as unknown as InternalModelLike;
    if (typeof internal.on !== "function" || typeof internal.off !== "function") {
      // No event bus (unexpected runtime) — fall back to a direct write.
      this.setMouth(this.target);
      return;
    }
    this.hook = () => this.tickFrame();
    internal.on("beforeModelUpdate", this.hook);
  }

  private detach(): void {
    if (this.hook === null) return;
    const internal = this.model.internalModel as unknown as InternalModelLike;
    try {
      internal.off?.("beforeModelUpdate", this.hook);
    } catch {
      /* already detached */
    }
    this.hook = null;
  }

  private tickFrame(): void {
    const now = performance.now();
    const dt = clamp(now - this.lastFrameAt, 0, MAX_FRAME_DELTA_MS);
    this.lastFrameAt = now;

    if (!this.closing) {
      if (now >= this.endTime) {
        this.beginClosing();
        if (this.hook === null) return;
      } else if (now - this.lastToggleAt >= MOUTH_TICK_MS) {
        this.lastToggleAt = now;
        this.pickTarget();
      }
    }

    const alpha = 1 - Math.exp(-dt / SMOOTHING_TAU_MS);
    this.current += (this.target - this.current) * alpha;
    this.setMouth(this.current);

    if (this.closing && this.current < CLOSE_THRESHOLD) {
      this.current = 0;
      this.setMouth(0);
      this.detach();
    }
  }

  private setMouth(value: number): void {
    try {
      const coreModel = (this.model.internalModel as unknown as { coreModel?: CoreModelWithParameters }).coreModel;
      if (!coreModel) return;
      if (typeof coreModel.setParameterValueById === "function") {
        coreModel.setParameterValueById("ParamMouthOpenY", value);
        return;
      }
      if (typeof coreModel.getParameterIndex === "function" && typeof coreModel.setParameterValueByIndex === "function") {
        const index = coreModel.getParameterIndex("ParamMouthOpenY");
        if (index >= 0) coreModel.setParameterValueByIndex(index, value);
      }
    } catch (err) {
      console.warn("[Cyrene] mouth sync failed", err);
      this.detach();
    }
  }
}
