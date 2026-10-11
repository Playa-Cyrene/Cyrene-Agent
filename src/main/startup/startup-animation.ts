import { app } from "electron";
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import path from "node:path";
import { StartupAnimationStore } from "../settings/startup-animation-store";

export interface StartupAnimationConfigInput {
  exe: string;
  appPath: string;
  packaged: boolean;
  mediaDirectory: string;
  settingsPath: string;
}

/** 附着到当前进程，不再次启动 Electron；配置不包含对话或凭据。 */
export function createStartupAnimationConfig(input: StartupAnimationConfigInput) {
  return {
    DisplayName: "Cyrene Agent", Video: path.join(input.mediaDirectory, "default.mp4"),
    AppLaunch: input.exe, AppArguments: input.packaged ? "" : ".",
    WorkingDirectory: input.packaged ? path.dirname(input.exe) : input.appPath,
    ProcessPathContains: input.exe, ProcessNames: [path.basename(input.exe, ".exe")],
    SharedSettingsPath: input.settingsPath, AttachOnly: true,
    FreezeAtEnd: true, HoldStill: true, HoldFrom: 11.5, HoldAt: 12,
    TransitionStart: 13.5, RevealEnd: 14.65, TransitionEnd: 15,
    MaxWaitSeconds: 90, Volume: 0, PlayerWidth: 1280, PlayerHeight: 720,
    MatchClientToPlayer: true,
    ScreenFrames: [
      { Time: 13.5, X: 0, Y: 0, Width: 1, Height: 1 },
      { Time: 15, X: 0, Y: 0, Width: 1, Height: 1 },
    ],
  };
}

/** true 表示由外部动画接管（或用户关闭动画），跳过旧 splash。 */
export function startStartupAnimation(): boolean {
  if (process.platform !== "win32") return false;
  if (process.env.CYRENE_BOOT_ACTIVE === "1") return true;
  let directory: string | undefined;
  try {
    const store = new StartupAnimationStore(path.join(app.getPath("userData"), "startup-animation"));
    if (!store.read().enabled) return true;
    const mediaDirectory = app.isPackaged
      ? path.join(process.resourcesPath, "startup-animation")
      : path.join(app.getAppPath(), "resources", "startup-animation");
    const helper = path.join(mediaDirectory, "CyreneBoot.exe");
    // 源码开发环境未构建 helper 时保留现有启动流程，不阻塞主窗口。
    if (!fs.existsSync(helper) || !fs.existsSync(path.join(mediaDirectory, "default.mp4"))) return false;
    fs.mkdirSync(store.directory, { recursive: true });
    directory = fs.mkdtempSync(path.join(store.directory, "session-"));
    const config = createStartupAnimationConfig({ exe: process.execPath, appPath: app.getAppPath(),
      packaged: app.isPackaged, mediaDirectory, settingsPath: store.settingsPath });
    fs.writeFileSync(path.join(directory, "launcher.json"), JSON.stringify(config), "utf8");
    const child = spawn(helper, ["--config-dir", directory], { windowsHide: true, stdio: "ignore" });
    const sessionDirectory = directory;
    const cleanup = () => {
      app.removeListener("will-quit", stop);
      // 日志供排错，仅清理配置，不删除媒体或其他会话。
      try { fs.rmSync(path.join(sessionDirectory, "launcher.json"), { force: true }); } catch { /* best effort */ }
    };
    const stop = () => { if (child.exitCode === null && !child.killed) child.kill(); };
    app.once("will-quit", stop);
    child.once("error", (error) => { console.warn("[StartupAnimation] helper unavailable:", error); cleanup(); });
    child.once("exit", cleanup);
    child.unref();
    return true;
  } catch (error) {
    if (directory) { try { fs.rmSync(path.join(directory, "launcher.json"), { force: true }); } catch { /* best effort */ } }
    console.warn("[StartupAnimation] falling back to splash:", error);
    return false;
  }
}
