import type {
  ChatMessage,
  ChatSession,
  ChatSessionMeta,
  ConversationMode,
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
  append: (id: string, message: ChatMessage) => Promise<ChatSession | null>;
  upsert: (id: string, message: ChatMessage) => Promise<ChatSession | null>;
  replaceTail: (id: string, startIndex: number, messages: ChatMessage[]) => Promise<ChatSession | null>;
  setMessageTtsCacheKey: (id: string, messageId: string, cacheKey: string, converterVersion: string) => Promise<ChatSession | null>;
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

export interface AguiApi {
  run: (input: {
    messages: Array<{ role: "user" | "model"; content: string; at?: number }>;
    userTurnId: string;
    assistantTurnId: string;
    styleId?: string;
    sessionId: string;
    imageAttachments?: Array<{ name: string; filePath: string; mime?: string }>;
    recoveryContext?: string;
    resumeFromRunId?: string;
    takeoverFromRunId?: string;
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

export interface PermissionApprovalRequest {
  id: string;
  runId?: string;
  toolId: string;
  toolName: string;
  toolDescription: string;
  args: Record<string, unknown>;
  risk: string;
}

export interface PermissionApprovalSettled {
  id: string;
  runId?: string;
  reason: "answered" | "cancelled" | "unavailable";
}

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
