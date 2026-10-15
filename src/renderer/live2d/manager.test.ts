import { existsSync, readFileSync } from "node:fs";
import { InteractionController } from "./interaction";
import { describe, expect, it, vi } from "vitest";

/**
 * Mock pixi-live2d-display before importing manager.ts so we don't have to
 * boot a real WebGL context in the test runner.
 */
vi.mock("pixi-live2d-display/cubism4", () => {
  return {
    Live2DModel: class {
      static from = vi.fn();
      motion = vi.fn(async () => true);
      expression = vi.fn(async () => true);
      internalModel = { motionManager: { definitions: { "动作#6": [{}, {}, {}, {}] } } };
    },
  };
});

vi.mock("pixi.js", () => {
  return {
    Application: class {
      renderer = { resize: vi.fn(), gl: { drawingBufferWidth: 200, drawingBufferHeight: 100 } };
      stage = { children: [] as unknown[], addChild: vi.fn((child: unknown) => { this.stage.children.push(child); }) };
      ticker = { started: true, stop: vi.fn(() => { this.ticker.started = false; }), start: vi.fn(() => { this.ticker.started = true; }) };
      render = vi.fn();
      destroy = vi.fn();
    },
    Renderer: class {},
    utils: { TextureCache: { a: {}, b: {} } },
  };
});

// Minimal stub canvas; we never read pixels in these tests.
const fakeCanvas = {} as HTMLCanvasElement;

describe("Live2DManager", () => {
  it("deduplicates concurrent initialization so only one model is loaded", async () => {
    vi.clearAllMocks();
    vi.stubGlobal("window", { devicePixelRatio: 1, innerWidth: 100, innerHeight: 100 });
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => ({}) })));
    const { Live2DModel } = await import("pixi-live2d-display/cubism4");
    const model = {
      anchor: { set: vi.fn() }, scale: { set: vi.fn() }, width: 100, height: 100,
      destroy: vi.fn(), motion: vi.fn(), expression: vi.fn(), internalModel: { motionManager: { definitions: {} } },
    };
    vi.mocked(Live2DModel.from).mockResolvedValue(model as never);
    const { Live2DManager } = await import("./manager");
    const mgr = new Live2DManager({ canvas: fakeCanvas, width: 100, height: 100, modelPath: "/x" });

    await Promise.all([mgr.init(), mgr.init()]);

    expect(Live2DModel.from).toHaveBeenCalledTimes(1);
    mgr.dispose();
    vi.unstubAllGlobals();
  });

  it("reports resource metrics for app, model, ticker, and texture cache", async () => {
    vi.clearAllMocks();
    vi.stubGlobal("window", { devicePixelRatio: 2, innerWidth: 100, innerHeight: 100 });
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => ({}) })));
    const { Live2DModel } = await import("pixi-live2d-display/cubism4");
    const model = {
      anchor: { set: vi.fn() }, scale: { set: vi.fn() }, width: 100, height: 100,
      destroy: vi.fn(), motion: vi.fn(), expression: vi.fn(), internalModel: { motionManager: { definitions: {} } },
    };
    vi.mocked(Live2DModel.from).mockResolvedValue(model as never);
    const { Live2DManager } = await import("./manager");
    const mgr = new Live2DManager({ canvas: fakeCanvas, width: 100, height: 100, modelPath: "/x" });

    expect(mgr.getResourceMetrics()).toMatchObject({
      appActive: false,
      modelLoaded: false,
      disposed: false,
    });

    await mgr.init();

    expect(mgr.getResourceMetrics()).toMatchObject({
      appActive: true,
      modelLoaded: true,
      disposed: false,
      tickerStarted: true,
      stageChildren: 1,
    });

    mgr.dispose();
    expect(mgr.getResourceMetrics()).toMatchObject({
      appActive: false,
      modelLoaded: false,
      disposed: true,
    });
    vi.unstubAllGlobals();
  });

});

describe("retained click actions", () => {
  it("resolves and plays all actual model hit areas, including both swing ropes", async () => {
    const json = JSON.parse(readFileSync(new URL("../public/models/cyrene/Cyrene.model3.json", import.meta.url), "utf8"));
    const definitions = json.FileReferences.Motions;
    const names = new Set(json.FileReferences.Expressions.map((e: { Name: string }) => e.Name));
    vi.stubGlobal("window", { devicePixelRatio: 1, innerWidth: 400, innerHeight: 500 });
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => json })));
    const callbacks = new Map<string, (e: {clientX: number; clientY: number}) => void>();
    const canvas = { addEventListener: vi.fn((n, cb) => callbacks.set(n, cb)), removeEventListener: vi.fn((n) => callbacks.delete(n)) };
    let areaName = "";
    const model = { anchor: { set: vi.fn() }, scale: { set: vi.fn() }, width: 100, height: 100, destroy: vi.fn(),
      motion: vi.fn(async () => false), expression: vi.fn(async (name: string) => names.has(name)), hitTest: () => [areaName],
      internalModel: { motionManager: { definitions } } };
    const { Live2DModel } = await import("pixi-live2d-display/cubism4");
    vi.mocked(Live2DModel.from).mockResolvedValue(model as never);
    const { Live2DManager } = await import("./manager");
    const mgr = new Live2DManager({ canvas: canvas as never, width: 400, height: 500, modelPath: "/x" });
    await mgr.init();
    const trigger = vi.fn();
    const interaction = new InteractionController(canvas as never, model as never, mgr.getHitAreaDefs(), { onTrigger: trigger });
    try {
      expect(mgr.getHitAreaDefs()).toHaveLength(9);
      for (const area of json.HitAreas) {
        areaName = area.Name;
        const [group, name] = area.Motion.split(":");
        const def = definitions[group].find((d: {Name: string}) => d.Name === name);
        expect(def.File).toBeUndefined();
        expect(mgr.getHitAreaDefs().find((hit) => hit.name === area.Name)).toMatchObject({
          motionIndex: definitions[group].indexOf(def), expressionName: def.Expression,
        });
        trigger.mockClear(); model.expression.mockClear();
        callbacks.get("pointerdown")!({clientX: 10, clientY: 10});
        callbacks.get("pointerup")!({clientX: 10, clientY: 10});
        await vi.waitFor(() => expect(trigger).toHaveBeenCalledOnce());
        expect(model.expression).toHaveBeenCalledWith(def.Expression);
      }
    } finally { interaction.dispose(); mgr.dispose(); vi.unstubAllGlobals(); }
    expect(callbacks.size).toBe(0);
  });
});

describe("模型资源路径", () => {
  it("所有动作 URL 无片段且能定位实际文件", () => {
    const modelUrl = new URL("../public/models/cyrene/Cyrene.model3.json", import.meta.url);
    const json = JSON.parse(readFileSync(modelUrl, "utf8"));
    for (const entries of Object.values(json.FileReferences.Motions) as Array<Array<{ File?: string }>>) {
      for (const entry of entries) {
        if (!entry.File) continue;
        const resource = new URL(entry.File, modelUrl);
        expect(resource.hash).toBe("");
        expect(existsSync(resource)).toBe(true);
      }
    }
  });
});
