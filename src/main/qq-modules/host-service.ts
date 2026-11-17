import { join } from "node:path";
import type { QqRuntimeConfig } from "../../shared/qq-module";
import type { QqModuleActionCommand, QqModuleActionResult } from "../../shared/qq-module-actions";
import type { QqRoutingAdapter } from "../channels/adapters/qq-routing-adapter";
import { QqInstallationController } from "./installation-controller";
import { QqPackageStore } from "./package-store";
import type { QqPackageVerificationContext, QqSignedPackage } from "./package-verifier";
import { QqMigrationCoordinator } from "./migration";
import type { QqMigrationSecretStorage } from "./migration-plan";
import { QqMigrationStore } from "./migration-store";
import { QqFirstSetupCoordinator } from "./first-setup";
import { QqFirstSetupStore } from "./first-setup-store";
import { getQqStartupMode, qqLifecyclePaths } from "./startup-recovery";
import { createQqTrustedRuntimeFactory } from "./trusted-runtime-factory";

export interface QqModuleHostOptions {
  /** All inputs originate in reviewed MAIN-process composition, never renderer input.
   * There is deliberately no default publisher, URL, release key or environment override. */
  userDataPath: string;
  router: QqRoutingAdapter;
  verificationContext(): QqPackageVerificationContext;
  candidate(): QqSignedPackage;
  readLegacySettings(): Uint8Array;
  secureStorage: QqMigrationSecretStorage;
  appName: string;
  readFirstConfiguration(accountId: string): QqRuntimeConfig;
  /** Must read a secure host credential; no plaintext/obfuscation fallback. */
  readFirstCredential(): string;
  verifyNoLegacyDriver(): Promise<boolean>;
  backendReconnectTimeoutMs?: number;
}
/** Actual host composition of signed package store, verified runtime factory,
 * single QQ route, migration and independent first setup. Constructing does not
 * read disk or start drivers. Production may inject it only after release policy
 * and acceptance are approved; current startup supplies no such configuration. */
export class QqModuleHostService {
  private readonly packages: QqPackageStore;
  private readonly migrationStore: QqMigrationStore;
  private readonly setupStore: QqFirstSetupStore;
  private readonly installation: QqInstallationController;
  private readonly factory: ReturnType<typeof createQqTrustedRuntimeFactory>;
  private setup?: QqFirstSetupCoordinator;
  private pending?: { kind: "install" | "migration" | "setup"; id: string; accountId?: string };
  private operation?: Promise<QqModuleActionResult>;
  private closing = false;
  constructor(private readonly options: QqModuleHostOptions) {
    const paths = qqLifecyclePaths(options.userDataPath);
    this.packages = new QqPackageStore(join(options.userDataPath, "qq-module-packages"), options.verificationContext);
    this.migrationStore = new QqMigrationStore(paths.migration);
    this.setupStore = new QqFirstSetupStore(paths.firstSetup);
    const runtime = createQqTrustedRuntimeFactory({ packages: this.packages, mediaCacheDirectory: join(options.userDataPath, "qq-module-media") });
    this.factory = {
      verifyCandidate: runtime.verifyCandidate,
      createModule: (input, id) => {
        if (this.closing) throw new Error("QQ_HOST_CLOSING");
        const manager = runtime.createModule(input, id);
        options.router.attachModule(manager);
        return manager;
      },
    };
    const migration = new QqMigrationCoordinator({ store: this.migrationStore, readLegacySettings: options.readLegacySettings,
      legacy: options.router, secureStorage: options.secureStorage,
      legacyMachine: { userDataPath: options.userDataPath, appName: options.appName },
      ...this.factory, backendReconnectTimeoutMs: options.backendReconnectTimeoutMs });
    this.installation = new QqInstallationController({ packages: this.packages, verificationContext: options.verificationContext, migration });
  }
  execute(command: QqModuleActionCommand): Promise<QqModuleActionResult> {
    if (this.closing) return Promise.resolve({ ok: false, error: "recovery-required" });
    if (this.operation) return Promise.resolve({ ok: false, error: "busy" });
    // Promise deferral installs the lock before any synchronous/reentrant port work.
    const operation = Promise.resolve().then(() => this.perform(command));
    this.operation = operation;
    void operation.finally(() => { if (this.operation === operation) this.operation = undefined; }).catch(() => {});
    return operation;
  }
  private recoveryRequired(): boolean { return getQqStartupMode(this.options.userDataPath) === "blocked"; }
  private cancelPending(): void {
    if (!this.pending) return;
    if (this.pending.kind === "setup") this.setup!.cancel({ previewId: this.pending.id });
    else this.installation.cancel({ operationId: this.pending.id });
    this.pending = undefined;
  }
  private async perform(command: QqModuleActionCommand): Promise<QqModuleActionResult> {
    if (command.action === "status") {
      if (this.options.router.getDriver() === "module" && this.options.router.getStatus().phase === "running") return { ok: true, state: "committed" };
      return { ok: true, state: this.recoveryRequired() ? "recovery-required" : "ready" };
    }
    if (command.action === "cancel") {
      if (this.pending?.id !== command.operationId) return { ok: false, error: "stale" };
      this.cancelPending(); return { ok: true, state: "cancelled" };
    }
    // Installation and first setup can never supersede an existing durable lifecycle
    // or a possibly live driver. Recovery is a separate explicit host operation.
    if (command.action.startsWith("preview-")) {
      this.cancelPending();
      if (this.recoveryRequired() || this.options.router.getDriver() === "module") return { ok: false, error: "recovery-required" };
    }
    switch (command.action) {
      case "preview-install": {
        const preview = this.installation.previewInstallation(this.options.candidate());
        this.pending = { kind: "install", id: preview.operationId };
        return { ok: true, state: "preview-install", preview: { operationId: preview.operationId, packageId: preview.packageId, version: preview.version } };
      }
      case "confirm-install": {
        if (this.recoveryRequired()) return { ok: false, error: "recovery-required" };
        if (this.pending?.kind !== "install" || this.pending.id !== command.operationId) return { ok: false, error: "stale" };
        this.pending = undefined;
        this.installation.confirmInstallation({ operationId: command.operationId, userConfirmed: command.userConfirmed });
        return { ok: true, state: "installed" };
      }
      case "preview-migration": {
        const preview = this.installation.previewMigration();
        this.pending = { kind: "migration", id: preview.previewId };
        return { ok: true, state: "preview-migration", preview: { operationId: preview.previewId, packageId: preview.targetPackageId, accountId: preview.accountId } };
      }
      case "confirm-migration": {
        if (this.pending?.kind !== "migration" || this.pending.id !== command.operationId) return { ok: false, error: "stale" };
        this.pending = undefined;
        const result = await this.installation.confirmMigration({ previewId: command.operationId, accountId: command.accountId, userConfirmed: command.userConfirmed });
        return { ok: true, state: result.outcome };
      }
      case "preview-setup": {
        const selected = this.packages.getSelected();
        if (!selected) return { ok: false, error: "operation-failed" };
        let routePrepared = false;
        this.setup = new QqFirstSetupCoordinator({ store: this.setupStore,
          readConfiguration: () => this.options.readFirstConfiguration(command.accountId),
          readCredential: this.options.readFirstCredential, secureStorage: this.options.secureStorage,
          verifyNoLegacyDriver: () => {
            if (!routePrepared) {
              routePrepared = true;
              return this.options.router.prepareFirstSetup(this.options.verifyNoLegacyDriver);
            }
            return this.options.verifyNoLegacyDriver();
          }, ...this.factory,
          backendReconnectTimeoutMs: this.options.backendReconnectTimeoutMs });
        const preview = this.setup.previewSetup(selected.packageId);
        this.pending = { kind: "setup", id: preview.previewId, accountId: preview.accountId };
        return { ok: true, state: "preview-setup", preview: { operationId: preview.previewId, packageId: preview.packageId, accountId: preview.accountId } };
      }
      case "confirm-setup": {
        if (this.pending?.kind !== "setup" || this.pending.id !== command.operationId || this.pending.accountId !== command.accountId) return { ok: false, error: "stale" };
        const setup = this.setup!;
        this.pending = undefined;
        const result = await setup.confirmSetup({ previewId: command.operationId, accountId: command.accountId, userConfirmed: command.userConfirmed });
        return { ok: true, state: result.outcome };
      }
    }
  }
  /** Application shutdown first disallows new actions and waits for the already
   * confirmed operation, then stops its single route. Never let a late factory
   * attach/start after shutdown completed. No automatic operation replay. */
  async shutdown(): Promise<void> {
    this.closing = true;
    await this.operation?.catch(() => {});
    this.cancelPending();
    await this.options.router.stop();
  }
}
