export interface StartupAnimationSettings {
  enabled: boolean;
  videoFile: string | null;
  videoName: string | null;
}

export interface StartupAnimationApi {
  get: () => Promise<StartupAnimationSettings>;
  setEnabled: (enabled: boolean) => Promise<StartupAnimationSettings>;
  importVideo: () => Promise<StartupAnimationSettings | null>;
  resetVideo: () => Promise<StartupAnimationSettings>;
}
