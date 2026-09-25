import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  browserWindowOptions: [] as Array<Record<string, unknown>>,
  restoredBounds: { x: 0, y: 0, width: 1200, height: 800 },
  maximized: false,
  readyToShow: null as (() => void) | null,
  setBounds: vi.fn(),
}));

vi.mock("electron", () => ({
  app: { getAppPath: () => "/app" },
  BrowserWindow: class {
    webContents = { on: vi.fn() };
    on = vi.fn();
    once = vi.fn((event: string, listener: () => void) => {
      if (event === "ready-to-show") mocks.readyToShow = listener;
    });
    getBounds = vi.fn(() => mocks.restoredBounds);
    isMaximized = vi.fn(() => mocks.maximized);
    setBounds = mocks.setBounds;
    loadFile = vi.fn();
    loadURL = vi.fn();
    constructor(options: Record<string, unknown>) {
      mocks.browserWindowOptions.push(options);
    }
  },
  screen: {
    getPrimaryDisplay: () => ({ workArea: { x: 0, y: 0, width: 1920, height: 1080 } }),
    getCursorScreenPoint: () => ({ x: 100, y: 100 }),
    getDisplayNearestPoint: () => ({ workArea: { x: 0, y: 0, width: 2560, height: 1400 } }),
  },
}));
vi.mock("../env", () => ({ isDev: false }));
vi.mock("../settings/settings-facade", () => ({
  loadGeneralSettings: () => ({ rememberWindowState: true }),
}));
vi.mock("../window-layout", () => ({
      DEFAULT_WORKSPACE_WINDOW_SIZE: { width: 1200, height: 800 },
}));
vi.mock("../call/call-manager", () => ({ stopCall: vi.fn(), setCallWindow: vi.fn() }));
vi.mock("./window-state", () => ({
  callWindow: null,
  getCurrentAppIconPath: () => "",
  reactChatSession: { reset: vi.fn(), markLoading: vi.fn(), queueOrTake: vi.fn() },
  reactChatWindow: null,
  setCallWindowLocal: vi.fn(),
  setReactChatWindow: vi.fn(),
  setStickerManagerWindow: vi.fn(),
  showWindowWhenStartupReady: vi.fn(),
  stickerManagerWindow: null,
}));

import { createReactChatWindowShell, persistedWindowState } from "./create-aux-windows";

function lastBrowserWindowOptions() {
  const options = mocks.browserWindowOptions.at(-1);
  if (!options) throw new Error("BrowserWindow was not created");
  return options;
}

describe("persistedWindowState", () => {
  it("returns no BrowserWindow persistence options when disabled", () => {
    expect(persistedWindowState("cyrene.settings", false)).toEqual({});
  });

  it("persists bounds only when enabled", () => {
    expect(persistedWindowState("cyrene.settings", true)).toEqual({
      name: "cyrene.settings",
      windowStatePersistence: { bounds: true, displayMode: false },
    });
  });

  it("can also persist maximized display mode for the workspace window", () => {
    expect(persistedWindowState("cyrene.workspace", true, true)).toEqual({
      name: "cyrene.workspace",
      windowStatePersistence: { bounds: true, displayMode: true },
    });
  });
});

describe("workspace window defaults and persistence", () => {
  beforeEach(() => {
    mocks.restoredBounds = { x: 0, y: 0, width: 1200, height: 800 };
    mocks.maximized = false;
    mocks.readyToShow = null;
    mocks.setBounds.mockClear();
  });

  it("creates a centered, screen-sized workspace with persistent bounds and maximized state", () => {
    createReactChatWindowShell();

    expect(lastBrowserWindowOptions()).toMatchObject({
      x: 320,
      y: 100,
      width: 1920,
      height: 1200,
      minWidth: 960,
      minHeight: 540,
      name: "cyrene.workspace",
      windowStatePersistence: { bounds: true, displayMode: true },
    });
  });

  it("upgrades only the old default window size after saved bounds are restored", () => {
    createReactChatWindowShell();
    expect(mocks.readyToShow).not.toBeNull();
    mocks.readyToShow?.();
    expect(mocks.setBounds).toHaveBeenCalledWith({ x: 320, y: 100, width: 1920, height: 1200 });

    mocks.setBounds.mockClear();
    mocks.restoredBounds = { x: 200, y: 180, width: 1500, height: 900 };
    createReactChatWindowShell();
    mocks.readyToShow?.();
    expect(mocks.setBounds).not.toHaveBeenCalled();
  });

  it("keeps a maximized workspace maximized during the old-size upgrade", () => {
    mocks.maximized = true;
    createReactChatWindowShell();
    mocks.readyToShow?.();
    expect(mocks.setBounds).not.toHaveBeenCalled();
  });
});
