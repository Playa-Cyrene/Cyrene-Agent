import { BrowserWindow } from "electron";
import { IPC } from "../../shared/ipc-channels";
import { createIpcScope, type IpcScope } from "../application/ipc-scope";
import { clearUsage, getUsageReport } from "../token-usage-store";
import {
  sidebarWindow,
  tasksWindow,
  settingsWindow,
  musicPlayerWindow,
} from "./window-state";
import type { WindowManager } from "./window-manager";

export interface WindowSystemIpcDependencies {
  get windowManager(): WindowManager | null;
  /** 传入共享 scope 以便退出时统一注销；缺省时使用独立 scope。 */
  ipc?: IpcScope;
  /**
   * 退出应用。由组合根注入（`() => app.quit()`），使本模块不直接依赖 electron app，
   * 同时保留 before-quit 受控退出链路。
   */
  quit(): void;
}

/**
 * 注册窗口控制与系统入口相关的 IPC handler。
 *
 * 注意：TOKEN_USAGE_GET 本质属于用量统计领域，当前仅因改动最小而临时
 * 挂靠在此；后续拆分统计模块时应二次归位。
 */
export function registerWindowSystemIpc(deps: WindowSystemIpcDependencies): void {
  const ipc = deps.ipc ?? createIpcScope();
  ipc.handle(IPC.WINDOW_SET_INTERACTIVE, (_event, interactive: boolean) => {
    deps.windowManager?.setPetWindowInteractive(interactive);
  });

  ipc.on(IPC.WINDOW_MOVE, (_event, dx: number, dy: number) => {
    deps.windowManager?.movePetWindowRelative(dx, dy);
  });

  ipc.on(IPC.WINDOW_MOVE_TO, (_event, x: number, y: number) => {
    deps.windowManager?.movePetWindowTo(x, y);
  });

  ipc.on(IPC.WINDOW_SET_DRAGGING, (_event, isDragging: boolean) => {
    deps.windowManager?.setPetWindowDragging(isDragging);
  });

  // 桌宠窗口自身的最小化/隐藏入口。两者曾随 index.ts 拆分（711a40d9）被误删，
  // preload 侧 window.cyrene.minimize()/hide() 一直保留，此处按原语义补回。
  ipc.on(IPC.WINDOW_MINIMIZE, () => {
    deps.windowManager?.minimizePetWindow();
  });

  ipc.on(IPC.WINDOW_CLOSE, () => {
    deps.windowManager?.hidePetWindow();
  });

  ipc.handle(IPC.WINDOW_CAPTURE_FRAME, async () => deps.windowManager?.capturePetWindowFrame() ?? null);
  ipc.handle(IPC.WINDOW_GET_CURSOR_POSITION, () => deps.windowManager?.getCursorScreenPosition() ?? { x: 0, y: 0 });

  ipc.on(IPC.SIDEBAR_MINIMIZE, () => {
    sidebarWindow?.minimize();
  });

  ipc.on(IPC.SIDEBAR_CLOSE, () => {
    sidebarWindow?.close();
  });

  // 状态栏窗口置顶 toggle：返回切换后的新状态（true=已置顶）
  ipc.handle(IPC.SIDEBAR_TOGGLE_ALWAYS_ON_TOP, () => {
    if (!sidebarWindow) return false;
    const next = !sidebarWindow.isAlwaysOnTop();
    sidebarWindow.setAlwaysOnTop(next, next ? "screen-saver" : "normal");
    return next;
  });

  ipc.on(IPC.SIDEBAR_OPEN_TASKS, () => {
    deps.windowManager?.createTasksWindow();
  });

  ipc.on(IPC.SIDEBAR_OPEN_SETTINGS, (_event, section?: string) => {
    deps.windowManager?.createSettingsWindow(section);
  });

  ipc.on(IPC.SIDEBAR_OPEN_CALL, () => {
    deps.windowManager?.createCallWindow();
  });

  ipc.on(IPC.TASKS_MINIMIZE, () => {
    tasksWindow?.minimize();
  });

  ipc.on(IPC.TASKS_CLOSE, () => {
    tasksWindow?.close();
  });
  ipc.on(IPC.SETTINGS_MINIMIZE, () => {
    settingsWindow?.minimize();
  });

  ipc.on(IPC.SETTINGS_CLOSE, () => {
    settingsWindow?.close();
  });

  // 音乐播放器窗口控制
  ipc.on(IPC.MUSIC_PLAYER_MINIMIZE, () => {
    musicPlayerWindow?.minimize();
  });
  ipc.on(IPC.MUSIC_PLAYER_CLOSE, () => {
    musicPlayerWindow?.close();
  });
  ipc.handle(IPC.MUSIC_OPEN_PLAYER, () => {
    deps.windowManager?.createMusicPlayerWindow();
    return true;
  });
  ipc.handle(IPC.MUSIC_OPEN_SETTINGS, (_event, section?: string) => {
    deps.windowManager?.createSettingsWindow(section);
    return true;
  });

  ipc.on(IPC.SETTINGS_OPEN_CHROME_GPU, async () => {
    const win = new BrowserWindow({ width: 1024, height: 768 });
    win.loadURL("chrome://gpu");
    win.show();
  });

  // Token 用量查询 IPC（临时挂靠，后续归到统计模块）
  // 上限 366：用量统计页的 52 周热力图需要一整年的按天数据。
  ipc.handle(IPC.TOKEN_USAGE_GET, (_event, days: number) => {
    return getUsageReport(Math.max(1, Math.min(366, Number(days) || 7)));
  });
  ipc.handle(IPC.TOKEN_USAGE_CLEAR, () => {
    clearUsage();
  });

  ipc.on(IPC.LIVE2D_SPEECH_PREPARE, () => {
    deps.windowManager?.sendToPetWindow(IPC.LIVE2D_SPEECH_PREPARE);
  });
  ipc.on(IPC.LIVE2D_MOUTH_START, (_event, payload: { durationMs?: number }) => {
    deps.windowManager?.sendToPetWindow(IPC.LIVE2D_MOUTH_START, { durationMs: Number(payload?.durationMs ?? 0) });
  });
  ipc.on(IPC.LIVE2D_MOUTH_STOP, () => {
    deps.windowManager?.sendToPetWindow(IPC.LIVE2D_MOUTH_STOP);
  });

  // 退出是应用级请求而非窗口操作：deps.quit() 最终走 app.quit()，
  // 触发 before-quit 受控退出，由 ShutdownCoordinator 完成固定阶段清理后再退出。
  ipc.on(IPC.APP_QUIT, () => {
    deps.quit();
  });
}
