// doubao（火山方舟）的注册表条目 —— 推理规则自 shared/reasoning.ts、能力自 capabilities.ts 原样迁入。
import { defineVendor, legacyMetadata } from "../define-vendor";

export const DOUBAO_REGISTRY = defineVendor({
  capability: {
    id: "doubao",
    displayName: "豆包（火山方舟）",
    transport: "openai",
    baseUrl: "https://ark.cn-beijing.volces.com/api/v3",
    authStyle: "bearer",
    defaultModel: "doubao-seed-2-1-pro-260628",
    supportsTools: true,
    supportsThinking: true,
    thinkingField: "reasoning_content",
    cacheStrategy: "none",
    testStrategy: "text",
    // 火山方舟三格式全兼容（官方文档）
    supportedTransports: ["openai", "anthropic", "responses"],
  },
  presetDefaults: {
    baseUrl: "https://ark.cn-beijing.volces.com/api/v3",
    transport: "openai",
  },
  models: [
    {
      model: "doubao-seed-2-1-pro-260628",
      recommendedFor: ["chat"],
      unknownCapabilities: [
        { feature: "sampling", transport: "openai", note: "现有采样白名单未覆盖该型号。" },
      ],
    },
    {
      model: "doubao-seed-2-0-pro-260215",
      recommendedFor: ["chat"],
      unknownCapabilities: [
        { feature: "sampling", transport: "openai", note: "现有采样白名单未覆盖该型号。" },
      ],
    },
    {
      model: "doubao-seed-2-0-lite-260428",
      recommendedFor: ["chat"],
      unknownCapabilities: [
        { feature: "sampling", transport: "openai", note: "现有采样白名单未覆盖该型号。" },
      ],
    },
    {
      model: "doubao-seed-2-0-mini-260428",
      recommendedFor: ["chat"],
      unknownCapabilities: [
        { feature: "sampling", transport: "openai", note: "现有采样白名单未覆盖该型号。" },
      ],
    },
  ],
  shortName: "豆包",
  structuredOutputRules: [
    {
      id: "doubao-structured-output",

      transport: "openai",
      modelPattern: /^doubao-seed(?:$|-)/i,
      tier: "A",
      mode: "provider_json_schema",
      verification: "official",
      metadata: legacyMetadata("迁自 src/main/orchestrator/structured-output/profiles.ts"),
    },
  ],
  reasoningRules: [
    // ── doubao（火山方舟）──
    { familyLabel: "doubao-seed 系列", modelPattern: /^doubao-seed-/i, modelInferencePattern: /^doubao-seed-/i, metadata: legacyMetadata("迁自 src/shared/vendor-registry/entries/doubao.ts"), capability: {
      control: "toggle",
      requestStyle: "thinking-type",
      supportsDisable: true,
    } },
  ],
});
