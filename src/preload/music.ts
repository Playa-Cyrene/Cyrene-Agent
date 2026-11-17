import { startupIpc as ipcRenderer } from "./startup-ipc";
import { contextBridge } from "electron";
import { IPC } from "../shared/ipc-channels";

export function exposeMusicApi() {
  contextBridge.exposeInMainWorld("music", {
    getStatus: () => ipcRenderer.invoke(IPC.MUSIC_GET_STATUS),
    beginLogin: () => ipcRenderer.invoke(IPC.MUSIC_BEGIN_LOGIN),
    cancelLogin: () => ipcRenderer.invoke(IPC.MUSIC_CANCEL_LOGIN),
    logout: () => ipcRenderer.invoke(IPC.MUSIC_LOGOUT),
    getDaily: () => ipcRenderer.invoke(IPC.MUSIC_GET_DAILY),
    search: (keyword: string, limit?: number) => ipcRenderer.invoke(IPC.MUSIC_SEARCH, { keyword, limit }),
    playTrack: (trackId: string) => ipcRenderer.invoke(IPC.MUSIC_PLAY_TRACK, trackId),
    playPlaylist: (playlistId: string) => ipcRenderer.invoke(IPC.MUSIC_PLAY_PLAYLIST, playlistId),
    detectPlayer: () => ipcRenderer.invoke(IPC.MUSIC_DETECT_PLAYER),
    getOpenapiConfig: () => ipcRenderer.invoke(IPC.MUSIC_GET_OPENAPI_CONFIG),
    saveOpenapiConfig: (config: { appId: string; privateKey: string }) =>
      ipcRenderer.invoke(IPC.MUSIC_SAVE_OPENAPI_CONFIG, config),
    // ── 播放控制（mpv） ──
    playbackPlay: () => ipcRenderer.invoke(IPC.MUSIC_PLAYBACK_PLAY),
    playbackPause: () => ipcRenderer.invoke(IPC.MUSIC_PLAYBACK_PAUSE),
    playbackToggle: () => ipcRenderer.invoke(IPC.MUSIC_PLAYBACK_TOGGLE),
    playbackSeek: (seconds: number) => ipcRenderer.invoke(IPC.MUSIC_PLAYBACK_SEEK, seconds),
    playbackVolume: (vol: number) => ipcRenderer.invoke(IPC.MUSIC_PLAYBACK_VOLUME, vol),
    playbackStop: () => ipcRenderer.invoke(IPC.MUSIC_PLAYBACK_STOP),
    playbackNext: () => ipcRenderer.invoke(IPC.MUSIC_PLAYBACK_NEXT),
    playbackPrev: () => ipcRenderer.invoke(IPC.MUSIC_PLAYBACK_PREV),
    getPlaybackSession: () => ipcRenderer.invoke(IPC.MUSIC_GET_PLAYBACK_SESSION),
    playSessionTrack: (payload: unknown) => ipcRenderer.invoke(IPC.MUSIC_PLAY_SESSION_TRACK, payload),
    syncPlaybackSession: (payload: unknown) => ipcRenderer.invoke(IPC.MUSIC_SYNC_PLAYBACK_SESSION, payload),
    getLyrics: (encryptedId: string) => ipcRenderer.invoke(IPC.MUSIC_GET_LYRICS, { encryptedId }),
    toggleFavorite: (encryptedId: string, favorite: boolean) =>
      ipcRenderer.invoke(IPC.MUSIC_TOGGLE_FAVORITE, { encryptedId, favorite }),
    // 用户歌单（播放器窗口顶部 chips + loadPlaylist）
    getMyPlaylists: () => ipcRenderer.invoke(IPC.MUSIC_GET_MY_PLAYLISTS),
    getPlaylistDetail: (playlistId: string) =>
      ipcRenderer.invoke(IPC.MUSIC_GET_PLAYLIST_DETAIL, playlistId),
    // ── 本地缓存歌单（边播边存 + 用户导入） ──
    getCachedTracks: () => ipcRenderer.invoke(IPC.MUSIC_GET_CACHED_TRACKS),
    removeCachedTrack: (trackId: string) =>
      ipcRenderer.invoke(IPC.MUSIC_REMOVE_CACHED_TRACK, trackId),
    importLocalTracks: () => ipcRenderer.invoke(IPC.MUSIC_IMPORT_LOCAL_TRACKS),
    importLocalFolder: () => ipcRenderer.invoke(IPC.MUSIC_IMPORT_LOCAL_FOLDER),
    // 窗口控制（播放器窗口无框）
    openPlayer: () => ipcRenderer.invoke(IPC.MUSIC_OPEN_PLAYER),
    openSettings: (section?: string) => ipcRenderer.invoke(IPC.MUSIC_OPEN_SETTINGS, section),
    minimizeWindow: () => ipcRenderer.send(IPC.MUSIC_PLAYER_MINIMIZE),
    closeWindow: () => ipcRenderer.send(IPC.MUSIC_PLAYER_CLOSE),
    // ── 事件订阅 ──
    onStateChanged: (h: (s: unknown) => void) => {
      const listener = (_: unknown, s: unknown) => h(s);
      ipcRenderer.on(IPC.MUSIC_STATE_CHANGED, listener);
      return () => ipcRenderer.removeListener(IPC.MUSIC_STATE_CHANGED, listener);
    },
    onPlaybackState: (h: (s: unknown) => void) => {
      const listener = (_: unknown, s: unknown) => h(s);
      ipcRenderer.on(IPC.MUSIC_PLAYBACK_STATE, listener);
      return () => ipcRenderer.removeListener(IPC.MUSIC_PLAYBACK_STATE, listener);
    },
    onPlaybackSessionChanged: (h: (s: unknown) => void) => {
      const listener = (_: unknown, s: unknown) => h(s);
      ipcRenderer.on(IPC.MUSIC_PLAYBACK_SESSION_CHANGED, listener);
      return () => ipcRenderer.removeListener(IPC.MUSIC_PLAYBACK_SESSION_CHANGED, listener);
    },
    onCacheUpdated: (h: () => void) => {
      const listener = () => h();
      ipcRenderer.on(IPC.MUSIC_CACHE_UPDATED, listener);
      return () => ipcRenderer.removeListener(IPC.MUSIC_CACHE_UPDATED, listener);
    },
  });
}
