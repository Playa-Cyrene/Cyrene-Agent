import { createHash } from "node:crypto";
import type { ConversationTranscriptStore } from "./conversation-transcript-store";
import {
  buildFullModelContext,
  buildModelContextFromCompactedView,
  type TranscriptRunReader,
} from "./conversation-transcript-projection";
import type { TranscriptAppendInput, TranscriptEntry } from "./conversation-transcript-types";
import type { ChatMessage as CanonicalChatMessage } from "./vendors/types";
import {
  compressForAgentLoop,
  findSafeCutPointForRetainedTokens,
} from "./harness/compaction";

export interface ConversationCompactionRequest {
  conversationId: string;
  trigger: "automatic" | "manual";
  retainTokens?: number;
}

export interface ConversationCompactionResult {
  checkpointEntryId: string;
  sourceThroughSeq: number;
  compactedMessages: CanonicalChatMessage[];
}

export interface ConversationTranscriptCompactorOptions {
  store: ConversationTranscriptStore;
  summarize: (history: CanonicalChatMessage[]) => Promise<string>;
  runReader?: TranscriptRunReader;
  now?: () => number;
}

/** 会话级压缩协调器：摘要成功并写入 checkpoint 前，canonical 轨迹永不改写。 */
export class ConversationTranscriptCompactor {
  private readonly store: ConversationTranscriptStore;
  private readonly summarize: ConversationTranscriptCompactorOptions["summarize"];
  private readonly runReader: TranscriptRunReader;
  private readonly now: () => number;

  constructor(options: ConversationTranscriptCompactorOptions) {
    this.store = options.store;
    this.summarize = options.summarize;
    this.runReader = options.runReader ?? { get: () => null };
    this.now = options.now ?? (() => Date.now());
  }

  async compact(request: ConversationCompactionRequest): Promise<ConversationCompactionResult> {
    const retainTokens = request.retainTokens ?? 1;
    const before = await this.store.read(request.conversationId);
    const full = buildFullModelContext(before.entries, this.runReader);
    const cutIndex = findSafeCutPointForRetainedTokens(full.messages, retainTokens);
    if (cutIndex <= 0) throw new Error("TRANSCRIPT_COMPACTION_REQUIRED");

    const sourceThroughSeq = sourceThroughSeqForMessages(before.entries, full.messages, cutIndex);
    const sourceEntries = before.entries.filter((entry) => entry.seq <= sourceThroughSeq);
    const sourceDigest = digest(sourceEntries);
    let summaryError: unknown;
    const compacted = await compressForAgentLoop({
      messages: full.messages,
      retainTokens,
      summarize: async (history) => {
        try {
          return await this.summarize(history);
        } catch (error) {
          summaryError = error;
          throw error;
        }
      },
    });
    if (summaryError) throw summaryError;
    const replacement = compacted[0];
    if (!replacement || replacement.role !== "system" || !isCompactionReplacement(replacement)) {
      throw new Error("TRANSCRIPT_COMPACTION_REQUIRED");
    }

    // A rewind or a competing checkpoint invalidates the prefix selected above.
    // Appended user/tool rows are intentionally allowed and become the suffix.
    const afterSummary = await this.store.read(request.conversationId);
    const currentPrefix = afterSummary.entries.filter((entry) => entry.seq <= sourceThroughSeq);
    if (digest(currentPrefix) !== sourceDigest || afterSummary.entries.some((entry) => (
      entry.seq > before.throughSeq
      && (entry.kind === "compaction_checkpoint" || entry.kind === "turn_rewind" || entry.kind === "turn_tombstone")
    ))) {
      throw new Error("TRANSCRIPT_COMPACTION_CONFLICT");
    }

    const checkpointInput: TranscriptAppendInput = {
      id: `compaction:${sourceThroughSeq}:${sourceDigest}`,
      at: this.now(),
      kind: "compaction_checkpoint",
      payload: {
        baseThroughSeq: before.throughSeq,
        sourceThroughSeq,
        sourceDigest,
        replacement,
        trigger: request.trigger,
      },
    };
    const checkpoint = await this.store.append(request.conversationId, checkpointInput);
    const finalSnapshot = await this.store.read(request.conversationId);
    const finalContext = buildModelContextFromCompactedView(finalSnapshot.entries, this.runReader);
    return {
      checkpointEntryId: checkpoint.id,
      sourceThroughSeq,
      compactedMessages: finalContext.messages,
    };
  }
}

function isCompactionReplacement(message: CanonicalChatMessage): boolean {
  return message.role === "system" && typeof message.content === "string"
    && message.content.includes("<cyrene_compaction_checkpoint>");
}

function digest(entries: TranscriptEntry[]): string {
  return createHash("sha256").update(JSON.stringify(entries), "utf8").digest("hex");
}

function sourceThroughSeqForMessages(
  entries: TranscriptEntry[],
  messages: CanonicalChatMessage[],
  messageCount: number,
): number {
  let messageIndex = 0;
  let sourceThroughSeq = 0;
  for (const entry of entries) {
    const message = canonicalMessageForEntry(entry);
    if (!message || messageIndex >= messageCount) continue;
    if (sameMessage(message, messages[messageIndex]!)) {
      sourceThroughSeq = entry.seq;
      messageIndex += 1;
    }
  }
  if (messageIndex < messageCount) throw new Error("TRANSCRIPT_COMPACTION_REQUIRED");
  return sourceThroughSeq;
}

function canonicalMessageForEntry(entry: TranscriptEntry): CanonicalChatMessage | null {
  if (entry.kind === "user") return { role: "user", content: entry.payload.text };
  if (entry.kind === "turn_rewind" && entry.payload.disposition === "replace_user") {
    return { role: "user", content: entry.payload.replacementUser?.text ?? "" };
  }
  if (entry.kind === "assistant") return entry.payload;
  if (entry.kind === "tool_result") return entry.payload.message;
  return null;
}

function sameMessage(left: CanonicalChatMessage, right: CanonicalChatMessage): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}
