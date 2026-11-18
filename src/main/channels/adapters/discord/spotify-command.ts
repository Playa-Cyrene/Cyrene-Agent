import {
  ApplicationCommandOptionType,
  escapeMarkdown,
  type ChatInputCommandInteraction,
} from "discord.js";

export const spotifyCommand = {
  name: "spotify",
  description: "控制已授權的 Spotify Connect 播放裝置",
  options: [
    {
      name: "action",
      description: "要執行的操作",
      type: ApplicationCommandOptionType.String as const,
      required: true,
      choices: [
        { name: "查看狀態", value: "status" },
        { name: "播放歌曲", value: "play" },
        { name: "暫停", value: "pause" },
        { name: "繼續播放", value: "resume" },
        { name: "上一首", value: "previous" },
        { name: "下一首", value: "next" },
        { name: "收藏目前的歌曲", value: "save" },
      ],
    },
    {
      name: "track",
      description: "播放指定歌曲時填寫 Spotify 連結或 URI",
      type: ApplicationCommandOptionType.String as const,
      maxLength: 240,
    },
  ],
};

interface SpotifyCredentials {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
}

interface PlaybackState {
  is_playing: boolean;
  item?: { name?: string; uri?: string } | null;
}

class SpotifyError extends Error {
  constructor(readonly status: number) {
    super(`Spotify HTTP ${status}`);
  }
}

function trackUri(input: string): string | undefined {
  const value = input.trim();
  const id = /^spotify:track:([a-z0-9]{22})$/i.exec(value)?.[1]
    ?? /^https:\/\/open\.spotify\.com\/(?:intl-[a-z]{2}\/)?track\/([a-z0-9]{22})(?:[?#][^\s]*)?$/i.exec(value)?.[1];
  return id ? `spotify:track:${id}` : undefined;
}

export class DiscordSpotifyPlayer {
  private token: { value: string; expiresAt: number } | undefined;
  private pendingToken: Promise<string> | undefined;

  constructor(private readonly credentials: SpotifyCredentials) {}

  static fromEnvironment(): DiscordSpotifyPlayer | undefined {
    const clientId = process.env.CYRENE_SPOTIFY_CLIENT_ID?.trim();
    const clientSecret = process.env.CYRENE_SPOTIFY_CLIENT_SECRET?.trim();
    const refreshToken = process.env.CYRENE_SPOTIFY_REFRESH_TOKEN?.trim();
    if (clientId && clientSecret && refreshToken) {
      return new DiscordSpotifyPlayer({ clientId, clientSecret, refreshToken });
    }
  }

  async handleCommand(command: ChatInputCommandInteraction): Promise<void> {
    let content: string;
    try {
      content = await this.execute(command.options.getString("action", true), command.options.getString("track"));
    } catch (error) {
      const status = error instanceof SpotifyError ? error.status : undefined;
      content = status === 403 || status === 401
        ? "Spotify 授權不足，請檢查帳號權限與授權範圍。"
        : status === 404
          ? "找不到可用的 Spotify 播放裝置。請先開啟 Spotify。"
          : status === 429
            ? "Spotify 請求過多，請稍後重試。"
            : "Spotify 暫時無法使用，請稍後重試。";
    }
    await command.editReply({ content, allowedMentions: { parse: [] } });
  }

  private async execute(action: string, input: string | null): Promise<string> {
    if (input && action !== "play") return "只有播放指定歌曲時需要填寫歌曲連結。";

    switch (action) {
      case "play": {
        const uri = trackUri(input ?? "");
        if (!uri) return "請輸入有效的 Spotify 歌曲連結或 URI。";
        await this.request("/me/player/play", { method: "PUT", body: JSON.stringify({ uris: [uri] }) });
        return "已送出播放請求。";
      }
      case "resume":
        await this.request("/me/player/play", { method: "PUT" });
        return "已送出繼續播放請求。";
      case "pause":
        await this.request("/me/player/pause", { method: "PUT" });
        return "已送出暫停請求。";
      case "next":
      case "previous":
        await this.request(`/me/player/${action}`, { method: "POST" });
        return action === "next" ? "已送出下一首請求。" : "已送出上一首請求。";
      case "status":
      case "save": {
        const response = await this.request("/me/player");
        if (response.status === 204) return "目前沒有 Spotify 播放階段。";
        const state = await response.json() as PlaybackState;
        if (action === "status") {
          const title = state.item?.name ? `：${escapeMarkdown(state.item.name.slice(0, 160))}` : "";
          return `${state.is_playing ? "正在播放" : "已暫停"}${title}`;
        }
        const uri = trackUri(state.item?.uri ?? "");
        if (!uri) return "目前沒有可收藏的歌曲。";
        const query = new URLSearchParams({ uris: uri });
        await this.request(`/me/library?${query}`, { method: "PUT" });
        return "已收藏到 Spotify 音樂庫。";
      }
      default:
        return "請選擇有效的 Spotify 操作。";
    }
  }

  private async request(path: string, init: RequestInit = {}): Promise<Response> {
    const send = (token: string) => fetch(`https://api.spotify.com/v1${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${token}`,
        ...(init.body ? { "Content-Type": "application/json" } : {}),
      },
      redirect: "error",
      signal: AbortSignal.timeout(10_000),
    });
    const token = await this.getToken();
    let response = await send(token);
    if (response.status === 401) {
      if (this.token?.value === token) this.token = undefined;
      await response.body?.cancel();
      response = await send(await this.getToken());
    }
    if (!response.ok) {
      await response.body?.cancel();
      throw new SpotifyError(response.status);
    }
    return response;
  }

  private getToken(): Promise<string> {
    if (this.token && this.token.expiresAt > Date.now()) return Promise.resolve(this.token.value);
    if (!this.pendingToken) {
      this.pendingToken = this.refreshToken().finally(() => { this.pendingToken = undefined; });
    }
    return this.pendingToken;
  }

  private async refreshToken(): Promise<string> {
    const { clientId, clientSecret, refreshToken } = this.credentials;
    const response = await fetch("https://accounts.spotify.com/api/token", {
      method: "POST",
      headers: {
        Authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString("base64")}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: refreshToken }),
      redirect: "error",
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw new SpotifyError(response.status);
    }
    const data = await response.json() as { access_token?: string; expires_in?: number; refresh_token?: string };
    if (!data.access_token || typeof data.expires_in !== "number") throw new SpotifyError(401);
    this.token = { value: data.access_token, expiresAt: Date.now() + Math.max(0, data.expires_in - 30) * 1000 };
    if (data.refresh_token) this.credentials.refreshToken = data.refresh_token;
    return data.access_token;
  }
}
