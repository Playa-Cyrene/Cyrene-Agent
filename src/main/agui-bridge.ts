// AG-UI IPC 桥：按会话模式选择执行链并把事件透传给渲染进程。
//
// 架构：
//   Chat  ──> CyreneAgent ──> 无工具 ChatLoop
//   Work / Learn / Code ──> CyreneAgent ──> CyreneHarness
//   各链路事件都由本桥通过 AGUI_EVENT 转发给渲染进程。
//
// Agent 的 Observable 是内存流、跨不过进程边界。
// 因此主进程统一持有运行并仅把事件发送给 Renderer。
import * as fs from "fs";
import { app, IpcMainInvokeEvent, WebContents } from "electron";
import { getHarnessRunStore } from "./orchestrator/harness/run-store";
import { IPC } from "../shared/ipc-channels";
import { createIpcScope, type IpcScope } from "./application/ipc-scope";
import { Subscription } from "rxjs";
import { AgentRuntimeError } from "./orchestrator/agent-runtime-error";
import {
  CyreneAgent,
  type AgentExecutionMode,
  type CyreneRunOptions,
  type CyreneRunResult,
} from "./orchestrator/cyrene-agent";
import { RunSettlementGate } from "./orchestrator/run-settlement";
import { toastEvents } from "./toast/toast-events";
import type { AguiRunAck, CyreneRunTerminalResult } from "../shared/run-terminal";
import { indexConversationTurn } from "./orchestrator/tools/history-tools";
import type { RelationshipChannel } from "./relationship/relationship-log";
import { createThinkFilter, type ThinkStreamFilter, type ThinkFilterMode } from "./chat/think-filter";
import { ChatTimeStreamPrefixFilter } from "./chat-time-stream-filter";
import { runLearnPostTurnHook } from "./learn/progress/learn-post-turn";
import { obsidianWorkspace } from "./learn/obsidian/obsidian-workspace-service";
import { registerObsidianTools, unregisterObsidianTools } from "./learn/obsidian/obsidian-tools";
import { getAdapterForConfig } from "./orchestrator/vendors";
import { perf } from "./perf-trace";
import type { StyleId } from "../shared/style-sampling";
import type { PendingTurnLifecycle } from "./plugin-host/pending-turn-lifecycle";
import * as chatsStore from "./chats/chats-store";
import { createRunAdjustmentPoller } from "./chats/pending-adjustment";
import { broadcastChatsChanged } from "./chats/chats-ipc";
import type { ChatMessage, ConversationMode, PendingChatAttachment } from "../shared/chat-types";
import { prepareTranscriptDispatch, type TranscriptRewindRequest } from "./orchestrator/conversation-transcript-coordinator";
import { getConversationTranscriptStore } from "./orchestrator/conversation-transcript-store";
import { createConversationSessionMigration } from "./orchestrator/conversation-session-migration";
import { ConversationJournalService } from "./orchestrator/conversation-journal-service";
import type { MaterializedTranscript } from "./orchestrator/conversation-transcript-projection";
import type { TranscriptPresentationPatch } from "./orchestrator/conversation-transcript-types";
import {
  requestUserClarification,
  cancelPendingChoicesForRun,
  type ChoiceCardData,
  type ChoiceSettlement,
} from "./user-choice";
import { cancelPendingApprovalsForRun } from "./permission";
import { cancelPendingQuizzesForRun, takeQuizEvidenceForRun } from "./orchestrator/pop-quiz";
import { approvePlan, getPlanPath, moveToReview, supplementPlan } from "./orchestrator/plan-mode";
import { buildPlanReviewCard, buildPlanSupplementCard } from "./orchestrator/harness/plan-tools";
import type { AskUserAnswer } from "../shared/ask-clarification";
import type { PluginPromptMode, PluginTurnCompletedEvent } from "../plugins/types";
/**
 * 从 RUN_FINISHED 事件中提取规范的终态结果（terminal）。
 *
 * CyreneAgent.runWithEvents 在 success / cancelled / timeout / runtime_error 路径都会发出
 * RUN_FINISHED 并附带 `result: CyreneRunTerminalResult`。下游（bridge / settlement gate）据此决定：
 *  - 是否跑成功收尾副作用（仅 status="success"）
 *  - runtime_error 是否转走 RUN_ERROR
 *
 * 缺失 result 字段时按 success 兜底，兼容尚未升级的 upstream。
 */
function extractTerminalFromRunFinished(baseEvent: unknown): CyreneRunTerminalResult {
  const result = (baseEvent as { result?: unknown })?.result;
  if (
    result
    && typeof result === "object"
    && "status" in result
    && typeof (result as { status: unknown }).status === "string"
  ) {
    const status = (result as { status: string }).status;
    // 终态 status 与 AG-UI 事件名是两个命名空间：status 用 runtime_error，
    // AG-UI 事件名仍是 RUN_ERROR，不要混用。
    if (status === "success" || status === "cancelled" || status === "timeout" || status === "runtime_error") {
      const reason = (result as { reason?: unknown }).reason;
      // externalEffectsMayContinue 是必填 invariant；
      // upstream 缺省时按保守规则补齐（success → false，其余三态 → true）。
      const rawFlag = (result as { externalEffectsMayContinue?: unknown }).externalEffectsMayContinue;
      const externalEffectsMayContinue = typeof rawFlag === "boolean"
        ? rawFlag
        : status !== "success";
      const terminal: CyreneRunTerminalResult = { status, externalEffectsMayContinue };
      if (typeof reason === "string") terminal.reason = reason;
      return terminal;
    }
  }
  // 兼容旧 upstream：未带 result 字段时按 success 处理（无 unresolved uncertainty）。
  return { status: "success", externalEffectsMayContinue: false };
}

/** 当前轮的结构化用户事实；renderer 不再上传完整历史。 */
export interface AguiCurrentUserInput {
  turnId: string;
  text: string;
  visibleContent: string;
  attachments?: PendingChatAttachment[];
  sticker?: string;
  at?: number;
}

function normalizeCurrentUserAttachments(value: unknown): PendingChatAttachment[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const attachments = value.flatMap((item) => {
    if (!item || typeof item !== "object") return [];
    const raw = item as Record<string, unknown>;
    const kind = raw.kind === "image" || raw.kind === "document" ? raw.kind : null;
    if (!kind || typeof raw.name !== "string" || typeof raw.filePath !== "string") return [];
    return [{
      kind: kind as "image" | "document",
      name: raw.name,
      filePath: raw.filePath,
      ...(typeof raw.mime === "string" ? { mime: raw.mime } : {}),
      ...(typeof raw.caption === "string" ? { caption: raw.caption } : {}),
      ...(raw.hasAnnotations === true ? { hasAnnotations: true } : {}),
    }];
  });
  return attachments.length > 0 ? attachments : undefined;
}

/** 渲染进程发起 run 时传的控制输入。 */
export interface AguiRunInput {
  sessionId: string;
  currentUser?: AguiCurrentUserInput;
  mode?: ConversationMode;
  /** 主进程在 append 后构建的权威模型上下文，renderer 无法构造。 */
  modelContext?: MaterializedTranscript;
  /** 仅旧内部调用兼容；renderer 新协议只放在 currentUser.turnId。 */
  userTurnId?: string;
  /** 本轮 assistant 占位消息的稳定 turn ID。 */
  assistantTurnId?: string;
  /** 旧版人格 style 文件名；仅保留兼容，不再承担运行模式语义。 */
  style?: string;
  /** 本轮表达风格，与 executionMode 正交。 */
  styleId?: StyleId | string;
  /** 主进程内部使用：为共享上下文指定工作区绑定来源；null 表示本轮不加载任何工作区。 */
  workspaceBindingSessionId?: string | null;
  /** 外部渠道入口。桌面聊天不传；微信/飞书用于注入渠道语气规则。 */
  channel?: RelationshipChannel;
  /** 仅主进程内部使用：插件无头 Agent 指定提示词 Provider 场景；缺省为 conversation。 */
  promptSource?: "conversation" | "plugin-agent";
  /** 仅主进程内部使用：传给插件提示词 Provider 的逻辑渠道，不参与内置渠道规则。 */
  promptChannel?: string;
  /** @deprecated 仅保留 Renderer 兼容；主进程按 ChatSession.mode 分流并忽略该值。 */
  executionMode?: ConversationMode | "soul-only" | "collaboration";
  /** 本轮附件（文本内容，临时注入系统上下文，不存历史）。 */
  attachments?: { name: string; text: string }[];
  /** 本轮图片附件。主进程会安全读取并转成 OpenAI-compatible image_url content block。 */
  imageAttachments?: { name: string; filePath: string; mime?: string }[];
  /** 同一会话上一次异常中断的只读恢复检查点。 */
  recoveryContext?: string;
  /** 用户点击“继续任务”时指定的中断 Harness Run。 */
  resumeFromRunId?: string;
  /** 显式接管：终止指定 run 并接管该会话（渲染端识别 SESSION_RUN_ACTIVE 后重发时携带）。 */
  takeoverFromRunId?: string;
  /** 只由主进程根据会话持久化字段注入，渲染端传值不可信。 */
  modelProfileId?: string;
  /** 桌面 edit / regenerate 的轨迹回退锚点（主进程写 turn_rewind；渲染端只传锚点元数据）。 */
  transcriptRewind?: TranscriptRewindRequest;
}

/** 调用方（index.ts）注入：把输入转成 agent 需要的 options（含 system prompt 拼接）。 */
export type BuildOptionsFn = (input: AguiRunInput) => Promise<{
  options: CyreneRunOptions;
  /** 跑完后副作用需要的信息。 */
  latestUserText: string;
}>;

/** 调用方注入：agent 跑完后的副作用（记忆/sticker/表情/广播）。 */
export interface RunFinishedEffects {
  /** 由 bridge 发给本次 AG-UI run 的发起窗口，保证不会落到旧 chatWindow。 */
  sticker?: string | null;
}
export type OnRunFinishedFn = (
  result: CyreneRunResult,
  latestUserText: string,
  context: {
    source: PluginTurnCompletedEvent["source"];
    mode: PluginPromptMode;
    conversationId: string;
    channel?: string;
    runId?: string;
  },
) => Promise<void | RunFinishedEffects> | void | RunFinishedEffects;

/** 调用方注入：拿聊天窗口（广播副作用用，可空）。 */
export type GetChatWindowFn = () => { webContents: WebContents; isDestroyed(): boolean } | null;

export interface AguiConversationLifecycle {
  onUserMessage(): void;
  onConversationStarted(): void;
  onConversationEnded(): void;
}

/**
 * 单次对话的活跃订阅（用于取消）。键 = runId。
 * 每个 run 持有独立 AbortController，AGUI_CANCEL 调用 abort() 触发
 * harness 的 cancelled 流程，而非粗暴 unsubscribe()。
 */
const activeRuns = new Map<string, {
  subscription: Subscription;
  endLifecycle: () => void;
  abortController: AbortController;
}>();

/**
 * 测试专用——验证同步 complete 后没有幽灵 active run。
 * 仅在测试环境使用；生产代码不要调用。
 */
export function __hasActiveRunForTest(runId: string): boolean {
  return activeRuns.has(runId);
}

// ── 会话级运行守卫 ────────────────────────────────────────
// 同一会话同一时刻最多一个 active run；不同会话允许并发。
// 渲染端 busy 队列只是 UX 优化，本守卫才是跨进程最终一致性边界：
// 无论 IPC 时序如何（如 F5 后立即发消息），正确性不依赖渲染端调度顺序。

interface SessionActiveRun {
  runId: string;
  /** 触发该 run 的 cancelled 流程（复用 AGUI_CANCEL 同款 abort 链路）。 */
  abort: () => void;
  /** run 终态结算完成（endLifecycle 释放守卫时 resolve）；takeover 等它保证旧 run checkpoint 已落盘。 */
  settled: Promise<void>;
}

const sessionActiveRuns = new Map<string, SessionActiveRun>();

/** 单次 takeover 等待旧 run 结算的时间上限：结算链路自身故障时超时回顶部重检，而非无限挂起。 */
let takeoverSettleTimeoutMs = 5_000;

/** compare-and-delete 释放：迟到的旧生命周期清理不误删新 run 的守卫。 */
function releaseSessionGuardEntry(sessionId: string, runId: string, resolveSettled?: () => void): void {
  if (sessionActiveRuns.get(sessionId)?.runId === runId) {
    sessionActiveRuns.delete(sessionId);
  }
  resolveSettled?.();
}

/** 测试专用：读取会话当前 active run 的 runId。 */
export function __getSessionActiveRunForTest(sessionId: string): string | undefined {
  return sessionActiveRuns.get(sessionId)?.runId;
}

/** 后台派生任务用：任一主会话运行期间避免并发占用模型配置。 */
export function hasActiveConversationRun(): boolean {
  return sessionActiveRuns.size > 0;
}

/** 测试专用：缩短 takeover 结算等待上限（避免真实等待 5s）。 */
export function __setTakeoverSettleTimeoutForTest(ms: number): void {
  takeoverSettleTimeoutMs = ms;
}

/** 测试专用：模拟旧 run 迟到的守卫释放（验证 compare-and-delete 语义）。 */
export function __releaseSessionGuardForTest(sessionId: string, runId: string): void {
  releaseSessionGuardEntry(sessionId, runId);
}

let buildOptionsFn: BuildOptionsFn | null = null;
let getChatWindowFn: GetChatWindowFn = () => null;

/**
 * 计划审批流：run 成功收尾后触发，不阻塞 RUN_FINISHED。
 *
 * 1. PLAN_DISCUSSING + 本轮 write_plan → PLAN_REVIEW（moveToReview 幂等，纯讨论轮不弹卡）
 * 2. 发 cyrene.plan.review（计划全文，渲染端打开独立计划窗口）+ 弹第一段审批卡（两选项）
 * 3. 批准 → EXECUTING + cyrene.plan.approved，渲染端自动发送执行消息开新 run
 * 4. 选"我要修改 / 补充" → 弹第二段纯文本卡；提交的文本经 cyrene.plan.supplement
 *    由渲染端作为用户消息发出，模型改计划后再次 write_plan 重新走审批
 * 5. 第二段卡超时 / 空文本 → 拉回 PLAN_DISCUSSING，等用户下一条消息
 */
function startPlanReviewFlow(params: {
  sessionId: string;
  threadId: string;
  runId: string;
  send: (event: unknown) => void;
}): void {
  const { sessionId, threadId, runId, send } = params;
  // 计划审批卡与补充卡共用同一收发通道：run 已结束，渲染端靠持久监听器收卡。
  // 卡片与结算（超时/取消）都带同一 runId 身份，结算事件让渲染端立即清卡，
  // 不留点不出结果的僵尸卡（与 run 内 ask_user 卡同机制）。
  const sendPlanCard = (cardData: ChoiceCardData): void => send({
    type: "CUSTOM",
    name: "cyrene.choice",
    value: { ...cardData, sessionId },
    threadId,
    runId,
  });
  const sendPlanDismiss = (settlement: ChoiceSettlement): void => send({
    type: "CUSTOM",
    name: "cyrene.choice.dismiss",
    value: settlement,
    threadId,
    runId,
  });
  void (async () => {
    if (!moveToReview(sessionId)) return;
    console.log("[AgUiBridge][Plan] run finished with write_plan, entering PLAN_REVIEW");
    const planPath = getPlanPath(sessionId);
    // 计划全文走独立事件：publishAskCard 只映射 questions，卡片 payload 带不动全文。
    let planContent = "";
    try {
      planContent = await fs.promises.readFile(planPath, "utf8");
    } catch (err) {
      console.warn("[AgUiBridge][Plan] read plan.md for review failed:", err);
    }
    send({
      type: "CUSTOM",
      name: "cyrene.plan.review",
      value: { planPath, planContent, sessionId },
      threadId,
      runId,
    });
    // 注意力提醒：计划进入审批，先于审批卡发布（ToastService 据此把同 runId 的
    // choice 卡归类为 plan-review，避免双弹）
    toastEvents.publishPlanReview({ sessionId, runId });
    const answer = await requestUserClarification(
      buildPlanReviewCard(planPath),
      sendPlanCard,
      sendPlanDismiss,
      { runId, revision: 1 },
    ) as AskUserAnswer;
    const decision = answer.answers.find((a) => a.field === "plan_decision");
    if (decision?.selectedValues?.includes("approve") && approvePlan(sessionId)) {
      console.log("[AgUiBridge][Plan] plan approved, entering EXECUTING");
      // 渲染端对此事件做持久监听（run 订阅此时已解除），按 sessionId 匹配后自动发送执行消息。
      send({ type: "CUSTOM", name: "cyrene.plan.approved", value: { planPath, sessionId }, threadId, runId });
      // 注意力提醒：计划已批准，ToastService 清去重记忆与残留 toast
      toastEvents.publishPlanApproved({ sessionId, runId });
      return;
    }
    // 非批准（含超时空答案）：统一拉回讨论态
    supplementPlan(sessionId);
    if (!decision?.selectedValues?.includes("supplement")) return;
    // 第二段：纯文本补充卡（复用同一 ask 卡片链路）
    console.log("[AgUiBridge][Plan] user wants to supplement, asking for details");
    const supplementAnswer = await requestUserClarification(
      buildPlanSupplementCard(),
      sendPlanCard,
      sendPlanDismiss,
      { runId, revision: 2 },
    ) as AskUserAnswer;
    const supplementText = supplementAnswer.answers
      .find((a) => a.field === "plan_supplement")?.customText?.trim();
    if (supplementText) {
      console.log("[AgUiBridge][Plan] supplement submitted, back to PLAN_DISCUSSING with user text");
      send({
        type: "CUSTOM",
        name: "cyrene.plan.supplement",
        value: { sessionId, text: supplementText },
        threadId,
        runId,
      });
    } else {
      console.log("[AgUiBridge][Plan] supplement card timed out / empty, waiting for user message");
    }
  })().catch((err) => {
    console.warn("[AgUiBridge][Plan] review flow failed:", err);
    supplementPlan(sessionId);
    // 注意力提醒：流程异常终止，同样要清理（幂等，与既有结算清理重合无副作用）
    toastEvents.publishPlanReviewEnded({ sessionId, runId });
  });
}

/**
 * 注册 AG-UI IPC。由 core bootstrap 在加载聊天页面前调一次。
 *
 * @param buildOptions 把渲染进程输入转成 agent options（含上下文构建）
 * @param onRunFinished agent 跑完的副作用（记忆/sticker 等）
 * @param getChatWindow 聊天窗口（事件要发到这里）
 * @param pendingTurns 桌面轮次生命周期协调器；缺省不发布轮次事件（测试与早期装配）
 */
export function registerAgUiIpc(
  buildOptions: BuildOptionsFn,
  onRunFinished: OnRunFinishedFn,
  getChatWindow: GetChatWindowFn,
  lifecycle?: AguiConversationLifecycle,
  ipcOption?: IpcScope,
  pendingTurns?: PendingTurnLifecycle,
): void {
  const ipc = ipcOption ?? createIpcScope();
  buildOptionsFn = buildOptions;
  getChatWindowFn = getChatWindow;
  const sessionMigration = createConversationSessionMigration(app.getPath("userData"));
  const transcriptStore = getConversationTranscriptStore(app.getPath("userData"));
  // Journal（会话日志服务）与 migration（迁移器）共享同一底层 store；
  // pending withdrawal 对账复用 Task 5 的持久状态，不创建旁路协议。
  // runReader 接入 harness 运行存储：崩溃孤儿工具按运行状态归类为 unknown，
  // 而不是被误判为 not_executed（避免模型重发外部副作用）。
  const journal = new ConversationJournalService({
    store: transcriptStore,
    pendingStore: chatsStore,
    runReader: getHarnessRunStore(app.getPath("userData")),
  });
  const loadComposedSession = async (sessionId: string) => {
    const recordReader = (chatsStore as typeof chatsStore & {
      getSessionRecord?: (id: string) => ReturnType<typeof chatsStore.getSessionRecord>;
    }).getSessionRecord;
    const migrated = typeof recordReader === "function"
      ? await sessionMigration.ensureConversationMigrated(sessionId)
      : null;
    await journal.reconcilePendingWithdrawals();
    if (!migrated) return chatsStore.getSession(sessionId);
    return sessionMigration.loadComposedSession(sessionId);
  };

  // 渲染端落盘确认（单向通知）：ChatPage 在 checkpointRun("terminal", true) 成功后上报。
  // 协调器据此在"终态 + 落盘确认"双条件满足时发布桌面 turn:finished。
  if (pendingTurns) {
    ipc.on(IPC.AGUI_RUN_PERSISTED, (_event, payload: unknown) => {
      const ack = payload as { runId?: unknown; finalMessageId?: unknown };
      if (typeof ack?.runId !== "string" || !ack.runId) return;
      pendingTurns.confirmPersistence(ack.runId, {
        ...(typeof ack.finalMessageId === "string" && ack.finalMessageId
          ? { finalMessageId: ack.finalMessageId }
          : {}),
      });
    });
  }

  ipc.handle(IPC.HARNESS_GET_INTERRUPTED_RUN, (_event, conversationId: unknown) => {
    if (typeof conversationId !== "string" || !conversationId) return null;
    const run = getHarnessRunStore(app.getPath("userData")).getLatestInterrupted(conversationId);
    return run ? {
      runId: run.runId,
      rounds: run.rounds,
      todoCount: run.state.todoItems.length,
      updatedAt: run.updatedAt,
    } : null;
  });

  const onFinished = onRunFinished;
  ipc.handle(IPC.AGUI_RUN, async (event: IpcMainInvokeEvent, rawInput: unknown) => {
    if (!buildOptionsFn || !onFinished) {
      throw new Error("AG-UI 桥未初始化");
    }
    lifecycle?.onUserMessage();
    lifecycle?.onConversationStarted();
    perf.beginTurn("desktop");
    const input = rawInput as AguiRunInput;

    // 事件转发目标：优先用 invoke 的 sender（发起 run 的窗口），兜底用聊天窗口
    const sender = event.sender;
    const runId = `run-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const turnStartedAt = Date.now();

    const send = (baseEvent: unknown): void => {
      // CyreneAgent 的 RUN_STARTED / RUN_FINISHED 自带 runId，但 ChatLoop 等内部
      // AgentLoopEvent 经 toAguiEvent 转换后没有。渲染端用 runId 隔离并发会话，
      // 因此所有桥层发出的事件都必须带 canonical runId，不能只给终态事件补上。
      const eventWithRunId = baseEvent && typeof baseEvent === "object"
        ? { ...(baseEvent as Record<string, unknown>), runId: (baseEvent as { runId?: unknown }).runId ?? runId }
        : baseEvent;
      const targets: WebContents[] = [];
      if (!sender.isDestroyed()) targets.push(sender);
      const chatWin = getChatWindowFn();
      if (chatWin && !chatWin.isDestroyed() && chatWin.webContents !== sender) {
        targets.push(chatWin.webContents);
      }
      for (const t of targets) {
        try {
          t.send(IPC.AGUI_EVENT, eventWithRunId);
        } catch (err) {
          console.error("[AgUiBridge] send 失败:", (err instanceof Error ? err.message : String(err)), "事件类型=", (baseEvent as { type?: string })?.type);
        }
      }
    };

    // ── 顶层模式分流：读取 ChatSession.mode（唯一可信来源） ──
    const sessionId = input.sessionId;
    if (!sessionId) {
      lifecycle?.onConversationEnded();
      throw new Error("AGUI_RUN 缺少 sessionId");
    }
    const session = await loadComposedSession(sessionId);
    if (!session) {
      lifecycle?.onConversationEnded();
      throw new Error(`AGUI_RUN 会话不存在: ${sessionId}`);
    }
    const mode = session.mode ?? (session.purpose === "proactive-chat" ? "chat" : "work");
    if ((mode === "work" || mode === "code" || mode === "learn") && !session.workspaceBinding?.workspaceRoot) {
      lifecycle?.onConversationEnded();
      throw new Error(`${mode} 模式需要先绑定项目工作区`);
    }

    // ── 会话级运行守卫：同一会话同一时刻最多一个 active run ──
    // 检查 + 注册在同一同步代码块内完成（JS 单线程，get 与 set 之间无 await = 原子），
    // 早于下方 buildOptions（async，存在竞态窗口，F5 后立即发消息即命中）。
    // 渲染端 busy 队列不参与正确性论证：无论 IPC 时序如何，这里都是最终边界。
    const runAbortController = new AbortController();
    let releaseSessionGuard: (() => void) | null = null;
    for (let takeovers = 0; ; takeovers++) {
      const existing = sessionActiveRuns.get(sessionId);
      if (!existing) {
        let resolveSettled!: () => void;
        const settled = new Promise<void>((resolve) => { resolveSettled = resolve; });
        // 并发 takeover 中只有一个能走到这里（await 醒来后必须回顶部重新竞争）
        sessionActiveRuns.set(sessionId, {
          runId,
          abort: () => runAbortController.abort(),
          settled,
        });
        releaseSessionGuard = () => releaseSessionGuardEntry(sessionId, runId, resolveSettled);
        break;
      }
      if (input.takeoverFromRunId !== existing.runId) {
        lifecycle?.onConversationEnded();
        throw new Error(`SESSION_RUN_ACTIVE:${existing.runId}`);
      }
      if (takeovers >= 2) {
        // 防御上限：abort 后旧 run 始终未结算（结算链路自身故障）→ 明确报错而非无限等待
        lifecycle?.onConversationEnded();
        throw new Error(`SESSION_RUN_TAKEOVER_STUCK:${existing.runId}`);
      }
      existing.abort();
      // 有界等待旧 run 结算（checkpoint 落盘 + 副作用收尾），超时回顶部重新竞争
      let settleTimeout: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([
        existing.settled,
        new Promise<void>((resolve) => {
          settleTimeout = setTimeout(resolve, takeoverSettleTimeoutMs);
        }),
      ]);
      clearTimeout(settleTimeout);
    }

    // ── 轨迹派发：canonical user/rewind → presentation → model context ──
    // renderer 的 messages（即使恶意/旧版载荷仍携带）永远不参与模型上下文。
    const currentUser = input.currentUser ?? (input.userTurnId
      ? (() => {
          const message = session.messages.find((candidate) => candidate.id === input.userTurnId && candidate.role === "user");
          return message ? {
            turnId: message.id,
            text: message.content,
            visibleContent: message.content,
            at: message.at,
            ...(message.attachments ? { attachments: message.attachments } : {}),
            ...(message.sticker ? { sticker: message.sticker } : {}),
          } : undefined;
        })()
      : undefined);
    if (input.currentUser && (!input.currentUser.turnId || typeof input.currentUser.text !== "string"
      || typeof input.currentUser.visibleContent !== "string")) {
      lifecycle?.onConversationEnded();
      throw new Error("AGUI_RUN_INVALID_CURRENT_USER");
    }
    if (input.userTurnId && !currentUser) {
      lifecycle?.onConversationEnded();
      throw new Error("TRANSCRIPT_USER_TURN_NOT_FOUND");
    }
    const currentUserAttachments = currentUser
      ? normalizeCurrentUserAttachments(currentUser.attachments)
      : undefined;
    let modelContext: MaterializedTranscript | undefined;
    if (currentUser) {
      try {
        const currentMessage: ChatMessage = {
          id: currentUser.turnId,
          role: "user" as const,
          content: currentUser.text,
          at: currentUser.at ?? Date.now(),
          ...(currentUserAttachments ? {
            attachments: currentUserAttachments.map((attachment) => attachment.kind === "image"
              ? {
                  kind: "image" as const,
                  name: attachment.name,
                  filePath: attachment.filePath,
                  mime: attachment.mime ?? "application/octet-stream",
                  ...(attachment.caption ? { caption: attachment.caption } : {}),
                  status: "pending" as const,
                  ...(attachment.hasAnnotations ? { hasAnnotations: true } : {}),
                }
              : {
                  kind: "document" as const,
                  name: attachment.name,
                  filePath: attachment.filePath,
                  status: "pending" as const,
                }),
          } : {}),
          ...(currentUser.sticker ? { sticker: currentUser.sticker } : {}),
        };
        const sessionRecord = (chatsStore as typeof chatsStore & {
          getSessionRecord?: (id: string) => ReturnType<typeof chatsStore.getSessionRecord>;
        }).getSessionRecord?.(sessionId);
        const migrated = sessionRecord?.schemaVersion === 2
          || (session as unknown as { schemaVersion?: number }).schemaVersion === 2;
        let presentationRevision: number = 1;
        if (migrated && input.transcriptRewind) {
          const rewindEntry = await journal.appendRewind(sessionId, {
            anchorUserTurnId: input.transcriptRewind.anchorUserTurnId,
            disposition: input.transcriptRewind.disposition,
            runId,
            at: currentMessage.at,
            ...(input.transcriptRewind.disposition === "replace_user" ? {
              replacementUser: {
                turnId: currentUser.turnId,
                text: currentUser.text,
                attachments: currentUserAttachments,
              },
            } : {}),
          });
          presentationRevision = rewindEntry.revision ?? 1;
        } else if (migrated) {
          await journal.appendUser(sessionId, {
            id: `user:v1:${currentUser.turnId}:r1`,
            turnId: currentUser.turnId,
            text: currentUser.text,
            attachments: currentUserAttachments,
            at: currentMessage.at,
            revision: 1,
          });
        } else {
          // v1 记录仍复用 Task 3 的确定性回填协调器；迁移完成后不会再次走这里。
          await prepareTranscriptDispatch({
            store: transcriptStore,
            session: {
              ...session,
              messages: [
                ...session.messages.filter((message) => message.id !== currentUser.turnId),
                currentMessage,
              ],
            },
            userTurnId: currentUser.turnId,
            runId,
            rewind: input.transcriptRewind,
          });
        }
        const presentationMessageId = input.transcriptRewind
          ? `${runId}:rewind:${input.transcriptRewind.anchorUserTurnId}`
          : `user:v1:${currentUser.turnId}:r1`;
        // v2 pending claim 的 reconcile 可能已写入 revision 1 sticker patch；
        // 续派展示补丁递增 revision，避免被同 ID 幂等写吞掉。
        if (!input.transcriptRewind && session.pendingDispatch?.messageId === currentUser.turnId) {
          presentationRevision = 2;
        }
        const presentation: Record<string, unknown> = {};
        if (currentUser.visibleContent !== currentUser.text) presentation.content = currentUser.visibleContent;
        if (currentUser.sticker) presentation.sticker = currentUser.sticker;
        const canPresent = !input.transcriptRewind || input.transcriptRewind.disposition === "replace_user";
        if (canPresent && Object.keys(presentation).length > 0) {
          await journal.appendPresentation(
            sessionId,
            presentationMessageId,
            presentationRevision,
            presentation as TranscriptPresentationPatch,
          );
        }
        modelContext = await journal.buildModelContext(sessionId);
      } catch (error) {
        // 轨迹写入失败即阻断模型启动（fail-closed），复位守卫与插话标记后上抛
        perf.dump();
        try { chatsStore.resetPendingAdjustByRun(sessionId, runId); } catch { /* 复位尽力而为 */ }
        releaseSessionGuard?.();
        releaseSessionGuard = null;
        lifecycle?.onConversationEnded();
        throw error;
      }
    }

    // ── Chat / Work / Learn / Code：共用 CyreneAgent 外壳 ──
    const agentExecutionMode: AgentExecutionMode = mode === "chat" ? "chat" : "work";
    let built;
    try {
    // 运行时拒绝未知的历史旁路字段；类型层已不再声明 renderer messages。
    const { messages: _ignoredLegacyMessages, ...safeInput } = input as AguiRunInput & Record<string, unknown>;
    built = await perf.track("build_options", () => buildOptionsFn!({
      ...safeInput,
      mode,
      ...(currentUser ? {
        currentUser: {
          ...currentUser,
          ...(currentUserAttachments ? { attachments: currentUserAttachments } : {}),
        },
        modelContext,
      } : {}),
      modelProfileId: session.modelProfileId,
      executionMode: agentExecutionMode,
    }));
    } catch (error) {
      perf.dump();
      // run 未开跑即失败：清掉这期间可能落下的插话标记，条目回普通队列
      try { chatsStore.resetPendingAdjustByRun(sessionId, runId); } catch { /* 复位尽力而为 */ }
      releaseSessionGuard?.();
      releaseSessionGuard = null;
      lifecycle?.onConversationEnded();
      throw error;
    }
    const { options, latestUserText } = built;
    options.executionMode = agentExecutionMode;
    // 轨迹侧崩溃孤儿提示与派发侧（渠道）恢复上下文合并，互不覆盖
    const mergedRecoveryContext = [options.recoveryContext, input.recoveryContext]
      .filter((value): value is string => Boolean(value?.trim()))
      .join("\n\n");
    if (mergedRecoveryContext) options.recoveryContext = mergedRecoveryContext;
    // 只有明确的非空 run ID 才代表用户要求继续中断运行；普通轮次不得
    // 因空白/旧兼容字段意外进入恢复路径，更不会自动继承 cancelled run。
    if (typeof input.resumeFromRunId === "string" && input.resumeFromRunId.trim()) {
      options.resumeFromRunId = input.resumeFromRunId.trim();
    } else {
      delete options.resumeFromRunId;
    }
    options.conversationMode = mode;
    // 把 bridge 创建的 canonical runId 注入 CyreneRunOptions，
    // 一路传到 Agent / Harness adapter / ToolContext / 所有 AG-UI 事件。
    // ack.runId 与 RUN_STARTED.runId 必须一致。
    options.runId = runId;
    // 轨迹写入总开关（CTA）：桌面 dispatch 带 userTurnId 才写轨迹——
    // 缺 userTurnId 的兼容调用按渲染端消息走，sink 与插话轨迹端口都不注入，
    // 否则模型回写没有对应 user 的孤立 assistant 条目。
    // renderer 回退只切换读取源，不影响这里（带 userTurnId 时双写持续）。
    const transcriptEnabled = Boolean(currentUser);
    // 轨迹提交端（CTA）：每 run 一个 sink，entryId 全程确定性，canonical assistant /
    // tool_result 经它写入权威轨迹。
    // 渲染端 assistantTurnId 存在时透传（ChatLoop 单轮路径的 assistant 条目锚点）。
    options.transcriptSink = transcriptEnabled ? journal.createRunSink({
      conversationId: sessionId,
      runId,
      ...(input.assistantTurnId ? { assistantTurnId: input.assistantTurnId } : {}),
    }) : undefined;
    // AbortController 已在会话守卫注册前创建（守卫的 abort 需要引用它）。
    // signal 一路传到 Agent / harness；AGUI_CANCEL / takeover 调用 abort()，
    // 触发 harness 返回 cancelled，CyreneAgent 发出 RUN_FINISHED(result.status="cancelled")，
    // complete 回调自然清理。
    options.signal = runAbortController.signal;
    // 插话轮询：把"插入当前运行下一步"的待发条目在模型请求边界提交并注入。
    // Chat 无工具链路是单请求运行，没有安全的下一步，不接轮询（IPC 侧同步拒绝）。
    // 双写顺序在 poller 内：先以稳定 ID 写权威轨迹（含附件元数据），
    // 再提交聊天历史；任一步失败 pending 保留并上抛（fail-closed）。
    if (mode !== "chat") {
      // 插话轨迹端口只在轨迹开启时注入：兼容调用缺省，poller 退化为只提交聊天历史
      options.pollRunAdjustments = createRunAdjustmentPoller(
        sessionId,
        runId,
        chatsStore,
        transcriptEnabled ? {
          // 稳定 entryId 规则与正常派发一致（user:v1:turnId:r1）：重试时幂等命中
          appendUser: async ({ turnId, text, attachments }) => {
            const transcriptStore = getConversationTranscriptStore(app.getPath("userData"));
            await transcriptStore.append(sessionId, {
              id: `user:v1:${turnId}:r1`,
              at: Date.now(),
              kind: "user",
              turnId,
              revision: 1,
              payload: { text, ...(attachments ? { attachments } : {}) },
            });
          },
        } : undefined,
      );
    }
    options.requestUserClarification = (card) => requestUserClarification(card, (cardData) => {
      send({ type: "CUSTOM", name: "cyrene.choice", value: cardData, threadId, runId });
    }, (settlement) => {
      send({ type: "CUSTOM", name: "cyrene.choice.dismiss", value: settlement, threadId, runId });
    }, { runId, revision: 1 });

    // Learn 模式：配置 Obsidian Vault 并注册工具
    if (mode === "learn" && session.workspaceBinding?.workspaceRoot) {
      try {
        obsidianWorkspace.configure({
          enabled: true,
          vaultPath: session.workspaceBinding.workspaceRoot,
        });
      } catch (error) {
        // 守卫已注册：configure 失败时必须释放，否则该会话永久拒绝新 run。
        // 语义保持"配置失败 → 中断本次 run"（learn 工具不可用时不静默降级）。
        try { chatsStore.resetPendingAdjustByRun(sessionId, runId); } catch { /* 复位尽力而为 */ }
        releaseSessionGuard?.();
        releaseSessionGuard = null;
        lifecycle?.onConversationEnded();
        throw error;
      }
      try {
        registerObsidianTools();
      } catch (err) {
        console.warn("[Learn] Obsidian 工具注册失败：", err);
      }
    }

    const threadId = `thread-${Date.now()}`;
    const agent = new CyreneAgent({ threadId, description: "Cyrene 主聊天" });

    // 桌面轮次事件：run 真正开跑时登记协调器（立即发布 turn:started）。
    // turn:finished 由协调器在"终态 + 渲染端落盘确认"双条件满足后发布一次。
    let detachPendingTurnWatchers: (() => void) | null = null;
    if (pendingTurns) {
      pendingTurns.beginTurn({
        runId,
        conversationId: sessionId,
        mode,
        inputMessageId: input.userTurnId ?? "",
        ...(input.assistantTurnId ? { assistantMessageId: input.assistantTurnId } : {}),
        startedAt: turnStartedAt,
        runTimeoutMs: options.timeoutMs,
      });
      // 发起 run 的渲染进程销毁 / 重载 / 导航后，落盘确认永远不会到达，直接清理
      const disposePendingTurn = (): void => { pendingTurns?.disposeEntry(runId); };
      sender.once("destroyed", disposePendingTurn);
      sender.once("did-start-navigation", disposePendingTurn);
      detachPendingTurnWatchers = () => {
        sender.removeListener("destroyed", disposePendingTurn);
        sender.removeListener("did-start-navigation", disposePendingTurn);
      };
    }

    let pendingRunFinishedEvent: unknown | null = null;
    // exactly-once settlement gate。
    // complete / error 两条 RxJS 回调都会先 trySettle，只有第一次进入的那条会真正发出终态事件。
    // 这覆盖：upstream 连续发两个 terminal、success 后 error、error 后 success 等竞态。
    const settlementGate = new RunSettlementGate();
    let lifecycleEnded = false;
    // run 终态统一清理：从 activeRuns 移除 + 清理该 run 关联的 pending 审批/选择卡。
    // 审批卡不再设超时，任何终态路径（success/cancelled/timeout/error）都必须走到这里，
    // 否则 pending promise 会永久悬挂；取消时会广播 PERMISSION_APPROVAL_SETTLED 让渲染端清卡。
    const cleanupRunState = (): void => {
      activeRuns.delete(runId);
      cancelPendingChoicesForRun(runId);
      cancelPendingApprovalsForRun(runId);
      cancelPendingQuizzesForRun(runId);
      detachPendingTurnWatchers?.();
      detachPendingTurnWatchers = null;
    };
    const endLifecycle = (): void => {
      if (lifecycleEnded) return;
      lifecycleEnded = true;
      // 插话复位：运行终态（任何路径）后，已标记但未注入的条目清标记回普通队列。
      // 必须先于会话守卫释放执行，让接续的新 run 从干净的普通队列消费。
      try {
        chatsStore.resetPendingAdjustByRun(sessionId, runId);
      } catch (err) {
        console.warn("[AgUiBridge] 插话标记复位失败:", err);
      }
      // 释放会话守卫（compare-and-delete）并 resolve settled：
      // 等待中的 takeover 此刻才被放行，保证其开局时旧 run 的 checkpoint 已落盘。
      releaseSessionGuard?.();
      releaseSessionGuard = null;
      // Learn 模式：注销 Obsidian 工具
      if (mode === "learn") {
        try { unregisterObsidianTools(); } catch { /* ignore */ }
      }
      lifecycle?.onConversationEnded();
    };

    // <think> 标签过滤器：按单条 assistant message 隔离（TEXT_MESSAGE_START ~ END）
    // leading-only 模式：只在消息开头以 <think> 开头时才过滤，避免误删正文中的 <think> 讨论
    let thinkFilter: ThinkStreamFilter | null = null;
    let timePrefixFilter: ChatTimeStreamPrefixFilter | null = null;
    const thinkFilterMode: ThinkFilterMode = "leading-only";
    let pendingTextStart: { type: string; messageId?: string; [key: string]: unknown } | null = null;
    let textStartForwarded = false;
    let embeddedReasoningStarted = false;
    let embeddedReasoningMessageId = "";
    const forwardTextStart = (): void => {
      if (!pendingTextStart || textStartForwarded) return;
      textStartForwarded = true;
      send(pendingTextStart);
    };
    const forwardEmbeddedReasoning = (delta: string): void => {
      if (!delta) return;
      if (!embeddedReasoningStarted) {
        embeddedReasoningStarted = true;
        embeddedReasoningMessageId = `${pendingTextStart?.messageId ?? runId}-reasoning`;
        send({
          type: "REASONING_MESSAGE_START",
          messageId: embeddedReasoningMessageId,
          role: "reasoning",
          threadId,
          runId,
        });
      }
      send({
        type: "REASONING_MESSAGE_CONTENT",
        messageId: embeddedReasoningMessageId,
        delta,
        threadId,
        runId,
      });
    };
    const endEmbeddedReasoning = (): void => {
      if (!embeddedReasoningStarted) return;
      send({ type: "REASONING_MESSAGE_END", messageId: embeddedReasoningMessageId, threadId, runId });
      embeddedReasoningStarted = false;
    };

    // 订阅 agent 事件流：每个事件透传渲染端；
    // TEXT_MESSAGE_CONTENT 经 <think> 过滤后再转发；
    // complete/error 时做副作用，并补发一个终态事件让渲染端知道这轮结束。
    perf.mark("agent_run_start");
    const sub = agent.runWithEvents(options).subscribe({
      next: (baseEvent) => {
        const eventType = (baseEvent as { type?: string })?.type;

        // sticker / memory 等副作用在 complete 回调里执行。前端收到 RUN_FINISHED 后会收尾并取消监听，
        // 所以必须把 RUN_FINISHED 延后到副作用事件之后发送，否则 cyrene.sticker 会晚到而被丢掉。
        if (eventType === "RUN_FINISHED") {
          // 兜底清理：如果 filter 仍存在（TEXT_MESSAGE_END 缺失），销毁
          endEmbeddedReasoning();
          thinkFilter = null;
          timePrefixFilter = null;
          pendingTextStart = null;
          textStartForwarded = false;
          // 通过 settlement gate 保证 only-once terminal。
          // 如果 upstream 已经发过 RUN_FINISHED / RUN_ERROR（gate 已结算），丢弃后续重复事件。
          const terminal = extractTerminalFromRunFinished(baseEvent);
          if (!settlementGate.trySettle(terminal)) {
            return;
          }
          // runtime_error 必须走 RUN_ERROR，不缓存为 RUN_FINISHED。
          // complete 回调据此跳过成功收尾副作用；渲染端只收到 RUN_ERROR 作为终态。
          if (terminal.status === "runtime_error") {
            const reason = terminal.reason ?? "E_RUN_FAILURE";
            send({ type: "RUN_ERROR", message: reason, code: reason, threadId, runId });
            pendingRunFinishedEvent = null;
            return;
          }
          pendingRunFinishedEvent = baseEvent;
          return;
        }

        // <think> 过滤：拦截 TEXT_MESSAGE_* 事件
        if (eventType === "TEXT_MESSAGE_START") {
          thinkFilter = createThinkFilter(thinkFilterMode);
          timePrefixFilter = new ChatTimeStreamPrefixFilter();
          pendingTextStart = baseEvent as typeof pendingTextStart;
          textStartForwarded = false;
          embeddedReasoningStarted = false;
          embeddedReasoningMessageId = "";
          return;
        }

        if (eventType === "TEXT_MESSAGE_CONTENT") {
          if (!thinkFilter) {
            // 没有 START 边界（异常），原样转发
            send(baseEvent);
            return;
          }
          const event = baseEvent as { type: string; delta?: string };
          const rawDelta = typeof event.delta === "string" ? event.delta : "";
          const visibleDelta = timePrefixFilter?.push(thinkFilter.push(rawDelta)) ?? thinkFilter.push(rawDelta);
          forwardEmbeddedReasoning(thinkFilter.takeThinking());
          if (visibleDelta) {
            endEmbeddedReasoning();
            forwardTextStart();
            send({ ...event, delta: visibleDelta });
          }
          // visibleDelta 为空时跳过发送（不产生空 CONTENT 事件）
          return;
        }

        if (eventType === "TEXT_MESSAGE_END") {
          if (thinkFilter) {
            const tail = timePrefixFilter?.push(thinkFilter.flush()) ?? thinkFilter.flush();
            const timeTail = timePrefixFilter?.finish() ?? "";
            forwardEmbeddedReasoning(thinkFilter.takeThinking());
            if (tail || timeTail) {
              endEmbeddedReasoning();
              forwardTextStart();
              // flush 出的尾部文本作为最后一个 CONTENT 发送，确保在 END 之前到达
              send({ type: "TEXT_MESSAGE_CONTENT", delta: `${tail}${timeTail}`, threadId, runId });
            }
            thinkFilter = null;
            timePrefixFilter = null;
          }
          endEmbeddedReasoning();
          if (textStartForwarded) send(baseEvent);
          pendingTextStart = null;
          textStartForwarded = false;
          return;
        }

        // 其他事件原样透传
        send(baseEvent);
      },
      error: (err) => {
        endEmbeddedReasoning();
        thinkFilter = null; // 错误时丢弃残留 filter 状态
        pendingTextStart = null;
        textStartForwarded = false;
        let message = err instanceof Error ? err.message : String(err);
        // 安全兜底：确保不泄漏原始 DOMException / AbortError 文本
        if (!message || message.includes("This operation was aborted") || message.includes("AbortError")) {
          message = "操作已中断，请重试。";
        }
        console.error("[AgUiBridge] run 失败:", message);
        perf.dump();
        const code = err instanceof AgentRuntimeError ? err.code : undefined;
        // runtime error 必须经过同一个 settlement gate。
        // 如果 upstream 已经发过 RUN_FINISHED（gate 已结算为 success / cancelled / timeout），
        // 这里直接丢弃 RUN_ERROR，避免渲染端收到第二终态。
        // pendingRunFinishedEvent 仍会在 complete 回调里发出（如果 complete 被调用）；
        // 若 complete 不会被调用（error 后 RxJS 不再调 complete），则下面兜底直接发 RUN_FINISHED。
        const errorTerminal: CyreneRunTerminalResult = {
          status: "runtime_error",
          reason: code ?? "E_RUN_FAILURE",
          externalEffectsMayContinue: true,
        };
        if (!settlementGate.trySettle(errorTerminal)) {
          // 已结算：检查是否需要补发缓存的 RUN_FINISHED。
          // 仅当 RUN_FINISHED 被 next 缓存但尚未发出（complete 未触发）时才补发。
          if (pendingRunFinishedEvent) {
            send(pendingRunFinishedEvent);
            pendingRunFinishedEvent = null;
          }
          // 终态在 next(RUN_FINISHED) 已结算（success/cancelled/timeout），complete 可能不再被调用
          const settled = settlementGate.get();
          if (settled) {
            pendingTurns?.settleTerminal(runId, {
              status: settled.status,
              durationMs: Date.now() - turnStartedAt,
            });
          }
          cleanupRunState();
          endLifecycle();
          return;
        }
        // 桌面轮次终态登记（协调器内幂等：首个终态生效）
        pendingTurns?.settleTerminal(runId, {
          status: "runtime_error",
          durationMs: Date.now() - turnStartedAt,
        });
        // 补发 RUN_ERROR 事件，渲染端据此收尾（invoke 早已 resolve，靠事件驱动）
        send({ type: "RUN_ERROR", message, code, threadId, runId });
        cleanupRunState();
        endLifecycle();
      },
      complete: async () => {
        perf.mark("agent_run_complete");
        cleanupRunState();
        // complete 路径下 settlement 应已由 next(RUN_FINISHED) 写入。
        // 若 upstream 走裸 complete（没有 RUN_FINISHED），必须补发一个合成的 RUN_FINISHED，
        // 否则 renderer 收到零个终态事件，exactly-once 退化为 at-most-once。
        // 若已被 error 路径或 runtime_error RUN_FINISHED 结算，则保持该终态，不再补发。
        if (!settlementGate.isSettled()) {
          const synthesizedTerminal: CyreneRunTerminalResult = {
            status: "success",
            externalEffectsMayContinue: false,
          };
          settlementGate.trySettle(synthesizedTerminal);
          pendingRunFinishedEvent = {
            type: "RUN_FINISHED",
            threadId,
            runId,
            result: synthesizedTerminal,
          };
        }
        const settlement = settlementGate.get();
        const isSuccessfulCompletion = settlement?.status === "success";
        // 桌面轮次终态登记：complete 与 error 双路径都会调用，协调器只认首个终态
        if (settlement) {
          pendingTurns?.settleTerminal(runId, {
            status: settlement.status,
            durationMs: Date.now() - turnStartedAt,
          });
        }
        try {
          // cancelled / timeout / runtime_error 不跑成功收尾副作用
          // （sticker / memory / learn-progress / 历史召回）。
          // 这些副作用假定 run 已经成功产出回复；其他终态不能保证有可用 finalAnswer。
          if (agent.lastResult && isSuccessfulCompletion) {
            const lastResult = agent.lastResult;
            const effects = await perf.track("on_run_finished", async () => onFinished(lastResult, latestUserText, {
              source: "desktop",
              mode,
              conversationId: sessionId,
              runId,
            }));
            if (mode !== "code" && effects?.sticker !== undefined) {
              send({
                type: "CUSTOM",
                name: "cyrene.sticker",
                value: effects.sticker,
                threadId,
                runId,
              });
            }
            // 历史召回用：把这轮对话存入向量库（异步，不阻塞，失败不影响主流程）
            // 放在 onFinished 之后，确保记忆/sticker 等副作用先跑完
            void indexConversationTurn(
              input.sessionId || "default",
              latestUserText,
              lastResult.reply,
            );

            // Learn 模式：静默更新学习进度（异步，不阻塞，失败不影响主流程）
            if (mode === "learn" && obsidianWorkspace.isReady()) {
              const adapter = getAdapterForConfig({
                provider: options.settings.provider,
                baseUrl: options.settings.baseUrl,
                model: options.settings.model,
                apiKey: options.settings.apiKey,
              });
              // 取走本轮抽查的实测作答（take 语义：取后即清，避免重复计入）
              const quizEvidence = takeQuizEvidenceForRun(runId);
              void runLearnPostTurnHook({
                adapter,
                cfg: {
                  provider: options.settings.provider,
                  baseUrl: options.settings.baseUrl,
                  model: options.settings.model,
                  apiKey: options.settings.apiKey,
                },
                systemPrompt: options.soulSystemBaseContent ?? "",
                userMessage: latestUserText,
                assistantMessage: lastResult.reply,
                quizEvidence: quizEvidence.length > 0 ? quizEvidence : undefined,
              });
            }
          }
        } catch (err) {
          console.warn("[AgUiBridge] 副作用失败（不影响结果）:", err);
        }
        // runtime_error 已在 next 回调发过 RUN_ERROR，complete 不再补发终态事件。
        if (settlement?.status === "runtime_error") {
          pendingRunFinishedEvent = null;
        } else if (pendingRunFinishedEvent) {
          send(pendingRunFinishedEvent);
          pendingRunFinishedEvent = null;
        }
        // 计划模式（code / chat）：run 成功收尾后检测 write_plan，触发审批流（异步，不阻塞 complete）。
        if ((mode === "code" || mode === "chat") && isSuccessfulCompletion) {
          startPlanReviewFlow({ sessionId, threadId, runId, send });
        }
        endLifecycle();
        perf.dump();
      },
    });
    // 同步 Observable 在 subscribe() 返回前可能已 complete 并 delete(runId)。
    // 若此时再无条件 set，会把已结算的 run 重新加入 map，留下幽灵 active run。
    // 仅在未结算（async、仍在运行）时才登记，供 cancel 取消用。
    if (!settlementGate.isSettled()) {
      activeRuns.set(runId, { subscription: sub, endLifecycle, abortController: runAbortController });
    }

    // invoke 立刻返回 ack，不等 Observable 结束。
    // 终态（RUN_FINISHED/RUN_ERROR）由事件流承载，渲染端据此 offEvent + 收尾。
    // 这样避免 invoke reply 与 send 事件的投递顺序竞争导致 offEvent 提前取消监听。
    return { success: true, runId };
  });

  ipc.handle(IPC.AGUI_CANCEL, (_event, runId?: string) => {
    // 通过 abort signal 触发 harness 的 cancelled 流程，
    // 而非粗暴 unsubscribe()。后者会阻止 RUN_FINISHED(result.status="cancelled")
    // 送达渲染端。abort() 让 harness 自然返回 cancelled → CyreneAgent 发出
    // RUN_FINISHED → complete 回调清理 activeRuns + endLifecycle。
    // 每个 run 持有独立 AbortController，cancel 一个 runId 绝不影响其他 run。
    const abortRun = (id: string): void => {
      const run = activeRuns.get(id);
      if (run && !run.abortController.signal.aborted) {
        run.abortController.abort();
      }
      // 清理该 run 关联的 pending permission / ask_user / pop_quiz 卡片。
      // 渲染端通过 RUN_FINISHED(result.status="cancelled") 自然收到卡片关闭信号。
      cancelPendingChoicesForRun(id);
      cancelPendingApprovalsForRun(id);
      cancelPendingQuizzesForRun(id);
    };
    if (runId) {
      abortRun(runId);
    } else {
      for (const id of [...activeRuns.keys()]) {
        abortRun(id);
      }
    }
    return true;
  });

  // ── 调整：把待发条目标记为"插入当前运行下一步" ──
  // 绑定会话当前活跃运行（会话级运行守卫是唯一可信来源）。
  // 无活跃运行、Chat 模式（单请求运行没有安全的下一步）、条目带附件、
  // 已被认领或已标记其他运行时明确拒绝，消息留在普通队列并返回最新权威队列。
  ipc.handle(IPC.CHATS_PENDING_ADJUST, async (event: IpcMainInvokeEvent, payload: unknown) => {
    const body = payload as { sessionId?: unknown; messageId?: unknown };
    const sessionId = typeof body?.sessionId === "string" ? body.sessionId : "";
    const messageId = typeof body?.messageId === "string" ? body.messageId : "";
    if (!sessionId || !messageId) return { ok: false, error: "invalid-payload" };
    const session = await loadComposedSession(sessionId);
    if (!session) return { ok: false, error: "session-not-found" };
    const active = sessionActiveRuns.get(sessionId);
    if (!active) {
      return { ok: false, error: "no-active-run", queue: chatsStore.getPendingMessages(sessionId) ?? [] };
    }
    const mode = session.mode ?? (session.purpose === "proactive-chat" ? "chat" : "work");
    if (mode === "chat") {
      return { ok: false, error: "no-safe-next-step", queue: chatsStore.getPendingMessages(sessionId) ?? [] };
    }
    const result = chatsStore.markPendingAdjust(sessionId, messageId, active.runId);
    if (result.ok) broadcastChatsChanged(event.sender);
    return result;
  });
}
