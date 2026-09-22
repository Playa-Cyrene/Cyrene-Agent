import { EventType, type BaseEvent } from "@ag-ui/core";
import type { HarnessEvent } from "../types";
import type { TaskDelegationPresentation } from "../../../../shared/task-session";

const LOG_PREFIX = "[HarnessAdapter]";

/**
 * 事件适配器（event mapper）只做 HarnessEvent → AG-UI BaseEvent 的协议转换。
 * 它不更新 run 状态、不执行工具，也不等待异步副作用；事件顺序由 Harness 保证。
 */
export function sendHarnessEventAsAgui(
  event: HarnessEvent,
  messageId: string,
  threadId: string,
  runId: string,
  send: (event: BaseEvent) => void,
): void {
  switch (event.type) {
    case "round_start":
    case "round_end": {
      send({
        type: EventType.CUSTOM,
        name: "cyrene.round",
        value: {
          action: event.type === "round_start" ? "start" : "end",
          roundId: event.roundId,
        },
        threadId,
        runId,
      } as BaseEvent);
      break;
    }
    case "candidate_text_delta":
    case "candidate_text_discard": {
      send({
        type: EventType.CUSTOM,
        name: "cyrene.candidate_text",
        value: event.type === "candidate_text_delta"
          ? { action: "delta", roundId: event.roundId, delta: event.delta }
          : { action: "discard", roundId: event.roundId },
        threadId,
        runId,
      } as BaseEvent);
      break;
    }
    case "progress_text": {
      send({
        type: EventType.CUSTOM,
        name: "cyrene.process_text",
        value: { content: event.content },
        threadId,
        runId,
      } as BaseEvent);
      break;
    }
    case "final_answer": {
      // AG-UI 文本消息必须按 START → CONTENT → END 发出，不能为了简化而合并事件。
      send({ type: EventType.TEXT_MESSAGE_START, messageId, role: "assistant", threadId, runId } as BaseEvent);
      send({ type: EventType.TEXT_MESSAGE_CONTENT, messageId, delta: event.content, threadId, runId } as BaseEvent);
      send({ type: EventType.TEXT_MESSAGE_END, messageId, threadId, runId } as BaseEvent);
      break;
    }
    case "reasoning_start": {
      // AG-UI 规范：REASONING_MESSAGE_START 的 role 固定为 "reasoning"。
      send({ type: EventType.REASONING_MESSAGE_START, messageId: event.messageId, role: "reasoning", threadId, runId } as BaseEvent);
      break;
    }
    case "reasoning_delta": {
      send({ type: EventType.REASONING_MESSAGE_CONTENT, messageId: event.messageId, delta: event.delta, threadId, runId } as BaseEvent);
      break;
    }
    case "reasoning_end": {
      send({ type: EventType.REASONING_MESSAGE_END, messageId: event.messageId, threadId, runId } as BaseEvent);
      break;
    }
    case "tool_start": {
      send({
        type: EventType.TOOL_CALL_START,
        toolCallId: event.toolCallId,
        toolCallName: event.toolName,
        toolCallDisplayName: event.displayName,
        threadId,
        runId,
      } as BaseEvent);
      send({
        type: EventType.TOOL_CALL_ARGS,
        toolCallId: event.toolCallId,
        delta: JSON.stringify(event.args),
        threadId,
        runId,
      } as BaseEvent);
      break;
    }
    case "tool_end": {
      // 前端先消费工具结果，再收到 TOOL_CALL_END；调整顺序会让工具卡片短暂显示为空。
      send({
        type: EventType.TOOL_CALL_RESULT,
        messageId: `${messageId}-tool-${event.toolCallId}`,
        toolCallId: event.toolCallId,
        content: event.preview,
        changes: event.changes,
        role: "tool",
        status: event.outcome === "success" ? "success" : "failed",
        threadId,
        runId,
      } as BaseEvent);
      send({
        type: EventType.TOOL_CALL_END,
        toolCallId: event.toolCallId,
        threadId,
        runId,
      } as BaseEvent);
      break;
    }
    case "todo_update": {
      send({
        type: EventType.CUSTOM,
        name: "cyrene.todo",
        value: { items: event.items },
        threadId,
        runId,
      } as BaseEvent);
      break;
    }
    case "context_usage": {
      send({
        type: EventType.CUSTOM,
        name: "cyrene.context.usage",
        value: event.snapshot,
        threadId,
        runId,
      } as BaseEvent);
      break;
    }
    case "runtime_feedback":
      // 这是 Harness 内部反馈，不属于公开 AG-UI 事件，刻意丢弃。
      break;
    case "ask_user":
      // ask_user 由 requestUserClarification 通道处理，不能在这里重复触发询问。
      break;
    case "plan_mode_changed": {
      send({
        type: EventType.CUSTOM,
        name: "cyrene.plan",
        value: { action: "state_changed", state: event.state },
        threadId,
        runId,
      } as BaseEvent);
      break;
    }
    case "plan_written": {
      send({
        type: EventType.CUSTOM,
        name: "cyrene.plan",
        value: { action: "written", planPath: event.planPath },
        threadId,
        runId,
      } as BaseEvent);
      break;
    }
    case "error":
      console.error(`${LOG_PREFIX} harness error: ${event.message}`);
      break;
  }
}

export function sendTaskLifecycleAsAgui(
  value: TaskDelegationPresentation,
  threadId: string,
  runId: string,
  send: (event: BaseEvent) => void,
): void {
  send({ type: EventType.CUSTOM, name: "cyrene.task", value, threadId, runId } as BaseEvent);
}
