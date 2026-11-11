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
      model: "gemini-4-carbon",
      recommendedFor: ["chat"],
      note: "2026-11-10 正式发布（GA）；固定型号名，无日期后缀。",
      unknownCapabilities: [
        { feature: "sampling", transport: "openai", note: "官方说明 temperature/top_p/top_k 应移除，传入会被忽略；未加采样白名单即不注入采样参数。" },
      ],
    },
    {
      model: "gemini-4-argon",
      recommendedFor: ["chat"],
      note: "2026-09-30 发布的旗舰推理模型（Stable）；固定型号名，无日期后缀。",
      unknownCapabilities: [
        { feature: "sampling", transport: "openai", note: "官方文档未说明 temperature/top_p 取值约束；未加采样白名单即不注入采样参数。" },
      ],
    },
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
  structuredOutputRules: [
    // 官方模型页列出 Structured outputs 为已支持；OpenAI 兼容层文档以 response_format（parse）示例说明。
    // 只覆盖已核实的完整型号名，其余 Gemini 型号仍走提示词 JSON 回退。
    {
      id: "gemini-4-carbon-structured-output",
      transport: "openai",
      modelPattern: /^gemini-4-carbon$/i,
      tier: "A",
      mode: "provider_json_schema",
      verification: "official",
      metadata: {
        status: "supported",
        evidence: {
          kind: "official",
          url: "https://ai.google.dev/gemini-api/docs/models/gemini-4-carbon",
          checkedAt: "2026-11-11",
          transports: ["openai"],
        },
      },
    },
    {
      id: "gemini-4-argon-structured-output",
      transport: "openai",
      modelPattern: /^gemini-4-argon$/i,
      tier: "A",
      mode: "provider_json_schema",
      verification: "official",
      metadata: {
        status: "supported",
        evidence: {
          kind: "official",
          url: "https://ai.google.dev/gemini-api/docs/models/gemini-4-argon",
          checkedAt: "2026-10-18",
          transports: ["openai"],
        },
      },
    },
  ],
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
    // Gemini 4 Argon：thinking_level 仅 low/medium/high，默认 medium（思考文档与模型页）。
    // 兼容层把 reasoning_effort:"minimal" 映射为 low；"none" 关闭思考只写明适用于 2.5，
    // 思考文档也未给 Argon 列出 Off 档 → supportsDisable=false。
    // 跨厂商推断：Vertex AI 等托管端点使用同一型号名。
    { modelPattern: /^gemini-4-argon/i, modelInferencePattern: /^gemini-4-argon/i, metadata: {
      status: "supported",
      evidence: {
        kind: "official",
        url: "https://ai.google.dev/gemini-api/docs/openai",
        checkedAt: "2026-10-18",
        transports: ["openai"],
      },
    }, capability: {
      control: "effort",
      supportedEfforts: ["low", "medium", "high"],
      defaultEffort: "medium",
      requestStyle: "openai-effort",
      supportsDisable: false,
    } },
    // Gemini 4 Carbon：与 Argon 相同，thinking_level 仅 low/medium/high，默认 medium；
    // 兼容文档写明 Gemini 4 的思考不能关闭 → supportsDisable=false（核验 2026-11-11）。
    { modelPattern: /^gemini-4-carbon/i, modelInferencePattern: /^gemini-4-carbon/i, metadata: {
      status: "supported",
      evidence: {
        kind: "official",
        url: "https://ai.google.dev/gemini-api/docs/openai",
        checkedAt: "2026-11-11",
        transports: ["openai"],
      },
    }, capability: {
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
