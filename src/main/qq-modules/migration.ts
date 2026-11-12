import { randomUUID } from "node:crypto";
import type { QqInitialize, QqRuntimeConfig } from "../../shared/qq-module";
import { strictObject } from "../../shared/qq-module/validation";
import { buildQqMigrationPlan, isQqLegacyIdentity, migrationFail, QqMigrationError, qqMigrationDigest, readQqMigrationToken,
  type QqLegacyIdentity, type QqMigrationPlan, type QqMigrationSecretStorage } from "./migration-plan";
import { QqMigrationStore, type QqMigrationRecord } from "./migration-store";
import type { QqModuleManager } from "./manager";

export interface QqMigrationPreview {
  previewId: string; channelId: "qq"; accountId: string; targetPackageId: string; config: QqRuntimeConfig;
  credentialAction: "none" | "host-decrypt-in-memory";
  legacyCredentialProtection: QqMigrationPlan["credentialKind"];
  preserved: readonly ["settings", "history", "bindings"];
  /** Local rollback does not promise a runnable old binary/backend. */
  rollback: "original-data-unchanged-legacy-runtime-not-guaranteed";
}
export interface QqMigrationLegacyPort {
  getMigrationIdentity(): { accountId: string; connectionEpoch: number } | null;
  prepareMigrationStop(input: { accountId: string; connectionEpoch: number; timeoutMs?: number }): Promise<{ safeToSwitch: boolean; drained: boolean; stopped: boolean }>;
}
export interface QqMigrationOptions {
  store: QqMigrationStore;
  readLegacySettings(): Uint8Array;
  legacy: QqMigrationLegacyPort;
  secureStorage: QqMigrationSecretStorage;
  legacyMachine: { userDataPath: string; appName: string };
  /** Must revalidate the exact installed digest/signature/compatibility, without executing it. */
  verifyCandidate(packageId: string): void;
  /** Trusted host construction only, no renderer-provided executable/config factory.
   * Factory must be side-effect-free. The coordinator stages this manager quarantined. */
  createModule(input: QqInitialize, packageId: string): QqModuleManager;
  interfaces?: Parameters<typeof buildQqMigrationPlan>[2];
  backendReconnectTimeoutMs?: number;
}
export interface QqMigrationOutcome {
  outcome: "committed" | "rolled-back" | "recovery-required";
  legacyData: "unchanged";
  legacyRuntime: "not-restarted";
  errorCode?: string;
}
/** Offline, opt-in foundation. No production init/IPC imports this coordinator. No
 * download, installation, history conversion or automatic restart is performed. */
export class QqMigrationCoordinator {
  private preview?: { id: string; packageId: string; plan: QqMigrationPlan };
  private module?: QqModuleManager;
  constructor(private readonly options: QqMigrationOptions) {}
  previewMigration(packageId: string): QqMigrationPreview {
    if (!/^pkg-[a-f0-9]{64}$/.test(packageId)) migrationFail("invalid-candidate");
    const existing = this.options.store.read();
    if (existing && existing.phase !== "rolled-back") migrationFail("existing-migration-requires-review");
    this.options.verifyCandidate(packageId);
    const account = this.options.legacy.getMigrationIdentity();
    if (!account) migrationFail("confirmed-live-account-required");
    const identity = { selfId: account.accountId, connectionEpoch: account.connectionEpoch };
    const plan = buildQqMigrationPlan(this.options.readLegacySettings(), identity, this.options.interfaces);
    if (plan.credentialKind !== "none" && !this.options.secureStorage.isSecureAvailable()) migrationFail("secure-storage-unavailable");
    const id = randomUUID();
    this.preview = { id, packageId, plan };
    return { previewId: id, channelId: "qq", accountId: identity.selfId, targetPackageId: packageId,
      config: structuredClone(plan.config), credentialAction: plan.credentialKind === "none" ? "none" : "host-decrypt-in-memory",
      legacyCredentialProtection: plan.credentialKind, preserved: ["settings", "history", "bindings"],
      rollback: "original-data-unchanged-legacy-runtime-not-guaranteed" };
  }
  async confirmMigration(consent: { previewId: string; accountId: string; userConfirmed: true }): Promise<QqMigrationOutcome> {
    if (!strictObject(consent, { previewId: (v) => typeof v === "string", accountId: (v) => typeof v === "string", userConfirmed: (v) => v === true })) migrationFail("explicit-account-confirmation-required");
    const preview = this.preview;
    if (!preview || consent.previewId !== preview.id || consent.accountId !== preview.plan.identity.selfId) migrationFail("stale-or-mismatched-confirmation");
    return this.options.store.locked(async (save) => {
      const existing = this.options.store.read();
      if (existing?.transactionId === preview.id && existing.phase === "committed") return this.outcome("committed");
      if (existing?.transactionId === preview.id && existing.phase === "rolled-back") return this.outcome("rolled-back");
      if (existing && existing.phase !== "rolled-back") migrationFail("existing-migration-requires-review");
      // Re-read every mutable input before touching the live legacy driver.
      const bytes = Buffer.from(this.options.readLegacySettings());
      if (qqMigrationDigest(bytes) !== preview.plan.sourceDigest) migrationFail("settings-changed");
      const account = this.options.legacy.getMigrationIdentity();
      if (!account || account.accountId !== preview.plan.identity.selfId || account.connectionEpoch !== preview.plan.identity.connectionEpoch) migrationFail("account-or-connection-changed");
      const current = buildQqMigrationPlan(bytes, preview.plan.identity, this.options.interfaces);
      if (JSON.stringify(current.config) !== JSON.stringify(preview.plan.config)) migrationFail("listen-address-changed");
      this.options.verifyCandidate(preview.packageId);
      let token = readQqMigrationToken(bytes, this.options.secureStorage, this.options.legacyMachine);
      const record: QqMigrationRecord = { schemaVersion: 1, transactionId: preview.id, packageId: preview.packageId,
        plan: structuredClone(preview.plan), phase: "prepared" };
      // Persist intent BEFORE stopping. Any crash marker requires explicit review; it
      // never authorizes starting both drivers or replaying queued messages on restart.
      save(record);
      try {
        const stopped = await this.options.legacy.prepareMigrationStop({ ...account });
        if (!stopped.safeToSwitch || !stopped.drained || !stopped.stopped) return this.outcome("recovery-required", "legacy-not-drained-and-stopped");
        record.phase = "legacy-stopped"; save(record);
        if (qqMigrationDigest(this.options.readLegacySettings()) !== record.plan.sourceDigest) migrationFail("settings-changed");
        this.options.verifyCandidate(preview.packageId);
        this.module = this.options.createModule({ config: structuredClone(record.plan.config), credentials: { accessToken: token } }, record.packageId);
        token = "";
        await this.module.stageForMigration();
        const identity = await this.module.waitForMigrationIdentity(this.options.backendReconnectTimeoutMs);
        if (!isQqLegacyIdentity(identity) || identity.selfId !== record.plan.identity.selfId) migrationFail("module-account-unverified");
        record.phase = "module-staged"; save(record);
        if (qqMigrationDigest(this.options.readLegacySettings()) !== record.plan.sourceDigest) migrationFail("settings-changed");
        record.phase = "committed"; save(record);
        if (!this.module.activateMigration()) migrationFail("module-disconnected-before-activation");
        return this.outcome("committed");
      } catch (error) {
        const code = error instanceof QqMigrationError ? error.code : "operation-failed";
        // Never restart old code, even after local rollback. Its availability and
        // account identity require a separate verified host action.
        try {
          if (this.module) {
            await this.module.stop();
            if (!this.module.isStoppedForMigration()) return this.outcome("recovery-required", code);
          }
          record.phase = "rolled-back"; save(record);
          return this.outcome("rolled-back", code);
        } catch { return this.outcome("recovery-required", code); }
      } finally { token = ""; }
    });
  }
  /** Explicit rollback/restart recovery only after host composition verifies BOTH
   * drivers are stopped, including any process left by the previous host instance.
   * No automatic stale-lock deletion or guessed process-exit proof is provided. */
  async rollbackStoppedMigration(verifyAllDriversStopped: () => Promise<boolean>): Promise<QqMigrationOutcome> {
    return this.options.store.locked(async (save) => {
      const record = this.options.store.read();
      if (!record) migrationFail("no-migration");
      if (this.module) {
        await this.module.stop();
        if (!this.module.isStoppedForMigration()) return this.outcome("recovery-required", "module-stop-unconfirmed");
      }
      if (!await verifyAllDriversStopped()) return this.outcome("recovery-required", "driver-stop-unconfirmed");
      record.phase = "rolled-back"; save(record);
      this.preview = undefined;
      return this.outcome("rolled-back");
    });
  }
  private outcome(outcome: QqMigrationOutcome["outcome"], errorCode?: string): QqMigrationOutcome {
    return { outcome, legacyData: "unchanged", legacyRuntime: "not-restarted", ...(errorCode ? { errorCode } : {}) };
  }
}
