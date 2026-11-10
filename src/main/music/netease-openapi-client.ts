// Netease Cloud Music OpenAPI client (M0-verified protocol).
//
// Protocol reference: docs/music-openapi-endpoints.md + tmp-m0-poc/manifest-full.json.
// Every method hardcodes the manifest default params (incl. hidden ones like
// `trialScene`) — the server rejects requests missing hidden defaults (400 empty body).
import { createSign } from "node:crypto";

const DEFAULT_BASE_URL = "https://openapi.music.163.com";
const USER_AGENT = "ncm-0.1.6";
const REFERER = "https://music.163.com/";

// ---------------------------------------------------------------------------
// Options / errors
// ---------------------------------------------------------------------------

export interface OpenApiClientOptions {
  appId: string;
  /** Platform-assigned RSA private key: raw base64 or already-wrapped PKCS#8 PEM. */
  privateKey: string;
  /** HTTPS endpoint without embedded credentials, query parameters or a fragment. */
  baseUrl?: string;
  /** Stable per-install device id (survives restarts; QR login binds to it). */
  deviceId?: string;
  fetchImpl?: typeof fetch;
  now?: () => number;
}

export class NeteaseOpenapiError extends Error {
  constructor(
    public readonly code: number,
    public readonly path: string,
    message: string,
    public readonly raw?: unknown,
  ) {
    super(`E_OPENAPI_${code} ${path}: ${message}`);
    this.name = "NeteaseOpenapiError";
  }
}

// ---------------------------------------------------------------------------
// Response payloads (raw OpenAPI shapes, consumed by the result normalizer)
// ---------------------------------------------------------------------------

export interface OpenapiTokenBundle {
  accessToken: string;
  refreshToken: string;
  /** Validity in SECONDS (server returns 86400 = 24h). */
  expireTime: number;
}

export type QrLoginStatus =
  | { status: 800; msg?: string } // expired
  | { status: 801 } // waiting for scan
  | { status: 802; msg?: string } // scanned, waiting for confirm
  | { status: 803; accessToken: OpenapiTokenBundle };

export interface OpenapiArtist {
  originalId?: number;
  id?: string;
  name: string;
  coverImgUrl?: string;
}

export interface OpenapiSongRecord {
  /** Numeric original id — for user-visible links only. */
  originalId: number;
  /** 32-hex encrypted id — REQUIRED for API calls (detail/like/playlist ops). */
  id: string;
  name: string;
  /** Milliseconds. */
  duration?: number;
  jumpUrl?: string;
  artists?: OpenapiArtist[];
  fullArtists?: OpenapiArtist[];
  albumName?: string;
  coverImgUrl?: string;
  /** Official SKILL.md: invisible songs are unplayable and must be filtered. */
  visible?: boolean;
  [k: string]: unknown;
}

export interface OpenapiSongDetail {
  id?: string;
  originalId?: number;
  name: string;
  artistName?: string;
  albumName?: string;
  /** Direct audio URL — mpv-ready (M0: HEAD 200 audio/mpeg). Empty when restricted. */
  playUrl?: string;
  coverImgUrl?: string;
  duration?: number;
  br?: number;
  level?: string;
  freeTrialPrivilege?: unknown;
  [k: string]: unknown;
}

export interface OpenapiLyric {
  songId?: string;
  /** LRC with timestamps (may be empty for some songs). */
  lyric?: string;
  /** Plain-text lyric, no timestamps. */
  txtLyric?: string;
  transLyric?: string;
  romalrc?: string;
  noLyric?: boolean;
  pureMusic?: boolean;
  [k: string]: unknown;
}

export interface OpenapiPlaylistRecord {
  originalId?: number;
  /** 32-hex encrypted playlist id. */
  id?: string;
  name: string;
  trackCount?: number;
  coverImgUrl?: string;
  describe?: string;
  creatorNickName?: string;
  playCount?: number;
  jumpUrl?: string;
  [k: string]: unknown;
}

export interface OpenapiUserProfile {
  userId?: number;
  nickname?: string;
  avatarUrl?: string;
  [k: string]: unknown;
}

interface OpenapiEnvelope<T> {
  code: number;
  message?: string;
  msg?: string;
  data?: T;
}

// ---------------------------------------------------------------------------
// Signing helpers (exported for unit tests)
// ---------------------------------------------------------------------------

/** Builds the canonical `k=v&...` string: drop sign/null/undefined/empty, sort by key, join. */
export function buildSignString(params: Record<string, unknown>): string {
  return Object.entries(params)
    .filter(([k, v]) => k !== "sign" && v !== null && v !== undefined && v !== "")
    .map(([k, v]) => [k, String(v)] as [string, string])
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`)
    .join("&");
}

/** Wraps a bare base64 private key into a PKCS#8 PEM (accepts pre-wrapped PEM too). */
export function wrapPkcs8Pem(privateKey: string): string {
  const s = privateKey.trim();
  if (s.includes("BEGIN PRIVATE KEY")) return s;
  const body = (s.match(/.{1,64}/g) ?? []).join("\n");
  return `-----BEGIN PRIVATE KEY-----\n${body}\n-----END PRIVATE KEY-----`;
}

function normalizeBaseUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("E_OPENAPI_BASE_URL_INVALID: credential-free HTTPS endpoint required");
  }
  // 不在错误信息中回显配置 URL，它可能包含凭据或令牌。
  if (url.protocol !== "https:" || url.username || url.password || url.href.includes("?") || url.href.includes("#")) {
    throw new Error("E_OPENAPI_BASE_URL_INVALID: credential-free HTTPS endpoint required");
  }
  return url.href.replace(/\/+$/, "");
}

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

export class NeteaseOpenapiClient {
  private appId: string;
  private privateKeyPem: string;
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  private readonly deviceJson: string;
  private accessToken: string | null = null;

  constructor(opts: OpenApiClientOptions) {
    this.appId = opts.appId;
    this.privateKeyPem = opts.privateKey ? wrapPkcs8Pem(opts.privateKey) : "";
    this.baseUrl = normalizeBaseUrl(opts.baseUrl ?? DEFAULT_BASE_URL);
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.now = opts.now ?? Date.now;
    this.deviceJson = JSON.stringify({
      deviceType: "openapi",
      os: "ncmcli",
      appVer: "0.1.6",
      channel: "ncmcli",
      model: "Windows_x64_cli",
      brand: "ncmcli",
      osVer: "10.0.19045",
      clientIp: "127.0.0.1",
      deviceId: opts.deviceId ?? "cyrene-default-device",
    });
  }

  /**
   * Inject real credentials into a placeholder client (created with empty
   * appId/privateKey by MusicService's constructor before config is loaded).
   * Replaces the previous direct-private-field mutation hack.
   */
  configure(opts: { appId: string; privateKey: string }): void {
    if (!opts.appId) throw new Error("E_CONFIG_MISSING appId");
    if (!opts.privateKey) throw new Error("E_CONFIG_MISSING privateKey");
    this.appId = opts.appId;
    this.privateKeyPem = wrapPkcs8Pem(opts.privateKey);
  }

  /** Throws E_CONFIG_MISSING if the client has not yet been configured. */
  private requireConfigured(): void {
    if (!this.appId || !this.privateKeyPem) {
      throw new Error("E_CONFIG_MISSING appId/privateKey");
    }
  }

  /** Inject the token from TokenVault (null = anonymous). */
  setAccessToken(token: string | null): void {
    this.accessToken = token;
  }

  get hasAccessToken(): boolean {
    return this.accessToken !== null;
  }

  // -- transport ------------------------------------------------------------

  private signParams(params: Record<string, unknown>): string {
    const signer = createSign("SHA256");
    signer.update(buildSignString(params));
    signer.end();
    return signer.sign(this.privateKeyPem, "base64");
  }

  private buildParams(biz: Record<string, unknown>, anonymous = false): Record<string, string> {
    const params: Record<string, unknown> = {
      appId: this.appId,
      signType: "RSA_SHA256",
      timestamp: String(this.now()),
      device: this.deviceJson,
      bizContent: JSON.stringify(biz),
    };
    // 匿名请求不携带任何旧 token——登录入口必须干净，残留的失效 token
    // 会让服务器拒绝匿名登录（301），导致二维码永远出不来（登录死锁）。
    if (!anonymous && this.accessToken) params.accessToken = this.accessToken;
    return { ...params, sign: this.signParams(params) } as Record<string, string>;
  }

  private async request<T>(
    method: "GET" | "POST",
    path: string,
    biz: Record<string, unknown>,
    opts: { anonymous?: boolean } = {},
  ): Promise<T> {
    this.requireConfigured();
    const params = this.buildParams(biz, opts.anonymous);
    let res: Response;
    try {
      if (method === "GET") {
        const url = `${this.baseUrl}${path}?${new URLSearchParams(params).toString()}`;
        res = await this.fetchImpl(url, {
          headers: { "User-Agent": USER_AGENT, Referer: REFERER },
          // URL 携带签名和登录令牌，禁止自动转发到其他来源或降级到 HTTP。
          redirect: "error",
        });
      } else {
        res = await this.fetchImpl(`${this.baseUrl}${path}`, {
          method: "POST",
          redirect: "error",
          headers: {
            "Content-Type": "application/json",
            "User-Agent": USER_AGENT,
            Referer: REFERER,
          },
          body: JSON.stringify(params),
        });
      }
    } catch (e: unknown) {
      throw new NeteaseOpenapiError(-1, path, `network error: ${(e as Error).message}`);
    }
    // 注入的 transport 也可能直接返回 3xx，不能把重定向响应当业务成功。
    if (res.status >= 300 && res.status < 400) {
      throw new NeteaseOpenapiError(res.status, path, "redirects are not allowed");
    }
    const text = await res.text();
    let json: OpenapiEnvelope<T> & { _http?: number };
    try {
      json = JSON.parse(text) as OpenapiEnvelope<T>;
    } catch {
      throw new NeteaseOpenapiError(res.status, path, `non-JSON body: ${text.slice(0, 120)}`);
    }
    if (json.code !== 200) {
      throw new NeteaseOpenapiError(json.code, path, json.message ?? json.msg ?? "unknown", json);
    }
    return json.data as T;
  }

  // -- auth -----------------------------------------------------------------

  /** Anonymous login: 24h token, business endpoints all return 301 with it. QR flow only.
   *  Never carries an accessToken — a stale user token would be rejected (301). */
  async loginAnonymous(): Promise<OpenapiTokenBundle> {
    return this.request<OpenapiTokenBundle>(
      "POST",
      "/openapi/music/basic/oauth2/login/anonymous",
      { clientId: this.appId },
      { anonymous: true },
    );
  }

  async getQrCodeKey(): Promise<{ qrCodeUrl: string; uniKey: string }> {
    return this.request<{ qrCodeUrl: string; uniKey: string }>(
      "GET",
      "/openapi/music/basic/user/oauth2/qrcodekey/get/v2",
      // expiredKey must be the STRING "300" (300s validity), not a number.
      { type: 2, expiredKey: "300" },
    );
  }

  /** Poll every 3s while status is 801/802. 803 carries the user token bundle. */
  async checkQrLoginStatus(uniKey: string): Promise<QrLoginStatus> {
    return this.request<QrLoginStatus>(
      "GET",
      "/openapi/music/basic/oauth2/device/login/qrcode/get",
      { key: uniKey, clientId: this.appId },
    );
  }

  /** Source-verified, not live-tested in M0 (no expired token available then). */
  async refreshAccessToken(refreshToken: string): Promise<OpenapiTokenBundle> {
    return this.request<OpenapiTokenBundle>(
      "GET",
      "/openapi/music/basic/user/oauth2/token/refresh/v2",
      { clientId: this.appId, refreshToken },
    );
  }

  // -- songs ----------------------------------------------------------------

  async searchSongs(
    keyword: string,
    limit = 30,
    offset = 0,
  ): Promise<{ recordCount: number; records: OpenapiSongRecord[] }> {
    return this.request("GET", "/openapi/music/basic/search/song/get/v3", {
      keyword,
      limit,
      offset,
      qualityFlag: false, // hidden default (manifest)
      trialScene: "cli", // hidden default — omitting it => 400 empty body
    });
  }

  /**
   * Song detail + playback URL. `songId` MUST be the 32-hex encrypted id
   * (numeric original id => 参数错误).
   */
  async getSongDetail(
    songId: string,
    opts: { withUrl?: boolean; bitrate?: number } = {},
  ): Promise<OpenapiSongDetail> {
    return this.request<OpenapiSongDetail>("GET", "/openapi/music/basic/song/detail/get/v2", {
      songId,
      withUrl: opts.withUrl ?? true,
      bitrate: opts.bitrate ?? 128,
      trialScene: "cli",
    });
  }

  async getLyric(songId: string): Promise<OpenapiLyric> {
    return this.request<OpenapiLyric>("GET", "/openapi/music/basic/song/lyric/get/v2", {
      songId,
    });
  }

  // -- recommendations --------------------------------------------------------

  /** Daily recommendations: `data` is the bare records array (no wrapper). */
  async getDailyRecommendations(limit = 30): Promise<OpenapiSongRecord[]> {
    return this.request<OpenapiSongRecord[]>("GET", "/openapi/music/basic/recommend/songlist/get/v2", {
      limit,
      qualityFlag: false, // hidden default (manifest)
      trialScene: "cli", // hidden default (manifest)
    });
  }

  // -- playlists -------------------------------------------------------------

  async getCreatedPlaylists(
    limit = 20,
    offset = 0,
  ): Promise<{ recordCount?: number; records: OpenapiPlaylistRecord[] }> {
    return this.request("GET", "/openapi/music/basic/playlist/created/get/v2", { limit, offset });
  }

  async getSubscribedPlaylists(
    limit = 20,
    offset = 0,
  ): Promise<{ recordCount?: number; records: OpenapiPlaylistRecord[] }> {
    return this.request("GET", "/openapi/music/basic/playlist/subed/get/v2", { limit, offset });
  }

  /** 红心歌单 (liked-music playlist). data is a single playlist record. */
  async getStarPlaylist(): Promise<OpenapiPlaylistRecord> {
    return this.request<OpenapiPlaylistRecord>("GET", "/openapi/music/basic/playlist/star/get/v2", {});
  }

  async getPlaylistDetail(playlistId: string): Promise<OpenapiPlaylistRecord> {
    return this.request<OpenapiPlaylistRecord>("GET", "/openapi/music/basic/playlist/detail/get/v2", {
      playlistId,
      originalCoverFlag: false, // hidden default (manifest)
    });
  }

  /** Playlist tracks: `data` is the bare song array. NOTE trialScene is "tui" here, not "cli". */
  async getPlaylistSongs(
    playlistId: string,
    limit = 30,
    offset = 0,
  ): Promise<OpenapiSongRecord[]> {
    return this.request<OpenapiSongRecord[]>("GET", "/openapi/music/basic/playlist/song/list/get/v3", {
      playlistId,
      limit,
      offset,
      qualityFlag: false, // hidden default (manifest)
      trialScene: "tui", // hidden default (manifest) — v3 of playlist songs uses "tui"
    });
  }

  async createPlaylist(playlistName: string): Promise<OpenapiPlaylistRecord> {
    return this.request<OpenapiPlaylistRecord>("GET", "/openapi/music/basic/playlist/create", {
      playlistName,
    });
  }

  async addSongsToPlaylist(playlistId: string, songIdList: string[]): Promise<unknown> {
    return this.request<unknown>("POST", "/openapi/music/basic/playlist/song/batch/like", {
      playlistId,
      songIdList,
    });
  }

  async removeSongsFromPlaylist(playlistId: string, songIdList: string[]): Promise<unknown> {
    return this.request<unknown>("POST", "/openapi/music/basic/playlist/song/batch/delete", {
      playlistId,
      songIdList,
    });
  }

  // -- likes (红心) ------------------------------------------------------------

  /** Red-heart like/unlike. Server fixed_param `isLike` rides along in bizContent. */
  async setSongLike(songId: string, isLike: boolean): Promise<unknown> {
    return this.request<unknown>("POST", "/openapi/music/basic/playlist/song/like/v2", {
      songId,
      isLike,
    });
  }

  // -- user ------------------------------------------------------------------

  async getUserProfile(): Promise<OpenapiUserProfile> {
    return this.request<OpenapiUserProfile>("GET", "/openapi/music/basic/user/profile/get/v2", {});
  }

  /** Subscribed albums. limit/offset are REQUIRED here (manifest), no hidden defaults. */
  async getSubscribedAlbums(limit = 20, offset = 0): Promise<unknown> {
    return this.request<unknown>("GET", "/openapi/music/basic/album/subed/get/v2", {
      limit,
      offset,
    });
  }
}
