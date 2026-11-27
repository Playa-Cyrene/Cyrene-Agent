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

  it("已下载时周期检查保持安装状态，不再次联网", async () => {
    const updater = new FakeUpdater();
    updater.checkForUpdates.mockImplementation(async () => {
      updater.emit("checking-for-update");
      updater.emit("update-available", { version: "1.2.0" });
      return null;
    });
    const service = createAppUpdateService({ updater, currentVersion: "1.1.7", isPackaged: true });
    updater.emit("update-downloaded", { version: "1.2.0" });
    expect((await service.check()).phase).toBe("downloaded");
    expect(updater.checkForUpdates).not.toHaveBeenCalled();
    expect(service.canInstall()).toBe(true);
    expect(service.install()).toBe(true);
  });

  it("下载进行中不启动检查或丢失下载进度", async () => {
    const updater = new FakeUpdater();
    let complete!: (files: string[]) => void;
    updater.downloadUpdate.mockImplementation(() => new Promise(resolve => { complete = resolve; }));
    const service = createAppUpdateService({ updater, currentVersion: "1.1.7", isPackaged: true });
    const downloading = service.download();
    updater.emit("download-progress", { percent: 42 });
    expect(await service.check()).toMatchObject({ phase: "downloading", percent: 42 });
    expect(updater.checkForUpdates).not.toHaveBeenCalled();
    updater.emit("update-downloaded", { version: "1.2.0" });
    complete([]); await downloading;
    expect(service.canInstall()).toBe(true);
  });

  it("迟到的检查事件和拒绝不会撤销已下载安装包", async () => {
    const updater = new FakeUpdater();
    let reject!: (error: Error) => void;
    updater.checkForUpdates.mockImplementation(() => new Promise((_, fail) => { reject = fail; }));
    const service = createAppUpdateService({ updater, currentVersion: "1.1.7", isPackaged: true });
    const checking = service.check();
    updater.emit("update-downloaded", { version: "1.2.0" });
    for (const event of ["checking-for-update", "update-available", "update-not-available", "error"]) {
      updater.emit(event, { version: "1.3.0" });
      expect(service.getState()).toMatchObject({ phase: "downloaded", availableVersion: "1.2.0" });
    }
    reject(new Error("late check error")); await checking;
    expect(service.canInstall()).toBe(true);
  });

  it.each([false, true])("安装启动失败仍报告错误（异步事件：%s）", async (deferred) => {
    const updater = new FakeUpdater();
    updater.quitAndInstall.mockImplementation(() => {
      const fail = () => updater.emit("error", new Error("installer launch failed"));
      if (deferred) queueMicrotask(fail);
      else fail();
    });
    const service = createAppUpdateService({ updater, currentVersion: "1.1.7", isPackaged: true });
    updater.emit("update-downloaded", { version: "1.2.0" });

    service.install();
    await Promise.resolve();

    expect(updater.quitAndInstall).toHaveBeenCalledOnce();
    expect(service.getState()).toMatchObject({ phase: "error", error: "check_failed" });
    expect(service.canInstall()).toBe(false);
  });

  it("安装失败后重新下载会恢复检查错误保护和下载错误归类", async () => {
    const updater = new FakeUpdater();
    updater.quitAndInstall.mockImplementation(() => updater.emit("error", new Error("installer launch failed")));
    const service = createAppUpdateService({ updater, currentVersion: "1.1.7", isPackaged: true });
    updater.emit("update-downloaded", { version: "1.2.0" });
    service.install();

    updater.downloadUpdate.mockRejectedValueOnce(new Error("download retry failed"));
    await service.download();
    expect(updater.downloadUpdate).toHaveBeenCalledOnce();
    expect(service.getState()).toMatchObject({ phase: "error", error: "download_failed" });

    updater.downloadUpdate.mockImplementation(async () => {
      updater.emit("update-downloaded", { version: "1.2.0" });
      return [];
    });
    await service.download();
    updater.emit("error", new Error("late check error"));
    expect(service.getState()).toMatchObject({ phase: "downloaded", availableVersion: "1.2.0" });
    expect(service.canInstall()).toBe(true);
  });

  it("检查结束后才开始下载，检查失败不会被误报为下载失败", async () => {
    const updater = new FakeUpdater();
    let reject!: (error: Error) => void;
    updater.checkForUpdates.mockImplementation(() => new Promise((_, fail) => { reject = fail; }));
    updater.downloadUpdate.mockImplementation(async () => {
      updater.emit("update-downloaded", { version: "1.2.0" });
      return [];
    });
    const service = createAppUpdateService({ updater, currentVersion: "1.1.7", isPackaged: true });
    const checking = service.check();
    updater.emit("update-available", { version: "1.2.0" });
    const downloading = service.download();
    expect(updater.downloadUpdate).not.toHaveBeenCalled();
    updater.emit("error", new Error("check failed"));
    expect(service.getState()).toMatchObject({ phase: "error", error: "check_failed" });
    reject(new Error("check failed"));
    await Promise.all([checking, downloading]);
    expect(updater.downloadUpdate).toHaveBeenCalledOnce();
    expect(service.canInstall()).toBe(true);
  });

  it("并发检查仍合并为一次请求，普通检查结束后允许再次检查", async () => {
    const updater = new FakeUpdater();
    let complete!: (value: null) => void;
    updater.checkForUpdates.mockImplementation(() => new Promise(resolve => { complete = resolve; }));
    const service = createAppUpdateService({ updater, currentVersion: "1.1.7", isPackaged: true });
    const first = service.check();
    const second = service.check();
    expect(updater.checkForUpdates).toHaveBeenCalledOnce();
    updater.emit("update-not-available"); complete(null);
    await Promise.all([first, second]);
    updater.checkForUpdates.mockResolvedValue(null);
    await service.check();
    expect(updater.checkForUpdates).toHaveBeenCalledTimes(2);
  });
});
