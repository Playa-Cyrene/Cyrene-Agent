import type {
  ProviderCapability,
  ReasoningCapability,
  ToolChoiceQuirk,
  Transport,
} from "./types";

/** 证据描述不驱动请求，只用于贡献审核与清单展示。 */
export type AdaptationEvidence =
  | { kind: "official"; url: string; checkedAt: string; transports: readonly Transport[] }
  | { kind: "observed"; artifact: string; checkedAt: string; transport: Transport; endpoint: string }
  | { kind: "legacy"; note: string };

export interface RuleMetadata {
  status: "supported" | "unsupported" | "unknown";
  evidence: AdaptationEvidence;
}

export interface UnknownModelCapability {
  feature: "reasoning" | "sampling" | "structuredOutput";
  transport: Transport;
  note: string;
}

export interface ModelCatalogItem {
  model: string;
  recommendedFor: readonly ("chat" | "vision")[];
  aliases?: readonly string[];
  note?: string;
  unknownCapabilities?: readonly UnknownModelCapability[];
}

/** 界面预填值与 capability 的运行默认值语义不同，分别保留。 */
export interface VendorPresetDefaults {
  baseUrl: string;
  transport: Transport;
  anthropicBaseUrl?: string;
  responsesBaseUrl?: string;
  visionBaseUrl?: string;
  defaultVisionModel?: string;
}

export interface ReasoningRuleInput {
  modelPattern: RegExp;
  modelInferencePattern?: RegExp;
  familyLabel?: string;
  metadata: RuleMetadata;
  capability: ReasoningCapability;
}

export interface ModelSamplingRuleInput {
  modelPattern: RegExp;
  diversity: boolean;
  repetition?: "openai" | "qwen";
  requiresReasoningOff?: boolean;
  maximumTemperature?: number;
  familyLabel?: string;
  metadata: RuleMetadata;
}

export interface ModelSamplingRule extends ModelSamplingRuleInput {
  providerId: string;
}

export type StructuredOutputMode = "provider_json_schema" | "provider_json_object" | "prompt_json";
export type StructuredOutputVerification = "official" | "contract_verified" | "contract_required";
export type StructuredOutputTier = "A" | "B" | "D" | "M";

export interface StructuredOutputRuleInput {
  id: string;
  transport: Transport;
  modelPattern: RegExp;
  tier: Exclude<StructuredOutputTier, "D">;
  mode: StructuredOutputMode;
  verification: StructuredOutputVerification;
  requestHints?: { sendJsonObject?: boolean; reasoningSplit?: boolean };
  repairOverrides?: readonly { modelPattern: RegExp; preset: "kimi-slow" }[];
  familyLabel?: string;
  metadata: RuleMetadata;
}

export interface StructuredOutputRule extends StructuredOutputRuleInput {
  provider: string;
}

export interface VendorRegistryInput {
  capability: ProviderCapability;
  shortName: string;
  reasoningRules: readonly ReasoningRuleInput[];
  toolChoiceQuirk?: ToolChoiceQuirk;
  presetDefaults?: VendorPresetDefaults;
  models?: readonly ModelCatalogItem[];
  samplingRules?: readonly ModelSamplingRuleInput[];
  structuredOutputRules?: readonly StructuredOutputRuleInput[];
}
