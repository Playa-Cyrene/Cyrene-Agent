import { app, BrowserWindow, screen } from "electron";
import * as path from "path";
import { isDev } from "../env";
import { loadGeneralSettings } from "../settings/settings-facade";
import { persistedWindowState } from "./create-aux-windows";
import { attachContextMenu } from "./context-menu";
import { getCurrentAppIconPath, setMusicPlayerWindow, musicPlayerWindow } from "./window-state";

/**
 * 创建/复用音乐播放器窗口。
 *
 * 窗口尺寸采用音乐播放器正式设计（960×640 卡片）。
 * 复用 settings/sidebar 那一套窗口工厂模式：已存在则 show+focus。
 */
export function createMusicPlayerWindow(): void {
  if (musicPlayerWindow && !musicPlayerWindow.isDestroyed()) {
    musicPlayerWindow.show();
    musicPlayerWindow.focus();
    return;
  }

  const width = 960;
  const height = 660;
  const display = screen.getPrimaryDisplay();
  const { x: dx, y: dy, width: dw, height: dh } = display.workArea;
  const rememberWindowState = loadGeneralSettings().rememberWindowState;

  const window = new BrowserWindow({
    ...persistedWindowState("cyrene.music-player", rememberWindowState),
    x: dx + Math.max(0, Math.floor((dw - width) / 2)),
    y: dy + Math.max(0, Math.floor((dh - height) / 2)),
    width,
    height,
    minWidth: 720,
    minHeight: 520,
    title: "Cyrene · 音乐",
    icon: getCurrentAppIconPath(),
    backgroundColor: "#00000000",
    autoHideMenuBar: true,
    show: false,
    frame: false,
    transparent: true,
    resizable: true,
    webPreferences: {
      preload: path.join(app.getAppPath(), "dist", "preload", "preload", "index.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });
  setMusicPlayerWindow(window);
  attachContextMenu(window);

  if (isDev) {
    void window
      .loadURL("http://localhost:5173/music/")
      .catch((error) => console.error("[MusicPlayerWindow] loadURL failed:", error));
  } else {
    void window
      .loadFile(path.join(app.getAppPath(), "dist", "renderer", "music", "index.html"))
      .catch((error) => console.error("[MusicPlayerWindow] loadFile failed:", error));
  }

  window.once("ready-to-show", () => {
    if (!window.isDestroyed()) window.show();
    if (isDev) window.webContents.openDevTools({ mode: "detach" });
  });

  window.on("closed", () => {
    if (musicPlayerWindow === window) {
      setMusicPlayerWindow(null);
    }
  });
}
