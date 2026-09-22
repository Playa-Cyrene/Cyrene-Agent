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
      schemaVersion: 1,
      status: "interrupted",
      conversationId: "thread-1",
      runId: "run-old",
      messages: [{
        role: "assistant",
        content: "stale",
        toolCalls: [{ id: "mail-1", name: "send_email", arguments: JSON.stringify({ to: "a@example.com", body: "hello" }) }],
      }],
      state: { todoItems: [{ id: "todo", content: "继续", status: "in_progress" }], uncertainEffects: [] },
      toolOutputs: [],
      toolCalls: [{ toolCallId: "mail-1", toolName: "send_email", sideEffect: "non_idempotent_side_effect", status: "started", updatedAt: 2 }],
      rounds: 3,
      cache: { cacheEpoch: 3, epochReason: "compaction" },
      request: {
        provider: "old-provider",
        model: "old-model",
        contextWindowTokens: 256000,
        promptFingerprint: "old-prompt",
        toolSchemaFingerprint: "old-tools",
        enabledToolIds: ["send_email"],
      },
      createdAt: 1,
      updatedAt: 2,
    });

    const prepared = await prepareHarnessRun({
      runId: "run-new",
      conversationId: "thread-1",
      conversationMode: "work",
      resumeFromRunId: "run-old",
      settings: { provider: "test", baseUrl: "", model: "model", apiKey: "" },
      messages: authoritativeMessages,
      capabilities: { tools: [{
        id: "send_email",
        name: "Send email",
        description: "send",
        enabled: true,
        inputSchema: { type: "object", properties: {} },
        effectKind: "external_side_effect",
        execute: vi.fn(),
      }] },
      toolSystemContent: "",
      soulSystemBaseContent: "persona",
    } as never, new AbortController().signal);

    expect(materializeHarnessStartTranscript).toHaveBeenCalledWith(expect.objectContaining({
      messages: authoritativeMessages,
      initialState: expect.objectContaining({ todoItems: expect.any(Array) }),
      kind: "recovery",
    }));
    const persistedRun = runStore.create.mock.calls.at(-1)?.[0] as { messages?: Array<{ content?: unknown }> };
    const preparedContents = prepared.runMessages.map((message) => message.content);
    const persistedContents = (persistedRun.messages ?? []).map((message) => message.content);
    expect(prepared.runMessages).toEqual(expect.arrayContaining(authoritativeMessages));
    expect(preparedContents).toContain("authoritative");
    expect(preparedContents).not.toContain("stale");
    expect(persistedRun.messages).toEqual(expect.arrayContaining(authoritativeMessages));
    expect(persistedContents).toContain("authoritative");
    expect(persistedContents).not.toContain("stale");
    expect(runStore.create).toHaveBeenCalledWith(expect.objectContaining({
      messages: expect.arrayContaining(authoritativeMessages),
      state: expect.objectContaining({ todoItems: expect.any(Array) }),
      cache: { cacheEpoch: 4, epochReason: "recovery" },
    }));
    expect(prepared.recovered?.uncertainEffects[0]).toEqual(expect.objectContaining({
      toolCallId: "mail-1",
      fingerprint: "send_email(body=hello,to=a@example.com)",
    }));
    expect(prepared.recovered?.recoveryContext).toContain("提示词指纹已变化");
    expect(prepared.recovered?.recoveryContext).toContain("工具目录指纹已变化");
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
