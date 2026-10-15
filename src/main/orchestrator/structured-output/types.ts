import type { Transport } from "../vendors/types";
import type {
  StructuredOutputMode,
  StructuredOutputTier,
  StructuredOutputVerification,
} from "../../../shared/vendor-registry/model-types";

export type {
  StructuredOutputMode,
  StructuredOutputTier,
  StructuredOutputVerification,
} from "../../../shared/vendor-registry/model-types";

export type StructuredOutputStage =
  | "cita"
  | "task_router"
  | "planner"
  | "native_fc"
  | "memory"
  | "memory_judge"
  | "memory_compress"
  | "memory_reflect"
  | "memory_resolve"
  | "memory_summary"
  | "memory_wiki";

export interface StructuredOutputProfileContext {
  provider: string;
  model: string;
  transport: Transport;
  endpointKind: "official" | "custom" | "local";
}

export interface StructuredOutputRepairPolicy {
  maxAttempts: number;
  totalBudgetMs: number;
  perAttemptTimeoutMs: number;
  minimumRemainingBudgetMs: number;
}

export interface StructuredOutputProfile {
  id: string;
  provider: string;
  model: string;
  transport?: Transport;
  tier: StructuredOutputTier;
  mode: StructuredOutputMode;
  verification: StructuredOutputVerification;
  allowCapabilityPromotion: false;
  requestHints: {
    sendJsonObject: boolean;
    reasoningSplit: boolean;
  };
  reasoning: "disabled" | "preserve";
  repair: Record<StructuredOutputStage, StructuredOutputRepairPolicy>;
}
