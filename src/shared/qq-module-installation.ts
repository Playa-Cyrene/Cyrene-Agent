/** Deliberately unavailable until a separately reviewed release trust policy exists.
 * Renderer cannot provide a URL, path, public key, executable or installation flag. */
export interface QqModuleListenInput { listenMode: string; customHost?: string }
export type QqModuleListenCompatibility = "loopback" | "unsupported-host" | "unresolved";
export interface QqModuleInstallationStatus {
  availability: "release-unconfigured";
  canInstall: false;
  moduleInstalled: false;
  currentDriver: "legacy-builtin";
  listenCompatibility: QqModuleListenCompatibility;
}
