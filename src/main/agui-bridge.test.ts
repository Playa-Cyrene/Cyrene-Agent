import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Observable } from "rxjs";
import { IPC } from "../shared/ipc-channels";

const mocks = vi.hoisted(() => ({
  handlers: new Map<string, (...args: any[]) => unknown>(),
  listeners: new Map<string, (...args: any[]) => void>(),
  getSession: vi.fn(),
  getSessionRecord: vi.fn(),
  getPendingDispatch: vi.fn(),
  composeSession: vi.fn(),
  getPendingMessages: vi.fn(),
  listPendingWithdrawals: vi.fn(() => []),
  markPendingAdjust: vi.fn(),
  resetPendingAdjustByRun: vi.fn(),
  runCyreneAgent: vi.fn(),
  requestUserClarification: vi.fn(),
  agentEvents: [] as unknown[],
  // 可定制的终态行为
  runFinishedResult: undefined as unknown,
  emitDuplicateRunFinished: false,
  errorAfterRunFinished: null as string | null,
  skipDefaultRunFinished: false,
  // 模拟正在运行的 Observable（不自动 complete）
  neverComplete: false,
  // 会话守卫/takeover 测试：abort 触发 RUN_FINISHED(cancelled) + complete，
  // 模拟真实 harness 的 cancelled 结算链路（AGUI_CANCEL / takeover 都走这条链）
  completeOnAbort: false,
  // 轨迹派发测试：主进程 app.getPath("userData") 的可替换根目录
  userDataRoot: "",
}));

vi.mock("electron", () => ({
  ipcMain: {
    handle: vi.fn((channel: string, handler: (...args: any[]) => unknown) => {
      mocks.handlers.set(channel, handler);
    }),
    on: vi.fn((channel: string, listener: (...args: any[]) => void) => {
      mocks.listeners.set(channel, listener);
    }),
    removeListener: vi.fn(),
  },
  // 插话 IPC 的成功路径会广播会话变更（遍历全部窗口）
  BrowserWindow: {
    getAllWindows: () => [],
  },
  app: { getPath: () => mocks.userDataRoot },
}));

vi.mock("./orchestrator/cyrene-agent", () => ({
  CyreneAgent: class {
    threadId: string;
    lastResult?: { reply: string; toolResults: unknown[] };

    constructor(input: { threadId: string }) {
      this.threadId = input.threadId;
    }

    runWithEvents(options: unknown) {
      mocks.runCyreneAgent(options);
      // 忠实模拟真实 CyreneAgent：读 options.runId 并 stamp 到 RUN_STARTED / RUN_FINISHED，
      // 保证 bridge 的 canonical runId 全链路一致（ack.runId === RUN_STARTED.runId === RUN_FINISHED.runId）。
      const runId = (options as { runId?: string } | null | undefined)?.runId;
      const signal = (options as { signal?: AbortSignal } | null | undefined)?.signal;
      return new Observable((subscriber) => {
        this.lastResult = { reply: "抱抱你", toolResults: [] };
        subscriber.next({ type: "RUN_STARTED", runId });
        for (const event of mocks.agentEvents) subscriber.next(event);
        if (!mocks.skipDefaultRunFinished) {
          const finishedEvent: { type: string; runId?: string; result?: unknown } = { type: "RUN_FINISHED", runId };
          if (mocks.runFinishedResult !== undefined) {
            finishedEvent.result = mocks.runFinishedResult;
          }
          subscriber.next(finishedEvent);
          if (mocks.emitDuplicateRunFinished) {
            subscriber.next({ type: "RUN_FINISHED", runId, result: mocks.runFinishedResult });
          }
          if (mocks.errorAfterRunFinished) {
            subscriber.error(new Error(mocks.errorAfterRunFinished));
            return;
          }
        }
        // 会话守卫/takeover 测试：abort 触发 cancelled 结算链路
        if (mocks.completeOnAbort && signal) {
          signal.addEventListener("abort", () => {
            subscriber.next({
              type: "RUN_FINISHED",
              runId,
              result: { status: "cancelled", reason: "user_cancelled", externalEffectsMayContinue: true },
            });
            subscriber.complete();
          });
        }
        // neverComplete 模拟正在运行的 Observable，不自动 complete
        if (!mocks.neverComplete) {
          subscriber.complete();
        }
      });
    }
  },
}));

vi.mock("./orchestrator/tools/history-tools", () => ({
  indexConversationTurn: vi.fn(),
}));

vi.mock("./chats/chats-store", () => ({
  getSession: mocks.getSession,
  getSessionRecord: mocks.getSessionRecord,
  getPendingDispatch: mocks.getPendingDispatch,
  composeSession: mocks.composeSession,
  getPendingMessages: mocks.getPendingMessages,
  listPendingWithdrawals: mocks.listPendingWithdrawals,
  markPendingAdjust: mocks.markPendingAdjust,
  resetPendingAdjustByRun: mocks.resetPendingAdjustByRun,
}));


vi.mock("./user-choice", () => ({
  requestUserClarification: mocks.requestUserClarification,
  cancelPendingChoicesForRun: vi.fn(),
}));

vi.mock("./permission", () => ({
  cancelPendingApprovalsForRun: vi.fn(),
  checkPermission: vi.fn(),
}));

describe("agui-bridge sticker event ordering", () => {
  // 每个测试前重置可定制的终态行为字段，
  // 避免上一个测试的副作用泄漏到下一个测试。
  beforeEach(() => {
    mocks.runFinishedResult = undefined;
    mocks.emitDuplicateRunFinished = false;
    mocks.errorAfterRunFinished = null;
    mocks.skipDefaultRunFinished = false;
    mocks.neverComplete = false;
    mocks.completeOnAbort = false;
    mocks.getSessionRecord.mockReset();
    mocks.getPendingDispatch.mockReset();
    mocks.composeSession.mockReset();
  });

  it("成功桌面对话把来源、模式和 canonical runId 交给收尾回调", async () => {
    vi.resetModules();
    mocks.handlers.clear();
    mocks.getSession.mockReturnValue({ id: "chat-events", mode: "chat" });
    const { registerAgUiIpc } = await import("./agui-bridge");
    const onFinished = vi.fn(async () => ({ sticker: null }));
    registerAgUiIpc(async () => ({
      options: {
        settings: { provider: "test", baseUrl: "", model: "", apiKey: "", contextWindowTokens: 256000 },
        messages: [],
        timeoutMs: 1000,
        toolSystemContent: "TOOL",
        soulSystemBaseContent: "SOUL",
      },
      latestUserText: "你好",
    }), onFinished, () => null);

    const handler = mocks.handlers.get(IPC.AGUI_RUN);
    if (!handler) throw new Error("AGUI_RUN handler was not registered");
    const ack = await handler({
      sender: { isDestroyed: () => false, send: () => {} },
    }, {
      messages: [{ role: "user", content: "你好" }],
      sessionId: "chat-events",
    }) as { runId: string };
    await expect.poll(() => onFinished.mock.calls.length).toBe(1);

    expect(onFinished).toHaveBeenCalledWith(
      expect.objectContaining({ reply: "抱抱你" }),
      "你好",
      {
        source: "desktop",
        mode: "chat",
        conversationId: "chat-events",
        runId: ack.runId,
      },
    );
  });

  it("v2 pending claim 通过 composed loader 恢复 canonical user 后可启动 AGUI_RUN", async () => {
    vi.resetModules();
    mocks.handlers.clear();
    const transcriptRoot = fs.mkdtempSync(path.join(os.tmpdir(), "cyrene-bridge-v2-claim-"));
    mocks.userDataRoot = transcriptRoot;
    const pendingDispatch = {
      messageId: "pending-user",
      claimedAt: 10,
      userMessage: {
        id: "pending-user",
        at: 10,
        text: "崩溃前输入",
        visibleContent: "崩溃前输入",
        sticker: "calm",
      },
    };
    const record = {
      id: "v2-claim",
      title: "待恢复",
      identityId: null,
      createdAt: 1,
      updatedAt: 10,
      schemaVersion: 2,
      messageCount: 0,
      mode: "chat",
      pendingDispatch,
    };
    mocks.getSession.mockReturnValue(null);
    mocks.getSessionRecord.mockReturnValue(record);
    mocks.getPendingDispatch.mockReturnValue(pendingDispatch);
    mocks.composeSession.mockImplementation((_record: unknown, messages: Array<{ id: string }>) => ({
      ...record,
      schemaVersion: 1,
      messages: messages.map((message) => message.id === "user:v1:pending-user:r1"
        ? { ...message, id: "pending-user" }
        : message),
    }));
    const { registerAgUiIpc } = await import("./agui-bridge");
    registerAgUiIpc(async () => ({
      options: {
        settings: { provider: "test", baseUrl: "", model: "", apiKey: "", contextWindowTokens: 256000 },
        messages: [], timeoutMs: 1000, toolSystemContent: "TOOL", soulSystemBaseContent: "SOUL",
      },
      latestUserText: "崩溃前输入",
    }), async () => ({}), () => null);
    const handler = mocks.handlers.get(IPC.AGUI_RUN);
    if (!handler) throw new Error("AGUI_RUN handler was not registered");
    const ack = await handler({ sender: { isDestroyed: () => false, send: () => {} } }, {
      sessionId: "v2-claim",
      userTurnId: "pending-user",
      messages: [{ role: "user", content: "崩溃前输入" }],
    }) as { runId: string };
    expect(ack.runId).toEqual(expect.any(String));
    const { ConversationTranscriptStore } = await import("./orchestrator/conversation-transcript-store");
    const transcript = await new ConversationTranscriptStore(transcriptRoot).read("v2-claim");
    expect(transcript.entries.filter((entry) => entry.kind === "user")).toHaveLength(1);
    expect(transcript.entries[0]).toEqual(expect.objectContaining({
      id: "user:v1:pending-user:r1",
      turnId: "pending-user",
    }));
    fs.rmSync(transcriptRoot, { recursive: true, force: true });
    mocks.userDataRoot = "";
  });

  it("桌面轮次事件走协调器：开始登记、终态结算、落盘确认后发布一次", async () => {
    vi.resetModules();
    mocks.handlers.clear();
    mocks.listeners.clear();
    // 桌面派发带 userTurnId：session 需含该 user 消息，轨迹写入用临时目录
    const transcriptRoot = fs.mkdtempSync(path.join(os.tmpdir(), "cyrene-bridge-pending-"));
    mocks.userDataRoot = transcriptRoot;
    mocks.getSession.mockReturnValue({
      id: "chat-pending",
      mode: "chat",
      messages: [{ id: "msg-user-1", role: "user", content: "你好", at: 1 }],
    });
    const { registerAgUiIpc } = await import("./agui-bridge");
    const { createPendingTurnLifecycle } = await import("./plugin-host/pending-turn-lifecycle");
    const publisher = {
      publishTurnStarted: vi.fn(),
      publishTurnFinished: vi.fn(),
      publishSchedulerFinished: vi.fn(),
    };
    // 真实协调器全链路：beginTurn（桥内）→ settleTerminal（complete 路径）→ confirmPersistence（落盘确认 IPC）
    const pendingTurns = createPendingTurnLifecycle({ publisher: publisher as never, now: () => 0 });
    registerAgUiIpc(async () => ({
      options: {
        settings: { provider: "test", baseUrl: "", model: "", apiKey: "", contextWindowTokens: 256000 },
        messages: [],
        timeoutMs: 1000,
        toolSystemContent: "TOOL",
        soulSystemBaseContent: "SOUL",
      },
      latestUserText: "你好",
    }), async () => ({}), () => null, undefined, undefined, pendingTurns);

    const handler = mocks.handlers.get(IPC.AGUI_RUN);
    const persistListener = mocks.listeners.get(IPC.AGUI_RUN_PERSISTED);
    if (!handler || !persistListener) throw new Error("AGUI_RUN / AGUI_RUN_PERSISTED 未注册");
    const sender = {
      isDestroyed: () => false,
      send: () => {},
      once: vi.fn(),
      removeListener: vi.fn(),
    };
    const ack = await handler({ sender }, {
      messages: [{ role: "user", content: "你好" }],
      sessionId: "chat-pending",
      userTurnId: "msg-user-1",
      assistantTurnId: "msg-assistant-1",
    }) as { runId: string };

    // turn:started 立即发布；终态结算后等待落盘确认（条目仍待结算）
    expect(publisher.publishTurnStarted).toHaveBeenCalledTimes(1);
    expect(publisher.publishTurnStarted).toHaveBeenCalledWith({
      source: "desktop",
      runId: ack.runId,
      mode: "chat",
      conversationId: "chat-pending",
      inputMessageId: "msg-user-1",
    });
    await vi.waitFor(() => expect(pendingTurns.pendingCount()).toBe(1));
    expect(publisher.publishTurnFinished).not.toHaveBeenCalled();

    // 渲染端落盘确认（单向通知）→ 终态 + 落盘确认双条件满足，发布一次
    persistListener({}, { runId: ack.runId, finalMessageId: "msg-assistant-1" });
    await vi.waitFor(() => expect(publisher.publishTurnFinished).toHaveBeenCalledTimes(1));
    expect(publisher.publishTurnFinished).toHaveBeenCalledWith(expect.objectContaining({
      source: "desktop",
      runId: ack.runId,
      mode: "chat",
      conversationId: "chat-pending",
      inputMessageId: "msg-user-1",
      finalMessageId: "msg-assistant-1",
      status: "success",
    }));
    expect(pendingTurns.pendingCount()).toBe(0);
    fs.rmSync(transcriptRoot, { recursive: true, force: true });
    mocks.userDataRoot = "";
  });

  it("routes structured Ask cards to the AG-UI run sender", async () => {
    vi.resetModules();
    mocks.handlers.clear();
    mocks.runCyreneAgent.mockClear();
    mocks.requestUserClarification.mockReset();
    mocks.getSession.mockReturnValue({
      id: "work-ask",
      mode: "work",
      workspaceBinding: { workspaceRoot: "C:\\workspace", displayName: "workspace", boundAt: 1 },
    });
    mocks.requestUserClarification.mockImplementation(async (_card, send, onSettled, identity) => {
      send({
        interactionId: "choice-1",
        runId: identity.runId,
        revision: identity.revision,
        mode: "semantic_clarification",
        intro: "需要确认",
        questions: [{
          id: "question-1",
          prompt: "选择格式？",
          required: true,
          multiple: false,
          options: [{ id: "word", label: "Word" }, { id: "pdf", label: "PDF" }],
          customInput: { enabled: true },
        }],
      });
      onSettled({ id: "choice-1", runId: identity.runId, revision: identity.revision, reason: "timeout" });
      return { requestId: "choice-1", answers: [] };
    });
    const { registerAgUiIpc } = await import("./agui-bridge");
    const sent: unknown[] = [];
    const sender = { isDestroyed: () => false, send: (_channel: string, event: unknown) => sent.push(event) };
    registerAgUiIpc(async () => ({
      options: {
        settings: { provider: "test", baseUrl: "", model: "", apiKey: "", contextWindowTokens: 256000 },
        messages: [], timeoutMs: 1000, toolSystemContent: "TOOL", soulSystemBaseContent: "SOUL",
      },
      latestUserText: "帮我生成一份文档",
    }), async () => {}, () => null);

    const handler = mocks.handlers.get(IPC.AGUI_RUN);
    if (!handler) throw new Error("AGUI_RUN handler was not registered");
    await handler({ sender }, { messages: [{ role: "user", content: "帮我生成一份文档" }], sessionId: "work-ask" });

    const options = mocks.runCyreneAgent.mock.calls[0]?.[0] as {
      requestUserClarification: (card: unknown) => Promise<unknown>;
    };
    await options.requestUserClarification({ intro: "需要确认", questions: [], deferredFields: [] });

    expect(mocks.requestUserClarification).toHaveBeenCalledOnce();
    expect(sent).toContainEqual(expect.objectContaining({
      type: "CUSTOM",
      name: "cyrene.choice",
      value: expect.objectContaining({ interactionId: "choice-1", runId: expect.any(String), revision: 1 }),
    }));
    expect(sent).toContainEqual(expect.objectContaining({
      type: "CUSTOM",
      name: "cyrene.choice.dismiss",
      value: expect.objectContaining({ id: "choice-1", runId: expect.any(String), revision: 1, reason: "timeout" }),
    }));
  });

  it("tags a post-run plan approval card with its owning session", async () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "cyrene-plan-review-"));
    try {
      vi.resetModules();
      mocks.handlers.clear();
      mocks.agentEvents = [];
      mocks.runCyreneAgent.mockClear();
      mocks.requestUserClarification.mockReset();
      mocks.getSession.mockReturnValue({
        id: "code-plan-review",
        mode: "code",
        workspaceBinding: { workspaceRoot: tempRoot, displayName: "workspace", boundAt: 1 },
      });
      mocks.requestUserClarification.mockImplementation(async (_card, send, _onSettled, identity) => {
        send({
          interactionId: "plan-choice-1",
          runId: identity.runId,
          revision: identity.revision,
          mode: "semantic_clarification",
          intro: "计划已生成",
          questions: [{
            id: "plan_decision",
            prompt: "是否批准此计划？",
            required: true,
            multiple: false,
            options: [{ id: "approve", label: "批准计划，开始执行" }],
            customInput: { enabled: false },
          }],
        });
        return { requestId: "plan-choice-1", answers: [] };
      });

      const planMode = await import("./orchestrator/plan-mode");
      planMode.enterPlanDiscussing("code-plan-review", tempRoot);
      planMode.markPlanWritten("code-plan-review");
      const planPath = planMode.getPlanPath("code-plan-review");
      fs.mkdirSync(path.dirname(planPath), { recursive: true });
      fs.writeFileSync(planPath, "# 测试计划\n", "utf8");

      const { registerAgUiIpc } = await import("./agui-bridge");
      const sent: Array<{ type?: string; name?: string; value?: Record<string, unknown> }> = [];
      registerAgUiIpc(async () => ({
        options: {
          settings: { provider: "test", baseUrl: "", model: "", apiKey: "", contextWindowTokens: 256000 },
          messages: [], timeoutMs: 1000, toolSystemContent: "TOOL", soulSystemBaseContent: "SOUL",
        },
        latestUserText: "写好计划",
      }), async () => {}, () => null);

      const handler = mocks.handlers.get(IPC.AGUI_RUN);
      if (!handler) throw new Error("AGUI_RUN handler was not registered");
      await handler(
        { sender: { isDestroyed: () => false, send: (_channel: string, event: typeof sent[number]) => sent.push(event) } },
        { messages: [{ role: "user", content: "写好计划" }], sessionId: "code-plan-review" },
      );
      await expect.poll(() => sent.find((event) => event.name === "cyrene.choice")).toBeTruthy();

      const terminalIndex = sent.findIndex((event) => event.type === "RUN_FINISHED");
      const choiceIndex = sent.findIndex((event) => event.name === "cyrene.choice");
      expect(choiceIndex).toBeGreaterThan(terminalIndex);
      expect(sent[choiceIndex]?.value).toMatchObject({
        sessionId: "code-plan-review",
        interactionId: "plan-choice-1",
      });
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it("计划审批卡超时结算会广播 cyrene.choice.dismiss 清卡", async () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "cyrene-plan-dismiss-"));
    try {
      vi.resetModules();
      mocks.handlers.clear();
      mocks.agentEvents = [];
      mocks.runCyreneAgent.mockClear();
      mocks.requestUserClarification.mockReset();
      mocks.getSession.mockReturnValue({
        id: "code-plan-dismiss",
        mode: "code",
        workspaceBinding: { workspaceRoot: tempRoot, displayName: "workspace", boundAt: 1 },
      });
      mocks.requestUserClarification.mockImplementation(async (_card, send, onSettled, identity) => {
        send({
          interactionId: "plan-choice-dismiss",
          runId: identity.runId,
          revision: identity.revision,
          mode: "semantic_clarification",
          intro: "计划已生成",
          questions: [{
            id: "plan_decision",
            prompt: "是否批准此计划？",
            required: true,
            multiple: false,
            options: [
              { id: "approve", label: "批准计划，开始执行" },
              { id: "supplement", label: "我要修改 / 补充" },
            ],
            customInput: { enabled: false },
          }],
        });
        // 模拟超时路径：pending 被结算时必须通过 onSettled 通知渲染端清卡
        onSettled({ id: "plan-choice-dismiss", runId: identity.runId, revision: identity.revision, reason: "timeout" });
        return { requestId: "plan-choice-dismiss", answers: [] };
      });

      const planMode = await import("./orchestrator/plan-mode");
      planMode.enterPlanDiscussing("code-plan-dismiss", tempRoot);
      planMode.markPlanWritten("code-plan-dismiss");
      const planPath = planMode.getPlanPath("code-plan-dismiss");
      fs.mkdirSync(path.dirname(planPath), { recursive: true });
      fs.writeFileSync(planPath, "# 测试计划\n", "utf8");

      const { registerAgUiIpc } = await import("./agui-bridge");
      const sent: Array<{ type?: string; name?: string; runId?: string; value?: Record<string, unknown> }> = [];
      registerAgUiIpc(async () => ({
        options: {
          settings: { provider: "test", baseUrl: "", model: "", apiKey: "", contextWindowTokens: 256000 },
          messages: [], timeoutMs: 1000, toolSystemContent: "TOOL", soulSystemBaseContent: "SOUL",
        },
        latestUserText: "写好计划",
      }), async () => {}, () => null);

      const handler = mocks.handlers.get(IPC.AGUI_RUN);
      if (!handler) throw new Error("AGUI_RUN handler was not registered");
      await handler(
        { sender: { isDestroyed: () => false, send: (_channel: string, event: typeof sent[number]) => sent.push(event) } },
        { messages: [{ role: "user", content: "写好计划" }], sessionId: "code-plan-dismiss" },
      );
      await expect.poll(() => sent.find((event) => event.name === "cyrene.choice.dismiss")).toBeTruthy();

      // dismiss 必须携带与审批卡一致的 runId / revision 身份，渲染端 shouldDismissAsk 才能匹配清卡
      const dismiss = sent.find((event) => event.name === "cyrene.choice.dismiss");
      const runId = sent.find((event) => event.type === "RUN_STARTED")?.runId;
      expect(dismiss?.value).toMatchObject({
        id: "plan-choice-dismiss",
        runId,
        revision: 1,
        reason: "timeout",
      });
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it("turns leading <think> text into reasoning events before forwarding the assistant start", async () => {
    vi.resetModules();
    mocks.handlers.clear();
    mocks.agentEvents = [
      { type: "TEXT_MESSAGE_START", messageId: "m1", role: "assistant" },
      { type: "TEXT_MESSAGE_CONTENT", messageId: "m1", delta: "<think>先分析" },
      { type: "TEXT_MESSAGE_CONTENT", messageId: "m1", delta: "问题</think>正式回答" },
      { type: "TEXT_MESSAGE_END", messageId: "m1" },
    ];
    mocks.getSession.mockReturnValue({ id: "chat-think", mode: "chat" });
    const { registerAgUiIpc } = await import("./agui-bridge");
    const sent: Array<{ type?: string; delta?: string; runId?: string }> = [];
    const sender = {
      isDestroyed: () => false,
      send: (_channel: string, event: { type?: string; delta?: string; runId?: string }) => sent.push(event),
    };
    registerAgUiIpc(
      async () => ({
        options: {
          settings: { provider: "test", baseUrl: "", model: "", apiKey: "", contextWindowTokens: 256000 },
          messages: [],
          timeoutMs: 1000,
          toolSystemContent: "TOOL",
          soulSystemBaseContent: "SOUL",
        },
        latestUserText: "解释一下",
      }),
      async () => {},
      () => null,
    );

    const handler = mocks.handlers.get(IPC.AGUI_RUN);
    if (!handler) throw new Error("AGUI_RUN handler was not registered");
    await handler({ sender }, { messages: [{ role: "user", content: "解释一下" }], sessionId: "chat-think" });
    await expect.poll(() => sent.some((event) => event.type === "RUN_FINISHED")).toBe(true);

    expect(sent.map((event) => event.type)).toEqual([
      "RUN_STARTED",
      "REASONING_MESSAGE_START",
      "REASONING_MESSAGE_CONTENT",
      "REASONING_MESSAGE_END",
      "TEXT_MESSAGE_START",
      "TEXT_MESSAGE_CONTENT",
      "TEXT_MESSAGE_END",
      "RUN_FINISHED",
    ]);
    expect(sent.find((event) => event.type === "REASONING_MESSAGE_CONTENT")?.delta).toBe("先分析问题");
    expect(sent.find((event) => event.type === "TEXT_MESSAGE_CONTENT")?.delta).toBe("正式回答");
    const runId = sent.find((event) => event.type === "RUN_STARTED")?.runId;
    expect(runId).toEqual(expect.any(String));
    expect(sent.filter((event) => event.type?.startsWith("TEXT_MESSAGE")).every((event) => event.runId === runId)).toBe(true);
    mocks.agentEvents = [];
  });

  it.each(["chat", "work", "code"] as const)("removes repeated leading time metadata for %s replies", async (mode) => {
    vi.resetModules();
    mocks.handlers.clear();
    mocks.agentEvents = [
      { type: "TEXT_MESSAGE_START", messageId: "m-time", role: "assistant" },
      { type: "TEXT_MESSAGE_CONTENT", messageId: "m-time", delta: "[2026-08-10 18:18, Asia/Shanghai]\n" },
      { type: "TEXT_MESSAGE_CONTENT", messageId: "m-time", delta: "[2026-08-10 18:18, Asia/Shanghai]真正回复" },
      { type: "TEXT_MESSAGE_END", messageId: "m-time" },
    ];
    mocks.getSession.mockReturnValue({
      id: `${mode}-time`,
      mode,
      ...(mode === "chat" ? {} : { workspaceBinding: { workspaceRoot: "C:\\workspace", displayName: "workspace", boundAt: 1 } }),
    });
    const { registerAgUiIpc } = await import("./agui-bridge");
    const sent: Array<{ type?: string; delta?: string }> = [];
    registerAgUiIpc(async () => ({
      options: { settings: { provider: "test", baseUrl: "", model: "", apiKey: "", contextWindowTokens: 256000 }, messages: [], timeoutMs: 1000, toolSystemContent: "TOOL", soulSystemBaseContent: "SOUL" },
      latestUserText: "测试",
    }), async () => {}, () => null);
    const handler = mocks.handlers.get(IPC.AGUI_RUN);
    if (!handler) throw new Error("AGUI_RUN handler was not registered");
    await handler({ sender: { isDestroyed: () => false, send: (_channel: string, event: { type?: string; delta?: string }) => sent.push(event) } }, { messages: [{ role: "user", content: "测试" }], sessionId: `${mode}-time` });

    expect(sent.filter((event) => event.type === "TEXT_MESSAGE_CONTENT").map((event) => event.delta).join("")).toBe("真正回复");
    mocks.agentEvents = [];
  });

  it("delivers sticker side effects before RUN_FINISHED so renderer keeps listening", async () => {
    vi.resetModules();
    mocks.handlers.clear();
    mocks.getSession.mockReturnValue({ id: "chat-sticker", mode: "chat" });
    const { registerAgUiIpc } = await import("./agui-bridge");
    const sent: unknown[] = [];
    const sender = {
      isDestroyed: () => false,
      send: (_channel: string, event: unknown) => {
        sent.push(event);
      },
    };

    registerAgUiIpc(
      async () => ({
        options: {
          settings: { provider: "test", baseUrl: "", model: "", apiKey: "", contextWindowTokens: 256000 },
          messages: [],
          timeoutMs: 1000,
          toolSystemContent: "TOOL",
          soulSystemBaseContent: "SOUL",
        },
        latestUserText: "累了",
      }),
      async () => ({ sticker: "hugtight" }),
      () => null,
    );

    const handler = mocks.handlers.get(IPC.AGUI_RUN);
    if (!handler) throw new Error("AGUI_RUN handler was not registered");
    await handler(
      { sender },
      { messages: [{ role: "user", content: "累了" }], sessionId: "chat-sticker", style: "01_default.md" },
    );
    await new Promise((resolve) => setTimeout(resolve, 0));

    const eventTypes = sent.map((event) => (event as { type?: string; name?: string }).name ?? (event as { type?: string }).type);
    expect(eventTypes).toEqual(["RUN_STARTED", "cyrene.sticker", "RUN_FINISHED"]);
  });

  it("uses the Chat session mode while preserving renderer styleId", async () => {
    vi.resetModules();
    mocks.handlers.clear();
    mocks.getSession.mockReturnValue({ id: "chat-style", mode: "chat" });
    const { registerAgUiIpc } = await import("./agui-bridge");
    const buildOptions = vi.fn(async () => ({
      options: {
        settings: { provider: "test", baseUrl: "", model: "", apiKey: "", contextWindowTokens: 256000 },
        messages: [],
        timeoutMs: 1000,
        toolSystemContent: "TOOL",
        soulSystemBaseContent: "SOUL",
      },
      latestUserText: "hi",
    }));
    const sender = {
      isDestroyed: () => false,
      send: () => {},
    };

    registerAgUiIpc(buildOptions, async () => {}, () => null);

    const handler = mocks.handlers.get(IPC.AGUI_RUN);
    if (!handler) throw new Error("AGUI_RUN handler was not registered");
    await handler(
      { sender },
      {
        messages: [{ role: "user", content: "hi" }],
        sessionId: "chat-style",
        styleId: "lively",
        executionMode: "work",
      },
    );

    expect(buildOptions).toHaveBeenCalledWith(expect.objectContaining({
      styleId: "lively",
      executionMode: "chat",
    }));
  });

  it("keeps Work requests on CyreneAgent and never dispatches the Code runtime", async () => {
    vi.resetModules();
    mocks.handlers.clear();
    mocks.runCyreneAgent.mockClear();
    mocks.getSession.mockReturnValue({
      id: "work-chat",
      mode: "work",
      workspaceBinding: { workspaceRoot: "C:\\workspace", displayName: "workspace", boundAt: 1 },
    });
    const { registerAgUiIpc } = await import("./agui-bridge");
    const buildOptions = vi.fn(async () => ({
      options: {
        settings: { provider: "test", baseUrl: "", model: "", apiKey: "", contextWindowTokens: 256000 },
        messages: [],
        timeoutMs: 1000,
        toolSystemContent: "TOOL",
        soulSystemBaseContent: "SOUL",
      },
      latestUserText: "修改项目文件",
    }));
    registerAgUiIpc(buildOptions, async () => {}, () => null);
    const handler = mocks.handlers.get(IPC.AGUI_RUN);
    if (!handler) throw new Error("AGUI_RUN handler was not registered");

    await handler({
      sender: { isDestroyed: () => false, send: () => {} },
    }, {
      messages: [{ role: "user", content: "修改项目文件" }],
      sessionId: "work-chat",
      executionMode: "chat",
    });

    expect(buildOptions).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: "work-chat",
      executionMode: "work",
    }));
    expect(mocks.runCyreneAgent).toHaveBeenCalledOnce();
    expect(mocks.runCyreneAgent).toHaveBeenCalledWith(expect.objectContaining({
      executionMode: "work",
    }));
  });

  it("rejects project modes without a trusted workspace binding", async () => {
    vi.resetModules();
    mocks.handlers.clear();
    mocks.runCyreneAgent.mockClear();
    mocks.getSession.mockReturnValue({ id: "work-no-workspace", mode: "work" });
    const { registerAgUiIpc } = await import("./agui-bridge");
    registerAgUiIpc(vi.fn(), async () => {}, () => null);
    const handler = mocks.handlers.get(IPC.AGUI_RUN);
    if (!handler) throw new Error("AGUI_RUN handler was not registered");

    await expect(handler({
      sender: { isDestroyed: () => false, send: () => {} },
    }, {
      messages: [{ role: "user", content: "开始" }],
      sessionId: "work-no-workspace",
    })).rejects.toThrow("需要先绑定项目工作区");
    expect(mocks.runCyreneAgent).not.toHaveBeenCalled();
  });

  it("does not forward an empty resume marker on an ordinary new turn", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "cyrene-bridge-empty-resume-"));
    mocks.userDataRoot = root;
    vi.resetModules();
    mocks.handlers.clear();
    mocks.runCyreneAgent.mockClear();
    mocks.getSession.mockReturnValue({ id: "chat-new-turn", mode: "chat" });
    const { registerAgUiIpc } = await import("./agui-bridge");
    const buildOptions = vi.fn(async () => ({
      options: {
        settings: { provider: "test", baseUrl: "", model: "", apiKey: "", contextWindowTokens: 256000 },
        messages: [{ role: "user", content: "new turn" }],
        timeoutMs: 1000,
        toolSystemContent: "TOOL",
        soulSystemBaseContent: "SOUL",
      },
      latestUserText: "new turn",
    }));
    registerAgUiIpc(buildOptions, async () => {}, () => null);
    const handler = mocks.handlers.get(IPC.AGUI_RUN);
    if (!handler) throw new Error("AGUI_RUN handler was not registered");

    try {
      await handler({ sender: { isDestroyed: () => false, send: () => {} } }, {
        sessionId: "chat-new-turn",
        resumeFromRunId: "   ",
        messages: [{ role: "user", content: "new turn" }],
      });

      expect(mocks.runCyreneAgent).toHaveBeenCalledWith(expect.not.objectContaining({ resumeFromRunId: expect.anything() }));
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
      mocks.userDataRoot = "";
    }
  });

  // ── canonical runId 与 exactly-once settlement ────────────

  it("propagates the canonical runId through ack, RUN_STARTED, options, and RUN_FINISHED", async () => {
    vi.resetModules();
    mocks.handlers.clear();
    mocks.runCyreneAgent.mockClear();
    mocks.getSession.mockReturnValue({ id: "chat-identity", mode: "chat" });
    const { registerAgUiIpc } = await import("./agui-bridge");
    const sent: Array<{ type?: string; runId?: string }> = [];
    const sender = {
      isDestroyed: () => false,
      send: (_channel: string, event: { type?: string; runId?: string }) => sent.push(event),
    };

    registerAgUiIpc(
      async () => ({
        options: {
          settings: { provider: "test", baseUrl: "", model: "", apiKey: "", contextWindowTokens: 256000 },
          messages: [],
          timeoutMs: 1000,
          toolSystemContent: "TOOL",
          soulSystemBaseContent: "SOUL",
        },
        latestUserText: "hi",
      }),
      async () => {},
      () => null,
    );

    const handler = mocks.handlers.get(IPC.AGUI_RUN);
    if (!handler) throw new Error("AGUI_RUN handler was not registered");
    const ack = await handler(
      { sender },
      { messages: [{ role: "user", content: "hi" }], sessionId: "chat-identity" },
    ) as { runId: string };

    await expect.poll(() => sent.some((event) => event.type === "RUN_FINISHED")).toBe(true);

    // ack.runId 必须存在
    expect(ack.runId).toBeTruthy();

    // CyreneAgent.runWithEvents 必须收到 options.runId === ack.runId
    expect(mocks.runCyreneAgent).toHaveBeenCalledWith(expect.objectContaining({
      runId: ack.runId,
    }));

    // RUN_STARTED 与 RUN_FINISHED 的 runId 必须与 ack.runId 一致
    const runStarted = sent.find((event) => event.type === "RUN_STARTED");
    const runFinished = sent.find((event) => event.type === "RUN_FINISHED");
    expect(runStarted?.runId).toBe(ack.runId);
    expect(runFinished?.runId).toBe(ack.runId);
  });

  it("drops duplicate RUN_FINISHED events so the renderer only sees one terminal", async () => {
    vi.resetModules();
    mocks.handlers.clear();
    mocks.runCyreneAgent.mockClear();
    mocks.getSession.mockReturnValue({ id: "chat-dup", mode: "chat" });
    mocks.emitDuplicateRunFinished = true;
    const { registerAgUiIpc } = await import("./agui-bridge");
    const sent: Array<{ type?: string }> = [];
    const sender = {
      isDestroyed: () => false,
      send: (_channel: string, event: { type?: string }) => sent.push(event),
    };

    registerAgUiIpc(
      async () => ({
        options: {
          settings: { provider: "test", baseUrl: "", model: "", apiKey: "", contextWindowTokens: 256000 },
          messages: [],
          timeoutMs: 1000,
          toolSystemContent: "TOOL",
          soulSystemBaseContent: "SOUL",
        },
        latestUserText: "hi",
      }),
      async () => {},
      () => null,
    );

    const handler = mocks.handlers.get(IPC.AGUI_RUN);
    if (!handler) throw new Error("AGUI_RUN handler was not registered");
    await handler(
      { sender },
      { messages: [{ role: "user", content: "hi" }], sessionId: "chat-dup" },
    );

    await expect.poll(() => sent.some((event) => event.type === "RUN_FINISHED")).toBe(true);

    // 即便 upstream 连发两个 RUN_FINISHED，渲染端只应收到一个
    const runFinishedCount = sent.filter((event) => event.type === "RUN_FINISHED").length;
    expect(runFinishedCount).toBe(1);
  });

  it("suppresses RUN_ERROR after RUN_FINISHED has already settled (success-then-error)", async () => {
    vi.resetModules();
    mocks.handlers.clear();
    mocks.runCyreneAgent.mockClear();
    mocks.getSession.mockReturnValue({ id: "chat-err-after", mode: "chat" });
    mocks.errorAfterRunFinished = "boom";
    const { registerAgUiIpc } = await import("./agui-bridge");
    const sent: Array<{ type?: string }> = [];
    const sender = {
      isDestroyed: () => false,
      send: (_channel: string, event: { type?: string }) => sent.push(event),
    };

    registerAgUiIpc(
      async () => ({
        options: {
          settings: { provider: "test", baseUrl: "", model: "", apiKey: "", contextWindowTokens: 256000 },
          messages: [],
          timeoutMs: 1000,
          toolSystemContent: "TOOL",
          soulSystemBaseContent: "SOUL",
        },
        latestUserText: "hi",
      }),
      async () => {},
      () => null,
    );

    const handler = mocks.handlers.get(IPC.AGUI_RUN);
    if (!handler) throw new Error("AGUI_RUN handler was not registered");
    await handler(
      { sender },
      { messages: [{ role: "user", content: "hi" }], sessionId: "chat-err-after" },
    );

    await expect.poll(() => sent.some((event) => event.type === "RUN_FINISHED")).toBe(true);

    // RUN_FINISHED 必须到达（settlement gate 第一次进入的是 finished）
    expect(sent.some((event) => event.type === "RUN_FINISHED")).toBe(true);
    // RUN_ERROR 必须被 gate 丢弃（已结算为 success/finished）
    expect(sent.some((event) => event.type === "RUN_ERROR")).toBe(false);
  });

  it("skips onRunFinished side effects when RUN_FINISHED.result.status is cancelled", async () => {
    vi.resetModules();
    mocks.handlers.clear();
    mocks.runCyreneAgent.mockClear();
    mocks.getSession.mockReturnValue({ id: "chat-cancelled", mode: "chat" });
    mocks.runFinishedResult = { status: "cancelled", reason: "user_cancelled", externalEffectsMayContinue: true };
    const { registerAgUiIpc } = await import("./agui-bridge");
    const sent: Array<{ type?: string; name?: string }> = [];
    const sender = {
      isDestroyed: () => false,
      send: (_channel: string, event: { type?: string; name?: string }) => sent.push(event),
    };
    const onFinished = vi.fn(async () => ({ sticker: "should-not-fire" }));

    registerAgUiIpc(
      async () => ({
        options: {
          settings: { provider: "test", baseUrl: "", model: "", apiKey: "", contextWindowTokens: 256000 },
          messages: [],
          timeoutMs: 1000,
          toolSystemContent: "TOOL",
          soulSystemBaseContent: "SOUL",
        },
        latestUserText: "hi",
      }),
      onFinished,
      () => null,
    );

    const handler = mocks.handlers.get(IPC.AGUI_RUN);
    if (!handler) throw new Error("AGUI_RUN handler was not registered");
    await handler(
      { sender },
      { messages: [{ role: "user", content: "hi" }], sessionId: "chat-cancelled" },
    );

    await expect.poll(() => sent.some((event) => event.type === "RUN_FINISHED")).toBe(true);

    // cancelled 路径不应触发 onRunFinished 成功副作用
    expect(onFinished).not.toHaveBeenCalled();
    // 也不应发出 sticker CUSTOM 事件
    expect(sent.some((event) => event.type === "CUSTOM" && event.name === "cyrene.sticker")).toBe(false);
    // 但 RUN_FINISHED 本身必须发出
    expect(sent.some((event) => event.type === "RUN_FINISHED")).toBe(true);
  });

  // ── 裸 complete（upstream 未发 RUN_FINISHED）必须补发一个合成 RUN_FINISHED ──

  it("synthesizes exactly one RUN_FINISHED when upstream completes without emitting one", async () => {
    vi.resetModules();
    mocks.handlers.clear();
    mocks.runCyreneAgent.mockClear();
    mocks.getSession.mockReturnValue({ id: "chat-bare-complete", mode: "chat" });
    // upstream 直接 complete，不发 RUN_FINISHED
    mocks.skipDefaultRunFinished = true;
    const { registerAgUiIpc } = await import("./agui-bridge");
    const sent: Array<{ type?: string; runId?: string }> = [];
    const sender = {
      isDestroyed: () => false,
      send: (_channel: string, event: { type?: string; runId?: string }) => sent.push(event),
    };

    registerAgUiIpc(
      async () => ({
        options: {
          settings: { provider: "test", baseUrl: "", model: "", apiKey: "", contextWindowTokens: 256000 },
          messages: [],
          timeoutMs: 1000,
          toolSystemContent: "TOOL",
          soulSystemBaseContent: "SOUL",
        },
        latestUserText: "hi",
      }),
      async () => {},
      () => null,
    );

    const handler = mocks.handlers.get(IPC.AGUI_RUN);
    if (!handler) throw new Error("AGUI_RUN handler was not registered");
    const ack = await handler(
      { sender },
      { messages: [{ role: "user", content: "hi" }], sessionId: "chat-bare-complete" },
    ) as { runId: string };

    await expect.poll(() => sent.some((event) => event.type === "RUN_FINISHED")).toBe(true);

    // 恰好一个 RUN_FINISHED（合成的），不是零个也不是两个
    const runFinishedCount = sent.filter((event) => event.type === "RUN_FINISHED").length;
    expect(runFinishedCount).toBe(1);
    // 合成的 RUN_FINISHED 必须带 canonical runId + success 终态
    const runFinished = sent.find((event) => event.type === "RUN_FINISHED");
    expect(runFinished?.runId).toBe(ack.runId);
    expect(runFinished).toMatchObject({ result: { status: "success", externalEffectsMayContinue: false } });
    // 不能误发 RUN_ERROR
    expect(sent.some((event) => event.type === "RUN_ERROR")).toBe(false);
  });

  // ── 同步 complete 不留幽灵 active run ──

  it("does not register a ghost active run when the Observable completes synchronously", async () => {
    vi.resetModules();
    mocks.handlers.clear();
    mocks.runCyreneAgent.mockClear();
    mocks.getSession.mockReturnValue({ id: "chat-sync-complete", mode: "chat" });
    const { registerAgUiIpc, __hasActiveRunForTest } = await import("./agui-bridge");
    const sender = {
      isDestroyed: () => false,
      send: () => {},
    };

    registerAgUiIpc(
      async () => ({
        options: {
          settings: { provider: "test", baseUrl: "", model: "", apiKey: "", contextWindowTokens: 256000 },
          messages: [],
          timeoutMs: 1000,
          toolSystemContent: "TOOL",
          soulSystemBaseContent: "SOUL",
        },
        latestUserText: "hi",
      }),
      async () => {},
      () => null,
    );

    const handler = mocks.handlers.get(IPC.AGUI_RUN);
    if (!handler) throw new Error("AGUI_RUN handler was not registered");
    const ack = await handler(
      { sender },
      { messages: [{ role: "user", content: "hi" }], sessionId: "chat-sync-complete" },
    ) as { runId: string };

    // 让 microtask 跑完（mock Observable 是同步的，subscribe 返回时已 complete）
    await new Promise((resolve) => setTimeout(resolve, 0));

    // 关键不变量：run 已结算，绝不能留在 activeRuns 里（否则 cancel 链路会带上幽灵 run）
    expect(__hasActiveRunForTest(ack.runId)).toBe(false);
  });

  // ── harness 返回 terminateReason="error" → runtime_error → RUN_ERROR ──

  it("routes harness runtime_error terminal to RUN_ERROR and skips success side effects", async () => {
    vi.resetModules();
    mocks.handlers.clear();
    mocks.runCyreneAgent.mockClear();
    mocks.getSession.mockReturnValue({ id: "chat-runtime-error", mode: "chat" });
    // upstream 发 RUN_FINISHED 但 result.status = "runtime_error"
    mocks.runFinishedResult = { status: "runtime_error", reason: "E_HARNESS_FAILURE", externalEffectsMayContinue: true };
    const { registerAgUiIpc } = await import("./agui-bridge");
    const sent: Array<{ type?: string; name?: string }> = [];
    const sender = {
      isDestroyed: () => false,
      send: (_channel: string, event: { type?: string; name?: string }) => sent.push(event),
    };
    const onFinished = vi.fn(async () => ({ sticker: "should-not-fire" }));

    registerAgUiIpc(
      async () => ({
        options: {
          settings: { provider: "test", baseUrl: "", model: "", apiKey: "", contextWindowTokens: 256000 },
          messages: [],
          timeoutMs: 1000,
          toolSystemContent: "TOOL",
          soulSystemBaseContent: "SOUL",
        },
        latestUserText: "hi",
      }),
      onFinished,
      () => null,
    );

    const handler = mocks.handlers.get(IPC.AGUI_RUN);
    if (!handler) throw new Error("AGUI_RUN handler was not registered");
    await handler(
      { sender },
      { messages: [{ role: "user", content: "hi" }], sessionId: "chat-runtime-error" },
    );

    await expect.poll(() => sent.some((event) => event.type === "RUN_ERROR")).toBe(true);

    // runtime_error 必须走 RUN_ERROR，绝不走 RUN_FINISHED
    expect(sent.some((event) => event.type === "RUN_ERROR")).toBe(true);
    expect(sent.some((event) => event.type === "RUN_FINISHED")).toBe(false);
    // 不能触发成功收尾副作用
    expect(onFinished).not.toHaveBeenCalled();
    expect(sent.some((event) => event.type === "CUSTOM" && event.name === "cyrene.sticker")).toBe(false);
  });

  // ── cancellation propagation（取消传播）───────────────────────────────

  it("AGUI_CANCEL aborts the run's AbortController (not just unsubscribe)", async () => {
    vi.resetModules();
    mocks.handlers.clear();
    mocks.runCyreneAgent.mockClear();
    mocks.getSession.mockReturnValue({ id: "chat-cancel-1", mode: "chat" });
    // upstream 永不自动 complete（模拟正在运行）：不发 RUN_FINISHED + 不 complete
    mocks.skipDefaultRunFinished = true;
    mocks.neverComplete = true;
    const { registerAgUiIpc } = await import("./agui-bridge");
    const sender = {
      isDestroyed: () => false,
      send: () => {},
    };

    registerAgUiIpc(
      async () => ({
        options: {
          settings: { provider: "test", baseUrl: "", model: "", apiKey: "", contextWindowTokens: 256000 },
          messages: [],
          timeoutMs: 60000,
          toolSystemContent: "TOOL",
          soulSystemBaseContent: "SOUL",
        },
        latestUserText: "hi",
      }),
      async () => {},
      () => null,
    );

    const runHandler = mocks.handlers.get(IPC.AGUI_RUN);
    const cancelHandler = mocks.handlers.get(IPC.AGUI_CANCEL);
    if (!runHandler || !cancelHandler) throw new Error("handlers not registered");

    const ack = await runHandler(
      { sender },
      { messages: [{ role: "user", content: "hi" }], sessionId: "chat-cancel-1" },
    ) as { runId: string };

    // 等 CyreneAgent.runWithEvents 被调用
    await vi.waitFor(() => expect(mocks.runCyreneAgent).toHaveBeenCalledOnce());

    // bridge 必须通过 options.signal 传入 AbortController.signal
    const passedOptions = mocks.runCyreneAgent.mock.calls[0]?.[0] as { signal?: AbortSignal };
    expect(passedOptions.signal).toBeDefined();
    expect(passedOptions.signal!.aborted).toBe(false);

    // 调用 AGUI_CANCEL —— 必须 abort signal，不是 unsubscribe Observable
    await cancelHandler({}, ack.runId);

    // signal 必须被 abort
    expect(passedOptions.signal!.aborted).toBe(true);
  });

  it("cancel one runId does not abort another run's signal", async () => {
    vi.resetModules();
    mocks.handlers.clear();
    mocks.runCyreneAgent.mockClear();
    mocks.getSession.mockReturnValue({ id: "chat-isolation", mode: "chat" });
    mocks.skipDefaultRunFinished = true;
    mocks.neverComplete = true;
    const { registerAgUiIpc } = await import("./agui-bridge");
    const sender = {
      isDestroyed: () => false,
      send: () => {},
    };

    registerAgUiIpc(
      async () => ({
        options: {
          settings: { provider: "test", baseUrl: "", model: "", apiKey: "", contextWindowTokens: 256000 },
          messages: [],
          timeoutMs: 60000,
          toolSystemContent: "TOOL",
          soulSystemBaseContent: "SOUL",
        },
        latestUserText: "hi",
      }),
      async () => {},
      () => null,
    );

    const runHandler = mocks.handlers.get(IPC.AGUI_RUN);
    const cancelHandler = mocks.handlers.get(IPC.AGUI_CANCEL);
    if (!runHandler || !cancelHandler) throw new Error("handlers not registered");

    // 启动两个 run（会话守卫要求不同会话：跨会话并发是既有能力）
    const ack1 = await runHandler(
      { sender },
      { messages: [{ role: "user", content: "run1" }], sessionId: "chat-isolation-a" },
    ) as { runId: string };
    const ack2 = await runHandler(
      { sender },
      { messages: [{ role: "user", content: "run2" }], sessionId: "chat-isolation-b" },
    ) as { runId: string };

    await vi.waitFor(() => expect(mocks.runCyreneAgent).toHaveBeenCalledTimes(2));

    const signal1 = (mocks.runCyreneAgent.mock.calls[0]?.[0] as { signal?: AbortSignal }).signal;
    const signal2 = (mocks.runCyreneAgent.mock.calls[1]?.[0] as { signal?: AbortSignal }).signal;
    expect(signal1).toBeDefined();
    expect(signal2).toBeDefined();
    expect(signal1).not.toBe(signal2);

    // cancel run1 —— 绝不能影响 run2
    await cancelHandler({}, ack1.runId);

    expect(signal1!.aborted).toBe(true);
    expect(signal2!.aborted).toBe(false);
  });

  it("AGUI_CANCEL with no runId aborts all active runs", async () => {
    vi.resetModules();
    mocks.handlers.clear();
    mocks.runCyreneAgent.mockClear();
    mocks.getSession.mockReturnValue({ id: "chat-cancel-all", mode: "chat" });
    mocks.skipDefaultRunFinished = true;
    mocks.neverComplete = true;
    const { registerAgUiIpc } = await import("./agui-bridge");
    const sender = {
      isDestroyed: () => false,
      send: () => {},
    };

    registerAgUiIpc(
      async () => ({
        options: {
          settings: { provider: "test", baseUrl: "", model: "", apiKey: "", contextWindowTokens: 256000 },
          messages: [],
          timeoutMs: 60000,
          toolSystemContent: "TOOL",
          soulSystemBaseContent: "SOUL",
        },
        latestUserText: "hi",
      }),
      async () => {},
      () => null,
    );

    const runHandler = mocks.handlers.get(IPC.AGUI_RUN);
    const cancelHandler = mocks.handlers.get(IPC.AGUI_CANCEL);
    if (!runHandler || !cancelHandler) throw new Error("handlers not registered");

    await runHandler(
      { sender },
      { messages: [{ role: "user", content: "run1" }], sessionId: "chat-cancel-all-a" },
    );
    await runHandler(
      { sender },
      { messages: [{ role: "user", content: "run2" }], sessionId: "chat-cancel-all-b" },
    );

    await vi.waitFor(() => expect(mocks.runCyreneAgent).toHaveBeenCalledTimes(2));

    const signal1 = (mocks.runCyreneAgent.mock.calls[0]?.[0] as { signal?: AbortSignal }).signal;
    const signal2 = (mocks.runCyreneAgent.mock.calls[1]?.[0] as { signal?: AbortSignal }).signal;

    // 无 runId → abort 全部
    await cancelHandler({}, undefined);

    expect(signal1!.aborted).toBe(true);
    expect(signal2!.aborted).toBe(true);
  });
});

// ── 会话级运行守卫 ──────────────────────────────────────
// 同一会话同一时刻最多一个 active run；不同会话允许并发。
// 渲染端 busy 队列只是 UX 优化，主进程守卫才是跨进程最终一致性边界。
describe("agui-bridge session run guard", () => {
  const defaultBuildOptions = async () => ({
    options: {
      settings: { provider: "test", baseUrl: "", model: "", apiKey: "", contextWindowTokens: 256000 },
      messages: [],
      timeoutMs: 60000,
      toolSystemContent: "TOOL",
      soulSystemBaseContent: "SOUL",
    },
    latestUserText: "hi",
  });

  function makeSender() {
    return { isDestroyed: () => false, send: () => {} };
  }

  beforeEach(() => {
    mocks.runFinishedResult = undefined;
    mocks.emitDuplicateRunFinished = false;
    mocks.errorAfterRunFinished = null;
    mocks.skipDefaultRunFinished = false;
    mocks.neverComplete = false;
    mocks.completeOnAbort = false;
    mocks.getSessionRecord.mockReset();
    mocks.getPendingDispatch.mockReset();
    mocks.composeSession.mockReset();
  });

  async function setupBridge(buildOptions = defaultBuildOptions) {
    vi.resetModules();
    mocks.handlers.clear();
    mocks.runCyreneAgent.mockClear();
    const bridge = await import("./agui-bridge");
    bridge.registerAgUiIpc(buildOptions, async () => {}, () => null);
    const runHandler = mocks.handlers.get(IPC.AGUI_RUN);
    if (!runHandler) throw new Error("AGUI_RUN handler was not registered");
    return { bridge, runHandler };
  }

  it("rejects a second same-session run with SESSION_RUN_ACTIVE while the first is unsettled", async () => {
    mocks.getSession.mockReturnValue({ id: "guard-1", mode: "chat" });
    mocks.skipDefaultRunFinished = true;
    mocks.neverComplete = true;
    const { bridge, runHandler } = await setupBridge();
    const sender = makeSender();

    const ack1 = await runHandler(
      { sender },
      { messages: [{ role: "user", content: "run1" }], sessionId: "guard-1" },
    ) as { runId: string };
    expect(bridge.__getSessionActiveRunForTest("guard-1")).toBe(ack1.runId);

    // 不带 takeoverFromRunId 的同会话第二个 run → 拒绝，错误带稳定前缀 + active runId
    await expect(runHandler(
      { sender },
      { messages: [{ role: "user", content: "run2" }], sessionId: "guard-1" },
    )).rejects.toThrow(`SESSION_RUN_ACTIVE:${ack1.runId}`);

    // 拒绝不得影响第一个 run：守卫仍指向 run1
    expect(bridge.__getSessionActiveRunForTest("guard-1")).toBe(ack1.runId);
  });

  it("releases the guard after the first run settles, allowing a new run", async () => {
    mocks.getSession.mockReturnValue({ id: "guard-2", mode: "chat" });
    const { bridge, runHandler } = await setupBridge();
    const sender = makeSender();

    const ack1 = await runHandler(
      { sender },
      { messages: [{ role: "user", content: "run1" }], sessionId: "guard-2" },
    ) as { runId: string };
    // complete 回调链路（副作用 → endLifecycle）是异步的：等守卫真实释放
    await vi.waitFor(() => expect(bridge.__getSessionActiveRunForTest("guard-2")).toBeUndefined());

    const ack2 = await runHandler(
      { sender },
      { messages: [{ role: "user", content: "run2" }], sessionId: "guard-2" },
    ) as { runId: string };
    expect(ack2.runId).toBeTruthy();
    expect(bridge.__getSessionActiveRunForTest("guard-2")).toBe(ack2.runId);
  });

  it("takeover aborts the active run, waits for settlement, then starts the new run", async () => {
    mocks.getSession.mockReturnValue({ id: "guard-3", mode: "chat" });
    // completeOnAbort：abort 触发 RUN_FINISHED(cancelled) + complete 的真实结算链路
    mocks.skipDefaultRunFinished = true;
    mocks.neverComplete = true;
    mocks.completeOnAbort = true;
    const { bridge, runHandler } = await setupBridge();
    const sender = makeSender();

    const ack1 = await runHandler(
      { sender },
      { messages: [{ role: "user", content: "run1" }], sessionId: "guard-3" },
    ) as { runId: string };

    const ack2 = await runHandler(
      { sender },
      {
        messages: [{ role: "user", content: "run2" }],
        sessionId: "guard-3",
        takeoverFromRunId: ack1.runId,
      },
    ) as { runId: string };

    expect(mocks.runCyreneAgent).toHaveBeenCalledTimes(2);
    // 旧 run 被 takeover abort（cancelled 结算），新 run 的 signal 干净
    const signal1 = (mocks.runCyreneAgent.mock.calls[0]?.[0] as { signal?: AbortSignal }).signal;
    const signal2 = (mocks.runCyreneAgent.mock.calls[1]?.[0] as { signal?: AbortSignal }).signal;
    expect(signal1!.aborted).toBe(true);
    expect(signal2!.aborted).toBe(false);
    // 守卫已易主到新 run
    expect(bridge.__getSessionActiveRunForTest("guard-3")).toBe(ack2.runId);
  });

  it("rejects takeover when takeoverFromRunId does not match the active run", async () => {
    mocks.getSession.mockReturnValue({ id: "guard-4", mode: "chat" });
    mocks.skipDefaultRunFinished = true;
    mocks.neverComplete = true;
    const { bridge, runHandler } = await setupBridge();
    const sender = makeSender();

    const ack1 = await runHandler(
      { sender },
      { messages: [{ role: "user", content: "run1" }], sessionId: "guard-4" },
    ) as { runId: string };

    await expect(runHandler(
      { sender },
      {
        messages: [{ role: "user", content: "run2" }],
        sessionId: "guard-4",
        takeoverFromRunId: "stale-or-wrong-run-id",
      },
    )).rejects.toThrow(`SESSION_RUN_ACTIVE:${ack1.runId}`);

    expect(bridge.__getSessionActiveRunForTest("guard-4")).toBe(ack1.runId);
  });

  it("throws SESSION_RUN_TAKEOVER_STUCK when the active run never settles after abort", async () => {
    mocks.getSession.mockReturnValue({ id: "guard-5", mode: "chat" });
    // abort 后旧 run 永不结算（模拟 settlement 链路自身故障）
    mocks.skipDefaultRunFinished = true;
    mocks.neverComplete = true;
    mocks.completeOnAbort = false;
    const { bridge, runHandler } = await setupBridge();
    bridge.__setTakeoverSettleTimeoutForTest(10);
    const sender = makeSender();

    const ack1 = await runHandler(
      { sender },
      { messages: [{ role: "user", content: "run1" }], sessionId: "guard-5" },
    ) as { runId: string };

    await expect(runHandler(
      { sender },
      {
        messages: [{ role: "user", content: "run2" }],
        sessionId: "guard-5",
        takeoverFromRunId: ack1.runId,
      },
    )).rejects.toThrow(`SESSION_RUN_TAKEOVER_STUCK:${ack1.runId}`);
  });

  it("concurrent takeovers of the same run: exactly one wins, the loser is rejected", async () => {
    mocks.getSession.mockReturnValue({ id: "guard-6", mode: "chat" });
    mocks.skipDefaultRunFinished = true;
    mocks.neverComplete = true;
    mocks.completeOnAbort = true;
    const { bridge, runHandler } = await setupBridge();
    const sender = makeSender();

    const ack1 = await runHandler(
      { sender },
      { messages: [{ role: "user", content: "run1" }], sessionId: "guard-6" },
    ) as { runId: string };

    // 两个 takeover 同 tick 发起：旧 run 结算后双双醒来重新竞争守卫，恰一个注册成功
    const [first, second] = await Promise.allSettled([
      runHandler({ sender }, {
        messages: [{ role: "user", content: "a" }],
        sessionId: "guard-6",
        takeoverFromRunId: ack1.runId,
      }),
      runHandler({ sender }, {
        messages: [{ role: "user", content: "b" }],
        sessionId: "guard-6",
        takeoverFromRunId: ack1.runId,
      }),
    ]);

    const outcomes = [first.status, second.status].sort();
    expect(outcomes).toEqual(["fulfilled", "rejected"]);
    // 输家的 takeoverFromRunId 已不匹配新 active run → SESSION_RUN_ACTIVE（指向赢家）
    const rejected = first.status === "rejected" ? first : second as PromiseRejectedResult;
    expect((rejected as PromiseRejectedResult).reason.message).toMatch(/^SESSION_RUN_ACTIVE:/);
    // 守卫恰好指向赢家
    const fulfilled = first.status === "fulfilled" ? first : second as PromiseFulfilledResult<{ runId: string }>;
    expect(bridge.__getSessionActiveRunForTest("guard-6")).toBe((fulfilled as PromiseFulfilledResult<{ runId: string }>).value.runId);
  });

  it("release is compare-and-delete: a mismatched runId never drops the guard", async () => {
    mocks.getSession.mockReturnValue({ id: "guard-7", mode: "chat" });
    mocks.skipDefaultRunFinished = true;
    mocks.neverComplete = true;
    const { bridge, runHandler } = await setupBridge();
    const sender = makeSender();

    const ack1 = await runHandler(
      { sender },
      { messages: [{ role: "user", content: "run1" }], sessionId: "guard-7" },
    ) as { runId: string };

    // 旧 run 迟到的清理（runId 不匹配）不得误删当前守卫
    bridge.__releaseSessionGuardForTest("guard-7", "some-other-run");
    expect(bridge.__getSessionActiveRunForTest("guard-7")).toBe(ack1.runId);

    // 匹配的 runId 才释放
    bridge.__releaseSessionGuardForTest("guard-7", ack1.runId);
    expect(bridge.__getSessionActiveRunForTest("guard-7")).toBeUndefined();
  });

  it("releases the session guard when buildOptions throws after registration", async () => {
    mocks.getSession.mockReturnValue({ id: "guard-8", mode: "chat" });
    const failingBuildOptions = async () => {
      throw new Error("boom: build options failed");
    };
    const { bridge, runHandler } = await setupBridge(failingBuildOptions);
    const sender = makeSender();

    await expect(runHandler(
      { sender },
      { messages: [{ role: "user", content: "run1" }], sessionId: "guard-8" },
    )).rejects.toThrow("boom: build options failed");

    // 早期退出路径必须释放守卫，否则该会话永久拒绝新 run
    expect(bridge.__getSessionActiveRunForTest("guard-8")).toBeUndefined();
  });

  it("same-tick concurrent runs on one session: exactly one registers", async () => {
    mocks.getSession.mockReturnValue({ id: "guard-9", mode: "chat" });
    mocks.skipDefaultRunFinished = true;
    mocks.neverComplete = true;
    const { runHandler } = await setupBridge();
    const sender = makeSender();

    const [first, second] = await Promise.allSettled([
      runHandler({ sender }, { messages: [{ role: "user", content: "a" }], sessionId: "guard-9" }),
      runHandler({ sender }, { messages: [{ role: "user", content: "b" }], sessionId: "guard-9" }),
    ]);

    // 守卫注册在同步代码块内完成（get 与 set 之间无 await）→ 同 tick 竞态下恰一个赢
    expect([first.status, second.status].sort()).toEqual(["fulfilled", "rejected"]);
    const rejected = first.status === "rejected" ? first : second as PromiseRejectedResult;
    expect((rejected as PromiseRejectedResult).reason.message).toMatch(/^SESSION_RUN_ACTIVE:/);
  });
});

describe("agui-bridge pending adjust IPC", () => {
  const defaultBuildOptions = async () => ({
    options: {
      settings: { provider: "test", baseUrl: "", model: "", apiKey: "", contextWindowTokens: 256000 },
      messages: [],
      timeoutMs: 60000,
      toolSystemContent: "TOOL",
      soulSystemBaseContent: "SOUL",
    },
    latestUserText: "hi",
  });

  function makeSender() {
    return { isDestroyed: () => false, send: () => {} };
  }

  beforeEach(() => {
    mocks.runFinishedResult = undefined;
    mocks.emitDuplicateRunFinished = false;
    mocks.errorAfterRunFinished = null;
    mocks.skipDefaultRunFinished = false;
    mocks.neverComplete = false;
    mocks.completeOnAbort = false;
    mocks.getSession.mockReset();
    mocks.getPendingMessages.mockReset();
    mocks.markPendingAdjust.mockReset();
    mocks.resetPendingAdjustByRun.mockReset();
    mocks.getSessionRecord.mockReset();
    mocks.getPendingDispatch.mockReset();
    mocks.composeSession.mockReset();
  });

  async function setupBridge(buildOptions = defaultBuildOptions) {
    vi.resetModules();
    mocks.handlers.clear();
    mocks.runCyreneAgent.mockClear();
    const bridge = await import("./agui-bridge");
    bridge.registerAgUiIpc(buildOptions, async () => {}, () => null);
    const adjustHandler = mocks.handlers.get(IPC.CHATS_PENDING_ADJUST);
    const runHandler = mocks.handlers.get(IPC.AGUI_RUN);
    if (!adjustHandler || !runHandler) {
      throw new Error("CHATS_PENDING_ADJUST / AGUI_RUN handlers were not registered");
    }
    return { bridge, adjustHandler, runHandler };
  }

  it("载荷校验与会话不存在：invalid-payload / session-not-found", async () => {
    mocks.getSession.mockReturnValue(null);
    const { adjustHandler } = await setupBridge();
    const sender = makeSender();

    expect(await adjustHandler({ sender }, null)).toEqual({ ok: false, error: "invalid-payload" });
    expect(await adjustHandler({ sender }, { sessionId: "", messageId: "q-1" })).toEqual({
      ok: false,
      error: "invalid-payload",
    });
    expect(await adjustHandler({ sender }, { sessionId: "missing", messageId: "q-1" })).toEqual({
      ok: false,
      error: "session-not-found",
    });
    expect(mocks.markPendingAdjust).not.toHaveBeenCalled();
  });

  it("无活跃运行：no-active-run 并返回最新权威队列（消息留在普通队列）", async () => {
    mocks.getSession.mockReturnValue({ id: "adj-1", mode: "work" });
    mocks.getPendingMessages.mockReturnValue([{ id: "q-1", rawContent: "排队中", visibleContent: "排队中", enqueuedAt: 1 }]);
    const { adjustHandler } = await setupBridge();
    const sender = makeSender();

    const result = await adjustHandler({ sender }, { sessionId: "adj-1", messageId: "q-1" });
    expect(result).toEqual({
      ok: false,
      error: "no-active-run",
      queue: [expect.objectContaining({ id: "q-1" })],
    });
    expect(mocks.markPendingAdjust).not.toHaveBeenCalled();
  });

  it("Chat 模式没有安全的下一步：no-safe-next-step 并返回队列", async () => {
    mocks.getSession.mockReturnValue({ id: "adj-2", mode: "chat" });
    mocks.getPendingMessages.mockReturnValue([]);
    const { adjustHandler, runHandler } = await setupBridge();
    const sender = makeSender();
    mocks.skipDefaultRunFinished = true;
    mocks.neverComplete = true;
    await runHandler({ sender }, { messages: [{ role: "user", content: "run" }], sessionId: "adj-2" });

    const result = await adjustHandler({ sender }, { sessionId: "adj-2", messageId: "q-1" });
    expect(result).toEqual({ ok: false, error: "no-safe-next-step", queue: [] });
    expect(mocks.markPendingAdjust).not.toHaveBeenCalled();
  });

  it("Work 模式活跃运行：以会话当前活跃 runId 标记插话并透传结果", async () => {
    mocks.getSession.mockReturnValue({
      id: "adj-3",
      mode: "work",
      workspaceBinding: { workspaceRoot: "C:\\workspace", displayName: "workspace", boundAt: 1 },
    });
    mocks.skipDefaultRunFinished = true;
    mocks.neverComplete = true;
    const { bridge, adjustHandler, runHandler } = await setupBridge();
    const sender = makeSender();
    const ack = await runHandler({ sender }, {
      messages: [{ role: "user", content: "执行任务" }],
      sessionId: "adj-3",
    }) as { runId: string };
    expect(bridge.__getSessionActiveRunForTest("adj-3")).toBe(ack.runId);

    mocks.markPendingAdjust.mockReturnValue({ ok: true, queue: [{ id: "q-1", adjustRunId: ack.runId }] });
    const result = await adjustHandler({ sender }, { sessionId: "adj-3", messageId: "q-1" });
    // 绑定的是会话当前活跃运行（会话级守卫是唯一可信来源）
    expect(mocks.markPendingAdjust).toHaveBeenCalledWith("adj-3", "q-1", ack.runId);
    expect(result).toEqual({
      ok: true,
      queue: [expect.objectContaining({ id: "q-1", adjustRunId: ack.runId })],
    });
  });

  it("v2 会话的 pending adjust 通过 composed loader，不因同步 getSession 为空而误报不存在", async () => {
    mocks.getSession.mockReturnValue(null);
    const record = {
      id: "adj-v2",
      title: "v2 调整",
      identityId: null,
      createdAt: 1,
      updatedAt: 1,
      schemaVersion: 2,
      messageCount: 0,
      mode: "work",
      workspaceBinding: { workspaceRoot: "C:\\workspace", displayName: "workspace", boundAt: 1 },
    };
    mocks.getSessionRecord.mockReturnValue(record);
    mocks.getPendingDispatch.mockReturnValue(null);
    mocks.composeSession.mockImplementation((_record: unknown, messages: unknown[]) => ({ ...record, schemaVersion: 1, messages }));
    mocks.getPendingMessages.mockReturnValue([]);
    const { bridge, adjustHandler, runHandler } = await setupBridge();
    const sender = makeSender();
    mocks.skipDefaultRunFinished = true;
    mocks.neverComplete = true;
    const ack = await runHandler({ sender }, {
      messages: [{ role: "user", content: "执行任务" }], sessionId: "adj-v2",
    }) as { runId: string };
    mocks.markPendingAdjust.mockReturnValue({ ok: true, queue: [{ id: "q-v2", adjustRunId: ack.runId }] });
    const result = await adjustHandler({ sender }, { sessionId: "adj-v2", messageId: "q-v2" });
    expect(bridge.__getSessionActiveRunForTest("adj-v2")).toBe(ack.runId);
    expect(mocks.markPendingAdjust).toHaveBeenCalledWith("adj-v2", "q-v2", ack.runId);
    expect(result).toEqual(expect.objectContaining({ ok: true }));
  });

  it("运行结束复位：run 结算后已标记未注入的条目清标记回普通队列", async () => {
    mocks.getSession.mockReturnValue({
      id: "adj-4",
      mode: "work",
      workspaceBinding: { workspaceRoot: "C:\\workspace", displayName: "workspace", boundAt: 1 },
    });
    const { bridge, runHandler } = await setupBridge();
    const sender = makeSender();
    const ack = await runHandler({ sender }, {
      messages: [{ role: "user", content: "很快结束" }],
      sessionId: "adj-4",
    }) as { runId: string };

    // run 自然结算（complete 回调 → endLifecycle）：插话标记按 runId 复位
    await vi.waitFor(() => expect(bridge.__getSessionActiveRunForTest("adj-4")).toBeUndefined());
    expect(mocks.resetPendingAdjustByRun).toHaveBeenCalledWith("adj-4", ack.runId);
  });

  it("buildOptions 失败的早期退出同样复位插话标记（消息不困在标记态）", async () => {
    mocks.getSession.mockReturnValue({
      id: "adj-5",
      mode: "work",
      workspaceBinding: { workspaceRoot: "C:\\workspace", displayName: "workspace", boundAt: 1 },
    });
    const { runHandler } = await setupBridge(async () => {
      throw new Error("boom: build options failed");
    });
    const sender = makeSender();

    await expect(runHandler({ sender }, {
      messages: [{ role: "user", content: "run" }],
      sessionId: "adj-5",
    })).rejects.toThrow("boom: build options failed");

    expect(mocks.resetPendingAdjustByRun).toHaveBeenCalled();
  });
});

describe("agui-bridge transcript dispatch", () => {
  const roots: string[] = [];

  function makeSender() {
    return { isDestroyed: () => false, send: () => {} };
  }

  afterEach(() => {
    for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
  });

  async function setupBridge(buildOptions?: (input: unknown) => Promise<unknown>) {
    vi.resetModules();
    mocks.handlers.clear();
    mocks.runCyreneAgent.mockClear();
    mocks.getSessionRecord.mockReset();
    mocks.getPendingDispatch.mockReset();
    mocks.composeSession.mockReset();
    const seenInputs: unknown[] = [];
    const bridge = await import("./agui-bridge");
    bridge.registerAgUiIpc(
      buildOptions ?? (async (input: unknown) => {
        seenInputs.push(input);
        return {
          options: {
            settings: { provider: "test", baseUrl: "", model: "", apiKey: "", contextWindowTokens: 256000 },
            messages: [],
            timeoutMs: 1000,
            toolSystemContent: "TOOL",
            soulSystemBaseContent: "SOUL",
          },
          latestUserText: "当前输入",
        };
      }),
      async () => {},
      () => null,
    );
    const runHandler = mocks.handlers.get(IPC.AGUI_RUN);
    if (!runHandler) throw new Error("AGUI_RUN handler was not registered");
    return { bridge, runHandler, seenInputs };
  }

  it("commits the turn to the transcript and flags transcript context before build options", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "cyrene-bridge-dispatch-"));
    roots.push(root);
    mocks.userDataRoot = root;
    mocks.getSession.mockReturnValue({
      id: "chat-transcript",
      mode: "chat",
      messages: [
        { id: "m1", role: "user", content: "旧问题", at: 1 },
        { id: "m2", role: "model", content: "旧回答", at: 2 },
        { id: "u1", role: "user", content: "当前输入", at: 3 },
      ],
    });
    const { runHandler, seenInputs } = await setupBridge();
    const sender = makeSender();

    await runHandler({ sender }, {
      messages: [{ role: "user", content: "当前输入" }],
      sessionId: "chat-transcript",
      userTurnId: "u1",
    });

    // buildOptions 收到主进程刚构建的权威模型上下文；不再有 renderer 回退开关
    expect(seenInputs[0]).toMatchObject({
      currentUser: { turnId: "u1", text: "当前输入", visibleContent: "当前输入" },
      modelContext: { messages: [
        { role: "user", content: "旧问题" },
        { role: "assistant", content: "旧回答" },
        { role: "user", content: "当前输入" },
      ] },
    });
    expect(seenInputs[0]).not.toHaveProperty("messages");

    // 派发前轨迹已落盘：回填边界 + 当前 user
    const { getConversationTranscriptStore } = await import("./orchestrator/conversation-transcript-store");
    const entries = (await getConversationTranscriptStore(root).read("chat-transcript")).entries;
    expect(entries.some((entry) => entry.kind === "backfill_boundary")).toBe(true);
    expect(entries.some((entry) => entry.kind === "user" && entry.turnId === "u1")).toBe(true);
    expect(entries.some((entry) => entry.kind === "assistant" && entry.payload.content === "旧回答")).toBe(true);
    mocks.userDataRoot = "";
  });

  it("在 append 前先完成 migration 与 pending reconcile，再构建模型上下文", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "cyrene-bridge-order-"));
    roots.push(root);
    mocks.userDataRoot = root;
    const session = { id: "order-session", mode: "chat" as const, messages: [] };
    const record = {
      id: "order-session",
      title: "order",
      identityId: null,
      createdAt: 1,
      updatedAt: 1,
      schemaVersion: 2,
      messageCount: 0,
      mode: "chat" as const,
    };
    mocks.getSession.mockReturnValue(session);
    const { runHandler } = await setupBridge();
    mocks.getSessionRecord.mockReturnValue(record);
    const { ConversationSessionMigration } = await import("./orchestrator/conversation-session-migration");
    const { ConversationJournalService } = await import("./orchestrator/conversation-journal-service");
    const order: string[] = [];
    const migration = vi.spyOn(ConversationSessionMigration.prototype, "ensureConversationMigrated")
      .mockImplementation(async () => { order.push("migration"); return null; });
    const reconcile = vi.spyOn(ConversationJournalService.prototype, "reconcilePendingWithdrawals")
      .mockImplementation(async () => { order.push("reconcile"); });
    const append = vi.spyOn(ConversationJournalService.prototype, "appendUser")
      .mockImplementation(async () => { order.push("append"); });
    const context = vi.spyOn(ConversationJournalService.prototype, "buildModelContext")
      .mockImplementation(async () => {
        order.push("context");
        return { conversationId: "order-session", messages: [] } as any;
      });
    try {
      await runHandler({ sender: makeSender() }, {
        sessionId: "order-session",
        currentUser: { turnId: "u1", text: "next", visibleContent: "next" },
      });
      expect(order).toEqual(["migration", "reconcile", "append", "context"]);
    } finally {
      migration.mockRestore();
      reconcile.mockRestore();
      append.mockRestore();
      context.mockRestore();
      mocks.userDataRoot = "";
    }
  });

  it("keeps callers without userTurnId on supplied messages without transcript context", async () => {
    mocks.getSession.mockReturnValue({ id: "chat-plain", mode: "chat" });
    const { runHandler, seenInputs } = await setupBridge();
    const sender = makeSender();

    await runHandler({ sender }, {
      messages: [{ role: "user", content: "channel text" }],
      sessionId: "chat-plain",
    });

    // 无 currentUser 的兼容调用不写轨迹，也不把 raw messages 传给 build-options
    expect(seenInputs[0]).not.toHaveProperty("modelContext");
    expect(seenInputs[0]).not.toHaveProperty("messages");
    const onFinishedNotStarted = mocks.runCyreneAgent;
    expect(onFinishedNotStarted).toHaveBeenCalled();
    // 轨迹提交端同样不得注入：否则模型回写没有对应 user 的孤立 assistant 条目
    const sink = (mocks.runCyreneAgent.mock.calls.at(-1)?.[0] as { transcriptSink?: unknown }).transcriptSink;
    expect(sink).toBeUndefined();
  });

  it("does not start the model when the transcript write fails", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "cyrene-bridge-fail-"));
    roots.push(root);
    mocks.userDataRoot = root;
    // 旧 userTurnId 指向的消息不存在 → 兼容锚点拒绝（fail-closed）
    mocks.getSession.mockReturnValue({
      id: "chat-fail",
      mode: "chat",
      messages: [{ id: "m1", role: "user", content: "旧问题", at: 1 }],
    });
    const { runHandler, seenInputs } = await setupBridge();
    const sender = makeSender();

    await expect(runHandler({ sender }, {
      sessionId: "chat-fail",
      userTurnId: "missing-turn",
    })).rejects.toThrow("TRANSCRIPT_USER_TURN_NOT_FOUND");

    // 模型不得启动：buildOptions 未被调用
    expect(seenInputs).toHaveLength(0);
    expect(mocks.runCyreneAgent).not.toHaveBeenCalled();
    mocks.userDataRoot = "";
  });

  it("桌面 dispatch 始终使用 journal 上下文，环境变量不能切换 renderer 回退", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "cyrene-bridge-rollback-"));
    roots.push(root);
    mocks.userDataRoot = root;
    mocks.getSession.mockReturnValue({
      id: "chat-rollback",
      mode: "chat",
      messages: [
        { id: "m1", role: "user", content: "旧问题", at: 1 },
        { id: "u1", role: "user", content: "当前输入", at: 2 },
      ],
    });
    const { runHandler, seenInputs } = await setupBridge();
    const sender = makeSender();
    try {
      await runHandler({ sender }, {
        sessionId: "chat-rollback",
        currentUser: { turnId: "u1", text: "当前输入", visibleContent: "当前输入" },
      });

      expect(seenInputs[0]).toMatchObject({ currentUser: { turnId: "u1" }, modelContext: expect.any(Object) });
      const { getConversationTranscriptStore } = await import("./orchestrator/conversation-transcript-store");
      const entries = (await getConversationTranscriptStore(root).read("chat-rollback")).entries;
      expect(entries.some((entry) => entry.kind === "backfill_boundary")).toBe(true);
      expect(entries.some((entry) => entry.kind === "user" && entry.turnId === "u1")).toBe(true);
    } finally {
      mocks.userDataRoot = "";
    }
  });

  it.each(["chat", "work", "code", "learn"] as const)(
    "%s 模式忽略 renderer 恶意历史并使用 journal 权威上下文",
    async (mode) => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), `cyrene-bridge-${mode}-`));
      roots.push(root);
      mocks.userDataRoot = root;
      const record = {
        id: `journal-${mode}`,
        title: mode,
        identityId: null,
        createdAt: 1,
        updatedAt: 1,
        schemaVersion: 2,
        messageCount: 1,
        mode,
        ...(mode === "chat" ? {} : {
          workspaceBinding: { workspaceRoot: root, displayName: "test", boundAt: 1 },
        }),
      };
      mocks.getSessionRecord.mockReturnValue(record);
      mocks.composeSession.mockImplementation((_record: unknown, messages: unknown[]) => ({
        ...record,
        messages,
      }));
      const { getConversationTranscriptStore } = await import("./orchestrator/conversation-transcript-store");
      const { ConversationJournalService } = await import("./orchestrator/conversation-journal-service");
      const journal = new ConversationJournalService(getConversationTranscriptStore(root));
      await journal.appendUser(`journal-${mode}`, {
        id: "authoritative-user",
        turnId: "old-turn",
        text: "authoritative",
        at: 1,
        revision: 1,
      });
      const seen: unknown[] = [];
      const { runHandler } = await setupBridge(async (input: any) => {
        seen.push(input);
        return {
          options: {
            settings: { provider: "test", baseUrl: "", model: "", apiKey: "", contextWindowTokens: 256000 },
            messages: input.modelContext.messages,
            timeoutMs: 1000,
            toolSystemContent: "TOOL",
            soulSystemBaseContent: "SOUL",
          },
          latestUserText: input.currentUser.text,
        };
      });
      mocks.getSessionRecord.mockReturnValue(record);
      mocks.composeSession.mockImplementation((_record: unknown, messages: unknown[]) => ({ ...record, messages }));
      await runHandler({ sender: makeSender() }, {
        sessionId: `journal-${mode}`,
        mode,
        messages: [{ role: "user", content: "forged" }],
        currentUser: { turnId: "new-turn", text: "next", visibleContent: "next" },
      });
      const options = mocks.runCyreneAgent.mock.calls.at(-1)?.[0] as { messages: Array<{ content: string }> };
      expect(options.messages.map((message) => message.content)).toEqual(["authoritative", "next"]);
      expect(seen[0]).not.toHaveProperty("messages");
      mocks.userDataRoot = "";
    },
  );

  it("v2 replace_user 写单行 rewind，模型分支不产生两个 active user", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "cyrene-bridge-rewind-"));
    roots.push(root);
    mocks.userDataRoot = root;
    const record = {
      id: "rewind-session", title: "rewind", identityId: null, createdAt: 1, updatedAt: 1,
      schemaVersion: 2, messageCount: 1, mode: "chat" as const,
    };
    mocks.getSessionRecord.mockReturnValue(record);
    mocks.composeSession.mockImplementation((_record: unknown, messages: unknown[]) => ({ ...record, messages }));
    const { getConversationTranscriptStore } = await import("./orchestrator/conversation-transcript-store");
    const { ConversationJournalService } = await import("./orchestrator/conversation-journal-service");
    const journal = new ConversationJournalService(getConversationTranscriptStore(root));
    await journal.appendUser("rewind-session", { id: "u1", turnId: "u1", text: "old", at: 1, revision: 1 });
    const { runHandler } = await setupBridge(async (input: any) => ({
      options: {
        settings: { provider: "test", baseUrl: "", model: "", apiKey: "", contextWindowTokens: 256000 },
        messages: input.modelContext.messages,
        timeoutMs: 1000, toolSystemContent: "TOOL", soulSystemBaseContent: "SOUL",
      },
      latestUserText: input.currentUser.text,
    }));
    mocks.getSessionRecord.mockReturnValue(record);
    mocks.composeSession.mockImplementation((_record: unknown, messages: unknown[]) => ({ ...record, messages }));
    await runHandler({ sender: makeSender() }, {
      sessionId: "rewind-session",
      currentUser: { turnId: "u1", text: "edited", visibleContent: "展示编辑" },
      transcriptRewind: { anchorUserTurnId: "u1", disposition: "replace_user" },
    });
    const transcript = await getConversationTranscriptStore(root).read("rewind-session");
    expect(transcript.entries.filter((entry) => entry.kind === "user")).toHaveLength(1);
    expect(transcript.entries.filter((entry) => entry.kind === "turn_rewind")).toHaveLength(1);
    const model = await journal.buildModelContext("rewind-session");
    expect(model.messages.filter((message) => message.role === "user").map((message) => message.content)).toEqual(["edited"]);
    mocks.userDataRoot = "";
  });

  it("v2 keep_user regenerate 只追加 rewind，不追加或 patch user", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "cyrene-bridge-keep-"));
    roots.push(root);
    mocks.userDataRoot = root;
    const record = {
      id: "keep-session", title: "keep", identityId: null, createdAt: 1, updatedAt: 1,
      schemaVersion: 2, messageCount: 1, mode: "chat" as const,
    };
    const { runHandler } = await setupBridge(async (input: any) => ({
      options: {
        settings: { provider: "test", baseUrl: "", model: "", apiKey: "", contextWindowTokens: 256000 },
        messages: input.modelContext.messages,
        timeoutMs: 1000, toolSystemContent: "TOOL", soulSystemBaseContent: "SOUL",
      },
      latestUserText: input.currentUser.text,
    }));
    mocks.getSessionRecord.mockReturnValue(record);
    mocks.composeSession.mockImplementation((_record: unknown, messages: unknown[]) => ({ ...record, messages }));
    const { getConversationTranscriptStore } = await import("./orchestrator/conversation-transcript-store");
    const { ConversationJournalService } = await import("./orchestrator/conversation-journal-service");
    const journal = new ConversationJournalService(getConversationTranscriptStore(root));
    await journal.appendUser("keep-session", { id: "u1", turnId: "u1", text: "old", at: 1, revision: 1 });
    await runHandler({ sender: makeSender() }, {
      sessionId: "keep-session",
      currentUser: { turnId: "u1", text: "old", visibleContent: "new visible", sticker: "wave" },
      transcriptRewind: { anchorUserTurnId: "u1", disposition: "keep_user" },
    });
    const transcript = await getConversationTranscriptStore(root).read("keep-session");
    expect(transcript.entries.filter((entry) => entry.kind === "user")).toHaveLength(1);
    expect(transcript.entries.filter((entry) => entry.kind === "turn_rewind")).toHaveLength(1);
    expect(transcript.entries.filter((entry) => entry.kind === "presentation_patch")).toHaveLength(0);
    mocks.userDataRoot = "";
  });

  it.each([
    ["canonical", "appendUser"],
    ["presentation", "appendPresentation"],
    ["model context", "buildModelContext"],
  ] as const)("%s 失败时 fail-closed，不启动模型", async (_label, method) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "cyrene-bridge-fail-closed-"));
    roots.push(root);
    mocks.userDataRoot = root;
    const record = {
      id: "fail-closed", title: "fail", identityId: null, createdAt: 1, updatedAt: 1,
      schemaVersion: 2, messageCount: 0, mode: "chat" as const,
    };
    mocks.getSessionRecord.mockReturnValue(record);
    mocks.composeSession.mockImplementation((_record: unknown, messages: unknown[]) => ({ ...record, messages }));
    const seen: unknown[] = [];
    const { runHandler } = await setupBridge(async (input: unknown) => {
      seen.push(input);
      return {
        options: { settings: { provider: "test", baseUrl: "", model: "", apiKey: "", contextWindowTokens: 256000 }, messages: [], timeoutMs: 1000, toolSystemContent: "TOOL", soulSystemBaseContent: "SOUL" },
        latestUserText: "next",
      };
    });
    mocks.getSessionRecord.mockReturnValue(record);
    mocks.composeSession.mockImplementation((_record: unknown, messages: unknown[]) => ({ ...record, messages }));
    const { ConversationJournalService } = await import("./orchestrator/conversation-journal-service");
    const failure = vi.spyOn(ConversationJournalService.prototype, method as "appendUser" | "appendPresentation" | "buildModelContext")
      .mockRejectedValueOnce(new Error(`FAIL_${method}`));
    await expect(runHandler({ sender: makeSender() }, {
      sessionId: "fail-closed",
      currentUser: { turnId: "u1", text: "next", visibleContent: "展示" },
    })).rejects.toThrow(`FAIL_${method}`);
    expect(seen).toHaveLength(0);
    expect(mocks.runCyreneAgent).not.toHaveBeenCalled();
    failure.mockRestore();
    mocks.userDataRoot = "";
  });

  it("合并轨迹不确定效果与派发侧 recoveryContext，不互相覆盖", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "cyrene-bridge-recovery-"));
    roots.push(root);
    mocks.userDataRoot = root;
    mocks.getSession.mockReturnValue({
      id: "chat-recovery-merge",
      mode: "chat",
      messages: [
        { id: "m1", role: "user", content: "旧问题", at: 1 },
        { id: "u1", role: "user", content: "当前输入", at: 2 },
      ],
    });
    const { runHandler } = await setupBridge(async (input: unknown) => ({
      options: {
        settings: { provider: "test", baseUrl: "", model: "", apiKey: "", contextWindowTokens: 256000 },
        messages: [],
        timeoutMs: 1000,
        toolSystemContent: "TOOL",
        soulSystemBaseContent: "SOUL",
        recoveryContext: "轨迹侧：上次运行有未确认副作用",
      },
      latestUserText: "当前输入",
    }));
    const sender = makeSender();

    await runHandler({ sender }, {
      messages: [{ role: "user", content: "当前输入" }],
      sessionId: "chat-recovery-merge",
      userTurnId: "u1",
      recoveryContext: "派发侧：渠道恢复上下文",
    });

    const agentOptions = mocks.runCyreneAgent.mock.calls[0]?.[0] as { recoveryContext?: string };
    expect(agentOptions?.recoveryContext).toContain("轨迹侧：上次运行有未确认副作用");
    expect(agentOptions?.recoveryContext).toContain("派发侧：渠道恢复上下文");
    mocks.userDataRoot = "";
  });

  // ── 四模式连续性验收：下一轮模型请求由权威轨迹物化（CTA Phase 1）──
  it.each(["chat", "work", "code", "learn"] as const)(
    "%s 模式下一轮模型请求使用权威轨迹上下文",
    async (mode) => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), "cyrene-bridge-modes-"));
      roots.push(root);
      mocks.userDataRoot = root;
      const conversationId = `conv-${mode}`;
      // work/code/learn 派发前必须绑定工作区；chat 不需要
      const sessionShape = (messages: unknown[]) => ({
        id: conversationId,
        mode,
        ...(mode !== "chat" ? { workspaceBinding: { workspaceRoot: "E:\\tmp\\workspace" } } : {}),
        messages,
      });
      mocks.getSession.mockReturnValue(sessionShape([
        { id: "turn-1", role: "user", content: "first-user", at: 1 },
      ]));

      // 物化函数占位：setupBridge 触发 resetModules 之后才能 import（保证与 bridge 共享单例）
      let materialize: () => Promise<unknown[]> = async () => [];
      const { runHandler } = await setupBridge(async (input: unknown) => ({
        options: {
          settings: { provider: "test", baseUrl: "", model: "", apiKey: "", contextWindowTokens: 256000 },
          messages: await materialize(),
          timeoutMs: 1000,
          toolSystemContent: "TOOL",
          soulSystemBaseContent: "SOUL",
        },
        latestUserText: (input as { messages?: Array<{ content?: string }> }).messages?.at(-1)?.content ?? "",
      }));
      const { getConversationTranscriptStore } = await import("./orchestrator/conversation-transcript-store");
      const { buildModelContext, resolveTranscriptRetainTokens } = await import("./orchestrator/conversation-transcript-context");
      const retainTokens = resolveTranscriptRetainTokens(256_000);
      const noRuns = { get: () => null };
      materialize = async () => (await buildModelContext({
        store: getConversationTranscriptStore(root),
        conversationId,
        retainTokens,
        runReader: noRuns,
      })).messages;
      const sender = makeSender();
      const lastModelRequestMessages = () =>
        (mocks.runCyreneAgent.mock.calls.at(-1)?.[0] as { messages: Array<Record<string, unknown>> }).messages;
      // bridge 实际注入的轨迹提交端（生产接线断言，不手工绕路）
      const sinkOfLastCall = () =>
        (mocks.runCyreneAgent.mock.calls.at(-1)?.[0] as { transcriptSink?: import("./orchestrator/transcript-sink").TranscriptSink }).transcriptSink;

      // 第一轮：当前 user 落盘，run 级提交端写入 canonical assistant
      await runHandler({ sender }, {
        messages: [{ role: "user", content: "first-user" }],
        sessionId: conversationId,
        userTurnId: "turn-1",
      });
      const firstSink = sinkOfLastCall();
      expect(firstSink).toBeDefined();
      // work/code/learn：第一轮含工具调用与 canonical 工具结果；chat：纯文本（ChatLoop 单轮路径）
      const assistantEntryId = await firstSink!.appendAssistant({
        message: mode === "chat"
          ? { role: "assistant", content: "first-assistant" }
          : {
            role: "assistant",
            content: "first-assistant",
            toolCalls: [{ id: "call-1", name: "read_file", arguments: '{"path":"a.txt"}' }],
          },
      });
      if (mode !== "chat") {
        await firstSink.appendToolResult({
          assistantEntryId,
          message: { role: "tool", toolCallId: "call-1", name: "read_file", content: "文件内容" },
          outcome: "success",
        });
      }

      // 第二轮派发：渲染端已收到 assistant；回填 boundary 已存在，连续性只能来自权威轨迹
      mocks.getSession.mockReturnValue(sessionShape([
        { id: "turn-1", role: "user", content: "first-user", at: 1 },
        { id: "a-1", role: "model", content: "first-assistant", at: 2 },
        { id: "turn-2", role: "user", content: "second-user", at: 3 },
      ]));
      await runHandler({ sender }, {
        messages: [{ role: "user", content: "second-user" }],
        sessionId: conversationId,
        userTurnId: "turn-2",
      });

      const messages = lastModelRequestMessages();
      expect(messages).toEqual(expect.arrayContaining([
        expect.objectContaining({ role: "user", content: "first-user" }),
        expect.objectContaining({ role: "assistant", content: "first-assistant" }),
        expect.objectContaining({ role: "user", content: "second-user" }),
      ]));
      if (mode !== "chat") {
        // canonical 工具结果随轨迹重放，声明与结果保持配对
        expect(messages).toEqual(expect.arrayContaining([
          expect.objectContaining({ role: "tool", toolCallId: "call-1", content: "文件内容" }),
        ]));
      }
      // 四模式各走各的执行通道：chat 单请求链路，其余走 harness 执行模式
      const lastOptions = mocks.runCyreneAgent.mock.calls.at(-1)?.[0] as { executionMode?: string };
      expect(lastOptions.executionMode).toBe(mode === "chat" ? "chat" : "work");
      mocks.userDataRoot = "";
    },
  );

  it("chat 模式跨工具开关保持轨迹连续（ChatLoop 与 Harness 共用权威轨迹）", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "cyrene-bridge-chat-tools-"));
    roots.push(root);
    mocks.userDataRoot = root;
    const conversationId = "conv-chat-tools";
    const sessionShape = (messages: unknown[]) => ({ id: conversationId, mode: "chat", messages });
    mocks.getSession.mockReturnValue(sessionShape([
      { id: "turn-1", role: "user", content: "first-user", at: 1 },
    ]));

    let materialize: () => Promise<unknown[]> = async () => [];
    const { runHandler } = await setupBridge(async (input: unknown) => ({
      options: {
        settings: { provider: "test", baseUrl: "", model: "", apiKey: "", contextWindowTokens: 256000 },
        messages: await materialize(),
        timeoutMs: 1000,
        toolSystemContent: "TOOL",
        soulSystemBaseContent: "SOUL",
      },
      latestUserText: (input as { messages?: Array<{ content?: string }> }).messages?.at(-1)?.content ?? "",
    }));
    const { getConversationTranscriptStore } = await import("./orchestrator/conversation-transcript-store");
    const { buildModelContext, resolveTranscriptRetainTokens } = await import("./orchestrator/conversation-transcript-context");
    const retainTokens = resolveTranscriptRetainTokens(256_000);
    materialize = async () => (await buildModelContext({
      store: getConversationTranscriptStore(root),
      conversationId,
      retainTokens,
      runReader: { get: () => null },
    })).messages;
    const sender = makeSender();
    const lastModelRequestMessages = () =>
      (mocks.runCyreneAgent.mock.calls.at(-1)?.[0] as { messages: Array<Record<string, unknown>> }).messages;
    // bridge 实际注入的轨迹提交端（生产接线断言，不手工绕路）
    const sinkOfLastCall = () =>
      (mocks.runCyreneAgent.mock.calls.at(-1)?.[0] as { transcriptSink?: import("./orchestrator/transcript-sink").TranscriptSink }).transcriptSink;

    // 轮次 1：无工具（ChatLoop 单请求路径，assistant 无 roundId）
    await runHandler({ sender }, {
      messages: [{ role: "user", content: "first-user" }],
      sessionId: conversationId,
      userTurnId: "turn-1",
    });
    const chatSink = sinkOfLastCall();
    expect(chatSink).toBeDefined();
    await chatSink!.appendAssistant({ message: { role: "assistant", content: "first-assistant" } });

    // 轮次 2：启用工具（Harness 路径，含工具调用与 canonical 结果）
    mocks.getSession.mockReturnValue(sessionShape([
      { id: "turn-1", role: "user", content: "first-user", at: 1 },
      { id: "a-1", role: "model", content: "first-assistant", at: 2 },
      { id: "turn-2", role: "user", content: "second-user", at: 3 },
    ]));
    await runHandler({ sender }, {
      messages: [{ role: "user", content: "second-user" }],
      sessionId: conversationId,
      userTurnId: "turn-2",
    });
    const harnessSink = sinkOfLastCall();
    expect(harnessSink).toBeDefined();
    const harnessAssistantEntryId = await harnessSink!.appendAssistant({
      message: {
        role: "assistant",
        content: "second-assistant",
        toolCalls: [{ id: "call-1", name: "read_file", arguments: '{"path":"a.txt"}' }],
      },
    });
    await harnessSink.appendToolResult({
      assistantEntryId: harnessAssistantEntryId,
      message: { role: "tool", toolCallId: "call-1", name: "read_file", content: "工具结果" },
      outcome: "success",
    });

    // 轮次 3：再关闭工具（回到 ChatLoop），三轮历史必须在同一条轨迹里保持连续
    mocks.getSession.mockReturnValue(sessionShape([
      { id: "turn-1", role: "user", content: "first-user", at: 1 },
      { id: "a-1", role: "model", content: "first-assistant", at: 2 },
      { id: "turn-2", role: "user", content: "second-user", at: 3 },
      { id: "a-2", role: "model", content: "second-assistant", at: 4 },
      { id: "turn-3", role: "user", content: "third-user", at: 5 },
    ]));
    await runHandler({ sender }, {
      messages: [{ role: "user", content: "third-user" }],
      sessionId: conversationId,
      userTurnId: "turn-3",
    });

    expect(lastModelRequestMessages()).toEqual(expect.arrayContaining([
      expect.objectContaining({ role: "user", content: "first-user" }),
      expect.objectContaining({ role: "assistant", content: "first-assistant" }),
      expect.objectContaining({ role: "user", content: "second-user" }),
      expect.objectContaining({ role: "assistant", content: "second-assistant" }),
      expect.objectContaining({ role: "tool", toolCallId: "call-1", content: "工具结果" }),
      expect.objectContaining({ role: "user", content: "third-user" }),
    ]));
    mocks.userDataRoot = "";
  });
});
