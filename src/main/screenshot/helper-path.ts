import * as path from "node:path";

export interface ScreenshotHelperPathEnvironment {
  isPackaged: boolean;
  appPath: string;
  resourcesPath: string;
  envOverride: string | undefined;
}

export function resolveScreenshotHelperPath(environment: ScreenshotHelperPathEnvironment): string {
  if (environment.envOverride?.trim()) return environment.envOverride;
  if (environment.isPackaged) {
    return path.win32.join(environment.resourcesPath, "bin", "cyrene-screenshot.exe");
  }
  return path.win32.join(environment.appPath, "native", "cyrene-screenshot", "target", "release", "cyrene-screenshot.exe");
}
