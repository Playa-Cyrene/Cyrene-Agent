import { powerMonitor } from "electron";
import * as chatsStore from "../chats/chats-store";
import { broadcastChatsChanged } from "../chats/chats-ipc";
import type { ConversationJournalService } from "../orchestrator/conversation-journal-service";
import { setChannelsConversationLifecycle } from "../channels/init";
import { channelManager } from "../channels/manager";
import {
  canStartProactiveChannelDelivery,
  sendProactiveChannelMessage,
} from "../channels/proactive-delivery";
import { resolveChatContextTimezone } from "../chat-time-context";
import { buildAlwaysOnContext, buildMemoryInjection } from "../orchestrator";
import { loadPromptFile } from "../prompts/prompt-loader";
import type { GeneralSettings } from "../settings/general-settings";
import { loadModelSettings } from "../settings/model-settings";
import { loadUserProfile } from "../settings-store";
import { createProactiveChatService } from "./proactive-service";
import type {
  ProactiveChatService,
  ProactiveCommitInput,
  ProactiveCommitResult,
} from "./proactive-service";
import { routeProactiveDelivery } from "./proactive-delivery-routing";
import { buildProactiveMessages, type ProactiveHistoryTurn } from "./proactive-prompt";
import { canCommitProactiveMessage } from "./proactive-policy";
import { loadProactiveState, saveProactiveState } from "./proactive-state-store";
import { createProactiveTrigger, type ProactiveTriggerController } from "./proactive-trigger";
import { runProactiveModel } from "./proactive-model";
import type { ProactiveCandidate, ProactiveRuntimeSnapshot } from "./proactive-types";

export interface ProactiveLifecycleOptions {
  loadGeneralSettings: () => GeneralSettings;
  conversationJournal: ConversationJournalService;
}

export interface ProactiveLifecycle {
  initializeProactiveChatService: () => void;
  initializeProactiveTrigger: () => void;
  stopProactiveTrigger: () => void;
  getProactiveChatService: () => ProactiveChatService | null;
  proactiveConversationLifecycle: {
    onUserMessage: () => void;
    onConversationStarted: () => void;
    onConversationEnded: () => void;
  };
}

export function createProactiveLifecycle(options: ProactiveLifecycleOptions): ProactiveLifecycle {
  let proactiveChatService: ProactiveChatService | null = null;
  let proactiveTrigger: ProactiveTriggerController | null = null;
  const proactiveBackoffMap = new Map<string, number>();
  const conversationJournal = options.conversationJournal;
  let normalConversationBusyCount = 0;
  let proactiveScreenLocked = false;

  function buildProactivePersonaPrompt(): string {
    const parts: string[] = [];
    const chatSystem = loadPromptFile("chat_system.md");
    if (chatSystem) parts.push(chatSystem);
    const soul = loadPromptFile("soul.md");
    if (soul) {
      // 主动轮完全不携带工具说明；Soul 尾部的 Live2D/联网章节由正常聊天使用。
      parts.push(soul.split("\n## Live2D 与聊天文字的分工")[0].trim());
    }
    const canon = loadPromptFile("canon_quotes.md");
    if (canon) parts.push(canon);
    const style = loadPromptFile("styles/01_default.md");
    if (style) parts.push(style);
    return parts.join("\n\n---\n\n");
  }

  function toProactiveHistory(
    messages: Array<{ role: "user" | "model"; content: string; at: number }>,
  ): ProactiveHistoryTurn[] {
    return messages
      .filter((message) => message.content.trim())
      .slice(-16)
      .map((message) => ({ role: message.role, content: message.content, at: message.at }));
  }

  async function getProactiveHistories(): Promise<{ ordinary: ProactiveHistoryTurn[]; proactive: ProactiveHistoryTurn[] }> {
    const ordinaryMeta = chatsStore.listSessions().find((session) => session.purpose !== "proactive-chat");
    const [ordinaryProjection, proactiveProjection] = await Promise.all([
      ordinaryMeta ? conversationJournal.readProjection(ordinaryMeta.id) : Promise.resolve(null),
      (chatsStore.listSessions().find((session) => session.purpose === "proactive-chat")
        ? conversationJournal.readProjection(chatsStore.listSessions().find((session) => session.purpose === "proactive-chat")!.id)
        : Promise.resolve(null)),
    ]);
    return {
      ordinary: toProactiveHistory(ordinaryProjection?.messages ?? []),
      proactive: toProactiveHistory(proactiveProjection?.messages ?? []),
    };
  }

  function getProactiveRuntimeSnapshot(): ProactiveRuntimeSnapshot {
    const now = Date.now();
    let idleSec = Number.POSITIVE_INFINITY;
    try { idleSec = powerMonitor.getSystemIdleTime(); } catch { /* app 尚未 ready */ }
    return {
      now,
      localHour: new Date(now).getHours(),
      idleSec,
      enabled: options.loadGeneralSettings().proactiveChatMode === "on",
      conversationBusy: normalConversationBusyCount > 0,
      generationBusy: false,
      screenLocked: proactiveScreenLocked,
    };
  }

  async function buildProactiveAgentMessages(candidate: ProactiveCandidate) {
    const histories = await getProactiveHistories();
    const recentTopic = histories.ordinary.slice(-4).map((turn) => turn.content).join("\n");
    const retrievalQuery = `${candidate.sceneId}\n${recentTopic}`.trim();
    const [profileContext, memoryContext] = await Promise.all([
      buildAlwaysOnContext(retrievalQuery, histories.ordinary.map((turn) => ({ role: turn.role, content: turn.content }))).catch(() => ""),
      buildMemoryInjection(retrievalQuery).catch(() => ""),
    ]);
    const state = loadProactiveState();
    const snapshot = getProactiveRuntimeSnapshot();
    // 用户有效时区：resolver 校验后传给 prompt，禁止未校验的 profile.timezone。
    const profile = loadUserProfile();
    const timezone = resolveChatContextTimezone(profile.timezone);
    return buildProactiveMessages({
      basePersona: buildProactivePersonaPrompt(),
      userProfile: profileContext,
      relevantMemory: memoryContext,
      ordinaryHistory: histories.ordinary,
      proactiveHistory: histories.proactive,
      sceneId: candidate.sceneId,
      localNow: new Date(snapshot.now),
      idleSec: snapshot.idleSec,
      unansweredCount: state.unansweredCount,
      timezone,
    });
  }

  function updateNormalConversationBusy(delta: 1 | -1): void {
    normalConversationBusyCount = Math.max(0, normalConversationBusyCount + delta);
  }

  function bestEffortConversationStateUpdate(label: string, update: () => void): void {
    try {
      update();
    } catch (error) {
      // Conversation delivery remains authoritative; a telemetry/cooldown state
      // write failure must not replace the original AG-UI or channel error.
      console.warn(`[Proactive] ${label} state update failed`, error);
    }
  }

  const proactiveConversationLifecycle = {
    onUserMessage: () => bestEffortConversationStateUpdate("user_message", () => proactiveChatService?.invalidateForUserMessage()),
    onConversationStarted: () => {
      updateNormalConversationBusy(1);
      bestEffortConversationStateUpdate("conversation_started", () => proactiveChatService?.normalConversationStarted());
    },
    onConversationEnded: () => {
      updateNormalConversationBusy(-1);
      if (normalConversationBusyCount === 0) {
        bestEffortConversationStateUpdate("conversation_ended", () => proactiveChatService?.normalConversationEnded());
      }
    },
  };

  function getProactiveCommitDecision(candidate: ProactiveCandidate, generationEpoch: number) {
    return canCommitProactiveMessage(
      getProactiveRuntimeSnapshot(),
      loadProactiveState(),
      candidate,
      generationEpoch,
    );
  }

  function recordProactiveDeliveryMetadata(input: ProactiveCommitInput): void {
    // Opener 的 todayFired/recentItems 字段已整体废弃（依赖的 SCENE_CONFIGS 与 ShowBubblePayload 来自旧 opener 子系统）。
    // ProactiveChat 这边只需持久化 committed 副作用；当前 implementation 已无副作用，留空占位即可。
    void input;
  }

  async function commitLocalProactiveMessage(input: ProactiveCommitInput): Promise<ProactiveCommitResult> {
    const initialDecision = getProactiveCommitDecision(input.candidate, input.generationEpoch);
    if (!initialDecision.allowed) return { kind: "cancelled", reason: initialDecision.reason };
    if (!input.intentId) return { kind: "cancelled", reason: "durable_intent_required" };

    const session = chatsStore.getOrCreateSessionByPurpose("proactive-chat", {
      title: "昔涟的主动消息",
      identityId: null,
    });
    // Stable business identity makes a retry after a derived snapshot failure
    // resolve the same canonical assistant entry instead of duplicating it.
    const commitKey = input.intentId;
    const runId = commitKey;
    const intentAt = input.intentAt ?? 0;
    const sink = conversationJournal.createRunSink({ conversationId: session.id, runId });
    try {
      const assistantEntryId = await sink.appendAssistant({
        message: { role: "assistant", content: input.text },
        roundId: "proactive",
      });
      await conversationJournal.appendPresentationNext(
        session.id,
        assistantEntryId,
        `${commitKey}:presentation`,
        { content: input.text, runSnapshot: { runId, status: "terminal", updatedAt: intentAt } },
      );
      await sink.checkpoint();
    } catch (error) {
      throw error;
    }
    broadcastChatsChanged();

    // 文本已落库；上次落库后没有 panel/show 步骤要做（opener 气泡已被移除，fallback 路径没有了）。
    void input;
    return { kind: "committed" };
  }

  async function commitSelectedProactiveMessage(input: ProactiveCommitInput): Promise<ProactiveCommitResult> {
    const settings = options.loadGeneralSettings();
    const target = input.deliveryTarget ?? settings.proactiveDeliveryTarget;
    const result = await routeProactiveDelivery(target, {
      commitLocal: () => commitLocalProactiveMessage(input),
      commitChannel: async (channel) => {
        // External channel delivery remains the legacy direct path until Task 11.
        const channelResult = await sendProactiveChannelMessage({
          channel,
          text: input.text,
          mobileMessageSegmentation: settings.mobileMessageSegmentation,
          manager: channelManager,
          canContinue: () => {
            if (options.loadGeneralSettings().proactiveDeliveryTarget !== channel) return false;
            return getProactiveCommitDecision(input.candidate, input.generationEpoch).allowed;
          },
        });
        return channelResult.kind === "committed"
          ? { kind: "committed" }
          : { kind: "cancelled", reason: channelResult.reason };
      },
    });

    if (result.kind === "committed") recordProactiveDeliveryMetadata(input);
    return result;
  }

  function initializeProactiveChatService(): void {
    proactiveChatService = createProactiveChatService({
      loadState: loadProactiveState,
      saveState: (state) => {
        saveProactiveState(state);
      },
      getSnapshot: getProactiveRuntimeSnapshot,
      buildMessages: async (candidate) => buildProactiveAgentMessages(candidate),
      runModel: async (messages) => {
        const settings = loadModelSettings();
        if (!settings.apiKey) return { kind: "error", reason: "missing_api_key" };
        return runProactiveModel({
          settings: {
            provider: settings.provider,
            baseUrl: settings.baseUrl,
            model: settings.model,
            apiKey: settings.apiKey,
            explicitTransport: settings.explicitTransport,
            reasoning: settings.reasoning,
          },
          messages,
          timeoutMs: 45_000,
        });
      },
      // Opener 的 preset fallback 已移除：model 失败时由 proactive-service 自身走 cancel 路径。
      getFallback: async () => null,
      canStartDelivery: () => {
        const target = options.loadGeneralSettings().proactiveDeliveryTarget;
        return target === "local" || canStartProactiveChannelDelivery(target, channelManager);
      },
      requiresDurableIntent: () => options.loadGeneralSettings().proactiveDeliveryTarget === "local",
      getDeliveryTarget: () => options.loadGeneralSettings().proactiveDeliveryTarget,
      commitMessage: commitSelectedProactiveMessage,
      log: (event, detail) => console.log(`[Proactive] ${event}`, detail ?? ""),
    });

    setChannelsConversationLifecycle(proactiveConversationLifecycle);

    powerMonitor.on("lock-screen", () => {
      proactiveScreenLocked = true;
      proactiveChatService?.invalidate();
    });
    powerMonitor.on("unlock-screen", () => { proactiveScreenLocked = false; });
    powerMonitor.on("suspend", () => {
      proactiveScreenLocked = true;
      proactiveChatService?.invalidate();
    });
    powerMonitor.on("resume", () => { proactiveScreenLocked = false; });
  }

  function initializeProactiveTrigger(): void {
    if (proactiveTrigger) return; // 幂等
    if (!proactiveChatService) {
      console.warn("[Proactive] trigger skipped: service not initialized");
      return;
    }
    const service = proactiveChatService;
    proactiveTrigger = createProactiveTrigger({
      evaluateCandidate: (c) => service.evaluateCandidate(c),
      getRuntimeSnapshot: getProactiveRuntimeSnapshot,
      getProactiveState: loadProactiveState,
      getTimezone: () => resolveChatContextTimezone(loadUserProfile().timezone),
      // getWeatherContext 第一版不传：未来天气缓存接入后填，函数体无需改
      getLastEvaluatedAtByScene: () => new Map(proactiveBackoffMap),
      setLastEvaluatedAtByScene: (next) => {
        proactiveBackoffMap.clear();
        for (const [k, v] of next) proactiveBackoffMap.set(k, v);
      },
    });
    proactiveTrigger.start();
  }

  function stopProactiveTrigger(): void {
    proactiveTrigger?.stop();
    proactiveTrigger = null;
  }

  return {
    initializeProactiveChatService,
    initializeProactiveTrigger,
    stopProactiveTrigger,
    getProactiveChatService: () => proactiveChatService,
    proactiveConversationLifecycle,
  };
}
