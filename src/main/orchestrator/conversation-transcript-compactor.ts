import { createHash } from "node:crypto";
import type { ConversationTranscriptStore } from "./conversation-transcript-store";
import { ConversationTranscriptArchive } from "./conversation-transcript-archive";
import {
  buildCompactionSourceView,
  buildModelContextFromCompactedView,
  type TranscriptRunReader,
} from "./conversation-transcript-projection";
import type { TranscriptAppendInput, TranscriptEntry } from "./conversation-transcript-types";
import type { ChatMessage as CanonicalChatMessage } from "./vendors/types";
import { callSummarizeModel } from "./context-manager";
import { getAdapterForConfig } from "./vendors";
import { buildCompactionContextUsageSnapshot } from "./context-usage";
import type { ContextUsageSnapshot } from "../../shared/context-usage";
import {
  compressForAgentLoop,
  findSafeCutPointForRetainedTokens,
} from "./harness/compaction";

export interface ConversationCompactionRequest {
  conversationId: string;
  trigger: "automatic" | "manual";
  retainTokens?: number;
  /** 调用方已解析的会话当前模型；只在本次摘要请求中使用，不写入会话记录。 */
  modelSettings?: TranscriptCompactionModelSettings;
  transientMessages?: CanonicalChatMessage[];
  signal?: AbortSignal;
}

export interface ConversationCompactionResult {
  checkpointEntryId: string;
  sourceThroughSeq: number;
  compactedMessages: CanonicalChatMessage[];
}

export interface ConversationTranscriptCompactorOptions {
  store: ConversationTranscriptStore;
  summarize: (
    history: CanonicalChatMessage[],
    modelSettings?: TranscriptCompactionModelSettings,
    signal?: AbortSignal,
  ) => Promise<string>;
  runReader?: TranscriptRunReader;
  archive?: ConversationTranscriptArchive;
  now?: () => number;
  /** 压缩阶段观察者：摘要请求前 running、检查点提交后 finished（失败也发）。
   *  统一推送运行前和运行中压缩的阶段及占用，驱动窗口提示。 */
  onPhase?: (phase: "running" | "finished", conversationId: string, usage?: ContextUsageSnapshot) => void;
}

export interface TranscriptCompactionModelSettings {
  provider: string;
  baseUrl: string;
  model: string;
  apiKey: string;
  explicitTransport?: "openai" | "anthropic" | "responses" | "auto";
  reasoning?: import("../../shared/reasoning").ReasoningPreference;
  manualReasoning?: import("../../shared/manual-reasoning").ManualReasoningConfig;
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
  onPhase?: ConversationTranscriptCompactorOptions["onPhase"];
}): ConversationTranscriptCompactor {
  return new ConversationTranscriptCompactor({
    store: input.store,
    runReader: input.runReader,
    onPhase: input.onPhase,
    summarize: async (history, settings, signal) => {
      if (!settings) throw createTranscriptCompactionRequiredError();
      return callSummarizeModel(
        history,
        getAdapterForConfig({
          provider: settings.provider,
          baseUrl: settings.baseUrl,
          model: settings.model,
          apiKey: settings.apiKey,
          explicitTransport: settings.explicitTransport,
          reasoning: settings.reasoning,
          manualReasoning: settings.manualReasoning,
        }),
        { ...settings, contextWindowTokens: settings.contextWindowTokens ?? 256_000 },
        signal,
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
  private readonly onPhase: ConversationTranscriptCompactorOptions["onPhase"];

  constructor(options: ConversationTranscriptCompactorOptions) {
    this.store = options.store;
    this.summarize = options.summarize;
    this.runReader = options.runReader ?? { get: () => null };
    this.archive = options.archive ?? new ConversationTranscriptArchive(options.store);
    this.now = options.now ?? (() => Date.now());
    this.onPhase = options.onPhase;
  }

  async compact(request: ConversationCompactionRequest): Promise<ConversationCompactionResult> {
    request.signal?.throwIfAborted();
    await this.runReader.refresh?.();
    const retainTokens = request.retainTokens ?? 1;
    const before = await this.store.read(request.conversationId);
    // 已有有效检查点时输入为"旧摘要 + 后缀"，二次压缩不会丢弃第一次摘要；
    // previousReplacement 用于识别压缩器未产出新摘要的失败路径。
    const full = buildCompactionSourceView(before.entries, this.runReader);
    const cutIndex = findSafeCutPointForRetainedTokens(full.messages, retainTokens);
    if (cutIndex <= 0) throw createTranscriptCompactionRequiredError();

    const sourceThroughSeq = Math.max(...full.sourceSeqs.slice(0, cutIndex), 0);
    if (sourceThroughSeq <= 0) throw createTranscriptCompactionRequiredError();
    const sourceEntries = before.entries.filter((entry) => entry.seq <= sourceThroughSeq);
    const sourceDigest = digest(sourceEntries);
    const previousUsage = before.entries.reduce<ContextUsageSnapshot | undefined>((latest, entry) => {
      const usage = entry.kind === "presentation_patch" ? entry.payload.patch.contextUsage : undefined;
      return usage && (!latest || usage.updatedAt > latest.updatedAt) ? usage : latest;
    }, undefined);
    const buildUsage = (messages: CanonicalChatMessage[], phase: ContextUsageSnapshot["phase"]) => request.modelSettings
      ? buildCompactionContextUsageSnapshot({
        phase,
        contextWindowTokens: request.modelSettings.contextWindowTokens ?? 256_000,
        messages: [...messages, ...(request.transientMessages ?? [])],
        previous: previousUsage,
      })
      : undefined;
    let phaseUsage = buildUsage(full.messages, "preCompaction");
    let summaryError: unknown;
    let compacted: CanonicalChatMessage[];
    // 呼吸提示覆盖整个压缩流程（含重试），只发一对 running/finished 避免闪烁。
    this.onPhase?.("running", request.conversationId, phaseUsage);
    try {
      compacted = await compressForAgentLoop({
        messages: full.messages,
        retainTokens,
        summarize: async (history) => {
          try {
            return await this.summarize(history, request.modelSettings, request.signal);
          } catch (error) {
            summaryError = error;
            throw error;
          }
        },
      });
      request.signal?.throwIfAborted();
      if (summaryError) {
        console.error("[ConversationTranscriptCompactor] summary failed", summaryError);
        throw createTranscriptCompactionRequiredError(summaryError);
      }
      const replacement = compacted[0];
      if (!replacement || replacement.role !== "system" || !isCompactionReplacement(replacement)
        // 无法产出更小摘要时首条可能是旧摘要，不能提交新检查点吞掉后缀历史。
        || replacement === full.previousReplacement) {
        throw createTranscriptCompactionRequiredError();
      }

      // 撤回或其它检查点会使摘要来源失效；新追加的消息则留作后缀。
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
      request.signal?.throwIfAborted();
      const checkpoint = await this.store.appendCompactionCheckpoint(request.conversationId, checkpointInput);
      // 先提交检查点再归档；归档失败不会撤销已持久化的摘要。
      try {
        await this.archive.archiveThrough(request.conversationId, sourceThroughSeq);
      } catch (error) {
        console.error("[ConversationTranscriptCompactor] archive failed", error);
      }
      const finalSnapshot = await this.store.read(request.conversationId);
      const finalContext = buildModelContextFromCompactedView(finalSnapshot.entries, this.runReader);
      phaseUsage = buildUsage(finalContext.messages, "preRequest");
      return {
        checkpointEntryId: checkpoint.id,
        sourceThroughSeq,
        compactedMessages: finalContext.messages,
      };
    } finally {
      this.onPhase?.("finished", request.conversationId, phaseUsage);
    }
  }
}

function isCompactionReplacement(message: CanonicalChatMessage): boolean {
  return message.role === "system" && typeof message.content === "string"
    && message.content.includes("<cyrene_compaction_checkpoint>");
}

function digest(entries: TranscriptEntry[]): string {
  return createHash("sha256").update(JSON.stringify(entries), "utf8").digest("hex");
}
