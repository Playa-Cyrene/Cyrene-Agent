import type {
  ChatMessage,
  ChatSession,
  ChatSessionMeta,
  ConversationMode,
  PendingChatAttachment,
  PendingChatMessage,
  ToolFileChange,
} from "../../../../../shared/chat-types";
import type {
  SpeechInputCommitRequest,
  SpeechInputCommitResult,
} from "../../../../../shared/ipc-channels";

/** 认领队首的返回形状（与主进程 chats-store 的 ClaimPendingResult 对齐）。 */
export type PendingClaimResult =
  | {
      ok: true;
      claimed: true;
      userMessage: ChatMessage;
      visibleContent: string;
      resumeFromRunId?: string;
      remainingQueue: PendingChatMessage[];
      session: ChatSession;
    }
  | { ok: true; claimed: false }
  | { ok: false; error: string };

/** 修改/调整待发条目的返回形状：失败时附带主进程最新权威队列（可能缺省）。 */
export type PendingMutationResult =
  | { ok: true; queue: PendingChatMessage[] }
  | { ok: false; error: string; queue?: PendingChatMessage[] };
import type {
  PopQuizCard,
  PopQuizResolveResponse,
  PopQuizSettledPayload,
  PopQuizSubmission,
} from "../../../../../shared/pop-quiz";

export interface ChatStoreApi {
  list: (options?: { mode?: ConversationMode }) => Promise<ChatSessionMeta[]>;
  get: (id: string) => Promise<ChatSession | null>;
  create: (input: { identityId: null; mode: ConversationMode; title?: string }) => Promise<ChatSession>;
  checkpointPresentation: (
    sessionId: string,
    messageId: string,
    mutationKey: string,
    patch: Partial<ChatMessage>,
  ) => Promise<{ ok: true } | { ok: false; error: string }>;
  rename: (id: string, title: string) => Promise<ChatSession | null>;
  delete: (id: string) => Promise<boolean>;
  // 会话级待发队列（主进程为权威）：入队失败时 ok=false，页面必须保留草稿
  pendingEnqueue: (
    id: string,
    entry: Omit<PendingChatMessage, "enqueuedAt">,
  ) => Promise<{ ok: true; queue: PendingChatMessage[] } | { ok: false; error: string }>;
  pendingList: (id: string) => Promise<PendingChatMessage[] | null>;
  pendingRemove: (id: string, messageId: string) => Promise<{ ok: boolean; error?: string }>;
  // 认领队首（主进程单次写入：待发条目→正式用户消息+派发状态）；run 确认后清除派发状态
  pendingClaim: (id: string) => Promise<PendingClaimResult>;
  pendingCompleteDispatch: (
    id: string,
    messageId: string,
  ) => Promise<{ ok: boolean; error?: string }>;
  // 修改未认领条目文字（调用方按现有解析规则产出三个文字字段；冲突返回最新队列）
  pendingEdit: (
    id: string,
    messageId: string,
    update: { rawContent: string; visibleContent: string; userSticker?: string },
  ) => Promise<PendingMutationResult>;
  // 调整：把待发条目插入当前运行下一步；无活跃运行/带附件等明确拒绝并留队
  pendingAdjust: (id: string, messageId: string) => Promise<PendingMutationResult>;
  setPinned: (id: string, pinned: boolean) => Promise<ChatSession | null>;
  setModelProfile: (id: string, modelProfileId?: string) => Promise<ChatSession | null>;
  pickWorkspaceFolder: () => Promise<{ ok: boolean; path?: string; displayName?: string; error?: string }>;
  setWorkspace: (sessionId: string, workspaceRoot: string) => Promise<{ ok: boolean; error?: string; isEmpty?: boolean }>;
  initLearnWorkspace: (sessionId: string) => Promise<{ ok: boolean; error?: string; created?: string[]; skipped?: string[] }>;
  openWorkspace: (workspaceRoot: string) => Promise<{ ok: boolean; error?: string }>;
  setActiveSession: (sessionId: string | null, mode?: ConversationMode) => Promise<unknown>;
  onChanged: (callback: () => void) => () => void;
  onReactSwitchSession: (callback: (sessionId: string) => void) => () => void;
  notifyReactReady: () => void;
  // 本页面的渲染目标标识；语音提交桥据此识别过期请求
  getRendererTargetId: () => string;
  // main → ChatPage：外部语音文本提交请求（携带租约冻结的目标）
  onSpeechInputCommitRequest: (
    callback: (request: SpeechInputCommitRequest) => void,
  ) => () => void;
  // ChatPage → main：提交结果（必须回显 requestId 与 rendererTargetId）
  sendSpeechInputCommitResult: (result: SpeechInputCommitResult) => void;
}

export interface SidebarApi {
  openSettings: (section?: string) => void;
}

export interface AguiEvent {
  type?: string;
  runId?: string;
  messageId?: string;
  delta?: string;
  message?: string;
  error?: string;
  content?: string;
  name?: string;
  value?: unknown;
  toolCallId?: string;
  toolCallName?: string;
  /** 主进程注册表里的中文展示名；用于工具执行卡片的用户可读标签。 */
  toolCallDisplayName?: string;
  stepName?: string;
  status?: string;
  changes?: ToolFileChange[];
}

/** Harness 正文候选事件：只驱动本次运行的临时预览，不代表正式消息提交。 */
export type CandidateTextEventValue =
  | { action: "delta"; roundId: string; delta: string }
  | { action: "discard"; roundId: string };

export interface AguiApi {
  run: (input: {
    currentUser: {
      turnId: string;
      text: string;
      visibleContent: string;
      attachments?: PendingChatAttachment[];
      sticker?: string;
      at?: number;
    };
    assistantTurnId: string;
    styleId?: string;
    sessionId: string;
    imageAttachments?: Array<{ name: string; filePath: string; mime?: string }>;
    recoveryContext?: string;
    resumeFromRunId?: string;
    takeoverFromRunId?: string;
    /** 桌面 edit / regenerate 的轨迹回退锚点（主进程写 turn_rewind；渲染端只传元数据）。 */
    transcriptRewind?: {
      anchorUserTurnId: string;
      disposition: "keep_user" | "replace_user";
    };
  }) => Promise<{ success: boolean; runId: string; error?: string }>;
  onEvent: (callback: (event: AguiEvent) => void) => () => void;
  cancel: (runId?: string) => Promise<unknown>;
  // 落盘确认（单向通知）：终态消息写入会话存储后上报，供插件轮次事件使用
  reportRunPersisted?: (payload: { runId: string; finalMessageId?: string }) => void;
  getInterruptedRun?: (sessionId: string) => Promise<{ runId: string; rounds: number; todoCount: number; updatedAt: number } | null>;
}

export interface ChoiceApi {
  resolve: (id: string, value: unknown) => Promise<{ ok: boolean }>;
}

/**
 * 审批载荷类型的唯一声明在 shared（主进程 / preload / 渲染端共用同一份）。
 * 先 import 再导出：纯 re-export 的别名在本文件内不可见，下方接口要用。
 */
import type {
  ApprovalRequest as PermissionApprovalRequest,
  ApprovalSettledPayload as PermissionApprovalSettled,
} from "../../../../../shared/permission-approval";

export type { PermissionApprovalRequest, PermissionApprovalSettled };

export interface SettingsApprovalApi {
  onPermissionApprovalRequest: (callback: (request: PermissionApprovalRequest) => void) => () => void;
  resolvePermissionApproval: (id: string, allowed: boolean) => Promise<{ ok: boolean }>;
  onPermissionApprovalSettled: (callback: (settlement: PermissionApprovalSettled) => void) => () => void;
  // pop_quiz 抽查卡片（learn 模式）：请求推送 / 提交作答 / 跳过 / 结算广播
  onPopQuizRequest: (callback: (card: PopQuizCard) => void) => () => void;
  resolvePopQuiz: (submission: PopQuizSubmission) => Promise<PopQuizResolveResponse>;
  skipPopQuiz: (quizId: string) => Promise<{ ok: boolean; error?: string }>;
  onPopQuizSettled: (callback: (settlement: PopQuizSettledPayload) => void) => () => void;
}

export interface PublicModelConfig {
  model?: unknown;
  displayName?: string;
  stickerSize?: "small" | "standard" | "large";
}

export interface ModelConfigApi {
  get: () => Promise<PublicModelConfig>;
  onChanged: (callback: (config: PublicModelConfig) => void) => () => void;
}

export function chatStore(): ChatStoreApi | undefined {
  return (window as typeof window & { chatStore?: ChatStoreApi }).chatStore;
}

export function sidebarApi(): SidebarApi | undefined {
  return (window as typeof window & { sidebar?: SidebarApi }).sidebar;
}

export function aguiApi(): AguiApi | undefined {
  return (window as typeof window & { agui?: AguiApi }).agui;
}

export function choiceApi(): ChoiceApi | undefined {
  return (window as typeof window & { choice?: ChoiceApi }).choice;
}

export function settingsApprovalApi(): SettingsApprovalApi | undefined {
  return (window as typeof window & { settings?: SettingsApprovalApi }).settings;
}
