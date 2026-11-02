import type { AppUpdateState } from "../../shared/app-update";
import { releaseNotesToSafeHtml } from "./release-notes";

type UpdaterEvent =
  | "checking-for-update"
  | "update-available"
  | "update-not-available"
  | "download-progress"
  | "update-downloaded"
  | "error";

export interface AppUpdaterLike {
  autoDownload: boolean;
  autoInstallOnAppQuit: boolean;
  allowPrerelease: boolean;
  on(event: UpdaterEvent, listener: (payload?: any) => void): unknown;
  checkForUpdates(): Promise<unknown>;
  downloadUpdate(): Promise<unknown>;
  quitAndInstall(isSilent?: boolean, isForceRunAfter?: boolean): void;
}

export interface AppUpdateService {
  getState(): AppUpdateState;
  check(): Promise<AppUpdateState>;
  download(): Promise<AppUpdateState>;
  /** 是否满足安装条件；与 install() 拆开，保证没有清理完成前不会启动安装器。 */
  canInstall(): boolean;
  install(): boolean;
  onStateChanged(listener: (state: AppUpdateState) => void): () => void;
}

interface CreateAppUpdateServiceOptions {
  updater: AppUpdaterLike;
  currentVersion: string;
  isPackaged: boolean;
  onStateChanged?: (state: AppUpdateState) => void;
}

export function createAppUpdateService(options: CreateAppUpdateServiceOptions): AppUpdateService {
  const { updater, currentVersion, isPackaged, onStateChanged } = options;
  let state: AppUpdateState = { phase: "idle", currentVersion };
  let checkPromise: Promise<unknown> | null = null;
  let downloadPromise: Promise<unknown> | null = null;
  const listeners = new Set<(state: AppUpdateState) => void>();

  updater.autoDownload = false;
  updater.autoInstallOnAppQuit = false;
  updater.allowPrerelease = false;

  const publish = (patch: Partial<AppUpdateState> & Pick<AppUpdateState, "phase">): void => {
    const next: AppUpdateState = {
      currentVersion,
      availableVersion: state.availableVersion,
      releaseNotesHtml: state.releaseNotesHtml,
      ...patch,
    };
    if (JSON.stringify(next) === JSON.stringify(state)) return;
    state = next;
    onStateChanged?.({ ...state });
    for (const listener of listeners) listener({ ...state });
  };

  updater.on("checking-for-update", () => publish({ phase: "checking" }));
  updater.on("update-available", (info) => publish({
    phase: "available",
    availableVersion: typeof info?.version === "string" ? info.version : undefined,
    releaseNotesHtml: normalizeReleaseNotes(info?.releaseNotes),
  }));
  updater.on("update-not-available", () => publish({ phase: "not_available" }));
  updater.on("download-progress", (progress) => publish({
    phase: "downloading",
    percent: finiteNumber(progress?.percent),
    bytesPerSecond: finiteNumber(progress?.bytesPerSecond),
    transferred: finiteNumber(progress?.transferred),
    total: finiteNumber(progress?.total),
  }));
  updater.on("update-downloaded", (info) => publish({
    phase: "downloaded",
    availableVersion: typeof info?.version === "string" ? info.version : state.availableVersion,
    releaseNotesHtml: normalizeReleaseNotes(info?.releaseNotes) ?? state.releaseNotesHtml,
    percent: 100,
  }));
  // 错误只带错误码，用户可读文案由渲染层按码翻译；下载中报错按下载失败归档
  updater.on("error", () => publish({
    phase: "error",
    error: downloadPromise ? "download_failed" : "check_failed",
  }));

  return {
    getState: () => ({ ...state }),
    async check() {
      if (!isPackaged) {
        publish({ phase: "not_available" });
        return { ...state };
      }
      if (!checkPromise) {
        publish({ phase: "checking" });
        checkPromise = updater.checkForUpdates().catch(() => {
          publish({ phase: "error", error: "check_failed" });
        }).finally(() => {
          checkPromise = null;
        });
      }
      await checkPromise;
      return { ...state };
    },
    async download() {
      if (!isPackaged) return { ...state };
      if (!downloadPromise && state.phase !== "downloaded") {
        publish({ phase: "downloading", percent: state.percent ?? 0 });
        downloadPromise = updater.downloadUpdate().catch(() => {
          publish({ phase: "error", error: "download_failed" });
        }).finally(() => {
          downloadPromise = null;
        });
      }
      await downloadPromise;
      return { ...state };
    },
    canInstall() {
      return isPackaged && state.phase === "downloaded";
    },
    install() {
      if (!this.canInstall()) return false;
      // 静默安装：跳过 NSIS 完整向导，不再让用户选"为所有人/仅为我"，
      // 避免 perMachine 切换导致安装目录漂移（旧目录被卸载器清空、新目录落到 C 盘）。
      // 升级时安装目录里的用户内容由 NSIS 脚本（installer.nsh）暂存保护。
      updater.quitAndInstall(true, true);
      return true;
    },
    onStateChanged(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function normalizeReleaseNotes(value: unknown): string | null | undefined {
  if (typeof value === "string") return releaseNotesToSafeHtml(value);
  if (!Array.isArray(value)) return value === null ? null : undefined;
  const notes = value
    .map((item) => typeof item?.note === "string" ? releaseNotesToSafeHtml(item.note) : null)
    .filter((note): note is string => Boolean(note));
  return notes.length ? notes.join("<hr>") : null;
}
