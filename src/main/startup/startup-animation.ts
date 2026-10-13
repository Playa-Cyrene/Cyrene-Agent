import { app, BrowserWindow, screen } from "electron";
import * as fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { StartupAnimationStore } from "../settings/startup-animation-store";
import type { AnimationOpenSource, StartupAnimationMode } from "../../shared/startup-animation";
import { registerStartupPresentation, type AnimationOutcome } from "./startup-animation-lifecycle";

export const ANIMATION_LOAD_TIMEOUT_MS = 5000;
export const ANIMATION_PLAYBACK_TIMEOUT_MS = 90000;
export const ANIMATION_REOPEN_MS = 1200;
type AnimationReason = "startup" | AnimationOpenSource;
export type AnimationState = "loading" | "playing" | "holding" | AnimationOutcome;
export type AnimationStartResult =
  | { status: "skipped"; reason: "disabled" | "mode" | "unavailable" }
  | { status: "already-running" }
  | { status: "starting"; window: BrowserWindow; finished: Promise<AnimationOutcome>; getState(): AnimationState };

export function shouldPlayAnimation(mode: StartupAnimationMode, reason: AnimationReason): boolean {
  return mode !== "off" && (reason === "startup" || (mode !== "startup" && (reason !== "tray" || mode === "always")));
}

let activeWindow: BrowserWindow | undefined;
export function isStartupAnimationRunning(): boolean { return !!activeWindow; }
export interface AnimationStartOptions {
  reason?: AnimationReason;
  owner?: BrowserWindow;
  onShown?(): void;
  /** Reuse this startup window for Loading, so the reveal barrier always owns it. */
  fallback?(window: BrowserWindow): void;
}

/** Initialization success arrives asynchronously from video.play(), never from window construction. */
export function startStartupAnimation(options: AnimationStartOptions = {}): AnimationStartResult {
  const reason = options.reason ?? "startup";
  if (activeWindow) return { status: "already-running" };
  let window: BrowserWindow;
  let video: string;
  try {
    const store = new StartupAnimationStore(path.join(app.getPath("userData"), "startup-animation"));
    const settings = store.read();
    if (!shouldPlayAnimation(settings.mode, reason)) {
      return { status: "skipped", reason: settings.mode === "off" ? "disabled" : "mode" };
    }
    const mediaDirectory = app.isPackaged ? path.join(process.resourcesPath, "startup-animation")
      : path.join(app.getAppPath(), "resources", "startup-animation");
    video = settings.videoFile ? path.join(store.directory, settings.videoFile) : path.join(mediaDirectory, "default.mp4");
    if (!fs.existsSync(video)) return { status: "skipped", reason: "unavailable" };
    const workArea = screen.getPrimaryDisplay().workArea;
    const width = Math.min(1280, workArea.width);
    const height = Math.min(720, workArea.height);
    const owner = options.owner;
    window = new BrowserWindow({
      ...(owner ? { parent: owner, ...owner.getBounds() } : {
        width, height, x: workArea.x + Math.round((workArea.width - width) / 2),
        y: workArea.y + Math.round((workArea.height - height) / 2),
      }),
      title: "Cyrene", frame: false, show: false, backgroundColor: "#ffffff",
      resizable: false, minimizable: false, maximizable: false, skipTaskbar: true,
      focusable: reason === "startup",
      webPreferences: {
        preload: path.join(app.getAppPath(), "dist", "preload", "preload", "startup-animation.js"),
        nodeIntegration: false, contextIsolation: true, sandbox: true,
      },
    });
  } catch (error) {
    console.warn("[StartupAnimation] unavailable; using Loading", error);
    return { status: "skipped", reason: "unavailable" };
  }

  activeWindow = window;
  let state: AnimationState = "loading";
  let settled = false;
  let fallbackShown = false;
  let shown = false;
  let resolve!: (outcome: AnimationOutcome) => void;
  const finished = new Promise<AnimationOutcome>((done) => { resolve = done; });
  let timer: ReturnType<typeof setTimeout> | undefined;
  const clearTimer = () => { if (timer) clearTimeout(timer); timer = undefined; };
  const settle = (outcome: AnimationOutcome) => {
    clearTimer();
    if (!settled) { settled = true; resolve(outcome); }
  };
  const removePlaybackListeners = () => {
    window.webContents.ipc.removeHandler("startup-animation:config");
    window.webContents.ipc.removeListener("startup-animation:event", onMessage);
    window.webContents.removeListener("before-input-event", onKey);
    window.webContents.removeListener("render-process-gone", onFailure);
    options.owner?.webContents.removeListener("before-input-event", onKey);
    options.owner?.removeListener("hide", closeOverlay);
    options.owner?.removeListener("minimize", closeOverlay);
    options.owner?.removeListener("closed", closeOverlay);
  };
  const fallback = (outcome: "failed" | "skipped") => {
    if (fallbackShown || window.isDestroyed()) return;
    fallbackShown = true;
    state = outcome;
    settle(outcome);
    removePlaybackListeners();
    if (reason === "startup" && options.fallback) {
      try { options.fallback(window); } catch { window.close(); }
    } else window.close();
  };
  const onFailure = () => fallback("failed");
  const onKey = (event: Electron.Event, input: Electron.Input) => {
    if (input.type === "keyDown" && input.key === "Escape") { event.preventDefault(); fallback("skipped"); }
  };
  const closeOverlay = () => { if (!window.isDestroyed()) window.close(); };
  const onMessage = (event: Electron.IpcMainEvent, message: unknown) => {
    if (event.senderFrame !== window.webContents.mainFrame || fallbackShown || window.isDestroyed()) return;
    if (message === "playing" && state === "loading") {
      state = "playing";
      if (reason === "startup") {
        clearTimer();
        timer = setTimeout(onFailure, ANIMATION_PLAYBACK_TIMEOUT_MS);
        window.show();
      } else { window.setIgnoreMouseEvents(true); window.showInactive(); }
      shown = true;
      options.onShown?.();
    } else if (message === "ended" && state === "playing") {
      state = reason === "startup" ? "holding" : "completed";
      settle("completed");
      if (reason !== "startup") closeOverlay();
    } else if (message === "skip") fallback("skipped");
    else if (message === "failed") onFailure();
  };
  const onQuit = () => { state = "cancelled"; settle("cancelled"); closeOverlay(); };
  window.webContents.ipc.handle("startup-animation:config", (event) => {
    if (event.senderFrame !== window.webContents.mainFrame || fallbackShown) throw new Error("Invalid animation sender");
    return { video: pathToFileURL(video).href, reopen: reason !== "startup" };
  });
  window.webContents.ipc.on("startup-animation:event", onMessage);
  window.webContents.on("before-input-event", onKey);
  window.webContents.on("render-process-gone", onFailure);
  window.webContents.on("will-navigate", (event) => event.preventDefault());
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  options.owner?.webContents.on("before-input-event", onKey);
  options.owner?.on("hide", closeOverlay);
  options.owner?.on("minimize", closeOverlay);
  options.owner?.on("closed", closeOverlay);
  app.once("before-quit", onQuit);
  window.once("closed", () => {
    settle(state === "cancelled" ? "cancelled" : "skipped");
    removePlaybackListeners();
    app.removeListener("before-quit", onQuit);
    if (activeWindow === window) activeWindow = undefined;
  });
  if (reason === "startup") registerStartupPresentation(window, {
    finished,
    getBounds: () => shown && !fallbackShown && !window.isDestroyed() ? window.getBounds() : undefined,
  });
  // A reopen costs at most 1.2s total, including loading; chat remains visible throughout.
  timer = setTimeout(reason === "startup" ? onFailure : () => {
    state = "completed"; settle("completed"); closeOverlay();
  }, reason === "startup" ? ANIMATION_LOAD_TIMEOUT_MS : ANIMATION_REOPEN_MS);
  const page = path.join(app.getAppPath(), app.isPackaged ? "dist/renderer" : "src/renderer/public", "startup-animation.html");
  try { void window.loadFile(page).catch(onFailure); } catch { onFailure(); }
  return { status: "starting", window, finished, getState: () => state };
}
