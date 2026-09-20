import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Minus, X } from "lucide-react";
import MusicPlayer from "./components/MusicPlayer";
import { canOpenPlayer, pickInitialPlaylist, pickPlayStartIndex, LOCAL_CACHE_PLAYLIST_ID } from "./player-source";
import LoadingScreen from "./components/LoadingScreen";
import { getNextQueueIndex } from "./playback-queue";
import type { PlaybackState as MpvPlaybackState } from "../../shared/music-types";
import type {
  Playlist,
  PlaybackActions,
  PlaybackState,
  PlaybackMode,
  Track,
} from "./types";

// ── window.music API 形状（与 preload/music.ts 对齐，局部声明避免跨层 import）──
interface MusicIpcResult<T> {
  ok: boolean;
  data?: T;
  errorCode?: string;
}
interface MusicApi {
  getStatus: () => Promise<MusicIpcResult<unknown>>;
  getMyPlaylists: () => Promise<MusicIpcResult<unknown>>;
  getPlaylistDetail: (playlistId: string) => Promise<MusicIpcResult<unknown>>;
  search: (keyword: string, limit?: number) => Promise<MusicIpcResult<unknown>>;
  playTrack: (encryptedId: string) => Promise<MusicIpcResult<unknown>>;
  playbackToggle: () => Promise<MusicIpcResult<unknown>>;
  playbackSeek: (seconds: number) => Promise<MusicIpcResult<unknown>>;
  playbackVolume: (vol: number) => Promise<MusicIpcResult<unknown>>;
  getPlaybackSession: () => Promise<MusicIpcResult<unknown>>;
  playSessionTrack: (payload: unknown) => Promise<MusicIpcResult<unknown>>;
  syncPlaybackSession: (payload: unknown) => Promise<MusicIpcResult<unknown>>;
  getLyrics: (encryptedId: string) => Promise<MusicIpcResult<unknown>>;
  toggleFavorite: (encryptedId: string, favorite: boolean) => Promise<MusicIpcResult<unknown>>;
  getCachedTracks: () => Promise<MusicIpcResult<unknown>>;
  removeCachedTrack: (trackId: string) => Promise<MusicIpcResult<unknown>>;
  importLocalTracks: () => Promise<MusicIpcResult<unknown>>;
  minimizeWindow: () => void;
  closeWindow: () => void;
  openSettings: (section?: string) => Promise<unknown>;
  onPlaybackState: (h: (s: unknown) => void) => (() => void) | void;
  onPlaybackSessionChanged: (h: (s: unknown) => void) => (() => void) | void;
  onStateChanged: (h: (s: unknown) => void) => (() => void) | void;
  onCacheUpdated: (h: () => void) => (() => void) | void;
}

// 后端返回类型（与 src/main/music/types.ts 的 MusicPlaylist/MusicTrack 对齐）
interface BackendTrack {
  id: string;
  encryptedId?: string;
  originalId?: number;
  name: string;
  artists?: string[];
  album?: string;
  durationMs?: number;
  coverUrl?: string;
}
interface BackendPlaylist {
  id: string;
  originalId?: number | string;
  name: string;
  coverUrl?: string;
  trackCount: number;
  tracks?: BackendTrack[];
}
interface BackendPlaybackSession {
  queue: BackendTrack[];
  queueIndex: number;
  playbackMode: PlaybackMode;
  playlistId: string;
}

function normalizeTrack(t: BackendTrack): Track {
  return {
    encryptedId: t.encryptedId ?? t.id,
    originalId: t.originalId != null ? String(t.originalId) : "",
    name: t.name,
    artists: t.artists ?? [],
    album: t.album,
    coverImgUrl: t.coverUrl,
    durationMs: t.durationMs,
    visible: true,
  };
}

function normalizePlaylist(p: BackendPlaylist): Playlist {
  return {
    id: p.id,
    originalId: String(p.originalId ?? ""),
    name: p.name,
    coverImgUrl: p.coverUrl,
    trackCount: p.trackCount,
    tracks: [],
  };
}

function toSessionTrack(track: Track): BackendTrack {
  return {
    id: track.encryptedId,
    encryptedId: track.encryptedId,
    originalId: track.originalId,
    name: track.name,
    artists: track.artists,
    album: track.album,
    durationMs: track.durationMs,
    coverUrl: track.coverImgUrl,
  };
}

function getMusicApi(): MusicApi | null {
  const w = window as unknown as { music?: MusicApi };
  return w.music ?? null;
}

const INITIAL_STATE: PlaybackState = {
  currentTrack: null,
  isPlaying: false,
  positionMs: 0,
  durationMs: 0,
  volume: 70,
  isMuted: false,
  queue: [],
  queueIndex: -1,
  playbackMode: "off",
  isLoading: false,
};

// ── 本地缓存虚拟歌单 ──────────────────────────────────────────
function makeCachePlaylist(tracks: Track[]): Playlist {
  return {
    id: LOCAL_CACHE_PLAYLIST_ID,
    originalId: "",
    name: "本地缓存",
    trackCount: tracks.length,
    tracks,
  };
}

// ── mpv 内核缺失判定：player 不可用且原因是二进制找不到/spawn 失败 ──
function isMpvKernelMissing(
  snap: { player?: string; playerErrorCode?: string } | undefined | null,
): boolean {
  return (
    snap?.player === "unavailable" &&
    (snap?.playerErrorCode === "E_MPV_NOT_FOUND" || snap?.playerErrorCode === "E_MPV_SPAWN_FAILED")
  );
}

// mpv 内核缺失提示条：只提示安装方式，不阻断浏览/搜索（issue #98）
function MpvKernelWarning() {
  return (
    <div className="mp-kernel-warning" role="alert">
      <span>
        未找到 mpv 播放器内核，暂时无法播放。请运行 <code>npm run prepare:mpv</code> 或安装 mpv 后重启应用
      </span>
    </div>
  );
}

// ── 播放模式：普通歌单双模式，缓存歌单四模式，localStorage 分开持久化 ──
const ONLINE_MODES: PlaybackMode[] = ["off", "one"];
const CACHE_MODES: PlaybackMode[] = ["off", "all", "one", "shuffle"];
const LS_MODE_ONLINE = "cyrene:music:playback-mode:online";
const LS_MODE_CACHE = "cyrene:music:playback-mode:cache";

function loadPersistedMode(key: string, allowed: PlaybackMode[]): PlaybackMode {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return "off";
    const parsed = JSON.parse(raw) as { mode?: string };
    const mode = parsed?.mode as PlaybackMode | undefined;
    return mode && allowed.includes(mode) ? mode : "off";
  } catch {
    return "off";
  }
}

function savePersistedMode(key: string, mode: PlaybackMode): void {
  try {
    localStorage.setItem(key, JSON.stringify({ mode }));
  } catch {
    /* localStorage 不可用时静默忽略 */
  }
}

export function App() {
  const persistedOnline = useMemo(() => loadPersistedMode(LS_MODE_ONLINE, ONLINE_MODES), []);
  const persistedCache = useMemo(() => loadPersistedMode(LS_MODE_CACHE, CACHE_MODES), []);
  const persistedOnlineRef = useRef(persistedOnline);
  const persistedCacheRef = useRef(persistedCache);

  const [state, setState] = useState<PlaybackState>({
    ...INITIAL_STATE,
    playbackMode: persistedOnline,
  });
  const [neteasePlaylists, setNeteasePlaylists] = useState<Playlist[]>([]);
  const [cacheTracks, setCacheTracks] = useState<Track[]>([]);
  const [activePlaylistId, setActivePlaylistId] = useState("");
  // 同步网易云歌单最新值给 onStateChanged 回调用，避免闭包陷阱导致重复拉取
  const neteasePlaylistsRef = useRef<Playlist[]>([]);
  const [searchResults, setSearchResults] = useState<Track[]>([]);
  const [isSearching, setIsSearching] = useState(false);
  const [loginReady, setLoginReady] = useState(false);
  // 网易云是否已有结论：未登录（立即成立），或已登录且歌单拉回来了。
  // 自动选源必须等它，否则本地曲库会抢占默认歌单（本地 IPC 比网络快）。
  const [neteaseResolved, setNeteaseResolved] = useState(false);
  const [loading, setLoading] = useState(true);
  // mpv 内核缺失（未安装 / spawn 失败）→ 顶部显示安装引导提示条
  const [kernelMissing, setKernelMissing] = useState(false);
  const searchTimer = useRef<number | null>(null);
  // 记住静音前的音量，用于取消静音时恢复
  const volumeBeforeMute = useRef<number>(70);
  // 换歌 loading 超时兜底（mpv 没在 3s 内回 duration 就强制解锁）
  const loadingTimer = useRef<number | null>(null);
  // 播完一次性标记（eof-reached 触发，防重复路由）；换曲时重置
  const endedRef = useRef(false);
  const lastTrackIdRef = useRef<string>("");
  // currentTrack 也会被歌单选择预先赋值；单独记录 mpv 真正加载的曲目，不能混为一谈。
  const loadedTrackIdRef = useRef<string>("");

  // 最新 state / activePlaylistId 的 ref（播完路由 effect 里读，避免闭包陷阱）
  const stateRef = useRef(state);
  stateRef.current = state;
  const activePlaylistIdRef = useRef(activePlaylistId);
  activePlaylistIdRef.current = activePlaylistId;

  const api = getMusicApi();

  // 缓存虚拟歌单插在头部
  const playlists = useMemo(
    () => [makeCachePlaylist(cacheTracks), ...neteasePlaylists],
    [cacheTracks, neteasePlaylists],
  );

  // 自动选源：没登录网易云但有本地曲库时，直接落到本地歌单。
  // 否则 activePlaylistId 会一直是空串，modeSet 被判成 "online"，
  // 用户打开播放器看到的是一个空的在线视图。
  // 只在还没选过歌单时生效，不覆盖用户的手动选择。
  useEffect(() => {
    const next = pickInitialPlaylist({
      currentId: activePlaylistId,
      localTrackCount: cacheTracks.length,
      neteasePlaylistCount: neteasePlaylists.length,
      neteaseResolved,
    });
    if (next) setActivePlaylistId(next);
  }, [activePlaylistId, cacheTracks.length, neteasePlaylists.length, neteaseResolved]);

  const patch = useCallback((p: Partial<PlaybackState>) => {
    setState((s) => ({ ...s, ...p }));
  }, []);

  // ── 歌词顺势拉取 ──────────────────────────────────────────
  // 用户点播（playTrack）与 agent 工具播放（播放状态推送检测换曲）两条路径
  // 共享；同一曲目只拉一次，主进程 LyricsCache 命中时 0 配额。
  const lastLyricsIdRef = useRef<string>("");
  const fetchLyrics = useCallback((encryptedId: string) => {
    if (!api) return;
    if (encryptedId.startsWith("local-")) return; // 本地导入曲目无网易云歌词
    if (lastLyricsIdRef.current === encryptedId) return;
    lastLyricsIdRef.current = encryptedId;
    void api.getLyrics(encryptedId).then((r) => {
      if (!r.ok || !r.data) {
        if (!r.ok) {
          console.warn("[music] getLyrics failed:", r.errorCode);
          // 失败允许下次播放重试
          if (lastLyricsIdRef.current === encryptedId) lastLyricsIdRef.current = "";
        }
        return;
      }
      const lyrics = r.data as { timeMs: number; text: string; translation?: string }[];
      setState((s) => {
        // 响应迟到且用户已切歌 → 丢弃，避免旧歌词挂到新歌上
        if (s.currentTrack && s.currentTrack.encryptedId !== encryptedId) {
          return s;
        }
        return {
          ...s,
          currentTrack: s.currentTrack ? { ...s.currentTrack, lyrics } : s.currentTrack,
          queue: s.queue.map((t) =>
            t.encryptedId === encryptedId ? { ...t, lyrics } : t,
          ),
        };
      });
    }).catch((err) => {
      console.warn("[music] getLyrics error:", err);
      if (lastLyricsIdRef.current === encryptedId) lastLyricsIdRef.current = "";
    });
  }, [api]);

  // ── 启动探测：搜索请求 + 4秒最低等待 ──────────────────────
  useEffect(() => {
    if (!api) {
      // 没有 preload API（浏览器预览等）→ 直接跳过 loading
      setLoading(false);
      return;
    }
    let cancelled = false;
    const MIN_WAIT = 4000;
    const timer = new Promise((r) => window.setTimeout(r, MIN_WAIT));
    // 用一次轻量搜索探测网易云连接是否正常
    const probe = api.search("test", 1).then(
      () => true,
      () => false,
    );
    Promise.all([timer, probe]).then(([, ok]) => {
      if (cancelled) return;
      if (ok) {
        setLoading(false);
      } else {
        // 探测失败 → 打开设置页网易云配置 + 关闭播放器窗口
        void api.openSettings("music");
        api.closeWindow();
      }
    });
    return () => {
      cancelled = true;
    };
  }, [api]);

  // ── 订阅 mpv 播放状态推送 ──────────────────────────────────
  useEffect(() => {
    if (!api) return;
    const unsub = api.onPlaybackState?.((raw) => {
      const mpv = raw as Partial<MpvPlaybackState>;
      setState((s) => {
        const next: Partial<PlaybackState> = {};
        if (typeof mpv.position === "number") next.positionMs = Math.round(mpv.position * 1000);
        if (typeof mpv.duration === "number") {
          next.durationMs = Math.round(mpv.duration * 1000);
          // 收到 duration → 换歌 loading 结束
          if (mpv.duration > 0 && s.isLoading) {
            next.isLoading = false;
            if (loadingTimer.current) {
              window.clearTimeout(loadingTimer.current);
              loadingTimer.current = null;
            }
          }
        }
        if (typeof mpv.volume === "number") {
          next.volume = Math.round(mpv.volume);
          if (mpv.volume > 0) next.isMuted = false;
        }
        if (typeof mpv.paused === "boolean") next.isPlaying = !mpv.paused;
        // track 变化 → 同步 currentTrack（优先用本地 queue 里的完整信息）
        if (mpv.track && typeof mpv.track.encryptedId === "string") {
          const inQueue = s.queue.find((t) => t.encryptedId === mpv.track!.encryptedId);
          if (inQueue) {
            next.currentTrack = inQueue;
            const idx = s.queue.indexOf(inQueue);
            if (idx >= 0) next.queueIndex = idx;
          } else if (s.currentTrack?.encryptedId !== mpv.track.encryptedId) {
            // 不在 queue（比如 AI 工具直接播的）→ 构造最小 Track
            next.currentTrack = {
              encryptedId: mpv.track.encryptedId,
              originalId: "",
              name: mpv.track.name ?? "未知歌曲",
              artists: mpv.track.artists ?? [],
              coverImgUrl: mpv.track.coverUrl,
              visible: true,
            };
          }
        } else if (mpv.loaded === false && s.currentTrack) {
          // 停止播放
          next.currentTrack = null;
          next.queueIndex = -1;
          next.isPlaying = false;
          next.positionMs = 0;
        }
        return { ...s, ...next };
      });

      // ── 播完判定（一次性标记）──
      // 事实源 = mpv eof-reached（keep-open 下播完停在结尾）；
      // paused && position >= duration - 1s 仅作 eof 事件丢失时的兜底
      const trackId = typeof mpv.track?.encryptedId === "string" ? mpv.track.encryptedId : undefined;
      if (mpv.loaded === false) {
        loadedTrackIdRef.current = "";
      } else if (trackId) {
        loadedTrackIdRef.current = trackId;
      }
      if (trackId && trackId !== lastTrackIdRef.current) {
        lastTrackIdRef.current = trackId;
        endedRef.current = false;
        // 播放即顺势拉歌词：覆盖 agent 工具触发的播放（不经 playTrack）
        fetchLyrics(trackId);
      }
      const duration = typeof mpv.duration === "number" ? mpv.duration : 0;
      const position = typeof mpv.position === "number" ? mpv.position : 0;
      const atTail = duration > 0 && position >= duration - 1;
      const ended =
        mpv.eofReached === true || (mpv.paused === true && atTail && mpv.loaded !== false);
      if (ended && !endedRef.current && trackId) {
        endedRef.current = true;
      }
    });
    return () => {
      if (typeof unsub === "function") unsub();
    };
  }, [api, fetchLyrics]);

  const applyPlaybackSession = useCallback((raw: unknown) => {
    const session = raw as Partial<BackendPlaybackSession>;
    if (!Array.isArray(session.queue) || typeof session.queueIndex !== "number" || !session.playbackMode) return;
    const queue = session.queue.map(normalizeTrack);
    const currentTrack = queue[session.queueIndex] ?? null;
    setState((s) => ({ ...s, queue, queueIndex: session.queueIndex!, playbackMode: session.playbackMode!, currentTrack }));
    if (typeof session.playlistId === "string") setActivePlaylistId(session.playlistId);
  }, []);

  useEffect(() => {
    if (!api) return;
    let receivedSessionPush = false;
    const unsub = api.onPlaybackSessionChanged?.((session) => {
      receivedSessionPush = true;
      applyPlaybackSession(session);
    });
    void api.getPlaybackSession().then((r) => {
      if (!receivedSessionPush && r.ok && r.data) applyPlaybackSession(r.data);
    }).catch(() => { /* session restore is optional */ });
    return () => {
      if (typeof unsub === "function") unsub();
    };
  }, [api, applyPlaybackSession]);

  // ── 订阅 music 状态（检测登录态） ──────────────────────────
  useEffect(() => {
    if (!api) return;
    const checkLogin = async () => {
      try {
        // 本地曲库与网易云登录无关，无论如何都要加载——放在 if 里面的话，
        // 「只导入了本地音乐、没登录网易云」的用户会看到一个空播放器。
        void loadCacheTracks();
        const r = await api.getStatus();
        const snap = r.data as { account?: string; backend?: string; player?: string; playerErrorCode?: string };
        setKernelMissing(isMpvKernelMissing(snap));
        if (snap?.account === "signed_in") {
          setLoginReady(true);
          // 已登录：等歌单真正拉回来才算有结论
          void loadPlaylists().finally(() => setNeteaseResolved(true));
        } else {
          setLoginReady(false);
          // 未登录：不会再有网易云歌单，立即有结论
          setNeteaseResolved(true);
        }
      } catch {
        /* ignore */
      }
    };
    void checkLogin();
    const unsub = api.onStateChanged?.((raw) => {
      const snap = raw as { account?: string; player?: string; playerErrorCode?: string };
      // mpv 失败后重试成功（比如用户补装了 mpv）→ 撤掉提示条
      setKernelMissing(isMpvKernelMissing(snap));
      void loadCacheTracks();
      if (snap?.account === "signed_in") {
        setLoginReady(true);
        if (neteasePlaylistsRef.current.length === 0) {
          void loadPlaylists().finally(() => setNeteaseResolved(true));
        } else {
          setNeteaseResolved(true);
        }
      } else {
        setLoginReady(false);
        setNeteaseResolved(true);
      }
    });
    return () => {
      if (typeof unsub === "function") unsub();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api]);

  // ── 拉取用户歌单 ──────────────────────────────────────────
  const loadPlaylists = useCallback(async () => {
    if (!api) return;
    try {
      const r = await api.getMyPlaylists();
      if (r.ok && r.data) {
        const pls = (r.data as BackendPlaylist[]).map(normalizePlaylist);
        setNeteasePlaylists(pls);
        neteasePlaylistsRef.current = pls;
        if (pls.length > 0 && !activePlaylistId) {
          setActivePlaylistId(pls[0].id);
          // 自动加载第一个歌单的 tracks 作为初始 queue
          void loadPlaylistTracks(pls[0]);
        }
      }
    } catch (err) {
      console.warn("[music] getMyPlaylists failed", err);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api, activePlaylistId]);

  // ── 拉取缓存歌单曲目 ──────────────────────────────────────
  const loadCacheTracks = useCallback(async () => {
    if (!api) return;
    try {
      const r = await api.getCachedTracks();
      if (r.ok && r.data) {
        setCacheTracks((r.data as BackendTrack[]).map(normalizeTrack));
      }
    } catch {
      /* 缓存歌单可选，失败不提示 */
    }
  }, [api]);

  // ── 订阅缓存索引变化（下载完成/删除/导入） ──────────────────
  useEffect(() => {
    if (!api) return;
    const unsub = api.onCacheUpdated?.(() => {
      void loadCacheTracks();
    });
    return () => {
      if (typeof unsub === "function") unsub();
    };
  }, [api, loadCacheTracks]);

  // ── 缓存歌单激活时：缓存索引变化 → 合并刷新 queue（不打断当前播放） ──
  useEffect(() => {
    if (activePlaylistId !== LOCAL_CACHE_PLAYLIST_ID) return;
    setState((s) => {
      const idx = cacheTracks.findIndex((t) => t.encryptedId === s.currentTrack?.encryptedId);
      const queueIndex =
        idx >= 0
          ? idx
          : cacheTracks.length > 0
            ? Math.min(s.queueIndex < 0 ? 0 : s.queueIndex, cacheTracks.length - 1)
            : -1;
      if (s.queue === cacheTracks && s.queueIndex === queueIndex) return s;
      return {
        ...s,
        queue: cacheTracks,
        queueIndex,
        durationMs: idx >= 0 ? (cacheTracks[idx].durationMs ?? s.durationMs) : s.durationMs,
      };
    });
  }, [activePlaylistId, cacheTracks]);

  const loadPlaylistTracks = useCallback(
    async (playlist: Playlist) => {
      if (!api) return;
      // 缓存歌单：tracks 已在内存（cacheTracks 快照），不调 API
      if (playlist.id === LOCAL_CACHE_PLAYLIST_ID) {
        setState((s) => ({
          ...s,
          queue: playlist.tracks,
          queueIndex: playlist.tracks.length > 0 ? 0 : -1,
          currentTrack: playlist.tracks[0] ?? null,
          durationMs: playlist.tracks[0]?.durationMs ?? 0,
          positionMs: 0,
          isPlaying: false,
          error: undefined,
        }));
        return;
      }
      try {
        const r = await api.getPlaylistDetail(playlist.id);
        if (r.ok && r.data) {
          const detail = r.data as BackendPlaylist;
          const tracks = (detail.tracks ?? []).map(normalizeTrack);
          setState((s) => ({
            ...s,
            queue: tracks,
            queueIndex: tracks.length > 0 ? 0 : -1,
            currentTrack: tracks[0] ?? null,
            durationMs: tracks[0]?.durationMs ?? 0,
            positionMs: 0,
            isPlaying: false,
            error: undefined,
          }));
        }
      } catch (err) {
        console.warn("[music] getPlaylistDetail failed", err);
      }
    },
    [api],
  );

  // ── 播放指定歌曲（本地 queue 管理 + IPC 派发） ──────────────
  const playTrack = useCallback(
    (track: Track) => {
      endedRef.current = false;
      if (!track.visible) {
        patch({ error: `「${track.name}」暂时无法播放` });
        return;
      }
      if (!api) {
        patch({ error: "音乐服务未就绪" });
        return;
      }
      // 换歌 loading：等 mpv 回 duration（或 3s 超时兜底）
      if (loadingTimer.current) window.clearTimeout(loadingTimer.current);
      patch({ isLoading: true, error: undefined, positionMs: 0 });
      loadingTimer.current = window.setTimeout(() => {
        patch({ isLoading: false });
        loadingTimer.current = null;
      }, 3000);

      const current = stateRef.current;
      const existingIndex = current.queue.findIndex((t) => t.encryptedId === track.encryptedId);
      const queue = existingIndex >= 0 ? current.queue : [...current.queue, { ...track }];
      const queueIndex = existingIndex >= 0 ? existingIndex : queue.length - 1;
      const currentTrack = queue[queueIndex] ?? track;
      setState((s) => ({ ...s, queue, queueIndex, currentTrack, durationMs: currentTrack.durationMs ?? 0 }));

      void api.playSessionTrack({
        queue: queue.map(toSessionTrack),
        queueIndex,
        playbackMode: current.playbackMode,
        playlistId: activePlaylistIdRef.current,
      }).then((r) => {
        if (!r.ok) throw new Error(r.errorCode ?? "E_PLAYBACK_FAILED");
      }).catch((err) => {
        patch({ isLoading: false, error: "播放失败：" + (err instanceof Error ? err.message : String(err)) });
      });

      // 异步补歌词（与 agent 播放路径共享，local- 曲目内部跳过）
      fetchLyrics(track.encryptedId);
    },
    [api, patch, fetchLyrics],
  );

  // ── 计算下一首/上一首索引 ──────────────────────────────────
  const computeNextIndex = useCallback((s: PlaybackState): number => {
    if (s.playbackMode === "shuffle" && s.queue.length > 1) {
      let ni: number;
      do {
        ni = Math.floor(Math.random() * s.queue.length);
      } while (ni === s.queueIndex);
      return ni;
    }
    return getNextQueueIndex({
      queueLength: s.queue.length,
      queueIndex: s.queueIndex,
      playbackMode: s.playbackMode,
    });
  }, []);

  const computePrevIndex = useCallback((s: PlaybackState): number => {
    if (s.queue.length === 0) return -1;
    if (s.queueIndex <= 0) return s.playbackMode === "all" ? s.queue.length - 1 : 0;
    return s.queueIndex - 1;
  }, []);

  // ── 切歌单时模式随歌单类型切换 ──────────────────────────────
  const applyModeForPlaylist = useCallback((playlistId: string) => {
    const mode =
      playlistId === LOCAL_CACHE_PLAYLIST_ID ? persistedCacheRef.current : persistedOnlineRef.current;
    setState((s) => (s.playbackMode === mode ? s : { ...s, playbackMode: mode }));
  }, []);

  // ── actions（MusicPlayer 组件消费） ──────────────────────────
  const actions: PlaybackActions = useMemo(
    () => ({
      playTrack,
      togglePlayPause() {
        if (!api) return;
        // 刚打开播放器时 currentTrack 还是空的。原来这里直接 return，
        // 于是点播放毫无反应——mpv 里没有任何文件，toggle 无从生效。
        // 这时应当从队列开头真正加载一首歌。
        const startIndex = pickPlayStartIndex({
          hasCurrentTrack: Boolean(state.currentTrack),
          isCurrentTrackLoaded:
            Boolean(state.currentTrack) && loadedTrackIdRef.current === state.currentTrack?.encryptedId,
          queueLength: state.queue.length,
          queueIndex: state.queueIndex,
        });
        if (startIndex !== null) {
          const first = state.queue[startIndex];
          if (first) playTrack(first);
          return;
        }
        if (!state.currentTrack) return;
        // 播完停在结尾（keep-open）→ 点播放 = 重播当前曲（缓存秒开）
        if (endedRef.current && !state.isPlaying) {
          endedRef.current = false;
          playTrack(state.currentTrack);
          return;
        }
        void api.playbackToggle().catch(() => { /* ignore */ });
      },
      next() {
        const ni = computeNextIndex(state);
        if (ni < 0) return;
        const t = state.queue[ni];
        if (t) playTrack(t);
      },
      prev() {
        if (state.positionMs > 3000) {
          if (api) void api.playbackSeek(0).catch(() => { /* ignore */ });
          patch({ positionMs: 0 });
          return;
        }
        const ni = computePrevIndex(state);
        if (ni < 0) return;
        const t = state.queue[ni];
        if (t) playTrack(t);
      },
      seek(positionMs) {
        const clamped = Math.max(0, Math.min(positionMs, state.durationMs));
        patch({ positionMs: clamped });
        if (api) void api.playbackSeek(Math.round(clamped / 1000)).catch(() => { /* ignore */ });
      },
      setVolume(volume) {
        const clamped = Math.max(0, Math.min(100, Math.round(volume)));
        patch({ volume: clamped, isMuted: clamped === 0 });
        if (api) void api.playbackVolume(clamped).catch(() => { /* ignore */ });
      },
      toggleMute() {
        if (state.isMuted) {
          patch({ isMuted: false, volume: volumeBeforeMute.current || 70 });
          if (api) void api.playbackVolume(volumeBeforeMute.current || 70).catch(() => { /* ignore */ });
        } else {
          volumeBeforeMute.current = state.volume;
          patch({ isMuted: true });
          if (api) void api.playbackVolume(0).catch(() => { /* ignore */ });
        }
      },
      addToQueue(track) {
        const current = stateRef.current;
        if (current.queue.some((t) => t.encryptedId === track.encryptedId)) return;
        const queue = [...current.queue, { ...track }];
        setState((s) => ({ ...s, queue }));
        void api?.syncPlaybackSession({
          queue: queue.map(toSessionTrack),
          queueIndex: current.queueIndex,
          playbackMode: current.playbackMode,
          playlistId: activePlaylistIdRef.current,
        });
      },
      removeFromQueue(index) {
        const current = stateRef.current;
        if (index < 0 || index >= current.queue.length) return;
        const queue = current.queue.filter((_, i) => i !== index);
        let queueIndex = current.queueIndex;
        let currentTrack = current.currentTrack;
        let isPlaying = current.isPlaying;
        let positionMs = current.positionMs;
        const removedCurrent = index === current.queueIndex;
        if (index < queueIndex) queueIndex -= 1;
        if (removedCurrent) {
          currentTrack = null;
          isPlaying = false;
          positionMs = 0;
          queueIndex = Math.min(queueIndex, queue.length - 1);
          void api?.playbackStop();
        }
        setState((s) => ({ ...s, queue, queueIndex, currentTrack, isPlaying, positionMs }));
        void api?.syncPlaybackSession({
          queue: queue.map(toSessionTrack),
          queueIndex,
          playbackMode: current.playbackMode,
          playlistId: activePlaylistIdRef.current,
        });
      },
      loadPlaylist(playlist) {
        applyModeForPlaylist(playlist.id);
        setActivePlaylistId(playlist.id);
        void loadPlaylistTracks(playlist);
      },
      cycleMode() {
        const isCache = activePlaylistId === LOCAL_CACHE_PLAYLIST_ID;
        const set = isCache ? CACHE_MODES : ONLINE_MODES;
        const idx = set.indexOf(state.playbackMode);
        const next = set[(idx + 1) % set.length];
        patch({ playbackMode: next });
        const current = stateRef.current;
        void api?.syncPlaybackSession({
          queue: current.queue.map(toSessionTrack),
          queueIndex: current.queueIndex,
          playbackMode: next,
          playlistId: activePlaylistId,
        });
        if (isCache) {
          persistedCacheRef.current = next;
          savePersistedMode(LS_MODE_CACHE, next);
        } else {
          persistedOnlineRef.current = next;
          savePersistedMode(LS_MODE_ONLINE, next);
        }
      },
      toggleFavorite(track) {
        if (!api) return;
        const newFav = !track.isFavorite;
        setState((s) => ({
          ...s,
          queue: s.queue.map((t) =>
            t.encryptedId === track.encryptedId ? { ...t, isFavorite: newFav } : t,
          ),
          currentTrack:
            s.currentTrack?.encryptedId === track.encryptedId
              ? { ...s.currentTrack, isFavorite: newFav }
              : s.currentTrack,
        }));
        void api.toggleFavorite(track.encryptedId, newFav).catch(() => { /* ignore */ });
      },
    }),
    [api, state, patch, playTrack, computeNextIndex, computePrevIndex, loadPlaylistTracks, activePlaylistId, applyModeForPlaylist],
  );

  // ── 搜索（250ms 防抖） ──────────────────────────────────────
  const handleSearch = useCallback((query: string) => {
    if (searchTimer.current) window.clearTimeout(searchTimer.current);
    if (!query.trim()) {
      setSearchResults([]);
      setIsSearching(false);
      return;
    }
    setIsSearching(true);
    searchTimer.current = window.setTimeout(async () => {
      if (!api) return;
      try {
        const r = await api.search(query, 20);
        if (r.ok && r.data) {
          const data = r.data as { tracks?: BackendTrack[] };
          setSearchResults((data.tracks ?? []).map(normalizeTrack));
        } else {
          setSearchResults([]);
        }
      } catch (err) {
        console.warn("[music] search failed", err);
        setSearchResults([]);
      } finally {
        setIsSearching(false);
      }
    }, 250);
  }, [api]);

  const handleSelectPlaylist = useCallback((playlist: Playlist) => {
    actions.loadPlaylist(playlist);
  }, [actions]);

  // ── 删除缓存曲目（正在播放的会被后端拒绝） ──────────────────
  const removeCachedTrack = useCallback(
    async (track: Track) => {
      if (!api) return;
      try {
        const r = await api.removeCachedTrack(track.encryptedId);
        if (!r.ok) {
          patch({
            error: r.errorCode === "E_CACHE_TRACK_PLAYING" ? "正在播放，无法删除" : "删除失败，请稍后再试",
          });
          return;
        }
        // 本地立即移除（onCacheUpdated 兜底同步）
        setCacheTracks((ts) => ts.filter((t) => t.encryptedId !== track.encryptedId));
      } catch {
        patch({ error: "删除失败，请稍后再试" });
      }
    },
    [api, patch],
  );

  // ── 导入本地音乐（主进程弹系统文件框，完成后 onCacheUpdated 自动刷新） ──
  const importLocalTracks = useCallback(async () => {
    if (!api) return;
    try {
      await api.importLocalTracks();
    } catch {
      patch({ error: "导入失败，请稍后再试" });
    }
  }, [api, patch]);

  // ── 窗口控制（无框窗口，通过 preload 暴露的 IPC 派发） ────
  const minimizeWindow = useCallback(() => {
    api?.minimizeWindow();
  }, [api]);

  const closeWindow = useCallback(() => {
    api?.closeWindow();
  }, [api]);

  // ── loading 阶段：只显示加载动画，无窗口按钮 ─────────────
  if (loading) {
    return <LoadingScreen />;
  }

  // 播放器可用的条件是「有东西可放」，而不是「登录了网易云」：
  // 本地导入的曲目完全不依赖网易云，之前把两者绑在一起，导致只用本地音乐
  // 的用户永远看到「音乐服务未就绪」。
  if (!canOpenPlayer({ neteaseSignedIn: loginReady, localTrackCount: cacheTracks.length })) {
    return (
      <div className="mp-shell">
        <div className="mp-window-chrome">
          <button type="button" className="win-btn" onClick={minimizeWindow} title="最小化"><Minus size={14} /></button>
          <button type="button" className="win-btn win-btn--close" onClick={closeWindow} title="关闭"><X size={14} /></button>
        </div>
        {kernelMissing && <MpvKernelWarning />}
        <div className="mp-not-ready">
          <p>还没有可播放的音乐</p>
          <p className="mp-not-ready-hint">在「设置 → 插件 → 音乐工具」里导入本地音乐，或扫码登录网易云</p>
        </div>
      </div>
    );
  }

  return (
    <div className="mp-shell">
      <div className="mp-window-chrome">
        <button type="button" className="win-btn" onClick={minimizeWindow} title="最小化"><Minus size={14} /></button>
        <button type="button" className="win-btn win-btn--close" onClick={closeWindow} title="关闭"><X size={14} /></button>
      </div>
      {kernelMissing && <MpvKernelWarning />}
      <MusicPlayer
        state={state}
        actions={actions}
        playlists={playlists}
        activePlaylistId={activePlaylistId}
        onSelectPlaylist={handleSelectPlaylist}
        modeSet={activePlaylistId === LOCAL_CACHE_PLAYLIST_ID ? "cache" : "online"}
        onImportLocalTracks={importLocalTracks}
        onRemoveCachedTrack={removeCachedTrack}
        searchResults={searchResults}
        isSearching={isSearching}
        onSearch={handleSearch}
      />
    </div>
  );
}

export default App;
