/**
 * harness-adapter 的终态映射 + 子事件 runId stamp 单元测试。
 *
 * 覆盖：cancelled/error 不再被吞成 success；所有 AG-UI 事件附 canonical runId。
 *
 * 这两个被测函数都是纯函数，直接单测，不需要 mock harness / vendor。
 */

import { describe, expect, it } from "vitest";
import { buildHarnessPromptLayers, buildHarnessSystemPrompt, mapTerminateReasonToTerminal, materializeHarnessStartTranscript, sendHarnessEventAsAgui, sendTaskLifecycleAsAgui } from "./harness-adapter";
import type { HarnessEvent } from "./harness/types";
import type { BaseEvent } from "@ag-ui/core";

describe("Harness Todo working notebook policy", () => {
  it("does not duplicate environment or CITA already owned by build options", () => {
    const prompt = buildHarnessSystemPrompt({
      soulSystemBaseContent: "[ENV]", toolSystemContent: "[CITA_CONTEXT]",
      runtimeEnvironmentContext: "[ENV]", citaContextBlock: "[CITA_CONTEXT]",
    } as never);
    expect(prompt.split("[ENV]").length - 1).toBe(1);
    expect(prompt.split("[CITA_CONTEXT]").length - 1).toBe(1);
  });
  it("places the soft Todo policy in every Harness system prompt", () => {
    const prompt = buildHarnessSystemPrompt({
      soulSystemBaseContent: "persona",
      toolSystemContent: "tools",
    } as never);

    expect(prompt).toContain("[TODO_WORKING_NOTEBOOK_POLICY]");
    expect(prompt).toContain("至少 2 个 execution step");
    expect(prompt).toContain("不得作为后续行动的强约束");
  });

  it("injects the shared tool usage policy (tool_usage.md) for tool modes but not chat", () => {
    const base = {
      soulSystemBaseContent: "persona",
      toolSystemContent: "tools",
    };
    const workPrompt = buildHarnessSystemPrompt({ ...base, conversationMode: "work" } as never);
    const learnPrompt = buildHarnessSystemPrompt({ ...base, conversationMode: "learn" } as never);
    const chatPrompt = buildHarnessSystemPrompt({ ...base, conversationMode: "chat" } as never);

    // 工具使用：主动调用规则（修复"不催就不调工具"）
    expect(workPrompt).toContain("## 工具使用");
    expect(workPrompt).toContain("主动调用");
    // Skill 使用规范
    expect(workPrompt).toContain("invoke_skill");
    // Task 委托规范
    expect(workPrompt).toContain("多个互不依赖的调查或执行方向");
    // learn 同样注入统一规范（Task 一节按工具可用性自行生效）
    expect(learnPrompt).toContain("## 工具使用");
    // chat 模式没有工具能力，不注入
    expect(chatPrompt).not.toContain("## 工具使用");
  });

  it("assembles the same persona prompt for Work and Code", () => {
    const common = {
      soulSystemBaseContent: "完整人设",
      toolSystemContent: "共享工具规则",
      environmentContext: "共享环境",
    };
    const workPrompt = buildHarnessSystemPrompt({ ...common, conversationMode: "work" } as never);
    const codePrompt = buildHarnessSystemPrompt({ ...common, conversationMode: "code" } as never);

    expect(codePrompt).toBe(workPrompt);
    expect(codePrompt).toContain("完整人设");
  });
});

describe("Harness recovery context", () => {
  it("keeps recovery and response context outside the stable system prefix", () => {
    const layers = buildHarnessPromptLayers({
      soulSystemBaseContent: "persona",
      toolSystemContent: "tools",
      recoveryContext: "上次停在检查取消链路",
      responseContext: "本轮引用资料",
    } as never);

    expect(layers.stablePrefix).not.toContain("RECOVERY_CONTEXT");
    expect(layers.stablePrefix).not.toContain("RESPONSE_CONTEXT");
    expect(layers.runtimeContext).toContain("上次停在检查取消链路");
    expect(layers.runtimeContext).toContain("本轮引用资料");
  });

  it("injects interrupted Todo context as read-only evidence", () => {
    const prompt = buildHarnessSystemPrompt({
      soulSystemBaseContent: "persona",
      toolSystemContent: "tools",
      recoveryContext: "上次停在检查取消链路",
    } as never);

    expect(prompt).toContain("[RECOVERY_CONTEXT]");
    expect(prompt).toContain("上次停在检查取消链路");
  });
});

describe("mapTerminateReasonToTerminal", () => {
  it("maps undefined → success with externalEffectsMayContinue=false", () => {
    expect(mapTerminateReasonToTerminal(undefined)).toStrictEqual({
      status: "success",
      externalEffectsMayContinue: false,
    });
  });

  // P1 修订：success + uncertainEffects 必须报告 true，不能谎报 false。
  it("maps undefined + hasUncertainEffects=true → success with externalEffectsMayContinue=true (P1)", () => {
    expect(mapTerminateReasonToTerminal(undefined, true)).toStrictEqual({
      status: "success",
      externalEffectsMayContinue: true,
    });
  });

  it("maps undefined + hasUncertainEffects=false → success with externalEffectsMayContinue=false (P1)", () => {
    expect(mapTerminateReasonToTerminal(undefined, false)).toStrictEqual({
      status: "success",
      externalEffectsMayContinue: false,
    });
  });

  //  hasUncertainEffects 不影响 cancelled / timeout / runtime_error（恒为 true）。
  it("ignores hasUncertainEffects for cancelled/timeout/runtime_error (P1)", () => {
    expect(mapTerminateReasonToTerminal("cancelled", false)).toStrictEqual({
      status: "cancelled",
      reason: "user_cancelled",
      externalEffectsMayContinue: true,
    });
    expect(mapTerminateReasonToTerminal("timeout", false)).toStrictEqual({
      status: "timeout",
      reason: "timeout",
      externalEffectsMayContinue: true,
    });
    expect(mapTerminateReasonToTerminal("error", false)).toStrictEqual({
      status: "runtime_error",
      reason: "E_HARNESS_FAILURE",
      externalEffectsMayContinue: true,
    });
  });

  it("maps max_rounds → timeout with externalEffectsMayContinue=true", () => {
    expect(mapTerminateReasonToTerminal("max_rounds")).toStrictEqual({
      status: "timeout",
      reason: "max_rounds",
      externalEffectsMayContinue: true,
    });
  });

  it("maps timeout → timeout with externalEffectsMayContinue=true", () => {
    expect(mapTerminateReasonToTerminal("timeout")).toStrictEqual({
      status: "timeout",
      reason: "timeout",
      externalEffectsMayContinue: true,
    });
  });

  // 核心不变量：cancelled 不再被 default 吞成 success
  it("maps cancelled → cancelled (NOT success) with externalEffectsMayContinue=true", () => {
    const terminal = mapTerminateReasonToTerminal("cancelled");
    expect(terminal.status).toBe("cancelled");
    expect(terminal.reason).toBe("user_cancelled");
    expect(terminal.externalEffectsMayContinue).toBe(true);
  });

  // 核心不变量：error 不再被 default 吞成 success，而是 runtime_error
  it("maps error → runtime_error (NOT success) with externalEffectsMayContinue=true", () => {
    const terminal = mapTerminateReasonToTerminal("error");
    expect(terminal.status).toBe("runtime_error");
    expect(terminal.reason).toBe("E_HARNESS_FAILURE");
    expect(terminal.externalEffectsMayContinue).toBe(true);
  });

  it("never returns a terminal missing externalEffectsMayContinue", () => {
    for (const reason of [undefined, "max_rounds", "timeout", "cancelled", "error"] as const) {
      const terminal = mapTerminateReasonToTerminal(reason);
      expect(typeof terminal.externalEffectsMayContinue).toBe("boolean");
    }
  });
});

describe("sendHarnessEventAsAgui runId stamping", () => {
  const runId = "run-canonical-abc";
  const messageId = "msg-1";
  const threadId = "thread-1";

  function captureEvents(harnessEvent: HarnessEvent): BaseEvent[] {
    const sent: BaseEvent[] = [];
    sendHarnessEventAsAgui(harnessEvent, messageId, threadId, runId, (e) => sent.push(e));
    return sent;
  }

  it("routes progress_text to the process area instead of the formal answer bubble", () => {
    const events = captureEvents({ type: "progress_text", content: "正在处理" });

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: "CUSTOM",
      name: "cyrene.process_text",
      value: { content: "正在处理" },
      runId,
    });
  });

  it("maps explicit model round boundaries to one ordered custom event stream", () => {
    expect(captureEvents({ type: "round_start", roundId: "round-3" })[0]).toMatchObject({
      type: "CUSTOM",
      name: "cyrene.round",
      value: { action: "start", roundId: "round-3" },
      runId,
    });
    expect(captureEvents({ type: "round_end", roundId: "round-3" })[0]).toMatchObject({
      type: "CUSTOM",
      name: "cyrene.round",
      value: { action: "end", roundId: "round-3" },
      runId,
    });
  });

  it("maps public model reasoning to AG-UI reasoning events", () => {
    const start = captureEvents({ type: "reasoning_start", messageId: "reason-1" });
    const delta = captureEvents({ type: "reasoning_delta", messageId: "reason-1", delta: "先检查" });
    const end = captureEvents({ type: "reasoning_end", messageId: "reason-1" });

    expect(start[0]).toMatchObject({ type: "REASONING_MESSAGE_START", messageId: "reason-1", runId });
    expect(delta[0]).toMatchObject({ type: "REASONING_MESSAGE_CONTENT", messageId: "reason-1", delta: "先检查", runId });
    expect(end[0]).toMatchObject({ type: "REASONING_MESSAGE_END", messageId: "reason-1", runId });
  });

  it("stamps runId on TOOL_CALL events (tool_start / tool_end)", () => {
    const startEvents = captureEvents({
      type: "tool_start",
      toolCallId: "tc-1",
      toolName: "apply_patch",
      args: { path: "src/main.ts" },
    });
    const endEvents = captureEvents({
      type: "tool_end",
      toolCallId: "tc-1",
      outcome: "success",
      preview: "done",
    });

    // 至少一个工具事件必须带 canonical runId
    const toolStart = startEvents[0] as BaseEvent & { runId?: string; toolCallId?: string };
    expect(toolStart).toBeDefined();
    expect(toolStart.runId).toBe(runId);
    expect(toolStart.toolCallId).toBe("tc-1");

    expect(startEvents[1]).toMatchObject({
      type: "TOOL_CALL_ARGS",
      toolCallId: "tc-1",
      delta: JSON.stringify({ path: "src/main.ts" }),
      runId,
    });

    const toolEnd = endEvents[0] as BaseEvent & { runId?: string; toolCallId?: string };
    expect(toolEnd.runId).toBe(runId);
    expect(toolEnd.toolCallId).toBe("tc-1");
  });

  it("emits a terminal TOOL_CALL_RESULT before TOOL_CALL_END", () => {
    const events = captureEvents({
      type: "tool_end",
      toolCallId: "tc-result",
      outcome: "success",
      preview: "saved file",
    }) as Array<BaseEvent & {
      type?: string;
      toolCallId?: string;
      content?: string;
      status?: string;
      runId?: string;
    }>;

    expect(events.map((event) => event.type)).toEqual(["TOOL_CALL_RESULT", "TOOL_CALL_END"]);
    expect(events[0]).toMatchObject({
      toolCallId: "tc-result",
      content: "saved file",
      status: "success",
      runId,
    });
  });

  it("forwards structured file changes on TOOL_CALL_RESULT independent of preview truncation", () => {
    const changes = [{
      file: "src/main/orchestrator/life-tools.ts",
      kind: "modified" as const,
      insertions: 3,
      deletions: 1,
      diff: [{ type: "add" as const, text: "const b = 20;" }],
    }];
    const events = captureEvents({
      type: "tool_end",
      toolCallId: "tc-changes",
      outcome: "success",
      preview: '{"tool":"str_replace","filePath":"E:\\very\\long\\path…', // 200 字符截断后的 preview
      changes,
    }) as Array<BaseEvent & { changes?: unknown }>;

    expect(events[0]).toMatchObject({ type: "TOOL_CALL_RESULT", toolCallId: "tc-changes" });
    expect((events[0] as { changes?: unknown }).changes).toEqual(changes);
  });

  it("marks every non-success harness outcome as a failed tool result", () => {
    for (const outcome of ["failure", "unknown", "not_executed"] as const) {
      const [result] = captureEvents({
        type: "tool_end",
        toolCallId: `tc-${outcome}`,
        outcome,
        preview: outcome,
      }) as Array<BaseEvent & { status?: string }>;
      expect(result.status).toBe("failed");
    }
  });

  it("stamps runId on CUSTOM todo events", () => {
    const events = captureEvents({
      type: "todo_update",
      items: [{ id: "t1", content: "task", status: "pending" }],
    });

    expect(events).toHaveLength(1);
    const custom = events[0] as BaseEvent & { runId?: string; name?: string };
    expect(custom.runId).toBe(runId);
    expect(custom.name).toBe("cyrene.todo");
  });

  it.each(["preCompaction", "preRequest", "terminal"] as const)("routes %s context usage snapshots to the renderer", (phase) => {
    const snapshot = {
      phase,
      contextWindowTokens: 128_000,
      totalTokens: 1200,
      categories: [{ key: "systemPrompt" as const, tokens: 1200 }],
      messageCount: 2,
      updatedAt: 1_700_000_000_000,
    };
    const events = captureEvents({ type: "context_usage", snapshot });

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: "CUSTOM",
      name: "cyrene.context.usage",
      value: snapshot,
      runId,
      threadId,
    });
  });

  it("stamps runId on final_answer TEXT_MESSAGE events", () => {
    const events = captureEvents({ type: "final_answer", content: "最终回复" });

    expect(events).toHaveLength(3);
    for (const event of events) {
      expect((event as { runId?: string }).runId).toBe(runId);
    }
  });
});

describe("buildHarnessPromptLayers usageParts", () => {
  it("splits persona and tool layers without breaking stablePrefix composition", () => {
    const layers = buildHarnessPromptLayers({
      soulSystemBaseContent: "完整人设",
      toolSystemContent: "工具规则与目录",
      conversationMode: "work",
    } as never);

    expect(layers.usageParts?.personaContent).toContain("完整人设");
    expect(layers.usageParts?.personaContent).toContain("[TODO_WORKING_NOTEBOOK_POLICY]");
    expect(layers.usageParts?.personaContent).not.toContain("工具规则与目录");
    expect(layers.usageParts?.toolLayerContent).toContain("工具规则与目录");
    // tool_usage.md 归入工具层，不进人设层
    expect(layers.usageParts?.toolLayerContent).toContain("## 工具使用");
    expect(layers.usageParts?.personaContent).not.toContain("## 工具使用");
    // stablePrefix 仍是两桶原序拼接，与拆分前一致
    expect(layers.stablePrefix).toBe([
      layers.usageParts?.personaContent,
      layers.usageParts?.toolLayerContent,
    ].filter(Boolean).join("\n\n---\n\n"));
  });

  it("keeps the tool layer empty for chat mode", () => {
    const layers = buildHarnessPromptLayers({
      soulSystemBaseContent: "完整人设",
      toolSystemContent: "",
      conversationMode: "chat",
    } as never);

    expect(layers.usageParts?.toolLayerContent).toBe("");
    expect(layers.stablePrefix).toBe(layers.usageParts?.personaContent);
  });

  it("chat keeps full soul persona without the harness compact persona; work/code keep both", () => {
    const base = {
      soulSystemBaseContent: "完整人设",
      toolSystemContent: "工具规则",
    };
    const chatLayers = buildHarnessPromptLayers({ ...base, conversationMode: "chat" } as never);
    const workLayers = buildHarnessPromptLayers({ ...base, conversationMode: "work" }as never);

    // chat：完整 soul 人在，不叠加 harness 精简人设（与 soul.md 逐字重复）
    expect(chatLayers.stablePrefix).toContain("完整人设");
    expect(chatLayers.stablePrefix).not.toContain("Execution Persona");
    // work：mode 文件无 soul.md，仍靠 harness 精简人设补位
    expect(workLayers.stablePrefix).toContain("完整人设");
    expect(workLayers.stablePrefix).toContain("Execution Persona");
  });
});

describe("Task delegation lifecycle projection", () => {
  it("sends only the sanitized presentation fields to the parent run", () => {
    const sent: BaseEvent[] = [];
    sendTaskLifecycleAsAgui({
      invocationId: "child-run-1", taskId: "task-1", description: "检查取消链路",
      nickname: "风堇", assetFileName: "风堇.png", status: "running",
    }, "thread-1", "run-1", (event) => sent.push(event));

    expect(sent).toEqual([expect.objectContaining({
      type: "CUSTOM", name: "cyrene.task", threadId: "thread-1", runId: "run-1",
      value: { invocationId: "child-run-1", taskId: "task-1", description: "检查取消链路", nickname: "风堇", assetFileName: "风堇.png", status: "running" },
    })]);
    expect(JSON.stringify(sent)).not.toContain("prompt");
  });

  it("materializes runtime context before the run store is created", () => {
    const messages = materializeHarnessStartTranscript({
      messages: [{ role: "user", content: "继续任务" }],
      runId: "run-1",
      runtimeContext: "[RECOVERY_CONTEXT]\n上次停在测试失败",
      initialState: {
        todoItems: [{ id: "test", content: "修复测试", status: "in_progress" }],
        uncertainEffects: [],
      },
      kind: "recovery",
    });

    expect(messages).toHaveLength(2);
    expect(messages[1]).toMatchObject({
      role: "user",
      visibility: "internal",
      internal: { kind: "recovery", runId: "run-1" },
    });
    expect(messages[1]?.content).toContain("上次停在测试失败");
    expect(messages[1]?.content).toContain("修复测试");
  });
});
