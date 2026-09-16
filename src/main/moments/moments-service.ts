// Moments 对外唯一门面：IPC 与组合根都只碰它。
//
// 职责：
// - 包装 moments-store 的 CRUD（读走内存缓存，写走串行队列）；
// - 用户发帖 / 评论成功后调度反应任务入持久化反应队列：
//   昔涟全模型决策；角色先抽签（谁刷到）再双骰分流（评/赞/划走），
//   到期由扫描器执行决策与落库，长尾延迟 + 深夜窗口保证拟人节奏；
// - AI 评论落库后事件驱动续接互动链：角色评论昔涟动态 → 昔涟回应 →
//   角色再回（深度内）——回复链深度达到上限时自然收束，用户插话开新链；
// - run 收尾后按策略调度昔涟主动发帖（后台 LLM，经 enqueueLLMTask 串行），
//   昔涟发帖同样进角色抽签池；
// - 规则闸门前置：反应开关关闭或模型未配置时连任务都不入队，不浪费 token。
//
// 反应执行分两段：agent/角色决策只产出结果（stale/retry/invalid/decided），
// 落库由反应队列的 apply 执行器统一提交——决策与副作用分离，崩溃后凭落盘的
// 决策缓存续接，不重问模型；AI 评论一律携带 sourceTaskId，重跑幂等。

import { app } from "electron";
import { enqueueLLMTask } from "../llm-queue";
import { loadGeneralSettings } from "../settings/settings-facade";
import { loadModelSettings } from "../settings/model-settings";
import { resolveImageRoute } from "../orchestrator/image-router";
import { loadPromptFile } from "../prompts/prompt-loader";
import { pluginPromptRegistry } from "../../plugins/prompts";
import type { ChatMessage, VendorConfig } from "../orchestrator/vendors";
import * as path from "path";
import { getEmbeddingProvider } from "../rag/embedding";
import { getKeywordMatchedWorldbookEntries, getPermanentWorldbookEntries } from "../rag";
import { validateCaptionImagePath } from "../chat/image-caption";
import { matchSticker, type StickerEmbeddingEntry } from "../sticker-embedder";
import { resolveMomentStickerMedia } from "./moment-media-matcher";
import * as momentsStore from "./moments-store";
import {
  createMomentsAgent,
  runMomentsModel,
  type MomentsAgent,
  type MomentsModelOutput,
  type MomentPostImage,
} from "./moments-agent";
import {
  buildConversationSummary,
  type ConversationSummaryTurn,
} from "./moments-context";
import {
  applyNightWindow,
  computeCharacterPostDelayMs,
  computeCharacterReplyDelayMs,
  computeCyrenePostDelayMs,
  computeCyreneReplyDelayMs,
  computeMentionDelayMs,
  createReactionQueue,
  type ReactionDecideOutcome,
  type ReactionDecision,
  type ReactionQueue,
  type ReactionTask,
  type ReactionTaskExecutor,
} from "./reaction-queue";
import {
  pickCandidateCount,
  pickWeightedCandidates,
  rollReactionDice,
  withinReplyDepthLimit,
  type MomentsLiveliness,
} from "./character-reactions";
import {
  buildCharacterPostEvalMessages,
  buildCharacterReplyEvalMessages,
  loadCharacterPersonas,
  parseCharacterMentionDecision,
  parseCharacterPostDecision,
  parseCharacterReplyDecision,
  type CharacterPersona,
} from "./character-personas";
import {
  buildMomentsEventKey,
  canCharacterModelCall,
  canPost,
  loadMomentsPolicyState,
  recordCharacterModelCall,
  recordEventKey,
  recordPost,
  saveMomentsPolicyState,
  type MomentsPolicyState,
} from "./moments-policy";
import type {
  MomentComment,
  MomentCommitResult,
  MomentMedia,
  MomentCreateCommentInput,
  MomentCreatePostInput,
  MomentFeedItem,
  MomentPost,
} from "../../shared/moments-types";

const MOMENTS_MODEL_TIMEOUT_MS = 45_000;

/** ring buffer 保留的最近轮数（MomentEvent.summary 的原料） */
const RING_BUFFER_MAX_TURNS = 6;
/** 供新颖性判断的最近昔涟动态条数 */
const RECENT_CYRENE_POSTS_FOR_NOVELTY = 5;
/** 昔涟在线判定窗口：最近一次对话收尾距今不足 10 分钟视为在线 */
const CYRENE_ONLINE_WINDOW_MS = 10 * 60_000;

/** Moments 一次 run 收尾的输入（事件产生时冻结的不可变快照）。 */
export interface MomentsTurnInput {
  conversationId: string;
  runId?: string;
  source: "desktop" | "channel";
  mode: string;
  channel?: string;
  userText: string;
  assistantReply: string;
  finishedAt: number;
}

export interface MomentsService {
  listFeed: (options?: { limit?: number; before?: number }) => MomentFeedItem[];
  getFeedItem: (postId: string) => MomentFeedItem | null;
  createUserPost: (input: MomentCreatePostInput) => Promise<MomentCommitResult<MomentPost>>;
  deletePost: (postId: string) => Promise<MomentCommitResult<null>>;
  createUserComment: (input: MomentCreateCommentInput) => Promise<MomentCommitResult<MomentComment>>;
  toggleUserLike: (postId: string) => Promise<MomentCommitResult<{ liked: boolean }>>;
  /** 昔涟在聊天里发动态（工具通道）：即时落库不排队，成功后进角色抽签池。 */
  cyreneCreatePostFromTool: (input: { title?: string; text: string }) => Promise<MomentCommitResult<MomentPost>>;
  /** 昔涟在聊天里点赞（工具通道）：幂等，已点过返回既有结果。 */
  cyreneLikeFromTool: (postId: string) => Promise<MomentCommitResult<{ liked: true }>>;
  /** 昔涟在聊天里评论/回复（工具通道）：落库后按需续接互动链。 */
  cyreneCommentFromTool: (input: MomentCreateCommentInput) => Promise<MomentCommitResult<MomentComment>>;
  /** run 成功收尾时调用：记录 ring buffer 并按策略调度昔涟主动发帖。 */
  scheduleTurn: (input: MomentsTurnInput) => void;
  /** 启动反应队列周期扫描器（启动即补扫一轮，重启后逾期任务尽快续上）；由后台启动组挂载 */
  startReactionScanner(): void;
  /** 停止反应队列周期扫描器 */
  stopReactionScanner(): void;
  /** 手动扫描一轮到期反应任务（诊断与测试用）；已有排空在进行时返回 false */
  drainReactionQueue(): Promise<boolean>;
}

interface MomentsStoreFacade {
  listFeed: typeof momentsStore.listFeed;
  getFeedItem: typeof momentsStore.getFeedItem;
  createUserPost: typeof momentsStore.createUserPost;
  deletePost: typeof momentsStore.deletePost;
  createComment: typeof momentsStore.createComment;
  toggleLike: typeof momentsStore.toggleLike;
  createCyreneLike: typeof momentsStore.createCyreneLike;
  createCyrenePost: typeof momentsStore.createCyrenePost;
  createCharacterLike: typeof momentsStore.createCharacterLike;
  createCharacterComment: typeof momentsStore.createCharacterComment;
  getCharacterTimeline: typeof momentsStore.getCharacterTimeline;
}

export interface MomentsServiceDeps {
  store: MomentsStoreFacade;
  loadGeneralSettings: () => {
    momentsEnabled: boolean;
    cyreneMomentsReactionsEnabled: boolean;
    cyreneMomentsPostingEnabled: boolean;
    momentsCharacterReactionsEnabled: boolean;
    /** 朋友圈热闹程度档位：缺省回落冷清档 */
    momentsLiveliness?: "quiet" | "natural" | "lively";
  };
  /** 返回 null 表示模型未配置（缺 API key 等），反应调度直接跳过 */
  loadVendorConfig: () => VendorConfig | null;
  buildPersona: () => string;
  enqueueTask: (label: string, task: () => Promise<void>) => Promise<void>;
  runModel: (messages: ChatMessage[]) => Promise<MomentsModelOutput>;
  /** 策略状态存取（默认读写 moments-state.json；测试注入内存版） */
  loadPolicyState?: () => MomentsPolicyState;
  savePolicyState?: (state: MomentsPolicyState) => void;
  /** 后置配图匹配（未注入或未命中时纯文字发帖） */
  matchMedia?: (query: string) => Promise<MomentMedia | null>;
  /** 关键词命中 worldbook 设定块（未注入时降级空串，不注入设定） */
  buildWorldbookContext?: (text: string) => string;
  /** 注入插件提示词上下文（moments-post 场景）；未注入或抛错时发帖不带插件上下文 */
  buildPluginPromptContext?: (input: {
    source: "moments-post";
    userText: string;
    /** 触发发帖的会话（事件到达时的快照）；按会话隔离记忆的插件可用它过滤 */
    conversationId?: string;
    /** 触发发帖的渠道（事件到达时的快照） */
    channel?: string;
  }) => Promise<string>;
  /** 读取用户动态图片转 base64（未注入时不带图） */
  loadPostImages?: (post: MomentPost) => MomentPostImage[];
  /**
   * 角色注册表加载（缺省每次读盘：md 随时可改，下次抽签即生效；
   * 测试注入内存版控制名单）。返回空 Map 时角色链路整体静默。
   */
  loadPersonas?: () => Map<string, CharacterPersona>;
  /** 反应队列持久化路径（缺省 userData/moments-reaction-queue.json；测试注入临时文件） */
  reactionQueueFilePath?: string | (() => string);
  /** 时钟（延迟计算与在线感知用；缺省真实时间） */
  now?: () => number;
  /** 延迟抽签随机源（缺省 Math.random） */
  random?: () => number;
  log?: (event: string, detail?: unknown) => void;
}

export function createMomentsService(deps: MomentsServiceDeps): MomentsService {
  // 角色注册表：注入优先；缺省每次读盘（md 随时可改，无需重启生效）
  const loadPersonas = deps.loadPersonas
    ?? (() => loadCharacterPersonas({ log: (event, detail) => deps.log?.(event, detail) }));

  const agent: MomentsAgent = createMomentsAgent({
    buildPersona: deps.buildPersona,
    runModel: deps.runModel,
    commitPost: async (input) => {
      const result = await deps.store.createCyrenePost(input);
      // 昔涟发帖成功后同样进角色抽签池：角色们也会刷到她的动态
      if (result.applied) scheduleCharacterPostReactions(result.value);
      return result;
    },
    loadFeedItem: (postId) => deps.store.getFeedItem(postId),
    matchMedia: deps.matchMedia ?? (async () => null),
    buildWorldbookContext: deps.buildWorldbookContext,
    buildPluginPromptContext: deps.buildPluginPromptContext,
    loadPostImages: deps.loadPostImages,
    log: deps.log,
  });

  const loadPolicyState = deps.loadPolicyState ?? loadMomentsPolicyState;
  const savePolicyState = deps.savePolicyState ?? saveMomentsPolicyState;
  const now = deps.now ?? Date.now;
  const random = deps.random ?? Math.random;

  // per-conversation ring buffer：MomentEvent.summary 的原料（内存态，V1 从简不落盘）
  const conversationTurns = new Map<string, ConversationSummaryTurn[]>();

  function postingEnabled(): boolean {
    const settings = deps.loadGeneralSettings();
    return settings.momentsEnabled && settings.cyreneMomentsPostingEnabled;
  }

  function reactionsEnabled(): boolean {
    const settings = deps.loadGeneralSettings();
    return settings.momentsEnabled && settings.cyreneMomentsReactionsEnabled;
  }

  /** 角色链路闸门：朋友圈总开关 + 角色互动开关，两者都开角色才刷朋友圈。 */
  function characterReactionsEnabled(): boolean {
    const settings = deps.loadGeneralSettings();
    return settings.momentsEnabled && settings.momentsCharacterReactionsEnabled;
  }

  /** 热闹程度档位：抽签分布与日调用上限共用，每次现读保证切换即时生效。 */
  function currentLiveliness(): MomentsLiveliness {
    return deps.loadGeneralSettings().momentsLiveliness ?? "quiet";
  }

  /**
   * 昔涟表态落库：点赞走昔涟点赞通道，评论/回复走昔涟评论通道——
   * 评论一律携带任务 id（sourceTaskId）幂等落库，崩溃重跑不重复写入
   * （store 串行队列内含开关与目标存在性复核，AI 思考期间世界变化不豁免）。
   */
  async function cyreneApply(task: ReactionTask, decision: ReactionDecision): Promise<void> {
    if (decision.action === "like" || decision.action === "like_comment") {
      await deps.store.createCyreneLike(task.postId);
    }
    if (decision.action === "comment" || decision.action === "like_comment" || decision.action === "reply") {
      const result = await deps.store.createComment(
        {
          postId: task.postId,
          content: decision.comment,
          replyTo: task.kind === "reply_eval" ? task.triggerCommentId : undefined,
        },
        "cyrene",
        { sourceTaskId: task.id },
      );
      // 评论落库后续接互动链：她回复的可能是角色评论，角色还等着回她
      if (result.applied) ensureFollowUpScheduled(result.value);
    }
  }

  /**
   * 昔涟在线感知：任何会话的最近一次收尾距今不足 10 分钟即在线。
   * ring buffer 是内存态，重启后视为离线——保守但正确。
   */
  function isCyreneOnline(): boolean {
    let latest = 0;
    for (const turns of conversationTurns.values()) {
      const last = turns[turns.length - 1];
      if (last && last.at > latest) latest = last.at;
    }
    return latest > 0 && now() - latest < CYRENE_ONLINE_WINDOW_MS;
  }

  /**
   * 昔涟任务到期时间：在线走短延迟且不受深夜窗口影响（用户正和她聊天，
   * 凌晨三点她就是醒着的）；离线走长尾分桶，且入队落在深夜时段时整体
   * 推迟到次日早晨，避免半夜刷朋友圈。
   */
  function computeCyreneDueAt(kind: "post_eval" | "reply_eval"): number {
    const online = isCyreneOnline();
    const delayMs = kind === "post_eval"
      ? computeCyrenePostDelayMs(online, random)
      : computeCyreneReplyDelayMs(online, random);
    const dueAt = now() + delayMs;
    return online ? dueAt : applyNightWindow(dueAt, new Date(now()), random);
  }

  /**
   * 角色任务到期时间：表态与随机点赞同表（秒赞同样穿帮，延迟是拟人感的来源），
   * 回复整体更快但同样长尾；角色没有"在线"概念，深夜窗口恒生效。
   */
  function computeCharacterDueAt(kind: "post_eval" | "reply_eval" | "auto_like"): number {
    const delayMs = kind === "reply_eval"
      ? computeCharacterReplyDelayMs(random)
      : computeCharacterPostDelayMs(random);
    return applyNightWindow(now() + delayMs, new Date(now()), random);
  }

  /** 入队（含落盘异常兜底）：反应是锦上添花，磁盘故障只记日志不阻断调用方 */
  function enqueueReactionTask(input: {
    kind: "post_eval" | "reply_eval" | "auto_like";
    actor: string;
    postId: string;
    triggerCommentId?: string;
    mentioned?: boolean;
    dueAt: number;
  }): void {
    try {
      reactionQueue.enqueue(input);
    } catch (error) {
      deps.log?.("reaction_enqueue_failed", error instanceof Error ? error.message : String(error));
    }
  }

  function enqueueCyreneReaction(input: {
    kind: "post_eval" | "reply_eval";
    postId: string;
    triggerCommentId?: string;
  }): void {
    enqueueReactionTask({ actor: "cyrene", dueAt: computeCyreneDueAt(input.kind), ...input });
  }

  /** 昔涟表态决策：闸门复核后委托 agent（agent 内含目标重读与模型调用） */
  async function cyreneDecide(task: ReactionTask): Promise<ReactionDecideOutcome> {
    // 执行时复核闸门：入队时通过不代表到期时仍通过，世界已变则任务作废
    if (!reactionsEnabled()) return { type: "stale", reason: "reactions_disabled" };
    if (deps.loadVendorConfig() === null) return { type: "stale", reason: "model_not_configured" };
    if (task.kind === "post_eval") return agent.decideUserPostReaction(task.postId, task.mentioned === true);
    if (task.kind === "reply_eval") {
      // 回复任务必带触发评论 id：缺失视为数据损坏，作废任务
      if (!task.triggerCommentId) return { type: "stale", reason: "missing_trigger_comment" };
      // 执行时复核回复链深度：入队后评论区可能继续生长，落点已超上限则收束
      const feed = deps.store.getFeedItem(task.postId);
      if (feed && !withinReplyDepthLimit(feed.comments, task.triggerCommentId)) {
        return { type: "stale", reason: "reply_depth_exceeded" };
      }
      return agent.decideCommentReply(task.postId, task.triggerCommentId);
    }
    return { type: "stale", reason: "unknown_task_kind" };
  }

  /**
   * 角色任务的世界复核：注册表、总开关、模型配置、目标动态，任一不过即作废。
   * 注册表每次现读——人设 md 随时可改，角色被移除后旧任务自然失效。
   */
  function characterWorldCheck(task: ReactionTask):
    | { ok: true; feed: NonNullable<ReturnType<MomentsStoreFacade["getFeedItem"]>>; persona: CharacterPersona }
    | { ok: false; outcome: ReactionDecideOutcome } {
    const persona = loadPersonas().get(task.actor);
    if (!persona) return { ok: false, outcome: { type: "stale", reason: "unknown_actor" } };
    if (!characterReactionsEnabled()) return { ok: false, outcome: { type: "stale", reason: "character_reactions_disabled" } };
    if (deps.loadVendorConfig() === null) return { ok: false, outcome: { type: "stale", reason: "model_not_configured" } };
    const feed = deps.store.getFeedItem(task.postId);
    if (!feed) return { ok: false, outcome: { type: "stale", reason: "post_not_found" } };
    return { ok: true, feed, persona };
  }

  /**
   * 角色模型调用预算闸门：到达日上限时返回作废结果，有余量则先记账再放行。
   * 记账在调用前完成——请求本身可能失败重试，重试也是真实调用，同样占预算；
   * 随机点赞零模型成本，不经过这里。
   * 点名任务豁免：用户主动 @ 的回应不占自然配额，也不能因配额用尽而"叫不应"。
   */
  function spendCharacterModelCall(mentioned: boolean): ReactionDecideOutcome | null {
    if (mentioned) return null;
    const state = loadPolicyState();
    if (!canCharacterModelCall(state, now(), currentLiveliness())) {
      return { type: "stale", reason: "character_daily_model_limit" };
    }
    savePolicyState(recordCharacterModelCall(state, now()));
    return null;
  }

  /**
   * 角色表态决策：组装角色卡 + 朋友圈记忆 + 评论区上下文调模型，
   * 解析为队列统一决策形态。普通任务输出非法按 invalid 降级 silent；
   * 点名任务解析失败按 retry 退避重问，耗尽后由队列落兜底文案保证必回。
   */
  async function characterDecide(task: ReactionTask): Promise<ReactionDecideOutcome> {
    const check = characterWorldCheck(task);
    if (!check.ok) return check.outcome;
    const { feed, persona } = check;

    const worldbookSource = [
      feed.post.title ?? "",
      feed.post.text,
      // 回复场景把评论文本也纳入关键词扫描：设定命中依赖具体讨论内容
      ...(task.kind === "reply_eval" ? feed.comments.map((comment) => comment.content) : []),
    ].filter(Boolean).join("\n");
    const baseInput = {
      persona,
      worldbook: deps.buildWorldbookContext?.(worldbookSource) ?? "",
      timeline: deps.store.getCharacterTimeline(persona.nickname),
      post: feed.post,
      postImages: deps.loadPostImages?.(feed.post),
      comments: feed.comments,
      localNow: new Date(now()),
    };

    if (task.kind === "post_eval") {
      const gated = spendCharacterModelCall(task.mentioned === true);
      if (gated) return gated;
      const output = await deps.runModel(buildCharacterPostEvalMessages({
        ...baseInput,
        mentioned: task.mentioned === true,
      }));
      if (output.kind !== "text") return { type: "retry", reason: output.reason };
      // 点名任务只接受带评论的输出（点赞由落库层强制），普通任务保留完整决策。
      // 点名解析失败按 retry 退避重问，重试耗尽由队列落兜底文案，保证"必回"。
      const decision = task.mentioned === true
        ? parseCharacterMentionDecision(output.text)
        : parseCharacterPostDecision(output.text);
      if (decision.action === "invalid") {
        return task.mentioned === true
          ? { type: "retry", reason: decision.reason }
          : { type: "invalid", reason: decision.reason };
      }
      return { type: "decided", decision };
    }

    if (task.kind === "reply_eval") {
      // 回复任务必带触发评论 id；触发评论已删（世界已变）则作废
      if (!task.triggerCommentId) return { type: "stale", reason: "missing_trigger_comment" };
      if (!feed.comments.some((comment) => comment.id === task.triggerCommentId)) {
        return { type: "stale", reason: "trigger_comment_not_found" };
      }
      // 执行时复核回复链深度：入队后评论区可能继续生长，落点已超上限则收束
      if (!withinReplyDepthLimit(feed.comments, task.triggerCommentId)) {
        return { type: "stale", reason: "reply_depth_exceeded" };
      }
      const gated = spendCharacterModelCall(false);
      if (gated) return gated;
      const output = await deps.runModel(buildCharacterReplyEvalMessages({
        ...baseInput,
        replyTargetId: task.triggerCommentId,
      }));
      if (output.kind !== "text") return { type: "retry", reason: output.reason };
      const decision = parseCharacterReplyDecision(output.text);
      if (decision.action === "invalid") return { type: "invalid", reason: decision.reason };
      return { type: "decided", decision };
    }

    return { type: "stale", reason: "unknown_task_kind" };
  }

  /**
   * 角色表态落库：点赞走角色点赞通道；评论走角色评论通道并携带任务 id 幂等。
   * 评论落库后无论 created 还是 already_applied（崩溃重跑）都续接后续调度——
   * already_applied 若被当作"无事可做"，"评论已落库但后续事件未入队"的
   * 崩溃窗口会让互动链永久断裂。
   */
  async function characterApply(task: ReactionTask, decision: ReactionDecision): Promise<void> {
    if (decision.action === "like" || decision.action === "like_comment") {
      await deps.store.createCharacterLike(task.actor, task.postId);
    }
    if (decision.action === "comment" || decision.action === "like_comment" || decision.action === "reply") {
      const result = await deps.store.createCharacterComment(task.actor, {
        postId: task.postId,
        content: decision.comment,
        replyTo: task.kind === "reply_eval" ? task.triggerCommentId : undefined,
        sourceTaskId: task.id,
      });
      if (result.status === "rejected") {
        // 目标已删/开关已关：评论没有落库，无后续可续接
        deps.log?.("character_comment_rejected", { taskId: task.id, actor: task.actor, reason: result.reason });
        return;
      }
      ensureFollowUpScheduled(result.comment);
    }
  }

  // 反应执行器：昔涟与角色共用一条队列，按 actor 分发各自的决策与落库逻辑。
  const reactionExecutor: ReactionTaskExecutor = {
    decide: (task) => (task.actor === "cyrene" ? cyreneDecide(task) : characterDecide(task)),
    apply: async (task, decision) => {
      if (task.actor === "cyrene") await cyreneApply(task, decision);
      else await characterApply(task, decision);
    },
  };

  const reactionQueue: ReactionQueue = createReactionQueue({
    filePath: deps.reactionQueueFilePath ?? defaultReactionQueueFilePath,
    executor: reactionExecutor,
    now,
    log: (event, detail) => deps.log?.(event, detail),
  });

  /** 闸门前置（省一次落盘）：开关关闭或模型未配置时连任务都不入队 */
  function reactionGateOpen(): boolean {
    return reactionsEnabled() && deps.loadVendorConfig() !== null;
  }

  /**
   * 回复任务入队前统一闸门：按主体分别复核开关与模型配置，再过回复链
   * 深度闸门——AI 自主接龙到深度上限时收束，等用户插话开启新链。
   */
  function enqueueReplyEval(
    actor: string,
    trigger: MomentComment,
    comments: readonly MomentComment[],
  ): void {
    if (actor === "cyrene") {
      if (!reactionGateOpen()) return;
    } else {
      // 角色回复走模型：角色开关与模型配置缺一不可
      if (!characterReactionsEnabled()) return;
      if (deps.loadVendorConfig() === null) return;
    }
    if (!withinReplyDepthLimit(comments, trigger.id)) return;
    enqueueReactionTask({
      kind: "reply_eval",
      actor,
      postId: trigger.postId,
      triggerCommentId: trigger.id,
      dueAt: actor === "cyrene" ? computeCyreneDueAt("reply_eval") : computeCharacterDueAt("reply_eval"),
    });
  }

  /**
   * 评论落库后的续接调度：任何新落库的评论都可能开启下一段互动——
   * 昔涟动态下的他人评论（或回复昔涟的评论）给昔涟入回复任务；
   * 回复目标是角色评论的给该角色入回复任务。
   * 用户、昔涟、角色的评论统一走这里，触发规则一份代码三处复用。
   */
  function ensureFollowUpScheduled(comment: MomentComment): void {
    const feed = deps.store.getFeedItem(comment.postId);
    if (!feed) return;
    const personas = loadPersonas();
    const isCharacterAuthor = (author: string) =>
      author !== "user" && author !== "cyrene" && personas.has(author);

    // 昔涟的动态下有人说话：她可能回应（自己的评论除外，不自问自答）
    if (feed.post.author === "cyrene" && comment.author !== "cyrene") {
      enqueueReplyEval("cyrene", comment, feed.comments);
    }
    // 回复目标是他人的评论：被回复者可能回话
    if (comment.replyTo) {
      const target = feed.comments.find((candidate) => candidate.id === comment.replyTo);
      if (target && target.author !== comment.author) {
        if (target.author === "cyrene" && comment.author !== "cyrene") {
          enqueueReplyEval("cyrene", comment, feed.comments);
        } else if (isCharacterAuthor(target.author)) {
          enqueueReplyEval(target.author, comment, feed.comments);
        }
      }
    }
  }

  /**
   * 角色抽签入队：先抽几位刷到（零人 = 合法冷场），再按活跃度加权抽人，
   * 每位抽中者独立掷双骰分流——评论骰中走模型表态，未中再掷点赞骰，
   * 中则零模型成本随机点赞，都未中即刷到但划走。
   * 用户动态另有特别关注通道：声明 presence 的角色先掷专骰，命中即直接
   * 刷到（额外候选，不占抽签名额，骰不中仍可被普通抽签抽中）。
   * 掷骰在入队瞬间一次定型，到期执行不重掷——延迟期间世界的任何
   * 变化都不改变骰子结果，行为可预测可测试。
   */
  function scheduleCharacterPostReactions(post: MomentPost, exclude: ReadonlySet<string> = new Set()): void {
    if (!characterReactionsEnabled()) return;
    // 已被点名直达的角色不参与抽签：同一人挂两条表态任务没有意义
    const personas = [...loadPersonas().values()].filter((persona) => !exclude.has(persona.nickname));
    if (personas.length === 0) return;

    // 特别关注骰只对用户动态掷：角色间的关系亲疏不适用这条通道
    const spotlit = post.author === "user"
      ? personas.filter((persona) => persona.presenceDice > 0 && random() < persona.presenceDice)
      : [];
    const rest = personas.filter((persona) => !spotlit.includes(persona));

    const candidateCount = pickCandidateCount(currentLiveliness(), random);
    const candidates = candidateCount === 0 && spotlit.length === 0
      ? []
      : [...spotlit, ...pickWeightedCandidates(rest, candidateCount, random)];

    // 已点赞者跳过：再掷也赞不了第二次，模型表态的点赞路径同样作废
    const feed = deps.store.getFeedItem(post.id);
    const likedActors = new Set((feed?.likes ?? []).map((reaction) => reaction.actor));

    for (const persona of candidates) {
      if (likedActors.has(persona.nickname)) continue;
      const outcome = rollReactionDice(persona, random);
      if (outcome === "silent") continue;
      // 模型表态任务需要模型配置；随机点赞零模型成本，不受模型闸门限制
      if (outcome === "post_eval" && deps.loadVendorConfig() === null) continue;
      enqueueReactionTask({
        kind: outcome,
        actor: persona.nickname,
        postId: post.id,
        dueAt: computeCharacterDueAt(outcome),
      });
    }
  }

  function scheduleUserPostReaction(post: MomentPost): void {
    // 点名直达：@ 的人不掷抽签与双骰，直接走模型表态 + 秒回延迟。
    // 名单在入队前过滤为合法主体（昔涟或注册角色），手滑写的名字静默忽略。
    const personas = loadPersonas();
    const mentionedCyrene = post.mentions?.includes("cyrene") ?? false;
    const mentionedCharacters = [...new Set(post.mentions ?? [])]
      .filter((name): name is string => name !== "cyrene" && personas.has(name));

    if (mentionedCyrene && reactionGateOpen() && deps.loadVendorConfig() !== null) {
      enqueueReactionTask({
        kind: "post_eval",
        actor: "cyrene",
        postId: post.id,
        mentioned: true,
        // 秒回档不套深夜窗口：用户半夜 @ 昔涟，说明醒着在等她
        dueAt: now() + computeMentionDelayMs(random),
      });
    } else if (reactionGateOpen()) {
      enqueueCyreneReaction({ kind: "post_eval", postId: post.id });
    }

    for (const nickname of mentionedCharacters) {
      // 点名任务零门槛：开关照常复核（执行时 stale），但不需要模型配置预检
      // 之外的抽签/双骰——被点名不回应很失礼，说什么由模型按人设决定
      enqueueReactionTask({
        kind: "post_eval",
        actor: nickname,
        postId: post.id,
        mentioned: true,
        dueAt: now() + computeMentionDelayMs(random),
      });
    }

    // 角色抽签自带闸门：昔涟反应关闭不影响角色刷到（两条独立链路）；
    // 已被点名直达的角色从抽签池排除，避免同一人挂两条表态任务
    scheduleCharacterPostReactions(post, new Set(mentionedCharacters));
  }

  /** run 成功收尾：记录 ring buffer → 设置/去重闸门（LLM 前）→ 入队生成。 */
  function scheduleTurn(input: MomentsTurnInput): void {
    // ring buffer 永远记录：后续事件的摘录需要这段上下文，与发帖闸门无关
    const turns = [...(conversationTurns.get(input.conversationId) ?? []), {
      user: input.userText,
      assistant: input.assistantReply,
      at: input.finishedAt,
    }].slice(-RING_BUFFER_MAX_TURNS);
    conversationTurns.set(input.conversationId, turns);

    // 设置闸门前置（省 token）：总开关 + 主动发帖开关 + 模型配置
    if (!postingEnabled()) return;
    if (deps.loadVendorConfig() === null) return;

    // run 粒度去重：同一事件重复到达直接丢弃，键在到达时立即记录
    const eventKey = buildMomentsEventKey(input);
    const state = loadPolicyState();
    if (state.recentEventKeys.includes(eventKey)) return;
    savePolicyState(recordEventKey(state, eventKey));

    // 摘要在事件到达时冻结（快照语义，契约 1）；会话归属同批捕获——
    // 任务执行时只读这份快照，不重读当前会话状态
    const summary = buildConversationSummary(turns);
    const { conversationId, channel } = input;
    deps.enqueueTask("MomentsPost", async () => {
      // 执行时复核冷却与日上限：闸门通过到任务执行之间，世界可能已变
      const gate = canPost(loadPolicyState(), now());
      if (!gate.ok) {
        deps.log?.("post_gated", gate.reason);
        return;
      }
      const recentCyrenePosts = deps.store.listFeed({ limit: 100 })
        .map((item) => item.post)
        .filter((post) => post.author === "cyrene")
        .slice(0, RECENT_CYRENE_POSTS_FOR_NOVELTY);
      const posted = await agent.generatePost({ summary, recentCyrenePosts, conversationId, channel });
      if (posted) savePolicyState(recordPost(loadPolicyState(), now()));
    }).catch((error) => {
      deps.log?.("post_task_failed", error instanceof Error ? error.message : String(error));
    });
  }

  return {
    listFeed: (options) => deps.store.listFeed(options),
    getFeedItem: (postId) => deps.store.getFeedItem(postId),

    createUserPost: (input) => {
      // 点名白名单过滤：只保留昔涟与注册角色，渲染端传来的其他名字一律丢弃
      // （mentions 决定调度行为，不能信任渲染端输入；文本本身不受影响）
      const legal = new Set<string>(["cyrene", ...loadPersonas().keys()]);
      const mentions = [...new Set(input.mentions ?? [])].filter((name) => legal.has(name));
      return deps.store.createUserPost(mentions.length > 0 ? { ...input, mentions } : { ...input, mentions: undefined })
        .then((result) => {
          if (result.applied) scheduleUserPostReaction(result.value);
          return result;
        });
    },

    deletePost: (postId) => deps.store.deletePost(postId),

    createUserComment: (input) =>
      deps.store.createComment(input, "user").then((result) => {
        // 用户评论落库后续接：在昔涟动态下说话、回复昔涟或回复角色都可能引来回应
        if (result.applied) ensureFollowUpScheduled(result.value);
        return result;
      }),

    toggleUserLike: (postId) => deps.store.toggleLike(postId, "user"),

    // ── 聊天工具通道 ──────────────────────────────────────────
    // 昔涟在对话中主动使用朋友圈：即时落库不走反应延迟（她正和用户聊天，
    // "当场发"才自然）；闸门沿用提交时复核，设置关闭时返回可读原因。
    // 发帖成功后照常进角色抽签池，评论落库后续接互动链。

    cyreneCreatePostFromTool: async (input) => {
      const result = await deps.store.createCyrenePost({
        title: input.title,
        text: input.text,
      });
      if (result.applied) scheduleCharacterPostReactions(result.value);
      return result;
    },

    cyreneLikeFromTool: (postId) =>
      deps.store.createCyreneLike(postId).then((result) => {
        // 手动点赞 = 她已经刷到并表态过：取消该动态下她所有待执行的自动任务，
        // 防止 20 分钟后自动表态再冒出一条重复评论
        reactionQueue.cancelTasks({ actor: "cyrene", postId });
        return result;
      }),

    cyreneCommentFromTool: (input) =>
      deps.store.createComment(input, "cyrene").then((result) => {
        // 手动评论同理：她在聊天里当场说过话了，自动任务全部作废
        if (result.applied) {
          reactionQueue.cancelTasks({ actor: "cyrene", postId: input.postId });
          // 她回复的可能是角色评论：被回复的角色还等着回她，链路照常续接
          ensureFollowUpScheduled(result.value);
        }
        return result;
      }),

    scheduleTurn,

    startReactionScanner: () => reactionQueue.start(),
    stopReactionScanner: () => reactionQueue.stop(),
    drainReactionQueue: () => reactionQueue.drainOnce(),
  };
}
// ── 配图匹配：贴图 embedding 索引由组合根晚绑定 ─────────────────

let getStickerEmbeddingIndex: () => StickerEmbeddingEntry[] | null = () => null;

/**
 * 组合根注册贴图索引 getter（EmbeddingIndexService 实例在
 * default-dependencies 内创建，模块单例无法静态引用，启动时注入）。
 * 未注册 / 索引未就绪时 matchMedia 返回 null——纯文字降级。
 */
export function registerMomentsMediaMatcher(deps: {
  getStickerIndex: () => StickerEmbeddingEntry[] | null;
}): void {
  getStickerEmbeddingIndex = deps.getStickerIndex;
}

// ── 具体装配（组合根 / IPC 直接使用） ───────────────────────────

/** 人设四件套，与主动聊天共用同源 prompt 文件，且不含工具说明。 */
function buildMomentsPersonaPrompt(): string {
  const parts: string[] = [];
  const chatSystem = loadPromptFile("chat_system.md");
  if (chatSystem) parts.push(chatSystem);
  const soul = loadPromptFile("soul.md");
  if (soul) {
    // 朋友圈场景不携带 Live2D 章节
    parts.push(soul.split("\n## Live2D 与聊天文字的分工")[0].trim());
  }
  const canon = loadPromptFile("canon_quotes.md");
  if (canon) parts.push(canon);
  const style = loadPromptFile("styles/01_default.md");
  if (style) parts.push(style);
  return parts.join("\n\n---\n\n");
}

function loadMomentsVendorConfig(): VendorConfig | null {
  const settings = loadModelSettings();
  if (!settings.apiKey) return null;
  return {
    provider: settings.provider,
    baseUrl: settings.baseUrl,
    model: settings.model,
    apiKey: settings.apiKey,
    explicitTransport: settings.explicitTransport,
    reasoning: settings.reasoning,
  };
}

/** 反应队列持久化文件：与 moments.json / moments-state.json 同目录但独立成文件，职责互不重叠 */
function defaultReactionQueueFilePath(): string {
  return path.join(app.getPath("userData"), "moments-reaction-queue.json");
}

/**
 * 具体配图匹配闭包：embedding provider + 晚绑定贴图索引 + 设置里的相似度阈值。
 * provider / 索引任一未就绪或分数未达阈值都返回 null——纯文字降级，不硬凑图。
 */
export function createMomentsMediaMatcher(): (query: string) => Promise<MomentMedia | null> {
  return async (query) => {
    const provider = getEmbeddingProvider();
    const index = getStickerEmbeddingIndex();
    if (!provider || !index) return null;
    const matched = await matchSticker(
      query,
      provider,
      index,
      loadModelSettings().stickerSimilarityThreshold,
    );
    if (!matched) return null;
    // 命中贴图后解析成渲染端可消费的媒体引用；贴图已被删除时降级纯文字
    return resolveMomentStickerMedia(matched.id);
  };
}

/**
 * 具体 worldbook 注入闭包：常驻条目全量 + 文本关键词命中条目，按优先级合并。
 * 供 Moments 各 LLM 调用注入设定（纯关键词触发，不走 DMAE 打分）。
 */
export function buildMomentsWorldbookContext(text: string): string {
  const parts = [...getPermanentWorldbookEntries(), ...getKeywordMatchedWorldbookEntries(text)];
  if (parts.length === 0) return "";
  return `[相关设定]\n${parts.join("\n\n")}`;
}

/**
 * 具体图片读取闭包：用户动态的 user_attachment 副本转 base64 dataUrl，
 * 直发多模态主模型；读取失败降级文字说明，不阻断反应流程。
 * character_asset 是昔涟自己的配图素材，不作为视觉输入。
 */
export function loadUserMomentPostImages(post: MomentPost): MomentPostImage[] {
  // 图片路由统一收口在 image-router。moments 只直发不转述：
  // direct 照常带图；caption（纯文本主模型 + 已配独立视觉模型）维持不带图现状；
  // reject（纯文本主模型 + 未配视觉模型）给出人话错误而非静默丢图。
  const settings = loadModelSettings();
  const route = settings ? resolveImageRoute("moments", settings) : { mode: "direct" as const };
  const hasUserImage = post.media.some((media) => media.origin === "user_attachment");
  if (route.mode === "reject") {
    return hasUserImage ? [{ name: "动态配图", error: route.reason }] : [];
  }
  if (route.mode !== "direct") return [];
  const images: MomentPostImage[] = [];
  for (const media of post.media) {
    if (media.origin !== "user_attachment") continue;
    const filePath = path.join(momentsStore.getMomentsMediaRootDir(), post.id, media.ref);
    const validated = validateCaptionImagePath(filePath);
    if (validated.ok) {
      images.push({
        name: media.ref,
        dataUrl: `data:${validated.mime};base64,${validated.buffer.toString("base64")}`,
      });
    } else {
      images.push({ name: media.ref, error: validated.error });
    }
  }
  return images;
}

export const momentsService: MomentsService = createMomentsService({
  store: momentsStore,
  loadGeneralSettings,
  loadVendorConfig: loadMomentsVendorConfig,
  matchMedia: createMomentsMediaMatcher(),
  buildWorldbookContext: buildMomentsWorldbookContext,
  // 插件提示词上下文（moments-post 场景）：registry 自带超时/长度/防注入收口，这里只转发
  buildPluginPromptContext: (input) => pluginPromptRegistry.build(input),
  loadPostImages: loadUserMomentPostImages,
  buildPersona: buildMomentsPersonaPrompt,
  // 角色注册表：立绘池 ∩ 人设 md，md 随时可改，每次抽签/执行前现读；
  // 每次加载顺带同步 store 的角色写入名单——service 抽到谁、store 就认谁，
  // 运行中新增人设 md 无需重启即可落库
  loadPersonas: () => {
    const personas = loadCharacterPersonas({
      log: (event, detail) => console.log(`[Moments] ${event}`, detail ?? ""),
    });
    momentsStore.setCharacterAuthorRegistry(new Set(personas.keys()));
    return personas;
  },
  enqueueTask: (label, task) => enqueueLLMTask(label, task),
  runModel: async (messages) => {
    const config = loadMomentsVendorConfig();
    if (!config) return { kind: "error", reason: "missing_api_key" };
    return runMomentsModel({
      settings: config,
      messages,
      timeoutMs: MOMENTS_MODEL_TIMEOUT_MS,
    });
  },
  log: (event, detail) => console.log(`[Moments] ${event}`, detail ?? ""),
});