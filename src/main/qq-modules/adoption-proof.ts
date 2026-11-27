import type { QqDriverOwnershipOptions } from "./driver-ownership";

/** Artifact identities are host-supplied SHA-256 digests, never version guesses. */
export interface QqAdoptionContext {
  platform: "win32";
  scopeId: string;
  sessionEpoch: string;
  mode: "new-install" | "validated-upgrade";
  previousHostSha256: string | null;
  hostSha256: string;
  moduleSha256: string;
}
export interface QqAdoptionScopeLease {
  /** Must stay held through the complete adopted supervisor lifetime. */
  isHeld(): boolean;
  /** Only used for an abandoned, unconsumed proof. */
  release(): void;
}
export interface QqAdoptionProofPorts {
  readContext(): QqAdoptionContext;
  /** Durable fail-closed startup marker MUST precede any freeze/stop side effect. */
  persistIntent(context: Readonly<QqAdoptionContext>): void;
  /** Reviewed exact host/module pair and (for upgrade) exact source artifact.
   * No built-in allowlist. Approval is not itself process-absence evidence. */
  reviewedPolicy: { approve(context: Readonly<QqAdoptionContext>): boolean };
  /** External reviewed evidence: freeze ALL launch paths and prove historical
   * unmanaged drivers absent, excluding only the explicitly tracked legacy port.
   * PID/port scans, absent files, version strings and singleInstanceLock alone
   * are NOT valid implementations. No implementation/default is supplied here. */
  exclusiveScope: { freezeAndProve(context: Readonly<QqAdoptionContext>): Promise<QqAdoptionScopeLease> };
  /** Upgrade only: observe the held legacy instance's actual listener close and
   * accepted-work drain. Frozen launch paths must remain frozen afterwards. */
  legacy?: { stopAndDrain(context: Readonly<QqAdoptionContext>): Promise<boolean> };
}
const blocked = (): never => { throw new Error("QQ_ADOPTION_PROOF_REQUIRED"); };
export function snapshotQqAdoptionContext(value: QqAdoptionContext): QqAdoptionContext {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || Object.keys(value).sort().join(",") !== "hostSha256,mode,moduleSha256,platform,previousHostSha256,scopeId,sessionEpoch"
    || value.platform !== "win32" || !["new-install", "validated-upgrade"].includes(value.mode)
    || typeof value.scopeId !== "string" || !value.scopeId || value.scopeId.length > 200
    || typeof value.sessionEpoch !== "string" || !value.sessionEpoch || value.sessionEpoch.length > 200
    || typeof value.hostSha256 !== "string" || !/^[a-f0-9]{64}$/.test(value.hostSha256)
    || typeof value.moduleSha256 !== "string" || !/^[a-f0-9]{64}$/.test(value.moduleSha256)
    || (value.mode === "new-install" ? value.previousHostSha256 !== null : typeof value.previousHostSha256 !== "string" || !/^[a-f0-9]{64}$/.test(value.previousHostSha256))) blocked();
  return Object.freeze({ platform: value.platform, scopeId: value.scopeId, sessionEpoch: value.sessionEpoch, mode: value.mode,
    previousHostSha256: value.previousHostSha256, hostSha256: value.hostSha256, moduleSha256: value.moduleSha256 });
}
/** A process-local, one-use bridge from asynchronous reviewed adoption evidence
 * to supervisor.open's synchronous bootstrap. It is not a durable recovery token. */
export interface QqAdoptionProof {
  readonly scopeId: string;
  readonly bootstrap: NonNullable<QqDriverOwnershipOptions["bootstrap"]>;
  /** Recheck before every activation/fork and absence assertion, not only bootstrap. */
  isHeld(): boolean;
  /** Cancels only before consumption. After consumption the scope must remain held. */
  cancel(): void;
}
export class QqAdoptionProofCoordinator {
  private preparing = false;
  private issued = false;
  private invalidated = false;
  constructor(private readonly ports: QqAdoptionProofPorts) {}
  /** Invalidating an already consumed proof MUST NOT unfreeze launch paths. */
  invalidate(): void { this.invalidated = true; }
  async prepare(): Promise<QqAdoptionProof> {
    if (this.preparing || this.issued || this.invalidated) blocked();
    this.preparing = true;
    let lease: QqAdoptionScopeLease | undefined;
    try {
      const context = snapshotQqAdoptionContext(this.ports.readContext());
      const check = () => {
        if (this.invalidated || JSON.stringify(snapshotQqAdoptionContext(this.ports.readContext())) !== JSON.stringify(context)
          || this.ports.reviewedPolicy.approve(context) !== true) blocked();
        if (lease && lease.isHeld() !== true) blocked();
      };
      check();
      if (context.mode === "validated-upgrade" && !this.ports.legacy) blocked();
      this.ports.persistIntent(context);
      check();
      // A failure must leave the external gate fail-closed; its port owns that rule.
      lease = await this.ports.exclusiveScope.freezeAndProve(context);
      if (!lease || typeof lease.isHeld !== "function" || typeof lease.release !== "function") blocked();
      check();
      if (context.mode === "validated-upgrade") {
        if (await this.ports.legacy!.stopAndDrain(context) !== true) blocked();
        check();
      }
      this.issued = true;
      let consumed = false, cancelled = false, poisoned = false;
      const retained = lease;
      const isHeld = () => {
        if (cancelled || poisoned) return false;
        try { check(); return true; } catch { poisoned = true; return false; }
      };
      return Object.freeze({ scopeId: context.scopeId, isHeld,
        bootstrap: Object.freeze({ verifyInitialScope: () => {
          if (consumed || cancelled) return false;
          // Consume even failed attempts. Never turn a stale proof into a retry token.
          consumed = true;
          return isHeld();
        } }),
        cancel: () => {
          if (consumed || cancelled) return;
          cancelled = true;
          retained.release();
        },
      });
    } catch (error) {
      // No supervisor owns this scope yet. Release may itself fail closed.
      lease?.release();
      throw error;
    } finally { this.preparing = false; }
  }
}
