// buildAgentRunOptions —— 把 AG-UI 桥的 buildOptions 闭包抽成纯函数。
//
// 设计原则：
//   - 函数无模块级状态；所有 index.ts 模块级符号（runtimeState, stickerEmbeddingIndex 等）
//     通过 deps 参数注入。
//   - 函数无副作用（不算 console.warn）；副作用（记忆写入/sticker 广播）由 onRunFinished
//     单独做，注入到同一个 deps 里。
//   - index.ts / dispatcher / scheduler 共用同一个 factory。
//   - 默认 style 写死 '01_default.md'，与原行为一致。
//
// 字段依赖梳理（按 index.ts:3175-3281）：
//   loadModelSettings / loadUserProfile / buildEnvironmentContext
//   buildSkillCatalog / skillRegistry / resolveSlashActivation
//   buildToneInjection
//   buildSystemPrompt / CHAT_REQUEST_TIMEOUT_MS
//   normalizeChatMessages / buildAlwaysOnContext / ToolDefinition
//   scheduleMemoryWrite / inferRuntimeState / runtimeState / feelingToExpression
//   matchSticker / stickerEmbeddingIndex / getEmbeddingProvider / loadStickerSettings
//   broadcastRuntimeStateChanged / observeRuntimeState
//   sticker 文本预处理 / stickerEmbeddingIndex / getEmbeddingProvider / loadStickerSettings
//
// 这些全部塞到 BuildOptionsDeps 里。dispatcher / agent-runtime 通过
// buildBuildOptionsDeps()（agent-runtime.ts）注入同一份 deps，保证口径一致。
import { existsSync } from "fs";
import { basename } from "path";
import {
  resolveExecutionMode,
  type CyreneRunOptions,
  type CyreneRunResult,
} from "./cyrene-agent";
import type { ToolDefinition, ToolModeOverrides } from "./tools/registry/tool-registry";
import type { SkillModeOverrides } from "../skills/types";
import type { ChatMessage, OpenAIContentBlock } from "./vendors/types";
import type { AguiRunInput } from "../agui-bridge";
import type { RelationshipChannel, RelationshipTurnInput } from "../relationship/relationship-log";
import type { ChannelId } from "../channels/types";
import { validateCaptionImagePath } from "../chat/image-caption";
import { resolveImageRoute } from "./image-router";
import {
  buildConversationTimeContext,
  resolveChatContextTimezone,
  type ChatContextMessage,
} from "../chat-time-context";
import { perf } from "../perf-trace";
import { debugLog } from "../agent-log";
import { buildResponseContext } from "../cita/context-package";
import {
  STYLE_IDS,
  normalizeStyleId,
  type CustomStyleConfig,
  type StyleId,
} from "../../shared/style-sampling";
import type { ApprovedStyleSampling } from "./vendors/style-sampling";
import type {
  SocialAtom,
  SocialExtractionInput,
} from "../social-context/types";
import type { ConversationMode } from "../../shared/chat-types";
import type { SkillRouteInfo } from "./cyrene-agent";
import { filterToolsBySearchBackend, type SearchBackend } from "./search-backend-filter";
import type { RunCapabilities } from "./run-capabilities";
import { buildStickerEmbeddingQuery } from "../sticker-query";
import { isPlanReadOnly, getPlanState } from "./plan-mode";
import { policyFor, type ToolRiskLevel } from "../permission-policy";
import { resolveTranscriptRetainTokens, type MaterializedTranscript } from "./conversation-transcript-context";
import type { UncertainEffect } from "./harness/types";
import { DEFAULT_HARNESS_CONFIG } from "./harness/types";
import { estimateMessageTokens } from "./context-manager";
import { createTranscriptCompactionRequiredError } from "./conversation-transcript-compactor";

/** index.ts 模块级符号的最小可注入子集。
 *  类型故意用宽签名（unknown / 任意 shape）—— 因为 build-options 是纯消费者，
 *  实际调用时由 index.ts 注入真实的强类型函数。这避免循环类型依赖。 */
export interface BuildOptionsDeps {
  loadModelSettings: (modelProfileId?: string) => ModelSettingsLite;
  loadGeneralSettings: () => StyleSettingsLite;
  loadUserProfile: () => UserProfileLite;
  buildEnvironmentContext: (model: { provider: string; model: string }, profile: unknown) => string;
  /** @deprecated 仅保留旧测试/调用方结构兼容；生产不再使用。 */
  buildSystemPrompt?: (styleFile: string) => string;
  buildSkillCatalog: (skills: ReadonlyArray<unknown>) => string;
  buildAutoInjectedSkillContext: (skills: ReadonlyArray<unknown>) => string;
  buildAutoInjectedSoulContext?: (skills: ReadonlyArray<unknown>) => string;
  skillRegistry: {
    getEnabled(): ReadonlyArray<unknown>;
    /** 按会话模式 + 用户覆盖层过滤的启用 skill 列表（三模适配层入口）。 */
    getEnabledForMode(mode: import("../skills/types").SkillMode, overrides?: SkillModeOverrides): ReadonlyArray<unknown>;
    /** 懒加载某 skill 的 SKILL.md 正文（去 frontmatter）。用于 plan mode 条件注入 cyrene-plan-mode body。 */
    getBody(id: string): string | null;
  };
  resolveSlashActivation: (
    messages: ReadonlyArray<{ role: string; content?: string }>,
    mode?: import("../skills/types").SkillMode,
    overrides?: SkillModeOverrides,
  ) => string;
  buildToneInjection: () => string;
  buildAlwaysOnContext: (
    userText: string,
    messages: ReadonlyArray<{ role: string; content?: string }>,
  ) => Promise<string>;
  buildRelationshipContext: () => Promise<string>;
  /** 明确按模式构建基础人设，不再通过 style 文件名猜模式。 */
  buildModePrompt?: (mode: ConversationMode) => string;
  /** 工具规则与目录 system prompt（进入 harness stablePrefix）。仅含自动生成的工具目录。 */
  buildToolSystemPrompt: (mode: ConversationMode, enabledTools: ReadonlyArray<unknown>) => string;
  /** 人设基础 system prompt；动态内容走 soulRuntimeContext，随请求尾部注入。 */
  buildSoulSystemBasePrompt: (styleFile: string) => string;
  resolveRunCapabilities?: (input: {
    mode: ConversationMode; activeSearchBackend: SearchBackend; toolModeOverrides?: ToolModeOverrides; skillModeOverrides?: SkillModeOverrides;
    chatToolsEnabled?: boolean;
  }) => RunCapabilities;
  /** 已由 main 侧解析好的 style Markdown；build-options 只负责注入边界。 */
  readStylePrompt: (styleId: StyleId) => string;
  /** 按 provider/model/reasoning/customStyle 解析后的 Soul 采样参数。 */
  resolveSoulSampling: (input: {
    styleId: StyleId;
    settings: ModelSettingsLite;
    customStyle: CustomStyleConfig;
  }) => ApprovedStyleSampling;
  /** 第一期：注入 toolRegistry（用于 buildToolSystemPrompt 自动生成目录）。 */
  toolRegistry: {
    getEnabled(): ReadonlyArray<unknown>;
    /** 按会话模式 + 用户覆盖层过滤的启用工具列表（三模适配层入口）。 */
    getEnabledToolsForMode(mode: ConversationMode, overrides?: ToolModeOverrides): ReadonlyArray<unknown>;
  };
  normalizeChatMessages: (raw: ReadonlyArray<unknown>) => ChatMessage[];
  /** 权威轨迹上下文构建：桌面 currentUser dispatch 时物化模型消息。 */
  buildModelContext?: (
    conversationId: string,
    retainTokens: number,
  ) => Promise<MaterializedTranscript>;
  /** 会话级权威压缩；成功后 buildModelContext 必须重新物化 checkpoint + suffix。 */
  compactTranscript?: (input: {
    conversationId: string;
    trigger: "automatic" | "manual";
    retainTokens: number;
  }) => Promise<unknown>;
  chatRequestTimeoutMs: number;
  captionImageForFallback?: (filePath: string) => Promise<{ ok: boolean; caption?: string; error?: string }>;
  prepareCitaTurn?: (input: {
    conversationId: string;
    turnId: string;
    originalQuery: string;
    recentDialogue: Array<{ role: "user" | "assistant"; text: string }>;
  }) => Promise<{
    contextBlock: string;
    contextPackage?: {
      originalQuery: string;
      contextualizedQuery: string;
      resolvedReferences: Array<{ surface: string; targetRef: string }>;
      focusedContexts?: Array<{ contextRef: string }>;
      supportingContexts?: Array<{ contextRef: string }>;
    };
  }>;
  buildChatSocialContext?: (input: {
    conversationId: string;
    query: string;
  }) => Promise<{
    contextBlock: string;
    retrievedAtoms: SocialAtom[];
  }>;
  /** 构建朋友圈 Chat 背景块（只读本地 moments 数据，同步）；返回空串表示无内容。 */
  buildMomentsContext?: (query: string) => string;
  /**
   * 获取对话的工作区绑定（来自 Conversation Workspace Binding）。
   * 返回 undefined 表示当前对话未绑定工作区。
   */
  getWorkspaceBinding?: (conversationId: string) => { workspaceRoot: string; displayName: string; boundAt: number } | undefined;
  /** 构建已启用插件贡献的每轮动态提示词；失败时调用方应降级为空内容。 */
  buildPluginPromptContext?: (input: {
    source: "conversation" | "plugin-agent";
    mode: ConversationMode;
    userText: string;
    conversationId?: string;
    channel?: string;
  }) => Promise<string>;
}

/** 所有入口都从 canonical journal 构建上下文；不再接受旁路历史消息。 */
export type BuildOptionsInput = AguiRunInput;

/** onRunFinished 副作用所需的 deps（与 BuildOptionsDeps 部分重叠） */
export interface OnRunFinishedDeps {
  loadModelSettings: () => ModelSettingsLite;
  scheduleMemoryWrite: (userText: string, reply: string, conversationId?: string) => void;
  scheduleSocialAtomExtraction?: (input: SocialExtractionInput) => void;
  inferRuntimeState: (userText: string, reply: string, flag: boolean) => { status: string };
  runtimeState: {
    status: string;
    expression: number;
    updatedAt: number;
    feeling?: string;
  };
  feelingToExpression: Record<string, number>;
  setRuntimeState: (next: { status?: string; expression?: number; updatedAt?: number; feeling?: string }) => void;
  stickerEmbeddingIndex: unknown;
  getStickerEmbeddingIndex?: () => unknown;
  getEmbeddingProvider: () => unknown;
  matchSticker: (
    text: string,
    provider: unknown,
    index: unknown,
    threshold: number,
  ) => Promise<{ id: string } | null | undefined>;
  loadStickerSettings: () => Record<string, boolean>;
  broadcastRuntimeStateChanged: () => void;
  observeRuntimeState: (
    settings: ModelSettingsLite,
    history: ReadonlyArray<unknown>,
    userText: string,
    reply: string,
  ) => Promise<void>;
  recordRelationshipTurn: (input: RelationshipTurnInput) => Promise<unknown> | unknown;
  /** run 成功收尾时调度昔涟朋友圈主动发帖评估（缺省不启用）。 */
  scheduleMomentsTurn?: (input: import("../moments/moments-service").MomentsTurnInput) => void;
}

export interface ModelSettingsLite {
  provider: string;
  baseUrl: string;
  model: string;
  apiKey: string;
  explicitTransport?: "openai" | "anthropic" | "responses" | "auto";
  /** 顶层 reasoning 镜像（来自 perProvider[currentProvider].reasoning）。adapter 直接读。 */
  reasoning?: import("../../shared/reasoning").ReasoningPreference;
  runtimeSync?: string;
  stickerEnabled?: boolean;
  stickerSimilarityThreshold?: number;
  /** 默认为 true；用户显式关闭时，图片先交给独立视觉模型转成文字。 */
  multimodal?: boolean;
  /** 独立视觉模型配置（可选）。image-router 路由判定用。 */
  vision?: { baseUrl: string; apiKey: string; model: string };
  /** 上下文窗口大小（Token）。来自 ModelSettings.contextWindowTokens。 */
  contextWindowTokens?: number;
}

export interface StyleSettingsLite {
  /** Harness 安全工具并发设置；旧测试/旧配置可省略。 */
  maxParallelToolCalls?: unknown;
  currentStyleId?: unknown;
  customStyle?: unknown;
  chatSocialContextEnabled?: unknown;
  /** 朋友圈总开关与 Chat 背景注入开关（moments-awareness 门控用）。 */
  momentsEnabled?: unknown;
  chatMomentsContextEnabled?: unknown;
  /** 工具-模式覆盖层（三模适配层）。未提供时按 modes 字段或全可见过滤。 */
  toolModeOverrides?: ToolModeOverrides;
  /** Chat 模式工具增强总开关。未提供时视为关闭（chat 无工具，现状行为）。 */
  chatToolsEnabled?: boolean;
  /** Skill-模式覆盖层（三模适配层）。未提供时按 modes 字段或全可见过滤。 */
  skillModeOverrides?: SkillModeOverrides;
}

export interface UserProfileLite {
  nickname?: string;
  callPreference?: string;
  birthday?: string;
  defaultCity?: string;
  timezone?: string;
  gender?: string;
}

export function buildChannelSystem(channel?: RelationshipChannel): string {
  if (channel === "wechat") {
    return [
      "【渠道回复方式】",
      "你正在通过微信回复用户。",
      "回复要像微信聊天消息：短、自然、有来有回。",
      "不要写长段说明，不要提桌面端、工具调用或系统。",
      "任务复杂时先简短确认，再安静执行。",
    ].join("\n");
  }
  if (channel === "feishu") {
    return [
      "【渠道回复方式】",
      "你正在通过飞书回复用户。",
      "语气仍是昔涟，但要适合工作上下文：清楚、省时间、结论靠前。",
      "必要时可以简短列步骤，不要过度撒娇，不要发太长情绪化回复。",
    ].join("\n");
  }
  if (channel === "qq") {
    return [
      "【渠道回复方式】",
      "你正在通过 QQ 回复用户。",
      "回复要自然、简洁，适合即时聊天；群聊中要结合发送者和引用上下文，避免混淆对象。",
      "不要提及系统提示、渠道实现或内部工具流程。",
    ].join("\n");
  }
  return "";
}

function contentToText(content: ChatMessage["content"]): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .filter((block): block is { type: "text"; text: string } => block?.type === "text")
      .map((block) => block.text)
      .join("\n");
  }
  return "";
}

function stripTurnModelContextForSideEffects(text: string): string {
  const markers = [
    "\n\n【本轮文件】",
    "\n\n【文档内容】",
    "\n\n【图片视觉信息】",
    "\n\n【图片附件】",
    "【本轮文件】",
    "【文档内容】",
    "【图片视觉信息】",
    "【图片附件】",
  ];
  const cut = markers
    .map((marker) => text.indexOf(marker))
    .filter((index) => index >= 0)
    .sort((a, b) => a - b)[0];
  return (cut === undefined ? text : text.slice(0, cut)).trim();
}

function withDirectImageAttachments(messages: ChatMessage[], input: AguiRunInput): ChatMessage[] {
  const images = input.imageAttachments?.filter((image) =>
    typeof image?.filePath === "string" && typeof image?.name === "string",
  ) ?? [];
  if (images.length === 0) return messages;

  const latestUserIndex = messages.map((message) => message.role).lastIndexOf("user");
  if (latestUserIndex < 0) return messages;

  const current = messages[latestUserIndex];
  const blocks: OpenAIContentBlock[] = [];
  const text = contentToText(current.content);
  blocks.push({ type: "text", text });

  for (const image of images) {
    const validated = validateCaptionImagePath(image.filePath);
    if (!validated.ok) {
      console.warn(`[image-send] 直发挂块失败 ${image.name}: 读取失败 ${validated.error}`);
      blocks.push({
        type: "text",
        text: `图片 ${image.name} 无法读取：${validated.error}。请诚实说明暂时无法看清这张图，不要编造图片内容。`,
      });
      continue;
    }
    console.log(`[image-send] 直发挂块 ${image.name}: ok ${validated.mime} ${validated.buffer.length}B`);
    blocks.push({
      type: "image_url",
      image_url: { url: `data:${validated.mime};base64,${validated.buffer.toString("base64")}` },
    });
  }

  const next = messages.slice();
  next[latestUserIndex] = { ...current, content: blocks };
  return next;
}

async function withCaptionedImageAttachments(
  messages: ChatMessage[],
  input: AguiRunInput,
  deps: BuildOptionsDeps,
): Promise<ChatMessage[]> {
  const images = input.imageAttachments?.filter((image) =>
    typeof image?.filePath === "string" && typeof image?.name === "string",
  ) ?? [];
  if (images.length === 0) return messages;
  // [image-send] 链路日志②：降级路径上没有独立视觉配置时，图片会被完全丢弃
  // （只剩文件名文本）——这是一个静默失败点，必须显式告知。
  if (!deps.captionImageForFallback) {
    console.warn(
      `[image-send] 图片降级但未配置独立视觉模型（captionImageForFallback 缺失），${images.length} 张图将不会带给主模型`,
    );
    return messages;
  }

  const captionedMessages = messages.map((message) => ({ ...message }));
  const latestUserIndex = captionedMessages.map((message) => message.role).lastIndexOf("user");
  if (latestUserIndex < 0) return captionedMessages;

  const current = captionedMessages[latestUserIndex];
  const text = contentToText(current.content);
  const imageLines: string[] = [];
  for (const image of images) {
    const result = await deps.captionImageForFallback(image.filePath);
    if (result.ok && result.caption) {
      console.log(`[image-send] caption 降级 ${image.name}: ok`);
      imageLines.push(`- ${image.name}：${result.caption}`);
    } else {
      console.warn(`[image-send] caption 降级 ${image.name}: 失败 ${result.error ?? "未知错误"}`);
      imageLines.push(`- ${image.name}：图片分析失败：${result.error || "图片分析失败"}。请诚实说明暂时无法看清这张图。`);
    }
  }

  const imageContext = "【图片视觉信息】\n以下内容是视觉模型对用户本轮图片的观察结果，请将其视为你已经看到的图片内容；如果某张图分析失败，请不要编造。\n" + imageLines.join("\n");
  captionedMessages[latestUserIndex] = {
    ...current,
    content: text ? `${text}\n\n${imageContext}` : imageContext,
  };
  return captionedMessages;
}

function buildImageCaptionFallbackMessages(
  systemContent: string,
  messages: ChatMessage[],
  input: AguiRunInput,
  deps: BuildOptionsDeps,
): (() => Promise<ChatMessage[]>) | undefined {
  if (!input.imageAttachments?.length || !deps.captionImageForFallback) return undefined;
  return async () => [
    { role: "system", content: systemContent },
    ...await withCaptionedImageAttachments(messages, input, deps),
  ];
}

/**
 * 路由拒绝时的诚实提示：当前配置既不能直发也没有可用的转述链路，
 * 把原因写进最后一条 user 消息，让模型如实告知用户怎么修，而不是静默丢图。
 */
function withImageRejectNotice(
  messages: ChatMessage[],
  input: AguiRunInput,
  reason: string,
): ChatMessage[] {
  const images = input.imageAttachments?.filter((image) =>
    typeof image?.filePath === "string" && typeof image?.name === "string",
  ) ?? [];
  if (images.length === 0) return messages;

  const latestUserIndex = messages.map((message) => message.role).lastIndexOf("user");
  if (latestUserIndex < 0) return messages;

  const current = messages[latestUserIndex];
  const text = contentToText(current.content);
  const names = images.map((image) => image.name).join("、");
  const notice = `【图片发送失败】用户发送的图片（${names}）无法处理：${reason}请如实告知用户当前无法查看图片及修复方法，不要编造图片内容。`;
  const next = messages.slice();
  next[latestUserIndex] = {
    ...current,
    content: text ? `${text}\n\n${notice}` : notice,
  };
  return next;
}

function isStyleId(value: unknown): value is StyleId {
  return typeof value === "string" && (STYLE_IDS as readonly string[]).includes(value);
}

function styleIdFromLegacyFile(value: unknown): StyleId | undefined {
  if (typeof value !== "string") return undefined;
  const legacy: Record<string, StyleId> = {
    "01_default.md": "default",
    "02_lively.md": "lively",
    "03_healing.md": "healing",
    "04_focused.md": "focused",
    "05_sweet.md": "sweet",
  };
  return legacy[value];
}

function resolveRunStyleId(input: AguiRunInput, saved: StyleSettingsLite): StyleId {
  if (isStyleId(input.styleId)) return input.styleId;
  const legacyStyleId = styleIdFromLegacyFile(input.style);
  if (legacyStyleId) return legacyStyleId;
  if (isStyleId(saved.currentStyleId)) return saved.currentStyleId;
  return normalizeStyleId(undefined);
}

/**
 * 读取工作区静态元数据（项目名 + 是否 git 仓库）。
 * 刻意只提供这两项稳定事实，不注入 branch 等动态状态——branch 会随
 * git switch 变化，进了 stable prefix 会打穿提示词缓存；需要时模型自己跑
 * git status 即可。.git 存在性检查同时兼容普通仓库（目录）和 worktree/submodule（文件）。
 */
function readWorkspaceMeta(root: string): { projectName: string; isGitRepo: boolean } {
  try {
    return {
      projectName: basename(root),
      isGitRepo: existsSync(root + "/.git"),
    };
  } catch {
    return { projectName: "", isGitRepo: false };
  }
}

function buildStylePromptBlock(markdown: string): string {
  const trimmed = markdown.trim();
  if (!trimmed) return "";
  return [
    "[表达风格]",
    "以下内容仅用于控制措辞、句式、语气和信息密度。",
    "不得修改角色身份、事实记忆、工具规则、安全约束及硬性行为规则。",
    "",
    trimmed,
  ].join("\n");
}

/** 轨迹侧崩溃孤儿说明：进入 recoveryContext 提示模型先查证，不得自动重放。 */
export function formatTranscriptUncertainEffects(effects: UncertainEffect[]): string {
  const lines = effects.map((effect) =>
    `- [${effect.toolName}]（调用 ${effect.toolCallId}，指纹 ${effect.fingerprint}）：${effect.message}`);
  return [
    "【上次运行的未确认外部副作用】",
    ...lines,
    "以上副作用结果未知，不得自动重放；先向用户查证实际结果后再决定下一步。",
  ].join("\n");
}

/** fail-closed：桌面轨迹上下文开启但装配缺失时直接报错，不得静默回退渲染端消息。 */
function requireBuildModelContext(
  deps: BuildOptionsDeps,
): NonNullable<BuildOptionsDeps["buildModelContext"]> {
  const reader = deps.buildModelContext;
  if (!reader) throw new Error("buildModelContext is not wired for transcript context");
  return reader;
}

/**
 * 构造 CyreneAgent.runWithEvents 所需的 options + 提取 latestUserText。
 * 与 index.ts 原 AG-UI bridge 的 buildOptions 行为完全一致。
 */
export async function buildAgentRunOptions(
  input: BuildOptionsInput,
  deps: BuildOptionsDeps,
): Promise<{ options: CyreneRunOptions; latestUserText: string }> {
  const settings = deps.loadModelSettings(input.modelProfileId);
  const styleSettings = deps.loadGeneralSettings();
  if (!settings.baseUrl) {
    throw new Error("还没有填写 API URL，请先在设置里保存 API 配置。");
  }
  // 权威轨迹上下文：桌面 bridge 在 canonical append 后传入 modelContext；
  // 若由其它主进程入口调用，则从同一 journal reader 构建，不读取 renderer 历史。
  const contextWindowTokens = settings.contextWindowTokens ?? 256_000;
  const retainTokens = resolveTranscriptRetainTokens(contextWindowTokens);
  let transcriptContext = input.modelContext
    ?? (input.currentUser && input.sessionId
      ? await requireBuildModelContext(deps)(input.sessionId, retainTokens)
      : undefined);
  // 预算检查对传入与自建上下文一视同仁：长会话无论从桌面还是渠道入口进入，
  // 都必须先提交自动压缩检查点，再重读 journal 作为最终上下文。
  if (input.currentUser && input.sessionId && transcriptContext) {
    const usableInputBudget = contextWindowTokens
      - DEFAULT_HARNESS_CONFIG.reservedOutputTokens
      - DEFAULT_HARNESS_CONFIG.safetyMarginTokens;
    const estimatedMessages = estimateMessageTokens(transcriptContext.messages);
    if (estimatedMessages >= usableInputBudget * DEFAULT_HARNESS_CONFIG.compactionThreshold) {
      if (!deps.compactTranscript) throw new Error("TRANSCRIPT_COMPACTION_REQUIRED");
      try {
        await deps.compactTranscript({
          conversationId: input.sessionId,
          trigger: "automatic",
          retainTokens: Math.max(1, Math.floor(contextWindowTokens * DEFAULT_HARNESS_CONFIG.compactionRetainRatio)),
        });
      } catch (error) {
        console.error("[BuildOptions] transcript compaction failed", error);
        throw createTranscriptCompactionRequiredError(error);
      }
      transcriptContext = await requireBuildModelContext(deps)(input.sessionId, retainTokens);
      if (estimateMessageTokens(transcriptContext.messages) >= usableInputBudget * DEFAULT_HARNESS_CONFIG.compactionThreshold) {
        throw createTranscriptCompactionRequiredError();
      }
    }
  }
  const messages = transcriptContext?.messages
    ?? (input.currentUser
      ? [{ role: "user" as const, content: input.currentUser.text } as ChatMessage]
      : []);
  if (messages.length === 0) {
    throw new Error("没有可发送的聊天内容。");
  }
  // slim view for downstream helpers that only need { role, content }
  const slimMessages = messages as unknown as Array<{ role: string; content?: string }>;
  const latestUserText = contentToText(messages.filter((m) => m.role === "user").at(-1)?.content) ?? "";
  const executionMode = resolveExecutionMode(
    input.executionMode ?? ((input.style || "").startsWith("talk") ? "chat" : "work"),
  );
  const isChatMode = executionMode === "chat";
  const conversationId = input.sessionId || "default";

  // 读取可信工作区绑定（来自 Conversation Workspace Binding）。
  // 某些主进程入口（例如外部渠道共享上下文）只应复用文字历史，
  // 必须显式传 null，避免把桌面对话的工作区权限带入渠道运行。
  const workspaceBindingSessionId = input.workspaceBindingSessionId === null
    ? undefined
    : (input.workspaceBindingSessionId ?? conversationId);
  const workspaceBinding = workspaceBindingSessionId
    ? deps.getWorkspaceBinding?.(workspaceBindingSessionId)
    : undefined;
  const resolvedWorkspaceRoot = workspaceBinding?.workspaceRoot;
  const workspaceMeta = resolvedWorkspaceRoot ? readWorkspaceMeta(resolvedWorkspaceRoot) : undefined;
  if (resolvedWorkspaceRoot) {
    console.log("[BuildOptions] workspace binding loaded:",
      "conversationId=" + conversationId.slice(0, 8) + "...",
      "workspaceRoot=" + resolvedWorkspaceRoot,
    );
  }

  const socialContextEnabled = isChatMode
    && styleSettings.chatSocialContextEnabled === true
    && Boolean(deps.buildChatSocialContext);
  // 朋友圈 Chat 背景：总开关与子开关都开启才注入（momentsEnabled && chatMomentsContextEnabled）
  const momentsContextEnabled = isChatMode
    && styleSettings.chatMomentsContextEnabled === true
    && styleSettings.momentsEnabled === true
    && Boolean(deps.buildMomentsContext);
  const profile = deps.loadUserProfile();
  const { cleanMessages: cleanLlm, timestampedMessages: llmMessages, timeContext: conversationTimeContext } = buildConversationTimeContext(
    messages as unknown as ChatContextMessage[],
    resolveChatContextTimezone(profile.timezone),
  );
  const slimLlmMessages = llmMessages as Array<{ role: string; content?: string }>;

  let alwaysOnContext = "";
  try {
    alwaysOnContext = await perf.track("build_always_on_context", () => deps.buildAlwaysOnContext(latestUserText, slimMessages));
  } catch (err) {
    console.warn("[Cyrene] always-on context build failed:", err);
  }

  let relationshipContext = "";
  try {
    relationshipContext = await perf.track("build_relationship_context", () => deps.buildRelationshipContext());
  } catch (err) {
    console.warn("[Cyrene] relationship context build failed:", err);
  }

  let environmentContext = "";
  const envTimer = perf.begin("build_environment_context");
  try {
    environmentContext = deps.buildEnvironmentContext(
      { provider: settings.provider, model: settings.model },
      {
        nickname: profile.nickname,
        callPreference: profile.callPreference,
        birthday: profile.birthday,
        defaultCity: profile.defaultCity,
        timezone: profile.timezone,
        gender: profile.gender,
      },
    );
  } catch (err) {
    console.warn("[Cyrene] environment context build failed:", err);
  }
  envTimer.end();

  const channelSystem = buildChannelSystem(input.channel);

  let momentsContextBlock = "";
  if (momentsContextEnabled) {
    try {
      momentsContextBlock = deps.buildMomentsContext!(latestUserText);
    } catch (err) {
      console.warn("[Cyrene] moments context build failed:", err);
    }
  }

  let chatSocialContextBlock = "";
  let retrievedSocialAtoms: SocialAtom[] = [];
  if (socialContextEnabled) {
    try {
      const built = await perf.track("build_chat_social_context", () => (
        deps.buildChatSocialContext!({
          conversationId,
          query: latestUserText,
        })
      ));
      chatSocialContextBlock = built.contextBlock;
      retrievedSocialAtoms = built.retrievedAtoms.slice(0, 5);
    } catch (err) {
      console.warn("[Cyrene] chat social context build failed:", err);
    }
  }

  let citaContextBlock = "";
  let contextualizedQuery = latestUserText;
  let responseContext = "";
  let trustedRefs: string[] = [];
  if (!isChatMode && deps.prepareCitaTurn) {
    try {
      const recentDialogue = messages
        .filter((message): message is ChatMessage & { role: "user" | "assistant" } => (
          message.role === "user" || message.role === "assistant"
        ))
        .slice(-12)
        .map((message) => ({ role: message.role, text: contentToText(message.content) }));
      const prepared = await perf.track("cita_prepare_turn", () => deps.prepareCitaTurn!({
        conversationId,
        turnId: `${conversationId}:${messages.length}`,
        originalQuery: latestUserText,
        recentDialogue,
      }));
      citaContextBlock = prepared.contextBlock;
      contextualizedQuery = prepared.contextPackage?.contextualizedQuery ?? latestUserText;
      if (prepared.contextPackage) {
        trustedRefs = [...new Set([
          ...prepared.contextPackage.resolvedReferences.map((reference) => reference.targetRef),
          ...(prepared.contextPackage.focusedContexts ?? []).map((context) => context.contextRef),
          ...(prepared.contextPackage.supportingContexts ?? []).map((context) => context.contextRef),
        ])];
        responseContext = buildResponseContext(
          prepared.contextPackage.contextualizedQuery,
          prepared.contextPackage.resolvedReferences,
        );
      }
      debugLog(
        `[CITA/Trace] injection conversation=${conversationId} tool=${citaContextBlock.length > 0} soul=${citaContextBlock.length > 0} blockChars=${citaContextBlock.length}`,
      );
    } catch {
      console.warn(`[CITA] injection conversation=${conversationId} tool=false soul=false reason=prepare_failed`);
    }
  }

  // 语气注入（通用语气规则；场景匹配已移除）
  let toneInjection = "";
  try {
    toneInjection = deps.buildToneInjection();
  } catch (err) {
    console.warn("[Cyrene] tone injection failed:", err);
  }

  let attachmentContext = "";
  const atts = input.attachments;
  if (atts && atts.length > 0) {
    const parts = atts.map((a) => `--- ${a.name} ---\n${a.text}`);
    attachmentContext = `\n\n【本轮附件内容】\n${parts.join("\n\n")}`;
  }

  // 优先使用 AguiBridge 注入的真实会话模式，fallback 到执行模式（兼容旧调用方）。
  const resolvedMode: ConversationMode = input.mode ?? (isChatMode ? "chat" : "work");
  const basePromptMode = resolvedMode;

  let pluginPromptContext = "";
  try {
    pluginPromptContext = await deps.buildPluginPromptContext?.({
      source: input.promptSource ?? "conversation",
      mode: resolvedMode,
      userText: latestUserText,
      conversationId,
      channel: input.promptChannel ?? input.channel,
    }) ?? "";
  } catch (error) {
    console.warn("[plugins] 构建插件提示词上下文失败，已跳过", error);
  }

  const styleId = resolveRunStyleId(input, styleSettings);
  const isTaskMode = resolvedMode === "work" || resolvedMode === "code";
  // work/code 完全不受 style 影响：不注入风格 prompt，采样走厂商默认。
  // chat/learn + default 也走厂商默认采样（不自己设 0.65）；
  // 只有显式选了非 default 的具体 style 才用预设采样。
  const stylePromptBlock = isTaskMode
    ? ""
    : buildStylePromptBlock(deps.readStylePrompt(styleId));
  const soulSampling = (!isTaskMode && styleId !== "default")
    ? deps.resolveSoulSampling({
      styleId,
      settings,
      customStyle: styleSettings.customStyle as CustomStyleConfig,
    })
    : undefined;
  const modeEnabledTools = deps.toolRegistry.getEnabledToolsForMode(resolvedMode, styleSettings.toolModeOverrides);
  // 计划模式只读强制（第一层，权限层）：PLAN_DISCUSSING/PLAN_REVIEW 期间
  // 工具列表在 run 组装时就收敛到 read-only 策略允许的风险级。
  // code 与 chat（开启工具走 harness）参与计划状态机；work 会话恒为 NORMAL 不触发过滤。
  const conversationIdForPlan = conversationId;
  const planReadOnly = (resolvedMode === "code" || resolvedMode === "chat")
    && isPlanReadOnly(conversationIdForPlan);
  const enabledTools = planReadOnly
    ? (modeEnabledTools as readonly ToolDefinition[]).filter(
      (t) => policyFor("read-only", (t as ToolDefinition & { risk?: ToolRiskLevel }).risk ?? "safe") === "allow",
    )
    : modeEnabledTools;

  // 三模适配层：skill 按 resolvedMode 过滤，chat 模式不暴露 skill。
  // ⚠️ 注意：下面这组 enabledSkills/skillCatalog/autoInjected*/availableSkills 计算
  // 在 resolveRunCapabilities 存在时会被整体覆盖重算（见下方"权威路径"注释）。
  // 这里的第一次计算只为 fallbackCapabilities 服务（调用方未提供
  // resolveRunCapabilities 时的兼容路径），两条路径过滤条件不同——
  // 禁止当成重复代码"去重合并"，除非先把 fallback 路径显式化并补测试。
  let enabledSkills = resolvedMode === "chat"
    ? []
    : deps.skillRegistry.getEnabledForMode(resolvedMode, styleSettings.skillModeOverrides);
  let skillCatalog = deps.buildSkillCatalog(enabledSkills);
  let autoInjectedSkillContext = deps.buildAutoInjectedSkillContext(enabledSkills);
  let autoInjectedSoulContext = deps.buildAutoInjectedSoulContext?.(enabledSkills) ?? "";

  // Plan Mode 条件注入：cyrene-plan-mode skill 的 SKILL.md 正文只在
  // PLAN_DISCUSSING / PLAN_REVIEW 时注入。不拼进 stablePrefix（autoInjectedSkillContext
  // 会进 toolSystemContent → stablePrefix，进/出 plan mode 会打断缓存），改为单独字段
  // planSkillContext 传给 harness，在 runtimeParts（可变部分）拼，保证缓存前缀稳定。
  const planStateForInject = resolvedMode === "code" || resolvedMode === "chat"
    ? getPlanState(conversationIdForPlan)
    : "NORMAL";
  let planSkillContext: string | undefined;
  if (planStateForInject === "PLAN_DISCUSSING" || planStateForInject === "PLAN_REVIEW") {
    const planSkillBody = deps.skillRegistry.getBody("cyrene-plan-mode");
    if (planSkillBody) {
      planSkillContext = `## Plan Mode 指令（自动激活，无需 invoke_skill）\n\n${planSkillBody}`;
    }
  }

  // 可用 Skill 列表（供 Skill 路由判断 direct/plan 与 Skill 加载用）
  let availableSkills: SkillRouteInfo[] = (enabledSkills as Array<Record<string, unknown>>).map((s) => ({
    id: String(s.id ?? ""),
    description: String(s.description ?? ""),
    ...((s.manifest as Record<string, unknown>)?.defaultExecutionMode
      ? { defaultExecutionMode: (s.manifest as Record<string, unknown>).defaultExecutionMode as "direct" | "plan" }
      : {}),
  })).filter((s) => s.id);

  // 三模适配层：slash 命令激活也按 resolvedMode 过滤。
  const slashMode = resolvedMode === "chat" ? undefined : resolvedMode;
  const skillActivation = deps.resolveSlashActivation(
    slimMessages,
    slashMode,
    styleSettings.skillModeOverrides,
  );

  // 搜索后端互斥过滤：每轮只暴露当前后端对应的搜索工具
  const generalSettings = deps.loadGeneralSettings();
  const activeSearchBackend = ((generalSettings as Record<string, unknown>).searchEngine as string ?? "off") as SearchBackend;
  // Chat 模式工具增强（fallbackCapabilities 路径，与 resolveRunCapabilities 同口径）：
  // 总开关开启时仅放行 Chat tab 显式勾选（override.chat===true）的工具，
  // 严格 opt-in——不走"未声明 modes 即全可见"的默认规则，防止 fs/git 等
  // 未声明 modes 的工具意外漏进闲聊会话。
  const chatOptInTools = (isChatMode && styleSettings.chatToolsEnabled === true)
    ? (modeEnabledTools as readonly ToolDefinition[]).filter(
      (t) => styleSettings.toolModeOverrides?.[t.id]?.chat === true,
    )
    : [];
  const filteredBySearch = isChatMode
    ? filterToolsBySearchBackend(chatOptInTools as unknown as Array<{ id: string }>, activeSearchBackend)
    : filterToolsBySearchBackend(
      enabledTools as unknown as Array<{ id: string }>,
      activeSearchBackend,
    );

  const fallbackCapabilities: RunCapabilities = {
    mode: resolvedMode,
    tools: filteredBySearch as unknown as ToolDefinition[],
    toolIds: new Set(filteredBySearch.map((tool) => tool.id)),
    skills: enabledSkills as never[],
    skillIds: new Set((enabledSkills as Array<{ id?: unknown }>).map((skill) => String(skill.id ?? "")).filter(Boolean)),
  };
  const capabilities = deps.resolveRunCapabilities?.({
    mode: resolvedMode,
    activeSearchBackend,
    toolModeOverrides: styleSettings.toolModeOverrides,
    skillModeOverrides: styleSettings.skillModeOverrides,
    chatToolsEnabled: styleSettings.chatToolsEnabled === true,
  }) ?? fallbackCapabilities;
  // ⚠️ resolveRunCapabilities 存在时的权威路径：覆盖上面 fallback 组的计算。
  enabledSkills = capabilities.skills;
  skillCatalog = deps.buildSkillCatalog(enabledSkills);
  autoInjectedSkillContext = deps.buildAutoInjectedSkillContext(enabledSkills);
  autoInjectedSoulContext = deps.buildAutoInjectedSoulContext?.(enabledSkills) ?? "";
  availableSkills = (enabledSkills as Array<Record<string, unknown>>).map((s) => ({
    id: String(s.id ?? ""),
    description: String(s.description ?? ""),
    ...((s.manifest as Record<string, unknown>)?.defaultExecutionMode
      ? { defaultExecutionMode: (s.manifest as Record<string, unknown>).defaultExecutionMode as "direct" | "plan" }
      : {}),
  })).filter((s) => s.id);
  const runTools = capabilities.tools;
  const searchToolIds = filteredBySearch
    .filter((t) => t.id === "web_search" || t.id.startsWith("minimax-web-search-"))
    .map((t) => t.id);
  console.log(`[Cyrene] 搜索后端=${activeSearchBackend} 暴露搜索工具=[${searchToolIds.join(", ") || "无"}]`);
  const baseSoulSystemPrompt = deps.buildModePrompt?.(resolvedMode)
    ?? deps.buildSoulSystemBasePrompt(basePromptMode);
  // Chat 工具增强开启且有勾选工具时，chat 也注入工具目录 prompt
  //（buildToolSystemPrompt 忽略 mode，只按工具列表生成目录，chat 复用安全）。
  const baseToolSystemPrompt = resolvedMode === "chat"
    ? (runTools.length > 0 ? deps.buildToolSystemPrompt(resolvedMode, runTools) : "")
    : deps.buildToolSystemPrompt(resolvedMode, runTools);

  // ⚠️ 缓存契约：本函数产出的 system prompt 分层（stablePrefix vs 尾部 runtime）
  // 的内容与拼接顺序直接影响厂商提示词缓存，且多数漂移现有测试不会变红。
  // 改动任何拼接逻辑前，先用固定输入对 options 做逐字段黄金对照（含闭包行为）。
  //
  // toolSystemContent 进入 harness stablePrefix（与人设层一起拼装）：
  // 工具规则 + 运行时工具目录 + 可用 Skill 路由清单。
  // skillLayerContent 是其中 Skill 目录段的独立副本（文本一致），供上下文容量
  // 快照把"技能"从"工具"里拆出来单独计量；不影响 toolSystemContent 本身。
  const skillLayerContent = [skillCatalog, autoInjectedSkillContext]
    .filter((part): part is string => Boolean(part))
    .join("\n\n---\n\n");
  const toolSystemContent = baseToolSystemPrompt
    + (conversationTimeContext.includes("## Internal Context Policy") ? "\n\n" + conversationTimeContext.split("\n\n[对话时间信息]")[0] : "")
    + (skillCatalog ? "\n\n---\n\n" + skillCatalog : "")
    + (autoInjectedSkillContext ? "\n\n---\n\n" + autoInjectedSkillContext : "")
    + (resolvedWorkspaceRoot
      ? `\n\n[当前项目工作区]\n可信根目录：${resolvedWorkspaceRoot}`
        + (workspaceMeta?.projectName ? `\n项目名称：${workspaceMeta.projectName}` : "")
        + `\ngit 仓库：${workspaceMeta?.isGitRepo ? "是" : "否"}`
        + `\n所有本地文件的读取、创建与生成都必须以此目录为根；不得写入桌面、下载目录或其他目录。`
      : "");


  // Soul 的稳定前缀只保留固定人设/渠道。每轮变化的事实在请求尾部注入，
  // 使厂商提示词缓存可以复用同一个前缀。
  // 工具结果以 role:tool 消息写回单循环 transcript。
  const soulSystemWithoutCita =
    (channelSystem ? channelSystem + "\n\n" : "") +
    baseSoulSystemPrompt;
  const soulSystemBaseContent = soulSystemWithoutCita;
  const soulRuntimeContext = [
    environmentContext,
    conversationTimeContext,
    chatSocialContextBlock,
    momentsContextBlock,
    stylePromptBlock,
    autoInjectedSoulContext,
    skillActivation,
    toneInjection,
    alwaysOnContext,
    relationshipContext,
    attachmentContext,
    pluginPromptContext,
  ].filter((context): context is string => Boolean(context?.trim())).join("\n\n---\n\n");

  // 图片路由统一收口在 image-router：direct 直发 / caption 转述 / reject 拒绝。
  // 能力对错交给服务端仲裁（直发 400 时 chat-loop 会用 imageCaptionFallback
  // 自动降级重试）。不维护「哪个协议支持发图」的静态表——该信息必然滞后于
  // 服务端实际状态（MiniMax /anthropic 支持发图晚于文档标注）。
  const imageRoute = resolveImageRoute("attachment", settings);
  const directVisionOk = imageRoute.mode === "direct";
  // [image-send] 链路日志①：直发判定。图片"传不过去"先看这条——
  // direct=false 时图片走 caption 降级/文本占位，根本不会以 image 块发给主模型。
  if (input.imageAttachments?.length) {
    console.log("[image-send] 直发判定:", {
      provider: settings.provider,
      model: settings.model,
      multimodal开关: settings.multimodal !== false,
      图片数: input.imageAttachments.length,
      结果: directVisionOk ? "直发 image 块" : imageRoute.mode === "caption" ? "降级（caption/文本占位）" : "拒绝（无可用视觉链路）",
    });
  }
  const fcMessages: ChatMessage[] = directVisionOk
    ? withDirectImageAttachments(llmMessages as unknown as ChatMessage[], input)
    : imageRoute.mode === "caption"
      ? await withCaptionedImageAttachments(llmMessages as unknown as ChatMessage[], input, deps)
      : withImageRejectNotice(llmMessages as unknown as ChatMessage[], input, imageRoute.reason);
  const cleanFcMessages: ChatMessage[] = directVisionOk
    ? withDirectImageAttachments(cleanLlm as unknown as ChatMessage[], input)
    : imageRoute.mode === "caption"
      ? await withCaptionedImageAttachments(cleanLlm as unknown as ChatMessage[], input, deps)
      : withImageRejectNotice(cleanLlm as unknown as ChatMessage[], input, imageRoute.reason);
  const imageCaptionFallback = directVisionOk
    ? buildImageCaptionFallbackMessages(
    isChatMode
      ? [soulSystemWithoutCita, soulRuntimeContext].filter(Boolean).join("\n\n---\n\n")
      : [toolSystemContent, soulSystemWithoutCita, soulRuntimeContext].filter(Boolean).join("\n\n---\n\n"),
    llmMessages as unknown as ChatMessage[],
    input,
    deps,
    )
    : undefined;

  // 轨迹侧崩溃孤儿：并入 recoveryContext，与派发侧（渠道恢复上下文）在 bridge 合并
  const transcriptRecoveryContext = transcriptContext?.uncertainEffects.length
    ? formatTranscriptUncertainEffects(transcriptContext.uncertainEffects)
    : undefined;

  return {
    options: {
      settings: {
        provider: settings.provider,
        baseUrl: settings.baseUrl,
        model: settings.model,
        apiKey: settings.apiKey,
        explicitTransport: settings.explicitTransport,
        reasoning: settings.reasoning,
        contextWindowTokens: settings.contextWindowTokens ?? 256000,
      },
      maxParallelToolCalls: typeof generalSettings.maxParallelToolCalls === "number"
        ? Math.max(1, Math.min(8, Math.trunc(generalSettings.maxParallelToolCalls)))
        : 4,
      messages: fcMessages,
      cleanMessages: cleanFcMessages,
      conversationId,
      executionMode,
      originalQuery: latestUserText,
      contextualizedQuery,
      citaContextBlock,
      trustedRefs,
      responseContext,
      runtimeEnvironmentContext: environmentContext,
      // 不设整轮任务期限；用户取消才停止整个 Agent Run。
      timeoutMs: 0,
      toolSystemContent,
      skillLayerContent,
      soulSystemBaseContent,
      soulRuntimeContext,
      ...(planSkillContext ? { planSkillContext } : {}),
      soulSampling,
      ...(socialContextEnabled && input.userTurnId && input.assistantTurnId ? {
        socialContext: {
          enabled: true as const,
          conversationId,
          userTurnId: input.userTurnId,
          assistantTurnId: input.assistantTurnId,
          retrievedAtoms: retrievedSocialAtoms,
          now: Date.now(),
        },
      } : {}),
      ...(transcriptRecoveryContext ? { recoveryContext: transcriptRecoveryContext } : {}),
      ...(imageCaptionFallback ? { imageCaptionFallback } : {}),
      tools: [...runTools],
      capabilities,
      ...(availableSkills.length > 0 ? { availableSkills } : {}),
      resolvedWorkspaceRoot,
    },
    latestUserText,
  };
}

/**
 * agent 跑完后的副作用：记忆 + 表情/sticker 推断 + 广播。
 * 与 index.ts 原 AG-UI bridge 的 onRunFinished 行为完全一致。
 *
 * 注意：feeling 字段由 inferRuntimeState 内部副作用更新；本函数只同步 status/expression/updatedAt。
 *
 * 渠道（wechat/feishu/...）的 sticker 走 OutgoingMessage.parts（统一消息模型）；
 * 桌面聊天窗由 AG-UI bridge 把本函数返回的 sticker 决定发回本次 run 的发起窗口；
 * 渠道则由 dispatcher 收下后纳入 OutgoingMessage.parts。
 */
export async function onAgentRunFinished(
  result: CyreneRunResult,
  latestUserText: string,
  deps: OnRunFinishedDeps,
  channel?: ChannelId,
  conversationId?: string,
  finishedContext?: { runId?: string; source?: "desktop" | "channel"; mode?: string },
): Promise<{ sticker: string | null }> {
  const chatContent = result.reply;
  const sideEffectUserText = stripTurnModelContextForSideEffects(latestUserText);
  const socialContext = result.executionMode === "chat" && result.socialContext?.enabled === true
    ? result.socialContext
    : undefined;
  const usesSocialExtractor = Boolean(socialContext);
  if (socialContext) {
    deps.scheduleSocialAtomExtraction?.({
      conversationId: socialContext.conversationId,
      userTurn: {
        id: socialContext.userTurnId,
        role: "user",
        text: sideEffectUserText,
      },
      assistantTurn: {
        id: socialContext.assistantTurnId,
        role: "assistant",
        text: chatContent,
      },
      retrievedAtoms: socialContext.retrievedAtoms,
      now: socialContext.now,
    });
  } else {
    deps.scheduleMemoryWrite(sideEffectUserText, chatContent, conversationId);
  }

  // 朋友圈主动发帖评估：输入是事件产生时冻结的快照（runId/source/mode 由 agent-runtime 透传）
  deps.scheduleMomentsTurn?.({
    conversationId: conversationId ?? "default",
    runId: finishedContext?.runId,
    source: finishedContext?.source ?? "desktop",
    mode: finishedContext?.mode ?? "chat",
    channel,
    userText: sideEffectUserText,
    assistantReply: chatContent,
    finishedAt: Date.now(),
  });

  const settings = deps.loadModelSettings();
  const inferredStatus = deps.inferRuntimeState(sideEffectUserText, chatContent, false);
  deps.setRuntimeState({
    status: inferredStatus.status,
    expression: deps.feelingToExpression[deps.runtimeState.feeling ?? ""] ?? 0,
    updatedAt: Date.now(),
  });

  await perf.track("record_relationship_turn", async () => {
    await deps.recordRelationshipTurn({
      userText: sideEffectUserText,
      assistantText: chatContent,
      cyreneFeeling: deps.runtimeState.feeling ?? "平静",
      channel: channel ?? "desktop",
    });
  });

  const stickerIndex = deps.getStickerEmbeddingIndex?.() ?? deps.stickerEmbeddingIndex;
  const stickerQuery = buildStickerEmbeddingQuery(chatContent, sideEffectUserText);
  let stickerCandidate: string | null = null;
  // 只有代码/公式时 stickerQuery 为空：不请求 embedding，避免技术内容误触发表情。
  if (settings.stickerEnabled && stickerIndex && stickerQuery) {
    const matched = await perf.track("match_sticker", () =>
      deps.matchSticker(
        stickerQuery,
        deps.getEmbeddingProvider(),
        stickerIndex,
        settings.stickerSimilarityThreshold ?? 0.55,
      ),
    );
    stickerCandidate = matched?.id ?? null;
  }
  const stickerSettings = deps.loadStickerSettings();
  const sticker = stickerCandidate && stickerSettings[stickerCandidate] !== false ? stickerCandidate : null;

  if (settings.runtimeSync === "local") {
    deps.broadcastRuntimeStateChanged();
  } else if (settings.runtimeSync === "llm") {
    deps.broadcastRuntimeStateChanged();
    // 心情观察器在 channels bot (wechat/feishu) 上跳过：节省一次 LLM 调用、加快首条回复
    // 桌面聊天（channel === undefined）照常跑，保持 Live2D 表情/心情跟随对话变化
    if (!usesSocialExtractor && channel === undefined) {
      void deps.observeRuntimeState(settings, [], sideEffectUserText, chatContent);
    }
  }

  // 返回 sticker 决定：
  // - 桌面聊天窗由 AG-UI bridge 发到本次 run 的源窗口，避免只投递旧 chatWindow
  // - 渠道（wechat/feishu/...）的 sticker 由 dispatcher 收下，纳入 OutgoingMessage.parts
  // - 桌面路径也返回 sticker 以保持签名一致；dispatcher 路径下 channel !== undefined 才会消费它
  return { sticker };
}
