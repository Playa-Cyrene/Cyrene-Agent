import { closeSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, parse, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import type { QqProcessTransport } from "./runtime";

export interface QqDriverActivationGrant { readonly epoch: string; readonly generation: number }
export interface QqDriverOwnershipOptions {
  /** Host-owned directory dedicated to this managed profile, never renderer input. */
  directory: string;
  scopeId: string;
  /** Externally reviewed proof covering historical unmanaged drivers. No default. */
  bootstrap?: { verifyInitialScope(): boolean };
  /** Host must also prevent every legacy start after handing ownership over. */
  legacy?: { stopAndDrain(): Promise<boolean> };
}
const fail = (): never => { throw new Error("QQ_DRIVER_OWNERSHIP_BLOCKED"); };
const absent = (path: string): boolean => {
  try { lstatSync(path); return false; } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return true;
    return fail();
  }
};

/** Closed-world ownership, NOT discovery of arbitrary OS processes or a sandbox. */
export class QqDriverOwnershipSupervisor {
  readonly epoch = randomUUID();
  private generation = 0;
  private closed = false;
  private busy = false;
  private unknown = false;
  private legacyStopped: boolean;
  private grant?: QqDriverActivationGrant;
  private readonly tracked = new Map<QqProcessTransport, boolean>();
  private readonly directory: string;
  private readonly lease: string;
  private readonly state: string;
  private constructor(private readonly options: QqDriverOwnershipOptions) {
    if (!options.scopeId || options.scopeId.length > 200) fail();
    if (!isAbsolute(options.directory) || resolve(options.directory) === parse(resolve(options.directory)).root) fail();
    this.directory = resolve(options.directory);
    // Reject aliases through symlinks before creating the one dedicated leaf.
    let parent = dirname(this.directory);
    while (true) {
      const stat = lstatSync(parent);
      if (!stat.isDirectory() || stat.isSymbolicLink()) fail();
      const next = dirname(parent);
      if (next === parent) break;
      parent = next;
    }
    this.lease = join(this.directory, "owner.lock");
    this.state = join(this.directory, "ownership.json");
    this.legacyStopped = !options.legacy;
  }
  static open(options: QqDriverOwnershipOptions): QqDriverOwnershipSupervisor {
    const owner = new QqDriverOwnershipSupervisor(options);
    const initial = absent(owner.directory);
    if (initial) mkdirSync(owner.directory, { mode: 0o700 });
    const root = lstatSync(owner.directory);
    if (!root.isDirectory() || root.isSymbolicLink()) fail();
    // Never delete an old lease or guess that its process has died.
    const fd = openSync(owner.lease, "wx", 0o600);
    try { writeFileSync(fd, owner.epoch); fsyncSync(fd); } finally { closeSync(fd); }
    if (initial) {
      if (options.bootstrap?.verifyInitialScope() !== true) fail();
    } else {
      if (absent(owner.state)) fail();
      const stat = lstatSync(owner.state);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > 4096) fail();
      const value = JSON.parse(readFileSync(owner.state, "utf8"));
      if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).sort().join(",") !== "epoch,phase,schema,scopeId") fail();
      if (value.schema !== 1 || value.scopeId !== options.scopeId || value.phase !== "clean-retired" || typeof value.epoch !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value.epoch)) fail();
    }
    // Opening an epoch itself makes subsequent unclean restart fail closed.
    owner.persist("dirty");
    return owner;
  }
  private assertOwned(): void {
    if (this.closed || this.unknown) fail();
    const stat = lstatSync(this.lease);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size !== this.epoch.length || readFileSync(this.lease, "utf8") !== this.epoch) fail();
  }
  private persist(phase: "dirty" | "clean-retired"): void {
    this.assertOwned();
    const temp = join(this.directory, `ownership-${this.epoch}.tmp`);
    const fd = openSync(temp, "wx", 0o600);
    try {
      writeFileSync(fd, JSON.stringify({ schema: 1, scopeId: this.options.scopeId, epoch: this.epoch, phase }));
      fsyncSync(fd);
    } finally { closeSync(fd); }
    renameSync(temp, this.state);
    this.syncDirectory();
  }
  private syncDirectory(): void {
    // Windows does not expose a portable directory fsync through Node.
    if (process.platform === "win32") return;
    const fd = openSync(this.directory, "r");
    try { fsyncSync(fd); } finally { closeSync(fd); }
  }
  async beginActivation(): Promise<QqDriverActivationGrant> {
    this.assertOwned();
    if (this.busy) fail();
    this.busy = true;
    this.grant = undefined;
    ++this.generation;
    try {
      this.persist("dirty");
      if (!this.legacyStopped) {
        if (await this.options.legacy!.stopAndDrain() !== true) fail();
        this.legacyStopped = true;
      }
      this.assertOwned();
      if ([...this.tracked.values()].some((exited) => !exited)) fail();
      this.grant = Object.freeze({ epoch: this.epoch, generation: this.generation });
      return this.grant;
    } finally { this.busy = false; }
  }
  wrapCreateTransport(create: () => QqProcessTransport, grant: QqDriverActivationGrant): () => QqProcessTransport {
    return () => {
      this.assertOwned();
      if (this.busy || this.grant !== grant || grant.epoch !== this.epoch || grant.generation !== this.generation || !this.verifyAllStopped()) fail();
      this.grant = undefined;
      // Synchronous reservation and durable dirty intent precede any spawn.
      this.busy = true;
      try {
        this.persist("dirty");
        const transport = create();
        this.tracked.set(transport, false);
        // Adapter must replay an exit which occurred before this subscription.
        transport.onExit(() => { this.tracked.set(transport, true); });
        return transport;
      } catch (error) {
        // A creator can throw after spawning. No handle means unknown, not absent.
        this.unknown = true;
        throw error;
      } finally { this.busy = false; }
    };
  }
  verifyAllStopped(): boolean {
    try { this.assertOwned(); } catch { return false; }
    return !this.busy && this.legacyStopped && [...this.tracked.values()].every(Boolean);
  }
  verifyNoOtherDrivers(allowed?: QqProcessTransport): boolean {
    try { this.assertOwned(); } catch { return false; }
    if (this.busy || !this.legacyStopped || (allowed && !this.tracked.has(allowed))) return false;
    return [...this.tracked].every(([transport, exited]) => exited || transport === allowed);
  }
  retire(): void {
    // Retirement is a terminal request even if an exit/proof is still pending.
    // Keep the lease on any failure; a late exit cannot revive launch authority.
    const stopped = this.verifyAllStopped();
    this.grant = undefined;
    ++this.generation;
    try {
      if (!stopped) fail();
      this.persist("clean-retired");
    } finally { this.closed = true; }
    // Closed before unlocking: no later launch can race a new owner.
    unlinkSync(this.lease);
    this.syncDirectory();
  }
}
