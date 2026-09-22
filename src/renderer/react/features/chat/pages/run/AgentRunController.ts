import type {
  AgentRoundRecord,
  ChatMessage,
  ChatSession,
  ConversationMode,
  PendingChatAttachment,
  ProcessMessageRecord,
  ReasoningBlock,
  RunActivityRecord,
  TaskDelegationDisplayRecord,
  ToolExecutionRecord,
} from "../../../../../../shared/chat-types";
import { isContextUsageSnapshot, type ContextUsageSnapshot } from "../../../../../../shared/context-usage";
import type { TodoItem } from "../../../../../../shared/todo-types";
import type { ChatMessageItem } from "../../components/ChatMessageList";
import type { ComposerAttachment } from "../../components/ChatComposer";
import {
  isFormalAnswerCommitted,
  normalizeChoiceInteraction,
  normalizeTaskPlanPresentation,
  resolveRunFinishedStage,
  resolveTerminalContent,
  shouldClearComposerInteractionForTerminal,
  type ComposerInteraction,
} from "../../components/run-presentation";
import { applyAgentRoundBoundary, createRoundProcessMessage } from "../../components/agent-rounds";
import { applyTaskDelegationEvent, normalizeTaskDelegationEvent } from "../../components/task-delegations";
import { t } from "../../../../i18n";
import type { AguiApi, AguiEvent, CandidateTextEventValue, ChatStoreApi } from "../chat-page-bridge";
import { normalizeWeatherData, parseSessionRunActiveError, stageForStep } from "../chat-page-normalizers";
import { RunEventGate } from "../run-event-gate";
import {
  SMOOTH_REVEAL_TICK_MS,
  SmoothTextRevealQueue,
  splitTextForReveal,
} from "../message-reveal";
import {
  buildTodoRecoveryContext,
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
  resumeFromRunId?: string;
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

/**
 * 运行宿主：控制器与 React 世界之间的全部通道。
 * 宿主只是端口——不要求把控制器每一次内部状态变化都暴露成一个方法，
 * 新增成员前优先考虑合并语义相近的通知。
 */
export interface AgentRunHost {
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
  /** 上下文压缩中提示。sessionId 供宿主未来按会话映射，当前实现为全局单值。 */
  setCompressingContext(sessionId: string, value: boolean): void;
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
/**
 * 单次 Agent 运行的生命周期控制器：事件归约、检查点落盘、
 * 正文渐显、早播 TTS 接线与终态结算全部内聚于此。
 * 不依赖 React，可注入假桥与记录型宿主做全流程单测。
 */
export class AgentRunController {
  private readonly input: AgentRunInput;
  private readonly deps: AgentRunDeps;

  // —— 流式累积状态 ——
  private streamContent = "";
  /** RUN_FINISHED.result.status：success / cancelled / timeout / runtime_error。 */
  private terminalStatus: string | undefined;
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
  private runStarted = false;
  /** run 已被主进程接受（ack 成功）：false 时 onRunFinished 携带 queuePaused 暂停队列消费。 */
  private runAccepted = false;
  private runActivity: RunActivityRecord | undefined;
  private currentTodos: TodoItem[] = [];
  private persistedFinalContent = "";
  /** 上下文容量快照：preRequest 每轮实时覆盖（纯内存），terminal 随 checkpoint 落盘。 */
  private contextUsage: ContextUsageSnapshot | undefined;
  private assistantAt = 0;
  private checkpointTimer: number | undefined;
  private checkpointChain: Promise<boolean> = Promise.resolve(true);
  private readonly activeReasoningStarts = new Map<string, number>();
  private currentReasoningId: string | undefined;
  private earlyTtsQueue: EarlyTtsPlaybackQueue | undefined;
  private resolveTerminal!: (error?: Error) => void;
  private readonly terminal: Promise<Error | undefined>;

  constructor(input: AgentRunInput, deps: AgentRunDeps) {
    this.input = input;
    this.deps = deps;
    this.terminal = new Promise<Error | undefined>((resolve) => {
      this.resolveTerminal = resolve;
    });
  }

  /** 启动并完整跑完一轮 run（从派发请求到终态落盘）。 */
  async start(): Promise<void> {
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
    await this.checkpointRun("running", true);

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
            const message = this.input.session.messages.find((item) => item.id === this.input.userMessageId);
            return message?.modelContext?.trim() || message?.content || "";
          })(),
          visibleContent: this.input.visibleContent
            ?? this.input.session.messages.find((item) => item.id === this.input.userMessageId)?.content
            ?? "",
          ...(this.input.attachments.length > 0 ? {
            attachments: this.input.attachments
              .filter((attachment): attachment is ComposerAttachment & { filePath: string } => Boolean(attachment.filePath))
              .map((attachment): PendingChatAttachment => ({
                kind: attachment.kind === "image" ? "image" : "document",
                name: attachment.name,
                filePath: attachment.filePath,
                ...(attachment.mime ? { mime: attachment.mime } : {}),
                ...(attachment.caption ? { caption: attachment.caption } : {}),
                ...(attachment.hasAnnotations ? { hasAnnotations: true } : {}),
              })),
          } : {}),
          ...(() => {
            const sticker = this.input.session.messages.find((item) => item.id === this.input.userMessageId)?.sticker;
            return sticker ? { sticker } : {};
          })(),
        },
        assistantTurnId: this.input.assistantId,
        styleId: general?.currentStyleId,
        sessionId: this.input.sessionId,
        recoveryContext: buildTodoRecoveryContext(this.input.session.messages, this.input.assistantId),
        ...(this.input.resumeFromRunId ? { resumeFromRunId: this.input.resumeFromRunId } : {}),
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
        reasoning: this.reasoningContent || undefined,
        reasoningBlocks: this.reasoningBlocks,
        processMessages: this.processMessages,
        agentRounds: this.agentRounds,
        reasoningStreaming: false,
        runActivity: this.runActivity,
        responseStarted: formalAnswerCommitted,
        sticker: this.sticker,
        toolExecutions: this.toolExecutions,
      });
      const savedAssistant = await this.checkpointRun("terminal", true);
      this.reportRunPersisted();
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
      await this.checkpointRun("terminal", true);
      // 错误终态的快照也已落盘：上报落盘确认（runId 未知时静默跳过）
      this.reportRunPersisted();
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

  /** 构建落盘检查点消息（含 runSnapshot 状态与累积的过程数据）。 */
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
      contextUsage: this.contextUsage,
      runSnapshot: {
        ...(this.deps.registries.activeRuns.current[this.input.sessionId]?.runId
          ? { runId: this.deps.registries.activeRuns.current[this.input.sessionId]?.runId }
          : {}),
        status,
        ...(status === "terminal" && this.terminalStatus
          ? { terminalStatus: this.terminalStatus as "success" | "cancelled" | "timeout" | "runtime_error" }
          : {}),
        todos: this.currentTodos,
        updatedAt: Date.now(),
      },
    };
  }

  /** 把检查点写入会话存储；串到链上保证与之前的写盘顺序一致。 */
  private writeCheckpoint(status: "running" | "waiting_user" | "terminal"): Promise<boolean> {
    const snapshot = this.buildCheckpoint(status);
    const patch = {
      content: snapshot.content,
      ...(snapshot.reasoning !== undefined ? { reasoning: snapshot.reasoning } : {}),
      reasoningBlocks: snapshot.reasoningBlocks,
      processMessages: snapshot.processMessages,
      agentRounds: snapshot.agentRounds,
      taskDelegations: snapshot.taskDelegations,
      ...(snapshot.runActivity !== undefined ? { runActivity: snapshot.runActivity } : {}),
      runSnapshot: snapshot.runSnapshot,
      ...(snapshot.sticker !== undefined ? { sticker: snapshot.sticker } : {}),
      toolExecutions: snapshot.toolExecutions,
      ...(snapshot.contextUsage !== undefined ? { contextUsage: snapshot.contextUsage } : {}),
    };
    // The idempotency key describes the exact queued patch, including its
    // timestamp. A retry of this queued item therefore reuses the same key
    // and payload instead of silently changing the mutation identity.
    const mutationKey = `run:${this.input.assistantId}:${status}:${encodeURIComponent(JSON.stringify(patch))}`;
    this.checkpointChain = this.checkpointChain
      .then(async () => {
        const result = await this.deps.store!.checkpointPresentation(
          this.input.sessionId,
          this.input.assistantId,
          mutationKey,
          patch,
        );
        if (!result.ok) throw new Error(result.error);
        return true;
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
      runStage: { kind: "responding" },
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
    this.scheduleCandidateClassification(this.candidateText);
  }

  private moveCandidateToInterruptedProcess(): void {
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

  /** AG-UI 事件归约：流式内容、推理、工具、交互卡与终态全部在此处理。 */
  private handleEvent(event: AguiEvent) {
    if (event.type === "CUSTOM" && event.name === "cyrene.round") {
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
      } else if (value.action === "discard") {
        // discard 是历史协议名：语义是「该轮正文不再是候选」，内容保留为过程消息
        this.closeRoundCandidateText();
      }
    } else if (event.type === "RUN_STARTED") {
      this.runStarted = true;
      this.runActivity = { startedAt: Date.now(), reasoningMs: 0 };
      this.deps.host.setCompressingContext(this.input.sessionId, false);
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
          runStage: { kind: "executing", detail: delegation.nickname },
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
    } else if (event.type === "CUSTOM" && event.name === "cyrene.compressingContext") {
      this.deps.host.setCompressingContext(this.input.sessionId, true);
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
    } else if (event.type === "CUSTOM" && event.name === "cyrene.sticker") {
      this.sticker = typeof event.value === "string" ? event.value : null;
      this.deps.host.patchMessage(this.input.sessionId, this.input.assistantId, { sticker: this.sticker });
    } else if (event.type === "CUSTOM" && event.name === "cyrene.weather") {
      const weather = normalizeWeatherData(event.value);
      if (weather) {
        this.deps.host.patchMessage(this.input.sessionId, this.input.assistantId, { weather });
      }
    } else if (event.type === "RUN_FINISHED") {
      // 读取 result.status 区分终态（success / cancelled / timeout / runtime_error）
      const result = (event as { result?: { status?: string } }).result;
      this.terminalStatus = result?.status;
      if (this.terminalStatus !== "success") {
        this.revealCancelled = true;
        this.abortCandidateReveal();
      }
      const stage = resolveRunFinishedStage(result);
      this.deps.host.patchMessage(this.input.sessionId, this.input.assistantId, { runStage: stage });
      const activeRunId = this.deps.registries.activeRuns.current[this.input.sessionId]?.runId;
      if (shouldClearComposerInteractionForTerminal(activeRunId, event.runId)) {
        this.deps.host.clearInteraction(this.input.sessionId);
      }
      this.resolveTerminal();
    } else if (event.type === "RUN_ERROR") {
      this.revealCancelled = true;
      this.abortCandidateReveal();
      this.completeRunActivity(true);
      this.deps.host.patchMessage(this.input.sessionId, this.input.assistantId, { runStage: { kind: "failed" } });
      const activeRunId = this.deps.registries.activeRuns.current[this.input.sessionId]?.runId;
      if (shouldClearComposerInteractionForTerminal(activeRunId, event.runId)) {
        this.deps.host.clearInteraction(this.input.sessionId);
      }
      this.resolveTerminal(new Error(event.message ?? event.error ?? event.content ?? t("chatPage.errorModelRequestFailed")));
    }
  }
}
