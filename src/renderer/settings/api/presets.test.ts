import { describe, expect, it } from "vitest";
import { MODEL_PRESETS, presetTransportUrl } from "./presets";

describe("provider preset transport endpoints", () => {
  it("keeps provider display order and custom entries independent of new candidates", () => {
    expect(MODEL_PRESETS.map(({ providerId }) => providerId)).toEqual([
      "minimax", "deepseek", "doubao", "glm", "kimi", "qwen", "chatgpt", "claude", "mimo", "grok", "gemini", "custom-cloud", "custom-local",
    ]);
    expect(MODEL_PRESETS.slice(-2).map(({ mainModels }) => mainModels)).toEqual([[], []]);
  });

  it("keeps MiMo vision defaults and custom endpoint presentation", () => {
    const mimo = MODEL_PRESETS.find((preset) => preset.providerId === "mimo")!;
    expect(mimo.visionModels).toEqual(["mimo-v2.6-pro", "mimo-v2.6-flash"]);
    expect(mimo.defaultVisionModel).toBe("mimo-v2.6-pro");
    expect(mimo.visionBaseUrl).toBe("https://api.xiaomimimo.com/v1");
    expect(MODEL_PRESETS.at(-1)?.hiddenInPresetList).toBe(true);
    expect(MODEL_PRESETS.at(-2)?.customEndpointMode).toBe("cloud");
  });

  it("uses MiniMax's official Responses endpoint and retains its existing defaults", () => {
    const minimax = MODEL_PRESETS.find((preset) => preset.providerId === "minimax");
    expect(minimax).toBeDefined();
    expect(presetTransportUrl(minimax!, "responses")).toBe("https://api.minimax.cn/v1");
    expect(presetTransportUrl(minimax!, "anthropic")).toBe("https://api.minimaxi.com/anthropic");
    expect(presetTransportUrl(minimax!, "openai")).toBe("https://api.minimaxi.com/v1");
  });
});
