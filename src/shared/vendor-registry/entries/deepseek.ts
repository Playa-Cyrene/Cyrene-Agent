// deepseek（深度求索）的注册表条目 —— 推理规则自 shared/reasoning.ts、能力自 capabilities.ts 原样迁入。
import { defineVendor, legacyMetadata } from "../define-vendor";
import { UNKNOWN_REASONING_CAPABILITY } from "../fallback";

export const DEEPSEEK_REGISTRY = defineVendor({
  capability: {
    id: "deepseek",
    displayName: "DeepSeek（深度求索）",
    transport: "openai",
    baseUrl: "https://api.deepseek.com",
    authStyle: "bearer",
    anthropicAuthStyle: "x-api-key",
    defaultModel: "deepseek-flash",
    supportsTools: true,
    supportsThinking: true,
    thinkingField: "reasoning_content",
    cacheStrategy: "auto",
    testStrategy: "text",
    // 三格式原生全支持（官方文档）
    supportedTransports: ["openai", "anthropic", "responses"],
  },
  presetDefaults: {
    baseUrl: "https://api.deepseek.com",
    transport: "openai",
    anthropicBaseUrl: "https://api.deepseek.com/anthropic",
  },
  models: [
    {
      model: "deepseek-flash",
      recommendedFor: ["chat"],
    },
    {
      model: "deepseek-v4-pro",
      recommendedFor: ["chat"],
    },
    {
      model: "deepseek-v4-flash",
      recommendedFor: [],
      note: "历史清单保留名称；不改写用户请求。",
    },
    {
      model: "deepseek-v4-flash-vision-exp",
      recommendedFor: [],
      note: "历史清单保留名称；不改写用户请求。",
    },
    {
      model: "deepseek-chat",
      recommendedFor: [],
      note: "历史清单保留名称；不改写用户请求。",
    },
    {
      model: "deepseek-reasoner",
      recommendedFor: [],
      note: "历史清单保留名称；不改写用户请求。",
    },
  ],
  shortName: "DeepSeek",
  // 厂商怪癖：思考时拒绝一切 tool_choice（must-call 也省略字段），
  // 思考开启时普通 FC 轮同样省略 tool_choice；非思考轮不受影响。
  toolChoiceQuirk: {
    mustCall: { preferred: "omit", when: "thinking-only" },
    omitAutoTurnWhenThinking: true,
  },
  samplingRules: [
    {

      // V4.1 Flash（deepseek-flash）与 V4 旧名；思考模式下 temperature 不生效，需关闭思考
      modelPattern: /^deepseek-(?:v4-(?:pro|flash)|flash)$/i,
      diversity: true,
      requiresReasoningOff: true,
      metadata: legacyMetadata("迁自 src/main/orchestrator/vendors/style-sampling.ts"),
    },
  ],
  structuredOutputRules: [
    {
      id: "deepseek-json-object",

      transport: "openai",
      // V4.1 Flash（deepseek-flash）与 V4 旧名（官方路由到 V4.1 Flash）均支持 JSON Output
      modelPattern: /^deepseek-(?:v4-(?:pro|flash)|flash)$/i,
      tier: "B",
      mode: "provider_json_object",
      verification: "official",
      metadata: legacyMetadata("迁自 src/main/orchestrator/structured-output/profiles.ts"),
    },
  ],
  reasoningRules: [
    // ── deepseek ──
    // V4.1 Flash（2026-09-10 发布，模型名 deepseek-flash，原生多模态）与 V4 旧名
    // （v4-pro / v4-flash / v4-flash-vision-exp，官方均已路由到 V4.1 Flash）统一规则：
    // thinking 默认开启可关闭；effort 官方原生 low/high/max 三档（官方思考模式文档），
    // 其余档位由服务端映射：minimal→low、medium/xhigh→high、ultra→max。
    // 默认选中 high：服务端缺省会给带工具的 agent 请求自动上 max，
    // 与 GLM-5.3 同款的思考爆炸陷阱（2026-08-27 多轮循环场景）。
    { modelPattern: /^deepseek-(?:v4|flash)/i, modelInferencePattern: /^deepseek-(?:v4|flash)/i, metadata: legacyMetadata("迁自 src/shared/vendor-registry/entries/deepseek.ts"), capability: {
      control: "toggle-effort",
      supportedEfforts: ["low", "high", "max"],
      defaultEffort: "high",
      requestStyle: "thinking-type",
      supportsDisable: true,
      autoEffort: "high",
    } },
    { modelPattern: /^deepseek-(chat|reasoner)$/i, modelInferencePattern: /^deepseek-(chat|reasoner)$/i, metadata: legacyMetadata("迁自 src/shared/vendor-registry/entries/deepseek.ts", "unknown"), capability: UNKNOWN_REASONING_CAPABILITY },
  ],
});
