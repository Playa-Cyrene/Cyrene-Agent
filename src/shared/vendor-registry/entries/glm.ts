// glm（智谱）的注册表条目 —— 推理规则自 shared/reasoning.ts、能力自 capabilities.ts 原样迁入。
import { defineVendor, legacyMetadata } from "../define-vendor";

export const GLM_REGISTRY = defineVendor({
  capability: {
    id: "glm",
    displayName: "GLM（智谱）",
    transport: "openai",
    baseUrl: "https://open.bigmodel.cn/api/paas/v4",
    authStyle: "bearer",
    defaultModel: "glm-5.2",
    supportsTools: true,
    supportsThinking: true,
    thinkingField: "reasoning_content",
    cacheStrategy: "auto",
    testStrategy: "text",
    // OpenAI 兼容 + Anthropic 兼容（协议矩阵 2026-08-21，用户确认）
    supportedTransports: ["openai", "anthropic"],
  },
  presetDefaults: {
    baseUrl: "https://open.bigmodel.cn/api/paas/v4",
    transport: "openai",
    anthropicBaseUrl: "https://open.bigmodel.cn/api/anthropic",
  },
  models: [
    {
      model: "glm-5.3",
      recommendedFor: ["chat"],
    },
    {
      model: "glm-5.3-flash",
      recommendedFor: ["chat"],
      unknownCapabilities: [
        { feature: "sampling", transport: "openai", note: "现有采样白名单未覆盖该型号。" },
      ],
    },
    {
      model: "glm-5.3-flashx",
      recommendedFor: ["chat"],
      unknownCapabilities: [
        { feature: "sampling", transport: "openai", note: "现有采样白名单未覆盖该型号。" },
      ],
    },
    {
      model: "glm-5.2",
      recommendedFor: ["chat"],
    },
    {
      model: "glm-5.1",
      recommendedFor: ["chat"],
    },
    {
      model: "glm-5-turbo",
      recommendedFor: ["chat"],
      unknownCapabilities: [
        { feature: "structuredOutput", transport: "openai", note: "预设协议没有专用结构化输出规则，保留提示词 JSON 回退。" },
      ],
    },
    {
      model: "glm-4.7",
      recommendedFor: ["chat"],
    },
    {
      model: "glm-5v-turbo",
      recommendedFor: [],
      note: "历史清单保留名称；不改写用户请求。",
    },
    {
      model: "glm-4.5",
      recommendedFor: [],
      note: "历史清单保留名称；不改写用户请求。",
    },
    {
      model: "glm-4.6",
      recommendedFor: [],
      note: "历史清单保留名称；不改写用户请求。",
    },
  ],
  shortName: "GLM",
  samplingRules: [
    {

      modelPattern: /^glm-(?:5\.[123]|5-turbo|4\.7)$/i,
      diversity: true,
      metadata: legacyMetadata("迁自 src/main/orchestrator/vendors/style-sampling.ts"),
    },
  ],
  structuredOutputRules: [
    {
      id: "glm-json-object",

      transport: "openai",
      modelPattern: /^glm-(?:5\.[123]|4\.[67])(?:$|-)/i,
      tier: "B",
      mode: "provider_json_object",
      verification: "official",
      metadata: legacyMetadata("迁自 src/main/orchestrator/structured-output/profiles.ts"),
    },
  ],
  reasoningRules: [
    // ── glm（智谱）──
    // 精确型号在前；glm-5 基础型号放在精确型号之后（兜底更宽的 glm-5 系列）。
    // GLM-5.3 / GLM-5.3-Flash：强制思考模型（thinking.type=disabled 服务端报错，
    // 官方文档 2026-08-26；z.ai 文档明确 FLASH 同为强制思考；
    // 2026-09-06 实测方舟托管端点 api/coding/v3 同样返回 400，强制思考跨端点成立）。
    // 支持 low/high/max 三档 effort（方舟端点 reasoning_effort 实测可用）。
    // 默认选择 high 并显式发送 —— 服务端默认 max，多步任务思考开销过大。
    { modelPattern: /^glm-5\.3/i, modelInferencePattern: /^glm-5\.3/i, metadata: legacyMetadata("迁自 src/shared/vendor-registry/entries/glm.ts"), capability: {
      control: "toggle-effort",
      supportedEfforts: ["low", "high", "max"],
      defaultEffort: "high",
      requestStyle: "thinking-type",
      supportsDisable: false,
      autoEffort: "high",
    } },
    // GLM-5.2：支持关闭思考；effort 档位较全。默认选择 high（服务端默认偏重）。
    { modelPattern: /^glm-5\.2/i, modelInferencePattern: /^glm-5\.2/i, metadata: legacyMetadata("迁自 src/shared/vendor-registry/entries/glm.ts"), capability: {
      control: "toggle-effort",
      supportedEfforts: ["low", "medium", "high", "xhigh", "max"],
      defaultEffort: "high",
      requestStyle: "thinking-type",
      supportsDisable: true,
      autoEffort: "high",
    } },
    { modelPattern: /^glm-5-turbo$/i, modelInferencePattern: /^glm-5-turbo$/i, metadata: legacyMetadata("迁自 src/shared/vendor-registry/entries/glm.ts"), capability: {
      control: "toggle",
      requestStyle: "thinking-type",
      supportsDisable: true,
    } },
    { modelPattern: /^glm-5v-turbo$/i, modelInferencePattern: /^glm-5v-turbo$/i, metadata: legacyMetadata("迁自 src/shared/vendor-registry/entries/glm.ts"), capability: {
      control: "toggle",
      requestStyle: "thinking-type",
      supportsDisable: true,
    } },
    { modelPattern: /^glm-5\.1/i, modelInferencePattern: /^glm-5\.1/i, metadata: legacyMetadata("迁自 src/shared/vendor-registry/entries/glm.ts"), capability: {
      control: "toggle",
      requestStyle: "thinking-type",
      supportsDisable: true,
    } },
    { modelPattern: /^glm-5/i, modelInferencePattern: /^glm-5/i, metadata: legacyMetadata("迁自 src/shared/vendor-registry/entries/glm.ts"), capability: {
      control: "toggle",
      requestStyle: "thinking-type",
      supportsDisable: true,
    } },
    { familyLabel: "glm-4.5 / glm-4.6 / glm-4.7", modelPattern: /^glm-(4\.5|4\.6|4\.7)/i, modelInferencePattern: /^glm-(4\.5|4\.6|4\.7)/i, metadata: legacyMetadata("迁自 src/shared/vendor-registry/entries/glm.ts"), capability: {
      control: "toggle",
      requestStyle: "thinking-type",
      supportsDisable: true,
    } },
  ],
});
