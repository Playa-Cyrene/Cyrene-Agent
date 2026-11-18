import type { ChannelsSettings } from "../../settings-store";
import type { IncomingMessage } from "../../types";

export type DiscordMode = "work" | "chat";

interface DiscordMessageAccess {
  readonly isGatewayMessage: boolean;
  readonly isOwner: boolean;
  readonly mode: DiscordMode;
}

const unverifiedAccess: DiscordMessageAccess = { isGatewayMessage: false, isOwner: false, mode: "chat" };
const messageAccess = new WeakMap<IncomingMessage, DiscordMessageAccess>();

export function getConfiguredDiscordMode(settings: Pick<ChannelsSettings, "discord" | "toolSandbox">): DiscordMode {
  return settings.discord.mode ?? (settings.toolSandbox === "all" ? "work" : "chat");
}

export function recordDiscordMessageAccess(msg: IncomingMessage, isOwner: boolean, mode: DiscordMode): void {
  if (msg.channel === "discord") {
    const canUseWork = isOwner && msg.chatId === msg.senderId;
    messageAccess.set(msg, { isGatewayMessage: true, isOwner, mode: canUseWork ? mode : "chat" });
  }
}

// Gateway access stays attached to this message instance. Payload fields cannot grant it.
export function getDiscordMessageAccess(msg: IncomingMessage): DiscordMessageAccess {
  return messageAccess.get(msg) ?? unverifiedAccess;
}

export function isDiscordOwnerDm(msg: IncomingMessage): boolean {
  return msg.chatId === msg.senderId && getDiscordMessageAccess(msg).isOwner;
}
