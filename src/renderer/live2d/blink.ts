import type { Live2DModel } from "pixi-live2d-display/cubism4";

/** Interval between blinks (randomized each cycle). */
const MIN_INTERVAL_MS = 2500;
const MAX_INTERVAL_MS = 6000;
/** Closing / opening phase lengths. Total blink ≈ 210ms. */
const CLOSE_MS = 70;
const OPEN_MS = 140;

type CoreModelWithParameters = {
  setParameterValueById?: (id: string, value: number) => void;
};

type InternalModelLike = {
  on?: (event: string, cb: () => void) => unknown;
  off?: (event: string, cb: () => void) => unknown;
  coreModel?: CoreModelWithParameters;
};

const EYE_IDS = ["ParamEyeLOpen", "ParamEyeROpen"] as const;

function randomInterval(): number {
  return MIN_INTERVAL_MS + Math.random() * (MAX_INTERVAL_MS - MIN_INTERVAL_MS);
}

/**
 * Always-on auto blinking.
 *
 * The stock Cubism eye-blink controller is skipped while any motion is
 * playing, which left the pet staring blankly through the looping swing
 * motion. This controller writes the eye-open parameters from the
 * `beforeModelUpdate` hook — the same place the mouth sync uses — so blinks
 * run in every frame, motion or not, and always win over motion curves
 * (the eyes are whitelisted in the model's `Groups.EyeBlink`).
 */
export class BlinkController {
  private readonly model: Live2DModel;
  private hook: (() => void) | null = null;
  private disposed = false;
  private nextBlinkAt = 0;
  private blinkStart = 0;

  constructor(model: Live2DModel) {
    this.model = model;
    this.nextBlinkAt = performance.now() + randomInterval();
    const internal = model.internalModel as unknown as InternalModelLike;
    if (typeof internal.on !== "function" || typeof internal.off !== "function") return;
    this.hook = () => this.tickFrame();
    internal.on("beforeModelUpdate", this.hook);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
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

    if (now < this.nextBlinkAt) {
      this.setEyes(1);
      return;
    }

    if (this.blinkStart === 0) {
      this.blinkStart = now;
    }
    const elapsed = now - this.blinkStart;
    if (elapsed >= CLOSE_MS + OPEN_MS) {
      // Blink finished.
      this.blinkStart = 0;
      this.nextBlinkAt = now + randomInterval();
      this.setEyes(1);
      return;
    }

    // 1 -> 0 during CLOSE_MS, then 0 -> 1 during OPEN_MS (ease-in-out).
    let open: number;
    if (elapsed < CLOSE_MS) {
      open = 1 - elapsed / CLOSE_MS;
    } else {
      open = (elapsed - CLOSE_MS) / OPEN_MS;
    }
    this.setEyes(open * open * (3 - 2 * open));
  }

  private setEyes(open: number): void {
    try {
      const coreModel = (this.model.internalModel as unknown as { coreModel?: CoreModelWithParameters }).coreModel;
      if (!coreModel || typeof coreModel.setParameterValueById !== "function") return;
      for (const id of EYE_IDS) {
        coreModel.setParameterValueById(id, open);
      }
    } catch {
      /* eyes missing — ignore */
    }
  }
}
