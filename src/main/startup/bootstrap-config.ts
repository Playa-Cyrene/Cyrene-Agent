import type { BrowserWindow } from "electron";
import { IPC } from "../../shared/ipc-channels";
import type { GeneralSettings } from "../settings/general-settings";
import { loadModelSettings, resolveModelSettingsProfile } from "../settings/model-settings";
import { loadUserProfile } from "../settings-store";
import {
  setSearchConfig,
  setUserTimezoneConfig,
  setWeatherConfig,
} from "../orchestrator/tools/built-in-tools";
import { setEmailConfig } from "../orchestrator/tools/email-tools";
import { setTravelConfig } from "../orchestrator/tools/travel-tools";
import { toolRegistry } from "../orchestrator/tools/registry/tool-registry";
import { resolveVendorRuntimeSettings, setVendorRuntimeSettingsGetter } from "../orchestrator/vendors/runtime-settings";
import { setChoiceCardSender, setChoiceDismissSender } from "../user-choice";
import { setAsrConfig } from "../asr/asr-config";
import { setCallSettings } from "../call/call-manager";
import { buildCallSystemPrompt } from "../call/call-prompt-builder";
import { reactChatWindow } from "../windows/window-state";

export interface BootstrapConfigContext {
  loadGeneralSettings: () => GeneralSettings;
}

function getReactChatWindow(): BrowserWindow | null {
  return reactChatWindow && !reactChatWindow.isDestroyed() ? reactChatWindow : null;
}

/**
 * 启动阶段配置 getter 注入。
 * 所有业务模块的"实时读配置"回调都在这里统一注册，避免散落在 createWindow 中。
 */
export function bootstrapConfigGetters(ctx: BootstrapConfigContext): void {
  const { loadGeneralSettings } = ctx;

  // 厂商适配层保持独立可测试；通过 getter 实时读取全局模型开关，避免反向依赖主进程入口。
  // thinkingOverride / disableMaxToken 仅对自定义端点生效（preset 厂商由 capability 表 + chat 下拉控制），
  // 详见 resolveVendorRuntimeSettings 的实现与单元测试。
  setVendorRuntimeSettingsGetter(() => resolveVendorRuntimeSettings(loadModelSettings()));

  // 注入天气工具配置获取器：每次工具执行时实时读 key/默认城市
  // （用户改了设置不用重启就能生效）
  setWeatherConfig(
    () => loadUserProfile().defaultCity,
    () => loadGeneralSettings().weatherSource,
    () => loadGeneralSettings().amapKey,
    // 天气卡片回调：工具拿到结构化数据后，发 Custom 事件给 react 聊天窗口渲染卡片
    (card, context) => {
      const win = getReactChatWindow();
      if (win) {
        win.webContents.send(IPC.AGUI_EVENT, {
          type: "CUSTOM",
          name: "cyrene.weather",
          value: card,
          // 天气工具在 Harness 内执行时必须归属到该 run；否则 renderer 的
          // RunEventGate 会把没有 runId 的卡片事件当作串会话事件丢弃。
          ...(context?.runId ? { runId: context.runId } : {}),
        });
      }
    },
    () => loadGeneralSettings().weatherEnabled,
  );

  // 注入用户时区 getter：工具侧通过 currentUserTimezone() 统一拿用户时区（缺/非法回退 Asia/Shanghai）
  setUserTimezoneConfig(() => loadUserProfile().timezone);

  // 注入用户选择卡片回调：工具调 ask_user_choice 时发 Custom 事件给 react 聊天窗口
  setChoiceCardSender((cardData) => {
    const win = getReactChatWindow();
    if (win) {
      win.webContents.send(IPC.AGUI_EVENT, {
        type: "CUSTOM",
        name: "cyrene.choice",
        value: cardData,
      });
    }
  });

  // 注入选择卡结算回调：老版 requestUserChoice 超时结算时通知渲染端清卡，
  // 避免留下「点了没反应」的僵尸卡（与澄清卡的 cyrene.choice.dismiss 同机制）。
  setChoiceDismissSender((settlement) => {
    const win = getReactChatWindow();
    if (win) {
      win.webContents.send(IPC.AGUI_EVENT, {
        type: "CUSTOM",
        name: "cyrene.choice.dismiss",
        value: settlement,
      });
    }
  });

  // 注入搜索配置获取器
  setSearchConfig(
    () => loadGeneralSettings().searchEngine,
    () => loadGeneralSettings().searchBochaKey,
    () => loadGeneralSettings().searchTavilyKey,
    () => loadGeneralSettings().searchAnySearchKey,
  );

  // 注入出行工具 amapKey 获取器（复用 GeneralSettings 中的 amapKey）
  setTravelConfig(() => loadGeneralSettings().amapKey, () => loadGeneralSettings().travelEnabled);

  // 注入邮件工具 SMTP 配置获取器（每次执行实时读 GeneralSettings）
  setEmailConfig(
    () => loadGeneralSettings().emailEnabled,
    () => loadGeneralSettings().emailSmtpHost,
    () => loadGeneralSettings().emailSmtpPort,
    () => loadGeneralSettings().emailSmtpSecure,
    () => loadGeneralSettings().emailSmtpUser,
    () => loadGeneralSettings().emailSmtpPass,
    () => loadGeneralSettings().emailFromName,
  );

  // 注入 ASR 配置获取器（通话功能用，实时读 GeneralSettings）
  setAsrConfig(() => {
    const s = loadGeneralSettings();
    if (s.asrEngine === "mossland") {
      return { engine: "mossland", apiKey: s.ttsMosslandKey };
    }
    if (s.asrEngine === "aliyun") {
      return { engine: "aliyun", appKey: s.asrAliyunAppKey, accessKeyId: s.asrAliyunAccessKeyId, accessKeySecret: s.asrAliyunAccessKeySecret, language: s.asrLanguage };
    }
    return null;
  });

  // 注入通话模型/TTS 配置获取器
  // 模型 getter 必须先展开默认档案再取字段：顶层镜像可能指向空壳 provider
  // （用户只在档案里配了模型），直接读会导致通话报"模型配置缺失"（与 channel bot 读到顶层空壳镜像同病根）。
  setCallSettings(
    () => {
      const s = resolveModelSettingsProfile(loadModelSettings());
      return { provider: s.provider, baseUrl: s.baseUrl, model: s.model, apiKey: s.apiKey, explicitTransport: s.explicitTransport };
    },
    () => {
      const s = loadGeneralSettings();
      return {
        ttsEngine: s.ttsEngine,
        ttsMinimaxKey: s.ttsMinimaxKey, ttsMinimaxVoiceId: s.ttsMinimaxVoiceId,
        ttsMinimaxModel: s.ttsMinimaxModel,
        ttsSpeed: s.ttsSpeed, ttsVolume: s.ttsVolume,
        ttsMinimaxVocalEnhance: s.ttsMinimaxVocalEnhance,
        ttsGptsovitsBaseUrl: s.ttsGptsovitsBaseUrl,
        ttsGptsovitsRefAudioPath: s.ttsGptsovitsRefAudioPath,
        ttsGptsovitsPromptText: s.ttsGptsovitsPromptText,
        ttsGptsovitsFormat: s.ttsGptsovitsFormat,
        ttsGptsovitsTimeoutMs: s.ttsGptsovitsTimeoutMs,
        ttsCustomCloudEndpointUrl: s.ttsCustomCloudEndpointUrl,
        ttsCustomCloudApiKey: s.ttsCustomCloudApiKey,
        ttsCustomCloudVoiceId: s.ttsCustomCloudVoiceId,
        ttsCustomCloudFormat: s.ttsCustomCloudFormat,
        ttsCustomCloudTimeoutMs: s.ttsCustomCloudTimeoutMs,
        ttsMimoKey: s.ttsMimoKey,
        ttsMimoVoiceAudioPath: s.ttsMimoVoiceAudioPath,
        ttsMimoStylePrompt: s.ttsMimoStylePrompt,
      };
    },
    // 通话专用 system prompt 构建器
    async (userText: string) => {
      const messages = [{ role: "user" as const, content: userText }];
      return buildCallSystemPrompt(userText, messages);
    },
    // 天气快捷处理：正则匹配到天气关键词 → 调 weather 工具的 execute
    async (userText: string) => {
      try {
        const weatherTool = toolRegistry.getById("weather");
        if (!weatherTool) return null;
        // 提取城市名（简单匹配：XX天气 / XX的天气）
        const cityMatch = userText.match(/([北京上海广州深圳成都杭州南京武汉西安重庆天津苏州长沙郑州青岛大连沈阳哈尔滨长春济南太原合肥南昌福州昆明贵阳拉萨乌鲁木齐呼和浩特]+)/);
        const city = cityMatch?.[1] ?? "";
        const result = await weatherTool.execute({ city }, undefined);
        return result;
      } catch (err) {
        console.warn("[Call] 天气查询失败:", err);
        return null;
      }
    },
  );

}
