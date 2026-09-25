import { BrowserWindow } from "electron";
import {
  createReactChatSessionDispatcher,
  type ReactChatSessionDispatcher,
} from "../react-chat-session-dispatcher";

/**
 * 辅助窗口全局状态。
 *
 * 把原本散落在 index.ts 顶层的窗口引用集中到这里，方便窗口工厂函数
 * 与 IPC handler 共享同一份引用，同时保持单一可预测的状态来源。
 *
 * 注意：ESM 的 `export let` 在外部模块是只读绑定，需要修改时请使用下面
 * 配套的 setter 函数，避免 TS2632 编译错误与循环依赖。
 */
export let reactChatWindow: BrowserWindow | null = null;
export let stickerManagerWindow: BrowserWindow | null = null;
export let callWindow: BrowserWindow | null = null;
export let musicPlayerWindow: BrowserWindow | null = null;
export let toastWindow: BrowserWindow | null = null;

export function setReactChatWindow(win: BrowserWindow | null): void {
  reactChatWindow = win;
}

export function setToastWindow(win: BrowserWindow | null): void {
  toastWindow = win;
}

export function setMusicPlayerWindow(win: BrowserWindow | null): void {
  musicPlayerWindow = win;
}

export function setStickerManagerWindow(win: BrowserWindow | null): void {
  stickerManagerWindow = win;
}

export function setCallWindowLocal(win: BrowserWindow | null): void {
  callWindow = win;
}

// 启动阶段控制：在 app startup 完成前，新创建的辅助窗口先不 show，
// 等主进程发送 STARTUP_READY 后再统一显示，制造“加载完再出现窗口”的效果。
let startupPhaseActive = true;
let startupPhaseReady = false;
const pendingShowWindows = new Set<BrowserWindow>();

export function isStartupPhaseActive(): boolean {
  return startupPhaseActive;
}

export function markStartupPhaseReady(): void {
  if (startupPhaseReady) return;
  startupPhaseReady = true;
  startupPhaseActive = false;
  for (const win of pendingShowWindows) {
    if (!win.isDestroyed()) {
      win.show();
    }
  }
  pendingShowWindows.clear();
}

export function showWindowWhenStartupReady(win: BrowserWindow): void {
  if (startupPhaseReady || !startupPhaseActive) {
    win.show();
    return;
  }
  pendingShowWindows.add(win);
}

/**
 * React 聊天窗口的会话调度器。
 *
 * 维护窗口 ready 状态与 pending sessionId 队列，被 createReactChatWindow
 * 与 CHATS_REACT_READY 的 IPC handler 共享。
 */
export const reactChatSession: ReactChatSessionDispatcher =
  createReactChatSessionDispatcher();

/**
 * 应用图标路径提供者。
 *
 * 由于获取当前图标依赖尚未解耦的 loadGeneralSettings，为避免窗口工厂与
 * index.ts 形成循环依赖，由 index.ts 在初始化阶段注入此 getter。
 */
export let getCurrentAppIconPath: () => string = () => "";

export function setGetCurrentAppIconPath(fn: () => string): void {
  getCurrentAppIconPath = fn;
}
