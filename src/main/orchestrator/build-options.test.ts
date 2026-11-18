import * as fs from "fs"
import * as os from "os"
import * as path from "path"
import { describe, expect, it, vi } from "vitest"
import {
  buildAgentRunOptions,
  buildChannelSystem,
  onAgentRunFinished,
  type BuildOptionsDeps,
  type OnRunFinishedDeps,
} from "./build-options"
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
    },
    resolveSlashActivation: () => "",
    buildToneInjection: async () => "",
    sceneEmbeddingIndex: null,
    getSceneEmbeddingProvider: () => null,
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
    loadActionGateSystemPrompt: () => "",
    loadNativeFcSystemPrompt: () => "",
    loadAskSystemPrompt: () => "ASK_SYSTEM",
    loadAskPersonaPrompt: () => "ASK_PERSONA",
    loadAskQuotesPrompt: () => "ASK_QUOTES",
  }
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
  it("builds the lightweight Ask Soul prompt in the approved order with trusted identity only", async () => {
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

    expect(askOptions.askSystemContent).toBe("ASK_SYSTEM\n\nASK_PERSONA\n\nASK_QUOTES")
    expect(askOptions.trustedAskUserProfile).toEqual({
      nickname: "小王",
      callPreference: "伙伴",
      gender: "male",
    })
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

  it("keeps private desktop context out of Discord guest and guild prompts", async () => {
    const deps = createBuildDeps();
    const loadSettings = deps.loadGeneralSettings;
    deps.loadGeneralSettings = () => ({ ...loadSettings(), chatSocialContextEnabled: true });
    deps.loadUserProfile = vi.fn(() => ({ nickname: "Private owner", timezone: "Asia/Taipei" }));
    deps.buildAlwaysOnContext = vi.fn(async () => "PRIVATE_MEMORY");
    deps.buildRelationshipContext = vi.fn(async () => "PRIVATE_RELATIONSHIP");
    deps.buildEnvironmentContext = vi.fn(() => "PRIVATE_ENVIRONMENT");
    deps.buildAutoInjectedSoulContext = vi.fn(() => "PRIVATE_SKILL");
    deps.resolveSlashActivation = vi.fn(() => "PRIVATE_ACTIVATION");
    deps.buildChatSocialContext = vi.fn(async () => ({ contextBlock: "PRIVATE_SOCIAL", retrievedAtoms: [] }));
    deps.getWorkspaceBinding = vi.fn(() => ({ workspaceRoot: "/private", displayName: "Private", boundAt: 0 }));
    const messages = [{ role: "assistant", content: "Scoped prior turn" }, { role: "user", content: "Latest turn" }];

    const { options } = await buildAgentRunOptions({
      channel: "discord", mode: "work", executionMode: "work", sessionId: "discord-guild",
      userTurnId: "user", assistantTurnId: "assistant", messages,
    }, deps);
    expect(options.executionMode).toBe("chat");
    expect(options.cleanMessages).toEqual(messages);
    expect(options.soulSystemBaseContent).toContain("SOUL_SYSTEM_BASE");
    expect(options.soulSystemBaseContent).not.toContain("PRIVATE_");
    expect(options.runtimeEnvironmentContext).toBe("");
    expect(options.resolvedWorkspaceRoot).toBeUndefined();
    expect(options.trustedAskUserProfile).toEqual({ gender: "unknown" });
    expect(options.socialContext).toBeUndefined();
    expect(deps.loadUserProfile).not.toHaveBeenCalled();
    expect(deps.getWorkspaceBinding).not.toHaveBeenCalled();
    expect(deps.buildChatSocialContext).not.toHaveBeenCalled();

    const owner = await buildAgentRunOptions({ channel: "discord", executionMode: "chat", messages }, deps, true);
    expect(owner.options.soulSystemBaseContent).toContain("PRIVATE_MEMORY");
    expect(owner.options.soulSystemBaseContent).toContain("PRIVATE_RELATIONSHIP");
    expect(owner.options.soulSystemBaseContent).toContain("PRIVATE_SOCIAL");
  });

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
    expect(result.options.soulSystemBaseContent).toContain("RELATIONSHIP")
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

  it("messages 不含 system，FC 循环按阶段动态注入", async () => {
    const result = await buildAgentRunOptions({
      messages: [{ role: "user", content: "你好" }],
      style: "01_default.md",
    }, createBuildDeps())

    // 第一期：原始 messages 不含 system 消息
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
    expect(result.options.soulSystemBaseContent).toContain("## Internal Context Policy")
    expect(result.options.toolSystemContent).toContain("## Internal Context Policy")
    expect(result.options.soulSystemBaseContent).toContain("[对话时间信息]")
    expect(result.options.soulSystemBaseContent).toContain("距离上一条有效聊天消息：约 14 小时 58 分钟")
    expect(result.options.soulSystemBaseContent.match(/距离上一条有效聊天消息/g)).toHaveLength(1)
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
    expect(result.options.soulSystemBaseContent).toContain("STYLE_PROMPT:lively")
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
    expect(result.options.messages).toHaveLength(12)
    expect(result.options.soulSystemBaseContent).toContain("用户喜欢海边")
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

    for (const result of [chat, work]) {
      expect(result.options.soulSystemBaseContent).toContain("STYLE_PROMPT:sweet")
      expect(result.options.soulSampling).toEqual({ temperature: 0.82, frequencyPenalty: 0.2 })
    }
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
    expect(result.options.toolSystemContent).toContain("[CITA_CONTEXT]")
    expect(result.options.toolSystemContent).toContain("music-candidate-1")
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
    expect(result.options.soulSystemBaseContent).toContain("SOUL_MUSIC_REPLY_RULES")
  })

  it("attaches direct image content blocks to the latest user message", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cyrene-image-direct-"))
    const imagePath = path.join(dir, "图 像.png")
    fs.writeFileSync(imagePath, Buffer.from([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
      0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
    ]))

    const result = await buildAgentRunOptions({
      messages: [
        { role: "user", content: "上一轮" },
        { role: "assistant", content: "好的" },
        { role: "user", content: "请看这张图" },
      ],
      style: "01_default.md",
      imageAttachments: [{ name: "图 像.png", filePath: imagePath, mime: "image/png" }],
    }, createBuildDeps())

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
