import { describe, expect, it, vi } from "vitest";
import { revealStartupWindows } from "./startup-window-reveal";

interface FakeWindow {
  close(): void;
  isDestroyed(): boolean;
  show(): void;
}

function createFakeWindow(initiallyVisible = false): FakeWindow & {
  state: { destroyed: boolean; visible: boolean };
} {
  const state = { destroyed: false, visible: initiallyVisible };
  return {
    state,
    close: () => {
      state.destroyed = true;
      state.visible = false;
    },
    isDestroyed: () => state.destroyed,
    show: () => {
      state.visible = true;
    },
  };
}

describe("revealStartupWindows", () => {
  it("closes Loading and shows the chat window", async () => {
    const splashWindow = createFakeWindow(true);
    const chatWindow = createFakeWindow(false);

    await revealStartupWindows({
      splashWindow,
      chatWindow,
      minimumDurationMs: 0,
    });

    expect(splashWindow.state.destroyed).toBe(true);
    expect(chatWindow.state.visible).toBe(true);
  });

  it("waits only the remaining duration since Loading was actually shown", async () => {
    vi.useFakeTimers();
    try {
      const splashWindow = createFakeWindow(true);
      const chatWindow = createFakeWindow(false);
      // Loading 已显示 2000ms，最短 2500ms → 只剩 500ms
      const revealed = revealStartupWindows({
        splashWindow,
        chatWindow,
        loadingShownAt: 1000,
        minimumDurationMs: 2500,
        now: () => 3000,
      });
      let settled = false;
      void revealed.then(() => { settled = true; });
      await vi.advanceTimersByTimeAsync(499);
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      expect(settled).toBe(true);
      expect(splashWindow.state.destroyed).toBe(true);
      expect(chatWindow.state.visible).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("skips the minimum delay when Loading was never shown", async () => {
    const chatWindow = createFakeWindow(false);
    const sleep = vi.fn(async () => undefined);

    await revealStartupWindows({
      splashWindow: null,
      chatWindow,
      loadingShownAt: undefined,
      minimumDurationMs: 2500,
      sleep,
    });

    expect(sleep).not.toHaveBeenCalled();
    expect(chatWindow.state.visible).toBe(true);
  });
});

it("does not reveal windows after shutdown begins during minimum splash delay", async () => {
  let stopped = false;
  const chatWindow = createFakeWindow();
  const onboardingWindow = createFakeWindow();
  const splashWindow = createFakeWindow(true);
  await revealStartupWindows({
    splashWindow, chatWindow, onboardingWindow, showOnboardingWindow: true,
    loadingShownAt: 0, now: () => 0, minimumDurationMs: 2500,
    isStopping: () => stopped,
    sleep: async () => { stopped = true; },
  });
  expect(chatWindow.state.visible).toBe(false);
  expect(onboardingWindow.state.visible).toBe(false);
  // Window shutdown owns closing, reveal does not fight it.
  expect(splashWindow.state.destroyed).toBe(false);
});
