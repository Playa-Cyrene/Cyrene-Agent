/**
 * Transcript canonical model materialization and UI projection.
 *
 * This module is deliberately pure: it does not read or write the transcript
 * store.  The model path only uses canonical payloads; presentation patches
 * are consumed by the UI projection path and never leak into model context.
 */

import {
  parseToolCallArgs,
  toolCallFingerprint,
  type UncertainEffect,
} from "./harness/types";
import type { HarnessRunSession } from "./harness/run-store";
import type { ChatMessage as UiChatMessage } from "../../shared/chat-types";
import type {
  TranscriptEntry,
  TranscriptPresentationPatch,
} from "./conversation-transcript-types";
import type { ChatMessage, ChatMessageContent, ToolCall } from "./vendors/types";

export interface TranscriptRunReader {
  get(runId: string): HarnessRunSession | null;
}

export interface MaterializedTranscript {
  messages: ChatMessage[];
  uncertainEffects: UncertainEffect[];
  throughSeq: number;
}

export interface ConversationProjection {
  throughSeq: number;
  messages: UiChatMessage[];
}

type UserEntry = Extract<TranscriptEntry, { kind: "user" }>;
type AssistantEntry = Extract<TranscriptEntry, { kind: "assistant" }>;
type RewindEntry = Extract<TranscriptEntry, { kind: "turn_rewind" }>;

type ActiveNode =
  | { kind: "user"; entry: UserEntry | RewindEntry; text: string }
  | { kind: "assistant"; entry: AssistantEntry; toolResults: Map<string, ChatMessage> };

interface ActiveTranscript {
  nodes: ActiveNode[];
  throughSeq: number;
}

interface CanonicalUiMessage {
  message: UiChatMessage;
  /** Canonical entry ids and assistant turn ids that address this message. */
  aliases: Set<string>;
}

function findActiveUserIndex(nodes: ActiveNode[], turnId: string): number {
  let best = -1;
  let bestRevision = -Infinity;
  for (let index = 0; index < nodes.length; index++) {
    const node = nodes[index];
    if (node.kind !== "user" || node.entry.turnId !== turnId) continue;
    const revision = node.entry.revision ?? 0;
    if (revision > bestRevision) {
      best = index;
      bestRevision = revision;
    }
  }
  return best;
}

/** Build the active canonical branch before either reducer materializes it. */
function reduceActiveTranscript(entries: TranscriptEntry[]): ActiveTranscript {
  const nodes: ActiveNode[] = [];
  let throughSeq = 0;

  for (const entry of entries) {
    throughSeq = Math.max(throughSeq, entry.seq);
    switch (entry.kind) {
      case "user":
        nodes.push({ kind: "user", entry, text: entry.payload.text });
        break;
      case "assistant":
        nodes.push({ kind: "assistant", entry, toolResults: new Map() });
        break;
      case "tool_result": {
        const node = nodes.find(
          (item) => item.kind === "assistant" && item.entry.id === entry.payload.assistantEntryId,
        );
        if (node?.kind === "assistant" && !node.toolResults.has(entry.payload.toolCallId)) {
          node.toolResults.set(entry.payload.toolCallId, entry.payload.message);
        }
        break;
      }
      case "turn_rewind": {
        const anchorIndex = findActiveUserIndex(nodes, entry.payload.anchorUserTurnId);
        if (entry.payload.disposition === "keep_user") {
          if (anchorIndex >= 0) nodes.length = anchorIndex + 1;
        } else {
          if (anchorIndex >= 0) nodes.length = anchorIndex;
          nodes.push({
            kind: "user",
            entry,
            text: entry.payload.replacementUser?.text ?? "",
          });
        }
        break;
      }
      case "turn_tombstone": {
        const targetIndex = findActiveUserIndex(nodes, entry.payload.targetUserTurnId);
        if (targetIndex >= 0) nodes.length = targetIndex;
        break;
      }
      default:
        // Presentation, receipts, interruption, backfill and checkpoints do
        // not themselves alter the active canonical node sequence.
        break;
    }
  }

  return { nodes, throughSeq };
}

function syntheticToolMessage(call: ToolCall, outcome: "unknown" | "not_executed"): ChatMessage {
  return {
    role: "tool",
    toolCallId: call.id,
    name: call.name,
    content: JSON.stringify({
      outcome,
      tool: call.name,
      message: outcome === "unknown"
        ? "该工具已启动但结果未知（中断或轨迹写入失败）；不得自动重放，先查证或询问用户。"
        : "该工具从未执行（排队未启动即中断）；请根据当前任务自行决定是否重新调用。",
    }),
  };
}

function addUncertainEffect(
  effects: UncertainEffect[],
  runId: string | undefined,
  call: ToolCall,
): void {
  if (effects.some((effect) => effect.toolCallId === call.id)) return;
  effects.push({
    id: `${runId ?? "unknown-run"}:${call.id}`,
    toolCallId: call.id,
    fingerprint: toolCallFingerprint(call.name, parseToolCallArgs(call)),
    toolName: call.name,
    message: "该外部副作用在应用中断时尚未确认结果",
  });
}

function materializeNodes(
  nodes: ActiveNode[],
  runReader: TranscriptRunReader,
): { messages: ChatMessage[]; uncertainEffects: UncertainEffect[] } {
  const messages: ChatMessage[] = [];
  const uncertainEffects: UncertainEffect[] = [];
  for (const node of nodes) {
    if (node.kind === "user") {
      messages.push({ role: "user", content: node.text });
      continue;
    }
    const payload = node.entry.payload;
    messages.push(payload);
    if (!payload.toolCalls?.length) continue;

    const runSession = node.entry.runId ? runReader.get(node.entry.runId) : null;
    const statusById = new Map(runSession?.toolCalls.map((call) => [call.toolCallId, call]));
    for (const call of payload.toolCalls) {
      const persisted = node.toolResults.get(call.id);
      if (persisted) {
        messages.push(persisted);
        continue;
      }
      const record = statusById.get(call.id);
      const isUnknown = record?.status === "started" || record?.status === "unknown";
      if (isUnknown) {
        if (record?.sideEffect === "non_idempotent_side_effect") {
          addUncertainEffect(uncertainEffects, node.entry.runId, call);
        }
        messages.push(syntheticToolMessage(call, "unknown"));
      } else {
        messages.push(syntheticToolMessage(call, "not_executed"));
      }
    }
  }
  return { messages, uncertainEffects };
}

function failedDeliveryNotes(
  entries: TranscriptEntry[],
  activeNodes: ActiveNode[],
  minSeqExclusive = -Infinity,
): ChatMessage[] {
  const notes: ChatMessage[] = [];
  const activeAssistantTurns = new Set(
    activeNodes
      .filter((node): node is Extract<ActiveNode, { kind: "assistant" }> => node.kind === "assistant")
      .map((node) => node.entry.turnId)
      .filter((turnId): turnId is string => Boolean(turnId)),
  );
  for (const entry of entries) {
    if (entry.kind !== "delivery_receipt" || entry.seq <= minSeqExclusive || entry.payload.status !== "failed") {
      continue;
    }
    if (!activeAssistantTurns.has(entry.payload.assistantTurnId)) continue;
    const detail = entry.payload.errorCode ? `（错误码：${entry.payload.errorCode}）` : "";
    notes.push({
      role: "system",
      visibility: "internal",
      content: `上一回复未送达（${entry.payload.channel}）${detail}`,
      internal: {
        kind: "recovery",
        revision: 1,
        digest: `${entry.payload.assistantTurnId}:${entry.payload.channel}:${entry.payload.errorCode ?? "failed"}`,
        id: `delivery-failure:${entry.id}`,
        runId: entry.runId ?? "delivery",
        createdAt: entry.at,
      },
    });
  }
  return notes;
}

function latestCompaction(entries: TranscriptEntry[]): Extract<TranscriptEntry, { kind: "compaction_checkpoint" }> | undefined {
  let latest: Extract<TranscriptEntry, { kind: "compaction_checkpoint" }> | undefined;
  for (const entry of entries) {
    if (entry.kind === "compaction_checkpoint" && (!latest || entry.seq > latest.seq)) latest = entry;
  }
  return latest;
}

function contentToText(content: ChatMessageContent | undefined): string {
  if (typeof content === "string") return content;
  if (!content) return "";
  return content.map((block) => block.type === "text" ? block.text : "[image]").join("");
}

function makeUiMessage(node: ActiveNode): CanonicalUiMessage | null {
  if (node.kind === "user") {
    return {
      message: {
        id: node.entry.id,
        role: "user",
        content: node.text,
        at: node.entry.at,
      },
      aliases: new Set([node.entry.id, ...(node.entry.turnId ? [node.entry.turnId] : [])]),
    };
  }
  const groupId = node.entry.turnId ?? node.entry.id;
  return {
    message: {
      id: groupId,
      role: "model",
      content: contentToText(node.entry.payload.content),
      at: node.entry.at,
    },
    aliases: new Set([node.entry.id, groupId]),
  };
}

function applyPatch(
  target: CanonicalUiMessage,
  patch: TranscriptPresentationPatch,
): void {
  Object.assign(target.message, patch);
}

function projectionFromActive(
  entries: TranscriptEntry[],
  active: ActiveTranscript,
  seed: ConversationProjection | undefined,
): ConversationProjection {
  const messages: CanonicalUiMessage[] = [];
  const byAlias = new Map<string, CanonicalUiMessage>();
  const allPatches = new Map<string, { revision: number; seq: number; patch: TranscriptPresentationPatch }>();

  for (const entry of entries) {
    if (entry.kind !== "presentation_patch") continue;
    const current = allPatches.get(entry.payload.messageId);
    if (!current || entry.payload.patchRevision > current.revision
      || (entry.payload.patchRevision === current.revision && entry.seq > current.seq)) {
      allPatches.set(entry.payload.messageId, {
        revision: entry.payload.patchRevision,
        seq: entry.seq,
        patch: entry.payload.patch,
      });
    }
  }

  if (seed && seed.throughSeq > 0) {
    for (const message of seed.messages) {
      const copy: CanonicalUiMessage = {
        message: { ...message },
        aliases: new Set([message.id]),
      };
      messages.push(copy);
      byAlias.set(message.id, copy);
    }
  }

  const nodesToApply = seed && seed.throughSeq > 0
    ? active.nodes.filter((node) => node.entry.seq > seed.throughSeq)
    : active.nodes;
  for (const node of nodesToApply) {
    const canonical = makeUiMessage(node);
    if (!canonical) continue;
    const groupId = canonical.message.id;
    const existing = node.kind === "assistant"
      ? byAlias.get(groupId)
      : undefined;
    if (existing) {
      // A later assistant round in the same assistant turn is the canonical
      // latest state for this single UI message.
      existing.message.content = canonical.message.content;
      existing.message.at = canonical.message.at;
      existing.aliases.forEach((alias) => byAlias.set(alias, existing));
      byAlias.set(node.entry.id, existing);
      continue;
    }
    messages.push(canonical);
    for (const alias of canonical.aliases) byAlias.set(alias, canonical);
  }

  // Apply buffered patches only to active canonical targets. A patch can be
  // observed before its canonical row, so this pass intentionally happens
  // after all active rows have been discovered.
  for (const [messageId, record] of allPatches) {
    const target = byAlias.get(messageId);
    if (target) applyPatch(target, record.patch);
  }

  const resultMessages = messages.map((item) => item.message);
  return {
    throughSeq: Math.max(seed?.throughSeq ?? 0, active.throughSeq),
    messages: resultMessages,
  };
}

/** Reduce canonical transcript rows into the complete UI presentation history. */
export function reduceTranscriptProjection(
  entries: TranscriptEntry[],
  seed?: ConversationProjection,
): ConversationProjection {
  const active = reduceActiveTranscript(entries);
  return projectionFromActive(entries, active, seed);
}

/** Materialize all active canonical messages, ignoring presentation fields. */
export function buildFullModelContext(
  entries: TranscriptEntry[],
  runReader: TranscriptRunReader,
): MaterializedTranscript {
  const active = reduceActiveTranscript(entries);
  const materialized = materializeNodes(active.nodes, runReader);
  return {
    messages: [...materialized.messages, ...failedDeliveryNotes(entries, active.nodes)],
    uncertainEffects: materialized.uncertainEffects,
    throughSeq: active.throughSeq,
  };
}

/**
 * Materialize the latest compaction replacement plus the active canonical
 * suffix. UI projection intentionally does not use this function and keeps
 * the complete active history.
 */
export function buildModelContextFromCompactedView(
  entries: TranscriptEntry[],
  runReader: TranscriptRunReader,
): MaterializedTranscript {
  const active = reduceActiveTranscript(entries);
  const checkpoint = latestCompaction(entries);
  if (!checkpoint) return buildFullModelContext(entries, runReader);

  const suffix = active.nodes.filter((node) => node.entry.seq > checkpoint.payload.sourceThroughSeq);
  const materialized = materializeNodes(suffix, runReader);
  // Uncertain side effects are execution state, not prompt history. Keep the
  // Phase 1 guard semantics even when their originating tool round is inside
  // the compacted prefix.
  const allActiveMaterialized = materializeNodes(active.nodes, runReader);
  return {
    messages: [
      checkpoint.payload.replacement,
      ...materialized.messages,
      ...failedDeliveryNotes(entries, suffix, checkpoint.payload.sourceThroughSeq),
    ],
    uncertainEffects: allActiveMaterialized.uncertainEffects,
    throughSeq: active.throughSeq,
  };
}
