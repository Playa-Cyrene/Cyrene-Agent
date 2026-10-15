// qwen（通义千问）的注册表条目 —— 推理规则自 shared/reasoning.ts、能力自 capabilities.ts 原样迁入。
import { defineVendor, legacyMetadata } from "../define-vendor";

export const QWEN_REGISTRY = defineVendor({
  capability: {
    id: "qwen",
    displayName: "Qwen（通义千问）",
    transport: "openai",
    baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    authStyle: "bearer",
    defaultModel: "qwen-max",
    supportsTools: true,
    supportsThinking: true,
    thinkingField: "reasoning_content",
    cacheStrategy: "auto",
    testStrategy: "text",
    // 官方 OpenAI 兼容；Responses 由阿里云百炼中转（协议矩阵 2026-08-21）
    supportedTransports: ["openai", "responses"],
  },
  presetDefaults: {
    baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    transport: "openai",
  },
  models: [
    {
      model: "qwen-max",
      recommendedFor: ["chat"],
      unknownCapabilities: [
        { feature: "structuredOutput", transport: "openai", note: "预设协议没有专用结构化输出规则，保留提示词 JSON 回退。" },
      ],
    },
    {
      model: "qwen-plus",
      recommendedFor: ["chat"],
      unknownCapabilities: [
        { feature: "structuredOutput", transport: "openai", note: "预设协议没有专用结构化输出规则，保留提示词 JSON 回退。" },
      ],
    },
    {
      model: "qwen-turbo",
      recommendedFor: ["chat"],
      unknownCapabilities: [
        { feature: "structuredOutput", transport: "openai", note: "预设协议没有专用结构化输出规则，保留提示词 JSON 回退。" },
      ],
    },
  ],
  shortName: "Qwen",
  samplingRules: [
    {

      modelPattern: /^qwen-(?:max|plus|turbo)$/i,
      diversity: true,
      repetition: "qwen",
      maximumTemperature: 1.99,
      metadata: legacyMetadata("迁自 src/main/orchestrator/vendors/style-sampling.ts"),
    },
  ],
  structuredOutputRules: [
    {
      id: "qwen-json-object",

      transport: "openai",
      modelPattern: /^(?:qwen3\.(?:7-(?:max|plus)|[56]-plus)|qwen-flash)(?:$|-)/i,
      tier: "B",
      mode: "provider_json_object",
      verification: "official",
      metadata: legacyMetadata("迁自 src/main/orchestrator/structured-output/profiles.ts"),
    },
  ],
  reasoningRules: [
    // ── qwen（通义千问）──
    // /-thinking$/ 必须在 /^qwen3/ 之前。
    { familyLabel: "qwen-*-thinking 系列（厂商内后缀；跨厂商限明确千问前缀）", modelPattern: /-thinking$/i, modelInferencePattern: /^qwen(?:3(?:[.-].*)?|-(?:max|plus|turbo)(?:-.*)?)-thinking$/i, metadata: legacyMetadata("迁自 src/shared/vendor-registry/entries/qwen.ts"), capability: {
      control: "fixed-on",
      requestStyle: "none",
      supportsDisable: false,
    } },
    // qwen3 系列（含 3.5/3.6/3.7/3.8 全系，官方 2026-08-26 文档）：混合思考模式，
    // enable_thinking 开关控制，3.8 起默认开启思考。Chat Completions 无 effort 档位
    //（effort 仅 Responses API 支持；thinking_budget 实测不生效），保持纯 toggle。
    { familyLabel: "qwen3 系列（3.5 / 3.6 / 3.7 / 3.8）", modelPattern: /^qwen3/i, modelInferencePattern: /^qwen3/i, metadata: legacyMetadata("迁自 src/shared/vendor-registry/entries/qwen.ts"), capability: {
      control: "toggle",
      requestStyle: "qwen-enable-thinking",
      supportsDisable: true,
    } },
    { modelPattern: /^qwen-(max|plus|turbo)/i, modelInferencePattern: /^qwen-(max|plus|turbo)/i, metadata: legacyMetadata("迁自 src/shared/vendor-registry/entries/qwen.ts"), capability: {
      control: "toggle",
      requestStyle: "qwen-enable-thinking",
      supportsDisable: true,
    } },
  ],
});
