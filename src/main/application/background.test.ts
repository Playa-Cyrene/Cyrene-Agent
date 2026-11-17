import { describe, expect, it, vi } from "vitest";
import { createShutdownCoordinator } from "./shutdown";
import { createStartupReadiness } from "./readiness";
import { MCP_RESTORE_BARRIER_TIMEOUT_MS, startBackground, createBackgroundTaskRunner, type BackgroundDependencies } from "./background";
import type { CoreResult } from "./core-bootstrap";

function makeCore(): CoreResult {
  return {
    runtime: {} as never,
    services: {} as never,
    channels: {} as never,
    plugins: {} as never,
    scheduler: {} as never,
  };
}

function makeBackgroundDeps(calls: string[], overrides: Partial<BackgroundDependencies> = {}): BackgroundDependencies & {
  readiness: ReturnType<typeof createStartupReadiness>;
  channels: { start: ReturnType<typeof vi.fn>; shutdown: ReturnType<typeof vi.fn> };
  scheduler: { start: ReturnType<typeof vi.fn>; stop: ReturnType<typeof vi.fn> };
} {
  const readiness = createStartupReadiness();
  readiness.transition("shell-ready");
  readiness.transition("core-ready");
  readiness.transition("background-starting");
  const channels = { start: vi.fn(async () => { calls.push("channels"); }), shutdown: vi.fn(async () => undefined) };
  const scheduler = { start: vi.fn(() => { calls.push("scheduler"); }), stop: vi.fn() };

  const deps: BackgroundDependencies = {
    core: makeCore(),
    channels: channels as never,
    scheduler: scheduler as never,
    readiness,
    shutdown: createShutdownCoordinator({ readiness, timeoutMs: 1000 }),
    pruneRemovedMcp: vi.fn(async () => { calls.push("prune"); }),
    prepareChatCapabilities: vi.fn(async () => { calls.push("chat-capabilities"); }),
    restoreMcp: vi.fn(async () => { calls.push("mcp"); }),
    reconcileMemory: vi.fn(async () => { calls.push("memory"); }),
    initializeReranker: vi.fn(async () => { calls.push("reranker"); }),
    prewarmScreenshot: vi.fn(async () => { calls.push("screenshot"); }),
    scheduleUpdateCheck: vi.fn(async () => { calls.push("update-check"); return () => undefined; }),
    startProactiveTrigger: vi.fn(async () => { calls.push("proactive"); return () => undefined; }),
    startMomentsReactionScanner: vi.fn(async () => { calls.push("moments-scanner"); return () => undefined; }),
    ...overrides,
  };

  return { ...deps, readiness, channels, scheduler } as never;
}

describe("createBackgroundTaskRunner", () => {
  it("aborts cooperative tasks and disposes resources returned after stop", async () => {
    const lateDispose = vi.fn();
    let deferredResolve: ((value: { dispose(): void }) => void) | undefined;
    const deferred = new Promise<{ dispose(): void }>((resolve) => { deferredResolve = resolve; });
    const runner = createBackgroundTaskRunner();
    const running = runner.run("late", async () => deferred);
    const stopping = runner.stop();
    deferredResolve?.({ dispose: lateDispose });
    await Promise.allSettled([running, stopping]);
    expect(lateDispose).toHaveBeenCalledOnce();
  });

  it("rejects new tasks after stop", async () => {
    const runner = createBackgroundTaskRunner();
    await runner.stop();
    await expect(runner.run("late", async () => undefined)).rejects.toThrow("stopped");
  });
});

describe("startBackground", () => {
  it("starts channels and scheduler after MCP settles", async () => {
    const calls: string[] = [];
    const background = startBackground(makeBackgroundDeps(calls));
    await background.settled;
    expect(calls).toEqual(expect.arrayContaining(["mcp", "channels", "scheduler"]));
    expect(calls.indexOf("mcp")).toBeLessThan(calls.indexOf("channels"));
    expect(calls.indexOf("channels")).toBeLessThan(calls.indexOf("scheduler"));
  });

  it("starts the moments reaction scanner after the proactive trigger and disposes it on shutdown", async () => {
    const calls: string[] = [];
    const disposeScanner = vi.fn();
    const deps = makeBackgroundDeps(calls, {
      startMomentsReactionScanner: vi.fn(async () => { calls.push("moments-scanner"); return { dispose: disposeScanner }; }),
    });
    const background = startBackground(deps);
    await background.settled;

    // 扫描器跟在主动触发器之后启动（同组串行），失败只降级不阻塞 ready
    expect(calls.indexOf("proactive")).toBeLessThan(calls.indexOf("moments-scanner"));

    await deps.shutdown.requestControlledShutdown({
      reason: "test",
      finalAction: () => undefined,
    });
    expect(disposeScanner).toHaveBeenCalledOnce();
  });

  it("continues after MCP barrier timeout and marks degradation", async () => {
    vi.useFakeTimers();
    try {
      const calls: string[] = [];
      const deps = makeBackgroundDeps(calls, {
        restoreMcp: () => new Promise(() => undefined),
      });
      const background = startBackground(deps);
      await vi.advanceTimersByTimeAsync(MCP_RESTORE_BARRIER_TIMEOUT_MS);
      await background.settled;
      expect(deps.channels.start).toHaveBeenCalledOnce();
      expect(deps.scheduler.start).toHaveBeenCalledOnce();
      expect(deps.readiness.getDegradedReasons().has("mcp")).toBe(true);
      expect(deps.readiness.getPhase()).toBe("ready");
    } finally {
      vi.useRealTimers();
    }
  });

  it("marks degraded when a group fails but still reaches ready", async () => {
    const deps = makeBackgroundDeps([], {
      restoreMcp: async () => { throw new Error("mcp offline"); },
      prewarmScreenshot: async () => { throw new Error("prewarm failed"); },
    });
    const background = startBackground(deps);
    await background.settled;
    expect(deps.channels.start).toHaveBeenCalledOnce();
    expect(deps.scheduler.start).toHaveBeenCalledOnce();
    expect(deps.readiness.getDegradedReasons().has("mcp")).toBe(true);
    expect(deps.readiness.getDegradedReasons().has("screenshot")).toBe(true);
    expect(deps.readiness.getPhase()).toBe("ready");
  });

  it("stops the runner and stops scheduler through the coordinator", async () => {
    const deps = makeBackgroundDeps([]);
    const background = startBackground(deps);
    await background.settled;
    await deps.shutdown.requestControlledShutdown({
      reason: "test",
      finalAction: () => undefined,
    });
    expect(deps.scheduler.stop).toHaveBeenCalledOnce();
    expect(deps.readiness.getPhase()).toBe("stopped");
  });
});
