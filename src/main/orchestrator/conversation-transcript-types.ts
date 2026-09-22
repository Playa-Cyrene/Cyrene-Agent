/**
 * 会话轨迹协议类型（CTA Phase 1）。
 *
 * 只定义 JSONL 条目协议与校验规则，不做任何 I/O：
 * - 信封字段：seq / id / at / runId / turnId / revision / roundId；
 * - 载荷按 kind 判别：user / assistant / tool_result / interruption /
 *   turn_rewind / backfill_boundary / compaction_checkpoint；
 * - assistant 与 tool_result 原样复用 canonical ChatMessage，
 *   不得从展示事件或 preview 重建协议消息。
 */

import type {
  ChatMessage as UiChatMessage,
  ChatMessageChannel,
  PendingChatAttachment,
} from "../../shared/chat-types";
import type { ToolCallOutcome } from "./harness/types";
import type { ChatMessage as CanonicalChatMessage } from "./vendors/types";
import { isContextUsageSnapshot } from "../../shared/context-usage";
import { normalizeMusicCardData } from "../../shared/music-card";

export interface TranscriptEnvelopeBase {
  /** 会话内单调递增序号，快照/重放协议依据。 */
  seq: number;
  /** entryId，幂等主键。 */
  id: string;
  at: number;
  /** 产生该条目的 run。 */
  runId?: string;
  /** userTurnId / assistantTurnId。 */
  turnId?: string;
  /** user 条目修订号（编辑替换递增，初值 1；replace_user 行复用此字段表达替换条目的修订号）。 */
  revision?: number;
  /** Harness 主循环内的轮次（多轮工具）。 */
  roundId?: string;
}

export type TranscriptUserPayload = {
  text: string;
  attachments?: PendingChatAttachment[];
};

export type TranscriptPresentationPatch = Partial<Pick<UiChatMessage,
  "content" | "reasoning" | "reasoningBlocks" | "processMessages" |
  "agentRounds" | "taskDelegations" | "channelSource" | "sticker" |
  "toolExecutions" | "runActivity" | "runSnapshot" | "ttsCacheKey" |
  "ttsCacheVersion" | "musicCard" | "contextUsage"
>>;

/** Runtime gate for renderer-originated derived presentation data. */
export function assertValidPresentationPatch(value: unknown): asserts value is TranscriptPresentationPatch {
  if (!isRecord(value) || Object.keys(value).length === 0) {
    throw new Error("TRANSCRIPT_INVALID_PRESENTATION_PATCH");
  }
  const allowed = new Set([
    "content", "reasoning", "reasoningBlocks", "processMessages", "agentRounds",
    "taskDelegations", "channelSource", "sticker", "toolExecutions", "runActivity",
    "runSnapshot", "ttsCacheKey", "ttsCacheVersion", "musicCard", "contextUsage",
  ]);
  if (Object.keys(value).some((key) => !allowed.has(key))) {
    throw new Error("TRANSCRIPT_INVALID_PRESENTATION_PATCH");
  }
  // Keep this shared gate as strict as the persisted ChatMessage contract.
  for (const [key, field] of Object.entries(value)) {
    if (["content", "reasoning", "ttsCacheKey", "ttsCacheVersion"].includes(key)) {
      if (typeof field !== "string") throw new Error("TRANSCRIPT_INVALID_PRESENTATION_PATCH");
    } else if (key === "sticker") {
      if (field !== null && typeof field !== "string") throw new Error("TRANSCRIPT_INVALID_PRESENTATION_PATCH");
    } else if (["reasoningBlocks", "processMessages", "agentRounds", "taskDelegations", "toolExecutions"].includes(key)) {
      if (!Array.isArray(field)) throw new Error("TRANSCRIPT_INVALID_PRESENTATION_PATCH");
      if (key === "reasoningBlocks" && !field.every((item) => isReasoningBlock(item))) throw new Error("TRANSCRIPT_INVALID_PRESENTATION_PATCH");
      if (key === "processMessages" && !field.every((item) => isProcessMessage(item))) throw new Error("TRANSCRIPT_INVALID_PRESENTATION_PATCH");
      if (key === "agentRounds" && !field.every((item) => isAgentRound(item))) throw new Error("TRANSCRIPT_INVALID_PRESENTATION_PATCH");
      if (key === "taskDelegations" && !field.every((item) => isTaskDelegation(item))) throw new Error("TRANSCRIPT_INVALID_PRESENTATION_PATCH");
      if (key === "toolExecutions" && !field.every((item) => isToolExecution(item))) throw new Error("TRANSCRIPT_INVALID_PRESENTATION_PATCH");
    } else if (key === "channelSource") {
      if (!isRecord(field) || !hasOnlyKeys(field, ["channel", "chatType", "senderName"]) || !["wechat", "feishu", "qq", "qqbot"].includes(field.channel as string) ||
        !optionalField(field, "chatType", (chatType) => ["private", "group"].includes(chatType as string)) ||
        !optionalField(field, "senderName", (senderName) => typeof senderName === "string")) throw new Error("TRANSCRIPT_INVALID_PRESENTATION_PATCH");
    } else if (key === "runActivity") {
      if (!isRecord(field) || !hasOnlyKeys(field, ["startedAt", "completedAt", "reasoningMs", "activeReasoningStartedAt", "keepExpanded"]) || !finiteNumber(field.startedAt) || !finiteNumber(field.reasoningMs) ||
        !optionalField(field, "completedAt", finiteNumber) || !optionalField(field, "activeReasoningStartedAt", finiteNumber) ||
        !optionalField(field, "keepExpanded", (keepExpanded) => typeof keepExpanded === "boolean")) throw new Error("TRANSCRIPT_INVALID_PRESENTATION_PATCH");
    } else if (key === "runSnapshot") {
      if (!isRunSnapshot(field)) throw new Error("TRANSCRIPT_INVALID_PRESENTATION_PATCH");
    } else if (key === "musicCard") {
      if (!isRecord(field) || normalizeMusicCardData(field) === null || !isMusicCard(field)) throw new Error("TRANSCRIPT_INVALID_PRESENTATION_PATCH");
    } else if (key === "contextUsage") {
      if (!isContextUsageSnapshot(field) || !isContextUsageShape(field)) throw new Error("TRANSCRIPT_INVALID_PRESENTATION_PATCH");
    } else {
      throw new Error("TRANSCRIPT_INVALID_PRESENTATION_PATCH");
    }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function finiteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function optionalField(value: Record<string, unknown>, key: string, predicate: (field: unknown) => boolean): boolean {
  return !Object.prototype.hasOwnProperty.call(value, key) || predicate(value[key]);
}

function validSequenceFields(value: Record<string, unknown>): boolean {
  return optionalField(value, "afterToolCount", (field) => typeof field === "number" && Number.isInteger(field)) &&
    optionalField(value, "roundId", (field) => typeof field === "string") &&
    optionalField(value, "seq", (field) => typeof field === "number" && Number.isInteger(field));
}

function hasOnlyKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const allowed = new Set(keys);
  return Object.keys(value).every((key) => allowed.has(key));
}

function isReasoningBlock(value: unknown): boolean {
  return isRecord(value) && hasOnlyKeys(value, ["id", "content", "streaming", "afterToolCount", "roundId", "seq"]) &&
    typeof value.id === "string" && typeof value.content === "string" &&
    optionalField(value, "streaming", (field) => typeof field === "boolean") && validSequenceFields(value);
}

function isProcessMessage(value: unknown): boolean {
  return isRecord(value) && hasOnlyKeys(value, ["id", "content", "interrupted", "afterToolCount", "roundId", "seq"]) &&
    typeof value.id === "string" && typeof value.content === "string" &&
    optionalField(value, "interrupted", (field) => typeof field === "boolean") && validSequenceFields(value);
}

function isAgentRound(value: unknown): boolean {
  return isRecord(value) && hasOnlyKeys(value, ["id", "status", "startedAt", "completedAt"]) &&
    typeof value.id === "string" && ["running", "completed"].includes(value.status as string) &&
    finiteNumber(value.startedAt) && optionalField(value, "completedAt", finiteNumber);
}

function isTaskDelegation(value: unknown): boolean {
  return isRecord(value) && hasOnlyKeys(value, ["invocationId", "taskId", "description", "nickname", "assetFileName", "status", "roundId"]) &&
    typeof value.invocationId === "string" && typeof value.taskId === "string" &&
    typeof value.description === "string" && typeof value.nickname === "string" && typeof value.assetFileName === "string" &&
    ["running", "completed", "failed", "cancelled"].includes(value.status as string) &&
    optionalField(value, "roundId", (field) => typeof field === "string");
}

function isToolExecution(value: unknown): boolean {
  return isRecord(value) && hasOnlyKeys(value, ["id", "name", "displayName", "status", "result", "argsText", "roundId", "changes", "seq"]) &&
    typeof value.id === "string" && typeof value.name === "string" &&
    ["running", "success", "error"].includes(value.status as string) &&
    optionalField(value, "displayName", (field) => typeof field === "string") &&
    optionalField(value, "result", (field) => typeof field === "string") &&
    optionalField(value, "argsText", (field) => typeof field === "string") &&
    optionalField(value, "roundId", (field) => typeof field === "string") &&
    optionalField(value, "changes", (field) => Array.isArray(field) && field.every(isToolFileChange)) &&
    optionalField(value, "seq", (field) => typeof field === "number" && Number.isInteger(field));
}

function isToolFileChange(value: unknown): boolean {
  return isRecord(value) && hasOnlyKeys(value, ["file", "kind", "insertions", "deletions", "diff", "truncated"]) &&
    typeof value.file === "string" && ["added", "modified", "deleted", "renamed"].includes(value.kind as string) &&
    Number.isInteger(value.insertions) && Number.isInteger(value.deletions) &&
    optionalField(value, "truncated", (field) => typeof field === "boolean") &&
    optionalField(value, "diff", (field) => Array.isArray(field) && field.every(isToolDiffLine));
}

function isToolDiffLine(value: unknown): boolean {
  return isRecord(value) && hasOnlyKeys(value, ["type", "text"]) &&
    ["context", "add", "remove", "hunk"].includes(value.type as string) && typeof value.text === "string";
}

function isContextUsageShape(value: unknown): boolean {
  if (!isRecord(value) || !hasOnlyKeys(value, ["phase", "runId", "round", "contextWindowTokens", "totalTokens", "categories", "messageCount", "updatedAt"])) return false;
  return optionalField(value, "runId", (field) => typeof field === "string") &&
    optionalField(value, "round", (field) => typeof field === "number" && Number.isInteger(field)) &&
    Array.isArray(value.categories) && value.categories.every((category) => isRecord(category) &&
      hasOnlyKeys(category, ["key", "tokens"]));
}

function isRunSnapshot(value: unknown): boolean {
  return isRecord(value) && hasOnlyKeys(value, ["runId", "status", "terminalStatus", "todos", "updatedAt"]) &&
    ["running", "waiting_user", "interrupted", "terminal"].includes(value.status as string) &&
    finiteNumber(value.updatedAt) && optionalField(value, "runId", (field) => typeof field === "string") &&
    optionalField(value, "terminalStatus", (field) => ["success", "cancelled", "timeout", "runtime_error"].includes(field as string)) &&
    optionalField(value, "todos", (field) => Array.isArray(field) && field.every((todo) => isRecord(todo) && typeof todo.id === "string" &&
      hasOnlyKeys(todo, ["id", "content", "status", "priority"]) && typeof todo.content === "string" &&
      ["pending", "in_progress", "completed"].includes(todo.status as string) &&
      optionalField(todo, "priority", (priority) => ["high", "medium", "low"].includes(priority as string))));
}

function isMusicCard(value: Record<string, unknown>): boolean {
  if (!hasOnlyKeys(value, ["setId", "source", "tracks"]) || typeof value.setId !== "string" || !value.setId || !["daily_recommendation", "search"].includes(value.source as string) || !Array.isArray(value.tracks)) return false;
  return value.tracks.length > 0 && value.tracks.length <= 5 && value.tracks.every((track) => isRecord(track) && typeof track.id === "string" &&
    hasOnlyKeys(track, ["id", "name", "artists", "album", "coverUrl"]) && typeof track.name === "string" && Array.isArray(track.artists) && track.artists.every((artist) => typeof artist === "string") &&
    optionalField(track, "album", (album) => typeof album === "string") && optionalField(track, "coverUrl", (coverUrl) => typeof coverUrl === "string"));
}

export type TranscriptCompactionCheckpointPayload = {
  baseThroughSeq: number;
  sourceThroughSeq: number;
  sourceDigest: string;
  replacement: CanonicalChatMessage;
  trigger: "automatic" | "manual";
};

export type TranscriptArchiveRef = {
  fromSeq: number;
  throughSeq: number;
  file: string;
  sha256: string;
};

export type TranscriptEntry =
  | (TranscriptEnvelopeBase & { kind: "user"; payload: TranscriptUserPayload })
  | (TranscriptEnvelopeBase & { kind: "assistant"; payload: CanonicalChatMessage })
  | (TranscriptEnvelopeBase & {
      kind: "tool_result";
      payload: {
        assistantEntryId: string;
        toolCallId: string;
        outcome: ToolCallOutcome;
        message: CanonicalChatMessage;
        fullRef?: string;
      };
    })
  | (TranscriptEnvelopeBase & {
      kind: "interruption";
      payload: { reason: "user_cancel" | "runtime_error" };
    })
  | (TranscriptEnvelopeBase & {
      kind: "turn_rewind";
      payload: {
        anchorUserTurnId: string;
        disposition: "keep_user" | "replace_user";
        reason: "edit" | "regenerate";
        replacementUser?: TranscriptUserPayload;
      };
    })
  | (TranscriptEnvelopeBase & { kind: "backfill_boundary"; payload: { note: string } })
  | (TranscriptEnvelopeBase & {
      kind: "compaction_checkpoint";
      payload: TranscriptCompactionCheckpointPayload;
    })
  | (TranscriptEnvelopeBase & { kind: "presentation_patch"; payload: {
      messageId: string; patchRevision: number; mutationKey?: string; patch: TranscriptPresentationPatch;
    }})
  | (TranscriptEnvelopeBase & { kind: "turn_tombstone"; payload: {
      targetUserTurnId: string; reason: "pending_withdrawn";
    }})
  | (TranscriptEnvelopeBase & { kind: "delivery_receipt"; payload: {
      assistantTurnId: string; channel: ChatMessageChannel;
      status: "delivered" | "failed"; errorCode?: string; revision?: number;
    }});

/** Omit 不分发联合，这里手动分发以保留 kind 判别信息。 */
type DistributiveOmit<T, K extends keyof any> = T extends unknown ? Omit<T, K> : never;

/** 追加输入：不带 seq（由 store 在会话写队列内分配）。 */
export type TranscriptAppendInput = DistributiveOmit<TranscriptEntry, "seq">;

export interface TranscriptSnapshot {
  schemaVersion: 1;
  /** 快照覆盖进度：重放只取 seq > throughSeq 的 JSONL 增量。 */
  throughSeq: number;
  entries: TranscriptEntry[];
  /** 幂等索引：快照恢复后旧 entryId 重试仍可被识别。 */
  seenEntryIds: string[];
  seenUserRevisions: string[];
}

export interface TranscriptSnapshotV2 {
  schemaVersion: 2;
  throughSeq: number;
  entries: TranscriptEntry[];
  projection: { throughSeq: number; messages: UiChatMessage[] };
  /** Digest binding the projection cache to the canonical UI state. */
  projectionDigest?: string;
  archives: TranscriptArchiveRef[];
  seenEntryIds: string[];
  seenUserRevisions: string[];
}

/** user 条目次级幂等键：(turnId, revision)。 */
export function userRevisionKey(turnId: string, revision: number): string {
  return `${turnId}\u0000${revision}`;
}

/** 追加前协议校验（fail-closed：非法草稿直接拒绝，不入队）。 */
export function assertValidTranscriptDraft(input: TranscriptAppendInput): void {
  if (!input.id || input.id.includes("\n")) throw new Error("TRANSCRIPT_INVALID_ENTRY_ID");
  if (input.kind === "user" && (!input.turnId || !input.revision || input.revision < 1)) {
    throw new Error("TRANSCRIPT_INVALID_USER_REVISION");
  }
  if (
    input.kind === "turn_rewind" &&
    input.payload.disposition === "replace_user" &&
    (!input.payload.replacementUser || !input.turnId || !input.revision)
  ) {
    throw new Error("TRANSCRIPT_REPLACEMENT_REQUIRED");
  }
}
