// image-router 路由判定表回归测试：
// 全部 6 种组合（multimodal × 协议 × 视觉配置）都必须有确定结果，
// 任何"返回注定失败配置"的状态都是回归。

import { describe, it, expect } from "vitest";
import { resolveImageRoute, resolveCaptionVisionConfig } from "./image-router";
import type { ModelSettings } from "../settings/model-settings";
import { normalizeModelSettings } from "../settings/model-settings";

/** 构造一份最小可用的模型设置。explicitTransport 同步写入顶层和 perProvider（顶层只是镜像，真值在 perProvider）。 */
function makeSettings(overrides: Partial<ModelSettings>): ModelSettings {
  const transport = overrides.explicitTransport ?? "openai";
  return normalizeModelSettings({
    provider: "测试厂商",
    baseUrl: "https://api.example.com/v1",
    model: "test-model",
    apiKey: "sk-test",
    explicitTransport: transport,
    perProvider: {
      "测试厂商": {
        baseUrl: "https://api.example.com/v1",
        model: "test-model",
        apiKey: "sk-test",
        explicitTransport: transport,
      },
    },
    runtimeSync: "off",
    stickerEnabled: true,
    stickerSize: "standard",
    stickerSimilarityThreshold: 0.55,
    chatRequestTimeoutSec: 300,
    citaRepairBudgetSec: 8,
    rerankerMode: "standard",
    embeddingModel: "bgem3",
    contextWindowTokens: 256000,
    ...overrides,
  } as Partial<ModelSettings>);
}

const VISION = {
  baseUrl: "https://api.vlm.example.com/v1",
  apiKey: "sk-vlm",
  model: "vlm-model",
};

describe("resolveImageRoute 统一路由", () => {
  it("多模态主模型 → 直发（不管协议、不管视觉配置）", () => {
    const route = resolveImageRoute("attachment", makeSettings({
      multimodal: true,
      explicitTransport: "anthropic",
      vision: VISION,
    }));
    expect(route).toEqual({ mode: "direct" });
  });

  it("纯文本主模型 + 已配视觉模型 → caption，且返回视觉配置", () => {
    const route = resolveImageRoute("tool", makeSettings({
      multimodal: false,
      vision: VISION,
    }));
    expect(route).toEqual({ mode: "caption", config: VISION });
  });

  it("纯文本主模型 + 视觉模型三字段不全 → reject", () => {
    const route = resolveImageRoute("channel", makeSettings({
      multimodal: false,
      vision: { baseUrl: "https://api.vlm.example.com/v1", apiKey: "", model: "vlm-model" },
    }));
    expect(route.mode).toBe("reject");
    if (route.mode === "reject") {
      expect(route.reason).toContain("视觉模型");
    }
  });

  it("纯文本主模型 + 无视觉模型 → reject，提示里带修复指引", () => {
    const route = resolveImageRoute("moments", makeSettings({ multimodal: false }));
    expect(route.mode).toBe("reject");
    if (route.mode === "reject") {
      expect(route.reason).toContain("设置");
    }
  });
});

describe("resolveCaptionVisionConfig 图片转述", () => {
  it("纯文本 + 视觉模型已配 → 视觉模型", () => {
    const result = resolveCaptionVisionConfig(makeSettings({
      multimodal: false,
      vision: VISION,
    }));
    expect(result).toEqual({ ok: true, config: VISION });
  });

  it("纯文本 + 无视觉模型 → 拒绝", () => {
    const result = resolveCaptionVisionConfig(makeSettings({ multimodal: false }));
    expect(result.ok).toBe(false);
  });

  it("多模态 + OpenAI 兼容 → 主模型兼职看图（沿用现状）", () => {
    const result = resolveCaptionVisionConfig(makeSettings({ multimodal: true }));
    expect(result).toEqual({
      ok: true,
      config: { baseUrl: "https://api.example.com/v1", apiKey: "sk-test", model: "test-model" },
    });
  });

  it("多模态 + Anthropic + 已配视觉模型 → 视觉模型（不再 404）", () => {
    const result = resolveCaptionVisionConfig(makeSettings({
      multimodal: true,
      explicitTransport: "anthropic",
      vision: VISION,
    }));
    expect(result).toEqual({ ok: true, config: VISION });
  });

  it("多模态 + Anthropic + 无视觉模型 → 显式拒绝（原为必然 404）", () => {
    const result = resolveCaptionVisionConfig(makeSettings({
      multimodal: true,
      explicitTransport: "anthropic",
    }));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("Anthropic");
      expect(result.error).toContain("视觉模型");
    }
  });
});
