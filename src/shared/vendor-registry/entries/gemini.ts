// gemini（Google）的注册表条目 —— 走官方 OpenAI 兼容层（…/v1beta/openai），
// 思考档位经 reasoning_effort 参数映射 thinking_level，以官方兼容文档（2026-09）为准。
import { defineVendor, legacyMetadata } from "../define-vendor";

export const GEMINI_REGISTRY = defineVendor({
  capability: {
    id: "gemini",
    displayName: "Gemini（Google）",
    transport: "openai",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
    authStyle: "bearer",
    defaultModel: "gemini-3.8-flash",
    supportsTools: true,
    supportsThinking: true,
    // 官方兼容文档未写明思考返回字段；第三方网关实测为 reasoning_content，
    // 先按 OpenAI 兼容惯例填，实测后如有出入再修正。
    thinkingField: "reasoning_content",
    // Gemini 隐式缓存：服务端自动命中折扣，无需显式参数
    cacheStrategy: "auto",
    testStrategy: "text",
    // 官方 OpenAI 兼容层已核实；原生 Gemini API 不属于三种内置协议
    supportedTransports: ["openai"],
  },
  presetDefaults: {
    baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
    transport: "openai",
  },
  models: [
    {
      model: "gemini-3.8-flash",
      recommendedFor: ["chat"],
      unknownCapabilities: [
        { feature: "sampling", transport: "openai", note: "现有采样白名单未覆盖该型号。" },
        { feature: "structuredOutput", transport: "openai", note: "预设协议没有专用结构化输出规则，保留提示词 JSON 回退。" },
      ],
    },
    {
      model: "gemini-3.1-pro",
      recommendedFor: ["chat"],
      unknownCapabilities: [
        { feature: "sampling", transport: "openai", note: "现有采样白名单未覆盖该型号。" },
        { feature: "structuredOutput", transport: "openai", note: "预设协议没有专用结构化输出规则，保留提示词 JSON 回退。" },
      ],
    },
    {
      model: "gemini-3.5-flash",
      recommendedFor: ["chat"],
      unknownCapabilities: [
        { feature: "sampling", transport: "openai", note: "现有采样白名单未覆盖该型号。" },
        { feature: "structuredOutput", transport: "openai", note: "预设协议没有专用结构化输出规则，保留提示词 JSON 回退。" },
      ],
    },
    {
      model: "gemini-2.5-flash",
      recommendedFor: ["chat"],
      unknownCapabilities: [
        { feature: "sampling", transport: "openai", note: "现有采样白名单未覆盖该型号。" },
        { feature: "structuredOutput", transport: "openai", note: "预设协议没有专用结构化输出规则，保留提示词 JSON 回退。" },
      ],
    },
    {
      model: "gemini-2.5-pro",
      recommendedFor: [],
      note: "历史清单保留名称；不改写用户请求。",
    },
  ],
  shortName: "Gemini",
  reasoningRules: [
    // ── gemini（Google）──
    // 官方兼容文档：reasoning_effort 仅 low/medium/high 三档（映射 thinking_level）。
    // Gemini 3 系与 2.5 Pro 官方明确"思考不可关闭" → supportsDisable=false。
    // 产品默认档 medium：官方不传参时动态思考偏重，medium 为成本/质量平衡点。
    { familyLabel: "gemini-3 系列", modelPattern: /^gemini-3/i, modelInferencePattern: /^gemini-3/i, metadata: legacyMetadata("迁自 src/shared/vendor-registry/entries/gemini.ts"), capability: {
      control: "effort",
      supportedEfforts: ["low", "medium", "high"],
      defaultEffort: "medium",
      requestStyle: "openai-effort",
      supportsDisable: false,
    } },
    { modelPattern: /^gemini-2\.5-pro/i, modelInferencePattern: /^gemini-2\.5-pro/i, metadata: legacyMetadata("迁自 src/shared/vendor-registry/entries/gemini.ts"), capability: {
      control: "effort",
      supportedEfforts: ["low", "medium", "high"],
      defaultEffort: "medium",
      requestStyle: "openai-effort",
      supportsDisable: false,
    } },
    // 2.5 Flash / Flash-Lite：官方支持 reasoning_effort:"none" 关闭思考 → 可关可调
    { modelPattern: /^gemini-2\.5-flash/i, modelInferencePattern: /^gemini-2\.5-flash/i, metadata: legacyMetadata("迁自 src/shared/vendor-registry/entries/gemini.ts"), capability: {
      control: "toggle-effort",
      supportedEfforts: ["low", "medium", "high"],
      defaultEffort: "medium",
      requestStyle: "openai-effort",
      supportsDisable: true,
    } },
  ],
});
