import { MODEL_STRUCTURED_OUTPUT_RULES } from "../../../shared/vendor-registry";
import type { StructuredOutputRule as ProfileDefinition } from "../../../shared/vendor-registry/model-types";
import type {
  StructuredOutputProfile,
  StructuredOutputProfileContext,
} from "./types";

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
  memory_summary: MEMORY_REPAIR,
  memory_wiki: MEMORY_REPAIR,
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
  memory_summary: MEMORY_REPAIR,
  memory_wiki: MEMORY_REPAIR,
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
  memory_summary: MEMORY_REPAIR,
  memory_wiki: MEMORY_REPAIR,
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
  memory_summary: MEMORY_REPAIR,
  memory_wiki: MEMORY_REPAIR,
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
  memory_summary: MEMORY_REPAIR,
  memory_wiki: MEMORY_REPAIR,
};

function repairFor(
  definition: ProfileDefinition,
  context: StructuredOutputProfileContext,
): StructuredOutputProfile["repair"] {
  if (definition.tier === "M") return MINIMAX_REPAIR;
  if (definition.tier === "B") return B_REPAIR;
  if (
    definition.tier === "A"
    && definition.repairOverrides?.some((override) => override.preset === "kimi-slow" && override.modelPattern.test(context.model))
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
  const match = MODEL_STRUCTURED_OUTPUT_RULES.find((definition) => (
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
