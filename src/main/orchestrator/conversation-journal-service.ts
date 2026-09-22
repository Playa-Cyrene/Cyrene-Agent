/**
 * The single business-level entrypoint for conversation facts.
 *
 * This service intentionally composes the canonical store, pure projection
 * reducers, and the existing run sink. It does not create a second transcript
 * format or duplicate run lifecycle writes.
 */

import { createHash } from "node:crypto";
import type { PendingChatAttachment } from "../../shared/chat-types";
import type { ChatMessageChannel } from "../../shared/chat-types";
import {
  buildModelContextFromCompactedView,
  isUserTurnRewindableInModelView,
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
import { assertValidPresentationPatch } from "./conversation-transcript-types";
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

export interface ChannelTurnState {
  userEntry: TranscriptEntry;
  assistantEntry?: Extract<TranscriptEntry, { kind: "assistant" }>;
  latestReceipt?: Extract<TranscriptEntry, { kind: "delivery_receipt" }>;
}

export interface JournalRewindInput {
  anchorUserTurnId: string;
  disposition: "keep_user" | "replace_user";
  runId: string;
  at?: number;
  replacementUser?: JournalUserInput;
}

export interface CreateRunSinkInput {
  conversationId: string;
  runId: string;
  assistantTurnId?: string;
}

export interface ProjectionPage {
  messages: ConversationProjection["messages"];
  messageCount: number;
  hasMore: boolean;
  nextBefore: number | null;
}

export interface ConversationJournalServiceOptions {
  runReader?: TranscriptRunReader;
  pendingStore?: ConversationPendingWithdrawalStore;
}

type PendingWithdrawalOperationResult =
  | { ok: true; withdrawalId: string }
  | { ok: false; error: "session-not-found" | "not-found" | "already-adjusting" | "withdrawal-in-progress" | "write-failed" };

type PendingWithdrawalCommitResult =
  | { ok: true; removed: boolean }
  | { ok: false; error: "session-not-found" | "not-found" | "already-adjusting" | "withdrawal-in-progress" | "write-failed" };

export interface ConversationPendingWithdrawalRecord {
  sessionId: string;
  messageId: string;
  withdrawalId: string;
}

/** chats-store 的窄接口：协调器只复用既有原子 metadata 读写，不创建第二套存储。 */
export interface ConversationPendingWithdrawalStore {
  beginPendingWithdrawal(sessionId: string, messageId: string): PendingWithdrawalOperationResult | Promise<PendingWithdrawalOperationResult>;
  commitPendingWithdrawal(sessionId: string, messageId: string, withdrawalId: string): PendingWithdrawalCommitResult | Promise<PendingWithdrawalCommitResult>;
  listPendingWithdrawals(): ConversationPendingWithdrawalRecord[] | Promise<ConversationPendingWithdrawalRecord[]>;
}

interface ConversationJournalServiceInput {
  store: ConversationTranscriptStore;
  runReader?: TranscriptRunReader;
  pendingStore?: ConversationPendingWithdrawalStore;
}

export class ConversationJournalService {
  private readonly store: ConversationTranscriptStore;
  private readonly runReader: TranscriptRunReader;
  private readonly pendingStore?: ConversationPendingWithdrawalStore;
  private readonly withdrawalLocks = new Map<string, Promise<PendingWithdrawalCommitResult>>();
  private crashAfterTombstone = false;

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
    this.pendingStore = options.pendingStore
      ?? (storeOrInput instanceof ConversationTranscriptStore ? undefined : storeOrInput.pendingStore);
  }

  /** 测试与故障演练入口：模拟墓碑成功后、pending 提交前的进程退出。 */
  failAfterTombstoneOnce(): void {
    this.crashAfterTombstone = true;
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
    assertValidPresentationPatch(patch);
    const entry = await this.store.append(conversationId, {
      kind: "presentation_patch",
      id: `presentation:${messageId}:r${patchRevision}`,
      at: Date.now(),
      payload: { messageId, patchRevision, patch },
    });
    await this.refreshProjection(conversationId);
    return entry;
  }

  async appendPresentationNext(
    conversationId: string,
    messageId: string,
    mutationKey: string,
    patch: TranscriptPresentationPatch,
  ): Promise<TranscriptEntry> {
    const entry = await this.store.appendPresentationNext(conversationId, messageId, mutationKey, patch);
    await this.refreshProjection(conversationId);
    return entry;
  }

  /** 以单行 turn_rewind 原子提交 regenerate/edit，避免产生第二个 active user。 */
  async appendRewind(conversationId: string, input: JournalRewindInput): Promise<TranscriptEntry> {
    const snapshot = await this.store.read(conversationId);
    const entryId = `${input.runId}:rewind:${input.anchorUserTurnId}`;
    const existing = snapshot.entries.find((entry) => entry.id === entryId);
    if (existing) return existing;
    const projection = await this.readProjection(conversationId);
    const activeUser = projection.state?.nodes.some((node) => (
      node.kind === "user" && node.turnId === input.anchorUserTurnId
    )) === true;
    if (!activeUser) throw new Error("TRANSCRIPT_REWIND_ANCHOR_NOT_FOUND");
    // 锚点必须位于模型活动分支的压缩边界之后：已归档进压缩前缀的 user 不能被
    // 编辑/重新生成改写，否则 UI 截断旧尾部而模型视图仍保留摘要与旧回答。
    if (!isUserTurnRewindableInModelView(snapshot.entries, input.anchorUserTurnId)) {
      throw new Error("TRANSCRIPT_REWIND_ACROSS_COMPACTION");
    }
    const revision = input.disposition === "replace_user"
      ? snapshot.entries
        .filter((entry) => entry.turnId === input.anchorUserTurnId && typeof entry.revision === "number")
        .reduce((max, entry) => Math.max(max, entry.revision ?? 0), 0) + 1
      : undefined;
    const entry = await this.store.append(conversationId, {
      id: entryId,
      at: input.at ?? Date.now(),
      kind: "turn_rewind",
      runId: input.runId,
      turnId: input.anchorUserTurnId,
      ...(revision !== undefined ? { revision } : {}),
      payload: {
        anchorUserTurnId: input.anchorUserTurnId,
        disposition: input.disposition,
        reason: input.disposition === "replace_user" ? "edit" : "regenerate",
        ...(input.disposition === "replace_user" && input.replacementUser ? {
          replacementUser: {
            text: input.replacementUser.text,
            ...(input.replacementUser.attachments?.length ? { attachments: input.replacementUser.attachments } : {}),
          },
        } : {}),
      },
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

  /**
   * 可恢复的 pending 撤回三步协议：原子 begin → journal 墓碑 → 原子 commit。
   * begin/commit 与 journal 均按稳定 ID 幂等；墓碑失败时保留 withdrawing，供重启对账。
   */
  async withdrawPendingMessage(
    sessionId: string,
    messageId: string,
  ): Promise<PendingWithdrawalCommitResult> {
    if (!this.pendingStore) throw new Error("PENDING_WITHDRAWAL_STORE_UNAVAILABLE");
    const key = `${sessionId}\u0000${messageId}`;
    const previous = this.withdrawalLocks.get(key);
    if (previous) return previous;
    const operation = this.performPendingWithdrawal(sessionId, messageId);
    this.withdrawalLocks.set(key, operation);
    return operation.finally(() => {
      if (this.withdrawalLocks.get(key) === operation) this.withdrawalLocks.delete(key);
    });
  }

  private async performPendingWithdrawal(
    sessionId: string,
    messageId: string,
  ): Promise<PendingWithdrawalCommitResult> {
    const pendingStore = this.pendingStore;
    if (!pendingStore) throw new Error("PENDING_WITHDRAWAL_STORE_UNAVAILABLE");
    const begun = await pendingStore.beginPendingWithdrawal(sessionId, messageId);
    // 条目已被认领/删除时，撤回请求本身仍是幂等成功；不存在的会话仍需报错。
    if (!begun.ok && begun.error === "not-found") return { ok: true, removed: false };
    if (!begun.ok) return begun;
    try {
      await this.withdrawUserTurn(sessionId, messageId);
    } catch (error) {
      console.error("[ConversationJournalService] pending withdrawal journal write failed", {
        sessionId,
        messageId,
        withdrawalId: begun.withdrawalId,
        error,
      });
      return { ok: false, error: "write-failed" };
    }
    if (this.crashAfterTombstone) {
      this.crashAfterTombstone = false;
      throw new Error("TEST_CRASH");
    }
    return pendingStore.commitPendingWithdrawal(sessionId, messageId, begun.withdrawalId);
  }

  /** 启动对账按会话/队列稳定顺序续做；单条 journal 失败保留 pending 并继续其它条目。 */
  async reconcilePendingWithdrawals(): Promise<void> {
    if (!this.pendingStore || typeof this.pendingStore.listPendingWithdrawals !== "function") return;
    const records = await this.pendingStore.listPendingWithdrawals();
    for (const record of records) {
      try {
        await this.withdrawPendingMessage(record.sessionId, record.messageId);
      } catch (error) {
        console.error("[ConversationJournalService] pending withdrawal reconciliation failed", {
          sessionId: record.sessionId,
          messageId: record.messageId,
          withdrawalId: record.withdrawalId,
          error,
        });
      }
    }
  }

  async readProjection(conversationId: string): Promise<ConversationProjection> {
    const snapshot = await this.store.read(conversationId);
    const seeded = isProjectionSeedUsable(snapshot);
    if (seeded) {
      // After archival the hot snapshot may lag behind the active generation;
      // apply only its suffix and keep the full UI history in the projection.
      const rebuilt = reduceTranscriptProjection(snapshot.entries, snapshot.projection);
      if (rebuilt.throughSeq === snapshot.throughSeq) return rebuilt;
      await this.store.checkpoint(conversationId, rebuilt);
      return rebuilt;
    }
    const auditEntries = snapshot.archives.length > 0
      ? await this.store.readAuditEntries(conversationId)
      : snapshot.entries;
    const rebuilt = reduceTranscriptProjection(auditEntries);
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
    const hasMore = start > 0;
    return {
      messages: projection.messages.slice(start, end),
      messageCount: projection.messages.length,
      hasMore,
      nextBefore: hasMore ? start : null,
    };
  }

  async buildModelContext(conversationId: string): Promise<MaterializedTranscript> {
    const snapshot = await this.store.read(conversationId);
    return buildModelContextFromCompactedView(snapshot.entries, this.runReader);
  }

  /**
   * Read the durable state for one channel turn. This intentionally stays
   * narrow: replay protection is derived from canonical journal order rather
   * than an in-memory seen set or a second persistence protocol.
   */
  async getChannelTurnState(
    conversationId: string,
    input: { userTurnId: string; assistantTurnId: string },
  ): Promise<ChannelTurnState | null> {
    const snapshot = await this.store.read(conversationId);
    const userEntry = snapshot.entries.find(
      (entry) => entry.kind === "user" && entry.turnId === input.userTurnId,
    );
    if (!userEntry) return null;
    const assistantEntry = snapshot.entries.find(
      (entry): entry is Extract<TranscriptEntry, { kind: "assistant" }> =>
        entry.kind === "assistant" && entry.turnId === input.assistantTurnId && entry.seq > userEntry.seq,
    );
    if (!assistantEntry) return { userEntry };
    const receipts = snapshot.entries.filter(
      (entry): entry is Extract<TranscriptEntry, { kind: "delivery_receipt" }> =>
        entry.kind === "delivery_receipt" && entry.payload.assistantTurnId === input.assistantTurnId && entry.seq > assistantEntry.seq,
    );
    const latestReceipt = receipts.reduce<Extract<TranscriptEntry, { kind: "delivery_receipt" }> | undefined>(
      (latest, entry) => {
        if (!latest) return entry;
        const revision = entry.payload.revision ?? entry.revision ?? 0;
        const latestRevision = latest.payload.revision ?? latest.revision ?? 0;
        return revision > latestRevision || (revision === latestRevision && entry.seq > latest.seq)
          ? entry
          : latest;
      },
      undefined,
    );
    return { userEntry, assistantEntry, ...(latestReceipt ? { latestReceipt } : {}) };
  }

  /** 记录外部渠道送达结果；失败回执只由模型投影合成为内部提示。 */
  async appendDeliveryReceipt(
    conversationId: string,
    input: {
      assistantTurnId: string;
      channel: ChatMessageChannel;
      status: "delivered" | "failed";
      errorCode?: string;
      runId?: string;
      at?: number;
      revision?: number;
    },
  ): Promise<TranscriptEntry> {
    const revision = input.revision ?? (input.errorCode === "DELIVERY_UNCONFIRMED" ? 1 : 2);
    return this.store.append(conversationId, {
      kind: "delivery_receipt",
      id: `delivery:${input.assistantTurnId}:${input.channel}:r${revision}`,
      at: input.at ?? Date.now(),
      ...(input.runId ? { runId: input.runId } : {}),
      turnId: input.assistantTurnId,
      revision,
      payload: {
        assistantTurnId: input.assistantTurnId,
        channel: input.channel,
        status: input.status,
        revision,
        ...(input.errorCode ? { errorCode: input.errorCode } : {}),
      },
    });
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
    const seeded = isProjectionSeedUsable(snapshot) ? snapshot.projection : undefined;
    const projection = seeded
      ? reduceTranscriptProjection(snapshot.entries, seeded)
      : reduceTranscriptProjection(
        snapshot.archives.length > 0 ? await this.store.readAuditEntries(conversationId) : snapshot.entries,
      );
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

function isProjectionSeedUsable(snapshot: TranscriptSnapshotV2): boolean {
  const projection = snapshot.projection;
  if (!isUsableProjection(projection, projection.throughSeq)) return false;
  const archivedThrough = snapshot.archives.reduce(
    (max, archive) => Math.max(max, archive.throughSeq), 0,
  );
  if (snapshot.archives.length > 0 &&
    (!snapshot.projectionDigest || digestProjection(projection) !== snapshot.projectionDigest)) return false;
  if (projection.throughSeq < archivedThrough || projection.throughSeq > snapshot.throughSeq) return false;
  const messageIds = new Set(projection.messages.map((message) => message.id));
  return projection.state?.nodes.every((node) => messageIds.has(node.messageId)) ?? projection.messages.length === 0;
}

function digestProjection(projection: ConversationProjection): string {
  return createHash("sha256").update(JSON.stringify(projection), "utf8").digest("hex");
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
