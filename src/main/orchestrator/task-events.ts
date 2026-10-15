import { randomUUID } from "node:crypto";
import type { TaskTraceRecord } from "../../shared/task-session";
import type { HarnessEvent } from "./harness/types";

const MAX_TRACE_TEXT_LENGTH = 2_000;

function boundedText(value: string): string {
  return value.length > MAX_TRACE_TEXT_LENGTH
    ? `${value.slice(0, MAX_TRACE_TEXT_LENGTH)}…`
    : value;
}

/**
 * 子 Harness 事件到私有 Task 轨迹的净化边界。
 * 故意不保存工具参数和完整工具输出，避免未来打开轨迹时泄漏敏感值。
 */
export function projectTaskTraceEvent(
  event: HarnessEvent,
  at = Date.now(),
  createId: () => string = randomUUID,
): TaskTraceRecord | undefined {
  switch (event.type) {
    case "round_start":
      return { id: createId(), at, kind: "round", phase: "start", label: event.roundId };
    case "round_end":
      return { id: createId(), at, kind: "round", phase: "end", label: event.roundId };
    case "candidate_text_delta":
      return { id: createId(), at, kind: "candidate", phase: "delta", label: event.roundId, content: boundedText(event.delta) };
    case "candidate_text_discard":
      return { id: createId(), at, kind: "candidate", phase: "discard", label: event.roundId };
    case "progress_text":
      return { id: createId(), at, kind: "progress", content: boundedText(event.content) };
    case "reasoning_start":
      return { id: createId(), at, kind: "reasoning", phase: "start", label: event.messageId };
    case "reasoning_delta":
      return { id: createId(), at, kind: "reasoning", phase: "delta", label: event.messageId, content: boundedText(event.delta) };
    case "reasoning_end":
      return { id: createId(), at, kind: "reasoning", phase: "end", label: event.messageId };
    case "tool_start":
      return {
        id: createId(), at, kind: "tool", phase: "start", label: event.toolName,
        toolCallId: event.toolCallId,
        ...(event.displayName ? { displayName: event.displayName } : {}),
      };
    case "tool_end":
      return { id: createId(), at, kind: "tool", phase: "end", label: event.toolCallId, status: event.outcome };
    case "todo_update":
      return { id: createId(), at, kind: "todo", status: String(event.items.length) };
    case "error":
      return { id: createId(), at, kind: "terminal", status: "error", content: boundedText(event.message) };
    default:
      return undefined;
  }
}
