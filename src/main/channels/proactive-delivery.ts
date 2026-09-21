import { normalizeMobileMessageSegmentationMode, type MobileMessageSegmentationMode } from "../../shared/preferences";
import { splitTextBySentenceBreaks } from "../../shared/message-segmentation";
import type { ChannelManager } from "./manager";
import {
  createChannelDeliveryService,
  type ChannelDeliveryService,
} from "./delivery-service";
import { appendHistory as appendChannelHistory } from "./history-log";
import { appendLog as appendChannelLog, type LogEntry } from "./message-log";
import type { ChannelId, IncomingMessage, OutgoingMessage } from "./types";

export type ProactiveMobileChannel = Extract<ChannelId, "wechat" | "feishu">;

// External channel delivery remains legacy until Task 11; CTA local intent
// persistence must not be presented as channel exactly-once delivery.

export interface RecentProactiveChannelRecipient {
  targetId: string;
  threadId?: string;
  sessionId: string;
  updatedAt: number;
}

export interface ProactiveChannelRecipientRegistry {
  remember(message: IncomingMessage, sessionId: string): void;
  get(channel: ProactiveMobileChannel): RecentProactiveChannelRecipient | null;
}

export function createProactiveChannelRecipientRegistry(): ProactiveChannelRecipientRegistry {
  const recipients = new Map<ProactiveMobileChannel, RecentProactiveChannelRecipient>();
  return {
    remember(message, sessionId): void {
      if (message.channel !== "wechat" && message.channel !== "feishu") return;
      const targetId = message.chatId.trim();
      if (!targetId || !sessionId) return;
      recipients.set(message.channel, {
        targetId,
        ...(message.threadId ? { threadId: message.threadId } : {}),
        sessionId,
        updatedAt: message.at.getTime(),
      });
    },
    get(channel): RecentProactiveChannelRecipient | null {
      return recipients.get(channel) ?? null;
    },
  };
}

const defaultRecipientRegistry = createProactiveChannelRecipientRegistry();

export function rememberProactiveChannelRecipient(message: IncomingMessage, sessionId: string): void {
  defaultRecipientRegistry.remember(message, sessionId);
}

export function canStartProactiveChannelDelivery(
  channel: ProactiveMobileChannel,
  manager: Pick<ChannelManager, "getAdapter">,
  recipientRegistry: ProactiveChannelRecipientRegistry = defaultRecipientRegistry,
): boolean {
  const adapter = manager.getAdapter(channel);
  return adapter?.getStatus().phase === "running" && recipientRegistry.get(channel) !== null;
}

export type ProactiveChannelDeliveryResult =
  | { kind: "committed"; deliveredParts: number; totalParts: number }
  | { kind: "cancelled"; reason: string };

interface ProactiveChannelDeliveryInput {
  channel: ProactiveMobileChannel;
  text: string;
  mobileMessageSegmentation: MobileMessageSegmentationMode;
  manager: Pick<ChannelManager, "getAdapter">;
  delivery?: ChannelDeliveryService;
  recipientRegistry?: ProactiveChannelRecipientRegistry;
  appendHistory?: typeof appendChannelHistory;
  appendLog?: (entry: Omit<LogEntry, "at">) => void;
  canContinue?: () => boolean;
}

export async function sendProactiveChannelMessage(
  input: ProactiveChannelDeliveryInput,
): Promise<ProactiveChannelDeliveryResult> {
  const adapter = input.manager.getAdapter(input.channel);
  if (!adapter || adapter.getStatus().phase !== "running") {
    return { kind: "cancelled", reason: "channel_offline" };
  }

  const recipient = (input.recipientRegistry ?? defaultRecipientRegistry).get(input.channel);
  if (!recipient) return { kind: "cancelled", reason: "recipient_unavailable" };
  const delivery = input.delivery ?? createChannelDeliveryService(input.manager);

  const mode = normalizeMobileMessageSegmentationMode(input.mobileMessageSegmentation);
  const texts = mode === "on" ? splitTextBySentenceBreaks(input.text) : [input.text.trim()].filter(Boolean);
  if (texts.length === 0) return { kind: "cancelled", reason: "empty_text" };

  const deliveredTexts: string[] = [];
  for (const text of texts) {
    if (input.canContinue && !input.canContinue()) break;
    if (adapter.getStatus().phase !== "running") break;
    const message: OutgoingMessage = {
      channel: input.channel,
      targetId: recipient.targetId,
      ...(recipient.threadId ? { threadId: recipient.threadId } : {}),
      parts: [{ kind: "text", text }],
    };
    const result = await delivery.send(message);
    if (!result.ok) break;
    deliveredTexts.push(text);
  }

  if (deliveredTexts.length === 0) return { kind: "cancelled", reason: "send_failed" };

  const deliveredText = deliveredTexts.join("");
  (input.appendHistory ?? appendChannelHistory)(recipient.sessionId, "assistant", deliveredText);
  (input.appendLog ?? appendChannelLog)({
    dir: "outgoing",
    channel: input.channel,
    senderId: recipient.targetId,
    chatId: recipient.targetId,
    text: deliveredText,
    hasAttachments: false,
  });

  return {
    kind: "committed",
    deliveredParts: deliveredTexts.length,
    totalParts: texts.length,
  };
}
