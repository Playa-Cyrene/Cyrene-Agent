import { beforeEach, afterEach, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import type { BrowserWindow } from "electron";

const mocks = vi.hoisted(() => ({ root: "", windows: [] as any[], app: undefined as any,
  loadError: false, constructError: false }));
vi.mock("electron", async () => {
  const { EventEmitter } = await import("node:events");
  class FakeWindow extends EventEmitter {
    destroyed = false;
    webContents = Object.assign(new EventEmitter(), {
      mainFrame: {}, setWindowOpenHandler: vi.fn(),
      ipc: Object.assign(new EventEmitter(), { handle: vi.fn(), removeHandler: vi.fn() }),
    });
    show = vi.fn(); showInactive = vi.fn(); focus = vi.fn(); hide = vi.fn();
    setIgnoreMouseEvents = vi.fn(); setBounds = vi.fn();
    getBounds = () => ({ x: 20, y: 30, width: 1280, height: 720 });
    isDestroyed = () => this.destroyed;
    loadFile = vi.fn((file: string) => mocks.loadError && file.endsWith("startup-animation.html")
      ? Promise.reject(new Error("page load failed")) : Promise.resolve());
    loadURL = vi.fn(() => Promise.resolve());
    close = vi.fn(() => { if (!this.destroyed) { this.destroyed = true; this.emit("closed"); } });
    constructor(readonly options: unknown) {
      super(); if (mocks.constructError) throw new Error("window unavailable"); mocks.windows.push(this);
    }
  }
  mocks.app = Object.assign(new EventEmitter(), {
    isPackaged: false, getAppPath: () => mocks.root, getPath: () => path.join(mocks.root, "data"),
  });
  return { BrowserWindow: FakeWindow, app: mocks.app, screen: {
    getPrimaryDisplay: () => ({ workArea: { x: 0, y: 0, width: 1920, height: 1080 }, workAreaSize: { width: 1920, height: 1080 } }),
  } };
});
import { startStartupAnimation, isStartupAnimationRunning, ANIMATION_LOAD_TIMEOUT_MS, ANIMATION_PLAYBACK_TIMEOUT_MS, ANIMATION_REOPEN_MS } from "./startup-animation";
import { StartupAnimationStore } from "../settings/startup-animation-store";
import { createSplashWindow } from "./create-splash-window";
import { revealStartupWindows } from "./startup-window-reveal";

let store: StartupAnimationStore;
beforeEach(() => {
  vi.useFakeTimers();
  mocks.root = fs.mkdtempSync(path.join(os.tmpdir(), "cyrene-animation-"));
  mocks.windows = []; mocks.loadError = false; mocks.constructError = false;
  const media = path.join(mocks.root, "resources/startup-animation"); fs.mkdirSync(media, { recursive: true });
  fs.writeFileSync(path.join(media, "default.mp4"), "mock media");
  store = new StartupAnimationStore(path.join(mocks.root, "data/startup-animation"));
});
afterEach(() => {
  for (const window of mocks.windows) window.close();
  vi.useRealTimers();
  fs.rmSync(mocks.root, { recursive: true, force: true });
});
function message(window: any, value: string, senderFrame = window.webContents.mainFrame) {
  window.webContents.ipc.emit("startup-animation:event", { senderFrame }, value);
}
function start() {
  store.setMode("startup");
  const result = startStartupAnimation();
  if (result.status !== "starting") throw new Error("expected a new session");
  return result;
}

it.each([
  ["off", "startup", false], ["off", "open", false], ["off", "tray", false],
  ["startup", "startup", true], ["startup", "open", false], ["startup", "tray", false],
  ["except-tray", "startup", true], ["except-tray", "open", true], ["except-tray", "tray", false],
  ["always", "startup", true], ["always", "open", true], ["always", "tray", true],
] as const)("mode %s on %s: playback=%s", (mode, reason, expected) => {
  store.setMode(mode);
  expect(startStartupAnimation({ reason }).status).toBe(expected ? "starting" : "skipped");
  expect(mocks.windows).toHaveLength(expected ? 1 : 0);
});

it("defaults to original Loading, including an explicit off preference", () => {
  for (const explicit of [false, true]) {
    if (explicit) store.setMode("off");
    const window = createSplashWindow({ isDev: false })!;
    expect(window.loadFile).toHaveBeenCalledWith(path.join(mocks.root, "dist/renderer/splash.html"));
    expect(isStartupAnimationRunning()).toBe(false);
    window.close();
  }
});

it("missing video uses original Loading; corrupt preferences do not block startup", () => {
  store.setMode("startup");
  fs.unlinkSync(path.join(mocks.root, "resources/startup-animation/default.mp4"));
  let window = createSplashWindow({ isDev: false })!;
  expect(window.loadFile).toHaveBeenLastCalledWith(path.join(mocks.root, "dist/renderer/splash.html"));
  window.close();
  fs.writeFileSync(store.settingsPath, "{");
  window = createSplashWindow({ isDev: false })!;
  expect(window.loadFile).toHaveBeenLastCalledWith(path.join(mocks.root, "dist/renderer/splash.html"));
});

it("reports loading separately from playing, ignores foreign frames and denies popups/navigation", () => {
  const result = start();
  const window = result.window as any;
  expect(result.getState()).toBe("loading");
  expect(window.options.webPreferences).toMatchObject({ nodeIntegration: false, contextIsolation: true, sandbox: true });
  expect(window.show).not.toHaveBeenCalled();
  message(window, "playing", {});
  expect(result.getState()).toBe("loading");
  const config = window.webContents.ipc.handle.mock.calls[0][1];
  expect(() => config({ senderFrame: {} })).toThrow();
  expect(config({ senderFrame: window.webContents.mainFrame }).video).toMatch(/^file:/);
  expect(window.webContents.setWindowOpenHandler.mock.calls[0][0]()).toEqual({ action: "deny" });
  const event = { preventDefault: vi.fn() }; window.webContents.emit("will-navigate", event);
  expect(event.preventDefault).toHaveBeenCalledOnce();
  message(window, "playing");
  expect(result.getState()).toBe("playing");
  expect(window.show).toHaveBeenCalledOnce();
  expect(startStartupAnimation().status).toBe("already-running");
  message(window, "ended");
  expect(result.getState()).toBe("holding");
  expect(window.isDestroyed()).toBe(false);
});

it.each(["load", "decode", "crash", "timeout"])("asynchronous %s failure restores Loading in the same window", async (failure) => {
  store.setMode("startup"); mocks.loadError = failure === "load";
  const window = createSplashWindow({ isDev: false })!;
  if (failure === "decode") message(window, "failed");
  if (failure === "crash") window.webContents.emit("render-process-gone", {}, { reason: "crashed" });
  if (failure === "timeout") await vi.advanceTimersByTimeAsync(ANIMATION_LOAD_TIMEOUT_MS);
  await Promise.resolve();
  expect(mocks.windows).toHaveLength(1);
  expect(window.loadFile).toHaveBeenLastCalledWith(path.join(mocks.root, "dist/renderer/splash.html"));
  const chat = { show: vi.fn(), isDestroyed: () => false, close: vi.fn() };
  await revealStartupWindows({ splashWindow: window, chatWindow: chat, minimumDurationMs: 2500 });
  expect(chat.show).toHaveBeenCalledOnce();
  expect(window.isDestroyed()).toBe(true);
  expect(isStartupAnimationRunning()).toBe(false);
});

it("stalled playback has a deadline and releases the startup barrier", async () => {
  const result = start(); message(result.window, "playing");
  await vi.advanceTimersByTimeAsync(ANIMATION_PLAYBACK_TIMEOUT_MS);
  expect(await result.finished).toBe("failed");
  expect(isStartupAnimationRunning()).toBe(false);
});

it.each(["skip", "Escape"])("%s releases playback and returns to Loading while core initializes", async (method) => {
  store.setMode("startup");
  const window = createSplashWindow({ isDev: false })!;
  message(window, "playing");
  if (method === "skip") message(window, "skip");
  else {
    const event = { preventDefault: vi.fn() };
    window.webContents.emit("before-input-event", event, { type: "keyDown", key: "Escape" });
    expect(event.preventDefault).toHaveBeenCalledOnce();
  }
  expect(window.loadFile).toHaveBeenLastCalledWith(path.join(mocks.root, "dist/renderer/splash.html"));
  expect(window.isDestroyed()).toBe(false);
  const chat = { show: vi.fn(), setBounds: vi.fn(), isDestroyed: () => false, close: vi.fn() };
  await revealStartupWindows({ splashWindow: window, chatWindow: chat, minimumDurationMs: 2500 });
  expect(chat.show).toHaveBeenCalledOnce();
  expect(chat.setBounds).not.toHaveBeenCalled();
});

it("core-ready waits for the video, then synchronizes chat bounds and closes the animation", async () => {
  const result = start(); message(result.window, "playing");
  const chat = { show: vi.fn(), setBounds: vi.fn(), isDestroyed: () => false, close: vi.fn() };
  const revealing = revealStartupWindows({ splashWindow: result.window, chatWindow: chat, minimumDurationMs: 2500 });
  await Promise.resolve(); expect(chat.show).not.toHaveBeenCalled();
  message(result.window, "ended"); await revealing;
  expect(chat.setBounds).toHaveBeenCalledWith(result.window.getBounds());
  expect(chat.show).toHaveBeenCalledOnce();
  expect(result.window.isDestroyed()).toBe(true);
  expect(mocks.app.listenerCount("before-quit")).toBe(0);
});

it("video-first keeps its last frame until core is ready, preserving onboarding geometry", async () => {
  const result = start(); message(result.window, "playing"); message(result.window, "ended");
  await vi.advanceTimersByTimeAsync(100000);
  expect(result.window.isDestroyed()).toBe(false);
  const chat = { show: vi.fn(), isDestroyed: () => false, close: vi.fn() };
  const onboarding = { ...chat, show: vi.fn(), setBounds: vi.fn() };
  await revealStartupWindows({ splashWindow: result.window, chatWindow: chat, onboardingWindow: onboarding,
    showOnboardingWindow: true, minimumDurationMs: 2500 });
  expect(onboarding.show).toHaveBeenCalledOnce(); expect(onboarding.setBounds).not.toHaveBeenCalled();
  expect(chat.show).not.toHaveBeenCalled();
});

it("quit cancels pending startup, removes listeners and never reveals chat", async () => {
  const result = start(); mocks.app.emit("before-quit");
  const chat = { show: vi.fn(), isDestroyed: () => false, close: vi.fn() };
  await revealStartupWindows({ splashWindow: result.window, chatWindow: chat, minimumDurationMs: 0 });
  expect(await result.finished).toBe("cancelled"); expect(chat.show).not.toHaveBeenCalled();
  expect(isStartupAnimationRunning()).toBe(false);
  expect(mocks.app.listenerCount("before-quit")).toBe(0);
});

it.each(["deadline", "Escape", "hide", "minimize", "closed"])("reopen overlay closes on %s without hiding/focusing its owner", async (end) => {
  store.setMode("always");
  const owner = Object.assign(new EventEmitter(), { webContents: new EventEmitter(),
    getBounds: () => ({ x: 50, y: 60, width: 1100, height: 700 }), hide: vi.fn(), focus: vi.fn() });
  const result = startStartupAnimation({ reason: "open", owner: owner as unknown as BrowserWindow });
  if (result.status !== "starting") throw new Error("expected overlay");
  await vi.advanceTimersByTimeAsync(900); message(result.window, "playing");
  expect(result.window.show).not.toHaveBeenCalled(); expect(result.window.showInactive).toHaveBeenCalledOnce();
  if (end === "deadline") await vi.advanceTimersByTimeAsync(ANIMATION_REOPEN_MS - 900);
  else if (end === "Escape") owner.webContents.emit("before-input-event", { preventDefault: vi.fn() }, { type: "keyDown", key: "Escape" });
  else owner.emit(end);
  expect(result.window.isDestroyed()).toBe(true);
  expect(owner.hide).not.toHaveBeenCalled(); expect(owner.focus).not.toHaveBeenCalled();
  expect(owner.webContents.listenerCount("before-input-event")).toBe(0);
  expect(owner.listenerCount("hide")).toBe(0);
});
