/** Renderer-safe commands. Paths, candidate bytes, keys and credentials are host-owned. */
export type QqModuleActionCommand =
  | { action: "status" }
  | { action: "preview-install" }
  | { action: "confirm-install"; operationId: string; userConfirmed: true }
  | { action: "preview-migration" }
  | { action: "confirm-migration"; operationId: string; accountId: string; userConfirmed: true }
  | { action: "preview-setup"; accountId: string }
  | { action: "confirm-setup"; operationId: string; accountId: string; userConfirmed: true }
  | { action: "preview-recovery" }
  | { action: "confirm-recovery"; operationId: string; accountId: string; userConfirmed: true }
  | { action: "preview-reconfigure" }
  | { action: "confirm-reconfigure"; operationId: string; accountId: string; userConfirmed: true }
  | { action: "cancel"; operationId: string };
export type QqModuleActionError = "unconfigured" | "unauthorized" | "busy" | "invalid" | "stale" | "operation-failed" | "recovery-required";
export type QqModuleConfigurationChange = "allowlist" | "enabled" | "account" | "credential" | "listen" | "configuration";
export interface QqModuleActionPreview {
  operationId: string; packageId: string; accountId?: string; version?: string;
  /** Reconfiguration only. Describes host-selected intent, never a credential or config upload. */
  desiredEnabled?: boolean;
  changes?: QqModuleConfigurationChange[];
}
export type QqModuleActionResult =
  | { ok: false; error: QqModuleActionError }
  | { ok: true; state: "ready" | "installed" | "committed" | "rolled-back" | "recovery-required" | "cancelled" | "disabled" }
  | { ok: true; state: "preview-install" | "preview-migration" | "preview-setup" | "preview-recovery" | "preview-reconfigure"; preview: QqModuleActionPreview };
