import type { SettingsSection } from "./AppearanceSettingsPage";

export type SettingsSearchCategory = "basic" | "agent" | "channels" | "voice" | "about";
export interface SettingsSearchItem {
  id: string;
  section: SettingsSection;
  category: SettingsSearchCategory;
  titleKey: string;
  sectionKey: string;
  source: string;
  keywords?: string[];
}

// 新增可搜索设置时，索引条目必须有对应的 data-settings-search-id，保证跳转按身份定位。
// 标题在查询时翻译，避免语言切换后仍匹配旧语言文案。
const sections: {
  section: SettingsSection;
  category: SettingsSearchCategory;
  titleKey: string;
  source: string;
  items: string[];
}[] = [
  {
    section: "general", category: "basic",
    titleKey: "settingsPage.general.title",
    source: "src/renderer/react/features/settings/GeneralSettingsPanel.tsx",
    items: [
      "settingsPage.general.windows",
      "settingsPage.general.rememberWindowState",
      "settingsPage.general.system",
      "settingsPage.general.toastSound",
      "settingsPage.general.launchAtLogin",
      "settingsPage.general.language",
      "settingsPage.general.dataDir",
      "settingsPage.general.disableGpu",
      "settingsPage.general.about",
      "settingsPage.general.softwareUpdate",
    ],
  },
  {
    section: "appearance", category: "basic",
    titleKey: "settingsPage.appearance",
    source: "src/renderer/react/features/settings/AppearanceSettingsPage.tsx",
    items: [
      "settingsPage.interface",
      "settingsPage.theme",
      "settingsPage.uiFont",
      "settingsPage.cyreneAvatar",
      "settingsPage.messageTypography",
      "settingsPage.messageFontSize",
      "settingsPage.messageLineHeight",
      "settingsPage.messageLetterSpacing",
      "settingsPage.messageFontWeight",
      "settingsPage.pet",
      "settingsPage.petAlwaysOnTop",
      "settingsPage.petVisible",
      "settingsPage.petZoom",
    ],
  },
  {
    section: "preferences", category: "basic",
    titleKey: "settingsPage.preferencesLabel",
    source: "src/renderer/react/features/settings/PreferencesSettingsPanel.tsx",
    items: [
      "settingsPage.preferences.messaging",
      "settingsPage.preferences.mobileSegmentation",
      "settingsPage.preferences.customStyle",
      "settingsPage.preferences.proactiveChat",
      "settingsPage.preferences.deliveryTarget",
      "settingsPage.preferences.moments",
      "settingsPage.preferences.momentsEnabled",
      "settingsPage.preferences.momentsPosting",
      "settingsPage.preferences.momentsReactions",
      "settingsPage.preferences.characterReactions",
      "settingsPage.preferences.liveliness",
      "settingsPage.preferences.context",
      "settingsPage.preferences.chatSocialContext",
      "settingsPage.preferences.cita",
    ],
  },
  {
    section: "models", category: "basic",
    titleKey: "settingsPage.modelSettings.title",
    source: "src/renderer/react/features/settings/ModelSettingsPanel.tsx",
    items: [
      "settingsPage.modelSettings.profiles",
      "settingsPage.modelSettings.newProfile",
      "settingsPage.modelSettings.imageGenerationEnable",
      "settingsPage.modelSettings.disableMaxToken",
      "settingsPage.modelSettings.requestTimeout",
      "settingsPage.modelSettings.retryCount",
      "settingsPage.modelSettings.userWait",
      "settingsPage.modelSettings.parallel",
      "settingsPage.modelSettings.testTimeout",
      "settingsPage.modelSettings.provider",
      "settingsPage.modelSettings.profileName",
      "settingsPage.modelSettings.customEndpointType",
      "settingsPage.modelSettings.apiKey",
      "settingsPage.modelSettings.baseUrl",
      "settingsPage.modelSettings.transport",
      "settingsPage.modelSettings.modelList",
      "settingsPage.modelSettings.imageGenerationModel",
      "settingsPage.modelSettings.visionModel",
      "settingsPage.modelSettings.visionTestLabel",
      "settingsPage.modelSettings.thinkingOverride",
    ],
  },
  {
    section: "usage", category: "basic",
    titleKey: "settingsPage.usage.title",
    source: "src/renderer/react/features/settings/UsageStatsPanel.tsx",
    items: [
      "settingsPage.usage.heatmapTitle",
      "settingsPage.usage.trendsTitle",
      "settingsPage.usage.modelsTitle",
    ],
  },
  {
    section: "browser", category: "basic",
    titleKey: "settingsPage.browserControl.navLabel",
    source: "src/renderer/react/features/settings/BrowserControlSettingsPanel.tsx",
    items: [
      "settingsPage.browserControl.sectionTitle",
      "settingsPage.browserControl.viewportMode",
      "settingsPage.browserControl.clearCookies",
    ],
  },
  {
    section: "email", category: "basic",
    titleKey: "settingsPage.emailSettings.title",
    source: "src/renderer/react/features/settings/EmailSettingsPanel.tsx",
    items: [
      "settingsPage.emailSettings.gmailTitle",
      "settingsPage.emailSettings.clientId",
      "settingsPage.emailSettings.clientSecret",
      "settingsPage.emailSettings.smtpTitle",
      "settingsPage.tools.emailEnabled",
      "settingsPage.emailSettings.smtpIdentity",
      "settingsPage.tools.smtpHost",
      "settingsPage.tools.smtpPort",
      "settingsPage.tools.smtpSecure",
      "settingsPage.tools.smtpUser",
      "settingsPage.tools.smtpPass",
      "settingsPage.tools.fromName",
    ],
  },
  {
    section: "toolToggle", category: "agent",
    titleKey: "settingsPage.toolToggle.title",
    source: "src/renderer/react/features/settings/ToolToggleSettingsPanel.tsx",
    items: [
      "toolPanel.chatEnhanceTitle",
    ],
  },
  {
    section: "tools", category: "agent",
    titleKey: "settingsPage.tools.title",
    source: "src/renderer/react/features/settings/ToolSettingsPanel.tsx",
    items: [
      "settingsPage.tools.extensionPanels",
      "settingsPage.tools.information",
      "settingsPage.tools.weather",
      "settingsPage.tools.weatherSource",
      "settingsPage.tools.travel",
      "settingsPage.tools.amapKey",
      "settingsPage.tools.search",
      "settingsPage.tools.searchEnabled",
      "settingsPage.tools.searchSource",
      "settingsPage.tools.files",
      "settingsPage.tools.permission",
      "settingsPage.tools.music",
      "settingsPage.tools.netease",
      "settingsPage.tools.localMusic",
    ],
  },
  {
    section: "subagents", category: "agent",
    titleKey: "settingsPage.subagents.title",
    source: "src/renderer/react/features/settings/SubagentSettingsPanel.tsx",
    items: [
      "settingsPage.subagents.personaTitle",
      "settingsPage.subagents.personaToggle",
      "settingsPage.subagents.modelTitle",
      "settingsPage.subagents.modelLabel",
    ],
  },
  {
    section: "plugins", category: "agent",
    titleKey: "pluginPanel.title",
    source: "src/renderer/react/features/settings/PluginSettingsPanel.tsx",
    items: [
    ],
  },
  {
    section: "mcp", category: "agent",
    titleKey: "settingsPage.mcp.menuLabel",
    source: "src/renderer/react/features/settings/McpSettingsPanel.tsx",
    items: [
      "settingsPage.mcp.serversTitle",
      "settingsPage.mcp.builtinTitle",
      "settingsPage.mcp.fsLabel",
      "settingsPage.mcp.recommendedTitle",
      "settingsPage.mcp.mcdName",
    ],
  },
  {
    section: "memory", category: "agent",
    titleKey: "settingsPage.memory.title",
    source: "src/renderer/react/features/settings/MemorySettingsPanel.tsx",
    items: [
      "settingsPage.memory.modeTitle",
      "settingsPage.memory.modeLabel",
      "settingsPage.memory.summaryTitle",
      "settingsPage.memory.workspaceSummary",
      "settingsPage.memory.sessionSummary",
      "settingsPage.memory.l0Title",
      "settingsPage.memory.l1Title",
      "settingsPage.memory.l2Title",
      "settingsPage.memory.reflectionsTitle",
      "settingsPage.memory.vault.title",
      "settingsPage.memory.vault.autoSync",
    ],
  },
  {
    section: "knowledge", category: "agent",
    titleKey: "settingsPage.knowledgeBase.title",
    source: "src/renderer/react/features/settings/KnowledgeBaseSettingsPanel.tsx",
    items: [
    ],
  },
  {
    section: "cyrene", category: "agent",
    titleKey: "settingsPage.cyrene.title",
    source: "src/renderer/react/features/settings/CyreneSettingsPanel.tsx",
    items: [
      "settingsPage.cyrene.runtimeTitle",
      "settingsPage.cyrene.runtimeMode",
      "settingsPage.cyrene.stickerTitle",
      "settingsPage.cyrene.stickerEnabled",
      "settingsPage.cyrene.stickerSize",
      "settingsPage.cyrene.threshold",
      "settingsPage.cyrene.retrievalTitle",
      "settingsPage.cyrene.embeddingModel",
      "settingsPage.cyrene.embeddingDimensions",
      "settingsPage.cyrene.reranker",
    ],
  },
  {
    section: "skill", category: "agent",
    titleKey: "settingsPage.skill.title",
    source: "src/renderer/react/features/settings/SkillSettingsPanel.tsx",
    items: [
    ],
  },
  {
    section: "channels", category: "channels",
    titleKey: "settingsPage.channels.title",
    source: "src/renderer/react/features/settings/ChannelsSettingsPanel.tsx",
    items: [
      "settingsPage.channels.contextTitle",
      "settingsPage.channels.providersTitle",
      "settingsPage.channels.globalTitle",
      "settingsPage.channels.rateUser",
      "settingsPage.channels.rateChannel",
      "settingsPage.channels.sendTts",
      "settingsPage.channels.sendSticker",
      "settingsPage.channels.mirrorDesktop",
      "settingsPage.channels.toolPermission",
      "settingsPage.channels.logsTitle",
    ],
  },
  {
    section: "tts", category: "voice",
    titleKey: "settingsPage.tts.title",
    source: "src/renderer/react/features/settings/TtsSettingsPanel.tsx",
    items: [
      "settingsPage.tts.playbackTitle",
      "settingsPage.tts.autoReadTitle",
      "settingsPage.tts.splitEnabledTitle",
      "settingsPage.tts.splitModeTitle",
      "settingsPage.tts.speedTitle",
      "settingsPage.tts.volumeTitle",
      "settingsPage.tts.engineTitle",
      "settingsPage.tts.minimaxConfig",
      "settingsPage.tts.streamingTitle",
      "settingsPage.tts.vocalEnhanceTitle",
      "settingsPage.tts.gptConfig",
      "settingsPage.tts.customCloudConfig",
      "settingsPage.tts.mimoConfig",
      "settingsPage.tts.mosslandConfig",
    ],
  },
  {
    section: "asr", category: "voice",
    titleKey: "settingsPage.asr.title",
    source: "src/renderer/react/features/settings/AsrSettingsPanel.tsx",
    items: [
      "settingsPage.asr.engineTitle",
      "settingsPage.asr.aliyunTitle",
      "settingsPage.asr.mosslandTitle",
      "settingsPage.asr.minimaxTitle",
      "settingsPage.asr.callTitle",
      "settingsPage.asr.vadSilence",
      "settingsPage.asr.vadThreshold",
      "settingsPage.asr.showTranscript",
    ],
  },
  {
    section: "disclaimer", category: "about",
    titleKey: "settingsPage.disclaimer.navLabel",
    source: "src/renderer/react/features/settings/DisclaimerSettingsPanel.tsx",
    items: [
    ],
  },
 ];

export const settingsSearchIndex: SettingsSearchItem[] = sections.flatMap((section) => [
  { id: `section:${section.section}`, section: section.section, category: section.category,
    titleKey: section.titleKey, sectionKey: section.titleKey, source: section.source },
  ...section.items.map((titleKey) => ({ id: titleKey, section: section.section,
    category: section.category, titleKey, sectionKey: section.titleKey, source: section.source })),
]);

export function searchSettings(query: string, translate: (key: string) => string, category?: SettingsSearchCategory) {
  const words = query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
  return settingsSearchIndex.filter((item) => {
    if (category && item.category !== category) return false;
    const text = [translate(item.titleKey), translate(item.sectionKey), ...(item.keywords ?? [])].join(" ").toLocaleLowerCase();
    return words.every((word) => text.includes(word));
  });
}
