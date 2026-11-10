import { describe, expect, it } from "vitest";
import { PROVIDER_CAPABILITIES } from "../../../main/orchestrator/vendors/capabilities";
import { MODEL_PRESETS, presetTransportUrl } from "./presets";

describe("provider preset transport endpoints", () => {
  it("uses Sonnet 5.5 for both Claude runtime fallback and new-profile default", () => {
    const claude = MODEL_PRESETS.find((preset) => preset.providerId === "claude")!;
    const runtime = PROVIDER_CAPABILITIES.find((capability) => capability.id === "claude")!;
    expect(runtime.defaultModel).toBe("claude-sonnet-5-5");
    expect(claude.mainModels[0]).toBe(runtime.defaultModel);
    expect(claude.mainModels).toContain("claude-sonnet-4-6");
    expect(claude.mainModels).toContain("claude-fable-5-2");
  });

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
