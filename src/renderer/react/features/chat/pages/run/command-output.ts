import { SHELL_VISIBLE_OUTPUT_LIMIT, type ShellOutputUpdate } from "../../../../../../shared/shell-output";

export interface ShellToolOutputEvent extends ShellOutputUpdate {
  toolCallId: string;
}

export function normalizeShellOutputEvent(value: unknown): ShellToolOutputEvent | null {
  if (!value || typeof value !== "object") return null;
  const event = value as Record<string, unknown>;
  if (typeof event.toolCallId !== "string" || !event.toolCallId.trim()) return null;
  if (event.action !== "append" && event.action !== "replace") return null;
  if (typeof event.text !== "string" || event.text.length > SHELL_VISIBLE_OUTPUT_LIMIT) return null;
  if (event.truncated !== undefined && typeof event.truncated !== "boolean") return null;
  return {
    toolCallId: event.toolCallId,
    action: event.action,
    text: event.text,
    truncated: event.truncated === true,
  };
}

export function applyVisibleOutput(current: string, update: ShellOutputUpdate, wasTruncated = false): { text: string; truncated: boolean } {
  const combined = update.action === "replace" ? update.text : current + update.text;
  let text = combined.length > SHELL_VISIBLE_OUTPUT_LIMIT
    ? combined.slice(-SHELL_VISIBLE_OUTPUT_LIMIT)
    : combined;
  if (/^[\uDC00-\uDFFF]/u.test(text)) text = text.slice(1);
  return {
    text,
    truncated: (update.action === "append" && wasTruncated)
      || update.truncated === true
      || combined.length > SHELL_VISIBLE_OUTPUT_LIMIT,
  };
}
