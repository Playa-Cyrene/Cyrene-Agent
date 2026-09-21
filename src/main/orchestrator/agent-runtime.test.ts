import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { PluginManager } from "../../plugins/manager";
import { createPluginPromptRegistry } from "../../plugins/prompts";
import type { PluginRuntime } from "../../plugins/context";
import type { ScheduledTask } from "../scheduler/types";
import { createAgentRuntime, type AgentRuntimeDeps } from "./agent-runtime";

const mocks = vi.hoisted(() => ({
  onAgentRunFinished: vi.fn(),
  buildAlwaysOnContext: vi.fn(),
  scheduleMemoryWrite: vi.fn(),
}));

// electron 模块 mock：agent-runtime 装配的轨迹 store 根目录指向可控临时目录
const electronMocks = vi.hoisted(() => ({ userDataRoot: "" }));
vi.mock("electron", () => ({ app: { getPath: () => electronMocks.userDataRoot } }));

let tmp = "";
let pluginManager: PluginManager | undefined;

vi.mock("./build-options", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./build-options")>();
  return { ...actual, onAgentRunFinished: mocks.onAgentRunFinished };
});

// 常驻上下文与记忆写入会触达真实磁盘 store，测试中统一替换为可控桩
vi.mock("./index", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./index")>();
  return {
    ...actual,
    buildAlwaysOnContext: mocks.buildAlwaysOnContext,
    scheduleMemoryWrite: mocks.scheduleMemoryWrite,
  };
});

function createDeps(
  publishPluginHostEvent: AgentRuntimeDeps["publishPluginHostEvent"],
): AgentRuntimeDeps {
  return {
    runtimeStateService: {
      getState: () => ({ status: "idle", expression: 0, updatedAt: 0 }),
    },
    getStickerEmbeddingIndex: () => undefined,
    publishPluginHostEvent,
  } as unknown as AgentRuntimeDeps;
}

describe("AgentRuntime 插件宿主事件", () => {
  beforeEach(() => {
    mocks.onAgentRunFinished.mockReset();
    mocks.onAgentRunFinished.mockResolvedValue({ sticker: null });
  });

  afterEach(async () => {
    await pluginManager?.stop();
    pluginManager = undefined;
    if (tmp) rmSync(tmp, { recursive: true, force: true });
    tmp = "";
    vi.restoreAllMocks();
  });

  it("成功收尾后仅发布轮次元数据且不等待插件监听器", async () => {
    let releaseListener!: () => void;
    const listenerPending = new Promise<void>((resolve) => { releaseListener = resolve; });
    const publishPluginHostEvent = vi.fn(() => listenerPending);
    const runtime = createAgentRuntime(createDeps(publishPluginHostEvent));

    await expect(runtime.onRunFinished(
      { reply: "回复", toolResults: [] },
      "问题",
      {
        source: "desktop",
        mode: "chat",
        conversationId: "conversation-1",
        runId: "run-1",
      },
    )).resolves.toEqual({ sticker: null });

    expect(publishPluginHostEvent).toHaveBeenCalledWith("turn:completed", {
      source: "desktop",
      mode: "chat",
      conversationId: "conversation-1",
      runId: "run-1",
    });
    releaseListener();
  });

  it("渠道来源的成功轮次事件携带 channel 字段", async () => {
    const publishPluginHostEvent = vi.fn(async () => {});
    const runtime = createAgentRuntime(createDeps(publishPluginHostEvent));

    await runtime.onRunFinished(
      { reply: "回复", toolResults: [] },
      "问题",
      {
        source: "channel",
        mode: "chat",
        conversationId: "conversation-channel",
        channel: "wechat",
      },
    );

    expect(publishPluginHostEvent).toHaveBeenCalledWith("turn:completed", {
      source: "channel",
      mode: "chat",
      conversationId: "conversation-channel",
      channel: "wechat",
    });
  });

  it.each(["timeout", "cancelled", "runtime_error"] as const)(
    "非成功终态 %s 不发布轮次完成事件",
    async (status) => {
      const publishPluginHostEvent = vi.fn(async () => {});
      const runtime = createAgentRuntime(createDeps(publishPluginHostEvent));

      await runtime.onRunFinished(
        {
          reply: "未成功结束的部分回复",
          toolResults: [],
          terminal: {
            status,
            reason: "未成功结束",
            externalEffectsMayContinue: true,
          },
        },
        "问题",
        { source: "desktop", mode: "chat", conversationId: "conversation-not-completed" },
      );

      expect(publishPluginHostEvent).not.toHaveBeenCalled();
    },
  );

  it("成功收尾后通过真实 PluginManager 和 EventBus 到达插件监听器", async () => {
    tmp = mkdtempSync(path.join(os.tmpdir(), "cyrene-turn-event-"));
    const pluginDir = path.join(tmp, "listener");
    const marker = path.join(tmp, "received.json");
    mkdirSync(pluginDir, { recursive: true });
    writeFileSync(path.join(pluginDir, "manifest.json"), JSON.stringify({
      apiVersion: 1,
      id: "listener",
      name: "listener",
      version: "1.0.0",
      description: "test listener",
      author: "test",
      entry: "index.cjs",
      defaultEnabled: true,
    }), "utf8");
    writeFileSync(path.join(pluginDir, "index.cjs"), `
      const fs = require("node:fs");
      module.exports = { register(ctx) {
        ctx.events.on("host:turn:completed", (payload) => {
          fs.writeFileSync(${JSON.stringify(marker)}, JSON.stringify(payload));
        });
      } };
    `, "utf8");

    const runtime: PluginRuntime = {
      toolRegistry: { register: () => {}, unregister: () => true },
      channelManager: { has: () => false, register: () => {}, unregister: async () => true, startOne: async () => {} },
      registerIpc: () => {},
      unregisterIpc: () => {},
      promptRegistry: createPluginPromptRegistry(),
    };
    pluginManager = new PluginManager({
      scanRoots: [{ path: tmp, source: "builtin" }],
      storageRoot: path.join(tmp, "storage"),
      runtime,
      loadEnabledMap: () => ({}),
      saveEnabledMap: () => {},
    });
    await pluginManager.start();

    const agentRuntime = createAgentRuntime(createDeps(
      (event, payload) => pluginManager!.publishHostEvent(event, payload),
    ));
    await agentRuntime.onRunFinished(
      { reply: "真实回复", toolResults: [] },
      "真实问题",
      {
        source: "desktop",
        mode: "chat",
        conversationId: "conversation-real",
        runId: "run-real",
      },
    );

    await expect.poll(() => existsSync(marker)).toBe(true);
    expect(JSON.parse(readFileSync(marker, "utf8"))).toEqual({
      source: "desktop",
      mode: "chat",
      conversationId: "conversation-real",
      runId: "run-real",
    });
  });

  it("宿主收尾失败时不发布成功完成事件", async () => {
    mocks.onAgentRunFinished.mockRejectedValueOnce(new Error("收尾失败"));
    const publishPluginHostEvent = vi.fn(async () => {});
    const runtime = createAgentRuntime(createDeps(publishPluginHostEvent));

    await expect(runtime.onRunFinished(
      { reply: "不会发布", toolResults: [] },
      "问题",
      { source: "desktop", mode: "chat", conversationId: "conversation-failed" },
    )).rejects.toThrow("收尾失败");
    expect(publishPluginHostEvent).not.toHaveBeenCalled();
  });

  it("插件事件发布失败不改变宿主收尾结果", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const runtime = createAgentRuntime(createDeps(async () => {
      throw new Error("监听器失败");
    }));

    await expect(runtime.onRunFinished(
      { reply: "正常回复", toolResults: [] },
      "问题",
      { source: "desktop", mode: "chat", conversationId: "conversation-listener-failed" },
    )).resolves.toEqual({ sticker: null });
    await expect.poll(() => warn.mock.calls.length).toBe(1);
  });

  it("buildOptions 注入工具完成观察回调并转发给发布入口", async () => {
    const buildOptionsModule = await import("./build-options");
    const spy = vi.spyOn(buildOptionsModule, "buildAgentRunOptions").mockResolvedValue({
      options: { toolSystemContent: "", soulSystemBaseContent: "" },
      latestUserText: "问题",
    });
    try {
      const publishToolFinished = vi.fn();
      const runtime = createAgentRuntime({
        ...createDeps(vi.fn()),
        publishToolFinished,
      });

      const built = await runtime.buildOptions({} as never);
      expect(built.options.onToolFinished).toBeTypeOf("function");
      const event = {
        toolId: "write_file",
        toolCallId: "call-1",
        runId: "run-1",
        status: "success",
        risk: "fs-write",
        durationMs: 5,
      } as const;
      built.options.onToolFinished!(event);
      expect(publishToolFinished).toHaveBeenCalledWith(event);

      // 未配置发布入口时不注入，harness 侧零开销
      const runtimeWithoutPublisher = createAgentRuntime(createDeps(vi.fn()));
      const builtWithoutPublisher = await runtimeWithoutPublisher.buildOptions({} as never);
      expect(builtWithoutPublisher.options.onToolFinished).toBeUndefined();
    } finally {
      spy.mockRestore();
    }
  });
});

/** 顶层镜像故意留空并配一个默认档案：验证各入口走档案展开而不是顶层三件套。 */
function modelSettingsFixture() {
  return {
    mode: "manual" as const,
    provider: "",
    baseUrl: "",
    model: "",
    apiKey: "",
    multimodal: false,
    perProvider: {},
    modelProfiles: [{
      id: "profile-1",
      provider: "测试厂商",
      baseUrl: "https://profile.example/v1",
      model: "profile-model",
      apiKey: "profile-key",
      explicitTransport: "anthropic",
    }],
  };
}

/** 覆盖装配链路的完整依赖桩：所有外部依赖都是可控的 vi.fn。 */
function createFullDeps(overrides?: Partial<AgentRuntimeDeps>): AgentRuntimeDeps {
  return {
    runtimeStateService: {
      getState: () => ({ status: "idle", expression: 0, updatedAt: 0 }),
      smoothFeeling: vi.fn(),
      inferFromText: vi.fn(() => ({ status: "idle" })),
      setStateWithoutNotify: vi.fn(),
    },
    llmClient: { chat: vi.fn() },
    enqueueLLMTask: vi.fn(async (_label: string, task: () => Promise<unknown>) => task()),
    loadModelSettings: () => modelSettingsFixture(),
    loadGeneralSettings: () => ({ skillModeOverrides: { chat: ["skill-a"] } }),
    loadUserProfile: () => ({}),
    toolRegistry: {
      getEnabledTools: vi.fn(() => []),
      getEnabledToolsForMode: vi.fn(() => []),
    },
    skillRegistry: {
      getEnabled: vi.fn(() => []),
      getEnabledForMode: vi.fn(() => []),
      getBody: vi.fn(() => null),
    },
    getStickerEmbeddingIndex: () => undefined,
    getEmbeddingProvider: () => undefined,
    broadcastRuntimeStateChanged: vi.fn(),
    citaService: { prepareTurn: vi.fn(async () => "cita-turn") },
    socialContextScheduler: { schedule: vi.fn() },
    chatsStore: { getWorkspaceBinding: vi.fn(() => ({ workspaceRoot: "E:/ws", displayName: "ws", boundAt: 1 })) },
    socialAtomStore: { listActive: vi.fn(() => []) },
    buildPluginPromptContext: vi.fn(async () => "[插件提示词上下文]"),
    publishPluginHostEvent: vi.fn(async () => {}),
    ...overrides,
  } as unknown as AgentRuntimeDeps;
}

function createScheduledTask(input: Partial<ScheduledTask>): ScheduledTask {
  return {
    id: "task-1",
    title: "测试任务",
    prompt: "整理下载目录",
    enabled: true,
    schedule: { type: "daily", time: "09:00" },
    nextFireAt: null,
    toolMode: "disabled",
    allowedToolIds: [],
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...input,
  } as ScheduledTask;
}

describe("AgentRuntime buildSchedulerOptions", () => {
  beforeEach(() => {
    mocks.buildAlwaysOnContext.mockReset();
    mocks.buildAlwaysOnContext.mockResolvedValue("[常驻上下文]");
  });

  it("默认按 work 模式装配：档案展开模型设置、skill 按模式过滤、提示词分层拼接", async () => {
    const deps = createFullDeps();
    const runtime = createAgentRuntime(deps);

    const options = await runtime.buildSchedulerOptions(createScheduledTask({ prompt: "整理下载目录" }));

    // 模型设置来自默认档案（顶层三件套为空也不能让定时任务调不到 LLM）
    expect(options.settings).toMatchObject({
      provider: "测试厂商",
      baseUrl: "https://profile.example/v1",
      model: "profile-model",
      apiKey: "profile-key",
      explicitTransport: "anthropic",
    });
    // work 模式：skill 按模式 + 用户覆盖层过滤
    expect(deps.skillRegistry.getEnabledForMode).toHaveBeenCalledWith("work", { chat: ["skill-a"] });
    // 系统提示词包含常驻上下文与插件上下文，分层用 --- 拼接
    const systemMessage = options.messages[0];
    expect(systemMessage.role).toBe("system");
    expect(systemMessage.content).toContain("[常驻上下文]");
    expect(systemMessage.content).toContain("[插件提示词上下文]");
    expect(systemMessage.content).toContain("---");
    expect(deps.buildPluginPromptContext).toHaveBeenCalledWith({
      source: "scheduler",
      mode: "work",
      userText: "整理下载目录",
    });
    // 用户消息原样透传任务 prompt
    expect(options.messages[1]).toEqual({ role: "user", content: "整理下载目录" });
    // 定时任务不因整轮耗时被中断
    expect(options.timeoutMs).toBe(0);
    // 未配置发布入口时不注入工具完成回调
    expect(options.onToolFinished).toBeUndefined();
  });

  it("chat 模式不暴露 skill，插件上下文跟随任务冻结的模式", async () => {
    const deps = createFullDeps();
    const runtime = createAgentRuntime(deps);

    await runtime.buildSchedulerOptions(createScheduledTask({ prompt: "说早安", mode: "chat" }));

    expect(deps.skillRegistry.getEnabledForMode).not.toHaveBeenCalled();
    expect(deps.buildPluginPromptContext).toHaveBeenCalledWith({
      source: "scheduler",
      mode: "chat",
      userText: "说早安",
    });
  });

  it("配置了发布入口时注入工具完成观察回调并转发", async () => {
    const publishToolFinished = vi.fn();
    const deps = createFullDeps({ publishToolFinished });
    const runtime = createAgentRuntime(deps);

    const options = await runtime.buildSchedulerOptions(createScheduledTask({}));
    expect(options.onToolFinished).toBeTypeOf("function");

    const event = {
      toolId: "run_shell",
      toolCallId: "call-9",
      runId: "run-9",
      status: "success",
      risk: "shell",
      durationMs: 12,
    } as const;
    options.onToolFinished!(event);
    expect(publishToolFinished).toHaveBeenCalledWith(event);
  });
});

describe("AgentRuntime buildOptions 依赖装配", () => {
  it("把外部依赖按契约透传给 buildAgentRunOptions", async () => {
    const buildOptionsModule = await import("./build-options");
    let captured: import("./build-options").BuildOptionsDeps | undefined;
    const spy = vi.spyOn(buildOptionsModule, "buildAgentRunOptions").mockImplementation(
      async (_input, deps) => {
        captured = deps;
        return { options: { toolSystemContent: "", soulSystemBaseContent: "" }, latestUserText: "问题" };
      },
    );
    try {
      const deps = createFullDeps();
      const runtime = createAgentRuntime(deps);
      await runtime.buildOptions({} as never);
      expect(captured).toBeDefined();

      // 工具注册表透传
      captured!.toolRegistry.getEnabled();
      expect(deps.toolRegistry.getEnabledTools).toHaveBeenCalled();
      captured!.toolRegistry.getEnabledToolsForMode("work");
      expect(deps.toolRegistry.getEnabledToolsForMode).toHaveBeenCalledWith("work", undefined);

      // cita、工作区绑定、插件提示词上下文透传
      await captured!.prepareCitaTurn({} as never);
      expect(deps.citaService.prepareTurn).toHaveBeenCalledWith({});
      captured!.getWorkspaceBinding("conversation-1");
      expect(deps.chatsStore.getWorkspaceBinding).toHaveBeenCalledWith("conversation-1");
      await captured!.buildPluginPromptContext({ source: "desktop", mode: "chat" } as never);
      expect(deps.buildPluginPromptContext).toHaveBeenCalledWith({ source: "desktop", mode: "chat" });

      // 社会背景：listActive 按会话查询，无活跃原子时返回空块
      const social = await captured!.buildChatSocialContext({ conversationId: "conversation-1", query: "最近在忙什么" });
      expect(deps.socialAtomStore.listActive).toHaveBeenCalledWith("conversation-1", expect.any(Number));
      expect(social).toEqual({ contextBlock: "", retrievedAtoms: [] });

      // 图片兜底：纯文本主模型且未配独立视觉模型时明确拒绝而不是给出注定失败的配置
      const caption = await captured!.captionImageForFallback("a.png");
      expect(caption).toMatchObject({ ok: false });
      expect((caption as { error: string }).error).toContain("未配置独立视觉模型");
    } finally {
      spy.mockRestore();
    }
  });
});

describe("AgentRuntime 心情观察器", () => {
  beforeEach(() => {
    mocks.onAgentRunFinished.mockReset();
    mocks.onAgentRunFinished.mockImplementation(async () => ({ sticker: null }));
  });

  async function captureOnRunFinishedDeps() {
    const deps = createFullDeps();
    const runtime = createAgentRuntime(deps);
    await runtime.onRunFinished(
      { reply: "回复", toolResults: [] },
      "问题",
      { source: "desktop", mode: "chat", conversationId: "conversation-observer" },
    );
    const call = mocks.onAgentRunFinished.mock.calls.at(-1);
    return { deps, onRunFinishedDeps: call![2] as import("./build-options").OnRunFinishedDeps };
  }

  it("解析到合法心情时通过低优先级队列平滑注入", async () => {
    const { deps, onRunFinishedDeps } = await captureOnRunFinishedDeps();
    (deps.llmClient.chat as Mock).mockResolvedValue('{"feeling": "开心"}');

    await onRunFinishedDeps.observeRuntimeState({ provider: "p", baseUrl: "u", model: "m", apiKey: "k" }, [], "问题", "回复");

    // 观察器走 enqueueLLMTask 低优先级通道且不记日志
    expect(deps.enqueueLLMTask).toHaveBeenCalledWith("心情观察器", expect.any(Function), { log: false });
    expect(deps.llmClient.chat).toHaveBeenCalledTimes(1);
    // 判定的是昔涟的心情，system 提示词带人格设定，user 带最后一轮回复
    const chatArgs = (deps.llmClient.chat as Mock).mock.calls[0];
    expect(chatArgs[1][0].role).toBe("system");
    expect(chatArgs[1][0].content).toContain("情绪分析器");
    expect(chatArgs[1][1].content).toContain("回复");
    expect(deps.runtimeStateService.smoothFeeling).toHaveBeenCalledWith("开心");
  });

  it("观察器输出非法心情时保持当前心情不变", async () => {
    const { deps, onRunFinishedDeps } = await captureOnRunFinishedDeps();
    (deps.llmClient.chat as Mock).mockResolvedValue("我今天心情不错！");

    await onRunFinishedDeps.observeRuntimeState({ provider: "p", baseUrl: "u", model: "m", apiKey: "k" }, [], "问题", "回复");

    expect(deps.runtimeStateService.smoothFeeling).not.toHaveBeenCalled();
  });

  it("观察器失败只告警，不影响对话主流程", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const deps = createFullDeps({
      enqueueLLMTask: vi.fn(async () => { throw new Error("队列已满"); }),
    });
    const runtime = createAgentRuntime(deps);
    await runtime.onRunFinished(
      { reply: "回复", toolResults: [] },
      "问题",
      { source: "desktop", mode: "chat", conversationId: "conversation-observer-error" },
    );
    const call = mocks.onAgentRunFinished.mock.calls.at(-1);
    const onRunFinishedDeps = call![2] as import("./build-options").OnRunFinishedDeps;

    await expect(onRunFinishedDeps.observeRuntimeState(
      { provider: "p", baseUrl: "u", model: "m", apiKey: "k" }, [], "问题", "回复",
    )).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledWith(
      "[Cyrene] observe runtime failed; keeping current feeling:",
      expect.any(Error),
    );
  });
});

describe("AgentRuntime 轨迹上下文注入（CTA Phase 1）", () => {
  it("桌面轨迹上下文从真实 store 物化模型消息，忽略渲染端消息", async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "cyrene-runtime-transcript-"));
    electronMocks.userDataRoot = root;
    mocks.buildAlwaysOnContext.mockReset();
    mocks.buildAlwaysOnContext.mockResolvedValue("[常驻上下文]");
    try {
      // 种子：真实轨迹里先落一条权威 user 条目
      const { getConversationTranscriptStore } = await import("./conversation-transcript-store");
      await getConversationTranscriptStore(root).append("conversation-authoritative", {
        id: "seed-user-1",
        kind: "user",
        turnId: "turn-1",
        revision: 1,
        at: 1,
        payload: { text: "权威历史消息" },
      });

      const runtime = createAgentRuntime(createFullDeps());
      const built = await runtime.buildOptions({
        sessionId: "conversation-authoritative",
        currentUser: { turnId: "turn-2", text: "next", visibleContent: "next" },
      } as never);

      // 模型消息来自轨迹物化，渲染端陈旧消息不进入模型上下文
      expect(built.options.cleanMessages).toContainEqual(
        expect.objectContaining({ content: "权威历史消息" }),
      );
      expect(JSON.stringify(built.options.messages)).not.toContain("stale renderer");
    } finally {
      electronMocks.userDataRoot = "";
      rmSync(root, { recursive: true, force: true });
    }
  });
});
