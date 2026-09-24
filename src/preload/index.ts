import { contextBridge, ipcRenderer, webUtils } from "electron";
import { IPC } from "../shared/ipc-channels";
import type { QqListenAuthRequirement } from "../shared/qq-listen";
import type { ApprovalRequest, ApprovalSettledPayload } from "../shared/permission-approval";
import type { StartTtsRequest, TtsSessionEvent, TtsStartResult } from "../shared/tts-session";
import type { ScreenshotInsertPayload } from "../shared/ipc-channels";
import type {
  SpeechInputCommitRequest,
  SpeechInputCommitResult,
} from "../shared/ipc-channels";
import type { UiTheme } from "../shared/ui-theme";
import type { UiFont } from "../shared/ui-font";
import type { PluginPanelApi } from "../shared/plugin-management";
import type { ReasoningPreference } from "../shared/reasoning";
import type { DocumentIndexProgress } from "../shared/document-index";
import type { AguiRunAck } from "../shared/run-terminal";
import type { ReviewSnapshot, ReviewRestoreOutcome } from "../shared/review-types";
import type { WorkspaceListResult, WorkspaceReadResult } from "../shared/workspace-files-types";
import type { OpenInAppListResult, OpenInAppOpenResult } from "../shared/open-in-app-types";
import { getLive2DIpcListenerCounts } from "./live2d-listener-diagnostics";
import { exposeMusicApi } from "./music";
import { normalizeChatAppearance, type ChatAppearanceSettings } from "../shared/chat-appearance";
import type { AppUpdateApi, AppUpdateState } from "../shared/app-update";
import type { ConversationMode } from "../shared/chat-types";
import type { SidebarOrganizationDraft, SidebarOrganizationResult, SidebarOrganizationSnapshot } from "../shared/sidebar-organization";
import type { ToastItem, ToastPushPayload } from "../shared/toast-types";

// 渲染目标标识：preload 每次加载（即每次页面初始化/重新加载）生成一次，
// 随活动会话一并上报主进程；同一页面内切换会话不改变该标识。
const rendererTargetId = crypto.randomUUID();

const cyreneApi = {
  minimize: () => ipcRenderer.send(IPC.WINDOW_MINIMIZE),
  hide: () => ipcRenderer.send(IPC.WINDOW_CLOSE),
  quit: () => ipcRenderer.send(IPC.APP_QUIT),
  setInteractive: (interactive: boolean) =>
    ipcRenderer.invoke(IPC.WINDOW_SET_INTERACTIVE, interactive),
  moveBy: (dx: number, dy: number) =>
    ipcRenderer.send(IPC.WINDOW_MOVE, dx, dy),
  moveTo: (x: number, y: number) =>
    ipcRenderer.send(IPC.WINDOW_MOVE_TO, x, y),
  setDragging: (isDragging: boolean) =>
    ipcRenderer.send(IPC.WINDOW_SET_DRAGGING, isDragging),
  captureFrame: () => ipcRenderer.invoke(IPC.WINDOW_CAPTURE_FRAME),
  getCursorPosition: () => ipcRenderer.invoke(IPC.WINDOW_GET_CURSOR_POSITION),
  onPetZoom: (callback: (zoom: number) => void) => {
    const listener = (_e: unknown, zoom: number) => callback(zoom);
    ipcRenderer.on(IPC.PET_ZOOM, listener);
    return () => ipcRenderer.off(IPC.PET_ZOOM, listener);
  },
  onPetVisibilityChanged: (callback: (visible: boolean) => void) => {
    const listener = (_e: unknown, visible: boolean) => callback(visible);
    ipcRenderer.on(IPC.PET_VISIBILITY_CHANGED, listener);
    return () => ipcRenderer.off(IPC.PET_VISIBILITY_CHANGED, listener);
  },
};

const appUpdateApi: AppUpdateApi = {
  getState: () => ipcRenderer.invoke(IPC.APP_UPDATE_GET_STATE),
  check: () => ipcRenderer.invoke(IPC.APP_UPDATE_CHECK),
  download: () => ipcRenderer.invoke(IPC.APP_UPDATE_DOWNLOAD),
  install: () => ipcRenderer.invoke(IPC.APP_UPDATE_INSTALL),
  onStateChanged: (callback: (state: AppUpdateState) => void) => {
    const listener = (_event: unknown, state: AppUpdateState) => callback(state);
    ipcRenderer.on(IPC.APP_UPDATE_STATE, listener);
    return () => ipcRenderer.off(IPC.APP_UPDATE_STATE, listener);
  },
};

const chatApi = {
  minimize: () => ipcRenderer.send(IPC.CHAT_MINIMIZE),
  close: () => ipcRenderer.send(IPC.CHAT_CLOSE),
  toggleMaximize: () => ipcRenderer.send(IPC.CHAT_TOGGLE_MAXIMIZE),
  isMaximized: () => ipcRenderer.invoke(IPC.CHAT_IS_MAXIMIZED),
  getEnabledStickers: () => ipcRenderer.invoke(IPC.STICKERS_GET_ENABLED),
  /** 从 dataTransfer.files 或 fileInput.files 提取路径后批量摄入。
   *  路径提取在 preload（webUtils.getPathForFile），避免新版 Electron 中 File.path 不可用的问题。
   *  同时携带 File.type（MIME）：主进程图片判定按「扩展名或 MIME」，与渲染端预览口径一致。 */
  ingestDroppedFiles: async (files: File[]): Promise<unknown[]> => {
    const entries: Array<{ path: string; mime: string }> = [];
    for (const f of files) {
      try {
        const p = webUtils.getPathForFile(f);
        if (p) entries.push({ path: p, mime: f.type });
      } catch { /* 跳过无法识别路径的文件 */ }
    }
    if (entries.length === 0) return [];
    return ipcRenderer.invoke(IPC.CHAT_INGEST_FILES, entries);
  },
  processDocuments: (filePaths: string[], query: string) =>
    ipcRenderer.invoke(IPC.CHAT_PROCESS_DOCUMENTS, { filePaths, query }),
  onDocumentIndexProgress: (callback: (progress: DocumentIndexProgress) => void) => {
    const listener = (_event: unknown, progress: DocumentIndexProgress) => callback(progress);
    ipcRenderer.on(IPC.CHAT_DOCUMENT_INDEX_PROGRESS, listener);
    return () => ipcRenderer.removeListener(IPC.CHAT_DOCUMENT_INDEX_PROGRESS, listener);
  },
  cancelDocumentIndex: (jobId: string) =>
    ipcRenderer.invoke(IPC.CHAT_CANCEL_DOCUMENT_INDEX, { jobId }) as Promise<boolean>,
  captionImage: (filePath: string, hasAnnotations = false) =>
    ipcRenderer.invoke(IPC.CHAT_CAPTION_IMAGE, { filePath, hasAnnotations }),
  getImagePreview: (filePath: string) =>
    ipcRenderer.invoke(IPC.CHAT_GET_IMAGE_PREVIEW, { filePath }),
  getImageSendStrategy: (sessionId?: string) =>
    ipcRenderer.invoke(IPC.CHAT_GET_IMAGE_SEND_STRATEGY, sessionId ? { sessionId } : undefined),
  getGeneralSettings: () => ipcRenderer.invoke(IPC.SETTINGS_GET_GENERAL),
  getReasoningState: (payload?: { sessionId?: string }) => ipcRenderer.invoke(IPC.CHAT_GET_REASONING_STATE, payload),
  setReasoning: (payload: { sessionId?: string; providerKey: string; preference: unknown }) => ipcRenderer.invoke(IPC.CHAT_SET_REASONING, payload),
  // 截图
  startScreenshot: () => ipcRenderer.invoke(IPC.SCREENSHOT_START),
  onScreenshotInsert: (
    callback: (data: ScreenshotInsertPayload) => void,
  ) => {
    const listener = (
      _e: unknown,
      data: ScreenshotInsertPayload,
    ) => callback(data);
    ipcRenderer.on(IPC.SCREENSHOT_INSERT, listener);
    return () => ipcRenderer.removeListener(IPC.SCREENSHOT_INSERT, listener);
  },
  saveScreenshotTemp: (base64: string, mime: string) =>
    ipcRenderer.invoke(IPC.SCREENSHOT_SAVE_TEMP, base64, mime) as Promise<{ filePath: string }>,
};

contextBridge.exposeInMainWorld("cyrene", cyreneApi);
contextBridge.exposeInMainWorld("appUpdate", appUpdateApi);
contextBridge.exposeInMainWorld("chat", chatApi);

// AG-UI 事件流：发起一次 agent run，通过 onEvent 回调收 AG-UI 标准事件，
// 返回 AguiRunAck 表示 invoke 已被接收（终态仍由事件流承载）。
// onEvent 返回的取消订阅函数用于停止监听。
const aguiApi = {
  run: (input: {
    currentUser: {
      turnId: string;
      text: string;
      visibleContent: string;
      attachments?: Array<{ kind: "image" | "document"; name: string; filePath: string; mime?: string; caption?: string; hasAnnotations?: boolean }>;
      sticker?: string;
      at?: number;
    };
    assistantTurnId: string;
    styleId?: string;
    sessionId: string;
    imageAttachments?: { name: string; filePath: string; mime?: string }[];
    recoveryContext?: string;
    takeoverFromRunId?: string;
    transcriptRewind?: { anchorUserTurnId: string; disposition: "keep_user" | "replace_user" };
  }) =>
    // 返回 AguiRunAck，渲染端可立即拿到 canonical runId。
    // ack.runId 与后续 RUN_STARTED.runId 强一致（由 bridge 注入 options.runId 保证）。
    ipcRenderer.invoke(IPC.AGUI_RUN, input) as Promise<AguiRunAck>,
  onEvent: (callback: (event: unknown) => void) => {
    const listener = (_e: unknown, event: unknown) => {
      try {
        callback(event);
      } catch (err) {
        console.error("[Preload] listener抛错:", err);
      }
    };
    ipcRenderer.on(IPC.AGUI_EVENT, listener);
    return () => ipcRenderer.off(IPC.AGUI_EVENT, listener);
  },
  cancel: (runId?: string) => ipcRenderer.invoke(IPC.AGUI_CANCEL, runId),
  // 落盘确认（单向通知）：本轮 run 的终态消息已写入会话存储，
  // 主进程据此发布桌面轮次结束事件（插件生命周期观察）。
  reportRunPersisted: (payload: { runId: string; finalMessageId?: string }) => {
    ipcRenderer.send(IPC.AGUI_RUN_PERSISTED, payload);
  },
};

contextBridge.exposeInMainWorld("agui", aguiApi);

// System utilities exposed to renderer
const systemApi = {
  openExternal: (url: string) => ipcRenderer.invoke(IPC.OPEN_EXTERNAL, url),
};

contextBridge.exposeInMainWorld("system", systemApi);

const schedulerEventsApi = {
  onEvent: (callback: (event: unknown) => void) => {
    const listener = (_e: unknown, event: unknown) => {
      try {
        callback(event);
      } catch (err) {
        console.error("[Preload] scheduler listener抛错:", err);
      }
    };
    ipcRenderer.on(IPC.SCHEDULER_EVENT, listener);
    return () => ipcRenderer.off(IPC.SCHEDULER_EVENT, listener);
  },
};

contextBridge.exposeInMainWorld("schedulerEvents", schedulerEventsApi);

// 用户选择卡片（歧义消解器）：渲染端回传用户选择给主进程
// 卡片展示走 AGUI_EVENT 的 CUSTOM 事件（与天气卡片同通道），resolve 走独立 IPC
const choiceApi = {
  resolve: (id: string, value: unknown) =>
    ipcRenderer.invoke(
      IPC.CHOICE_RESOLVE,
      typeof value === "string" ? { id, value } : { id, answer: value },
    ),
};
contextBridge.exposeInMainWorld("choice", choiceApi);

const sidebarApi = {
  minimize: () => ipcRenderer.send(IPC.SIDEBAR_MINIMIZE),
  close: () => ipcRenderer.send(IPC.SIDEBAR_CLOSE),
  toggleAlwaysOnTop: () => ipcRenderer.invoke(IPC.SIDEBAR_TOGGLE_ALWAYS_ON_TOP),
  openTasks: () => ipcRenderer.send(IPC.SIDEBAR_OPEN_TASKS),
  openSettings: (section?: string) => ipcRenderer.send(IPC.SIDEBAR_OPEN_SETTINGS, section),
  openCall: () => ipcRenderer.send(IPC.SIDEBAR_OPEN_CALL),
};

contextBridge.exposeInMainWorld("sidebar", sidebarApi);

// 注意力 Toast 中心 API：渲染页纯表现层。
// 点击/关闭只上报 toast id，跳转目标由主进程查权威状态解析；高度上报服务于高度协议。
const toastApi: import("../shared/toast-types").ToastRendererApi = {
  getAll: () => ipcRenderer.invoke(IPC.TOAST_GET_ALL) as Promise<ToastItem[]>,
  clicked: (id: string) => ipcRenderer.send(IPC.TOAST_CLICKED, id),
  dismissed: (id: string) => ipcRenderer.send(IPC.TOAST_DISMISSED, id),
  reportHeight: (height: number) => ipcRenderer.send(IPC.TOAST_RESIZE, height),
  onPush: (callback: (payload: ToastPushPayload) => void) => {
    const handler = (_e: unknown, payload: ToastPushPayload) => callback(payload);
    ipcRenderer.on(IPC.TOAST_PUSH, handler);
    return () => ipcRenderer.removeListener(IPC.TOAST_PUSH, handler);
  },
  onRemove: (callback: (id: string) => void) => {
    const handler = (_e: unknown, id: string) => callback(id);
    ipcRenderer.on(IPC.TOAST_REMOVE, handler);
    return () => ipcRenderer.removeListener(IPC.TOAST_REMOVE, handler);
  },
};
contextBridge.exposeInMainWorld("toast", toastApi);

// Moments（动态 / 朋友圈）API：renderer 只能提交内容字段，author/id/createdAt 由主进程强制生成
const momentsApi: import("../shared/moments-types").MomentsApi = {
  list: (options) => ipcRenderer.invoke(IPC.MOMENTS_LIST, options),
  getPost: (postId) => ipcRenderer.invoke(IPC.MOMENTS_GET_POST, postId),
  createPost: (input) => ipcRenderer.invoke(IPC.MOMENTS_CREATE_POST, input),
  deletePost: (postId) => ipcRenderer.invoke(IPC.MOMENTS_DELETE_POST, postId),
  createComment: (input) => ipcRenderer.invoke(IPC.MOMENTS_CREATE_COMMENT, input),
  toggleLike: (postId) => ipcRenderer.invoke(IPC.MOMENTS_TOGGLE_LIKE, postId),
  listCharacters: () => ipcRenderer.invoke(IPC.MOMENTS_LIST_CHARACTERS),
  onChanged: (callback) => {
    const handler = () => callback();
    ipcRenderer.on(IPC.MOMENTS_CHANGED, handler);
    return () => ipcRenderer.removeListener(IPC.MOMENTS_CHANGED, handler);
  },
};
contextBridge.exposeInMainWorld("moments", momentsApi);

// 通话窗口 API
const callApi = {
  start: () => ipcRenderer.send(IPC.CALL_START),
  sendAudioFrame: (frame: ArrayBuffer) => ipcRenderer.send(IPC.CALL_AUDIO_FRAME, frame),
  turnEnd: () => ipcRenderer.send(IPC.CALL_TURN_END),
  ttsDone: () => ipcRenderer.send(IPC.CALL_TTS_DONE),
  stop: () => ipcRenderer.send(IPC.CALL_STOP),
  onState: (callback: (state: string) => void) => {
    const handler = (_event: unknown, data: { state: string }) => callback(data.state);
    ipcRenderer.on(IPC.CALL_STATE, handler);
    return () => ipcRenderer.removeListener(IPC.CALL_STATE, handler);
  },
  onAsrResult: (callback: (data: { partial?: string; final?: string }) => void) => {
    const handler = (_event: unknown, data: { partial?: string; final?: string }) => callback(data);
    ipcRenderer.on(IPC.CALL_ASR_RESULT, handler);
    return () => ipcRenderer.removeListener(IPC.CALL_ASR_RESULT, handler);
  },
  onTtsAudio: (callback: (data: { base64: string }) => void) => {
    const handler = (_event: unknown, data: { base64: string }) => callback(data);
    ipcRenderer.on(IPC.CALL_TTS_AUDIO, handler);
    return () => ipcRenderer.removeListener(IPC.CALL_TTS_AUDIO, handler);
  },
  onError: (callback: (data: { message: string }) => void) => {
    const handler = (_event: unknown, data: { message: string }) => callback(data);
    ipcRenderer.on(IPC.CALL_ERROR, handler);
    return () => ipcRenderer.removeListener(IPC.CALL_ERROR, handler);
  },
};
contextBridge.exposeInMainWorld("call", callApi);

const cyreneThemeApi = {
  get: () => ipcRenderer.invoke(IPC.UI_THEME_GET) as Promise<UiTheme>,
  onChanged: (callback: (theme: UiTheme) => void) => {
    const listener = (_e: unknown, theme: UiTheme) => callback(theme);
    ipcRenderer.on(IPC.UI_THEME_CHANGED, listener);
    return () => ipcRenderer.off(IPC.UI_THEME_CHANGED, listener);
  },
  getRadius: () => ipcRenderer.invoke(IPC.UI_THEME_RADIUS_GET) as Promise<boolean>,
  onRadiusChanged: (callback: (theme: boolean) => void) => {
    const listener = (_e: unknown, theme: boolean) => callback(theme);
    ipcRenderer.on(IPC.UI_THEME_RADIUS_CHANGED, listener);
    return () => ipcRenderer.off(IPC.UI_THEME_RADIUS_CHANGED, listener);
  },
};

contextBridge.exposeInMainWorld("cyreneTheme", cyreneThemeApi);

const cyreneWindowAppearanceApi = {
  getCornerRadius: () =>
    ipcRenderer.invoke(IPC.UI_WINDOW_CORNER_RADIUS_GET) as Promise<number>,
  onCornerRadiusChanged: (callback: (radius: number) => void) => {
    const listener = (_e: unknown, radius: number) => callback(radius);
    ipcRenderer.on(IPC.UI_WINDOW_CORNER_RADIUS_CHANGED, listener);
    return () => ipcRenderer.off(IPC.UI_WINDOW_CORNER_RADIUS_CHANGED, listener);
  },
};

contextBridge.exposeInMainWorld("cyreneWindowAppearance", cyreneWindowAppearanceApi);

const cyreneFontApi = {
  get: () => ipcRenderer.invoke(IPC.UI_FONT_GET) as Promise<UiFont>,
  onChanged: (callback: (font: UiFont) => void) => {
    const listener = (_e: unknown, font: UiFont) => callback(font);
    ipcRenderer.on(IPC.UI_FONT_CHANGED, listener);
    return () => ipcRenderer.off(IPC.UI_FONT_CHANGED, listener);
  },
};

contextBridge.exposeInMainWorld("cyreneFont", cyreneFontApi);

const cyreneAppearanceApi = {
  get: async () => {
    const settings = await ipcRenderer.invoke(IPC.SETTINGS_GET_GENERAL);
    return normalizeChatAppearance(settings);
  },
  onChanged: (callback: (settings: ChatAppearanceSettings) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, payload: unknown) => {
      callback(normalizeChatAppearance(payload));
    };
    ipcRenderer.on(IPC.CHAT_TYPOGRAPHY_CHANGED, listener);
    return () => {
      ipcRenderer.off(IPC.CHAT_TYPOGRAPHY_CHANGED, listener);
    };
  },
};

contextBridge.exposeInMainWorld("cyreneAppearance", cyreneAppearanceApi);

const settingsApi = {
  getConfig: () => ipcRenderer.invoke(IPC.SETTINGS_GET_CONFIG),
  saveConfig: (config: unknown) => ipcRenderer.invoke(IPC.SETTINGS_SAVE_CONFIG, config),
  listModelProfiles: () => ipcRenderer.invoke(IPC.SETTINGS_MODEL_PROFILES_LIST),
  saveModelProfile: (profile: unknown) => ipcRenderer.invoke(IPC.SETTINGS_MODEL_PROFILE_SAVE, profile),
  deleteModelProfile: (id: string) => ipcRenderer.invoke(IPC.SETTINGS_MODEL_PROFILE_DELETE, id),
  setDefaultModelProfile: (id: string) => ipcRenderer.invoke(IPC.SETTINGS_MODEL_PROFILE_SET_DEFAULT, id),
  testConnection: (config: { provider: string; baseUrl: string; model: string; apiKey: string; explicitTransport?: "openai" | "anthropic"; reasoning?: ReasoningPreference }) => ipcRenderer.invoke(IPC.SETTINGS_TEST_CONNECTION, config),
  testVision: (config: { baseUrl: string; apiKey: string; model: string }) => ipcRenderer.invoke(IPC.SETTINGS_TEST_VISION, config),
  // main → settings：要求切到指定标签（窗口已打开时由 main 发这个事件）
  onSwitchSection: (callback: (section: string) => void) => {
    const listener = (_e: unknown, section: string) => callback(section);
    ipcRenderer.on(IPC.SETTINGS_SWITCH_SECTION, listener);
    return () => ipcRenderer.off(IPC.SETTINGS_SWITCH_SECTION, listener);
  },
  getGeneral: () => ipcRenderer.invoke(IPC.SETTINGS_GET_GENERAL),
  saveGeneral: (config: unknown) => ipcRenderer.invoke(IPC.SETTINGS_SAVE_GENERAL, config),
  getTimeoutSettings: () => ipcRenderer.invoke(IPC.SETTINGS_GET_TIMEOUT_SETTINGS),
  saveTimeoutSettings: (config: unknown) => ipcRenderer.invoke(IPC.SETTINGS_SAVE_TIMEOUT_SETTINGS, config),
  pickUiFont: () => ipcRenderer.invoke(IPC.SETTINGS_PICK_UI_FONT) as Promise<string | null>,
  importUiFont: (sourcePath: string) => ipcRenderer.invoke(IPC.SETTINGS_IMPORT_UI_FONT, sourcePath) as Promise<UiFont>,
  resetUiFont: () => ipcRenderer.invoke(IPC.SETTINGS_RESET_UI_FONT) as Promise<UiFont>,
  openChromeGpu: () => ipcRenderer.send(IPC.SETTINGS_OPEN_CHROME_GPU),
  setPetAlwaysOnTop: (value: boolean) => ipcRenderer.send(IPC.SETTINGS_SET_PET_ALWAYS_ON_TOP, value),
  setPetVisible: (value: boolean) => ipcRenderer.send(IPC.SETTINGS_SET_PET_VISIBLE, value),
  setPetZoom: (value: number) => ipcRenderer.send(IPC.SETTINGS_SET_PET_ZOOM, value),
  previewRuntimeSync: (value: "off" | "local" | "llm") => ipcRenderer.send(IPC.SETTINGS_PREVIEW_RUNTIME_SYNC, value),
  openStickerManager: () => ipcRenderer.invoke(IPC.SETTINGS_OPEN_STICKER_MANAGER),
  openCustomStylePrompt: () => ipcRenderer.invoke(IPC.SETTINGS_OPEN_CUSTOM_STYLE_PROMPT),
  stickerPickFile: () => ipcRenderer.invoke(IPC.STICKERS_PICK_FILE),
  stickerAdd: (payload: { sourcePath: string; id: string; description: string; phrases: string[] }) => ipcRenderer.invoke(IPC.STICKERS_ADD, payload),
  embeddingSetModel: (model: string) => ipcRenderer.invoke(IPC.EMBEDDING_SET_MODEL, model),
  rerankerSetMode: (mode: string) => ipcRenderer.invoke(IPC.RERANKER_SET_MODE, mode),
  getRerankerStatus: (): Promise<{ light: boolean; standard: boolean }> => ipcRenderer.invoke(IPC.RERANKER_GET_STATUS),
  setToolEnabled: (id: string, enabled: boolean) => ipcRenderer.invoke(IPC.TOOL_SET_ENABLED, { id, enabled }),
  getToolEnabled: () => ipcRenderer.invoke(IPC.TOOL_GET_ENABLED),
  // 三模适配层：工具-模式覆盖层（UI 设置面板用）
  getToolCatalog: () => ipcRenderer.invoke(IPC.TOOL_GET_CATALOG),
  getToolModeOverrides: () => ipcRenderer.invoke(IPC.TOOL_GET_MODE_OVERRIDES),
  setToolModeOverride: (toolId: string, mode: string, enabled: boolean) =>
    ipcRenderer.invoke(IPC.TOOL_SET_MODE_OVERRIDE, { toolId, mode, enabled }),
  clearToolModeOverride: (toolId: string, mode?: string) =>
    ipcRenderer.invoke(IPC.TOOL_CLEAR_MODE_OVERRIDE, { toolId, mode }),
  listSkills: () => ipcRenderer.invoke(IPC.SKILL_LIST),
  setSkillEnabled: (id: string, enabled: boolean) => ipcRenderer.invoke(IPC.SKILL_SET_ENABLED, { id, enabled }),
  // 三模适配层：skill-模式覆盖层（UI 设置面板用）
  getSkillCatalog: () => ipcRenderer.invoke(IPC.SKILL_GET_CATALOG),
  rescanSkills: () => ipcRenderer.invoke(IPC.SKILL_RESCAN),
  getSkillModeOverrides: () => ipcRenderer.invoke(IPC.SKILL_GET_MODE_OVERRIDES),
  setSkillModeOverride: (skillId: string, mode: string, enabled: boolean) =>
    ipcRenderer.invoke(IPC.SKILL_SET_MODE_OVERRIDE, { skillId, mode, enabled }),
  clearSkillModeOverride: (skillId: string, mode?: string) =>
    ipcRenderer.invoke(IPC.SKILL_CLEAR_MODE_OVERRIDE, { skillId, mode }),
  addMcpServer: (config: unknown) => ipcRenderer.invoke(IPC.MCP_ADD_SERVER, config),
  removeMcpServer: (serverId: string) => ipcRenderer.invoke(IPC.MCP_REMOVE_SERVER, serverId),
  listMcpServers: () => ipcRenderer.invoke(IPC.MCP_LIST_SERVERS),
  listMcpServerConfigs: () => ipcRenderer.invoke(IPC.MCP_LIST_SERVER_CONFIGS),
  // 多渠道（微信/飞书/QQ/QQ 机器人）
  channelsGetConfig: () => ipcRenderer.invoke(IPC.CHANNELS_GET_CONFIG),
  channelsSaveConfig: (patch: unknown) => ipcRenderer.invoke(IPC.CHANNELS_SAVE_CONFIG, patch),
  channelsList: () => ipcRenderer.invoke(IPC.CHANNELS_LIST),
  channelsGetStatus: () => ipcRenderer.invoke(IPC.CHANNELS_GET_STATUS),
  channelsRestart: () => ipcRenderer.invoke(IPC.CHANNELS_RESTART),
  channelsWechatInstall: () => ipcRenderer.invoke(IPC.CHANNELS_WECHAT_INSTALL),
  channelsWechatLoginStart: () => ipcRenderer.invoke(IPC.CHANNELS_WECHAT_LOGIN_START),
  channelsWechatLoginCancel: () => ipcRenderer.invoke(IPC.CHANNELS_WECHAT_LOGIN_CANCEL),
  channelsWechatPairingList: () => ipcRenderer.invoke(IPC.CHANNELS_WECHAT_PAIRING_LIST),
  channelsWechatPairingApprove: (code: string) => ipcRenderer.invoke(IPC.CHANNELS_WECHAT_PAIRING_APPROVE, code),
  channelsWechatLogout: () => ipcRenderer.invoke(IPC.CHANNELS_WECHAT_LOGOUT),
  channelsWechatRuntimeDetect: () => ipcRenderer.invoke(IPC.CHANNELS_WECHAT_RUNTIME_DETECT),
  channelsWechatRuntimeInstall: () => ipcRenderer.invoke(IPC.CHANNELS_WECHAT_RUNTIME_INSTALL),
  channelsWechatRuntimeUpdate: () => ipcRenderer.invoke(IPC.CHANNELS_WECHAT_RUNTIME_UPDATE),
  channelsFeishuTestConnection: () => ipcRenderer.invoke(IPC.CHANNELS_FEISHU_TEST_CONNECTION),
  channelsFeishuTestWebhookReachable: () => ipcRenderer.invoke(IPC.CHANNELS_FEISHU_TEST_WEBHOOK_REACHABLE),
  channelsQqTestConnection: () => ipcRenderer.invoke(IPC.CHANNELS_QQ_TEST_CONNECTION),
  // 权威鉴权预检：监听地址能否解析、是否必须配 token 只有主进程知道
  channelsQqResolveAuthRequirement: (input: { listenMode: string; customHost?: string }) =>
    ipcRenderer.invoke(IPC.CHANNELS_QQ_RESOLVE_AUTH_REQUIREMENT, input) as Promise<QqListenAuthRequirement>,
  channelsQqBotTestConnection: () => ipcRenderer.invoke(IPC.CHANNELS_QQBOT_TEST_CONNECTION),
  // 消息日志
  channelsLogGet: (limit?: number) => ipcRenderer.invoke(IPC.CHANNELS_LOG_GET, limit ?? 100),
  channelsLogClear: () => ipcRenderer.invoke(IPC.CHANNELS_LOG_CLEAR),
  channelsContextBindingsGet: () => ipcRenderer.invoke(IPC.CHANNELS_CONTEXT_BINDINGS_GET),
  channelsContextBind: (payload: { sessionId: string; conversationId: string }) =>
    ipcRenderer.invoke(IPC.CHANNELS_CONTEXT_BIND, payload),
  channelsContextUnbind: (sessionId: string) => ipcRenderer.invoke(IPC.CHANNELS_CONTEXT_UNBIND, sessionId),
  onChannelsInstallProgress: (callback: (p: { channel: string; phase: string; pct: number }) => void) => {
    const listener = (_e: unknown, progress: { channel: string; phase: string; pct: number }) => callback(progress);
    ipcRenderer.on(IPC.CHANNELS_INSTALL_PROGRESS, listener);
    return () => ipcRenderer.off(IPC.CHANNELS_INSTALL_PROGRESS, listener);
  },
  onChannelsStatusChanged: (callback: (status: unknown) => void) => {
    const listener = (_e: unknown, status: unknown) => callback(status);
    ipcRenderer.on(IPC.CHANNELS_STATUS_CHANGED, listener);
    return () => ipcRenderer.off(IPC.CHANNELS_STATUS_CHANGED, listener);
  },
  // 微信扫码：订阅 Main 推送的 QR PNG dataURL
  onChannelsWechatQrcode: (callback: (dataUrl: string) => void) => {
    const listener = (_e: unknown, dataUrl: string) => callback(dataUrl);
    ipcRenderer.on(IPC.CHANNELS_WECHAT_QRCODE, listener);
    return () => ipcRenderer.off(IPC.CHANNELS_WECHAT_QRCODE, listener);
  },
  // 微信扫码：订阅 Main 推送的登录结果
  onChannelsWechatLoginDone: (callback: (payload: { ok: boolean; botId?: string; error?: string }) => void) => {
    const listener = (_e: unknown, payload: { ok: boolean; botId?: string; error?: string }) => callback(payload);
    ipcRenderer.on(IPC.CHANNELS_WECHAT_LOGIN_DONE, listener);
    return () => ipcRenderer.off(IPC.CHANNELS_WECHAT_LOGIN_DONE, listener);
  },
  // 权限档位
  getPermissionLevel: () => ipcRenderer.invoke(IPC.PERMISSION_GET_LEVEL),
  setPermissionLevel: (level: string) => ipcRenderer.invoke(IPC.PERMISSION_SET_LEVEL, level),
  // 计划模式开关（renderer → main）：显式设置 on/off
  setPlanMode: (payload: { conversationId: string; target: "on" | "off"; workspaceRoot?: string }) =>
    ipcRenderer.invoke(IPC.PLAN_SET_MODE, payload),
  // 计划模式状态查询（renderer → main）：挂载时调一次拿初始状态
  getPlanState: (conversationId: string) =>
    ipcRenderer.invoke(IPC.PLAN_GET_STATE, { conversationId }),
  // 计划模式状态广播（main → renderer）：任何入口触发的状态切换都走这条
  onPlanStateChanged: (
    callback: (payload: { conversationId: string; state: string }) => void,
  ) => {
    const listener = (
      _e: Electron.IpcRendererEvent,
      payload: { conversationId: string; state: string },
    ) => callback(payload);
    ipcRenderer.on(IPC.PLAN_STATE_CHANGED, listener);
    return () => ipcRenderer.removeListener(IPC.PLAN_STATE_CHANGED, listener);
  },

  // 审批弹窗：主进程在 per-action 档位下推过来的请求（不设超时，等用户回应或 run 取消）
  onPermissionApprovalRequest: (
    cb: (req: ApprovalRequest) => void
  ): (() => void) => {
    const listener = (_e: Electron.IpcRendererEvent, req: Parameters<typeof cb>[0]) => cb(req);
    ipcRenderer.on(IPC.PERMISSION_APPROVAL_REQUEST, listener);
    return () => ipcRenderer.removeListener(IPC.PERMISSION_APPROVAL_REQUEST, listener);
  },
  resolvePermissionApproval: (id: string, allowed: boolean): Promise<{ ok: boolean }> =>
    ipcRenderer.invoke(IPC.PERMISSION_APPROVAL_RESOLVE, { id, allowed }),
  // 审批结算广播：pending 已在主进程被结算（用户已答 / run 取消），渲染端据此清卡
  onPermissionApprovalSettled: (
    cb: (settlement: ApprovalSettledPayload) => void
  ): (() => void) => {
    const listener = (_e: Electron.IpcRendererEvent, settlement: Parameters<typeof cb>[0]) => cb(settlement);
    ipcRenderer.on(IPC.PERMISSION_APPROVAL_SETTLED, listener);
    return () => ipcRenderer.removeListener(IPC.PERMISSION_APPROVAL_SETTLED, listener);
  },
  // pop_quiz 抽查卡片（learn 模式）：主进程推送卡片（10s 幂等重播，同 quizId 覆盖）
  onPopQuizRequest: (
    cb: (card: { quizId: string; runId: string; intro: string; questions: unknown[] }) => void
  ): (() => void) => {
    const listener = (_e: Electron.IpcRendererEvent, card: Parameters<typeof cb>[0]) => cb(card);
    ipcRenderer.on(IPC.POP_QUIZ_REQUEST, listener);
    return () => ipcRenderer.removeListener(IPC.POP_QUIZ_REQUEST, listener);
  },
  // 提交作答：返回值带主进程本地判分详情，渲染端据此切展示态
  resolvePopQuiz: (submission: unknown): Promise<{ ok: boolean; error?: string; graded?: unknown[] }> =>
    ipcRenderer.invoke(IPC.POP_QUIZ_RESOLVE, submission),
  // 跳过整次抽查
  skipPopQuiz: (quizId: string): Promise<{ ok: boolean; error?: string }> =>
    ipcRenderer.invoke(IPC.POP_QUIZ_SKIP, { quizId }),
  // 抽查结算广播：提交/跳过/run 取消后主进程广播，渲染端据此清卡
  onPopQuizSettled: (
    cb: (settlement: { quizId: string; runId?: string; reason: "submitted" | "skipped" | "cancelled" }) => void
  ): (() => void) => {
    const listener = (_e: Electron.IpcRendererEvent, settlement: Parameters<typeof cb>[0]) => cb(settlement);
    ipcRenderer.on(IPC.POP_QUIZ_SETTLED, listener);
    return () => ipcRenderer.removeListener(IPC.POP_QUIZ_SETTLED, listener);
  },
  // 截图热键捕获（设置页临时挂起全局快捷键）
  beginScreenshotHotkeyCapture: () => ipcRenderer.invoke(IPC.SCREENSHOT_HOTKEY_CAPTURE_START),
  endScreenshotHotkeyCapture: () => ipcRenderer.invoke(IPC.SCREENSHOT_HOTKEY_CAPTURE_END),
};

contextBridge.exposeInMainWorld("settings", settingsApi);

const pluginsApi = {
  list: () => ipcRenderer.invoke(IPC.PLUGINS_LIST),
  setEnabled: (id: string, enabled: boolean) =>
    ipcRenderer.invoke(IPC.PLUGINS_SET_ENABLED, id, enabled),
  open: (id: string) => ipcRenderer.invoke(IPC.PLUGINS_OPEN, id),
  rescan: () => ipcRenderer.invoke(IPC.PLUGINS_RESCAN),
  importZip: () => ipcRenderer.invoke(IPC.PLUGINS_IMPORT_ZIP),
  uninstall: (id: string) => ipcRenderer.invoke(IPC.PLUGINS_UNINSTALL, id),
  marketList: (preferred?: string) => ipcRenderer.invoke(IPC.PLUGINS_MARKET_LIST, preferred),
  marketInstall: (id: string) => ipcRenderer.invoke(IPC.PLUGINS_MARKET_INSTALL, id),
};

contextBridge.exposeInMainWorld("plugins", pluginsApi);

// 设置面板桥的统一转发通道：只暴露单一 invoke，pluginId 由设置页宿主
// 按 iframe 归属填入；主进程侧还会校验 sender 窗口身份
const pluginPanelApi: PluginPanelApi = {
  invoke: (pluginId, channel, args) =>
    ipcRenderer.invoke(IPC.PLUGINS_PANEL_INVOKE, pluginId, channel, args),
};

contextBridge.exposeInMainWorld("pluginPanel", pluginPanelApi);

const schedulerApi = {
  list: () => ipcRenderer.invoke(IPC.SCHEDULER_LIST),
  add: (input: unknown) => ipcRenderer.invoke(IPC.SCHEDULER_ADD, input),
  update: (id: string, patch: unknown) => ipcRenderer.invoke(IPC.SCHEDULER_UPDATE, id, patch),
  delete: (id: string) => ipcRenderer.invoke(IPC.SCHEDULER_DELETE, id),
  toggle: (id: string, enabled: boolean) => ipcRenderer.invoke(IPC.SCHEDULER_TOGGLE, id, enabled),
  fireNow: (id: string) => ipcRenderer.invoke(IPC.SCHEDULER_FIRE_NOW, id),
  getHistory: (taskId: string, limit?: number) => ipcRenderer.invoke(IPC.SCHEDULER_GET_HISTORY, taskId, limit),
  getTools: () => ipcRenderer.invoke(IPC.SCHEDULER_GET_TOOLS),
  onChanged: (callback: () => void) => {
    const listener = () => callback();
    ipcRenderer.on(IPC.SCHEDULER_CHANGED, listener);
    return () => ipcRenderer.removeListener(IPC.SCHEDULER_CHANGED, listener);
  },
};

contextBridge.exposeInMainWorld("cyreneScheduler", schedulerApi);

const stickerManagerApi = {
	  minimize: () => ipcRenderer.send(IPC.STICKERS_MINIMIZE),
	  close: () => ipcRenderer.send(IPC.STICKERS_CLOSE),
	  getConfig: () => ipcRenderer.invoke(IPC.STICKERS_GET_CONFIG),
	  setEnabled: (id: string, enabled: boolean) => ipcRenderer.invoke(IPC.STICKERS_SET_ENABLED, { id, enabled }),
	  pickFile: () => ipcRenderer.invoke(IPC.STICKERS_PICK_FILE),
	  addSticker: (payload: { sourcePath: string; id: string; description: string; phrases: string[] }) =>
	    ipcRenderer.invoke(IPC.STICKERS_ADD, payload),
	  deleteSticker: (id: string) => ipcRenderer.invoke(IPC.STICKERS_DELETE, id),
	};

contextBridge.exposeInMainWorld("stickerManager", stickerManagerApi);

const modelConfigApi = {
  get: () => ipcRenderer.invoke(IPC.MODEL_CONFIG_GET),
  getModelInstallStatus: () => ipcRenderer.invoke(IPC.MODEL_GET_INSTALL_STATUS),
  onChanged: (callback: (config: unknown) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, config: unknown) => callback(config);
    ipcRenderer.on(IPC.MODEL_CONFIG_CHANGED, listener);
    return () => ipcRenderer.removeListener(IPC.MODEL_CONFIG_CHANGED, listener);
  },
};

contextBridge.exposeInMainWorld("modelConfig", modelConfigApi);
const runtimeStateApi = {
  get: () => ipcRenderer.invoke(IPC.RUNTIME_STATE_GET),
  onChanged: (callback: (state: unknown) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, state: unknown) => callback(state);
    ipcRenderer.on(IPC.RUNTIME_STATE_CHANGED, listener);
    return () => ipcRenderer.removeListener(IPC.RUNTIME_STATE_CHANGED, listener);
  },
};

const userApi = {
  getProfile: () => ipcRenderer.invoke(IPC.USER_GET_PROFILE),
  saveProfile: (profile: unknown) => ipcRenderer.invoke(IPC.USER_SAVE_PROFILE, profile),
  onProfileChanged: (callback: (profile: unknown) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, profile: unknown) => callback(profile);
    ipcRenderer.on(IPC.USER_PROFILE_CHANGED, listener);
    return () => ipcRenderer.off(IPC.USER_PROFILE_CHANGED, listener);
  },
  uploadAvatar: () => ipcRenderer.invoke(IPC.USER_UPLOAD_AVATAR),
  getAvatar: () => ipcRenderer.invoke(IPC.USER_GET_AVATAR),
  onAvatarChanged: (callback: () => void) => {
    const listener = (_event: Electron.IpcRendererEvent) => callback();
    ipcRenderer.on(IPC.USER_AVATAR_CHANGED, listener);
    return () => ipcRenderer.off(IPC.USER_AVATAR_CHANGED, listener);
  },
};

const memoryPanelApi = {
  getData: () => ipcRenderer.invoke(IPC.MEMORY_PANEL_GET_DATA),
  deleteImportedDoc: (importId: string, fileName?: string) => ipcRenderer.invoke(IPC.MEMORY_PANEL_DELETE_IMPORTED_DOC, { importId, fileName }),
  saveL0: (patch: Record<string, unknown>) => ipcRenderer.invoke(IPC.MEMORY_PANEL_SAVE_L0, patch),
  saveL1: (patch: Record<string, unknown>) => ipcRenderer.invoke(IPC.MEMORY_PANEL_SAVE_L1, patch),
  exportToObsidianVault: () => ipcRenderer.invoke(IPC.MEMORY_EXPORT_OBSIDIAN_VAULT),
  bindVault: () => ipcRenderer.invoke(IPC.OBSIDIAN_VAULT_BIND),
  unbindVault: () => ipcRenderer.invoke(IPC.OBSIDIAN_VAULT_UNBIND),
  getVaultConfig: () => ipcRenderer.invoke(IPC.OBSIDIAN_VAULT_GET_CONFIG),
  setAutoSync: (autoSync: boolean) => ipcRenderer.invoke(IPC.OBSIDIAN_VAULT_SET_AUTO_SYNC, autoSync),
  syncNow: () => ipcRenderer.invoke(IPC.OBSIDIAN_VAULT_SYNC_NOW),
};

contextBridge.exposeInMainWorld("user", userApi);
contextBridge.exposeInMainWorld("memoryPanel", memoryPanelApi);
contextBridge.exposeInMainWorld("runtimeState", runtimeStateApi);

const live2dSpeechApi = {
  prepare: () => ipcRenderer.send(IPC.LIVE2D_SPEECH_PREPARE),
  startMouth: (durationMs: number) => ipcRenderer.send(IPC.LIVE2D_MOUTH_START, { durationMs }),
  stopMouth: () => ipcRenderer.send(IPC.LIVE2D_MOUTH_STOP),
  onPrepare: (callback: () => void) => {
    const listener = () => callback();
    ipcRenderer.on(IPC.LIVE2D_SPEECH_PREPARE, listener);
    return () => ipcRenderer.removeListener(IPC.LIVE2D_SPEECH_PREPARE, listener);
  },
  onMouthStart: (callback: (payload: { durationMs: number }) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, payload: { durationMs: number }) => callback(payload);
    ipcRenderer.on(IPC.LIVE2D_MOUTH_START, listener);
    return () => ipcRenderer.removeListener(IPC.LIVE2D_MOUTH_START, listener);
  },
  onMouthStop: (callback: () => void) => {
    const listener = () => callback();
    ipcRenderer.on(IPC.LIVE2D_MOUTH_STOP, listener);
    return () => ipcRenderer.removeListener(IPC.LIVE2D_MOUTH_STOP, listener);
  },
};
contextBridge.exposeInMainWorld("live2dSpeech", live2dSpeechApi);

const live2dActionApi = {
  onPlayAction: (callback: (payload: import("../shared/live2d-actions").Live2DTarget) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, payload: import("../shared/live2d-actions").Live2DTarget) => callback(payload);
    ipcRenderer.on(IPC.LIVE2D_PLAY_ACTION, listener);
    return () => ipcRenderer.removeListener(IPC.LIVE2D_PLAY_ACTION, listener);
  },
};
contextBridge.exposeInMainWorld("live2dAction", live2dActionApi);

const live2dDiagnosticsApi = {
  getMain: () => ipcRenderer.invoke(IPC.LIVE2D_GET_MAIN_DIAGNOSTICS),
  getIpcListenerCounts: () => getLive2DIpcListenerCounts(ipcRenderer),
};
contextBridge.exposeInMainWorld("live2dDiagnostics", live2dDiagnosticsApi);

// 聊天会话存储（多对话历史）
const chatStoreApi = {
  list: (options?: { mode?: "chat" | "work" | "code" | "learn" }) => ipcRenderer.invoke(IPC.CHATS_LIST, options),
  getSidebarOrganization: () => ipcRenderer.invoke(IPC.CHATS_SIDEBAR_ORGANIZATION_GET) as Promise<SidebarOrganizationSnapshot>,
  applySidebarOrganization: (expectedRevision: number, draft: SidebarOrganizationDraft) =>
    ipcRenderer.invoke(IPC.CHATS_SIDEBAR_ORGANIZATION_APPLY, { expectedRevision, draft }) as Promise<SidebarOrganizationResult>,
  onSidebarOrganizationChanged: (callback: () => void) => {
    const listener = () => callback();
    ipcRenderer.on(IPC.CHATS_SIDEBAR_ORGANIZATION_CHANGED, listener);
    return () => ipcRenderer.removeListener(IPC.CHATS_SIDEBAR_ORGANIZATION_CHANGED, listener);
  },
  get: (id: string) => ipcRenderer.invoke(IPC.CHATS_GET, id),
  getPage: (id: string, before: number | null, limit: number) =>
    ipcRenderer.invoke(IPC.CHATS_GET_PAGE, { id, before, limit }),
  create: (payload?: { title?: string; identityId?: string | null; mode?: "chat" | "work" | "code" | "learn" }) =>
    ipcRenderer.invoke(IPC.CHATS_CREATE, payload ?? {}),
  checkpointPresentation: (sessionId: string, messageId: string, mutationKey: string, patch: unknown) =>
    ipcRenderer.invoke(IPC.CTA_PRESENTATION_CHECKPOINT, { sessionId, messageId, mutationKey, patch }),
  // 主动压缩：把模型窗口内旧消息摘要成一条记忆（上下文容量菜单小人点击触发）
  compactConversation: (sessionId: string) =>
    ipcRenderer.invoke(IPC.CHATS_COMPACT, { sessionId }) as Promise<{
      ok: boolean;
      error?: string;
      before?: number;
      after?: number;
    }>,
  rename: (id: string, title: string) =>
    ipcRenderer.invoke(IPC.CHATS_RENAME, { id, title }),
  delete: (id: string) => ipcRenderer.invoke(IPC.CHATS_DELETE, id),
  // 会话级待发队列：入队成功才清草稿（失败保留并提示）；读取/删除按稳定标识
  pendingEnqueue: (id: string, entry: unknown) =>
    ipcRenderer.invoke(IPC.CHATS_PENDING_ENQUEUE, { sessionId: id, entry }),
  pendingList: (id: string) => ipcRenderer.invoke(IPC.CHATS_PENDING_LIST, id),
  pendingRemove: (id: string, messageId: string) =>
    ipcRenderer.invoke(IPC.CHATS_PENDING_REMOVE, { sessionId: id, messageId }),
  // 认领队首（主进程单次写入完成转正式消息 + 派发状态）；run 确认接受后清除派发状态
  pendingClaim: (id: string) => ipcRenderer.invoke(IPC.CHATS_PENDING_CLAIM, id),
  pendingCompleteDispatch: (id: string, messageId: string) =>
    ipcRenderer.invoke(IPC.CHATS_PENDING_COMPLETE_DISPATCH, { sessionId: id, messageId }),
  // 修改未认领条目文字（保持标识/顺序/附件不变；冲突返回最新权威队列）
  pendingEdit: (
    id: string,
    messageId: string,
    update: { rawContent: string; visibleContent: string; userSticker?: string },
  ) =>
    ipcRenderer.invoke(IPC.CHATS_PENDING_EDIT, {
      sessionId: id,
      messageId,
      rawContent: update.rawContent,
      visibleContent: update.visibleContent,
      ...(update.userSticker !== undefined ? { userSticker: update.userSticker } : {}),
    }),
  // 调整：把待发条目插入当前运行下一步（绑定活跃运行；不可调整时明确拒绝并留队）
  pendingAdjust: (id: string, messageId: string) =>
    ipcRenderer.invoke(IPC.CHATS_PENDING_ADJUST, { sessionId: id, messageId }),
  setPinned: (id: string, pinned: boolean) =>
    ipcRenderer.invoke(IPC.CHATS_SET_PINNED, { id, pinned }),
  setModelProfile: (id: string, modelProfileId?: string) =>
    ipcRenderer.invoke(IPC.CHATS_SET_MODEL_PROFILE, { id, modelProfileId }),
  // 会话级当前模型窄 IPC：主进程校验 + 原子写入，失败返回机器可读错误（UI 据此回滚）
  setSessionModel: (id: string, model: string) =>
    ipcRenderer.invoke(IPC.CHATS_SET_SESSION_MODEL, { id, model }),
  openFolder: () => ipcRenderer.invoke(IPC.CHATS_OPEN_FOLDER),
  openWorkspace: (workspaceRoot: string) =>
    ipcRenderer.invoke(IPC.CHATS_OPEN_WORKSPACE, workspaceRoot),
  migrateLegacy: (messages: unknown[]) =>
    ipcRenderer.invoke(IPC.CHATS_MIGRATE_LEGACY, messages),
  // 聊天窗口加载 / 切换 session 时上报；附带本页面的渲染目标标识与会话模式，
  // 主进程据此维护语音输入租约冻结的活动目标；其他窗口可查询/订阅
  setActiveSession: (sessionId: string | null, mode?: ConversationMode) =>
    ipcRenderer.invoke(
      IPC.CHATS_SET_ACTIVE_SESSION,
      sessionId ? { sessionId, mode, rendererTargetId } : null,
    ),
  getActiveSession: () => ipcRenderer.invoke(IPC.CHATS_GET_ACTIVE_SESSION),
  onActiveSessionChanged: (callback: (sessionId: string | null) => void) => {
    const listener = (_e: Electron.IpcRendererEvent, sessionId: string | null) => callback(sessionId);
    ipcRenderer.on(IPC.CHATS_ACTIVE_SESSION_CHANGED, listener);
    return () => ipcRenderer.removeListener(IPC.CHATS_ACTIVE_SESSION_CHANGED, listener);
  },
  // 任意会话变动后 main 广播；列表/聊天窗口订阅刷新
  onChanged: (callback: () => void) => {
    const listener = () => callback();
    ipcRenderer.on(IPC.CHATS_CHANGED, listener);
    return () => ipcRenderer.removeListener(IPC.CHATS_CHANGED, listener);
  },
  // ── 对话工作区绑定 ──────────────────────────────────────
  setWorkspace: (sessionId: string, workspaceRoot: string) =>
    ipcRenderer.invoke(IPC.CHATS_SET_WORKSPACE, { sessionId, workspaceRoot }),
  getWorkspace: (sessionId: string) =>
    ipcRenderer.invoke(IPC.CHATS_GET_WORKSPACE, sessionId),
  clearWorkspace: (sessionId: string) =>
    ipcRenderer.invoke(IPC.CHATS_CLEAR_WORKSPACE, sessionId),
  pickWorkspaceFolder: () =>
    ipcRenderer.invoke(IPC.CHATS_PICK_WORKSPACE_FOLDER),
  initLearnWorkspace: (sessionId: string) =>
    ipcRenderer.invoke(IPC.CHATS_INIT_LEARN_WORKSPACE, sessionId),
  onWorkspaceChanged: (callback: (payload: { sessionId: string; binding: unknown }) => void) => {
    const listener = (_e: Electron.IpcRendererEvent, payload: { sessionId: string; binding: unknown }) =>
      callback(payload);
    ipcRenderer.on(IPC.CHATS_WORKSPACE_CHANGED, listener);
    return () => ipcRenderer.removeListener(IPC.CHATS_WORKSPACE_CHANGED, listener);
  },
  // 状态栏专用入口：要求 main 打开/复用 reactChatWindow 并加载指定 sessionId
  openInReactChatWindow: (sessionId: string) =>
    ipcRenderer.invoke(IPC.CHATS_OPEN_IN_REACT_WINDOW, sessionId),
  // main → reactChatWindow：通知 ChatPage 切换到指定 sessionId
  onReactSwitchSession: (callback: (sessionId: string) => void) => {
    const listener = (_e: Electron.IpcRendererEvent, sessionId: string) => callback(sessionId);
    ipcRenderer.on(IPC.CHATS_REACT_SWITCH_SESSION, listener);
    return () => ipcRenderer.removeListener(IPC.CHATS_REACT_SWITCH_SESSION, listener);
  },
  // reactChatWindow → main：ChatPage 已挂好 IPC 监听，允许 flush pending sessionId
  notifyReactReady: () => ipcRenderer.send(IPC.CHATS_REACT_READY),
  // 本页面的渲染目标标识（页面初始化时生成一次；语音提交桥据此识别过期请求）
  getRendererTargetId: () => rendererTargetId,
  // main → ChatPage：外部语音文本提交请求（携带租约冻结的目标）
  onSpeechInputCommitRequest: (callback: (request: SpeechInputCommitRequest) => void) => {
    const listener = (
      _e: Electron.IpcRendererEvent,
      request: SpeechInputCommitRequest,
    ) => callback(request);
    ipcRenderer.on(IPC.SPEECH_INPUT_COMMIT_REQUEST, listener);
    return () => ipcRenderer.removeListener(IPC.SPEECH_INPUT_COMMIT_REQUEST, listener);
  },
  // ChatPage → main：提交结果（必须回显 requestId 与 rendererTargetId）
  sendSpeechInputCommitResult: (result: SpeechInputCommitResult) =>
    ipcRenderer.send(IPC.SPEECH_INPUT_COMMIT_RESULT, result),
};

contextBridge.exposeInMainWorld("chatStore", chatStoreApi);

// Review 快照：获取指定 Run 的不可变文件变更审查数据
const reviewApi = {
  get: (runId: string) => ipcRenderer.invoke(IPC.REVIEW_GET, runId) as Promise<ReviewSnapshot | null>,
  // 把本次 Run 修改过的文件恢复到运行前状态（基于 before/ 基线）
  restore: (runId: string) => ipcRenderer.invoke(IPC.REVIEW_RESTORE, runId) as Promise<ReviewRestoreOutcome>,
};

contextBridge.exposeInMainWorld("review", reviewApi);

// 会话工作区只读文件（右侧面板文件树 / 预览；主进程负责 realpath 防越界）
const workspaceFilesApi = {
  list: (sessionId: string, relPath: string) =>
    ipcRenderer.invoke(IPC.WORKSPACE_FILES_LIST, { sessionId, relPath }) as Promise<WorkspaceListResult>,
  read: (sessionId: string, relPath: string) =>
    ipcRenderer.invoke(IPC.WORKSPACE_FILES_READ, { sessionId, relPath }) as Promise<WorkspaceReadResult>,
};

contextBridge.exposeInMainWorld("workspaceFiles", workspaceFilesApi);

// 工作区右上角"打开"菜单：本机应用探测（主进程进程内缓存）+ 打开执行
const openInAppApi = {
  listApps: (sessionId: string) =>
    ipcRenderer.invoke(IPC.WORKSPACE_OPEN_IN_LIST_APPS, { sessionId }) as Promise<OpenInAppListResult>,
  open: (sessionId: string, appId: string) =>
    ipcRenderer.invoke(IPC.WORKSPACE_OPEN_IN, { sessionId, appId }) as Promise<OpenInAppOpenResult>,
};

contextBridge.exposeInMainWorld("openInApp", openInAppApi);

const codeGitApi = {
  getStatus: (sessionId: string) => ipcRenderer.invoke(IPC.CODE_GIT_STATUS, sessionId),
  watch: (sessionId: string) => ipcRenderer.invoke(IPC.CODE_GIT_WATCH, sessionId),
  unwatch: (sessionId: string) => ipcRenderer.invoke(IPC.CODE_GIT_UNWATCH, sessionId),
  switchBranch: (sessionId: string, branch: string, create = false) => ipcRenderer.invoke(IPC.CODE_GIT_SWITCH_BRANCH, { sessionId, branch, create }),
  commit: (sessionId: string, message: string, paths: string[]) => ipcRenderer.invoke(IPC.CODE_GIT_COMMIT, { sessionId, message, paths }),
  push: (sessionId: string) => ipcRenderer.invoke(IPC.CODE_GIT_PUSH, sessionId),
  onChanged: (callback: (payload: { sessionId: string }) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, payload: { sessionId: string }) => callback(payload);
    ipcRenderer.on(IPC.CODE_GIT_CHANGED, listener);
    return () => ipcRenderer.removeListener(IPC.CODE_GIT_CHANGED, listener);
  },
};
contextBridge.exposeInMainWorld("codeGit", codeGitApi);

// Token 用量查询（设置中心 Token 面板用）
const tokenUsageApi = {
  get: (days: number) => ipcRenderer.invoke(IPC.TOKEN_USAGE_GET, days),
  clear: () => ipcRenderer.invoke(IPC.TOKEN_USAGE_CLEAR) as Promise<void>,
};
contextBridge.exposeInMainWorld("tokenUsage", tokenUsageApi);

// TTS 语音合成（设置中心 TTS 面板 + 聊天窗口朗读用）
const ttsApi = {
  startSession: (payload: StartTtsRequest): Promise<TtsStartResult> =>
    ipcRenderer.invoke(IPC.TTS_SESSION_START, payload),
  cancelSession: (requestId: string): Promise<boolean> =>
    ipcRenderer.invoke(IPC.TTS_SESSION_CANCEL, requestId),
  onSessionEvent: (callback: (event: TtsSessionEvent) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, payload: TtsSessionEvent) => callback(payload);
    ipcRenderer.on(IPC.TTS_SESSION_EVENT, listener);
    return () => ipcRenderer.removeListener(IPC.TTS_SESSION_EVENT, listener);
  },
  upload: (apiKey: string, filePath: string, purpose: "voice_clone" | "prompt_audio") =>
    ipcRenderer.invoke(IPC.TTS_UPLOAD, { apiKey, filePath, purpose }),
  pickAudio: () => ipcRenderer.invoke(IPC.TTS_PICK_AUDIO),
  clone: (payload: {
    apiKey: string; fileId: string; voiceId: string;
    promptAudioId?: string; promptText?: string;
    text: string; model?: string;
  }) => ipcRenderer.invoke(IPC.TTS_CLONE, payload),
  synthesize: (payload: {
    apiKey: string; voiceId: string; text: string;
    speed?: number; volume?: number; pitch?: number;
    model?: string; format?: "mp3" | "wav" | "pcm";
    vocalEnhance?: { enabled: boolean };
  }) => ipcRenderer.invoke(IPC.TTS_SYNTHESIZE, payload),
  synthesizeCached: (payload: {
    apiKey: string; voiceId: string; text: string;
    speed?: number; volume?: number; pitch?: number;
    model?: string; format?: "mp3" | "wav" | "pcm";
    expectedCacheKey?: string;
  }) => ipcRenderer.invoke(IPC.TTS_SYNTHESIZE_CACHED, payload),
  // GPT-SoVITS 本地 TTS（独立通道，payload 与 minimax 不同）
  synthesizeGptsovits: (payload: {
    baseUrl: string; refAudioPath: string; promptText: string; text: string;
    speed?: number; format?: "wav" | "mp3";
  }) => ipcRenderer.invoke(IPC.TTS_SYNTHESIZE_GPTSOVITS, payload),
  synthesizeCachedGptsovits: (payload: {
    baseUrl: string; refAudioPath: string; promptText: string; text: string;
    speed?: number; format?: "wav" | "mp3";
    expectedCacheKey?: string;
  }) => ipcRenderer.invoke(IPC.TTS_SYNTHESIZE_CACHED_GPTSOVITS, payload),
  // 自定义云端 TTS（固定 HTTP 合约）
  synthesizeCustomCloud: (payload: {
    endpointUrl: string; apiKey?: string; voiceId?: string; text: string;
    speed?: number; volume?: number; format?: "wav" | "mp3"; timeoutMs?: number;
  }) => ipcRenderer.invoke(IPC.TTS_SYNTHESIZE_CUSTOM_CLOUD, payload),
  synthesizeCachedCustomCloud: (payload: {
    endpointUrl: string; apiKey?: string; voiceId?: string; text: string;
    speed?: number; volume?: number; format?: "wav" | "mp3"; timeoutMs?: number;
    expectedCacheKey?: string;
  }) => ipcRenderer.invoke(IPC.TTS_SYNTHESIZE_CACHED_CUSTOM_CLOUD, payload),
  // 小米 MiMo TTS（官方 chat-completions 接口）
  synthesizeMimo: (payload: {
    apiKey: string; voiceAudioPath?: string; text: string; stylePrompt?: string;
  }) => ipcRenderer.invoke(IPC.TTS_SYNTHESIZE_MIMO, payload),
  synthesizeCachedMimo: (payload: {
    apiKey: string; voiceAudioPath?: string; text: string; stylePrompt?: string;
    expectedCacheKey?: string;
  }) => ipcRenderer.invoke(IPC.TTS_SYNTHESIZE_CACHED_MIMO, payload),
  // Mossland TTS（api.mosi.cn，POST /v1/audio/speech）
  synthesizeMossland: (payload: {
    apiKey: string; voiceId: string; text: string;
    model?: string; format?: "mp3" | "wav";
  }) => ipcRenderer.invoke(IPC.TTS_SYNTHESIZE_MOSSLAND, payload),
  synthesizeCachedMossland: (payload: {
    apiKey: string; voiceId: string; text: string;
    model?: string; format?: "mp3" | "wav";
    expectedCacheKey?: string;
  }) => ipcRenderer.invoke(IPC.TTS_SYNTHESIZE_CACHED_MOSSLAND, payload),
  // Mossland 音色克隆（POST /v1/audio/voices，multipart 上传本地文件）
  cloneMossland: (payload: {
    apiKey: string; filePath: string; name?: string; description?: string;
  }) => ipcRenderer.invoke(IPC.TTS_CLONE_MOSSLAND, payload),
  // Mossland 拉取账号下音色列表（GET /v1/audio/voices）
  listMosslandVoices: (payload: {
    apiKey: string; limit?: number; offset?: number; after?: string; status?: string;
  }) => ipcRenderer.invoke(IPC.TTS_LIST_MOSSLAND_VOICES, payload),
  // 选择音频文件（复用 TTS_PICK_AUDIO，gptsovits 选 ref audio 也用这个）
  pickAudioFile: () => ipcRenderer.invoke(IPC.TTS_PICK_AUDIO),
  // 流式语音合成（边合成边播）
  streamStart: (payload: {
    apiKey: string; voiceId: string; text: string;
    speed?: number; volume?: number; pitch?: number;
    model?: string; format?: "mp3" | "wav" | "pcm";
    expectedCacheKey?: string;
  }) => ipcRenderer.invoke(IPC.TTS_STREAM_START, payload),
  onAudioChunk: (callback: (payload: { base64: string }) => void) => {
    const listener = (_e: Electron.IpcRendererEvent, payload: { base64: string }) => callback(payload);
    ipcRenderer.on(IPC.TTS_AUDIO_CHUNK, listener);
    return () => ipcRenderer.removeListener(IPC.TTS_AUDIO_CHUNK, listener);
  },
  onStreamEnd: (callback: (payload: { cacheKey: string; cached: boolean; format: "mp3" | "wav" | "pcm" }) => void) => {
    const listener = (_e: Electron.IpcRendererEvent, payload: { cacheKey: string; cached: boolean; format: "mp3" | "wav" | "pcm" }) => callback(payload);
    ipcRenderer.on(IPC.TTS_STREAM_END, listener);
    return () => ipcRenderer.removeListener(IPC.TTS_STREAM_END, listener);
  },
  onStreamError: (callback: (payload: { message: string }) => void) => {
    const listener = (_e: Electron.IpcRendererEvent, payload: { message: string }) => callback(payload);
    ipcRenderer.on(IPC.TTS_STREAM_ERROR, listener);
    return () => ipcRenderer.removeListener(IPC.TTS_STREAM_ERROR, listener);
  },
  saveSettings: (tts: Record<string, unknown>) => ipcRenderer.invoke(IPC.TTS_SAVE_SETTINGS, tts),
  loadSettings: () => ipcRenderer.invoke(IPC.TTS_LOAD_SETTINGS),
};
contextBridge.exposeInMainWorld("tts", ttsApi);

exposeMusicApi();
