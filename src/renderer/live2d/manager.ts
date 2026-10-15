import * as PIXI from "pixi.js";
import { Live2DModel } from "pixi-live2d-display/cubism4";
import type { HitAreaDef } from "./interaction";

export type { HitAreaDef } from "./interaction";

/**
 * Base window dimensions at zoom = 1.0. Must stay in sync with the matching
 * constants in src/main/index.ts (PET_WINDOW_BASE_WIDTH/HEIGHT). baseScale is
 * always computed against these fixed values so it stays zoom-invariant.
 */
const PET_WINDOW_BASE_WIDTH = 400;
const PET_WINDOW_BASE_HEIGHT = 500;

export interface Live2DManagerOptions {
  canvas: HTMLCanvasElement;
  width: number;
  height: number;
  modelPath: string;
  onLoad?: () => void;
  onError?: (err: Error) => void;
}

export interface Live2DResourceMetrics {
  appActive: boolean;
  modelLoaded: boolean;
  disposed: boolean;
  tickerStarted: boolean | null;
  stageChildren: number | null;
  textureCacheSize: number | null;
  rendererType: "webgl" | "unknown" | null;
  drawingBufferWidth: number | null;
  drawingBufferHeight: number | null;
}

interface MotionEntry {
  Name?: string;
  File?: string;
  Expression?: string;
  [k: string]: unknown;
}

interface ModelJsonShape {
  HitAreas?: { Name?: string; Id?: string; Motion?: string }[];
  FileReferences?: { Motions?: Record<string, MotionEntry[]> };
}

function buildHitAreaDefs(json: ModelJsonShape): HitAreaDef[] {
  const out: HitAreaDef[] = [];
  const hitAreas = json.HitAreas ?? [];
  const motions = json.FileReferences?.Motions ?? {};
  for (const area of hitAreas) {
    const name = area.Name;
    const id = area.Id;
    const trigger = area.Motion;
    if (!name || !id || !trigger) continue;
    const sep = trigger.indexOf(":");
    if (sep <= 0) continue;
    const group = trigger.substring(0, sep);
    const motionName = trigger.substring(sep + 1);
    const list = motions[group];
    const motionIndex = list ? list.findIndex((m) => m.Name === motionName) : -1;
    const motion = motionIndex >= 0 && list ? list[motionIndex] : undefined;
    const expressionName = motion?.Expression;
    out.push({ name, id, group, motionName, motionIndex, expressionName });
  }
  return out;
}

export class Live2DManager {
  private app: PIXI.Application | null = null;
  private model: Live2DModel | null = null;
  private hitAreaDefs: HitAreaDef[] = [];
  private options: Live2DManagerOptions;
  private disposed = false;
  private initPromise: Promise<void> | null = null;
  /** Scale that fits the model into the base window (zoom=1.0). Cached once
   *  at load so applyZoom can multiply it by the user's zoom factor. */
  private baseScale = 1;
  /** Current zoom factor (1.0 = default). Window size is driven separately by
   *  the main process; this only scales the model relative to baseScale. */
  private zoom = 1;

  constructor(options: Live2DManagerOptions) {
    this.options = options;
  }

  async init(): Promise<void> {
    if (this.disposed) return;
    if (this.initPromise) return this.initPromise;
    this.initPromise = this.initialize();
    try {
      await this.initPromise;
    } finally {
      this.initPromise = null;
    }
  }

  private async initialize(): Promise<void> {
    const { canvas, width, height } = this.options;
    this.app = new PIXI.Application({
      view: canvas,
      width,
      height,
      transparent: true,
      backgroundAlpha: 0,
      antialias: true,
      // Preserve the drawing buffer so callers can read pixels back out of
      // it at any time (e.g. the click-through controller sampling the alpha
      // under the cursor to decide transparent vs. opaque). Without this the
      // WebGL framebuffer is cleared after each frame and readPixels is UB.
      preserveDrawingBuffer: true,
      // Cap DPR to avoid an oversized WebGL drawing buffer on high-DPI
      // displays; 2x is enough visual fidelity for the pet window.
      resolution: Math.min(window.devicePixelRatio || 1, 2),
      autoDensity: true,
    });
    try {
      await this.loadModel();
    } catch (err) {
      this.options.onError?.(err instanceof Error ? err : new Error(String(err)));
      if (this.app) {
        this.app.destroy(false, { children: true, texture: true });
        this.app = null;
      }
    }
  }

  private async loadModel(): Promise<void> {
    const { modelPath } = this.options;
    // Kick off the Live2D load and the raw JSON fetch in parallel so the
    // hit-area definitions are ready the moment the model is.
    const modelPromise = Live2DModel.from(modelPath, {
      ticker: this.app!.ticker,
      autoHitTest: false,
      autoFocus: false,
    });
    const jsonPromise = fetch(modelPath).then((r) => {
      if (!r.ok) throw new Error("Failed to fetch " + modelPath + ": " + r.status);
      return r.json() as Promise<ModelJsonShape>;
    });
    let model: Live2DModel;
    let json: ModelJsonShape;
    try {
      [model, json] = await Promise.all([modelPromise, jsonPromise]);
    } catch (err) {
      // A JSON fetch failure can race with a successful Cubism load. Wait for
      // that model and destroy it before propagating the error so its textures
      // never survive an unsuccessful initialization attempt.
      const loadedModel = await modelPromise.catch(() => null);
      loadedModel?.destroy();
      throw err;
    }
    if (!this.app || this.disposed) {
      model.destroy();
      return;
    }
    this.model = model;
    this.hitAreaDefs = buildHitAreaDefs(json);
    this.app.stage.addChild(this.model);
    this.model.anchor.set(0.5, 0.5);
    // baseScale is always computed against the *base* window size, never the
    // current (possibly zoomed) one. The main process resizes the window to
    // base × zoom before the renderer loads, so reading the live window here
    // would fold zoom into baseScale and then applyZoom would double-count
    // it. Using fixed base dimensions keeps baseScale zoom-invariant.
    const baseScaleX = PET_WINDOW_BASE_WIDTH / this.model.width;
    const baseScaleY = PET_WINDOW_BASE_HEIGHT / this.model.height;
    this.baseScale = Math.min(baseScaleX, baseScaleY, 1.0);
    this.applyZoom(this.zoom);
    this.options.onLoad?.();
  }

  /**
   * Apply the user's zoom factor on top of the cached base scale. The window
   * itself is resized separately by the main process (window = base × zoom),
   * so this just sets model scale = baseScale × zoom and re-centres it in the
   * (now resized) canvas. Reads the live window size rather than the stale
   * constructor options, since the main process has already resized the
   * window by the time this is invoked. Proportions never change, so the
   * model always fills the window and is never clipped.
   */
  applyZoom(zoom: number): void {
    this.zoom = zoom;
    if (!this.model) return;
    this.model.scale.set(this.baseScale * zoom);
    this.resize(window.innerWidth, window.innerHeight);
  }

  getModel(): Live2DModel | null {
    return this.model;
  }

  /**
   * The underlying WebGL rendering context, or null before init/disposed.
   * Used by the click-through controller to sample pixel alpha under the
   * cursor (transparent -> click passes through, opaque -> capture).
   *
   * `app.renderer` is typed as the abstract `IRenderer`; only the concrete
   * WebGL `Renderer` exposes `.gl`, so we narrow with an instanceof check.
   */
  getGL(): WebGL2RenderingContext | null {
    const renderer = this.app?.renderer;
    return renderer instanceof PIXI.Renderer ? renderer.gl : null;
  }

  getHitAreaDefs(): HitAreaDef[] {
    return this.hitAreaDefs;
  }

  getResourceMetrics(): Live2DResourceMetrics {
    const gl = this.getGL();
    const textureCache = (PIXI as unknown as { utils?: { TextureCache?: Record<string, unknown> } }).utils?.TextureCache;
    return {
      appActive: this.app !== null,
      modelLoaded: this.model !== null,
      disposed: this.disposed,
      tickerStarted: this.app ? Boolean((this.app.ticker as unknown as { started?: boolean }).started) : null,
      stageChildren: this.app ? ((this.app.stage as unknown as { children?: unknown[] }).children?.length ?? null) : null,
      textureCacheSize: textureCache ? Object.keys(textureCache).length : null,
      rendererType: gl ? "webgl" : this.app ? "unknown" : null,
      drawingBufferWidth: gl?.drawingBufferWidth ?? null,
      drawingBufferHeight: gl?.drawingBufferHeight ?? null,
    };
  }

  resize(width: number, height: number): void {
    if (!this.app) return;
    this.app.renderer.resize(width, height);
    if (this.model) {
      this.model.x = width / 2;
      this.model.y = height / 2;
    }
  }

  /**
   * Pause the PIXI ticker. Stops all per-frame controllers (AutoBreath,
   * EyeBlink, MouseTracking, Physics) from advancing. The model freezes
   * on its last rendered frame.
   *
   * Used while the user is dragging the window, so that the Windows DWM
   * "drag image" stays bit-identical to the live canvas content -- this
   * kills the ghosting/flicker that transparent Electron windows show
   * during a drag on Windows.
   */
  pause(): void {
    if (this.app) this.app.ticker.stop();
  }

  /** Resume the PIXI ticker. See pause(). */
  resume(): void {
    if (!this.app) return;
    this.app.render();
    this.app.ticker.start();
  }

    dispose(): void {
    this.disposed = true;
    if (this.model) {
      this.model.destroy();
      this.model = null;
    }
    if (this.app) {
      this.app.destroy(false, { children: true, texture: true, baseTexture: true });
      this.app = null;
    }
    // Explicitly clear PIXI global texture caches so a reload/reinit does not
    // retain GPU memory from the previous model session.
    const pixiUtils = (PIXI as unknown as { utils?: { TextureCache?: Record<string, unknown>; BaseTextureCache?: Record<string, unknown> } }).utils;
    if (pixiUtils?.TextureCache) {
      for (const key of Object.keys(pixiUtils.TextureCache)) {
        delete pixiUtils.TextureCache[key];
      }
    }
    if (pixiUtils?.BaseTextureCache) {
      for (const key of Object.keys(pixiUtils.BaseTextureCache)) {
        delete pixiUtils.BaseTextureCache[key];
      }
    }
  }
}
