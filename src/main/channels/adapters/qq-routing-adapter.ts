import { AsyncLocalStorage } from "node:async_hooks";
import type { ChannelAdapter } from "./base";
import type { ChannelCapability, ChannelStatus, MessageHandler, OutgoingMessage } from "../types";
import type { QqMigrationLegacyPort } from "../../qq-modules/migration";
import type { QqModuleManager } from "../../qq-modules/manager";
import { QqModuleAdapter } from "./qq-module-adapter";

type Legacy = ChannelAdapter & QqMigrationLegacyPort;
/** Register exactly this adapter under qq. The coordinator owns module staging and
 * activation; attaching a manager never starts it. No persisted choice is live proof.
 * `blocked` is a trusted host startup decision (recovery/first setup), not renderer input. */
export class QqRoutingAdapter implements ChannelAdapter, QqMigrationLegacyPort {
  readonly id = "qq" as const;
  readonly displayName = "QQ";
  onMessage: MessageHandler | null = null;
  private module?: QqModuleAdapter;
  private mode: "legacy" | "blocked" | "module";
  private generation = 0;
  private stoppedForSwitch: boolean;
  private busy = false;
  private operation?: Promise<unknown>;
  private stopping?: Promise<void>;
  private stopRequested = false;
  private legacyDraining = false;
  private readonly turns = new AsyncLocalStorage<number>();
  constructor(private readonly legacy: Legacy, initial: "legacy" | "blocked" = "legacy") {
    this.mode = initial;
    this.stoppedForSwitch = false;
    this.wire(legacy, 0, "legacy");
  }
  private wire(adapter: ChannelAdapter, generation: number, driver: "legacy" | "module"): void {
    adapter.onMessage = (message) => {
      if (this.mode !== driver || this.generation !== generation || message.channel !== "qq"
        || (driver === "legacy" && this.legacyDraining)
        || (driver === "module" && !this.module?.manager.getActiveMigrationIdentity())) return Promise.resolve(null);
      return this.turns.run(generation, () => this.onMessage?.(message) ?? Promise.resolve(null));
    };
  }
  isLegacyBlocked(): boolean { return this.mode !== "legacy"; }
  getDriver(): "legacy" | "blocked" | "module" { return this.mode; }
  get capability(): ChannelCapability { return this.module?.capability ?? this.legacy.capability; }
  private runOperation<T>(work: () => Promise<T>): Promise<T> {
    this.busy = true;
    const operation = Promise.resolve().then(work);
    this.operation = operation;
    return operation.finally(() => {
      if (this.operation === operation) { this.operation = undefined; this.busy = false; }
    });
  }
  async start(): Promise<void> {
    if (this.busy || this.stopping) throw new Error("QQ_ROUTING_BUSY");
    // startAll / settings restart must not replay a migration or silently fall back.
    if (this.mode !== "legacy") throw new Error("QQ_ROUTING_EXPLICIT_ACTIVATION_REQUIRED");
    this.stopRequested = false;
    await this.runOperation(() => this.legacy.start());
  }
  stop(): Promise<void> {
    this.stopRequested = true; // Revoke attachment before waiting for in-flight work.
    if (this.stopping) return this.stopping;
    const operation = this.operation;
    this.stopping = (async () => {
      try { await operation; } catch { /* A failed start/drain still requires stop. */ }
      this.busy = true;
      try {
        if (this.mode === "module") await this.module!.stop();
        else await this.legacy.stop();
      } catch (error) {
        if (this.mode === "legacy") { this.mode = "blocked"; this.generation++; }
        throw error;
      } finally { this.busy = false; }
      // Ordinary legacy stop is not independently verified listener-exit proof.
    })().finally(() => { this.stopping = undefined; });
    return this.stopping;
  }
  async send(message: OutgoingMessage): Promise<{ ok: boolean; error?: string }> {
    const turn = this.turns.getStore();
    if (message.channel !== "qq" || (turn !== undefined && turn !== this.generation)
      || this.mode === "blocked" || (this.mode === "legacy" && this.legacyDraining && turn === undefined)) return { ok: false, error: "QQ_ROUTING_REVOKED" };
    if (this.mode === "module") return this.module!.send(message);
    return this.legacy.send(message);
  }
  getStatus(): ChannelStatus {
    if (this.mode === "blocked") return { enabled: false, phase: "error", message: "QQ_ROUTING_EXPLICIT_ACTIVATION_REQUIRED" };
    return this.mode === "module" ? this.module!.getStatus() : this.legacy.getStatus();
  }
  getMigrationIdentity(): ReturnType<QqMigrationLegacyPort["getMigrationIdentity"]> {
    return this.mode === "legacy" && !this.busy && !this.legacyDraining ? this.legacy.getMigrationIdentity() : null;
  }
  async prepareMigrationStop(input: Parameters<QqMigrationLegacyPort["prepareMigrationStop"]>[0]): ReturnType<QqMigrationLegacyPort["prepareMigrationStop"]> {
    if (this.mode !== "legacy" || this.busy || this.stopping || this.stopRequested) throw new Error("QQ_ROUTING_BUSY");
    this.legacyDraining = true; this.stoppedForSwitch = false;
    return this.runOperation(async () => { try {
      const result = await this.legacy.prepareMigrationStop(input);
      this.stoppedForSwitch = result.safeToSwitch && result.drained && result.stopped;
      return result;
    } finally {
      // A failed/uncertain stop also blocks restart. Never revive a quiesced legacy driver.
      this.mode = "blocked"; this.generation++;
    } });
  }
  /** First setup/recovery must prove the old runtime absent independently. Blocking
   * survives verification failure and does not itself constitute stop proof. */
  async prepareFirstSetup(verifyStopped: () => Promise<boolean>): Promise<boolean> {
    if (this.busy || this.stopping || this.stopRequested || this.module || this.stoppedForSwitch) throw new Error("QQ_ROUTING_BUSY");
    this.mode = "blocked"; this.generation++;
    return this.runOperation(async () => { this.stoppedForSwitch = await verifyStopped(); return this.stoppedForSwitch; });
  }
  /** Trusted factory calls after legacy stop proof and BEFORE stageForMigration.
   * Install-only and generic restart cannot invoke this. No automatic fallback. */
  attachModule(manager: QqModuleManager): void {
    if (this.busy || this.stopping || this.stopRequested || this.mode !== "blocked" || !this.stoppedForSwitch || this.module) throw new Error("QQ_ROUTING_SWITCH_UNCONFIRMED");
    if (!["disabled", "stopped"].includes(manager.getState().phase)) throw new Error("QQ_ROUTING_MODULE_ALREADY_STARTED");
    this.module = new QqModuleAdapter(manager);
    this.mode = "module"; this.generation++; this.stoppedForSwitch = false;
    this.wire(this.module, this.generation, "module");
  }
}
