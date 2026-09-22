// IPC channel names shared between main and renderer
export interface ScreenshotInsertPayload {
  mime: "image/png";
  width: number;
  height: number;
  filePath: string;
  previewUrl: string;
  hasAnnotations: boolean;
}

/** 语音输入提交请求（main → 聊天窗口渲染页）：把外部识别文本提交到冻结的会话。 */
export interface SpeechInputCommitRequest {
  /** 本次提交的关联标识；结果必须原样回显。 */
  requestId: string;
  /** 租约冻结的渲染目标标识；页面据此识别过期请求。 */
  rendererTargetId: string;
  sessionId: string;
  mode: "chat" | "work" | "learn" | "code";
  text: string;
}

/** 语音输入提交结果（渲染页 → main）：必须回显 requestId 与 rendererTargetId。 */
export interface SpeechInputCommitResult {
  requestId: string;
  rendererTargetId: string;
  ok: boolean;
  /** ok 为 false 时的稳定错误码（PluginHostErrorCode 之一）与说明。 */
  error?: { code: string; message: string };
}

export const IPC = {
  // pet window
  WINDOW_MINIMIZE: "window:minimize",
  WINDOW_CLOSE: "window:close",
  WINDOW_DRAG_START: "window:drag-start",
  WINDOW_SET_INTERACTIVE: "window:set-interactive",
  WINDOW_MOVE: "window:move",
  WINDOW_MOVE_TO: "window:move-to",
  WINDOW_SET_DRAGGING: "window:set-dragging",
  WINDOW_CAPTURE_FRAME: "window:capture-frame",
  WINDOW_GET_CURSOR_POSITION: "window:get-cursor-position",
  PET_VISIBILITY_CHANGED: "pet:visibility-changed",
  APP_QUIT: "app:quit",

  // GitHub 应用更新
  APP_UPDATE_GET_STATE: "app-update:get-state",
  APP_UPDATE_CHECK: "app-update:check",
  APP_UPDATE_DOWNLOAD: "app-update:download",
  APP_UPDATE_INSTALL: "app-update:install",
  APP_UPDATE_STATE: "app-update:state",

  // chat window
  CHAT_MINIMIZE: "chat:minimize",
  CHAT_CLOSE: "chat:close",
  CHAT_TOGGLE_MAXIMIZE: "chat:toggle-maximize",
  CHAT_IS_MAXIMIZED: "chat:is-maximized",
  CHAT_INGEST_FILES: "chat:ingest-files",
  CHAT_PROCESS_DOCUMENTS: "chat:process-documents",
  CHAT_DOCUMENT_INDEX_PROGRESS: "chat:document-index-progress",
  CHAT_CANCEL_DOCUMENT_INDEX: "chat:cancel-document-index",
  CHAT_CAPTION_IMAGE: "chat:caption-image",
  CHAT_GET_IMAGE_PREVIEW: "chat:get-image-preview",
  CHAT_GET_IMAGE_SEND_STRATEGY: "chat:get-image-send-strategy",
  // 推理下拉（chat 窗口：原子读 + providerKey 写）
  CHAT_GET_REASONING_STATE: "chat:get-reasoning-state",
  CHAT_SET_REASONING: "chat:set-reasoning",

  // AG-UI 事件流
  AGUI_RUN: "agui:run",
  AGUI_EVENT: "agui:event",
  AGUI_CANCEL: "agui:cancel",
  // 渲染端→主进程单向通知：本轮 run 的终态消息已写入会话存储（插件轮次事件的落盘确认）
  AGUI_RUN_PERSISTED: "agui:run-persisted",
  HARNESS_GET_INTERRUPTED_RUN: "harness:get-interrupted-run",
  SCHEDULER_EVENT: "scheduler:event",

  // 注意力 Toast 中心（右下角提醒弹窗；main 为生命周期唯一权威，渲染页纯表现层）
  // main → toast 窗口：推送/更新条目（同 id 覆盖）、移除条目（关闭回执/点击消隐/通知档超时/结算清退）
  TOAST_PUSH: "toast:push",
  TOAST_REMOVE: "toast:remove",
  // toast 窗口 → main：页面加载/重载后恢复当前显示列表；用户点击与关闭只带 toast id，
  // 跳转目标由主进程查权威状态解析；resize 上报内容区实际高度（高度协议）
  TOAST_GET_ALL: "toast:get-all",
  TOAST_CLICKED: "toast:clicked",
  TOAST_DISMISSED: "toast:dismissed",
  TOAST_RESIZE: "toast:resize",

  // Code 模式 Git 工作台（renderer 只能读取结构化状态）
  CODE_GIT_STATUS: "code-git:status",
  CODE_GIT_CHANGED: "code-git:changed",
  CODE_GIT_WATCH: "code-git:watch",
  CODE_GIT_UNWATCH: "code-git:unwatch",
  CODE_GIT_SWITCH_BRANCH: "code-git:switch-branch",
  CODE_GIT_COMMIT: "code-git:commit",
  CODE_GIT_PUSH: "code-git:push",

  // sidebar window (status / schedule / settings entry)
  SIDEBAR_MINIMIZE: "sidebar:minimize",
  SIDEBAR_CLOSE: "sidebar:close",
  SIDEBAR_TOGGLE_ALWAYS_ON_TOP: "sidebar:toggle-always-on-top",
  SIDEBAR_OPEN_SETTINGS: "sidebar:open-settings",
  SIDEBAR_OPEN_TASKS: "sidebar:open-tasks",
  SIDEBAR_OPEN_CALL: "sidebar:open-call",

  // tasks window (read-only display, no per-element interactions)
  TASKS_CLOSE: "tasks:close",
  TASKS_MINIMIZE: "tasks:minimize",

  // Moments（动态 / 朋友圈）
  MOMENTS_LIST: "moments:list",
  MOMENTS_GET_POST: "moments:get-post",
  MOMENTS_CREATE_POST: "moments:create-post",
  MOMENTS_DELETE_POST: "moments:delete-post",
  MOMENTS_CREATE_COMMENT: "moments:create-comment",
  MOMENTS_TOGGLE_LIKE: "moments:toggle-like",
  MOMENTS_CHANGED: "moments:changed",
  // 点名名单：@ 选择框数据源（昔涟 + 全部入驻角色）
  MOMENTS_LIST_CHARACTERS: "moments:list-characters",

  // settings window
  SETTINGS_MINIMIZE: "settings:minimize",
  SETTINGS_CLOSE: "settings:close",
  // main → settings 窗口：要求切到指定标签（已打开时用）
  SETTINGS_SWITCH_SECTION: "settings:switch-section",
  SETTINGS_GET_CONFIG: "settings:get-config",
  SETTINGS_SAVE_CONFIG: "settings:save-config",
  SETTINGS_MODEL_PROFILES_LIST: "settings:model-profiles:list",
  SETTINGS_MODEL_PROFILE_SAVE: "settings:model-profiles:save",
  SETTINGS_MODEL_PROFILE_DELETE: "settings:model-profiles:delete",
  SETTINGS_MODEL_PROFILE_SET_DEFAULT: "settings:model-profiles:set-default",
  SETTINGS_TEST_CONNECTION: "settings:test-connection",
  SETTINGS_TEST_VISION: "settings:test-vision",
  SETTINGS_GET_GENERAL: "settings:get-general",
  SETTINGS_SAVE_GENERAL: "settings:save-general",
  SETTINGS_GET_TIMEOUT_SETTINGS: "settings:get-timeout-settings",
  SETTINGS_SAVE_TIMEOUT_SETTINGS: "settings:save-timeout-settings",
  UI_THEME_GET: "ui-theme:get",
  UI_THEME_CHANGED: "ui-theme:changed",
  UI_THEME_RADIUS_GET: "ui-theme-radius:get",
  UI_THEME_RADIUS_CHANGED: "ui-theme-radius:changed",
  UI_WINDOW_CORNER_RADIUS_GET: "ui-window-corner-radius:get",
  UI_WINDOW_CORNER_RADIUS_CHANGED: "ui-window-corner-radius:changed",
  UI_FONT_GET: "ui-font:get",
  UI_FONT_CHANGED: "ui-font:changed",
  CHAT_TYPOGRAPHY_CHANGED: "chat-typography:changed",
  SETTINGS_PICK_UI_FONT: "settings:pick-ui-font",
  SETTINGS_IMPORT_UI_FONT: "settings:import-ui-font",
  SETTINGS_RESET_UI_FONT: "settings:reset-ui-font",
  SETTINGS_OPEN_SIDEBAR: "settings:open-sidebar",
  SETTINGS_CLOSE_SIDEBAR: "settings:close-sidebar",
  SETTINGS_OPEN_TASKS: "settings:open-tasks",
  SETTINGS_CLOSE_TASKS: "settings:close-tasks",
  SETTINGS_SET_PET_ALWAYS_ON_TOP: "settings:set-pet-always-on-top",
  SETTINGS_SET_PET_VISIBLE: "settings:set-pet-visible",
  SETTINGS_SET_PET_ZOOM: "settings:set-pet-zoom",
  // debugging
  SETTINGS_OPEN_CHROME_GPU: "settings:open-chrome-gpu",
  // main → pet window：推送当前 zoom 因子，渲染进程据此重算 scale
  PET_ZOOM: "pet:zoom",
  SETTINGS_PREVIEW_RUNTIME_SYNC: "settings:preview-runtime-sync",
  SETTINGS_OPEN_STICKER_MANAGER: "settings:open-sticker-manager",
  SETTINGS_OPEN_CUSTOM_STYLE_PROMPT: "settings:open-custom-style-prompt",

  // chat sessions (multi-conversation history, persisted to userData/cyrene-chats/)
  CHATS_LIST: "chats:list",
  CHATS_GET: "chats:get",
  CHATS_GET_PAGE: "chats:get-page",
  CHATS_CREATE: "chats:create",
  CTA_PRESENTATION_CHECKPOINT: "cta:presentation-checkpoint",
  // renderer → main：主动压缩会话上下文（模型窗口内旧消息摘要成一条记忆）
  CHATS_COMPACT: "chats:compact",
  CHATS_RENAME: "chats:rename",
  CHATS_DELETE: "chats:delete",
  // 会话级待发队列（运行中排队、未派发；独立于正式 messages 历史）
  CHATS_PENDING_ENQUEUE: "chats:pending-enqueue",
  CHATS_PENDING_LIST: "chats:pending-list",
  CHATS_PENDING_REMOVE: "chats:pending-remove",
  // 认领队首（单次写入：待发条目 → 正式用户消息 + 派发状态）与派发确认
  CHATS_PENDING_CLAIM: "chats:pending-claim",
  CHATS_PENDING_COMPLETE_DISPATCH: "chats:pending-complete-dispatch",
  // 修改未认领的待发条目文字（按会话 + 条目稳定标识；复用页面解析结果）
  CHATS_PENDING_EDIT: "chats:pending-edit",
  // 调整：把待发条目插入当前运行的下一步（绑定 active run，由 agui-bridge 处理）
  CHATS_PENDING_ADJUST: "chats:pending-adjust",
  CHATS_SET_PINNED: "chats:set-pinned",
  CHATS_SET_MODEL_PROFILE: "chats:set-model-profile",
  CHATS_OPEN_FOLDER: "chats:open-folder",
  CHATS_OPEN_WORKSPACE: "chats:open-workspace",
  CHATS_MIGRATE_LEGACY: "chats:migrate-legacy",
  // 任意会话变动后 main → 所有渲染窗口 broadcast，触发列表/标题刷新
  CHATS_CHANGED: "chats:changed",
  // 状态栏 → main：要求打开/复用 reactChatWindow 并加载指定 sessionId
  CHATS_OPEN_IN_REACT_WINDOW: "chats:open-in-react-window",
  // main → reactChatWindow：要求切到指定 sessionId（窗口已存在时用）
  CHATS_REACT_SWITCH_SESSION: "chats:react-switch-session",
  // reactChatWindow → main：ChatPage 已挂好 IPC 监听，允许 flush pending sessionId
  CHATS_REACT_READY: "chats:react-ready",
  // 聊天窗口 → main：声明当前活跃 sessionId（用于设置面板"删除当前会话"时差异化提示）
  CHATS_SET_ACTIVE_SESSION: "chats:set-active-session",
  // renderer → main: 查询当前活跃 sessionId（设置面板初次打开时用）
  CHATS_GET_ACTIVE_SESSION: "chats:get-active-session",
  // main → 所有窗口：活跃 sessionId 变化时广播
  CHATS_ACTIVE_SESSION_CHANGED: "chats:active-session-changed",

  // 语音输入提交桥（主进程 ↔ 聊天窗口渲染页，仅供宿主内部使用，插件不直接接触）
  // main → reactChatWindow：要求把外部语音识别文本提交到租约冻结的会话
  SPEECH_INPUT_COMMIT_REQUEST: "speech-input:commit-request",
  // reactChatWindow → main：提交结果（必须回显 requestId 与 rendererTargetId）
  SPEECH_INPUT_COMMIT_RESULT: "speech-input:commit-result",

  // 对话工作区绑定
  // renderer → main：设置当前对话的工作区目录
  CHATS_SET_WORKSPACE: "chats:set-workspace",
  // renderer → main：获取当前对话的工作区绑定
  CHATS_GET_WORKSPACE: "chats:get-workspace",
  // renderer → main：清除当前对话的工作区绑定
  CHATS_CLEAR_WORKSPACE: "chats:clear-workspace",
  // renderer → main：打开文件夹选择器
  CHATS_PICK_WORKSPACE_FOLDER: "chats:pick-workspace-folder",
  // renderer → main：为 Learn 模式初始化工作区结构（只创建缺失文件）
  CHATS_INIT_LEARN_WORKSPACE: "chats:init-learn-workspace",
  // main → 所有窗口：工作区绑定变更广播
  CHATS_WORKSPACE_CHANGED: "chats:workspace-changed",

  // Review 快照（不可变文件变更审查）
  // renderer → main：获取指定 Run 的 ReviewSnapshot（不存在时按 halted 补生成）
  REVIEW_GET: "review:get",
  // renderer → main：把指定 Run 修改过的文件恢复到运行前状态（基于 before/ 基线）
  REVIEW_RESTORE: "review:restore",

  // 会话工作区只读文件（右侧面板文件树 / 文件预览）
  // renderer → main：列出工作区内某目录的条目（懒加载用）
  WORKSPACE_FILES_LIST: "workspace-files:list",
  // renderer → main：读取工作区内某文件的内容（预览用，带大小/二进制限制）
  WORKSPACE_FILES_READ: "workspace-files:read",

  // 工作区右上角"打开"菜单（用本机应用打开工作区根目录）
  // renderer → main：探测本机可打开工作区的应用（VSCode / Cursor 等，进程内缓存）
  WORKSPACE_OPEN_IN_LIST_APPS: "workspace-open-in:list-apps",
  // renderer → main：执行打开动作（explorer 走 shell.openPath，其余走 detached spawn）
  WORKSPACE_OPEN_IN: "workspace-open-in:open",

// sticker manager window
	  STICKERS_MINIMIZE: "stickers:minimize",
	  STICKERS_CLOSE: "stickers:close",
	  STICKERS_GET_CONFIG: "stickers:get-config",
	  STICKERS_SET_ENABLED: "stickers:set-enabled",
	  STICKERS_PICK_FILE: "stickers:pick-file",
	  STICKERS_ADD: "stickers:add",
	  STICKERS_DELETE: "stickers:delete",
	  STICKERS_GET_ENABLED: "stickers:get-enabled",

  // public model config updates (no API key)
  MODEL_CONFIG_GET: "model-config:get",
  MODEL_CONFIG_CHANGED: "model-config:changed",

  // runtime state updates (status / feeling / expression)
  RUNTIME_STATE_GET: "runtime-state:get",
  RUNTIME_STATE_CHANGED: "runtime-state:changed",

  // Live2D speech / mouth sync
  LIVE2D_SPEECH_PREPARE: "live2d:speech-prepare",
  LIVE2D_MOUTH_START: "live2d:mouth-start",
  LIVE2D_MOUTH_STOP: "live2d:mouth-stop",
  LIVE2D_PLAY_ACTION: "live2d:play-action",        // 主进程 → 桌宠窗口：执行动作（motion 或 expression）
  LIVE2D_GET_MAIN_DIAGNOSTICS: "live2d:get-main-diagnostics",
  // embedding model status
  EMBEDDING_SET_MODEL: "embedding:set-model",
  RERANKER_SET_MODE: "reranker:set-mode",
  RERANKER_GET_STATUS: "reranker:get-status",
  // unified model install status
  MODEL_GET_INSTALL_STATUS: "model:get-install-status",
  // shell external URL
  OPEN_EXTERNAL: "shell:open-external",
  // user profile
  USER_GET_PROFILE: "user:get-profile",
  USER_SAVE_PROFILE: "user:save-profile",
  USER_UPLOAD_AVATAR: "user:upload-avatar",
  USER_GET_AVATAR: "user:get-avatar",
  USER_PROFILE_CHANGED: "user:profile-changed",
  USER_AVATAR_CHANGED: "user:avatar-changed",

  // memory panel
  MEMORY_PANEL_GET_DATA: "memory-panel:get-data",
  MEMORY_PANEL_DELETE_IMPORTED_DOC: "memory-panel:delete-imported-doc",
  MEMORY_PANEL_SAVE_L0: "memory-panel:save-l0",
  MEMORY_PANEL_SAVE_L1: "memory-panel:save-l1",
  MEMORY_EXPORT_OBSIDIAN_VAULT: "memory:export-obsidian-vault",
  OBSIDIAN_VAULT_BIND: "obsidian-vault:bind",
  OBSIDIAN_VAULT_UNBIND: "obsidian-vault:unbind",
  OBSIDIAN_VAULT_GET_CONFIG: "obsidian-vault:get-config",
  OBSIDIAN_VAULT_SET_AUTO_SYNC: "obsidian-vault:set-auto-sync",
  OBSIDIAN_VAULT_SYNC_NOW: "obsidian-vault:sync-now",

  // MCP server management
  MCP_ADD_SERVER: "mcp:add-server",
  MCP_REMOVE_SERVER: "mcp:remove-server",
  MCP_LIST_SERVERS: "mcp:list-servers",

  // tool (plugin) toggle
  TOOL_SET_ENABLED: "tool:set-enabled",
  TOOL_GET_ENABLED: "tool:get-enabled",
  // tool-mode override (三模适配层：用户自定义工具在 learn/code/work 模式下的可见性)
  TOOL_GET_MODE_OVERRIDES: "tool:get-mode-overrides",
  TOOL_SET_MODE_OVERRIDE: "tool:set-mode-override",
  TOOL_CLEAR_MODE_OVERRIDE: "tool:clear-mode-override",
  // tool catalog (工具页拉取工具元数据：id/name/description/modes)
  TOOL_GET_CATALOG: "tool:get-catalog",

  // skill toggle
  SKILL_LIST: "skill:list",
  SKILL_SET_ENABLED: "skill:set-enabled",
  // skill-mode override（三模适配层：用户自定义 skill 在 work/code/learn 模式下的可见性）
  SKILL_GET_MODE_OVERRIDES: "skill:get-mode-overrides",
  SKILL_SET_MODE_OVERRIDE: "skill:set-mode-override",
  SKILL_CLEAR_MODE_OVERRIDE: "skill:clear-mode-override",
  // skill catalog（skill 页拉取元数据：id/name/description/modes）
  SKILL_GET_CATALOG: "skill:get-catalog",
  // 重新扫描 user skills 目录，安装/删除 skill 后无需重启即可刷新 UI
  SKILL_RESCAN: "skill:rescan",

  // scheduled tasks
  SCHEDULER_LIST: "scheduler:list",
  SCHEDULER_ADD: "scheduler:add",
  SCHEDULER_UPDATE: "scheduler:update",
  SCHEDULER_DELETE: "scheduler:delete",
  SCHEDULER_TOGGLE: "scheduler:toggle",
  SCHEDULER_FIRE_NOW: "scheduler:fire-now",
  SCHEDULER_GET_HISTORY: "scheduler:get-history",
  SCHEDULER_GET_TOOLS: "scheduler:get-tools",
  SCHEDULER_CHANGED: "scheduler:changed",  // main → renderer：任务列表变更通知

  // token usage statistics
  TOKEN_USAGE_GET: "token-usage:get",
  TOKEN_USAGE_CLEAR: "token-usage:clear",

  // TTS 语音合成
  TTS_UPLOAD: "tts:upload",          // 上传音频文件 → file_id
  TTS_CLONE: "tts:clone",           // 音色快速复刻 → voice_id
  TTS_SYNTHESIZE: "tts:synthesize", // 语音合成 → audio buffer(base64)
  TTS_SYNTHESIZE_CACHED: "tts:synthesize-cached", // 语音合成 + 本地音频缓存
  // 流式语音合成（边合成边播，首字延迟低）
  TTS_STREAM_START: "tts:stream-start",           // 渲染端 → main：启动流式合成
  TTS_AUDIO_CHUNK: "tts:audio-chunk",             // main → 渲染端：推一段音频 base64
  TTS_STREAM_END: "tts:stream-end",               // main → 渲染端：流式结束（含 cacheKey）
  TTS_STREAM_ERROR: "tts:stream-error",           // main → 渲染端：流式错误
  TTS_SESSION_START: "tts:session-start",
  TTS_SESSION_CANCEL: "tts:session-cancel",
  TTS_SESSION_EVENT: "tts:session-event",
  TTS_SAVE_SETTINGS: "tts:save-settings",   // 保存 TTS 配置
  TTS_LOAD_SETTINGS: "tts:load-settings",   // 加载 TTS 配置
  TTS_PICK_AUDIO: "tts:pick-audio",         // 选择音频文件（dialog）
  TTS_SYNTHESIZE_GPTSOVITS: "tts:synthesize-gptsovits",             // GPT-SoVITS 合成 → base64
  TTS_SYNTHESIZE_CACHED_GPTSOVITS: "tts:synthesize-cached-gptsovits", // GPT-SoVITS 合成 + 本地缓存
  TTS_SYNTHESIZE_CUSTOM_CLOUD: "tts:synthesize-custom-cloud",             // 自定义云端 TTS 合成 → base64
  TTS_SYNTHESIZE_CACHED_CUSTOM_CLOUD: "tts:synthesize-cached-custom-cloud", // 自定义云端 TTS 合成 + 本地缓存
  TTS_SYNTHESIZE_MIMO: "tts:synthesize-mimo",             // 小米 MiMo TTS 合成 → base64
  TTS_SYNTHESIZE_CACHED_MIMO: "tts:synthesize-cached-mimo", // 小米 MiMo TTS 合成 + 本地缓存
  TTS_SYNTHESIZE_MOSSLAND: "tts:synthesize-mossland",       // Mossland (api.mosi.cn) 合成 → base64
  TTS_SYNTHESIZE_CACHED_MOSSLAND: "tts:synthesize-cached-mossland", // Mossland 合成 + 本地缓存
  TTS_CLONE_MOSSLAND: "tts:clone-mossland",           // Mossland 克隆音色（multipart 上传）
  TTS_LIST_MOSSLAND_VOICES: "tts:list-mossland-voices", // Mossland 拉取账号下音色列表

  // agent permission level (file/shell access)
  PERMISSION_GET_LEVEL: "permission:get-level",
  PERMISSION_SET_LEVEL: "permission:set-level",
  // main → renderer：要求审批
  PERMISSION_APPROVAL_REQUEST: "permission:approval-request",
  // renderer → main：审批结果回传
  PERMISSION_APPROVAL_RESOLVE: "permission:approval-resolve",
  // main → renderer：审批结算广播（用户已答 / run 取消），渲染端据此清卡
  PERMISSION_APPROVAL_SETTLED: "permission:approval-settled",
  // main → renderer：计划模式状态变化广播（任何入口触发都走这条）
  PLAN_STATE_CHANGED: "plan:state-changed",
  // renderer → main：设置计划模式 on/off（显式目标，不是 toggle）
  PLAN_SET_MODE: "plan:set-mode",
  // renderer → main：查询某会话当前计划模式状态
  PLAN_GET_STATE: "plan:get-state",

  // user choice card (ambiguity resolver)
  // 卡片展示走 AGUI_EVENT 的 CUSTOM 事件（与天气卡片同通道）
  // renderer → main：回传用户选择
  CHOICE_RESOLVE: "choice:resolve",

  // pop_quiz 抽查测试（learn 模式）
  // 与审批流同构：不设超时、10s 幂等重播、结算统一广播
  // main → renderer：推送抽查卡片（重复推送同 id 覆盖，用于渲染端恢复）
  POP_QUIZ_REQUEST: "pop-quiz:request",
  // renderer → main：提交作答（返回值带判分结果，渲染端切展示态）
  POP_QUIZ_RESOLVE: "pop-quiz:resolve",
  // renderer → main：跳过整次抽查
  POP_QUIZ_SKIP: "pop-quiz:skip",
  // main → renderer：结算广播（提交/跳过/run 取消），渲染端据此清卡
  POP_QUIZ_SETTLED: "pop-quiz:settled",

  // call window (voice call)
  CALL_OPEN: "call:open",                 // sidebar → main：打开通话窗口
  CALL_START: "call:start",               // renderer → main：开始通话（初始化 ASR）
  CALL_AUDIO_FRAME: "call:audio-frame",    // renderer → main：PCM 音频帧
  CALL_ASR_RESULT: "call:asr-result",     // main → renderer：ASR 识别结果
  CALL_TURN_END: "call:turn-end",         // renderer → main：VAD 静默，结束本轮
  CALL_TTS_AUDIO: "call:tts-audio",       // main → renderer：TTS 音频
  CALL_TTS_DONE: "call:tts-done",         // renderer → main：TTS 播放完毕
  CALL_STATE: "call:state",               // main → renderer：状态变更
  CALL_ERROR: "call:error",               // main → renderer：错误
  CALL_STOP: "call:stop",                 // renderer → main：挂断

  // 多渠道（微信/飞书/QQ/QQ 机器人）
  CHANNELS_GET_CONFIG: "channels:get-config",
  CHANNELS_SAVE_CONFIG: "channels:save-config",
  CHANNELS_LIST: "channels:list",
  CHANNELS_RESTART: "channels:restart",
  CHANNELS_GET_STATUS: "channels:get-status",
  CHANNELS_INSTALL_PROGRESS: "channels:install-progress",     // main → renderer
  CHANNELS_STATUS_CHANGED: "channels:status-changed",         // main → renderer
  // 微信专属
  CHANNELS_WECHAT_INSTALL: "channels:wechat:install",
  CHANNELS_WECHAT_LOGIN_START: "channels:wechat:login-start",
  CHANNELS_WECHAT_LOGIN_CANCEL: "channels:wechat:login-cancel",
  CHANNELS_WECHAT_QRCODE: "channels:wechat:qrcode",        // main → renderer, payload: dataURL string
  CHANNELS_WECHAT_LOGIN_DONE: "channels:wechat:login-done", // main → renderer, payload: { ok, botId?, error? }
  CHANNELS_WECHAT_LOGIN_RESULT: "channels:wechat:login-result",
  CHANNELS_WECHAT_PAIRING_LIST: "channels:wechat:pairing-list",
  CHANNELS_WECHAT_PAIRING_APPROVE: "channels:wechat:pairing-approve",
  CHANNELS_WECHAT_LOGOUT: "channels:wechat:logout",
  CHANNELS_WECHAT_RUNTIME_DETECT: "channels:wechat:runtime-detect",
  CHANNELS_WECHAT_RUNTIME_INSTALL: "channels:wechat:runtime-install",
  CHANNELS_WECHAT_RUNTIME_UPDATE: "channels:wechat:runtime-update",
  // 飞书专属
  CHANNELS_FEISHU_TEST_CONNECTION: "channels:feishu:test-connection",
  CHANNELS_FEISHU_TEST_WEBHOOK_REACHABLE: "channels:feishu:test-webhook-reachable",
  CHANNELS_QQ_TEST_CONNECTION: "channels:qq:test-connection",
  /**
   * QQ 监听鉴权预检：主进程按 listenMode/customHost 解析真实监听地址，并判定是否
   * 必须配置 Access Token。渲染进程看不到网络接口，因此该判定只能由主进程给出。
   */
  CHANNELS_QQ_RESOLVE_AUTH_REQUIREMENT: "channels:qq:resolve-auth-requirement",
  // QQ 官方机器人（QQ 开放平台）专属
  CHANNELS_QQBOT_TEST_CONNECTION: "channels:qqbot:test-connection",
  // 消息日志
  CHANNELS_LOG_GET: "channels:log:get",
  CHANNELS_LOG_CLEAR: "channels:log:clear",
  // 渠道上下文绑定：设置页选择外部聊天继续使用某个桌面会话
  CHANNELS_CONTEXT_BINDINGS_GET: "channels:context-bindings:get",
  CHANNELS_CONTEXT_BIND: "channels:context-bindings:bind",
  CHANNELS_CONTEXT_UNBIND: "channels:context-bindings:unbind",

  // Music
  MUSIC_GET_STATUS: "music:get-status",
  MUSIC_BEGIN_LOGIN: "music:begin-login",
  MUSIC_CANCEL_LOGIN: "music:cancel-login",
  MUSIC_LOGOUT: "music:logout",
  MUSIC_GET_DAILY: "music:get-daily",
  MUSIC_SEARCH: "music:search",
  MUSIC_PLAY_TRACK: "music:play-track",
  MUSIC_PLAY_PLAYLIST: "music:play-playlist",
  MUSIC_DETECT_PLAYER: "music:detect-player",
  MUSIC_GET_OPENAPI_CONFIG: "music:get-openapi-config",
  MUSIC_SAVE_OPENAPI_CONFIG: "music:save-openapi-config",
  MUSIC_STATE_CHANGED: "music:state-changed",
  // mpv playback control (renderer → main)
  MUSIC_PLAYBACK_PLAY: "music:playback:play",
  MUSIC_PLAYBACK_PAUSE: "music:playback:pause",
  MUSIC_PLAYBACK_TOGGLE: "music:playback:toggle",
  MUSIC_PLAYBACK_SEEK: "music:playback:seek",
  MUSIC_PLAYBACK_VOLUME: "music:playback:volume",
  MUSIC_PLAYBACK_STOP: "music:playback:stop",
  MUSIC_PLAYBACK_NEXT: "music:playback:next",
  MUSIC_PLAYBACK_PREV: "music:playback:prev",
  MUSIC_PLAYBACK_STATE: "music:playback:state", // main → renderer push
  MUSIC_GET_PLAYBACK_SESSION: "music:playback-session:get",
  MUSIC_PLAY_SESSION_TRACK: "music:playback-session:play",
  MUSIC_SYNC_PLAYBACK_SESSION: "music:playback-session:sync",
  MUSIC_PLAYBACK_SESSION_CHANGED: "music:playback-session:changed",
  // UI direct connect (renderer → main, not via AI tool layer)
  MUSIC_GET_LYRICS: "music:get-lyrics",
  MUSIC_TOGGLE_FAVORITE: "music:toggle-favorite",
  // 用户歌单（播放器窗口顶部 chips + loadPlaylist）
  MUSIC_GET_MY_PLAYLISTS: "music:get-my-playlists",
  MUSIC_GET_PLAYLIST_DETAIL: "music:get-playlist-detail",
  // 打开/关闭播放器窗口（renderer → main）
  MUSIC_OPEN_PLAYER: "music:open-player",
  MUSIC_OPEN_SETTINGS: "music:open-settings",
  MUSIC_PLAYER_CLOSE: "music:player:close",
  MUSIC_PLAYER_MINIMIZE: "music:player:minimize",
  // 本地缓存歌单（边播边存 + 用户导入）
  MUSIC_GET_CACHED_TRACKS: "music:get-cached-tracks",
  MUSIC_REMOVE_CACHED_TRACK: "music:remove-cached-track",
  MUSIC_IMPORT_LOCAL_TRACKS: "music:import-local-tracks",
  MUSIC_IMPORT_LOCAL_FOLDER: "music:import-local-folder",
  // main → renderer：缓存索引变化（下载完成/删除/导入）广播
  MUSIC_CACHE_UPDATED: "music:cache-updated",

  // screenshot
  SCREENSHOT_START: "screenshot:start",
  SCREENSHOT_SAVE_TEMP: "screenshot:save-temp",
  SCREENSHOT_INSERT: "screenshot:insert",
  SCREENSHOT_HOTKEY_CAPTURE_START: "screenshot:hotkey-capture-start",
  SCREENSHOT_HOTKEY_CAPTURE_END: "screenshot:hotkey-capture-end",

  // plugin system
  PLUGINS_LIST: "plugins:list",
  PLUGINS_SET_ENABLED: "plugins:set-enabled",
  PLUGINS_OPEN: "plugins:open",
  PLUGINS_RESCAN: "plugins:rescan",
  PLUGINS_IMPORT_ZIP: "plugins:import-zip",
  PLUGINS_UNINSTALL: "plugins:uninstall",
  /** 设置面板桥的统一转发通道：仅面板宿主窗口可用，pluginId 由宿主侧绑定 */
  PLUGINS_PANEL_INVOKE: "plugins:panel:invoke",
  PLUGINS_MARKET_LIST: "plugins:market:list",
  PLUGINS_MARKET_INSTALL: "plugins:market:install",

} as const;
