import * as path from "node:path";

export interface ComputerHelperPathEnvironment {
  isPackaged: boolean;
  appPath: string;
  resourcesPath: string;
  envOverride: string | undefined;
}

export function resolveComputerHelperPath(environment: ComputerHelperPathEnvironment): string {
  if (environment.envOverride?.trim()) return environment.envOverride;
  if (environment.isPackaged) {
    return path.join(environment.resourcesPath, "bin", "cyrene-computer.exe");
  }
  return path.join(environment.appPath, "native", "cyrene-computer", "target", "release", "cyrene-computer.exe");
}
