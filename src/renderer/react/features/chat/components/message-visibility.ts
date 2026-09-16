import type { RunActivityRecord } from "../../../../../shared/chat-types";

export interface AssistantVisibilityState {
  content: string;
  transientText?: string;
  loading?: boolean;
  reasoning?: string;
  reasoningStreaming?: boolean;
  responseStarted?: boolean;
  sticker?: string | null;
  runActivity?: RunActivityRecord;
}

export function assistantRenderStages(message: AssistantVisibilityState): Array<"activity" | "reasoning" | "assistant"> {
  const stages: Array<"activity" | "reasoning" | "assistant"> = [];
  if (message.runActivity) stages.push("activity");
  // `loading` only means the run is pending. It must not fabricate a visible
  // chain of thought for tool-capable models that do not return reasoning.
  if (message.reasoning || message.reasoningStreaming) stages.push("reasoning");
  if (message.responseStarted || message.transientText || message.content || message.sticker) stages.push("assistant");
  return stages;
}

export function resolveReasoningExpanded(
  expandedById: Readonly<Record<string, boolean>>,
  messageId: string,
): boolean {
  return expandedById[messageId] ?? false;
}

export function updateReasoningExpanded(
  expandedById: Readonly<Record<string, boolean>>,
  messageId: string,
  expanded: boolean,
): Record<string, boolean> {
  return expandedById[messageId] === expanded
    ? expandedById
    : { ...expandedById, [messageId]: expanded };
}
