/**
 * v1 chats-store 会话到 v2 元数据 + 轨迹的可重入迁移。
 * 迁移只负责业务胶水，文件原子写与轨迹队列继续由现有服务负责。
 */

import * as chatsStore from "../chats/chats-store";
import type {
  ChatMessage,
  ChatSession,
  ChatSessionRecordV2,
} from "../../shared/chat-types";
import { ConversationJournalService } from "./conversation-journal-service";
import { getConversationTranscriptStore, type ConversationTranscriptStore } from "./conversation-transcript-store";
import { buildLegacyBackfillDrafts } from "./conversation-transcript-coordinator";

export interface ConversationSessionMigrationOptions {
  journal: ConversationJournalService;
  store: ConversationTranscriptStore;
  sessionStore?: Pick<typeof chatsStore, "getSessionRecord" | "writeMigratedSession">;
}

type MigrationSessionStore = Pick<typeof chatsStore, "getSessionRecord" | "writeMigratedSession">;

export interface ComposedSessionPage {
  session: Omit<ChatSession, "messages"> & { messageCount: number };
  messages: ChatMessage[];
  hasMore: boolean;
  nextBefore: number | null;
}

export class ConversationSessionMigration {
  private readonly journal: ConversationJournalService;
  private readonly store: ConversationTranscriptStore;
  private readonly sessionStore: MigrationSessionStore;
  private readonly locks = new Map<string, Promise<ChatSessionRecordV2 | null>>();
  private crashAfterCheckpoint = false;
  private checkpointGate: {
    entered: Promise<void>;
    signalEntered: () => void;
    released: Promise<void>;
    release: () => void;
  } | null = null;

  constructor(options: ConversationSessionMigrationOptions) {
    this.journal = options.journal;
    this.store = options.store;
    this.sessionStore = options.sessionStore ?? chatsStore;
  }

  /** 测试用崩溃注入点：checkpoint 成功后、元数据原子写之前抛错。 */
  failAfterCheckpointOnce(): void {
    this.crashAfterCheckpoint = true;
  }

  /** 测试用窗口：在 checkpoint 成功后暂停，允许并发 append/delete。 */
  pauseAfterCheckpoint(): { entered: Promise<void>; release: () => void } {
    let signalEntered!: () => void;
    let release!: () => void;
    const entered = new Promise<void>((resolve) => { signalEntered = resolve; });
    const released = new Promise<void>((resolve) => { release = resolve; });
    this.checkpointGate = { entered, signalEntered, released, release };
    return { entered, release };
  }

  getJournal(): ConversationJournalService {
    return this.journal;
  }

  /** 先迁移/恢复 pending intent，再把 metadata 与同一 journal projection 组合。 */
  async loadComposedSession(sessionId: string): Promise<ChatSession | null> {
    const record = await this.loadCurrentRecord(sessionId);
    if (!record) return null;
    const projection = await this.journal.readProjection(sessionId);
    return chatsStore.composeSession(record, projection.messages);
  }

  /** 与 CHATS_GET_PAGE 共用的分页组合边界，避免返回未组合的 canonical ID。 */
  async loadComposedSessionPage(
    sessionId: string,
    before: number | null,
    limit: number,
  ): Promise<ComposedSessionPage | null> {
    const record = await this.loadCurrentRecord(sessionId);
    if (!record) return null;
    const page = await this.journal.readProjectionPage(sessionId, before, limit);
    const composed = chatsStore.composeSession(record, page.messages);
    const { messages: _messages, ...session } = composed;
    return {
      session: { ...session, messageCount: page.messageCount },
      messages: composed.messages,
      hasMore: page.hasMore,
      nextBefore: page.nextBefore,
    };
  }

  /**
   * v2 claim 的 durable intent 恢复：canonical user 与 presentation patch 都使用
   * 稳定 entry ID，journal 的主键/次级幂等保证重试不产生第二条 user。
   */
  async reconcilePendingDispatch(sessionId: string): Promise<boolean> {
    const record = this.sessionStore.getSessionRecord(sessionId);
    if (!record || record.schemaVersion !== 2) return false;
    const pending = chatsStore.getPendingDispatch(sessionId);
    const snapshot = pending?.userMessage;
    if (!pending || !snapshot) return false;
    if (snapshot.id !== pending.messageId) {
      throw new Error("PENDING_DISPATCH_SNAPSHOT_MISMATCH");
    }
    const canonicalId = `user:v1:${snapshot.id}:r1`;
    await this.journal.appendUser(sessionId, {
      id: canonicalId,
      turnId: snapshot.id,
      at: snapshot.at,
      text: snapshot.text,
      attachments: snapshot.attachments,
      revision: 1,
    });
    if (snapshot.sticker) {
      await this.journal.appendPresentation(sessionId, canonicalId, 1, { sticker: snapshot.sticker });
    }
    return true;
  }

  /**
   * claim 的 async IPC 边界：journal 写成功后才向 renderer 报 claimed。
   * 残留认领（上次认领后 run 从未被主进程接受）：先把快照幂等 reconcile 进
   * 轨迹、清掉残留簿记，再正常认领下一条——绝不再把旧消息当新认领返回，
   * 那等于替用户自动补发；旧消息留在轨迹里，等用户下一条消息再启动新 run。
   */
  async claimPendingMessage(sessionId: string): Promise<chatsStore.ClaimPendingResult> {
    const record = this.sessionStore.getSessionRecord(sessionId);
    const existing = record?.schemaVersion === 2 ? chatsStore.getPendingDispatch(sessionId) : null;
    if (existing?.userMessage) {
      try {
        await this.reconcilePendingDispatch(sessionId);
      } catch {
        return { ok: false, error: "transcript-write-failed" };
      }
      // 残留认领已落轨迹：清簿记（写盘失败时残留保持，下次恢复重试），
      // 随后照常认领队首——排队消息仍是用户既有意图
      chatsStore.completePendingDispatch(sessionId, existing.messageId);
    }

    const claimed = chatsStore.claimPendingMessage(sessionId);
    if (!claimed.ok || !claimed.claimed) return claimed;
    const afterClaim = this.sessionStore.getSessionRecord(sessionId);
    if (afterClaim?.schemaVersion !== 2) return claimed;
    try {
      await this.reconcilePendingDispatch(sessionId);
    } catch {
      return { ok: false, error: "transcript-write-failed" };
    }
    const composed = await this.loadComposedSession(sessionId);
    return composed ? { ...claimed, session: composed } : claimed;
  }

  private async loadCurrentRecord(sessionId: string): Promise<ChatSessionRecordV2 | null> {
    const migrated = await this.ensureConversationMigrated(sessionId);
    if (!migrated) return null;
    await this.reconcilePendingDispatch(sessionId);
    const current = this.sessionStore.getSessionRecord(sessionId);
    return current?.schemaVersion === 2 ? current : migrated;
  }

  ensureConversationMigrated(sessionId: string): Promise<ChatSessionRecordV2 | null> {
    const previous = this.locks.get(sessionId);
    if (previous) return previous;
    const current = this.migrate(sessionId);
    this.locks.set(sessionId, current);
    return current.finally(() => {
      if (this.locks.get(sessionId) === current) this.locks.delete(sessionId);
    });
  }

  private async migrate(sessionId: string): Promise<ChatSessionRecordV2 | null> {
    let current = this.sessionStore.getSessionRecord(sessionId);
    if (!current) return null;
    if (current.schemaVersion === 2) return current;

    while (current.schemaVersion === 1) {
      // 79fad414 之前创建的会话，消息已以旧格式落盘（backfill:v1: / ${runId}:user: 等条目，turnId 一致）。
      // 已落盘的轮次整体跳过（canonical 条目与展示补丁都不再追加）：
      // 既避免迁移追加撞上次级幂等键（TRANSCRIPT_IDEMPOTENCY_CONFLICT），也避免 assistant 消息重复投影。
      const journaled = await this.store.read(sessionId);
      const journaledTurns = new Set(
        journaled.entries
          .filter((entry) => (entry.kind === "user" || entry.kind === "assistant") && entry.turnId)
          .map((entry) => entry.turnId as string),
      );
      for (const draft of buildLegacyBackfillDrafts(current.messages)) {
        if (journaledTurns.has(draft.message.id)) continue;
        const canonicalId = `migration:v2:${draft.message.id}:canonical`;
        if (draft.message.role === "user") {
          await this.store.append(sessionId, {
            id: canonicalId,
            at: draft.message.at,
            kind: "user",
            turnId: draft.message.id,
            revision: 1,
            payload: { text: draft.text, attachments: draft.attachments },
          });
        } else {
          await this.store.append(sessionId, {
            id: canonicalId,
            at: draft.message.at,
            kind: "assistant",
            turnId: draft.message.id,
            payload: { role: "assistant", content: draft.text },
          });
        }
        await this.store.append(sessionId, {
          kind: "presentation_patch",
          id: `migration:v2:${draft.message.id}:presentation:r1`,
          at: draft.message.at,
          payload: {
            messageId: draft.message.id,
            patchRevision: 1,
            patch: draft.presentationPatch,
          },
        });
      }

      await this.journal.checkpoint(sessionId);
      const checkpointGate = this.checkpointGate;
      if (checkpointGate) {
        this.checkpointGate = null;
        checkpointGate.signalEntered();
        await checkpointGate.released;
      }
      if (this.crashAfterCheckpoint) {
        this.crashAfterCheckpoint = false;
        throw new Error("TEST_CRASH");
      }

      const projection = await this.journal.readProjection(sessionId);
      const { messages: _messages, schemaVersion: _schemaVersion, ...metadata } = current;
      const record: ChatSessionRecordV2 = {
        ...metadata,
        schemaVersion: 2,
        messageCount: projection.messages.length,
      };
      const committed = this.sessionStore.writeMigratedSession(record, current);
      if (committed) return committed;
      const latest = this.sessionStore.getSessionRecord(sessionId);
      if (!latest) return null;
      if (latest.schemaVersion === 2) return latest;
      current = latest;
    }
    return current;
  }
}

/** 为主进程入口提供一份共享的 journal + migration 组合。 */
export function createConversationSessionMigration(
  userDataRoot: string,
  sessionStore: MigrationSessionStore = chatsStore,
): ConversationSessionMigration {
  const transcriptStore = getConversationTranscriptStore(userDataRoot);
  return new ConversationSessionMigration({
    journal: new ConversationJournalService(transcriptStore),
    store: transcriptStore,
    sessionStore,
  });
}

/** 将 metadata 与轨迹投影组合成既有 IPC ChatSession 形状。 */
export function composeMigratedSession(record: ChatSessionRecordV2, messages: ChatSession["messages"]): ChatSession {
  return chatsStore.composeSession(record, messages);
}
