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

/** Canonical messages plus the active transcript row that produced each one. */
export interface MaterializedTranscriptWithSources extends MaterializedTranscript {
  sourceSeqs: number[];
}

export interface ConversationProjectionNodeState {
  kind: "user" | "assistant";
  entryId: string;
  messageId: string;
  turnId?: string;
  revision?: number;
}

export interface ConversationProjectionPatchState {
  messageId: string;
  patchRevision: number;
  patch: TranscriptPresentationPatch;
}

export interface ConversationProjectionState {
  nodes: ConversationProjectionNodeState[];
  patches?: ConversationProjectionPatchState[];
}

export interface ConversationProjection {
  throughSeq: number;
  messages: UiChatMessage[];
  /** JSON-safe reducer state needed for incremental branch mutations. */
  state?: ConversationProjectionState;
}

type UserEntry = Extract<TranscriptEntry, { kind: "user" }>;
type AssistantEntry = Extract<TranscriptEntry, { kind: "assistant" }>;
type RewindEntry = Extract<TranscriptEntry, { kind: "turn_rewind" }>;

type ActiveNode =
  | { kind: "user"; entry: UserEntry | RewindEntry; text: string }
  | {
      kind: "assistant";
      entry: AssistantEntry;
      toolResults: Map<string, ChatMessage>;
      toolResultSeqs: Map<string, number>;
    };

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
        nodes.push({ kind: "assistant", entry, toolResults: new Map(), toolResultSeqs: new Map() });
        break;
      case "tool_result": {
        const node = nodes.find(
          (item) => item.kind === "assistant" && item.entry.id === entry.payload.assistantEntryId,
        );
        if (node?.kind === "assistant" && !node.toolResults.has(entry.payload.toolCallId)) {
          node.toolResults.set(entry.payload.toolCallId, entry.payload.message);
          node.toolResultSeqs.set(entry.payload.toolCallId, entry.seq);
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
): { messages: ChatMessage[]; uncertainEffects: UncertainEffect[]; sourceSeqs: number[] } {
  const messages: ChatMessage[] = [];
  const uncertainEffects: UncertainEffect[] = [];
  const sourceSeqs: number[] = [];
  for (const node of nodes) {
    if (node.kind === "user") {
      messages.push({ role: "user", content: node.text });
      sourceSeqs.push(node.entry.seq);
      continue;
    }
    const payload = node.entry.payload;
    messages.push(payload);
    sourceSeqs.push(node.entry.seq);
    if (!payload.toolCalls?.length) continue;

    const runSession = node.entry.runId ? runReader.get(node.entry.runId) : null;
    const statusById = new Map(runSession?.toolCalls.map((call) => [call.toolCallId, call]));
    for (const call of payload.toolCalls) {
      const persisted = node.toolResults.get(call.id);
      if (persisted) {
        messages.push(persisted);
        sourceSeqs.push(node.toolResultSeqs.get(call.id) ?? node.entry.seq);
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
      sourceSeqs.push(node.entry.seq);
    }
  }
  return { messages, uncertainEffects, sourceSeqs };
}

/** 模型上下文内部提示（送达失败 / 中断边界等）的插入位置：beforeSeq 前插一条。 */
interface InternalNotePlacement {
  note: ChatMessage;
  sourceSeq: number;
  beforeSeq: number;
}

function failedDeliveryNotesWithSources(
  entries: TranscriptEntry[],
  activeNodes: ActiveNode[],
  minSeqExclusive = -Infinity,
): { notes: InternalNotePlacement[] } {
  const latestByAssistant = new Map<string, Extract<TranscriptEntry, { kind: "delivery_receipt" }>>();
  for (const entry of entries) {
    if (entry.kind !== "delivery_receipt" || entry.seq <= minSeqExclusive) continue;
    const previous = latestByAssistant.get(entry.payload.assistantTurnId);
    const revision = entry.payload.revision ?? entry.revision ?? 0;
    const previousRevision = previous?.payload.revision ?? previous?.revision ?? 0;
    if (!previous || revision > previousRevision || (revision === previousRevision && entry.seq > previous.seq)) {
      latestByAssistant.set(entry.payload.assistantTurnId, entry);
    }
  }

  const notes: InternalNotePlacement[] = [];
  for (const receipt of latestByAssistant.values()) {
    if (receipt.payload.status !== "failed") continue;
    const assistantIndex = activeNodes.findIndex(
      (node) => node.kind === "assistant" && node.entry.turnId === receipt.payload.assistantTurnId,
    );
    if (assistantIndex < 0) continue;
    const nextUser = activeNodes.slice(assistantIndex + 1).find(
      (node): node is Extract<ActiveNode, { kind: "user" }> => node.kind === "user" && node.entry.seq > receipt.seq,
    );
    if (!nextUser) continue;
    const nextAssistant = activeNodes.slice(assistantIndex + 1).find(
      (node) => node.kind === "assistant" && node.entry.seq > nextUser.entry.seq,
    );
    // The next assistant round has already consumed this recovery note.
    if (nextAssistant) continue;
    const detail = receipt.payload.errorCode ? `（错误码：${receipt.payload.errorCode}）` : "";
    notes.push({
      note: {
        role: "system",
        visibility: "internal",
        content: `上一回复未送达（${receipt.payload.channel}）${detail}`,
        internal: {
          kind: "recovery",
          revision: 1,
          digest: `${receipt.payload.assistantTurnId}:${receipt.payload.channel}:${receipt.payload.errorCode ?? "failed"}`,
          id: `delivery-failure:${receipt.id}`,
          runId: receipt.runId ?? "delivery",
          createdAt: receipt.at,
        },
      },
      sourceSeq: receipt.seq,
      beforeSeq: nextUser.entry.seq,
    });
  }
  return { notes };
}

/**
 * 未闭合中断的一次性内部提示（与送达失败提示同构，只进模型上下文，不进聊天 UI）：
 * - 找到中断条目之后（seq 更大）的第一个活动 user，提示插在它之前；
 * - 该 user 之后一旦出现 assistant 即视为已闭合，后续轮次不再注入；
 * - 闭合判定必须是「中断后第一个 user 之后的 assistant」——中断前的
 *   assistant（含带工具调用的）不算闭合证据；
 * - 活动分支感知：user 查找走 activeNodes，rewind / 墓碑裁掉的分支里
 *   找不到锚点自然不注入；
 * - sourceSeq 用中断条目自身的 seq，与压缩/重放的来源映射保持一致。
 */
function interruptionNotesWithSources(
  entries: TranscriptEntry[],
  activeNodes: ActiveNode[],
  minSeqExclusive = -Infinity,
): { notes: InternalNotePlacement[] } {
  const notes: InternalNotePlacement[] = [];
  for (const entry of entries) {
    if (entry.kind !== "interruption" || entry.seq <= minSeqExclusive) continue;
    const nextUser = activeNodes.find(
      (node): node is Extract<ActiveNode, { kind: "user" }> => node.kind === "user" && node.entry.seq > entry.seq,
    );
    if (!nextUser) continue;
    const nextAssistant = activeNodes.find(
      (node) => node.kind === "assistant" && node.entry.seq > nextUser.entry.seq,
    );
    if (nextAssistant) continue;
    notes.push({
      note: {
        role: "system",
        visibility: "internal",
        content: entry.payload.reason === "user_cancel"
          ? "上一轮由用户主动停止，未完整结束。不要自行延续上一轮；以用户最新消息为准。"
          : "上一轮因系统错误未完整结束，没有生成完整回答。请结合用户最新消息决定是否继续。",
        internal: {
          kind: "recovery",
          revision: 1,
          digest: `interruption:${entry.payload.reason}`,
          id: `interruption-note:${entry.id}`,
          runId: entry.runId ?? "interruption",
          createdAt: entry.at,
        },
      },
      sourceSeq: entry.seq,
      beforeSeq: nextUser.entry.seq,
    });
  }
  return { notes };
}

/**
 * 按插入点分组插入内部提示：同一 beforeSeq 可能有多条（如中断提示 + 送达失败
 * 提示同时指向一个 user），组内按来源 seq 稳定排序，不互相覆盖。
 */
function insertInternalNotes(
  materialized: { messages: ChatMessage[]; sourceSeqs: number[] },
  placements: InternalNotePlacement[],
): { messages: ChatMessage[]; sourceSeqs: number[] } {
  if (placements.length === 0) return materialized;
  const byBeforeSeq = new Map<number, InternalNotePlacement[]>();
  for (const placement of placements) {
    const group = byBeforeSeq.get(placement.beforeSeq);
    if (group) group.push(placement);
    else byBeforeSeq.set(placement.beforeSeq, [placement]);
  }
  const messages: ChatMessage[] = [];
  const sourceSeqs: number[] = [];
  for (let index = 0; index < materialized.messages.length; index += 1) {
    const before = byBeforeSeq.get(materialized.sourceSeqs[index]);
    if (before) {
      for (const placement of [...before].sort((left, right) => left.sourceSeq - right.sourceSeq)) {
        messages.push(placement.note);
        sourceSeqs.push(placement.sourceSeq);
      }
    }
    messages.push(materialized.messages[index]);
    sourceSeqs.push(materialized.sourceSeqs[index]);
  }
  return { messages, sourceSeqs };
}

function checkpointCoversActiveBranch(
  entries: TranscriptEntry[],
  active: ActiveTranscript,
  checkpoint: Extract<TranscriptEntry, { kind: "compaction_checkpoint" }>,
): boolean {
  const sourceThroughSeq = checkpoint.payload.sourceThroughSeq;
  const beforeCheckpoint = reduceActiveTranscript(
    entries.filter((entry) => entry.seq <= sourceThroughSeq),
  ).nodes;
  const finalCovered = active.nodes.filter((node) => node.entry.seq <= sourceThroughSeq);
  return beforeCheckpoint.length === finalCovered.length
    && beforeCheckpoint.every((node, index) => node.entry.id === finalCovered[index]?.entry.id);
}

function latestValidCompaction(
  entries: TranscriptEntry[],
  active: ActiveTranscript,
): Extract<TranscriptEntry, { kind: "compaction_checkpoint" }> | undefined {
  return entries
    .filter((entry): entry is Extract<TranscriptEntry, { kind: "compaction_checkpoint" }> => entry.kind === "compaction_checkpoint")
    .sort((left, right) => right.seq - left.seq)
    .find((checkpoint) => checkpointCoversActiveBranch(entries, active, checkpoint));
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

function nodeStateFromActive(node: ActiveNode): ConversationProjectionNodeState {
  return node.kind === "user"
    ? {
      kind: "user",
      entryId: node.entry.id,
      messageId: node.entry.id,
      ...(node.entry.turnId ? { turnId: node.entry.turnId } : {}),
      ...(node.entry.revision !== undefined ? { revision: node.entry.revision } : {}),
    }
    : {
      kind: "assistant",
      entryId: node.entry.id,
      messageId: node.entry.turnId ?? node.entry.id,
      ...(node.entry.turnId ? { turnId: node.entry.turnId } : {}),
    };
}

function findSeedUserIndex(nodes: ConversationProjectionNodeState[], turnId: string): number {
  let best = -1;
  let bestRevision = -Infinity;
  for (let index = 0; index < nodes.length; index++) {
    const node = nodes[index];
    if (node.kind !== "user" || node.turnId !== turnId) continue;
    const revision = node.revision ?? 0;
    if (revision > bestRevision) {
      best = index;
      bestRevision = revision;
    }
  }
  return best;
}

function projectSeedDelta(
  entries: TranscriptEntry[],
  seed: ConversationProjection,
): ConversationProjection {
  const messages: CanonicalUiMessage[] = seed.messages.map((message) => ({
    message: { ...message },
    aliases: new Set([message.id]),
  }));
  const byAlias = new Map<string, CanonicalUiMessage>();
  for (const item of messages) byAlias.set(item.message.id, item);
  const state: ConversationProjectionState = {
    nodes: (seed.state?.nodes ?? seed.messages.map((message) => ({
      kind: message.role === "user" ? "user" : "assistant",
      entryId: message.id,
      messageId: message.id,
    }))).map((node) => ({ ...node })),
  };

  // Restore aliases for canonical assistant entries that were folded into one
  // UI message in the seed. This is what lets a later patch address the
  // original assistant entry id.
  for (const node of state.nodes) {
    const target = byAlias.get(node.messageId);
    if (!target) continue;
    target.aliases.add(node.entryId);
    if (node.turnId) target.aliases.add(node.turnId);
    byAlias.set(node.entryId, target);
    if (node.turnId) byAlias.set(node.turnId, target);
  }

  const activeEntries = entries.filter((entry) => entry.seq > seed.throughSeq);
  const patches = new Map<string, { revision: number; seq: number; patch: TranscriptPresentationPatch }>();
  for (const record of seed.state?.patches ?? []) {
    patches.set(record.messageId, {
      revision: record.patchRevision,
      seq: Number.NEGATIVE_INFINITY,
      patch: record.patch,
    });
  }
  for (const entry of activeEntries) {
    if (entry.kind !== "presentation_patch") continue;
    const current = patches.get(entry.payload.messageId);
    if (!current || entry.payload.patchRevision > current.revision
      || (entry.payload.patchRevision === current.revision && entry.seq > current.seq)) {
      patches.set(entry.payload.messageId, {
        revision: entry.payload.patchRevision,
        seq: entry.seq,
        patch: { ...(current?.patch ?? {}), ...entry.payload.patch },
      });
    }
  }

  const retainMessagesForState = (): void => {
    const retained = new Set(state.nodes.map((node) => node.messageId));
    for (let index = messages.length - 1; index >= 0; index--) {
      if (!retained.has(messages[index].message.id)) messages.splice(index, 1);
    }
    byAlias.clear();
    for (const item of messages) byAlias.set(item.message.id, item);
    for (const node of state.nodes) {
      const target = byAlias.get(node.messageId);
      if (!target) continue;
      target.aliases.add(node.entryId);
      if (node.turnId) target.aliases.add(node.turnId);
      byAlias.set(node.entryId, target);
      if (node.turnId) byAlias.set(node.turnId, target);
    }
  };

  for (const entry of activeEntries) {
    switch (entry.kind) {
      case "user": {
        const node: ConversationProjectionNodeState = {
          kind: "user", entryId: entry.id, messageId: entry.id,
          ...(entry.turnId ? { turnId: entry.turnId } : {}),
          ...(entry.revision !== undefined ? { revision: entry.revision } : {}),
        };
        state.nodes.push(node);
        const item: CanonicalUiMessage = {
          message: { id: entry.id, role: "user", content: entry.payload.text, at: entry.at },
          aliases: new Set([entry.id, ...(entry.turnId ? [entry.turnId] : [])]),
        };
        messages.push(item);
        byAlias.set(entry.id, item);
        if (entry.turnId) byAlias.set(entry.turnId, item);
        break;
      }
      case "assistant": {
        const messageId = entry.turnId ?? entry.id;
        const node: ConversationProjectionNodeState = {
          kind: "assistant", entryId: entry.id, messageId,
          ...(entry.turnId ? { turnId: entry.turnId } : {}),
        };
        state.nodes.push(node);
        const existing = byAlias.get(messageId);
        if (existing && existing.message.role === "model") {
          existing.message.content = contentToText(entry.payload.content);
          existing.message.at = entry.at;
          existing.aliases.add(entry.id);
          byAlias.set(entry.id, existing);
        } else {
          const item: CanonicalUiMessage = {
            message: { id: messageId, role: "model", content: contentToText(entry.payload.content), at: entry.at },
            aliases: new Set([entry.id, messageId]),
          };
          messages.push(item);
          byAlias.set(entry.id, item);
          byAlias.set(messageId, item);
        }
        break;
      }
      case "turn_rewind": {
        const anchorIndex = findSeedUserIndex(state.nodes, entry.payload.anchorUserTurnId);
        if (entry.payload.disposition === "keep_user") {
          if (anchorIndex >= 0) state.nodes.length = anchorIndex + 1;
        } else {
          if (anchorIndex >= 0) state.nodes.length = anchorIndex;
          state.nodes.push({
            kind: "user", entryId: entry.id, messageId: entry.id,
            ...(entry.turnId ? { turnId: entry.turnId } : {}),
            ...(entry.revision !== undefined ? { revision: entry.revision } : {}),
          });
        }
        retainMessagesForState();
        if (entry.payload.disposition === "replace_user") {
          const item: CanonicalUiMessage = {
            message: { id: entry.id, role: "user", content: entry.payload.replacementUser?.text ?? "", at: entry.at },
            aliases: new Set([entry.id, ...(entry.turnId ? [entry.turnId] : [])]),
          };
          messages.push(item);
          byAlias.set(entry.id, item);
          if (entry.turnId) byAlias.set(entry.turnId, item);
        }
        break;
      }
      case "turn_tombstone": {
        const targetIndex = findSeedUserIndex(state.nodes, entry.payload.targetUserTurnId);
        if (targetIndex >= 0) state.nodes.length = targetIndex;
        retainMessagesForState();
        break;
      }
      default:
        break;
    }
  }

  for (const [messageId, record] of patches) {
    const target = byAlias.get(messageId);
    if (target) applyPatch(target, record.patch);
  }
  return {
    throughSeq: Math.max(seed.throughSeq, ...activeEntries.map((entry) => entry.seq), 0),
    messages: messages.map((item) => item.message),
    state: {
      ...state,
      patches: [...patches.entries()]
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([messageId, record]) => ({
          messageId,
          patchRevision: record.revision,
          patch: record.patch,
        })),
    },
  };
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
        patch: { ...(current?.patch ?? {}), ...entry.payload.patch },
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
    state: {
      nodes: active.nodes.map(nodeStateFromActive),
      patches: [...allPatches.entries()]
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([messageId, record]) => ({
          messageId,
          patchRevision: record.revision,
          patch: record.patch,
        })),
    },
  };
}

/** Reduce canonical transcript rows into the complete UI presentation history. */
export function reduceTranscriptProjection(
  entries: TranscriptEntry[],
  seed?: ConversationProjection,
): ConversationProjection {
  if (seed && seed.throughSeq > 0) return projectSeedDelta(entries, seed);
  const active = reduceActiveTranscript(entries);
  return projectionFromActive(entries, active, seed);
}

/** Materialize all active canonical messages, ignoring presentation fields. */
export function buildFullModelContext(
  entries: TranscriptEntry[],
  runReader: TranscriptRunReader,
): MaterializedTranscript {
  const result = buildFullModelContextWithSources(entries, runReader);
  return {
    messages: result.messages,
    uncertainEffects: result.uncertainEffects,
    throughSeq: result.throughSeq,
  };
}

/** Full active model view with branch-aware source sequence mapping for compaction. */
export function buildFullModelContextWithSources(
  entries: TranscriptEntry[],
  runReader: TranscriptRunReader,
): MaterializedTranscriptWithSources {
  const active = reduceActiveTranscript(entries);
  const materialized = materializeNodes(active.nodes, runReader);
  const delivery = failedDeliveryNotesWithSources(entries, active.nodes);
  const interruption = interruptionNotesWithSources(entries, active.nodes);
  const withInternalNotes = insertInternalNotes(materialized, [...delivery.notes, ...interruption.notes]);
  return {
    messages: withInternalNotes.messages,
    uncertainEffects: materialized.uncertainEffects,
    throughSeq: active.throughSeq,
    sourceSeqs: withInternalNotes.sourceSeqs,
  };
}

/**
 * 压缩输入视图：已存在有效压缩检查点时，摘要输入改为"旧摘要 + 活动后缀"，
 * 避免二次压缩只总结后缀而静默丢弃第一次摘要所代表的更早历史。
 * previousReplacement 返回旧摘要本体，供压缩器识别"未产生新摘要"的失败路径。
 */
export function buildCompactionSourceView(
  entries: TranscriptEntry[],
  runReader: TranscriptRunReader,
): MaterializedTranscriptWithSources & { previousReplacement?: ChatMessage } {
  const active = reduceActiveTranscript(entries);
  const checkpoint = latestValidCompaction(entries, active);
  if (!checkpoint) return buildFullModelContextWithSources(entries, runReader);

  const suffix = active.nodes.filter((node) => node.entry.seq > checkpoint.payload.sourceThroughSeq);
  const materialized = materializeNodes(suffix, runReader);
  const delivery = failedDeliveryNotesWithSources(entries, active.nodes, checkpoint.payload.sourceThroughSeq);
  const interruption = interruptionNotesWithSources(entries, active.nodes, checkpoint.payload.sourceThroughSeq);
  const suffixWithInternalNotes = insertInternalNotes(materialized, [...delivery.notes, ...interruption.notes]);
  return {
    messages: [
      checkpoint.payload.replacement,
      ...suffixWithInternalNotes.messages,
    ],
    uncertainEffects: materialized.uncertainEffects,
    throughSeq: active.throughSeq,
    // 旧摘要对应的源边界是上一个检查点的 sourceThroughSeq：切点覆盖它时，
    // 新检查点即完整接管旧检查点所代表的历史。
    sourceSeqs: [checkpoint.payload.sourceThroughSeq, ...suffixWithInternalNotes.sourceSeqs],
    previousReplacement: checkpoint.payload.replacement,
  };
}

/**
 * rewind 锚点安全性：锚点必须存在于模型活动分支，且位于最新有效压缩边界之后。
 * 已归档进压缩前缀的 user 轮次不能作为编辑/重新生成锚点——模型视图无法截断
 * 压缩摘要内部的历史，强行提交会造成 UI 与模型分支分裂。
 */
export function isUserTurnRewindableInModelView(
  entries: TranscriptEntry[],
  anchorUserTurnId: string,
): boolean {
  const active = reduceActiveTranscript(entries);
  const anchorIndex = findActiveUserIndex(active.nodes, anchorUserTurnId);
  if (anchorIndex < 0) return false;
  const checkpoint = latestValidCompaction(entries, active);
  if (!checkpoint) return true;
  return active.nodes[anchorIndex]!.entry.seq > checkpoint.payload.sourceThroughSeq;
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
  const checkpoint = latestValidCompaction(entries, active);
  if (!checkpoint) return buildFullModelContext(entries, runReader);

  const suffix = active.nodes.filter((node) => node.entry.seq > checkpoint.payload.sourceThroughSeq);
  const materialized = materializeNodes(suffix, runReader);
  // Uncertain side effects are execution state, not prompt history. Keep the
  // Phase 1 guard semantics even when their originating tool round is inside
  // the compacted prefix.
  const allActiveMaterialized = materializeNodes(active.nodes, runReader);
  const delivery = failedDeliveryNotesWithSources(entries, active.nodes, checkpoint.payload.sourceThroughSeq);
  const interruption = interruptionNotesWithSources(entries, active.nodes, checkpoint.payload.sourceThroughSeq);
  const suffixWithInternalNotes = insertInternalNotes(materialized, [...delivery.notes, ...interruption.notes]);
  return {
    messages: [
      checkpoint.payload.replacement,
      ...suffixWithInternalNotes.messages,
    ],
    uncertainEffects: allActiveMaterialized.uncertainEffects,
    throughSeq: active.throughSeq,
  };
}
