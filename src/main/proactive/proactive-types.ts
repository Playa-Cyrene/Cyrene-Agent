export interface ProactiveRuntimeSnapshot {
  now: number;
  localHour: number;
  idleSec: number;
  enabled: boolean;
  conversationBusy: boolean;
  generationBusy: boolean;
  screenLocked: boolean;
}

export interface ProactiveCandidate {
  sceneId: string;
  score: number;
  sceneCooldownMs: number;
}

/** Durable intent captured before delivery; retries must replay this exact payload. */
export interface ProactiveCommitIntent {
  intentId: string;
  sequence: number;
  candidate: ProactiveCandidate;
  generationEpoch: number;
  intentAt: number;
  text: string;
  source: "model" | "fallback";
  fallbackPayload?: unknown;
}

export interface ProactiveState {
  proactiveEpoch: number;
  unansweredCount: 0 | 1 | 2;
  lastProactiveAt: number | null;
  lastProactiveScene: string | null;
  lastNormalConversationEndedAt: number | null;
  globalDesire: number;
  affinity: Record<string, number>;
  lastFiredAt: Record<string, number | null>;
  /** At most one durable commit can be awaiting delivery completion. */
  pendingCommitIntent?: ProactiveCommitIntent;
  /** Monotonic durable identity source; absent in legacy state files. */
  proactiveCommitSequence?: number;
}

export type ProactiveBlockReason =
  | "allowed"
  | "disabled"
  | "screen_locked"
  | "conversation_busy"
  | "generation_busy"
  | "night_inactive"
  | "normal_quiet_period"
  | "global_cooldown"
  | "scene_cooldown"
  | "unanswered_limit"
  | "followup_cooldown"
  | "followup_same_scene"
  | "followup_score_too_low"
  | "stale_epoch";

export interface ProactiveCommitDecision {
  allowed: boolean;
  reason: ProactiveBlockReason;
}
