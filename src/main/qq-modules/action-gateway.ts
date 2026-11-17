import { validateRuntimeConfig } from "../../shared/qq-module";
import { isQqModuleLoopbackHost } from "./listen-policy";
import { strictObject } from "../../shared/qq-module/validation";
import type { QqModuleActionCommand, QqModuleActionError, QqModuleActionPreview, QqModuleActionResult } from "../../shared/qq-module-actions";

export interface QqModuleActionPort { execute(command: QqModuleActionCommand): QqModuleActionResult | Promise<QqModuleActionResult> }
/** Construct ONLY in the host from a validated IPC sender. The object identity must
 * be stable per owner/window session, never supplied as an ID inside renderer payloads.
 * isAuthorized must recheck live ownership and sender authorization on every call. */
export interface QqModuleActionOwner { key: object; isAuthorized(): boolean }
const id = (v: unknown) => typeof v === "string" && /^[a-zA-Z0-9_-]{1,128}$/.test(v);
const account = (v: unknown) => typeof v === "string" && /^\d{1,128}$/.test(v);
const revision = (v: unknown) => v === null || (Number.isSafeInteger(v) && (v as number) > 0);
const configuration = (v: unknown) => validateRuntimeConfig(v) && account(v.expectedSelfId)
  && v.allowedPrivateUserIds.every(account) && v.allowedGroupIds.every(account) && isQqModuleLoopbackHost(v.listen.host);
const configurationChanges = ["allowlist", "enabled", "account", "credential", "listen", "configuration"] as const;
const actionErrors: readonly QqModuleActionError[] = ["unconfigured", "unauthorized", "busy", "invalid", "stale", "operation-failed", "recovery-required"];
const failure = (error: QqModuleActionError): QqModuleActionResult => ({ ok: false, error });
function command(value: unknown): QqModuleActionCommand | null {
  if (!value || typeof value !== "object") return null;
  const action = (value as { action?: unknown }).action;
  const base = { action: (v: unknown) => v === action };
  const confirmed = { ...base, operationId: id, userConfirmed: (v: unknown) => v === true };
  const valid = action === "status" || action === "read-configuration" || action === "preview-install" || action === "preview-migration" || action === "preview-recovery" || action === "preview-reconfigure" ? strictObject(value, base)
    : action === "propose-configuration" ? strictObject(value, { ...base, expectedRevision: revision, config: configuration, enabled: (v) => typeof v === "boolean" })
    : action === "preview-setup" ? strictObject(value, { ...base, accountId: account })
      : action === "confirm-install" ? strictObject(value, confirmed)
        : action === "confirm-migration" || action === "confirm-setup" || action === "confirm-recovery" || action === "confirm-reconfigure" ? strictObject(value, { ...confirmed, accountId: account })
          : action === "cancel" && strictObject(value, { ...base, operationId: id });
  return valid ? structuredClone(value) as QqModuleActionCommand : null;
}
/** Validate the host result as well: accidentally returned exceptions, paths or tokens
 * never pass through this boundary, even when a port violates its static interface. */
function result(value: unknown, request: QqModuleActionCommand): QqModuleActionResult {
  if (strictObject(value, { ok: (v) => v === false, error: (v) => actionErrors.includes(v as QqModuleActionError) })) {
    return { ok: false, error: (value as { error: QqModuleActionError }).error };
  }
  if (request.action === "read-configuration" || request.action === "propose-configuration") {
    return strictObject(value, { ok: v => v === true, state: v => v === (request.action === "read-configuration" ? "configuration" : "configuration-saved"),
      configuration: v => strictObject(v, { proposalRevision: revision, config: c => c === null || configuration(c), enabled: n => typeof n === "boolean", credentialAccountId: a => a === null || account(a) }) })
      ? structuredClone(value) as QqModuleActionResult : failure("operation-failed");
  }
  const expected = request.action === "status" ? ["ready", "committed", "recovery-required", "disabled"]
    : request.action.startsWith("preview-") ? [request.action]
      : request.action === "confirm-install" ? ["installed"]
        : request.action === "cancel" ? ["cancelled"] : request.action === "confirm-reconfigure" ? ["committed", "disabled", "rolled-back", "recovery-required"] : ["committed", "rolled-back", "recovery-required"];
  const preview = request.action.startsWith("preview-");
  if (!strictObject(value, { ok: (v) => v === true, state: (v) => expected.includes(v as string), ...(preview ? {
    preview: (v: unknown) => strictObject(v, { operationId: id, packageId: (p) => typeof p === "string" && /^pkg-[a-f0-9]{64}$/.test(p),
      ...(request.action !== "preview-install" ? { accountId: account } : {}),
      ...(request.action === "preview-reconfigure" ? { desiredEnabled: (v: unknown) => typeof v === "boolean",
        changes: (v: unknown) => Array.isArray(v) && v.length <= configurationChanges.length && new Set(v).size === v.length
          && v.every((change) => configurationChanges.includes(change as typeof configurationChanges[number])) } : {}) },
    { ...(request.action === "preview-install" ? { accountId: account } : {}), ...(request.action !== "preview-install" ? { configuration } : {}), version: (v) => typeof v === "string" && v.length <= 128 && /^\d{1,8}\.\d{1,8}\.\d{1,8}(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(v) }),
  } : {}) })) return failure("operation-failed");
  const output = structuredClone(value) as QqModuleActionResult;
  if (output.ok && "preview" in output && output.preview.configuration
    && output.preview.configuration.expectedSelfId !== output.preview.accountId) return failure("operation-failed");
  return output;
}
interface BoundPreview { owner: object; kind: "preview-install" | "preview-migration" | "preview-setup" | "preview-recovery" | "preview-reconfigure"; preview: QqModuleActionPreview }
/** One host-session gateway for all QQ operation IPC. No port = zero side effects.
 * Preview authority belongs to its originating live owner; a second window may query
 * status but cannot replace, confirm or cancel that preview. Never expose the port.
 * Invalidating an owner can cancel a pending preview, never an already-confirmed switch. */
export class QqModuleActionGateway {
  private pending?: BoundPreview;
  private busy = false;
  private cleanupFailed = false;
  private readonly invalidOwners = new WeakSet<object>();
  constructor(private readonly port?: QqModuleActionPort) {}
  private authorized(owner: QqModuleActionOwner): boolean {
    try { return !this.invalidOwners.has(owner.key) && owner.isAuthorized() === true; } catch { return false; }
  }
  async execute(input: unknown, owner: QqModuleActionOwner): Promise<QqModuleActionResult> {
    if (!this.port) return failure("unconfigured");
    if (!this.authorized(owner)) { await this.invalidate(owner.key); return failure("unauthorized"); }
    let request: QqModuleActionCommand | null;
    try { request = command(input); } catch { return failure("invalid"); }
    if (!request) return failure("invalid");
    if (this.cleanupFailed) return failure("recovery-required");
    if (this.busy) return failure("busy");
    if (this.pending && this.pending.owner !== owner.key && request.action !== "status" && request.action !== "read-configuration") return failure("unauthorized");
    if (this.pending && request.action === "propose-configuration") return failure("busy");
    if (request.action.startsWith("confirm-") || request.action === "cancel") {
      const consent = request as Extract<QqModuleActionCommand, { operationId: string }>;
      const pending = this.pending;
      if (!pending || consent.operationId !== pending.preview.operationId) return failure("stale");
      if (request.action !== "cancel" && (`confirm-${pending.kind.slice(8)}` !== request.action
        || ("accountId" in consent && consent.accountId !== pending.preview.accountId))) return failure("stale");
    }
    const desiredEnabled = this.pending?.kind === "preview-reconfigure" ? this.pending.preview.desiredEnabled : undefined;
    this.busy = true;
    if (request.action !== "status" && request.action !== "read-configuration") this.pending = undefined; // Consume before calling a reentrant/asynchronous port.
    try {
      const response = result(await this.port.execute(request), request);
      // A disable confirmation must not be presented as successful reactivation (or
      // vice versa). The host still owns execution and durable recovery after failure.
      if (request.action === "confirm-reconfigure" && response.ok
        && ((response.state === "committed" && desiredEnabled !== true) || (response.state === "disabled" && desiredEnabled !== false))) return failure("operation-failed");
      if (request.action === "cancel" && (!response.ok || response.state !== "cancelled")) this.cleanupFailed = true;
      if (response.ok && "preview" in response) {
        if (request.action === "preview-setup" && response.preview.accountId !== request.accountId) {
          await this.cancelPreview(response.preview.operationId); return failure("operation-failed");
        }
        if (!this.authorized(owner)) {
          await this.cancelPreview(response.preview.operationId); return failure("unauthorized");
        }
        this.pending = { owner: owner.key, kind: response.state, preview: structuredClone(response.preview) };
      }
      // A confirmed operation may already have taken effect. Never report it cancelled
      // just because the window disappeared; the host must inspect durable/live state.
      if (!this.authorized(owner)) this.invalidOwners.add(owner.key);
      return this.authorized(owner) ? response : failure("unauthorized");
    } catch { if (request.action === "cancel") this.cleanupFailed = true; return failure("operation-failed"); }
    finally {
      // A window can disappear while a status request (not only preview) is in flight.
      if (this.pending && this.invalidOwners.has(this.pending.owner)) {
        const pending = this.pending; this.pending = undefined;
        await this.cancelPreview(pending.preview.operationId);
      }
      this.busy = false;
    }
  }
  private async cancelPreview(operationId: string): Promise<void> {
    try {
      const response = result(await this.port!.execute({ action: "cancel", operationId }), { action: "cancel", operationId });
      if (!response.ok || response.state !== "cancelled") this.cleanupFailed = true;
    } catch { this.cleanupFailed = true; }
  }
  /** Called by host on window destruction/navigation/ownership change. In-flight
   * preview results are discarded and cleaned on completion; confirmed work is not aborted. */
  async invalidate(ownerKey: object): Promise<void> {
    this.invalidOwners.add(ownerKey);
    if (!this.port || this.busy || this.pending?.owner !== ownerKey) return;
    const pending = this.pending; this.pending = undefined; this.busy = true;
    try { await this.cancelPreview(pending.preview.operationId); } finally { this.busy = false; }
  }
}
