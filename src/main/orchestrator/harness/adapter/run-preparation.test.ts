import { beforeEach, describe, expect, it, vi } from "vitest";

const { trace, preparePlanRunContext, buildHarnessPromptLayers, materializeHarnessStartTranscript, runStore, prepareHarnessRecoveryState } = vi.hoisted(() => ({
  trace: [] as string[],
  preparePlanRunContext: vi.fn(),
  buildHarnessPromptLayers: vi.fn(),
  materializeHarnessStartTranscript: vi.fn(),
  runStore: { create: vi.fn(), get: vi.fn() },
  prepareHarnessRecoveryState: vi.fn(),
}));

vi.mock("./plan-lifecycle", () => ({ preparePlanRunContext }));
vi.mock("./prompt-builder", () => ({ buildHarnessPromptLayers, materializeHarnessStartTranscript }));
vi.mock("../run-store", () => ({ getHarnessRunStore: vi.fn(() => runStore) }));
vi.mock("../run-recovery", () => ({ prepareHarnessRecoveryState }));
vi.mock("../../tools/registry/tool-registry", () => ({
  toolRegistry: { getEnabledTools: vi.fn(() => []) },
}));
vi.mock("electron", () => ({ app: { getPath: vi.fn(() => "C:\\cyrene-preparation") } }));

import { prepareHarnessRun } from "./run-preparation";

describe("harness run preparation", () => {
  beforeEach(() => {
    trace.length = 0;
    preparePlanRunContext.mockReset();
    preparePlanRunContext.mockResolvedValue({ planState: undefined });
    buildHarnessPromptLayers.mockReset();
    buildHarnessPromptLayers.mockReturnValue({
      stablePrefix: "stable",
      runtimeContext: "runtime",
      mode: "work",
    });
    materializeHarnessStartTranscript.mockReset();
    materializeHarnessStartTranscript.mockImplementation((input) => {
      trace.push("materialize");
      return [...input.messages, { role: "user", content: "materialized" }];
    });
    runStore.create.mockReset();
    runStore.create.mockImplementation(() => trace.push("create"));
    runStore.get.mockReset();
    prepareHarnessRecoveryState.mockReset();
  });

  it("materializes the startup transcript before creating the run store", async () => {
    const prepared = await prepareHarnessRun({
      runId: "run-preparation",
      conversationId: "thread-1",
      conversationMode: "work",
      settings: { provider: "test", baseUrl: "", model: "model", apiKey: "" },
      messages: [{ role: "user", content: "开始" }],
      toolSystemContent: "",
      soulSystemBaseContent: "persona",
    } as never, new AbortController().signal);

    expect(trace).toEqual(["materialize", "create"]);
    expect(prepared.runId).toBe("run-preparation");
    expect(prepared.systemPrompt).toBe("stable");
    expect(runStore.create).toHaveBeenCalledWith(expect.objectContaining({
      conversationId: "thread-1",
      runId: "run-preparation",
      messages: expect.arrayContaining([{ role: "user", content: "materialized" }]),
    }));
  });

  it("always uses journal messages as the recovery base and restores only execution state", async () => {
    const authoritativeMessages = [{ role: "user", content: "authoritative" }];
    runStore.get.mockReturnValue({
      status: "interrupted",
      conversationId: "thread-1",
      runId: "run-old",
      request: { provider: "test", model: "model", contextWindowTokens: 256000, promptFingerprint: "p", toolSchemaFingerprint: "t" },
    });
    prepareHarnessRecoveryState.mockReturnValue({
      state: { todoItems: [{ id: "todo", content: "继续", status: "in_progress" }], uncertainEffects: [] },
      cacheState: { cacheEpoch: 4, epochReason: "recovery" },
      recoveryContext: "继续执行",
      uncertainEffects: [],
    });

    const prepared = await prepareHarnessRun({
      runId: "run-new",
      conversationId: "thread-1",
      conversationMode: "work",
      resumeFromRunId: "run-old",
      settings: { provider: "test", baseUrl: "", model: "model", apiKey: "" },
      messages: authoritativeMessages,
      toolSystemContent: "",
      soulSystemBaseContent: "persona",
    } as never, new AbortController().signal);

    expect(prepareHarnessRecoveryState).toHaveBeenCalled();
    expect(materializeHarnessStartTranscript).toHaveBeenCalledWith(expect.objectContaining({
      messages: authoritativeMessages,
      initialState: expect.objectContaining({ todoItems: expect.any(Array) }),
      kind: "recovery",
    }));
    expect(prepared.runMessages).toEqual(expect.arrayContaining(authoritativeMessages));
    expect(prepared.runMessages).not.toEqual(expect.arrayContaining([{ role: "user", content: "stale" }]));
    expect(runStore.create).toHaveBeenCalledWith(expect.objectContaining({
      messages: expect.arrayContaining(authoritativeMessages),
      state: expect.objectContaining({ todoItems: expect.any(Array) }),
      cache: { cacheEpoch: 4, epochReason: "recovery" },
    }));
  });

  it("does not inspect interrupted runs for an ordinary new turn", async () => {
    await prepareHarnessRun({
      runId: "run-new",
      conversationId: "thread-1",
      conversationMode: "work",
      settings: { provider: "test", baseUrl: "", model: "model", apiKey: "" },
      messages: [{ role: "user", content: "new turn" }],
      toolSystemContent: "",
      soulSystemBaseContent: "persona",
    } as never, new AbortController().signal);

    expect(runStore.get).not.toHaveBeenCalled();
  });
});
