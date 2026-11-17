import { lstatSync } from "node:fs";
import { QqAdoptionProofCoordinator, snapshotQqAdoptionContext, type QqAdoptionContext, type QqAdoptionProof, type QqAdoptionProofPorts } from "./adoption-proof";
import { QqAdoptionIntentStore, type QqAdoptionIntent } from "./adoption-intent";
import { createQqCurrentHostLegacyAdoptionPort } from "./adoption-legacy-port";
import { buildQqMigrationPlan, qqMigrationDigest, readQqMigrationToken } from "./migration-plan";
import { readQqLifecycleDiagnostics } from "./lifecycle-diagnostics";
import { join } from "node:path";
import type { QqModuleActionCommand, QqModuleActionResult, QqModuleConfigurationView } from "../../shared/qq-module-actions";
import type { QqRoutingAdapter } from "../channels/adapters/qq-routing-adapter";
import { QqModuleHostService } from "./host-service";
import { QqConfigurationProposalStore, qqConfigurationProposalDirectory, type QqConfigurationProposalBinding } from "./configuration-proposal";
import { QqSecureCredentialStore, qqSecureCredentialDirectory, type QqSecureStoragePort } from "./secure-credential-store";
import { createQqElectronSecureStoragePort } from "./secure-credential-electron";
import { QqDriverOwnershipSupervisor, type QqDriverActivationGrant, type QqDriverOwnershipOptions } from "./driver-ownership";
import { createQqUtilityProcess } from "./utility-process";
import type { QqProcessTransport } from "./runtime";
import type { QqPackageVerificationContext, QqSignedPackage } from "./package-verifier";

export interface QqProductionHostOptions {
  userDataPath: string;
  router: QqRoutingAdapter;
  /** Explicit reviewed MAIN policy only. No bundled/default key, URL or env override. */
  releasePolicy?: { verificationContext(): QqPackageVerificationContext; candidate(): QqSignedPackage };
  /** Scope identifies ONLY this managed Cyrene profile's adapters, not QQ/NapCat itself.
   * Bootstrap must independently establish historical unmanaged-driver absence. */
  ownership: Pick<QqDriverOwnershipOptions, "scopeId" | "bootstrap">;
  /** Confirm-time initial adoption only. Existing owner state can never be overridden. */
  adoption?: Pick<QqAdoptionProofCoordinator, "prepare">;
  /** Explicit validated-upgrade source and reviewed historical proof provider.
   * No default sources, versions or absence evidence. Same route must own legacy. */
  legacyUpgrade?: {
    readLegacySettings(): Uint8Array;
    adoption: Pick<QqAdoptionProofPorts, "readContext" | "reviewedPolicy" | "exclusiveScope">;
  };
  secureStorage?: QqSecureStoragePort;
  createTransport?: typeof createQqUtilityProcess;
  backendReconnectTimeoutMs?: number;
}
/** Optional production composition. NOT enabled by application startup. This first
 * closed-world binding requires a blocked route and supports module-only first setup
 * and recovery. Unsupervised legacy migration remains deliberately unavailable. */
export function createQqProductionHost(options: QqProductionHostOptions): QqProductionHost | undefined {
  if (!options.releasePolicy) return undefined; // No disk/secret/process work without policy.
  if (options.router.getDriver() !== "blocked" && !(options.legacyUpgrade && options.router.getDriver() === "legacy")) throw new Error("QQ_PRODUCTION_EXCLUSIVE_ROUTE_REQUIRED");
  return new QqProductionHost(options);
}
export class QqProductionHost {
  private readonly proposals: QqConfigurationProposalStore;
  private readonly credentials: QqSecureCredentialStore;
  private readonly service: QqModuleHostService;
  private binding?: QqConfigurationProposalBinding;
  private upgradePreview?: { operationId: string; accountId: string; connectionEpoch: number; packageId: string; context: QqAdoptionContext; sourceDigest: string };
  private readonly secure: QqSecureStoragePort;
  private upgradeIntent?: QqAdoptionIntent;
  private upgradeImported?: { proposal: ReturnType<QqConfigurationProposalStore["propose"]>; generation: string };
  private owner?: QqDriverOwnershipSupervisor;
  private adoptionProof?: QqAdoptionProof;
  private grant?: QqDriverActivationGrant;
  private candidate?: QqProcessTransport;
  private prepared = false;
  private closing = false;
  private operation?: Promise<QqModuleActionResult>;
  private stopping?: Promise<void>;
  constructor(private readonly options: QqProductionHostOptions) {
    if (!options.releasePolicy || (options.router.getDriver() !== "blocked" && !(options.legacyUpgrade && options.router.getDriver() === "legacy"))) throw new Error("QQ_PRODUCTION_POLICY_REQUIRED");
    if (options.legacyUpgrade && (options.adoption || options.ownership.bootstrap)) throw new Error("QQ_PRODUCTION_AMBIGUOUS_UPGRADE");
    if (options.adoption && options.ownership.bootstrap) throw new Error("QQ_PRODUCTION_AMBIGUOUS_ADOPTION");
    const secure = options.secureStorage ?? createQqElectronSecureStoragePort();
    this.secure = secure;
    this.credentials = new QqSecureCredentialStore(qqSecureCredentialDirectory(options.userDataPath), secure);
    this.proposals = new QqConfigurationProposalStore(qqConfigurationProposalDirectory(options.userDataPath));
    const desired = () => {
      if (!this.binding) throw new Error("QQ_PRODUCTION_PROPOSAL_REQUIRED");
      const proposal = this.proposals.assertCurrent(this.binding);
      return this.proposals.readDesired(this.binding, proposal.enabled ? this.credentials.getMetadata() : null);
    };
    const prepare = async () => {
      if (this.closing) return false;
      if (!this.owner) {
        const directory = join(options.userDataPath, "qq-module-driver-ownership");
        let exists = true;
        try { lstatSync(directory); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; exists = false; }
        if (!exists && options.adoption) {
          this.adoptionProof = await options.adoption.prepare();
          if (this.closing || this.adoptionProof.scopeId !== options.ownership.scopeId || !this.adoptionProof.isHeld()) {
            this.adoptionProof.cancel(); throw new Error("QQ_PRODUCTION_ADOPTION_LOST");
          }
        }
        this.owner = QqDriverOwnershipSupervisor.open({ ...options.ownership,
          ...(this.adoptionProof ? { bootstrap: this.adoptionProof.bootstrap } : {}), directory });
      }
      if (!this.adoptionHeld()) throw new Error("QQ_PRODUCTION_ADOPTION_LOST");
      const grant = await this.owner.beginActivation();
      if (this.closing || !this.adoptionHeld()) throw new Error("QQ_PRODUCTION_ADOPTION_LOST");
      this.prepared = true;
      // A disable transaction must not leave a factory permission available.
      this.grant = desired().enabled ? grant : undefined;
      return this.adoptionHeld() && this.owner.verifyAllStopped();
    };
    this.service = new QqModuleHostService({ userDataPath: options.userDataPath, router: options.router,
      ...options.releasePolicy, appName: "Cyrene", secureStorage: secure,
      readLegacySettings: () => this.readUpgradeSettings(),
      ...(options.legacyUpgrade ? { migrationLegacy: {
        getMigrationIdentity: () => options.router.getMigrationIdentity(),
        prepareMigrationStop: async (identity: { accountId: string; connectionEpoch: number }) => {
          const p = this.assertUpgradePreview();
          if (identity.accountId !== p.accountId || identity.connectionEpoch !== p.connectionEpoch || this.owner || this.closing) throw new Error("QQ_PRODUCTION_UPGRADE_STALE");
          const intent = new QqAdoptionIntentStore(options.userDataPath);
          const adoption = options.legacyUpgrade!.adoption;
          const coordinator = new QqAdoptionProofCoordinator({
            readContext: () => { this.assertUpgradePreview(); return adoption.readContext(); },
            reviewedPolicy: adoption.reviewedPolicy, exclusiveScope: adoption.exclusiveScope,
            persistIntent: context => {
              // Import already persisted this exact attempt before writing sidecars.
              if (!this.upgradeIntent || JSON.stringify(intent.read()) !== JSON.stringify(this.upgradeIntent)
                || JSON.stringify(context) !== JSON.stringify(this.upgradeIntent.context)) throw new Error("QQ_PRODUCTION_UPGRADE_INTENT_CHANGED");
            },
            legacy: createQqCurrentHostLegacyAdoptionPort(options.router, identity),
          });
          this.adoptionProof = await coordinator.prepare();
          if (this.closing || !this.adoptionHeld()) { this.adoptionProof.cancel(); throw new Error("QQ_PRODUCTION_ADOPTION_LOST"); }
          this.owner = QqDriverOwnershipSupervisor.open({ scopeId: options.ownership.scopeId, bootstrap: this.adoptionProof.bootstrap,
            directory: join(options.userDataPath, "qq-module-driver-ownership") });
          const grant = await this.owner.beginActivation();
          if (this.closing || !this.adoptionHeld()) throw new Error("QQ_PRODUCTION_ADOPTION_LOST");
          this.grant = grant;
          return { safeToSwitch: true, drained: true, stopped: this.owner.verifyAllStopped() };
        },
      } } : {}),
      readFirstConfiguration: accountId => { const d = desired(); if (!d.enabled || d.config.expectedSelfId !== accountId) throw new Error("QQ_PRODUCTION_ACCOUNT_MISMATCH"); return d.config; },
      readFirstCredential: () => { const d = desired(); return this.credentials.read({ accountId: d.config.expectedSelfId, generation: d.credentialRevision }); },
      verifyNoLegacyDriver: () => this.prepared ? Promise.resolve(this.adoptionHeld() && this.owner?.verifyNoOtherDrivers(this.candidate) === true) : prepare(),
      lifecycle: { readDesired: desired, readCredential: d => this.credentials.read({ accountId: d.config.expectedSelfId, generation: d.credentialRevision }),
        verifyAllDriversStopped: prepare, verifyNoOtherDrivers: async () => this.adoptionHeld() && this.owner?.verifyNoOtherDrivers(this.candidate) === true },
      createTransport: (directory, entry) => {
        if (!this.owner || !this.grant || this.closing || !this.adoptionHeld()) throw new Error("QQ_PRODUCTION_DRIVER_GRANT_REQUIRED");
        const factory = this.owner.wrapCreateTransport(() => (options.createTransport ?? createQqUtilityProcess)(directory, entry), this.grant);
        this.grant = undefined;
        return this.candidate = factory();
      }, backendReconnectTimeoutMs: options.backendReconnectTimeoutMs });
  }
  private assertUpgradePreview() {
    const p = this.upgradePreview, upgrade = this.options.legacyUpgrade;
    if (!p || !upgrade || JSON.stringify(snapshotQqAdoptionContext(upgrade.adoption.readContext())) !== JSON.stringify(p.context)
      || upgrade.adoption.reviewedPolicy.approve(p.context) !== true) throw new Error("QQ_PRODUCTION_UPGRADE_STALE");
    return p;
  }
  private readUpgradeSettings(): Uint8Array {
    if (!this.options.legacyUpgrade) throw new Error("QQ_PRODUCTION_LEGACY_UNSUPERVISED");
    if (this.upgradePreview) this.assertUpgradePreview();
    if (this.upgradeImported) {
      const metadata = this.credentials.getMetadata();
      if (!metadata || metadata.status !== "active" || metadata.generation !== this.upgradeImported.generation
        || metadata.accountId !== this.upgradePreview?.accountId || JSON.stringify(this.proposals.read()) !== JSON.stringify(this.upgradeImported.proposal)) throw new Error("QQ_PRODUCTION_UPGRADE_IMPORT_CHANGED");
    }
    if (this.adoptionProof && (!this.adoptionHeld() || (this.owner && !this.owner.verifyNoOtherDrivers(this.candidate)))) throw new Error("QQ_PRODUCTION_ADOPTION_LOST");
    return this.options.legacyUpgrade.readLegacySettings();
  }
  private importUpgradeConfiguration(): void {
    const p = this.assertUpgradePreview();
    const bytes = this.readUpgradeSettings();
    if (qqMigrationDigest(bytes) !== p.sourceDigest) throw new Error("QQ_PRODUCTION_UPGRADE_STALE");
    const identity = this.options.router.getMigrationIdentity();
    if (!identity || identity.accountId !== p.accountId || identity.connectionEpoch !== p.connectionEpoch) throw new Error("QQ_PRODUCTION_UPGRADE_STALE");
    // Never overwrite another secure credential/proposal or silently merge policies.
    if (this.credentials.getMetadata() || this.proposals.read()) throw new Error("QQ_PRODUCTION_UPGRADE_DESTINATION_EXISTS");
    const plan = buildQqMigrationPlan(bytes, { selfId: p.accountId, connectionEpoch: p.connectionEpoch });
    const intent = new QqAdoptionIntentStore(this.options.userDataPath);
    intent.persistIntent(p.context); this.upgradeIntent = intent.read()!;
    let token = readQqMigrationToken(bytes, this.secure, { userDataPath: this.options.userDataPath, appName: "Cyrene" });
    try {
      if (!token.trim()) throw new Error("QQ_PRODUCTION_UPGRADE_CREDENTIAL_REQUIRED");
      const credential = this.credentials.write({ accountId: p.accountId, token, expectedGeneration: null, userConfirmed: true });
      const proposal = this.proposals.propose({ config: plan.config, enabled: true, credentialGeneration: credential.generation }, null);
      this.upgradeImported = { proposal, generation: credential.generation };
    } finally { token = ""; }
  }
  private adoptionHeld(): boolean { return !this.adoptionProof || this.adoptionProof.isHeld(); }
  private view(): QqModuleConfigurationView {
    const current = this.proposals.read();
    // Unreadable credentials are unavailable, not permission to use an old token.
    // Nonsecret disabled proposals must remain editable without decrypting anything.
    let metadata: ReturnType<QqSecureCredentialStore["getMetadata"]> = null;
    try { metadata = this.credentials.getMetadata(); } catch { /* fail closed for enabling */ }
    return { proposalRevision: current?.revision ?? null, config: current ? structuredClone(current.config) : null,
      enabled: current?.enabled ?? false, credentialAccountId: metadata?.status === "active" ? metadata.accountId : null };
  }
  execute(command: QqModuleActionCommand): Promise<QqModuleActionResult> {
    if (this.closing) return Promise.resolve({ ok: false, error: "recovery-required" });
    if (this.operation) return Promise.resolve({ ok: false, error: "busy" });
    const operation = Promise.resolve().then(() => this.perform(command)); this.operation = operation;
    void operation.finally(() => { if (this.operation === operation) this.operation = undefined; }).catch(() => {});
    return operation;
  }
  private async perform(command: QqModuleActionCommand): Promise<QqModuleActionResult> {
    if (command.action === "read-diagnostics") return { ok: true, state: "diagnostics", diagnostics: readQqLifecycleDiagnostics(this.options.userDataPath) };
    if (command.action === "preview-migration" || command.action === "confirm-migration") {
      if (!this.options.legacyUpgrade) return { ok: false, error: "unconfigured" };
      if (command.action === "preview-migration") {
        if (this.options.router.getDriver() !== "legacy") return { ok: false, error: "recovery-required" };
        this.upgradePreview = undefined;
        const context = snapshotQqAdoptionContext(this.options.legacyUpgrade.adoption.readContext());
        if (context.mode !== "validated-upgrade" || context.scopeId !== this.options.ownership.scopeId
          || this.options.legacyUpgrade.adoption.reviewedPolicy.approve(context) !== true) return { ok: false, error: "unconfigured" };
        const identity = this.options.router.getMigrationIdentity();
        if (!identity) return { ok: false, error: "recovery-required" };
        const sourceDigest = qqMigrationDigest(this.options.legacyUpgrade.readLegacySettings());
        const result = await this.service.execute(command);
        if (result.ok && result.state === "preview-migration" && "preview" in result) {
          if (result.preview.packageId !== `pkg-${context.moduleSha256}` || result.preview.accountId !== identity.accountId) {
            await this.service.execute({ action: "cancel", operationId: result.preview.operationId });
            return { ok: false, error: "stale" };
          }
          this.upgradePreview = { operationId: result.preview.operationId, accountId: identity.accountId,
            connectionEpoch: identity.connectionEpoch, packageId: result.preview.packageId, context, sourceDigest };
          this.assertUpgradePreview();
        }
        return result;
      }
      const p = this.upgradePreview;
      if (!p || p.operationId !== command.operationId || p.accountId !== command.accountId || command.userConfirmed !== true) return { ok: false, error: "stale" };
      try { this.importUpgradeConfiguration(); return await this.service.execute(command); }
      finally { this.grant = undefined; }
    }
    if (this.options.router.getDriver() === "legacy" && ["preview-setup", "confirm-setup", "preview-recovery", "confirm-recovery", "preview-reconfigure", "confirm-reconfigure", "propose-configuration"].includes(command.action)) return { ok: false, error: "unconfigured" };
    if (command.action === "read-configuration") return { ok: true, state: "configuration", configuration: this.view() };
    if (command.action === "propose-configuration") {
      if (this.binding) return { ok: false, error: "busy" };
      const prior = this.proposals.read();
      if ((prior?.revision ?? null) !== command.expectedRevision) return { ok: false, error: "stale" };
      // No token import, generation, file path or release key is accepted from renderer.
      const metadata = command.enabled ? this.credentials.getMetadata() : null;
      if (command.enabled && (!metadata || metadata.status !== "active" || metadata.accountId !== command.config.expectedSelfId)) return { ok: false, error: "unconfigured" };
      const generation = command.enabled ? metadata!.generation : prior?.credentialGeneration;
      if (!generation) return { ok: false, error: "unconfigured" };
      this.proposals.propose({ config: { ...structuredClone(command.config), configRevision: (prior?.config.configRevision ?? 0) + 1 }, enabled: command.enabled, credentialGeneration: generation }, command.expectedRevision);
      return { ok: true, state: "configuration-saved", configuration: this.view() };
    }
    if (command.action === "cancel" && !this.adoptionProof) this.upgradePreview = undefined;
    if (command.action.startsWith("preview-")) {
      if (!this.adoptionProof) this.upgradePreview = undefined;
      this.binding = undefined; this.prepared = false; this.grant = undefined;
      if (["preview-setup", "preview-recovery", "preview-reconfigure"].includes(command.action)) {
        const proposal = this.proposals.read(); if (!proposal) return { ok: false, error: "unconfigured" };
        this.binding = { proposalId: proposal.proposalId, revision: proposal.revision };
      }
    }
    try {
      const result = await this.service.execute(command);
      if (command.action.startsWith("preview-") && (!result.ok || !("preview" in result))) this.binding = undefined;
      return result;
    } catch (error) { if (command.action.startsWith("preview-")) this.binding = undefined; throw error; }
    finally {
      if (command.action.startsWith("confirm-") || command.action === "cancel") { this.binding = undefined; this.grant = undefined; }
    }
  }
  shutdown(): Promise<void> {
    this.closing = true;
    return this.stopping ??= (async () => {
      await this.operation?.catch(() => {});
      await this.service.shutdown();
      this.grant = undefined;
      // Stop owned children even if external evidence was lost, but never mark clean.
      if (!this.adoptionHeld()) throw new Error("QQ_PRODUCTION_ADOPTION_LOST");
      this.owner?.retire();
    })();
  }
}
