import { describe, expect, it, vi } from "vitest";
import { createDefaultProactiveState, FOLLOWUP_INTERVAL_MS } from "./proactive-policy";
import { createProactiveChatService } from "./proactive-service";
import type { ProactiveCandidate, ProactiveRuntimeSnapshot } from "./proactive-types";

const NOW = Date.UTC(2026, 6, 13, 6);
const candidate: ProactiveCandidate = { sceneId: "work_break", score: 90, sceneCooldownMs: 0 };

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

function setup(overrides: Record<string, unknown> = {}) {
  const state = createDefaultProactiveState();
  let snapshot: ProactiveRuntimeSnapshot = {
    now: NOW,
    localHour: 14,
    idleSec: 0,
    enabled: true,
    conversationBusy: false,
    generationBusy: false,
    screenLocked: false,
  };
  const commitMessage = vi.fn(async () => ({ kind: "committed" as const }));
  const saveState = vi.fn();
  const runModel = vi.fn(async () => ({ kind: "send" as const, text: "休息一下吧♪" }));
  const getFallback = vi.fn(async () => ({ text: "预设关心", payload: { audio: true } }));
  const service = createProactiveChatService({
    loadState: () => state,
    saveState,
    getSnapshot: () => ({ ...snapshot }),
    buildMessages: async () => [],
    runModel,
    getFallback,
    commitMessage,
    ...overrides,
  });
  return { service, state, commitMessage, saveState, runModel, getFallback, setSnapshot: (next: Partial<ProactiveRuntimeSnapshot>) => { snapshot = { ...snapshot, ...next }; } };
}

describe("proactive chat service", () => {
  it("invalidates an in-flight generation when the user sends a message", async () => {
    const pending = deferred<{ kind: "send"; text: string }>();
    const ctx = setup({ runModel: vi.fn(() => pending.promise) });

    const evaluation = ctx.service.evaluateCandidate(candidate);
    ctx.service.invalidateForUserMessage();
    pending.resolve({ kind: "send", text: "stale" });
    await evaluation;

    expect(ctx.commitMessage).not.toHaveBeenCalled();
    expect(ctx.state.unansweredCount).toBe(0);
    expect(ctx.state.proactiveEpoch).toBe(1);
  });

  it("runs the complete policy again after the model returns", async () => {
    const pending = deferred<{ kind: "send"; text: string }>();
    const ctx = setup({ runModel: vi.fn(() => pending.promise) });
    const evaluation = ctx.service.evaluateCandidate(candidate);
    ctx.setSnapshot({ conversationBusy: true });
    pending.resolve({ kind: "send", text: "too late" });
    await evaluation;
    expect(ctx.commitMessage).not.toHaveBeenCalled();
  });

  it("never falls back or creates a message for explicit silent", async () => {
    const ctx = setup({ runModel: vi.fn(async () => ({ kind: "silent" as const })) });
    ctx.state.globalDesire = 90;
    await ctx.service.evaluateCandidate(candidate);
    expect(ctx.getFallback).not.toHaveBeenCalled();
    expect(ctx.commitMessage).not.toHaveBeenCalled();
    expect(ctx.state.globalDesire).toBe(0);
    expect(ctx.state.lastFiredAt.work_break).toBe(NOW);
    expect(ctx.state.unansweredCount).toBe(0);
  });

  it("uses preset fallback only for technical or invalid failures and rechecks policy", async () => {
    const ctx = setup({ runModel: vi.fn(async () => ({ kind: "invalid" as const, reason: "invalid_json" })) });
    await ctx.service.evaluateCandidate(candidate);
    expect(ctx.getFallback).toHaveBeenCalledOnce();
    expect(ctx.commitMessage).toHaveBeenCalledWith(expect.objectContaining({
      text: "预设关心",
      source: "fallback",
    }));

    const blocked = setup({ runModel: vi.fn(async () => ({ kind: "error" as const, reason: "timeout" })) });
    blocked.setSnapshot({ conversationBusy: true });
    await blocked.service.evaluateCandidate(candidate);
    expect(blocked.commitMessage).not.toHaveBeenCalled();
  });

  it("records a successful commit and blocks the third unanswered message", async () => {
    const ctx = setup();
    await ctx.service.evaluateCandidate(candidate);
    expect(ctx.state.unansweredCount).toBe(1);

    ctx.state.lastProactiveAt = NOW - FOLLOWUP_INTERVAL_MS;
    ctx.state.lastProactiveScene = "morning";
    await ctx.service.evaluateCandidate({ ...candidate, sceneId: "rainy_day" });
    expect(ctx.state.unansweredCount).toBe(2);

    ctx.state.lastProactiveAt = NOW - FOLLOWUP_INTERVAL_MS;
    await ctx.service.evaluateCandidate({ ...candidate, sceneId: "sunny_day" });
    expect(ctx.commitMessage).toHaveBeenCalledTimes(2);
  });

  it("passes a stable intent timestamp to commit retries", async () => {
    const ctx = setup();
    await ctx.service.evaluateCandidate(candidate);
    expect(ctx.commitMessage).toHaveBeenCalledWith(expect.objectContaining({
      candidate,
      generationEpoch: 0,
      intentAt: NOW,
    }));
  });

  it("does not call the model when the selected delivery destination is unavailable", async () => {
    const ctx = setup({ canStartDelivery: () => false });
    await ctx.service.evaluateCandidate(candidate);
    expect(ctx.runModel).not.toHaveBeenCalled();
    expect(ctx.commitMessage).not.toHaveBeenCalled();
  });

  it("does not consume cooldown or unanswered count when delivery is cancelled", async () => {
    const log = vi.fn();
    const ctx = setup({
      commitMessage: vi.fn(async () => ({ kind: "cancelled" as const, reason: "channel_offline" })),
      log,
    });

    await ctx.service.evaluateCandidate(candidate);

    expect(ctx.state.lastProactiveAt).toBeNull();
    expect(ctx.state.unansweredCount).toBe(0);
    expect(log).toHaveBeenCalledWith("commit_cancelled", expect.objectContaining({
      reason: "channel_offline",
    }));
  });

  it("normal conversation lifecycle invalidates generation and starts quiet state", () => {
    const ctx = setup();
    ctx.service.normalConversationStarted();
    ctx.service.normalConversationEnded(NOW);
    expect(ctx.state.proactiveEpoch).toBe(2);
    expect(ctx.state.lastNormalConversationEndedAt).toBe(NOW);
  });

  it("does not overwrite newer user activity when delivery finishes later", async () => {
    const delivery = deferred<{ kind: "committed" }>();
    const deliveryStarted = deferred<void>();
    const ctx = setup({ commitMessage: vi.fn(() => {
      deliveryStarted.resolve();
      return delivery.promise;
    }) });
    const evaluation = ctx.service.evaluateCandidate(candidate);
    await deliveryStarted.promise;
    ctx.service.invalidateForUserMessage();
    delivery.resolve({ kind: "committed" });
    await evaluation;

    expect(ctx.state.proactiveEpoch).toBe(1);
    expect(ctx.state.unansweredCount).toBe(0);
    expect(ctx.state.lastProactiveAt).toBe(NOW);
  });
});
