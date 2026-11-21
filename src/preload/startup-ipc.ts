import { ipcRenderer } from "electron";
import { IPC } from "../shared/ipc-channels";

// 这些接口在聊天页面加载前已注册。其余调用共享一次运行时握手。
const surfaceChannels = new Set<string>([
  IPC.CHAT_IS_MAXIMIZED,
  IPC.CHAT_MINIMIZE,
  IPC.CHAT_CLOSE,
  IPC.CHAT_TOGGLE_MAXIMIZE,
  IPC.CHATS_REACT_READY,
  IPC.APP_QUIT,
  IPC.WINDOW_MINIMIZE,
  IPC.WINDOW_CLOSE,
  IPC.WINDOW_MOVE,
  IPC.WINDOW_MOVE_TO,
  IPC.WINDOW_SET_DRAGGING,
  IPC.WINDOW_SET_INTERACTIVE,
  IPC.WINDOW_GET_CURSOR_POSITION,
  IPC.SETTINGS_GET_CONFIG,
  IPC.SETTINGS_MODEL_PROFILES_LIST,
  IPC.SETTINGS_GET_GENERAL,
  IPC.UI_THEME_GET,
  IPC.UI_THEME_RADIUS_GET,
  IPC.MODEL_CONFIG_GET,
  IPC.CHATS_LIST,
  IPC.CHATS_SIDEBAR_ORGANIZATION_GET,
  IPC.CHATS_SIDEBAR_ORGANIZATION_APPLY,
  IPC.CHATS_GET,
  IPC.CHATS_GET_PAGE,
  IPC.CHATS_CREATE,
  IPC.CHATS_PENDING_ENQUEUE,
  IPC.CHATS_PENDING_LIST,
  IPC.CHATS_PENDING_REMOVE,
]);
let ready = false;
let pending: Promise<void> | undefined;
function waitForRuntime(): Promise<void> {
  return pending ??= ipcRenderer.invoke(IPC.APP_RUNTIME_IPC_READY).then(
    () => { ready = true; },
    (error) => { pending = undefined; throw error; },
  );
}

export const startupIpc = {
  invoke(channel: string, ...args: unknown[]) {
    if (ready || surfaceChannels.has(channel)) return ipcRenderer.invoke(channel, ...args);
    return waitForRuntime().then(() => ipcRenderer.invoke(channel, ...args));
  },
  send(channel: string, ...args: unknown[]) {
    if (ready || surfaceChannels.has(channel)) ipcRenderer.send(channel, ...args);
    else void waitForRuntime().then(() => ipcRenderer.send(channel, ...args)).catch((error) => console.warn(channel, error));
  },
  on: ipcRenderer.on.bind(ipcRenderer),
  off: ipcRenderer.off.bind(ipcRenderer),
  removeListener: ipcRenderer.removeListener.bind(ipcRenderer),
  listenerCount: ipcRenderer.listenerCount.bind(ipcRenderer),
};
