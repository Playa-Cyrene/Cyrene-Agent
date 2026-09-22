import { createHash } from "node:crypto";
import type { ConversationTranscriptStore } from "./conversation-transcript-store";
import { ConversationTranscriptArchive } from "./conversation-transcript-archive";
import {
  buildFullModelContextWithSources,
  buildModelContextFromCompactedView,
  type TranscriptRunReader,
} from "./conversation-transcript-projection";
import type { TranscriptAppendInput, TranscriptEntry } from "./conversation-transcript-types";
import type { ChatMessage as CanonicalChatMessage } from "./vendors/types";
import { callSummarizeModel } from "./context-manager";
import { getAdapterForConfig } from "./vendors";
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
  archive?: ConversationTranscriptArchive;
  now?: () => number;
}

export interface TranscriptCompactionModelSettings {
  provider: string;
  baseUrl: string;
  model: string;
  apiKey: string;
  explicitTransport?: "openai" | "anthropic" | "responses" | "auto";
  reasoning?: import("../../shared/reasoning").ReasoningPreference;
  contextWindowTokens?: number;
}

export const TRANSCRIPT_COMPACTION_REQUIRED = "TRANSCRIPT_COMPACTION_REQUIRED";

export function createTranscriptCompactionRequiredError(cause?: unknown): Error {
  const error = new Error(TRANSCRIPT_COMPACTION_REQUIRED);
  if (cause !== undefined) Object.assign(error, { cause });
  return error;
}

/** Composition-root factory: the existing context-manager summarizer is the only provider path. */
export function createModelBackedConversationTranscriptCompactor(input: {
  store: ConversationTranscriptStore;
  runReader?: TranscriptRunReader;
  loadModelSettings: () => TranscriptCompactionModelSettings;
}): ConversationTranscriptCompactor {
  return new ConversationTranscriptCompactor({
    store: input.store,
    runReader: input.runReader,
    summarize: async (history) => {
      const settings = input.loadModelSettings();
      return callSummarizeModel(
        history,
        getAdapterForConfig({
          provider: settings.provider,
          baseUrl: settings.baseUrl,
          model: settings.model,
          apiKey: settings.apiKey,
          explicitTransport: settings.explicitTransport,
          reasoning: settings.reasoning,
        }),
        { ...settings, contextWindowTokens: settings.contextWindowTokens ?? 256_000 },
      );
    },
  });
}

/** 会话级压缩协调器：摘要成功并写入 checkpoint 前，canonical 轨迹永不改写。 */
export class ConversationTranscriptCompactor {
  private readonly store: ConversationTranscriptStore;
  private readonly summarize: ConversationTranscriptCompactorOptions["summarize"];
  private readonly runReader: TranscriptRunReader;
  private readonly archive: ConversationTranscriptArchive;
  private readonly now: () => number;

  constructor(options: ConversationTranscriptCompactorOptions) {
    this.store = options.store;
    this.summarize = options.summarize;
    this.runReader = options.runReader ?? { get: () => null };
    this.archive = options.archive ?? new ConversationTranscriptArchive(options.store);
    this.now = options.now ?? (() => Date.now());
  }

  async compact(request: ConversationCompactionRequest): Promise<ConversationCompactionResult> {
    const retainTokens = request.retainTokens ?? 1;
    const before = await this.store.read(request.conversationId);
    const full = buildFullModelContextWithSources(before.entries, this.runReader);
    const cutIndex = findSafeCutPointForRetainedTokens(full.messages, retainTokens);
    if (cutIndex <= 0) throw createTranscriptCompactionRequiredError();

    const sourceThroughSeq = Math.max(...full.sourceSeqs.slice(0, cutIndex), 0);
    if (sourceThroughSeq <= 0) throw createTranscriptCompactionRequiredError();
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
    if (summaryError) {
      console.error("[ConversationTranscriptCompactor] summary failed", summaryError);
      throw createTranscriptCompactionRequiredError(summaryError);
    }
    const replacement = compacted[0];
    if (!replacement || replacement.role !== "system" || !isCompactionReplacement(replacement)) {
      throw createTranscriptCompactionRequiredError();
    }

    // A rewind or a competing checkpoint invalidates the prefix selected above.
    // Appended user/tool rows are intentionally allowed and become the suffix.
    const afterSummary = await this.store.read(request.conversationId);
    const currentPrefix = afterSummary.entries.filter((entry) => entry.seq <= sourceThroughSeq);
    if (digest(currentPrefix) !== sourceDigest || afterSummary.entries.some((entry) => (
      entry.seq > before.throughSeq
      && (entry.kind === "compaction_checkpoint" || entry.kind === "turn_rewind" || entry.kind === "turn_tombstone")
    ))) {
      throw createTranscriptCompactionRequiredError();
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
    const checkpoint = await this.store.appendCompactionCheckpoint(request.conversationId, checkpointInput);
    // The checkpoint is committed before archival. A crash in the generation
    // commit therefore leaves the complete canonical log readable and lets a
    // later attempt safely retry the hot-prefix archive.
    await this.archive.archiveThrough(request.conversationId, sourceThroughSeq);
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
