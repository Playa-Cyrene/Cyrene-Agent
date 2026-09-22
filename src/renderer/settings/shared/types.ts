// Settings 公共类型定义
// 从 settings.ts 抽离的跨面板共享类型。
// 注意路径深度：本文件位于 src/renderer/settings/shared/，
// 到 src/shared/ 需要 ../../../shared/，到 settings/ 下其他模块用 ../

import type { ApiTransport } from "../../../shared/api-endpoint";
import type { ReasoningPreference } from "../../../shared/reasoning";
import type { ChatAppearanceSettings } from "../../../shared/chat-appearance";
import type { UiTheme } from "../../../shared/ui-theme";
import type { UiFont } from "../../../shared/ui-font";
import type { UiIcon } from "../../../shared/ui-icon";
import type {
  DefaultChatMode,
  MobileMessageSegmentationMode,
  ProactiveChatMode,
  ProactiveDeliveryTarget,
  SegmentedOutputMode,
} from "../../../shared/preferences";
import type { QqListenAuthRequirement } from "../../../shared/qq-listen";
import type { CustomStyleConfig } from "../../../shared/style-sampling";
import type { CustomEndpointMode } from "../custom-endpoint-state";
import type { TimeoutSettings } from "../../../shared/timeout-types";

export interface ProviderProfile {
  baseUrl: string;
  model: string;
  apiKey: string;
  displayName?: string;
  /**
   * 用户在 settings 显式选择的协议。旧配置中的 auto 会由 main 进程迁移为具体值。
   */
  explicitTransport?: ApiTransport;
  reasoning?: ReasoningPreference;
}

export interface ModelSettings {
  mode: "auto" | "manual";
  provider: string;
  // 用户给模型起的自定义昵称，留空时用厂商 shortName。状态栏"正在喂养"显示它。
  displayName?: string;
  baseUrl: string;
  model: string;
  apiKey: string;
  /**
   * 当前厂商的 explicitTransport 镜像（顶层字段是 main 进程 perProvider[currentProvider] 的视图）。
   * UI 改动 transport-select 时，saveConfig 把这个值带给 main 进程折叠回 perProvider。
   */
  explicitTransport?: ApiTransport;
  /** 当前厂商 reasoning 偏好的顶层镜像。 */
  reasoning?: ReasoningPreference;
  // 按厂商缓存：切回该厂商时，从这里恢复 baseUrl / model / apiKey
  perProvider?: Record<string, ProviderProfile>;
  runtimeSync: "off" | "local" | "llm";
  stickerEnabled: boolean;
  stickerSize: "small" | "standard" | "large";
  stickerSimilarityThreshold: number;
  /** 整个聊天请求的超时（秒）。30-1800，默认 300。 */
  chatRequestTimeoutSec: number;
  /** CITA 结构化输出重试总预算（秒）。4-30，默认 8。 */
  citaRepairBudgetSec: number;
  vision?: {
    baseUrl: string;
    apiKey: string;
    model: string;
  };
  /** Embedding 维度（可选，仅 cloud 模式）。留空 = 自动探测。 */
  embeddingDimensions?: number;
  multimodal: boolean;
  thinkingOverride?: -1 | 0 | 1;
  /** 禁用 max_tokens 注入。仅对自定义端点生效（与主进程 model-settings.ts 对齐）。 */
  disableMaxToken?: boolean;
  /** 上下文窗口大小（Token）。默认 256000。 */
  contextWindowTokens?: number;
}

export interface ModelPreset {
  providerName: string;
  // 厂商短名（去括号后缀），用于状态栏"正在喂养"显示和昵称默认值。
  // 如 "MiniMax（稀宇科技）" → shortName "MiniMax"。
  shortName: string;
  baseUrl: string;
  /** 已由厂商官方确认的 Anthropic 兼容 Base URL；没有就不猜。 */
  anthropicBaseUrl?: string;
  /** 预设首次使用时选中的明确协议；用户之后可以手动修改。 */
  transport: ApiTransport;
  mainModels: string[];
  iconUrl: string;
  // 厂商官网链接，显示在预设下拉框旁边，方便用户直接跳转注册/查看文档。
  websiteUrl?: string;
  // 视觉模型的 OpenAI 兼容 baseUrl。主模型与视觉模型入口不同时使用。
  visionBaseUrl?: string;
  // 标记为 true 时，该项在 <select> 里显示但不可选；
  // 用于"已列出但 vendor adapter 还没接好"的情况，避免用户选到后调用直接报错。
  disabled?: boolean;
  // 独立视觉模型的默认值（applyPreset 在没有保存值时使用）。
  defaultVisionModel?: string;
  // 独立视觉模型的候选列表（用于视觉模型输入框的 datalist）。
  visionModels?: string[];
  // 自定义端点的云端/本地变体共用一张可见卡片，但分别持久化配置。
  customEndpointMode?: CustomEndpointMode;
  hiddenInPresetList?: boolean;
}

export interface GeneralSettings extends ChatAppearanceSettings {
  maxParallelToolCalls: number;
  citaEnabled: boolean;
  citaSemanticEngine: "remote" | "local";
  chatSocialContextEnabled: boolean;
  momentsEnabled: boolean;
  chatMomentsContextEnabled: boolean;
  cyreneMomentsPostingEnabled: boolean;
  cyreneMomentsReactionsEnabled: boolean;
  momentsCharacterReactionsEnabled: boolean;
  /** 朋友圈热闹程度：抽签人数分布与角色日调用上限联动档位 */
  momentsLiveliness: "quiet" | "natural" | "lively";
  petAlwaysOnTop: boolean;
  rememberWindowState: boolean;
  petVisible: boolean;
  petZoom: number;
  disableGpuElectron?: boolean;
  sidebarVisible: boolean;
  tasksVisible: boolean;
  /** 提醒中心音效总开关：关闭后所有 toast 静音 */
  toastSoundEnabled: boolean;
  launchAtLogin: boolean;
  language: "zh-CN";
  uiTheme: UiTheme;
  windowCornerRadius: number;
  uiThemeRadius: boolean;
  uiFont: UiFont;
  uiIcon: UiIcon;
  defaultChatMode: DefaultChatMode;
  currentStyleId?: string;
  customStyle: CustomStyleConfig;
  segmentedOutputMode: SegmentedOutputMode;
  mobileMessageSegmentation: MobileMessageSegmentationMode;
  proactiveChatMode: ProactiveChatMode;
  proactiveDeliveryTarget: ProactiveDeliveryTarget;
  /** 聊天段落间距（em）。目前仅设置窗口 UI 使用，主进程归一化尚未持久化该字段。 */
  chatParaSpacing?: number;
  screenshotHotkey?: string;
}

export interface UserApi {
  getProfile: () => Promise<{ nickname: string; callPreference: string; birthday: string; timezone: string; avatarPath: string; defaultCity: string; gender: string }>;
  saveProfile: (profile: Record<string, unknown>) => Promise<unknown>;
  uploadAvatar: () => Promise<{ avatarPath: string } | null>;
  getAvatar: () => Promise<string | null>;
  onAvatarChanged: (callback: () => void) => () => void;
}

export interface MemoryPanelPayload {
  l0: {
    preferredName: string;
    occupation: string;
    longTermInterests: string;
    language: string;
    permanentNote: string;
  };
  l1: {
    recentGoals: string;
    recentPreferences: string;
    currentProject: string;
  };
  l2: Array<{
    id: string;
    content: string;
    triggerText: string;
    status: "active" | "aging" | "archived";
    weight: number;
    createdAt: number;
  }>;
  importedDocs: Array<{
    importId: string | null;
    fileName: string;
    chunkCount: number;
    lastImportedAt: number;
  }>;
  reflections: Array<{
    id: string;
    title: string;
    body: string;
    meta: string;
  }>;
}

export interface ObsidianVaultConfig {
  vaultPath: string;
  autoSync: boolean;
  lastSyncAt: number;
}

export interface MemoryPanelApi {
  getData: () => Promise<MemoryPanelPayload>;
  deleteImportedDoc: (importId: string, fileName?: string) => Promise<{ ok: boolean; deleted: number }>;
  saveL0: (patch: Record<string, unknown>) => Promise<{ ok: boolean }>;
  saveL1: (patch: Record<string, unknown>) => Promise<{ ok: boolean }>;
  exportToObsidianVault: () => Promise<{
    ok: boolean;
    outputPath?: string;
    fileCount?: number;
    error?: string;
    canceled?: boolean;
  }>;
  bindVault: () => Promise<{
    ok: boolean;
    vaultPath?: string;
    fileCount?: number;
    error?: string;
    canceled?: boolean;
  }>;
  unbindVault: () => Promise<{ ok: boolean }>;
  getVaultConfig: () => Promise<ObsidianVaultConfig>;
  setAutoSync: (autoSync: boolean) => Promise<{ ok: boolean; config: ObsidianVaultConfig }>;
  syncNow: () => Promise<{ ok: boolean; vaultPath?: string; fileCount?: number; error?: string; skipped?: boolean }>;
}

export interface SettingsApi {
  minimize: () => void;
  close: () => void;
  getConfig: () => Promise<ModelSettings>;
  saveConfig: (config: Partial<ModelSettings>) => Promise<ModelSettings>;
  listModelProfiles?: () => Promise<{ profiles: Array<{ id: string; provider: string; displayName?: string; baseUrl: string; model: string; apiKey: string; explicitTransport?: ApiTransport; reasoning?: ReasoningPreference; contextWindowTokens?: number; multimodal?: boolean }>; defaultModelProfileId?: string }>;
  saveModelProfile?: (profile: { id?: string; provider: string; displayName?: string; baseUrl: string; model: string; apiKey: string; explicitTransport?: ApiTransport; reasoning?: ReasoningPreference; contextWindowTokens?: number; multimodal?: boolean }) => Promise<{ added: boolean; profiles: unknown[]; defaultModelProfileId?: string }>;
  deleteModelProfile?: (id: string) => Promise<unknown>;
  setDefaultModelProfile?: (id: string) => Promise<unknown>;
  getGeneral: () => Promise<GeneralSettings>;
  saveGeneral: (config: Partial<GeneralSettings>) => Promise<GeneralSettings>;
  openCustomStylePrompt?: () => Promise<{ ok: boolean; filePath?: string; error?: string }>;
  getTimeoutSettings: () => Promise<TimeoutSettings>;
  saveTimeoutSettings: (config: Partial<TimeoutSettings>) => Promise<TimeoutSettings>;
  pickUiFont: () => Promise<string | null>;
  importUiFont: (sourcePath: string) => Promise<UiFont>;
  resetUiFont: () => Promise<UiFont>;
  openSidebar: () => void;
  closeSidebar: () => void;
  openTasks: () => void;
  closeTasks: () => void;
  openChromeGpu: () => void;
  setPetAlwaysOnTop: (value: boolean) => void;
  setPetVisible: (value: boolean) => void;
  setPetZoom: (value: number) => void;
  previewRuntimeSync: (value: "off" | "local" | "llm") => void;
  openStickerManager: () => Promise<{ ok: boolean; error?: string }>;
  stickerPickFile?: () => Promise<string | null>;
  stickerAdd?: (payload: { sourcePath: string; id: string; description: string; phrases: string[] }) => Promise<unknown>;
  embeddingSetModel?: (model: string) => Promise<{ ok: boolean; clearedEntries?: number; error?: string }>;
  rerankerSetMode?: (mode: string) => Promise<boolean>;
  setToolEnabled?: (id: string, enabled: boolean) => Promise<{ ok: boolean; error?: string }>;
  getToolEnabled?: () => Promise<Record<string, boolean>>;
  // 三模适配层：工具-模式覆盖层（UI 设置面板用）
  getToolCatalog?: () => Promise<Array<{
    id: string;
    name: string;
    description: string;
    enabled: boolean;
    modes: Array<"chat" | "work" | "code" | "learn"> | null;
    deprecated: string | null;
  }>>;
  getToolModeOverrides?: () => Promise<Record<string, Partial<Record<"chat" | "work" | "code" | "learn", boolean>>>>;
  setToolModeOverride?: (toolId: string, mode: "chat" | "work" | "code" | "learn", enabled: boolean) => Promise<{ ok: boolean; error?: string }>;
  clearToolModeOverride?: (toolId: string, mode?: "chat" | "work" | "code" | "learn") => Promise<{ ok: boolean; error?: string }>;
  // 三模适配层：Skill-模式覆盖层（聊天窗口用）。
  getSkillCatalog?: () => Promise<Array<{
    id: string;
    name: string;
    description: string;
    enabled: boolean;
    source: string;
    modes: ("work" | "code" | "learn")[] | null;
    version?: string;
    references: string[];
  }>>;
  rescanSkills?: () => Promise<{ ok: boolean; count: number; error?: string }>;
  getSkillModeOverrides?: () => Promise<Record<string, Partial<Record<"work" | "code" | "learn", boolean>>>>;
  setSkillModeOverride?: (skillId: string, mode: "work" | "code" | "learn", enabled: boolean) => Promise<{ ok: boolean; error?: string }>;
  clearSkillModeOverride?: (skillId: string, mode?: "work" | "code" | "learn") => Promise<{ ok: boolean; error?: string }>;
  addMcpServer?: (config: unknown) => Promise<{ ok: boolean; toolIds?: string[]; error?: string }>;
  removeMcpServer?: (serverId: string) => Promise<{ ok: boolean; error?: string }>;
  listMcpServers?: () => Promise<Array<{ id: string; name: string; connected: boolean; toolCount: number; toolIds: string[] }>>;
  getPermissionLevel?: () => Promise<{ level: "read-only" | "scoped" | "per-action" | "full" }>;
  setPermissionLevel?: (level: string) => Promise<{ ok: boolean; level?: string; error?: string }>;
  // 计划模式开关（renderer → main）：显式设置 on/off
  setPlanMode?: (payload: { conversationId: string; target: "on" | "off"; workspaceRoot?: string }) => Promise<{ ok: boolean; state?: string; reason?: string }>;
  // 计划模式状态查询（renderer → main）：挂载时调一次拿初始状态
  getPlanState?: (conversationId: string) => Promise<{ state: string }>;
  // 计划模式状态广播（main → renderer）：任意入口触发的状态切换都走这条
  onPlanStateChanged?: (
    callback: (payload: { conversationId: string; state: string }) => void,
  ) => (() => void) | void;
  testConnection?: (config: { provider: string; baseUrl: string; model: string; apiKey: string; explicitTransport?: ApiTransport; reasoning?: ReasoningPreference }) => Promise<{ ok: boolean; latency: number; sample?: string; error?: string }>;
  testVision?: (config: { baseUrl: string; apiKey: string; model: string }) => Promise<{ ok: boolean; latency: number; sample?: string; error?: string }>;
  // main → settings：要求切到指定标签（窗口已打开时由 main 发这个事件）
  onSwitchSection?: (callback: (section: string) => void) => (() => void) | void;
  channelsGetConfig: () => Promise<any>;
  channelsSaveConfig: (patch: unknown) => Promise<any>;
  channelsRestart: () => Promise<{ ok: boolean }>;
  channelsQqTestConnection: () => Promise<{ ok: boolean; error?: string; detail?: Record<string, unknown> }>;
  /**
   * QQ 监听鉴权预检（renderer → main）：主进程按参数解析真实监听地址并判定是否
   * 必须配置 Access Token。渲染端看不到网络接口，因此不得自行复制该判定。
   */
  channelsQqResolveAuthRequirement: (input: { listenMode: string; customHost?: string }) => Promise<QqListenAuthRequirement>;
  channelsQqBotTestConnection: () => Promise<{ ok: boolean; error?: string; detail?: Record<string, unknown> }>;
  channelsLogGet: (limit?: number) => Promise<unknown[]>;
  channelsLogClear: () => Promise<{ ok: boolean }>;
  channelsContextBindingsGet: () => Promise<{
    externalChats: Array<{
      sessionId: string;
      channel: string;
      chatId: string;
      chatType: "private" | "group";
      senderName?: string;
      lastAt: number;
    }>;
    bindings: Array<{ sessionId: string; conversationId: string; updatedAt: number }>;
    conversations: Array<{ id: string; title: string; mode: string; updatedAt: number }>;
  }>;
  channelsContextBind: (payload: { sessionId: string; conversationId: string }) => Promise<{ ok: boolean; error?: string }>;
  channelsContextUnbind: (sessionId: string) => Promise<{ ok: boolean; error?: string }>;
  onChannelsInstallProgress: (callback: (progress: { channel: string; phase: string; pct: number }) => void) => (() => void) | void;
  onChannelsWechatQrcode: (callback: (dataUrl: string) => void) => (() => void) | void;
  onChannelsWechatLoginDone: (callback: (payload: { ok: boolean; botId?: string; error?: string }) => void) => (() => void) | void;
  channelsWechatLoginStart: () => Promise<{ ok: boolean; error?: string }>;
  channelsGetStatus: () => Promise<Record<string, { phase?: string; message?: string }>>;
  onChannelsStatusChanged: (callback: (status: unknown) => void) => (() => void) | void;
  beginScreenshotHotkeyCapture: () => Promise<boolean>;
  endScreenshotHotkeyCapture: () => Promise<boolean>;
}
