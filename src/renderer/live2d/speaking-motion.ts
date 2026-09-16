import type { Live2DModel } from "pixi-live2d-display/cubism4";
import { MotionPriority } from "pixi-live2d-display/cubism4";

/** Motion group holding the designer-made idle swing animation. */
const SWING_GROUP = "Tick3";
/** Definition name of the 60.333s looping swing motion inside that group. */
const SWING_MOTION_NAME = "荡秋千（待机）";
/** Fallback index (4th entry) if the definition is renamed upstream. */
const FALLBACK_SWING_INDEX = 3;
/** Duration for easing swing-driven parameters back to neutral on stop. */
const RESTORE_DURATION_MS = 350;

/**
 * Parameters written by the swing motion that have no other owner. When the
 * motion is stopped mid-swing they would freeze at their last value (rope
 * pulled, swing visible), so we ease them back to 0 manually.
 */
const SWING_PARAMS = ["Param32", "Param13", "Param14"] as const;

type CoreModelWithParameters = {
  setParameterValueById?: (id: string, value: number) => void;
  getParameterValueById?: (id: string) => number;
};

type InternalModelLike = {
  motionManager: {
    definitions?: Record<string, ReadonlyArray<{ Name?: string }>>;
    stopAllMotions: () => void;
  };
  on?: (event: string, cb: () => void) => unknown;
  off?: (event: string, cb: () => void) => unknown;
  coreModel?: CoreModelWithParameters;
};

function easeOutCubic(t: number): number {
  const inv = 1 - t;
  return 1 - inv * inv * inv;
}

/**
 * Drives the "swing while speaking" effect.
 *
 * Instead of toggling expressions on a timer (which produced a robotic
 * square-wave pull), this plays the designer-made looping swing motion from
 * the model itself. The motion's Param32 keyframes feed the physics rig
 * (PhysicsSetting1), so the swing gets natural pendulum inertia. On stop the
 * motion is cut and the swing-owned parameters are eased back to neutral via
 * the `beforeModelUpdate` hook so the pose never freezes mid-air.
 */
export class SpeakingMotionController {
  private readonly model: Live2DModel;
  private disposed = false;
  private restoreHook: (() => void) | null = null;
  private restoreStart = 0;
  private restoreFrom: number[] = [];

  constructor(model: Live2DModel) {
    this.model = model;
  }

  start(): void {
    if (this.disposed) return;
    this.detachRestore();
    void this.playSwingMotion();
  }

  stop(): void {
    if (this.disposed) return;
    this.detachRestore();
    const internal = this.model.internalModel as unknown as InternalModelLike;
    try {
      internal.motionManager.stopAllMotions();
    } catch (err) {
      console.warn("[Cyrene] stop swing motion failed", err);
    }
    this.attachRestore();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.detachRestore();
  }

  private async playSwingMotion(): Promise<void> {
    const index = this.findSwingIndex();
    if (index < 0) return;
    try {
      // IDLE priority: only starts when nothing else is playing, and any
      // NORMAL motion (LLM actions, hit-area reactions) can interrupt it.
      await this.model.motion(SWING_GROUP, index, MotionPriority.IDLE);
    } catch (err) {
      console.warn("[Cyrene] swing motion failed", err);
    }
  }

  private findSwingIndex(): number {
    const internal = this.model.internalModel as unknown as InternalModelLike;
    const defs = internal.motionManager.definitions?.[SWING_GROUP];
    if (!Array.isArray(defs) || defs.length === 0) return -1;
    const byName = defs.findIndex((def) => def?.Name === SWING_MOTION_NAME);
    if (byName >= 0) return byName;
    return FALLBACK_SWING_INDEX < defs.length ? FALLBACK_SWING_INDEX : -1;
  }

  /**
   * The hook must stay attached for as long as the neutral value should hold:
   * Cubism restores the saved (motion-era) parameter values at the top of each
   * frame, so writing once outside the frame loop would be undone.
   */
  private attachRestore(): void {
    const internal = this.model.internalModel as unknown as InternalModelLike;
    const coreModel = internal.coreModel;
    if (!coreModel || typeof internal.on !== "function" || typeof internal.off !== "function") return;

    this.restoreFrom = SWING_PARAMS.map((id) => {
      try {
        return typeof coreModel.getParameterValueById === "function" ? (coreModel.getParameterValueById(id) ?? 0) : 0;
      } catch {
        return 0;
      }
    });
    if (this.restoreFrom.every((value) => Math.abs(value) < 0.001)) return;

    this.restoreStart = performance.now();
    this.restoreHook = () => {
      const core = (this.model.internalModel as unknown as InternalModelLike).coreModel;
      const setParam = core?.setParameterValueById;
      if (typeof setParam !== "function") return;
      const t = Math.min(1, (performance.now() - this.restoreStart) / RESTORE_DURATION_MS);
      const fade = 1 - easeOutCubic(t);
      SWING_PARAMS.forEach((id, i) => {
        try {
          setParam.call(core, id, this.restoreFrom[i] * fade);
        } catch {
          /* parameter missing — nothing to restore */
        }
      });
    };
    internal.on("beforeModelUpdate", this.restoreHook);
  }

  private detachRestore(): void {
    if (this.restoreHook === null) return;
    const internal = this.model.internalModel as unknown as InternalModelLike;
    try {
      internal.off?.("beforeModelUpdate", this.restoreHook);
    } catch {
      /* already detached */
    }
    this.restoreHook = null;
    this.restoreFrom = [];
  }
}
