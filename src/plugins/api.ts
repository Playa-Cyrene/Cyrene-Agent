/**
 * Cyrene Plugin API v1.
 *
 * This file is the stable, plugin-facing contract. It deliberately does not
 * import from src/main or src/shared so internal application refactors do not
 * leak into third-party plugin types.
 */

export const CURRENT_PLUGIN_API_VERSION = 1 as const;

/**
 * 插件可向宿主申请的宿主服务。deps 只是服务可用性声明，不是安全权限：
 * 未声明的服务不会注入，声明的服务也只是获得该服务的稳定接口。
 */
export type PluginCapability =
  | "channels"
  | "llm"
  | "secrets"
  | "workspace"
  | "conversations"
  | "scheduler"
  | "speech-input";

/** 全部宿主能力的运行时清单；与 PluginCapability 类型一一对应，SDK 直接再导出。 */
export const PLUGIN_CAPABILITIES: readonly PluginCapability[] = [
  "channels",
  "llm",
  "secrets",
  "workspace",
  "conversations",
  "scheduler",
  "speech-input",
];

/**
 * 插件设置面板的挂载分区。每开放一个枚举值，设置页必须有对应的
 * 挂载容器，所以首版故意只收窄到渠道和插件两个分区。
 */
export type PluginSettingsSection = "channels" | "plugins";

export interface PluginManifest {
  /** Plugin API major version required by this plugin. */
  apiVersion: number;
  /** Unique lowercase id, for example "my-plugin". */
  id: string;
  name: string;
  /** Strict SemVer plugin version. */
  version: string;
  description: string;
  author: string;
  /** Bare file name inside the plugin directory. */
  entry: string;
  /** Optional bare icon file name inside the plugin directory (png/jpg/webp/svg). */
  icon?: string;
  /** 插件目录内的设置面板 HTML 裸文件名；声明后宿主在设置页挂载该面板。 */
  settingsPanel?: string;
  /** 面板挂载的设置分区；缺省挂到「插件」分区。 */
  settingsSection?: PluginSettingsSection;
  /** Honored only for bundled plugins. User plugins always require opt-in. */
  defaultEnabled: boolean;
  /** Host services requested from Cyrene. This is not a security sandbox. */
  deps?: PluginCapability[];
}

/**
 * 插件作者提交的 manifest 原始形状，是 Manifest JSON Schema 的生成目标。
 * 与 PluginManifest 的区别：defaultEnabled 可省略（宿主归一化为 true），
 * 字段格式约束（id 连字符、SemVer、entry 裸文件名等）由加载器的文件
 * 与格式校验补充完成，Schema 只负责结构、类型和枚举。
 */
export interface PluginManifestInput {
  apiVersion: number;
  id: string;
  name: string;
  version: string;
  description: string;
  author: string;
  entry: string;
  icon?: string;
  settingsPanel?: string;
  settingsSection?: PluginSettingsSection;
  defaultEnabled?: boolean;
  deps?: PluginCapability[];
}

export type PluginJsonSchema = {
  type: string;
  description?: string;
  enum?: string[];
  default?: unknown;
  properties?: Record<string, PluginJsonSchema>;
  items?: PluginJsonSchema;
  required?: string[];
};

export interface PluginToolContext {
  userQuery: string;
  conversationId?: string;
  runId?: string;
  signal?: AbortSignal;
  resolvedWorkspaceRoot?: string;
  mode?: "chat" | "learn" | "code" | "work";
  permissionMode?: "normal" | "allow_all";
  metadata?: Record<string, unknown>;
}

export interface PluginTool {
  id: string;
  name: string;
  description: string;
  catalogHint?: string;
  category?: string;
  capability?: string;
  enabled: boolean;
  risk?: "safe" | "fs-read" | "fs-write" | "shell" | "network" | "input-control";
  modes?: Array<"learn" | "code" | "work">;
  inputSchema: {
    type: "object";
    properties: Record<string, PluginJsonSchema>;
    required?: string[];
  };
  needsContext?: boolean;
  ledgerPolicy?: "success_terminal" | "bypass";
  deprecated?: boolean;
  effectKind?: "read" | "mutation" | "verification" | "external_side_effect" | "unknown";
  verificationPolicy?: "none" | "artifact" | "code" | "unknown";
  execute(args: Record<string, unknown>, ctx?: PluginToolContext): Promise<string>;
}

export interface PluginChannelCapability {
  text: boolean;
  image: boolean;
  audio: boolean;
  file: boolean;
  video: boolean;
  markdown: boolean;
  card: boolean;
  sticker: boolean;
  maxTextLength: number;
}

export interface PluginChannelStatus {
  enabled: boolean;
  phase: "running" | "offline" | "starting" | "config_missing" | "error";
  message?: string;
}

export interface PluginIncomingMessage {
  channel: string;
  chatType?: "private" | "group";
  messageId?: string;
  senderId: string;
  senderName?: string;
  chatId: string;
  threadId?: string;
  text: string;
  attachments?: Array<{
    kind: "image" | "audio" | "file" | "video";
    url?: string;
    filePath?: string;
    mime?: string;
    caption?: string;
  }>;
  at: Date;
  _raw?: unknown;
}

export interface PluginOutgoingMessage {
  channel: string;
  chatType?: "private" | "group";
  targetId: string;
  threadId?: string;
  parts: Array<Record<string, unknown> & { kind: string }>;
}

export type PluginMessageHandler = (
  message: PluginIncomingMessage,
) => Promise<PluginOutgoingMessage | null>;

export interface PluginChannelAdapter {
  readonly id: string;
  readonly displayName: string;
  readonly capability: PluginChannelCapability;
  start(): Promise<void>;
  stop(): Promise<void>;
  onMessage: PluginMessageHandler | null;
  send(message: PluginOutgoingMessage): Promise<{ ok: boolean; error?: string }>;
  getStatus(): PluginChannelStatus;
}

export interface PluginLlmMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface PluginLlmGenerateOptions {
  /** 1-8192; defaults to 1024. */
  maxTokens?: number;
  /** 1000-300000 ms; defaults to the current chat timeout capped at 120s. */
  timeoutMs?: number;
  /** Optional cancellation signal owned by the plugin. */
  signal?: AbortSignal;
  /** Short diagnostic label appended to plugin:<id>. */
  purpose?: string;
}

/** 无头目标运行的稳定进度投影；不暴露宿主 Harness 内部事件结构。 */
export type PluginAgentEvent =
  | { kind: "round_started"; round: number }
  | { kind: "tool_started"; toolName: string }
  | { kind: "tool_finished"; toolName: string; ok: boolean };

export interface PluginAgentRunOptions {
  /** 插件在启动前生成；宿主、工具上下文与日志全链共用。 */
  runId: string;
  /** 任务目标，作为首条 user 消息。 */
  goal: string;
  /** 不注册的冻结工具集；直接复用 PluginTool 完整契约。 */
  tools: ReadonlyArray<PluginTool>;
  /** 可选任务诊断标签；宿主以 plugin:<id>:<purpose> 标记该次运行与工具上下文。 */
  purpose?: string;
  /** 插件持有的取消信号。 */
  signal?: AbortSignal;
  /** 稳定进度事件投影；回调不得发起工具调用。 */
  onEvent?: (event: PluginAgentEvent) => void;
  /** 工具轮上限；默认 50。 */
  maxRounds?: number;
  /** 整体硬截止毫秒；默认 15 分钟。 */
  maxWallMs?: number;
}

export interface PluginAgentRunResult {
  text: string;
  terminal: {
    status: PluginTurnStatus;
    reason?: string;
    externalEffectsMayContinue: boolean;
  };
  rounds: number;
}

export interface PluginLlmService {
  generateText(
    messages: PluginLlmMessage[],
    options?: PluginLlmGenerateOptions,
  ): Promise<string>;
  /**
   * 较新宿主提供的无头目标循环。老宿主没有该方法，插件应保留兼容回退。
   */
  runGoal?(options: PluginAgentRunOptions): Promise<PluginAgentRunResult>;
}

export interface PluginStorage {
  get<T>(key: string): T | undefined;
  set<T>(key: string, value: T): void;
  rootDir(): string;
}

export type PluginEventListener<T = unknown> = (payload: T) => void | Promise<void>;

export interface PluginEvents {
  /** 订阅带完整命名空间的 host:* 或 plugin:<id>:* 事件。 */
  on<T = unknown>(event: string, listener: PluginEventListener<T>): () => void;
  /** 发布当前插件自有事件；框架自动补全为 plugin:<id>:<event>。 */
  emit<T = unknown>(event: string, payload: T): Promise<void>;
}

/** host:turn:completed 的公开 payload；首版只暴露稳定元数据，不包含对话原文。 */
export interface PluginTurnCompletedEvent {
  source: "desktop" | "channel";
  mode: PluginPromptMode;
  conversationId: string;
  channel?: string;
  runId?: string;
}

/** 轮次统一终态：成功、用户取消、超时和运行错误互斥，只发布其中一个。 */
export type PluginTurnStatus = "success" | "cancelled" | "timeout" | "runtime_error";

/** 所有宿主事件的公共元数据；eventId 用于诊断关联，不承诺 exactly-once 投递。 */
export interface PluginHostEventBase {
  eventId: string;
  timestamp: string;
}

interface PluginTurnEventBase extends PluginHostEventBase {
  runId: string;
  mode: PluginPromptMode;
}

/**
 * 轮次开始事件。以 source 为判别字段：插件按 event.source 分支后，
 * TypeScript 自动收窄出各来源的必填字段，不需要猜测可选字段是否合法。
 */
export type PluginTurnStartedEvent =
  | (PluginTurnEventBase & {
      source: "desktop";
      conversationId: string;
      inputMessageId: string;
    })
  | (PluginTurnEventBase & {
      source: "channel";
      channel: string;
      conversationId?: string;
    })
  | (PluginTurnEventBase & {
      source: "scheduler";
      taskId: string;
      schedulerRunId: string;
      conversationId?: string;
    });

interface PluginTurnFinishedBase extends PluginTurnEventBase {
  status: PluginTurnStatus;
  durationMs?: number;
}

/**
 * 轮次结束事件。finalMessageId 只有宿主确认本轮 assistant 消息
 * 已作为最终边界持久化后才存在；非成功终态不得用"当前最后一条
 * assistant 消息"补齐该字段。
 */
export type PluginTurnFinishedEvent =
  | (PluginTurnFinishedBase & {
      source: "desktop";
      conversationId: string;
      inputMessageId: string;
      finalMessageId?: string;
    })
  | (PluginTurnFinishedBase & {
      source: "channel";
      channel: string;
      conversationId?: string;
    })
  | (PluginTurnFinishedBase & {
      source: "scheduler";
      taskId: string;
      schedulerRunId: string;
      conversationId?: string;
    });

/**
 * 调度任务完成事件：携带任务 ID 与历史记录 ID，供插件把轮次事件与任务执行关联。
 * 只含稳定元数据，不含任务提示词与模型输出正文。
 */
export interface PluginSchedulerFinishedEvent extends PluginHostEventBase {
  taskId: string;
  schedulerRunId: string;
  conversationId?: string;
  status: PluginTurnStatus;
  durationMs?: number;
}

/** 工具完成事件的归一化状态（与宿主执行层四态 outcome 一致）。 */
export type PluginToolStatus = "success" | "failure" | "unknown" | "not_executed";

/** 工具风险级投影；取值与宿主工具注册表声明的风险级一致。 */
export type PluginToolRisk =
  | "safe"
  | "fs-read"
  | "fs-write"
  | "shell"
  | "network"
  | "input-control";

/**
 * 工具完成事件：结果已确定后的只读观察通知。
 * 不携带工具参数、输出、文件变更正文与内部异常；只反映宿主视角的归一化结果。
 */
export interface PluginToolFinishedEvent extends PluginHostEventBase {
  runId: string;
  toolId: string;
  toolCallId: string;
  status: PluginToolStatus;
  risk: PluginToolRisk;
  durationMs?: number;
}

/** 会话列表的稳定投影；只暴露插件需要的字段，不透出内部索引和存储细节。 */
export interface PluginConversationSummary {
  id: string;
  title: string;
  mode: PluginPromptMode;
  createdAt: string;
  updatedAt: string;
}

/** 会话消息的稳定投影；只含 user/assistant 两种角色和纯文本内容。 */
export interface PluginConversationMessage {
  id: string;
  role: "user" | "assistant";
  text: string;
  at: string;
}

export interface PluginConversationListInput {
  cursor?: string;
  limit?: number;
}

export interface PluginConversationPage {
  items: PluginConversationSummary[];
  nextCursor?: string;
}

export interface PluginMessagePageInput {
  conversationId: string;
  cursor?: string;
  limit?: number;
  /** 可选的包含式起点；与 throughMessageId 一起冻结读取范围。 */
  fromMessageId?: string;
  /** 可选的包含式终点；分页过程中不得越过该消息。 */
  throughMessageId?: string;
}

export interface PluginMessagePage {
  items: PluginConversationMessage[];
  nextCursor?: string;
  /** 本次分页实际冻结的包含式边界；后续页的游标携带同一组边界。 */
  range: {
    fromMessageId?: string;
    throughMessageId?: string;
  };
}

/**
 * 会话只读服务。长期记忆插件的标准用法：把桌面轮次结束事件中的
 * inputMessageId / finalMessageId 直接作为 fromMessageId / throughMessageId
 * 传入 getMessages()，冻结读取范围后翻页不会混入后续轮次的消息。
 */
export interface PluginConversationsService {
  list(input?: PluginConversationListInput): Promise<PluginConversationPage>;
  getMessages(input: PluginMessagePageInput): Promise<PluginMessagePage>;
}

/**
 * 插件私有密钥服务。Key 在插件命名空间内解析，插件无法读写其他
 * 插件的密钥；密钥仅保存在宿主安全存储中，插件卸载后默认保留。
 */
export interface PluginSecretsService {
  get(key: string): Promise<string | undefined>;
  set(key: string, value: string): Promise<void>;
  delete(key: string): Promise<boolean>;
}

/** 会话工作区绑定的稳定投影。 */
export interface PluginWorkspaceBinding {
  conversationId: string;
  root: string;
  displayName: string;
}

/**
 * 受控的工作区访问：只读取会话已绑定的工作区描述，
 * 不提供绑定、解绑或选择目录的写接口。
 */
export interface PluginWorkspaceService {
  getBinding(conversationId: string): Promise<PluginWorkspaceBinding | null>;
}

/** 定时计划：一次性、每日、每周（0=周日）和固定间隔。 */
export type PluginScheduleConfig =
  | { kind: "once"; runAt: string }
  | { kind: "daily"; timeOfDay: string }
  | { kind: "weekly"; dayOfWeek: 0 | 1 | 2 | 3 | 4 | 5 | 6; timeOfDay: string }
  | { kind: "interval"; every: number; unit: "minutes" | "hours" };

/**
 * 完整执行规格：计划、提示词、会话模式和工具白名单共同决定任务行为，
 * 也是用户授权指纹的计算输入。未来新增影响行为的字段必须先加入本规格，
 * 标题等展示元数据不属于执行规格。
 */
export interface PluginScheduledExecutionSpec {
  schedule: PluginScheduleConfig;
  prompt: string;
  mode: PluginPromptMode;
  /** 显式工具白名单；插件任务不允许 all-enabled 模式。 */
  allowedToolIds: string[];
}

export interface PluginScheduledTaskInput extends PluginScheduledExecutionSpec {
  title: string;
}

export interface PluginScheduledTaskPatch {
  title?: string;
  schedule?: PluginScheduleConfig;
  prompt?: string;
  mode?: PluginPromptMode;
  allowedToolIds?: string[];
}

export interface PluginScheduledTask extends PluginScheduledTaskInput {
  id: string;
  /** 宿主计算后的有效启用状态；插件不能写入，创建后必须由用户在宿主界面确认启用。 */
  enabled: boolean;
  nextFireAt: string | null;
  lastFiredAt?: string;
  createdAt: string;
  updatedAt: string;
}

/**
 * 插件调度任务服务。插件只能查看和修改自己创建的任务；接口不提供
 * 启用、立即运行或切换到全部工具模式的能力，任何执行规格变化都会
 * 撤销用户已有的授权并回到停用状态。
 */
export interface PluginSchedulerService {
  createTask(input: PluginScheduledTaskInput): Promise<PluginScheduledTask>;
  listTasks(): Promise<PluginScheduledTask[]>;
  updateTask(id: string, patch: PluginScheduledTaskPatch): Promise<PluginScheduledTask>;
  deleteTask(id: string): Promise<boolean>;
  getHistory(id: string, limit?: number): Promise<PluginScheduledTaskHistory[]>;
}

/** 任务执行历史摘要；只保留诊断信息，不含完整模型输出。 */
export interface PluginScheduledTaskHistory {
  id: string;
  taskId: string;
  status: string;
  startedAt: string;
  finishedAt?: string;
  summary?: string;
}

/** 语音输入目标：普通聊天窗口或活动通话，二选一。 */
export type PluginSpeechInputTarget = "active-chat" | "active-call";

export interface PluginSpeechInputAcquireOptions {
  target: PluginSpeechInputTarget;
}

/**
 * 语音输入租约。取得时目标即被冻结：切换会话不会迁移租约，
 * 原渲染目标失效时租约自动中止（signal 触发）。
 * commit() 复用宿主正常用户输入路径，不等待模型完整回答。
 */
export interface PluginSpeechInputLease {
  /** 提交最终识别文本；用户消息被接受并落盘后即返回。 */
  commit(text: string): Promise<void>;
  /** 幂等释放；释放后不得再 commit。 */
  release(): Promise<void>;
  /** 租约中止信号（目标失效、插件停止、应用退出等）。 */
  signal: AbortSignal;
}

/** 独占语音输入服务：全局同一时刻只允许一个插件持有租约。 */
export interface PluginSpeechInputService {
  acquire(options: PluginSpeechInputAcquireOptions): Promise<PluginSpeechInputLease>;
}

export interface PluginDeps {
  /** Read-only channel discovery. Registration must use PluginContext methods. */
  channels?: { has(id: string): boolean };
  llm?: PluginLlmService;
  conversations?: PluginConversationsService;
  secrets?: PluginSecretsService;
  workspace?: PluginWorkspaceService;
  scheduler?: PluginSchedulerService;
  speechInput?: PluginSpeechInputService;
}

export type PluginCleanup = () => void | Promise<void>;

export type PluginPromptMode = "chat" | "work" | "learn" | "code";

/**
 * 提示词 Provider 的场景来源。新增场景默认不收录既有 Provider，
 * 插件必须显式声明 sources 才会参与，防止升级后不知情地被扩大调用。
 */
export type PluginPromptSource = "conversation" | "scheduler" | "moments-post" | "plugin-agent";

/** 各场景共有的构建输入：本轮用户文本与可选的会话归属。 */
interface PluginPromptBuildInputCommon {
  userText: string;
  conversationId?: string;
  channel?: string;
}

/** 用户会话轮次；mode 为当前会话模式。 */
export interface ConversationPromptBuildInput extends PluginPromptBuildInputCommon {
  source: "conversation";
  mode: PluginPromptMode;
}

/** 定时任务轮次；mode 为任务冻结的执行模式。 */
export interface SchedulerPromptBuildInput extends PluginPromptBuildInputCommon {
  source: "scheduler";
  mode: PluginPromptMode;
}

/** 插件发起的无头目标循环；仅显式声明该来源的 Provider 会参与。 */
export interface PluginAgentPromptBuildInput extends PluginPromptBuildInputCommon {
  source: "plugin-agent";
  mode: PluginPromptMode;
}

/** 动态发帖决策；无会话模式，是否生效仅由 Provider 的 sources 声明决定。 */
export interface MomentsPostPromptBuildInput extends PluginPromptBuildInputCommon {
  source: "moments-post";
  /**
   * 恒为 undefined：moments-post 不存在会话模式。声明为 never 而非省略字段，
   * 是为了兼容既有插件 `provide({ source, mode, userText })` 的参数解构写法——
   * 升级 SDK 后旧代码仍可编译，运行时该值不存在。
   */
  mode?: never;
}

/**
 * 提示词 Provider 的构建输入，以 source 为判别字段：插件按 source 分支后，
 * TypeScript 自动收窄出各场景的必填字段（conversation/scheduler 必带 mode，
 * moments-post 没有会话模式），不需要猜测可选字段是否合法。
 */
export type PluginPromptBuildInput =
  | ConversationPromptBuildInput
  | SchedulerPromptBuildInput
  | PluginAgentPromptBuildInput
  | MomentsPostPromptBuildInput;

/**
 * PluginPromptBuildInput 是联合，接口不能 extends 联合类型；
 * 交集会自动分发到各成员，按 source 收窄的行为与逐成员声明一致。
 */
export type PluginPromptProviderInput = PluginPromptBuildInput & {
  /** 插件停止时触发；Provider 应尽快结束仍在进行的异步工作。 */
  readonly signal: AbortSignal;
};

export interface PluginPromptProvider {
  /** 当前插件内唯一；框架会自动补全 plugin:<插件id>: 前缀。 */
  id: string;
  /** 缺省表示全部会话模式。 */
  modes?: PluginPromptMode[];
  /**
   * 声明后仅在列出的场景生效；缺省 = 仅 conversation + scheduler
   * （与旧版行为一致），参与 moments-post 必须显式声明，防止升级后插件不知情地被扩大调用。
   */
  sources?: PluginPromptSource[];
  provide(input: PluginPromptProviderInput): string | Promise<string>;
}

export interface PluginContext {
  id: string;
  /** 插件停止或激活回滚开始前会先触发取消。 */
  readonly signal: AbortSignal;
  /** 登记插件自有资源的清理回调；回调按逆序且最多执行一次。 */
  onDispose(cleanup: PluginCleanup): void;
  events: PluginEvents;
  registerTool(tool: PluginTool): void;
  unregisterTool(toolId: string): void;
  /** 注册每轮动态提示词贡献；内容进入 runtime context，不改变核心提示词文件。 */
  registerPromptProvider(provider: PluginPromptProvider): void;
  unregisterPromptProvider(providerId: string): void;
  /** Automatically namespaced as plugin:<id>:<channel>. */
  registerIpc(channel: string, handler: (...args: unknown[]) => unknown): void;
  unregisterIpc(channel: string): void;
  registerChannelAdapter(adapter: PluginChannelAdapter): Promise<void>;
  unregisterChannelAdapter(channelId: string): Promise<void>;
  storage: PluginStorage;
  deps: PluginDeps;
  log(...args: unknown[]): void;
}

export interface CyrenePlugin {
  open?(): void | Promise<void>;
  register(ctx: PluginContext): void | Promise<void>;
  unregister?(): void | Promise<void>;
}

/**
 * 宿主服务的稳定错误码。插件只应依赖错误码做分支处理，
 * 不要匹配错误消息文案；内部异常只进宿主日志，不透传给插件。
 */
export type PluginHostErrorCode =
  | "E_CAPABILITY_UNAVAILABLE"
  | "E_INVALID_ARGUMENT"
  | "E_NOT_FOUND"
  | "E_NOT_OWNER"
  | "E_STORAGE_UNAVAILABLE"
  | "E_SPEECH_INPUT_BUSY"
  | "E_NO_ACTIVE_INPUT_TARGET"
  | "E_PLUGIN_STOPPING"
  | "E_INTERNAL";

export interface PluginHostError extends Error {
  code: PluginHostErrorCode;
}

/** 全部稳定错误码的运行时清单；SDK 直接再导出，供测试断言使用。 */
export const PLUGIN_HOST_ERROR_CODES: ReadonlySet<string> = new Set([
  "E_CAPABILITY_UNAVAILABLE",
  "E_INVALID_ARGUMENT",
  "E_NOT_FOUND",
  "E_NOT_OWNER",
  "E_STORAGE_UNAVAILABLE",
  "E_SPEECH_INPUT_BUSY",
  "E_NO_ACTIVE_INPUT_TARGET",
  "E_PLUGIN_STOPPING",
  "E_INTERNAL",
]);

export function isPluginHostError(value: unknown): value is PluginHostError {
  return (
    value instanceof Error
    && PLUGIN_HOST_ERROR_CODES.has((value as PluginHostError).code)
  );
}
