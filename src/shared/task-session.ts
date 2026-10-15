/** 私有子任务会话的跨进程可序列化契约。 */

export type TaskSessionStatus = "running" | "completed" | "failed" | "cancelled" | "interrupted";

export type TaskSubagentType = "general" | "document" | "search";

export type TaskAccessMode = "read_only" | "write";

export const DEFAULT_TASK_MAX_PARALLEL_TOOL_CALLS = 4;
export const MAX_PARALLEL_TOOL_CALLS = 12;

export type TodoStatus = "pending" | "in_progress" | "completed" | "cancelled";

export interface TodoItem {
  id: string;
  content: string;
  status: TodoStatus;
  activeForm?: string;
}

/**
 * 保留 Harness 协议消息所需的可序列化字段，但不把 Main 的 vendor 类型反向引入 shared。
 */
export interface TaskTranscriptMessage {
  role: string;
  content: string;
  toolCalls?: unknown[];
  toolCallId?: string;
  name?: string;
  /** 检查器的展示关联信息，不进入恢复运行时的模型消息。 */
  presentation?: {
    id?: string;
    at?: number;
    runId?: string;
    roundId?: string;
    outcome?: string;
    fullRef?: string;
  };
  [key: string]: unknown;
}

export interface TaskTraceRecord {
  id: string;
  at: number;
  /** 区分同一角色上下文中的多次委派；旧轨迹没有此字段。 */
  runId?: string;
  roundId?: string;
  toolCallId?: string;
  kind: "round" | "candidate" | "progress" | "reasoning" | "tool" | "todo" | "terminal";
  phase?: "start" | "delta" | "end" | "discard";
  label?: string;
  displayName?: string;
  content?: string;
  status?: string;
}

export interface TaskSession {
  schemaVersion: 1;
  id: string;
  parentConversationId: string;
  parentRunId: string;
  childRunId: string;
  description: string;
  subagentType: TaskSubagentType;
  /** 当前上下文绑定的黄金裔；关闭后保留旧记录但不再恢复该上下文。 */
  companionId?: string;
  contextOpen?: boolean;
  mode: "work" | "code";
  resolvedWorkspaceRoot?: string;
  status: TaskSessionStatus;
  messages: TaskTranscriptMessage[];
  trace: TaskTraceRecord[];
  todoItems: TodoItem[];
  resultText?: string;
  error?: { code: string; message: string };
  createdAt: number;
  updatedAt: number;
  completedAt?: number;
}

/** 存在于父助手消息中的最小公开记录；不包含子任务提示词或轨迹。 */
export interface TaskDelegationRecord {
  taskId: string;
  description: string;
  subagentType: TaskSubagentType;
  status: TaskSessionStatus;
  delegatedAt: number;
  updatedAt: number;
}

export type TaskDelegationPresentationStatus = "running" | "completed" | "failed" | "cancelled";

/** 父流程可见的最小委托信息，不包含子任务 prompt 或私有轨迹。 */
export interface TaskDelegationPresentation {
  invocationId: string;
  taskId: string;
  description: string;
  nickname: string;
  assetFileName: string;
  status: TaskDelegationPresentationStatus;
}
