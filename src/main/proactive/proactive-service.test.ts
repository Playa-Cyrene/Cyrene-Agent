import { describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createDefaultProactiveState, FOLLOWUP_INTERVAL_MS } from "./proactive-policy";
import { createProactiveChatService } from "./proactive-service";
import type { ProactiveCandidate, ProactiveRuntimeSnapshot } from "./proactive-types";
import { ConversationJournalService } from "../orchestrator/conversation-journal-service";
import { ConversationTranscriptStore } from "../orchestrator/conversation-transcript-store";

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
  const saveState = vi.fn((next: typeof state) => {
    for (const key of Object.keys(state) as Array<keyof typeof state>) {
      if (!(key in next)) delete state[key];
    }
    Object.assign(state, next);
  });
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

  it("persists one intent before delivery and replays its first payload after a refresh failure", async () => {
    let first = true;
    const commitMessage = vi.fn(async (input: { text: string; intentAt?: number; generationEpoch: number }) => {
      if (first) {
        first = false;
        throw new Error("snapshot refresh failed");
      }
      return { kind: "committed" as const, input };
    });
    const ctx = setup({ commitMessage });
    await expect(ctx.service.evaluateCandidate(candidate)).rejects.toThrow("snapshot refresh failed");
    expect(ctx.state.pendingCommitIntent).toMatchObject({
      intentId: "proactive-intent-1",
      sequence: 1,
      candidate,
      generationEpoch: 0,
      intentAt: NOW,
      text: "休息一下吧♪",
      source: "model",
    });

    ctx.setSnapshot({ now: NOW + 123_456 });
    await ctx.service.evaluateCandidate({ ...candidate, score: 1 });
    expect(ctx.runModel).toHaveBeenCalledOnce();
    expect(commitMessage).toHaveBeenCalledTimes(2);
    expect(commitMessage.mock.calls[1][0]).toMatchObject({
      candidate,
      text: "休息一下吧♪",
      generationEpoch: 0,
      intentAt: NOW,
    });
    expect(ctx.state.pendingCommitIntent).toBeUndefined();
    expect(ctx.state.proactiveCommitSequence).toBe(1);
  });

  it("fails closed when the pending intent save does not persist", async () => {
    const saveState = vi.fn();
    const ctx = setup({ saveState });

    await expect(ctx.service.evaluateCandidate(candidate)).rejects.toThrow("PROACTIVE_PENDING_INTENT_NOT_PERSISTED");
    expect(ctx.commitMessage).not.toHaveBeenCalled();
    expect(ctx.state.pendingCommitIntent).toBeUndefined();
    expect(ctx.state.proactiveCommitSequence).toBeUndefined();
  });

  it("keeps legacy external delivery outside the local durable-intent protocol", async () => {
    const ctx = setup({ requiresDurableIntent: () => false });

    await ctx.service.evaluateCandidate(candidate);

    expect(ctx.commitMessage).toHaveBeenCalledWith(expect.objectContaining({ candidate, text: "休息一下吧♪" }));
    expect(ctx.commitMessage.mock.calls[0][0].intentId).toBeUndefined();
    expect(ctx.state.pendingCommitIntent).toBeUndefined();
    expect(ctx.state.proactiveCommitSequence).toBeUndefined();
  });

  it("freezes a local target before model completion", async () => {
    let target: "local" | "wechat" = "local";
    const commitMessage = vi.fn(async () => ({ kind: "committed" as const }));
    const ctx = setup({
      commitMessage,
      getDeliveryTarget: () => target,
      runModel: vi.fn(async () => {
        target = "wechat";
        return { kind: "send" as const, text: "固定本地消息" };
      }),
    });

    await ctx.service.evaluateCandidate(candidate);

    expect(commitMessage).toHaveBeenCalledWith(expect.objectContaining({ deliveryTarget: "local", intentId: "proactive-intent-1" }));
    expect(ctx.state.pendingCommitIntent).toBeUndefined();
  });

  it("does not consume a local pending intent while target is external, then replays it when local returns", async () => {
    let target: "local" | "wechat" = "local";
    let first = true;
    const commitMessage = vi.fn(async () => {
      if (first) {
        first = false;
        throw new Error("local journal unavailable");
      }
      return { kind: "committed" as const };
    });
    const ctx = setup({ commitMessage, getDeliveryTarget: () => target });

    await expect(ctx.service.evaluateCandidate(candidate)).rejects.toThrow("local journal unavailable");
    const pendingId = ctx.state.pendingCommitIntent?.intentId;
    target = "wechat";
    await ctx.service.evaluateCandidate({ ...candidate, score: 90 });
    expect(commitMessage.mock.calls[1][0]).toMatchObject({ deliveryTarget: "wechat" });
    expect(commitMessage.mock.calls[1][0].intentId).toBeUndefined();
    expect(ctx.state.pendingCommitIntent?.intentId).toBe(pendingId);

    target = "local";
    await ctx.service.evaluateCandidate(candidate);
    expect(commitMessage.mock.calls.at(-1)?.[0]).toMatchObject({ deliveryTarget: "local", intentId: pendingId });
    expect(ctx.state.pendingCommitIntent).toBeUndefined();
  });

  it("allocates a fresh intent identity for a later same-scene trigger", async () => {
    const ctx = setup();
    await ctx.service.evaluateCandidate(candidate);
    ctx.state.unansweredCount = 0;
    ctx.state.lastProactiveAt = NOW - 8 * 60 * 60 * 1000;
    ctx.state.lastFiredAt[candidate.sceneId] = NOW - 8 * 60 * 60 * 1000;
    await ctx.service.evaluateCandidate(candidate);
    expect(ctx.commitMessage).toHaveBeenCalledTimes(2);
    expect(ctx.state.proactiveCommitSequence).toBe(2);
    expect(ctx.state.pendingCommitIntent).toBeUndefined();
    expect(ctx.commitMessage.mock.calls.map((call) => (call[0] as { intentAt?: number }).intentAt)).toEqual([NOW, NOW]);
  });

  it("retries one real canonical assistant and presentation after refresh failure", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "cta-proactive-journal-"));
    try {
      const store = new ConversationTranscriptStore(root, { now: () => 1_000 });
      const journal = new ConversationJournalService(store);
      const state = createDefaultProactiveState();
      let now = NOW;
      let generatedText = "首次文本";
      const refresh = vi.spyOn(journal as unknown as { refreshProjection: (id: string) => Promise<unknown> }, "refreshProjection");
      refresh.mockRejectedValueOnce(new Error("refresh failed"));
      const service = createProactiveChatService({
        loadState: () => state,
        saveState: (next) => {
          for (const key of Object.keys(state) as Array<keyof typeof state>) {
            if (!(key in next)) delete state[key];
          }
          Object.assign(state, next);
        },
        getSnapshot: () => ({ now, localHour: 14, idleSec: 0, enabled: true, conversationBusy: false, generationBusy: false, screenLocked: false }),
        buildMessages: async () => [],
        runModel: async () => ({ kind: "send" as const, text: generatedText }),
        getFallback: async () => null,
        commitMessage: async (input) => {
          const sink = journal.createRunSink({ conversationId: "proactive-session", runId: input.intentId });
          const assistantId = await sink.appendAssistant({ message: { role: "assistant", content: input.text }, roundId: "proactive" });
          await journal.appendPresentationNext("proactive-session", assistantId, `${input.intentId}:presentation`, {
            content: input.text,
            runSnapshot: { runId: input.intentId, status: "terminal", updatedAt: input.intentAt ?? 0 },
          });
          await sink.checkpoint();
          return { kind: "committed" as const };
        },
      });

      await expect(service.evaluateCandidate(candidate)).rejects.toThrow("refresh failed");
      expect(state.pendingCommitIntent?.intentId).toBe("proactive-intent-1");
      generatedText = "第二次模型文本";
      now += 999_999;
      await service.evaluateCandidate({ ...candidate, score: 1 });
      const snapshot = await store.read("proactive-session");
      expect(snapshot.entries.filter((entry) => entry.kind === "assistant")).toHaveLength(1);
      expect(snapshot.entries.filter((entry) => entry.kind === "presentation_patch")).toHaveLength(1);
      expect((await journal.readProjection("proactive-session")).messages[0]).toMatchObject({ content: "首次文本" });
      expect(state.pendingCommitIntent).toBeUndefined();
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
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
