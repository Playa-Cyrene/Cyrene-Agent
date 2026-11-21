import { CURRENT_DISCLAIMER_VERSION } from "../../shared/disclaimer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  app: { once: vi.fn(), quit: vi.fn() },
  createdWindows: [] as Array<ReturnType<typeof createFakeWindow>>,
  createPetWindow: vi.fn(),
}));

vi.mock("electron", () => ({
  app: mocks.app,
  BrowserWindow: { getAllWindows: vi.fn(() => []) },
  screen: { getCursorScreenPoint: vi.fn(() => ({ x: 0, y: 0 })) },
}));
vi.mock("../startup/create-pet-window", () => ({
  createPetWindow: mocks.createPetWindow,
  PET_WINDOW_BASE_HEIGHT: 500,
  PET_WINDOW_BASE_WIDTH: 400,
}));
vi.mock("./create-aux-windows", () => ({
  createCallWindow: vi.fn(), createReactChatWindowShell: vi.fn(), createStickerManagerWindow: vi.fn(),
  loadReactChatWindowPage: vi.fn(), loadOnboardingWindowPage: vi.fn(), createOnboardingBrowserWindow: vi.fn(),
  showReactChatWindow: vi.fn(),
}));
vi.mock("./startup-window-load", () => ({ CHAT_READY_TIMEOUT_MS: 1, loadWindowForStartup: vi.fn() }));
vi.mock("./create-music-player-window", () => ({ createMusicPlayerWindow: vi.fn() }));
vi.mock("./broadcast", () => ({ broadcastToAllWindows: vi.fn() }));
vi.mock("../pet-window-movement", () => ({ PetWindowMoveController: class { dispose() {} finishDragging() {} moveRelative() {} queueAbsolute() {} } }));


function createFakeWindow() {
  const listeners = new Map<string, Array<(...args: any[]) => void>>();
  let visible = false;
  let destroyed = false;
  return {
    on: vi.fn((event: string, listener: (...args: any[]) => void) => {
      listeners.set(event, [...(listeners.get(event) ?? []), listener]);
    }),
    once: vi.fn((event: string, listener: (...args: any[]) => void) => {
      const wrapped = (...args: any[]) => {
        listeners.set(event, (listeners.get(event) ?? []).filter((candidate) => candidate !== wrapped));
        listener(...args);
      };
      listeners.set(event, [...(listeners.get(event) ?? []), wrapped]);
    }),
    emit(event: string, ...args: unknown[]) { for (const listener of [...(listeners.get(event) ?? [])]) listener(...args); },
    hide: vi.fn(() => { visible = false; for (const listener of [...(listeners.get("hide") ?? [])]) listener(); }),
    show: vi.fn(() => { visible = true; for (const listener of [...(listeners.get("show") ?? [])]) listener(); }),
    destroy: vi.fn(() => { destroyed = true; for (const listener of [...(listeners.get("closed") ?? [])]) listener(); }),
    isDestroyed: vi.fn(() => destroyed),
    isVisible: vi.fn(() => visible),
    setAlwaysOnTop: vi.fn(),
    getPosition: vi.fn(() => [0, 0]),
  };
}

import { createWindowManager } from "./window-manager";
import { createOnboardingBrowserWindow } from "./create-aux-windows";

afterEach(() => vi.useRealTimers());

describe("pet window resource release", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    mocks.createdWindows = [];
    mocks.createPetWindow.mockImplementation(() => {
      const window = createFakeWindow();
      mocks.createdWindows.push(window);
      return window;
    });
  });

  it("destroys a hidden pet window after 30 seconds and recreates it when shown", () => {
    const manager = createWindowManager({
      getCurrentAppIconPath: () => "icon",
      isDev: false,
      loadPetWindowSettingsSlice: () => ({ disclaimerAcceptedVersion: CURRENT_DISCLAIMER_VERSION, petAlwaysOnTop: true }),
      persistPetWindowPosition: vi.fn(),
    });
    const firstWindow = manager.createPetWindow();

    manager.hidePetWindow();
    vi.advanceTimersByTime(29_999);
    expect(firstWindow.destroy).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1);
    expect(firstWindow.destroy).toHaveBeenCalledOnce();

    manager.showPetWindow();
    expect(mocks.createdWindows).toHaveLength(2);
    expect(mocks.createdWindows[1].setAlwaysOnTop).toHaveBeenCalledWith(true, "screen-saver");
  });

  it("cancels delayed destruction when shown again before the timeout", () => {
    const manager = createWindowManager({
      getCurrentAppIconPath: () => "icon",
      isDev: false,
      loadPetWindowSettingsSlice: () => ({ disclaimerAcceptedVersion: CURRENT_DISCLAIMER_VERSION }),
      persistPetWindowPosition: vi.fn(),
    });
    const window = manager.createPetWindow();

    manager.hidePetWindow();
    vi.advanceTimersByTime(20_000);
    manager.showPetWindow();
    vi.advanceTimersByTime(30_000);

    expect(window.destroy).not.toHaveBeenCalled();
    expect(mocks.createdWindows).toHaveLength(1);
    expect(window.show).toHaveBeenCalledOnce();
  });
});


describe("window manager consent gate", () => {
  beforeEach(() => vi.clearAllMocks());

  it.each([undefined, "", "2026-09-27", CURRENT_DISCLAIMER_VERSION])("checks current consent for %s and does not bypass the gate on close", async version => {
    const window = createFakeWindow();
    vi.mocked(createOnboardingBrowserWindow).mockReturnValue(window as never);
    const manager = createWindowManager({
      getCurrentAppIconPath: () => "icon",
      isDev: false,
      loadPetWindowSettingsSlice: () => ({ disclaimerAcceptedVersion: version }),
      persistPetWindowPosition: vi.fn(),
    });
    const accepted = version === CURRENT_DISCLAIMER_VERSION;
    expect(manager.hasCurrentDisclaimerConsent()).toBe(accepted);
    await manager.createOnboardingWindow();
    const preventDefault = vi.fn();
    window.emit("close", { preventDefault });
    expect(preventDefault).toHaveBeenCalledTimes(accepted ? 0 : 1);
    expect(mocks.app.quit).toHaveBeenCalledTimes(accepted ? 0 : 1);
  });
});

it("uses the live remote consent check rather than the legacy version", () => {
  let accepted = false;
  const manager = createWindowManager({
    getCurrentAppIconPath: () => "icon", isDev: false,
    loadPetWindowSettingsSlice: () => ({ disclaimerAcceptedVersion: CURRENT_DISCLAIMER_VERSION }),
    persistPetWindowPosition: vi.fn(), hasCurrentDisclaimerConsent: () => accepted,
  });
  expect(manager.hasCurrentDisclaimerConsent?.()).toBe(false);
  accepted = true;
  expect(manager.hasCurrentDisclaimerConsent?.()).toBe(true);
  accepted = false;
  expect(manager.hasCurrentDisclaimerConsent?.()).toBe(false);
});
