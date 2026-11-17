import { closeSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname, isAbsolute, join, parse, resolve } from "node:path";
import { strictObject } from "../../shared/qq-module/validation";

export interface QqSecureStoragePort {
  isSecureAvailable(): boolean;
  encryptString(value: string): Buffer;
  decryptString(value: Buffer): string;
}
export interface QqSecureCredentialMetadata { accountId: string; generation: string; status: "active" | "revoked" }
interface Envelope extends QqSecureCredentialMetadata { schemaVersion: 1; ciphertext: string }
export class QqSecureCredentialError extends Error {
  constructor(readonly code: string) { super(`QQ_SECURE_CREDENTIAL_${code}`); }
}
function fail(code: string): never { throw new QqSecureCredentialError(code); }
const account = (v: unknown): v is string => typeof v === "string" && /^\d{1,128}$/.test(v);
const generation = (v: unknown): v is string => typeof v === "string" && /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(v);
const token = (v: unknown): v is string => typeof v === "string" && v.length > 0 && v.length <= 4096 && Boolean(v.trim()) && !/[\x00-\x1f\x7f]/.test(v);
const MARKER = "Cyrene QQ secure credential store v1\n";
const MAX_CIPHERTEXT = 32 * 1024;
const MAX_ENVELOPE = 48 * 1024;
function absent(error: unknown): boolean { return (error as NodeJS.ErrnoException)?.code === "ENOENT"; }
function present(path: string): boolean {
  try { lstatSync(path); return true; } catch (error) { if (absent(error)) return false; return fail("unsafe-store-path"); }
}
/** This fixed MAIN-process location is never taken from a renderer or a package. */
export function qqSecureCredentialDirectory(userDataPath: string): string {
  if (!isAbsolute(userDataPath)) fail("invalid-store-path");
  return join(userDataPath, "qq-module-credentials");
}
/** A host-owned single QQ credential. No renderer IPC, plaintext fallback or auto-import.
 * Generation is random metadata, never a digest of the token. Revocation retains only
 * the encrypted envelope for explicit recovery; it is NOT disk erasure.
 * File checks do not defend against malicious code running as the same OS user. */
export class QqSecureCredentialStore {
  readonly root: string;
  private initialWrite = false;
  constructor(root: string, private readonly storage: QqSecureStoragePort,
    /** Host test injection only; never configurable through renderer input. */
    private readonly checkpoint: (stage: "before-commit" | "after-commit") => void = () => {}) {
    if (!isAbsolute(root) || resolve(root) === parse(resolve(root)).root) fail("invalid-store-path");
    this.root = resolve(root);
  }
  private directories(path: string): void {
    const parent = dirname(path); if (parent !== path) this.directories(parent);
    let stat: ReturnType<typeof lstatSync>;
    try { stat = lstatSync(path); } catch { return fail("unsafe-store-path"); }
    if (!stat.isDirectory() || stat.isSymbolicLink()) fail("unsafe-store-path");
  }
  private bytes(path: string, max: number): Buffer {
    this.directories(dirname(path));
    try {
      const stat = lstatSync(path);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > max) fail("unsafe-store-file");
      const data = readFileSync(path);
      if (data.length > max) fail("unsafe-store-file");
      return data;
    } catch (error) { if (error instanceof QqSecureCredentialError) throw error; return fail("unsafe-store-file"); }
  }
  private writeNew(path: string, bytes: Buffer): void {
    try {
      const fd = openSync(path, "wx", 0o600);
      try { writeFileSync(fd, bytes); fsyncSync(fd); } finally { closeSync(fd); }
    } catch { fail("write-failed"); }
  }
  private ensure(create: boolean): boolean {
    this.directories(dirname(this.root));
    if (!present(this.root)) {
      if (!create) return false;
      try { mkdirSync(this.root, { mode: 0o700 }); } catch { fail("write-failed"); }
      this.writeNew(join(this.root, "marker"), Buffer.from(MARKER));
    }
    this.directories(this.root);
    if (this.bytes(join(this.root, "marker"), 128).toString() !== MARKER) fail("unrecognized-store");
    return true;
  }
  private load(): Envelope | null {
    if (!this.ensure(false)) return null;
    const path = join(this.root, "credential.json");
    if (!present(path)) { if (this.initialWrite) return null; return fail("incomplete-store"); }
    let value: unknown;
    try { value = JSON.parse(this.bytes(path, MAX_ENVELOPE).toString("utf8")); }
    catch (error) { if (error instanceof QqSecureCredentialError) throw error; return fail("invalid-envelope"); }
    if (!strictObject(value, { schemaVersion: (v) => v === 1, accountId: account, generation,
      status: (v) => v === "active" || v === "revoked", ciphertext: (v) => typeof v === "string" && v.length > 0 && v.length <= Math.ceil(MAX_CIPHERTEXT / 3) * 4 })) fail("invalid-envelope");
    const envelope = value as Envelope;
    const ciphertext = Buffer.from(envelope.ciphertext, "base64");
    if (!ciphertext.length || ciphertext.length > MAX_CIPHERTEXT || ciphertext.toString("base64") !== envelope.ciphertext) fail("invalid-envelope");
    return envelope;
  }
  private metadata(value: Envelope): QqSecureCredentialMetadata {
    return { accountId: value.accountId, generation: value.generation, status: value.status };
  }
  /** Metadata is deliberately usable before Electron readiness and never decrypts. */
  getMetadata(): QqSecureCredentialMetadata | null {
    this.unlocked();
    const value = this.load(); return value ? this.metadata(value) : null;
  }
  private unlocked(): void { if (present(join(this.root, "credential-lock"))) fail("busy-or-recovery-required"); }
  private secure(): void {
    try { if (!this.storage.isSecureAvailable()) fail("secure-storage-unavailable"); }
    catch { fail("secure-storage-unavailable"); }
  }
  private encrypt(accountId: string, next: string, secret: string): Envelope {
    this.secure();
    let ciphertext: Buffer;
    try { ciphertext = this.storage.encryptString(JSON.stringify({ schemaVersion: 1, accountId, generation: next, token: secret })); }
    catch { return fail("encryption-failed"); }
    if (!Buffer.isBuffer(ciphertext) || !ciphertext.length || ciphertext.length > MAX_CIPHERTEXT) fail("encryption-failed");
    return { schemaVersion: 1, accountId, generation: next, status: "active", ciphertext: ciphertext.toString("base64") };
  }
  private decrypt(value: Envelope): string {
    this.secure();
    let plain: string, decoded: unknown;
    try {
      plain = this.storage.decryptString(Buffer.from(value.ciphertext, "base64"));
      if (typeof plain !== "string" || Buffer.byteLength(plain) > 24 * 1024) return fail("decryption-failed");
      decoded = JSON.parse(plain);
      plain = "";
    } catch { return fail("decryption-failed"); }
    if (!strictObject(decoded, { schemaVersion: (v) => v === 1, accountId: account, generation, token })) fail("decryption-failed");
    const payload = decoded as { accountId: string; generation: string; token: string };
    if (payload.accountId !== value.accountId || payload.generation !== value.generation) fail("identity-mismatch");
    return payload.token;
  }
  read(input: { accountId: string; generation: string }): string {
    if (!strictObject(input, { accountId: account, generation })) fail("invalid-request");
    this.unlocked();
    const value = this.load();
    if (!value || value.status !== "active" || value.accountId !== input.accountId || value.generation !== input.generation) fail("stale-or-revoked");
    return this.decrypt(value);
  }
  private locked<T>(action: () => T): T {
    this.unlocked();
    const existed = present(this.root);
    this.ensure(true);
    let fd: number;
    try { fd = openSync(join(this.root, "credential-lock"), "wx", 0o600); }
    catch { return fail("busy-or-recovery-required"); }
    this.initialWrite = !existed;
    try { return action(); }
    finally {
      this.initialWrite = false;
      try { closeSync(fd); unlinkSync(join(this.root, "credential-lock")); } catch { /* stale lock fails closed */ }
    }
  }
  private commit(value: Envelope): void {
    const path = join(this.root, `.credential-${randomUUID()}`);
    let committed = false;
    try {
      this.writeNew(path, Buffer.from(JSON.stringify(value)));
      this.checkpoint("before-commit");
      renameSync(path, join(this.root, "credential.json")); committed = true;
      // POSIX directory fsync makes the rename durable. Windows uses its atomic
      // same-volume rename semantics; real filesystem acceptance is still required.
      if (process.platform !== "win32") {
        const fd = openSync(this.root, "r"); try { fsyncSync(fd); } finally { closeSync(fd); }
      }
      this.checkpoint("after-commit");
    } catch { fail(committed ? "commit-uncertain" : "write-failed"); }
    finally { try { if (present(path)) unlinkSync(path); } catch { /* do not mask committed state */ } }
  }
  /** User authorization must name this host's secure store and credential/account.
   * Expected generation prevents overwriting an intervening confirmed replacement. */
  write(input: { accountId: string; token: string; expectedGeneration: string | null; userConfirmed: true }): QqSecureCredentialMetadata {
    if (!strictObject(input, { accountId: account, token, expectedGeneration: (v) => v === null || generation(v), userConfirmed: (v) => v === true })) fail("invalid-confirmation");
    this.unlocked();
    const current = this.load();
    if ((current?.generation ?? null) !== input.expectedGeneration) fail("stale-generation");
    // Encrypt before any directory write; unsafe/unready storage is zero-write.
    const next = this.encrypt(input.accountId, randomUUID(), input.token);
    return this.locked(() => {
      if ((this.load()?.generation ?? null) !== input.expectedGeneration) fail("stale-generation");
      this.commit(next); return this.metadata(next);
    });
  }
  revoke(input: { accountId: string; generation: string; userConfirmed: true }): QqSecureCredentialMetadata {
    if (!strictObject(input, { accountId: account, generation, userConfirmed: (v) => v === true })) fail("invalid-confirmation");
    this.unlocked();
    const current = this.load();
    if (!current || current.status !== "active" || current.accountId !== input.accountId || current.generation !== input.generation) fail("stale-or-revoked");
    return this.locked(() => {
      const value = this.load();
      if (!value || value.status !== "active" || value.accountId !== input.accountId || value.generation !== input.generation) fail("stale-or-revoked");
      const revoked: Envelope = { ...value, status: "revoked" };
      this.commit(revoked); return this.metadata(revoked);
    });
  }
  restore(input: { accountId: string; generation: string; userConfirmed: true }): QqSecureCredentialMetadata {
    if (!strictObject(input, { accountId: account, generation, userConfirmed: (v) => v === true })) fail("invalid-confirmation");
    this.unlocked();
    const current = this.load();
    if (!current || current.status !== "revoked" || current.accountId !== input.accountId || current.generation !== input.generation) fail("stale-or-revoked");
    // Re-encrypt with NEW identity inside the encrypted payload, not just metadata.
    let secret = this.decrypt(current);
    let next: Envelope;
    try { next = this.encrypt(current.accountId, randomUUID(), secret); } finally { secret = ""; }
    return this.locked(() => {
      const value = this.load();
      if (!value || value.status !== "revoked" || value.accountId !== input.accountId || value.generation !== input.generation) fail("stale-or-revoked");
      this.commit(next); return this.metadata(next);
    });
  }
}
