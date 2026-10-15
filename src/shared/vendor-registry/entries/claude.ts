// claude（Anthropic）的注册表条目 —— 推理规则自 shared/reasoning.ts、能力自 capabilities.ts 原样迁入。
import { defineVendor, legacyMetadata } from "../define-vendor";

export const CLAUDE_REGISTRY = defineVendor({
  capability: {
    id: "claude",
    displayName: "Claude（Anthropic）",
    transport: "anthropic",
    baseUrl: "https://api.anthropic.com/v1",
    authStyle: "x-api-key",
    defaultModel: "claude-sonnet-4-6",
    supportsTools: true,
    supportsThinking: true,
    thinkingField: "thinking",
    cacheStrategy: "cache_control",
    testStrategy: "text",
    // 自家协议 only
    supportedTransports: ["anthropic"],
  },
  presetDefaults: {
    baseUrl: "https://api.anthropic.com/v1",
    transport: "anthropic",
  },
  models: [
    {
      model: "claude-fable-5",
      recommendedFor: ["chat"],
      unknownCapabilities: [
        { feature: "sampling", transport: "anthropic", note: "现有采样白名单未覆盖该型号。" },
      ],
    },
    {
      model: "claude-opus-4-8",
      recommendedFor: ["chat"],
      unknownCapabilities: [
        { feature: "sampling", transport: "anthropic", note: "现有采样白名单未覆盖该型号。" },
      ],
    },
    {
      model: "claude-sonnet-4-6",
      recommendedFor: ["chat"],
      unknownCapabilities: [
        { feature: "sampling", transport: "anthropic", note: "现有采样白名单未覆盖该型号。" },
      ],
    },
    {
      model: "claude-haiku-5-5",
      recommendedFor: ["chat"],
      note: "2026-10-07 发布；固定型号名，无日期后缀、无别名。",
      unknownCapabilities: [
        {
          feature: "sampling",
          transport: "anthropic",
          note: "官方说明非默认 temperature/top_p/top_k 返回 400；未加采样白名单即不注入采样参数。",
        },
      ],
    },
    {
      model: "claude-opus-4-7",
      recommendedFor: [],
      note: "历史清单保留名称；不改写用户请求。",
    },
    {
      model: "claude-opus-4-6",
      recommendedFor: [],
      note: "历史清单保留名称；不改写用户请求。",
    },
    {
      model: "claude-sonnet-5",
      recommendedFor: [],
      note: "历史清单保留名称；不改写用户请求。",
    },
  ],
  shortName: "Claude",
  structuredOutputRules: [
    // 具体型号规则放在下方宽泛的历史规则之前；Haiku 5.5 没有日期后缀，按完整名称匹配。
    {
      id: "claude-haiku-5-5-structured-output",
      transport: "anthropic",
      modelPattern: /^claude-haiku-5-5$/i,
      tier: "A",
      mode: "provider_json_schema",
      verification: "official",
      metadata: {
        status: "supported",
        evidence: {
          kind: "official",
          url: "https://platform.claude.com/docs/en/build-with-claude/structured-outputs",
          checkedAt: "2026-10-08",
          transports: ["anthropic"],
        },
      },
    },
    {
      id: "claude-structured-output",

      transport: "anthropic",
      modelPattern: /^claude-(?:fable-5|mythos(?:-5|-preview)|opus-4-[5-8]|sonnet-(?:5|4-[56])|haiku-4-5)(?:$|-\d{8})/i,
      tier: "A",
      mode: "provider_json_schema",
      verification: "official",
      metadata: legacyMetadata("迁自 src/main/orchestrator/structured-output/profiles.ts"),
    },
  ],
  reasoningRules: [
    // ── claude（Anthropic）──
    { modelPattern: /^claude-fable-5/i, modelInferencePattern: /^claude-fable-5/i, metadata: legacyMetadata("迁自 src/shared/vendor-registry/entries/claude.ts"), capability: {
      control: "toggle-effort",
      supportedEfforts: ["low", "medium", "high", "xhigh", "max"],
      defaultEffort: "high",
      requestStyle: "anthropic-adaptive",
      supportsDisable: true,
    } },
    { modelPattern: /^claude-sonnet-5/i, modelInferencePattern: /^claude-sonnet-5/i, metadata: legacyMetadata("迁自 src/shared/vendor-registry/entries/claude.ts"), capability: {
      control: "toggle-effort",
      supportedEfforts: ["low", "medium", "high", "xhigh", "max"],
      defaultEffort: "high",
      requestStyle: "anthropic-adaptive",
      supportsDisable: true,
    } },
    { modelPattern: /^claude-opus-4-(8|7|6)/i, modelInferencePattern: /^claude-opus-4-(8|7|6)/i, metadata: legacyMetadata("迁自 src/shared/vendor-registry/entries/claude.ts"), capability: {
      control: "toggle-effort",
      supportedEfforts: ["low", "medium", "high", "xhigh", "max"],
      defaultEffort: "high",
      requestStyle: "anthropic-adaptive",
      supportsDisable: true,
    } },
    { modelPattern: /^claude-sonnet-4-6/i, modelInferencePattern: /^claude-sonnet-4-6/i, metadata: legacyMetadata("迁自 src/shared/vendor-registry/entries/claude.ts"), capability: {
      control: "toggle-effort",
      supportedEfforts: ["low", "medium", "high", "xhigh"],
      defaultEffort: "high",
      requestStyle: "anthropic-adaptive",
      supportsDisable: true,
    } },
    // Claude Haiku 5.5：只接受自适应思考（type:"enabled" + budget_tokens 返回 400），五档 effort，默认 medium。
    // 官方允许在 high 及以下关闭思考，xhigh/max 下关闭返回 400；关闭时本项目不发送 effort，
    // 服务端取默认 medium，因此 supportsDisable 可以为 true。
    // 跨厂商推断：Google Cloud、Microsoft Foundry、Claude Platform on AWS 都使用同一型号名。
    { modelPattern: /^claude-haiku-5-5/i, modelInferencePattern: /^claude-haiku-5-5/i, metadata: {
      status: "supported",
      evidence: {
        kind: "official",
        url: "https://platform.claude.com/docs/en/build-with-claude/effort",
        checkedAt: "2026-10-08",
        transports: ["anthropic"],
      },
    }, capability: {
      control: "toggle-effort",
      supportedEfforts: ["low", "medium", "high", "xhigh", "max"],
      defaultEffort: "medium",
      requestStyle: "anthropic-adaptive",
      supportsDisable: true,
    } },
  ],
});
