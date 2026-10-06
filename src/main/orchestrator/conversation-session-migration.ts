/** 会话导入由数据库线程一次提交；此适配器仅组合元信息与投影。 */
import * as chatsStore from "../chats/chats-store";
import type { ChatMessage, ChatSession, ChatSessionRecordV2 } from "../../shared/chat-types";
import { ConversationJournalService } from "./conversation-journal-service";
import { getConversationTranscriptStore, type ConversationTranscriptStore } from "./conversation-transcript-store";
import { ConversationStoreError } from "../storage/conversation-store-error";
type MigrationSessionStore = Pick<typeof chatsStore, "getSessionRecord">;
export interface ConversationSessionMigrationOptions {
  journal: ConversationJournalService;
  store: ConversationTranscriptStore;
  sessionStore?: MigrationSessionStore;
}
export interface ComposedSessionPage {
  session: Omit<ChatSession, "messages"> & {
    messageCount: number;
  };
  messages: ChatMessage[];
  hasMore: boolean;
  nextBefore: number | null;
}
export class ConversationSessionMigration {
  private readonly sessionStore: MigrationSessionStore;
  constructor(private readonly options: ConversationSessionMigrationOptions) {
    this.sessionStore = options.sessionStore ?? chatsStore;
  }
  getJournal(): ConversationJournalService { return this.options.journal; }
  async ensureConversationMigrated(id: string): Promise<ChatSessionRecordV2 | null> {
    const record = await this.sessionStore.getSessionRecord(id);
    if (!record)
      return null;
    if (record.schemaVersion !== 2)
      throw new ConversationStoreError("CONVERSATION_STORE_INTEGRITY_ERROR", { source: "unimported_session" });
    return record;
  }
  async loadComposedSession(id: string): Promise<ChatSession | null> {
    const record = await this.ensureConversationMigrated(id);
    if (!record)
      return null;
    return chatsStore.composeSession(record, (await this.options.journal.readProjection(id)).messages);
  }
  async loadComposedSessionPage(id: string, before: number | null, limit: number): Promise<ComposedSessionPage | null> {
    const record = await this.ensureConversationMigrated(id);
    if (!record)
      return null;
    const page = await this.options.journal.readProjectionPage(id, before, limit);
    const { messages, ...session } = chatsStore.composeSession(record, page.messages);
    return { session: { ...session, messageCount: page.messageCount }, messages, hasMore: page.hasMore, nextBefore: page.nextBefore };
  }
  reconcilePendingDispatch(id: string): Promise<boolean> { return chatsStore.reconcilePendingDispatch(id); }
  async claimPendingMessage(id: string): Promise<chatsStore.ClaimPendingResult> {
    await this.ensureConversationMigrated(id);
    const claimed = await chatsStore.claimPendingMessage(id);
    if (!claimed.ok || !claimed.claimed)
      return claimed;
    const session = await this.loadComposedSession(id);
    return session ? { ...claimed, session } : claimed;
  }
}
export function createConversationSessionMigration(root: string, sessionStore: MigrationSessionStore = chatsStore): ConversationSessionMigration {
  const store = getConversationTranscriptStore(root);
  return new ConversationSessionMigration({ journal: new ConversationJournalService(store), store, sessionStore });
}
export function composeMigratedSession(record: ChatSessionRecordV2, messages: ChatSession["messages"]): ChatSession {
  return chatsStore.composeSession(record, messages);
}
