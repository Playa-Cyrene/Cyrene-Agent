import { describe, expect, it } from "vitest";
import {
  applyManualReasoningBody,
  normalizeManualReasoningConfig,
  resolveConfiguredReasoningCapability,
} from "./manual-reasoning";

describe("单模型手动推理适配", () => {
  it("让未收录模型使用用户指定的档位和请求格式", () => {
    const config = normalizeManualReasoningConfig({
      style: "openai-effort",
      supportedEfforts: ["low", "high", "max"],
      defaultEffort: "high",
      supportsDisable: true,
    });

    expect(config).toBeDefined();
    expect(resolveConfiguredReasoningCapability("custom", "unknown-model", config)).toMatchObject({
      control: "toggle-effort",
      requestStyle: "openai-effort",
      supportedEfforts: ["low", "high", "max"],
      defaultEffort: "high",
      supportsDisable: true,
    });
  });

  it("根据当前滑块档位注入自定义请求片段，不修改原请求", () => {
    const config = normalizeManualReasoningConfig({
      style: "custom",
      supportedEfforts: ["high", "max"],
      defaultEffort: "high",
      supportsDisable: true,
      customBodies: {
        high: { reasoning: { effort: "high" } },
        max: { reasoning: { effort: "max" } },
        off: { reasoning: { effort: "none" } },
      },
    });
    expect(config).toBeDefined();
    const base = { model: "unknown-model", input: "hello" };

    expect(applyManualReasoningBody(base, config, { mode: "on", effort: "max" })).toEqual({
      model: "unknown-model",
      input: "hello",
      reasoning: { effort: "max" },
    });
    expect(applyManualReasoningBody(base, config, { mode: "off" })).toEqual({
      model: "unknown-model",
      input: "hello",
      reasoning: { effort: "none" },
    });
    expect(base).toEqual({ model: "unknown-model", input: "hello" });
  });

  it("拒绝覆盖请求核心字段的自定义片段", () => {
    expect(normalizeManualReasoningConfig({
      style: "custom",
      supportedEfforts: ["high"],
      defaultEffort: "high",
      supportsDisable: false,
      customBodies: { high: { model: "other-model" } },
    })).toBeUndefined();
  });
});
