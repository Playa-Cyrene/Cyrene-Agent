import { MODEL_SAMPLING_RULES } from "../../../shared/vendor-registry";
import type { ModelSamplingRule } from "../../../shared/vendor-registry/model-types";
import type { ReasoningPreference } from "../../../shared/reasoning";
import type {
  RepetitionLevel,
  StyleSamplingPreference,
} from "../../../shared/style-sampling";

export interface ApprovedStyleSampling {
  temperature?: number;
  topP?: number;
  frequencyPenalty?: number;
  repetitionPenalty?: number;
}

interface ResolveStyleSamplingInput {
  providerId: string;
  model: string;
  reasoning: ReasoningPreference;
  preference: StyleSamplingPreference;
}

const OPENAI_REPETITION = { light: 0.2, medium: 0.5, strong: 0.8 } as const;
const QWEN_REPETITION = { light: 1.05, medium: 1.10, strong: 1.18 } as const;

function resolveDiversity(
  preference: StyleSamplingPreference,
  rule: ModelSamplingRule,
): ApprovedStyleSampling {
  if (!rule.diversity || preference.diversity.driver === "model-default") {
    return {};
  }

  if (preference.diversity.driver === "top-p") {
    return { topP: preference.diversity.value };
  }

  const maximum = rule.maximumTemperature ?? preference.diversity.value;
  return { temperature: Math.min(preference.diversity.value, maximum) };
}

function repetitionValue<T extends number>(
  level: RepetitionLevel,
  mapping: Readonly<Record<Exclude<RepetitionLevel, "model-default">, T>>,
): T | undefined {
  return level === "model-default" ? undefined : mapping[level];
}

export function resolveApprovedStyleSampling({
  providerId,
  model,
  reasoning,
  preference,
}: ResolveStyleSamplingInput): ApprovedStyleSampling {
  const rule = MODEL_SAMPLING_RULES.find(candidate => (
    candidate.providerId === providerId && candidate.modelPattern.test(model)
  ));

  if (!rule || (rule.requiresReasoningOff && reasoning.mode !== "off")) {
    return {};
  }

  const approved = resolveDiversity(preference, rule);

  if (rule.repetition === "openai") {
    const frequencyPenalty = repetitionValue(preference.repetition, OPENAI_REPETITION);
    return frequencyPenalty === undefined ? approved : { ...approved, frequencyPenalty };
  }

  if (rule.repetition === "qwen") {
    const repetitionPenalty = repetitionValue(preference.repetition, QWEN_REPETITION);
    return repetitionPenalty === undefined ? approved : { ...approved, repetitionPenalty };
  }

  return approved;
}
