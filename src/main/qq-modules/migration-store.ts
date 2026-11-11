import { closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname, isAbsolute, join, parse, resolve } from "node:path";
import { strictObject, isBoundedJson } from "../../shared/qq-module/validation";
import { validateRuntimeConfig } from "../../shared/qq-module";
import { migrationFail, isQqLegacyIdentity, type QqMigrationPlan } from "./migration-plan";

export interface QqMigrationRecord {
  schemaVersion: 1; transactionId: string; packageId: string; plan: QqMigrationPlan;
  phase: "prepared" | "legacy-stopped" | "module-staged" | "committed" | "rolled-back";
}
const hex = (v: unknown): boolean => typeof v === "string" && /^[a-f0-9]{64}$/.test(v);
const packageId = (v: unknown): boolean => typeof v === "string" && /^pkg-[a-f0-9]{64}$/.test(v);
export function validateQqMigrationRecord(value: unknown): value is QqMigrationRecord {
  return isBoundedJson(value) && strictObject(value, {
    schemaVersion: (v) => v === 1, transactionId: (v) => typeof v === "string" && /^[a-f0-9-]{36}$/.test(v), packageId,
    phase: (v) => ["prepared", "legacy-stopped", "module-staged", "committed", "rolled-back"].includes(v as string),
    plan: (v) => strictObject(v, { schemaVersion: (n) => n === 1, channelId: (n) => n === "qq", config: validateRuntimeConfig,
      sourceDigest: hex, identity: isQqLegacyIdentity, credentialKind: (n) => ["none", "encrypted", "obfuscated", "plaintext"].includes(n as string) }),
  }) && (value as QqMigrationRecord).plan.config.expectedSelfId === (value as QqMigrationRecord).plan.identity.selfId;
}
const MARKER = "Cyrene QQ migration rehearsal v1\n";
/** Dedicated host-owned sidecar. Original settings/history/bindings are never written or
 * copied here. No credentials are persisted. This is NOT a user-data backup or OS sandbox. */
export class QqMigrationStore {
  readonly root: string;
  constructor(root: string, private readonly beforeCommit: (record: QqMigrationRecord) => void = () => {}) {
    if (!isAbsolute(root) || resolve(root) === parse(resolve(root)).root) migrationFail("invalid-store-path");
    this.root = resolve(root);
  }
  private directory(path: string): void {
    const parent = dirname(path);
    if (parent !== path) this.directory(parent);
    const stat = lstatSync(path);
    if (!stat.isDirectory() || stat.isSymbolicLink()) migrationFail("unsafe-store-path");
  }
  private readFile(path: string, max: number): Buffer {
    this.directory(dirname(path));
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > max) migrationFail("unsafe-store-file");
    const bytes = readFileSync(path);
    if (bytes.length > max) migrationFail("unsafe-store-file");
    return bytes;
  }
  private writeNew(path: string, bytes: Buffer): void {
    const fd = openSync(path, "wx", 0o600);
    try { writeFileSync(fd, bytes); fsyncSync(fd); } finally { closeSync(fd); }
  }
  private ensure(create: boolean): boolean {
    this.directory(dirname(this.root));
    if (!existsSync(this.root)) {
      if (!create) return false;
      mkdirSync(this.root, { mode: 0o700 });
      this.writeNew(join(this.root, "marker"), Buffer.from(MARKER));
    }
    this.directory(this.root);
    if (this.readFile(join(this.root, "marker"), 128).toString() !== MARKER) migrationFail("unrecognized-store");
    return true;
  }
  read(): QqMigrationRecord | null {
    if (!this.ensure(false) || !existsSync(join(this.root, "state.json"))) return null;
    let value: unknown;
    try { value = JSON.parse(this.readFile(join(this.root, "state.json"), 256 * 1024).toString()); } catch { return migrationFail("invalid-state"); }
    if (!validateQqMigrationRecord(value)) migrationFail("invalid-state");
    return value as QqMigrationRecord;
  }
  async locked<T>(action: (save: (record: QqMigrationRecord) => void) => Promise<T>): Promise<T> {
    this.ensure(true);
    const lock = join(this.root, "migration-lock");
    let fd: number;
    try { fd = openSync(lock, "wx", 0o600); } catch { return migrationFail("busy-or-recovery-required"); }
    try { return await action((record) => this.commit(record)); }
    finally { try { closeSync(fd); unlinkSync(lock); } catch { /* stale lock must fail closed, never auto-delete */ } }
  }
  private commit(record: QqMigrationRecord): void {
    if (!validateQqMigrationRecord(record)) migrationFail("invalid-state");
    const temp = join(this.root, `.state-${randomUUID()}`);
    try {
      this.writeNew(temp, Buffer.from(JSON.stringify(record)));
      this.beforeCommit(record);
      renameSync(temp, join(this.root, "state.json"));
    } finally { if (existsSync(temp)) unlinkSync(temp); }
  }
}
