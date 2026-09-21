// 聊天会话相关的持久化数据形状（main / renderer 共用）。
//
// 设计要点：
// - ChatSession 是「完整体」，含 messages，存到 sessions/<id>.json；
// - ChatSessionMeta 是「索引项」，不含 messages，存到 index.json；
//   列表渲染只读 index.json，避免一次性把所有会话消息加载到内存。
// - identityId 当前为预留字段——职位面板还未做，新会话默认 null，
import type { MusicCardData } from "./music-card";
import type { TodoItem } from "./todo-types";
import type { TaskDelegationPresentation } from "./task-session";
import type { ContextUsageSnapshot } from "./context-usage";

// - schemaVersion 用于以后改 schema 时的迁移判断；当前固定 1。

export type ChatRole = "user" | "model";

export type ChatSessionPurpose = "proactive-chat";

/** 会话模式：创建时绑定，整个会话生命周期不变 */
export type ConversationMode = "chat" | "work" | "code" | "learn";

export type ChatStickerId =
  | "playful"
  | "love-happy"
  | "confident"
  | "serious"
  | "calm"
  | "peek"
  | "clingy-confused"
  | "love-calm";

/** 任意表情包 ID（内置 + 用户自定义） */
export type AnyStickerId = string;

/** 一次模型回复中已展示的工具执行记录，供 React Harness 会话恢复执行过程。 */
export interface ToolExecutionRecord {
  id: string;
  name: string;
  /** 注册表中文展示名（如「播放歌曲」）；新记录由主进程事件携带，历史记录缺失时前端回退 i18n 映射或原始 ID。 */
  displayName?: string;
  status: "running" | "success" | "error";
  result?: string;
  argsText?: string;
  roundId?: string;
  /** 结构化文件变更证据（Diff Review 卡片）；由 tool_end 事件独立携带，不依赖被截断的 result 文本。 */
  changes?: ToolFileChange[];
  /** run 内单调递增的时间线序号：保证推理/正文/工具跨类别按实际发生顺序排列。 */
  seq?: number;
}

/** Diff Review 卡片：单行展示（hunk=@@ 头，context=未变行）。 */
export type ToolDiffLineType = "context" | "add" | "remove" | "hunk";

export interface ToolDiffLine {
  type: ToolDiffLineType;
  text: string;
}

/** 写文件工具返回 JSON 中的结构化变更证据，前端渲染成"文件 +x/-y"审查卡片。 */
export interface ToolFileChange {
  /** 相对工作区路径（或工具给定的展示路径） */
  file: string;
  kind: "added" | "modified" | "deleted" | "renamed";
  insertions: number;
  deletions: number;
  /** 展示用红绿 diff 行；变更过大时省略并置 truncated */
  diff?: ToolDiffLine[];
  truncated?: boolean;
}

/** 一次 assistant run 的可恢复展示指标。 */
export interface RunActivityRecord {
  /** Renderer 收到 RUN_STARTED 时的时间戳。 */
  startedAt: number;
  /** RUN_FINISHED 或终态错误到达后写入；缺失表示仍在处理。 */
  completedAt?: number;
  /** 已完成 reasoning 段的累计时长，不包含工具执行等待。 */
  reasoningMs: number;
  /** 当前仍在流式输出的 reasoning 段起点；终态时必须清除。 */
  activeReasoningStartedAt?: number;
  /** 取消、超时或失败时保持过程面板展开，避免隐藏唯一可见的执行证据。 */
  keepExpanded?: boolean;
}

export interface ProcessMessageRecord {
  id: string;
  content: string;
  /** 运行取消、失败或超时时，从尚未结算的候选回答保留下来的中断片段。 */
  interrupted?: boolean;
  /** 该过程消息出现前已完成的工具数，用于恢复大致执行顺序。 */
  afterToolCount?: number;
  roundId?: string;
  /** run 内单调递增的时间线序号；旧记录缺失时回退 afterToolCount 排序。 */
  seq?: number;
}

export interface ReasoningBlock {
  id: string;
  content: string;
  streaming?: boolean;
  /** 已完成的工具数，用于恢复 Think 与工具链的真实顺序。 */
  afterToolCount?: number;
  roundId?: string;
  /** run 内单调递增的时间线序号；旧记录缺失时回退 afterToolCount 排序。 */
  seq?: number;
}

export interface AgentRoundRecord {
  id: string;
  status: "running" | "completed";
  startedAt: number;
  completedAt?: number;
}

export interface TaskDelegationDisplayRecord extends TaskDelegationPresentation {
  roundId?: string;
}

export type ChatMessageChannel = "wechat" | "feishu" | "qq" | "qqbot";

/** 外部渠道镜像来源。只用于展示，不改变桌面对话或渠道 Agent 的运行身份。 */
export interface ChatMessageChannelSource {
  channel: ChatMessageChannel;
  chatType?: "private" | "group";
  senderName?: string;
}

export interface ChatMessage {
  id: string;
  role: ChatRole;
  content: string;
  /** 模型公开返回的推理过程；不包含隐藏或加密思考。 */
  reasoning?: string;
  reasoningBlocks?: ReasoningBlock[];
  /** 工具轮次中模型给用户的过程说明；不属于正式回答，也不冒充 reasoning。 */
  processMessages?: ProcessMessageRecord[];
  /** Harness 模型调用回合；用于把公开文本、reasoning 与工具执行折叠为一个单元。 */
  agentRounds?: AgentRoundRecord[];
  /** 父流程中的趣味子任务委托行；不包含子任务私有上下文。 */
  taskDelegations?: TaskDelegationDisplayRecord[];
  at: number;
  /** 模型消息回答的用户消息 id：把认领派发与对应模型运行显式关联，恢复判定据此对账。 */
  answersUserMessageId?: string;
  /** 不直接显示在聊天气泡里，但会拼入模型上下文。 */
  modelContext?: string;
  /** 绑定的微信/QQ等渠道来源；正文保持为用户实际发送的内容。 */
  channelSource?: ChatMessageChannelSource;
  attachments?: MessageAttachment[];
  /** 表情包 ID（内置或用户自定义） */
  sticker?: string | null;
  /** 工具调用过程；与模型推理 reasoning 分开保存和展示。 */
  toolExecutions?: ToolExecutionRecord[];
  /** 本轮处理与公开推理的展示指标。 */
  runActivity?: RunActivityRecord;
  /** 活跃 Agent run 的可恢复检查点；非终态快照在重启后只能恢复为 interrupted。 */
  runSnapshot?: {
    runId?: string;
    status: "running" | "waiting_user" | "interrupted" | "terminal";
    terminalStatus?: "success" | "cancelled" | "timeout" | "runtime_error";
    todos?: TodoItem[];
    updatedAt: number;
  };
  /** TTS 缓存 key。只存 key，不存绝对路径，避免 userData 路径变化后 session JSON 失效。 */
  ttsCacheKey?: string;
  /** 生成缓存时使用的朗读文本转换器版本；版本变化时旧缓存自然失效。 */
  ttsCacheVersion?: string;
  /** 已实际展示的音乐候选卡片；持久化展示不延长 Skill 候选状态 TTL。 */
  musicCard?: MusicCardData;
  /** 上下文容量快照（run 终态落盘）；运行中被每轮 preRequest 快照实时覆盖（纯内存）。 */
  contextUsage?: ContextUsageSnapshot;
}

export type MessageAttachment = ImageMessageAttachment | DocumentMessageAttachment;

export interface ImageMessageAttachment {
  kind: "image";
  name: string;
  filePath: string;
  mime: string;
  previewUrl?: string;
  caption?: string;
  status: "pending" | "done" | "error";
  /** 截图标注标记：标注像素已绘入图片文件，恢复派发时用于 caption 提示词分支。 */
  hasAnnotations?: boolean;
}

export interface DocumentMessageAttachment {
  kind: "document";
  name: string;
  filePath: string;
  status: "pending" | "done" | "error";
  processedKind?: "text" | "indexed" | "empty" | "unsupported";
  chunks?: number;
  reason?: string;
}

/** 对话工作区绑定：将一个可信目录绑定到对话 */
export interface ConversationWorkspaceBinding {
  /** 规范化后的绝对路径（realpath + Windows 标准化） */
  workspaceRoot: string;
  /** 用户可见的显示名（通常是文件夹名或缩短路径） */
  displayName: string;
  /** 绑定时间戳 */
  boundAt: number;
}

/**
 * 待发消息的附件引用：入队时刻的快照，只保留可恢复的稳定字段。
 * blob: 预览 URL、预处理状态等瞬态数据不落盘，派发时由渲染层重建。
 */
export interface PendingChatAttachment {
  kind: "image" | "document";
  name: string;
  /** 主进程落盘的附件绝对路径（临时文件或用户文件），派发时按它重新读取。 */
  filePath: string;
  mime?: string;
  caption?: string;
  /** 截图标注标记：标注像素已由截图 helper 绘入图片文件，此标记供派发时的 caption 提示词分支与展示使用。 */
  hasAnnotations?: boolean;
}

/**
 * 会话级待发消息：运行中排队、尚未派发的用户草稿快照。
 * 独立于 messages 正式历史；派发成功后由队列消费逻辑转成 ChatMessage 并移除。
 */
export interface PendingChatMessage {
  /** 稳定标识：页面生成（crypto.randomUUID），删除/去重/认领均按它处理。 */
  id: string;
  /** 用户原始输入（含表情包标记等未清洗内容）。 */
  rawContent: string;
  /** 展示内容（剥离表情包标记后；纯表情包消息可为空串）。 */
  visibleContent: string;
  /** 附件引用快照（入队时刻）；无附件时省略。 */
  attachments?: PendingChatAttachment[];
  /** 用户表情包 ID（内置或自定义）。 */
  userSticker?: string;
  /** 恢复指定旧 run（中断任务续跑）：随条目入队，认领派发时透传给模型运行。 */
  resumeFromRunId?: string;
  /**
   * 调整目标运行 id：非空表示该条目已被请求"插入当前运行下一步"。
   * 注入成功后条目转为正式用户消息并移出队列；运行结束/取消时未注入的
   * 条目由复位逻辑清除此标记，回普通队列按序派发。
   */
  adjustRunId?: string;
  /** 入队时间戳（主进程写入）：数组顺序是派发顺序的权威依据，此字段作审计。 */
  enqueuedAt: number;
  /** 撤回事务的可恢复中间态；存在时条目对认领、编辑与插话调整只读。 */
  withdrawal?: PendingWithdrawalState;
}

export interface PendingWithdrawalState {
  /** 由会话与消息标识确定性派生，重试与重启保持不变。 */
  id: string;
  status: "withdrawing";
  startedAt: number;
}

/** 可重放的待发用户事实；v2 认领时与 pendingDispatch 一起原子落盘。 */
export interface PendingDispatchUserSnapshot {
  /** 对外可见的 renderer userTurnId。 */
  id: string;
  /** 认领时生成的稳定消息时间戳。 */
  at: number;
  /** 送入模型/轨迹的原始文本。 */
  text: string;
  /** 页面展示文本；旧记录缺省时回退 text。 */
  visibleContent?: string;
  /** 认领时冻结的稳定附件元数据。 */
  attachments?: PendingChatAttachment[];
  /** 用户表情包标识。 */
  sticker?: string;
}

/**
 * 待发派发状态：队首已被认领，但模型运行尚未被主进程确认接受。
 * v2 同时保留完整 user 快照，使轨迹写入可在进程重启后恢复；旧记录仍兼容
 * 仅有 messageId/claimedAt 的形态，并在缺快照时 fail-closed（封闭失败）。
 */
export interface PendingDispatchState {
  /** 被认领的用户消息 id（即待发条目稳定标识）。 */
  messageId: string;
  /** 认领时间戳。 */
  claimedAt: number;
  /** v2 durable user intent；旧 v1 pendingDispatch 缺省。 */
  userMessage?: PendingDispatchUserSnapshot;
}

export interface ChatSession {
  id: string;
  title: string;
  identityId: string | null;
  messages: ChatMessage[];
  createdAt: number;
  updatedAt: number;
  schemaVersion: 1;
  /** 系统用途会话的稳定标识；普通用户会话不设置。 */
  purpose?: ChatSessionPurpose;
  // 用户是否手动改过名；true 时不再根据消息内容自动派生 title。
  // 没有此字段的老数据视为 false（向后兼容）。
  titleIsCustom?: boolean;
  /** 对话工作区绑定（Coding Agent 使用的可信目录） */
  workspaceBinding?: ConversationWorkspaceBinding;
  /** 会话模式：创建时绑定，整个会话生命周期不变。旧会话无此字段时默认 "work"。 */
  mode?: ConversationMode;
  /** 用户是否置顶该会话；置顶项在列表中优先展示。 */
  pinned?: boolean;
  /** 当前会话选择的已保存模型；缺失时使用默认模型。 */
  modelProfileId?: string;
  /**
   * 会话级最新上下文容量快照：上下文环形图的唯一读取点（消息级 contextUsage 仅作历史兜底）。
   * 手动压缩等「不产生新 assistant 消息但改变上下文构成」的操作写这里，
   * 避免 UI 显示过期数据（known-issues 问题 3）。
   */
  currentContextUsage?: ContextUsageSnapshot;
  /** 会话级待发队列：旧会话无此字段视为空队列（向后兼容）。 */
  pendingMessages?: PendingChatMessage[];
  /** 待发派发状态：认领后 run 确认接受前存在；残留即恢复入口（向后兼容缺省为无）。 */
  pendingDispatch?: PendingDispatchState;
}

/**
 * v2 会话磁盘记录：正式消息由 ConversationJournalService（会话轨迹服务）保存，
 * chats-store 只保留元数据与可恢复的 pending（待发）状态。
 */
export interface ChatSessionRecordV2 extends Omit<ChatSession, "messages" | "schemaVersion"> {
  schemaVersion: 2;
  messageCount: number;
}

export type ChatSessionRecord = ChatSession | ChatSessionRecordV2;

// index.json 里的轻量元数据（列表渲染用）。
export interface ChatSessionMeta {
  id: string;
  title: string;
  identityId: string | null;
  createdAt: number;
  updatedAt: number;
  messageCount: number;
  purpose?: ChatSessionPurpose;
  mode: ConversationMode;
  /** 列表分组所需的轻量工作区信息，避免为每一项读取完整 session 文件。 */
  workspaceRoot?: string;
  workspaceDisplayName?: string;
  /** 用户是否置顶该会话；与 ChatSession.pinned 同步。 */
  pinned?: boolean;
}

export const CHAT_SCHEMA_VERSION = 1 as const;

// 默认 identity 显示名（职位面板未做，所有会话先用这个）。
