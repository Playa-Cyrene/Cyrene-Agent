import type { BrowserWindow } from "electron";
import { startStartupAnimation, isStartupAnimationRunning } from "./startup-animation";
import type { AnimationOpenSource } from "../../shared/startup-animation";

const openSources = new WeakMap<BrowserWindow, AnimationOpenSource>();
export function prepareAnimationWindowOpen(window: BrowserWindow, source: AnimationOpenSource): void {
  if (!window.isVisible() || window.isMinimized()) openSources.set(window, source);
}

/** Track user-facing chat visibility, not focus changes or navigation inside the UI. */
export function createAnimationWindowOpenTracker(
  play: (source: AnimationOpenSource) => unknown = startStartupAnimation,
  isPlaying = isStartupAnimationRunning,
) {
  let firstWindowShown = false;
  return (window: BrowserWindow): void => {
    let visible = false;
    let concealedByAnimation = false;
    const onShow = () => {
      if (visible) return;
      visible = true;
      const source = openSources.get(window) ?? "open";
      openSources.delete(window);
      // The first presentation belongs to process initialization, already handled by splash.
      if (firstWindowShown && !concealedByAnimation) play(source);
      concealedByAnimation = false;
      firstWindowShown = true;
    };
    const onHide = () => { visible = false; concealedByAnimation = isPlaying(); };
    window.on("show", onShow);
    window.on("restore", onShow);
    window.on("hide", onHide);
    window.on("minimize", onHide);
    window.once("closed", () => {
      openSources.delete(window);
      window.removeListener("show", onShow);
      window.removeListener("restore", onShow);
      window.removeListener("hide", onHide);
      window.removeListener("minimize", onHide);
    });
  };
}

export const trackAnimationWindowOpen = createAnimationWindowOpenTracker();
