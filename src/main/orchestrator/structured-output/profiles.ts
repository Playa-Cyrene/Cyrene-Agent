import type {
  StructuredOutputMode,
  StructuredOutputProfile,
  StructuredOutputProfileContext,
  StructuredOutputTier,
  StructuredOutputVerification,
} from "./types";

interface ProfileDefinition {
  id: string;
  provider: string;
  transport: StructuredOutputProfileContext["transport"];
  modelPattern: RegExp;
  tier: Exclude<StructuredOutputTier, "D">;
  mode: StructuredOutputMode;
  verification: StructuredOutputVerification;
  requestHints?: Partial<StructuredOutputProfile["requestHints"]>;
}

const KIMI_SLOW_MODEL_PATTERN = /^(?:kimi-for-coding|kimi-(?:k3|k2\.7-code(?:-highspeed)?))(?:$|-)/i;

const DEFINITIONS: readonly ProfileDefinition[] = [
  {
    id: "openai-structured-output",
    provider: "chatgpt",
    transport: "openai",
    // gpt-6 按家族前缀匹配（已发布型号自动覆盖：astra / sol / luna），
    // 不预测未来小版本号，协议兼容矩阵比 UI 能力表更保守。
    modelPattern: /^(?:gpt-6(?:$|-)|gpt-5(?:\.\d+)?(?:-(?:sol|terra|luna))?|gpt-4\.1(?:$|-)|gpt-4o-mini(?:$|-)|gpt-4o-(?:2024-08-06|2024-11-20)|o[134](?:$|-))/i,
    tier: "A",
    mode: "provider_json_schema",
    verification: "official",
  },
  {
    id: "claude-structured-output",
    provider: "claude",
    transport: "anthropic",
    modelPattern: /^claude-(?:fable-5|mythos(?:-5|-preview)|opus-4-[5-8]|sonnet-(?:5|4-[56])|haiku-4-5)(?:$|-\d{8})/i,
    tier: "A",
    mode: "provider_json_schema",
    verification: "official",
  },
  {
    id: "kimi-structured-output",
    provider: "kimi",
    transport: "openai",
    modelPattern: /^(?:kimi-for-coding|kimi-(?:k3|k2\.(?:6|7-code(?:-highspeed)?)))(?:$|-)/i,
    tier: "A",
    mode: "provider_json_schema",
    verification: "official",
  },
  {
    id: "doubao-structured-output",
    provider: "doubao",
    transport: "openai",
    modelPattern: /^doubao-seed(?:$|-)/i,
    tier: "A",
    mode: "provider_json_schema",
    verification: "official",
  },
  {
    id: "deepseek-json-object",
    provider: "deepseek",
    transport: "openai",
    // V4.1 Flash（deepseek-flash）与 V4 旧名（官方路由到 V4.1 Flash）均支持 JSON Output
    modelPattern: /^deepseek-(?:v4-(?:pro|flash)|flash)$/i,
    tier: "B",
    mode: "provider_json_object",
    verification: "official",
  },
  {
    id: "qwen-json-object",
    provider: "qwen",
    transport: "openai",
    modelPattern: /^(?:qwen3\.(?:7-(?:max|plus)|[56]-plus)|qwen-flash)(?:$|-)/i,
    tier: "B",
    mode: "provider_json_object",
    verification: "official",
  },
  {
    id: "glm-json-object",
    provider: "glm",
    transport: "openai",
    modelPattern: /^glm-(?:5\.[123]|4\.[67])(?:$|-)/i,
    tier: "B",
    mode: "provider_json_object",
    verification: "official",
  },
  {
    id: "mimo-json-object",
    provider: "mimo",
    transport: "openai",
    // V2.6（2026-09-22 发布）与 V2.5 同 API 面（官方文档请求体一致），json_object
    // 同适用；V2.5 官方 2026-10-21 下线，模式保留至下线后清理。
    modelPattern: /^mimo-v2\.(?:5|6)(?:$|-)/i,
    tier: "B",
    mode: "provider_json_object",
    verification: "official",
  },
  {
    id: "minimax-m3-adapter",
    provider: "minimax",
    transport: "openai",
    modelPattern: /^MiniMax-M3(?:$|[-_])/i,
    tier: "M",
    mode: "prompt_json",
    verification: "contract_verified",
    requestHints: { sendJsonObject: true, reasoningSplit: true },
  },
];

const MEMORY_REPAIR: StructuredOutputProfile["repair"]["memory_judge"] = {
  maxAttempts: 2,
  totalBudgetMs: 15_000,
  perAttemptTimeoutMs: 8_000,
  minimumRemainingBudgetMs: 500,
};

// 通用 stage（task_router / planner / native_fc / memory）的默认 repair 策略
const DEFAULT_STAGE_REPAIR = {
  maxAttempts: 2,
  totalBudgetMs: 10_000,
  perAttemptTimeoutMs: 5_000,
  minimumRemainingBudgetMs: 800,
};

const REPAIR: StructuredOutputProfile["repair"] = {
  cita: {
    maxAttempts: 2,
    totalBudgetMs: 8_000,
    perAttemptTimeoutMs: 4_000,
    minimumRemainingBudgetMs: 500,
  },
  task_router: DEFAULT_STAGE_REPAIR,
  planner: DEFAULT_STAGE_REPAIR,
  native_fc: DEFAULT_STAGE_REPAIR,
  memory: DEFAULT_STAGE_REPAIR,
  memory_judge: MEMORY_REPAIR,
  memory_compress: MEMORY_REPAIR,
  memory_reflect: MEMORY_REPAIR,
  memory_resolve: MEMORY_REPAIR,
};

const A_STAGE_REPAIR = {
  maxAttempts: 2,
  totalBudgetMs: 25_000,
  perAttemptTimeoutMs: 12_500,
  minimumRemainingBudgetMs: 800,
};

const A_REPAIR: StructuredOutputProfile["repair"] = {
  cita: {
    maxAttempts: 2,
    totalBudgetMs: 20_000,
    perAttemptTimeoutMs: 10_000,
    minimumRemainingBudgetMs: 500,
  },
  task_router: A_STAGE_REPAIR,
  planner: A_STAGE_REPAIR,
  native_fc: A_STAGE_REPAIR,
  memory: A_STAGE_REPAIR,
  memory_judge: MEMORY_REPAIR,
  memory_compress: MEMORY_REPAIR,
  memory_reflect: MEMORY_REPAIR,
  memory_resolve: MEMORY_REPAIR,
};

const KIMI_SLOW_REPAIR: StructuredOutputProfile["repair"] = {
  cita: {
    maxAttempts: 2,
    totalBudgetMs: 40_000,
    perAttemptTimeoutMs: 20_000,
    minimumRemainingBudgetMs: 500,
  },
  task_router: A_STAGE_REPAIR,
  planner: A_STAGE_REPAIR,
  native_fc: A_STAGE_REPAIR,
  memory: A_STAGE_REPAIR,
  memory_judge: MEMORY_REPAIR,
  memory_compress: MEMORY_REPAIR,
  memory_reflect: MEMORY_REPAIR,
  memory_resolve: MEMORY_REPAIR,
};

const B_STAGE_REPAIR = {
  maxAttempts: 2,
  totalBudgetMs: 20_000,
  perAttemptTimeoutMs: 10_000,
  minimumRemainingBudgetMs: 800,
};

const B_REPAIR: StructuredOutputProfile["repair"] = {
  cita: {
    maxAttempts: 2,
    totalBudgetMs: 16_000,
    perAttemptTimeoutMs: 8_000,
    minimumRemainingBudgetMs: 500,
  },
  task_router: B_STAGE_REPAIR,
  planner: B_STAGE_REPAIR,
  native_fc: B_STAGE_REPAIR,
  memory: B_STAGE_REPAIR,
  memory_judge: MEMORY_REPAIR,
  memory_compress: MEMORY_REPAIR,
  memory_reflect: MEMORY_REPAIR,
  memory_resolve: MEMORY_REPAIR,
};

const MINIMAX_STAGE_REPAIR = {
  maxAttempts: 2,
  totalBudgetMs: 12_000,
  perAttemptTimeoutMs: 7_000,
  minimumRemainingBudgetMs: 800,
};

const MINIMAX_REPAIR: StructuredOutputProfile["repair"] = {
  cita: {
    maxAttempts: 2,
    totalBudgetMs: 10_000,
    perAttemptTimeoutMs: 5_500,
    minimumRemainingBudgetMs: 500,
  },
  task_router: MINIMAX_STAGE_REPAIR,
  planner: MINIMAX_STAGE_REPAIR,
  native_fc: MINIMAX_STAGE_REPAIR,
  memory: MINIMAX_STAGE_REPAIR,
  memory_judge: MEMORY_REPAIR,
  memory_compress: MEMORY_REPAIR,
  memory_reflect: MEMORY_REPAIR,
  memory_resolve: MEMORY_REPAIR,
};

function repairFor(
  definition: ProfileDefinition,
  context: StructuredOutputProfileContext,
): StructuredOutputProfile["repair"] {
  if (definition.tier === "M") return MINIMAX_REPAIR;
  if (definition.tier === "B") return B_REPAIR;
  if (
    definition.tier === "A"
    && definition.provider === "kimi"
    && KIMI_SLOW_MODEL_PATTERN.test(context.model)
  ) {
    return KIMI_SLOW_REPAIR;
  }
  return definition.tier === "A" ? A_REPAIR : REPAIR;
}

function materialize(
  definition: ProfileDefinition,
  context: StructuredOutputProfileContext,
): StructuredOutputProfile {
  return {
    id: definition.id,
    provider: definition.provider,
    model: context.model,
    transport: definition.transport,
    tier: definition.tier,
    mode: definition.mode,
    verification: definition.verification,
    allowCapabilityPromotion: false,
    requestHints: {
      sendJsonObject: definition.requestHints?.sendJsonObject ?? false,
      reasoningSplit: definition.requestHints?.reasoningSplit ?? false,
    },
    reasoning: "disabled",
    repair: repairFor(definition, context),
  };
}

const FALLBACK: StructuredOutputProfile = {
  id: "prompt-json-fallback",
  provider: "unknown",
  model: "unknown",
  tier: "D",
  mode: "prompt_json",
  verification: "contract_required",
  allowCapabilityPromotion: false,
  requestHints: { sendJsonObject: false, reasoningSplit: false },
  reasoning: "disabled",
  repair: REPAIR,
};

export function resolveStructuredOutputProfile(
  context: StructuredOutputProfileContext,
): StructuredOutputProfile {
  const fallback: StructuredOutputProfile = {
    ...FALLBACK,
    provider: context.provider,
    model: context.model,
  };
  if (context.endpointKind !== "official") return fallback;
  const match = DEFINITIONS.find((definition) => (
    definition.provider === context.provider
    && definition.transport === context.transport
    && definition.modelPattern.test(context.model)
  ));
  return match ? materialize(match, context) : fallback;
}

function normalizeBaseUrl(value: string): string {
  return value.trim().replace(/\/+$/, "").toLowerCase();
}

export function classifyStructuredOutputEndpoint(input: {
  providerId: string;
  configuredBaseUrl: string;
  officialBaseUrl: string;
}): StructuredOutputProfileContext["endpointKind"] {
  const configured = normalizeBaseUrl(input.configuredBaseUrl);
  const officialBaseUrls = [
    input.officialBaseUrl,
    ...(input.providerId === "kimi" ? ["https://api.kimi.com/coding/v1"] : []),
  ].filter(Boolean).map(normalizeBaseUrl);
  if (/^https?:\/\/(?:localhost|127(?:\.\d+){3}|0\.0\.0\.0|\[::1\])(?::|\/|$)/.test(configured)) {
    return "local";
  }
  if (
    input.providerId === "unknown"
    || !configured
    || !officialBaseUrls.includes(configured)
  ) {
    return "custom";
  }
  return "official";
}
