import { describe, expect, it, vi } from "vitest";
import type { PluginTool } from "../plugins/api";
import { createPluginAgentRunner } from "./plugin-agent";

function goalTool(patch: Partial<PluginTool> = {}): PluginTool {
  return {
    id: "minecraft-bot_goto",
    name: "前往坐标",
    description: "移动到指定坐标并等待结束",
    enabled: true,
    risk: "input-control",
    inputSchema: {
      type: "object",
      properties: { x: { type: "number" }, y: { type: "number" }, z: { type: "number" } },
      required: ["x", "y", "z"],
    },
    needsContext: true,
    ledgerPolicy: "success_terminal",
    effectKind: "mutation",
    verificationPolicy: "none",
    execute: async () => "已到达",
    ...patch,
  };
}

function builtOptions() {
  return {
    options: {
      settings: {
        provider: "test",
        baseUrl: "https://example.test",
        model: "test-model",
        apiKey: "test-key",
        contextWindowTokens: 128_000,
      },
      messages: [{ role: "user", content: "收集十个木头" }],
      soulSystemBaseContent: "SOUL",
      soulRuntimeContext: "WORLD SNAPSHOT",
      toolSystemContent: "GLOBAL TOOL CATALOG",
      skillLayerContent: "SKILLS",
    },
    latestUserText: "收集十个木头",
  };
}

describe("plugin-agent", () => {
  it("拒绝缺少显式 effectKind 的目标工具", async () => {
    const runHarness = vi.fn();
    const runGoal = createPluginAgentRunner({
      pluginId: "minecraft-bot",
      pluginSignal: new AbortController().signal,
      userDataPath: "E:\\test-user-data",
      agentRuntime: { buildOptions: vi.fn(async () => builtOptions()) } as never,
      runHarness: runHarness as never,
    });

    await expect(runGoal({
      runId: "minecraft-goal-1",
      goal: "收集十个木头",
      tools: [goalTool({ effectKind: undefined })],
    })).rejects.toThrow(/effectKind/);
    expect(runHarness).not.toHaveBeenCalled();
  });

  it("以冻结工具集装配无头 Harness，并返回显式终态", async () => {
    const buildOptions = vi.fn(async () => builtOptions());
    const runHarness = vi.fn(async () => ({
      finalAnswer: "木头已收集。",
      finalState: { todoItems: [], uncertainEffects: [] },
      terminated: false,
      rounds: 1,
    }));
    const events: unknown[] = [];
    const runGoal = createPluginAgentRunner({
      pluginId: "minecraft-bot",
      pluginSignal: new AbortController().signal,
      userDataPath: "E:\\test-user-data",
      agentRuntime: { buildOptions } as never,
      runHarness: runHarness as never,
    });

    const result = await runGoal({
      runId: "minecraft-goal-2",
      goal: "收集十个木头",
      tools: [goalTool()],
      maxRounds: 3,
      maxWallMs: 60_000,
      onEvent: (event) => events.push(event),
    });

    expect(buildOptions).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: "plugin:minecraft-bot",
      executionMode: "work",
      mode: "work",
      promptSource: "plugin-agent",
      promptChannel: "minecraft",
      currentUser: expect.objectContaining({ text: "收集十个木头", visibleContent: "收集十个木头" }),
    }));
    const input = runHarness.mock.calls[0]?.[0];
    expect(input).toEqual(expect.objectContaining({
      runId: "minecraft-goal-2",
      tools: [expect.objectContaining({
        id: "minecraft-bot_goto",
        effectKind: "mutation",
        risk: "input-control",
        ledgerPolicy: "success_terminal",
        needsContext: true,
      })],
      config: expect.objectContaining({
        maxRounds: 3,
        maxParallelToolCalls: 1,
        totalTimeoutMs: 60_000,
      }),
      includeInteractiveTools: false,
      planState: undefined,
      taskExecutor: undefined,
      toolContext: expect.objectContaining({
        userQuery: "收集十个木头",
        conversationId: "plugin:minecraft-bot",
        runId: "minecraft-goal-2",
        mode: "work",
        permissionMode: "allow_all",
      }),
    }));
    expect(input.promptLayers.stablePrefix).toContain("minecraft-bot_goto");
    expect(input.promptLayers.stablePrefix).not.toContain("GLOBAL TOOL CATALOG");
    expect(input.promptLayers.runtimeContext).toContain("WORLD SNAPSHOT");
    expect(events).toEqual([]);
    expect(result).toEqual({
      text: "木头已收集。",
      terminal: { status: "success", externalEffectsMayContinue: false },
      rounds: 1,
    });
  });

  it("硬截止先触发时覆盖 Harness 的 cancelled 终态", async () => {
    const deadline = AbortSignal.abort();
    const runHarness = vi.fn(async () => ({
      finalAnswer: "",
      finalState: { todoItems: [], uncertainEffects: [] },
      terminated: true,
      terminateReason: "cancelled" as const,
      terminal: { status: "cancelled" as const, reason: "user_cancelled", externalEffectsMayContinue: true },
      rounds: 1,
    }));
    const runGoal = createPluginAgentRunner({
      pluginId: "minecraft-bot",
      pluginSignal: new AbortController().signal,
      userDataPath: "E:\\test-user-data",
      agentRuntime: { buildOptions: vi.fn(async () => builtOptions()) } as never,
      runHarness: runHarness as never,
      createDeadline: () => deadline,
    } as never);

    const result = await runGoal({
      runId: "minecraft-goal-3",
      goal: "收集十个木头",
      tools: [goalTool()],
      maxWallMs: 60_000,
    });

    expect(runHarness.mock.calls[0]?.[0].signal.aborted).toBe(true);
    expect(result.terminal).toEqual({
      status: "timeout",
      reason: "timeout",
      externalEffectsMayContinue: true,
    });
  });

  it("将 purpose 归一为贯穿无头运行与工具上下文的诊断标签", async () => {
    const runHarness = vi.fn(async () => ({
      finalAnswer: "木头已收集。",
      finalState: { todoItems: [], uncertainEffects: [] },
      terminated: false,
      rounds: 1,
    }));
    const log = vi.spyOn(console, "info").mockImplementation(() => undefined);
    const runGoal = createPluginAgentRunner({
      pluginId: "minecraft-bot",
      pluginSignal: new AbortController().signal,
      userDataPath: "E:\\test-user-data",
      agentRuntime: { buildOptions: vi.fn(async () => builtOptions()) } as never,
      runHarness: runHarness as never,
    });

    try {
      await runGoal({
        runId: "minecraft-goal-purpose",
        goal: "收集十个木头",
        tools: [goalTool()],
        purpose: "minecraft-goal",
      });

      expect(runHarness.mock.calls[0]?.[0].toolContext.metadata).toEqual({
        pluginAgentDiagnosticLabel: "plugin:minecraft-bot:minecraft-goal",
      });
      expect(log).toHaveBeenCalledWith(
        "[plugin-agent] 无头任务开始",
        expect.objectContaining({ label: "plugin:minecraft-bot:minecraft-goal" }),
      );
      expect(log).toHaveBeenCalledWith(
        "[plugin-agent] 无头任务结束",
        expect.objectContaining({ label: "plugin:minecraft-bot:minecraft-goal", status: "success" }),
      );
    } finally {
      log.mockRestore();
    }
  });
});
