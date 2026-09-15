import type { ChatMessageItem } from "../components/ChatMessageList";
import type { ChatMessage, ChatSession, ConversationMode } from "../../../../../shared/chat-types";
import type { ComposerInteraction } from "../components/run-presentation";
import type { TodoItem } from "../../../../../shared/todo-types";
import { t } from "../../../i18n";

export interface SessionInteractionEntry {
  interaction: ComposerInteraction;
  busy: boolean;
}

export type SessionInteractionState = Record<string, SessionInteractionEntry>;

export function bindWorkspaceName(
  state: Partial<Record<ConversationMode, string>>,
  mode: ConversationMode,
  displayName: string | undefined,
): Partial<Record<ConversationMode, string>> {
  return { ...state, [mode]: displayName };
}

export function sessionInteraction(
  state: SessionInteractionState,
  sessionId: string | undefined,
): SessionInteractionEntry | undefined {
  return sessionId ? state[sessionId] : undefined;
}

export function setSessionInteraction(
  state: SessionInteractionState,
  sessionId: string,
  interaction: ComposerInteraction,
  busy = false,
): SessionInteractionState {
  return { ...state, [sessionId]: { interaction, busy } };
}

export function clearSessionInteraction(
  state: SessionInteractionState,
  sessionId: string,
): SessionInteractionState {
  if (!state[sessionId]) return state;
  const next = { ...state };
  delete next[sessionId];
  return next;
}

export function setSessionInteractionBusy(
  state: SessionInteractionState,
  sessionId: string,
  busy: boolean,
): SessionInteractionState {
  const current = state[sessionId];
  return current ? { ...state, [sessionId]: { ...current, busy } } : state;
}

export function patchSessionMessage(
  state: Record<string, ChatMessageItem[]>,
  sessionId: string,
  messageId: string,
  patch: Partial<ChatMessageItem>,
): Record<string, ChatMessageItem[]> {
  return {
    ...state,
    [sessionId]: (state[sessionId] ?? []).map((item) => (
      item.id === messageId ? { ...item, ...patch } : item
    )),
  };
}

export function hydrateSessionMessages(
  state: Record<string, ChatMessageItem[]>,
  sessionId: string,
  storedMessages: ChatMessageItem[],
  hasActiveRun: boolean,
): Record<string, ChatMessageItem[]> {
  if (hasActiveRun && state[sessionId]) return state;
  return { ...state, [sessionId]: storedMessages };
}

export function recoverInterruptedMessage(
  message: ChatMessageItem,
  snapshot: NonNullable<ChatMessage["runSnapshot"]>,
): ChatMessageItem {
  if (snapshot.status === "terminal" || snapshot.status === "interrupted") return message;
  return {
    ...message,
    streaming: false,
    reasoningStreaming: false,
    loading: false,
    waitingForFirstEvent: false,
    runStage: { kind: "failed", detail: t("chatPage.lastRunInterrupted") },
    runActivity: {
      ...(message.runActivity ?? { startedAt: snapshot.updatedAt, reasoningMs: 0 }),
      activeReasoningStartedAt: undefined,
      completedAt: snapshot.updatedAt,
      keepExpanded: true,
    },
  };
}

export function findSessionIdForRun(
  activeRuns: Record<string, { runId?: string }>,
  runId: string | undefined,
): string | undefined {
  if (!runId) return undefined;
  return Object.entries(activeRuns).find(([, run]) => run.runId === runId)?.[0];
}

export function hasActiveRunForSession(
  activeRuns: Record<string, unknown>,
  sessionId: string,
): boolean {
  return Boolean(activeRuns[sessionId]);
}

interface HarnessTodoPresentation {
  id: string;
  content: string;
  status: string;
}

export interface SessionTodoState {
  runId?: string;
  todos: TodoItem[];
  updatedAt: number;
}

export type TodoStateBySession = Record<string, SessionTodoState>;

export function buildTodoRecoveryContext(
  messages: readonly ChatMessage[],
  excludedMessageId?: string,
): string | undefined {
  const message = [...messages].reverse().find((candidate) => {
    if (candidate.id === excludedMessageId) return false;
    const snapshot = candidate.runSnapshot;
    if (!snapshot?.todos?.some((todo) => todo.status === "pending" || todo.status === "in_progress")) return false;
    if (snapshot.status !== "terminal") return true;
    return snapshot.terminalStatus !== undefined && snapshot.terminalStatus !== "success";
  });
  if (!message?.runSnapshot?.todos) return undefined;

  const successes = message.toolExecutions?.filter((tool) => tool.status === "success").length ?? 0;
  const failures = message.toolExecutions?.filter((tool) => tool.status === "error").length ?? 0;
  return [
    "上一次任务在完整回答提交前中断。以下内容来自同一会话的本地检查点，仅用于恢复方向：",
    "Todo：",
    ...message.runSnapshot.todos.map((todo) => `- [${todo.status}] ${todo.content}`),
    `工具执行事实：成功 ${successes} 项，失败 ${failures} 项。`,
    "Todo 和本地记录不能证明外部副作用已经成功；继续前请根据现有证据查证，不要自动重放危险操作。",
  ].join("\n");
}

export function startSessionTodos(
  state: TodoStateBySession,
  sessionId: string,
  runId: string | undefined,
  updatedAt = Date.now(),
): TodoStateBySession {
  return {
    ...state,
    [sessionId]: { runId, todos: [], updatedAt },
  };
}

export function mergeHarnessTodosForSession(
  state: TodoStateBySession,
  sessionId: string,
  runId: string | undefined,
  items: readonly HarnessTodoPresentation[],
  updatedAt = Date.now(),
): TodoStateBySession {
  const current = state[sessionId];
  if (current?.runId && runId && current.runId !== runId) return state;

  const todos = items.flatMap<TodoItem>((item) => {
    if (!item.id || !item.content) return [];
    if (item.status !== "pending" && item.status !== "in_progress" && item.status !== "completed") return [];
    return [{ id: item.id, content: item.content, status: item.status }];
  });

  return {
    ...state,
    [sessionId]: { runId: current?.runId ?? runId, todos, updatedAt },
  };
}
/** 残留认领（pendingDispatch）的恢复判定结果。 */
export type ClaimRecoveryStatus =
  /** 对应模型运行已有终态回答或错误提示：清除派发簿记后继续消费队列。 */
  | { kind: "dispatched" }
  /** 尚未派发或运行未终态：需要续派（旧 run 仍活着由主进程守卫与接管卡兜底）。 */
  | { kind: "needs-dispatch" }
  /** 认领记录指向的用户消息不存在（数据损坏）：暂停该会话队列并报错，绝不当作已完成。 */
  | { kind: "claim-message-missing" };

/**
 * 判定残留认领的恢复路径：必须关联「本次认领的消息」与「它对应的模型运行」——
 * 只统计 answersUserMessageId 指向该认领的 model 消息，其余消息（旧 run 的迟到回答、
 * 其他轮次的回答）一律不算，避免误判已派发而丢消息。
 */
export function evaluateClaimRecovery(session: ChatSession, messageId: string): ClaimRecoveryStatus {
  const index = session.messages.findIndex((message) => message.id === messageId && message.role === "user");
  if (index < 0) return { kind: "claim-message-missing" };
  const answered = session.messages.slice(index + 1).some((message) =>
    message.role === "model"
    && message.answersUserMessageId === messageId
    && (message.runSnapshot
      ? message.runSnapshot.status === "terminal"
      : Boolean(message.content.trim() || message.sticker)),
  );
  return answered ? { kind: "dispatched" } : { kind: "needs-dispatch" };
}