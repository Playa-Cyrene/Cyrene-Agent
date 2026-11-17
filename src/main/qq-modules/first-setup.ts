import { randomUUID } from "node:crypto";
import { strictObject } from "../../shared/qq-module/validation";
import { validateRequestPayload, validateRuntimeConfig, type QqInitialize, type QqRuntimeConfig } from "../../shared/qq-module";
import { isQqModuleLoopbackHost } from "./listen-policy";
import type { QqModuleManager } from "./manager";
import { QqFirstSetupError, QqFirstSetupStore, firstSetupFail, type QqFirstSetupRecord } from "./first-setup-store";

export interface QqFirstSetupPreview {
  previewId: string; packageId: string; accountId: string; config: QqRuntimeConfig;
  action: "first-setup"; credentials: "read-from-secure-host-after-confirmation";
}
export interface QqFirstSetupOutcome {
  outcome: "committed" | "rolled-back" | "recovery-required";
  errorCode?: string;
}
export interface QqFirstSetupOptions {
  store: QqFirstSetupStore;
  /** Host-only fresh configuration, not a fabricated legacy migration snapshot. */
  readConfiguration(): QqRuntimeConfig;
  secureStorage: { isSecureAvailable(): boolean };
  /** Host-owned secure credential source; never called during preview or cancellation.
   * The source must reject plaintext/obfuscation fallbacks. This module writes no secret. */
  readCredential(): string;
  verifyCandidate(packageId: string): void;
  /** Host must own a BLOCKED exclusive QQ router for this entire operation.
   * A plain adapter.stop() or empty persisted selection is NOT proof of absence. */
  verifyNoLegacyDriver(): Promise<boolean>;
  /** Side-effect-free host factory; the host binds the manager to its blocked router.
   * No competing start is permitted between the absence checks and activation. */
  createModule(input: QqInitialize, packageId: string): QqModuleManager;
  backendReconnectTimeoutMs?: number;
}
/** First-time setup, independent of legacy migration. No production IPC registration.
 * Durable records always gate startup: never auto-replay or infer a live activation. */
export class QqFirstSetupCoordinator {
  private pending?: QqFirstSetupPreview;
  private busy = false;
  private module?: QqModuleManager;
  constructor(private readonly options: QqFirstSetupOptions) {}
  private ready(): void { if (this.busy) firstSetupFail("operation-busy"); }
  private config(): QqRuntimeConfig {
    const config = this.options.readConfiguration();
    if (!validateRuntimeConfig(config) || !isQqModuleLoopbackHost(config.listen.host)) firstSetupFail("invalid-configuration");
    return structuredClone(config);
  }
  previewSetup(packageId: string): QqFirstSetupPreview {
    this.ready(); this.pending = undefined;
    if (!/^pkg-[a-f0-9]{64}$/.test(packageId)) firstSetupFail("invalid-candidate");
    const record = this.options.store.read();
    if (record && record.phase !== "rolled-back") firstSetupFail("existing-setup-requires-review");
    if (!this.options.secureStorage.isSecureAvailable()) firstSetupFail("secure-storage-unavailable");
    this.options.verifyCandidate(packageId);
    const config = this.config();
    const preview: QqFirstSetupPreview = { previewId: randomUUID(), packageId, accountId: config.expectedSelfId,
      config, action: "first-setup", credentials: "read-from-secure-host-after-confirmation" };
    this.pending = preview;
    return structuredClone(preview);
  }
  cancel(input: unknown): void {
    this.ready();
    if (!strictObject(input, { previewId: (v) => typeof v === "string" })
      || !this.pending || (input as { previewId: string }).previewId !== this.pending.previewId) firstSetupFail("stale-confirmation");
    this.pending = undefined;
  }
  async confirmSetup(input: unknown): Promise<QqFirstSetupOutcome> {
    this.ready();
    if (!strictObject(input, { previewId: (v) => typeof v === "string", accountId: (v) => typeof v === "string", userConfirmed: (v) => v === true })) firstSetupFail("explicit-account-confirmation-required");
    const preview = this.pending;
    const consent = input as { previewId: string; accountId: string };
    if (!preview || consent.previewId !== preview.previewId || consent.accountId !== preview.accountId) firstSetupFail("stale-confirmation");
    this.pending = undefined; this.busy = true;
    try {
      if (this.module && !this.module.isStoppedForMigration()) firstSetupFail("module-stop-unconfirmed");
      return await this.options.store.locked(async (save) => {
        const previous = this.options.store.read();
        if (previous && previous.phase !== "rolled-back") firstSetupFail("existing-setup-requires-review");
        const checkInputs = () => {
          if (JSON.stringify(this.config()) !== JSON.stringify(preview.config)) firstSetupFail("configuration-changed");
          if (!this.options.secureStorage.isSecureAvailable()) firstSetupFail("secure-storage-unavailable");
          this.options.verifyCandidate(preview.packageId);
        };
        checkInputs();
        let token = "";
        const initialize = { config: structuredClone(preview.config), credentials: { accessToken: "" } };
        const record: QqFirstSetupRecord = { schemaVersion: 1, transactionId: preview.previewId,
          packageId: preview.packageId, config: structuredClone(preview.config), phase: "prepared" };
        try {
          // Durable intent MUST precede route revocation or any asynchronous proof.
          // A crash while absence is unknown must never silently restart legacy.
          save(record);
          if (!await this.options.verifyNoLegacyDriver()) firstSetupFail("legacy-driver-not-confirmed-absent");
          checkInputs();
          token = this.options.readCredential();
          initialize.credentials.accessToken = token;
          if (!validateRequestPayload("initialize", initialize) || !token.trim()) firstSetupFail("credential-unreadable");
          if (!await this.options.verifyNoLegacyDriver()) firstSetupFail("legacy-driver-not-confirmed-absent");
          checkInputs();
          this.module = this.options.createModule(initialize, preview.packageId);
          token = "";
          await this.module.stageForMigration();
          const identity = await this.module.waitForMigrationIdentity(this.options.backendReconnectTimeoutMs);
          const epoch = this.module.getState().runtimeEpoch;
          if (!identity || identity.selfId !== preview.accountId) firstSetupFail("module-account-unverified");
          record.phase = "module-staged"; save(record);
          if (!await this.options.verifyNoLegacyDriver()) firstSetupFail("legacy-driver-not-confirmed-absent");
          checkInputs();
          record.phase = "selected"; save(record);
          if (!this.module.activateMigration()) firstSetupFail("module-disconnected-before-activation");
          const live = this.module.getActiveMigrationIdentity();
          if (!live || live.selfId !== identity.selfId || live.connectionEpoch !== identity.connectionEpoch || live.runtimeEpoch !== epoch) firstSetupFail("module-account-unverified");
          return { outcome: "committed" };
        } catch (error) {
          const errorCode = error instanceof QqFirstSetupError ? error.code : "operation-failed";
          try {
            if (this.module) {
              await this.module.stop();
              if (!this.module.isStoppedForMigration()) return { outcome: "recovery-required", errorCode };
            }
            record.phase = "rolled-back"; save(record);
            return { outcome: "rolled-back", errorCode };
          } catch { return { outcome: "recovery-required", errorCode }; }
        } finally { token = ""; initialize.credentials.accessToken = ""; }
      });
    } finally { this.busy = false; }
  }
  /** Explicit recovery only with live host proof that every QQ driver is stopped.
   * Does not restart either driver, delete stale locks or restore secret material. */
  async rollbackStoppedSetup(verifyAllDriversStopped: () => Promise<boolean>): Promise<QqFirstSetupOutcome> {
    this.ready(); this.pending = undefined; this.busy = true;
    try {
      return await this.options.store.locked(async (save) => {
        const record = this.options.store.read(); if (!record) firstSetupFail("no-setup");
        try {
          if (this.module) { await this.module.stop(); if (!this.module.isStoppedForMigration()) return { outcome: "recovery-required", errorCode: "module-stop-unconfirmed" }; }
          if (!await verifyAllDriversStopped()) return { outcome: "recovery-required", errorCode: "driver-stop-unconfirmed" };
          save({ ...record, phase: "rolled-back" }); this.module = undefined;
          return { outcome: "rolled-back" };
        } catch { return { outcome: "recovery-required", errorCode: "recovery-failed" }; }
      });
    } finally { this.busy = false; }
  }
}
