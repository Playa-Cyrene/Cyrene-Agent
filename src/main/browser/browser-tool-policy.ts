import { recoverPortableMessage } from "../orchestrator/vendors/model-history";
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
  return projectChannelBrowserHistory(messages).filter((message) => message !== undefined);
}

/** Preserve source positions so checkpoint boundaries can be applied after filtering. */
export function projectChannelBrowserHistory(
  messages: ChatMessage[],
  activeRunAssistants?: ReadonlySet<ChatMessage>,
): Array<ChatMessage | undefined> {
  const portable = messages.map(recoverPortableMessage);
  const callOwners = new Map<string, { name: string; blockedIds: Set<string> }>();
  const blockedCalls = new Map<number, Set<string>>();
  const observations: Array<{ index: number; browser: boolean; read: boolean; blockedIds?: Set<string> }> = [];
  const sharedRefs = new Set<string>();
  const browserRefs = new Set<string>();
  const observationsWithRefs = new Map<number, NonNullable<ReturnType<typeof parseToolResult>>>();
  for (const [index, message] of portable.entries()) {
    if (message.role === "assistant" && message.toolCalls?.length) {
      // Providers can reuse a call ID in later rounds. Match each result to the preceding owner.
      const blockedIds = new Set<string>();
      blockedCalls.set(index, blockedIds);
      for (const call of message.toolCalls) callOwners.set(call.id, { name: call.name, blockedIds });
    }
    if (message.role !== "tool") continue;
    const owner = callOwners.get(message.toolCallId ?? "");
    const names = [message.name, owner?.name];
    const browser = names.some((name) => name && isDesktopBrowserTool(name));
    const read = names.includes("read_tool_result");
    observations.push({ index, browser, read, blockedIds: owner?.blockedIds });
    if (read || !names.some(Boolean)) continue;
    const observation = parseToolResult(message.content);
    if (typeof observation?.fullOutputRef !== "string") continue;
    observationsWithRefs.set(index, observation);
    (browser ? browserRefs : sharedRefs).add(observation.fullOutputRef);
  }
  const blockedResults = new Set<number>();
  for (const { index, browser, read, blockedIds } of observations) {
    const message = portable[index]!;
    const observation = read ? parseToolResult(message.content) : undefined;
    const source = observation?.outcome === "success" ? parseToolResult(observation.output) : undefined;
    // Old paginated results have no source tool name. Replay only those tied to a shared result.
    const ref = source?.resultRef;
    const blockedRead = observation?.outcome === "success" && ((ref && browserRefs.has(ref))
      || (typeof source?.toolName === "string"
        ? isDesktopBrowserTool(source.toolName) : !ref || !sharedRefs.has(ref)));
    if (browser || blockedRead) {
      blockedResults.add(index);
      if (message.toolCallId) blockedIds?.add(message.toolCallId);
    }
  }
  return portable.map((message, index) => {
    if (blockedResults.has(index)) return undefined;
    if (message.role !== "assistant") {
      const observation = observationsWithRefs.get(index);
      if (observation?.fullOutputRef && browserRefs.has(observation.fullOutputRef)) {
        // An old store can reuse the first record for a call ID within a run.
        const { fullOutputRef: _ref, ...shared } = observation;
        return { ...message, content: JSON.stringify(shared) };
      }
      return message;
    }
    const toolCalls = message.toolCalls?.filter((call) => !isDesktopBrowserTool(call.name)
      && !blockedCalls.get(index)?.has(call.id));
    const changedCalls = toolCalls?.length !== message.toolCalls?.length;
    if (changedCalls && !toolCalls?.length && !message.content && !message.attachments?.length) return undefined;
    // Private reasoning can quote a desktop observation even in an assistant message without calls.
    const { rawAssistant, providerReplay, thinking, ...shared } = message;
    if (!changedCalls && (activeRunAssistants?.has(messages[index]!)
      || (rawAssistant === undefined && providerReplay === undefined && thinking === undefined))) return message;
    return { ...shared, toolCalls };
  });
}
