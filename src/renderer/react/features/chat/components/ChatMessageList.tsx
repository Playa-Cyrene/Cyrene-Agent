import { Bubble, Think, ThoughtChain, type BubbleItemType } from "@ant-design/x";
import { Component, createContext, createElement, useCallback, useContext, useEffect, useMemo, useRef, useState, type ErrorInfo, type KeyboardEvent, type ReactNode } from "react";
import { t, useTranslation } from "../../../i18n";
import { normalizeModelMarkdown } from "./markdown-normalize";
import { resolveAsset } from "../../../../../shared/renderer-base";
import type { AgentRoundRecord, ChatMessage, ChatMessageChannelSource, ConversationMode, ProcessMessageRecord, ReasoningBlock, RunActivityRecord, TaskDelegationDisplayRecord, ToolExecutionRecord, ToolFileChange } from "../../../../../shared/chat-types";
import type { ContextUsageSnapshot } from "../../../../../shared/context-usage";
import thinkingMoodUrl from "../../../assets/status-moods/思考中.png?url";
import completedThinkingMoodUrl from "../../../assets/status-moods/提醒.png?url";
import workingMoodUrl from "../../../assets/status-moods/工作中.png?url";
import interruptedMoodUrl from "../../../assets/status-moods/已中断.png?url";
import processedMoodUrl from "../../../assets/status-moods/已处理.png?url";
import connectingMoodUrl from "../../../assets/status-moods/连接中.png?url";
import { useUserAvatar } from "../../../hooks/useUserAvatar";
import {
  assistantRenderStages,
  resolveReasoningExpanded,
  updateReasoningExpanded,
} from "./message-visibility";
import { formatElapsed, resolveRunActivityExpanded, resolveRunActivitySnapshot, shouldAutoCollapseRunActivity } from "./run-activity";
import { RunStageIndicator } from "./RunStageIndicator";
import { TaskPlanCard } from "./TaskPlanCard";
import type { AgentRunStage, TaskPlanPresentation } from "./run-presentation";
import { CopyButton } from "./CopyButton";
import { TtsButton } from "./TtsButton";
import { stopTtsPlayback } from "./tts-playback";
import { LastTurnActionButton } from "./LastTurnActionButton";
import { resolveRevisableLastTurn } from "./last-turn-actions";
import { extractMessageStickerId, stripMessageStickerMarkers } from "./message-sticker";
import type { WeatherData } from "./weather/weather-types";
import { WeatherCard } from "./weather/WeatherCard";
import { buildAskUserQa, buildFlatRunTimeline, countRoundChangedFiles, describeToolExecution, resolveAgentRoundTitle } from "./agent-rounds";
import { TaskDelegationRow } from "./TaskDelegationRow";
import { extractFileChanges, FileChangeCard } from "./FileChangeCard";
import { ReviewPanel } from "./ReviewPanel";
import { reportChatPerfRender } from "./chat-perf-probe";
import { StreamdownMessageContent } from "./StreamdownMessageContent";

export interface ChatMessageItem {
  id: string;
  role: "user" | "assistant" | "system";
  content: string;
  /** 当前模型轮尚未结算的可见正文；只存在于渲染态，不写入会话消息。 */
  transientText?: string;
  reasoning?: string;
  reasoningBlocks?: ReasoningBlock[];
  processMessages?: ProcessMessageRecord[];
  agentRounds?: AgentRoundRecord[];
  taskDelegations?: TaskDelegationDisplayRecord[];
  reasoningStreaming?: boolean;
  responseStarted?: boolean;
  streaming?: boolean;
  loading?: boolean;
  /** 请求已发出但尚未收到 Think、工具或正文等首个可视事件。 */
  waitingForFirstEvent?: boolean;
  ttsCacheKey?: string;
  ttsCacheVersion?: string;
  sticker?: string | null;
  toolExecutions?: ToolExecutionRecord[];
  runActivity?: RunActivityRecord;
  runSnapshot?: ChatMessage["runSnapshot"];
  runStage?: AgentRunStage;
  /** 关联的 Run ID，用于获取 Review 快照 */
  runId?: string;
  taskPlan?: TaskPlanPresentation;
  attachments?: ChatMessageAttachment[];
  weather?: WeatherData;
  /** 上下文容量快照：运行中为每轮 preRequest 实时值，run 结束后为终态快照。 */
  contextUsage?: ContextUsageSnapshot;
  /** 渠道群聊的发送者/引用等隐藏模型上下文；不直接渲染。 */
  modelContext?: string;
  channelSource?: ChatMessageChannelSource;
}

export interface ChatMessageAttachment {
  name: string;
  kind: string;
  filePath?: string;
  mime?: string;
  previewUrl?: string;
  caption?: string;
  status?: string;
  reason?: string;
  imageSendMode?: "direct" | "caption";
}

interface ChatMessageListProps {
  messages: ChatMessageItem[];
  conversationId?: string;
  mode: ConversationMode;
  preferredAddress: string;
  stickerSize?: "small" | "standard" | "large";
  onTtsCacheKey?: (messageId: string, cacheKey: string, converterVersion: string) => void;
  revisionBusy?: boolean;
  onEditLastUserMessage?: (messageId: string, content: string) => Promise<boolean>;
  onRegenerateLastResponse?: (userMessageId: string, assistantMessageId: string) => Promise<boolean>;
  onScrollToBottomVisibilityChange?: (visible: boolean) => void;
  onRegisterScrollToBottom?: (scroll: () => void) => void;
  /** 点击 Review 文件项时打开右侧检查面板（filePath 用于标签标识与去重） */
  onOpenReviewInspector?: (runId: string, fileIndex: number, filePath: string) => void;
  /** 工作区根路径：正文里的 file:/// 链接据此判断界内/越界 */
  workspaceRoot?: string;
  /** 点击界内文件链接 → 打开右侧预览标签并定位行号 */
  onOpenFileLink?: (relPath: string, line?: number) => void;
}

const cyreneAvatarUrl = resolveAsset("avatars/cyrene-avatar.png");

// 消息是否正在流式输出。code 渲染器收不到 MarkdownContent 的 props，用 context 传下去，
// mermaid 块靠它在流式期间显示占位而不是渲染半截语法。
export const MessageStreamingContext = createContext(false);

/** 文件链接环境：工作区根 + 点击回调，由 ChatMessageList 提供，anchor 渲染器消费。 */
export interface FileLinkEnv {
  workspaceRoot?: string;
  openFile?: (relPath: string, line?: number) => void;
}
export const FileLinkContext = createContext<FileLinkEnv>({});

/**
 * 最后一轮可修订消息的 ID。footer 动作组件经 context 读取，不进 roles 闭包——
 * 流式阶段边界（推理结束/正文开始/运行结束）lastTurn 在 null 与非 null 间切换时
 * 若被 footer 闭包，全部 role 的 contentRender 换引用、memoedContent 失效，历史消息全量重渲染。
 * value 只含原始字符串 ID，值相等时 useMemo 返回同一对象，历史条目的动作组件零重渲染。
 */
export interface LastTurnIds {
  userMessageId: string | null;
  assistantMessageId: string | null;
}
export const LastTurnIdsContext = createContext<LastTurnIds>({ userMessageId: null, assistantMessageId: null });

/** 最后一轮的编辑按钮：目标消息与 context 匹配才渲染 */
export function LastTurnEditAction({ messageId, content, disabled, onBeginEdit }: {
  messageId?: string;
  content: string;
  disabled: boolean;
  onBeginEdit: (messageId: string, content: string) => void;
}) {
  const lastTurnIds = useContext(LastTurnIdsContext);
  if (!messageId || messageId !== lastTurnIds.userMessageId) return null;
  return <LastTurnActionButton kind="edit" disabled={disabled} onClick={() => onBeginEdit(messageId, content)} />;
}

/** 助手消息 footer：重生成目标经 context 匹配（点击时读最新值），TTS/复制与本轮无关 */
export function AssistantMessageFooter({ content, messageId, streaming, conversationId, mode, preferredAddress, revisionBusy, onTtsCacheKey, onRegenerateLastResponse }: {
  content: string;
  messageId?: string;
  streaming: boolean;
  conversationId?: string;
  mode: ConversationMode;
  preferredAddress: string;
  revisionBusy: boolean;
  onTtsCacheKey?: (messageId: string, cacheKey: string, converterVersion: string) => void;
  onRegenerateLastResponse?: (userMessageId: string, assistantMessageId: string) => Promise<boolean>;
}) {
  const lastTurnIds = useContext(LastTurnIdsContext);
  const cleanText = content.trim();
  const canRegenerate = Boolean(messageId && messageId === lastTurnIds.assistantMessageId);
  if (streaming || (!cleanText && !canRegenerate)) return null;
  return (
    <div className="cy-message-actions">
      {cleanText && messageId && conversationId && (
        <TtsButton
          conversationId={conversationId}
          messageId={messageId}
          text={cleanText}
          speechMode={mode === "learn" ? "learn" : "default"}
          preferredAddress={preferredAddress}
          onCacheKey={(cacheKey, converterVersion) => onTtsCacheKey?.(messageId, cacheKey, converterVersion)}
        />
      )}
      {cleanText && <CopyButton text={cleanText} />}
      {canRegenerate && (
        <LastTurnActionButton
          kind="regenerate"
          disabled={revisionBusy}
          onClick={() => {
            if (!lastTurnIds.userMessageId || !lastTurnIds.assistantMessageId) return;
            void onRegenerateLastResponse?.(lastTurnIds.userMessageId, lastTurnIds.assistantMessageId);
          }}
        />
      )}
    </div>
  );
}

class MarkdownRenderBoundary extends Component<{
  content: string;
  children: ReactNode;
}, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error("[ReactChat] Markdown/KaTeX 渲染失败，已降级为原始文本", error, info);
  }

  render(): ReactNode {
    if (this.state.failed) {
      return <pre className="cy-message-markdown-fallback">{this.props.content}</pre>;
    }
    return this.props.children;
  }
}

export function MarkdownContent({
  content,
  streaming,
}: {
  content: string;
  streaming?: boolean;
}) {
  // 性能探针：perf harness 注册后统计正文渲染次数（阶段 2 验收：流式期间历史消息应为 0）
  reportChatPerfRender("markdownRenders");
  // 模型偶尔输出畸形 Markdown（# 后缺空格、标题粘正文、围栏粘句子），渲染前先做机械归一化。
  const normalized = useMemo(() => normalizeModelMarkdown(content), [content]);
  return (
    <MarkdownRenderBoundary content={normalized}>
      <MessageStreamingContext.Provider value={Boolean(streaming)}>
        <StreamdownMessageContent content={normalized} streaming={Boolean(streaming)} />
      </MessageStreamingContext.Provider>
    </MarkdownRenderBoundary>
  );
}

interface EnabledSticker {
  id: string;
  src: string;
}

export type { EnabledSticker };

function resolveStickerUrl(id: string, stickers: readonly EnabledSticker[]): string | undefined {
  const raw = stickers.find((sticker) => sticker.id === id)?.src;
  if (!raw) return undefined;
  return raw.startsWith("/stickers/") ? resolveAsset(raw) : raw;
}

function AssistantContent({
  content,
  streaming,
  stickerUrl,
  channelSource,
}: {
  content: string;
  streaming: boolean;
  stickerUrl?: string;
  channelSource?: ChatMessageChannelSource;
}) {
  return (
    <div className="cy-message__assistant-body">
      {channelSource && <ChannelSourceLabel source={channelSource} direction="outgoing" />}
      {content && <MarkdownContent content={content} streaming={streaming} />}
      {stickerUrl && <img className="cy-message__sticker" src={stickerUrl} alt={t("messageList.assistantStickerAlt")} draggable={false} />}
    </div>
  );
}

const channelNameKeys: Record<ChatMessageChannelSource["channel"], string> = {
  wechat: "messageList.channelSource.wechat",
  feishu: "messageList.channelSource.feishu",
  qq: "messageList.channelSource.qq",
  qqbot: "messageList.channelSource.qqbot",
};

function ChannelSourceLabel({
  source,
  direction,
}: {
  source: ChatMessageChannelSource;
  direction: "incoming" | "outgoing";
}) {
  const label = formatChannelSourceLabel(source, direction);
  return label ? <span className="cy-message__channel-source">{label}</span> : null;
}

export function formatChannelSourceLabel(
  source: ChatMessageChannelSource,
  direction: "incoming" | "outgoing",
): string {
  if (direction === "outgoing" || source.chatType !== "group") return "";
  return source.senderName?.trim() ?? "";
}

function channelName(channel: ChatMessageChannelSource["channel"]): string {
  const key = channelNameKeys[channel];
  return key ? t(key) : t("messageList.channelSource.unknown");
}

/** 把逐条来源提示收拢为会话级提示，避免每个气泡都像日志。 */
export function resolveChannelConversationLabel(
  messages: readonly Pick<ChatMessageItem, "channelSource">[],
): string | null {
  const channels = Array.from(new Set(
    messages
      .map((message) => message.channelSource?.channel)
      .filter((channel): channel is ChatMessageChannelSource["channel"] => Boolean(channel)),
  ));
  if (channels.length === 0) return null;
  return t("messageList.channelSource.sameConversation", {
    channels: channels.map(channelName).join("、"),
  });
}

function DotSpinner() {
  const { t } = useTranslation();
  return (
    <span className="cy-dot-spinner" aria-label={t("messageList.loadingAria")} role="status">
      {Array.from({ length: 8 }, (_, index) => <span className="cy-dot-spinner__dot" key={index} />)}
    </span>
  );
}

function ModelWaitContent() {
  const { t } = useTranslation();
  return (
    <section className="cy-model-wait" aria-label={t("messageList.modelWaitAria")}>
      <span className="cy-model-wait__art" aria-hidden="true">
        <img src={connectingMoodUrl} alt="" draggable={false} />
        <DotSpinner />
      </span>
      <span>{t("messageList.modelWaitText")}</span>
    </section>
  );
}

function ReasoningContent({
  content,
  loading,
  expanded,
  onExpand,
}: {
  content: string;
  loading: boolean;
  expanded: boolean;
  onExpand: (expanded: boolean) => void;
}) {
  const { t } = useTranslation();
  return (
    <Think
      rootClassName="cy-message-reasoning"
      title={loading ? t("messageList.thinkingTitle") : t("messageList.thinkingDoneTitle")}
      icon={
        <span className={`cy-reasoning-status-art${loading ? " is-thinking" : " is-complete"}`} aria-hidden="true">
          <img src={thinkingMoodUrl} alt="" draggable={false} />
          {loading && <DotSpinner />}
        </span>
      }
      blink={loading}
      expanded={expanded}
      onExpand={onExpand}
      destroyOnHidden
    >
      {content && <MarkdownContent content={content} streaming={loading} />}
    </Think>
  );
}

function useRunActivityNow(processing: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!processing) return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [processing]);
  return now;
}

function RunActivityReasoningBlock({ block }: { block: ReasoningBlock }) {
  const streaming = Boolean(block.streaming);
  // 与纯聊天模式保持一致：思考块默认折叠（含流式生成期间），仅用户点击后展开
  const [expanded, setExpanded] = useState(false);
  return (
    <ReasoningContent
      content={block.content}
      loading={streaming}
      expanded={expanded}
      onExpand={setExpanded}
    />
  );
}

function AgentRoundGroup({
  round,
  reasoningBlocks,
  processMessages,
  taskDelegations,
  tools,
  interrupted,
}: {
  round: AgentRoundRecord;
  reasoningBlocks: ReasoningBlock[];
  processMessages: ProcessMessageRecord[];
  taskDelegations: TaskDelegationDisplayRecord[];
  tools: ToolExecutionRecord[];
  interrupted: boolean;
}) {
  const { t } = useTranslation();
  const running = round.status === "running" && !interrupted;
  const [expanded, setExpanded] = useState(running);
  const wasRunningRef = useRef(running);
  useEffect(() => {
    if (!wasRunningRef.current && running) setExpanded(true);
    if (wasRunningRef.current && !running) setExpanded(false);
    wasRunningRef.current = running;
  }, [running]);

  const roundArt = interrupted
    ? interruptedMoodUrl
    : running
      ? workingMoodUrl
      : completedThinkingMoodUrl;

  return (
    <section className={`cy-agent-round${running ? " is-running" : " is-complete"}`}>
      {processMessages.filter((message) => message.content.trim()).map((message) => (
        <div className="cy-run-activity__process" key={message.id}>
          {message.interrupted && (
            <div className="cy-run-activity__process-label">{t("messageList.interruptedCandidate")}</div>
          )}
          <MarkdownContent content={message.content} />
        </div>
      ))}
      {taskDelegations.map((delegation) => (
        <TaskDelegationRow delegation={delegation} key={delegation.invocationId} />
      ))}
      <button
        type="button"
        className="cy-agent-round__header"
        aria-expanded={expanded}
        onClick={() => setExpanded((current) => !current)}
      >
        <span className="cy-agent-round__art" aria-hidden="true">
          <img
            className="cy-agent-round__art-image"
            src={roundArt}
            alt=""
            draggable={false}
          />
        </span>
        <span className="cy-agent-round__title">
          {resolveAgentRoundTitle(round, tools, interrupted)}
          {!interrupted && round.status !== "running" && countRoundChangedFiles(tools) > 0 && (
            <span className="cy-agent-round__files"> · {t("messageList.roundChangedFiles", { count: countRoundChangedFiles(tools) })}</span>
          )}
        </span>
        <svg className={`cy-agent-round__chevron${expanded ? " is-expanded" : ""}`} viewBox="0 0 16 16" aria-hidden="true">
          <path d="m4 6 4 4 4-4" fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.75" />
        </svg>
      </button>
      {expanded && (
        <div className="cy-agent-round__body">
          {reasoningBlocks.filter((block) => block.content.trim()).map((block) => (
            <RunActivityReasoningBlock block={block} key={block.id} />
          ))}
          {tools.length > 0 && <ToolExecutionContent tools={tools} />}
        </div>
      )}
    </section>
  );
}

/** 运行中平铺时间线的单条渲染：正文直接展开，推理块保持可折叠，工具卡逐条显示。 */
function FlatTimelineProcess({ message }: { message: ProcessMessageRecord }) {
  const { t } = useTranslation();
  return (
    <div className="cy-run-activity__process">
      {message.interrupted && (
        <div className="cy-run-activity__process-label">{t("messageList.interruptedCandidate")}</div>
      )}
      <MarkdownContent content={message.content} />
    </div>
  );
}

export function RunActivityDetail({
  live = false,
  agentRounds = [],
  reasoningBlocks,
  processMessages,
  taskDelegations = [],
  tools,
  interrupted = false,
}: {
  /** 运行中：所有事件按实际发生顺序平铺，不做轮次折叠归类。 */
  live?: boolean;
  agentRounds?: AgentRoundRecord[];
  reasoningBlocks: ReasoningBlock[];
  processMessages: ProcessMessageRecord[];
  taskDelegations?: TaskDelegationDisplayRecord[];
  tools: ToolExecutionRecord[];
  interrupted?: boolean;
}) {
  const { t } = useTranslation();
  if (live) {
    // 运行中统一平铺时间线：推理、过程正文、工具卡、任务委派按 seq 交错连续显示，
    // 不出现每轮的折叠头部——终态才做一次分界归类
    const entries = buildFlatRunTimeline({ processMessages, reasoningBlocks, tools, taskDelegations });
    const timeline = entries.flatMap((entry) => {
      if (entry.kind === "process" && entry.process?.content.trim()) {
        return [<FlatTimelineProcess message={entry.process} key={entry.key} />];
      }
      if (entry.kind === "reasoning" && entry.reasoning?.content.trim()) {
        return [<RunActivityReasoningBlock block={entry.reasoning} key={entry.key} />];
      }
      if (entry.kind === "tool" && entry.tool) {
        return [<ToolExecutionContent key={entry.key} tools={[entry.tool]} />];
      }
      if (entry.kind === "task" && entry.task) {
        return [<TaskDelegationRow delegation={entry.task} key={entry.key} />];
      }
      return [];
    });
    return timeline.length
      ? <div className="cy-run-activity__detail">{timeline}</div>
      : <div className="cy-run-activity__empty">{t("messageList.organizingReply")}</div>;
  }
  if (agentRounds.length > 0) {
    const visibleRounds = agentRounds.filter((round) =>
      processMessages.some((message) => message.roundId === round.id && message.content.trim())
      || reasoningBlocks.some((block) => block.roundId === round.id && block.content.trim())
      || taskDelegations.some((delegation) => delegation.roundId === round.id)
      || tools.some((tool) => tool.roundId === round.id));
    if (visibleRounds.length === 0) {
      return <div className="cy-run-activity__empty">{t("messageList.organizingReply")}</div>;
    }
    return (
      <div className="cy-run-activity__detail">
        {visibleRounds.map((round) => (
          <AgentRoundGroup
            key={round.id}
            round={round}
            interrupted={interrupted && round.status === "running"}
            processMessages={processMessages.filter((message) => message.roundId === round.id)}
            taskDelegations={taskDelegations.filter((delegation) => delegation.roundId === round.id)}
            reasoningBlocks={reasoningBlocks.filter((block) => block.roundId === round.id)}
            tools={tools.filter((tool) => tool.roundId === round.id)}
          />
        ))}
      </div>
    );
  }
  const timeline: ReactNode[] = [];
  taskDelegations.forEach((delegation) => {
    timeline.push(<TaskDelegationRow delegation={delegation} key={`task-${delegation.invocationId}`} />);
  });
  for (let index = 0; index <= tools.length; index += 1) {
    processMessages
      .filter((message) => (message.afterToolCount ?? 0) === index)
      .forEach((message) => {
        if (!message.content.trim()) return;
        timeline.push(
          <div className="cy-run-activity__process" key={`process-${message.id}`}>
            {message.interrupted && (
              <div className="cy-run-activity__process-label">{t("messageList.interruptedCandidate")}</div>
            )}
            <MarkdownContent content={message.content} />
          </div>,
        );
      });
    reasoningBlocks
      .filter((block) => (block.afterToolCount ?? 0) === index)
      .forEach((block) => {
        if (!block.content.trim()) return;
        timeline.push(
          <RunActivityReasoningBlock
            key={`reasoning-${block.id}`}
            block={block}
          />,
        );
      });
    if (index < tools.length) {
      timeline.push(<ToolExecutionContent key={`tool-${tools[index].id}`} tools={[tools[index]]} />);
    }
  }
  return timeline.length
    ? <div className="cy-run-activity__detail">{timeline}</div>
    : <div className="cy-run-activity__empty">{t("messageList.organizingReply")}</div>;
}

function RunActivityContent({
  activityId,
  activity,
  reasoningBlocks,
  processMessages,
  agentRounds,
  taskDelegations,
  tools,
  stage,
  taskPlan,
  expanded,
  onExpand,
}: {
  activityId: string;
  activity: RunActivityRecord;
  reasoningBlocks: ReasoningBlock[];
  processMessages: ProcessMessageRecord[];
  agentRounds: AgentRoundRecord[];
  taskDelegations: TaskDelegationDisplayRecord[];
  tools: ToolExecutionRecord[];
  stage?: AgentRunStage;
  taskPlan?: TaskPlanPresentation;
  expanded: boolean;
  onExpand: (expanded: boolean) => void;
}) {
  const { t } = useTranslation();
  const now = useRunActivityNow(activity.completedAt === undefined);
  const snapshot = resolveRunActivitySnapshot(activity, now);
  const wasProcessingRef = useRef(snapshot.processing);
  useEffect(() => {
    if (shouldAutoCollapseRunActivity(wasProcessingRef.current, snapshot.processing, activity.keepExpanded)) onExpand(false);
    wasProcessingRef.current = snapshot.processing;
  }, [activity.keepExpanded, onExpand, snapshot.processing]);

  const title = snapshot.processing
    ? t("messageList.activityProcessingTitle", { elapsed: formatElapsed(snapshot.processingMs) })
    : t("messageList.activityProcessedTitle", { elapsed: formatElapsed(snapshot.processingMs) });
  const image = snapshot.processing ? workingMoodUrl : processedMoodUrl;

  return (
    <section className={`cy-run-activity${snapshot.processing ? " is-processing" : " is-complete"}`}>
      <button
        type="button"
        className="cy-run-activity__header"
        onClick={() => onExpand(!expanded)}
        aria-expanded={expanded}
        aria-controls={`${activityId}-details`}
      >
        <span className="cy-run-activity__title">
            <span className="cy-run-activity__art" aria-hidden="true">
              <img src={image} alt="" draggable={false} />
              {snapshot.processing && <DotSpinner />}
            </span>
            <span>{title}</span>
            {stage && <RunStageIndicator stage={stage} />}
        </span>
        <svg className={`cy-run-activity__chevron${expanded ? " is-expanded" : ""}`} viewBox="0 0 16 16" aria-hidden="true">
          <path d="m4 6 4 4 4-4" fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.75" />
        </svg>
      </button>
      {expanded && (
        <div className="cy-run-activity__expanded" id={`${activityId}-details`}>
          {taskPlan && <TaskPlanCard plan={taskPlan} />}
          <div className="cy-run-activity__divider" />
          <RunActivityDetail
            live={snapshot.processing}
            agentRounds={agentRounds}
            reasoningBlocks={reasoningBlocks}
            processMessages={processMessages}
            taskDelegations={taskDelegations}
            tools={tools}
            interrupted={Boolean(activity.keepExpanded && activity.completedAt !== undefined)}
          />
          <div className="cy-run-activity__divider" />
        </div>
      )}
    </section>
  );
}

function ToolExecutionContent({ tools }: { tools: ToolExecutionRecord[] }) {
  const { t } = useTranslation();
  return (
    <section className="cy-tool-executions" aria-label={t("messageList.toolExecutionsAria")}>
      <ThoughtChain
        rootClassName="cy-tool-executions__chain"
        line="dashed"
        items={tools.map((tool) => {
          const presentation = describeToolExecution(tool);
          return {
            key: tool.id,
            title: presentation.label,
            description: (
              <span className="cy-tool-executions__description">
                <span className="cy-tool-executions__status">{presentation.statusText}</span>
                {presentation.detail && <code className="cy-tool-executions__detail">{presentation.detail}</code>}
              </span>
            ),
            status: tool.status === "running" ? "loading" : tool.status === "error" ? "error" : "success",
            blink: tool.status === "running",
            collapsible: Boolean(tool.result || tool.changes),
            content: (tool.result || tool.changes)
              ? <ToolResultContent tool={tool} result={tool.result} changes={tool.changes} />
              : undefined,
          };
        })}
      />
    </section>
  );
}

/** ask_user 问答配对展示：问题 + 用户回答成对出现，不展示原始 JSON。 */
function AskUserQaContent({ rows }: { rows: string[] }) {
  return (
    <ul className="cy-ask-user-qa">
      {rows.map((row) => {
        const separator = row.indexOf("→");
        const question = separator >= 0 ? row.slice(0, separator).trim() : row;
        const answer = separator >= 0 ? row.slice(separator + 1).trim() : "";
        return (
          <li className="cy-ask-user-qa__row" key={row}>
            <span className="cy-ask-user-qa__question">{question}</span>
            <span className="cy-ask-user-qa__answer">{answer}</span>
          </li>
        );
      })}
    </ul>
  );
}

/** 工具结果展示：ask_user 渲染问答配对；优先用事件携带的结构化 changes 渲染 Diff Review 卡片；否则尝试解析完整 result JSON；最后原样展示 */
function ToolResultContent({ tool, result, changes }: { tool?: ToolExecutionRecord; result?: string; changes?: ToolFileChange[] }) {
  if (tool?.name === "ask_user") {
    const rows = buildAskUserQa(tool);
    if (rows.length > 0) return <AskUserQaContent rows={rows} />;
  }
  if (changes && changes.length > 0) return <FileChangeCard changes={changes} />;
  if (result) {
    const parsed = extractFileChanges(result);
    if (parsed) return <FileChangeCard changes={parsed} />;
    return <pre className="cy-tool-executions__result">{result}</pre>;
  }
  return null;
}

function attachmentStatus(attachment: ChatMessageAttachment): string | undefined {
  if (attachment.status === "processing") return t("messageList.attachmentProcessing");
  if (attachment.status === "error") return attachment.reason ?? t("messageList.attachmentErrorFallback");
  if (attachment.imageSendMode === "direct") return t("messageList.attachmentDirect");
  if (attachment.imageSendMode === "caption" && attachment.status === "done") return t("messageList.attachmentDone");
  return undefined;
}

function UserAttachments({ attachments }: { attachments: ChatMessageAttachment[] }) {
  useTranslation();
  if (attachments.length === 0) return null;
  return (
    <div className="cy-message__attachments">
      {attachments.map((attachment, index) => {
        const status = attachmentStatus(attachment);
        if (attachment.kind === "image" && (attachment.previewUrl || attachment.filePath)) {
          return (
            <figure className="cy-message__image-attachment" key={`${attachment.filePath ?? attachment.name}-${index}`}>
              <AttachmentImage attachment={attachment} />
              {status && <figcaption className={attachment.status === "error" ? "is-error" : ""}>{status}</figcaption>}
            </figure>
          );
        }
        return <span className="cy-message__file-attachment" key={`${attachment.filePath ?? attachment.name}-${index}`}>{attachment.name}</span>;
      })}
    </div>
  );
}

function AttachmentImage({ attachment }: { attachment: ChatMessageAttachment }) {
  const [src, setSrc] = useState(attachment.previewUrl);
  // blob: 预览 URL 只在当前页面有效，聊天记录持久化后刷新必失效；只允许一次磁盘重读兜底
  const diskFallbackTriedRef = useRef(false);

  function readFromDisk(): void {
    if (!attachment.filePath) return;
    void window.chat?.getImagePreview?.(attachment.filePath).then((result) => {
      if (result.ok && result.dataUrl) setSrc(result.dataUrl);
    });
  }

  useEffect(() => {
    setSrc(attachment.previewUrl);
    diskFallbackTriedRef.current = false;
    if ((!attachment.previewUrl || attachment.previewUrl.startsWith("file:")) && attachment.filePath) {
      let active = true;
      void window.chat?.getImagePreview?.(attachment.filePath).then((result) => {
        if (active && result.ok && result.dataUrl) setSrc(result.dataUrl);
      });
      return () => {
        active = false;
      };
    }
  }, [attachment.filePath, attachment.previewUrl]);

  // 历史 blob: URL 加载失败时从磁盘重读，修复刷新后的存量裂图
  function handleImageError(): void {
    if (diskFallbackTriedRef.current) return;
    diskFallbackTriedRef.current = true;
    readFromDisk();
  }

  return <img src={src} alt={attachment.name} draggable={false} onError={handleImageError} />;
}

function UserContent({
  content,
  stickerUrl,
  attachments = [],
  channelSource,
}: {
  content: string;
  stickerUrl?: string;
  attachments?: ChatMessageAttachment[];
  channelSource?: ChatMessageChannelSource;
}) {
  const { t } = useTranslation();
  return (
    <div className="cy-message__user-body">
      {channelSource && <ChannelSourceLabel source={channelSource} direction="incoming" />}
      <UserAttachments attachments={attachments} />
      {content && <MarkdownContent content={content} />}
      {stickerUrl && <img className="cy-message__sticker" src={stickerUrl} alt={t("messageList.userStickerAlt")} draggable={false} />}
    </div>
  );
}

function LastUserMessageEditor({
  value,
  busy,
  onChange,
  onCancel,
  onSubmit,
}: {
  value: string;
  busy: boolean;
  onChange: (value: string) => void;
  onCancel: () => void;
  onSubmit: () => void;
}) {
  const { t } = useTranslation();
  const handleKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Escape") {
      event.preventDefault();
      onCancel();
    } else if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
      event.preventDefault();
      onSubmit();
    }
  };
  return (
    <div className="cy-last-message-editor">
      <textarea
        autoFocus
        value={value}
        disabled={busy}
        aria-label={t("messageList.editLastMessageAria")}
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={handleKeyDown}
      />
      <div className="cy-last-message-editor__actions">
        <button type="button" disabled={busy} onClick={onCancel}>{t("common.cancel")}</button>
        <button type="button" className="is-primary" disabled={busy || !value.trim()} onClick={onSubmit}>
          {t("messageList.saveAndRegenerate")}
        </button>
      </div>
    </div>
  );
}

function CyreneMessageAvatar() {
  const { t } = useTranslation();
  return <img className="cy-message-avatar__image" src={cyreneAvatarUrl} alt={t("messageList.cyreneAvatarAlt")} draggable={false} />;
}

function UserMessageAvatar({ src }: { src: string | null }) {
  const { t } = useTranslation();
  if (src) return <img className="cy-message-avatar__image" src={src} alt={t("messageList.userAvatarAlt")} draggable={false} />;
  return <span className="cy-message-avatar__user" aria-label={t("messageList.userAvatarAlt")} />;
}

function createRoles(
  userAvatarUrl: string | null,
  conversationId: string | undefined,
  mode: ConversationMode,
  preferredAddress: string,
  editingMessageId: string | null,
  editDraft: string,
  revisionBusy: boolean,
  onBeginEdit: (messageId: string, content: string) => void,
  onEditDraftChange: (value: string) => void,
  onCancelEdit: () => void,
  onSubmitEdit: () => void,
  onRegenerateLastResponse: ((userMessageId: string, assistantMessageId: string) => Promise<boolean>) | undefined,
  reasoningExpanded: Readonly<Record<string, boolean>>,
  onReasoningExpand: (id: string, expanded: boolean) => void,
  onTtsCacheKey?: (messageId: string, cacheKey: string, converterVersion: string) => void,
  onOpenReviewInspector?: (runId: string, fileIndex: number, filePath: string) => void,
) {
  return {
  user: {
    placement: "end" as const,
    variant: "filled" as const,
    rootClassName: "cy-message cy-message--user",
    avatar: <UserMessageAvatar src={userAvatarUrl} />,
    contentRender: (content: string, info: { extraInfo?: { messageId?: string; stickerUrl?: string; attachments?: ChatMessageAttachment[]; channelSource?: ChatMessageChannelSource } }) => (
      info.extraInfo?.messageId === editingMessageId
        ? <LastUserMessageEditor
            value={editDraft}
            busy={revisionBusy}
            onChange={onEditDraftChange}
            onCancel={onCancelEdit}
            onSubmit={onSubmitEdit}
          />
        : <UserContent
            content={content}
            stickerUrl={info.extraInfo?.stickerUrl}
            attachments={info.extraInfo?.attachments}
            channelSource={info.extraInfo?.channelSource}
          />
    ),
    footer: (content: string, info: { extraInfo?: { messageId?: string } }) => {
      const cleanText = content.replace(/\[sticker:[^\]]+\]/g, "").trim();
      const messageId = info.extraInfo?.messageId;
      if (!cleanText || messageId === editingMessageId) return null;
      return (
        <div className="cy-message-actions">
          <LastTurnEditAction messageId={messageId} content={cleanText} disabled={revisionBusy} onBeginEdit={onBeginEdit} />
          <CopyButton text={cleanText} />
        </div>
      );
    },
  },
  assistant: {
    placement: "start" as const,
    variant: "filled" as const,
    rootClassName: "cy-message cy-message--assistant",
    avatar: <CyreneMessageAvatar />,
    contentRender: (content: string, info: { extraInfo?: { streaming?: boolean; stickerUrl?: string; channelSource?: ChatMessageChannelSource } }) => (
      <AssistantContent
        content={content}
        streaming={Boolean(info.extraInfo?.streaming)}
        stickerUrl={info.extraInfo?.stickerUrl}
        channelSource={info.extraInfo?.channelSource}
      />
    ),
    footer: (content: string, info: { extraInfo?: { messageId?: string; streaming?: boolean } }) => (
      <AssistantMessageFooter
        content={content}
        messageId={info.extraInfo?.messageId}
        streaming={Boolean(info.extraInfo?.streaming)}
        conversationId={conversationId}
        mode={mode}
        preferredAddress={preferredAddress}
        revisionBusy={revisionBusy}
        onTtsCacheKey={onTtsCacheKey}
        onRegenerateLastResponse={onRegenerateLastResponse}
      />
    ),
  },
  reasoning: {
    placement: "start" as const,
    variant: "borderless" as const,
    rootClassName: "cy-message cy-message--reasoning",
    contentRender: (_content: string, info: { extraInfo?: { reasoningId?: string; reasoning?: string; reasoningStreaming?: boolean } }) => (
      <ReasoningContent
        content={info.extraInfo?.reasoning ?? ""}
        loading={Boolean(info.extraInfo?.reasoningStreaming)}
        expanded={info.extraInfo?.reasoningId
          ? resolveReasoningExpanded(reasoningExpanded, info.extraInfo.reasoningId)
          : false}
        onExpand={(expanded) => {
          if (info.extraInfo?.reasoningId) onReasoningExpand(info.extraInfo.reasoningId, expanded);
        }}
      />
    ),
  },
  activity: {
    placement: "start" as const,
    variant: "borderless" as const,
    avatar: null,
    rootClassName: "cy-message cy-message--activity",
    contentRender: (_content: string, info: {
      extraInfo?: {
        activityId?: string;
        activity?: RunActivityRecord;
        reasoningBlocks?: ReasoningBlock[];
        processMessages?: ProcessMessageRecord[];
        agentRounds?: AgentRoundRecord[];
        taskDelegations?: TaskDelegationDisplayRecord[];
        tools?: ToolExecutionRecord[];
        runStage?: AgentRunStage;
        taskPlan?: TaskPlanPresentation;
      };
    }) => {
      const activityId = info.extraInfo?.activityId;
      const activity = info.extraInfo?.activity;
      if (!activityId || !activity) return null;
      return (
        <RunActivityContent
          activityId={activityId}
          activity={activity}
          reasoningBlocks={info.extraInfo?.reasoningBlocks ?? []}
          processMessages={info.extraInfo?.processMessages ?? []}
          agentRounds={info.extraInfo?.agentRounds ?? []}
          taskDelegations={info.extraInfo?.taskDelegations ?? []}
          tools={info.extraInfo?.tools ?? []}
          stage={info.extraInfo?.runStage}
          taskPlan={info.extraInfo?.taskPlan}
          expanded={resolveRunActivityExpanded(reasoningExpanded, activityId, activity)}
          onExpand={(expanded) => onReasoningExpand(activityId, expanded)}
        />
      );
    },
  },
  tool: {
    placement: "start" as const,
    variant: "borderless" as const,
    avatar: null,
    rootClassName: "cy-message cy-message--tool",
    contentRender: (_content: string, info: { extraInfo?: { tools?: ToolExecutionRecord[] } }) => (
      info.extraInfo?.tools?.length ? <ToolExecutionContent tools={info.extraInfo.tools} /> : null
    ),
  },
  waiting: {
    placement: "start" as const,
    variant: "borderless" as const,
    avatar: null,
    rootClassName: "cy-message cy-message--waiting",
    contentRender: () => <ModelWaitContent />,
  },
  weather: {
    placement: "start" as const,
    variant: "borderless" as const,
    avatar: null,
    rootClassName: "cy-message cy-message--weather",
    contentRender: (_content: string, info: { extraInfo?: { weather?: WeatherData } }) => (
      info.extraInfo?.weather ? <WeatherCard data={info.extraInfo.weather} /> : null
    ),
  },
  review: {
    placement: "start" as const,
    variant: "borderless" as const,
    avatar: null,
    rootClassName: "cy-message cy-message--review",
    contentRender: (_content: string, info: { extraInfo?: { runId?: string } }) => (
      info.extraInfo?.runId
        ? <ReviewPanel runId={info.extraInfo.runId} onOpenInspector={onOpenReviewInspector} />
        : null
    ),
  },
  system: {
    placement: "start" as const,
    variant: "borderless" as const,
    rootClassName: "cy-message cy-message--system",
  },
  };
}

/**
 * 单消息 → 气泡条目（flatMap 语义：一条消息可产出多个条目）。
 * 纯函数：只依赖 message 与 enabledStickers——这是阶段 2 派生缓存正确性的前提，
 * 修改本函数时不得引入消息对象与贴纸表之外的输入。
 */
function convertMessage(message: ChatMessageItem, enabledStickers: readonly EnabledSticker[]): readonly BubbleItemType[] {
  if (message.role !== "assistant") {
    const stickerId = extractMessageStickerId(message.content, message.sticker);
    return [{
      key: message.id,
      role: message.role,
      content: stripMessageStickerMarkers(message.content),
      extraInfo: {
        stickerUrl: stickerId ? resolveStickerUrl(stickerId, enabledStickers) : undefined,
        attachments: message.attachments,
        messageId: message.id,
        channelSource: message.channelSource,
      },
    }];
  }

  const assistantItems: BubbleItemType[] = [];
  const stages = assistantRenderStages(message);
  if (message.waitingForFirstEvent && !message.runActivity) {
    assistantItems.push({
      key: `${message.id}-waiting`,
      role: "waiting",
      content: "",
    });
  }
  const reasoningBlocks = message.reasoningBlocks?.length
    ? message.reasoningBlocks
    : (stages.includes("reasoning") ? [{ id: `${message.id}-legacy`, content: message.reasoning ?? "", streaming: message.reasoningStreaming }] : []);
  const appendReasoning = (block: ReasoningBlock) => {
    assistantItems.push({
      key: `${message.id}-reasoning-${block.id}`,
      role: "reasoning",
      content: "",
      extraInfo: {
        reasoningId: block.id,
        reasoning: block.content,
        reasoningStreaming: block.streaming,
      },
    });
  };
  const tools = message.toolExecutions ?? [];
  // 活动卡是否渲染：运行中始终显示；终态只在确实产生了过程内容（正文/推理/工具/委派）时保留，
  // 首轮无工具调用的成功运行不产生空折叠头部。头像钉在活动卡头部，正文据此决定是否隐藏自己的头像。
  const hasProcessContent = (message.processMessages ?? []).some((item) => item.content.trim())
    || tools.length > 0
    || (message.taskDelegations ?? []).length > 0
    || reasoningBlocks.some((block) => block.content.trim());
  const processing = message.runActivity?.completedAt === undefined;
  const activityVisible = Boolean(message.runActivity) && (processing || hasProcessContent);
  if (message.runActivity) {
    if (activityVisible) {
      assistantItems.push({
        key: `${message.id}-activity`,
        role: "activity",
        content: "",
        // 头像钉在运行块头部（状态行左侧）：一次运行只出现一次，不随每条消息重复。
        // 用 createElement 而非 JSX：convertMessage 在测试里直接执行，不经过 JSX 运行时
        avatar: createElement(CyreneMessageAvatar),
        extraInfo: {
          activityId: `${message.id}-activity`,
          activity: message.runActivity,
          reasoningBlocks,
          processMessages: message.processMessages ?? [],
          agentRounds: message.agentRounds ?? [],
          taskDelegations: message.taskDelegations ?? [],
          tools,
          runStage: message.runStage,
          taskPlan: message.taskPlan,
        },
      });
    }
  } else {
    for (let index = 0; index <= tools.length; index += 1) {
      reasoningBlocks.filter((block) => (block.afterToolCount ?? 0) === index).forEach(appendReasoning);
      if (index === tools.length) continue;
      assistantItems.push({
        key: `${message.id}-tool-${tools[index].id}`,
        role: "tool",
        content: "",
        extraInfo: { tools: [tools[index]] },
      });
    }
  }
  if (message.weather) {
    assistantItems.push({
      key: `${message.id}-weather`,
      role: "weather",
      content: "",
      extraInfo: { weather: message.weather },
    });
  }
  if (stages.includes("assistant")) {
    // 运行块内的正文不重复头像（头像已钉在活动卡头部）：
    // 保留头像占位只做视觉隐藏，正文左边缘与活动卡时间线内容精确对齐。
    // 活动卡未渲染时（如首轮直接回答的纯文本运行）正文保留自己的头像。
    const hideAvatar = activityVisible;
    assistantItems.push({
      key: message.id,
      role: "assistant",
      content: message.transientText ?? message.content,
      streaming: message.streaming,
      ...(hideAvatar ? { rootClassName: "cy-message cy-message--assistant cy-message--assistant-run" } : {}),
      extraInfo: {
        messageId: message.id,
        streaming: message.streaming,
        ttsCacheKey: message.ttsCacheKey,
        stickerUrl: message.sticker ? resolveStickerUrl(message.sticker, enabledStickers) : undefined,
        channelSource: message.channelSource,
      },
    });
  }
  // Review 面板：Run 结束后（非 streaming/loading）且有 runId 时显示
  if (message.runId && !message.streaming && !message.loading) {
    assistantItems.push({
      key: `${message.id}-review`,
      role: "review",
      content: "",
      // Review 面板属于运行块：头像占位隐藏（头像钉在活动卡头部），面板与正文/时间线内容左对齐
      avatar: createElement(CyreneMessageAvatar),
      rootClassName: "cy-message cy-message--review cy-message--review-run",
      extraInfo: { runId: message.runId },
    });
  }
  return assistantItems;
}

export function createMessageItems(messages: ChatMessageItem[], enabledStickers: EnabledSticker[]): BubbleItemType[] {
  return messages.flatMap((message) => convertMessage(message, enabledStickers));
}

/** 阶段 2：单消息派生缓存状态——stickers 引用变化时整体替换（新 WeakMap），不逐条维护版本号 */
export interface MessageItemsCacheState {
  stickers: readonly EnabledSticker[];
  byMessage: WeakMap<ChatMessageItem, readonly BubbleItemType[]>;
}

/**
 * 阶段 2：带缓存的条目装配——消息对象不变时直接复用上次条目（条目引用稳定，
 * 历史气泡的 memoized content 不失效）；消息被 patch 后对象引用必变，自动 miss 重算。
 * items 外层数组每次新建（由 messages 引用变化驱动渲染），条目对象保持稳定。
 */
export function assembleMessageItems(
  messages: readonly ChatMessageItem[],
  stickers: readonly EnabledSticker[],
  cache: MessageItemsCacheState | null,
): { items: BubbleItemType[]; cache: MessageItemsCacheState } {
  const state: MessageItemsCacheState = cache && cache.stickers === stickers
    ? cache
    : { stickers, byMessage: new WeakMap<ChatMessageItem, readonly BubbleItemType[]>() };
  const items: BubbleItemType[] = [];
  for (const message of messages) {
    let converted = state.byMessage.get(message);
    if (converted === undefined) {
      converted = convertMessage(message, stickers);
      state.byMessage.set(message, converted);
    }
    for (const item of converted) items.push(item);
  }
  return { items, cache: state };
}

export function ChatMessageList({
  messages,
  conversationId,
  mode,
  preferredAddress,
  stickerSize = "standard",
  onTtsCacheKey,
  revisionBusy = false,
  onEditLastUserMessage,
  onRegenerateLastResponse,
  onScrollToBottomVisibilityChange,
  onRegisterScrollToBottom,
  onOpenReviewInspector,
  workspaceRoot,
  onOpenFileLink,
}: ChatMessageListProps) {
  // 性能探针：列表外壳执行次数（A0 实验补 markdownRenders 覆盖不到的 Bubble 外壳/footer 路径）
  reportChatPerfRender("listRenders");
  const userAvatarUrl = useUserAvatar();
  const [enabledStickers, setEnabledStickers] = useState<EnabledSticker[]>([]);
  const [reasoningExpanded, setReasoningExpanded] = useState<Record<string, boolean>>({});
  const [editingMessageId, setEditingMessageId] = useState<string | null>(null);
  const [editDraft, setEditDraft] = useState("");
  // 完成态最后一轮：流式期间恒为 null，完成态随 messages 重算。
  // 不做引用稳定化 hack（渲染期写 ref 属于 React 反模式）：footer 动作组件经
  // LastTurnIdsContext 消费原始 ID，值相等时下方 lastTurnIds 派生对象引用天然稳定。
  const lastTurn = useMemo(() => resolveRevisableLastTurn(messages, mode), [messages, mode]);
  const lastTurnIds = useMemo<LastTurnIds>(
    () => ({ userMessageId: lastTurn?.userMessageId ?? null, assistantMessageId: lastTurn?.assistantMessageId ?? null }),
    [lastTurn?.userMessageId, lastTurn?.assistantMessageId],
  );
  const onReasoningExpand = useCallback((id: string, expanded: boolean) => {
    setReasoningExpanded((current) => updateReasoningExpanded(current, id, expanded));
  }, []);
  const beginEdit = useCallback((messageId: string, content: string) => {
    setEditingMessageId(messageId);
    setEditDraft(content);
  }, []);
  const cancelEdit = useCallback(() => {
    if (revisionBusy) return;
    setEditingMessageId(null);
    setEditDraft("");
  }, [revisionBusy]);
  const submitEdit = useCallback(() => {
    if (!editingMessageId || !editDraft.trim() || !onEditLastUserMessage || revisionBusy) return;
    void onEditLastUserMessage(editingMessageId, editDraft.trim()).then((accepted) => {
      if (!accepted) return;
      setEditingMessageId(null);
      setEditDraft("");
    });
  }, [editDraft, editingMessageId, onEditLastUserMessage, revisionBusy]);
  const containerRef = useRef<HTMLDivElement>(null);
  const isNearBottomRef = useRef(true);

  const scrollToBottom = useCallback((behavior: ScrollBehavior = "smooth") => {
    const el = containerRef.current;
    if (!el) return;
    el.scrollTo({ top: el.scrollHeight, behavior });
  }, []);

  // 向父组件注册滚动到底部的回调
  useEffect(() => {
    onRegisterScrollToBottom?.(scrollToBottom);
  }, [onRegisterScrollToBottom, scrollToBottom]);

  const updateScrollState = useCallback(() => {
    const el = containerRef.current;
    if (!el) return;
    const distance = el.scrollHeight - el.scrollTop - el.clientHeight;
    const nearBottom = distance < 100;
    isNearBottomRef.current = nearBottom;
    onScrollToBottomVisibilityChange?.(!nearBottom);
  }, [onScrollToBottomVisibilityChange]);

  // 打开/切换会话时滚动到底部
  useEffect(() => {
    scrollToBottom("auto");
    // 内容渲染后再次兜底滚动
    const timer = window.setTimeout(() => scrollToBottom("auto"), 100);
    isNearBottomRef.current = true;
    onScrollToBottomVisibilityChange?.(false);
    return () => window.clearTimeout(timer);
  }, [conversationId, onScrollToBottomVisibilityChange, scrollToBottom]);

  // roles 不闭包 lastTurn（footer 动作组件经 LastTurnIdsContext 读取）：流式阶段边界
  // （推理结束/正文开始/运行结束）lastTurn 在 null 与非 null 间切换是真实值变化，若进入
  // 依赖会让全部条目的 contentRender 换引用、memoedContent 失效，历史消息被全量重渲染。
  const roles = useMemo(
    () => createRoles(
      userAvatarUrl,
      conversationId,
      mode,
      preferredAddress,
      editingMessageId,
      editDraft,
      revisionBusy,
      beginEdit,
      setEditDraft,
      cancelEdit,
      submitEdit,
      onRegenerateLastResponse,
      reasoningExpanded,
      onReasoningExpand,
      onTtsCacheKey,
      onOpenReviewInspector,
    ),
    [beginEdit, cancelEdit, conversationId, editDraft, editingMessageId, mode, onOpenReviewInspector, onReasoningExpand, onRegenerateLastResponse, onTtsCacheKey, preferredAddress, reasoningExpanded, revisionBusy, submitEdit, userAvatarUrl],
  );

  useEffect(() => {
    if (editingMessageId && editingMessageId !== lastTurn?.userMessageId) {
      setEditingMessageId(null);
      setEditDraft("");
    }
  }, [editingMessageId, lastTurn?.userMessageId]);

  useEffect(() => stopTtsPlayback, [conversationId]);

  useEffect(() => {
    let active = true;
    void window.chat?.getEnabledStickers?.().then((stickers) => {
      if (active) setEnabledStickers(stickers);
    }).catch(() => {
      if (active) setEnabledStickers([]);
    });
    return () => {
      active = false;
    };
  }, []);

  // 阶段 2：实例级单消息派生缓存（组件无 key、单实例常驻；会话切换仅换 messages 数组不卸载，
  // 切回旧会话若消息对象复用可自然命中，卸载时 WeakMap 随之释放，不跨窗口共享）。
  // 流式 delta 只重算被 patch 的消息（patch 必产生新对象引用 → 自动 miss），历史条目引用稳定。
  const messageItemsCacheRef = useRef<MessageItemsCacheState | null>(null);
  const items = useMemo(() => {
    const assembled = assembleMessageItems(messages, enabledStickers, messageItemsCacheRef.current);
    messageItemsCacheRef.current = assembled.cache;
    return assembled.items;
  }, [messages, enabledStickers]);
  const channelConversationLabel = resolveChannelConversationLabel(messages);
  const fileLinkEnv = useMemo<FileLinkEnv>(
    () => ({ workspaceRoot, openFile: onOpenFileLink }),
    [workspaceRoot, onOpenFileLink],
  );

  return (
    <FileLinkContext.Provider value={fileLinkEnv}>
      <LastTurnIdsContext.Provider value={lastTurnIds}>
        <div
          ref={containerRef}
          className={`cy-message-list cy-message-list--stickers-${stickerSize}`}
          aria-live="polite"
          onScroll={updateScrollState}
        >
          {channelConversationLabel && (
            <div className="cy-message-list__channel-context" role="note" aria-label={channelConversationLabel}>
              <span className="cy-message-list__channel-dot" aria-hidden="true" />
              <span>{channelConversationLabel}</span>
            </div>
          )}
          <Bubble.List items={items} role={roles} autoScroll />
        </div>
      </LastTurnIdsContext.Provider>
    </FileLinkContext.Provider>
  );
}
