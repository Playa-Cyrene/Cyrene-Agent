/** Renderer-safe commands. Paths, candidate bytes, keys and credentials are host-owned. */
export type QqModuleActionCommand =
  | { action: "status" }
  | { action: "preview-install" }
  | { action: "confirm-install"; operationId: string; userConfirmed: true }
  | { action: "preview-migration" }
  | { action: "confirm-migration"; operationId: string; accountId: string; userConfirmed: true }
  | { action: "preview-setup"; accountId: string }
  | { action: "confirm-setup"; operationId: string; accountId: string; userConfirmed: true }
  | { action: "cancel"; operationId: string };
export type QqModuleActionError = "unconfigured" | "unauthorized" | "busy" | "invalid" | "stale" | "operation-failed" | "recovery-required";
export interface QqModuleActionPreview { operationId: string; packageId: string; accountId?: string; version?: string }
export type QqModuleActionResult =
  | { ok: false; error: QqModuleActionError }
  | { ok: true; state: "ready" | "installed" | "committed" | "rolled-back" | "recovery-required" | "cancelled" }
  | { ok: true; state: "preview-install" | "preview-migration" | "preview-setup"; preview: QqModuleActionPreview };
