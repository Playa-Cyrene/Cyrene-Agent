// Moments（动态 / 朋友圈）持久化存储。
//
// 布局：
//   <userData>/moments.json               — MomentsStoreData（posts/comments/reactions）
//   <userData>/moments-media/<postId>/    — 用户上传图片副本（随 post 级联删除）
//
// 设计（照 chats-store 模式）：
// - 读走内存缓存（initialize() 时一次性加载），写走 promise 尾链串行队列；
// - 每次写："校验 → 变更 → 原子落盘（.tmp + rename）→ 通知变更"；
// - 提交时校验：AI 异步产物返回时目标可能已删除、开关可能已关闭，不因"已决定"而豁免；
// - 删除 post 级联删除 comments / reactions / 图片副本。

import { app } from "electron";
import { randomUUID } from "crypto";
import * as fs from "fs";
import * as path from "path";
import {
  MOMENT_ALLOWED_IMAGE_MIME,
  MOMENT_MAX_COMMENT_TEXT_LENGTH,
  MOMENT_MAX_IMAGE_BYTES,
  MOMENT_MAX_IMAGES_PER_POST,
  MOMENT_MAX_POST_TEXT_LENGTH,
  MOMENT_MAX_POST_TITLE_LENGTH,
  type ApplyCommentResult,
  type CharacterTimeline,
  type MomentAuthor,
  type MomentComment,
  type MomentCommitResult,
  type MomentCreateCommentInput,
  type MomentCreatePostInput,
  type MomentFeedItem,
  type MomentMedia,
  type MomentPost,
  type MomentPostSource,
  type MomentsStoreData,
} from "../../shared/moments-types";

const STORE_FILE_NAME = "moments.json";
const MEDIA_ROOT_DIR_NAME = "moments-media";
const CURRENT_SCHEMA_VERSION = 2;

const MIME_TO_EXT: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
};

let storePath = "";
let mediaRootDir = "";
let cache: MomentsStoreData | null = null;
let tail: Promise<unknown> = Promise.resolve();
const changeListeners = new Set<() => void>();

/** 昔涟在 Feed 内的行为种类，提交时按种类复核对应开关。 */
export type CyreneMomentBehavior = "reaction" | "posting";

/**
 * 昔涟行为开关（默认全放行）。IPC 注册时注入真实读取逻辑；
 * 检查发生在串行队列内的提交时刻，AI 思考期间关闭开关时迟到的结果不豁免。
 */
let cyreneBehaviorGate: (behavior: CyreneMomentBehavior) => boolean = () => true;

/** 注册昔涟行为开关检查（moments-ipc 注入，读取 general settings）。 */
export function setCyreneBehaviorGate(gate: (behavior: CyreneMomentBehavior) => boolean): void {
  cyreneBehaviorGate = gate;
}

/**
 * 角色行为开关（默认全放行，settings 就绪后由 IPC 层注入真实读取）。
 * 与昔涟开关分离：用户可以单独关掉角色互动而保留昔涟反应。
 */
let characterBehaviorGate: () => boolean = () => true;

/** 注册角色行为开关检查。 */
export function setCharacterBehaviorGate(gate: () => boolean): void {
  characterBehaviorGate = gate;
}

/**
 * 入驻朋友圈的角色名单（角色注册表注入）。
 * store 只信任注入名单内的 author——渲染端无法伪造角色身份写库。
 */
let knownCharacterAuthors = new Set<string>();

/** 注册角色名单（角色注册表就绪后注入；名单变更可重复注入）。 */
export function setCharacterAuthorRegistry(names: ReadonlySet<string>): void {
  knownCharacterAuthors = new Set(names);
}

/** 校验 author 合法：user / cyrene / 注册表内角色。 */
function isValidAuthor(author: string): boolean {
  return author === "user" || author === "cyrene" || knownCharacterAuthors.has(author);
}

export function initialize(): void {
  if (cache) return;
  const userData = app.getPath("userData");
  storePath = path.join(userData, STORE_FILE_NAME);
  mediaRootDir = path.join(userData, MEDIA_ROOT_DIR_NAME);
  fs.mkdirSync(mediaRootDir, { recursive: true });
  cache = loadFromDisk();
}

/** moments-media 根目录（moment-media:// 协议解析用；未初始化时先初始化）。 */
export function getMomentsMediaRootDir(): string {
  initialize();
  return mediaRootDir;
}

export function onMomentsChanged(listener: () => void): () => void {
  changeListeners.add(listener);
  return () => {
    changeListeners.delete(listener);
  };
}

function notifyChanged(): void {
  for (const listener of changeListeners) {
    try {
      listener();
    } catch {
      // 单个监听器异常不影响其他监听器与主流程
    }
  }
}

function emptyStore(): MomentsStoreData {
  return { schemaVersion: CURRENT_SCHEMA_VERSION, posts: [], comments: [], reactions: [] };
}

function loadFromDisk(): MomentsStoreData {
  if (!fs.existsSync(storePath)) return emptyStore();
  try {
    const parsed = JSON.parse(fs.readFileSync(storePath, "utf8")) as Partial<MomentsStoreData>;
    return {
      schemaVersion: CURRENT_SCHEMA_VERSION,
      posts: Array.isArray(parsed.posts) ? parsed.posts : [],
      comments: Array.isArray(parsed.comments) ? parsed.comments : [],
      reactions: Array.isArray(parsed.reactions) ? parsed.reactions : [],
    };
  } catch {
    return emptyStore();
  }
}

function persist(): void {
  const tmpPath = storePath + ".tmp";
  fs.writeFileSync(tmpPath, JSON.stringify(cache, null, 2), "utf8");
  fs.renameSync(tmpPath, storePath);
}

function enqueue<T>(task: () => T | Promise<T>): Promise<T> {
  const next = tail.then(task);
  tail = next.catch(() => {
    // 单个任务失败不阻塞后续队列
  });
  return next;
}

function requireCache(): MomentsStoreData {
  if (!cache) throw new Error("[Moments] store 未初始化");
  return cache;
}

// ── 读（内存缓存，无锁） ────────────────────────────────────────

function assembleFeedItem(store: MomentsStoreData, post: MomentPost): MomentFeedItem {
  const comments = store.comments
    .filter((comment) => comment.postId === post.id)
    .sort((a, b) => a.createdAt - b.createdAt);
  const likes = store.reactions
    .filter((reaction) => reaction.postId === post.id)
    .sort((a, b) => a.createdAt - b.createdAt);
  return { post, comments, likes };
}

export function listFeed(options: { limit?: number; before?: number } = {}): MomentFeedItem[] {
  const store = requireCache();
  const limit = Math.max(1, Math.min(options.limit ?? 20, 100));
  const before = options.before;
  return store.posts
    .map((post, index) => ({ post, index }))
    .filter(({ post }) => (typeof before === "number" ? post.createdAt < before : true))
    // createdAt 相同（同毫秒）时按插入顺序倒序，保证后创建的动态稳定排在前面
    .sort((a, b) => b.post.createdAt - a.post.createdAt || b.index - a.index)
    .slice(0, limit)
    .map(({ post }) => assembleFeedItem(store, post));
}

export function getFeedItem(postId: string): MomentFeedItem | null {
  const store = requireCache();
  const post = store.posts.find((candidate) => candidate.id === postId);
  return post ? assembleFeedItem(store, post) : null;
}

// ── 写（串行队列 + 提交时校验） ─────────────────────────────────

export function createUserPost(input: MomentCreatePostInput): Promise<MomentCommitResult<MomentPost>> {
  return enqueue(() => commitCreatePost("user", input));
}

/** 昔涟发帖：内部通道，不经 IPC（renderer 无法伪造 cyrene 身份）。 */
export function createCyrenePost(input: {
  title?: string;
  text: string;
  media?: MomentMedia[];
  source?: MomentPostSource;
}): Promise<MomentCommitResult<MomentPost>> {
  return enqueue(() => {
    if (!cyreneBehaviorGate("posting")) {
      return { applied: false, reason: "moments_disabled" as const };
    }
    const store = requireCache();
    const text = (input.text ?? "").trim();
    if (!text || text.length > MOMENT_MAX_POST_TEXT_LENGTH) return { applied: false, reason: "invalid_input" as const };
    const title = (input.title ?? "").trim().slice(0, MOMENT_MAX_POST_TITLE_LENGTH);
    const post: MomentPost = {
      id: newPostId(),
      author: "cyrene",
      title: title || undefined,
      text,
      media: input.media ?? [],
      createdAt: Date.now(),
      source: input.source,
    };
    store.posts.push(post);
    persist();
    notifyChanged();
    return { applied: true, value: post };
  });
}

function commitCreatePost(author: MomentAuthor, input: MomentCreatePostInput): MomentCommitResult<MomentPost> {
  const store = requireCache();
  const text = (input.text ?? "").trim();
  const title = (input.title ?? "").trim().slice(0, MOMENT_MAX_POST_TITLE_LENGTH);
  const images = input.images ?? [];

  if (text.length > MOMENT_MAX_POST_TEXT_LENGTH) return { applied: false, reason: "invalid_input" };
  if (!text && images.length === 0) return { applied: false, reason: "invalid_input" };
  if (images.length > MOMENT_MAX_IMAGES_PER_POST) return { applied: false, reason: "too_many_images" };
  for (const image of images) {
    if (!MOMENT_ALLOWED_IMAGE_MIME.includes(image.mime as (typeof MOMENT_ALLOWED_IMAGE_MIME)[number])) {
      return { applied: false, reason: "unsupported_mime" };
    }
    if (!image.bytes || image.bytes.byteLength <= 0 || image.bytes.byteLength > MOMENT_MAX_IMAGE_BYTES) {
      return { applied: false, reason: "image_too_large" };
    }
  }

  const postId = newPostId();
  const media: MomentMedia[] = [];
  if (images.length > 0) {
    const mediaDir = path.join(mediaRootDir, postId);
    fs.mkdirSync(mediaDir, { recursive: true });
    images.forEach((image, index) => {
      const fileName = `${index + 1}.${MIME_TO_EXT[image.mime]}`;
      fs.writeFileSync(path.join(mediaDir, fileName), Buffer.from(image.bytes));
      media.push({
        id: `media_${randomUUID().slice(0, 8)}`,
        type: "image",
        origin: "user_attachment",
        ref: fileName,
      });
    });
  }

  const post: MomentPost = {
    id: postId,
    author,
    title: title || undefined,
    text,
    media,
    // 点名列表在 service 层已过滤为合法名单，store 原样落盘；无点名不写字段
    mentions: input.mentions?.length ? [...new Set(input.mentions)] : undefined,
    createdAt: Date.now(),
    source: { type: "manual" },
  };
  store.posts.push(post);
  persist();
  notifyChanged();
  return { applied: true, value: post };
}

/** 级联删除：post + comments + reactions + 图片副本（不动用户原始文件，副本才是我们的）。 */
export function deletePost(postId: string): Promise<MomentCommitResult<null>> {
  return enqueue(() => {
    const store = requireCache();
    const index = store.posts.findIndex((post) => post.id === postId);
    if (index < 0) return { applied: false, reason: "post_not_found" as const };

    store.posts.splice(index, 1);
    store.comments = store.comments.filter((comment) => comment.postId !== postId);
    store.reactions = store.reactions.filter((reaction) => reaction.postId !== postId);

    const mediaDir = path.join(mediaRootDir, postId);
    if (fs.existsSync(mediaDir)) fs.rmSync(mediaDir, { recursive: true, force: true });

    persist();
    notifyChanged();
    return { applied: true, value: null };
  });
}

export function createComment(
  input: MomentCreateCommentInput,
  author: MomentAuthor,
  options: { sourceTaskId?: string } = {},
): Promise<MomentCommitResult<MomentComment>> {
  return enqueue(() => {
    const store = requireCache();
    if (!isValidAuthor(author)) {
      return { applied: false, reason: "invalid_input" as const };
    }
    // 昔涟的评论属于反应行为：提交时复核开关，AI 思考期间关闭则拒绝
    if (author === "cyrene" && !cyreneBehaviorGate("reaction")) {
      return { applied: false, reason: "moments_disabled" as const };
    }
    const content = (input.content ?? "").trim();
    if (!content || content.length > MOMENT_MAX_COMMENT_TEXT_LENGTH) {
      return { applied: false, reason: "invalid_input" as const };
    }
    if (!store.posts.some((post) => post.id === input.postId)) {
      return { applied: false, reason: "post_not_found" as const };
    }
    if (input.replyTo) {
      const target = store.comments.find((comment) => comment.id === input.replyTo);
      if (!target || target.postId !== input.postId) {
        return { applied: false, reason: "reply_to_not_found" as const };
      }
    }

    // 反应任务幂等：该任务已产出过评论 → 不重复写，返回既有评论（崩溃重跑续接）
    if (options.sourceTaskId) {
      const existing = store.comments.find(
        (comment) => comment.postId === input.postId && comment.sourceTaskId === options.sourceTaskId,
      );
      if (existing) return { applied: true, value: existing };
    }

    const comment: MomentComment = {
      id: `comment_${Date.now()}_${randomUUID().slice(0, 8)}`,
      postId: input.postId,
      author,
      content,
      replyTo: input.replyTo,
      createdAt: Date.now(),
      sourceTaskId: options.sourceTaskId,
    };
    store.comments.push(comment);
    persist();
    notifyChanged();
    return { applied: true, value: comment };
  });
}

/** 点赞唯一性：(postId, actor, type) 全局唯一 —— 只能 insert / remove，不会重复点赞。 */
export function toggleLike(
  postId: string,
  actor: MomentAuthor,
): Promise<MomentCommitResult<{ liked: boolean }>> {
  return enqueue(() => {
    const store = requireCache();
    if (!store.posts.some((post) => post.id === postId)) {
      return { applied: false, reason: "post_not_found" as const };
    }
    const existingIndex = store.reactions.findIndex(
      (reaction) => reaction.postId === postId && reaction.actor === actor && reaction.type === "like",
    );

    let liked: boolean;
    if (existingIndex >= 0) {
      store.reactions.splice(existingIndex, 1);
      liked = false;
    } else {
      store.reactions.push({ postId, actor, type: "like", createdAt: Date.now() });
      liked = true;
    }
    persist();
    notifyChanged();
    return { applied: true, value: { liked } };
  });
}

/**
 * 昔涟点赞提交（AI 反应通道）：只插入不撤销。
 * 与用户的 toggleLike 语义不同——AI 决策"点赞"就是点赞，重复提交按唯一性拒绝。
 */
export function createCyreneLike(postId: string): Promise<MomentCommitResult<{ liked: true }>> {
  return enqueue(() => {
    const store = requireCache();
    if (!cyreneBehaviorGate("reaction")) {
      return { applied: false, reason: "moments_disabled" as const };
    }
    if (!store.posts.some((post) => post.id === postId)) {
      return { applied: false, reason: "post_not_found" as const };
    }
    const exists = store.reactions.some(
      (reaction) => reaction.postId === postId && reaction.actor === "cyrene" && reaction.type === "like",
    );
    if (exists) return { applied: false, reason: "reaction_exists" as const };

    store.reactions.push({ postId, actor: "cyrene", type: "like", createdAt: Date.now() });
    persist();
    notifyChanged();
    return { applied: true, value: { liked: true } };
  });
}

/**
 * 角色点赞提交：目标态语义——"确保已点赞"。
 * 已点赞时幂等成功（点赞唯一约束天然幂等，崩溃重跑无副作用），
 * 调用方无需区分"这次点的"和"早就点过的"。
 */
export function createCharacterLike(
  nickname: string,
  postId: string,
): Promise<MomentCommitResult<{ liked: true }>> {
  return enqueue(() => {
    if (!characterBehaviorGate()) {
      return { applied: false, reason: "moments_disabled" as const };
    }
    if (!isValidAuthor(nickname)) {
      return { applied: false, reason: "invalid_input" as const };
    }
    const store = requireCache();
    if (!store.posts.some((post) => post.id === postId)) {
      return { applied: false, reason: "post_not_found" as const };
    }
    const exists = store.reactions.some(
      (reaction) => reaction.postId === postId && reaction.actor === nickname && reaction.type === "like",
    );
    if (exists) return { applied: true, value: { liked: true } };

    store.reactions.push({ postId, actor: nickname, type: "like", createdAt: Date.now() });
    persist();
    notifyChanged();
    return { applied: true, value: { liked: true } };
  });
}

/**
 * 角色评论提交（AI 反应通道）。
 * 携带 sourceTaskId 时具备崩溃幂等：同一任务重跑发现评论已落库，
 * 返回 already_applied + 既有评论——调用方必须继续后续调度（如给被评论者入回复任务），
 * already_applied 不代表"无事可做"。
 */
export function createCharacterComment(
  nickname: string,
  input: {
    postId: string;
    content: string;
    replyTo?: string;
    sourceTaskId?: string;
  },
): Promise<ApplyCommentResult> {
  return enqueue(() => {
    if (!characterBehaviorGate()) {
      return { status: "rejected", reason: "moments_disabled" as const };
    }
    if (!isValidAuthor(nickname)) {
      return { status: "rejected", reason: "invalid_input" as const };
    }
    const store = requireCache();
    const content = (input.content ?? "").trim();
    if (!content || content.length > MOMENT_MAX_COMMENT_TEXT_LENGTH) {
      return { status: "rejected", reason: "invalid_input" as const };
    }
    const post = store.posts.find((candidate) => candidate.id === input.postId);
    if (!post) return { status: "rejected", reason: "post_not_found" as const };
    if (input.replyTo) {
      const target = store.comments.find((comment) => comment.id === input.replyTo);
      if (!target || target.postId !== input.postId) {
        return { status: "rejected", reason: "reply_to_not_found" as const };
      }
    }

    // 反应任务幂等：该任务已产出过评论 → 不重复写，返回既有评论供续接
    if (input.sourceTaskId) {
      const existing = store.comments.find(
        (comment) => comment.postId === input.postId && comment.sourceTaskId === input.sourceTaskId,
      );
      if (existing) return { status: "already_applied", comment: existing };
    }

    const comment: MomentComment = {
      id: `comment_${Date.now()}_${randomUUID().slice(0, 8)}`,
      postId: input.postId,
      author: nickname,
      content,
      replyTo: input.replyTo,
      createdAt: Date.now(),
      sourceTaskId: input.sourceTaskId,
    };
    store.comments.push(comment);
    persist();
    notifyChanged();
    return { status: "created", comment };
  });
}

/**
 * 角色朋友圈记忆：跨动态的互动时间线（纯读内存缓存）。
 * 收集该角色的评论（含他人对其评论的回复）与点赞；评论占主槽位、点赞限量——
 * 近期狂点赞的角色不该把有内容的对话挤出记忆。
 */
export function getCharacterTimeline(
  nickname: string,
  options: { commentLimit?: number; likeLimit?: number } = {},
): CharacterTimeline {
  const store = requireCache();
  const commentLimit = options.commentLimit ?? 6;
  const likeLimit = options.likeLimit ?? 2;

  // 该角色全部评论，时间倒序取前 commentLimit 条
  const ownComments = store.comments
    .filter((comment) => comment.author === nickname)
    .sort((a, b) => b.createdAt - a.createdAt);
  const selectedComments = ownComments.slice(0, commentLimit);
  const truncatedComments = Math.max(0, ownComments.length - selectedComments.length);

  const commentEntries = selectedComments.map((comment) => ({
    kind: "comment" as const,
    post: store.posts.find((post) => post.id === comment.postId),
    comment,
    // 该评论下的直接回复（正序），保留"你评论 → 对方回了什么"的连续性
    replies: store.comments
      .filter((reply) => reply.replyTo === comment.id)
      .sort((a, b) => a.createdAt - b.createdAt),
  })).filter((entry): entry is { kind: "comment"; post: MomentPost; comment: MomentComment; replies: MomentComment[] } =>
    Boolean(entry.post),
  );

  const likeEntries = store.reactions
    .filter((reaction) => reaction.actor === nickname && reaction.type === "like")
    .sort((a, b) => b.createdAt - a.createdAt)
    .slice(0, likeLimit)
    .map((reaction) => ({
      kind: "like" as const,
      post: store.posts.find((post) => post.id === reaction.postId),
      reaction,
    }))
    .filter((entry): entry is { kind: "like"; post: MomentPost; reaction: (typeof store.reactions)[number] } =>
      Boolean(entry.post),
    );

  // 合并后按互动时间正序排列（旧 → 新），呈现为连续日记
  const entries = [...commentEntries, ...likeEntries].sort((a, b) => {
    const timeA = a.kind === "comment" ? a.comment.createdAt : a.reaction.createdAt;
    const timeB = b.kind === "comment" ? b.comment.createdAt : b.reaction.createdAt;
    return timeA - timeB;
  });

  return { entries, truncatedComments };
}

function newPostId(): string {
  return `moment_${Date.now()}_${randomUUID().slice(0, 8)}`;
}
