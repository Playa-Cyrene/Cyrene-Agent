import { beforeEach, describe, expect, it, vi } from "vitest";

const { trace, preparePlanRunContext, buildHarnessPromptLayers, materializeHarnessStartTranscript, runStore } = vi.hoisted(() => ({
  trace: [] as string[],
  preparePlanRunContext: vi.fn(),
  buildHarnessPromptLayers: vi.fn(),
  materializeHarnessStartTranscript: vi.fn(),
  runStore: { create: vi.fn(), get: vi.fn() },
}));

vi.mock("./plan-lifecycle", () => ({ preparePlanRunContext }));
vi.mock("./prompt-builder", () => ({ buildHarnessPromptLayers, materializeHarnessStartTranscript }));
vi.mock("../run-store", () => ({ getHarnessRunStore: vi.fn(() => runStore) }));
vi.mock("../../tools/registry/tool-registry", () => ({
  toolRegistry: { getEnabledTools: vi.fn(() => []) },
}));
vi.mock("electron", () => ({ app: { getPath: vi.fn(() => "C:\\cyrene-preparation") } }));
vi.mock("../../../storage/persistent-execution-ledger", () => ({ createPersistentExecutionLedger: vi.fn() }));

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
  });

  it("materializes the startup transcript while creating metadata-only run state", async () => {
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
    expect(prepared.runMessages).toContainEqual({ role: "user", content: "materialized" });
    expect(runStore.create).toHaveBeenCalledWith({
      conversationId: "thread-1",
      runId: "run-preparation",
    });
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

  it.each([false, true, undefined])("filters interactive tools only for headless runs (interactive=%s)", async interactive => {
    const prepared = await prepareHarnessRun({
      runId: "quiz-filter", conversationId: "thread-1", conversationMode: "learn",
      settings: { provider: "test", baseUrl: "", model: "model", apiKey: "" },
      messages: [], toolSystemContent: "", soulSystemBaseContent: "persona",
      harnessInteractiveTools: interactive,
      capabilities: { tools: [{ id: "pop_quiz" }, { id: "learn_exam_publish" }, { id: "browser_control_start", browserControlPhase: "entry" },
        { id: "browser_click", browserControlPhase: "active" }, { id: "read_file" }] },
    } as never, new AbortController().signal);
    expect(prepared.tools.map(tool => tool.id)).toEqual(interactive !== false
      ? ["pop_quiz", "learn_exam_publish", "browser_control_start", "browser_click", "read_file"] : ["read_file"]);
  });
});
