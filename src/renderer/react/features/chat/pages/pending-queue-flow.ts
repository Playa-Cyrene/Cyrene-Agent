import type { ChatMessageItem } from "../components/ChatMessageList";
import type { ComposerAttachment } from "../components/ChatComposer";
import type {
  ChatMessage,
  ChatSession,
  ConversationMode,
  PendingChatMessage,
} from "../../../../../shared/chat-types";
import { t } from "../../../i18n";
import type { ChatStoreApi, PendingClaimResult, PendingMutationResult } from "./chat-page-bridge";
import type { AgentRunInput } from "./run/AgentRunController";
import { evaluateClaimRecovery } from "./session-runtime-state";

/**
 * 待发队列流程宿主：页面注入的端口。队列的权威数据在主进程会话文件里，
 * 页面只持显示投影；本模块串起入队 → 认领 → 派发 → 恢复的完整链路，
 * 端口全部回调化，便于用替身做流程级测试。
 */
export interface PendingQueueFlowHost {
  /** 主进程会话存储桥；未就绪时各操作安全失败 */
  getStore(): ChatStoreApi | undefined;
  /** 该会话在本页面是否仍有进行中的 run（run 结束会再次触发消费） */
  isSessionBusy(sessionId: string): boolean;
  /** 渲染态是否已含该消息（刷新恢复时用户消息已随会话灌入，避免重复追加） */
  hasRenderedMessage(sessionId: string, messageId: string): boolean;
  /** 替换该会话的待发队列投影；null 表示会话已删除，移除投影项 */
  replaceProjection(sessionId: string, queue: PendingChatMessage[] | null): void;
  /** 向渲染态追加消息（认领派发时补用户消息与助手占位） */
  appendMessages(sessionId: string, items: ChatMessageItem[]): void;
  /** 与手动发送一致的图片附件预处理（direct/caption 策略） */
  prepareImageAttachments(sessionId: string, messageId: string, attachments: ComposerAttachment[]): void;
  /** 刷新会话列表（认领产生真实历史后） */
  refreshSessions(mode: ConversationMode): void;
  /** 启动模型运行（页面侧 runModel：构造 AgentRunController 并跑完整轮） */
  startRun(input: AgentRunInput): Promise<void>;
  /** 用户可见错误提示 */
  reportError(message: string): void;
}

export interface PendingQueueFlow {
  /**
   * 把一条消息入队到主进程权威队列：会话忙时刷新投影显示队列并返回 true；
   * 空闲时消息随即被认领转正，跳过投影刷新以免队列 Dock 闪现几帧（认领
   * 结果会以权威剩余队列刷新投影，认领失败路径在 consume 里有兜底同步）。
   * 失败/异常保留草稿（由调用方控制）并按 notifyError 提示，返回 false。
   * 同模式同内容重试复用原稳定标识——入队回执丢失时靠主进程幂等去重，不产生重复消息。
   */
  enqueue(
    sessionId: string,
    mode: ConversationMode,
    entry: {
      id: string;
      rawContent: string;
      visibleContent: string;
      attachments?: ComposerAttachment[];
      userSticker?: string;
      resumeFromRunId?: string;
    },
    notifyError?: boolean,
  ): Promise<boolean>;
  /** 消费会话待发队列：先恢复残留认领（刷新/进程退出/启动失败），再认领队首并派发 */
  consume(mode: ConversationMode, sessionId: string): Promise<void>;
  /** 修改未认领条目文字（调用方已按现有解析规则产出原文/展示文字/表情标记） */
  editMessage(
    sessionId: string,
    messageId: string,
    update: { rawContent: string; visibleContent: string; userSticker?: string },
  ): Promise<boolean>;
  /** 把待发条目插入当前运行的下一步；不可调整时提示并保留普通队列 */
  adjustMessage(sessionId: string, messageId: string): Promise<boolean>;
  /** 拉取主进程权威队列刷新该会话的页面投影 */
  syncProjection(sessionId: string): Promise<void>;
  /** run 结束回调：刷新列表与投影；queuePaused 时暂停消费（先恢复认领再说） */
  handleRunFinished(input: { mode: ConversationMode; sessionId: string; queuePaused: boolean }): void;
}

/** 入队失败缓存上限：防止无限增长（仅缓存最近的失败重试锚点） */
const FAILED_ENQUEUE_CACHE_LIMIT = 32;

/**
 * 页面待发队列流程。认领/派发的核心不变量：
 * - 用户消息只由主进程认领时写入历史（一次写入），页面绝不重复追加；
 * - 认领 → run 被主进程接受 → 确认派发，期间任何中断都能从会话文件恢复；
 * - 恢复判定按 answersUserMessageId 关联「本次认领」与「对应模型运行」，
 *   认领记录损坏时暂停该会话并报错，绝不当作已完成。
 */
export function createPendingQueueFlow(getHost: () => PendingQueueFlowHost): PendingQueueFlow {
  /** 入队失败缓存：`${mode}::${rawContent}` → 原 id，重试复用避免重复入队 */
  const failedEnqueueIds = new Map<string, string>();
  /** 认领记录损坏（消息缺失）而暂停消费的会话：恢复需人工处理或重启后重新评估 */
  const pausedSessions = new Set<string>();

  function rememberFailedEnqueue(key: string, id: string): void {
    failedEnqueueIds.set(key, id);
    // FIFO 淘汰最旧的失败锚点
    while (failedEnqueueIds.size > FAILED_ENQUEUE_CACHE_LIMIT) {
      const oldest = failedEnqueueIds.keys().next().value;
      if (oldest === undefined) break;
      failedEnqueueIds.delete(oldest);
    }
  }

  async function enqueue(
    sessionId: string,
    mode: ConversationMode,
    entry: {
      id: string;
      rawContent: string;
      visibleContent: string;
      attachments?: ComposerAttachment[];
      userSticker?: string;
      resumeFromRunId?: string;
    },
    notifyError = true,
  ): Promise<boolean> {
    const host = getHost();
    const store = host.getStore();
    if (!store) {
      if (notifyError) {
        host.reportError(t("chatPage.errorEnqueueFailed", { error: t("chatPage.errorChatStoreUnavailable") }));
      }
      return false;
    }
    // 附件完整性守卫：不完整的附件（缺文件路径/种类非法）整条拒绝——
    // 静默丢弃会让消息"看起来发出去了"却少了附件，此处保留草稿让用户处理
    const invalid = (entry.attachments ?? []).find(
      (attachment) => (attachment.kind !== "image" && attachment.kind !== "document")
        || !attachment.filePath
        || !attachment.name,
    );
    if (invalid) {
      if (notifyError) host.reportError(t("chatPage.errorAttachmentIncomplete"));
      return false;
    }
    // 稳定标识复用：上次同内容入队失败/异常（结果未知）时沿用原 id，
    // 若上次其实已成功，主进程幂等比较会返回现有队列而不重复写入
    const cacheKey = `${mode}::${entry.rawContent}`;
    const id = failedEnqueueIds.get(cacheKey) ?? entry.id;
    const stableAttachments = (entry.attachments ?? []).map((attachment) => attachment.kind === "image" ? {
      kind: "image" as const,
      name: attachment.name,
      filePath: attachment.filePath!,
      ...(attachment.mime ? { mime: attachment.mime } : {}),
      ...(attachment.caption ? { caption: attachment.caption } : {}),
      ...(attachment.hasAnnotations === true ? { hasAnnotations: true } : {}),
    } : {
      kind: "document" as const,
      name: attachment.name,
      filePath: attachment.filePath!,
    });
    let result: Awaited<ReturnType<ChatStoreApi["pendingEnqueue"]>>;
    try {
      result = await store.pendingEnqueue(sessionId, {
        id,
        rawContent: entry.rawContent,
        visibleContent: entry.visibleContent,
        ...(stableAttachments.length > 0 ? { attachments: stableAttachments } : {}),
        ...(entry.userSticker ? { userSticker: entry.userSticker } : {}),
        ...(entry.resumeFromRunId ? { resumeFromRunId: entry.resumeFromRunId } : {}),
      });
    } catch (error) {
      // 入队请求异常（IPC 断连等）：结果未知，缓存原 id 供重试去重
      rememberFailedEnqueue(cacheKey, id);
      if (notifyError) {
        host.reportError(t("chatPage.errorEnqueueFailed", {
          error: error instanceof Error ? error.message : String(error),
        }));
      }
      return false;
    }
    if (!result.ok) {
      rememberFailedEnqueue(cacheKey, id);
      if (notifyError) host.reportError(t("chatPage.errorEnqueueFailed", { error: result.error }));
      return false;
    }
    failedEnqueueIds.delete(cacheKey);
    // 会话忙（消息会留队等待）才立即刷新投影；空闲会话的消息马上会被
    // consume 认领转正，此刻刷投影会让队列 Dock 闪现几帧。
    // 认领成功会以权威剩余队列刷新投影，认领失败/异常路径在 consume 里有兜底同步
    if (host.isSessionBusy(sessionId)) {
      host.replaceProjection(sessionId, result.queue.map((item) => ({ ...item })));
    }
    return true;
  }

  async function consume(mode: ConversationMode, sessionId: string): Promise<void> {
    const host = getHost();
    const store = host.getStore();
    if (!store) return;
    // 认领记录损坏的会话已暂停：不再消费，等人工处理或重启后重新评估
    if (pausedSessions.has(sessionId)) return;
    // 页面侧该会话仍有进行中的 run：队列等 run 结束再消费
    if (host.isSessionBusy(sessionId)) return;
    let session: ChatSession | null;
    try {
      session = await store.get(sessionId);
    } catch (error) {
      console.warn("[pending-queue-flow] 读取会话失败，保留队首待下个触发点:", sessionId, error);
      // 入队时跳过了投影刷新，这里兜底同步让仍在队列的消息可见
      await syncProjection(sessionId);
      return;
    }
    if (!session) {
      // 会话已被删除：清投影并停止消费
      host.replaceProjection(sessionId, null);
      return;
    }
    // 残留认领优先恢复：认领的消息尚未确认派发，先处理它再消费下一条
    if (session.pendingDispatch) {
      await resumePendingDispatch(mode, sessionId, session);
      return;
    }
    let claim: PendingClaimResult;
    try {
      claim = await store.pendingClaim(sessionId);
    } catch (error) {
      console.warn("[pending-queue-flow] 认领请求异常，保留队首待下个触发点:", sessionId, error);
      await syncProjection(sessionId);
      return;
    }
    // 写盘失败保留队首；already-dispatching 说明另一窗口刚认领（它会派发），本窗口退出
    if (!claim.ok || !claim.claimed) {
      // 消息未被本窗口认领（写盘失败/他窗已认领/队列已空）：
      // 兜底同步投影，保证入队时跳过刷新的队列消息在页面上可见
      await syncProjection(sessionId);
      return;
    }
    // 认领成功即持有权威剩余队列：按稳定标识替换投影
    host.replaceProjection(sessionId, claim.remainingQueue.map((item) => ({ ...item })));
    await startClaimedRun(mode, sessionId, claim);
  }

  /**
   * 恢复残留认领（pendingDispatch）：被认领的用户消息已由主进程在认领/读取时
   * reconcile 落入权威轨迹（consume 前必有 store.get），清派发簿记不会丢消息。
   * 按关联锚点（answersUserMessageId）区分：
   * - 已派发完成（对应 run 已有终态回答/错误提示）：清派发簿记，继续消费下一条；
   * - 未派发（启动失败/守卫冲突/run 仍在进行/认领后进程退出）：同样只清簿记，
   *   绝不自动续派——没有新的用户意图就不产生新的模型请求；消息以「已发送
   *   未回答」留在历史，用户下一条消息会让模型在完整上下文里看到它；
   * - 认领记录指向的消息不存在（数据损坏）：暂停该会话队列并报错，绝不当作已完成。
   */
  async function resumePendingDispatch(
    mode: ConversationMode,
    sessionId: string,
    session: ChatSession,
  ): Promise<void> {
    const host = getHost();
    const store = host.getStore();
    if (!store) return;
    const pending = session.pendingDispatch;
    if (!pending) return;
    const status = evaluateClaimRecovery(session, pending.messageId);
    if (status.kind === "claim-message-missing") {
      pausedSessions.add(sessionId);
      host.reportError(t("chatPage.errorClaimMessageMissing"));
      return;
    }
    const completed = await store.pendingCompleteDispatch(sessionId, pending.messageId);
    if (!completed.ok) return; // 写盘失败：保留恢复入口，等下一个触发点
    await consume(mode, sessionId);
  }

  /**
   * 派发一条已认领的用户消息：用户消息由主进程认领时写入历史（本函数绝不重复追加），
   * 这里只补渲染态占位并启动模型运行；claimedPendingMessageId 让控制器在
   * run 被接受后清除派发状态。仅由 consume 的正常认领路径调用（残留认领恢复只清簿记）。
   */
  async function startClaimedRun(
    targetMode: ConversationMode,
    sessionId: string,
    claim: {
      userMessage: ChatMessage;
      visibleContent: string;
      resumeFromRunId?: string;
      session: ChatSession;
    },
  ): Promise<void> {
    const host = getHost();
    const assistantId = crypto.randomUUID();
    const attachments: ComposerAttachment[] = (claim.userMessage.attachments ?? []).map((attachment) => ({
      ...attachment,
      status: "pending",
    }));
    // 刷新恢复时用户消息已随会话灌入渲染态：只补助手占位，避免视图重复
    const assistantPlaceholder: ChatMessageItem = {
      id: assistantId,
      role: "assistant",
      content: "",
      loading: true,
      waitingForFirstEvent: true,
      streaming: false,
      responseStarted: false,
    };
    if (host.hasRenderedMessage(sessionId, claim.userMessage.id)) {
      host.appendMessages(sessionId, [assistantPlaceholder]);
    } else {
      host.appendMessages(sessionId, [
        {
          id: claim.userMessage.id,
          role: "user",
          content: claim.visibleContent,
          sticker: claim.userMessage.sticker,
          attachments: attachments.length > 0 ? attachments : undefined,
        },
        assistantPlaceholder,
      ]);
    }
    // 附件快照恢复派发：与手动发送一致地做图片预处理（caption 策略等）
    if (attachments.length > 0) {
      host.prepareImageAttachments(sessionId, claim.userMessage.id, attachments);
    }
    host.refreshSessions(targetMode);
    await host.startRun({
      targetMode,
      sessionId,
      userMessageId: claim.userMessage.id,
      assistantId,
      session: claim.session,
      attachments,
      visibleContent: claim.visibleContent,
      ...(claim.resumeFromRunId ? { resumeFromRunId: claim.resumeFromRunId } : {}),
      claimedPendingMessageId: claim.userMessage.id,
    });
  }

  /**
   * 修改未认领条目文字：成功时用主进程返回的权威队列刷新投影；
   * 失败/冲突时若返回了最新队列也刷新投影（不覆盖新状态），并按错误提示。
   */
  async function editMessage(
    sessionId: string,
    messageId: string,
    update: { rawContent: string; visibleContent: string; userSticker?: string },
  ): Promise<boolean> {
    const host = getHost();
    const store = host.getStore();
    if (!store) {
      host.reportError(t("chatPage.errorPendingEditFailed", { error: t("chatPage.errorChatStoreUnavailable") }));
      return false;
    }
    let result: PendingMutationResult;
    try {
      result = await store.pendingEdit(sessionId, messageId, update);
    } catch (error) {
      host.reportError(t("chatPage.errorPendingEditFailed", {
        error: error instanceof Error ? error.message : String(error),
      }));
      return false;
    }
    if (!result.ok) {
      if (result.queue) {
        host.replaceProjection(sessionId, result.queue.map((item) => ({ ...item })));
      }
      host.reportError(t("chatPage.errorPendingEditFailed", { error: result.error }));
      return false;
    }
    host.replaceProjection(sessionId, result.queue.map((item) => ({ ...item })));
    return true;
  }

  /**
   * 把待发条目插入当前运行的下一步：主进程绑定会话当前活跃运行。
   * 无活跃运行/Chat 模式没有安全下一步/条目带附件等被明确拒绝时，
   * 条目留在普通队列并按错误类型提示。
   */
  async function adjustMessage(sessionId: string, messageId: string): Promise<boolean> {
    const host = getHost();
    const store = host.getStore();
    if (!store) {
      host.reportError(t("chatPage.errorPendingAdjustFailed", { error: t("chatPage.errorChatStoreUnavailable") }));
      return false;
    }
    let result: PendingMutationResult;
    try {
      result = await store.pendingAdjust(sessionId, messageId);
    } catch (error) {
      host.reportError(t("chatPage.errorPendingAdjustFailed", {
        error: error instanceof Error ? error.message : String(error),
      }));
      return false;
    }
    if (!result.ok) {
      if (result.queue) {
        host.replaceProjection(sessionId, result.queue.map((item) => ({ ...item })));
      }
      const errorKey = result.error === "no-active-run" || result.error === "no-safe-next-step"
        ? t("chatPage.errorPendingAdjustNoRun")
        : result.error === "has-attachments"
          ? t("chatPage.errorPendingAdjustAttachments")
          : result.error;
      host.reportError(t("chatPage.errorPendingAdjustFailed", { error: errorKey }));
      return false;
    }
    host.replaceProjection(sessionId, result.queue.map((item) => ({ ...item })));
    return true;
  }

  async function syncProjection(sessionId: string): Promise<void> {
    const host = getHost();
    const store = host.getStore();
    if (!store) return;
    let queue: PendingChatMessage[] | null;
    try {
      queue = await store.pendingList(sessionId);
    } catch (error) {
      console.warn("[pending-queue-flow] 读取待发队列失败，投影保持不变:", sessionId, error);
      return;
    }
    host.replaceProjection(sessionId, queue === null ? null : queue.map((item) => ({ ...item })));
  }

  function handleRunFinished(input: { mode: ConversationMode; sessionId: string; queuePaused: boolean }): void {
    const host = getHost();
    host.refreshSessions(input.mode);
    void syncProjection(input.sessionId);
    // queuePaused：run 未被主进程接受（启动失败/守卫冲突挂起接管），
    // 认领的消息尚未派发成功——暂停消费，等接管决定或下次会话切换/刷新触发恢复
    if (input.queuePaused) return;
    void consume(input.mode, input.sessionId);
  }

  return { enqueue, consume, editMessage, adjustMessage, syncProjection, handleRunFinished };
}
