/**
 * 受控退出协调器（ShutdownCoordinator）：
 * 固定清理阶段顺序执行（不依赖注册顺序），同一阶段内 Promise.allSettled() 并行，
 * 单个清理函数失败不跳过后续阶段；总超时触发后中止信号、记录未完成资源并停止等待。
 */

import type { StartupReadiness } from "./readiness";

export type ShutdownPhase =
  | "quiesce"
  | "stopProducers"
  | "stopActiveWork"
  | "stopExternalConsumers"
  | "stopExternalProviders"
  | "stopLocalResources"
  | "flushPersistence"
  | "closePersistence";

// 固定清理阶段顺序（与 composition-root 计划一致），不得用“反向注册顺序”替代。
const SHUTDOWN_PHASE_ORDER: readonly ShutdownPhase[] = [
  "quiesce",
  "stopProducers",
  "stopActiveWork",
  "stopExternalConsumers",
  "stopExternalProviders",
  "stopLocalResources",
  "flushPersistence",
  "closePersistence",
];

export interface ShutdownCoordinator {
  register(input: {
    id: string;
    phase: ShutdownPhase;
    dispose(signal: AbortSignal): void | Promise<void>;
  }): () => void;
  registerEmergencyFlush(id: string, flush: () => void): () => void;
  requestControlledShutdown(input: {
    reason: string;
    finalAction(): void;
  }): Promise<void>;
  emergencyFlush(): void;
  isStopping(): boolean;
  isFinalizing(): boolean;
}

interface Registration {
  id: string;
  phase: ShutdownPhase;
  dispose(signal: AbortSignal): void | Promise<void>;
}

export interface CreateShutdownCoordinatorOptions {
  readiness: StartupReadiness;
  /** 受控退出总超时；超时后中止信号并停止等待未完成的清理函数。 */
  timeoutMs?: number;
  setTimeout?: typeof globalThis.setTimeout;
  clearTimeout?: typeof globalThis.clearTimeout;
  log?: (message: string, error?: unknown) => void;
}

const DEFAULT_TIMEOUT_MS = 10_000;

/** 退出耗时埋点：整体超过该阈值才输出一行汇总，避免正常退出刷屏。 */
const TIMING_LOG_THRESHOLD_MS = 500;
/** 单项清理超过该阈值才计入「慢资源」明细。 */
const SLOW_RESOURCE_MS = 200;

interface ShutdownTiming {
  /** 各阶段实际耗时（含阶段内并行等待）。 */
  phases: Array<{ phase: ShutdownPhase; ms: number }>;
  /** 单项清理耗时明细，仅记录慢资源。 */
  slow: Array<{ id: string; ms: number }>;
}

export function createShutdownCoordinator(options: CreateShutdownCoordinatorOptions): ShutdownCoordinator {
  const readiness = options.readiness;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const setTimeoutFn = options.setTimeout ?? ((handler: () => void, ms: number) => globalThis.setTimeout(handler, ms));
  const clearTimeoutFn = options.clearTimeout ?? ((handle: ReturnType<typeof setTimeout>) => globalThis.clearTimeout(handle));
  const log = options.log ?? ((message, error) => console.error(message, error));

  const registrations = new Map<string, Registration>();
  const emergencyFlushers = new Map<string, () => void>();
  let stopping = false;
  let finalizing = false;
  let emergencyFlushDone = false;
  let shutdownPromise: Promise<void> | null = null;
  let firstRequest: { reason: string; finalAction(): void } | null = null;

  // 依次执行各阶段；同一阶段内并行，单项失败记录后继续，不跳过后续阶段。
  async function runPhases(signal: AbortSignal, pendingIds: Set<string>, timing: ShutdownTiming): Promise<void> {
    for (const phase of SHUTDOWN_PHASE_ORDER) {
      if (signal.aborted) break;
      const entries = [...registrations.values()].filter((entry) => entry.phase === phase);
      if (entries.length === 0) continue;
      for (const entry of entries) pendingIds.add(entry.id);
      const phaseStartedAt = performance.now();
      await Promise.allSettled(entries.map(async (entry) => {
        const startedAt = performance.now();
        try {
          await entry.dispose(signal);
        } catch (error) {
          log(`shutdown: dispose failed for ${entry.id} (${phase})`, error);
        } finally {
          const ms = performance.now() - startedAt;
          if (ms >= SLOW_RESOURCE_MS) timing.slow.push({ id: entry.id, ms });
          pendingIds.delete(entry.id);
        }
      }));
      timing.phases.push({ phase, ms: performance.now() - phaseStartedAt });
    }
  }

  /** 退出耗时汇总：仅在整体偏慢时输出一行，含各阶段耗时与慢资源明细。 */
  function logShutdownTiming(totalMs: number, timing: ShutdownTiming): void {
    if (totalMs < TIMING_LOG_THRESHOLD_MS) return;
    const phases = timing.phases.map((item) => `${item.phase}=${Math.round(item.ms)}ms`).join(" ");
    const slow = timing.slow.length > 0
      ? ` | slow: ${timing.slow.map((item) => `${item.id}=${Math.round(item.ms)}ms`).join(", ")}`
      : "";
    console.log(`[ShutdownTiming] cleanup ${Math.round(totalMs)}ms | ${phases}${slow}`);
  }

  function finalize(): void {
    if (finalizing) return;
    try {
      if (readiness.getPhase() === "stopping") readiness.transition("stopped");
    } catch (error) {
      log("shutdown: readiness transition to stopped failed", error);
    }
    finalizing = true;
    const request = firstRequest;
    if (request) {
      try {
        request.finalAction();
      } catch (error) {
        log(`shutdown: finalAction failed (${request.reason})`, error);
      }
    }
  }

  return {
    register(input) {
      registrations.set(input.id, { id: input.id, phase: input.phase, dispose: input.dispose });
      return () => {
        registrations.delete(input.id);
      };
    },

    registerEmergencyFlush(id, flush) {
      emergencyFlushers.set(id, flush);
      return () => {
        emergencyFlushers.delete(id);
      };
    },

    requestControlledShutdown(input) {
      // 后续请求复用同一个 Promise；finalAction 只执行第一次请求传入的那个。
      if (shutdownPromise) return shutdownPromise;
      firstRequest = input;
      stopping = true;
      try {
        if (readiness.getPhase() !== "stopped") readiness.transition("stopping");
      } catch (error) {
        log("shutdown: readiness transition to stopping failed", error);
      }

      const controller = new AbortController();
      const pendingIds = new Set<string>();
      const timing: ShutdownTiming = { phases: [], slow: [] };
      const cleanupStartedAt = performance.now();
      let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
      const deadline = new Promise<void>((resolve) => {
        timeoutHandle = setTimeoutFn(() => {
          controller.abort();
          log(`shutdown: total timeout (${timeoutMs}ms) reached, incomplete resources: ${[...pendingIds].join(", ") || "(none)"}`);
          resolve();
        }, timeoutMs);
      });

      shutdownPromise = Promise.race([runPhases(controller.signal, pendingIds, timing), deadline]).then(() => {
        if (timeoutHandle !== undefined) clearTimeoutFn(timeoutHandle);
        logShutdownTiming(performance.now() - cleanupStartedAt, timing);
        finalize();
      });
      return shutdownPromise;
    },

    // 紧急落盘：同步、幂等，不等待网络、不执行完整受控退出。
    emergencyFlush() {
      if (emergencyFlushDone) return;
      emergencyFlushDone = true;
      for (const [id, flush] of emergencyFlushers) {
        try {
          flush();
        } catch (error) {
          log(`shutdown: emergency flush failed for ${id}`, error);
        }
      }
    },

    isStopping: () => stopping,
    isFinalizing: () => finalizing,
  };
}
