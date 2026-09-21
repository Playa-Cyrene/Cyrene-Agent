/**
 * Conversation transcript model-context entry points.
 *
 * Canonical materialization and UI projection live in
 * conversation-transcript-projection.ts. This module keeps the context API
 * stable while returning the complete active model view. Compaction is now a
 * transcript-level checkpoint operation; callers must not silently tail-cut.
 */

import { DEFAULT_HARNESS_CONFIG } from "./harness/types";
import type { ConversationTranscriptStore } from "./conversation-transcript-store";
import {
  buildFullModelContext,
  buildModelContextFromCompactedView,
  type MaterializedTranscript,
  type TranscriptRunReader,
} from "./conversation-transcript-projection";
import type { TranscriptEntry } from "./conversation-transcript-types";

export type { MaterializedTranscript, TranscriptRunReader } from "./conversation-transcript-projection";
export {
  buildFullModelContext,
  buildModelContextFromCompactedView,
  reduceTranscriptProjection,
} from "./conversation-transcript-projection";

/** Phase 1 compatibility alias for the full canonical materializer. */
export function materializeTranscript(
  entries: TranscriptEntry[],
  runReader: TranscriptRunReader,
): MaterializedTranscript {
  return buildFullModelContext(entries, runReader);
}

/** 权威上下文构建：等队列清空 → 读轨迹 → 物化完整活动视图。 */
export async function buildModelContext(input: {
  store: ConversationTranscriptStore;
  conversationId: string;
  retainTokens: number;
  runReader: TranscriptRunReader;
}): Promise<MaterializedTranscript> {
  // fail-closed 读取前置：先等该会话写队列清空，禁止读到半更新状态
  await input.store.waitForIdle(input.conversationId);
  const snapshot = await input.store.read(input.conversationId);
  // `retainTokens` remains in the compatibility signature; the budget decision
  // now belongs to the transcript compactor and never drops history implicitly.
  void input.retainTokens;
  const materialized = buildModelContextFromCompactedView(snapshot.entries, input.runReader);
  return {
    messages: materialized.messages,
    uncertainEffects: materialized.uncertainEffects,
    throughSeq: snapshot.throughSeq,
  };
}

/** 轨迹尾窗预算：沿用 Harness 既有 token 预算体系，不另立标准。 */
export function resolveTranscriptRetainTokens(contextWindowTokens: number): number {
  const usable = Math.max(
    1,
    contextWindowTokens
      - DEFAULT_HARNESS_CONFIG.reservedOutputTokens
      - DEFAULT_HARNESS_CONFIG.safetyMarginTokens,
  );
  return Math.max(1, Math.floor(usable * DEFAULT_HARNESS_CONFIG.compactionThreshold));
}
