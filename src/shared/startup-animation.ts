export type StartupAnimationMode = "off" | "startup" | "except-tray" | "always";
export type AnimationOpenSource = "open" | "tray";

export interface StartupAnimationSettings {
  enabled: boolean;
  mode: StartupAnimationMode;
  videoFile: string | null;
  videoName: string | null;
}

export interface StartupAnimationApi {
  get: () => Promise<StartupAnimationSettings>;
  setEnabled: (enabled: boolean) => Promise<StartupAnimationSettings>;
  setMode: (mode: StartupAnimationMode) => Promise<StartupAnimationSettings>;
  importVideo: () => Promise<StartupAnimationSettings | null>;
  resetVideo: () => Promise<StartupAnimationSettings>;
}
