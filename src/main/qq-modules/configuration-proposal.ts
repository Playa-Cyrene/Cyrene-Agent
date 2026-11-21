import { randomUUID } from "node:crypto";
import { closeSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, parse, resolve } from "node:path";
import { validateRuntimeConfig, type QqRuntimeConfig } from "../../shared/qq-module";
import { strictObject } from "../../shared/qq-module/validation";
import { isQqModuleLoopbackHost } from "./listen-policy";
import type { QqSecureCredentialMetadata } from "./secure-credential-store";
import type { QqRecoveryDesired } from "./recovery-store";

export interface QqConfigurationProposalInput { config: QqRuntimeConfig; enabled: boolean; credentialGeneration: string }
export interface QqConfigurationProposal extends QqConfigurationProposalInput { schemaVersion: 1; revision: number; proposalId: string }
export interface QqConfigurationProposalBinding { proposalId: string; revision: number }
export class QqConfigurationProposalError extends Error {
  constructor(readonly code: string) { super(`QQ_CONFIGURATION_PROPOSAL_${code}`); }
}
function fail(code: string): never { throw new QqConfigurationProposalError(code); }
const revision = (v: unknown): boolean => Number.isSafeInteger(v) && (v as number) > 0;
const uuid = (v: unknown): boolean => typeof v === "string" && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(v);
const generation = (v: unknown): boolean => typeof v === "string" && /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(v);
const config = (v: unknown): boolean => validateRuntimeConfig(v) && isQqModuleLoopbackHost(v.listen.host);
export function validateQqConfigurationProposalInput(v: unknown): v is QqConfigurationProposalInput {
  return strictObject(v, { config, enabled: n => typeof n === "boolean", credentialGeneration: generation });
}
export function validateQqConfigurationProposal(v: unknown): v is QqConfigurationProposal {
  return strictObject(v, { schemaVersion: n => n === 1, revision, proposalId: uuid, config, enabled: n => typeof n === "boolean", credentialGeneration: generation });
}
const MARKER = "Cyrene QQ configuration proposals v1\n";
/** Host-only non-secret desired configuration. A proposal is NOT consent, activation,
 * credential storage, or proof any QQ driver stopped. No production wiring exists.
 * Host owns the absolute dedicated root; never accept renderer paths or credentials. */
export class QqConfigurationProposalStore {
  readonly root: string;
  constructor(root: string, private readonly beforeCommit: () => void = () => {}) {
    if (!isAbsolute(root) || resolve(root) === parse(resolve(root)).root) fail("invalid-root");
    this.root = resolve(root);
  }
  private exists(path: string): boolean {
    try { lstatSync(path); return true; } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; return fail("unsafe-path"); }
  }
  private directory(path: string): void {
    const parent = dirname(path); if (parent !== path) this.directory(parent);
    const stat = lstatSync(path); if (!stat.isDirectory() || stat.isSymbolicLink()) fail("unsafe-path");
  }
  private readFile(path: string, max: number): Buffer {
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > max) fail("unsafe-file");
    const bytes = readFileSync(path); if (bytes.length > max) fail("unsafe-file"); return bytes;
  }
  private writeNew(path: string, bytes: Buffer): void {
    const fd = openSync(path, "wx", 0o600);
    try { writeFileSync(fd, bytes); fsyncSync(fd); } finally { closeSync(fd); }
  }
  private ensure(create: boolean): boolean {
    this.directory(dirname(this.root));
    if (!this.exists(this.root)) {
      if (!create) return false;
      mkdirSync(this.root, { mode: 0o700 }); this.writeNew(join(this.root, "marker"), Buffer.from(MARKER));
    }
    this.directory(this.root);
    if (!this.exists(join(this.root, "marker")) || this.readFile(join(this.root, "marker"), 128).toString() !== MARKER) fail("unrecognized-store");
    return true;
  }
  private readInside(locked: boolean, allowEmpty: boolean): QqConfigurationProposal | null {
    if (this.exists(join(this.root, "proposal-lock")) && !locked) fail("busy-or-recovery-required");
    if (readdirSync(this.root).some(name => !["marker", "state.json", ...(locked ? ["proposal-lock"] : [])].includes(name))) fail("unrecognized-store");
    if (!this.exists(join(this.root, "state.json"))) { if (allowEmpty) return null; return fail("invalid-state"); }
    let value: unknown;
    try { value = JSON.parse(this.readFile(join(this.root, "state.json"), 256 * 1024).toString()); } catch { return fail("invalid-state"); }
    if (!validateQqConfigurationProposal(value)) fail("invalid-state");
    return value;
  }
  read(): QqConfigurationProposal | null { return this.ensure(false) ? this.readInside(false, false) : null; }
  /** Compare-and-swap, not an unconditional replace. Config revision must advance
   * as well as proposal revision, including credential-only/enable-only changes. */
  propose(input: QqConfigurationProposalInput, expectedRevision: number | null): QqConfigurationProposal {
    if (!validateQqConfigurationProposalInput(input) || !(expectedRevision === null || revision(expectedRevision))) fail("invalid-input");
    const snapshot = structuredClone(input);
    const fresh = !this.exists(this.root);
    if (fresh && expectedRevision !== null) fail("stale-proposal");
    this.ensure(true);
    const lock = join(this.root, "proposal-lock"); let fd: number;
    try { fd = openSync(lock, "wx", 0o600); } catch { return fail("busy-or-recovery-required"); }
    try {
      const prior = this.readInside(true, fresh);
      if ((prior?.revision ?? null) !== expectedRevision) fail("stale-proposal");
      const next = (prior?.revision ?? 0) + 1;
      if (!revision(next) || (prior && snapshot.config.configRevision <= prior.config.configRevision)) fail("non-monotonic-revision");
      const record: QqConfigurationProposal = { ...snapshot, schemaVersion: 1, revision: next, proposalId: randomUUID() };
      const temp = join(this.root, `.state-${randomUUID()}`);
      try {
        this.writeNew(temp, Buffer.from(JSON.stringify(record))); this.beforeCommit(); renameSync(temp, join(this.root, "state.json"));
      } finally { if (this.exists(temp)) unlinkSync(temp); }
      return structuredClone(record);
    } finally { try { closeSync(fd); unlinkSync(lock); } catch { /* A stale lock requires explicit review. */ } }
  }
  assertCurrent(binding: QqConfigurationProposalBinding): QqConfigurationProposal {
    if (!strictObject(binding, { proposalId: uuid, revision })) fail("invalid-binding");
    const current = this.read();
    if (!current || current.proposalId !== binding.proposalId || current.revision !== binding.revision) fail("stale-proposal");
    return current;
  }
  readDesired(binding: QqConfigurationProposalBinding | undefined, metadata: QqSecureCredentialMetadata | null): QqRecoveryDesired {
    const current = binding ? this.assertCurrent(binding) : this.read(); if (!current) fail("missing-proposal");
    if (current.enabled && (!metadata || metadata.status !== "active" || metadata.accountId !== current.config.expectedSelfId || metadata.generation !== current.credentialGeneration)) fail("credential-generation-mismatch");
    return { config: structuredClone(current.config), enabled: current.enabled, credentialRevision: current.credentialGeneration };
  }
}
/** Safe UI summary: values of credentials, paths and keys are never returned. */
export function diffQqConfigurationProposals(previous: QqConfigurationProposalInput | null, next: QqConfigurationProposalInput) {
  if (!validateQqConfigurationProposalInput(next) || (previous !== null && !validateQqConfigurationProposalInput(previous))) fail("invalid-input");
  const changes: ("configuration" | "allowlist" | "enabled" | "account" | "credential" | "listen")[] = [];
  if (!previous) changes.push("configuration");
  else {
    if (JSON.stringify([previous.config.allowedPrivateUserIds, previous.config.allowedGroupIds, previous.config.groupRequireMention]) !== JSON.stringify([next.config.allowedPrivateUserIds, next.config.allowedGroupIds, next.config.groupRequireMention])) changes.push("allowlist");
    if (previous.enabled !== next.enabled) changes.push("enabled");
    if (previous.config.expectedSelfId !== next.config.expectedSelfId) changes.push("account");
    if (previous.credentialGeneration !== next.credentialGeneration) changes.push("credential");
    if (previous.config.listen.host !== next.config.listen.host || previous.config.listen.port !== next.config.listen.port) changes.push("listen");
  }
  return { accountId: next.config.expectedSelfId, desiredEnabled: next.enabled, changes,
    before: previous ? { config: structuredClone(previous.config), enabled: previous.enabled } : null,
    after: { config: structuredClone(next.config), enabled: next.enabled } };
}
/** Fixed production location derived only from the host's userData path. */
export function qqConfigurationProposalDirectory(userDataPath: string): string {
  if (!isAbsolute(userDataPath)) fail("invalid-root");
  return join(resolve(userDataPath), "qq-module-configuration-proposals");
}
