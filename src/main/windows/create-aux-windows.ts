import { app, BrowserWindow, screen } from "electron";
import * as path from "path";
import { IPC } from "../../shared/ipc-channels";
import { isDev } from "../env";
import { DEFAULT_WORKSPACE_WINDOW_SIZE } from "../window-layout";
import { loadGeneralSettings } from "../settings/settings-facade";
import { stopCall, setCallWindow } from "../call/call-manager";
import { attachContextMenu } from "./context-menu";
import { getWorkspaceInitialBounds } from "./workspace-window-bounds";
import {
  callWindow,
  getCurrentAppIconPath,
  reactChatSession,
  reactChatWindow,
  setCallWindowLocal,
  setReactChatWindow,
  setStickerManagerWindow,
  showWindowWhenStartupReady,
  stickerManagerWindow,
} from "./window-state";

/**
 * React 聊天窗口句柄：壳对象 + 显式页面加载 + 显示。
 * load() 只允许由启动编排器在全部 IPC 处理器注册后调用。
 */
export interface ReactChatWindowHandle {
  window: BrowserWindow;
  load(sessionId?: string): Promise<void>;
  show(sessionId?: string): void;
}

export function persistedWindowState(
  name: string,
  enabled: boolean,
  persistDisplayMode = false,
): { name?: string; windowStatePersistence?: Electron.WindowStatePersistence } {
  return enabled
    ? { name, windowStatePersistence: { bounds: true, displayMode: persistDisplayMode } }
    : {};
}

/**
 * 创建/复用 React 聊天窗口壳。
 * 只构造 BrowserWindow 对象并登记全局状态，禁止调用 loadURL/loadFile ——
 * 页面加载由 loadReactChatWindowPage 在核心 IPC 就绪后执行。
 */
export function createReactChatWindowShell(): BrowserWindow {
  // 已有窗口 → 复用（壳不重复创建）
  if (reactChatWindow && !reactChatWindow.isDestroyed()) {
    return reactChatWindow;
  }

  // 新建窗口：dispatcher 重置；pending 仅服务于"未 ready 期间又收到请求"
  reactChatSession.reset();

  const workArea = screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).workArea;
  const bounds = getWorkspaceInitialBounds(workArea);
  const rememberWindowState = loadGeneralSettings().rememberWindowState;
  const window = new BrowserWindow({
    ...persistedWindowState("cyrene.workspace", rememberWindowState, true),
    ...bounds,
    minWidth: Math.min(960, workArea.width),
    minHeight: Math.min(540, workArea.height),
    title: "Cyrene · 聊天",
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
  setReactChatWindow(window);
  attachContextMenu(window);

  if (rememberWindowState) {
    window.once("ready-to-show", () => {
      if (window.isMaximized()) return;
      const restored = window.getBounds();
      if (
        restored.width === DEFAULT_WORKSPACE_WINDOW_SIZE.width &&
        restored.height === DEFAULT_WORKSPACE_WINDOW_SIZE.height
      ) {
        window.setBounds(bounds);
      }
    });
  }

  window.webContents.on("did-start-loading", () => {
    reactChatSession.markLoading();
  });

  window.on("closed", () => {
    // 闭包引用 + 仅当当前全局仍指向自己时才清理，避免旧窗口 closed 误清新窗口
    if (reactChatWindow === window) {
      setReactChatWindow(null);
      reactChatSession.reset();
    }
  });
  return window;
}

/**
 * 加载聊天渲染页面。search 字段必须含前导 "?"（Electron url.format() 要求）。
 * 失败原样向上抛（由 startup-window-load 统一判定致命性），不再吞掉。
 */
export function loadReactChatWindowPage(window: BrowserWindow, sessionId?: string): Promise<void> {
  const search = sessionId ? `?sessionId=${encodeURIComponent(sessionId)}` : undefined;
  const indexPath = path.join(app.getAppPath(), "dist", "renderer", "react", "index.html");

  if (isDev) {
    return window.loadURL(`http://localhost:5173/react/${search ?? ""}`);
  }
  return window.loadFile(indexPath, search ? { search } : undefined);
}

/**
 * 显示聊天窗口（不加载页面）；带 sessionId 时走会话分发。
 */
export function showReactChatWindow(sessionId?: string): void {
  const win = reactChatWindow;
  if (!win || win.isDestroyed()) return;
  win.show();
  win.focus();
  if (sessionId) dispatchOrQueueReactSession(sessionId);
}

export function dispatchOrQueueReactSession(sessionId: string): void {
  const win = reactChatWindow;
  if (!win?.webContents) return;
  const immediate = reactChatSession.queueOrTake(sessionId);
  if (immediate) {
    win.webContents.send(IPC.CHATS_REACT_SWITCH_SESSION, immediate);
  }
}

/**
 * 创建/复用表情包管理窗口。
 */
export async function createStickerManagerWindow(): Promise<{ ok: boolean; error?: string }> {
  if (stickerManagerWindow && !stickerManagerWindow.isDestroyed()) {
    stickerManagerWindow.show();
    stickerManagerWindow.focus();
    stickerManagerWindow.moveTop();
    return { ok: true };
  }

  const parentBounds = reactChatWindow?.getBounds();
  const display = screen.getPrimaryDisplay();
  const { x: dx, y: dy, width: dw, height: dh } = display.workArea;
  const width = 520;
  const height = 420;
  const window = new BrowserWindow({
    x: parentBounds ? parentBounds.x + Math.max(24, Math.floor((parentBounds.width - width) / 2)) : dx + Math.max(0, Math.floor((dw - width) / 2)),
    y: parentBounds ? parentBounds.y + 64 : dy + Math.max(0, Math.floor((dh - height) / 2)),
    width,
    height,
    minWidth: 460,
    minHeight: 360,
    title: "表情包管理",
    backgroundColor: "#00000000",
    autoHideMenuBar: true,
    show: false,
    frame: false,
    transparent: true,
    resizable: true,
    parent: reactChatWindow ?? undefined,
    webPreferences: {
      preload: path.join(app.getAppPath(), "dist", "preload", "preload", "index.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });
  setStickerManagerWindow(window);
  attachContextMenu(window);

  window.webContents.on("did-fail-load", (_event, errorCode, errorDescription, validatedURL) => {
    console.error("[stickers] did-fail-load", { errorCode, errorDescription, validatedURL });
  });

  try {
    if (isDev) {
      await window.loadURL("http://localhost:5173/sticker-manager/");
    } else {
      await window.loadFile(
        path.join(app.getAppPath(), "dist", "renderer", "sticker-manager", "index.html")
      );
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("[stickers] failed to load sticker manager window", error);
    window.close();
    return { ok: false, error: message };
  }

  window.once("ready-to-show", () => {
    showWindowWhenStartupReady(window);
    window.focus();
    window.moveTop();
  });

  window.on("closed", () => {
    setStickerManagerWindow(null);
  });

  return { ok: true };
}

/**
 * 创建/复用语音通话窗口（450×800 竖屏，语音通话）。
 */
export function createCallWindow(): void {
  if (callWindow && !callWindow.isDestroyed()) {
    callWindow.show();
    callWindow.focus();
    return;
  }

  const display = screen.getPrimaryDisplay();
  const { width: dw, height: dh } = display.workArea;
  const CALL_W = 420;
  const CALL_H = 800;
  const cx = Math.max(0, Math.floor((dw - CALL_W) / 2));
  const cy = Math.max(0, Math.floor((dh - CALL_H) / 2));

  const window = new BrowserWindow({
    x: display.workArea.x + cx,
    y: display.workArea.y + cy,
    width: CALL_W,
    height: CALL_H,
    minWidth: 420,
    minHeight: 600,
    title: "Cyrene · 语音通话",
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
  setCallWindowLocal(window);
  attachContextMenu(window);

  if (isDev) {
    window.loadURL("http://localhost:5173/call-react/");
  } else {
    window.loadFile(path.join(app.getAppPath(), "dist", "renderer", "call-react", "index.html"));
  }

  window.once("ready-to-show", () => {
    showWindowWhenStartupReady(window);
  });

  window.on("closed", () => {
    setCallWindowLocal(null);
    stopCall();
    setCallWindow(null);
  });

  // 绑定给 call-manager
  setCallWindow(window);
}
