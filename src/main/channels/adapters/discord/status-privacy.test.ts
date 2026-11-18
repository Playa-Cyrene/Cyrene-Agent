import { MessageFlags } from "discord.js";
import { describe, expect, it, vi } from "vitest";
import { DiscordAdapter } from "./index";

vi.mock("../../settings-store", () => ({
  loadChannelsSettings: () => ({ discord: { enabled: true, mode: "work" }, toolSandbox: "all" }),
}));
vi.mock("./discord-session", () => ({
  currentDiscordMode: () => "work",
  getDiscordSessionWorkspace: () => ({ workspaceRoot: "/path-to-private-workspace" }),
  getLastDiscordErrorAt: () => new Date("2026-01-01T00:00:00Z"),
}));
vi.mock("../../../settings/model-settings", () => ({
  loadModelSettings: () => ({
    provider: "provider-name",
    model: "model-name",
    apiKey: "private-api-key",
    baseUrl: "https://private-api.invalid",
  }),
  getDefaultModelProfile: () => undefined,
}));
vi.mock("../../../permission", () => ({
  getCurrentLevel: () => "full",
  ACCESS_LEVEL_LABEL: { full: "完整權限" },
}));

const ownerId = "100000000000000010";
const teamId = "100000000000000011";

async function requestStatus(userId: string, owner: { id: string; ownerId?: string } | null) {
  const client = { application: { fetch: vi.fn().mockResolvedValue({ owner }) } };
  const adapter = new DiscordAdapter() as unknown as {
    client: typeof client;
    handleInteraction(cmd: unknown): Promise<void>;
  };
  adapter.client = client;
  const cmd = {
    client,
    user: { id: userId },
    commandName: "status",
    isChatInputCommand: () => true,
    deferReply: vi.fn().mockResolvedValue(undefined),
    editReply: vi.fn().mockResolvedValue(undefined),
  };
  await adapter.handleInteraction(cmd);
  return cmd;
}

describe("Discord /status privacy", () => {
  it("shows a private, sanitized status to the application owner", async () => {
    const { deferReply, editReply } = await requestStatus(ownerId, { id: ownerId });
    expect(deferReply).toHaveBeenCalledWith({ flags: MessageFlags.Ephemeral });
    expect(editReply).toHaveBeenCalledWith({
      allowedMentions: { parse: [] },
      content: expect.stringContaining("model-name"),
    });
    const { content } = editReply.mock.calls[0][0];
    expect(content).not.toContain("private-api-key");
    expect(content).not.toContain("private-api.invalid");
    expect(content).not.toContain("path-to-private-workspace");
  });

  it("uses the team's owner's account for a team-owned application", async () => {
    const { editReply } = await requestStatus(ownerId, { id: teamId, ownerId });
    expect(editReply).toHaveBeenCalledWith(expect.objectContaining({ content: expect.stringContaining("model-name") }));
  });

  it("returns a private denial when the user is unverified", async () => {
    for (const applicationOwner of [{ id: ownerId }, null]) {
      const { deferReply, editReply } = await requestStatus(teamId, applicationOwner);
      expect(deferReply).toHaveBeenCalledWith({ flags: MessageFlags.Ephemeral });
      expect(editReply).toHaveBeenCalledWith("只有 Discord 應用程式擁有者可以使用此指令。");
    }
  });
});
