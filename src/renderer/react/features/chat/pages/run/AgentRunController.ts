import type {
  AgentRoundRecord,
  ChatMessage,
  ChatPresentationCheckpointPatch,
  ChatSession,
  ConversationMode,
  PendingChatAttachment,
  ProcessMessageRecord,
  ReasoningBlock,
  RunActivityRecord,
  TaskDelegationDisplayRecord,
  ToolExecutionRecord,
} from "../../../../../../shared/chat-types";
import type { GeneratedImageAttachment } from "../../../../../../shared/generated-image";
import { isContextUsageSnapshot, type ContextUsageSnapshot } from "../../../../../../shared/context-usage";
import type { TodoItem } from "../../../../../../shared/todo-types";
import { normalizeMailDraftCardData, type MailDraftCardData } from "../../../../../../shared/mail-draft-card";
import { isModelFailureInfo, type ModelFailureInfo } from "../../../../../../shared/model-error";
import type { ModelRetryStatus } from "../../../../../../shared/model-retry";
import type { ChatMessageItem } from "../../components/ChatMessageList";
import { formatBrowserElementSelection } from "../../../../../../shared/browser-panel-types";
import type { ComposerAttachment } from "../../components/ChatComposer";
import {
  isFormalAnswerCommitted,
  normalizeChoiceInteraction,
  normalizeTaskPlanPresentation,
  resolveRunFinishedStage,
  resolveTerminalContent,
  shouldClearComposerInteractionForTerminal,
  type AgentRunStage,
  type ComposerInteraction,
} from "../../components/run-presentation";
import { applyAgentRoundBoundary, createRoundProcessMessage } from "../../components/agent-rounds";
import { applyTaskDelegationEvent, normalizeTaskDelegationEvent } from "../../components/task-delegations";
import { getCharacterName, t } from "../../../../i18n";
import type { AguiApi, AguiEvent, CandidateTextEventValue, ChatStoreApi } from "../chat-page-bridge";
import { parseSessionRunActiveError, stageForStep } from "../chat-page-normalizers";
import { RunEventGate } from "../run-event-gate";
import { applyVisibleOutput, normalizeShellOutputEvent } from "./command-output";
import {
  SMOOTH_REVEAL_TICK_MS,
  SmoothTextRevealQueue,
  splitTextForReveal,
} from "../message-reveal";
import {
  mergeHarnessTodosForSession,
  startSessionTodos,
  type TodoStateBySession,
} from "../session-runtime-state";
import {
  resolveEarlyTtsSplitMode,
  type EarlyTtsPlaybackQueue,
  type EarlyTtsSplitMode,
} from "../../tts/early-tts-queue";

/** 一次模型运行的全部输入：目标会话、消息占位与恢复/接管信息。 */
export interface AgentRunInput {
  targetMode: ConversationMode;
  sessionId: string;
  userMessageId: string;
  assistantId: string;
  session: ChatSession;
  attachments: ComposerAttachment[];
  /** 原始用户文本对应的 UI 展示文本；表情包标记不进入模型 text。 */
  visibleContent?: string;
  /**
   * 模型侧文本（认领时由主进程计算）：贴纸消息为「用户原话 + 表情包说明」，
   * 其余消息缺省。缺省时回退到投影会话里推导，保证旧路径行为不变。
   */
  modelText?: string;
  takeoverFromRunId?: string;
  /**
   * 待发队列认领派发：用户消息已由主进程认领写入历史（非本控制器追加）。
   * run ack 成功后清除会话的 pendingDispatch；失败则保留给恢复逻辑清账（恢复不自动续派）。
   */
  claimedPendingMessageId?: string;
  /** 桌面 edit / regenerate 的轨迹回退锚点（主进程写 turn_rewind；渲染端只传元数据）。 */
  transcriptRewind?: {
    anchorUserTurnId: string;
    disposition: "keep_user" | "replace_user";
  };
}

/** 计划面板更新：submit_plan 交卷（载入全文并打开面板）与执行收尾（阶段标记）。 */
export type PlanReviewUpdate =
  | { kind: "submitted"; planContent: string; planPath: string }
  | { kind: "completed" };

/**
 * 运行宿主：控制器与 React 世界之间的全部通道。
 * 宿主只是端口——不要求把控制器每一次内部状态变化都暴露成一个方法，
 * 新增成员前优先考虑合并语义相近的通知。
 */
export interface AgentRunHost {
  /** 插话边界补用户消息与新的助手消息段；沿用当前 run。 */
  appendMessages?(sessionId: string, messages: ChatMessageItem[]): void;
  onAssistantSegment?(previousId: string, nextId: string): void;
  /** 消息视图补丁：流式内容、推理块、工具执行记录等全部经此写入。 */
  patchMessage(sessionId: string, messageId: string, patch: Partial<ChatMessageItem>): void;
  /** 展示 composer 交互卡（审批请求 / ask 选择卡）。 */
  setInteraction(sessionId: string, interaction: ComposerInteraction): void;
  /** 清除指定会话的交互卡（run 终态结算）。 */
  clearInteraction(sessionId: string): void;
  /** ask 卡的 dismiss 事件：仅当当前卡片与事件匹配时清除。 */
  dismissAskIfMatched(sessionId: string, value: unknown): void;
  /** 会话级 Todo 面板状态更新（函数式，避免读旧值）。 */
  updateTodos(sessionId: string, updater: (current: TodoStateBySession) => TodoStateBySession): void;
  /** 会话级上下文容量快照更新（环形图优先读取点）。 */
  updateContextUsage(sessionId: string, snapshot: ContextUsageSnapshot): void;
  setMainModelFailure?(sessionId: string, failure: ModelFailureInfo | null): void;
  /** 会话级计划面板更新：submit_plan 交卷与执行收尾（事件均在 run 内到达）。 */
  updatePlanReview(sessionId: string, update: PlanReviewUpdate): void;
  /** 模式级 busy 标记（ref 与渲染状态由宿主同步维护）。 */
  setModeBusy(mode: ConversationMode, busy: boolean): void;
  /** 会话守卫冲突（SESSION_RUN_ACTIVE）：挂起接管操作卡，等用户决定。 */
  requestTakeover(sessionId: string, activeRunId: string, retry: () => Promise<void>): void;
  /** 新 run 已被主进程接受：同会话旧的接管操作卡（若有）不再有效。 */
  clearTakeover(sessionId: string): void;
  earlyTts: {
    /** 创建本轮的早播 TTS 队列（同一时间只保留一个活跃队列）。 */
    start(
      mode: ConversationMode,
      sessionId: string,
      messageId: string,
      splitMode?: EarlyTtsSplitMode,
    ): EarlyTtsPlaybackQueue;
    /** run 成功结束后用完整正文收尾播放。 */
    finish(queue: EarlyTtsPlaybackQueue, fullText: string): void;
  };
  /**
   * run 结束（含成功、失败、取消、接管冲突等所有路径）。
   * 宿主据此刷新会话列表并消费该会话的待发消息队列。
   * queuePaused=true 表示 run 未被主进程接受（启动失败/守卫冲突挂起接管），
   * 该会话的队列消费必须停住：认领的消息尚未派发成功，先恢复它再说。
   */
  onRunFinished(input: { mode: ConversationMode; sessionId: string; queuePaused: boolean }): void;
}

/** 跨 run 共享的可变注册表：由页面持有、按引用注入，语义与 ref 一致。 */
export interface AgentRunRegistries {
  /** 会话 → 进行中的 run（assistant 占位消息 + runId + 模式）。 */
  activeRuns: { current: Record<string, { assistantId: string; runId?: string; mode: ConversationMode }> };
  /** 会话 → 立即写检查点的触发器（审批请求到达时把 run 状态落为 waiting_user）。 */
  checkpointTriggers: { current: Record<string, (status: "running" | "waiting_user") => void> };
  /** ack.runId 尚未返回时已被请求取消的会话。 */
  cancelRequestedSessions: { current: Set<string> };
  /** 页面卸载时需要统一退订的事件句柄集合。 */
  eventUnsubscribers: { current: Set<() => void> };
}

/** 控制器运行依赖：桥层 API、宿主端口、共享注册表与 run 重开入口。 */
export interface AgentRunDeps {
  api: AguiApi | undefined;
  store: ChatStoreApi | undefined;
  host: AgentRunHost;
  registries: AgentRunRegistries;
  /** 接管重开时复用同一派发入口启动新 run。 */
  startRun: (input: AgentRunInput) => Promise<void>;
}

function buildPresentationCheckpointPatch(
  previous: ChatMessage | undefined,
  current: ChatMessage,
  status: "running" | "waiting_user" | "terminal",
): ChatPresentationCheckpointPatch | undefined {
  const delta: NonNullable<ChatPresentationCheckpointPatch["delta"]> = {};
  const reasoning = diffPresentationItems(previous?.reasoningBlocks, current.reasoningBlocks, (item) => item.id);
  if (reasoning.upserts.length) delta.reasoningBlockUpserts = reasoning.upserts;
  if (reasoning.appends.length) delta.reasoningBlockAppends = reasoning.appends;
  const process = diffPresentationItems(previous?.processMessages, current.processMessages, (item) => item.id);
  if (process.upserts.length) delta.processMessageUpserts = process.upserts;
  if (process.appends.length) delta.processMessageAppends = process.appends;
  const rounds = diffPresentationItems(previous?.agentRounds, current.agentRounds, (item) => item.id);
  if (rounds.upserts.length) delta.agentRoundUpserts = rounds.upserts;
  const delegations = diffPresentationItems(previous?.taskDelegations, current.taskDelegations, (item) => item.invocationId);
  if (delegations.upserts.length) delta.taskDelegationUpserts = delegations.upserts;
  const tools = diffPresentationItems(previous?.toolExecutions, current.toolExecutions, (item) => item.id);
  if (tools.upserts.length) delta.toolExecutionUpserts = tools.upserts;

  const patch: ChatPresentationCheckpointPatch = {};
  if (Object.keys(delta).length) patch.delta = delta;
  if (status === "terminal") patch.content = current.content;
  if (current.runSnapshot && !sameRunSnapshot(previous?.runSnapshot, current.runSnapshot)) {
    patch.runSnapshot = current.runSnapshot;
  }
  if (current.runActivity && !sameJson(previous?.runActivity, current.runActivity)) patch.runActivity = current.runActivity;
  if (current.contextUsage && !sameJson(previous?.contextUsage, current.contextUsage)) patch.contextUsage = current.contextUsage;
  if (current.sticker !== undefined && current.sticker !== previous?.sticker) patch.sticker = current.sticker;
  if (current.emailDraftCards && !sameJson(previous?.emailDraftCards ?? [], current.emailDraftCards)) patch.emailDraftCards = current.emailDraftCards;
  return Object.keys(patch).length ? patch : undefined;
}

function diffPresentationItems<T extends object>(
  previous: readonly T[] | undefined,
  current: readonly T[] | undefined,
  getId: (item: T) => string,
): { upserts: T[]; appends: Array<{ id: string; content: string }> } {
  const oldById = new Map((previous ?? []).map((item) => [getId(item), item]));
  const upserts: T[] = [];
  const appends: Array<{ id: string; content: string }> = [];
  for (const item of current ?? []) {
    const id = getId(item);
    const old = oldById.get(id);
    if (!old) {
      upserts.push(item);
      continue;
    }
    if (sameJson(old, item)) continue;
    const previousContent = (old as T & { content?: unknown }).content;
    const nextContent = (item as T & { content?: unknown }).content;
    if (typeof previousContent === "string" && typeof nextContent === "string" &&
      nextContent.startsWith(previousContent) && sameWithoutContent(old, item)) {
      const appended = nextContent.slice(previousContent.length);
      if (appended) appends.push({ id, content: appended });
    } else {
      upserts.push(item);
    }
  }
  return { upserts, appends };
}

function sameWithoutContent<T extends object>(left: T, right: T): boolean {
  const { content: _leftContent, ...leftFields } = left as T & { content?: unknown };
  const { content: _rightContent, ...rightFields } = right as T & { content?: unknown };
  return sameJson(leftFields, rightFields);
}

function sameRunSnapshot(
  left: ChatMessage["runSnapshot"] | undefined,
  right: ChatMessage["runSnapshot"] | undefined,
): boolean {
  return left?.runId === right?.runId && left?.status === right?.status && left?.terminalStatus === right?.terminalStatus;
}

function sameJson(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function createCheckpointRunToken(): string {
  const randomId = globalThis.crypto?.randomUUID?.();
  if (randomId) return randomId.replaceAll("-", "").slice(0, 12);
  return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * 单次 Agent 运行的生命周期控制器：事件归约、检查点落盘、
 * 正文渐显、早播 TTS 接线与终态结算全部内聚于此。
 * 不依赖 React，可注入假桥与记录型宿主做全流程单测。
 */
function normalizeModelRetryStatus(value: unknown): ModelRetryStatus | undefined {
  if (!value || typeof value !== "object") return undefined;
  const status = value as Partial<ModelRetryStatus>;
  if ((status.phase !== "waiting" && status.phase !== "attempting" && status.phase !== "cleared")
    || !Number.isInteger(status.retryNumber) || !Number.isInteger(status.maxRetries)) return undefined;
  return {
    phase: status.phase,
    retryNumber: status.retryNumber!,
    maxRetries: status.maxRetries!,
    ...(typeof status.delayMs === "number" ? { delayMs: status.delayMs } : {}),
    ...(typeof status.category === "string" ? { category: status.category } : {}),
  };
}

export class AgentRunController {
  private readonly input: AgentRunInput;
  private readonly deps: AgentRunDeps;
  /** 插话边界等待旧段渐显及检查点完成，后续事件仍按到达顺序处理。 */
  private eventChain: Promise<void> | undefined;

  // —— 流式累积状态 ——
  private streamContent = "";
  /** RUN_FINISHED.result.status：success / cancelled / timeout / runtime_error。 */
  private terminalStatus: string | undefined;
  /** 终态阶段文案：结算后候选正文还会逐帧补完，用它挡住把阶段退回「组织回复」的后续帧。 */
  private terminalStage: AgentRunStage | undefined;
  private reasoningContent = "";
  private reasoningBlocks: ReasoningBlock[] = [];
  private processMessages: ProcessMessageRecord[] = [];
  private agentRounds: AgentRoundRecord[] = [];
  private taskDelegations: TaskDelegationDisplayRecord[] = [];
  private activeRoundId: string | undefined;
  private processMessageSequence = 0;
  /** run 内单调递增的时间线序号：推理块、过程消息、工具记录创建时各领一个。 */
  private eventSequence = 0;
  private finalMessageCompleted = false;
  private revealCancelled = false;
  private revealChain: Promise<void> = Promise.resolve();
  /** 当前模型轮的临时候选正文；只用于界面预览，不进入检查点。 */
  private candidateRoundId: string | undefined;
  private candidateText = "";
  private candidateVisibleText = "";
  private readonly candidateRevealQueue = new SmoothTextRevealQueue();
  /** 候选正文开始流式时的时间线序号：轮闭合转过程消息时沿用，保证正文排在同轮工具之前。 */
  private candidateSeq: number | undefined;
  private candidateFrameId: number | undefined;
  private candidateFrameUsesRaf = false;
  private candidateLastFrameAt: number | undefined;
  private candidateDrainResolve: (() => void) | undefined;
  private pendingCandidateClassification: { processId: string; content: string } | undefined;
  private sticker: string | null = null;
  private toolExecutions: ToolExecutionRecord[] = [];
  private emailDraftCards: MailDraftCardData[] = [];
  private runStarted = false;
  /** run 已被主进程接受（ack 成功）：false 时 onRunFinished 携带 queuePaused 暂停队列消费。 */
  private runAccepted = false;
  private runActivity: RunActivityRecord | undefined;
  private currentTodos: TodoItem[] = [];
  private persistedFinalContent = "";
  private generatedImageAttachments: GeneratedImageAttachment[] = [];
  /** 上下文容量快照：preRequest 每轮实时覆盖（纯内存），terminal 随 checkpoint 落盘。 */
  private contextUsage: ContextUsageSnapshot | undefined;
  private assistantAt = 0;
  private checkpointTimer: number | undefined;
  private checkpointChain: Promise<boolean> = Promise.resolve(true);
  private persistedCheckpoint: ChatMessage | undefined;
  private checkpointMutationSequence = 0;
  private readonly checkpointRunToken = createCheckpointRunToken();
  private readonly activeReasoningStarts = new Map<string, number>();
  private currentReasoningId: string | undefined;
  private earlyTtsQueue: EarlyTtsPlaybackQueue | undefined;
  private earlyTtsSplitMode: EarlyTtsSplitMode = "sentence";
  private resolveTerminal!: (error?: Error) => void;
  private readonly terminal: Promise<Error | undefined>;

  constructor(input: AgentRunInput, deps: AgentRunDeps) {
    this.input = { ...input };
    this.deps = deps;
    this.terminal = new Promise<Error | undefined>((resolve) => {
      this.resolveTerminal = resolve;
    });
  }

  /** 启动并完整跑完一轮 run（从派发请求到终态落盘）。 */
  async start(): Promise<void> {
    this.deps.host.setMainModelFailure?.(this.input.sessionId, null);
    const { api, store } = this.deps;
    if (!api || !store) {
      const visibleError = t("chatPage.errorModelServiceNotReady");
      this.deps.host.patchMessage(this.input.sessionId, this.input.assistantId, {
        content: visibleError,
        loading: false,
        waitingForFirstEvent: false,
        streaming: false,
        responseStarted: true,
      });
      // run 未被主进程接受：认领派发（若有）保留 pendingDispatch 供恢复，宿主暂停队列消费
      this.deps.host.onRunFinished({ mode: this.input.targetMode, sessionId: this.input.sessionId, queuePaused: true });
      return;
    }

    this.deps.host.setModeBusy(this.input.targetMode, true);
    this.deps.registries.activeRuns.current = {
      ...this.deps.registries.activeRuns.current,
      [this.input.sessionId]: { assistantId: this.input.assistantId, mode: this.input.targetMode },
    };
    this.assistantAt = Date.now();

    // 注册本会话的检查点触发器：审批请求到达时立即把状态落为 waiting_user
    this.deps.registries.checkpointTriggers.current = {
      ...this.deps.registries.checkpointTriggers.current,
      [this.input.sessionId]: (status) => {
        void this.checkpointRun(status, true);
      },
    };

    const eventGate = new RunEventGate<AguiEvent>();
    const off = api.onEvent((event) => {
      for (const accepted of eventGate.accept(event)) this.handleEvent(accepted);
    });
    this.deps.registries.eventUnsubscribers.current.add(off);

    try {
      const general = await window.chat?.getGeneralSettings?.();
      const splitMode = resolveEarlyTtsSplitMode(
        general?.ttsEarlyReadSplitEnabled,
        general?.ttsEarlyReadSplitMode,
      );
      this.earlyTtsSplitMode = splitMode;
      this.earlyTtsQueue = this.deps.host.earlyTts.start(
        this.input.targetMode,
        this.input.sessionId,
        this.input.assistantId,
        splitMode,
      );
      const ack = await api.run({
        // 模型历史由主进程 journal 构建；renderer 只发送当前 user 事实。
        currentUser: {
          turnId: this.input.userMessageId,
          text: (() => {
            const selectedElements = this.input.attachments
              .filter((attachment) => attachment.kind === "web-element" && attachment.element)
              .map((attachment) => formatBrowserElementSelection(attachment.element!));
            // 认领派发时主进程已把权威模型文本交给我们（贴纸消息含自然语言说明），
            // 直接用；旧路径缺省时回退投影会话推导。
            const content = this.input.modelText ?? (() => {
              const message = this.input.session.messages.find((item) => item.id === this.input.userMessageId);
              return message?.modelContext?.trim() || message?.content || "";
            })();
            return selectedElements.length > 0 ? [content, ...selectedElements].filter(Boolean).join("\n\n") : content;
          })(),
          visibleContent: this.input.visibleContent
            ?? this.input.session.messages.find((item) => item.id === this.input.userMessageId)?.content
            ?? "",
          ...(this.input.attachments.length > 0 ? {
            attachments: this.input.attachments.flatMap((attachment): PendingChatAttachment[] => {
              if (attachment.kind === "web-element" && attachment.element) {
                return [{ kind: "web-element", name: attachment.name, element: attachment.element }];
              }
              if (!attachment.filePath) return [];
              return [{
                kind: attachment.kind === "image" ? "image" : "document",
                name: attachment.name,
                filePath: attachment.filePath,
                ...(attachment.mime ? { mime: attachment.mime } : {}),
                ...(attachment.caption ? { caption: attachment.caption } : {}),
                ...(attachment.hasAnnotations ? { hasAnnotations: true } : {}),
              }];
            }),
          } : {}),
          ...(() => {
            const sticker = this.input.session.messages.find((item) => item.id === this.input.userMessageId)?.sticker;
            return sticker ? { sticker } : {};
          })(),
        },
        assistantTurnId: this.input.assistantId,
        styleId: general?.currentStyleId,
        sessionId: this.input.sessionId,
        ...(this.input.takeoverFromRunId ? { takeoverFromRunId: this.input.takeoverFromRunId } : {}),
        ...(this.input.transcriptRewind ? { transcriptRewind: this.input.transcriptRewind } : {}),
        imageAttachments: this.input.attachments
          .filter((attachment) => attachment.kind === "image" && attachment.filePath)
          .map((attachment) => ({
            name: attachment.name,
            filePath: attachment.filePath!,
            mime: attachment.mime,
          })),
      });
      if (!ack.success) throw new Error(ack.error ?? t("chatPage.errorModelRequestStartFailed"));
      // run 已被主进程接受：认领派发的消息确认派发完成，清除 pendingDispatch。
      // 确认失败仅告警——残留状态会被恢复逻辑直接清账（不自动续派），不会重复派发。
      this.runAccepted = true;
      if (this.input.claimedPendingMessageId) {
        // 模型启动已成功：派发状态清理失败/异常只告警，绝不落入下方 catch 的
        // 「模型请求失败」分支（那会把成功的 run 污染成错误终态）。
        // 残留的 pendingDispatch 由恢复逻辑清账，不会重复派发。
        try {
          const completed = await store.pendingCompleteDispatch(
            this.input.sessionId,
            this.input.claimedPendingMessageId,
          );
          if (!completed.ok) {
            console.warn(
              `[AgentRunController] 待发派发确认失败（保留恢复入口）: sessionId=${this.input.sessionId}`,
              `messageId=${this.input.claimedPendingMessageId}`,
            );
          }
        } catch (err) {
          console.warn(
            `[AgentRunController] 待发派发确认异常（保留恢复入口）: sessionId=${this.input.sessionId}`,
            `messageId=${this.input.claimedPendingMessageId}`,
            err,
          );
        }
      }
      if (ack.duplicate && ack.status === "completed") {
        const session = await store.get(this.input.sessionId);
        const message = session?.messages.find(item => item.id === this.input.assistantId);
        const { role: _role, ...fields } = message ?? {};
        this.deps.host.patchMessage(this.input.sessionId, this.input.assistantId, { ...fields, loading: false, streaming: false, waitingForFirstEvent: false });
        this.earlyTtsQueue?.cancel();
        return;
      }
      // 新 run 已被主进程接受：同会话旧的守卫冲突操作卡（若有）不再有效
      this.deps.host.clearTakeover(this.input.sessionId);
      // 立即把 ack.runId 写入注册表，让 cancel 在 RUN_STARTED 事件到达前也能找到正确的 runId。
      // RUN_STARTED.runId 必须与 ack.runId 一致（由 bridge 注入 options.runId 保证）。
      if (ack.runId) {
        const existing = this.deps.registries.activeRuns.current[this.input.sessionId];
        this.deps.registries.activeRuns.current = {
          ...this.deps.registries.activeRuns.current,
          [this.input.sessionId]: {
            ...(existing ?? { assistantId: this.input.assistantId, mode: this.input.targetMode }),
            runId: ack.runId,
          },
        };
        for (const accepted of eventGate.bind(ack.runId)) this.handleEvent(accepted);
        await this.checkpointRun("running", true);
        if (this.deps.registries.cancelRequestedSessions.current.delete(this.input.sessionId)) {
          await api.cancel(ack.runId);
        }
      }
      const terminalError = await this.terminal;
      if (terminalError) throw terminalError;
      await this.revealChain;

      // 只有 success + 完整 TEXT_MESSAGE_END + 非空正文才提交正式回答。
      // cancelled / timeout / runtime_error 与半截流都只保留在展开的过程区。
      const formalAnswerCommitted = isFormalAnswerCommitted(this.streamContent, this.terminalStatus, this.finalMessageCompleted);
      if (!formalAnswerCommitted) this.moveCandidateToInterruptedProcess();
      else this.resetCandidateState();
      this.completeRunActivity(!formalAnswerCommitted);
      const finalContent = formalAnswerCommitted ? resolveTerminalContent(this.streamContent, this.terminalStatus) : "";
      this.persistedFinalContent = finalContent;
      this.deps.host.patchMessage(this.input.sessionId, this.input.assistantId, {
        content: finalContent,
        transientText: undefined,
        loading: false,
        waitingForFirstEvent: false,
        streaming: false,
        // 回复结算时刻：footer 的回复时间据此展示；会话重载后由持久化消息的 at 接管
        at: Date.now(),
        reasoning: this.reasoningContent || undefined,
        reasoningBlocks: this.reasoningBlocks,
        processMessages: this.processMessages,
        agentRounds: this.agentRounds,
        reasoningStreaming: false,
        // 结算收尾统一回写终态阶段，避免停在流式过程的「组织回复」上
        runStage: this.terminalStage,
        runActivity: this.runActivity,
        responseStarted: formalAnswerCommitted,
        sticker: this.sticker,
        toolExecutions: this.toolExecutions,
      });
      const savedAssistant = await this.checkpointRun("terminal", true);
      if (savedAssistant) this.reportRunPersisted();
      if (savedAssistant && formalAnswerCommitted && this.earlyTtsQueue) {
        this.deps.host.earlyTts.finish(this.earlyTtsQueue, finalContent);
      } else this.earlyTtsQueue?.cancel();
    } catch (error) {
      this.earlyTtsQueue?.cancel();
      this.terminalStatus = this.terminalStatus ?? "runtime_error";
      this.completeRunActivity(true);
      const errorMessage = error instanceof Error ? error.message : String(error);
      // 会话守卫冲突：主进程拒绝了并发 run（典型场景：F5 后立即发消息）。
      // 不走通用错误文案，改为挂起操作卡等用户决定是否终止旧 run 并重开本轮。
      const conflictRunId = parseSessionRunActiveError(errorMessage);
      if (conflictRunId) {
        this.moveCandidateToInterruptedProcess();
        this.processMessages = [...this.processMessages, createRoundProcessMessage(
          `process-${this.processMessageSequence++}`,
          t("chatPage.sessionRunActiveNotice"),
          this.toolExecutions.length,
          this.activeRoundId,
          this.nextSeq(),
        )];
        this.deps.host.patchMessage(this.input.sessionId, this.input.assistantId, {
          content: "",
          transientText: undefined,
          processMessages: this.processMessages,
          loading: false,
          waitingForFirstEvent: false,
          streaming: false,
          reasoningStreaming: false,
          runActivity: this.runActivity,
          responseStarted: false,
        });
        this.persistedFinalContent = "";
        this.deps.host.requestTakeover(this.input.sessionId, conflictRunId, async () => {
          // 重开本轮：assistant 占位消息回到 loading，带 takeoverFromRunId 重发
          this.deps.host.patchMessage(this.input.sessionId, this.input.assistantId, {
            loading: true,
            waitingForFirstEvent: true,
            streaming: false,
            responseStarted: false,
          });
          await this.deps.startRun({ ...this.input, takeoverFromRunId: conflictRunId });
        });
        await this.checkpointRun("terminal", true);
        return;
      }
      const visibleError = t("chatPage.errorModelRequestFailedWith", { message: errorMessage });
      this.moveCandidateToInterruptedProcess();
      this.processMessages = [...this.processMessages, createRoundProcessMessage(
        `process-${this.processMessageSequence++}`,
        visibleError,
        this.toolExecutions.length,
        this.activeRoundId,
        this.nextSeq(),
      )];
      this.deps.host.patchMessage(this.input.sessionId, this.input.assistantId, {
        content: "",
        transientText: undefined,
        processMessages: this.processMessages,
        loading: false,
        waitingForFirstEvent: false,
        streaming: false,
        reasoningStreaming: false,
        runActivity: this.runActivity,
        responseStarted: false,
      });
      this.persistedFinalContent = "";
      const savedAssistant = await this.checkpointRun("terminal", true);
      // 错误终态的快照也已落盘：上报落盘确认（runId 未知时静默跳过）
      if (savedAssistant) this.reportRunPersisted();
    } finally {
      this.cancelCandidateFrame();
      if (this.checkpointTimer !== undefined) window.clearTimeout(this.checkpointTimer);
      const checkpointCallbacks = { ...this.deps.registries.checkpointTriggers.current };
      delete checkpointCallbacks[this.input.sessionId];
      this.deps.registries.checkpointTriggers.current = checkpointCallbacks;
      off();
      this.deps.registries.eventUnsubscribers.current.delete(off);
      const currentActive = this.deps.registries.activeRuns.current[this.input.sessionId];
      this.deps.registries.cancelRequestedSessions.current.delete(this.input.sessionId);
      if (currentActive?.assistantId === this.input.assistantId) {
        const nextActive = { ...this.deps.registries.activeRuns.current };
        delete nextActive[this.input.sessionId];
        this.deps.registries.activeRuns.current = nextActive;
      }
      this.deps.host.setModeBusy(this.input.targetMode, false);
      // queuePaused：run 从未被主进程接受（启动失败/守卫冲突挂起接管），
      // 该会话的认领消息尚未派发成功——宿主必须暂停队列消费，先恢复认领再说。
      this.deps.host.onRunFinished({
        mode: this.input.targetMode,
        sessionId: this.input.sessionId,
        queuePaused: !this.runAccepted,
      });
    }
  }

  /** 落盘确认：终态快照写入会话存储后上报主进程，是插件桌面轮次结束事件发布的双条件之一。 */
  private reportRunPersisted(): void {
    const runId = this.deps.registries.activeRuns.current[this.input.sessionId]?.runId;
    if (runId) this.deps.api?.reportRunPersisted?.({ runId, finalMessageId: this.input.assistantId });
  }

  /** Card actions from the user and card presentation events share this run-local source of truth. */
  updateEmailDraftCard(card: MailDraftCardData): void {
    const existing = this.emailDraftCards.findIndex((item) => item.id === card.id);
    this.emailDraftCards = existing < 0
      ? [...this.emailDraftCards, card]
      : this.emailDraftCards.map((item, index) => index === existing ? card : item);
    this.deps.host.patchMessage(this.input.sessionId, this.input.assistantId, { emailDraftCards: this.emailDraftCards });
    void this.checkpointRun(this.terminalStatus ? "terminal" : "running", true);
  }

  /** 构建当前内存展示状态；写入时只提交相对上次成功检查点的差量。 */
  private buildCheckpoint(status: "running" | "waiting_user" | "terminal"): ChatMessage {
    return {
      id: this.input.assistantId,
      role: "model",
      content: status === "terminal" ? this.persistedFinalContent : "",
      reasoning: this.reasoningContent || undefined,
      reasoningBlocks: this.reasoningBlocks,
      processMessages: this.processMessages,
      agentRounds: this.agentRounds,
      taskDelegations: this.taskDelegations,
      runActivity: this.runActivity,
      at: this.assistantAt,
      sticker: this.sticker,
      toolExecutions: this.toolExecutions,
      emailDraftCards: this.emailDraftCards,
      contextUsage: this.contextUsage,
      runSnapshot: {
        ...(this.deps.registries.activeRuns.current[this.input.sessionId]?.runId
          ? { runId: this.deps.registries.activeRuns.current[this.input.sessionId]?.runId }
          : {}),
        status,
        ...(status === "terminal" && this.terminalStatus
          ? { terminalStatus: this.terminalStatus as "success" | "cancelled" | "timeout" | "runtime_error" }
          : {}),
        updatedAt: Date.now(),
      },
    };
  }

  /** 把展示差量写入会话轨迹；幂等键短小，串行顺序沿用 run 内事件顺序。 */
  private writeCheckpoint(status: "running" | "waiting_user" | "terminal"): Promise<boolean> {
    const snapshot = this.buildCheckpoint(status);
    this.checkpointChain = this.checkpointChain
      .catch((error) => {
        console.error("[AgentRunController] prior presentation checkpoint failed:", error);
        return false;
      })
      .then(async () => {
        const previous = this.persistedCheckpoint?.id === snapshot.id ? this.persistedCheckpoint : undefined;
        const patch = buildPresentationCheckpointPatch(previous, snapshot, status);
        if (!patch) {
          this.persistedCheckpoint = snapshot;
          return true;
        }
        const mutationKey = `run:${snapshot.id}:${this.checkpointRunToken}:p${++this.checkpointMutationSequence}`;
        try {
          const result = await this.deps.store!.checkpointPresentation(
            this.input.sessionId,
            snapshot.id,
            mutationKey,
            patch,
          );
          if (!result.ok) throw new Error(result.error);
          this.persistedCheckpoint = snapshot;
          return true;
        } catch (error) {
          console.error("[AgentRunController] presentation checkpoint failed:", error);
          return false;
        }
      });
    return this.checkpointChain;
  }

  /**
   * 检查点写入（带 350ms 合并）：immediate 为 true 时立即写，
   * 否则合并短时间内的多次请求，减少落盘频率。
   */
  private checkpointRun(
    status: "running" | "waiting_user" | "terminal",
    immediate = false,
  ): Promise<boolean> {
    if (this.checkpointTimer !== undefined) {
      window.clearTimeout(this.checkpointTimer);
      this.checkpointTimer = undefined;
    }
    if (immediate) return this.writeCheckpoint(status);
    this.checkpointTimer = window.setTimeout(() => {
      this.checkpointTimer = undefined;
      void this.writeCheckpoint(status);
    }, 350);
    return this.checkpointChain;
  }

  /** 更新（或新建）一条工具执行记录并同步到消息视图。 */
  private updateRunTool(toolId: string, patch: Partial<ToolExecutionRecord>) {
    const definedPatch = Object.fromEntries(
      Object.entries(patch).filter(([, value]) => value !== undefined),
    ) as Partial<ToolExecutionRecord>;
    const index = this.toolExecutions.findIndex((tool) => tool.id === toolId);
    this.toolExecutions = index === -1
      ? [...this.toolExecutions, {
          id: toolId,
          name: definedPatch.name ?? t("chatPage.toolCallFallbackName"),
          ...(definedPatch.displayName !== undefined ? { displayName: definedPatch.displayName } : {}),
          status: definedPatch.status ?? "running",
          ...(definedPatch.result !== undefined ? { result: definedPatch.result } : {}),
          ...(definedPatch.argsText !== undefined ? { argsText: definedPatch.argsText } : {}),
          ...(definedPatch.changes !== undefined ? { changes: definedPatch.changes } : {}),
          ...((definedPatch.roundId ?? this.activeRoundId) !== undefined ? { roundId: definedPatch.roundId ?? this.activeRoundId } : {}),
          seq: this.nextSeq(),
        }]
      : this.toolExecutions.map((tool, toolIndex) => toolIndex === index ? { ...tool, ...definedPatch } : tool);
    this.deps.host.patchMessage(this.input.sessionId, this.input.assistantId, { toolExecutions: this.toolExecutions });
  }

  /**
   * 公开正文渐显：chat 模式直接整段发布；
   * 其他模式按 chunk 串到渐显链上，等待前置内容展示完毕。
   */
  private enqueuePublicTextReveal(content: string, publish: (chunk: string) => void) {
    if (this.input.targetMode === "chat") {
      publish(content);
      return;
    }
    this.revealChain = this.revealChain.then(async () => {
      for (const chunk of splitTextForReveal(content)) {
        if (this.revealCancelled) break;
        publish(chunk);
        await new Promise<void>((resolve) => window.setTimeout(resolve, 14));
      }
    });
  }

  private publishCandidateChunk(chunk: string): void {
    if (!chunk) return;
    this.candidateVisibleText += chunk;
    this.deps.host.patchMessage(this.input.sessionId, this.input.assistantId, {
      transientText: this.candidateVisibleText,
      loading: false,
      waitingForFirstEvent: false,
      streaming: true,
      responseStarted: true,
      // 终态已定：后面几帧只是把正文补完，不能再把阶段退回「组织回复」，
      // 否则回复都出完了，面板头还挂着"昔涟正在组织回复…"。
      ...(this.terminalStage ? {} : { runStage: { kind: "responding" } as AgentRunStage }),
    });
  }

  private ensureCandidateDrainTracked(): void {
    if (this.candidateDrainResolve || !this.candidateRevealQueue.hasPending) return;
    const drain = new Promise<void>((resolve) => {
      this.candidateDrainResolve = resolve;
    });
    this.revealChain = this.revealChain.then(() => drain);
  }

  private completeCandidateDrain(): void {
    const resolve = this.candidateDrainResolve;
    this.candidateDrainResolve = undefined;
    this.candidateLastFrameAt = undefined;
    resolve?.();
  }

  private appendCandidateDelta(delta: string): void {
    const immediate = this.candidateRevealQueue.push(delta);
    const reduceMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
    if (reduceMotion) {
      this.publishCandidateChunk(immediate + this.candidateRevealQueue.drain());
      this.completeCandidateDrain();
      return;
    }
    this.publishCandidateChunk(immediate);
    if (!this.candidateRevealQueue.hasPending) {
      this.completeCandidateDrain();
      return;
    }
    this.ensureCandidateDrainTracked();
    this.scheduleCandidateFrame();
  }

  private scheduleCandidateFrame(): void {
    if (this.candidateFrameId !== undefined || !this.candidateRevealQueue.hasPending) return;
    if (this.candidateLastFrameAt === undefined) this.candidateLastFrameAt = performance.now();
    this.candidateFrameUsesRaf = Boolean(window.requestAnimationFrame);
    const schedule = window.requestAnimationFrame?.bind(window)
      ?? ((callback: FrameRequestCallback) => window.setTimeout(() => callback(performance.now()), SMOOTH_REVEAL_TICK_MS));
    this.candidateFrameId = schedule((timestamp) => {
      this.candidateFrameId = undefined;
      if (!this.candidateRevealQueue.hasPending) {
        this.completeCandidateDrain();
        return;
      }
      const elapsed = Math.max(0, timestamp - (this.candidateLastFrameAt ?? timestamp));
      if (elapsed >= SMOOTH_REVEAL_TICK_MS) {
        this.candidateLastFrameAt = timestamp;
        this.publishCandidateChunk(this.candidateRevealQueue.takeNext(Math.min(elapsed, 160)));
      }
      if (this.candidateRevealQueue.hasPending) this.scheduleCandidateFrame();
      else this.completeCandidateDrain();
    });
  }

  private cancelCandidateFrame(): void {
    if (this.candidateFrameId === undefined) return;
    if (this.candidateFrameUsesRaf && window.cancelAnimationFrame) window.cancelAnimationFrame(this.candidateFrameId);
    else window.clearTimeout(this.candidateFrameId);
    this.candidateFrameId = undefined;
  }

  private abortCandidateReveal(): void {
    this.cancelCandidateFrame();
    this.candidateRevealQueue.clear();
    this.completeCandidateDrain();
  }

  private resetCandidateState(): void {
    this.abortCandidateReveal();
    this.candidateRoundId = undefined;
    this.candidateText = "";
    this.candidateVisibleText = "";
    this.candidateSeq = undefined;
  }

  private commitPendingCandidateClassification(): void {
    const pending = this.pendingCandidateClassification;
    if (!pending) return;
    this.pendingCandidateClassification = undefined;
    this.processMessages = this.processMessages.map((message) => message.id === pending.processId
      ? { ...message, content: pending.content }
      : message);
    this.resetCandidateState();
    this.deps.host.patchMessage(this.input.sessionId, this.input.assistantId, {
      transientText: undefined,
      streaming: false,
      responseStarted: false,
      processMessages: this.processMessages,
    });
    void this.checkpointRun("running");
  }

  private scheduleCandidateClassification(
    content: string,
    roundId = this.candidateRoundId ?? this.activeRoundId,
    seq = this.candidateSeq,
  ): void {
    if (this.pendingCandidateClassification) {
      this.pendingCandidateClassification.content = content;
      return;
    }
    const processId = `process-${this.processMessageSequence++}`;
    this.processMessages = [...this.processMessages, createRoundProcessMessage(
      processId,
      "",
      this.toolExecutions.length,
      roundId,
      seq,
    )];
    this.pendingCandidateClassification = { processId, content };
    this.revealChain = this.revealChain.then(() => {
      this.commitPendingCandidateClassification();
    });
  }

  /** 领取下一个时间线序号（run 内单调递增）。 */
  private nextSeq(): number {
    return this.eventSequence++;
  }

  /**
   * 闭合当前轮的候选正文：append 为一条过程消息（带 roundId + seq），
   * 内容保留显示——数据进 processMessages 不等于视觉进折叠区，
   * 运行中渲染层照样把它平铺在展开区。
   */
  private closeRoundCandidateText(): void {
    if (this.pendingCandidateClassification) return;
    if (!this.candidateText.trim()) {
      this.resetCandidateState();
      return;
    }
    // 候选正文降级为过程消息：清掉已切未播的句子与半句缓冲（正在播的不打断）
    this.earlyTtsQueue?.dropPending();
    this.scheduleCandidateClassification(this.candidateText);
  }

  private moveCandidateToInterruptedProcess(): void {
    const pending = this.pendingCandidateClassification;
    if (pending) {
      this.pendingCandidateClassification = undefined;
      this.processMessages = this.processMessages.map((message) => message.id === pending.processId
        ? { ...message, content: pending.content, interrupted: true }
        : message);
      this.resetCandidateState();
      return;
    }
    if (!this.candidateText.trim()) {
      this.resetCandidateState();
      return;
    }
    this.processMessages = [...this.processMessages, {
      id: `process-${this.processMessageSequence++}`,
      content: this.candidateText,
      interrupted: true,
      afterToolCount: this.toolExecutions.length,
      ...(this.candidateRoundId !== undefined ? { roundId: this.candidateRoundId } : {}),
      ...(this.candidateSeq !== undefined ? { seq: this.candidateSeq } : {}),
    }];
    this.resetCandidateState();
  }

  /** 把运行活动统计发布到消息视图。 */
  private publishRunActivity() {
    if (!this.runActivity) return;
    this.deps.host.patchMessage(this.input.sessionId, this.input.assistantId, { runActivity: { ...this.runActivity } });
  }

  /** 根据仍在进行的推理段落刷新「推理开始时间」汇总。 */
  private updateActiveReasoningStart() {
    const starts = [...this.activeReasoningStarts.values()];
    if (!this.runActivity) return;
    const { activeReasoningStartedAt: _activeReasoningStartedAt, ...base } = this.runActivity;
    this.runActivity = starts.length
      ? { ...base, activeReasoningStartedAt: Math.min(...starts) }
      : base;
  }

  /** 结算运行活动统计：把未关闭的推理段落计入耗时并标记完成。 */
  private completeRunActivity(keepExpanded = false) {
    if (!this.runActivity || this.runActivity.completedAt === undefined) {
      const completedAt = Date.now();
      for (const startedAt of this.activeReasoningStarts.values()) {
        this.runActivity = {
          ...(this.runActivity ?? { startedAt: completedAt, reasoningMs: 0 }),
          reasoningMs: (this.runActivity?.reasoningMs ?? 0) + Math.max(0, completedAt - startedAt),
        };
      }
      this.activeReasoningStarts.clear();
      this.updateActiveReasoningStart();
      this.runActivity = {
        ...(this.runActivity ?? { startedAt: completedAt, reasoningMs: 0 }),
        completedAt,
        keepExpanded,
      };
      this.publishRunActivity();
    }
  }

  /** 首个可视事件到达：关闭「等待首个事件」占位。 */
  private markFirstResponse() {
    this.deps.host.patchMessage(this.input.sessionId, this.input.assistantId, { waitingForFirstEvent: false });
  }

  /** 更新（或新建）一个推理块，并同步拼接后的推理全文。 */
  private updateReasoningBlock(id: string, patch: Partial<ReasoningBlock>) {
    const index = this.reasoningBlocks.findIndex((block) => block.id === id);
    this.reasoningBlocks = index < 0
      ? [...this.reasoningBlocks, {
          id,
          content: "",
          afterToolCount: this.toolExecutions.length,
          ...(this.activeRoundId !== undefined ? { roundId: this.activeRoundId } : {}),
          seq: this.nextSeq(),
          ...patch,
        }]
      : this.reasoningBlocks.map((block, blockIndex) => blockIndex === index ? { ...block, ...patch } : block);
    this.reasoningContent = this.reasoningBlocks.map((block) => block.content).filter(Boolean).join("\n\n");
    this.deps.host.patchMessage(this.input.sessionId, this.input.assistantId, {
      reasoning: this.reasoningContent || undefined,
      reasoningBlocks: this.reasoningBlocks,
    });
    void this.checkpointRun("running");
  }

  private handleEvent(event: AguiEvent): void {
    if (event.type === "CUSTOM" && event.name === "cyrene.run.adjustment") {
      this.eventChain = (this.eventChain ?? Promise.resolve()).then(async () => {
        await this.revealChain;
        await this.beginAdjustmentSegment(event.value);
      });
    } else if (this.eventChain) {
      this.eventChain = this.eventChain.then(() => this.reduceEvent(event));
    } else this.reduceEvent(event);
    // 展示处理异常不能让终态 promise 永久悬挂。
    if (this.eventChain) this.eventChain = this.eventChain.catch((error) => {
      this.resolveTerminal(error instanceof Error ? error : new Error(String(error)));
    });
  }

  private async beginAdjustmentSegment(value: unknown): Promise<void> {
    const adjustment = value as { messages?: unknown; assistantMessageId?: unknown } | null;
    if (!adjustment || typeof adjustment.assistantMessageId !== "string" || !adjustment.assistantMessageId
      || !Array.isArray(adjustment.messages) || !adjustment.messages.length
      || adjustment.assistantMessageId === this.input.assistantId) return;
    const users: ChatMessageItem[] = adjustment.messages.flatMap((entry) => {
      const item = entry as { id?: unknown; rawContent?: unknown; userMessage?: ChatMessage } | null;
      if (!item || typeof item.id !== "string" || typeof item.rawContent !== "string") return [];
      const user = item.userMessage;
      return [{ id: item.id, role: "user" as const, content: user?.content ?? item.rawContent,
        ...(user?.sticker ? { sticker: user.sticker } : {}), ...(user?.at ? { at: user.at } : {}) }];
    });
    if (!users.length || !this.deps.host.appendMessages) return;
    this.publishCandidateChunk(this.candidateRevealQueue.drain());
    this.completeCandidateDrain();
    this.commitPendingCandidateClassification();
    this.closeRoundCandidateText();
    this.publishCandidateChunk(this.candidateRevealQueue.drain());
    this.completeCandidateDrain();
    this.commitPendingCandidateClassification();
    this.cancelCandidateFrame();
    this.resetCandidateState();
    this.completeRunActivity();
    this.deps.host.patchMessage(this.input.sessionId, this.input.assistantId, {
      loading: false, waitingForFirstEvent: false, streaming: false, reasoningStreaming: false,
      transientText: undefined, runStage: { kind: "completed" },
    });
    // 封存插话前的内容，但保留整个运行的起点和累计推理时间。
    // 先捕获旧消息检查点，再同步追加后续片段，避免界面短暂显示为已完成。
    const previousCheckpoint = this.checkpointRun("terminal", true);
    if (this.runActivity) {
      const { completedAt: _completedAt, keepExpanded: _keepExpanded, ...ongoing } = this.runActivity;
      this.runActivity = ongoing;
    }
    this.earlyTtsQueue?.cancel();
    const previousId = this.input.assistantId;
    this.input.assistantId = adjustment.assistantMessageId;
    this.streamContent = "";
    this.reasoningContent = "";
    this.reasoningBlocks = [];
    this.processMessages = [];
    this.agentRounds = [];
    this.taskDelegations = [];
    this.activeRoundId = undefined;
    this.processMessageSequence = 0;
    this.eventSequence = 0;
    this.finalMessageCompleted = false;
    this.currentReasoningId = undefined;
    this.persistedFinalContent = "";
    this.toolExecutions = [];
    this.emailDraftCards = [];
    this.generatedImageAttachments = [];
    this.sticker = null;
    this.assistantAt = Date.now();
    const active = this.deps.registries.activeRuns.current[this.input.sessionId];
    this.deps.registries.activeRuns.current = { ...this.deps.registries.activeRuns.current,
      [this.input.sessionId]: { ...(active ?? { mode: this.input.targetMode }), assistantId: this.input.assistantId } };
    this.deps.host.appendMessages(this.input.sessionId, [...users, {
      id: this.input.assistantId, role: "assistant", content: "", loading: true,
      waitingForFirstEvent: true, streaming: false, responseStarted: false, runId: active?.runId,
      runActivity: this.runActivity ? { ...this.runActivity } : undefined,
      runStage: { kind: "understanding" },
    }]);
    this.deps.host.onAssistantSegment?.(previousId, this.input.assistantId);
    this.earlyTtsQueue = this.deps.host.earlyTts.start(
      this.input.targetMode, this.input.sessionId, this.input.assistantId, this.earlyTtsSplitMode,
    );
    await previousCheckpoint;
    await this.checkpointRun("running", true);
  }

  /** AG-UI 事件归约：流式内容、推理、工具、交互卡与终态全部在此处理。 */
  private reduceEvent(event: AguiEvent) {
    if (event.type === "CUSTOM" && event.name === "cyrene.mail_draft_card") {
      const card = normalizeMailDraftCardData((event.value as { card?: unknown } | null | undefined)?.card);
      if (!card) return;
      this.updateEmailDraftCard(card);
      return;
    } else if (event.type === "CUSTOM" && event.name === "cyrene.image_attachments") {
      const value = event.value as { messageId?: unknown; attachments?: unknown } | null | undefined;
      if (value?.messageId !== this.input.assistantId || !Array.isArray(value.attachments)) return;
      const attachments = value.attachments.filter(isGeneratedImageAttachment);
      if (attachments.length === 0) return;
      this.generatedImageAttachments = mergeGeneratedImageAttachments(this.generatedImageAttachments, attachments);
      this.deps.host.patchMessage(this.input.sessionId, this.input.assistantId, {
        attachments: this.generatedImageAttachments,
        waitingForFirstEvent: false,
      });
      return;
    } else if (event.type === "CUSTOM" && event.name === "cyrene.round") {
      const value = event.value as { action?: unknown; roundId?: unknown } | null | undefined;
      if ((value?.action === "start" || value?.action === "end") && typeof value.roundId === "string") {
        // 新轮开始：防御性闭合上一轮候选正文（不依赖 progress_text / discard 事件到达）
        if (value.action === "start" && value.roundId !== this.candidateRoundId) {
          this.closeRoundCandidateText();
        }
        const next = applyAgentRoundBoundary(
          { rounds: this.agentRounds, activeRoundId: this.activeRoundId },
          value.action,
          value.roundId,
        );
        this.agentRounds = next.rounds;
        this.activeRoundId = next.activeRoundId;
        this.deps.host.patchMessage(this.input.sessionId, this.input.assistantId, { agentRounds: this.agentRounds });
        void this.checkpointRun("running", true);
      }
    } else if (event.type === "CUSTOM" && event.name === "cyrene.candidate_text") {
      const value = event.value as Partial<CandidateTextEventValue> | null | undefined;
      if (typeof value?.roundId !== "string" || value.roundId !== this.activeRoundId) return;
      if (value.action === "delta" && typeof value.delta === "string" && value.delta) {
        if (this.candidateRoundId !== value.roundId) {
          if (this.pendingCandidateClassification) {
            this.publishCandidateChunk(this.candidateRevealQueue.drain());
            this.completeCandidateDrain();
            this.commitPendingCandidateClassification();
          }
          this.resetCandidateState();
          this.candidateRoundId = value.roundId;
          // 候选正文开始流式：领取时间线序号，轮闭合转过程消息时沿用
          this.candidateSeq = this.nextSeq();
        }
        this.candidateText += value.delta;
        this.appendCandidateDelta(value.delta);
        // 流式正文直接喂早播队列：边生成边切句合成，超长回复首句无需等 run 结束
        this.earlyTtsQueue?.append(value.delta);
      } else if (value.action === "discard") {
        // discard 是历史协议名：语义是「该轮正文不再是候选」，内容保留为过程消息
        this.closeRoundCandidateText();
      }
    } else if (event.type === "RUN_STARTED") {
      this.runStarted = true;
      this.runActivity = { startedAt: Date.now(), reasoningMs: 0 };
      if (event.runId) {
        // RUN_STARTED.runId 必须与 ack.runId 一致（由 bridge 注入 options.runId 保证）。
        // 不一致时只 warn 不重写，避免渲染端拿到错误 runId 后无法 cancel。
        const existing = this.deps.registries.activeRuns.current[this.input.sessionId];
        if (existing?.runId && existing.runId !== event.runId) {
          console.warn(
            `[AgentRunController] RUN_STARTED.runId (${event.runId}) 与 ack.runId (${existing.runId}) 不一致，` +
            `请检查 bridge 是否正确注入 options.runId。保留 ack.runId 作为权威值。`,
          );
        } else {
          this.deps.registries.activeRuns.current = {
            ...this.deps.registries.activeRuns.current,
            [this.input.sessionId]: { ...(existing ?? { assistantId: this.input.assistantId, mode: this.input.targetMode }), runId: event.runId },
          };
        }
      }
      this.currentTodos = [];
      const startedRunId = event.runId ?? this.deps.registries.activeRuns.current[this.input.sessionId]?.runId;
      this.deps.host.updateTodos(this.input.sessionId, (current) => startSessionTodos(current, this.input.sessionId, startedRunId));
      this.deps.host.patchMessage(this.input.sessionId, this.input.assistantId, {
        waitingForFirstEvent: false,
        runActivity: { ...this.runActivity },
        runStage: { kind: "understanding" },
        runId: startedRunId,
      });
      void this.checkpointRun("running", true);
      return;
    }
    if (!this.runStarted) return;
    if (
      event.type === "REASONING_MESSAGE_START"
      || event.type === "REASONING_MESSAGE_CONTENT"
      || event.type === "REASONING_MESSAGE_END"
      || event.type === "TOOL_CALL_START"
      || event.type === "TOOL_CALL_RESULT"
      || event.type === "TOOL_CALL_END"
      || event.type === "TEXT_MESSAGE_START"
      || event.type === "TEXT_MESSAGE_CONTENT"
      || event.type === "TEXT_MESSAGE_END"
      || event.type === "CUSTOM"
    ) this.markFirstResponse();
    if (event.type === "REASONING_MESSAGE_START") {
      const reasoningId = event.messageId ?? crypto.randomUUID();
      this.currentReasoningId = reasoningId;
      this.activeReasoningStarts.set(reasoningId, Date.now());
      this.updateActiveReasoningStart();
      this.publishRunActivity();
      this.updateReasoningBlock(reasoningId, { streaming: true });
      this.deps.host.patchMessage(this.input.sessionId, this.input.assistantId, {
        loading: false,
        reasoningStreaming: true,
        runStage: { kind: "responding" },
      });
    } else if (event.type === "REASONING_MESSAGE_CONTENT" && event.delta) {
      const reasoningId = event.messageId ?? this.currentReasoningId ?? crypto.randomUUID();
      this.currentReasoningId = reasoningId;
      const current = this.reasoningBlocks.find((block) => block.id === reasoningId)?.content ?? "";
      this.updateReasoningBlock(reasoningId, { content: current + event.delta, streaming: true });
      this.deps.host.patchMessage(this.input.sessionId, this.input.assistantId, {
        reasoning: this.reasoningContent,
        loading: false,
        reasoningStreaming: true,
      });
    } else if (event.type === "REASONING_MESSAGE_END") {
      const reasoningId = event.messageId ?? this.currentReasoningId;
      if (reasoningId) {
        const startedAt = this.activeReasoningStarts.get(reasoningId);
        if (startedAt && this.runActivity) {
          this.runActivity = {
            ...this.runActivity,
            reasoningMs: this.runActivity.reasoningMs + Math.max(0, Date.now() - startedAt),
          };
        }
        this.activeReasoningStarts.delete(reasoningId);
        this.updateActiveReasoningStart();
        this.publishRunActivity();
        this.updateReasoningBlock(reasoningId, { streaming: false });
      }
      this.currentReasoningId = undefined;
      this.deps.host.patchMessage(this.input.sessionId, this.input.assistantId, { reasoningStreaming: false, loading: false });
    } else if (event.type === "STEP_STARTED") {
      const stage = stageForStep(event.stepName);
      if (stage) this.deps.host.patchMessage(this.input.sessionId, this.input.assistantId, { runStage: stage });
    } else if (event.type === "TOOL_CALL_START" && event.toolCallId) {
      // 中文名优先（主进程注册表携带）；缺失时回退英文 ID
      const displayToolName = event.toolCallDisplayName ?? event.toolCallName ?? t("chatPage.toolCallFallbackName");
      this.updateRunTool(event.toolCallId, {
        name: event.toolCallName ?? t("chatPage.toolCallFallbackName"),
        displayName: event.toolCallDisplayName,
        status: "running",
        roundId: this.activeRoundId,
      });
      this.deps.host.patchMessage(this.input.sessionId, this.input.assistantId, {
        runStage: { kind: "executing", detail: displayToolName },
      });
    } else if (event.type === "TOOL_CALL_ARGS" && event.toolCallId && event.delta) {
      const currentArgs = this.toolExecutions.find((tool) => tool.id === event.toolCallId)?.argsText ?? "";
      this.updateRunTool(event.toolCallId, { argsText: currentArgs + event.delta, roundId: this.activeRoundId });
    } else if (event.type === "TOOL_CALL_RESULT" && event.toolCallId) {
      this.updateRunTool(event.toolCallId, {
        status: event.status === "failed" ? "error" : "success",
        result: (event.content ?? "").slice(0, 4000),
        changes: event.changes,
      });
      void this.checkpointRun("running", true);
    } else if (event.type === "TOOL_CALL_END" && event.toolCallId) {
      this.updateRunTool(event.toolCallId, {});
    } else if (event.type === "CUSTOM" && event.name === "cyrene.tool_output") {
      const output = normalizeShellOutputEvent(event.value);
      const tool = output && this.toolExecutions.find((item) => item.id === output.toolCallId);
      if (output && tool?.name === "run_shell" && tool.status === "running") {
        const visible = applyVisibleOutput(tool.terminalOutput ?? "", output, tool.terminalOutputTruncated);
        this.updateRunTool(tool.id, {
          terminalOutput: visible.text,
          terminalOutputTruncated: visible.truncated,
        });
        void this.checkpointRun("running");
      }
    } else if (event.type === "TEXT_MESSAGE_START") {
      this.deps.host.patchMessage(this.input.sessionId, this.input.assistantId, {
        loading: false,
        reasoningStreaming: false,
        responseStarted: true,
        streaming: true,
        runStage: { kind: "responding" },
      });
    } else if (event.type === "TEXT_MESSAGE_CONTENT" && event.delta) {
      if (this.candidateText) {
        this.streamContent += event.delta;
      } else {
        this.enqueuePublicTextReveal(event.delta, (chunk) => {
          this.streamContent += chunk;
          this.earlyTtsQueue?.append(chunk);
          this.deps.host.patchMessage(this.input.sessionId, this.input.assistantId, {
            content: this.streamContent,
            loading: false,
            streaming: true,
            responseStarted: true,
          });
          void this.checkpointRun("running");
        });
      }
    } else if (event.type === "TEXT_MESSAGE_END") {
      if (this.candidateText) {
        this.finalMessageCompleted = true;
      } else {
        this.revealChain = this.revealChain.then(() => {
          this.finalMessageCompleted = true;
          this.deps.host.patchMessage(this.input.sessionId, this.input.assistantId, { streaming: false });
        });
      }
    } else if (event.type === "CUSTOM" && event.name === "cyrene.process_text") {
      const content = (event.value as { content?: unknown } | null | undefined)?.content;
      if (typeof content === "string" && content.trim()) {
        const replacesCandidate = Boolean(this.candidateText);
        // 权威全文替换候选：沿用候选开始时的时间线序号，正文保持在同轮工具之前
        const processSeq = replacesCandidate ? this.candidateSeq : this.nextSeq();
        if (replacesCandidate) {
          // 候选正文被权威全文降级替换：清掉已切未播的句子与半句缓冲
          this.earlyTtsQueue?.dropPending();
          this.scheduleCandidateClassification(content, this.candidateRoundId ?? this.activeRoundId, processSeq);
        } else {
          const processId = `process-${this.processMessageSequence++}`;
          this.processMessages = [...this.processMessages, createRoundProcessMessage(
            processId,
            "",
            this.toolExecutions.length,
            this.activeRoundId,
            processSeq,
          )];
          this.deps.host.patchMessage(this.input.sessionId, this.input.assistantId, { processMessages: this.processMessages });
          this.enqueuePublicTextReveal(content, (chunk) => {
            this.processMessages = this.processMessages.map((message) => message.id === processId
              ? { ...message, content: message.content + chunk }
              : message);
            this.deps.host.patchMessage(this.input.sessionId, this.input.assistantId, { processMessages: this.processMessages });
            void this.checkpointRun("running");
          });
        }
      }
    } else if (event.type === "CUSTOM" && event.name === "cyrene.task") {
      const delegation = normalizeTaskDelegationEvent(event.value);
      if (delegation) {
        this.taskDelegations = applyTaskDelegationEvent(this.taskDelegations, delegation, this.activeRoundId);
        this.deps.host.patchMessage(this.input.sessionId, this.input.assistantId, {
          taskDelegations: this.taskDelegations,
          runStage: { kind: "executing", detail: getCharacterName(delegation.nickname) },
        });
        void this.checkpointRun("running", true);
      }
    } else if (event.type === "CUSTOM" && event.name === "cyrene.choice") {
      const interaction = normalizeChoiceInteraction(event.value);
      if (interaction) {
        this.deps.host.setInteraction(this.input.sessionId, interaction);
        this.deps.host.patchMessage(this.input.sessionId, this.input.assistantId, { runStage: { kind: "waiting_user" } });
        void this.checkpointRun("waiting_user", true);
      }
    } else if (event.type === "CUSTOM" && event.name === "cyrene.choice.dismiss") {
      this.deps.host.dismissAskIfMatched(this.input.sessionId, event.value);
      void this.checkpointRun("running", true);
    } else if (event.type === "CUSTOM" && event.name === "cyrene.plan.review") {
      // submit_plan 交卷：计划全文经 run 内事件链到达，载入面板供用户在审批等待期间审阅。
      const value = event.value as { sessionId?: unknown; planPath?: unknown; planContent?: unknown } | null | undefined;
      if (
        typeof value?.sessionId === "string" && value.sessionId === this.input.sessionId
        && typeof value.planContent === "string" && value.planContent.trim()
      ) {
        this.deps.host.updatePlanReview(this.input.sessionId, {
          kind: "submitted",
          planContent: value.planContent,
          planPath: typeof value.planPath === "string" ? value.planPath : "",
        });
      }
    } else if (event.type === "CUSTOM" && event.name === "cyrene.plan.completed") {
      // 执行收尾通知（completePlanRun 在 run 内发出，不带 sessionId）：面板阶段标记为已完成。
      this.deps.host.updatePlanReview(this.input.sessionId, { kind: "completed" });
    } else if (event.type === "CUSTOM" && event.name === "cyrene.taskPlan") {
      const taskPlan = normalizeTaskPlanPresentation(event.value);
      if (taskPlan) {
        this.deps.host.patchMessage(this.input.sessionId, this.input.assistantId, {
          taskPlan,
          runStage: { kind: "executing" },
        });
      }
    } else if (event.type === "CUSTOM" && event.name === "cyrene.todo") {
      // Harness 的 Todo 复用右侧现有 TodoPanel，不再复制成消息内 TaskPlanCard。
      const items = (event.value as { items?: Array<{ id: string; content: string; status: string }> } | null | undefined)?.items;
      if (Array.isArray(items)) {
        const ownerRunId = event.runId ?? this.deps.registries.activeRuns.current[this.input.sessionId]?.runId;
        const normalized = mergeHarnessTodosForSession({
          [this.input.sessionId]: {
            runId: ownerRunId,
            todos: this.currentTodos,
            updatedAt: Date.now(),
          },
        }, this.input.sessionId, ownerRunId, items);
        this.currentTodos = normalized[this.input.sessionId]?.todos ?? this.currentTodos;
        this.deps.host.updateTodos(this.input.sessionId, (current) => mergeHarnessTodosForSession(
          current,
          this.input.sessionId,
          ownerRunId,
          items,
        ));
        void this.checkpointRun("running", true);
      }
    } else if (event.type === "CUSTOM" && event.name === "cyrene.context.usage") {
      // 上下文容量快照：preRequest 纯内存实时刷新（零 I/O）；
      // terminal 用 debounce 版 checkpointRun，合并进紧随其后的 RUN_FINISHED terminal checkpoint，一次落盘。
      const snapshot = isContextUsageSnapshot(event.value) ? event.value : undefined;
      if (snapshot) {
        this.contextUsage = snapshot;
        this.deps.host.patchMessage(this.input.sessionId, this.input.assistantId, { contextUsage: snapshot });
        // session 级状态同步刷新：环形图优先读取点，手动压缩等场景不再依赖消息级兜底。
        this.deps.host.updateContextUsage(this.input.sessionId, snapshot);
        if (snapshot.phase === "terminal") void this.checkpointRun("running");
      }
    } else if (event.type === "CUSTOM" && event.name === "cyrene.model.retry") {
      const status = normalizeModelRetryStatus(event.value);
      this.deps.host.patchMessage(this.input.sessionId, this.input.assistantId, {
        modelRetry: status?.phase === "cleared" ? null : status,
      });
    } else if (event.type === "CUSTOM" && event.name === "cyrene.sticker") {
      this.sticker = typeof event.value === "string" ? event.value : null;
      this.deps.host.patchMessage(this.input.sessionId, this.input.assistantId, { sticker: this.sticker });
    } else if (event.type === "RUN_FINISHED") {
      this.deps.host.patchMessage(this.input.sessionId, this.input.assistantId, { modelRetry: null });
      // 读取 result.status 区分终态（success / cancelled / timeout / runtime_error）
      const result = (event as { result?: { status?: string } }).result;
      this.terminalStatus = result?.status;
      if (this.terminalStatus !== "success") {
        this.revealCancelled = true;
        this.abortCandidateReveal();
      }
      const stage = resolveRunFinishedStage(result);
      this.terminalStage = stage;
      this.deps.host.patchMessage(this.input.sessionId, this.input.assistantId, { runStage: stage });
      const activeRunId = this.deps.registries.activeRuns.current[this.input.sessionId]?.runId;
      if (shouldClearComposerInteractionForTerminal(activeRunId, event.runId)) {
        this.deps.host.clearInteraction(this.input.sessionId);
      }
      this.resolveTerminal();
    } else if (event.type === "RUN_ERROR") {
      this.deps.host.patchMessage(this.input.sessionId, this.input.assistantId, { modelRetry: null });
      this.revealCancelled = true;
      this.abortCandidateReveal();
      this.completeRunActivity(true);
      this.terminalStage = { kind: "failed" };
      const modelFailure = event.metadata?.cyreneModelFailure;
      if (isModelFailureInfo(modelFailure)) this.deps.host.setMainModelFailure?.(this.input.sessionId, modelFailure);
      this.deps.host.patchMessage(this.input.sessionId, this.input.assistantId, { runStage: this.terminalStage });
      const activeRunId = this.deps.registries.activeRuns.current[this.input.sessionId]?.runId;
      if (shouldClearComposerInteractionForTerminal(activeRunId, event.runId)) {
        this.deps.host.clearInteraction(this.input.sessionId);
      }
      this.resolveTerminal(new Error(event.message ?? event.error ?? event.content ?? t("chatPage.errorModelRequestFailed")));
    }
  }
}

function isGeneratedImageAttachment(value: unknown): value is GeneratedImageAttachment {
  if (!value || typeof value !== "object") return false;
  const attachment = value as Partial<GeneratedImageAttachment>;
  return typeof attachment.id === "string" && attachment.kind === "image"
    && typeof attachment.name === "string" && typeof attachment.filePath === "string"
    && attachment.mime === "image/png" && attachment.source === "model"
    && typeof attachment.byteLength === "number" && attachment.status === "done";
}

function mergeGeneratedImageAttachments(
  current: GeneratedImageAttachment[],
  incoming: GeneratedImageAttachment[],
): GeneratedImageAttachment[] {
  const byId = new Map(current.map((item) => [item.id, item]));
  for (const attachment of incoming) byId.set(attachment.id, attachment);
  return [...byId.values()];
}
