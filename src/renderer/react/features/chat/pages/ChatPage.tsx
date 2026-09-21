import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "../../../i18n";
import { DownOutlined } from "@ant-design/icons";
import { Group, Panel, Separator, useDefaultLayout } from "react-resizable-panels";
import { ChatComposer, parseComposerMessage } from "../components/ChatComposer";
import { ComposerSlot } from "../components/ComposerSlot";
import { TodoPanel } from "../components/TodoPanel";
import { CodeGitPanel } from "../components/CodeGitPanel";
import type { PlanReviewPhase } from "../components/PlanReviewPanel";
import { ChatPageInspector } from "../components/ChatPageInspector";
import {
  normalizeDeferredPlanChoice,
  normalizePopQuizCard,
  shouldDismissAsk,
  type ComposerInteraction,
} from "../components/run-presentation";
import { ChatMessageList } from "../components/ChatMessageList";
import { ChatPageNavigation, type ChatPagePanel } from "../components/ChatPageNavigation";
import {
  ContextCompressionNotice,
  FileDropOverlay,
  RunRecoveryNotices,
} from "../components/ChatWorkspaceNotices";
import { getTtsPlaybackSnapshot, playTtsToCompletion, stopTtsPlayback } from "../components/tts-playback";
import { EarlyTtsPlaybackQueue, type EarlyTtsSplitMode } from "../tts/early-tts-queue";

import type {
  ChatMessage,
  ChatSession,
  ChatSessionMeta,
  ConversationMode,
  PendingChatMessage,
} from "../../../../../shared/chat-types";
import { type ContextUsageSnapshot } from "../../../../../shared/context-usage";
import { ChatPagePanelHost } from "../components/ChatPagePanelHost";
import { useUserCallPreference } from "../../../hooks/useUserNickname";
import { resolveRevisableLastTurn } from "../components/last-turn-actions";
import { shouldListenForDeferredPlanEvents } from "./conversation-run-policy";

import {
  aguiApi,
  chatStore,
  choiceApi,
  settingsApprovalApi,
  sidebarApi,
  type ModelConfigApi,
  type PublicModelConfig,
} from "./chat-page-bridge";
import {
  getInitialMode,
  isConversationMode,
  LAST_MODE_STORAGE_KEY,
  permissionInteraction,
  toUiMessages,
} from "./chat-page-normalizers";
import {
  bootstrapReactSession,
  normalizeSessionMode,
  openSessionByIdWithDeps,
  type OpenSessionArgs,
  type ReactSessionMode,
} from "./openSessionByDeps";
import { useComposerAttachments } from "../hooks/useComposerAttachments";
import { useSessionMessages } from "../hooks/useSessionMessages";
import { useSchedulerEvents } from "../hooks/useSchedulerEvents";
import { useChannelMirrorEvents } from "../hooks/useChannelMirrorEvents";
import { useFeedback } from "../../../components/feedback/FeedbackProvider";
import { AgentRunController, type AgentRunInput } from "./run/AgentRunController";
import {
  clearSessionInteraction,
  bindWorkspaceName,
  findSessionIdForRun,
  hasActiveRunForSession,
  sessionInteraction,
  setSessionInteraction,
  setSessionInteractionBusy,
  type SessionInteractionState,
  type TodoStateBySession,
} from "./session-runtime-state";
import {
  createPendingQueueFlow,
  type PendingQueueFlow,
  type PendingQueueFlowHost,
} from "./pending-queue-flow";
import "../../../components/ui/SidebarToggle.css";
import { InspectorToggle } from "../../../components/ui/InspectorToggle";
import { OpenWorkspaceMenu } from "../components/OpenWorkspaceMenu";
import "../../../components/ui/ModeSwitch.css";
import "../../../components/ui/WindowControls.css";
import "../../../components/ui/SettingsButton.css";
import "../../../components/ui/UserAvatar.css";
import "../../../components/ui/NewTaskButton.css";
import "../../../components/ui/ToolModeButton.css";
import "../components/ChatComposer.css";
import "../components/ReasoningControl.css";
import "../components/StyleControl.css";
import "../components/PermissionControl.css";
import "../components/ChatMessageList.css";
import "../components/ConversationSidebar.css";
/**
 * React 窗口会话打开的纯函数 helper：
 * 从同目录的 openSessionByDeps 模块 re-export 出来，便于 ChatPage 内部组件与
 * 独立测试文件共享同一份实现。
 */
export {
  normalizeSessionMode,
  openSessionByIdWithDeps,
  type ReactSessionMode,
  type OpenSessionArgs,
};

// 空列表固定引用：sessionsByMode[mode] 未加载时避免每次渲染产生新数组穿透导航 memo
const EMPTY_SESSIONS: ChatSessionMeta[] = [];

// 会话列表内容浅比较：run 结束等触发的重复刷新内容未变时保持原引用，
// 避免无谓的 sessionsByMode 新引用穿透导航/侧栏 memo（阶段 1A）
function sessionMetaListEqual(a: ChatSessionMeta[], b: ChatSessionMeta[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    const x = a[i]!;
    const y = b[i]!;
    if (
      x.id !== y.id
      || x.title !== y.title
      || x.identityId !== y.identityId
      || x.createdAt !== y.createdAt
      || x.updatedAt !== y.updatedAt
      || x.messageCount !== y.messageCount
      || x.purpose !== y.purpose
      || x.mode !== y.mode
      || x.workspaceRoot !== y.workspaceRoot
      || x.workspaceDisplayName !== y.workspaceDisplayName
      || x.pinned !== y.pinned
    ) return false;
  }
  return true;
}

/** 导航动作函数的最小签名（供 navActionsRef 转发，见组件内注释） */
interface NavActions {
  createNewTask: () => Promise<void>;
  selectSession: (sessionId: string, targetMode?: ConversationMode) => Promise<void>;
  handleRenameSession: (sessionId: string, newTitle: string) => Promise<void>;
  handleDeleteSession: (sessionId: string) => Promise<void>;
  handleTogglePinSession: (sessionId: string, pinned: boolean) => Promise<void>;
  openProject: (workspaceRoot: string) => void;
}

export function ChatPage() {
  const { t } = useTranslation();
  // 统一反馈入口：错误轻提示 / 需阅读的错误弹窗 / 危险确认
  const feedback = useFeedback();
  const preferredAddress = useUserCallPreference();
  const [collapsed, setCollapsed] = useState(false);
  const [activePanel, setActivePanel] = useState<ChatPagePanel | null>(null);
  /** 右侧面板已打开的 diff 标签，ID 规范 diff:<runId>:<文件路径>，同 ID 只激活不重开 */
  const [diffTabs, setDiffTabs] = useState<
    { id: string; runId: string; fileIndex: number; filePath: string }[]
  >([]);
  /** 右侧面板已打开的文件预览标签，ID 规范 file:<相对路径> */
  const [fileTabs, setFileTabs] = useState<{ id: string; relPath: string; line?: number; lineSeq?: number }[]>([]);
  /** 工作区文件树标签是否打开（ID 固定为 files） */
  const [filesTabOpen, setFilesTabOpen] = useState(false);
  /** 右侧面板当前激活的标签 ID（files / file:... / diff:... / plan:...），null 时面板取第一个标签 */
  const [activeTabId, setActiveTabId] = useState<string | null>(null);
  // 右栏拖宽布局：聊天区 + 右侧面板套 Group/Panel，宽度持久化到 localStorage。
  // onlySaveAfterUserInteractions 保证只记用户拖动结果，不在挂载/程序化布局时写盘。
  const { defaultLayout, onLayoutChanged } = useDefaultLayout({
    id: "cyrene.chat-page-dock",
    panelIds: ["chat", "inspector"],
    onlySaveAfterUserInteractions: true,
  });
  const [mode, setMode] = useState<ConversationMode>(getInitialMode);
  const [drafts, setDrafts] = useState<Record<string, string>>({});

  const [workspaceNames, setWorkspaceNames] = useState<Partial<Record<ConversationMode, string>>>({});
  const [pendingWorkspaceByMode, setPendingWorkspaceByMode] = useState<
    Partial<Record<ConversationMode, { path: string; displayName?: string }>>
  >({});
  // 欢迎页（无会话）暂存的模型选择：ensureSession 建会话后落地（与 pendingWorkspaceByMode 同构）。
  const [pendingModelProfileByMode, setPendingModelProfileByMode] = useState<
    Partial<Record<ConversationMode, string>>
  >({});
  const [sessionsByMode, setSessionsByMode] = useState<Partial<Record<ConversationMode, ChatSessionMeta[]>>>({});
  const [activeSessionIds, setActiveSessionIds] = useState<Partial<Record<ConversationMode, string>>>({});

  const [modelBusyByMode, setModelBusyByMode] = useState<Partial<Record<ConversationMode, boolean>>>({});
  const [isCompressingContext, setIsCompressingContext] = useState(false);
  const [interactionsBySession, setInteractionsBySession] = useState<SessionInteractionState>({});
  const [lastTurnRevisionStarting, setLastTurnRevisionStarting] = useState(false);
  const [stickerSize, setStickerSize] = useState<"small" | "standard" | "large">("standard");

  const [todoStateBySession, setTodoStateBySession] = useState<TodoStateBySession>({});
  // 计划模式（Plan Mode 二期）：会话级计划面板内容与阶段（review → executing → completed）。
  const [planReviewBySession, setPlanReviewBySession] = useState<
    Record<string, { content: string; planPath: string; phase: PlanReviewPhase }>
  >({});
  const [planDrawerOpen, setPlanDrawerOpen] = useState(false);
  const [interruptedRun, setInterruptedRun] = useState<{ runId: string; rounds: number; todoCount: number } | null>(null);
  // 会话守卫冲突（SESSION_RUN_ACTIVE）：主进程拒绝了并发 run，
  // 等用户决定是否终止旧 run 并接管重开本轮。仅 UX 层；正确性由主进程守卫保证。
  const [sessionTakeover, setSessionTakeover] = useState<{
    sessionId: string;
    activeRunId: string;
    retry: () => Promise<void>;
  } | null>(null);
  const activeModeRef = useRef(mode);
  const activeSessionIdsRef = useRef(activeSessionIds);
  const activeScopeRef = useRef(`mode:${mode}`);
  const sessionSelectionGeneration = useRef(0);

  const activeRunsBySession = useRef<Record<string, { assistantId: string; runId?: string; mode: ConversationMode }>>({});
  const runCheckpointBySessionRef = useRef<Record<string, (status: "running" | "waiting_user") => void>>({});
  // bootstrap 标志：只由 cold-start finally 写入；模式切换 effect 仅检查
  const [bootstrapCompleted, setBootstrapCompleted] = useState(false);
  const observedModeRef = useRef(mode);
  // 长期持有的刷新操作 ref：供 IPC 回调读取当前实现
  const refreshSessionsRef = useRef<
    (targetMode: ConversationMode, selectCurrent: boolean) => Promise<void>
  >(async () => {});
  // IPC 切换串行链：保证 Ready 后连续切换按顺序完成
  const reactSessionSwitchChainRef = useRef<Promise<void>>(Promise.resolve());
  // 滚动到底部按钮状态
  const [scrollToBottomVisible, setScrollToBottomVisible] = useState(false);
  const scrollToBottomRef = useRef<() => void>(() => {});
  // 阶段 1B：注册回调稳定化——ChatMessageList 的注册 effect 依赖该引用，避免每次渲染反复注销/重注册
  const registerScrollToBottom = useCallback((scroll: () => void) => {
    scrollToBottomRef.current = scroll;
  }, []);

  // 消息域：渲染态消息按会话存储；补丁通道供 run 事件流、TTS、取消与附件预处理共用
  const {
    messagesBySession,
    patchMessage: updateMessage,
    hydrateMessages,
    replaceSessionMessages,
    appendMessages,
    patchMessageAttachments: updateMessageAttachments,
  } = useSessionMessages((targetMode) => activeSessionIdsRef.current[targetMode]);

  // 定时任务执行事件：任务触发/流式回复/终态展示在当前会话（主进程 scheduler-runner 推送）
  useSchedulerEvents({
    getActiveSessionId: () => activeSessionIdsRef.current[activeModeRef.current],
    appendMessages,
    patchMessage: updateMessage,
    persistMessage: (sessionId, message) => {
      void chatStore()?.append(sessionId, message);
    },
  });

  // 渠道消息镜像：微信/飞书等外部渠道收发消息以临时系统消息展示在当前会话（dispatcher 推送）
  useChannelMirrorEvents({
    getActiveSessionId: () => activeSessionIdsRef.current[activeModeRef.current],
    appendMessages,
  });

  useEffect(() => {
    const settings = settingsApprovalApi();
    if (!settings) return;
    const offRequest = settings.onPermissionApprovalRequest((request) => {
      const currentMode = activeModeRef.current;
      const currentSessionId = activeSessionIdsRef.current[currentMode];
      const ownerSessionId = findSessionIdForRun(activeRunsBySession.current, request.runId)
        ?? currentSessionId;
      // 路由不到会话时先丢弃：主进程每 10s 幂等重播，会话就绪后卡片自然出现。
      if (!ownerSessionId) return;
      setInteractionForSession(ownerSessionId, permissionInteraction(request));
      const activeRun = activeRunsBySession.current[ownerSessionId];
      if (activeRun) {
        updateMessage(ownerSessionId, activeRun.assistantId, { runStage: { kind: "waiting_permission" } });
        runCheckpointBySessionRef.current[ownerSessionId]?.("waiting_user");
      }
    });
    // 结算广播：pending 已在主进程被结算（用户已答 / run 取消），
    // 渲染端据此立即清卡——这是「僵尸审批卡（点了没反应）」的根治点。
    const offSettled = settings.onPermissionApprovalSettled((settlement) => {
      setInteractionsBySession((current) => {
        for (const [sessionId, entry] of Object.entries(current)) {
          if (entry.interaction.kind === "permission" && entry.interaction.id === settlement.id) {
            const next = { ...current };
            delete next[sessionId];
            return next;
          }
        }
        return current;
      });
    });
    return () => {
      offRequest();
      offSettled();
    };
  }, []);

  // pop_quiz 抽查卡片（learn 模式）：与审批流同构的持久监听。
  // 请求按 runId 路由到所属会话；结算广播只清 skipped/cancelled——
  // submitted 时卡片要留在原地切展示态（判分结果 + 解析），等 run 结束统一收卡。
  useEffect(() => {
    const settings = settingsApprovalApi();
    if (!settings) return;
    const offRequest = settings.onPopQuizRequest((card) => {
      const interaction = normalizePopQuizCard(card);
      if (!interaction) return;
      const currentMode = activeModeRef.current;
      const currentSessionId = activeSessionIdsRef.current[currentMode];
      const ownerSessionId = findSessionIdForRun(activeRunsBySession.current, card.runId)
        ?? currentSessionId;
      // 路由不到会话时先丢弃：主进程每 10s 幂等重播，会话就绪后卡片自然出现。
      if (!ownerSessionId) return;
      setInteractionForSession(ownerSessionId, interaction);
      const activeRun = activeRunsBySession.current[ownerSessionId];
      if (activeRun) {
        updateMessage(ownerSessionId, activeRun.assistantId, { runStage: { kind: "waiting_user" } });
        runCheckpointBySessionRef.current[ownerSessionId]?.("waiting_user");
      }
    });
    const offSettled = settings.onPopQuizSettled((settlement) => {
      if (settlement.reason === "submitted") return;
      setInteractionsBySession((current) => {
        for (const [sessionId, entry] of Object.entries(current)) {
          if (entry.interaction.kind === "quiz" && entry.interaction.id === settlement.quizId) {
            const next = { ...current };
            delete next[sessionId];
            return next;
          }
        }
        return current;
      });
    });
    return () => {
      offRequest();
      offSettled();
    };
  }, []);

  useEffect(() => {
    const modelConfig = (window as typeof window & { modelConfig?: ModelConfigApi }).modelConfig;
    if (!modelConfig) return;
    let active = true;
    const apply = (config: PublicModelConfig) => {
      if (!active) return;
      setStickerSize(config.stickerSize === "small" || config.stickerSize === "large" ? config.stickerSize : "standard");
    };
    void modelConfig.get().then(apply).catch(() => {
      if (active) setStickerSize("standard");
    });
    const off = modelConfig.onChanged(apply);
    return () => {
      active = false;
      off();
    };
  }, []);
  const modelBusyByModeRef = useRef<Partial<Record<ConversationMode, boolean>>>({});
  const lastTurnRevisionStartingRef = useRef(false);
  const activeAguiOffsRef = useRef(new Set<() => void>());
  const cancelRequestedSessionsRef = useRef(new Set<string>());
  // 会话待发队列投影：权威数据是主进程会话文件里的 pendingMessages，
  // 页面只持显示快照，入队/删除/认领/其他窗口变更后按稳定标识（id）对账刷新
  const [pendingQueueBySession, setPendingQueueBySession] = useState<Record<string, PendingChatMessage[]>>({});
  const pendingQueueBySessionRef = useRef(pendingQueueBySession);
  useEffect(() => {
    pendingQueueBySessionRef.current = pendingQueueBySession;
  }, [pendingQueueBySession]);
  const activeEarlyTtsRef = useRef<{
    queue: EarlyTtsPlaybackQueue;
    mode: ConversationMode;
    sessionId: string;
    messageId: string;
  } | null>(null);

  const activeSessionId = activeSessionIds[mode];
  const scopeKey = activeSessionId ?? `mode:${mode}`;
  const draft = drafts[scopeKey] ?? "";
  const messages = activeSessionId ? (messagesBySession[activeSessionId] ?? []) : [];
  const activeInteraction = sessionInteraction(interactionsBySession, activeSessionId);
  const composerInteraction = activeInteraction?.interaction;
  const interactionBusy = activeInteraction?.busy ?? false;
  const hasMessages = messages.length > 0;
  const {
    attachments,
    attachmentBusy,
    isDraggingFiles,
    chooseFiles,
    handlePastedImage,
    handleScreenshot,
    removeAttachment,
    prepareImageAttachments,
    clearScopeAttachments,
    deleteScopeAttachments,
    dragHandlers,
  } = useComposerAttachments({
    scopeKey,
    getActiveScope: () => activeScopeRef.current,
    patchMessageAttachments: updateMessageAttachments,
  });

  // 渲染态消息快照 ref：待发队列流程查询消息是否已在视图（刷新恢复时不重复追加）
  const messagesBySessionRef = useRef(messagesBySession);
  messagesBySessionRef.current = messagesBySession;

  // 待发队列流程：入队/认领/派发/恢复的页面链路（独立模块，便于流程级测试）。
  // host 经 ref 每次渲染刷新到最新闭包；流程实例与入队失败缓存跨渲染稳定。
  const queueFlowHostRef = useRef<PendingQueueFlowHost | null>(null);
  queueFlowHostRef.current = {
    getStore: () => chatStore(),
    isSessionBusy,
    hasRenderedMessage: (sessionId, messageId) =>
      (messagesBySessionRef.current[sessionId] ?? []).some((item) => item.id === messageId),
    replaceProjection: (sessionId, queue) => {
      setPendingQueueBySession((current) => {
        if (queue === null) {
          if (!(sessionId in current)) return current;
          const next = { ...current };
          delete next[sessionId];
          return next;
        }
        return { ...current, [sessionId]: queue.map((item) => ({ ...item })) };
      });
    },
    appendMessages,
    prepareImageAttachments: (sessionId, messageId, attachmentList) => {
      void prepareImageAttachments(sessionId, messageId, attachmentList);
    },
    refreshSessions: (targetMode) => {
      void refreshSessions(targetMode, false);
    },
    startRun: runModel,
    reportError: (message) => feedback.notice({ tone: "error", message }),
  };
  const queueFlowRef = useRef<PendingQueueFlow | null>(null);
  if (!queueFlowRef.current) {
    queueFlowRef.current = createPendingQueueFlow(() => queueFlowHostRef.current!);
  }
  const queueFlow = queueFlowRef.current;
  const sessions = sessionsByMode[mode] ?? EMPTY_SESSIONS;
  const [activeSession, setActiveSession] = useState<ChatSession | null>(null);
  // 会话级最新上下文快照（环形图优先读取点）：run 事件实时写入；
  // 手动压缩后随会话重载从 session.currentContextUsage 初始化（known-issues 问题 3）。
  const [sessionContextUsageBySession, setSessionContextUsageBySession] = useState<Record<string, ContextUsageSnapshot>>({});

  activeModeRef.current = mode;
  activeSessionIdsRef.current = activeSessionIds;
  activeScopeRef.current = scopeKey;

  // 缓存用户最后停留的模式，下次打开窗口时恢复
  useEffect(() => {
    try {
      localStorage.setItem(LAST_MODE_STORAGE_KEY, mode);
    } catch {
      // 忽略写入失败
    }
  }, [mode]);

  useEffect(() => () => {
    for (const off of activeAguiOffsRef.current) off();
    activeAguiOffsRef.current.clear();
    activeEarlyTtsRef.current?.queue.cancel();
    activeEarlyTtsRef.current = null;
  }, []);

  useEffect(() => {
    const store = chatStore();
    if (!store) return;
    const refresh = () => {
      void refreshSessions(activeModeRef.current, true);
      // 队列投影对账：刷新当前各模式活跃会话与所有仍有投影的会话
      // （其他窗口可能入队/删除/认领；会话已删时 pendingList 返回 null 清除投影）
      const sessionIds = new Set<string>(Object.keys(pendingQueueBySessionRef.current));
      for (const activeId of Object.values(activeSessionIdsRef.current)) {
        if (activeId) sessionIds.add(activeId);
      }
      for (const sessionId of sessionIds) void queueFlow.syncProjection(sessionId);
    };
    const off = store.onChanged(refresh);
    return off;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 模式 effect：bootstrap 完成后才刷新；bootstrap 自身由下方合并 effect 接管
  useEffect(() => {
    const previousMode = observedModeRef.current;
    observedModeRef.current = mode;
    if (!bootstrapCompleted || previousMode === mode) return;
    void refreshSessionsRef.current(mode, true).catch((error) => {
      console.error("[ChatPage] Failed to refresh sessions after mode change:", error);
    });
  }, [bootstrapCompleted, mode]);

  // 合并 effect：注册 IPC → cold-start → finally 置 bootstrap + 通知 ready
  useEffect(() => {
    const store = chatStore();
    if (!store?.onReactSwitchSession) return;

    let disposed = false;

    const unsubscribe = store.onReactSwitchSession((sessionId) => {
      if (!sessionId) return;
      reactSessionSwitchChainRef.current = reactSessionSwitchChainRef.current
        .then(async () => {
          const opened = await openSessionById(sessionId);
          if (!opened) {
            await refreshSessionsRef.current(activeModeRef.current, true);
          }
        })
        .catch(async (error) => {
          console.error("[ChatPage] Failed to switch React session:", error);
          try {
            await refreshSessionsRef.current(activeModeRef.current, true);
          } catch (fallbackError) {
            console.error("[ChatPage] Switch fallback failed:", fallbackError);
          }
        });
    });

    void bootstrapReactSession({
      urlSessionId: new URLSearchParams(window.location.search).get("sessionId"),
      currentMode: activeModeRef.current as ReactSessionMode,
      openSession: openSessionById,
      refreshSessions: async (targetMode, selectCurrent) => {
        await refreshSessions(targetMode as ConversationMode, selectCurrent);
      },
    }).catch((error) => {
      console.error("[ChatPage] Failed to bootstrap React session:", error);
    }).finally(() => {
        // cold-start 全程完成才标记 bootstrap 完成；只有该标志置位后
        // mode 切换 effect 才会触发 refreshSessions
        setBootstrapCompleted(true);
        if (!disposed) store.notifyReactReady?.();
    });

    return () => {
      disposed = true;
      unsubscribe();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 外部语音文本提交：主进程经 IPC 要求把文本提交到租约冻结的会话。
  // 页面重新加载后 rendererTargetId 变化，旧目标的迟到请求直接回绝。
  useEffect(() => {
    const store = chatStore();
    if (!store?.onSpeechInputCommitRequest) return;
    const unsubscribe = store.onSpeechInputCommitRequest((request) => {
      void (async () => {
        let result: { ok: true } | { ok: false; error: { code: string; message: string } };
        if (request.rendererTargetId !== store.getRendererTargetId()) {
          result = {
            ok: false,
            error: { code: "E_NO_ACTIVE_INPUT_TARGET", message: "渲染目标已过期" },
          };
        } else {
          result = await submitTextToSession({
            sessionId: request.sessionId,
            mode: request.mode,
            text: request.text,
          });
        }
        store.sendSpeechInputCommitResult({
          requestId: request.requestId,
          rendererTargetId: request.rendererTargetId,
          ...(result.ok ? { ok: true } : { ok: false, error: result.error }),
        });
      })();
    });
    return unsubscribe;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const active = activeEarlyTtsRef.current;
    if (active && (active.mode !== mode || active.sessionId !== activeSessionId)) {
      active.queue.cancel();
      activeEarlyTtsRef.current = null;
    }
  }, [activeSessionId, mode]);

  useEffect(() => {
    const sessionId = activeSessionId;
    const api = aguiApi();
    if (!sessionId || !api?.getInterruptedRun || mode === "chat") {
      setInterruptedRun(null);
      return;
    }
    let active = true;
    void api.getInterruptedRun(sessionId).then((run) => {
      if (active) setInterruptedRun(run ? { runId: run.runId, rounds: run.rounds, todoCount: run.todoCount } : null);
    }).catch(() => { if (active) setInterruptedRun(null); });
    return () => { active = false; };
  }, [activeSessionId, mode]);

  // 计划模式事件（Plan Mode）：review/approved/exited 在 run 结束后由主进程发出
  // （run 订阅已解除），必须持久监听；completed 在 run 内发出，run 订阅无此分支，
  // 也统一在这里处理。批准后自动发送执行消息（sendMessage 自带 busy 排队机制）。
  useEffect(() => {
    const api = aguiApi();
    if (!api?.onEvent || !shouldListenForDeferredPlanEvents(mode) || !activeSessionId) return;
    const off = api.onEvent((event) => {
      if (event.type !== "CUSTOM" || typeof event.name !== "string") return;
      if (event.name === "cyrene.choice") {
        const interaction = normalizeDeferredPlanChoice(event.value, activeSessionId);
        if (interaction) setInteractionForSession(activeSessionId, interaction);
        return;
      }
      if (event.name === "cyrene.choice.dismiss") {
        // run 事件闸之外的 dismiss（老版选择卡超时 / run 结束后发出的结算）：
        // 匹配当前 ask 卡时清掉，避免留下点不出结果的僵尸卡。
        setInteractionsBySession((current) => {
          const entry = current[activeSessionId];
          if (!entry || entry.interaction.kind !== "ask" || !shouldDismissAsk(entry.interaction, event.value)) return current;
          return clearSessionInteraction(current, activeSessionId);
        });
        return;
      }
      if (!event.name.startsWith("cyrene.plan.")) return;
      const value = (event.value ?? null) as { sessionId?: string; planPath?: string; planContent?: string; text?: string } | null;
      if (value?.sessionId && value.sessionId !== activeSessionId) return;
      switch (event.name) {
        case "cyrene.plan.review":
          if (value?.sessionId && typeof value.planContent === "string" && value.planContent.trim()) {
            setPlanReviewBySession((current) => ({
              ...current,
              [value.sessionId!]: {
                content: value.planContent!,
                planPath: value.planPath ?? "",
                phase: "review",
              },
            }));
            setPlanDrawerOpen(true);
            setActiveTabId(`plan:${value.sessionId}`);
          }
          break;
        case "cyrene.plan.approved":
          if (value?.sessionId) {
            setPlanReviewBySession((current) => current[value.sessionId!]
              ? { ...current, [value.sessionId!]: { ...current[value.sessionId!], phase: "executing" } }
              : current);
            void sendMessage(t("chatPage.planApprovedAutoMessage"));
          }
          break;
        case "cyrene.plan.supplement":
          // 第二段补充卡提交的文本：作为用户消息发给模型修改计划，改完会重新走审批
          if (value?.sessionId && typeof value.text === "string" && value.text.trim()) {
            void sendMessage(value.text);
          }
          break;
        case "cyrene.plan.completed":
          // adapter 发出时不带 sessionId；按当前计划会话处理
          setPlanReviewBySession((current) => current[activeSessionId]
            ? { ...current, [activeSessionId]: { ...current[activeSessionId], phase: "completed" } }
            : current);
          break;
      }
    });
    return off;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, activeSessionId]);

  function setInteractionForSession(sessionId: string, interaction: ComposerInteraction): void {
    setInteractionsBySession((current) => setSessionInteraction(current, sessionId, interaction));
  }

  function clearInteractionForSession(sessionId: string): void {
    setInteractionsBySession((current) => clearSessionInteraction(current, sessionId));
  }

  function setInteractionBusyForSession(sessionId: string, busy: boolean): void {
    setInteractionsBySession((current) => setSessionInteractionBusy(current, sessionId, busy));
  }


  function handleTtsCacheKey(
    sessionId: string,
    messageId: string,
    cacheKey: string,
    converterVersion: string,
  ) {
    updateMessage(sessionId, messageId, { ttsCacheKey: cacheKey, ttsCacheVersion: converterVersion });
    void chatStore()?.setMessageTtsCacheKey(sessionId, messageId, cacheKey, converterVersion);
  }

  // 阶段 1B：TTS 缓存回调稳定化——roles 依赖该引用，仅会话切换时换新；
  // 内部 updateMessage 走函数式 setState，捕获旧闭包安全
  const handleTtsCacheKeyForActiveSession = useCallback(
    (messageId: string, cacheKey: string, converterVersion: string) => {
      if (!activeSessionId) return;
      handleTtsCacheKey(activeSessionId, messageId, cacheKey, converterVersion);
    },
    [activeSessionId],
  );

  function createEarlyTtsQueue(
    targetMode: ConversationMode,
    sessionId: string,
    messageId: string,
    splitMode: EarlyTtsSplitMode = "sentence",
  ): EarlyTtsPlaybackQueue {
    activeEarlyTtsRef.current?.queue.cancel();
    const queue = new EarlyTtsPlaybackQueue(
      async (segment) => {
        if (
          activeModeRef.current !== targetMode
          || activeSessionIdsRef.current[targetMode] !== sessionId
          || activeEarlyTtsRef.current?.queue !== queue
        ) return "interrupted";
        return await playTtsToCompletion({
          conversationId: sessionId,
          messageId,
          text: segment,
          speechMode: targetMode === "learn" ? "learn" : "default",
          preferredAddress,
          automatic: true,
        });
      },
      stopTtsPlayback,
      splitMode,
    );
    activeEarlyTtsRef.current = { queue, mode: targetMode, sessionId, messageId };
    return queue;
  }

  function finishEarlyTtsQueue(queue: EarlyTtsPlaybackQueue, fullText: string): void {
    void queue.finish(fullText).finally(() => {
      const active = activeEarlyTtsRef.current;
      if (active?.queue !== queue) return;
      const playback = getTtsPlaybackSnapshot();
      if (playback.messageId === active.messageId && playback.status === "completed") stopTtsPlayback();
      activeEarlyTtsRef.current = null;
    });
  }

  async function selectSession(sessionId: string, targetMode: ConversationMode = mode) {
    const store = chatStore();
    if (!store) return;
    const generation = ++sessionSelectionGeneration.current;
    const session = await store.get(sessionId);
    if (!session || generation !== sessionSelectionGeneration.current) return;
    setActiveSession(session);
    // 环形图快照初始化：session 级（压缩后写入）与消息级（最近 run 留下）取最新。
    setSessionContextUsageBySession((current) => {
      const messageLevel = session.messages.findLast((message) => message.contextUsage)?.contextUsage;
      const sessionLevel = session.currentContextUsage;
      const best = sessionLevel && (!messageLevel || sessionLevel.updatedAt >= messageLevel.updatedAt)
        ? sessionLevel
        : messageLevel;
      if (!best || current[sessionId]?.updatedAt === best.updatedAt) return current;
      return { ...current, [sessionId]: best };
    });
    setActiveSessionIds((current) => {
      const next = { ...current, [targetMode]: sessionId };
      activeSessionIdsRef.current = next;
      return next;
    });
    const uiMessages = toUiMessages(session);
    const latestRunSnapshot = session.messages.findLast((message) => message.runSnapshot)?.runSnapshot;
    if (latestRunSnapshot?.todos) {
      setTodoStateBySession((current) => {
        if (hasActiveRunForSession(activeRunsBySession.current, sessionId) && current[sessionId]) return current;
        return {
          ...current,
          [sessionId]: {
            runId: latestRunSnapshot.runId,
            todos: latestRunSnapshot.todos ?? [],
            updatedAt: latestRunSnapshot.updatedAt,
          },
        };
      });
    }
    hydrateMessages(sessionId, uiMessages, hasActiveRunForSession(activeRunsBySession.current, sessionId));
    setWorkspaceNames((current) => ({
      ...current,
      [targetMode]: session.workspaceBinding?.displayName,
    }));
    if (targetMode === activeModeRef.current) void store.setActiveSession(sessionId, targetMode);
    // 切到会话即对账队列投影，并尝试消费队列/恢复残留认领
    // （页面刷新、进程重启后队列消费的恢复入口；会话忙或队列空时内部直接返回）
    void queueFlow.syncProjection(sessionId);
    void queueFlow.consume(targetMode, sessionId);
  }

  /**
   * 通过 ref 暴露给 IPC 切换链和初始化 effect；成功切换后同步写回 URL，
   * 不触发页面重新加载。
   */
  async function openSessionById(sessionId: string): Promise<boolean> {
    const opened = await openSessionByIdWithDeps({
      sessionId,
      getSession: async (id) => {
        const store = chatStore();
        if (!store) return null;
        const result = await store.get(id);
        return (result ?? null) as { mode?: string } | null;
      },
      selectSession: async (id, targetMode) => {
        await selectSession(id, targetMode as ConversationMode);
      },
    });
    if (opened && typeof window !== "undefined") {
      try {
        const url = new URL(window.location.href);
        url.searchParams.set("sessionId", sessionId);
        window.history.replaceState(
          null,
          "",
          `${url.pathname}${url.search}${url.hash}`,
        );
      } catch {
        // 忽略 URL 同步失败，不影响会话切换
      }
    }
    return opened;
  }

  async function refreshSessions(targetMode: ConversationMode, selectCurrent: boolean) {
    const store = chatStore();
    if (!store) return;
    const listed = await store.list({ mode: targetMode });
    // 内容未变时返回原引用：React 对同引用 state 会 bailout，导航/侧栏 memo 不再被重复刷新穿透
    setSessionsByMode((current) => {
      const existing = current[targetMode];
      if (existing && sessionMetaListEqual(existing, listed)) return current;
      return { ...current, [targetMode]: listed };
    });
    if (!selectCurrent) return;
    const currentId = activeSessionIdsRef.current[targetMode];
    const nextId = listed.some((session) => session.id === currentId) ? currentId : listed[0]?.id;
    if (nextId) {
      await selectSession(nextId, targetMode);
      return;
    }
    setActiveSessionIds((current) => {
      const next = { ...current };
      delete next[targetMode];
      activeSessionIdsRef.current = next;
      return next;
    });
    setWorkspaceNames((current) => ({ ...current, [targetMode]: undefined }));
    if (targetMode === activeModeRef.current) void store.setActiveSession(null, targetMode);
  }

  // 渲染期间同步安装真实实现，保证 mount effect 不会先观察到默认 no-op。
  refreshSessionsRef.current = refreshSessions;

  /**
   * 模型运行入口：组装运行宿主与共享注册表，交给运行控制器执行。
   * run 结束后的会话列表刷新与待发队列消费在 onRunFinished 中协调。
   */
  async function runModel(input: AgentRunInput) {
    const controller = new AgentRunController(input, {
      api: aguiApi(),
      store: chatStore(),
      host: {
        patchMessage: updateMessage,
        setInteraction: setInteractionForSession,
        clearInteraction: clearInteractionForSession,
        dismissAskIfMatched: (sessionId, value) => {
          setInteractionsBySession((current) => {
            const interaction = sessionInteraction(current, sessionId)?.interaction;
            if (interaction?.kind !== "ask" || !shouldDismissAsk(interaction, value)) return current;
            return clearSessionInteraction(current, sessionId);
          });
        },
        updateTodos: (_sessionId, updater) => setTodoStateBySession((current) => updater(current)),
        updateContextUsage: (sessionId, snapshot) => setSessionContextUsageBySession((current) => ({
          ...current,
          [sessionId]: snapshot,
        })),
        setCompressingContext: (_sessionId, value) => setIsCompressingContext(value),
        setModeBusy: (targetMode, busy) => {
          if (busy) {
            modelBusyByModeRef.current = { ...modelBusyByModeRef.current, [targetMode]: true };
            setModelBusyByMode((current) => ({ ...current, [targetMode]: true }));
          } else {
            const nextBusy = { ...modelBusyByModeRef.current };
            delete nextBusy[targetMode];
            modelBusyByModeRef.current = nextBusy;
            setModelBusyByMode((current) => {
              const next = { ...current };
              delete next[targetMode];
              return next;
            });
          }
        },
        requestTakeover: (sessionId, activeRunId, retry) => setSessionTakeover({ sessionId, activeRunId, retry }),
        clearTakeover: (sessionId) => setSessionTakeover((current) => (current && current.sessionId === sessionId ? null : current)),
        earlyTts: {
          start: createEarlyTtsQueue,
          finish: finishEarlyTtsQueue,
        },
        onRunFinished: ({ mode, sessionId, queuePaused }) => {
          // 刷新列表与队列投影；queuePaused 时暂停消费（先恢复认领再说），否则消费下一条
          queueFlow.handleRunFinished({ mode, sessionId, queuePaused });
        },
      },
      registries: {
        activeRuns: activeRunsBySession,
        checkpointTriggers: runCheckpointBySessionRef,
        cancelRequestedSessions: cancelRequestedSessionsRef,
        eventUnsubscribers: activeAguiOffsRef,
      },
      startRun: runModel,
    });
    await controller.start();
  }

  function isSessionBusy(sessionId: string): boolean {
    return hasActiveRunForSession(activeRunsBySession.current, sessionId);
  }

  async function restartLastChatTurn(
    expectedUserMessageId: string,
    expectedAssistantMessageId: string,
    disposition: "replace_user" | "keep_user",
    editedContent?: string,
  ): Promise<boolean> {
    if (
      activeModeRef.current !== "chat"
      || modelBusyByModeRef.current.chat
      || lastTurnRevisionStartingRef.current
    ) return false;
    const store = chatStore();
    const sessionId = activeSessionIdsRef.current.chat;
    if (!store || !sessionId) return false;
    lastTurnRevisionStartingRef.current = true;
    setLastTurnRevisionStarting(true);
    try {
      const session = await store.get(sessionId);
      if (!session || session.mode !== "chat") return false;
      const lastTurn = resolveRevisableLastTurn(session.messages, "chat");
      if (
        !lastTurn
        || lastTurn.userMessageId !== expectedUserMessageId
        || lastTurn.assistantMessageId !== expectedAssistantMessageId
      ) return false;

      const nextContent = editedContent === undefined ? undefined : editedContent.trim();
      if (editedContent !== undefined && !nextContent) return false;
      const userIndex = session.messages.length - 2;
      const previousUserMessage = session.messages[userIndex];
      const nextUserMessage: ChatMessage = nextContent === undefined
        ? previousUserMessage
        : {
            ...previousUserMessage,
            content: nextContent,
            at: Date.now(),
          };
      const truncatedSession = await store.replaceTail(sessionId, userIndex, [nextUserMessage]);
      if (!truncatedSession) return false;

      activeEarlyTtsRef.current?.queue.cancel();
      activeEarlyTtsRef.current = null;
      stopTtsPlayback();
      const assistantId = crypto.randomUUID();
      replaceSessionMessages(sessionId, [
        ...toUiMessages(truncatedSession),
        {
          id: assistantId,
          role: "assistant",
          content: "",
          loading: true,
          waitingForFirstEvent: true,
          streaming: false,
          responseStarted: false,
        },
      ]);
      void runModel({
        targetMode: "chat",
        sessionId,
        userMessageId: nextUserMessage.id,
        assistantId,
        session: truncatedSession,
        attachments: (nextUserMessage.attachments ?? []).map((attachment) => ({ ...attachment })),
        visibleContent: nextUserMessage.content,
        // 轨迹回退锚点：主进程据此写 turn_rewind（edit=replace_user / regenerate=keep_user）
        transcriptRewind: { anchorUserTurnId: expectedUserMessageId, disposition },
      });
      return true;
    } catch (error) {
      console.error("[Cyrene React] 重建最后一轮对话失败:", error);
      return false;
    } finally {
      lastTurnRevisionStartingRef.current = false;
      setLastTurnRevisionStarting(false);
    }
  }

  async function editLastChatUserMessageImpl(messageId: string, content: string): Promise<boolean> {
    const sessionId = activeSessionIdsRef.current.chat;
    const lastTurn = resolveRevisableLastTurn(sessionId ? (messagesBySessionRef.current[sessionId] ?? []) : [], "chat");
    if (!lastTurn || lastTurn.userMessageId !== messageId) return false;
    return restartLastChatTurn(lastTurn.userMessageId, lastTurn.assistantMessageId, "replace_user", content);
  }

  async function regenerateLastChatResponseImpl(
    userMessageId: string,
    assistantMessageId: string,
  ): Promise<boolean> {
    return restartLastChatTurn(userMessageId, assistantMessageId, "keep_user");
  }

  // 阶段 1B：编辑/重新生成回调稳定化（同 navActionsRef 模式）——ChatMessageList 的 roles
  // 依赖这两个引用，每次渲染新建会连锁重建 roles（全部气泡重渲染）。实现走 ref 取最新闭包。
  const lastTurnActionsRef = useRef({
    editLastChatUserMessage: editLastChatUserMessageImpl,
    regenerateLastChatResponse: regenerateLastChatResponseImpl,
  });
  lastTurnActionsRef.current = {
    editLastChatUserMessage: editLastChatUserMessageImpl,
    regenerateLastChatResponse: regenerateLastChatResponseImpl,
  };
  const editLastChatUserMessage = useCallback(
    async (messageId: string, content: string): Promise<boolean> =>
      lastTurnActionsRef.current.editLastChatUserMessage(messageId, content),
    [],
  );
  const regenerateLastChatResponse = useCallback(
    async (userMessageId: string, assistantMessageId: string): Promise<boolean> =>
      lastTurnActionsRef.current.regenerateLastChatResponse(userMessageId, assistantMessageId),
    [],
  );

  async function ensureSession(targetMode: ConversationMode): Promise<string> {
    const existing = activeSessionIdsRef.current[targetMode];
    if (existing) return existing;
    const store = chatStore();
    if (!store) throw new Error(t("chatPage.errorChatStoreUnavailable"));
    const hasPendingWorkspace = !!pendingWorkspaceByMode[targetMode];
    const session = await store.create({
      identityId: null,
      mode: targetMode,
      title:
        targetMode === "work" || targetMode === "code" || hasPendingWorkspace
          ? t("chatPage.newTaskTitle")
          : t("chatPage.newChatTitle"),
    });
    // 欢迎页暂存的模型选择在此落地（问题 2：无会话时选择器曾被静默丢弃）。
    const pendingModelProfileId = pendingModelProfileByMode[targetMode];
    if (pendingModelProfileId) {
      await store.setModelProfile(session.id, pendingModelProfileId);
      setPendingModelProfileByMode((current) => {
        const next = { ...current };
        delete next[targetMode];
        return next;
      });
    }
    await refreshSessions(targetMode, false);
    await selectSession(session.id, targetMode);
    return session.id;
  }



  async function initVaultStructure(sessionId: string, options?: { confirm?: boolean }) {
    const store = chatStore();
    if (!store) return;
    // 结构学习会在工作区写入文件：覆盖性选择，需确认后执行
    const confirmed = options?.confirm === false || await feedback.confirm({
      title: t("chatPage.learnStructureConfirmTitle"),
      message: t("chatPage.learnStructureConfirm"),
      confirmText: t("common.confirm"),
    });
    if (!confirmed) return;
    const result = await store.initLearnWorkspace(sessionId);
    if (!result.ok) {
      // 长操作失败：错误详情需阅读，用单按钮错误弹窗
      await feedback.alert({
        tone: "error",
        title: t("chatPage.learnStructureFailedTitle"),
        message: t("chatPage.learnStructureFailed", { error: result.error ?? t("chatPage.unknownError") }),
      });
    } else {
      const created = result.created?.length ?? 0;
      const skipped = result.skipped?.length ?? 0;
      // 普通成功反馈：非阻塞轻提示
      feedback.notice({
        tone: "success",
        message: skipped > 0
          ? t("chatPage.learnStructureCreatedWithSkipped", { created, skipped })
          : t("chatPage.learnStructureCreated", { created }),
      });
    }
  }

  async function chooseWorkspace() {
    const targetMode = mode;
    if (targetMode === "chat") return;
    const store = chatStore();
    if (!store) return;
    const picked = await store.pickWorkspaceFolder();
    if (!picked.ok || !picked.path) return;

    const workspace = { path: picked.path, displayName: picked.displayName ?? t("chatPage.defaultWorkspaceName") };
    setWorkspaceNames((current) => ({ ...current, [targetMode]: workspace.displayName }));

    const activeId = activeSessionIdsRef.current[targetMode];
    if (activeId) {
      const result = await store.setWorkspace(activeId, workspace.path);
      if (!result.ok) {
        // 长操作失败：错误详情需阅读，用单按钮错误弹窗
        await feedback.alert({
          tone: "error",
          title: t("chatPage.setWorkspaceFailedTitle"),
          message: t("chatPage.setWorkspaceFailed", { error: result.error ?? t("chatPage.unknownError") }),
        });
        return;
      }
      // Learn 模式：空目录询问是否初始化通用学习结构
      if (targetMode === "learn" && result.isEmpty) {
        const confirmed = await feedback.confirm({
          title: t("chatPage.learnStructureConfirmTitle"),
          message: t("chatPage.emptyDirLearnStructureConfirm"),
          confirmText: t("common.confirm"),
        });
        if (confirmed) {
          await initVaultStructure(activeId, { confirm: false });
        }
      }
      await refreshSessions(targetMode, false);
    } else {
      // 还没有发送第一条消息、未创建 session，先暂存工作区，发消息时一起绑定。
      setPendingWorkspaceByMode((current) => ({ ...current, [targetMode]: workspace }));
    }
  }

  async function createNewTask() {
    const targetMode = mode;
    const store = chatStore();
    if (!store) return;

    // 点“新建”不真正创建 session，只清空当前模式的状态并回到欢迎页。
    // 工作区保留：如果当前 session 已绑定项目，新任务继续在该项目下创建；
    // 否则沿用之前通过 chooseWorkspace 选好的待绑定目录。
    const activeId = activeSessionIdsRef.current[targetMode];
    const activeSession = activeId ? await store.get(activeId) : null;
    const inheritedWorkspace = activeSession?.workspaceBinding?.workspaceRoot
      ? {
          path: activeSession.workspaceBinding.workspaceRoot,
          displayName: activeSession.workspaceBinding.displayName,
        }
      : pendingWorkspaceByMode[targetMode];

    setActiveSessionIds((current) => {
      const next = { ...current };
      delete next[targetMode];
      activeSessionIdsRef.current = next;
      return next;
    });
    setDrafts((current) => {
      const next = { ...current };
      delete next[`mode:${targetMode}`];
      return next;
    });
    deleteScopeAttachments(`mode:${targetMode}`);
    setPendingWorkspaceByMode((current) => {
      const next = { ...current };
      if (inheritedWorkspace) {
        next[targetMode] = inheritedWorkspace;
      } else {
        delete next[targetMode];
      }
      return next;
    });
    setWorkspaceNames((current) => {
      const next = { ...current };
      if (!inheritedWorkspace) {
        delete next[targetMode];
      }
      return next;
    });
    setActivePanel(null);
  }

  async function handleRenameSession(sessionId: string, newTitle: string) {
    const store = chatStore();
    if (!store?.rename) return;
    const title = newTitle.trim();
    if (!title) return;
    await store.rename(sessionId, title);
    await refreshSessionsRef.current(mode, false);
  }

  async function handleDeleteSession(sessionId: string) {
    const store = chatStore();
    if (!store) return;
    const ok = await store.delete(sessionId);
    if (!ok) return;
    await refreshSessionsRef.current(mode, true);
  }

  async function handleTogglePinSession(sessionId: string, pinned: boolean) {
    const store = chatStore();
    if (!store?.setPinned) return;
    await store.setPinned(sessionId, pinned);
    await refreshSessionsRef.current(mode, false);
  }


  async function sendMessage(content: string, resumeFromRunId?: string) {
    const parsedMessage = parseComposerMessage(mode, content);
    const message = parsedMessage.rawContent;
    if (!message) return;
    activeEarlyTtsRef.current?.queue.cancel();
    activeEarlyTtsRef.current = null;
    const userSticker = parsedMessage.userSticker;
    const visibleMessage = parsedMessage.visibleContent;
    const userMessageId = crypto.randomUUID();
    const attachmentsForMessage = attachments.map((attachment) => ({ ...attachment }));
    const targetMode = mode;
    const sessionId = await ensureSession(targetMode);

    // 如果新建任务时已选好工作区但尚未创建 session，在这里一并绑定。
    const pendingWorkspace = pendingWorkspaceByMode[targetMode];
    if (pendingWorkspace) {
      const workspaceResult = await chatStore()?.setWorkspace(sessionId, pendingWorkspace.path);
      if (workspaceResult?.ok) {
        setWorkspaceNames((current) => bindWorkspaceName(
          current,
          targetMode,
          pendingWorkspace.displayName ?? t("chatPage.defaultWorkspaceName"),
        ));
      }
      if (workspaceResult?.ok && targetMode === "learn" && workspaceResult.isEmpty) {
        const confirmed = await feedback.confirm({
          title: t("chatPage.learnStructureConfirmTitle"),
          message: t("chatPage.emptyDirLearnStructureConfirm"),
          confirmText: t("common.confirm"),
        });
        if (confirmed) {
          await initVaultStructure(sessionId, { confirm: false });
        }
      }
      setPendingWorkspaceByMode((current) => {
        const next = { ...current };
        delete next[targetMode];
        return next;
      });
    }

    // 统一走主进程权威队列：只有入队确认成功后才清草稿和附件（失败保留并提示）。
    // 会话忙时留在队列等 run 结束消费；空闲时立即认领派发——
    // 发送瞬间的并发由主进程 claim 原子性与 SESSION_RUN_ACTIVE 守卫兜底。
    // 入队失败/异常时流程内部复用原稳定标识，重试靠主进程幂等去重不产生重复消息。
    const enqueued = await queueFlow.enqueue(sessionId, targetMode, {
      id: userMessageId,
      rawContent: message,
      visibleContent: visibleMessage,
      attachments: attachmentsForMessage,
      userSticker,
      ...(resumeFromRunId ? { resumeFromRunId } : {}),
    });
    if (!enqueued) return;
    // 请求期间用户继续输入时不清掉新内容：仅当草稿仍是发送时的文本才清空；
    // 附件同样只清随消息发送的那些（空快照不清任何附件），期间新加的保留
    setDrafts((current) => (current[scopeKey] === content ? { ...current, [scopeKey]: "" } : current));
    clearScopeAttachments(attachmentsForMessage);
    await queueFlow.consume(targetMode, sessionId);
  }

  /**
   * 外部（语音输入租约）向指定会话提交文本：
   * - 使用提交请求冻结的会话与模式，不读取当前页面状态；
   * - 不清空用户正在编辑的草稿、附件和输入框；
   * - 与手动发送走同一持久队列：入队确认成功（消息已落盘）才返回成功，
   *   绝不能只进页面内存就回执；空闲时随即认领派发，模型运行后台继续。
   */
  async function submitTextToSession(input: {
    sessionId: string;
    mode: ConversationMode;
    text: string;
  }): Promise<{ ok: true } | { ok: false; error: { code: string; message: string } }> {
    const text = input.text.trim();
    if (!text) {
      return { ok: false, error: { code: "E_INVALID_ARGUMENT", message: "提交文本不能为空" } };
    }
    const store = chatStore();
    if (!store) {
      return { ok: false, error: { code: "E_INTERNAL", message: "会话存储不可用" } };
    }
    const session = await store.get(input.sessionId);
    if (!session) {
      return { ok: false, error: { code: "E_NOT_FOUND", message: "会话已删除" } };
    }
    if (session.mode !== input.mode) {
      return { ok: false, error: { code: "E_INVALID_ARGUMENT", message: "会话模式不匹配" } };
    }
    // 入队失败不弹窗（外部提交场景）：错误码回传给语音调用方；
    // 同样走流程的失败标识缓存——外部重试同文本也复用原稳定标识
    const enqueued = await queueFlow.enqueue(
      input.sessionId,
      input.mode,
      {
        id: crypto.randomUUID(),
        rawContent: text,
        visibleContent: text,
        attachments: [],
      },
      false,
    );
    if (!enqueued) {
      return { ok: false, error: { code: "E_INTERNAL", message: "消息入队失败" } };
    }
    // 空闲时立即消费派发（忙时等 run 结束的 onRunFinished）；不等待模型回答
    void queueFlow.consume(input.mode, input.sessionId);
    return { ok: true };
  }

  async function cancelCurrentRun() {
    const sessionId = activeSessionId;
    if (!sessionId) return;
    const activeRun = activeRunsBySession.current[sessionId];
    if (!activeRun) return;
    updateMessage(activeRun.mode, activeRun.assistantId, {
      streaming: false,
      loading: false,
      waitingForFirstEvent: false,
      responseStarted: false,
    });
    if (!activeRun.runId) {
      cancelRequestedSessionsRef.current.add(sessionId);
      // 首次模型请求尚未返回 ack.runId 时，仍要立即通知主进程。
      // 该窗口内当前窗口只有这一条 active run，桥层会取消它；ack 返回后
      // 仍保留 cancelRequestedSessionsRef 以处理跨进程投递顺序。
      await aguiApi()?.cancel();
      return;
    }
    await aguiApi()?.cancel(activeRun.runId);
  }

  /** 撤回排队消息：主进程按稳定标识删除（已被认领/移除时幂等成功），失败提示且投影不动。 */
  async function removeQueuedMessage(sessionId: string, id: string) {
    const store = chatStore();
    if (!store) return;
    const result = await store.pendingRemove(sessionId, id);
    if (!result.ok) {
      // 简短失败反馈：非阻塞错误轻提示
      feedback.notice({ tone: "error", message: t("chatPage.errorQueueRemoveFailed", { error: result.error ?? t("chatPage.unknownError") }) });
      return;
    }
    await queueFlow.syncProjection(sessionId);
  }

  /** 修改待发文字：保留原条目的附件快照，只更新解析后的正文与表情标记。 */
  async function editQueuedMessage(
    sessionId: string,
    targetMode: ConversationMode,
    id: string,
    content: string,
  ) {
    const parsedMessage = parseComposerMessage(targetMode, content);
    if (!parsedMessage.rawContent) return false;
    return queueFlow.editMessage(sessionId, id, {
      rawContent: parsedMessage.rawContent,
      visibleContent: parsedMessage.visibleContent,
      userSticker: parsedMessage.userSticker,
    });
  }

  /** 运行中把当前草稿排进持久队列（composer 加号按钮）：入队成功才清草稿与附件。 */
  async function queueCurrentDraft(value: string) {
    if (!activeSessionId || !value.trim()) return;
    const sessionId = activeSessionId;
    const parsedMessage = parseComposerMessage(mode, value);
    if (!parsedMessage.rawContent) return;
    const userSticker = parsedMessage.userSticker;
    const visibleContent = parsedMessage.visibleContent;
    const attachmentsForMessage = attachments.map((attachment) => ({ ...attachment }));
    const userMessageId = crypto.randomUUID();
    const enqueued = await queueFlow.enqueue(sessionId, mode, {
      id: userMessageId,
      rawContent: parsedMessage.rawContent,
      visibleContent,
      attachments: attachmentsForMessage,
      userSticker,
    });
    if (!enqueued) return;
    // 请求期间用户继续输入时不清掉新内容：仅当草稿仍是排队时的文本才清空；
    // 附件同样只清随消息入队的那些（空快照不清任何附件），期间新加的保留
    setDrafts((current) => (current[scopeKey] === value ? { ...current, [scopeKey]: "" } : current));
    clearScopeAttachments(attachmentsForMessage);
  }

  const isCurrentScopeRunning = Boolean(activeSessionId && activeRunsBySession.current[activeSessionId]);
  const currentPendingQueue = activeSessionId
    ? (pendingQueueBySession[activeSessionId] ?? []).map((item) => ({
      id: item.id,
      content: item.visibleContent || item.rawContent,
      attachmentCount: item.attachments?.length,
    }))
    : [];
  // 上下文容量圆环：session 级快照优先（手动压缩等不产生新消息的操作也即时刷新），
  // 消息级快照兜底兼容旧数据；无快照不渲染。
  const latestContextUsage = (activeSessionId ? sessionContextUsageBySession[activeSessionId] : undefined)
    ?? messages.findLast((message) => message.contextUsage)?.contextUsage;
  const activePlan = mode === "code" && activeSessionId ? planReviewBySession[activeSessionId] : null;

  // ── 右侧面板标签管理 ──
  // 会话隔离：切换会话时清空工作区相关标签，避免把 A 会话的文件带进 B 会话
  useEffect(() => {
    setDiffTabs([]);
    setFileTabs([]);
    setFilesTabOpen(false);
    setActiveTabId(null);
  }, [activeSessionId]);

  /** 打开/激活一个 diff 标签：同 runId + 文件路径已存在则仅激活，不重复开 */
  // 阶段 1B：useCallback 稳定引用——作为 onOpenReviewInspector 进 roles 依赖，每次渲染新建会连锁重建 roles
  const openDiffTab = useCallback((runId: string, fileIndex: number, filePath: string) => {
    const id = `diff:${runId}:${filePath || `#${fileIndex}`}`;
    setDiffTabs((tabs) =>
      tabs.some((tab) => tab.id === id) ? tabs : [...tabs, { id, runId, fileIndex, filePath }],
    );
    // 点开 diff 时自动带出文件树标签（会话已绑定工作区才有意义）
    if (activeSession?.workspaceBinding) setFilesTabOpen(true);
    setActiveTabId(id);
  }, [activeSession?.workspaceBinding]);

  /** 打开/激活文件树标签 */
  const openFilesTab = () => {
    setFilesTabOpen(true);
    setActiveTabId("files");
  };

  /** 收起右侧面板：关闭全部标签（再次点击开关可重新展开文件树） */
  const collapseInspector = () => {
    setFilesTabOpen(false);
    setFileTabs([]);
    setDiffTabs([]);
    setPlanDrawerOpen(false);
    setActiveTabId(null);
  };

  /** 打开/激活一个文件预览标签：同路径只激活不重开；带行号时更新定位并触发滚动 */
  const fileLineSeqRef = useRef(0);
  // 阶段 1B：useCallback 稳定引用——进 fileLinkEnv 依赖，防止 FileLink 消费者全量更新
  const openFileTab = useCallback((relPath: string, line?: number) => {
    const id = `file:${relPath}`;
    setFileTabs((tabs) => {
      const existing = tabs.some((tab) => tab.id === id);
      if (!existing) {
        return [...tabs, line === undefined ? { id, relPath } : { id, relPath, line, lineSeq: ++fileLineSeqRef.current }];
      }
      // 已打开：带行号则更新定位（lineSeq 变化触发预览重新滚动），不带则清除定位
      return tabs.map((tab) =>
        tab.id === id
          ? line === undefined
            ? { ...tab, line: undefined, lineSeq: undefined }
            : { ...tab, line, lineSeq: ++fileLineSeqRef.current }
          : tab,
      );
    });
    // 文件预览与 diff 一样：打开时自动带出文件树标签
    if (activeSession?.workspaceBinding) setFilesTabOpen(true);
    setActiveTabId(id);
  }, [activeSession?.workspaceBinding]);

  /** 计划标签 ID：会话内唯一（计划内容始终跟随当前会话） */
  const planTabId = `plan:${activeSessionId ?? "session"}`;

  /** 右侧面板标签的固定顺序：文件树 → 文件预览 → Diff → 计划 */
  const inspectorTabIds = [
    ...(filesTabOpen ? ["files"] : []),
    ...fileTabs.map((tab) => tab.id),
    ...diffTabs.map((tab) => tab.id),
    ...((activePlan !== null && planDrawerOpen) ? [planTabId] : []),
  ];

  /**
   * 文件树标签是否被钉住：面板里还有 diff / 文件预览 / 计划标签时，
   * 文件树不可关闭（chip 无 ×、右上角关闭按钮对它无效），
   * 只剩它一个时恢复可关——关掉即收起整个面板。
   */
  const filesTabPinned = filesTabOpen
    && (fileTabs.length > 0 || diffTabs.length > 0 || (activePlan !== null && planDrawerOpen));

  /** 关闭右侧面板标签：活动标签关闭后回退到相邻标签（优先左侧） */
  const closeInspectorTab = (id: string) => {
    const index = inspectorTabIds.indexOf(id);
    if (index < 0) return;
    // 钉住的文件树标签：关闭请求降级为激活它
    if (id === "files" && filesTabPinned) {
      setActiveTabId("files");
      return;
    }
    const remaining = inspectorTabIds.filter((tabId) => tabId !== id);
    if (id === "files") {
      setFilesTabOpen(false);
    } else if (id.startsWith("file:")) {
      setFileTabs((tabs) => tabs.filter((tab) => tab.id !== id));
    } else if (id.startsWith("plan:")) {
      setPlanDrawerOpen(false);
    } else {
      setDiffTabs((tabs) => tabs.filter((tab) => tab.id !== id));
    }
    if (activeTabId === id) {
      setActiveTabId(remaining[index - 1] ?? remaining[index] ?? null);
    }
  };

  // ── 阶段 1A：导航 props 引用稳定化 ──
  // 下方 6 个动作函数读取大量页面状态、内部调用链每次渲染都产生新引用，
  // 属"需读最新状态且引用不能变"的场景：用 ref 转发当次渲染的最新实现，
  // 外层回调引用恒定，配合 React.memo 让导航/侧栏子树在流式期间保持命中。
  const navActionsRef = useRef<NavActions>({
    createNewTask: () => Promise.resolve(),
    selectSession: () => Promise.resolve(),
    handleRenameSession: () => Promise.resolve(),
    handleDeleteSession: () => Promise.resolve(),
    handleTogglePinSession: () => Promise.resolve(),
    openProject: () => undefined,
  });
  // 渲染期同步最新实现（函数声明在组件体内提升，此处可安全引用）
  navActionsRef.current = {
    createNewTask,
    selectSession,
    handleRenameSession,
    handleDeleteSession,
    handleTogglePinSession,
    openProject: (workspaceRoot) => {
      void chatStore()?.openWorkspace(workspaceRoot).then((result) => {
        // 简短失败反馈：非阻塞错误轻提示
        if (!result.ok) feedback.notice({ tone: "error", message: t("chatPage.openProjectFolderFailed", { error: result.error ?? t("chatPage.unknownError") }) });
      });
    },
  };

  const navToggleCollapsed = useCallback(() => setCollapsed((value) => !value), []);
  const navModeChange = useCallback((nextMode: string) => {
    if (isConversationMode(nextMode)) setMode(nextMode);
  }, []);
  const navNewTask = useCallback(() => {
    void navActionsRef.current.createNewTask();
  }, []);
  const navTogglePanel = useCallback((panel: ChatPagePanel) => {
    setActivePanel((current) => current === panel ? null : panel);
  }, []);
  const navSelectSession = useCallback((sessionId: string) => {
    setActivePanel(null);
    void navActionsRef.current.selectSession(sessionId);
  }, []);
  const navOpenProject = useCallback((workspaceRoot: string) => {
    navActionsRef.current.openProject(workspaceRoot);
  }, []);
  const navRenameSession = useCallback((sessionId: string, newTitle: string) => {
    void navActionsRef.current.handleRenameSession(sessionId, newTitle);
  }, []);
  const navDeleteSession = useCallback((sessionId: string) => {
    void navActionsRef.current.handleDeleteSession(sessionId);
  }, []);
  const navTogglePinSession = useCallback((sessionId: string, pinned: boolean) => {
    void navActionsRef.current.handleTogglePinSession(sessionId, pinned);
  }, []);
  const navMinimize = useCallback(() => window.chat?.minimize(), []);
  const navMaximize = useCallback(() => window.chat?.toggleMaximize(), []);
  const navCloseWindow = useCallback(() => window.chat?.close(), []);
  const navOpenSettings = useCallback(() => sidebarApi()?.openSettings("appearance"), []);

  return (
    <div className={`cy-page ${collapsed ? "is-collapsed" : ""}`}>
      <ChatPageNavigation
        collapsed={collapsed}
        activePanel={activePanel}
        mode={mode}
        sessions={sessions}
        activeSessionId={activeSessionId}
        onToggleCollapsed={navToggleCollapsed}
        onModeChange={navModeChange}
        onNewTask={navNewTask}
        onTogglePanel={navTogglePanel}
        onSelectSession={navSelectSession}
        onOpenProject={navOpenProject}
        onRenameSession={navRenameSession}
        onDeleteSession={navDeleteSession}
        onTogglePinSession={navTogglePinSession}
        onMinimize={navMinimize}
        onMaximize={navMaximize}
        onCloseWindow={navCloseWindow}
        onOpenSettings={navOpenSettings}
      />
      {/* 右栏可拖宽布局：聊天区 Panel 常驻（保证内容不重挂载），右侧面板按需挂载 */}
      <Group
        orientation="horizontal"
        className="cy-page-dock"
        defaultLayout={defaultLayout}
        onLayoutChanged={onLayoutChanged}
        // 拖动条命中区外溢到两侧（视觉条只有 12px，命中区鼠标 24px / 触屏 33px）
        resizeTargetMinimumSize={{ coarse: 33, fine: 24 }}
      >
        <Panel id="chat" minSize={480} className="cy-dock-body">
      <main
        className={`cy-page-main cy-workspace ${hasMessages ? "has-messages" : "is-empty"} ${isDraggingFiles ? "is-dragging-files" : ""}`}
        onDragEnter={dragHandlers.onDragEnter}
        onDragOver={dragHandlers.onDragOver}
        onDragLeave={dragHandlers.onDragLeave}
        onDrop={dragHandlers.onDrop}
      >
        <FileDropOverlay visible={isDraggingFiles} />
        {/* 白色工作区右上角：打开菜单 + 分割线 + 右侧面板展开/收起开关（左上角 SidebarToggle 的镜像同款动画）。
            仅在会话对话视图显示：产生过消息、且当前不在插件/工具/技能/模型/动态等面板页时才挂载 */}
        {(hasMessages && !activePanel && (activeSession?.workspaceBinding || inspectorTabIds.length > 0)) && (
          <span className="cy-inspector-toggle-float">
            {activeSession?.workspaceBinding && activeSessionId && (
              <>
                <OpenWorkspaceMenu sessionId={activeSessionId} />
                <span className="cy-inspector-toggle-divider" aria-hidden="true" />
              </>
            )}
            <InspectorToggle
              open={inspectorTabIds.length > 0}
              onToggle={() => (inspectorTabIds.length > 0 ? collapseInspector() : openFilesTab())}
            />
          </span>
        )}
        {activePanel ? (
          <ChatPagePanelHost panel={activePanel} />
        ) : (
        <>
        {(mode === "work" || mode === "learn") && (
          <TodoPanel
            state={activeSessionId ? todoStateBySession[activeSessionId] : null}
            mode={mode}
          />
        )}
        {mode === "code" && activeSessionId && (
          <CodeGitPanel
            sessionId={activeSessionId}
            projectName={workspaceNames.code}
            todoState={todoStateBySession[activeSessionId] ?? null}
            planPhase={planReviewBySession[activeSessionId]?.phase}
            onOpenPlan={() => {
              setPlanDrawerOpen(true);
              setActiveTabId(planTabId);
            }}
          />
        )}
        <RunRecoveryNotices
          interruptedRun={interruptedRun}
          sessionTakeover={sessionTakeover}
          activeSessionId={activeSessionId}
          isRunning={isCurrentScopeRunning}
          onResume={(runId) => void sendMessage(t("chatPage.resumeLastTaskMessage"), runId)}
          onTakeover={() => {
            const takeover = sessionTakeover;
            if (!takeover) return;
            setSessionTakeover(null);
            void takeover.retry();
          }}
        />
        {hasMessages && (
          <ChatMessageList
            messages={messages}
            conversationId={activeSessionId}
            mode={mode}
            preferredAddress={preferredAddress}
            stickerSize={stickerSize}
            revisionBusy={Boolean(modelBusyByMode[mode]) || lastTurnRevisionStarting}
            onEditLastUserMessage={mode === "chat" ? editLastChatUserMessage : undefined}
            onRegenerateLastResponse={mode === "chat" ? regenerateLastChatResponse : undefined}
            onTtsCacheKey={activeSessionId ? handleTtsCacheKeyForActiveSession : undefined}
            onScrollToBottomVisibilityChange={setScrollToBottomVisible}
            onRegisterScrollToBottom={registerScrollToBottom}
            onOpenReviewInspector={openDiffTab}
            workspaceRoot={activeSession?.workspaceBinding?.workspaceRoot}
            onOpenFileLink={openFileTab}
          />
        )}
        <ContextCompressionNotice visible={isCompressingContext} />
        <div className="cy-workspace-composer">
          {scrollToBottomVisible && (
            <button
              type="button"
              className="cy-workspace-composer__scroll-to-bottom"
              onClick={() => scrollToBottomRef.current()}
              aria-label={t("chatPage.scrollToBottom")}
              title={t("chatPage.scrollToBottom")}
            >
              <DownOutlined />
            </button>
          )}
          <ComposerSlot
            composer={<ChatComposer
            value={draft}
            mode={mode}
            docked={hasMessages}
            conversationId={activeSessionId ?? undefined}
            workspaceName={workspaceNames[mode]}
            workspaceRoot={activeSession?.workspaceBinding?.workspaceRoot}
            attachments={attachments}
            attachmentBusy={attachmentBusy}
            modelBusy={isCurrentScopeRunning}
            pendingQueue={currentPendingQueue}
            onChange={(value) => setDrafts((current) => ({ ...current, [scopeKey]: value }))}
            onSubmit={(value) => void sendMessage(value)}
            onCancel={() => void cancelCurrentRun()}
            onQueueMessage={(value) => void queueCurrentDraft(value)}
            onRemoveQueuedMessage={(id) => activeSessionId && void removeQueuedMessage(activeSessionId, id)}
            onEditQueuedMessage={(id, content) => activeSessionId
              ? editQueuedMessage(activeSessionId, mode, id, content)
              : Promise.resolve(false)}
            onAdjustQueuedMessage={(id) => activeSessionId
              ? queueFlow.adjustMessage(activeSessionId, id)
              : Promise.resolve(false)}
            onChooseWorkspace={() => void chooseWorkspace()}
            onChooseFiles={(files) => void chooseFiles(files)}
            onRemoveAttachment={removeAttachment}
            onScreenshot={() => void handleScreenshot()}
            onPasteImage={(file) => void handlePastedImage(file)}
            onChooseSticker={(id) => {
              const separator = draft && !draft.endsWith(" ") ? " " : "";
              setDrafts((current) => ({ ...current, [scopeKey]: `${draft}${separator}[sticker:${id}]` }));
            }}
            activeModelProfileId={
              activeSession?.id === activeSessionId && activeSession
                ? activeSession.modelProfileId
                : pendingModelProfileByMode[mode]
            }
            contextUsage={latestContextUsage}
            onSelectModelProfile={(modelProfileId) => {
              // 欢迎页（无会话）：暂存选择，ensureSession 建会话后落地；不再静默丢弃。
              if (!activeSessionId) {
                setPendingModelProfileByMode((current) => ({ ...current, [mode]: modelProfileId }));
                return;
              }
              const store = chatStore();
              if (!store) return;
              void store.setModelProfile(activeSessionId, modelProfileId).then((session) => setActiveSession(session));
            }}
            />}
            interaction={composerInteraction}
            interactionBusy={interactionBusy}
            onAnswer={(id, answer) => {
              if (!activeSessionId) return;
              const choice = choiceApi();
              if (!choice) return;
              setInteractionBusyForSession(activeSessionId, true);
              void choice.resolve(id, answer).then((result) => {
                // ok:false = pending 已在主进程被结算（超时/取消等）：卡片不可能再提交成功，直接清掉，
                // 避免留下一张点多少次都没反应的僵尸卡。
                if (result.ok) {
                  runCheckpointBySessionRef.current[activeSessionId]?.("running");
                }
                clearInteractionForSession(activeSessionId);
                setInteractionBusyForSession(activeSessionId, false);
              }).catch(() => setInteractionBusyForSession(activeSessionId, false));
            }}
            onIgnore={(id) => {
              if (!activeSessionId) return;
              const choice = choiceApi();
              if (!choice) return;
              setInteractionBusyForSession(activeSessionId, true);
              void choice.resolve(id, "").then((result) => {
                // 同 onAnswer：ok:false 说明 pending 已被主进程结算，卡片清掉不留僵尸。
                if (result.ok) {
                  runCheckpointBySessionRef.current[activeSessionId]?.("running");
                }
                clearInteractionForSession(activeSessionId);
                setInteractionBusyForSession(activeSessionId, false);
              }).catch(() => setInteractionBusyForSession(activeSessionId, false));
            }}
            onPermissionDecision={(id, allowed) => {
              if (!activeSessionId) return;
              const settings = settingsApprovalApi();
              if (!settings) return;
              setInteractionBusyForSession(activeSessionId, true);
              void settings.resolvePermissionApproval(id, allowed).then((result) => {
                // ok:false = pending 已在主进程被结算（run 取消等）：卡片不可能再提交成功，直接清掉，
                // 避免留下一张点多少次都没反应的僵尸卡。
                if (result.ok) {
                  runCheckpointBySessionRef.current[activeSessionId]?.("running");
                }
                clearInteractionForSession(activeSessionId);
                setInteractionBusyForSession(activeSessionId, false);
              }).catch(() => setInteractionBusyForSession(activeSessionId, false));
            }}
            onQuizSubmit={(submission) => {
              const settings = settingsApprovalApi();
              if (!settings) return Promise.resolve({ ok: false, error: "E_QUIZ_NO_BRIDGE" });
              // 展示态切换由卡片组件处理，这里只透传判分结果
              return settings.resolvePopQuiz(submission);
            }}
            onQuizSkip={(quizId) => {
              const settings = settingsApprovalApi();
              if (!settings) return Promise.resolve({ ok: false, error: "E_QUIZ_NO_BRIDGE" });
              return settings.skipPopQuiz(quizId);
            }}
          />
        </div>
        </>
        )}
      </main>
        </Panel>
        {/* 右侧面板打开时才挂载 Panel + 拖动条；默认 45% 宽，范围 320px ～ 窗口 70% */}
        {inspectorTabIds.length > 0 && (
          <>
            <Separator className="cy-dock-separator" />
            <Panel id="inspector" defaultSize="45" minSize={320} maxSize="70%" className="cy-dock-body">
              <ChatPageInspector
                sessionId={activeSessionId}
                workspaceRoot={activeSession?.workspaceBinding?.workspaceRoot}
                filesTabOpen={filesTabOpen}
                filesTabPinned={filesTabPinned}
                fileTabs={fileTabs}
                diffTabs={diffTabs}
                activePlan={activePlan}
                planDrawerOpen={planDrawerOpen}
                planTabId={planTabId}
                activeTabId={activeTabId}
                onTabChange={setActiveTabId}
                onCloseTab={closeInspectorTab}
                onOpenFile={openFileTab}
              />
            </Panel>
          </>
        )}
      </Group>
    </div>
  );
}
