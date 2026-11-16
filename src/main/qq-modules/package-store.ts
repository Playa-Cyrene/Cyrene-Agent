import { closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname, isAbsolute, join, parse, resolve } from "node:path";
import { strictObject } from "../../shared/qq-module/validation";
import { isQqPackagePath, QQ_PACKAGE_LIMITS, QqPackageError, qqPackageDigest, verifyQqPackage,
  type QqPackageManifest, type QqPackageVerificationContext, type QqSignedPackage } from "./package-verifier";

interface StoreState { schemaVersion: 1; active: string | null; previous: string | null; highestSequence: number }
export interface QqInstalledCandidate { packageId: string; manifest: QqPackageManifest }
const MARKER = "Cyrene QFCA candidate package store v1\n";
const packageId = (value: unknown): value is string => typeof value === "string" && /^pkg-[a-f0-9]{64}$/.test(value);
const emptyState = (): StoreState => ({ schemaVersion: 1, active: null, previous: null, highestSequence: 0 });
const fail = (code: string): never => { throw new QqPackageError(code); };

/** Offline staging primitive, deliberately NOT connected to runtime activation.
 * The host supplies a dedicated absolute directory, never a renderer/package path.
 * Only immutable code directories + an atomic selection pointer are written here.
 * No settings, credentials, chat history, bindings or existing QQ runtime are touched.
 * This is not a defense against hostile code with the same OS-user privileges. */
export class QqPackageStore {
  private readonly root: string;
  constructor(root: string, private readonly context: () => QqPackageVerificationContext,
    /** Fault injection for tests; not exposed through IPC. */
    private readonly checkpoint: (phase: "staged" | "published" | "before-commit") => void = () => {}) {
    if (!isAbsolute(root)) fail("invalid-store-path");
    this.root = resolve(root);
    if (this.root === parse(this.root).root) fail("invalid-store-path");
  }
  private directory(path: string): void {
    const stat = lstatSync(path);
    if (stat.isSymbolicLink() || !stat.isDirectory()) fail("unsafe-store-path");
  }
  private ancestors(path: string): void {
    const parent = dirname(path);
    if (parent !== path) this.ancestors(parent);
    this.directory(path);
  }
  private readFile(path: string, max: number): Buffer {
    this.ancestors(dirname(path));
    const stat = lstatSync(path);
    if (stat.isSymbolicLink() || !stat.isFile() || stat.nlink !== 1 || stat.size > max) fail("unsafe-store-file");
    const bytes = readFileSync(path);
    if (bytes.length > max) fail("unsafe-store-file");
    return bytes;
  }
  private ensureRoot(create: boolean): boolean {
    this.ancestors(dirname(this.root));
    if (!existsSync(this.root)) {
      if (!create) return false;
      mkdirSync(this.root, { mode: 0o700 });
      this.writeNew(join(this.root, "store-marker"), Buffer.from(MARKER));
    }
    this.directory(this.root);
    if (this.readFile(join(this.root, "store-marker"), 128).toString() !== MARKER) fail("unrecognized-store");
    return true;
  }
  private writeNew(path: string, bytes: Uint8Array): void {
    const fd = openSync(path, "wx", 0o600);
    try { writeFileSync(fd, bytes); fsyncSync(fd); } finally { closeSync(fd); }
  }
  private state(): StoreState {
    const path = join(this.root, "state.json");
    if (!existsSync(path)) return emptyState();
    let state: unknown;
    try { state = JSON.parse(this.readFile(path, 4096).toString()); } catch { return fail("invalid-store-state"); }
    if (!strictObject(state, { schemaVersion: (v) => v === 1, active: (v) => v === null || packageId(v),
      previous: (v) => v === null || packageId(v), highestSequence: (v) => Number.isSafeInteger(v) && (v as number) >= 0 })) fail("invalid-store-state");
    return state as StoreState;
  }
  private commit(state: StoreState): void {
    const temp = join(this.root, `.state-${randomUUID()}`);
    try {
      this.writeNew(temp, Buffer.from(JSON.stringify(state)));
      this.checkpoint("before-commit");
      // Same-volume rename is the commit point. Never delete the previous state first.
      renameSync(temp, join(this.root, "state.json"));
    } finally { if (existsSync(temp)) unlinkSync(temp); }
  }
  private locked<T>(action: () => T): T {
    this.ensureRoot(true);
    const path = join(this.root, "install-lock");
    let fd: number;
    try { fd = openSync(path, "wx", 0o600); } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") fail("install-busy-or-recovery-required");
      throw error;
    }
    try { return action(); } finally {
      // Cleanup cannot turn an already committed selection into a reported failure.
      // A leftover lock fails closed on the next install; recovery needs host review.
      try { closeSync(fd); } catch { /* no authority to discard package state */ }
      try { unlinkSync(path); } catch { /* retain a stale lock rather than overwrite */ }
    }
  }
  private readPackage(id: string): QqInstalledCandidate {
    if (!packageId(id)) fail("invalid-store-state");
    const base = join(this.root, id);
    this.directory(base);
    const manifest = this.readFile(join(base, "manifest.json"), QQ_PACKAGE_LIMITS.manifestBytes);
    const signature = this.readFile(join(base, "signature.bin"), 64);
    // Decode only a bounded path inventory first; cryptographic verification below
    // is still mandatory. No source path or arbitrary archive extraction is allowed.
    let parsed: QqPackageManifest;
    try { parsed = JSON.parse(manifest.toString()); } catch { return fail("invalid-manifest"); }
    if (!Array.isArray(parsed?.files) || parsed.files.length > QQ_PACKAGE_LIMITS.files) fail("invalid-file-inventory");
    const payload = join(base, "payload");
    this.directory(payload);
    const files = new Map<string, Uint8Array>();
    let total = 0;
    for (const entry of parsed.files) {
      if (!entry || !isQqPackagePath(entry.path) || !Number.isSafeInteger(entry.size) || entry.size < 0 || entry.size > QQ_PACKAGE_LIMITS.fileBytes) fail("invalid-file-inventory");
      total += entry.size;
      if (total > QQ_PACKAGE_LIMITS.totalBytes) fail("package-too-large");
      const bytes = this.readFile(join(payload, entry.path), entry.size);
      files.set(entry.path, bytes);
    }
    let count = 0;
    const walk = (path: string, prefix = ""): void => {
      for (const name of readdirSync(path)) {
        const full = join(path, name), relative = prefix ? `${prefix}/${name}` : name;
        if (!isQqPackagePath(relative)) fail("invalid-file-inventory");
        const stat = lstatSync(full);
        if (stat.isSymbolicLink()) fail("unsafe-store-path");
        if (stat.isDirectory()) walk(full, relative);
        else if (!stat.isFile() || !files.has(relative) || ++count > QQ_PACKAGE_LIMITS.files) fail("invalid-file-inventory");
      }
    };
    walk(payload);
    if (count !== files.size || id !== `pkg-${qqPackageDigest(manifest)}`) fail("file-integrity-failed");
    return { packageId: id, manifest: verifyQqPackage({ manifest, signature, files }, this.context()) };
  }
  getSelected(): QqInstalledCandidate | null {
    if (!this.ensureRoot(false)) return null;
    const state = this.state();
    return state.active ? this.readPackage(state.active) : null;
  }
  install(input: QqSignedPackage, consent: { userConfirmed: true }): QqInstalledCandidate {
    if (!strictObject(consent, { userConfirmed: (v) => v === true })) fail("explicit-consent-required");
    // Verify before any filesystem writes, and snapshot bytes before later callbacks.
    verifyQqPackage(input, this.context());
    const copy: QqSignedPackage = { manifest: Buffer.from(input.manifest), signature: Buffer.from(input.signature),
      files: new Map([...input.files].map(([path, bytes]) => [path, Buffer.from(bytes)])) };
    const manifest = verifyQqPackage(copy, this.context());
    return this.locked(() => {
      const state = this.state();
      if (manifest.releaseSequence <= state.highestSequence) fail("release-replay-blocked");
      // A revoked/expired/incompatible old package must not block a verified repair.
      // It remains on disk, but cannot be selected or rolled back without revalidation.
      const id = `pkg-${qqPackageDigest(copy.manifest)}`;
      const staging = join(this.root, `.stage-${randomUUID()}`), destination = join(this.root, id);
      if (existsSync(destination)) fail("package-already-present");
      let published = false, committed = false;
      mkdirSync(staging, { mode: 0o700 });
      try {
        this.writeNew(join(staging, "manifest.json"), copy.manifest);
        this.writeNew(join(staging, "signature.bin"), copy.signature);
        const payload = join(staging, "payload");
        mkdirSync(payload, { mode: 0o700 });
        for (const [path, bytes] of copy.files) {
          mkdirSync(dirname(join(payload, path)), { recursive: true, mode: 0o700 });
          this.writeNew(join(payload, path), bytes);
        }
        this.checkpoint("staged");
        renameSync(staging, destination); published = true;
        const result = this.readPackage(id);
        this.checkpoint("published");
        this.commit({ schemaVersion: 1, active: id, previous: state.active, highestSequence: manifest.releaseSequence });
        committed = true;
        return result;
      } finally {
        // Remove only our fresh paths, never existing versions or user data.
        if (!committed) rmSync(published ? destination : staging, { recursive: true, force: true });
      }
    });
  }
  rollback(consent: { userConfirmed: true }): QqInstalledCandidate {
    if (!strictObject(consent, { userConfirmed: (v) => v === true })) fail("explicit-consent-required");
    return this.locked(() => {
      const state = this.state();
      if (!state.previous) throw new QqPackageError("rollback-unavailable");
      const previous = this.readPackage(state.previous);
      // Keep the anti-replay high-water mark, including after explicit rollback.
      this.commit({ ...state, active: state.previous, previous: state.active });
      return previous;
    });
  }
}
