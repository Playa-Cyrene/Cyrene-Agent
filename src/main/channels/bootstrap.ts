import type { BrowserWindow } from "electron";
import { randomUUID } from "node:crypto";
import { IPC } from "../../shared/ipc-channels";
import { loadGeneralSettings } from "../settings/settings-facade";
import { loadModelSettings, loadVisionConfig, getDefaultModelProfile, listSavedModelProfiles } from "../settings/model-settings";
import { CyreneAgent } from "../orchestrator/cyrene-agent";
import { toolRegistry } from "../orchestrator/tool-registry";
import { decideImageSendStrategy } from "../chat/image-send-strategy";
import {
  IMAGE_CAPTION_PROMPT,
  validateCaptionImagePath,
} from "../chat/image-caption";
import { indexConversationTurn } from "../orchestrator/history-tools";
import type { AgentRuntime } from "../orchestrator/agent-runtime";
import type { TtsSynthesisService } from "../services/tts/tts-synthesis-service";
import { buildChannelAttachmentInputs } from "./agent-input";
import { loadChannelsSettings } from "./settings-store";
import { resolveChannelAgentPolicy } from "./agent-policy";
import {
  setDispatcherBuildAndRunAgent,
  setDispatcherBroadcastChat,
  setDispatcherLoadGeneralSettings,
  setDispatcherLoadRecentHistory,
  setDispatcherSynthesizeTts,
} from "./dispatcher";
import { initChannels, shutdownChannels } from "./init";
import { getDiscordMessageAccess, isDiscordOwnerDm } from "./adapters/discord/access";
import { getDiscordSessionWorkspace, recordDiscordError } from "./adapters/discord/discord-session";
import { buildDiscordMessageText } from "./adapters/discord/message-context";
import { runDiscordChatWithFallback } from "./adapters/discord/model-fallback";

export interface ChannelsSubsystem {
  shutdown(): Promise<void>;
}

export interface ChannelsSubsystemDeps {
  agentRuntime: AgentRuntime;
  ttsSynthesisService: TtsSynthesisService;
  getReactChatWindow: () => BrowserWindow | null;
}

export function createChannelsSubsystem(deps: ChannelsSubsystemDeps): ChannelsSubsystem {
  setDispatcherLoadRecentHistory(async (sessionId, limit) => {
    const { loadRecentHistory } = await import("./history-log");
    return loadRecentHistory(sessionId, limit);
  });
  setDispatcherLoadGeneralSettings(loadGeneralSettings);

  setDispatcherBuildAndRunAgent(async (msg, sessionId, priorMessages) => {
    const channelResult: { text: string; sticker: string | null } = { text: "", sticker: null };

    const isDiscord = msg.channel === "discord";
    const discordAccess = isDiscord ? getDiscordMessageAccess(msg) : undefined;
    const ownerDm = isDiscordOwnerDm(msg);
    const channelSettings = loadChannelsSettings();
    const sandbox = discordAccess
      ? (discordAccess.mode === "work" ? "all" : "off")
      : channelSettings.toolSandbox;
    const policy = resolveChannelAgentPolicy(sandbox);
    const allTools = toolRegistry.getEnabledTools();
    const exposedTools = policy.exposeTools ? allTools : [];
    console.log(
      "[Channels] bot run:",
      `msg.channel=${msg.channel} sandbox=${sandbox} tools=${exposedTools.length}/${allTools.length} priorMsgs=${priorMessages?.length ?? 0}`,
    );

    const historyMessages = (priorMessages ?? [])
      .filter((m) => typeof m.content === "string" && m.content.trim().length > 0)
      .map((m) => ({
        role: m.role as "user" | "assistant" | "system",
        content: m.content,
      }));

    const channelModelSettings = loadModelSettings();
    const primaryModel = getDefaultModelProfile(channelModelSettings);
    const canUseFallback = policy.executionMode === "chat" && discordAccess?.isGatewayMessage
      && (discordAccess.isOwner || channelSettings.discord.fallbackUserIds?.includes(msg.senderId));
    const fallbackModel = canUseFallback
      ? listSavedModelProfiles(channelModelSettings).find((profile) =>
          profile.id === channelSettings.discord.fallbackModelProfileId
          && profile.apiKey.trim() && profile.model.trim() && profile.baseUrl.trim())
      : undefined;
    const imageSendStrategy = decideImageSendStrategy({
      multimodal: channelModelSettings.multimodal,
      vision: loadVisionConfig(),
    });
    const attachmentInputs = await buildChannelAttachmentInputs(msg, {
      imageMode: imageSendStrategy.mode,
      captionImage: async (filePath: string) => {
        const validated = validateCaptionImagePath(filePath);
        if (!validated.ok) return { ok: false, error: validated.error };
        const visionCfg = loadVisionConfig();
        if (!visionCfg) return { ok: false, error: "未配置视觉模型，无法分析图片" };
        try {
          const { captionImage } = await import("../orchestrator/vision-captioner");
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
    });
    const messages = [...historyMessages, { role: "user" as const, content: buildDiscordMessageText(msg) }];
    const workspace = isDiscord && policy.exposeTools ? getDiscordSessionWorkspace("work") : undefined;
    const runProfile = async (modelProfileId?: string) => {
      const { options } = await deps.agentRuntime.buildOptions({
        messages,
        style: "01_default.md",
        sessionId,
        modelProfileId,
        attachments: attachmentInputs.attachments,
        imageAttachments: attachmentInputs.imageAttachments,
        channel: msg.channel,
        executionMode: policy.executionMode,
        ...(policy.executionMode === "chat" ? {
          userTurnId: `${msg.channel}:${msg.senderId}:${msg.at.toISOString()}:user`,
          assistantTurnId: `${msg.channel}:${msg.senderId}:${msg.at.toISOString()}:assistant`,
        } : {}),
      }, ownerDm);
      options.tools = policy.exposeTools ? [...(options.capabilities?.tools ?? exposedTools)] : [];
      options.harnessInteractiveTools = policy.includeInteractiveTools;
      options.permissionMode = isDiscord ? "normal" : policy.permissionMode;
      if (workspace?.workspaceRoot) options.resolvedWorkspaceRoot = workspace.workspaceRoot;

      const agent = new CyreneAgent({
        threadId: `thread-${sessionId}-${randomUUID()}`,
        description: `bot:${msg.channel}:${msg.senderId}`,
      });
      return new Promise<CyreneAgent["lastResult"]>((resolve, reject) => {
        agent.runWithEvents(options).subscribe({
          complete: () => resolve(agent.lastResult),
          error: (err) => reject(err instanceof Error ? err : new Error(String(err))),
        });
      });
    };

    let result: CyreneAgent["lastResult"];
    try {
      result = isDiscord
        ? await runDiscordChatWithFallback(runProfile, primaryModel?.id, fallbackModel?.id)
        : await runProfile(primaryModel?.id);
    } catch (err) {
      if (isDiscord) recordDiscordError();
      throw err;
    }
    const reply = result?.reply ?? "";
    channelResult.text = reply;
    if (!isDiscord || ownerDm) {
      if (result) {
        const finished = await deps.agentRuntime.onRunFinished(result, msg.text, msg.channel, sessionId);
        channelResult.sticker = finished.sticker;
      }
      void indexConversationTurn(sessionId, msg.text, reply);
    }
    return channelResult;
  });

  setDispatcherSynthesizeTts(async (text: string, context) => {
    const cfg = loadGeneralSettings();
    return await deps.ttsSynthesisService.synthesizeChannelTts(text, cfg, context.channel);
  });

  setDispatcherBroadcastChat((event) => {
    const win = deps.getReactChatWindow();
    if (!win || win.isDestroyed()) return;
    try {
      win.webContents.send(IPC.AGUI_EVENT, {
        type: "CUSTOM",
        name: "cyrene.botMessage",
        value: event,
      });
    } catch (err) {
      console.warn("[Channels] botMessage 广播失败:", err);
    }
  });

  void initChannels();

  return {
    shutdown: shutdownChannels,
  };
}
