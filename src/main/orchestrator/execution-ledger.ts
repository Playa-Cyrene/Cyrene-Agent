import type { ToolExecutionOutcome } from "./types";

export interface LogicalInvocationInput {
  logicalInvocationId: string;
  capability: string;
  targetRefs: string[];
  args: Record<string, unknown>;
}

function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => [key, stable(child)]),
  );
}

function requestFingerprint(input: LogicalInvocationInput): string {
  return JSON.stringify(stable({
    capability: input.capability,
    targetRefs: input.targetRefs,
    args: input.args,
  }));
}

export class LogicalInvocationConflictError extends Error {
  readonly code = "E_LOGICAL_INVOCATION_CONFLICT";
  readonly name = "LogicalInvocationConflictError";
}

export interface ExecutionLedgerPersistence {
  begin(key: string, fingerprint: string): Promise<{ outcome: ToolExecutionOutcome } | null>;
  finish(key: string, fingerprint: string, outcome: ToolExecutionOutcome): Promise<void>;
}

export class ExecutionLedger {
  private readonly requestFingerprints = new Map<string, string>();
  private readonly succeeded = new Map<string, ToolExecutionOutcome>();

  private readonly inFlight = new Map<string, Promise<{ outcome: ToolExecutionOutcome; cached: boolean }>>();
  constructor(private readonly persistence?: ExecutionLedgerPersistence) {}

  async execute(
    input: LogicalInvocationInput,
    run: () => Promise<ToolExecutionOutcome>,
  ): Promise<{ outcome: ToolExecutionOutcome; cached: boolean }> {
    const key = input.logicalInvocationId;
    const fingerprint = requestFingerprint(input);
    const previousFingerprint = this.requestFingerprints.get(key);
    if (previousFingerprint && previousFingerprint !== fingerprint) {
      throw new LogicalInvocationConflictError(
        `Logical invocation ${key} was reused with different request facts`,
      );
    }
    this.requestFingerprints.set(key, fingerprint);
    const existing = this.succeeded.get(key);
    if (existing) return { outcome: existing, cached: true };
    const pending = this.inFlight.get(key);
    if (pending) { const settled = await pending; return { outcome: settled.outcome, cached: true }; }
    const operation = (async () => {
      const receipt = await this.persistence?.begin(key, fingerprint);
      if (receipt) return { outcome: receipt.outcome, cached: true };
      let outcome: ToolExecutionOutcome;
      try { outcome = await run(); }
      catch (error) {
        await this.persistence?.finish(key, fingerprint, { output: "", status: "failed", effectState: "unknown", errorCode: "EXECUTION_OUTCOME_UNKNOWN" });
        throw error;
      }
      await this.persistence?.finish(key, fingerprint, outcome);
    // 只缓存终态成功结果：非终态成功结果（terminal=false）不得写入 ExecutionLedger。
    // 原因：非终态结果是中间状态，如果被缓存，后续相同输入会命中缓存返回中间结果，
    // 导致 Agent 认为工具已成功完成而跳过实际执行，形成无限循环。
    // terminal 未显式提供时按默认终态语义（true）处理。
    if (outcome.status === "succeeded" && outcome.terminal !== false) {
      this.succeeded.set(key, outcome);
    }
      return { outcome, cached: false };
    })();
    this.inFlight.set(key, operation);
    try { return await operation; }
    finally {
      this.inFlight.delete(key);
      if (this.persistence) { this.requestFingerprints.delete(key); this.succeeded.delete(key); }
    }
  }
}

interface ScopedLedger {
  ledger: ExecutionLedger;
  lastUsedAt: number;
}

/** Bounded, short-lived ledger cache used to survive a retry of the same conversation turn. */
export class ExecutionLedgerStore {
  private readonly entries = new Map<string, ScopedLedger>();

  constructor(
    private readonly ttlMs = 10 * 60_000,
    private readonly maxScopes = 256,
    private readonly now: () => number = Date.now,
  ) {}

  forScope(scopeId: string): ExecutionLedger {
    const now = this.now();
    for (const [id, entry] of this.entries) {
      if (now - entry.lastUsedAt > this.ttlMs) this.entries.delete(id);
    }
    const existing = this.entries.get(scopeId);
    if (existing) {
      existing.lastUsedAt = now;
      return existing.ledger;
    }
    if (this.entries.size >= this.maxScopes) {
      const oldest = [...this.entries.entries()].sort(([, left], [, right]) => left.lastUsedAt - right.lastUsedAt)[0];
      if (oldest) this.entries.delete(oldest[0]);
    }
    const ledger = new ExecutionLedger();
    this.entries.set(scopeId, { ledger, lastUsedAt: now });
    return ledger;
  }
}
