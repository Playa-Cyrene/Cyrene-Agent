export interface CallTranscriptMessage {
  id: number;
  speaker: "user" | "assistant";
  text: string;
  final: boolean;
}

export type CallTranscriptEvent = Omit<CallTranscriptMessage, "id" | "final"> & { final?: boolean };

export function applyCallTranscriptEvent(
  messages: CallTranscriptMessage[],
  event: CallTranscriptEvent,
): CallTranscriptMessage[] {
  const lastMessage = messages.at(-1);
  if (event.speaker === "user" && lastMessage?.speaker === "user" && !lastMessage.final) {
    return [...messages.slice(0, -1), { ...lastMessage, text: event.text, final: event.final ?? true }];
  }

  return [...messages, {
    id: (lastMessage?.id ?? 0) + 1,
    ...event,
    final: event.final ?? true,
  }];
}
