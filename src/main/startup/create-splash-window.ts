import { app, BrowserWindow, screen } from "electron";
import path from "node:path";
import { startStartupAnimation } from "./startup-animation";

export interface CreateSplashWindowContext {
  isDev: boolean;
  /** 窗口实际 show() 时回调（单调时钟，默认 performance.now()），用于最短展示时长计算。 */
  onShown?(at: number): void;
  /** 单调时钟注入（测试用）。 */
  now?: () => number;
}

const SPLASH_SIZE = 520;

/**
 * 创建 Loading（splash）窗口。创建失败返回 null（启动编排器会跳过最短展示时长，
 * 继续以聊天核心就绪条件推进），不让 Loading 问题阻塞启动。
 */
export function createSplashWindow(ctx: CreateSplashWindowContext): BrowserWindow | null {
  const animation = startStartupAnimation({
    fallback: (window) => showLoading(window, ctx),
    onShown: () => ctx.onShown?.((ctx.now ?? (() => performance.now()))()),
  });
  if (animation.status === "starting") return animation.window;
  if (animation.status === "already-running") return null;
  try {
    const { width: screenWidth, height: screenHeight } = screen.getPrimaryDisplay().workAreaSize;

    const window = new BrowserWindow({
      width: SPLASH_SIZE,
      height: SPLASH_SIZE,
      x: Math.round((screenWidth - SPLASH_SIZE) / 2),
      y: Math.round((screenHeight - SPLASH_SIZE) / 2),
      transparent: true,
      frame: false,
      resizable: false,
      movable: false,
      minimizable: false,
      maximizable: false,
      alwaysOnTop: true,
      skipTaskbar: true,
      hasShadow: false,
      show: false,
      webPreferences: {
        // 闪屏窗口不需要 Node/IPC 访问
        nodeIntegration: false,
        contextIsolation: true,
      },
    });

    showLoading(window, ctx);

    return window;
  } catch (error) {
    console.error("[Splash] Failed to create splash window:", error);
    return null;
  }
}

/** Also used for asynchronous video/load failure; retains the original reveal-owned window. */
function showLoading(window: BrowserWindow, ctx: CreateSplashWindowContext): void {
  if (window.isDestroyed()) return;
  const area = screen.getPrimaryDisplay().workArea;
  window.setBounds({ x: area.x + Math.round((area.width - SPLASH_SIZE) / 2),
    y: area.y + Math.round((area.height - SPLASH_SIZE) / 2), width: SPLASH_SIZE, height: SPLASH_SIZE });
  window.setIgnoreMouseEvents(true);
  const show = () => {
    if (window.isDestroyed()) return;
    // Fallback must not steal focus after the user switched to another app.
    window.showInactive();
    ctx.onShown?.((ctx.now ?? (() => performance.now()))());
  };
  const loaded = ctx.isDev ? window.loadURL("http://localhost:5173/splash.html")
    : window.loadFile(path.join(app.getAppPath(), "dist", "renderer", "splash.html"));
  // ready-to-show may already have fired for the video page; use this navigation's completion.
  void loaded.then(show).catch((error) => console.error("[Splash] Failed to load Loading:", error));
}
