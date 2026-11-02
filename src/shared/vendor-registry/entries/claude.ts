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
      model: "claude-fable-5-1",
      recommendedFor: ["chat"],
      unknownCapabilities: [
        {
          feature: "sampling",
          transport: "anthropic",
          note: "官方说明非默认 temperature/top_p/top_k 返回 400；未加采样白名单即不注入采样参数。",
        },
      ],
    },
    {
      model: "claude-opus-5-5",
      recommendedFor: ["chat"],
      unknownCapabilities: [
        {
          feature: "sampling",
          transport: "anthropic",
          note: "官方说明非默认 temperature/top_p/top_k 返回 400；未加采样白名单即不注入采样参数。",
        },
      ],
    },
    {
      model: "claude-sonnet-5-5",
      recommendedFor: ["chat"],
      unknownCapabilities: [
        {
          feature: "sampling",
          transport: "anthropic",
          note: "官方说明非默认 temperature/top_p/top_k 返回 400；未加采样白名单即不注入采样参数。",
        },
      ],
    },
    {
      model: "claude-fable-5",
      recommendedFor: ["chat"],
      unknownCapabilities: [
        { feature: "sampling", transport: "anthropic", note: "现有采样白名单未覆盖该型号。" },
      ],
    },
    {
      model: "claude-opus-5",
      recommendedFor: ["chat"],
      unknownCapabilities: [
        {
          feature: "sampling",
          transport: "anthropic",
          note: "官方说明非默认 temperature/top_p/top_k 返回 400；未加采样白名单即不注入采样参数。",
        },
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
      recommendedFor: ["chat"],
      unknownCapabilities: [
        {
          feature: "sampling",
          transport: "anthropic",
          note: "官方说明非默认 temperature/top_p/top_k 返回 400；未加采样白名单即不注入采样参数。",
        },
      ],
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
    // Fable 5.1 / Opus 5.5 / Opus 5 / Sonnet 5.5：output_config.format 结构化输出（官方结构化输出文档），
    // 按完整名称匹配；下方历史规则的 fable-5 / sonnet-5 分支只匹配无后缀或日期后缀，不会误吞这几个名称。
    {
      id: "claude-current-structured-output",
      transport: "anthropic",
      modelPattern: /^claude-(?:fable-5-1|opus-5-5|opus-5|sonnet-5-5)$/i,
      tier: "A",
      mode: "provider_json_schema",
      verification: "official",
      metadata: {
        status: "supported",
        evidence: {
          kind: "official",
          url: "https://platform.claude.com/docs/en/build-with-claude/structured-outputs",
          checkedAt: "2026-11-01",
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
    // 依据官方 effort / 思考文档与模型总览（核验 2026-11-01）。具体型号在前，同前缀的旧型号在后。
    // supportsDisable=false 的型号思考始终开启：本项目把「关闭」折叠为开启并按默认档位发送，
    // 不会发出 thinking:{type:"disabled"}；思考开启时 must-call 走 tool_choice:auto，
    // 也避开了 Fable 5.1 / Opus 5.5 / Sonnet 5.5 对 any / tool 强制工具调用的 400。
    // Fable 5.1：思考始终开启，disabled 返回 400；五档 effort，默认 high。
    { modelPattern: /^claude-fable-5-1$/i, modelInferencePattern: /^claude-fable-5-1$/i, metadata: {
      status: "supported",
      evidence: {
        kind: "official",
        url: "https://platform.claude.com/docs/en/build-with-claude/effort",
        checkedAt: "2026-11-01",
        transports: ["anthropic"],
      },
    }, capability: {
      control: "toggle-effort",
      supportedEfforts: ["low", "medium", "high", "xhigh", "max"],
      defaultEffort: "high",
      requestStyle: "anthropic-adaptive",
      supportsDisable: false,
    } },
    // Fable 5：同样思考始终开启（此前的规则允许关闭，会发出被拒绝的 disabled）。
    { modelPattern: /^claude-fable-5(?:$|-\d{8})/i, modelInferencePattern: /^claude-fable-5(?:$|-\d{8})/i, metadata: {
      status: "supported",
      evidence: {
        kind: "official",
        url: "https://platform.claude.com/docs/en/build-with-claude/effort",
        checkedAt: "2026-11-01",
        transports: ["anthropic"],
      },
    }, capability: {
      control: "toggle-effort",
      supportedEfforts: ["low", "medium", "high", "xhigh", "max"],
      defaultEffort: "high",
      requestStyle: "anthropic-adaptive",
      supportsDisable: false,
    } },
    // Opus 5.5：思考始终开启，任何档位下 disabled 都返回 400；默认 medium（比 Opus 5 低一档）。
    { modelPattern: /^claude-opus-5-5$/i, modelInferencePattern: /^claude-opus-5-5$/i, metadata: {
      status: "supported",
      evidence: {
        kind: "official",
        url: "https://platform.claude.com/docs/en/build-with-claude/effort",
        checkedAt: "2026-11-01",
        transports: ["anthropic"],
      },
    }, capability: {
      control: "toggle-effort",
      supportedEfforts: ["low", "medium", "high", "xhigh", "max"],
      defaultEffort: "medium",
      requestStyle: "anthropic-adaptive",
      supportsDisable: false,
    } },
    // Opus 5：思考默认开启；disabled 只在 high 及以下接受。关闭时本项目不发送 effort，
    // 服务端取默认 high，因此可以开放关闭。
    { modelPattern: /^claude-opus-5$/i, modelInferencePattern: /^claude-opus-5$/i, metadata: {
      status: "supported",
      evidence: {
        kind: "official",
        url: "https://platform.claude.com/docs/en/build-with-claude/effort",
        checkedAt: "2026-11-01",
        transports: ["anthropic"],
      },
    }, capability: {
      control: "toggle-effort",
      supportedEfforts: ["low", "medium", "high", "xhigh", "max"],
      defaultEffort: "high",
      requestStyle: "anthropic-adaptive",
      supportsDisable: true,
    } },
    // Sonnet 5.5：disabled 返回 400（关闭前置思考需改用 between_tools，本项目暂不支持），默认 high。
    { modelPattern: /^claude-sonnet-5-5$/i, modelInferencePattern: /^claude-sonnet-5-5$/i, metadata: {
      status: "supported",
      evidence: {
        kind: "official",
        url: "https://platform.claude.com/docs/en/build-with-claude/effort",
        checkedAt: "2026-11-01",
        transports: ["anthropic"],
      },
    }, capability: {
      control: "toggle-effort",
      supportedEfforts: ["low", "medium", "high", "xhigh", "max"],
      defaultEffort: "high",
      requestStyle: "anthropic-adaptive",
      supportsDisable: false,
    } },
    // Sonnet 5：自适应思考，可关闭，默认 high。
    { modelPattern: /^claude-sonnet-5(?:$|-\d{8})/i, modelInferencePattern: /^claude-sonnet-5(?:$|-\d{8})/i, metadata: {
      status: "supported",
      evidence: {
        kind: "official",
        url: "https://platform.claude.com/docs/en/build-with-claude/effort",
        checkedAt: "2026-11-01",
        transports: ["anthropic"],
      },
    }, capability: {
      control: "toggle-effort",
      supportedEfforts: ["low", "medium", "high", "xhigh", "max"],
      defaultEffort: "high",
      requestStyle: "anthropic-adaptive",
      supportsDisable: true,
    } },
    // Opus 4.8 / 4.7：五档 effort（xhigh 自 Opus 4.7 起提供），可关闭。
    { modelPattern: /^claude-opus-4-[78]/i, modelInferencePattern: /^claude-opus-4-[78]/i, metadata: {
      status: "supported",
      evidence: {
        kind: "official",
        url: "https://platform.claude.com/docs/en/build-with-claude/effort",
        checkedAt: "2026-11-01",
        transports: ["anthropic"],
      },
    }, capability: {
      control: "toggle-effort",
      supportedEfforts: ["low", "medium", "high", "xhigh", "max"],
      defaultEffort: "high",
      requestStyle: "anthropic-adaptive",
      supportsDisable: true,
    } },
    // Opus 4.6 / Sonnet 4.6：没有 xhigh，最高为 max（此前的规则误列 xhigh、漏了 max）。
    { modelPattern: /^claude-(?:opus|sonnet)-4-6/i, modelInferencePattern: /^claude-(?:opus|sonnet)-4-6/i, metadata: {
      status: "supported",
      evidence: {
        kind: "official",
        url: "https://platform.claude.com/docs/en/build-with-claude/effort",
        checkedAt: "2026-11-01",
        transports: ["anthropic"],
      },
    }, capability: {
      control: "toggle-effort",
      supportedEfforts: ["low", "medium", "high", "max"],
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
