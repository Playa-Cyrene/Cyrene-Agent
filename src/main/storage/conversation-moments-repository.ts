/**
 * 空间动态（moments）仓储（worker 侧）：moment_posts / moment_comments / moment_reactions 的全部 SQL。
 *
 * 设计：行级写入 + JSON 载荷。posts 的 seq 是稳定插入序——feed 排序在
 * createdAt 同毫秒时按 seq 倒序（与旧 JSON 数组序等价）。reactions 的
 * (post_id, actor, type) 主键就是"只能 insert/remove"的唯一性不变量。
 *
 * 校验、行为开关、反应任务幂等全部留在主进程 store（JS 读模型），
 * DB 只承担持久化与级联删除事务。旧 moments.json（v2）启动时一次性
 * 只读导入，源文件保留。
 */

import fs from "node:fs";
import path from "node:path";
import { ConversationDatabase } from "./conversation-database";
import { ConversationStoreError } from "./conversation-store-error";
import type { MomentComment, MomentPost, MomentReaction } from "../../shared/moments-types";

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object";
}

export function importMoments(database: ConversationDatabase): void {
  if (database.db.prepare("SELECT version FROM schema_migrations WHERE version=105").get()) return;
  const filePath = path.join(database.userDataRoot, "moments.json");
  let parsed: { posts?: unknown; comments?: unknown; reactions?: unknown } | null = null;
  try {
    if (fs.existsSync(filePath)) {
      const raw = fs.readFileSync(filePath, "utf8");
      const candidate = JSON.parse(raw) as { posts?: unknown; comments?: unknown; reactions?: unknown };
      if (candidate && typeof candidate === "object") parsed = candidate;
    }
  } catch (error) {
    console.warn("[conversation-store] 旧 moments.json 读取失败，保留原文件:", error);
  }
  if (parsed) {
    const legacy = parsed;
    database.transaction(() => {
      const insertPost = database.db.prepare("INSERT INTO moment_posts(id,seq,created_at,post_json) VALUES(?,?,?,?)");
      for (const [index, post] of (Array.isArray(legacy.posts) ? legacy.posts : []).entries()) {
        if (!isRecord(post) || typeof post.id !== "string") continue;
        insertPost.run(post.id, index + 1, Number(post.createdAt) || 0, JSON.stringify(post));
      }
      const insertComment = database.db.prepare(`INSERT INTO moment_comments(id,post_id,author,reply_to,source_task_id,created_at,comment_json)
   VALUES(?,?,?,?,?,?,?)`);
      for (const comment of Array.isArray(legacy.comments) ? legacy.comments : []) {
        if (!isRecord(comment) || typeof comment.id !== "string" || typeof comment.postId !== "string") continue;
        insertComment.run(
          comment.id, comment.postId, String(comment.author ?? ""),
          typeof comment.replyTo === "string" ? comment.replyTo : null,
          typeof comment.sourceTaskId === "string" ? comment.sourceTaskId : null,
          Number(comment.createdAt) || 0, JSON.stringify(comment),
        );
      }
      const insertReaction = database.db.prepare("INSERT OR IGNORE INTO moment_reactions(post_id,actor,type,created_at) VALUES(?,?,?,?)");
      for (const reaction of Array.isArray(legacy.reactions) ? legacy.reactions : []) {
        if (!isRecord(reaction) || typeof reaction.postId !== "string" || typeof reaction.actor !== "string") continue;
        insertReaction.run(reaction.postId, reaction.actor, "like", Number(reaction.createdAt) || 0);
      }
    });
  }
  database.db.prepare("INSERT INTO schema_migrations VALUES(105)").run();
}

export function runMomentsCommand(database: ConversationDatabase, method: string, args: any[]): unknown {
  const db = database.db;
  if (method === "moments.loadAll") {
    const posts = (db.prepare("SELECT post_json FROM moment_posts ORDER BY created_at, seq").all() as Array<{ post_json: string }>)
      .map((row) => JSON.parse(row.post_json) as MomentPost);
    const comments = (db.prepare("SELECT comment_json FROM moment_comments ORDER BY created_at, id").all() as Array<{ comment_json: string }>)
      .map((row) => JSON.parse(row.comment_json) as MomentComment);
    const reactions = (db.prepare("SELECT post_id,actor,type,created_at FROM moment_reactions ORDER BY created_at").all() as Array<{
      post_id: string; actor: string; type: string; created_at: number;
    }>).map((row) => ({ postId: row.post_id, actor: row.actor, type: "like" as const, createdAt: row.created_at }));
    return { posts, comments, reactions };
  }
  if (method === "moments.nextSeq") {
    return Number((db.prepare("SELECT MAX(seq) AS max FROM moment_posts").get() as { max: number | null }).max ?? 0) + 1;
  }
  if (method === "moments.insertPost") {
    const post = args[0] as MomentPost;
    const seq = args[1] as number;
    return database.transaction(() => {
      db.prepare("INSERT INTO moment_posts(id,seq,created_at,post_json) VALUES(?,?,?,?)")
        .run(post.id, seq, post.createdAt, JSON.stringify(post));
      return null;
    });
  }
  if (method === "moments.deletePost") {
    const postId = args[0] as string;
    return database.transaction(() => {
      db.prepare("DELETE FROM moment_posts WHERE id=?").run(postId);
      db.prepare("DELETE FROM moment_comments WHERE post_id=?").run(postId);
      db.prepare("DELETE FROM moment_reactions WHERE post_id=?").run(postId);
      return null;
    });
  }
  if (method === "moments.insertComment") {
    const comment = args[0] as MomentComment;
    return database.transaction(() => {
      db.prepare(`INSERT INTO moment_comments(id,post_id,author,reply_to,source_task_id,created_at,comment_json)
   VALUES(?,?,?,?,?,?,?)`).run(
        comment.id, comment.postId, comment.author,
        comment.replyTo ?? null, comment.sourceTaskId ?? null,
        comment.createdAt, JSON.stringify(comment),
      );
      return null;
    });
  }
  if (method === "moments.insertReaction") {
    const reaction = args[0] as MomentReaction;
    return database.transaction(() => {
      db.prepare("INSERT INTO moment_reactions(post_id,actor,type,created_at) VALUES(?,?,?,?)")
        .run(reaction.postId, reaction.actor, reaction.type, reaction.createdAt);
      return null;
    });
  }
  if (method === "moments.deleteReaction") {
    const [postId, actor, type] = args as [string, string, string];
    return database.transaction(() => {
      db.prepare("DELETE FROM moment_reactions WHERE post_id=? AND actor=? AND type=?").run(postId, actor, type);
      return null;
    });
  }
  throw new ConversationStoreError("CONVERSATION_DATABASE_UNKNOWN_COMMAND");
}
