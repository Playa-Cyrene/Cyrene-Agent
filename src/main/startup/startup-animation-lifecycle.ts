/** Startup orchestration can await playback without importing Electron. */
export type AnimationOutcome = "completed" | "skipped" | "failed" | "cancelled";
export interface AnimationBounds { x: number; y: number; width: number; height: number }
export interface StartupPresentation {
  finished: Promise<AnimationOutcome>;
  getBounds(): AnimationBounds | undefined;
}
const presentations = new WeakMap<object, StartupPresentation>();
export function registerStartupPresentation(window: object, presentation: StartupPresentation): void {
  presentations.set(window, presentation);
}
export function getStartupPresentation(window: object | null): StartupPresentation | undefined {
  return window ? presentations.get(window) : undefined;
}
