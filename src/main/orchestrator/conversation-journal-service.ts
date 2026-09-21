/**
 * The single business-level entrypoint for conversation facts.
 *
 * This service intentionally composes the canonical store, pure projection
 * reducers, and the existing run sink. It does not create a second transcript
 * format or duplicate run lifecycle writes.
 */

import type { PendingChatAttachment } from "../../shared/chat-types";
import {
  buildModelContextFromCompactedView,
  reduceTranscriptProjection,
  type ConversationProjection,
  type MaterializedTranscript,
  type TranscriptRunReader,
} from "./conversation-transcript-projection";
import {
  ConversationTranscriptStore,
} from "./conversation-transcript-store";
import type {
  TranscriptEntry,
  TranscriptPresentationPatch,
  TranscriptSnapshotV2,
} from "./conversation-transcript-types";
import { createTranscriptSink, type TranscriptSink } from "./transcript-sink";

export interface JournalUserInput {
  turnId: string;
  text: string;
  id?: string;
  revision?: number;
  at?: number;
  runId?: string;
  attachments?: PendingChatAttachment[];
}

export interface CreateRunSinkInput {
  conversationId: string;
  runId: string;
  assistantTurnId?: string;
}

export interface ProjectionPage {
  messages: ConversationProjection["messages"];
  hasMore: boolean;
}

export interface ConversationJournalServiceOptions {
  runReader?: TranscriptRunReader;
}

interface ConversationJournalServiceInput {
  store: ConversationTranscriptStore;
  runReader?: TranscriptRunReader;
}

export class ConversationJournalService {
  private readonly store: ConversationTranscriptStore;
  private readonly runReader: TranscriptRunReader;

  constructor(
    storeOrInput: ConversationTranscriptStore | ConversationJournalServiceInput,
    options: ConversationJournalServiceOptions = {},
  ) {
    this.store = storeOrInput instanceof ConversationTranscriptStore
      ? storeOrInput
      : storeOrInput.store;
    this.runReader = options.runReader
      ?? (storeOrInput instanceof ConversationTranscriptStore ? undefined : storeOrInput.runReader)
      ?? { get: () => null };
  }

  async appendUser(conversationId: string, input: JournalUserInput): Promise<TranscriptEntry> {
    const revision = input.revision ?? 1;
    const entry = await this.store.append(conversationId, {
      kind: "user",
      id: input.id ?? `user:${input.turnId}:r${revision}`,
      at: input.at ?? Date.now(),
      turnId: input.turnId,
      revision,
      ...(input.runId ? { runId: input.runId } : {}),
      payload: {
        text: input.text,
        ...(input.attachments?.length ? { attachments: input.attachments } : {}),
      },
    });
    await this.refreshProjection(conversationId);
    return entry;
  }

  async appendPresentation(
    conversationId: string,
    messageId: string,
    patchRevision: number,
    patch: TranscriptPresentationPatch,
  ): Promise<TranscriptEntry> {
    if (!messageId || !Number.isInteger(patchRevision) || patchRevision < 1) {
      throw new Error("TRANSCRIPT_INVALID_PRESENTATION_PATCH");
    }
    const entry = await this.store.append(conversationId, {
      kind: "presentation_patch",
      id: `presentation:${messageId}:r${patchRevision}`,
      at: Date.now(),
      payload: { messageId, patchRevision, patch },
    });
    await this.refreshProjection(conversationId);
    return entry;
  }

  createRunSink(input: CreateRunSinkInput): TranscriptSink {
    return createTranscriptSink({ store: this.store, ...input });
  }

  async withdrawUserTurn(conversationId: string, userTurnId: string): Promise<"written" | "absent"> {
    const projection = await this.readProjection(conversationId);
    const activeUser = projection.state?.nodes.some(
      (node) => node.kind === "user" && node.turnId === userTurnId,
    );
    if (!activeUser) return "absent";

    await this.store.append(conversationId, {
      kind: "turn_tombstone",
      id: `withdraw:${userTurnId}`,
      at: Date.now(),
      payload: { targetUserTurnId: userTurnId, reason: "pending_withdrawn" },
    });
    await this.refreshProjection(conversationId);
    return "written";
  }

  async readProjection(conversationId: string): Promise<ConversationProjection> {
    const snapshot = await this.store.read(conversationId);
    if (isUsableProjection(snapshot.projection, snapshot.throughSeq)) {
      return snapshot.projection;
    }
    const rebuilt = reduceTranscriptProjection(snapshot.entries);
    await this.store.checkpoint(conversationId, rebuilt);
    return rebuilt;
  }

  async readProjectionPage(
    conversationId: string,
    before: number | null,
    limit: number,
  ): Promise<ProjectionPage> {
    const projection = await this.readProjection(conversationId);
    const end = Math.max(0, Math.min(before ?? projection.messages.length, projection.messages.length));
    const safeLimit = Math.max(1, Math.min(Math.floor(limit) || 1, 200));
    const start = Math.max(0, end - safeLimit);
    return { messages: projection.messages.slice(start, end), hasMore: start > 0 };
  }

  async buildModelContext(conversationId: string): Promise<MaterializedTranscript> {
    const snapshot = await this.store.read(conversationId);
    return buildModelContextFromCompactedView(snapshot.entries, this.runReader);
  }

  async checkpoint(conversationId: string): Promise<TranscriptSnapshotV2> {
    const snapshot = await this.store.read(conversationId);
    const projection = isUsableProjection(snapshot.projection, snapshot.throughSeq)
      ? snapshot.projection
      : reduceTranscriptProjection(snapshot.entries);
    return this.store.checkpoint(conversationId, projection);
  }

  deleteConversation(conversationId: string): Promise<void> {
    return this.store.deleteConversation(conversationId);
  }

  private async refreshProjection(conversationId: string): Promise<ConversationProjection> {
    const snapshot = await this.store.read(conversationId);
    const projection = reduceTranscriptProjection(snapshot.entries);
    await this.store.checkpoint(conversationId, projection);
    return projection;
  }
}

function isUsableProjection(
  projection: unknown,
  throughSeq: number,
): projection is ConversationProjection {
  if (!projection || typeof projection !== "object") return false;
  const candidate = projection as Partial<ConversationProjection>;
  if (
    typeof candidate.throughSeq !== "number" ||
    !Number.isInteger(candidate.throughSeq) ||
    candidate.throughSeq < 0 ||
    candidate.throughSeq !== throughSeq ||
    !Array.isArray(candidate.messages)
  ) return false;
  if (!candidate.messages.every(isProjectionMessage)) return false;
  // Current snapshots carry reducer state so aliases, pending patches, and
  // branch mutations can be recovered. An empty legacy projection is safe to
  // accept; a non-empty one without state must be rebuilt.
  if (candidate.state === undefined) return candidate.messages.length === 0;
  if (!candidate.state || !Array.isArray(candidate.state.nodes)) return false;
  if (!candidate.state.nodes.every((node) => (
    !!node &&
    (node.kind === "user" || node.kind === "assistant") &&
    typeof node.entryId === "string" &&
    typeof node.messageId === "string"
  ))) return false;
  return candidate.state.patches === undefined || (
    Array.isArray(candidate.state.patches) && candidate.state.patches.every((patch) => (
    !!patch &&
    typeof patch.messageId === "string" &&
    Number.isInteger(patch.patchRevision) &&
    !!patch.patch &&
    typeof patch.patch === "object"
    ))
  );
}

function isProjectionMessage(message: unknown): boolean {
  if (!message || typeof message !== "object") return false;
  const candidate = message as Record<string, unknown>;
  if (
    typeof candidate.id !== "string" ||
    (candidate.role !== "user" && candidate.role !== "model") ||
    typeof candidate.content !== "string" ||
    typeof candidate.at !== "number"
  ) return false;
  if (candidate.sticker !== undefined && candidate.sticker !== null && typeof candidate.sticker !== "string") {
    return false;
  }
  for (const key of [
    "reasoningBlocks", "processMessages", "agentRounds", "taskDelegations", "toolExecutions",
  ]) {
    if (candidate[key] !== undefined && !Array.isArray(candidate[key])) return false;
  }
  for (const key of ["reasoning", "ttsCacheKey", "ttsCacheVersion"]) {
    if (candidate[key] !== undefined && typeof candidate[key] !== "string") return false;
  }
  return true;
}
