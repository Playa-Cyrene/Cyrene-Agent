import { randomUUID } from "node:crypto";
import { lstatSync } from "node:fs";
import { join } from "node:path";
import { strictObject } from "../../shared/qq-module/validation";
import { validateRequestPayload, type QqInitialize } from "../../shared/qq-module";
import { isQqModuleLoopbackHost } from "./listen-policy";
import type { QqModuleManager } from "./manager";
import type { QqFirstSetupStore } from "./first-setup-store";
import type { QqMigrationStore } from "./migration-store";
import { QqRecoveryError, QqRecoveryStore, recoveryFail, validateQqRecoveryDesired, validateQqRecoveryOrigin,
  type QqRecoveryBaseline, type QqRecoveryDesired, type QqRecoveryOrigin, type QqRecoveryRecord } from "./recovery-store";

function unlocked(root: string, lock: string, requireState = false): void {
  let rootPresent = false;
  try {
    const stat = lstatSync(root); rootPresent = true;
    if (!stat.isDirectory() || stat.isSymbolicLink()) recoveryFail("unsafe-source");
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  try {
    const state = lstatSync(join(root, "state.json"));
    if (state.isSymbolicLink() || !state.isFile() || state.nlink !== 1) recoveryFail("unsafe-source");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    if (rootPresent && requireState) recoveryFail("incomplete-source");
  }
  try { lstatSync(join(root, lock)); recoveryFail("source-locked"); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
}
/** Reads the single completed ORIGINAL selection. Never guesses among two sources,
 * never repairs corrupt/locked/interrupted state, never writes the source stores. */
export function readQqRecoveryOrigin(setup: QqFirstSetupStore, migration: QqMigrationStore): QqRecoveryOrigin {
  unlocked(setup.root, "setup-lock", true); unlocked(migration.root, "migration-lock", true);
  const first = setup.read(), legacy = migration.read();
  if (Boolean(first) === Boolean(legacy)) recoveryFail("ambiguous-or-missing-source");
  if (first) {
    if (first.phase !== "selected") recoveryFail("incomplete-source");
    return { kind: "first-setup", transactionId: first.transactionId, packageId: first.packageId, config: structuredClone(first.config) };
  }
  if (!legacy || legacy.phase !== "selected") recoveryFail("incomplete-source");
  return { kind: "migration", transactionId: legacy.transactionId, packageId: legacy.packageId, config: structuredClone(legacy.plan.config) };
}
export interface QqRecoveryPreview {
  previewId: string; action: "recover" | "reconfigure"; packageId: string; accountId: string;
  desiredEnabled: boolean; config: QqRecoveryDesired["config"];
  changes: ("allowlist" | "enabled" | "account" | "credential" | "listen" | "configuration")[];
}
export interface QqRecoveryOutcome { outcome: "committed" | "disabled" | "rolled-back" | "recovery-required"; errorCode?: string }
export interface QqRecoveryOptions {
  store: QqRecoveryStore;
  readSource(): QqRecoveryOrigin;
  /** Trusted host desired snapshot. For recovery it MUST equal canonical config/enabled
   * and any recorded credential generation. Historical source records have no generation;
   * their first explicit recovery binds the current nonsecret secure-storage revision. */
  readConfiguration(baseline: QqRecoveryBaseline): QqRecoveryDesired;
  secureStorage: { isSecureAvailable(): boolean };
  readCredential(snapshot: QqRecoveryDesired): string;
  verifyCandidate(packageId: string): void;
  /** May stop/revoke the old route, then independently prove ALL QQ drivers stopped.
   * Called only after durable intent. Host must retain exclusive routing ownership. */
  prepareAllDriversStopped(snapshot: QqRecoveryDesired): Promise<boolean>;
  /** Checks old/OTHER drivers only; the newly quarantined module is permitted.
   * This is not a substitute for the preceding ALL-stopped proof. */
  verifyNoOtherDrivers(): Promise<boolean>;
  createModule(input: QqInitialize, packageId: string): QqModuleManager;
  backendReconnectTimeoutMs?: number;
}
const equal = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);
function changes(a: QqRecoveryBaseline, b: QqRecoveryDesired): QqRecoveryPreview["changes"] {
  const out: QqRecoveryPreview["changes"] = [];
  if (!equal([a.config.allowedPrivateUserIds, a.config.allowedGroupIds], [b.config.allowedPrivateUserIds, b.config.allowedGroupIds])) out.push("allowlist");
  if (a.enabled !== b.enabled) out.push("enabled");
  if (a.config.expectedSelfId !== b.config.expectedSelfId) out.push("account");
  if (a.credentialRevision !== null && a.credentialRevision !== b.credentialRevision) out.push("credential");
  if (!equal(a.config.listen, b.config.listen)) out.push("listen");
  if (!equal(a.config, b.config) && !out.some((v) => ["allowlist", "account", "listen"].includes(v))) out.push("configuration");
  return out;
}
export class QqRecoveryCoordinator {
  private pending?: { preview: QqRecoveryPreview; origin: QqRecoveryOrigin; baseline: QqRecoveryBaseline; desired: QqRecoveryDesired; previousRecord: QqRecoveryRecord | null };
  private busy = false;
  private module?: QqModuleManager;
  constructor(private readonly options: QqRecoveryOptions) {}
  private ready(): void { if (this.busy) recoveryFail("operation-busy"); }
  private origin(): QqRecoveryOrigin {
    const source = this.options.readSource();
    if (!validateQqRecoveryOrigin(source)) recoveryFail("invalid-source");
    return structuredClone(source);
  }
  private baseline(origin: QqRecoveryOrigin, previous: QqRecoveryRecord | null): QqRecoveryBaseline {
    if (!previous) return { config: structuredClone(origin.config), enabled: true, credentialRevision: null };
    if (!equal(previous.origin, origin)) recoveryFail("source-changed");
    if (previous.phase === "prepared" || previous.phase === "module-staged") recoveryFail("incomplete-recovery");
    return structuredClone(previous.phase === "rolled-back" ? previous.previous : previous.desired);
  }
  private desired(baseline: QqRecoveryBaseline, action: QqRecoveryPreview["action"]): QqRecoveryDesired {
    const value = this.options.readConfiguration(structuredClone(baseline));
    if (!validateQqRecoveryDesired(value) || !isQqModuleLoopbackHost(value.config.listen.host)) recoveryFail("invalid-configuration");
    if (action === "recover" && (!baseline.enabled || !value.enabled || !equal(value.config, baseline.config)
      || (baseline.credentialRevision !== null && value.credentialRevision !== baseline.credentialRevision))) recoveryFail("reconfiguration-required");
    if (action === "reconfigure" && !equal(value.config, baseline.config) && value.config.configRevision <= baseline.config.configRevision) recoveryFail("configuration-revision-required");
    if (value.enabled && !this.options.secureStorage.isSecureAvailable()) recoveryFail("secure-storage-unavailable");
    return structuredClone(value);
  }
  previewRecovery(action: QqRecoveryPreview["action"]): QqRecoveryPreview {
    this.ready(); this.pending = undefined;
    if (action !== "recover" && action !== "reconfigure") recoveryFail("invalid-action");
    unlocked(this.options.store.root, "recovery-lock");
    const origin = this.origin(), previousRecord = this.options.store.read();
    const baseline = this.baseline(origin, previousRecord), desired = this.desired(baseline, action);
    if (desired.enabled) this.options.verifyCandidate(origin.packageId);
    const preview: QqRecoveryPreview = { previewId: randomUUID(), action, packageId: origin.packageId,
      accountId: desired.config.expectedSelfId, desiredEnabled: desired.enabled, config: structuredClone(desired.config), changes: changes(baseline, desired) };
    this.pending = { preview, origin, baseline, desired, previousRecord };
    return structuredClone(preview);
  }
  cancel(input: unknown): void {
    this.ready();
    if (!strictObject(input, { previewId: (v) => typeof v === "string" }) || !this.pending
      || (input as { previewId: string }).previewId !== this.pending.preview.previewId) recoveryFail("stale-confirmation");
    this.pending = undefined;
  }
  async confirmRecovery(input: unknown): Promise<QqRecoveryOutcome> {
    this.ready();
    if (!strictObject(input, { previewId: (v) => typeof v === "string", accountId: (v) => typeof v === "string", userConfirmed: (v) => v === true })) recoveryFail("explicit-account-confirmation-required");
    const p = this.pending, consent = input as { previewId: string; accountId: string };
    if (!p || consent.previewId !== p.preview.previewId || consent.accountId !== p.preview.accountId) recoveryFail("stale-confirmation");
    this.pending = undefined; this.busy = true;
    try {
      const check = () => {
        if (!equal(this.origin(), p.origin)) recoveryFail("source-changed");
        if (!equal(this.desired(p.baseline, p.preview.action), p.desired)) recoveryFail("configuration-or-credential-changed");
        if (p.desired.enabled) this.options.verifyCandidate(p.origin.packageId);
      };
      // Ordinary stale previews must fail without creating a sidecar. An empty
      // existing sidecar is intentionally treated as unknown crash state.
      unlocked(this.options.store.root, "recovery-lock");
      if (!equal(this.options.store.read(), p.previousRecord)) recoveryFail("recovery-state-changed");
      check();
      return await this.options.store.locked(async (save) => {
        if (!equal(this.options.store.read(), p.previousRecord)) recoveryFail("recovery-state-changed");
        check();
        const record: QqRecoveryRecord = { schemaVersion: 1, transactionId: p.preview.previewId, origin: structuredClone(p.origin),
          previous: structuredClone(p.baseline), desired: structuredClone(p.desired), operation: p.preview.action, phase: "prepared" };
        const initialize = { config: structuredClone(p.desired.config), credentials: { accessToken: "" } };
        let candidate: QqModuleManager | undefined;
        let stopAttempted = false, allStopped = false;
        try {
          save(record);
          stopAttempted = true;
          if (!await this.options.prepareAllDriversStopped(structuredClone(p.desired))) recoveryFail("all-drivers-stop-unconfirmed");
          allStopped = true;
          if (this.module && !this.module.isStoppedForMigration()) recoveryFail("module-stop-unconfirmed");
          check();
          if (!p.desired.enabled) { record.phase = "disabled"; save(record); this.module = undefined; return { outcome: "disabled" }; }
          initialize.credentials.accessToken = this.options.readCredential(structuredClone(p.desired));
          if (!validateRequestPayload("initialize", initialize) || !initialize.credentials.accessToken.trim()) recoveryFail("credential-unreadable");
          if (!await this.options.verifyNoOtherDrivers()) recoveryFail("other-driver-stop-unconfirmed");
          check();
          candidate = this.options.createModule(initialize, p.origin.packageId);
          this.module = candidate;
          await candidate.stageForMigration();
          const identity = await candidate.waitForMigrationIdentity(this.options.backendReconnectTimeoutMs);
          const epoch = candidate.getState().runtimeEpoch;
          if (!identity || identity.selfId !== p.preview.accountId) recoveryFail("module-account-unverified");
          record.phase = "module-staged"; save(record);
          if (!await this.options.verifyNoOtherDrivers()) recoveryFail("other-driver-stop-unconfirmed");
          check();
          record.phase = "selected"; save(record);
          if (!candidate.activateMigration()) recoveryFail("module-disconnected-before-activation");
          const live = candidate.getActiveMigrationIdentity();
          if (!live || live.selfId !== identity.selfId || live.connectionEpoch !== identity.connectionEpoch || live.runtimeEpoch !== epoch) recoveryFail("module-account-unverified");
          return { outcome: "committed" };
        } catch (error) {
          const errorCode = error instanceof QqRecoveryError ? error.code : "operation-failed";
          try {
            // Only this attempt's candidate can be stopped here; old drivers belong
            // to the explicit all-driver port and may still be unconfirmed.
            if (candidate) { await candidate.stop(); if (!candidate.isStoppedForMigration()) return { outcome: "recovery-required", errorCode }; }
            record.phase = "rolled-back"; save(record);
            // A reverted desired selection is not proof the old runtime stopped.
            const uncertain = (stopAttempted && !allStopped) || ["other-driver-stop-unconfirmed", "module-stop-unconfirmed"].includes(errorCode);
            return { outcome: uncertain ? "recovery-required" : "rolled-back", errorCode };
          } catch { return { outcome: "recovery-required", errorCode }; }
        } finally { initialize.credentials.accessToken = ""; }
      });
    } finally { this.busy = false; }
  }
}

export type { QqRecoveryBaseline, QqRecoveryDesired, QqRecoveryOrigin } from "./recovery-store";
