import { randomUUID } from "node:crypto";
import { QQ_RUNTIME_TIMEOUTS, validateEnvelope, validateRequestPayload, validateResponsePayload, type QqEvent, type QqMethod, type QqRequestPayloads, type QqResponsePayloads } from "../../shared/qq-module";

/** Private parent/child IPC only; no HTTP server, shell or renderer-facing raw port. */
export interface QqProcessTransport {
  postMessage(message: unknown): void;
  onMessage(listener: (message: unknown) => void): () => void;
  onExit(listener: () => void): () => void;
  onError?(listener: () => void): () => void;
  /** Resolves only after confirmed process exit; rejects on a bounded failure. */
  terminate(): Promise<void>;
}
export class QqRuntimeError extends Error {
  constructor(readonly code: "timeout" | "cancelled" | "closed" | "protocol" | "busy" | "remote", readonly transmitted: boolean) {
    super(`QQ_MODULE_${code.toUpperCase()}`);
  }
}
interface Pending {
  method: QqMethod;
  payload: unknown;
  transmitted: boolean;
  resolve: (value: unknown) => void;
  reject: (error: QqRuntimeError) => void;
  cleanup: () => void;
}
export class QqModuleRuntime {
  readonly instanceId = randomUUID();
  readonly apiVersion = { major: 1, minor: 0 } as const;
  private readonly pending = new Map<string, Pending>();
  private readonly events = new Set<(event: QqEvent) => void>();
  private readonly exits = new Set<() => void>();
  private readonly detachMessage: () => void;
  private readonly detachExit: () => void;
  private readonly detachError: () => void;
  private closed = false;
  private exited = false;
  private termination?: Promise<boolean>;
  constructor(private readonly transport: QqProcessTransport, readonly runtimeEpoch: number, private readonly timeoutMs: number = QQ_RUNTIME_TIMEOUTS.controlMs) {
    this.detachMessage = transport.onMessage((v) => this.receive(v));
    this.detachError = transport.onError?.(() => { void this.close(); }) ?? (() => {});
    this.detachExit = transport.onExit(() => {
      this.exited = true;
      if (!this.closed) void this.close();
      this.detachExit();
    });
  }
  onEvent(listener: (event: QqEvent) => void): () => void { this.events.add(listener); return () => this.events.delete(listener); }
  onClose(listener: () => void): () => void { this.exits.add(listener); return () => this.exits.delete(listener); }
  get pendingCount(): number { return this.pending.size; }
  get isClosed(): boolean { return this.closed; }
  get hasExited(): boolean { return this.exited; }
  request<K extends QqMethod>(method: K, payload: QqRequestPayloads[K], signal?: AbortSignal, timeoutMs = this.timeoutMs): Promise<QqResponsePayloads[K]> {
    if (this.closed) return Promise.reject(new QqRuntimeError("closed", false));
    if (signal?.aborted) return Promise.reject(new QqRuntimeError("cancelled", false));
    if (this.pending.size >= 64) return Promise.reject(new QqRuntimeError("busy", false));
    if (!validateRequestPayload(method, payload)) return Promise.reject(new QqRuntimeError("protocol", false));
    // Snapshot before queuing so caller mutations cannot alter request/result correlation.
    const snapshot: unknown = JSON.parse(JSON.stringify(payload));
    const requestId = randomUUID();
    const envelope = { apiVersion: this.apiVersion, instanceId: this.instanceId, runtimeEpoch: this.runtimeEpoch, kind: "request", requestId, method, payload: snapshot };
    // A legal payload may still overflow the frame once identity is added.
    if (!validateEnvelope(envelope)) return Promise.reject(new QqRuntimeError("protocol", false));
    return new Promise<QqResponsePayloads[K]>((resolve, reject) => {
      const cancel = () => this.fail(requestId, "cancelled");
      const timer = setTimeout(() => this.fail(requestId, "timeout"), timeoutMs);
      const pending: Pending = { method, payload: snapshot, transmitted: false, resolve: (v) => resolve(v as QqResponsePayloads[K]), reject,
        cleanup: () => { clearTimeout(timer); signal?.removeEventListener("abort", cancel); } };
      this.pending.set(requestId, pending);
      signal?.addEventListener("abort", cancel, { once: true });
      try {
        // Treat a postMessage exception as uncertain, never safe-to-retry sending.
        pending.transmitted = true;
        this.transport.postMessage(envelope);
      } catch { this.fail(requestId, "closed"); this.close(); }
    });
  }
  private fail(requestId: string, code: QqRuntimeError["code"]): void {
    const pending = this.pending.get(requestId);
    if (!pending) return;
    this.pending.delete(requestId); pending.cleanup(); pending.reject(new QqRuntimeError(code, pending.transmitted));
  }
  private receive(value: unknown): void {
    if (this.closed) return;
    // Wrong generation and late/duplicate terminal responses never affect this instance.
    if (!validateEnvelope(value)) { this.close("protocol"); return; }
    if (value.instanceId !== this.instanceId || value.runtimeEpoch !== this.runtimeEpoch) return;
    if (value.kind === "response") {
      const pending = this.pending.get(value.responseTo);
      if (!pending) return;
      if (!value.ok) { this.fail(value.responseTo, "remote"); return; }
      if (!validateResponsePayload(pending.method, value.payload, pending.payload)) { this.close("protocol"); return; }
      this.pending.delete(value.responseTo); pending.cleanup(); pending.resolve(value.payload);
    } else if (value.kind === "event") {
      for (const listener of this.events) listener(value);
    } else { this.close("protocol"); }
  }
  close(code: "closed" | "protocol" = "closed"): Promise<boolean> {
    if (this.closed) return this.termination ?? Promise.resolve(this.exited);
    this.closed = true;
    this.detachMessage();
    this.detachError();
    for (const requestId of this.pending.keys()) this.fail(requestId, code);
    // Closing the RPC port is not evidence that the process stopped. A failed
    // termination keeps its exit observer alive and prevents replacement.
    this.termination = Promise.resolve().then(async () => {
      if (!this.exited) await this.transport.terminate();
      this.exited = true;
      this.detachExit();
      return true;
    }).catch(() => this.exited);
    for (const listener of this.exits) listener();
    this.events.clear(); this.exits.clear();
    return this.termination;
  }
}
