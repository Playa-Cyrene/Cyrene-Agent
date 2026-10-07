import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const electronMock = vi.hoisted(() => ({
  userDataDir: "",
}));

vi.mock("electron", () => ({
  app: {
    getPath: () => electronMock.userDataDir,
  },
}));

function pngBytes(size = 16): ArrayBuffer {
  return new Uint8Array(size).fill(7).buffer;
}

async function freshStore() {
  const store = await import("./moments-store");
  await store.initialize();
  return store;
}

const temporaryRoots: string[] = [];

afterEach(async () => {
  // 先关 DB worker（Windows 下打开的 sqlite 文件不能删），再清临时目录。
  const { closeConversationDatabases } = await import("../storage/conversation-database-client");
  await closeConversationDatabases().catch(() => {});
  for (const root of temporaryRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe("moments store", () => {
  beforeEach(() => {
    vi.resetModules();
    electronMock.userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "cyrene-moments-"));
    temporaryRoots.push(electronMock.userDataDir);
  });

  it("创建用户动态并按 createdAt 倒序出现在 feed", async () => {
    const store = await freshStore();
    const first = await store.createUserPost({ title: "标题", text: "第一条" });
    const second = await store.createUserPost({ text: "第二条" });

    expect(first.applied && first.value.author).toBe("user");
    expect(first.applied && first.value.title).toBe("标题");

    const feed = store.listFeed();
    expect(feed).toHaveLength(2);
    expect(feed[0].post.id).toBe(second.applied ? second.value.id : "");
    expect(feed[0].post.createdAt).toBeGreaterThanOrEqual(feed[1].post.createdAt);
  });

  it("拒绝空动态、超长文本、超量图片、非法 MIME 与超大图片", async () => {
    const store = await freshStore();

    expect(await store.createUserPost({ text: "   " })).toMatchObject({ applied: false, reason: "invalid_input" });
    expect(await store.createUserPost({ text: "x".repeat(2001) })).toMatchObject({ applied: false, reason: "invalid_input" });
    expect(
      await store.createUserPost({
        text: "图太多",
        images: Array.from({ length: 10 }, (_, i) => ({ name: `${i}.png`, mime: "image/png", bytes: pngBytes() })),
      }),
    ).toMatchObject({ applied: false, reason: "too_many_images" });
    expect(
      await store.createUserPost({ text: "gif 不支持", images: [{ name: "a.gif", mime: "image/gif", bytes: pngBytes() }] }),
    ).toMatchObject({ applied: false, reason: "unsupported_mime" });
    expect(
      await store.createUserPost({
        text: "太大",
        images: [{ name: "big.png", mime: "image/png", bytes: pngBytes(15 * 1024 * 1024 + 1) }],
      }),
    ).toMatchObject({ applied: false, reason: "image_too_large" });
  });

  it("带图动态把副本写入 moments-media/<postId>/ 并可在协议路径下解析", async () => {
    const store = await freshStore();
    const result = await store.createUserPost({
      text: "带图",
      images: [{ name: "photo.png", mime: "image/png", bytes: pngBytes(32) }],
    });

    expect(result.applied).toBe(true);
    if (!result.applied) return;
    const media = result.value.media[0];
    expect(media.origin).toBe("user_attachment");
    expect(media.ref).toBe("1.png");

    const mediaPath = path.join(store.getMomentsMediaRootDir(), result.value.id, media.ref);
    expect(fs.existsSync(mediaPath)).toBe(true);
  });

  it("删除动态级联删除评论、点赞与图片副本", async () => {
    const store = await freshStore();
    const post = await store.createUserPost({
      text: "要删的",
      images: [{ name: "a.png", mime: "image/png", bytes: pngBytes() }],
    });
    if (!post.applied) throw new Error("create failed");
    const postId = post.value.id;
    await store.createComment({ postId, content: "评论" }, "user");
    await store.toggleLike(postId, "user");

    const deleted = await store.deletePost(postId);
    expect(deleted.applied).toBe(true);

    const feed = store.listFeed();
    expect(feed).toHaveLength(0);
    expect(fs.existsSync(path.join(store.getMomentsMediaRootDir(), postId))).toBe(false);
  });

  it("删除不存在的动态返回 post_not_found", async () => {
    const store = await freshStore();
    expect(await store.deletePost("moment_missing")).toMatchObject({ applied: false, reason: "post_not_found" });
  });

  it("评论校验：目标动态必须存在、replyTo 必须属于同一动态、内容有上限", async () => {
    const store = await freshStore();
    const postA = await store.createUserPost({ text: "A" });
    const postB = await store.createUserPost({ text: "B" });
    if (!postA.applied || !postB.applied) throw new Error("create failed");

    expect(await store.createComment({ postId: "moment_missing", content: "x" }, "user"))
      .toMatchObject({ applied: false, reason: "post_not_found" });
    expect(await store.createComment({ postId: postA.value.id, content: "x".repeat(501) }, "user"))
      .toMatchObject({ applied: false, reason: "invalid_input" });

    const commentOnB = await store.createComment({ postId: postB.value.id, content: "B 下的评论" }, "cyrene");
    expect(commentOnB.applied).toBe(true);
    if (!commentOnB.applied) return;

    // 跨动态 replyTo：拒绝（过期/错乱的 AI 回复不会落到错误的动态下）
    expect(
      await store.createComment({ postId: postA.value.id, content: "回错地方", replyTo: commentOnB.value.id }, "user"),
    ).toMatchObject({ applied: false, reason: "reply_to_not_found" });

    const reply = await store.createComment(
      { postId: postB.value.id, content: "回复你", replyTo: commentOnB.value.id },
      "user",
    );
    expect(reply.applied).toBe(true);

    const item = store.getFeedItem(postB.value.id);
    expect(item?.comments).toHaveLength(2);
    expect(item?.comments[1].replyTo).toBe(commentOnB.value.id);
  });

  it("点赞唯一性：toggle 只能 insert/remove，不会重复点赞", async () => {
    const store = await freshStore();
    const post = await store.createUserPost({ text: "赞我" });
    if (!post.applied) throw new Error("create failed");

    expect(await store.toggleLike(post.value.id, "user")).toMatchObject({ applied: true, value: { liked: true } });
    expect(await store.toggleLike(post.value.id, "user")).toMatchObject({ applied: true, value: { liked: false } });
    expect(await store.toggleLike(post.value.id, "cyrene")).toMatchObject({ applied: true, value: { liked: true } });

    const item = store.getFeedItem(post.value.id);
    expect(item?.likes).toHaveLength(1);
    expect(item?.likes[0].actor).toBe("cyrene");

    expect(await store.toggleLike("moment_missing", "user")).toMatchObject({ applied: false, reason: "post_not_found" });
  });

  it("并发写串行化：删动态后迟到的评论被拒绝，不产生孤儿数据", async () => {
    const store = await freshStore();
    const post = await store.createUserPost({ text: "并发目标" });
    if (!post.applied) throw new Error("create failed");

    // 模拟「AI 还在思考时用户删了动态」：删除与迟到评论并发入队
    const [deleted, lateComment, lateLike] = await Promise.all([
      store.deletePost(post.value.id),
      store.createComment({ postId: post.value.id, content: "迟到的评论" }, "cyrene"),
      store.toggleLike(post.value.id, "cyrene"),
    ]);

    expect(deleted.applied).toBe(true);
    expect(lateComment).toMatchObject({ applied: false, reason: "post_not_found" });
    expect(lateLike).toMatchObject({ applied: false, reason: "post_not_found" });
    expect(store.listFeed()).toHaveLength(0);
  });

  it("落盘后可恢复：DB worker 重启后动态仍在（SQLite 持久化）", async () => {
    const store = await freshStore();
    await store.createUserPost({ title: "持久", text: "重启还在" });

    // 模拟进程重启：关闭 worker（连接终止），重新初始化读模型
    const { closeConversationDatabases } = await import("../storage/conversation-database-client");
    await closeConversationDatabases();
    vi.resetModules();
    const reloaded = await import("./moments-store");
    await reloaded.initialize();
    const feed = reloaded.listFeed();
    expect(feed).toHaveLength(1);
    expect(feed[0].post.title).toBe("持久");
  });

  it("createCyrenePost 内部通道可发昔涟动态（不携带图片副本逻辑）", async () => {
    const store = await freshStore();
    const result = await store.createCyrenePost({ text: "今天有点想偷懒。" });
    expect(result.applied).toBe(true);
    if (!result.applied) return;
    expect(result.value.author).toBe("cyrene");
    expect(result.value.media).toHaveLength(0);
  });

  it("昔涟点赞只插入不撤销：重复提交被 reaction_exists 拒绝", async () => {
    const store = await freshStore();
    const post = await store.createUserPost({ text: "赞我" });
    if (!post.applied) throw new Error("create failed");

    expect(await store.createCyreneLike(post.value.id)).toMatchObject({ applied: true, value: { liked: true } });
    expect(await store.createCyreneLike(post.value.id)).toMatchObject({ applied: false, reason: "reaction_exists" });
    // 用户 toggle 互不影响（唯一性按 actor 区分）
    expect(await store.toggleLike(post.value.id, "user")).toMatchObject({ applied: true, value: { liked: true } });
    expect(await store.createCyreneLike("moment_missing")).toMatchObject({ applied: false, reason: "post_not_found" });
  });

  it("反应开关关闭时昔涟提交被 moments_disabled 拒绝，用户操作不受影响", async () => {
    const store = await freshStore();
    const post = await store.createUserPost({ text: "开关测试" });
    if (!post.applied) throw new Error("create failed");

    store.setCyreneBehaviorGate(() => false);
    expect(await store.createCyreneLike(post.value.id)).toMatchObject({ applied: false, reason: "moments_disabled" });
    expect(await store.createComment({ postId: post.value.id, content: "迟到的 AI 评论" }, "cyrene"))
      .toMatchObject({ applied: false, reason: "moments_disabled" });
    expect(await store.createCyrenePost({ text: "发不出去" })).toMatchObject({ applied: false, reason: "moments_disabled" });
    // 用户侧不经过昔涟门控，照常可用
    expect((await store.createComment({ postId: post.value.id, content: "用户还能评论" }, "user")).applied).toBe(true);
    expect((await store.toggleLike(post.value.id, "user")).applied).toBe(true);
    // 门控按行为种类区分：posting 放行时昔涟发帖不受反应开关影响
    store.setCyreneBehaviorGate((behavior) => behavior === "posting");
    expect((await store.createCyrenePost({ text: "发得出去" })).applied).toBe(true);
  });

  // ── 角色写通道（入驻角色互动） ─────────────────────────────────

  async function freshStoreWithCharacters(names: string[]) {
    const store = await freshStore();
    store.setCharacterAuthorRegistry(new Set(names));
    return store;
  }

  it("角色点赞：幂等成功语义，重复提交与崩溃重跑都返回 liked", async () => {
    const store = await freshStoreWithCharacters(["万敌", "风堇"]);
    const post = await store.createUserPost({ text: "跑步打卡" });
    if (!post.applied) throw new Error("create failed");

    expect(await store.createCharacterLike("万敌", post.value.id)).toMatchObject({ applied: true, value: { liked: true } });
    // 同一角色重复点赞：目标态已达成，幂等成功而非拒绝
    expect(await store.createCharacterLike("万敌", post.value.id)).toMatchObject({ applied: true, value: { liked: true } });

    const item = store.getFeedItem(post.value.id);
    expect(item?.likes).toHaveLength(1);
    expect(item?.likes[0].actor).toBe("万敌");

    // 未注册角色与不存在的动态都被拒绝
    expect(await store.createCharacterLike("路人甲", post.value.id)).toMatchObject({ applied: false, reason: "invalid_input" });
    expect(await store.createCharacterLike("万敌", "moment_missing")).toMatchObject({ applied: false, reason: "post_not_found" });
  });

  it("角色评论：内容校验与 replyTo 校验沿用既有规则", async () => {
    const store = await freshStoreWithCharacters(["万敌"]);
    const postA = await store.createUserPost({ text: "A" });
    const postB = await store.createUserPost({ text: "B" });
    if (!postA.applied || !postB.applied) throw new Error("create failed");

    expect(await store.createCharacterComment("万敌", { postId: postA.value.id, content: "   " }))
      .toMatchObject({ status: "rejected", reason: "invalid_input" });
    expect(await store.createCharacterComment("万敌", { postId: postA.value.id, content: "x".repeat(501) }))
      .toMatchObject({ status: "rejected", reason: "invalid_input" });
    expect(await store.createCharacterComment("路人甲", { postId: postA.value.id, content: "冒名" }))
      .toMatchObject({ status: "rejected", reason: "invalid_input" });
    expect(await store.createCharacterComment("万敌", { postId: "moment_missing", content: "无的放矢" }))
      .toMatchObject({ status: "rejected", reason: "post_not_found" });

    const commentOnB = await store.createCharacterComment("万敌", { postId: postB.value.id, content: "保持。" });
    expect(commentOnB.status).toBe("created");
    if (commentOnB.status !== "created") return;
    expect(commentOnB.comment.author).toBe("万敌");

    // 跨动态 replyTo 拒绝（同一个已注册角色，回错动态）
    expect(
      await store.createCharacterComment("万敌", { postId: postA.value.id, content: "回错地方", replyTo: commentOnB.comment.id }),
    ).toMatchObject({ status: "rejected", reason: "reply_to_not_found" });
  });

  it("角色评论 sourceTaskId 幂等：重跑返回 already_applied 与既有评论", async () => {
    const store = await freshStoreWithCharacters(["万敌"]);
    const post = await store.createUserPost({ text: "训练记录" });
    if (!post.applied) throw new Error("create failed");

    const first = await store.createCharacterComment("万敌", {
      postId: post.value.id,
      content: "练得不错。",
      sourceTaskId: "task_1",
    });
    expect(first.status).toBe("created");

    // 崩溃重跑：同一任务再次提交，不产生第二条评论
    const retry = await store.createCharacterComment("万敌", {
      postId: post.value.id,
      content: "练得不错。（重跑输出）",
      sourceTaskId: "task_1",
    });
    expect(retry.status).toBe("already_applied");
    if (retry.status !== "already_applied") return;
    expect(retry.comment.id).toBe(first.status === "created" ? first.comment.id : "");
    expect(retry.comment.content).toBe("练得不错。");

    // 不同任务不受影响
    const second = await store.createCharacterComment("万敌", {
      postId: post.value.id,
      content: "另外一句",
      sourceTaskId: "task_2",
    });
    expect(second.status).toBe("created");

    const item = store.getFeedItem(post.value.id);
    expect(item?.comments).toHaveLength(2);
  });

  it("昔涟评论同样支持 sourceTaskId 幂等", async () => {
    const store = await freshStore();
    const post = await store.createUserPost({ text: "昔涟幂等" });
    if (!post.applied) throw new Error("create failed");

    const first = await store.createComment({ postId: post.value.id, content: "看到了。" }, "cyrene", { sourceTaskId: "task_c1" });
    expect(first.applied).toBe(true);
    if (!first.applied) return;

    const retry = await store.createComment({ postId: post.value.id, content: "看到了。（重跑）" }, "cyrene", { sourceTaskId: "task_c1" });
    expect(retry.applied).toBe(true);
    if (!retry.applied) return;
    expect(retry.value.id).toBe(first.value.id);
    expect(retry.value.content).toBe("看到了。");

    expect(store.getFeedItem(post.value.id)?.comments).toHaveLength(1);
  });

  it("角色行为开关：关闭时角色点赞评论被拒，昔涟与用户不受影响", async () => {
    const store = await freshStoreWithCharacters(["万敌"]);
    const post = await store.createUserPost({ text: "开关" });
    if (!post.applied) throw new Error("create failed");

    store.setCharacterBehaviorGate(() => false);
    expect(await store.createCharacterLike("万敌", post.value.id)).toMatchObject({ applied: false, reason: "moments_disabled" });
    expect(await store.createCharacterComment("万敌", { postId: post.value.id, content: "说不出" }))
      .toMatchObject({ status: "rejected", reason: "moments_disabled" });

    // 昔涟与用户通道走各自门控，照常可用
    expect((await store.createCyreneLike(post.value.id)).applied).toBe(true);
    expect((await store.createComment({ postId: post.value.id, content: "用户评论" }, "user")).applied).toBe(true);
  });

  it("角色 timeline：评论带回复、点赞限量、按时间正序、评论优先不被点赞洪水冲掉", async () => {
    const store = await freshStoreWithCharacters(["万敌"]);
    const postA = await store.createUserPost({ text: "炖菜" });
    const postB = await store.createUserPost({ text: "十公里" });
    if (!postA.applied || !postB.applied) throw new Error("create failed");

    // 万敌评论 A，用户回复他
    const commentA = await store.createCharacterComment("万敌", { postId: postA.value.id, content: "火候不错。" });
    if (commentA.status !== "created") throw new Error("comment failed");
    await store.createComment(
      { postId: postA.value.id, content: "下周再战", replyTo: commentA.comment.id },
      "user",
    );

    // 点赞洪水：8 条点赞（timeline 只保留 2 条）
    for (let index = 0; index < 8; index += 1) {
      const post = await store.createUserPost({ text: `点赞目标 ${index}` });
      if (!post.applied) throw new Error("create failed");
      await store.createCharacterLike("万敌", post.value.id);
    }

    // 万敌评论 B
    await store.createCharacterComment("万敌", { postId: postB.value.id, content: "保持。" });

    const timeline = store.getCharacterTimeline("万敌");
    const commentEntries = timeline.entries.filter((entry) => entry.kind === "comment");
    const likeEntries = timeline.entries.filter((entry) => entry.kind === "like");

    // 评论 2 条都保留（点赞再多也挤不掉评论）；点赞截断到 2 条
    expect(commentEntries).toHaveLength(2);
    expect(likeEntries).toHaveLength(2);

    // 评论条目携带他人回复，保留对话连续性
    const withReply = commentEntries.find(
      (entry) => entry.kind === "comment" && entry.comment.postId === postA.value.id,
    );
    expect(withReply && withReply.kind === "comment" && withReply.replies[0]?.content).toBe("下周再战");

    // 时间正序（旧 → 新）
    const times = timeline.entries.map((entry) =>
      entry.kind === "comment" ? entry.comment.createdAt : entry.reaction.createdAt,
    );
    expect([...times].sort((a, b) => a - b)).toEqual(times);

    // 未注册角色查不到任何记录
    expect(store.getCharacterTimeline("路人甲").entries).toHaveLength(0);

    // 槽位限制可自定义
    const limited = store.getCharacterTimeline("万敌", { commentLimit: 1, likeLimit: 1 });
    expect(limited.entries).toHaveLength(2);
  });

  it("旧 moments.json 一次性导入：评论（含 sourceTaskId）与点赞在重启后可见", async () => {
    // 旧 JSON 存储时代的数据：worker 启动时导入（版本 105 标记），源文件保留
    fs.writeFileSync(path.join(electronMock.userDataDir, "moments.json"), JSON.stringify({
      schemaVersion: 2,
      posts: [{ id: "moment_legacy_1", author: "user", text: "旧动态", media: [], createdAt: 1_000 }],
      comments: [
        { id: "comment_legacy_1", postId: "moment_legacy_1", author: "万敌", content: "带任务 id 的评论", createdAt: 1_100, sourceTaskId: "task_v2" },
        { id: "comment_legacy_2", postId: "moment_legacy_1", author: "user", content: "无任务 id 的旧评论", createdAt: 1_200 },
      ],
      reactions: [{ postId: "moment_legacy_1", actor: "user", type: "like", createdAt: 1_300 }],
    }), "utf8");

    const store = await import("./moments-store");
    await store.initialize();

    const item = store.getFeedItem("moment_legacy_1");
    expect(item?.post.text).toBe("旧动态");
    expect(item?.comments.map((comment) => comment.sourceTaskId)).toEqual(["task_v2", undefined]);
    expect(item?.likes).toHaveLength(1);

    // 反应任务幂等：sourceTaskId 随导入保留，同一任务重跑识别为已产出
    store.setCharacterAuthorRegistry(new Set(["万敌"]));
    const idempotent = await store.createComment(
      { postId: "moment_legacy_1", content: "带任务 id 的评论" },
      "万敌",
      { sourceTaskId: "task_v2" },
    );
    expect(idempotent).toMatchObject({ applied: true });
    expect((idempotent as { value: { id: string } }).value.id).toBe("comment_legacy_1");
    expect(store.getFeedItem("moment_legacy_1")?.comments).toHaveLength(2);
  });
});
