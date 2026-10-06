import path from "node:path";
import { assertValidPresentationPatch, userRevisionKey, type TranscriptEntry, type TranscriptSnapshotV2 } from "./conversation-transcript-types";
import type { ChatMessage as CanonicalChatMessage } from "./vendors/types";
export function validateLoadedTranscriptEntry(entry: unknown): asserts entry is TranscriptEntry {
  if (!entry || typeof entry !== "object")
    throw new Error("TRANSCRIPT_CORRUPT_ROW");
  const candidate = entry as Partial<TranscriptEntry>;
  const kinds = new Set([
    "user", "assistant", "tool_result", "interruption", "turn_rewind",
    "tool_started", "task_state", "effect_resolution",
    "backfill_boundary", "compaction_checkpoint", "presentation_patch",
    "turn_tombstone", "delivery_receipt",
  ]);
  if (typeof candidate.id !== "string" ||
    candidate.id.length === 0 ||
    candidate.id.includes("\n") ||
    typeof candidate.seq !== "number" ||
    !Number.isFinite(candidate.seq) ||
    !Number.isInteger(candidate.seq) ||
    candidate.seq < 1 ||
    typeof candidate.at !== "number" ||
    !Number.isFinite(candidate.at) ||
    !kinds.has(candidate.kind as string) ||
    (candidate.runId !== undefined && typeof candidate.runId !== "string") ||
    (candidate.turnId !== undefined && typeof candidate.turnId !== "string") ||
    (candidate.revision !== undefined && (!Number.isInteger(candidate.revision) || candidate.revision < 1)) ||
    (candidate.roundId !== undefined && typeof candidate.roundId !== "string") ||
    !isValidTranscriptPayload(candidate))
    throw new Error("TRANSCRIPT_CORRUPT_ROW");
}
export function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
function isValidTranscriptTodoItem(value: unknown): boolean {
  return isRecord(value) && typeof value.id === "string" && typeof value.content === "string" &&
    ["pending", "in_progress", "completed", "cancelled"].includes(value.status as string) &&
    (value.activeForm === undefined || typeof value.activeForm === "string");
}
function isValidTranscriptPayload(entry: Partial<TranscriptEntry>): boolean {
  if (!isRecord(entry.payload))
    return false;
  switch (entry.kind) {
    case "user":
      return typeof entry.turnId === "string" && entry.turnId.length > 0 &&
        Number.isInteger(entry.revision) && (entry.revision ?? 0) >= 1 &&
        typeof entry.payload.text === "string" &&
        (entry.payload.attachments === undefined || Array.isArray(entry.payload.attachments));
    case "assistant":
      return isValidCanonicalChatMessage(entry.payload, "assistant");
    case "tool_result":
      return typeof entry.payload.assistantEntryId === "string" &&
        typeof entry.payload.toolCallId === "string" &&
        ["success", "failure", "unknown", "not_executed"].includes(entry.payload.outcome as string) &&
        isValidCanonicalChatMessage(entry.payload.message, "tool") &&
        (entry.payload.fullRef === undefined || typeof entry.payload.fullRef === "string");
    case "tool_started":
      return typeof entry.payload.assistantEntryId === "string" && entry.payload.assistantEntryId.length > 0 &&
        typeof entry.payload.toolCallId === "string" && entry.payload.toolCallId.length > 0 &&
        typeof entry.payload.toolName === "string" && entry.payload.toolName.length > 0 &&
        ["read_only", "idempotent_mutation", "non_idempotent_side_effect"].includes(entry.payload.sideEffect as string) &&
        typeof entry.payload.fingerprint === "string" && entry.payload.fingerprint.length > 0 &&
        (entry.payload.repeatAuthorizationId === undefined ||
          (typeof entry.payload.repeatAuthorizationId === "string" && entry.payload.repeatAuthorizationId.length > 0));
    case "task_state":
      return typeof entry.payload.assistantEntryId === "string" && entry.payload.assistantEntryId.length > 0 &&
        typeof entry.payload.toolCallId === "string" && entry.payload.toolCallId.length > 0 &&
        Array.isArray(entry.payload.items) && entry.payload.items.every(isValidTranscriptTodoItem);
    case "effect_resolution":
      return typeof entry.payload.assistantEntryId === "string" && entry.payload.assistantEntryId.length > 0 &&
        typeof entry.payload.effectId === "string" && entry.payload.effectId.length > 0 &&
        entry.payload.action === "repeat_authorized" &&
        typeof entry.payload.authorizationId === "string" && entry.payload.authorizationId.length > 0 &&
        typeof entry.payload.fingerprint === "string" && entry.payload.fingerprint.length > 0 &&
        validOptionalNumber(entry.payload.grantedAt) && entry.payload.grantedAt !== undefined;
    case "interruption":
      return ["user_cancel", "runtime_error", "crashed"].includes(entry.payload.reason);
    case "turn_rewind":
      return typeof entry.payload.anchorUserTurnId === "string" &&
        ["keep_user", "replace_user"].includes(entry.payload.disposition as string) &&
        ["edit", "regenerate"].includes(entry.payload.reason as string) &&
        (entry.payload.disposition !== "replace_user" || (typeof entry.turnId === "string" && entry.turnId.length > 0 &&
          Number.isInteger(entry.revision) && (entry.revision ?? 0) >= 1)) &&
        (entry.payload.replacementUser === undefined || (isRecord(entry.payload.replacementUser) &&
          typeof entry.payload.replacementUser.text === "string")) &&
        (entry.payload.disposition !== "replace_user" || !!entry.payload.replacementUser);
    case "backfill_boundary":
      return typeof entry.payload.note === "string";
    case "compaction_checkpoint":
      return Number.isInteger(entry.payload.baseThroughSeq) && entry.payload.baseThroughSeq >= 0 &&
        Number.isInteger(entry.payload.sourceThroughSeq) && entry.payload.sourceThroughSeq >= 0 &&
        typeof entry.payload.sourceDigest === "string" &&
        isValidCanonicalChatMessage(entry.payload.replacement) &&
        ["automatic", "manual"].includes(entry.payload.trigger as string);
    case "presentation_patch":
      return typeof entry.payload.messageId === "string" &&
        Number.isInteger(entry.payload.patchRevision) && entry.payload.patchRevision >= 1 &&
        (entry.payload.mutationKey === undefined || (typeof entry.payload.mutationKey === "string" && entry.payload.mutationKey.length > 0)) &&
        isValidPresentationPatch(entry.payload.patch);
    case "turn_tombstone":
      return typeof entry.payload.targetUserTurnId === "string" && entry.payload.reason === "pending_withdrawn";
    case "delivery_receipt":
      return typeof entry.payload.assistantTurnId === "string" &&
        ["wechat", "feishu", "qq", "qqbot"].includes(entry.payload.channel as string) &&
        ["delivered", "failed"].includes(entry.payload.status as string) &&
        (entry.payload.errorCode === undefined || typeof entry.payload.errorCode === "string") &&
        (entry.payload.revision === undefined || (Number.isInteger(entry.payload.revision) && entry.payload.revision >= 1));
    default:
      return false;
  }
}
export function snapshotEntriesAreConsistent(entries: TranscriptEntry[], throughSeq: number, seenEntryIds: string[], seenUserRevisions: string[], allowArchivedPrefix = false): boolean {
  let previousSeq = 0;
  const entryIds: string[] = [];
  const userRevisions: string[] = [];
  for (const entry of entries) {
    validateLoadedTranscriptEntry(entry);
    if (entry.seq <= previousSeq)
      return false;
    if (!allowArchivedPrefix && entry.seq !== entryIds.length + 1)
      return false;
    previousSeq = entry.seq;
    entryIds.push(entry.id);
    if (entry.kind === "user") {
      if (typeof entry.turnId !== "string" || !Number.isInteger(entry.revision)) {
        throw new Error("TRANSCRIPT_CORRUPT_ROW");
      }
      userRevisions.push(userRevisionKey(entry.turnId, entry.revision as number));
    }
  }
  if (entries.length === 0)
    return throughSeq === 0 && seenEntryIds.length === 0 && seenUserRevisions.length === 0;
  if ((!allowArchivedPrefix && previousSeq !== throughSeq) || (allowArchivedPrefix && previousSeq > throughSeq))
    return false;
  if (!allowArchivedPrefix)
    return sameStringSet(entryIds, seenEntryIds) && sameStringSet(userRevisions, seenUserRevisions);
  const seenIds = new Set(seenEntryIds);
  const seenRevisions = new Set(seenUserRevisions);
  return new Set(entryIds).size === entryIds.length &&
    new Set(userRevisions).size === userRevisions.length &&
    entryIds.every((id) => seenIds.has(id)) &&
    userRevisions.every((key) => seenRevisions.has(key));
}
function sameStringSet(left: string[], right: string[]): boolean {
  if (left.length !== right.length || new Set(left).size !== left.length || new Set(right).size !== right.length) {
    return false;
  }
  const rightSet = new Set(right);
  return left.every((value) => rightSet.has(value));
}
function isValidPresentationPatch(value: unknown): boolean {
  try {
    assertValidPresentationPatch(value);
    return true;
  }
  catch {
    return false;
  }
}
function validOptionalNumber(value: unknown): boolean {
  return value === undefined || (typeof value === "number" && Number.isFinite(value));
}
function isValidCanonicalChatMessage(value: unknown, expectedRole?: CanonicalChatMessage["role"]): value is CanonicalChatMessage {
  if (!isRecord(value) || typeof value.role !== "string" || !["system", "user", "assistant", "tool"].includes(value.role)) {
    return false;
  }
  if (expectedRole && value.role !== expectedRole)
    return false;
  if (value.content !== undefined && !isValidChatMessageContent(value.content))
    return false;
  if (value.toolCalls !== undefined && (!Array.isArray(value.toolCalls) || !value.toolCalls.every((call) => (isRecord(call) && typeof call.id === "string" && typeof call.name === "string" && typeof call.arguments === "string"))))
    return false;
  if (value.toolCallId !== undefined && typeof value.toolCallId !== "string")
    return false;
  if (value.name !== undefined && typeof value.name !== "string")
    return false;
  if (value.thinking !== undefined && typeof value.thinking !== "string")
    return false;
  if (value.attachments !== undefined && (value.role !== "assistant" || !Array.isArray(value.attachments) || !value.attachments.every(isValidGeneratedImageAttachment)))
    return false;
  if (value.visibility !== undefined && !["user", "internal"].includes(value.visibility as string))
    return false;
  return true;
}
function isValidGeneratedImageAttachment(value: unknown): boolean {
  if (!isRecord(value))
    return false;
  const allowed = new Set(["id", "kind", "name", "filePath", "mime", "source", "byteLength", "status"]);
  return Object.keys(value).every((key) => allowed.has(key)) &&
    typeof value.id === "string" && value.id.length > 0 && value.id.length <= 256 &&
    value.kind === "image" && typeof value.name === "string" && value.name.length > 0 &&
    typeof value.filePath === "string" && path.isAbsolute(value.filePath) &&
    path.extname(value.filePath).toLowerCase() === ".png" &&
    value.mime === "image/png" && value.source === "model" &&
    typeof value.byteLength === "number" && Number.isSafeInteger(value.byteLength) &&
    value.byteLength >= 8 && value.byteLength <= 20 * 1024 * 1024 && value.status === "done";
}
function isValidChatMessageContent(value: unknown): boolean {
  if (typeof value === "string")
    return true;
  return Array.isArray(value) && value.every((block) => {
    if (!isRecord(block) || typeof block.type !== "string")
      return false;
    if (block.type === "text")
      return typeof block.text === "string";
    return block.type === "image_url" && isRecord(block.image_url) && typeof block.image_url.url === "string";
  });
}
