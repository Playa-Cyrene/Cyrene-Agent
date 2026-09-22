import * as fs from "fs"
import * as os from "os"
import * as path from "path"
import { describe, expect, it, vi } from "vitest"
import {
  buildAgentRunOptions as buildAgentRunOptionsProduction,
  buildChannelSystem,
  onAgentRunFinished,
  type BuildOptionsDeps,
  type OnRunFinishedDeps,
} from "./build-options"
import type { MaterializedTranscript } from "./conversation-transcript-context"
import type { SocialAtom } from "../social-context/types"
import type { ConversationMode } from "../../shared/chat-types"

function createBuildDeps(): BuildOptionsDeps {
  return {
    loadModelSettings: () => ({ provider: "test", baseUrl: "https://example.test", model: "m", apiKey: "k" }),
    loadGeneralSettings: () => ({
      currentStyleId: "default",
      customStyle: { diversity: { driver: "model-default" }, repetition: "model-default" },
      chatSocialContextEnabled: false,
    }),
    loadUserProfile: () => ({}),
    buildEnvironmentContext: () => "ENV",
    buildSkillCatalog: () => "",
    buildAutoInjectedSkillContext: () => "",
    skillRegistry: {
      getEnabled: () => [],
      // 三模适配层：测试 mock skill 都不声明 modes，等价于全模式通用。
      getEnabledForMode(this: { getEnabled(): ReadonlyArray<unknown> }, _mode: import("../skills/types").SkillMode) {
        return this.getEnabled()
      },
      getBody: () => null,
    },
    resolveSlashActivation: () => "",
    buildToneInjection: () => "",
    buildAlwaysOnContext: async () => "ALWAYS",
    buildRelationshipContext: async () => "RELATIONSHIP",
    buildSystemPrompt: () => "BASE_SYSTEM",
    buildToolSystemPrompt: () => "TOOL_SYSTEM",
    buildSoulSystemBasePrompt: () => "SOUL_SYSTEM_BASE",
    readStylePrompt: (styleId) => `STYLE_PROMPT:${styleId}`,
    resolveSoulSampling: () => ({}),
    toolRegistry: {
      getEnabled: () => [],
      // 三模适配层：测试 mock 工具都不声明 modes，等价于全模式通用，
      // 因此 getEnabledToolsForMode 直接转发到 getEnabled，单测覆写 getEnabled 即可生效。
      getEnabledToolsForMode(this: { getEnabled(): ReadonlyArray<unknown> }, _mode: ConversationMode) {
        return this.getEnabled()
      },
    },
    normalizeChatMessages: (raw) => raw as never,
    chatRequestTimeoutMs: 1000,
  }
}

// 测试夹具把历史消息物化为 canonical journal 的 modelContext；生产入口不再接受旁路 messages。
async function buildAgentRunOptions(
  input: Record<string, unknown>,
  deps: BuildOptionsDeps,
) {
  const rawMessages = input.messages
  const { messages: _legacyMessages, ...canonicalInput } = input
  const modelContext = !canonicalInput.currentUser && Array.isArray(rawMessages)
    ? {
      messages: rawMessages,
      uncertainEffects: [],
      throughSeq: 0,
    } as MaterializedTranscript
    : undefined
  return buildAgentRunOptionsProduction({
    ...canonicalInput,
    ...(modelContext ? { modelContext } : {}),
  } as never, deps)
}

describe("build-options", () => {
  it.each(["chat", "work", "learn", "code"] as const)("uses the explicit %s mode prompt", async (mode) => {
    const deps = createBuildDeps();
    deps.buildModePrompt = (target) => `[MODE:${target}]`;
    const result = await buildAgentRunOptions({
      sessionId: `${mode}-session`,
      mode,
      executionMode: mode === "chat" ? "chat" : "work",
      messages: [{ role: "user", content: "你好" }],
    }, deps);
    expect(result.options.soulSystemBaseContent).toContain(`[MODE:${mode}]`);
  });

  it("把插件贡献放入每轮 runtime context，并传递可信运行元数据", async () => {
    const deps = createBuildDeps();
    deps.buildPluginPromptContext = vi.fn(async (input) => (
      `[插件上下文：demo]\n${input.mode}:${input.userText}`
    ));

    const result = await buildAgentRunOptions({
      sessionId: "plugin-prompt-session",
      mode: "chat",
      executionMode: "chat",
      channel: "wechat",
      messages: [{ role: "user", content: "今天天气如何" }],
    }, deps);

    expect(deps.buildPluginPromptContext).toHaveBeenCalledWith({
      source: "conversation",
      mode: "chat",
      userText: "今天天气如何",
      conversationId: "plugin-prompt-session",
      channel: "wechat",
    });
    expect(result.options.soulRuntimeContext).toContain("[插件上下文：demo]\nchat:今天天气如何");
    expect(result.options.soulSystemBaseContent).not.toContain("插件上下文：demo");
    expect(result.options.toolSystemContent).not.toContain("插件上下文：demo");
  });

  it("无头插件任务把显式 promptSource 传给插件提示词 Provider", async () => {
    const deps = createBuildDeps();
    deps.buildPluginPromptContext = vi.fn(async (input) => `[${input.source}] ${input.channel}`);

    const result = await buildAgentRunOptions({
      sessionId: "plugin:minecraft-bot",
      mode: "work",
      executionMode: "work",
      promptSource: "plugin-agent",
      promptChannel: "minecraft",
      messages: [{ role: "user", content: "收集木头" }],
    } as never, deps);

    expect(deps.buildPluginPromptContext).toHaveBeenCalledWith({
      source: "plugin-agent",
      mode: "work",
      userText: "收集木头",
      conversationId: "plugin:minecraft-bot",
      channel: "minecraft",
    });
    expect(result.options.soulRuntimeContext).toContain("[plugin-agent] minecraft");
  });

  it("keeps chat tool-free when enhancement switch is off", async () => {
    const deps = createBuildDeps();
    deps.toolRegistry.getEnabled = () => [
      { id: "music_search", name: "搜索歌曲", description: "d", enabled: true } as never,
    ];
    const result = await buildAgentRunOptions({
      sessionId: "chat-plain",
      mode: "chat",
      executionMode: "chat",
      messages: [{ role: "user", content: "你好" }],
    }, deps);
    expect(result.options.tools).toEqual([]);
    expect(result.options.toolSystemContent).not.toContain("TOOL_SYSTEM");
  });

  it("exposes only opted-in tools for enhanced chat", async () => {
    const deps = createBuildDeps();
    deps.loadGeneralSettings = () => ({
      currentStyleId: "default",
      customStyle: { diversity: { driver: "model-default" }, repetition: "model-default" },
      chatSocialContextEnabled: false,
      chatToolsEnabled: true,
      // 勾选 music_search；read_file 不勾（验证未声明 modes 的工具不漏进 chat）。
      toolModeOverrides: { music_search: { chat: true }, read_file: { chat: false } },
    });
    deps.toolRegistry.getEnabled = () => [
      { id: "music_search", name: "搜索歌曲", description: "d", enabled: true },
      { id: "read_file", name: "读文件", description: "d", enabled: true },
    ] as never;
    const result = await buildAgentRunOptions({
      sessionId: "chat-tools",
      mode: "chat",
      executionMode: "chat",
      messages: [{ role: "user", content: "放首歌" }],
    }, deps);
    expect((result.options.tools ?? []).map((t: { id: string }) => t.id)).toEqual(["music_search"]);
    // 有工具时 chat 也注入工具目录 prompt（进 harness stablePrefix）。
    expect(result.options.toolSystemContent).toContain("TOOL_SYSTEM");
  });
  it("does not include legacy Ask Soul prompt fields", async () => {
    const deps = createBuildDeps()
    deps.loadUserProfile = () => ({
      nickname: "小王",
      callPreference: "伙伴",
      gender: "male",
      birthday: "2000-01-01",
      defaultCity: "淄博",
    })

    const result = await buildAgentRunOptions({
      messages: [{ role: "user", content: "生成一份文档" }],
      style: "01_default.md",
    }, deps)
    const askOptions = result.options as typeof result.options & {
      askSystemContent?: string
      trustedAskUserProfile?: Record<string, unknown>
    }

    expect(askOptions.askSystemContent).toBeUndefined()
    expect(askOptions.trustedAskUserProfile).toBeUndefined()
  })

  it("passes the trusted runtime environment to the agent decision stages", async () => {
    const result = await buildAgentRunOptions({
      messages: [{ role: "user", content: "帮我查一下今天的天气" }],
      style: "01_default.md",
    }, createBuildDeps())

    expect((result.options as typeof result.options & {
      runtimeEnvironmentContext?: string
    }).runtimeEnvironmentContext).toBe("ENV")
  })

  it("passes the saved reasoning preference into the Agent Runtime", async () => {
    const deps = createBuildDeps()
    deps.loadModelSettings = () => ({
      provider: "DeepSeek（深度求索）",
      baseUrl: "https://api.deepseek.com",
      model: "deepseek-v4-pro",
      apiKey: "k",
      reasoning: { mode: "off" },
    })

    const result = await buildAgentRunOptions({
      messages: [{ role: "user", content: "你好" }],
      style: "01_default.md",
    }, deps)

    expect(result.options.settings.reasoning).toEqual({ mode: "off" })
  })

  it.each(["chat", "work", "code", "learn"] as const)(
    "preserves the saved reasoning preference in %s mode",
    async (executionMode) => {
      const deps = createBuildDeps()
      deps.loadModelSettings = () => ({
        provider: "Qwen（通义千问）",
        baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
        model: "qwen3-max",
        apiKey: "k",
        reasoning: { mode: "on" },
      })

      const result = await buildAgentRunOptions({
        messages: [{ role: "user", content: "你好" }],
        style: "01_default.md",
        executionMode,
        mode: executionMode,
      }, deps)

      expect(result.options.settings.reasoning).toEqual({ mode: "on" })
      expect(result.options.executionMode).toBe(executionMode === "chat" ? "chat" : "work")
    },
  )

  it("adds a concise WeChat system when the run comes from WeChat", async () => {
    const result = await buildAgentRunOptions({
      messages: [{ role: "user", content: "你好" }],
      style: "01_default.md",
      channel: "wechat",
    }, createBuildDeps())

    expect(result.options.soulSystemBaseContent).toContain("你正在通过微信回复用户")
    expect(result.options.soulSystemBaseContent).toContain("SOUL_SYSTEM_BASE")
    expect(result.options.soulRuntimeContext).toContain("RELATIONSHIP")
    expect(result.options.toolSystemContent).toBe("TOOL_SYSTEM")
  })

  it("does not add channel system for desktop chat", async () => {
    const result = await buildAgentRunOptions({
      messages: [{ role: "user", content: "你好" }],
      style: "01_default.md",
    }, createBuildDeps())

    expect(result.options.soulSystemBaseContent).not.toContain("你正在通过微信回复用户")
    expect(result.options.soulSystemBaseContent).not.toContain("你正在通过飞书回复用户")
  })

  it("messages 不含 system，由循环层组装 system", async () => {
    const result = await buildAgentRunOptions({
      messages: [{ role: "user", content: "你好" }],
      style: "01_default.md",
    }, createBuildDeps())

    // 原始 messages 不含 system 消息
    expect(result.options.messages.some((m) => m.role === "system")).toBe(false)
  })

  it("adds message timestamps and one gap notice to AG-UI chat context", async () => {
    const deps = createBuildDeps()
    deps.loadUserProfile = () => ({ timezone: "Asia/Taipei" })

    const result = await buildAgentRunOptions({
      messages: [
        { role: "user", content: "今天有点累", at: Date.UTC(2026, 6, 12, 12, 0) },
        { role: "assistant", content: "早点休息", at: Date.UTC(2026, 6, 12, 12, 2) },
        { role: "user", content: "我回来啦", at: Date.UTC(2026, 6, 13, 3, 0) },
      ],
      style: "01_default.md",
    }, deps)

    expect(result.options.messages[0].content).toContain("<internal_context>用户发送这条消息的时间：2026-07-12 20:00")
    expect(result.options.messages[2].content).toContain("<internal_context>用户发送这条消息的时间：2026-07-13 11:00")
    expect(result.options.soulRuntimeContext).toContain("## Internal Context Policy")
    expect(result.options.toolSystemContent).toContain("## Internal Context Policy")
    expect(result.options.soulRuntimeContext).toContain("[对话时间信息]")
    expect(result.options.soulRuntimeContext).toContain("距离上一条有效聊天消息：约 14 小时 58 分钟")
    expect(result.options.soulRuntimeContext?.match(/距离上一条有效聊天消息/g)).toHaveLength(1)
    expect(result.options.toolSystemContent).not.toContain("[对话时间信息]")
  })

  it("toolSystemContent / soulSystemBaseContent 是分开的两套字符串", async () => {
    const result = await buildAgentRunOptions({
      messages: [{ role: "user", content: "你好" }],
      style: "01_default.md",
    }, createBuildDeps())

    expect(result.options.toolSystemContent).toBe("TOOL_SYSTEM")
    expect(result.options.soulSystemBaseContent).not.toBe("TOOL_SYSTEM")
    expect(result.options.soulSystemBaseContent).toContain("SOUL_SYSTEM_BASE")
  })

  it("builds Chat mode without CITA or tools", async () => {
    const deps = createBuildDeps()
    deps.prepareCitaTurn = vi.fn(async () => ({ contextBlock: "unexpected" }))
    deps.toolRegistry.getEnabled = () => [
      { id: "music_search" },
      { id: "weather" },
    ]

    const result = await buildAgentRunOptions({
      messages: [{ role: "user", content: "陪我聊聊" }],
      styleId: "lively",
      executionMode: "chat",
    }, deps)

    expect(deps.prepareCitaTurn).not.toHaveBeenCalled()
    expect(result.options.executionMode).toBe("chat")
    expect(result.options.tools).toEqual([])
    expect(result.options.citaContextBlock).toBe("")
    expect(result.options.soulRuntimeContext).toContain("STYLE_PROMPT:lively")
    expect(result.options.toolSystemContent).not.toContain("STYLE_PROMPT:lively")
  })

  it("injects the trusted session workspace into tool instructions", async () => {
    const deps = createBuildDeps()
    deps.getWorkspaceBinding = (conversationId) => conversationId === "daily-session"
      ? { workspaceRoot: "C:\\projects\\daily", displayName: "daily", boundAt: 1 }
      : undefined

    const result = await buildAgentRunOptions({
      sessionId: "daily-session",
      messages: [{ role: "user", content: "搜索后写一份 Markdown 报告" }],
      style: "01_default.md",
      executionMode: "work",
    }, deps)

    expect(result.options.resolvedWorkspaceRoot).toBe("C:\\projects\\daily")
    expect(result.options.toolSystemContent).toContain("可信根目录：C:\\projects\\daily")
    expect(result.options.toolSystemContent).toContain("不得写入桌面")
  })

  it("does not load a workspace when the main-process caller disables workspace inheritance", async () => {
    const deps = createBuildDeps()
    deps.getWorkspaceBinding = vi.fn(() => ({
      workspaceRoot: "C:\\projects\\desktop",
      displayName: "desktop",
      boundAt: 1,
    }))

    const result = await buildAgentRunOptions({
      sessionId: "conversation-bound",
      workspaceBindingSessionId: null,
      messages: [{ role: "user", content: "继续对话" }],
      style: "01_default.md",
      executionMode: "work",
    }, deps)

    expect(deps.getWorkspaceBinding).not.toHaveBeenCalled()
    expect(result.options.resolvedWorkspaceRoot).toBeUndefined()
    expect(result.options.toolSystemContent).not.toContain("可信根目录")
  })

  it("adds a bounded social background only to enabled Chat runs", async () => {
    const deps = createBuildDeps()
    const retrievedAtom: SocialAtom = {
      id: "atom-1",
      conversationId: "chat-a",
      type: "long_term",
      content: "用户喜欢海边",
      evidenceTurnId: "old-user",
      evidenceQuote: "我喜欢海边",
      createdAt: 1,
      status: "active",
    }
    deps.loadGeneralSettings = () => ({
      currentStyleId: "default",
      customStyle: { diversity: { driver: "model-default" }, repetition: "model-default" },
      chatSocialContextEnabled: true,
    })
    deps.buildChatSocialContext = vi.fn(async () => ({
      contextBlock: "【本轮可用的对话背景】\n- 用户喜欢海边",
      retrievedAtoms: [retrievedAtom],
    }))
    const messages = Array.from({ length: 14 }, (_, index) => ({
      role: index % 2 === 0 ? "assistant" : "user",
      content: `message-${index}`,
      at: index + 1,
    }))

    const result = await buildAgentRunOptions({
      messages,
      executionMode: "chat",
      sessionId: "chat-a",
      userTurnId: "user-14",
      assistantTurnId: "assistant-14",
    }, deps)

    expect(deps.buildChatSocialContext).toHaveBeenCalledWith({
      conversationId: "chat-a",
      query: "message-13",
    })
    // CTA Phase 1：社交开关只影响检索块，不再截断模型历史
    expect(result.options.messages).toHaveLength(14)
    expect(result.options.soulRuntimeContext).toContain("用户喜欢海边")
    expect(result.options.socialContext).toMatchObject({
      enabled: true,
      conversationId: "chat-a",
      userTurnId: "user-14",
      assistantTurnId: "assistant-14",
      retrievedAtoms: [retrievedAtom],
    })
  })

  it("omits empty social background and never calls it for Work or disabled Chat", async () => {
    const emptyDeps = createBuildDeps()
    emptyDeps.loadGeneralSettings = () => ({
      currentStyleId: "default",
      customStyle: { diversity: { driver: "model-default" }, repetition: "model-default" },
      chatSocialContextEnabled: true,
    })
    emptyDeps.buildChatSocialContext = vi.fn(async () => ({
      contextBlock: "",
      retrievedAtoms: [],
    }))
    const chat = await buildAgentRunOptions({
      messages: [{ role: "user", content: "你好" }],
      executionMode: "chat",
      sessionId: "chat-a",
      userTurnId: "user-1",
      assistantTurnId: "assistant-1",
    }, emptyDeps)
    expect(chat.options.soulSystemBaseContent).not.toContain("本轮可用的对话背景")

    const workDeps = createBuildDeps()
    workDeps.loadGeneralSettings = emptyDeps.loadGeneralSettings
    workDeps.buildChatSocialContext = vi.fn(async () => ({
      contextBlock: "unexpected",
      retrievedAtoms: [],
    }))
    await buildAgentRunOptions({
      messages: [{ role: "user", content: "你好" }],
      executionMode: "work",
    }, workDeps)
    expect(workDeps.buildChatSocialContext).not.toHaveBeenCalled()

    const disabledDeps = createBuildDeps()
    disabledDeps.buildChatSocialContext = vi.fn(async () => ({
      contextBlock: "unexpected",
      retrievedAtoms: [],
    }))
    await buildAgentRunOptions({
      messages: [{ role: "user", content: "你好" }],
      executionMode: "chat",
    }, disabledDeps)
    expect(disabledDeps.buildChatSocialContext).not.toHaveBeenCalled()
  })

  it("honors an explicit Chat mode for channel runs", async () => {
    const deps = createBuildDeps()
    deps.prepareCitaTurn = vi.fn(async () => ({ contextBlock: "unexpected" }))
    deps.toolRegistry.getEnabled = () => [{ id: "weather" }]
    deps.buildSoulSystemBasePrompt = vi.fn(() => "TALK_SOUL_SYSTEM")

    const result = await buildAgentRunOptions({
      messages: [{ role: "user", content: "今天怎么样" }],
      style: "01_default.md",
      channel: "wechat",
      executionMode: "chat",
    }, deps)

    expect(deps.prepareCitaTurn).not.toHaveBeenCalled()
    expect(deps.buildSoulSystemBasePrompt).toHaveBeenCalledWith("chat")
    expect(result.options.executionMode).toBe("chat")
    expect(result.options.tools).toEqual([])
  })

  it("keeps selected style prompt and sampling independent from execution mode", async () => {
    const deps = createBuildDeps()
    deps.resolveSoulSampling = ({ styleId }) => (
      styleId === "sweet"
        ? { temperature: 0.82, frequencyPenalty: 0.2 }
        : {}
    )

    const chat = await buildAgentRunOptions({
      messages: [{ role: "user", content: "陪我聊聊" }],
      styleId: "sweet",
      executionMode: "chat",
    }, deps)
    const work = await buildAgentRunOptions({
      messages: [{ role: "user", content: "查一下天气" }],
      styleId: "sweet",
      executionMode: "work",
    }, deps)

    // chat 保留 style prompt 与采样；work/code 完全不受 style 影响，走厂商默认
    expect(chat.options.soulRuntimeContext).toContain("STYLE_PROMPT:sweet")
    expect(chat.options.soulSampling).toEqual({ temperature: 0.82, frequencyPenalty: 0.2 })
    expect(work.options.soulRuntimeContext).not.toContain("STYLE_PROMPT:sweet")
    expect(work.options.soulSampling).toBeUndefined()
    expect(chat.options.executionMode).toBe("chat")
    expect(work.options.executionMode).toBe("work")
  })

  it("does not locally route an explicit NetEase Cloud search request", async () => {
    const deps = createBuildDeps()
    deps.toolRegistry.getEnabled = () => [{ id: "music_search" }]

    const result = await buildAgentRunOptions({
      messages: [{ role: "user", content: "网易云上搜一下左转灯" }],
      styleId: "default",
      executionMode: "chat",
    }, deps)

    expect(result.options).not.toHaveProperty("requiredToolName")
    expect(result.options).not.toHaveProperty("requiredToolArgs")
  })

  it("does not locally route daily recommendations or infer continuations", async () => {
    const deps = createBuildDeps()
    deps.toolRegistry.getEnabled = () => [
      { id: "music_get_daily_recommendations" },
      { id: "music_search" },
    ]

    const daily = await buildAgentRunOptions({
      messages: [{ role: "user", content: "看看网易云今日推荐" }],
      styleId: "default",
      executionMode: "chat",
    }, deps)
    const generic = await buildAgentRunOptions({
      messages: [{ role: "user", content: "有点无聊，想听歌" }],
      styleId: "default",
      executionMode: "chat",
    }, deps)

    expect(daily.options).not.toHaveProperty("requiredToolName")
    expect(generic.options).not.toHaveProperty("requiredToolName")
  })

  it("injects CITA as a separate tool-phase block and preserves the original user message", async () => {
    const deps = createBuildDeps()
    deps.prepareCitaTurn = vi.fn(async () => ({
      contextBlock: "[CITA_CONTEXT]\n{\"focusedContexts\":[{\"contextRef\":\"music-candidate-1\"}]}\n[/CITA_CONTEXT]",
      contextPackage: {
        originalQuery: "第二首",
        contextualizedQuery: "播放当前网易云日推第二首",
        resolvedReferences: [],
      },
    }))
    const originalUserMessage = { role: "user", content: "第二首" }

    const result = await buildAgentRunOptions({
      messages: [originalUserMessage],
      style: "01_default.md",
      sessionId: "conversation-1",
    }, deps)

    expect(deps.prepareCitaTurn).toHaveBeenCalledTimes(1)
    expect(result.options.conversationId).toBe("conversation-1")
    expect(result.options.messages.at(-1)).toEqual(originalUserMessage)
    expect(result.options.toolSystemContent).not.toContain("[CITA_CONTEXT]")
    expect(result.options.citaContextBlock).toContain("[CITA_CONTEXT]")
    expect(result.options.citaContextBlock).toContain("music-candidate-1")
    expect(result.options.originalQuery).toBe("第二首")
    expect(result.options.contextualizedQuery).toBe("播放当前网易云日推第二首")
    expect(result.options.citaContextBlock).toContain("music-candidate-1")
    expect(result.options).not.toHaveProperty("requiredToolName")
    expect(result.options).not.toHaveProperty("requiredToolArgs")
  })

  it("emits no CITA marker when the service is disabled", async () => {
    const deps = createBuildDeps()
    deps.prepareCitaTurn = vi.fn(async () => ({ contextBlock: "" }))

    const result = await buildAgentRunOptions({
      messages: [{ role: "user", content: "第二首" }],
      style: "01_default.md",
      sessionId: "conversation-1",
    }, deps)

    expect(result.options.toolSystemContent).not.toContain("[CITA_CONTEXT]")
  })

  it("puts the enabled Skill catalog into the tool phase so invoke_skill can route", async () => {
    const deps = createBuildDeps()
    deps.buildSkillCatalog = () => "SKILL_CATALOG"

    const result = await buildAgentRunOptions({
      messages: [{ role: "user", content: "好无聊" }],
      style: "01_default.md",
    }, deps)

    expect(result.options.toolSystemContent).toContain("SKILL_CATALOG")
    expect(result.options.soulSystemBaseContent).not.toContain("SKILL_CATALOG")
  })

  it("keeps tool-oriented Skill rules out of Soul but retains reply-only strategy", async () => {
    const deps = createBuildDeps()
    deps.buildAutoInjectedSkillContext = () => "AUTO_MUSIC_RULES"
    deps.buildAutoInjectedSoulContext = () => "SOUL_MUSIC_REPLY_RULES"

    const result = await buildAgentRunOptions({
      messages: [{ role: "user", content: "今日推荐呢" }],
      style: "01_default.md",
    }, deps)

    expect(result.options.toolSystemContent).toContain("AUTO_MUSIC_RULES")
    expect(result.options.soulSystemBaseContent).not.toContain("AUTO_MUSIC_RULES")
    expect(result.options.soulRuntimeContext).toContain("SOUL_MUSIC_REPLY_RULES")
  })

  it("attaches direct image content blocks to the latest user message", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cyrene-image-direct-"))
    const imagePath = path.join(dir, "图 像.png")
    fs.writeFileSync(imagePath, Buffer.from([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
      0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
    ]))

    // 直发判定只看 multimodal 开关（默认开）：任意 provider/协议都直发，
    // 能力对错由服务端仲裁（400 时 chat-loop 走 imageCaptionFallback 降级）。
    const deps = createBuildDeps()

    const result = await buildAgentRunOptions({
      messages: [
        { role: "user", content: "上一轮" },
        { role: "assistant", content: "好的" },
        { role: "user", content: "请看这张图" },
      ],
      style: "01_default.md",
      imageAttachments: [{ name: "图 像.png", filePath: imagePath, mime: "image/png" }],
    }, deps)

    const latestUser = result.options.messages.at(-1)
    expect(latestUser?.content).toEqual([
      { type: "text", text: "请看这张图" },
      {
        type: "image_url",
        image_url: { url: expect.stringMatching(/^data:image\/png;base64,/) },
      },
    ])
    // 第一期：原始 messages 不含 system，所以 messages[0] 就是首条用户消息
    expect(result.options.messages[0].content).toBe("上一轮")
  })

  it("uses a vision caption instead of sending image data when the primary model is not multimodal", async () => {
    const deps = createBuildDeps()
    deps.loadModelSettings = () => ({
      provider: "test", baseUrl: "https://example.test", model: "text-only", apiKey: "k", multimodal: false,
      vision: { baseUrl: "https://vlm.test/v1", apiKey: "k", model: "vlm-model" },
    })
    deps.captionImageForFallback = async () => ({ ok: true, caption: "截图显示一个红色错误提示" })

    const result = await buildAgentRunOptions({
      messages: [{ role: "user", content: "这张图报什么错？" }],
      imageAttachments: [{ name: "error.png", filePath: "C:\\tmp\\error.png", mime: "image/png" }],
    }, deps)

    const latestUser = result.options.messages.at(-1)
    expect(latestUser?.content).toBe(
      "这张图报什么错？\n\n【图片视觉信息】\n以下内容是视觉模型对用户本轮图片的观察结果，请将其视为你已经看到的图片内容；如果某张图分析失败，请不要编造。\n- error.png：截图显示一个红色错误提示",
    )
    expect(result.options.imageCaptionFallback).toBeUndefined()
  })

  it("纯文本主模型且未配视觉模型时注入人话拒绝提示（不再静默丢图）", async () => {
    const deps = createBuildDeps()
    deps.loadModelSettings = () => ({
      provider: "test", baseUrl: "https://example.test", model: "text-only", apiKey: "k", multimodal: false,
    })

    const result = await buildAgentRunOptions({
      messages: [{ role: "user", content: "这张图报什么错？" }],
      imageAttachments: [{ name: "error.png", filePath: "C:\\tmp\\error.png", mime: "image/png" }],
    }, deps)

    const latestUser = result.options.messages.at(-1)
    expect(latestUser?.content).toContain("【图片发送失败】")
    expect(latestUser?.content).toContain("error.png")
    expect(latestUser?.content).toContain("视觉模型")
    expect(latestUser?.content).not.toContain("image_url")
  })

  it("builds caption fallback messages for direct image send failures", async () => {
    const deps = createBuildDeps()
    deps.captionImageForFallback = async () => ({ ok: true, caption: "画面里有一张安装截图" })

    const result = await buildAgentRunOptions({
      messages: [{ role: "user", content: "这图哪里不对？" }],
      style: "01_default.md",
      imageAttachments: [{ name: "setup.png", filePath: "C:\\tmp\\setup.png", mime: "image/png" }],
    }, deps)

    const fallbackMessages = await result.options.imageCaptionFallback?.()
    const userMessage = fallbackMessages?.at(-1)
    expect(userMessage?.content).toContain("这图哪里不对？")
    expect(userMessage?.content).toContain("setup.png：画面里有一张安装截图")
    expect(userMessage?.content).not.toContain("image_url")
  })

  it("MiniMax + anthropic 入口直发 image 块（anthropic-adapter 会转成 image source 块）", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cyrene-image-mm-m3-"))
    const imagePath = path.join(dir, "shot.png")
    fs.writeFileSync(imagePath, Buffer.from([0x89, 0x50, 0x4e, 0x47]))

    const deps = createBuildDeps()
    deps.loadModelSettings = () => ({
      provider: "MiniMax（稀宇科技）", baseUrl: "https://api.minimaxi.com/anthropic", model: "MiniMax-M3", apiKey: "k",
    })
    deps.captionImageForFallback = async () => ({ ok: true, caption: "一张截图" })

    const result = await buildAgentRunOptions({
      messages: [{ role: "user", content: "看图" }],
      imageAttachments: [{ name: "shot.png", filePath: imagePath, mime: "image/png" }],
    }, deps)

    const latestUser = result.options.messages.at(-1)
    expect(latestUser?.content).toEqual([
      { type: "text", text: "看图" },
      { type: "image_url", image_url: { url: expect.stringMatching(/^data:image\/png;base64,/) } },
    ])
    // 直发场景构建 caption 兜底（直发 400 时可降级重试）。
    expect(result.options.imageCaptionFallback).toBeDefined()
  })

  it("MiniMax M2.7 开关开着也直发（本地不做模型级防呆，能力由服务端仲裁）", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cyrene-image-mm-m2-"))
    const imagePath = path.join(dir, "shot.png")
    fs.writeFileSync(imagePath, Buffer.from([0x89, 0x50, 0x4e, 0x47]))

    const deps = createBuildDeps()
    deps.loadModelSettings = () => ({
      provider: "MiniMax（稀宇科技）", baseUrl: "https://api.minimaxi.com/anthropic", model: "MiniMax-M2.7", apiKey: "k",
    })

    const result = await buildAgentRunOptions({
      messages: [{ role: "user", content: "看图" }],
      imageAttachments: [{ name: "shot.png", filePath: imagePath, mime: "image/png" }],
    }, deps)

    // 用户开了多模态开关就直发：M2.x 拒收与否由服务端说了算，
    // 失败时 chat-loop 用 imageCaptionFallback 降级重试。
    const latestUser = result.options.messages.at(-1)
    expect(latestUser?.content).toEqual([
      { type: "text", text: "看图" },
      { type: "image_url", image_url: { url: expect.stringMatching(/^data:image\/png;base64,/) } },
    ])
  })

  it("has distinct system text for Feishu work chat", () => {
    expect(buildChannelSystem("feishu")).toContain("你正在通过飞书回复用户")
    expect(buildChannelSystem("feishu")).toContain("工作上下文")
  })

  it("records relationship turn after agent run finishes", async () => {
    const recordRelationshipTurn = vi.fn(async () => {})
    const deps: OnRunFinishedDeps = {
      loadModelSettings: () => ({ provider: "test", baseUrl: "", model: "", apiKey: "", runtimeSync: "off" }),
      scheduleMemoryWrite: () => {},
      inferRuntimeState: () => ({ status: "陪伴中" }),
      runtimeState: { status: "陪伴中", feeling: "温柔", expression: 0, updatedAt: 0 },
      feelingToExpression: { "温柔": 0 },
      setRuntimeState: () => {},
      stickerEmbeddingIndex: null,
      getEmbeddingProvider: () => null,
      matchSticker: async () => null,
      loadStickerSettings: () => ({}),
      broadcastRuntimeStateChanged: () => {},
      observeRuntimeState: async () => {},
      recordRelationshipTurn,
    }

    await onAgentRunFinished({ reply: "好呀", toolResults: [] }, "今天有点累", deps, "wechat")

    expect(recordRelationshipTurn).toHaveBeenCalledWith({
      userText: "今天有点累",
      assistantText: "好呀",
      cyreneFeeling: "温柔",
      channel: "wechat",
    })
  })

  it("uses the latest sticker embedding index when agent run finishes", async () => {
    const matchSticker = vi.fn(async () => ({ id: "hugtight" }))
    const latestIndex = [{ id: "hugtight", embedding: [1, 0] }]
    const deps: OnRunFinishedDeps & { getStickerEmbeddingIndex: () => unknown } = {
      loadModelSettings: () => ({
        provider: "test",
        baseUrl: "",
        model: "",
        apiKey: "",
        runtimeSync: "off",
        stickerEnabled: true,
        stickerSimilarityThreshold: 0.55,
      }),
      scheduleMemoryWrite: () => {},
      inferRuntimeState: () => ({ status: "陪伴中" }),
      runtimeState: { status: "陪伴中", feeling: "温柔", expression: 0, updatedAt: 0 },
      feelingToExpression: { "温柔": 0 },
      setRuntimeState: () => {},
      stickerEmbeddingIndex: null,
      getStickerEmbeddingIndex: () => latestIndex,
      getEmbeddingProvider: () => ({ embed: async () => [1, 0] }),
      matchSticker,
      loadStickerSettings: () => ({}),
      broadcastRuntimeStateChanged: () => {},
      observeRuntimeState: async () => {},
      recordRelationshipTurn: async () => {},
    }

    const effects = await onAgentRunFinished({ reply: "来，抱抱你", toolResults: [] }, "今天好累", deps)

    expect(matchSticker).toHaveBeenCalledWith(
      "来，抱抱你\n今天好累",
      expect.anything(),
      latestIndex,
      0.55,
    )
    expect(effects).toEqual({ sticker: "hugtight" })
  })

  it("does not send document model context into memory or sticker embedding side effects", async () => {
    const scheduleMemoryWrite = vi.fn()
    const matchSticker = vi.fn(async () => null)
    const latestIndex = [{ id: "thinking", embedding: [1, 0] }]
    const hugeDoc = "超长文档内容".repeat(1000)
    const latestUserText = [
      "帮我总结这个 md",
      "【本轮文件】\n📝 notes.md（附件，内容已注入本轮上下文）",
      `【文档内容】\n文档 notes.md 内容：\n${hugeDoc}`,
    ].join("\n\n")
    const deps: OnRunFinishedDeps = {
      loadModelSettings: () => ({
        provider: "test",
        baseUrl: "",
        model: "",
        apiKey: "",
        runtimeSync: "off",
        stickerEnabled: true,
        stickerSimilarityThreshold: 0.55,
      }),
      scheduleMemoryWrite,
      inferRuntimeState: () => ({ status: "陪伴中" }),
      runtimeState: { status: "陪伴中", feeling: "温柔", expression: 0, updatedAt: 0 },
      feelingToExpression: { "温柔": 0 },
      setRuntimeState: () => {},
      stickerEmbeddingIndex: latestIndex,
      getEmbeddingProvider: () => ({ embed: async () => [1, 0] }),
      matchSticker,
      loadStickerSettings: () => ({}),
      broadcastRuntimeStateChanged: () => {},
      observeRuntimeState: async () => {},
      recordRelationshipTurn: async () => {},
    }

    await onAgentRunFinished({ reply: "总结好了", toolResults: [] }, latestUserText, deps)

    expect(scheduleMemoryWrite).toHaveBeenCalledWith("帮我总结这个 md", "总结好了", undefined)
    expect(matchSticker).toHaveBeenCalledWith(
      "总结好了\n帮我总结这个 md",
      expect.anything(),
      latestIndex,
      0.55,
    )
  })

  it("skips sticker embedding when reply and user content contain only code or math", async () => {
    const matchSticker = vi.fn(async () => ({ id: "hugtight" }))
    const deps: OnRunFinishedDeps = {
      loadModelSettings: () => ({ provider: "test", baseUrl: "", model: "", apiKey: "", runtimeSync: "off", stickerEnabled: true }),
      scheduleMemoryWrite: () => {},
      inferRuntimeState: () => ({ status: "陪伴中" }),
      runtimeState: { status: "陪伴中", feeling: "温柔", expression: 0, updatedAt: 0 },
      feelingToExpression: { "温柔": 0 },
      setRuntimeState: () => {},
      stickerEmbeddingIndex: [{ id: "hugtight", embedding: [1, 0] }],
      getEmbeddingProvider: () => ({ embed: async () => [1, 0] }),
      matchSticker,
      loadStickerSettings: () => ({}),
      broadcastRuntimeStateChanged: () => {},
      observeRuntimeState: async () => {},
      recordRelationshipTurn: async () => {},
    }

    const effects = await onAgentRunFinished(
      { reply: "```ts\nconst onlyCode = true\n```\n$$x^2$$", toolResults: [] },
      "$E=mc^2$",
      deps,
    )

    expect(matchSticker).not.toHaveBeenCalled()
    expect(effects).toEqual({ sticker: null })
  })

  it("schedules one social extraction instead of legacy memory for an enabled Chat result", async () => {
    const scheduleMemoryWrite = vi.fn()
    const scheduleSocialAtomExtraction = vi.fn()
    const observeRuntimeState = vi.fn(async () => {})
    const deps: OnRunFinishedDeps = {
      loadModelSettings: () => ({ provider: "test", baseUrl: "", model: "", apiKey: "", runtimeSync: "llm" }),
      scheduleMemoryWrite,
      scheduleSocialAtomExtraction,
      inferRuntimeState: () => ({ status: "陪伴中" }),
      runtimeState: { status: "陪伴中", feeling: "温柔", expression: 0, updatedAt: 0 },
      feelingToExpression: { "温柔": 0 },
      setRuntimeState: () => {},
      stickerEmbeddingIndex: null,
      getEmbeddingProvider: () => null,
      matchSticker: async () => null,
      loadStickerSettings: () => ({}),
      broadcastRuntimeStateChanged: () => {},
      observeRuntimeState,
      recordRelationshipTurn: async () => {},
    }
    const retrievedAtoms: SocialAtom[] = []

    await onAgentRunFinished({
      reply: "海风确实很舒服。",
      toolResults: [],
      executionMode: "chat",
      socialContext: {
        enabled: true,
        conversationId: "chat-a",
        userTurnId: "user-1",
        assistantTurnId: "assistant-1",
        retrievedAtoms,
        now: 100,
      },
    }, "我喜欢海边。", deps)

    expect(scheduleMemoryWrite).not.toHaveBeenCalled()
    expect(observeRuntimeState).not.toHaveBeenCalled()
    expect(scheduleSocialAtomExtraction).toHaveBeenCalledWith({
      conversationId: "chat-a",
      userTurn: { id: "user-1", role: "user", text: "我喜欢海边。" },
      assistantTurn: { id: "assistant-1", role: "assistant", text: "海风确实很舒服。" },
      retrievedAtoms,
      now: 100,
    })
  })
})

describe("moments context 注入（Phase 3 Chat Awareness）", () => {
  function momentsDeps(overrides: {
    momentsEnabled?: boolean;
    chatMomentsContextEnabled?: boolean;
    blockText?: string;
    throwInBuild?: boolean;
  }) {
    const deps = createBuildDeps()
    deps.loadGeneralSettings = () => ({
      currentStyleId: "default",
      customStyle: { diversity: { driver: "model-default" }, repetition: "model-default" },
      chatSocialContextEnabled: false,
      momentsEnabled: overrides.momentsEnabled ?? true,
      chatMomentsContextEnabled: overrides.chatMomentsContextEnabled ?? true,
    })
    deps.buildMomentsContext = vi.fn((query: string) => {
      if (overrides.throwInBuild) throw new Error("moments store 未初始化")
      return overrides.blockText ?? `【近期朋友圈动态】\n${query}`
    })
    return deps
  }

  it("Chat 模式且双开关开启时注入 momentsContextBlock，并把最新用户文本传给门控检索", async () => {
    const deps = momentsDeps({})
    const result = await buildAgentRunOptions({
      sessionId: "moments-chat",
      executionMode: "chat",
      messages: [{ role: "user", content: "你刚才朋友圈发的是什么意思" }],
    }, deps)

    expect(deps.buildMomentsContext).toHaveBeenCalledWith("你刚才朋友圈发的是什么意思")
    expect(result.options.soulRuntimeContext).toContain("【近期朋友圈动态】")
  })

  it("chatMomentsContextEnabled=false 时 block 不出现", async () => {
    const deps = momentsDeps({ chatMomentsContextEnabled: false })
    const result = await buildAgentRunOptions({
      sessionId: "moments-off",
      executionMode: "chat",
      messages: [{ role: "user", content: "你好" }],
    }, deps)

    expect(deps.buildMomentsContext).not.toHaveBeenCalled()
    expect(result.options.soulRuntimeContext).not.toContain("【近期朋友圈动态】")
  })

  it("momentsEnabled=false 总开关关闭时不注入", async () => {
    const deps = momentsDeps({ momentsEnabled: false })
    await buildAgentRunOptions({
      sessionId: "moments-master-off",
      executionMode: "chat",
      messages: [{ role: "user", content: "你好" }],
    }, deps)

    expect(deps.buildMomentsContext).not.toHaveBeenCalled()
  })

  it("Work 模式不注入", async () => {
    const deps = momentsDeps({})
    await buildAgentRunOptions({
      sessionId: "moments-work",
      executionMode: "work",
      messages: [{ role: "user", content: "帮我修个 bug" }],
    }, deps)

    expect(deps.buildMomentsContext).not.toHaveBeenCalled()
  })

  it("构建抛错时静默降级为空，不影响本轮运行", async () => {
    const deps = momentsDeps({ throwInBuild: true })
    const result = await buildAgentRunOptions({
      sessionId: "moments-error",
      executionMode: "chat",
      messages: [{ role: "user", content: "你好" }],
    }, deps)

    expect(result.options.soulRuntimeContext).not.toContain("【近期朋友圈动态】")
  })

  it("返回空串时按空省略，不产生空分隔段", async () => {
    const deps = momentsDeps({ blockText: "" })
    const result = await buildAgentRunOptions({
      sessionId: "moments-empty",
      executionMode: "chat",
      messages: [{ role: "user", content: "你好" }],
    }, deps)

    expect(result.options.soulRuntimeContext).not.toContain("【近期朋友圈动态】")
    expect(result.options.soulRuntimeContext).not.toMatch(/(^|\n)---(\n|$)\s*(^|\n)---/)
  })
})

describe("权威轨迹上下文源（CTA Phase 1）", () => {
  it("desktop transcript context 启用时忽略渲染端消息", async () => {
    const deps = createBuildDeps()
    deps.buildModelContext = vi.fn(async () => ({
      messages: [{ role: "user" as const, content: "authoritative" }],
      uncertainEffects: [],
      throughSeq: 3,
    }))

    const built = await buildAgentRunOptions({
      sessionId: "c1",
      currentUser: { turnId: "turn-1", text: "next", visibleContent: "next" },
      messages: [{ role: "user" as const, content: "stale renderer" }],
    } as never, deps)

    expect(deps.buildModelContext).toHaveBeenCalledWith("c1", expect.any(Number))
    expect(built.options.cleanMessages).toContainEqual(expect.objectContaining({ content: "authoritative" }))
    expect(JSON.stringify(built.options.messages)).not.toContain("stale renderer")
    expect(built.latestUserText).toBe("authoritative")
  })

  it("渠道与内部调用方不触发轨迹上下文，继续使用传入消息", async () => {
    const deps = createBuildDeps()
    deps.buildModelContext = vi.fn(async () => ({
      messages: [],
      uncertainEffects: [],
      throughSeq: 0,
    }))

    const built = await buildAgentRunOptions({
      sessionId: "channel-binding",
      messages: [{ role: "user" as const, content: "channel text" }],
    } as never, deps)

    expect(deps.buildModelContext).not.toHaveBeenCalled()
    expect(built.latestUserText).toBe("channel text")
    expect(built.options.cleanMessages).toContainEqual(expect.objectContaining({ content: "channel text" }))
  })

  it("缺失 buildModelContext 注入时轨迹上下文请求 fail-closed", async () => {
    const deps = createBuildDeps()
    await expect(buildAgentRunOptions({
      sessionId: "missing-dep",
      currentUser: { turnId: "turn-1", text: "hi", visibleContent: "hi" },
      messages: [{ role: "user" as const, content: "hi" }],
    } as never, deps)).rejects.toThrow("buildModelContext")
  })

  it("完整活动视图超预算时先提交会话级 compaction，再重新物化上下文", async () => {
    const deps = createBuildDeps()
    deps.loadModelSettings = () => ({
      provider: "test", baseUrl: "https://example.test", model: "m", apiKey: "k",
      contextWindowTokens: 10_000,
    })
    const full = [{ role: "user" as const, content: "历史".repeat(2_000) }]
    const compacted = [{ role: "system" as const, content: "<cyrene_compaction_checkpoint>\n摘要\n</cyrene_compaction_checkpoint>" }]
    let reads = 0
    deps.buildModelContext = vi.fn(async () => ({
      messages: reads++ === 0 ? full : compacted,
      uncertainEffects: [], throughSeq: 8,
    }))
    deps.compactTranscript = vi.fn(async () => ({ checkpointEntryId: "cp-1" }))

    const built = await buildAgentRunOptions({
      sessionId: "auto-compact", currentUser: { turnId: "turn-1", text: "继续", visibleContent: "继续" },
    } as never, deps)

    expect(deps.compactTranscript).toHaveBeenCalledWith(expect.objectContaining({
      conversationId: "auto-compact", trigger: "automatic", retainTokens: expect.any(Number),
    }))
    expect(deps.buildModelContext).toHaveBeenCalledTimes(2)
    expect(built.options.cleanMessages).toContainEqual(expect.objectContaining({ content: expect.stringContaining("<cyrene_compaction_checkpoint>") }))
  })

  it("传入 modelContext 超预算时同样执行自动压缩并重读 journal", async () => {
    const deps = createBuildDeps()
    deps.loadModelSettings = () => ({
      provider: "test", baseUrl: "https://example.test", model: "m", apiKey: "k",
      contextWindowTokens: 10_000,
    })
    const compacted = [{ role: "system" as const, content: "<cyrene_compaction_checkpoint>\n摘要\n</cyrene_compaction_checkpoint>" }]
    deps.buildModelContext = vi.fn(async () => ({
      messages: compacted, uncertainEffects: [], throughSeq: 8,
    }))
    deps.compactTranscript = vi.fn(async () => ({ checkpointEntryId: "cp-1" }))

    const built = await buildAgentRunOptions({
      sessionId: "prebuilt-compact",
      currentUser: { turnId: "turn-1", text: "继续", visibleContent: "继续" },
      // 模拟桌面/渠道入口预传入的超长上下文
      modelContext: {
        messages: [{ role: "user" as const, content: "历史".repeat(2_000) }],
        uncertainEffects: [], throughSeq: 8,
      },
    } as never, deps)

    expect(deps.compactTranscript).toHaveBeenCalledWith(expect.objectContaining({
      conversationId: "prebuilt-compact", trigger: "automatic", retainTokens: expect.any(Number),
    }))
    // 压缩后只发生一次重读（初始上下文来自传入值）
    expect(deps.buildModelContext).toHaveBeenCalledTimes(1)
    expect(built.options.cleanMessages).toContainEqual(expect.objectContaining({ content: expect.stringContaining("<cyrene_compaction_checkpoint>") }))
  })

  it("自动 compaction 摘要失败时对外只报告 TRANSCRIPT_COMPACTION_REQUIRED", async () => {
    const deps = createBuildDeps()
    deps.loadModelSettings = () => ({
      provider: "test", baseUrl: "https://example.test", model: "m", apiKey: "k", contextWindowTokens: 100,
    })
    deps.buildModelContext = vi.fn(async () => ({
      messages: [{ role: "user" as const, content: "历史".repeat(300) }], uncertainEffects: [], throughSeq: 8,
    }))
    deps.compactTranscript = vi.fn(async () => { throw new Error("provider down") })

    await expect(buildAgentRunOptions({
      sessionId: "auto-compact-failure",
      currentUser: { turnId: "turn-1", text: "继续", visibleContent: "继续" },
    } as never, deps)).rejects.toThrow("TRANSCRIPT_COMPACTION_REQUIRED")
  })

  it("崩溃孤儿不确定效果并入 recoveryContext", async () => {
    const deps = createBuildDeps()
    deps.buildModelContext = vi.fn(async () => ({
      messages: [{ role: "user" as const, content: "authoritative" }],
      uncertainEffects: [{
        id: "run-1:call-1",
        toolCallId: "call-1",
        fingerprint: "send_email:abc",
        toolName: "send_email",
        message: "该外部副作用在应用中断时尚未确认结果",
      }],
      throughSeq: 5,
    }))

    const built = await buildAgentRunOptions({
      sessionId: "uncertain",
      currentUser: { turnId: "turn-1", text: "继续", visibleContent: "继续" },
      messages: [{ role: "user" as const, content: "继续" }],
    } as never, deps)

    expect(built.options.recoveryContext).toContain("send_email")
    expect(built.options.recoveryContext).toContain("不得自动重放")
  })

  it("开启社交上下文不再截断模型历史（slice(-12) 已废除）", async () => {
    const deps = createBuildDeps()
    deps.buildChatSocialContext = vi.fn(async () => ({ contextBlock: "SOCIAL", retrievedAtoms: [] }))
    const messages = Array.from({ length: 16 }, (_, index) => ({
      role: index % 2 === 0 ? "user" as const : "assistant" as const,
      content: `消息${index}`,
    }))

    const built = await buildAgentRunOptions({
      sessionId: "social-no-truncate",
      executionMode: "chat",
      userTurnId: "turn-8",
      assistantTurnId: "turn-7",
      messages,
    } as never, {
      ...deps,
      loadGeneralSettings: () => ({
        ...deps.loadGeneralSettings(),
        chatSocialContextEnabled: true,
      }),
    })

    // 16 条消息全部进入模型上下文，社交开关只影响检索块不再影响历史
    expect(built.options.cleanMessages).toHaveLength(16)
    expect(JSON.stringify(built.options.messages)).toContain("消息0")
    expect(JSON.stringify(built.options.messages)).toContain("消息15")
  })
})
