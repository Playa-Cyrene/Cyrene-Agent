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
  secureStorage?: QqSecureStoragePort;
  createTransport?: typeof createQqUtilityProcess;
  backendReconnectTimeoutMs?: number;
}
/** Optional production composition. NOT enabled by application startup. This first
 * closed-world binding requires a blocked route and supports module-only first setup
 * and recovery. Unsupervised legacy migration remains deliberately unavailable. */
export function createQqProductionHost(options: QqProductionHostOptions): QqProductionHost | undefined {
  if (!options.releasePolicy) return undefined; // No disk/secret/process work without policy.
  if (options.router.getDriver() !== "blocked") throw new Error("QQ_PRODUCTION_EXCLUSIVE_ROUTE_REQUIRED");
  return new QqProductionHost(options);
}
export class QqProductionHost {
  private readonly proposals: QqConfigurationProposalStore;
  private readonly credentials: QqSecureCredentialStore;
  private readonly service: QqModuleHostService;
  private binding?: QqConfigurationProposalBinding;
  private owner?: QqDriverOwnershipSupervisor;
  private grant?: QqDriverActivationGrant;
  private candidate?: QqProcessTransport;
  private prepared = false;
  private closing = false;
  private operation?: Promise<QqModuleActionResult>;
  private stopping?: Promise<void>;
  constructor(private readonly options: QqProductionHostOptions) {
    if (!options.releasePolicy || options.router.getDriver() !== "blocked") throw new Error("QQ_PRODUCTION_POLICY_REQUIRED");
    const secure = options.secureStorage ?? createQqElectronSecureStoragePort();
    this.credentials = new QqSecureCredentialStore(qqSecureCredentialDirectory(options.userDataPath), secure);
    this.proposals = new QqConfigurationProposalStore(qqConfigurationProposalDirectory(options.userDataPath));
    const desired = () => {
      if (!this.binding) throw new Error("QQ_PRODUCTION_PROPOSAL_REQUIRED");
      const proposal = this.proposals.assertCurrent(this.binding);
      return this.proposals.readDesired(this.binding, proposal.enabled ? this.credentials.getMetadata() : null);
    };
    const prepare = async () => {
      if (this.closing) return false;
      this.owner ??= QqDriverOwnershipSupervisor.open({ ...options.ownership, directory: join(options.userDataPath, "qq-module-driver-ownership") });
      const grant = await this.owner.beginActivation();
      this.prepared = true;
      // A disable transaction must not leave a factory permission available.
      this.grant = desired().enabled ? grant : undefined;
      return this.owner.verifyAllStopped();
    };
    this.service = new QqModuleHostService({ userDataPath: options.userDataPath, router: options.router,
      ...options.releasePolicy, appName: "Cyrene", secureStorage: secure,
      readLegacySettings: () => { throw new Error("QQ_PRODUCTION_LEGACY_UNSUPERVISED"); },
      readFirstConfiguration: accountId => { const d = desired(); if (!d.enabled || d.config.expectedSelfId !== accountId) throw new Error("QQ_PRODUCTION_ACCOUNT_MISMATCH"); return d.config; },
      readFirstCredential: () => { const d = desired(); return this.credentials.read({ accountId: d.config.expectedSelfId, generation: d.credentialRevision }); },
      verifyNoLegacyDriver: () => this.prepared ? Promise.resolve(this.owner?.verifyNoOtherDrivers(this.candidate) === true) : prepare(),
      lifecycle: { readDesired: desired, readCredential: d => this.credentials.read({ accountId: d.config.expectedSelfId, generation: d.credentialRevision }),
        verifyAllDriversStopped: prepare, verifyNoOtherDrivers: async () => this.owner?.verifyNoOtherDrivers(this.candidate) === true },
      createTransport: (directory, entry) => {
        if (!this.owner || !this.grant || this.closing) throw new Error("QQ_PRODUCTION_DRIVER_GRANT_REQUIRED");
        const factory = this.owner.wrapCreateTransport(() => (options.createTransport ?? createQqUtilityProcess)(directory, entry), this.grant);
        this.grant = undefined;
        return this.candidate = factory();
      }, backendReconnectTimeoutMs: options.backendReconnectTimeoutMs });
  }
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
    if (command.action === "preview-migration" || command.action === "confirm-migration") return { ok: false, error: "unconfigured" };
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
    if (command.action.startsWith("preview-")) {
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
      this.owner?.retire();
    })();
  }
}
