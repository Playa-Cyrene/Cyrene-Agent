/**
 * 子任务 transcript 条目 → messages 形状的投影。
 *
 * 消费方两处，语义必须一致：
 * - chats-ipc TASK_SESSION_GET：任务检查器渲染对话与工具执行面板；
 * - task-runtime：resume 时把 transcript 重投影为 harness 输入的对话历史
 *   （checkpoint 全量快照退役后，跨 resume 的历史唯一来源就是 transcript）。
 *
 * assistant / tool_result 的 payload 本身就是 canonical ChatMessage，按角色透传；
 * task_state / presentation_patch 等展示类条目不进对话流。
 */

import type { TranscriptEntry } from "./conversation-transcript-types";
import type { TodoItem } from "./harness/types";
import type { TaskTranscriptMessage } from "../../shared/task-session";

/** canonical content 是 string | 分块数组 的联合，检查器与 harness 都只吃文本。 */
export function transcriptContentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => typeof part === "string" ? part : typeof (part as { text?: unknown })?.text === "string" ? (part as { text: string }).text : "")
      .join("");
  }
  return "";
}

export function projectTaskTranscriptMessages(entries: TranscriptEntry[]): TaskTranscriptMessage[] {
  const messages: TaskTranscriptMessage[] = [];
  for (const entry of entries) {
    if (entry.kind === "user") {
      messages.push({ role: "user", content: entry.payload.text });
    } else if (entry.kind === "assistant") {
      const { role, content, toolCalls } = entry.payload;
      messages.push({ role, content: transcriptContentText(content), ...(Array.isArray(toolCalls) ? { toolCalls } : {}) });
    } else if (entry.kind === "tool_result") {
      const message = entry.payload.message;
      messages.push({
        role: "tool",
        content: transcriptContentText(message.content),
        toolCallId: message.toolCallId,
        ...(message.name ? { name: message.name } : {}),
      });
    }
  }
  return messages;
}

/** 最新 todo 状态 = 最后一条 task_state 条目的 items（todoItems 只经 update_todo 变化，
 *  每次变化都伴随一条 task_state 落库；checkpoint 快照通道已退役）。 */
export function projectTaskTodoItems(entries: TranscriptEntry[]): TodoItem[] {
  for (let index = entries.length - 1; index >= 0; index--) {
    const entry = entries[index]!;
    if (entry.kind === "task_state") return entry.payload.items;
  }
  return [];
}
