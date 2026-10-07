import { createHash } from "node:crypto";
import { getConversationDatabase } from "../storage/conversation-database-client";
import { assertValidPresentationPatch, assertValidTranscriptDraft, type TranscriptAppendInput, type TranscriptEntry, type TranscriptSnapshotV2, type TranscriptPresentationPatch } from "./conversation-transcript-types";
export interface ConversationTranscriptStoreOptions {
  now?: () => number;
}
export function transcriptStorageKey(id: string): string {
  if (!id || id.includes('\0'))
    throw new Error('TRANSCRIPT_INVALID_CONVERSATION_ID');
  return `v2-${createHash('sha256').update(id).digest('hex')}`;
}
/** SQLite owns sequence allocation, idempotency and complete historical lookup. */
export class ConversationTranscriptStore {
  private readonly database;
  private readonly now: () => number;
  constructor(root: string, options: ConversationTranscriptStoreOptions = {}) { this.database = getConversationDatabase(root); this.now = options.now ?? Date.now; }
  async append(id: string, input: TranscriptAppendInput): Promise<TranscriptEntry> {
    assertValidTranscriptDraft(input);
    return this.database.call('transcript.append', id, { ...input, at: input.at ?? this.now() });
  }
  async appendCompactionCheckpoint(id: string, input: TranscriptAppendInput): Promise<Extract<TranscriptEntry, {
    kind: 'compaction_checkpoint';
  }>> {
    assertValidTranscriptDraft(input);
    if (input.kind !== 'compaction_checkpoint')
      return Promise.reject(new Error('TRANSCRIPT_INVALID_COMPACTION_CHECKPOINT'));
    return this.database.call('transcript.compaction', id, input);
  }
  async appendPresentationNext(id: string, messageId: string, mutationKey: string, patch: TranscriptPresentationPatch): Promise<Extract<TranscriptEntry, {
    kind: 'presentation_patch';
  }>> {
    if (!messageId || !mutationKey || /[\u0000-\u001f\u007f]/.test(mutationKey))
      return Promise.reject(new Error('TRANSCRIPT_INVALID_PRESENTATION_PATCH'));
    assertValidPresentationPatch(patch);
    return this.database.call('transcript.presentation', id, messageId, mutationKey, patch, this.now());
  }
  read(id: string): Promise<TranscriptSnapshotV2> { return this.database.call('transcript.read', id); }
  readAuditEntries(id: string): Promise<TranscriptEntry[]> { return this.database.call('transcript.audit', id); }
  async archiveThrough(id: string, through: number, beforeCommit?: () => Promise<void>): Promise<void> { if (beforeCommit)
    await beforeCommit(); await this.database.call('transcript.archive', id, through); }
  async waitForIdle(_id: string): Promise<void> { await this.database.call('barrier'); }
  deleteConversation(id: string): Promise<void> { return this.database.call('transcript.delete', id); }
}
const stores = new Map<string, ConversationTranscriptStore>();
export function getConversationTranscriptStore(root: string): ConversationTranscriptStore {
  let store = stores.get(root);
  if (!store) {
    store = new ConversationTranscriptStore(root);
    stores.set(root, store);
  }
  return store;
}
