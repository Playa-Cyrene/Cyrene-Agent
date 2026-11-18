// dispatcher 核心单元测试：sessionId hash + 限速
import { readFileSync, rmSync } from "node:fs";
import { app } from "electron";
import { afterAll, describe, it, expect, vi } from "vitest";
import { recordDiscordMessageAccess } from "./adapters/discord/access";
import { ChannelDispatcher, makeSessionId, lookupOriginalSender } from "./dispatcher";
import { loadRecentHistory } from "./history-log";
import { ChannelManager } from "./manager";
import { sendProactiveChannelMessage } from "./proactive-delivery";
import { saveChannelsSettings } from "./settings-store";
import type { IncomingMessage } from "./types";

vi.mock("electron", async () => {
  const { mkdtempSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const userData = mkdtempSync(join(tmpdir(), "cyrene-discord-dispatcher-"));
  return { app: { getPath: () => userData } };
});

afterAll(() => rmSync(app.getPath("userData"), { recursive: true, force: true }));

describe("channels/dispatcher", () => {
  it("makeSessionId: 同 channel + 同 sender → 同 sessionId", () => {
    const a = makeSessionId("feishu", "ou_abc123");
    const b = makeSessionId("feishu", "ou_abc123");
    expect(a).toBe(b);
  });

  it("makeSessionId: 跨 channel 不同 sessionId", () => {
    const f = makeSessionId("feishu", "user-x");
    const w = makeSessionId("wechat", "user-x");
    expect(f).not.toBe(w);
  });

  it("makeSessionId: 长度 16 字符 hash + 前缀", () => {
    const s = makeSessionId("feishu", "ou_abc");
    // 格式: channel:<channel>:<16 hex>
    expect(s).toMatch(/^channel:feishu:[0-9a-f]{16}$/);
  });

  it("makeSessionId: 不同 sender → 不同 sessionId", () => {
    const a = makeSessionId("feishu", "ou_aaa");
    const b = makeSessionId("feishu", "ou_bbb");
    expect(a).not.toBe(b);
  });

  it("makeSessionId: discord work/chat 歷史分開", () => {
    const w = makeSessionId("discord", "user-1", "work");
    const w2 = makeSessionId("discord", "user-1", "work");
    const c = makeSessionId("discord", "user-1", "chat");
    expect(w).toBe(w2);
    expect(w).not.toBe(c);
    expect(c).toMatch(/^channel:discord:chat:[0-9a-f]{16}$/);
    expect(w).toMatch(/^channel:discord:work:[0-9a-f]{16}$/);
  });

  it("lookupOriginalSender: 未知 sessionId 返回 null", () => {
    expect(lookupOriginalSender("channel:feishu:0000000000000000")).toBeNull();
  });

  it("keeps a sender's Discord DMs and different guild channels in distinct histories", () => {
    const make = (id?: string) => makeSessionId("discord", "user", "chat", id);
    expect(new Set([make(), make("user"), make("guild-1"), make("guild-2")]).size).toBe(4);
    expect(make("guild-1")).toBe(make("guild-1"));
  });
});

describe("Discord dispatcher", () => {
  it("plays an explicit voice reply without a model call and falls back to text", async () => {
    const manager = new ChannelManager();
    manager.register({
      id: "discord",
      displayName: "Discord",
      capability: { text: true, audio: true, image: true, file: true, video: true, markdown: true, card: true, sticker: false, maxTextLength: 2000 },
      start: async () => {},
      stop: async () => {},
      onMessage: null,
      send: async () => ({ ok: true }),
      getStatus: () => ({ enabled: true, phase: "running" }),
    });
    const audio = Buffer.from("mock audio");
    const synthesizeTts = vi.fn().mockResolvedValueOnce(audio).mockResolvedValueOnce(null);
    const buildAndRunAgent = vi.fn();
    const dispatcher = new ChannelDispatcher({ manager, synthesizeTts, buildAndRunAgent });
    const incoming: IncomingMessage = {
      channel: "discord", senderId: "voice-user", chatId: "voice-user", at: new Date(), text: "voice: おはよう", voiceReplyText: "おはよう",
    };
    recordDiscordMessageAccess(incoming, true, "chat");

    const voiced = await dispatcher.handleIncoming(incoming);
    const audioPart = voiced?.parts.find((part) => part.kind === "audio");
    expect(audioPart && readFileSync(audioPart.filePath)).toEqual(audio);
    expect(voiced?.parts[0]).toEqual({ kind: "text", text: "おはよう" });
    expect(await dispatcher.handleIncoming(incoming)).toMatchObject({ parts: [{ kind: "text", text: "おはよう" }] });

    saveChannelsSettings({ ttsEnabled: false });
    dispatcher.reloadSettings();
    expect(await dispatcher.handleIncoming(incoming)).toMatchObject({ parts: [{ kind: "text", text: "おはよう" }] });
    expect(synthesizeTts).toHaveBeenCalledTimes(2);
    expect(synthesizeTts).toHaveBeenCalledWith("おはよう", { channel: "discord" });
    expect(buildAndRunAgent).not.toHaveBeenCalled();
  });

  it("sends scoped prior turns without the current message or raw provider errors", async () => {
    const manager = new ChannelManager();
    const run = vi.fn().mockResolvedValueOnce({ text: "Private reply", sticker: null })
      .mockRejectedValueOnce(Object.assign(new Error("private provider detail"), { code: "private-provider-code" }))
      .mockResolvedValueOnce({ text: "Public reply", sticker: null });
    const dispatcher = new ChannelDispatcher({
      manager,
      buildAndRunAgent: run,
      loadRecentChannelHistory: async (sessionId, limit) => loadRecentHistory(sessionId, limit),
    });
    const dm: IncomingMessage = {
      channel: "discord", senderId: "history-user", chatId: "history-user", at: new Date(), text: "Private question",
    };
    const publicMessage = { ...dm, chatId: "guild-channel", text: "Public question" };
    recordDiscordMessageAccess(dm, true, "chat");
    recordDiscordMessageAccess(publicMessage, true, "chat");
    await dispatcher.handleIncoming(dm);
    const failure = await dispatcher.handleIncoming(dm);
    await dispatcher.handleIncoming(publicMessage);
    const priorTurns = run.mock.calls.map(([, , prior]) => prior.map(({ content }: { content: string }) => content));
    expect(priorTurns).toEqual([[], ["Private question", "Private reply"], []]);
    expect(failure?.parts).toEqual([{ kind: "text", text: "我處理你的訊息時出了點問題，請稍後重試。" }]);
  });

  it("keeps proactive replies in the verified Discord owner's DM", async () => {
    const manager = new ChannelManager();
    const send = vi.fn(async () => ({ ok: true }));
    manager.register({
      id: "discord", displayName: "Discord",
      capability: { text: true, audio: false, image: false, file: false, video: false, markdown: false, card: false, sticker: false, maxTextLength: 2000 },
      start: async () => {}, stop: async () => {}, onMessage: null, send,
      getStatus: () => ({ enabled: true, phase: "running" }),
    });
    const dispatcher = new ChannelDispatcher({ manager });
    const ownerDm: IncomingMessage = {
      channel: "discord", senderId: "proactive-owner", chatId: "proactive-owner", at: new Date(), text: "Hi",
    };
    const guildMessage = { ...ownerDm, chatId: "guild" };
    const guestDm = { ...ownerDm, senderId: "guest", chatId: "guest" };
    recordDiscordMessageAccess(ownerDm, true, "chat");
    recordDiscordMessageAccess(guildMessage, true, "chat");
    recordDiscordMessageAccess(guestDm, false, "chat");

    for (const message of [ownerDm, guildMessage, guestDm, { ...ownerDm, chatId: "unverified" }]) {
      await dispatcher.handleIncoming(message);
    }
    await expect(sendProactiveChannelMessage({ channel: "discord", text: "Reminder", manager, mobileMessageSegmentation: "off" }))
      .resolves.toMatchObject({ kind: "committed" });
    expect(send).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ targetId: "proactive-owner" }));
  });
});
