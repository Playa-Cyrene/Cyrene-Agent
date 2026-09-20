// MusicService — M3+M4 rewrite: OpenAPI provider, no Python lifecycle, no CITA.
//
// Replaces MusicMcpClient/ProtocolDetector/CookieVault/LoginOrchestrator with
// NeteaseOpenapiClient/TokenVault/OpenapiLoginOrchestrator.  SelectionSetCache
// is retained as a TTL session cache for daily/search result reuse (no longer
// used for CITA candidate gating — that was removed in M4).
import * as crypto from "node:crypto";
import * as path from "node:path";
import { NeteaseOpenapiClient } from "./netease-openapi-client";
import { TokenVault } from "./token-vault";
import { OpenapiLoginOrchestrator } from "./openapi-login-orchestrator";
import { NeteaseOpenapiProvider } from "./netease-openapi-provider";
import { OpenapiConfigStore } from "./openapi-config";
import { SelectionSetCache } from "./selection-set-cache";
import { MpvController } from "./mpv-controller";
import { CacheDownloader } from "./cache-downloader";
import { scanAudioFiles } from "./local-music-scanner";
import {
  PlaybackSession,
  type MusicPlaybackSessionSnapshot,
  type PlaybackSessionInput,
} from "./playback-session";
import type { PlaybackDispatcher } from "./netease-openapi-provider";
import { MusicInputError } from "./types";
import { assertEncryptedId } from "./openapi-result-normalizer";
import type { MusicPaths } from "./paths";
import type {
  MusicSelectionSet,
  PlaybackDispatchResult,
  MusicBackendState,
  MusicAccountState,
  MusicPlayerState,
  LoginFlowState,
  MusicProfile,
  MusicShutdownReport,
  MusicPlaylist,
  MusicPlaylistDetail,
  MusicSubscription,
  MusicTrack,
} from "./types";
import type { MusicStatusSnapshot } from "../../shared/music-view-state";
import type { PlaybackState } from "../../shared/music-types";

const SET_TTL_MS = 30 * 60_000;

type StateListener<T> = (state: T) => void;

export class MusicService {
  private backendState: MusicBackendState = "stopped";
  private playerState: MusicPlayerState = "unknown";
  // playerState 为 "unavailable" 时的细分错误码（E_MPV_NOT_FOUND 等），
  // 透传给前端做针对性提示（引导用户装 mpv / 跑 prepare:mpv）
  private playerErrorCode: string | undefined;
  private activeProfile: MusicProfile | null = null;
  private shuttingDown = false;
  private startPromise: Promise<void> | null = null;

  private readonly configStore: OpenapiConfigStore;
  private readonly client: NeteaseOpenapiClient;
  private readonly tokenVault: TokenVault;
  private readonly orchestrator: OpenapiLoginOrchestrator;
  private provider: NeteaseOpenapiProvider;
  private readonly cache: SelectionSetCache;
  private readonly cacheDownloader: CacheDownloader;
  private readonly paths: MusicPaths;
  private mpv: MpvController | null = null;
  private currentPlayback: PlaybackState["track"] | null = null;
  private readonly playbackSession = new PlaybackSession();
  private lastHandledEofTrackId: string | null = null;
  private sessionAdvance: Promise<void> = Promise.resolve();

  private backendListeners = new Set<StateListener<MusicBackendState>>();
  private accountListeners = new Set<StateListener<MusicAccountState>>();
  private playerListeners = new Set<StateListener<MusicPlayerState>>();
  private flowListeners = new Set<StateListener<LoginFlowState>>();
  private stateListeners = new Set<StateListener<MusicStatusSnapshot>>();
  private playbackSessionListeners = new Set<StateListener<MusicPlaybackSessionSnapshot | null>>();
  // mpv 未启动时缓存的 playback 监听器，mpv.start() 后批量补注册
  private pendingPlaybackListeners = new Set<(state: PlaybackState) => void>();

  constructor(paths: MusicPaths) {
    this.paths = paths;
    const configDir = path.dirname(paths.accountPath);
    this.configStore = new OpenapiConfigStore(configDir);
    this.tokenVault = new TokenVault(configDir);
    // Client created lazily with config on start(); placeholder until then.
    this.client = new NeteaseOpenapiClient({ appId: "", privateKey: "" });
    this.orchestrator = new OpenapiLoginOrchestrator({
      client: this.client,
      vault: this.tokenVault,
    });
    this.provider = new NeteaseOpenapiProvider(this.client);
    this.cache = new SelectionSetCache();
    // 边播边存缓存池：与 lyrics-cache 同级
    this.cacheDownloader = new CacheDownloader(path.join(paths.runtimeDir, "music-cache"));
  }

  // ── Lifecycle ──────────────────────────────────────────────

  async start(): Promise<void> {
    if (this.backendState === "ready" || this.backendState === "degraded") return;
    if (this.startPromise) return this.startPromise;
    this.startPromise = this.initOpenapi();
    try {
      await this.startPromise;
    } finally {
      this.startPromise = null;
    }
  }

  /**
   * M3: no Python process to start. "ready" = OpenAPI config present.
   * If no config yet → "incompatible" (renderer prompts user to configure).
   * If config present → inject into client + restore token session.
   */
  private async initOpenapi(): Promise<void> {
    // 缓存池初始化（幂等）：读索引 + 启动对账，失败不阻塞主链路
    await this.cacheDownloader.initialize();

    const config = await this.configStore.loadValidated();
    if (!config) {
      this.backendState = "incompatible";
      this.emitBackendChange("incompatible");
      // 关键：mpv 与网易云凭据无关。本地导入的曲目直接由 mpv 播本地文件，
      // 之前 mpv 的启动写在这个 return 之后，导致没配网易云的用户
      // 连本地音乐都放不了——播放器根本没起来。
      await this.startMpv();
      return;
    }
    // Inject real credentials into the placeholder client (constructed with
    // empty appId/privateKey — see MusicService constructor).
    this.client.configure({ appId: config.appId, privateKey: config.privateKey });
    this.backendState = "ready";
    this.emitBackendChange("ready");

    // Restore saved token session FIRST (doesn't depend on mpv). Token 恢复
    // 不阻塞播放器初始化，避免 mpv 启动慢时 UI 一直看到 account: unknown。
    await this.orchestrator.restoreSession().then((ok) => {
      this.emitAccountChange(this.orchestrator.getAccountState());
    });

    await this.startMpv();
  }

  /**
   * 启动 mpv 并把 dispatcher 接进 provider。
   * 无论有没有网易云凭据都会调用——本地/缓存曲目的播放同样依赖它。
   */
  private async startMpv(): Promise<void> {
    // 幂等：没有网易云凭据时 backendState 永远停在 "incompatible"，
    // start() 的早退守卫（只认 ready/degraded）拦不住，于是每一次音乐操作
    // 都会重跑 initOpenapi()。若这里不做保护，就会每次都 new 一个
    // MpvController——旧实例连同注册在它上面的 IPC 监听器一起被丢掉，
    // 表现为「歌能放但进度条不动」，同时后台堆积多个 mpv 进程。
    //
    // 注意守卫条件是 isReady() 而不是「对象存在」：上一次启动失败（mpv 缺失、
    // IPC 连不上）会留下一个没跑起来的实例，若按「存在即早退」，
    // 「无凭据时启动失败 → 用户补配凭据 → 再次 start()」这条路径会被挡住，
    // 结果 backendState 变 ready 但 mpv 从未运行，不重启就永远放不了歌。
    if (this.mpv?.isReady()) return;
    if (this.mpv) {
      // 上一次启动失败的残留实例：先清干净再重试，避免泄漏子进程
      try { await this.mpv.dispose(); } catch { /* ignore */ }
      this.mpv = null;
    }
    this.mpv = new MpvController();
    try {
      await this.mpv.start();
      // 补注册 mpv 启动前缓存的 playback 监听器（ipc-handlers 在 app 启动时注册）
      for (const l of this.pendingPlaybackListeners) {
        this.mpv.onStateChange(l);
      }
      this.pendingPlaybackListeners.clear();
      const dispatcher: PlaybackDispatcher = async (resource) => {
        if (!this.mpv) {
          return { state: "client_unavailable", resourceType: resource.kind, resourceId: "", errorCode: "E_MPV_NOT_STARTED" };
        }
        await this.mpv.load(resource.playUrl, "replace");
        const track = resource.kind === "song" ? resource.track : resource.tracks[0];
        if (track) {
          this.currentPlayback = {
            encryptedId: track.id,
            name: track.name,
            artists: track.artists,
            coverUrl: track.coverUrl,
          };
          this.mpv.setTrack(this.currentPlayback);
        }
        this.playerState = "available";
        this.emitPlayerChange("available");
        // 边播边存：CDN 直链约 20 分钟过期，必须当下并行下载（切歌不取消）
        if (track) {
          void this.cacheDownloader.download(track, resource.playUrl);
        }
        return { state: "dispatched", resourceType: resource.kind, resourceId: resource.kind === "song" ? resource.track.id : "" };
      };
      this.provider = new NeteaseOpenapiProvider(this.client, dispatcher);
      this.mpv.onStateChange((state) => {
        this.emitStateChange();
        void this.handleMpvState(state);
      });
      // mpv 启动成功后显式广播 player: available。
      // 字段必须一起写：emitPlayerChange 只通知监听器，不改 this.playerState。
      // 只广播不落字段的话，getPlayerState() 会停在 "unknown"；而在
      // 「首次启动失败 → 重试成功」这条路径上更糟——字段会残留上一次的
      // "unavailable"，UI 显示播放器不可用，实际却已经跑起来了。
      this.playerState = "available";
      this.playerErrorCode = undefined;
      this.emitPlayerChange("available");
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // mpv not found → degraded but still functional for non-playback operations.
      console.error("[music] mpv 启动失败，播放器降级为不可用：", message);
      this.playerState = "unavailable";
      // 提取细分错误码（"E_MPV_NOT_FOUND: ..." → "E_MPV_NOT_FOUND"），
      // 前端据此区分「没装 mpv」和「mpv 起不来」给出不同提示
      this.playerErrorCode = message.startsWith("E_MPV_") ? message.split(":", 1)[0] : undefined;
      // 关键：把失败的实例清掉。留着的话下一次 startMpv() 会被守卫早退，
      // 用户即便补上了凭据、装好了 mpv，也要重启应用才能恢复。
      try { await this.mpv?.dispose(); } catch { /* ignore */ }
      this.mpv = null;
      this.provider = new NeteaseOpenapiProvider(this.client);
      this.emitPlayerChange("unavailable");
    }
  }

  async shutdown(): Promise<MusicShutdownReport> {
    if (this.shuttingDown) {
      return {
        rootProcessPid: undefined,
        transportClosed: true,
        processTreeExited: true,
        runtimeRemoved: true,
      };
    }
    this.shuttingDown = true;
    try {
      await this.orchestrator.shutdown();
    } catch { /* ignore */ }
    if (this.mpv) {
      try { await this.mpv.dispose(); } catch { /* ignore */ }
      this.mpv = null;
    }
    this.backendState = "stopped";
    this.emitBackendChange("stopped");
    return {
      rootProcessPid: undefined,
      transportClosed: true,
      processTreeExited: true,
      runtimeRemoved: true,
    };
  }

  // ── State accessors ────────────────────────────────────────

  getBackendState(): MusicBackendState { return this.backendState; }
  getAccountState(): MusicAccountState { return this.orchestrator.getAccountState(); }
  getPlayerState(): MusicPlayerState { return this.playerState; }
  getLoginFlowState(): LoginFlowState { return this.orchestrator.getFlowState(); }
  /** Lyrics cache directory under userData — used by IPC handler for MUSIC_GET_LYRICS. */
  getLyricsCacheDir(): string { return path.join(this.paths.runtimeDir, "lyrics-cache"); }
  getActiveProfile(): MusicProfile | null { return this.activeProfile; }

  getLatestSelectionSet(
    conversationId: string,
    source?: MusicSelectionSet["source"],
  ): MusicSelectionSet | null {
    return this.cache.latest(conversationId, source);
  }

  // ── Login poll passthrough ─────────────────────────────────

  async pollOnce(): Promise<unknown> {
    const result = await this.orchestrator.pollOnce();
    this.emitStateChange();
    return result;
  }

  // ── Event listeners ────────────────────────────────────────

  onBackendStateChange(listener: StateListener<MusicBackendState>): () => void {
    this.backendListeners.add(listener);
    return () => this.backendListeners.delete(listener);
  }
  onAccountStateChange(listener: StateListener<MusicAccountState>): () => void {
    this.accountListeners.add(listener);
    return () => this.accountListeners.delete(listener);
  }
  onPlayerStateChange(listener: StateListener<MusicPlayerState>): () => void {
    this.playerListeners.add(listener);
    return () => this.playerListeners.delete(listener);
  }
  onLoginFlowStateChange(listener: StateListener<LoginFlowState>): () => void {
    this.flowListeners.add(listener);
    return () => this.flowListeners.delete(listener);
  }
  onStateChange(listener: StateListener<MusicStatusSnapshot>): () => void {
    this.stateListeners.add(listener);
    return () => this.stateListeners.delete(listener);
  }
  onPlaybackStateChange(listener: (state: PlaybackState) => void): () => void {
    if (this.mpv) {
      return this.mpv.onStateChange(listener);
    }
    // mpv 尚未启动：缓存 listener，start() 完成后补注册
    this.pendingPlaybackListeners.add(listener);
    return () => {
      this.pendingPlaybackListeners.delete(listener);
    };
  }
  onPlaybackSessionChange(listener: StateListener<MusicPlaybackSessionSnapshot | null>): () => void {
    this.playbackSessionListeners.add(listener);
    return () => this.playbackSessionListeners.delete(listener);
  }

  getSnapshot(): MusicStatusSnapshot {
    return {
      backend: this.backendState,
      account: this.getAccountState(),
      player: this.playerState,
      playerErrorCode: this.playerErrorCode,
      flow: this.getLoginFlowState(),
      profile: this.activeProfile,
    };
  }

  private emitStateChange(): void {
    const snapshot = this.getSnapshot();
    for (const l of this.stateListeners) l(snapshot);
  }

  // ── Login ──────────────────────────────────────────────────

  async beginLogin() {
    await this.ensureReady();
    return this.orchestrator.beginLogin();
  }

  async cancelLogin() {
    await this.orchestrator.cancelLogin();
    this.emitStateChange();
  }

  async logout(): Promise<void> {
    await this.orchestrator.cancelLogin();
    await this.tokenVault.delete();
    this.client.setAccessToken(null);
    this.activeProfile = null;
    this.orchestrator.setAccountState("signed_out");
    this.emitAccountChange("signed_out");
  }

  /**
   * Write OpenAPI credentials (appId + privateKey) to disk and re-init the
   * backend with the new config.  Called from the settings panel IPC handler
   * when the user fills in the OpenAPI config form.
   *
   * If the backend is already ready, the existing client is re-configured
   * in place; otherwise start() is triggered to pick up the new config.
   */
  async applyOpenapiConfig(config: { appId: string; privateKey: string }): Promise<void> {
    // Validate before persisting — OpenapiConfigStore.save() also validates,
    // but we want a clearer error here for the IPC layer.
    if (!config.appId || typeof config.appId !== "string") {
      throw new MusicInputError("E_OPENAPI_CONFIG_INVALID", "appId required");
    }
    if (!config.privateKey || typeof config.privateKey !== "string") {
      throw new MusicInputError("E_OPENAPI_CONFIG_INVALID", "privateKey required");
    }
    await this.configStore.save(config);
    // Reset startPromise so start() can run again after a failed/incompatible init.
    this.startPromise = null;
    this.backendState = "stopped";
    await this.start();
  }

  /** Read the current persisted OpenAPI config (or null if not configured). */
  async getOpenapiConfig(): Promise<{ appId: string; privateKey: string } | null> {
    return this.configStore.loadValidated();
  }

  // ── Data ───────────────────────────────────────────────────

  async getDailyRecommendations(
    conversationId: string,
  ): Promise<MusicSelectionSet> {
    await this.ensureReady();
    this.requireSignedIn();
    const tracks = await this.provider.getDailyRecommendations();
    const setId = crypto.randomUUID();
    const set: MusicSelectionSet = {
      setId,
      provider: this.provider.id,
      source: "daily_recommendation",
      createdAt: Date.now(),
      expiresAt: Date.now() + SET_TTL_MS,
      conversationId,
      tracks,
    };
    this.cache.add(set);
    return set;
  }

  async searchTracks(
    keyword: string,
    conversationId: string,
    limit?: number,
  ): Promise<MusicSelectionSet> {
    await this.ensureReady();
    const trimmed = (typeof keyword === "string" ? keyword : "").trim();
    if (trimmed.length === 0) throw new MusicInputError("E_INVALID_KEYWORD_EMPTY");
    if (trimmed.length > 100) throw new MusicInputError("E_INVALID_KEYWORD_TOO_LONG");
    const clampedLimit = Math.max(1, Math.min(limit ?? 20, 20));
    const tracks = (await this.provider.searchTracks(trimmed)).slice(0, clampedLimit);
    const setId = crypto.randomUUID();
    const set: MusicSelectionSet = {
      setId,
      provider: this.provider.id,
      source: "search",
      query: trimmed,
      createdAt: Date.now(),
      expiresAt: Date.now() + SET_TTL_MS,
      conversationId,
      tracks,
    };
    this.cache.add(set);
    return set;
  }

  async getMyPlaylists(): Promise<MusicPlaylist[]> {
    await this.ensureReady();
    this.requireSignedIn();
    return this.provider.getMyPlaylists();
  }

  async getPlaylistDetail(playlistId: string): Promise<MusicPlaylistDetail> {
    await this.ensureReady();
    this.requireSignedIn();
    assertEncryptedId(playlistId);
    return this.provider.getPlaylistDetail(playlistId);
  }

  async createPlaylist(
    name: string,
    options: { privacy?: boolean } = {},
  ): Promise<MusicPlaylist> {
    await this.ensureReady();
    this.requireSignedIn();
    const trimmed = (typeof name === "string" ? name : "").trim();
    if (trimmed.length === 0) throw new MusicInputError("E_INVALID_PLAYLIST_NAME_EMPTY");
    if (trimmed.length > 100) throw new MusicInputError("E_INVALID_PLAYLIST_NAME_TOO_LONG");
    return this.provider.createPlaylist(trimmed, options.privacy);
  }

  async addToPlaylist(
    playlistId: string,
    trackIds: string[],
  ): Promise<{ added: number; playlistId: string }> {
    await this.ensureReady();
    this.requireSignedIn();
    if (!playlistId) throw new MusicInputError("E_INVALID_ID_FORMAT");
    if (!Array.isArray(trackIds) || trackIds.length === 0) {
      throw new MusicInputError("E_TRACK_IDS_EMPTY");
    }
    return this.provider.addToPlaylist(playlistId, trackIds);
  }

  async removeFromPlaylist(
    playlistId: string,
    trackIds: string[],
  ): Promise<{ removed: number; playlistId: string }> {
    await this.ensureReady();
    this.requireSignedIn();
    if (!playlistId) throw new MusicInputError("E_INVALID_ID_FORMAT");
    if (!Array.isArray(trackIds) || trackIds.length === 0) {
      throw new MusicInputError("E_TRACK_IDS_EMPTY");
    }
    return this.provider.removeFromPlaylist(playlistId, trackIds);
  }

  async getMySubscriptions(
    category: "artists" | "albums",
  ): Promise<MusicSubscription[]> {
    await this.ensureReady();
    this.requireSignedIn();
    if (category !== "artists" && category !== "albums") {
      throw new MusicInputError("E_INVALID_SUBSCRIPTION_CATEGORY");
    }
    return this.provider.getMySubscriptions(category);
  }

  // ── Playback control (mpv) ─────────────────────────────────

  getPlaybackState(): PlaybackState {
    if (!this.mpv) {
      return { connected: false, loaded: false, paused: false, position: 0, duration: 0, volume: 70 };
    }
    return this.mpv.getState();
  }

  getPlaybackSession(): MusicPlaybackSessionSnapshot | null {
    return this.playbackSession.snapshot();
  }

  async playSessionTrack(input: unknown): Promise<PlaybackDispatchResult> {
    const session = this.validatePlaybackSession(input);
    const track = session.queue[session.queueIndex];
    if (!track) throw new MusicInputError("E_PLAYBACK_QUEUE_INDEX_INVALID");
    await this.ensureTrackPlaybackReady(track.id);
    this.playbackSession.replace(session);
    this.emitPlaybackSessionChange();
    return this.dispatchFromCacheOrProvider(track.id);
  }

  syncPlaybackSession(input: unknown): MusicPlaybackSessionSnapshot {
    const session = this.validatePlaybackSession(input);
    this.playbackSession.replace(session);
    this.emitPlaybackSessionChange();
    return this.playbackSession.snapshot()!;
  }

  async playbackPlay(): Promise<void> {
    this.requireMpv();
    await this.mpv!.play();
  }

  async playbackPause(): Promise<void> {
    this.requireMpv();
    await this.mpv!.pause();
  }

  async playbackToggle(): Promise<void> {
    this.requireMpv();
    await this.mpv!.togglePlay();
  }

  async playbackSeek(seconds: number): Promise<void> {
    this.requireMpv();
    await this.mpv!.seek(seconds);
  }

  async playbackSetVolume(vol: number): Promise<void> {
    this.requireMpv();
    await this.mpv!.setVolume(vol);
  }

  async playbackStop(): Promise<void> {
    this.requireMpv();
    await this.mpv!.stop();
    this.currentPlayback = null;
    this.playerState = "unknown";
    this.emitPlayerChange("unknown");
  }

  async playbackNext(): Promise<void> {
    this.requireMpv();
    await this.mpv!.next();
  }

  async playbackPrev(): Promise<void> {
    this.requireMpv();
    await this.mpv!.prev();
  }

  private requireMpv(): void {
    if (!this.mpv || !this.mpv.isReady()) {
      throw new MusicInputError("E_MPV_NOT_READY");
    }
  }

  private async handleMpvState(state: PlaybackState): Promise<void> {
    if (state.eofReached !== true) {
      this.lastHandledEofTrackId = null;
      return;
    }
    const trackId = state.track?.encryptedId;
    if (!trackId || trackId === this.lastHandledEofTrackId) return;
    this.lastHandledEofTrackId = trackId;
    this.sessionAdvance = this.sessionAdvance.then(async () => {
      const snapshot = this.playbackSession.snapshot();
      const current = snapshot?.queue[snapshot.queueIndex];
      if (!snapshot || current?.id !== trackId) return;
      const target = this.playbackSession.nextForEof();
      if (!target) return;
      await this.dispatchFromCacheOrProvider(target.track.id);
      this.emitPlaybackSessionChange();
    }).catch((err: unknown) => {
      console.warn("[music] background session advance failed:", err instanceof Error ? err.message : err);
    });
    await this.sessionAdvance;
  }

  private emitPlaybackSessionChange(): void {
    const snapshot = this.playbackSession.snapshot();
    for (const listener of this.playbackSessionListeners) listener(snapshot);
  }

  private validatePlaybackSession(input: unknown): PlaybackSessionInput {
    if (!input || typeof input !== "object") {
      throw new MusicInputError("E_PLAYBACK_SESSION_INVALID");
    }
    const session = input as Partial<PlaybackSessionInput>;
    const { queue, playbackMode, playlistId, queueIndex } = session;
    if (!Array.isArray(queue) || !this.isPlaybackMode(playbackMode) || typeof playlistId !== "string") {
      throw new MusicInputError("E_PLAYBACK_SESSION_INVALID");
    }
    if (typeof queueIndex !== "number" || !Number.isInteger(queueIndex)) {
      throw new MusicInputError("E_PLAYBACK_QUEUE_INDEX_INVALID");
    }
    if (queue.length === 0) {
      if (queueIndex !== -1) throw new MusicInputError("E_PLAYBACK_QUEUE_INDEX_INVALID");
    } else if (queueIndex < -1 || queueIndex >= queue.length) {
      throw new MusicInputError("E_PLAYBACK_QUEUE_INDEX_INVALID");
    }
    if (!queue.every((track) => this.isSessionTrack(track))) {
      throw new MusicInputError("E_PLAYBACK_SESSION_INVALID");
    }
    return {
      queue,
      queueIndex,
      playbackMode,
      playlistId,
    };
  }

  private isPlaybackMode(value: unknown): value is PlaybackSessionInput["playbackMode"] {
    return value === "off" || value === "all" || value === "one" || value === "shuffle";
  }

  private isSessionTrack(value: unknown): value is MusicTrack {
    if (!value || typeof value !== "object") return false;
    const track = value as Partial<MusicTrack>;
    return typeof track.id === "string" && track.id.trim().length > 0
      && typeof track.name === "string"
      && Array.isArray(track.artists)
      && track.artists.every((artist) => typeof artist === "string");
  }

  // ── UI 直连数据（lyrics / favorite，不经 AI 工具层） ────────

  /** 返回原文 LRC + 翻译 LRC（翻译由 IPC 层按时间戳合并）。 */
  async getLyrics(encryptedId: string): Promise<{ lrc: string; transLrc: string }> {
    await this.ensureReady();
    this.requireSignedIn();
    const lyric = await this.client.getLyric(encryptedId);
    return {
      lrc: lyric.lyric ?? "",
      transLrc: lyric.transLyric ?? "",
    };
  }

  async toggleFavorite(encryptedId: string, favorite: boolean): Promise<boolean> {
    await this.ensureReady();
    this.requireSignedIn();
    await this.client.setSongLike(encryptedId, favorite);
    return favorite;
  }

  // ── 本地缓存（边播边存 + 用户导入） ────────────────────────

  /** 缓存歌单曲目列表（离线可用，不要求登录）。 */
  async getCachedTracks(): Promise<MusicTrack[]> {
    await this.cacheDownloader.initialize();
    return this.cacheDownloader.listTracks();
  }

  /** 删除缓存曲目；正在播放该曲目时拒删（E_CACHE_TRACK_PLAYING）。 */
  async removeCachedTrack(encryptedId: string): Promise<boolean> {
    if (!encryptedId) throw new MusicInputError("E_INVALID_ID_FORMAT");
    await this.cacheDownloader.initialize();
    if (this.currentPlayback?.encryptedId === encryptedId) {
      throw new MusicInputError("E_CACHE_TRACK_PLAYING");
    }
    return this.cacheDownloader.remove(encryptedId);
  }

  /** 导入用户本地音乐文件到缓存池（主进程文件框选好的路径）。 */
  async importLocalFiles(filePaths: string[]): Promise<{ imported: number; skipped: number }> {
    await this.cacheDownloader.initialize();
    return this.cacheDownloader.importFiles(filePaths);
  }

  /**
   * 导入整个文件夹：递归扫描出音频文件后复用 importLocalFiles。
   * truncated 表示命中数量上限，调用方需要如实告诉用户结果被截断了。
   */
  async importLocalFolder(dir: string): Promise<{ imported: number; skipped: number; truncated: boolean }> {
    const { files, truncated } = await scanAudioFiles(dir);
    if (files.length === 0) return { imported: 0, skipped: 0, truncated };
    const result = await this.importLocalFiles(files);
    return { ...result, truncated };
  }

  /** 缓存索引变化（下载完成/删除/导入）订阅。 */
  onCacheUpdated(listener: () => void): () => void {
    return this.cacheDownloader.onUpdated(listener);
  }

  // ── Playback dispatch ──────────────────────────────────────

  /**
   * 播放优先级（顺序即层级）：
   *   1. 缓存命中（index + 文件双条件）→ 直接播本地文件，不调 API
   *   2. 正在下载 → await 现有下载 Promise（Promise 复用），完成后播本地
   *   3. 都没有 → 在线链路（getSongDetail → dispatch），dispatch 成功后并行下载
   * 缓存判断在 assertEncryptedId 之前，`local-` 开头的导入曲目 ID 也能走通。
   */
  private async dispatchFromCacheOrProvider(trackId: string): Promise<PlaybackDispatchResult> {
    const cachedPath = this.cacheDownloader.getFilePath(trackId);
    if (cachedPath) {
      return this.dispatchLocalTrack(trackId, cachedPath);
    }
    const pending = this.cacheDownloader.getDownloadPromise(trackId);
    if (pending) {
      const result = await pending;
      if (result.ok && result.filePath) {
        return this.dispatchLocalTrack(trackId, result.filePath);
      }
      // 下载失败 → 落回在线链路
    }
    return this.provider.playTrack(trackId);
  }

  /** 直接播本地缓存文件（零延迟、零流量、零 API 调用）。 */
  private async dispatchLocalTrack(trackId: string, filePath: string): Promise<PlaybackDispatchResult> {
    this.requireMpv();
    const rec = this.cacheDownloader.getTrack(trackId);
    await this.mpv!.load(filePath, "replace");
    this.currentPlayback = {
      encryptedId: trackId,
      name: rec?.name ?? trackId,
      artists: rec?.artists ?? [],
      coverUrl: rec?.coverUrl,
    };
    this.mpv!.setTrack(this.currentPlayback);
    this.playerState = "available";
    this.emitPlayerChange("available");
    console.log("[music-cache] play from cache:", { trackId, name: this.currentPlayback.name });
    return { state: "dispatched", resourceType: "song", resourceId: trackId };
  }

  /** Trusted renderer path: IDs originate from MusicService search results. */
  async playTrackFromUi(trackId: string): Promise<PlaybackDispatchResult> {
    if (!trackId) throw new MusicInputError("E_INVALID_ID_FORMAT");
    await this.ensureTrackPlaybackReady(trackId);
    return this.dispatchFromCacheOrProvider(trackId);
  }

  async playPlaylist(playlistId: string): Promise<PlaybackDispatchResult> {
    if (!playlistId) throw new MusicInputError("E_INVALID_ID_FORMAT");
    await this.ensureReady();
    return this.provider.playPlaylist(playlistId);
  }

  // ── Helpers ────────────────────────────────────────────────

  /**
   * 本地缓存（含用户导入）只依赖 mpv，不依赖网易云后端。
   * 两条 UI 播放入口必须共用这道门禁，避免其中一条重新把本地音乐锁住。
   */
  private async ensureTrackPlaybackReady(trackId: string): Promise<void> {
    if (this.shuttingDown) throw new MusicInputError("E_BACKEND_NOT_READY");
    await this.start();
    if (this.cacheDownloader.getFilePath(trackId)) return;
    this.requireReady();
  }

  private async ensureReady(): Promise<void> {
    if (this.shuttingDown) throw new MusicInputError("E_BACKEND_NOT_READY");
    await this.start();
    this.requireReady();
  }

  private requireReady(): void {
    if (this.backendState !== "ready" && this.backendState !== "degraded") {
      throw new MusicInputError("E_BACKEND_NOT_READY");
    }
  }

  private requireSignedIn(): void {
    if (this.orchestrator.getAccountState() !== "signed_in") {
      throw new MusicInputError("E_ACCOUNT_REQUIRED");
    }
  }

  private emitBackendChange(s: MusicBackendState): void {
    for (const l of this.backendListeners) l(s);
    this.emitStateChange();
  }
  private emitAccountChange(s: MusicAccountState): void {
    for (const l of this.accountListeners) l(s);
    this.emitStateChange();
  }
  private emitPlayerChange(s: MusicPlayerState): void {
    for (const l of this.playerListeners) l(s);
    this.emitStateChange();
  }
  private emitFlowChange(s: LoginFlowState): void {
    for (const l of this.flowListeners) l(s);
    this.emitStateChange();
  }
}
