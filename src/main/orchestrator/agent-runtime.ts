import { app } from "electron";
import { loadPromptFile } from "../prompts/prompt-loader";
import type { AguiRunInput } from "../agui-bridge";
import type { ScheduledTask } from "../scheduler/types";
import type { ChannelId } from "../channels/types";
import type { ModelSettings } from "../settings/model-settings";
import type { GeneralSettings } from "../settings/general-settings";
import type { UserProfile } from "../settings-store";
import { resolveCaptionVisionConfig } from "./image-router";
import { getTimeoutSettings } from "../timeout-manager";
import { resolveModelSettingsProfile } from "../settings/model-settings";
import { normalizeChatMessages } from "../chat-api-utils";
import { parseObserverFeeling } from "../chat-stream-utils";
import { captionImageSafe, IMAGE_CAPTION_PROMPT } from "../chat/image-caption";
import { buildEnvironmentContext } from "./environment";
import { buildToneInjection } from "./tone-injector";
import { buildAlwaysOnContext, scheduleMemoryWrite } from "./index";
import { matchSticker } from "../sticker-embedder";
import { buildRelationshipContext, recordRelationshipTurn } from "../relationship/relationship-log";
import { compileSocialContextBlock } from "../social-context/context";
import * as momentsStore from "../moments/moments-store";
import { momentsService } from "../moments/moments-service";
import { buildMomentsContextBlock } from "../moments/moments-context";
import { rankSocialAtoms } from "../social-context/retrieval";
import {
  buildSkillCatalog,
  buildAutoInjectedSkillContext,
  buildAutoInjectedSoulContext,
  skillRegistry,
} from "../skills";
import { feelingToExpression } from "../runtime-state";
import { resolveSlashActivation } from "../skills/slash-activation";
import type { CitaService } from "../cita";
import type { SocialAtom, SocialExtractionInput } from "../social-context/types";
import type { ToolDefinition, ToolModeOverrides } from "./tools/registry/tool-registry";
import type { ConversationMode } from "../../shared/chat-types";
import {
  buildAgentRunOptions,
  onAgentRunFinished,
  type BuildOptionsDeps,
  type OnRunFinishedDeps,
  type ModelSettingsLite,
} from "./build-options";
import { buildModelContext } from "./conversation-transcript-context";
import { getConversationTranscriptStore } from "./conversation-transcript-store";
import { getHarnessRunStore } from "./harness/run-store";
import { ConversationTranscriptCompactor } from "./conversation-transcript-compactor";
import { type CyreneRunResult, type CyreneRunOptions } from "./cyrene-agent";
import type { HarnessToolFinishedEvent } from "./harness/types";
import type { ToolFinishedInput } from "../plugin-host/lifecycle-publisher";
import {
  buildToolSystemPrompt,
  buildSoulSystemBasePrompt,
  readStylePrompt,
  resolveSoulSamplingForStyle,
  loadSoulFeelingContext,
} from "./system-prompt-builder";
import { buildModePrompt } from "./mode-prompt-profile";
import { resolveRunCapabilities } from "./run-capabilities";
import { loadStickerSettings } from "./sticker-settings";
import type { RuntimeStateService } from "./runtime-state-service";
import type { LlmClient } from "../services/llm/llm-client";
import type {
  PluginTurnCompletedEvent,
  PluginPromptBuildInput,
  PluginPromptMode,
} from "../../plugins/types";

type EnqueueLLMTask = <T>(
  label: string,
  task: () => Promise<T>,
  options?: { log?: boolean; retryRateLimit?: boolean },
) => Promise<T>;

export interface AgentRuntimeDeps {
  runtimeStateService: RuntimeStateService;
  llmClient: LlmClient;
  enqueueLLMTask: EnqueueLLMTask;
  loadModelSettings: () => ModelSettings;
  loadGeneralSettings: () => GeneralSettings;
  loadUserProfile: () => UserProfile;
  toolRegistry: {
    getEnabledTools: () => ToolDefinition[];
    getEnabledToolsForMode: (mode: ConversationMode, overrides?: ToolModeOverrides) => ToolDefinition[];
  };
  skillRegistry: typeof skillRegistry;
  getStickerEmbeddingIndex: () => unknown;
  getEmbeddingProvider: () => unknown;
  broadcastRuntimeStateChanged: () => void;
  citaService: CitaService;
  socialContextScheduler: { schedule: (input: SocialExtractionInput) => void };
  chatsStore: { getWorkspaceBinding: (conversationId: string) => { workspaceRoot: string; displayName: string; boundAt: number } | undefined };
  socialAtomStore: { listActive: (conversationId: string, now: number) => SocialAtom[] };
  buildPluginPromptContext: (input: PluginPromptBuildInput) => Promise<string>;
  publishPluginHostEvent: <T>(event: string, payload: T) => Promise<void>;
  /** 工具完成事件发布入口；缺省不发布（早期装配与测试场景）。 */
  publishToolFinished?: (event: ToolFinishedInput) => void;
  /** Composition-root-owned singleton shared with manual CHATS_COMPACT. */
  transcriptCompactor?: ConversationTranscriptCompactor;
}

type SchedulerRunOptions = Omit<CyreneRunOptions, "toolSystemContent" | "soulSystemBaseContent">;

export interface AgentRunFinishedContext {
  source: PluginTurnCompletedEvent["source"];
  mode: PluginPromptMode;
  conversationId: string;
  channel?: string;
  runId?: string;
}

export interface AgentRuntime {
  buildOptions(input: AguiRunInput): Promise<{ options: CyreneRunOptions; latestUserText: string }>;
  onRunFinished(result: CyreneRunResult, latestUserText: string, context: AgentRunFinishedContext): Promise<{ sticker: string | null }>;
  buildSchedulerOptions(task: ScheduledTask): Promise<SchedulerRunOptions>;
}

export function createAgentRuntime(rawDeps: AgentRuntimeDeps): AgentRuntime {
  const runtimeStateService = rawDeps.runtimeStateService;
  const transcriptStore = getConversationTranscriptStore(app.getPath("userData"));
  const transcriptRunStore = getHarnessRunStore(app.getPath("userData"));
  // Production composition owns the singleton; unit/fallback callers retain
  // the same service contract but fail closed until one is injected.
  const transcriptCompactor = rawDeps.transcriptCompactor ?? new ConversationTranscriptCompactor({
    store: transcriptStore,
    runReader: transcriptRunStore,
    summarize: async () => { throw new Error("TRANSCRIPT_COMPACTION_REQUIRED"); },
  });

  async function observeRuntimeState(
    settings: ModelSettingsLite,
    _recentMessages: ReadonlyArray<{ role: "system" | "user" | "assistant"; content: string }>,
    _latestUserText: string,
    chatContent: string,
  ): Promise<void> {
    const recentDialogue = [{ role: "assistant" as const, content: chatContent }];

    await rawDeps.enqueueLLMTask(
      "心情观察器",
      async () => {
        const observerContent = await rawDeps.llmClient.chat(
          settings as ModelSettings,
          [
            {
              role: "system",
              content:
                "你是一个情绪分析器。以下是昔涟的完整人格设定：\n\n" +
                loadSoulFeelingContext() +
                "\n\n根据以上人格设定和以下对话，判断昔涟当前的心情状态。可选心情值（只能选其中一个）：平静 / 开心 / 温柔 / 激动 / 撒娇 / 担心 / 难过 / 感动 / 害羞。只返回 JSON，不要任何多余文字：{\"feeling\": \"心情值\"}。判断规则：以最后一轮对话为主，之前几轮为辅；判断的是昔涟的心情，不是用户的心情；无法判断时返回 平静。",
            },
            {
              role: "user",
              content: JSON.stringify({ recentDialogue }),
            },
          ],
          undefined,
          30000,
          "心情观察器",
          false,
        );
        const feeling = parseObserverFeeling(observerContent);
        if (feeling) {
          runtimeStateService.smoothFeeling(feeling);
        }
      },
      { log: false },
    ).catch((err) => {
      console.warn("[Cyrene] observe runtime failed; keeping current feeling:", err);
    });
  }

  function buildBuildOptionsDeps(): BuildOptionsDeps {
    return {
      loadModelSettings: (modelProfileId?: string) => resolveModelSettingsProfile(rawDeps.loadModelSettings(), modelProfileId),
      loadGeneralSettings: () => rawDeps.loadGeneralSettings(),
      loadUserProfile: () => rawDeps.loadUserProfile(),
      buildEnvironmentContext: ((model, profile) =>
        buildEnvironmentContext(model, profile as any)) as BuildOptionsDeps["buildEnvironmentContext"],
      buildSkillCatalog: ((skills) =>
        buildSkillCatalog(skills as any)) as BuildOptionsDeps["buildSkillCatalog"],
      buildAutoInjectedSkillContext: ((skills) =>
        buildAutoInjectedSkillContext(skills as any, (id) =>
          rawDeps.skillRegistry.getBody(id),
        )) as BuildOptionsDeps["buildAutoInjectedSkillContext"],
      buildAutoInjectedSoulContext: ((skills) =>
        buildAutoInjectedSoulContext(skills as any, (id) =>
          rawDeps.skillRegistry.getBody(id),
        )) as BuildOptionsDeps["buildAutoInjectedSoulContext"],
      skillRegistry: {
        getEnabled: () => rawDeps.skillRegistry.getEnabled() as unknown[],
        getEnabledForMode: (mode, overrides) =>
          rawDeps.skillRegistry.getEnabledForMode(mode, overrides) as unknown[],
        getBody: (id) => rawDeps.skillRegistry.getBody(id),
      },
      resolveSlashActivation: ((messages, mode, overrides) =>
        resolveSlashActivation(messages as any, mode, overrides)) as BuildOptionsDeps["resolveSlashActivation"],
      buildToneInjection: (() => buildToneInjection()) as BuildOptionsDeps["buildToneInjection"],
      buildAlwaysOnContext: ((userText, messages) =>
        buildAlwaysOnContext(userText, messages as any)) as BuildOptionsDeps["buildAlwaysOnContext"],
      buildRelationshipContext,
      buildModePrompt,
      buildToolSystemPrompt: ((mode, enabledTools) =>
        buildToolSystemPrompt(mode, enabledTools as ToolDefinition[])) as BuildOptionsDeps["buildToolSystemPrompt"],
      buildSoulSystemBasePrompt,
      resolveRunCapabilities: ({ mode, activeSearchBackend, toolModeOverrides, skillModeOverrides, chatToolsEnabled }) => resolveRunCapabilities({
        mode, activeSearchBackend, toolModeOverrides, skillModeOverrides, chatToolsEnabled,
        toolRegistry: rawDeps.toolRegistry,
        skillRegistry: rawDeps.skillRegistry,
      }),
      readStylePrompt,
      resolveSoulSampling: resolveSoulSamplingForStyle,
      toolRegistry: {
        getEnabled: () => rawDeps.toolRegistry.getEnabledTools() as unknown[],
        getEnabledToolsForMode: (mode: ConversationMode, overrides?: ToolModeOverrides) =>
          rawDeps.toolRegistry.getEnabledToolsForMode(mode, overrides) as unknown[],
      },
      normalizeChatMessages: ((raw) =>
        normalizeChatMessages(raw as any)) as BuildOptionsDeps["normalizeChatMessages"],
      chatRequestTimeoutMs: getTimeoutSettings().chatRequestTimeout,
      captionImageForFallback: async (filePath: string) => {
        // 走注入的设置加载（与 buildSchedulerOptions 同策略），保证可测且不绕过依赖装配
        const settings = resolveModelSettingsProfile(rawDeps.loadModelSettings());
        const vision = resolveCaptionVisionConfig(settings);
        if (!vision.ok) return { ok: false, error: vision.error };
        return captionImageSafe(filePath, IMAGE_CAPTION_PROMPT, vision.config);
      },
      prepareCitaTurn: (input) => rawDeps.citaService.prepareTurn(input),
      buildChatSocialContext: async ({ conversationId, query }) => {
        const now = Date.now();
        const active = rawDeps.socialAtomStore.listActive(conversationId, now);
        const retrievedAtoms = rankSocialAtoms(query, active, { now, limit: 5 });
        return {
          contextBlock: compileSocialContextBlock(retrievedAtoms),
          retrievedAtoms,
        };
      },
      buildMomentsContext: (query: string) => {
        // 只读本地 moments 数据（内存缓存），同步返回；initialize 幂等防御装配顺序
        momentsStore.initialize();
        return buildMomentsContextBlock(momentsStore.listFeed({ limit: 20 }), query, Date.now());
      },
      getWorkspaceBinding: (conversationId: string) => {
        return rawDeps.chatsStore.getWorkspaceBinding(conversationId);
      },
      buildPluginPromptContext: (input) => rawDeps.buildPluginPromptContext(input),
      // 权威轨迹上下文（CTA Phase 1）：桌面端与 bridge 共用同一 userData 根下的单例 store
      buildModelContext: (conversationId, retainTokens) => buildModelContext({
        store: transcriptStore,
        conversationId,
        retainTokens,
        runReader: transcriptRunStore,
      }),
      compactTranscript: (input) => transcriptCompactor.compact(input),
    };
  }

  function buildOnRunFinishedDeps(): OnRunFinishedDeps {
    return {
      loadModelSettings: () => rawDeps.loadModelSettings(),
      scheduleMemoryWrite,
      scheduleSocialAtomExtraction: (input) => rawDeps.socialContextScheduler.schedule(input),
      scheduleMomentsTurn: (input) => momentsService.scheduleTurn(input),
      inferRuntimeState: ((userText, reply, flag) =>
        runtimeStateService.inferFromText(userText, reply, flag)) as OnRunFinishedDeps["inferRuntimeState"],
      runtimeState: runtimeStateService.getState(),
      feelingToExpression,
      setRuntimeState: ((next) =>
        runtimeStateService.setStateWithoutNotify(next as any)) as OnRunFinishedDeps["setRuntimeState"],
      stickerEmbeddingIndex: rawDeps.getStickerEmbeddingIndex(),
      getEmbeddingProvider: (() => rawDeps.getEmbeddingProvider() as unknown) as OnRunFinishedDeps["getEmbeddingProvider"],
      matchSticker: ((text, provider, index, threshold) =>
        matchSticker(text, provider as any, index as any, threshold) as Promise<{
          id: string;
        } | null | undefined>) as OnRunFinishedDeps["matchSticker"],
      loadStickerSettings,
      broadcastRuntimeStateChanged: rawDeps.broadcastRuntimeStateChanged,
      observeRuntimeState: ((settings, history, userText, reply) =>
        observeRuntimeState(settings as ModelSettingsLite, history as any, userText, reply)) as OnRunFinishedDeps["observeRuntimeState"],
      recordRelationshipTurn,
    };
  }

  // 工具完成观察回调：harness 事件结构与插件事件字段一一对应，直接透传；
  // 未配置发布入口时不注入，harness 侧零开销。
  const onToolFinished = rawDeps.publishToolFinished
    ? (event: HarnessToolFinishedEvent) => rawDeps.publishToolFinished!(event)
    : undefined;

  return {
    buildOptions: async (input) => {
      const buildOptionsDeps = buildBuildOptionsDeps();
      const { options, latestUserText } = await buildAgentRunOptions(input, buildOptionsDeps);
      return { options: { ...options, onToolFinished }, latestUserText };
    },

    onRunFinished: async (result, latestUserText, context) => {
      const onRunFinishedDeps = buildOnRunFinishedDeps();
      const effects = await onAgentRunFinished(
        result,
        latestUserText,
        onRunFinishedDeps,
        context.channel as ChannelId | undefined,
        context.conversationId,
        { runId: context.runId, source: context.source, mode: context.mode },
      );
      // 调用方应只在成功终态进入收尾；此处再守住插件事件契约，避免未来新增入口误报完成。
      const terminalStatus = result.terminal?.status;
      if (terminalStatus !== undefined && terminalStatus !== "success") {
        return effects;
      }
      const payload: PluginTurnCompletedEvent = {
        source: context.source,
        mode: context.mode,
        conversationId: context.conversationId,
        ...(context.channel ? { channel: context.channel } : {}),
        ...(context.runId ? { runId: context.runId } : {}),
      };
      // 插件监听器属于旁路扩展：不等待它们，避免第三方插件延迟主回复的终态事件。
      void rawDeps.publishPluginHostEvent("turn:completed", payload).catch((error) => {
        console.warn("[plugins] 发布对话轮次完成事件失败", error);
      });
      return effects;
    },

    buildSchedulerOptions: async (task) => {
      // 与 channel bot / 聊天路径同策略：先展开默认模型档案再取顶层镜像，
      // 否则用户只在档案里配模型时顶层 baseUrl/apiKey 可能为空，定时任务会调不到 LLM。
      const settings = resolveModelSettingsProfile(rawDeps.loadModelSettings());
      const profile = rawDeps.loadUserProfile();
      const generalSettings = rawDeps.loadGeneralSettings();
      // 会话模式取任务冻结字段（旧任务默认 work）：skill 过滤、模式提示词
      // 和插件提示词上下文都跟随该模式。
      const mode = task.mode ?? "work";
      const messages = [{ role: "user" as const, content: task.prompt }];
      // 定时任务按任务模式过滤 skill，并尊重 skill-模式覆盖层；
      // 与聊天路径同约定：chat 模式不暴露 skill。
      const scheduledSkills = mode === "chat"
        ? []
        : rawDeps.skillRegistry.getEnabledForMode(mode, generalSettings.skillModeOverrides);
      const systemContent = [
        buildModePrompt(mode),
        buildEnvironmentContext({ provider: settings.provider, model: settings.model }, profile),
        buildSkillCatalog(scheduledSkills),
        await buildAlwaysOnContext(task.prompt, messages),
        await rawDeps.buildPluginPromptContext({
          source: "scheduler",
          mode,
          userText: task.prompt,
        }),
      ].join("\n\n---\n\n");
      return {
        settings: {
          provider: settings.provider,
          baseUrl: settings.baseUrl,
          model: settings.model,
          apiKey: settings.apiKey,
          // 协议与推理偏好需与聊天路径一致透传，否则定时任务会按默认协议发请求。
          explicitTransport: settings.explicitTransport,
          reasoning: settings.reasoning,
          contextWindowTokens: settings.contextWindowTokens,
        },
        messages: [{ role: "system" as const, content: systemContent }, ...messages],
        // 定时任务也不因整轮耗时被中断；仍保留单次模型/工具自身的超时。
        timeoutMs: 0,
        onToolFinished,
      };
    },
  };
}
