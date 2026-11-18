import { loadPromptFile } from "../prompts/prompt-loader";
import type { AguiRunInput } from "../agui-bridge";
import type { ScheduledTask } from "../scheduler/types";
import type { ModelSettings } from "../settings/model-settings";
import type { GeneralSettings } from "../settings/general-settings";
import type { UserProfile } from "../settings-store";
import { loadVisionConfig } from "../settings/model-settings";
import { getTimeoutSettings } from "../timeout-manager";
import { resolveModelSettingsProfile } from "../settings/model-settings";
import { normalizeChatMessages } from "../chat-api-utils";
import { parseObserverFeeling } from "../chat-stream-utils";
import { validateCaptionImagePath, IMAGE_CAPTION_PROMPT } from "../chat/image-caption";
import { buildEnvironmentContext } from "./environment";
import { buildToneInjection } from "./tone-injector";
import { buildAlwaysOnContext, scheduleMemoryWrite } from "./index";
import { matchSticker } from "../sticker-embedder";
import { buildRelationshipContext, recordRelationshipTurn } from "../relationship/relationship-log";
import { compileSocialContextBlock } from "../social-context/context";
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
import type { ToolDefinition, ToolModeOverrides } from "./tool-registry";
import type { ConversationMode } from "../../shared/chat-types";
import {
  buildAgentRunOptions,
  onAgentRunFinished,
  type BuildOptionsDeps,
  type OnRunFinishedDeps,
  type ModelSettingsLite,
} from "./build-options";
import { type CyreneRunResult, type CyreneRunOptions } from "./cyrene-agent";
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
  getSceneEmbeddingIndex: () => unknown;
  getStickerEmbeddingIndex: () => unknown;
  getEmbeddingProvider: () => unknown;
  getSceneEmbeddingProvider: () => unknown;
  broadcastRuntimeStateChanged: () => void;
  citaService: CitaService;
  socialContextScheduler: { schedule: (input: SocialExtractionInput) => void };
  chatsStore: { getWorkspaceBinding: (conversationId: string) => { workspaceRoot: string; displayName: string; boundAt: number } | undefined };
  socialAtomStore: { listActive: (conversationId: string, now: number) => SocialAtom[] };
}

type SchedulerRunOptions = Omit<CyreneRunOptions, "toolSystemContent" | "soulSystemBaseContent">;

export interface AgentRuntime {
  buildOptions(input: AguiRunInput, includePrivateDiscordContext?: boolean): Promise<{ options: CyreneRunOptions; latestUserText: string }>;
  onRunFinished(result: CyreneRunResult, latestUserText: string, channel?: "wechat" | "feishu" | "discord", conversationId?: string): Promise<{ sticker: string | null }>;
  buildSchedulerOptions(task: ScheduledTask): Promise<SchedulerRunOptions>;
}

export function createAgentRuntime(rawDeps: AgentRuntimeDeps): AgentRuntime {
  const runtimeStateService = rawDeps.runtimeStateService;

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
      },
      resolveSlashActivation: ((messages, mode, overrides) =>
        resolveSlashActivation(messages as any, mode, overrides)) as BuildOptionsDeps["resolveSlashActivation"],
      buildToneInjection: ((userText, messages, provider, index) =>
        buildToneInjection(userText, messages as any, provider as any, index as any)) as BuildOptionsDeps["buildToneInjection"],
      sceneEmbeddingIndex: rawDeps.getSceneEmbeddingIndex(),
      getSceneEmbeddingProvider: (() =>
        rawDeps.getSceneEmbeddingProvider() as unknown) as BuildOptionsDeps["getSceneEmbeddingProvider"],
      buildAlwaysOnContext: ((userText, messages) =>
        buildAlwaysOnContext(userText, messages as any)) as BuildOptionsDeps["buildAlwaysOnContext"],
      buildRelationshipContext,
      buildModePrompt,
      buildToolSystemPrompt: ((mode, enabledTools, isOptimizedFirstRound) =>
        buildToolSystemPrompt(mode, enabledTools as ToolDefinition[], isOptimizedFirstRound)) as BuildOptionsDeps["buildToolSystemPrompt"],
      buildSoulSystemBasePrompt,
      resolveRunCapabilities: ({ mode, activeSearchBackend, toolModeOverrides, skillModeOverrides }) => resolveRunCapabilities({
        mode, activeSearchBackend, toolModeOverrides, skillModeOverrides,
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
        const validated = validateCaptionImagePath(filePath);
        if (!validated.ok) return { ok: false, error: validated.error };
        const visionCfg = loadVisionConfig();
        if (!visionCfg) return { ok: false, error: "未配置视觉模型，无法分析图片" };
        try {
          const { captionImage } = await import("./vision-captioner");
          const caption = await captionImage(
            { base64: validated.buffer.toString("base64"), mime: validated.mime },
            IMAGE_CAPTION_PROMPT,
            visionCfg,
          );
          if (caption.startsWith("[错误")) return { ok: false, error: caption };
          return { ok: true, caption };
        } catch (err: any) {
          return { ok: false, error: err?.message || String(err) };
        }
      },
      loadActionGateSystemPrompt: () => loadPromptFile("action_gate_system.md"),
      loadNativeFcSystemPrompt: () => loadPromptFile("native_fc_system.md"),
      loadAskSystemPrompt: () => loadPromptFile("ask_system.md"),
      loadAskPersonaPrompt: () => loadPromptFile("ask_persona.md"),
      loadAskQuotesPrompt: () => loadPromptFile("ask_quotes.md"),
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
      getWorkspaceBinding: (conversationId: string) => {
        return rawDeps.chatsStore.getWorkspaceBinding(conversationId);
      },
    };
  }

  function buildOnRunFinishedDeps(): OnRunFinishedDeps {
    return {
      loadModelSettings: () => rawDeps.loadModelSettings(),
      scheduleMemoryWrite,
      scheduleSocialAtomExtraction: (input) => rawDeps.socialContextScheduler.schedule(input),
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

  return {
    buildOptions: async (input, includePrivateDiscordContext) => {
      const buildOptionsDeps = buildBuildOptionsDeps();
      return buildAgentRunOptions(input, buildOptionsDeps, includePrivateDiscordContext);
    },

    onRunFinished: async (result, latestUserText, channel, conversationId) => {
      const onRunFinishedDeps = buildOnRunFinishedDeps();
      return onAgentRunFinished(result, latestUserText, onRunFinishedDeps, channel, conversationId);
    },

    buildSchedulerOptions: async (task) => {
      const settings = rawDeps.loadModelSettings();
      const profile = rawDeps.loadUserProfile();
      const generalSettings = rawDeps.loadGeneralSettings();
      const messages = [{ role: "user" as const, content: task.prompt }];
      // 定时任务默认按 work 模式过滤 skill，并尊重 skill-模式覆盖层。
      const scheduledSkills = rawDeps.skillRegistry.getEnabledForMode(
        "work",
        generalSettings.skillModeOverrides,
      );
      const systemContent = [
        buildModePrompt("work"),
        buildEnvironmentContext({ provider: settings.provider, model: settings.model }, profile),
        buildSkillCatalog(scheduledSkills),
        await buildAlwaysOnContext(task.prompt, messages),
      ].join("\n\n---\n\n");
      return {
        settings: {
          provider: settings.provider,
          baseUrl: settings.baseUrl,
          model: settings.model,
          apiKey: settings.apiKey,
          contextWindowTokens: settings.contextWindowTokens,
        },
        messages: [{ role: "system" as const, content: systemContent }, ...messages],
        // 定时任务也不因整轮耗时被中断；仍保留单次模型/工具自身的超时。
        timeoutMs: 0,
      };
    },
  };
}
