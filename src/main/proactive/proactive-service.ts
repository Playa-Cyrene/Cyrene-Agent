import type { ChatMessage } from "../orchestrator/vendors/types";
import {
  canCommitProactiveMessage,
  canStartProactiveGeneration,
  markNormalConversationEnded,
  markNormalConversationStarted,
  markProactiveCommitted,
  markUserActivity,
} from "./proactive-policy";
import type { ProactiveModelResult } from "./proactive-model";
import type { ProactiveCandidate, ProactiveCommitIntent, ProactiveRuntimeSnapshot, ProactiveState } from "./proactive-types";

export interface ProactiveFallback {
  text: string;
  payload?: unknown;
}

export interface ProactiveCommitInput {
  /** Durable delivery identity shared by local and channel adapters. */
  intentId?: string;
  candidate: ProactiveCandidate;
  text: string;
  source: "model" | "fallback";
  fallbackPayload?: unknown;
  generationEpoch: number;
  /** Stable intent timestamp captured before model generation. */
  intentAt?: number;
}

export type ProactiveCommitResult =
  | { kind: "committed" }
  | { kind: "cancelled"; reason: string };

export interface ProactiveChatServiceDeps {
  loadState: () => ProactiveState;
  saveState: (state: ProactiveState) => void | boolean;
  getSnapshot: () => ProactiveRuntimeSnapshot;
  buildMessages: (candidate: ProactiveCandidate, state: ProactiveState) => Promise<ChatMessage[]>;
  runModel: (messages: ChatMessage[]) => Promise<ProactiveModelResult>;
  getFallback: (candidate: ProactiveCandidate) => Promise<ProactiveFallback | null>;
  commitMessage: (input: ProactiveCommitInput) => Promise<ProactiveCommitResult>;
  /** Local journal commits require a durable intent; legacy external channels do not. */
  requiresDurableIntent?: () => boolean;
  canStartDelivery?: () => boolean;
  log?: (event: string, detail?: unknown) => void;
}

export interface ProactiveChatService {
  evaluateCandidate(candidate: ProactiveCandidate): Promise<void>;
  invalidateForUserMessage(): void;
  normalConversationStarted(): void;
  normalConversationEnded(now?: number): void;
  invalidate(): void;
  isGenerating(): boolean;
}

export function createProactiveChatService(deps: ProactiveChatServiceDeps): ProactiveChatService {
  let generating = false;

  const cloneState = (state: ProactiveState): ProactiveState => ({
    ...state,
    affinity: { ...state.affinity },
    lastFiredAt: { ...state.lastFiredAt },
    ...(state.pendingCommitIntent ? {
      pendingCommitIntent: {
        ...state.pendingCommitIntent,
        candidate: { ...state.pendingCommitIntent.candidate },
      },
    } : {}),
  });

  const stateHasIntent = (state: ProactiveState, intent: ProactiveCommitIntent): boolean => (
    state.proactiveCommitSequence === intent.sequence
    && JSON.stringify(state.pendingCommitIntent) === JSON.stringify(intent)
  );

  const persistPendingIntent = (state: ProactiveState, intent: ProactiveCommitIntent): void => {
    const result = deps.saveState(state);
    if (result === false || !stateHasIntent(deps.loadState(), intent)) {
      throw new Error("PROACTIVE_PENDING_INTENT_NOT_PERSISTED");
    }
  };

  const persistMutation = (mutate: (state: ProactiveState) => void): void => {
    const state = deps.loadState();
    mutate(state);
    deps.saveState(state);
  };

  const clearPendingIntent = (state: ProactiveState, intentId: string): void => {
    if (state.pendingCommitIntent?.intentId === intentId) delete state.pendingCommitIntent;
  };

  const finalizeDelivery = (
    result: ProactiveCommitResult,
    candidate: ProactiveCandidate,
    source: "model" | "fallback",
    generationEpoch: number,
    intentAt: number,
    intentId?: string,
  ): ProactiveCommitResult => {
    if (result.kind === "cancelled") {
      const cancelledState = cloneState(deps.loadState());
      if (intentId) clearPendingIntent(cancelledState, intentId);
      deps.saveState(cancelledState);
      deps.log?.("commit_cancelled", {
        scene: candidate.sceneId,
        reason: result.reason,
        source,
      });
      return result;
    }

    const latestState = cloneState(deps.loadState());
    if (intentId) clearPendingIntent(latestState, intentId);
    if (latestState.proactiveEpoch === generationEpoch) {
      markProactiveCommitted(latestState, candidate, intentAt);
    } else {
      // 文本已经成功写入，但用户可能在后续 TTS 等待期间发来消息。
      // 保留更新后的 Epoch/unansweredCount，只补记这次真实发送的硬冷却时间。
      latestState.lastProactiveAt = intentAt;
      latestState.lastProactiveScene = candidate.sceneId;
      latestState.lastFiredAt[candidate.sceneId] = intentAt;
      latestState.globalDesire = 0;
    }
    deps.saveState(latestState);
    deps.log?.("message_committed", { scene: candidate.sceneId, source, ...(intentId ? { intentId } : {}) });
    return result;
  };

  const deliverIntent = async (intent: ProactiveCommitIntent): Promise<ProactiveCommitResult> => {
    const result = await deps.commitMessage({
      intentId: intent.intentId,
      candidate: intent.candidate,
      text: intent.text,
      source: intent.source,
      ...(intent.fallbackPayload !== undefined ? { fallbackPayload: intent.fallbackPayload } : {}),
      generationEpoch: intent.generationEpoch,
      intentAt: intent.intentAt,
    });
    return finalizeDelivery(result, intent.candidate, intent.source, intent.generationEpoch, intent.intentAt, intent.intentId);
  };

  return {
    async evaluateCandidate(candidate): Promise<void> {
      const initialState = deps.loadState();
      const rawInitialSnapshot = deps.getSnapshot();
      const initialSnapshot = { ...rawInitialSnapshot, generationBusy: rawInitialSnapshot.generationBusy || generating };

      const requiresDurableIntent = deps.requiresDurableIntent?.() ?? true;
      const pendingIntent = requiresDurableIntent ? initialState.pendingCommitIntent : undefined;
      if (pendingIntent) {
        const pendingDecision = canCommitProactiveMessage(
          initialSnapshot,
          initialState,
          pendingIntent.candidate,
          pendingIntent.generationEpoch,
        );
        if (!pendingDecision.allowed) {
          if (pendingDecision.reason === "stale_epoch") {
            const staleState = deps.loadState();
            clearPendingIntent(staleState, pendingIntent.intentId);
            deps.saveState(staleState);
          }
          deps.log?.("pending_commit_blocked", { scene: pendingIntent.candidate.sceneId, reason: pendingDecision.reason, intentId: pendingIntent.intentId });
          return;
        }
        if (deps.canStartDelivery && !deps.canStartDelivery()) {
          deps.log?.("pending_commit_blocked", { scene: pendingIntent.candidate.sceneId, reason: "delivery_unavailable", intentId: pendingIntent.intentId });
          return;
        }
        generating = true;
        try {
          await deliverIntent(pendingIntent);
        } finally {
          generating = false;
        }
        return;
      }

      const startDecision = canStartProactiveGeneration(initialSnapshot, initialState, candidate);
      if (!startDecision.allowed) {
        deps.log?.("candidate_blocked", { scene: candidate.sceneId, reason: startDecision.reason });
        return;
      }
      if (deps.canStartDelivery && !deps.canStartDelivery()) {
        deps.log?.("candidate_blocked", { scene: candidate.sceneId, reason: "delivery_unavailable" });
        return;
      }

      generating = true;
      const generationEpoch = initialState.proactiveEpoch;
      try {
        const messages = await deps.buildMessages(candidate, initialState);
        const result = await deps.runModel(messages);
        const stateAfterModel = deps.loadState();
        if (stateAfterModel.proactiveEpoch !== generationEpoch) {
          deps.log?.("generation_discarded", { scene: candidate.sceneId, reason: "stale_epoch" });
          return;
        }

        let text: string;
        let source: "model" | "fallback";
        let fallbackPayload: unknown;
        if (result.kind === "silent") {
          const silentState = deps.loadState();
          if (silentState.proactiveEpoch === generationEpoch) {
            silentState.globalDesire = 0;
            silentState.lastFiredAt[candidate.sceneId] = deps.getSnapshot().now;
            deps.saveState(silentState);
          }
          deps.log?.("model_silent", { scene: candidate.sceneId });
          return;
        }
        if (result.kind === "send") {
          text = result.text;
          source = "model";
        } else {
          // 技术失败或无效输出才允许寻找旧预设；Epoch 失效已在上方提前拦截。
          const fallback = await deps.getFallback(candidate);
          if (!fallback?.text.trim()) {
            deps.log?.("fallback_unavailable", { scene: candidate.sceneId, result: result.kind });
            return;
          }
          text = fallback.text.trim();
          fallbackPayload = fallback.payload;
          source = "fallback";
        }

        const commitState = deps.loadState();
        const commitSnapshot = deps.getSnapshot();
        const commitDecision = canCommitProactiveMessage(
          commitSnapshot,
          commitState,
          candidate,
          generationEpoch,
        );
        if (!commitDecision.allowed) {
          deps.log?.("commit_blocked", { scene: candidate.sceneId, reason: commitDecision.reason, source });
          return;
        }

        if (!(deps.requiresDurableIntent?.() ?? true)) {
          const directResult = await deps.commitMessage({
            candidate,
            text,
            source,
            ...(fallbackPayload !== undefined ? { fallbackPayload } : {}),
            generationEpoch,
            intentAt: commitSnapshot.now,
          });
          finalizeDelivery(directResult, candidate, source, generationEpoch, commitSnapshot.now);
          return;
        }

        const commitStateBeforeIntent = cloneState(deps.loadState());
        const sequence = (commitStateBeforeIntent.proactiveCommitSequence ?? 0) + 1;
        const intent: ProactiveCommitIntent = {
          intentId: `proactive-intent-${sequence}`,
          sequence,
          candidate: { ...candidate },
          generationEpoch,
          intentAt: commitSnapshot.now,
          text,
          source,
          ...(fallbackPayload !== undefined ? { fallbackPayload } : {}),
        };
        commitStateBeforeIntent.proactiveCommitSequence = sequence;
        commitStateBeforeIntent.pendingCommitIntent = intent;
        // Persist the exact business intent before crossing into any delivery adapter.
        persistPendingIntent(commitStateBeforeIntent, intent);
        await deliverIntent(intent);
      } finally {
        generating = false;
      }
    },

    invalidateForUserMessage(): void {
      persistMutation(markUserActivity);
    },

    normalConversationStarted(): void {
      persistMutation(markNormalConversationStarted);
    },

    normalConversationEnded(now = Date.now()): void {
      persistMutation((state) => markNormalConversationEnded(state, now));
    },

    invalidate(): void {
      persistMutation((state) => { state.proactiveEpoch += 1; });
    },

    isGenerating(): boolean {
      return generating;
    },
  };
}
