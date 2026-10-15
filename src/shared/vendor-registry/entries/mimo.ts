// mimo（小米）的注册表条目 —— 推理规则自 shared/reasoning.ts、能力自 capabilities.ts 原样迁入。
import { defineVendor, legacyMetadata } from "../define-vendor";

export const MIMO_REGISTRY = defineVendor({
  capability: {
    id: "mimo",
    displayName: "MiMo（小米）",
    // 默认使用 OpenAI 入口；Anthropic 入口由用户在设置中明确选择。
    transport: "openai",
    baseUrl: "https://api.xiaomimimo.com/v1",
    // 官方文档：/v1 与 /anthropic 都支持 Authorization: Bearer
    authStyle: "bearer",
    // V2.6（2026-09-22 发布，原生全模态）为当前默认；V2.5 官方 2026-10-21 下线
    defaultModel: "mimo-v2.6-pro",
    supportsTools: true,
    supportsThinking: true,
    thinkingField: "reasoning_content",
    cacheStrategy: "auto",
    testStrategy: "text",
    // 结构上独立：用户切主入口到 /anthropic 时视觉仍由 visionBaseUrl 决定
    visionBaseUrl: "https://api.xiaomimimo.com/v1",
    // 三格式原生全支持（协议矩阵 2026-08-21）
    supportedTransports: ["openai", "anthropic", "responses"],
  },
  presetDefaults: {
    baseUrl: "https://api.xiaomimimo.com/v1",
    transport: "openai",
    anthropicBaseUrl: "https://api.xiaomimimo.com/anthropic",
    visionBaseUrl: "https://api.xiaomimimo.com/v1",
    defaultVisionModel: "mimo-v2.6-pro",
  },
  models: [
    {
      model: "mimo-v2.6-pro",
      recommendedFor: ["chat","vision"],
      unknownCapabilities: [
        { feature: "sampling", transport: "openai", note: "现有采样白名单未覆盖该型号。" },
      ],
    },
    {
      model: "mimo-v2.6-flash",
      recommendedFor: ["chat","vision"],
      unknownCapabilities: [
        { feature: "sampling", transport: "openai", note: "现有采样白名单未覆盖该型号。" },
      ],
    },
    {
      model: "mimo-v2.6-pro-ultraspeed",
      recommendedFor: ["chat"],
      unknownCapabilities: [
        { feature: "sampling", transport: "openai", note: "现有采样白名单未覆盖该型号。" },
      ],
    },
  ],
  shortName: "MiMo",
  samplingRules: [
    {

      modelPattern: /^mimo-v2\.5-pro$/i,
      diversity: true,
      requiresReasoningOff: true,
      metadata: legacyMetadata("迁自 src/main/orchestrator/vendors/style-sampling.ts"),
    },
  ],
  structuredOutputRules: [
    {
      id: "mimo-json-object",

      transport: "openai",
      // V2.6（2026-09-22 发布）与 V2.5 同 API 面（官方文档请求体一致），json_object
      // 同适用；V2.5 官方 2026-10-21 下线，模式保留至下线后清理。
      modelPattern: /^mimo-v2\.(?:5|6)(?:$|-)/i,
      tier: "B",
      mode: "provider_json_object",
      verification: "official",
      metadata: legacyMetadata("迁自 src/main/orchestrator/structured-output/profiles.ts"),
    },
  ],
  reasoningRules: [
    // ── mimo（小米）──
    // 跨 transport 共用：OpenAI 入口 + Anthropic 入口都生成 thinking.type。
    // V2.5 / V2.6 同一控制面（官方文档请求体一致）：thinking.type 仅 enabled/disabled
    // 开关、无 effort 档位，V2.6 无需单独条目。
    { familyLabel: "mimo-v2.x 系列（含 V2.5）", modelPattern: /^mimo-v2\./i, modelInferencePattern: /^mimo-v2\./i, metadata: legacyMetadata("迁自 src/shared/vendor-registry/entries/mimo.ts"), capability: {
      control: "toggle",
      requestStyle: "thinking-type",
      supportsDisable: true,
    } },
  ],
});
