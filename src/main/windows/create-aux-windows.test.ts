import { describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({
  app: { getAppPath: () => "/app" },
  BrowserWindow: class {},
  screen: { getPrimaryDisplay: () => ({ workArea: { x: 0, y: 0, width: 1920, height: 1080 } }) },
}));
vi.mock("../env", () => ({ isDev: false }));
vi.mock("../settings/settings-facade", () => ({
  loadGeneralSettings: () => ({ rememberWindowState: true }),
}));
vi.mock("../window-layout", () => ({
  computeLayout: () => ({ chat: { x: 0, y: 0 }, sidebar: { x: 0, y: 0 }, tasks: { x: 0, y: 0 } }),
}));
vi.mock("../call/call-manager", () => ({ stopCall: vi.fn(), setCallWindow: vi.fn() }));
vi.mock("./window-state", () => ({
  callWindow: null,
  getCurrentAppIconPath: () => "",
  reactChatSession: { reset: vi.fn(), markLoading: vi.fn(), queueOrTake: vi.fn() },
  reactChatWindow: null,
  setCallWindowLocal: vi.fn(),
  setReactChatWindow: vi.fn(),
  setSettingsWindow: vi.fn(),
  setSidebarWindow: vi.fn(),
  setStickerManagerWindow: vi.fn(),
  setTasksWindow: vi.fn(),
  settingsWindow: null,
  showWindowWhenStartupReady: vi.fn(),
  sidebarWindow: null,
  stickerManagerWindow: null,
  tasksWindow: null,
}));

import { persistedWindowState } from "./create-aux-windows";

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
});
