import type { QqRuntimeConfig } from "./qq-module";
/** Renderer-safe commands. Paths, candidate bytes, keys and credentials are host-owned. */
export type QqModuleActionCommand =
  | { action: "status" }
  | { action: "read-configuration" }
  | { action: "propose-configuration"; expectedRevision: number | null; config: QqRuntimeConfig; enabled: boolean }
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
  /** Exact nonsecret snapshot for informed runtime confirmation. */
  configuration?: QqRuntimeConfig;
}
/** Nonsecret view. Credential generation, encrypted envelope and token stay in main. */
export interface QqModuleConfigurationView {
  proposalRevision: number | null; config: QqRuntimeConfig | null; enabled: boolean;
  credentialAccountId: string | null;
}
export type QqModuleActionResult =
  | { ok: true; state: "configuration" | "configuration-saved"; configuration: QqModuleConfigurationView }
  | { ok: false; error: QqModuleActionError }
  | { ok: true; state: "ready" | "installed" | "committed" | "rolled-back" | "recovery-required" | "cancelled" | "disabled" }
  | { ok: true; state: "preview-install" | "preview-migration" | "preview-setup" | "preview-recovery" | "preview-reconfigure"; preview: QqModuleActionPreview };
