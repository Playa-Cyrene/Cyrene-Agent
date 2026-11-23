import { closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname, isAbsolute, join, parse, resolve } from "node:path";
import { strictObject, isBoundedJson } from "../../shared/qq-module/validation";
import { validateRuntimeConfig } from "../../shared/qq-module";
import type { QqRuntimeConfig } from "../../shared/qq-module";
import { qqFirstSetupLockPath } from "./startup-recovery";

export class QqFirstSetupError extends Error {
  constructor(readonly code: string) { super(`QQ_FIRST_SETUP_${code}`); }
}
export function firstSetupFail(code: string): never { throw new QqFirstSetupError(code); }

export interface QqFirstSetupRecord {
  schemaVersion: 1; transactionId: string; packageId: string; config: QqRuntimeConfig;
  /** A selection is not proof of a live runtime after restart. */
  phase: "prepared" | "module-staged" | "selected" | "rolled-back";
}
const packageId = (v: unknown): boolean => typeof v === "string" && /^pkg-[a-f0-9]{64}$/.test(v);
export function validateQqFirstSetupRecord(value: unknown): value is QqFirstSetupRecord {
  return isBoundedJson(value) && strictObject(value, {
    schemaVersion: (v) => v === 1, transactionId: (v) => typeof v === "string" && /^[a-f0-9-]{36}$/.test(v), packageId,
    phase: (v) => ["prepared", "module-staged", "selected", "rolled-back"].includes(v as string),
    config: validateRuntimeConfig,
  });
}
const MARKER = "Cyrene QQ first setup v1\n";
/** Dedicated host-owned sidecar. Original settings/history/bindings are never written or
 * copied here. No credentials are persisted. This is NOT a user-data backup or OS sandbox. */
export class QqFirstSetupStore {
  readonly root: string;
  constructor(root: string, private readonly beforeCommit: (record: QqFirstSetupRecord) => void = () => {}) {
    if (!isAbsolute(root) || resolve(root) === parse(resolve(root)).root) firstSetupFail("invalid-store-path");
    this.root = resolve(root);
  }
  private directory(path: string): void {
    const parent = dirname(path);
    if (parent !== path) this.directory(parent);
    const stat = lstatSync(path);
    if (!stat.isDirectory() || stat.isSymbolicLink()) firstSetupFail("unsafe-store-path");
  }
  private readFile(path: string, max: number): Buffer {
    this.directory(dirname(path));
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > max) firstSetupFail("unsafe-store-file");
    const bytes = readFileSync(path);
    if (bytes.length > max) firstSetupFail("unsafe-store-file");
    return bytes;
  }
  private writeNew(path: string, bytes: Buffer): void {
    const fd = openSync(path, "wx", 0o600);
    try { writeFileSync(fd, bytes); fsyncSync(fd); } finally { closeSync(fd); }
  }
  private missing(path: string): boolean {
    try { lstatSync(path); return false; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return true;
      throw error;
    }
  }
  private exists(): boolean {
    this.directory(dirname(this.root));
    if (this.missing(this.root)) return false;
    this.directory(this.root);
    if (this.readFile(join(this.root, "marker"), 128).toString() !== MARKER) firstSetupFail("unrecognized-store");
    return true;
  }
  read(): QqFirstSetupRecord | null {
    if (!this.exists() || this.missing(join(this.root, "state.json"))) return null;
    let value: unknown;
    try { value = JSON.parse(this.readFile(join(this.root, "state.json"), 256 * 1024).toString()); } catch { return firstSetupFail("invalid-state"); }
    if (!validateQqFirstSetupRecord(value)) firstSetupFail("invalid-state");
    return value as QqFirstSetupRecord;
  }
  private acquireLock(path: string): number {
    try { return openSync(path, "wx", 0o600); }
    catch { return firstSetupFail("busy-or-recovery-required"); }
  }
  private releaseLock(path: string, fd: number): void {
    try { closeSync(fd); unlinkSync(path); } catch { /* stale lock must fail closed, never auto-delete */ }
  }
  async locked<T>(
    action: (save: (record: QqFirstSetupRecord) => void) => Promise<T>,
    preflight: (storeExists: boolean) => void = () => {},
  ): Promise<T> {
    // Reserve even an uninitialized store without creating its durable marker.
    this.directory(dirname(this.root));
    const reservation = qqFirstSetupLockPath(this.root);
    const reservationFd = this.acquireLock(reservation);
    const lock = join(this.root, "setup-lock");
    let fd: number | undefined;
    try {
      const existing = this.exists();
      // Continue honoring old in-store locks, including leftovers from a crash.
      if (existing) fd = this.acquireLock(lock);
      preflight(existing);
      if (!existing) {
        // Do not adopt a directory that appeared during preflight.
        mkdirSync(this.root, { mode: 0o700 });
        this.writeNew(join(this.root, "marker"), Buffer.from(MARKER));
        fd = this.acquireLock(lock);
      }
      return await action((record) => this.commit(record));
    } finally {
      if (fd !== undefined) this.releaseLock(lock, fd);
      this.releaseLock(reservation, reservationFd);
    }
  }
  private commit(record: QqFirstSetupRecord): void {
    if (!validateQqFirstSetupRecord(record)) firstSetupFail("invalid-state");
    const temp = join(this.root, `.state-${randomUUID()}`);
    try {
      this.writeNew(temp, Buffer.from(JSON.stringify(record)));
      this.beforeCommit(record);
      renameSync(temp, join(this.root, "state.json"));
    } finally { if (existsSync(temp)) unlinkSync(temp); }
  }
}
