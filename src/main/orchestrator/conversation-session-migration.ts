/**
 * v1 chats-store 会话到 v2 元数据 + 轨迹的可重入迁移。
 * 迁移只负责业务胶水，文件原子写与轨迹队列继续由现有服务负责。
 */

import * as chatsStore from "../chats/chats-store";
import type { ChatSession, ChatSessionRecordV2 } from "../../shared/chat-types";
import { ConversationJournalService } from "./conversation-journal-service";
import { ConversationTranscriptStore } from "./conversation-transcript-store";
import { buildLegacyBackfillDrafts } from "./conversation-transcript-coordinator";

export interface ConversationSessionMigrationOptions {
  journal: ConversationJournalService;
  store: ConversationTranscriptStore;
  sessionStore?: Pick<typeof chatsStore, "getSessionRecord" | "writeMigratedSession">;
}

type MigrationSessionStore = Pick<typeof chatsStore, "getSessionRecord" | "writeMigratedSession">;

export class ConversationSessionMigration {
  private readonly journal: ConversationJournalService;
  private readonly store: ConversationTranscriptStore;
  private readonly sessionStore: MigrationSessionStore;
  private readonly locks = new Map<string, Promise<ChatSessionRecordV2 | null>>();
  private crashAfterCheckpoint = false;

  constructor(options: ConversationSessionMigrationOptions) {
    this.journal = options.journal;
    this.store = options.store;
    this.sessionStore = options.sessionStore ?? chatsStore;
  }

  /** 测试用崩溃注入点：checkpoint 成功后、元数据原子写之前抛错。 */
  failAfterCheckpointOnce(): void {
    this.crashAfterCheckpoint = true;
  }

  getJournal(): ConversationJournalService {
    return this.journal;
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
    const current = this.sessionStore.getSessionRecord(sessionId);
    if (!current) return null;
    if (current.schemaVersion === 2) return current;

    for (const draft of buildLegacyBackfillDrafts(current.messages)) {
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
    return this.sessionStore.writeMigratedSession(record);
  }
}

/** 为主进程入口提供一份共享的 journal + migration 组合。 */
export function createConversationSessionMigration(
  userDataRoot: string,
  sessionStore: MigrationSessionStore = chatsStore,
): ConversationSessionMigration {
  const transcriptStore = new ConversationTranscriptStore(userDataRoot);
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
