import type { ChatMessage } from "../orchestrator/vendors/types";

/** The browser_* tools act on the desktop browser panel. */
export function isDesktopBrowserTool(toolId: string): boolean {
  return toolId.startsWith("browser_");
}

function parseToolResult(text: unknown): { outcome?: string; fullOutputRef?: string; output?: string; toolName?: string; resultRef?: string } | undefined {
  if (typeof text !== "string") return undefined;
  try {
    const value = JSON.parse(text);
    return value && typeof value === "object" ? value : undefined;
  } catch {
    return undefined;
  }
}

/** Bound channels share conversation text without replaying desktop browser calls or results. */
export function withoutDesktopBrowserHistory(messages: ChatMessage[]): ChatMessage[] {
  const blockedCallIds = new Set(messages.flatMap((message) =>
    message.toolCalls?.filter((call) => isDesktopBrowserTool(call.name)).map((call) => call.id) ?? []));
  const sharedRefs = new Set<string>();
  for (const message of messages) {
    if (message.role !== "tool" || !message.name || isDesktopBrowserTool(message.name)) continue;
    const ref = parseToolResult(message.content)?.fullOutputRef;
    if (typeof ref === "string") sharedRefs.add(ref);
  }
  const blockedResults = new Set<ChatMessage>();
  for (const message of messages) {
    if (message.role !== "tool") continue;
    const observation = message.name === "read_tool_result" ? parseToolResult(message.content) : undefined;
    const source = observation?.outcome === "success" ? parseToolResult(observation.output) : undefined;
    // Old paginated results have no source tool name. Replay only those tied to a shared result.
    const blockedRead = observation?.outcome === "success" && (typeof source?.toolName === "string"
      ? isDesktopBrowserTool(source.toolName) : !source?.resultRef || !sharedRefs.has(source.resultRef));
    if (blockedRead || (message.name
      ? isDesktopBrowserTool(message.name) : blockedCallIds.has(message.toolCallId ?? ""))) {
      blockedResults.add(message);
      if (message.toolCallId) blockedCallIds.add(message.toolCallId);
    }
  }
  return messages.flatMap((message) => {
    if (blockedResults.has(message)) return [];
    const toolCalls = message.toolCalls?.filter((call) => !isDesktopBrowserTool(call.name)
      && (call.name !== "read_tool_result" || !blockedCallIds.has(call.id)));
    if (toolCalls?.length === message.toolCalls?.length) return [message];
    if (!toolCalls?.length && !message.content) return [];
    return [{ ...message, toolCalls, rawAssistant: undefined, providerReplay: undefined }];
  });
}
