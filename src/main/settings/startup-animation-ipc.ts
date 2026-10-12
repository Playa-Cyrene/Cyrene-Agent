import { app, BrowserWindow, dialog } from "electron";
import path from "node:path";
import { IPC } from "../../shared/ipc-channels";
import type { IpcScope } from "../application/ipc-scope";
import { StartupAnimationStore } from "./startup-animation-store";

export function registerStartupAnimationIpc(ipc: IpcScope): void {
  const store = new StartupAnimationStore(path.join(app.getPath("userData"), "startup-animation"));
  let pending = false;
  ipc.handle(IPC.STARTUP_ANIMATION_GET, () => store.read());
  ipc.handle(IPC.STARTUP_ANIMATION_SET_ENABLED, (_event, enabled: unknown) => store.setEnabled(enabled));
  ipc.handle(IPC.STARTUP_ANIMATION_SET_MODE, (_event, mode: unknown) => store.setMode(mode));
  ipc.handle(IPC.STARTUP_ANIMATION_RESET, () => {
    if (pending) throw new Error("请等待视频导入完成");
    return store.resetVideo();
  });
  ipc.handle(IPC.STARTUP_ANIMATION_IMPORT, async (event) => {
    if (pending) return null;
    pending = true;
    try {
      const parent = BrowserWindow.fromWebContents(event.sender);
      const options: Electron.OpenDialogOptions = {
        title: "导入启动动画", properties: ["openFile"],
        filters: [{ name: "MP4 视频（H.264，最大 500 MB）", extensions: ["mp4"] }],
      };
      const result = parent ? await dialog.showOpenDialog(parent, options) : await dialog.showOpenDialog(options);
      if (result.canceled || !result.filePaths[0]) return null;
      return await store.importVideo(result.filePaths[0]);
    } finally {
      pending = false;
    }
  });
}
