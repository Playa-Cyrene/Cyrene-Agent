import { setTimeout as sleep } from "node:timers/promises";
import type { ModelRetryStatus } from "../../../shared/model-retry";
import { isModelFailureInfo, type ModelFailureInfo } from "../../../shared/model-error";
import { AgentRuntimeError } from "../agent-runtime-error";
import { nextModelRetryDelayMs, readRetryAfterMs } from "./model-retry-policy";

export interface ModelRetryAttemptInput {
  signal: AbortSignal;
  /** 收到响应数据或协议增量时重置空闲超时。 */
  onStreamActivity: () => void;
  /** 用户可见文本或推理开始输出后禁止重发。 */
  onVisibleDelta: () => void;
  retryNumber: number;
}

export interface ModelRetryRunnerOptions {
  provider: string;
  model: string;
  maxRetries: number;
  idleTimeoutMs: number;
  signal?: AbortSignal;
  getRemainingBudgetMs?: () => number;
  onStatus?: (status: ModelRetryStatus) => void;
}

function findModelFailure(error: unknown): ModelFailureInfo | undefined {
  let current = error;
  const visited = new Set<object>();
  for (let depth = 0; depth < 8 && typeof current === "object" && current !== null; depth += 1) {
    if (visited.has(current)) return undefined;
    visited.add(current);
    const record = current as Record<string, unknown>;
    if (isModelFailureInfo(record.modelFailure)) return record.modelFailure;
    current = record.cause;
  }
  return undefined;
}

function makeIdleTimeoutError(provider: string, model: string, cause: unknown): AgentRuntimeError {
  return new AgentRuntimeError("E_MODEL_REQUEST_TIMEOUT", "模型响应超时，请稍后重试。", {
    cause,
    modelFailure: { provider, model, category: "TIMEOUT", retryable: true },
  });
}

function makeBudgetTimeoutError(provider: string, model: string, cause: unknown): AgentRuntimeError {
  return new AgentRuntimeError("E_MODEL_REQUEST_TIMEOUT", "模型请求超过本轮剩余时间。", {
    cause,
    modelFailure: { provider, model, category: "TIMEOUT", retryable: true },
  });
}

export async function runModelRequestWithRetry<T>(
  attempt: (input: ModelRetryAttemptInput) => Promise<T>,
  options: ModelRetryRunnerOptions,
): Promise<T> {
  const maxRetries = Number.isFinite(options.maxRetries)
    ? Math.max(0, Math.min(10, Math.trunc(options.maxRetries)))
    : 5;
  let activeRetryNumber = 0;
  let statusActive = false;
  let visibleOutput = false;

  const emitStatus = (status: ModelRetryStatus): void => {
    statusActive = status.phase !== "cleared";
    options.onStatus?.(status);
  };
  const clearStatus = (): void => {
    if (!statusActive) return;
    emitStatus({ phase: "cleared", retryNumber: activeRetryNumber, maxRetries });
  };
  const throwBudgetTimeout = (cause: unknown): never => {
    throw makeBudgetTimeoutError(options.provider, options.model, cause);
  };

  try {
    for (let retryNumber = 0; retryNumber <= maxRetries; retryNumber += 1) {
      activeRetryNumber = retryNumber;
      if (options.signal?.aborted) throw new Error("E_SOUL_ONLY_CANCELLED");
      if (retryNumber > 0) {
        const remaining = options.getRemainingBudgetMs?.();
        if (remaining !== undefined && remaining <= 0) throwBudgetTimeout(undefined);
        emitStatus({ phase: "attempting", retryNumber, maxRetries });
      }

      const controller = new AbortController();
      let idleTimer: ReturnType<typeof setTimeout> | undefined;
      let idleTimedOut = false;
      const onCallerAbort = () => controller.abort();
      const resetIdleTimer = () => {
        if (idleTimer !== undefined) clearTimeout(idleTimer);
        if (options.idleTimeoutMs > 0) {
          idleTimer = setTimeout(() => {
            idleTimedOut = true;
            controller.abort();
          }, options.idleTimeoutMs);
        }
      };
      const onStreamActivity = () => resetIdleTimer();
      const onVisibleDelta = () => {
        visibleOutput = true;
        onStreamActivity();
        clearStatus();
      };
      options.signal?.addEventListener("abort", onCallerAbort, { once: true });
      if (options.signal?.aborted) onCallerAbort();
      resetIdleTimer();

      try {
        return await attempt({ signal: controller.signal, onStreamActivity, onVisibleDelta, retryNumber });
      } catch (originalError) {
        if (options.signal?.aborted) throw originalError;
        const error = idleTimedOut
          ? makeIdleTimeoutError(options.provider, options.model, originalError)
          : originalError;
        if (visibleOutput) throw error;

        if (retryNumber >= maxRetries) throw error;

        const retryAfterMs = readRetryAfterMs(error);
        const delayMs = nextModelRetryDelayMs(retryNumber + 1, retryAfterMs);
        if (delayMs === undefined) throw error;
        const remaining = options.getRemainingBudgetMs?.();
        if (remaining !== undefined && remaining <= delayMs) throwBudgetTimeout(error);

        emitStatus({
          phase: "waiting", retryNumber: retryNumber + 1, maxRetries, delayMs,
          category: findModelFailure(error)?.category ?? "UNKNOWN",
        });
        try {
          await sleep(delayMs, undefined, { signal: options.signal });
        } catch (waitError) {
          if (options.signal?.aborted) throw new Error("E_SOUL_ONLY_CANCELLED", { cause: waitError });
          throw waitError;
        }
      } finally {
        if (idleTimer !== undefined) clearTimeout(idleTimer);
        options.signal?.removeEventListener("abort", onCallerAbort);
      }
    }
    throw new Error("模型重试执行器进入了不可达状态");
  } finally {
    clearStatus();
  }
}
