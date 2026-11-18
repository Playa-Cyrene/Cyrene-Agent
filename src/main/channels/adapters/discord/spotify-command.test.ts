import type { ChatInputCommandInteraction } from "discord.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DiscordSpotifyPlayer } from "./spotify-command";

const trackId = "7a3LWj5xSFhFRYmztS8wgK";

function command(action: string, track?: string) {
  return {
    editReply: vi.fn().mockResolvedValue(undefined),
    options: { getString: (key: string) => key === "action" ? action : track ?? null },
  };
}

function player() {
  return new DiscordSpotifyPlayer({ clientId: "client", clientSecret: "secret", refreshToken: "refresh" });
}

afterEach(() => vi.unstubAllGlobals());

describe("Discord Spotify Connect", () => {
  it("rejects links outside Spotify before attempting an API request", async () => {
    const interaction = command("play", `https://example.com/open.spotify.com/track/${trackId}`);
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    await player().handleCommand(interaction as unknown as ChatInputCommandInteraction);
    expect(interaction.editReply).toHaveBeenCalledWith(expect.objectContaining({ allowedMentions: { parse: [] } }));
    expect(fetch).not.toHaveBeenCalled();
  });

  it("uses fixed Spotify endpoints for playback and saving the current track", async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce(Response.json({ access_token: "access", expires_in: 3600 }))
      .mockResolvedValueOnce(new Response(null, { status: 204 }))
      .mockResolvedValueOnce(Response.json({ item: { uri: `spotify:track:${trackId}` } }))
      .mockResolvedValueOnce(new Response(null, { status: 200 }));
    vi.stubGlobal("fetch", fetch);
    const spotify = player();
    await spotify.handleCommand(command("play", `https://open.spotify.com/track/${trackId}?si=123`) as unknown as ChatInputCommandInteraction);
    await spotify.handleCommand(command("save") as unknown as ChatInputCommandInteraction);
    expect(fetch).toHaveBeenNthCalledWith(2, "https://api.spotify.com/v1/me/player/play", expect.objectContaining({
      method: "PUT",
      body: JSON.stringify({ uris: [`spotify:track:${trackId}`] }),
    }));
    expect(fetch).toHaveBeenNthCalledWith(4, `https://api.spotify.com/v1/me/library?uris=spotify%3Atrack%3A${trackId}`, expect.objectContaining({
      method: "PUT",
    }));
  });
});
