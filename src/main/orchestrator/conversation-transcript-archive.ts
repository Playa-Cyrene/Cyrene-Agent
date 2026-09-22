import type { TranscriptArchiveRef, TranscriptEntry } from "./conversation-transcript-types";
import { ConversationTranscriptStore } from "./conversation-transcript-store";

export interface TranscriptArchiveSegment extends TranscriptArchiveRef {}

export interface TranscriptGenerationManifest {
  schemaVersion: 1;
  activeFile: string;
  archives: TranscriptArchiveSegment[];
}

export interface ConversationTranscriptArchiveOptions {
  store: ConversationTranscriptStore;
}

/**
 * Coordinates generation commits around the existing per-conversation store
 * queue. Storage, hashing, fsync and atomic rename remain owned by the store;
 * this class only exposes the archive protocol to compaction callers.
 */
export class ConversationTranscriptArchive {
  private readonly store: ConversationTranscriptStore;
  private crashBeforeManifest = false;

  constructor(storeOrOptions: ConversationTranscriptStore | ConversationTranscriptArchiveOptions) {
    this.store = storeOrOptions instanceof ConversationTranscriptStore
      ? storeOrOptions
      : storeOrOptions.store;
  }

  failBeforeManifestOnce(): void {
    this.crashBeforeManifest = true;
  }

  archiveThrough(conversationId: string, throughSeq: number): Promise<void> {
    return this.store.archiveThrough(conversationId, throughSeq, async () => {
      if (!this.crashBeforeManifest) return;
      this.crashBeforeManifest = false;
      throw new Error("TEST_CRASH");
    });
  }

  readAuditEntries(conversationId: string): Promise<TranscriptEntry[]> {
    return this.store.readAuditEntries(conversationId);
  }
}

