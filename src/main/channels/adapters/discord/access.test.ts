import { describe, expect, it } from "vitest";
import type { IncomingMessage } from "../../types";
import { getConfiguredDiscordMode, getDiscordMessageAccess, recordDiscordMessageAccess } from "./access";

const discordMessage: IncomingMessage = {
  channel: "discord",
  senderId: "100000000000000001",
  chatId: "100000000000000002",
  text: "Hello",
  at: new Date(0),
};

describe("Discord message access", () => {
  it("starts unverified senders in tool-free chat when work is configured", () => {
    const incoming = { ...discordMessage, _raw: { isGatewayMessage: true, isOwner: true, mode: "work" } };
    expect(getDiscordMessageAccess(incoming)).toEqual({ isGatewayMessage: false, isOwner: false, mode: "chat" });
    recordDiscordMessageAccess(incoming, false, "work");
    expect(getDiscordMessageAccess(incoming)).toEqual({ isGatewayMessage: true, isOwner: false, mode: "chat" });
  });

  it("keeps the verified owner's mode on this gateway message only", () => {
    const incoming = { ...discordMessage, chatId: discordMessage.senderId };
    recordDiscordMessageAccess(incoming, true, "work");
    expect(getDiscordMessageAccess(incoming)).toEqual({ isGatewayMessage: true, isOwner: true, mode: "work" });
    expect(getDiscordMessageAccess({ ...incoming })).toEqual({ isGatewayMessage: false, isOwner: false, mode: "chat" });
  });

  it("keeps guild messages in chat even when the verified owner has Work enabled", () => {
    const incoming = { ...discordMessage };
    recordDiscordMessageAccess(incoming, true, "work");
    expect(getDiscordMessageAccess(incoming)).toEqual({ isGatewayMessage: true, isOwner: true, mode: "chat" });
  });

  it("distinguishes an owner in chat mode from an unverified sender", () => {
    const incoming = { ...discordMessage };
    recordDiscordMessageAccess(incoming, true, "chat");
    expect(getDiscordMessageAccess(incoming)).toEqual({ isGatewayMessage: true, isOwner: true, mode: "chat" });
  });

  it("uses the global mode for legacy settings and the saved Discord mode when present", () => {
    expect(getConfiguredDiscordMode({ discord: { enabled: true }, toolSandbox: "all" })).toBe("work");
    expect(getConfiguredDiscordMode({ discord: { enabled: true, mode: "chat" }, toolSandbox: "all" })).toBe("chat");
  });
});
