import { closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname, isAbsolute, join, parse, resolve } from "node:path";
import { strictObject, isBoundedJson } from "../../shared/qq-module/validation";
import { validateRuntimeConfig } from "../../shared/qq-module";
import type { QqRuntimeConfig } from "../../shared/qq-module";

export class QqRecoveryError extends Error {
  constructor(readonly code: string) { super(`QQ_RECOVERY_${code}`); }
}
export function recoveryFail(code: string): never { throw new QqRecoveryError(code); }

export interface QqRecoveryDesired { config: QqRuntimeConfig; enabled: boolean; credentialRevision: string }
export interface QqRecoveryBaseline { config: QqRuntimeConfig; enabled: boolean; credentialRevision: string | null }
export interface QqRecoveryOrigin { kind: "first-setup" | "migration"; transactionId: string; packageId: string; config: QqRuntimeConfig }
export interface QqRecoveryRecord {
  schemaVersion: 1; transactionId: string; origin: QqRecoveryOrigin;
  previous: QqRecoveryBaseline; desired: QqRecoveryDesired; operation: "recover" | "reconfigure";
  phase: "prepared" | "module-staged" | "selected" | "disabled" | "rolled-back";
}
const uuid = (v: unknown): boolean => typeof v === "string" && /^[a-f0-9-]{36}$/.test(v);
const packageId = (v: unknown): boolean => typeof v === "string" && /^pkg-[a-f0-9]{64}$/.test(v);
const revision = (v: unknown): boolean => typeof v === "string" && /^[a-zA-Z0-9._:-]{1,128}$/.test(v);
export function validateQqRecoveryOrigin(v: unknown): v is QqRecoveryOrigin {
  return strictObject(v, { kind: (n) => n === "first-setup" || n === "migration", transactionId: uuid, packageId, config: validateRuntimeConfig });
}
export function validateQqRecoveryDesired(v: unknown): v is QqRecoveryDesired {
  return strictObject(v, { config: validateRuntimeConfig, enabled: (n) => typeof n === "boolean", credentialRevision: revision });
}
export function validateQqRecoveryRecord(value: unknown): value is QqRecoveryRecord {
  return isBoundedJson(value) && strictObject(value, {
    schemaVersion: (v) => v === 1, transactionId: uuid, origin: validateQqRecoveryOrigin,
    previous: (v) => strictObject(v, { config: validateRuntimeConfig, enabled: (n) => typeof n === "boolean", credentialRevision: (n) => n === null || revision(n) }),
    desired: validateQqRecoveryDesired, operation: (v) => v === "recover" || v === "reconfigure",
    phase: (v) => ["prepared", "module-staged", "selected", "disabled", "rolled-back"].includes(v as string),
  }) && ((value as QqRecoveryRecord).phase !== "selected" || (value as QqRecoveryRecord).desired.enabled)
    && ((value as QqRecoveryRecord).phase !== "disabled" || !(value as QqRecoveryRecord).desired.enabled);
}
const MARKER = "Cyrene QQ recovery v1\n";
/** Dedicated host-owned sidecar. Original settings/history/bindings are never written or
 * copied here. No credentials are persisted. This is NOT a user-data backup or OS sandbox. */
export class QqRecoveryStore {
  readonly root: string;
  private allowInitialEmptyRead = false;
  constructor(root: string, private readonly beforeCommit: (record: QqRecoveryRecord) => void = () => {}) {
    if (!isAbsolute(root) || resolve(root) === parse(resolve(root)).root) recoveryFail("invalid-store-path");
    this.root = resolve(root);
  }
  private directory(path: string): void {
    const parent = dirname(path);
    if (parent !== path) this.directory(parent);
    const stat = lstatSync(path);
    if (!stat.isDirectory() || stat.isSymbolicLink()) recoveryFail("unsafe-store-path");
  }
  private readFile(path: string, max: number): Buffer {
    this.directory(dirname(path));
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > max) recoveryFail("unsafe-store-file");
    const bytes = readFileSync(path);
    if (bytes.length > max) recoveryFail("unsafe-store-file");
    return bytes;
  }
  private writeNew(path: string, bytes: Buffer): void {
    const fd = openSync(path, "wx", 0o600);
    try { writeFileSync(fd, bytes); fsyncSync(fd); } finally { closeSync(fd); }
  }
  private ensure(create: boolean): boolean {
    this.directory(dirname(this.root));
    let present = true;
    try { lstatSync(this.root); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") present = false; else recoveryFail("unsafe-store-path"); }
    if (!present) {
      if (!create) return false;
      mkdirSync(this.root, { mode: 0o700 });
      this.writeNew(join(this.root, "marker"), Buffer.from(MARKER));
    }
    this.directory(this.root);
    if (this.readFile(join(this.root, "marker"), 128).toString() !== MARKER) recoveryFail("unrecognized-store");
    return true;
  }
  read(): QqRecoveryRecord | null {
    if (!this.ensure(false)) return null;
    // A dangling state symlink is corrupt state, not an absent previous selection.
    try { lstatSync(join(this.root, "state.json")); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT" && this.allowInitialEmptyRead) return null;
      recoveryFail("invalid-state");
    }
    let value: unknown;
    try { value = JSON.parse(this.readFile(join(this.root, "state.json"), 256 * 1024).toString()); } catch { return recoveryFail("invalid-state"); }
    if (!validateQqRecoveryRecord(value)) recoveryFail("invalid-state");
    return value as QqRecoveryRecord;
  }
  async locked<T>(action: (save: (record: QqRecoveryRecord) => void) => Promise<T>): Promise<T> {
    let wasPresent = true;
    try { lstatSync(this.root); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") wasPresent = false; else recoveryFail("unsafe-store-path"); }
    this.ensure(true);
    const lock = join(this.root, "recovery-lock");
    let fd: number;
    try { fd = openSync(lock, "wx", 0o600); } catch { return recoveryFail("busy-or-recovery-required"); }
    this.allowInitialEmptyRead = !wasPresent;
    try { return await action((record) => this.commit(record)); }
    finally { this.allowInitialEmptyRead = false; try { closeSync(fd); unlinkSync(lock); } catch { /* stale lock must fail closed, never auto-delete */ } }
  }
  private commit(record: QqRecoveryRecord): void {
    if (!validateQqRecoveryRecord(record)) recoveryFail("invalid-state");
    const temp = join(this.root, `.state-${randomUUID()}`);
    try {
      this.writeNew(temp, Buffer.from(JSON.stringify(record)));
      this.beforeCommit(record);
      renameSync(temp, join(this.root, "state.json"));
    } finally { if (existsSync(temp)) unlinkSync(temp); }
  }
}
