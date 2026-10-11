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
  if (startStartupAnimation()) return null;
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

    window.setIgnoreMouseEvents(true);

    if (ctx.isDev) {
      // Vite dev server 会把 public 目录下的文件挂在根路径
      window.loadURL("http://localhost:5173/splash.html").catch((err) => {
        console.error("[Splash] Failed to load dev URL:", err);
      });
    } else {
      window.loadFile(path.join(app.getAppPath(), "dist", "renderer", "splash.html")).catch((err) => {
        console.error("[Splash] Failed to load splash.html:", err);
      });
    }

    window.once("ready-to-show", () => {
      if (!window.isDestroyed()) {
        window.show();
        window.focus();
        // 最短展示时长从实际 show() 时刻起算
        try {
          ctx.onShown?.((ctx.now ?? (() => performance.now()))());
        } catch (err) {
          console.error("[Splash] onShown callback failed:", err);
        }
      }
    });

    return window;
  } catch (error) {
    console.error("[Splash] Failed to create splash window:", error);
    return null;
  }
}
