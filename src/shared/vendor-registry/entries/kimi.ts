// kimi（月之暗面）的注册表条目 —— 推理规则自 shared/reasoning.ts、能力自 capabilities.ts 原样迁入。
import { defineVendor, legacyMetadata } from "../define-vendor";

export const KIMI_REGISTRY = defineVendor({
  capability: {
    id: "kimi",
    displayName: "Kimi（月之暗面）",
    // OpenAI 兼容 + prompt_cache_key + function.name 正则限制；baseUrl 必须是 .cn
    transport: "openai",
    baseUrl: "https://api.moonshot.cn/v1",
    authStyle: "bearer",
    defaultModel: "kimi-k2.7-code",
    supportsTools: true,
    supportsThinking: true,
    thinkingField: "thinking",
    cacheStrategy: "prompt_cache_key",
    testStrategy: "text",
    // 官方仅兼容 Chat Completions（协议矩阵 2026-08-21）
    supportedTransports: ["openai"],
  },
  presetDefaults: {
    baseUrl: "https://api.moonshot.cn/v1",
    transport: "openai",
  },
  models: [
    {
      model: "kimi-k2.6",
      recommendedFor: ["chat"],
      unknownCapabilities: [
        { feature: "sampling", transport: "openai", note: "现有采样白名单未覆盖该型号。" },
      ],
    },
    {
      model: "kimi-k2.5",
      recommendedFor: ["chat"],
      unknownCapabilities: [
        { feature: "sampling", transport: "openai", note: "现有采样白名单未覆盖该型号。" },
        { feature: "structuredOutput", transport: "openai", note: "预设协议没有专用结构化输出规则，保留提示词 JSON 回退。" },
      ],
    },
    {
      model: "kimi-k2-thinking",
      recommendedFor: ["chat"],
      unknownCapabilities: [
        { feature: "sampling", transport: "openai", note: "现有采样白名单未覆盖该型号。" },
        { feature: "structuredOutput", transport: "openai", note: "预设协议没有专用结构化输出规则，保留提示词 JSON 回退。" },
      ],
    },
    {
      model: "kimi-k3",
      recommendedFor: [],
      note: "历史清单保留名称；不改写用户请求。",
    },
    {
      model: "kimi-k2.7-code",
      recommendedFor: [],
      note: "历史清单保留名称；不改写用户请求。",
    },
    {
      model: "kimi-k2.7-code-highspeed",
      recommendedFor: [],
      note: "历史清单保留名称；不改写用户请求。",
    },
  ],
  shortName: "Kimi",
  // 厂商怪癖：fixed-thinking / 思考中的模型拒绝指定工具选择，
  // must-call 首选 auto 保持原生 Function Calling。
  toolChoiceQuirk: {
    mustCall: { preferred: "auto", when: "thinking-only" },
  },
  structuredOutputRules: [
    {
      id: "kimi-structured-output",

      transport: "openai",
      modelPattern: /^(?:kimi-for-coding|kimi-(?:k3|k2\.(?:6|7-code(?:-highspeed)?)))(?:$|-)/i,
      tier: "A",
      mode: "provider_json_schema",
      verification: "official",
      metadata: legacyMetadata("迁自 src/main/orchestrator/structured-output/profiles.ts"),
      repairOverrides: [{ modelPattern: /^(?:kimi-for-coding|kimi-(?:k3|k2\.7-code(?:-highspeed)?))(?:$|-)/i, preset: "kimi-slow" }],
    },
  ],
  reasoningRules: [
    // ── kimi（月之暗面）──
    // K3：旗舰思考模型（2026-07 发布）。思考始终开启（Preserved Thinking 常开），
    // 不用 K2.x 的 thinking 参数，用顶层 reasoning_effort（low/high/max，默认 max）。
    // 强制思考 + 服务端默认 max → 与 GLM-5.3 同体质，默认选择 high 防思考爆炸。
    { modelPattern: /^kimi-k3/i, modelInferencePattern: /^kimi-k3/i, metadata: legacyMetadata("迁自 src/shared/vendor-registry/entries/kimi.ts"), capability: {
      control: "effort",
      supportedEfforts: ["low", "high", "max"],
      defaultEffort: "high",
      requestStyle: "openai-effort",
      supportsDisable: false,
      autoEffort: "high",
    } },
    // K2.7-Code / K2.7-Code-HighSpeed 必须用精确正则（$-anchor），
    // 且排在通用 kimi-k2-thinking 系列之前。
    { modelPattern: /^kimi-k2\.7-code-highspeed$/i, modelInferencePattern: /^kimi-k2\.7-code-highspeed$/i, metadata: legacyMetadata("迁自 src/shared/vendor-registry/entries/kimi.ts"), capability: {
      control: "fixed-on",
      requestStyle: "none",
      supportsDisable: false,
    } },
    { modelPattern: /^kimi-k2\.7-code$/i, modelInferencePattern: /^kimi-k2\.7-code$/i, metadata: legacyMetadata("迁自 src/shared/vendor-registry/entries/kimi.ts"), capability: {
      control: "fixed-on",
      requestStyle: "none",
      supportsDisable: false,
    } },
    { modelPattern: /^kimi-k2\.6/i, modelInferencePattern: /^kimi-k2\.6/i, metadata: legacyMetadata("迁自 src/shared/vendor-registry/entries/kimi.ts"), capability: {
      control: "toggle",
      requestStyle: "thinking-type",
      supportsDisable: true,
      keepOnTools: true,
    } },
    { modelPattern: /^kimi-k2\.5/i, modelInferencePattern: /^kimi-k2\.5/i, metadata: legacyMetadata("迁自 src/shared/vendor-registry/entries/kimi.ts"), capability: {
      control: "toggle",
      requestStyle: "thinking-type",
      supportsDisable: true,
      keepOnTools: false,
    } },
    { modelPattern: /^kimi-k2-thinking/i, modelInferencePattern: /^kimi-k2-thinking/i, metadata: legacyMetadata("迁自 src/shared/vendor-registry/entries/kimi.ts"), capability: {
      control: "fixed-on",
      requestStyle: "none",
      supportsDisable: false,
    } },
  ],
});
