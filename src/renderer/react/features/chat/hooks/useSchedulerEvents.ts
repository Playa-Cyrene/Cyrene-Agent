// 定时任务执行事件 → 聊天窗口消息流。
//
// 主进程 scheduler-runner 把任务执行过程（触发提示、流式回复、工具调用、
// 终态）通过 schedulerEvents IPC 推给 React 聊天窗口；本 hook 把事件流
// 转成"当前会话"里的消息插入与补丁：任务触发时插入提示消息 + 助手占位，
// 流式文本与工具调用实时补丁到占位消息，终态后把结果落库。
// 行为对齐 React 迁移前旧聊天窗口的 installSchedulerEventListener。

import { useEffect, useRef } from "react";
import type { ChatMessageItem } from "../components/ChatMessageList";
import type { ChatMessage } from "../../../../../shared/chat-types";

/** 主进程 scheduler-runner 转发的事件（AG-UI 事件 + schedulerRunId 标记）。 */
interface SchedulerStreamEvent {
  type?: string;
  name?: string;
  value?: unknown;
  delta?: string;
  message?: string;
  error?: string;
  content?: string;
  status?: string;
  toolCallId?: string;
  toolCallName?: string;
  /** 主进程注册表里的中文展示名；用于工具行的用户可读标签。 */
  toolCallDisplayName?: string;
  schedulerRunId?: string;
  schedulerTaskId?: string;
  conversationId?: string;
  runId?: string;
  threadId?: string;
  messageId?: string;
  toolExecutions?: ChatMessage["toolExecutions"];
  runSnapshot?: ChatMessage["runSnapshot"];
}

interface SchedulerStartedValue {
  taskId?: string;
  title?: string;
  manual?: boolean;
  firedAt?: string;
  runId?: string;
  noticeId?: string;
  replyId?: string;
}

/** 单次调度执行在渲染端的累积状态；sessionId 在触发时冻结（切会话不改归属）。 */
interface SchedulerStreamState {
  sessionId: string | null;
  replyId: string;
  content: string;
  tools: ChatMessageItem["toolExecutions"];
}

export interface UseSchedulerEventsDeps {
  /** 主进程在 scheduler started 时冻结的会话归属。 */
  appendMessages: (sessionId: string, items: ChatMessageItem[]) => void;
  patchMessage: (sessionId: string, id: string, patch: Partial<ChatMessageItem>) => void;
}

/** preload 暴露的 schedulerEvents 全局对象。 */
function schedulerEventsApi(): { onEvent: (callback: (event: unknown) => void) => () => void } | undefined {
  return (window as typeof window & {
    schedulerEvents?: { onEvent: (callback: (event: unknown) => void) => () => void };
  }).schedulerEvents;
}

function startedValue(event: SchedulerStreamEvent): SchedulerStartedValue | null {
  const value = event.value;
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  return value as SchedulerStartedValue;
}

/** 事件归属的调度执行键：schedulerRunId 优先，兼容裸 runId / threadId。 */
function runKeyOf(event: SchedulerStreamEvent): string {
  return event.schedulerRunId ?? event.runId ?? event.threadId ?? "scheduler-default";
}

export function useSchedulerEvents(deps: UseSchedulerEventsDeps): void {
  const depsRef = useRef(deps);
  depsRef.current = deps;
  const streamsRef = useRef(new Map<string, SchedulerStreamState>());

  useEffect(() => {
    const api = schedulerEventsApi();
    if (!api) return;

    /** 终态收尾：补丁占位消息为终态并落库。 */
    const finishStream = (
      state: SchedulerStreamState,
      finalContent: string,
      runSnapshot?: ChatMessage["runSnapshot"],
      toolExecutions?: ChatMessage["toolExecutions"],
    ): void => {
      if (!state.sessionId) return;
      const { sessionId, replyId } = state;
      depsRef.current.patchMessage(sessionId, replyId, {
        content: finalContent,
        loading: false,
        streaming: false,
        waitingForFirstEvent: false,
        responseStarted: true,
        toolExecutions: toolExecutions ?? state.tools,
        ...(runSnapshot !== undefined ? { runSnapshot } : {}),
      });
    };

    const off = api.onEvent((rawEvent) => {
      const event = rawEvent as SchedulerStreamEvent;

      // 任务触发：在当前激活会话里插入提示消息 + 助手占位
      if (event.type === "CUSTOM" && event.name === "scheduler.started") {
        const value = startedValue(event);
        const runKey = event.schedulerRunId ?? value?.runId ?? `scheduler-${Date.now()}`;
        if (streamsRef.current.has(runKey)) return;
        const sessionId = event.conversationId ?? null;
        const replyId = value?.replyId ?? `scheduler-reply-${runKey}`;
        const noticeId = value?.noticeId ?? event.messageId ?? `scheduler-notice-${runKey}`;
        const title = value?.title ?? "未命名任务";
        streamsRef.current.set(runKey, { sessionId, replyId, content: "", tools: [] });
        if (!sessionId) return;
        depsRef.current.appendMessages(sessionId, [
          { id: noticeId, role: "user", content: `定时任务「${title}」已触发` },
          {
            id: replyId,
            role: "assistant",
            content: "",
            loading: true,
            waitingForFirstEvent: true,
            streaming: false,
            responseStarted: false,
          },
        ]);
        return;
      }

      const runKey = runKeyOf(event);
      const state = streamsRef.current.get(runKey);
      if (!state?.sessionId) return;

      switch (event.type) {
        case "TOOL_CALL_START": {
          if (!event.toolCallId) return;
          state.tools = [
            ...(state.tools ?? []),
            { id: event.toolCallId, name: event.toolCallName ?? "工具", displayName: event.toolCallDisplayName, status: "running" },
          ];
          depsRef.current.patchMessage(state.sessionId, state.replyId, {
            toolExecutions: [...state.tools],
            loading: false,
            waitingForFirstEvent: false,
          });
          return;
        }
        case "TOOL_CALL_RESULT": {
          if (!event.toolCallId) return;
          state.tools = (state.tools ?? []).map((tool) => (
            tool.id === event.toolCallId
              ? {
                ...tool,
                status: event.status === "failed" ? "error" : "success",
                result: (event.content ?? "").slice(0, 4000),
              }
              : tool
          ));
          depsRef.current.patchMessage(state.sessionId, state.replyId, { toolExecutions: [...state.tools] });
          return;
        }
        case "TEXT_MESSAGE_START": {
          state.content = "";
          depsRef.current.patchMessage(state.sessionId, state.replyId, {
            loading: false,
            waitingForFirstEvent: false,
            responseStarted: true,
            streaming: true,
            content: "",
          });
          return;
        }
        case "TEXT_MESSAGE_CONTENT": {
          if (!event.delta) return;
          state.content += event.delta;
          depsRef.current.patchMessage(state.sessionId, state.replyId, {
            content: state.content,
            loading: false,
            streaming: true,
            responseStarted: true,
            waitingForFirstEvent: false,
          });
          return;
        }
        case "TEXT_MESSAGE_END": {
          depsRef.current.patchMessage(state.sessionId, state.replyId, { streaming: false });
          return;
        }
        case "RUN_FINISHED": {
          // Main owns the deterministic display reply; local state is only a fallback for old events.
          const finalContent = event.content ?? state.content;
          finishStream(state, finalContent, event.runSnapshot, event.toolExecutions);
          streamsRef.current.delete(runKey);
          return;
        }
        case "RUN_ERROR": {
          const message = event.message ?? event.error ?? "未知错误";
          finishStream(state, `定时任务执行失败：${message}`);
          streamsRef.current.delete(runKey);
          return;
        }
        default:
          return;
      }
    });

    return off;
  }, []);
}
