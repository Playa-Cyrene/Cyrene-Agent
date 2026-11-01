import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { createAppUpdateService } from "./app-update-service";

class FakeUpdater extends EventEmitter {
  autoDownload = true;
  autoInstallOnAppQuit = true;
  allowPrerelease = true;
  checkForUpdates = vi.fn(async () => null);
  downloadUpdate = vi.fn(async () => [] as string[]);
  quitAndInstall = vi.fn();
}

describe("createAppUpdateService", () => {
  it("configures explicit user-controlled downloads and reports an available release", async () => {
    const updater = new FakeUpdater();
    const states: string[] = [];
    const service = createAppUpdateService({
      updater,
      currentVersion: "1.1.7",
      isPackaged: true,
      onStateChanged: (state) => states.push(state.phase),
    });

    expect(updater.autoDownload).toBe(false);
    expect(updater.autoInstallOnAppQuit).toBe(false);
    expect(updater.allowPrerelease).toBe(false);

    const checking = service.check();
    updater.emit("checking-for-update");
    updater.emit("update-available", {
      version: "1.2.0",
      releaseNotes: "可靠性更新",
    });
    await checking;

    expect(updater.checkForUpdates).toHaveBeenCalledOnce();
    expect(service.getState()).toMatchObject({
      phase: "available",
      currentVersion: "1.1.7",
      availableVersion: "1.2.0",
      releaseNotesHtml: "<p>可靠性更新</p>",
    });
    expect(states).toEqual(["checking", "available"]);
  });

  it("GitHub 发布源的 HTML 更新说明经净化后保留排版，交给设置页渲染", () => {
    const updater = new FakeUpdater();
    const service = createAppUpdateService({ updater, currentVersion: "1.3.4", isPackaged: true });
    updater.emit("update-available", {
      version: "1.3.5",
      releaseNotes: "<h1>Cyrene-Agent 1.3.5</h1><ul><li>新增 GPT-6.1 Terra</li></ul><script>alert(1)</script>",
    });
    expect(service.getState().releaseNotesHtml).toBe("<h1>Cyrene-Agent 1.3.5</h1><ul><li>新增 GPT-6.1 Terra</li></ul>");
  });

  it("maps download progress and downloaded state, then installs only when ready", async () => {
    const updater = new FakeUpdater();
    const service = createAppUpdateService({ updater, currentVersion: "1.1.7", isPackaged: true });

    await service.download();
    expect(updater.downloadUpdate).toHaveBeenCalledOnce();

    updater.emit("download-progress", {
      percent: 42.4,
      bytesPerSecond: 1024,
      transferred: 42,
      total: 100,
    });
    expect(service.getState()).toMatchObject({ phase: "downloading", percent: 42.4 });

    updater.emit("update-downloaded", { version: "1.2.0", releaseNotes: null });
    expect(service.getState()).toMatchObject({ phase: "downloaded", availableVersion: "1.2.0", percent: 100 });
    expect(service.install()).toBe(true);
    expect(updater.quitAndInstall).toHaveBeenCalledWith(true, true);
  });

  it("does not contact GitHub or install updates in development", async () => {
    const updater = new FakeUpdater();
    const service = createAppUpdateService({ updater, currentVersion: "1.1.7", isPackaged: false });

    await service.check();
    await service.download();

    expect(updater.checkForUpdates).not.toHaveBeenCalled();
    expect(updater.downloadUpdate).not.toHaveBeenCalled();
    expect(service.install()).toBe(false);
    expect(service.getState().phase).toBe("not_available");
  });

  it("normalizes updater errors without leaking a stale progress state", () => {
    const updater = new FakeUpdater();
    const service = createAppUpdateService({ updater, currentVersion: "1.1.7", isPackaged: true });

    updater.emit("error", new Error("network unavailable"));

    expect(service.getState()).toMatchObject({
      phase: "error",
      error: "check_failed",
    });
  });

  it("reports download errors with the download error code", async () => {
    const updater = new FakeUpdater();
    updater.downloadUpdate = vi.fn(async () => {
      throw new Error("network unavailable");
    });
    const service = createAppUpdateService({ updater, currentVersion: "1.1.7", isPackaged: true });

    // 先走到 available，再触发下载失败
    const checking = service.check();
    updater.emit("checking-for-update");
    updater.emit("update-available", { version: "1.2.0" });
    await checking;
    await service.download();

    expect(service.getState()).toMatchObject({ phase: "error", error: "download_failed" });
  });
});
