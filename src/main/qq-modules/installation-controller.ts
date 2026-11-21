import { randomUUID } from "node:crypto";
import { strictObject } from "../../shared/qq-module/validation";
import { QqMigrationCoordinator, type QqMigrationOutcome, type QqMigrationPreview } from "./migration";
import { QqPackageStore, type QqInstalledCandidate } from "./package-store";
import { qqPackageDigest, verifyQqPackage, type QqPackageVerificationContext, type QqSignedPackage } from "./package-verifier";

/** Trusted host composition only. Never construct this from renderer configuration,
 * environment flags, a package's own key, or a downloaded trust document. */
export interface QqInstallationHost {
  packages: QqPackageStore;
  verificationContext(): QqPackageVerificationContext;
  migration: QqMigrationCoordinator;
}
export interface QqInstallationPreview {
  operationId: string;
  packageId: string;
  version: string;
  action: "install-only";
  startsRuntime: false;
}
export class QqInstallationOperationError extends Error {
  constructor(readonly code: "release-unconfigured" | "operation-busy" | "invalid-confirmation" | "stale-operation" | "candidate-changed") {
    super(`QQ_INSTALLATION_${code}`);
  }
}
type Pending = { kind: "installation"; id: string; input: QqSignedPackage; preview: QqInstallationPreview }
  | { kind: "migration"; id: string; preview: QqMigrationPreview };

/** Host-only rehearsal composition, deliberately NOT registered in production IPC.
 * Adds one-shot previews/cancellation and mutual exclusion to the existing stores.
 * Installation never means runtime activation. No credential, path, key, or executable
 * is accepted by confirm/cancel. No network, driver discovery or auto-recovery exists.
 * Keep one instance per host session; reconstructing it does not recover durable state.
 * The coordinator remains responsible for durable recovery and live activation proof. */
export class QqInstallationController {
  private pending?: Pending;
  private busy = false;
  constructor(private readonly host?: QqInstallationHost) {}

  getState(): { availability: "release-unconfigured" | "host-configured"; phase: "idle" | "preview-installation" | "preview-migration" | "busy" } {
    return { availability: this.host ? "host-configured" : "release-unconfigured",
      phase: this.busy ? "busy" : this.pending?.kind === "installation" ? "preview-installation" : this.pending ? "preview-migration" : "idle" };
  }
  private ready(): QqInstallationHost {
    if (!this.host) throw new QqInstallationOperationError("release-unconfigured");
    if (this.busy) throw new QqInstallationOperationError("operation-busy");
    return this.host;
  }
  /** The HOST supplies already materialized, bounded candidate bytes. Never an IPC
   * package-upload API. Preview verifies without writing the package store. */
  previewInstallation(input: QqSignedPackage): QqInstallationPreview {
    const host = this.ready();
    this.pending = undefined; // Even a failed replacement invalidates the previous confirmation.
    verifyQqPackage(input, host.verificationContext());
    const snapshot: QqSignedPackage = { manifest: Buffer.from(input.manifest), signature: Buffer.from(input.signature),
      files: new Map([...input.files].map(([path, bytes]) => [path, Buffer.from(bytes)])) };
    const manifest = verifyQqPackage(snapshot, host.verificationContext());
    const preview: QqInstallationPreview = { operationId: randomUUID(), packageId: `pkg-${qqPackageDigest(snapshot.manifest)}`,
      version: manifest.version, action: "install-only", startsRuntime: false };
    this.pending = { kind: "installation", id: preview.operationId, input: snapshot, preview };
    return { ...preview };
  }
  confirmInstallation(input: unknown): QqInstalledCandidate {
    const host = this.ready();
    if (!strictObject(input, { operationId: (v) => typeof v === "string", userConfirmed: (v) => v === true })) {
      throw new QqInstallationOperationError("invalid-confirmation");
    }
    const consent = input as { operationId: string };
    const pending = this.pending;
    if (!pending || pending.kind !== "installation" || consent.operationId !== pending.id) throw new QqInstallationOperationError("stale-operation");
    this.pending = undefined;
    this.busy = true;
    try {
      // Store rechecks current trust/expiry/platform and prevents release replay.
      return host.packages.install(pending.input, { userConfirmed: true });
    } finally { this.busy = false; }
  }
  /** No renderer-selected package ID: always bind to the current verified selection. */
  previewMigration(): QqMigrationPreview {
    const host = this.ready();
    this.pending = undefined;
    const selected = host.packages.getSelected();
    if (!selected) throw new QqInstallationOperationError("candidate-changed");
    const preview = host.migration.previewMigration(selected.packageId);
    this.pending = { kind: "migration", id: preview.previewId, preview: structuredClone(preview) };
    return structuredClone(preview);
  }
  async confirmMigration(input: unknown): Promise<QqMigrationOutcome> {
    const host = this.ready();
    if (!strictObject(input, { previewId: (v) => typeof v === "string", accountId: (v) => typeof v === "string", userConfirmed: (v) => v === true })) {
      throw new QqInstallationOperationError("invalid-confirmation");
    }
    const consent = input as { previewId: string; accountId: string };
    const pending = this.pending;
    if (!pending || pending.kind !== "migration" || consent.previewId !== pending.id || consent.accountId !== pending.preview.accountId) {
      throw new QqInstallationOperationError("stale-operation");
    }
    this.pending = undefined; // Consume BEFORE any reentrant store/coordinator work.
    this.busy = true;
    try {
      const selected = host.packages.getSelected();
      if (selected?.packageId !== pending.preview.targetPackageId) throw new QqInstallationOperationError("candidate-changed");
      return await host.migration.confirmMigration({ previewId: pending.id, accountId: pending.preview.accountId, userConfirmed: true });
    } finally { this.busy = false; }
  }
  /** Cancellation is only for an unstarted preview. Never pretend to cancel a
   * migration after legacy stop/persistence has begun; busy must remain visible. */
  cancel(input: unknown): void {
    this.ready();
    if (!strictObject(input, { operationId: (v) => typeof v === "string" })) throw new QqInstallationOperationError("invalid-confirmation");
    if (!this.pending || (input as { operationId: string }).operationId !== this.pending.id) throw new QqInstallationOperationError("stale-operation");
    this.pending = undefined;
  }
}
