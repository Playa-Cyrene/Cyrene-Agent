// 会话级待发队列的真实存储测试（临时目录 + mock electron，与 chats-store.test.ts 同模式）。
// 覆盖阶段二 A 契约：重启恢复、重复标识、跨会话隔离、失败不误报入队成功、
// 旧会话兼容、入队顺序、待发条目绝不进入正式 messages。
import fs from "fs";
import os from "os";
import path from "path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PendingChatMessageInput } from "../../../shared/chat-types";

const mocks = vi.hoisted(() => ({
  userDataDir: "",
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
}));

// 单一 electron mock：同时满足 store（app/shell）与 IPC（BrowserWindow/ipcMain/dialog）测试
vi.mock("electron", () => ({
  app: {
    getPath: () => mocks.userDataDir,
  },
  shell: {
    openPath: vi.fn(),
  },
  BrowserWindow: {
    getAllWindows: () => [],
  },
  ipcMain: {
    handle: vi.fn((channel: string, handler: (...args: unknown[]) => unknown) => {
      mocks.handlers.set(channel, handler);
    }),
  },
  dialog: {
    showOpenDialog: vi.fn(),
  },
}));

/** 构造合法入队载荷（id 可覆盖，便于重复标识用例）。 */
function entry(overrides: Partial<PendingChatMessageInput> = {}): PendingChatMessageInput {
  return {
    id: "pending-1",
    rawContent: "第一条排队消息",
    visibleContent: "第一条排队消息",
    ...overrides,
  };
}

describe("chats pending queue store", () => {
  beforeEach(() => {
    vi.resetModules();
    mocks.userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "cyrene-pending-queue-"));
  });

  it("入队后重启（重新 initialize）队列完整恢复，含顺序与附件引用", async () => {
    let store = await import("./chats-store");
    store.initialize();
    const session = store.createSession({ mode: "work" });
    store.enqueuePendingMessage(session.id, entry({ id: "q1", rawContent: "先发这个", visibleContent: "先发这个" }));
    store.enqueuePendingMessage(session.id, entry({ id: "q2", rawContent: "再发这个", visibleContent: "再发这个" }));

    // 模拟进程重启：模块重置 + 重新从磁盘加载
    vi.resetModules();
    store = await import("./chats-store");
    store.initialize();

    const restored = store.getPendingMessages(session.id);
    expect(restored?.map((item) => item.id)).toEqual(["q1", "q2"]);
    expect(restored?.[0].rawContent).toBe("先发这个");
    expect(typeof restored?.[0].enqueuedAt).toBe("number");
  });

  it("同标识同内容（含附件）重复入队幂等成功，返回现有权威队列且不重复写入", async () => {
    const store = await import("./chats-store");
    store.initialize();
    const session = store.createSession({ mode: "work" });
    const payload = entry({
      id: "dup-1",
      attachments: [
        { kind: "image", name: "截图.png", filePath: "C:/tmp/shot.png", mime: "image/png", hasAnnotations: true },
      ],
    });

    const first = store.enqueuePendingMessage(session.id, payload);
    expect(first).toEqual(expect.objectContaining({ ok: true, enqueued: true }));
    const firstEnqueuedAt = first.ok ? first.queue[0].enqueuedAt : 0;

    // 同标识同内容重试：幂等成功，enqueued=false，队列保持单条
    const retry = store.enqueuePendingMessage(session.id, payload);
    expect(retry).toEqual(expect.objectContaining({ ok: true, enqueued: false }));
    expect(retry.ok && retry.queue).toHaveLength(1);
    // enqueuedAt 保持首次值：证明幂等命中未重写磁盘
    expect(retry.ok && retry.queue[0].enqueuedAt).toBe(firstEnqueuedAt);
  });

  it("同标识但内容不同才返回冲突，队列保持首条不变", async () => {
    const store = await import("./chats-store");
    store.initialize();
    const session = store.createSession({ mode: "work" });

    store.enqueuePendingMessage(session.id, entry({ id: "dup-1" }));

    const conflict = store.enqueuePendingMessage(session.id, entry({
      id: "dup-1",
      rawContent: "同标识不同内容",
      visibleContent: "同标识不同内容",
    }));
    expect(conflict).toEqual({ ok: false, error: "duplicate-id" });
    expect(store.getPendingMessages(session.id)).toHaveLength(1);
    expect(store.getPendingMessages(session.id)?.[0].rawContent).toBe("第一条排队消息");

    // 附件不同同样视为内容不同（冲突）
    const conflictByAttachment = store.enqueuePendingMessage(session.id, entry({
      id: "dup-1",
      attachments: [{ kind: "document", name: "新附件.txt", filePath: "C:/tmp/new.txt" }],
    }));
    expect(conflictByAttachment).toEqual({ ok: false, error: "duplicate-id" });
  });

  it("首次成功但回复丢失后重试：同载荷重发得到成功与同一队列，不产生重复条目", async () => {
    const store = await import("./chats-store");
    store.initialize();
    const session = store.createSession({ mode: "work" });
    // 渲染层生成载荷（含稳定标识）；首次入队已在主进程落盘，但 IPC 回复丢失
    const payload = entry({ id: "lost-reply", rawContent: "回复丢失的重试", visibleContent: "回复丢失的重试" });
    const first = store.enqueuePendingMessage(session.id, payload);
    expect(first).toEqual(expect.objectContaining({ ok: true, enqueued: true }));

    // 渲染层超时后重发同一载荷：应得到成功与现有权威队列，而非冲突或重复
    const retried = store.enqueuePendingMessage(session.id, payload);
    expect(retried).toEqual(expect.objectContaining({ ok: true, enqueued: false }));
    expect(retried.ok && retried.queue.map((item) => item.id)).toEqual(["lost-reply"]);
    // 重启后磁盘上也只有一条（重复写入从未发生）
    vi.resetModules();
    const storeAfterRestart = await import("./chats-store");
    storeAfterRestart.initialize();
    const restored = storeAfterRestart.getPendingMessages(session.id);
    expect(restored?.map((item) => item.id)).toEqual(["lost-reply"]);
  });

  it("跨会话隔离：各会话只读到自己的队列", async () => {
    const store = await import("./chats-store");
    store.initialize();
    const alpha = store.createSession({ mode: "work" });
    const beta = store.createSession({ mode: "chat" });

    store.enqueuePendingMessage(alpha.id, entry({ id: "a1", rawContent: "A 会话的", visibleContent: "A 会话的" }));
    store.enqueuePendingMessage(beta.id, entry({ id: "b1", rawContent: "B 会话的", visibleContent: "B 会话的" }));

    expect(store.getPendingMessages(alpha.id)?.map((item) => item.id)).toEqual(["a1"]);
    expect(store.getPendingMessages(beta.id)?.map((item) => item.id)).toEqual(["b1"]);
    // 删除 A 的条目不影响 B
    store.removePendingMessage(alpha.id, "a1");
    expect(store.getPendingMessages(alpha.id)).toEqual([]);
    expect(store.getPendingMessages(beta.id)).toHaveLength(1);
  });

  it("失败时不误报入队成功：会话不存在 / 空内容 / 非法附件 / 写盘失败", async () => {
    const store = await import("./chats-store");
    store.initialize();
    const session = store.createSession({ mode: "work" });

    // 会话不存在
    expect(store.enqueuePendingMessage("missing-session", entry())).toEqual({
      ok: false,
      error: "session-not-found",
    });
    // 空内容
    expect(store.enqueuePendingMessage(session.id, entry({ rawContent: "   ", visibleContent: "" }))).toEqual({
      ok: false,
      error: "empty-content",
    });
    // 附件缺 filePath（字段不完整整条拒绝）
    expect(store.enqueuePendingMessage(session.id, entry({
      attachments: [{ kind: "image", name: "坏附件" } as never],
    }))).toEqual({ ok: false, error: "invalid-attachments" });
    // 以上全部失败后队列必须仍为空
    expect(store.getPendingMessages(session.id)).toEqual([]);

    // 写盘失败（物理方式：把原子写的 .tmp 路径做成目录，writeFileSync 抛 EISDIR）
    const { getRootDir } = store;
    const tmpPath = path.join(getRootDir(), "sessions", `${session.id}.json.tmp`);
    fs.mkdirSync(tmpPath, { recursive: true });
    const failed = store.enqueuePendingMessage(session.id, entry({ id: "q-write" }));
    expect(failed).toEqual({ ok: false, error: "write-failed" });
    // 写盘失败后磁盘上确实没有该条目（清掉阻塞目录后重新读）
    fs.rmdirSync(tmpPath);
    expect(store.getPendingMessages(session.id)).toEqual([]);
  });

  it("旧会话无 pendingMessages 字段视为空队列（向后兼容）", async () => {
    const root = path.join(mocks.userDataDir, "cyrene-chats");
    const sessionsDir = path.join(root, "sessions");
    fs.mkdirSync(sessionsDir, { recursive: true });
    fs.writeFileSync(path.join(root, "index.json"), JSON.stringify([{
      id: "legacy", title: "旧对话", identityId: null, createdAt: 1, updatedAt: 1, messageCount: 1,
    }]));
    fs.writeFileSync(path.join(sessionsDir, "legacy.json"), JSON.stringify({
      id: "legacy",
      title: "旧对话",
      identityId: null,
      messages: [{ id: "m1", role: "user", content: "历史消息", at: 1 }],
      createdAt: 1,
      updatedAt: 1,
      schemaVersion: 1,
    }));

    const store = await import("./chats-store");
    store.initialize();

    expect(store.getPendingMessages("legacy")).toEqual([]);
    // 旧会话直接入队也能工作（字段延迟创建）
    const result = store.enqueuePendingMessage("legacy", entry({ id: "new-q" }));
    expect(result).toEqual(expect.objectContaining({ ok: true }));
    expect(store.getPendingMessages("legacy")?.map((item) => item.id)).toEqual(["new-q"]);
  });

  it("三条按序入队：数组顺序即入队顺序（派发顺序依据）", async () => {
    const store = await import("./chats-store");
    store.initialize();
    const session = store.createSession({ mode: "work" });

    for (const [index, id] of ["q-a", "q-b", "q-c"].entries()) {
      const result = store.enqueuePendingMessage(session.id, entry({
        id,
        rawContent: `消息 ${index}`,
        visibleContent: `消息 ${index}`,
      }));
      expect(result).toEqual(expect.objectContaining({ ok: true }));
    }

    expect(store.getPendingMessages(session.id)?.map((item) => item.id)).toEqual(["q-a", "q-b", "q-c"]);
  });

  it("待发条目只写 pendingMessages，绝不进入正式 messages 历史", async () => {
    const store = await import("./chats-store");
    store.initialize();
    const session = store.createSession({
      mode: "work",
      initialMessages: [{ id: "m1", role: "user", content: "已有历史", at: 1 }],
    });

    store.enqueuePendingMessage(session.id, entry({ id: "q1" }));
    store.enqueuePendingMessage(session.id, entry({ id: "q2", rawContent: "第二条", visibleContent: "第二条" }));

    const persisted = store.getSession(session.id);
    // 正式历史只有原有消息，队列条目不冒充用户消息
    expect(persisted?.messages.map((message) => message.id)).toEqual(["m1"]);
    expect(persisted?.pendingMessages?.map((item) => item.id)).toEqual(["q1", "q2"]);
    // 会话列表的 messageCount 也不被待发条目污染
    expect(store.listSessions().find((item) => item.id === session.id)?.messageCount).toBe(1);
  });

  it("附件引用只保留稳定字段：截图标注标记保留，预览地址与处理状态剥离", async () => {
    const store = await import("./chats-store");
    store.initialize();
    const session = store.createSession({ mode: "work" });

    const result = store.enqueuePendingMessage(session.id, entry({
      id: "q-att",
      attachments: [
        {
          kind: "image",
          name: "截图.png",
          filePath: "C:/tmp/shot.png",
          mime: "image/png",
          hasAnnotations: true,
          // 以下瞬态字段应被规范化丢弃
          previewUrl: "blob:123",
          status: "pending",
          imageSendMode: "caption",
        } as never,
        { kind: "document", name: "报告.txt", filePath: "C:/tmp/报告.txt" },
      ],
    }));
    expect(result).toEqual(expect.objectContaining({ ok: true }));

    const queue = store.getPendingMessages(session.id);
    expect(queue?.[0].attachments).toEqual([
      { kind: "image", name: "截图.png", filePath: "C:/tmp/shot.png", mime: "image/png", hasAnnotations: true },
      { kind: "document", name: "报告.txt", filePath: "C:/tmp/报告.txt" },
    ]);
  });

  it("恢复后的附件可重新用于派发：标注标记与路径跨重启保留", async () => {
    let store = await import("./chats-store");
    store.initialize();
    const session = store.createSession({ mode: "work" });
    store.enqueuePendingMessage(session.id, entry({
      id: "q-restore",
      attachments: [
        { kind: "image", name: "标注截图.png", filePath: "C:/tmp/annotated.png", mime: "image/png", hasAnnotations: true },
      ],
    }));

    vi.resetModules();
    store = await import("./chats-store");
    store.initialize();

    const restored = store.getPendingMessages(session.id)?.[0];
    expect(restored?.attachments?.[0]).toEqual({
      kind: "image",
      name: "标注截图.png",
      filePath: "C:/tmp/annotated.png",
      mime: "image/png",
      hasAnnotations: true,
    });
  });

  it("删除按标识幂等：删不存在的条目成功且不写盘，会话不存在才报错", async () => {
    const store = await import("./chats-store");
    store.initialize();
    const session = store.createSession({ mode: "work" });
    store.enqueuePendingMessage(session.id, entry({ id: "q1" }));

    // 删存在的条目
    expect(store.removePendingMessage(session.id, "q1")).toEqual({ ok: true, removed: true });
    expect(store.getPendingMessages(session.id)).toEqual([]);
    // 再删同一条（幂等）与删从未存在的条目都安全（removed=false）
    expect(store.removePendingMessage(session.id, "q1")).toEqual({ ok: true, removed: false });
    expect(store.removePendingMessage(session.id, "never-existed")).toEqual({ ok: true, removed: false });
    // 会话不存在
    expect(store.removePendingMessage("missing-session", "q1")).toEqual({ ok: false, error: "session-not-found" });
    expect(store.getPendingMessages("missing-session")).toBeNull();
  });

  it("删除写盘失败返回失败，条目保留在队列中", async () => {
    const store = await import("./chats-store");
    store.initialize();
    const session = store.createSession({ mode: "work" });
    store.enqueuePendingMessage(session.id, entry({ id: "q-del" }));

    // 物理方式制造写盘失败：原子写的 .tmp 路径被目录占用，writeFileSync 抛 EISDIR
    const tmpPath = path.join(store.getRootDir(), "sessions", `${session.id}.json.tmp`);
    fs.mkdirSync(tmpPath, { recursive: true });
    expect(store.removePendingMessage(session.id, "q-del")).toEqual({ ok: false, error: "write-failed" });
    // 清掉阻塞目录后：删除从未落盘，条目仍在（删除失败不误删）
    fs.rmdirSync(tmpPath);
    expect(store.getPendingMessages(session.id)?.map((item) => item.id)).toEqual(["q-del"]);
  });

  it("增删队列不刷新会话排序时间也不写 index.json", async () => {
    const store = await import("./chats-store");
    store.initialize();
    const session = store.createSession({ mode: "work" });
    const indexJsonPath = path.join(store.getRootDir(), "index.json");
    const indexBefore = fs.readFileSync(indexJsonPath, "utf8");
    const updatedAtBefore = store.getSession(session.id)?.updatedAt;

    // 入队：会话文件更新，但排序时间与 index.json 不动
    store.enqueuePendingMessage(session.id, entry({ id: "q-sort" }));
    expect(store.getSession(session.id)?.updatedAt).toBe(updatedAtBefore);
    expect(fs.readFileSync(indexJsonPath, "utf8")).toBe(indexBefore);

    // 删除：同样不动
    store.removePendingMessage(session.id, "q-sort");
    expect(store.getSession(session.id)?.updatedAt).toBe(updatedAtBefore);
    expect(fs.readFileSync(indexJsonPath, "utf8")).toBe(indexBefore);

    // 会话列表排序依据（updatedAt）未变
    expect(store.listSessions().find((item) => item.id === session.id)?.updatedAt).toBe(updatedAtBefore);
  });

  it("表情包与原始/展示内容分离保存", async () => {
    const store = await import("./chats-store");
    store.initialize();
    const session = store.createSession({ mode: "chat" });

    store.enqueuePendingMessage(session.id, {
      id: "q-sticker",
      rawContent: "抱抱 [sticker:playful]",
      visibleContent: "抱抱",
      userSticker: "playful",
    });

    const queue = store.getPendingMessages(session.id);
    expect(queue?.[0]).toEqual(expect.objectContaining({
      rawContent: "抱抱 [sticker:playful]",
      visibleContent: "抱抱",
      userSticker: "playful",
    }));
  });
});

describe("chats pending claim & dispatch", () => {
  beforeEach(() => {
    vi.resetModules();
    mocks.userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "cyrene-pending-claim-"));
  });

  /** 建会话并入队三条消息（带序号），返回会话 id。 */
  async function seedThreeMessages() {
    const store = await import("./chats-store");
    store.initialize();
    const session = store.createSession({
      mode: "work",
      initialMessages: [{ id: "m0", role: "user", content: "已有历史", at: 1 }],
    });
    for (const id of ["q-a", "q-b", "q-c"]) {
      store.enqueuePendingMessage(session.id, entry({ id, rawContent: `消息 ${id}`, visibleContent: `消息 ${id}` }));
    }
    return { store, sessionId: session.id };
  }

  it("三条顺序认领派发：每次拿队首转正式消息，队列递减，认领完队列空", async () => {
    const { store, sessionId } = await seedThreeMessages();

    for (const expectedId of ["q-a", "q-b", "q-c"]) {
      const claim = store.claimPendingMessage(sessionId);
      expect(claim).toEqual(expect.objectContaining({ ok: true, claimed: true }));
      if (!claim.ok || !claim.claimed) throw new Error("unreachable");
      expect(claim.userMessage.id).toBe(expectedId);
      expect(claim.userMessage.role).toBe("user");
      // 认领后的会话已含转正消息，剩余队列是权威快照
      expect(claim.session.messages.at(-1)?.id).toBe(expectedId);
      // 页面流程：run ack 成功后才确认派发，随后才能认领下一条
      expect(store.completePendingDispatch(sessionId, expectedId)).toEqual({ ok: true, cleared: true });
    }
    // 三条全部派发完：队列空、messages 追加三条、派发状态已清
    expect(store.getPendingMessages(sessionId)).toEqual([]);
    expect(store.getSession(sessionId)?.messages.map((message) => message.id)).toEqual(["m0", "q-a", "q-b", "q-c"]);
    expect(store.getSession(sessionId)?.pendingDispatch).toBeUndefined();
    // 队列空再认领：claimed=false
    expect(store.claimPendingMessage(sessionId)).toEqual({ ok: true, claimed: false });
  });

  it("认领把附件快照映射为正式消息附件（图片标注保留，状态重置为 pending）", async () => {
    const store = await import("./chats-store");
    store.initialize();
    const session = store.createSession({ mode: "work" });
    store.enqueuePendingMessage(session.id, entry({
      id: "q-att",
      rawContent: "看这张图",
      visibleContent: "看这张图",
      attachments: [
        { kind: "image", name: "标注截图.png", filePath: "C:/tmp/annotated.png", mime: "image/png", hasAnnotations: true },
        { kind: "document", name: "报告.txt", filePath: "C:/tmp/报告.txt" },
      ],
    }));

    const claim = store.claimPendingMessage(session.id);
    expect(claim).toEqual(expect.objectContaining({ ok: true, claimed: true }));
    if (!claim.ok || !claim.claimed) throw new Error("unreachable");
    expect(claim.userMessage.attachments).toEqual([
      { kind: "image", name: "标注截图.png", filePath: "C:/tmp/annotated.png", mime: "image/png", status: "pending", hasAnnotations: true },
      { kind: "document", name: "报告.txt", filePath: "C:/tmp/报告.txt", status: "pending" },
    ]);
    // 展示内容与恢复 run 标识一并带出，页面无需回读原始条目
    expect(claim.visibleContent).toBe("看这张图");
  });

  it("认领写入 pendingDispatch；completePendingDispatch 按 messageId 清除，不匹配幂等", async () => {
    const store = await import("./chats-store");
    store.initialize();
    const session = store.createSession({ mode: "work" });
    store.enqueuePendingMessage(session.id, entry({ id: "q-1", rawContent: "第一条", visibleContent: "第一条" }));
    store.enqueuePendingMessage(session.id, entry({ id: "q-2", rawContent: "第二条", visibleContent: "第二条" }));

    const claim = store.claimPendingMessage(session.id);
    if (!claim.ok || !claim.claimed) throw new Error("unreachable");
    expect(store.getSession(session.id)?.pendingDispatch).toEqual({
      messageId: "q-1",
      claimedAt: claim.userMessage.at,
    });

    // messageId 不匹配（已被清除/认领了新条目）：幂等成功不写盘
    expect(store.completePendingDispatch(session.id, "q-2")).toEqual({ ok: true, cleared: false });
    expect(store.getSession(session.id)?.pendingDispatch?.messageId).toBe("q-1");

    // 匹配：清除派发状态
    expect(store.completePendingDispatch(session.id, "q-1")).toEqual({ ok: true, cleared: true });
    expect(store.getSession(session.id)?.pendingDispatch).toBeUndefined();
    // 会话不存在
    expect(store.completePendingDispatch("missing", "q-1")).toEqual({ ok: false, error: "session-not-found" });
  });

  it("认领冲突：已有未完成认领时再次认领返回 already-dispatching，队列与历史不动", async () => {
    const { store, sessionId } = await seedThreeMessages();

    const first = store.claimPendingMessage(sessionId);
    expect(first).toEqual(expect.objectContaining({ ok: true, claimed: true }));

    // 未 completeDispatch 前再次认领（如另一窗口并发）：拒绝且不改变任何状态
    expect(store.claimPendingMessage(sessionId)).toEqual({ ok: false, error: "already-dispatching" });
    expect(store.getSession(sessionId)?.messages.map((message) => message.id)).toEqual(["m0", "q-a"]);
    expect(store.getPendingMessages(sessionId)?.map((item) => item.id)).toEqual(["q-b", "q-c"]);

    // 确认派发后可继续认领下一条
    store.completePendingDispatch(sessionId, "q-a");
    const second = store.claimPendingMessage(sessionId);
    expect(second).toEqual(expect.objectContaining({ ok: true, claimed: true }));
    if (!second.ok || !second.claimed) throw new Error("unreachable");
    expect(second.userMessage.id).toBe("q-b");
  });

  it("认领写盘失败：队首保留、messages 不变、无派发状态（绝不半途丢消息）", async () => {
    const { store, sessionId } = await seedThreeMessages();

    // 物理方式制造写盘失败：原子写 .tmp 路径被目录占用
    const tmpPath = path.join(store.getRootDir(), "sessions", `${sessionId}.json.tmp`);
    fs.mkdirSync(tmpPath, { recursive: true });
    expect(store.claimPendingMessage(sessionId)).toEqual({ ok: false, error: "write-failed" });
    fs.rmdirSync(tmpPath);

    // 写盘失败后一切如初：队首仍在队列、历史未追加、无 pendingDispatch
    const persisted = store.getSession(sessionId);
    expect(persisted?.messages.map((message) => message.id)).toEqual(["m0"]);
    expect(persisted?.pendingMessages?.map((item) => item.id)).toEqual(["q-a", "q-b", "q-c"]);
    expect(persisted?.pendingDispatch).toBeUndefined();
  });

  it("认领时会话文件写成功、索引写失败：认领仍成立，不得让调用方误判为失败", async () => {
    const { store, sessionId } = await seedThreeMessages();

    // 物理方式制造索引写失败：index.json 的原子写 .tmp 路径被目录占用
    const indexTmp = path.join(store.getRootDir(), "index.json.tmp");
    fs.mkdirSync(indexTmp, { recursive: true });
    let claim: ReturnType<typeof store.claimPendingMessage>;
    try {
      claim = store.claimPendingMessage(sessionId);
    } finally {
      fs.rmdirSync(indexTmp);
    }

    // 会话文件（权威）已写成功：认领必须如实返回成功，否则调用方误判后重试
    // 会被 already-dispatching 守卫拒绝，消息卡死在派发状态
    expect(claim).toEqual(expect.objectContaining({ ok: true, claimed: true }));
    if (!claim.ok || !claim.claimed) throw new Error("unreachable");
    expect(claim.userMessage.id).toBe("q-a");
    // 磁盘事实：用户消息已入册、派发状态已落盘、队首已移出
    const persisted = store.getSession(sessionId);
    expect(persisted?.messages.map((message) => message.id)).toEqual(["m0", "q-a"]);
    expect(persisted?.pendingDispatch).toEqual({ messageId: "q-a", claimedAt: expect.any(Number) });
    expect(persisted?.pendingMessages?.map((item) => item.id)).toEqual(["q-b", "q-c"]);
    // 后续派发确认照常可用（索引阻塞已解除）
    expect(store.completePendingDispatch(sessionId, "q-a")).toEqual({ ok: true, cleared: true });
  });

  it("删除与认领竞争：认领后按同 id 删除幂等成功，认领后的消息不丢", async () => {
    const { store, sessionId } = await seedThreeMessages();

    const claim = store.claimPendingMessage(sessionId);
    if (!claim.ok || !claim.claimed) throw new Error("unreachable");
    // 用户在另一窗口点了撤回，但该条目已被认领转正：删除幂等成功（removed=false）
    expect(store.removePendingMessage(sessionId, "q-a")).toEqual({ ok: true, removed: false });
    // 转正的消息保留在历史，剩余队列不受影响
    expect(store.getSession(sessionId)?.messages.map((message) => message.id)).toEqual(["m0", "q-a"]);
    expect(store.getPendingMessages(sessionId)?.map((item) => item.id)).toEqual(["q-b", "q-c"]);
  });

  it("刷新/进程重启恢复：认领后重启 → 用户消息在历史、派发状态残留、队列为空", async () => {
    let store = await import("./chats-store");
    store.initialize();
    const session = store.createSession({ mode: "work" });
    store.enqueuePendingMessage(session.id, entry({ id: "q-1", rawContent: "认领后崩溃", visibleContent: "认领后崩溃" }));

    const claim = store.claimPendingMessage(session.id);
    expect(claim).toEqual(expect.objectContaining({ ok: true, claimed: true }));

    // 模拟进程重启：认领已落盘但 completeDispatch 尚未发生
    vi.resetModules();
    store = await import("./chats-store");
    store.initialize();

    const restored = store.getSession(session.id);
    // 页面恢复入口需要的全部事实都在磁盘上：消息已入册、认领状态指向它、队列为空
    expect(restored?.messages.map((message) => message.id)).toEqual(["q-1"]);
    expect(restored?.pendingDispatch).toEqual({ messageId: "q-1", claimedAt: expect.any(Number) });
    expect(restored?.pendingMessages ?? []).toEqual([]);
    // 恢复确认派发仍可完成（幂等链路闭环）
    expect(store.completePendingDispatch(session.id, "q-1")).toEqual({ ok: true, cleared: true });
  });

  it("认领等于真实历史入册：刷新排序时间并更新列表 messageCount", async () => {
    const { store, sessionId } = await seedThreeMessages();
    const before = store.getSession(sessionId);

    const claim = store.claimPendingMessage(sessionId);
    if (!claim.ok || !claim.claimed) throw new Error("unreachable");

    const after = store.getSession(sessionId);
    expect(after?.updatedAt).toBeGreaterThanOrEqual(before?.updatedAt ?? 0);
    expect(store.listSessions().find((item) => item.id === sessionId)?.messageCount).toBe(2);
  });

  it("首条用户消息认领后立即派生临时标题，等待异步模型标题时不显示新对话", async () => {
    const store = await import("./chats-store");
    store.initialize();
    const session = store.createSession({ mode: "learn" });
    store.enqueuePendingMessage(session.id, entry({
      id: "first-user",
      rawContent: "请帮我制定机器学习计划",
      visibleContent: "请帮我制定机器学习计划",
    }));

    expect(store.claimPendingMessage(session.id)).toEqual(expect.objectContaining({ ok: true, claimed: true }));
    expect(store.getSession(session.id)?.title).toBe("请帮我制定机器学习计划");
  });

  it("入队携带的恢复 run 标识随认领带出，供续派启动模型时使用", async () => {
    const store = await import("./chats-store");
    store.initialize();
    const session = store.createSession({ mode: "work" });
    store.enqueuePendingMessage(session.id, entry({
      id: "q-resume",
      rawContent: "继续上次任务",
      visibleContent: "继续上次任务",
      resumeFromRunId: "run-old",
    }));

    const claim = store.claimPendingMessage(session.id);
    expect(claim).toEqual(expect.objectContaining({ ok: true, claimed: true, resumeFromRunId: "run-old" }));
  });
});

describe("chats pending edit & adjust", () => {
  beforeEach(() => {
    vi.resetModules();
    mocks.userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "cyrene-pending-edit-"));
  });

  /** 建会话并入队两条消息，返回会话 id 与首条入队时间。 */
  async function seedTwoMessages() {
    const store = await import("./chats-store");
    store.initialize();
    const session = store.createSession({
      mode: "work",
      initialMessages: [{ id: "m0", role: "user", content: "已有历史", at: 1 }],
    });
    store.enqueuePendingMessage(session.id, entry({ id: "q-a", rawContent: "消息甲", visibleContent: "消息甲" }));
    store.enqueuePendingMessage(session.id, entry({ id: "q-b", rawContent: "消息乙", visibleContent: "消息乙" }));
    const enqueuedAt = store.getPendingMessages(session.id)?.[0].enqueuedAt ?? 0;
    return { store, sessionId: session.id, enqueuedAt };
  }

  it("编辑成功：三个文字字段更新，标识/入队时间/顺序/附件保持不变", async () => {
    const { store, sessionId, enqueuedAt } = await seedTwoMessages();
    store.enqueuePendingMessage(sessionId, entry({
      id: "q-att",
      rawContent: "带附件的",
      visibleContent: "带附件的",
      attachments: [{ kind: "document", name: "报告.txt", filePath: "C:/tmp/报告.txt" }],
    }));

    const result = store.editPendingMessage(sessionId, "q-a", {
      rawContent: "改后的文字 [sticker:shy]",
      visibleContent: "改后的文字",
      userSticker: "shy",
    });
    expect(result).toEqual(expect.objectContaining({ ok: true }));
    const queue = result.ok ? result.queue : [];
    expect(queue.map((item) => item.id)).toEqual(["q-a", "q-b", "q-att"]);
    expect(queue[0]).toMatchObject({
      rawContent: "改后的文字 [sticker:shy]",
      visibleContent: "改后的文字",
      userSticker: "shy",
      enqueuedAt,
    });
    // 其他条目与附件不受影响
    expect(queue[2].attachments).toEqual([
      { kind: "document", name: "报告.txt", filePath: "C:/tmp/报告.txt" },
    ]);
    // 编辑不把待发条目转成正式消息，也不动列表计数
    expect(store.getSession(sessionId)?.messages.map((message) => message.id)).toEqual(["m0"]);
    expect(store.listSessions().find((item) => item.id === sessionId)?.messageCount).toBe(1);
  });

  it("编辑清空表情标记：未传 userSticker 时移除原标记", async () => {
    const store = await import("./chats-store");
    store.initialize();
    const session = store.createSession({ mode: "chat" });
    store.enqueuePendingMessage(session.id, {
      id: "q-sticker",
      rawContent: "抱抱 [sticker:playful]",
      visibleContent: "抱抱",
      userSticker: "playful",
    });

    const result = store.editPendingMessage(session.id, "q-sticker", {
      rawContent: "只改文字",
      visibleContent: "只改文字",
    });
    expect(result.ok).toBe(true);
    expect(store.getPendingMessages(session.id)?.[0]).not.toHaveProperty("userSticker");
    expect(store.getPendingMessages(session.id)?.[0].rawContent).toBe("只改文字");
  });

  it("空文字拒绝：队列保持原样", async () => {
    const { store, sessionId } = await seedTwoMessages();

    const result = store.editPendingMessage(sessionId, "q-a", { rawContent: "   ", visibleContent: "" });
    expect(result).toEqual(expect.objectContaining({ ok: false, error: "empty-content" }));
    expect(store.getPendingMessages(sessionId)?.[0].rawContent).toBe("消息甲");
  });

  it("编辑与认领竞争：条目已被认领转正后编辑被拒，返回 already-claimed 与最新队列", async () => {
    const { store, sessionId } = await seedTwoMessages();
    // 认领队首（q-a 转正式消息并进入派发流程）
    const claim = store.claimPendingMessage(sessionId);
    expect(claim).toEqual(expect.objectContaining({ ok: true, claimed: true }));

    // 另一窗口此时编辑同一条目：明确拒绝，不覆盖新状态
    const result = store.editPendingMessage(sessionId, "q-a", {
      rawContent: "迟到的编辑",
      visibleContent: "迟到的编辑",
    });
    expect(result).toEqual(expect.objectContaining({ ok: false, error: "already-claimed" }));
    // 附带的最新权威队列反映认领后的世界（q-a 已移出）
    if (!result.ok) {
      expect(result.queue?.map((item) => item.id)).toEqual(["q-b"]);
    }
    // 认领转正的消息内容未被编辑覆盖
    expect(store.getSession(sessionId)?.messages.at(-1)?.content).toBe("消息甲");
    // 队首外的条目（未认领）仍可编辑
    const editB = store.editPendingMessage(sessionId, "q-b", {
      rawContent: "消息乙改",
      visibleContent: "消息乙改",
    });
    expect(editB.ok).toBe(true);
  });

  it("编辑已标记插入当前运行的条目被拒：already-adjusting", async () => {
    const { store, sessionId } = await seedTwoMessages();
    expect(store.markPendingAdjust(sessionId, "q-a", "run-1")).toEqual(expect.objectContaining({ ok: true }));

    const result = store.editPendingMessage(sessionId, "q-a", {
      rawContent: "改标记中的条目",
      visibleContent: "改标记中的条目",
    });
    expect(result).toEqual(expect.objectContaining({ ok: false, error: "already-adjusting" }));
    expect(store.getPendingMessages(sessionId)?.[0].rawContent).toBe("消息甲");
  });

  it("撤回已标记插入当前运行的条目被拒：already-adjusting，复位后可撤回", async () => {
    const { store, sessionId } = await seedTwoMessages();
    expect(store.markPendingAdjust(sessionId, "q-a", "run-1")).toEqual(expect.objectContaining({ ok: true }));

    const result = store.removePendingMessage(sessionId, "q-a");
    expect(result).toEqual(expect.objectContaining({ ok: false, error: "already-adjusting" }));
    // 附带最新权威队列，调用方据此刷新投影、不覆盖新状态
    if (!result.ok) {
      expect(result.queue?.map((item) => item.id)).toEqual(["q-a", "q-b"]);
    }
    // 条目原样保留（标记未被清除）
    expect(store.getPendingMessages(sessionId)?.[0]).toMatchObject({ id: "q-a", adjustRunId: "run-1" });

    // 运行终止复位标记后，条目回到普通队列，此时可正常撤回
    store.resetPendingAdjustByRun(sessionId, "run-1");
    expect(store.removePendingMessage(sessionId, "q-a")).toEqual({ ok: true, removed: true });
    expect(store.getPendingMessages(sessionId)?.map((item) => item.id)).toEqual(["q-b"]);
  });

  it("撤回与插话双写的并发窗口：轨迹写入挂起期间撤回被拒，恢复后双写完成", async () => {
    const { store, sessionId } = await seedTwoMessages();
    const { createRunAdjustmentPoller } = await import("./pending-adjustment");
    expect(store.markPendingAdjust(sessionId, "q-a", "run-1")).toEqual(expect.objectContaining({ ok: true }));

    // 挂起的轨迹端口：appendUser 在手动放行前不返回，模拟双写第一步进行中
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const appendedTurnIds: string[] = [];
    const poll = createRunAdjustmentPoller(sessionId, "run-1", store, {
      appendUser: async (input) => {
        appendedTurnIds.push(input.turnId);
        await gate;
      },
    });
    const polling = poll()!;
    expect(polling).toBeInstanceOf(Promise);

    // 窗口内撤回：already-adjusting 拒绝，条目保留
    expect(store.removePendingMessage(sessionId, "q-a")).toEqual(
      expect.objectContaining({ ok: false, error: "already-adjusting" }),
    );
    expect(store.getPendingMessages(sessionId)?.[0].id).toBe("q-a");

    // 恢复写入：双写完成，条目转正移出队列
    release();
    const injected = await polling;
    expect(injected.map((item) => item.id)).toEqual(["q-a"]);
    expect(appendedTurnIds).toEqual(["q-a"]);
    expect(store.getPendingMessages(sessionId)?.map((item) => item.id)).toEqual(["q-b"]);
  });

  it("编辑不存在的条目与会话：not-found / session-not-found", async () => {
    const { store, sessionId } = await seedTwoMessages();

    expect(store.editPendingMessage(sessionId, "ghost", {
      rawContent: "文字",
      visibleContent: "文字",
    })).toEqual(expect.objectContaining({ ok: false, error: "not-found" }));
    expect(store.editPendingMessage("missing", "q-a", {
      rawContent: "文字",
      visibleContent: "文字",
    })).toEqual({ ok: false, error: "session-not-found" });
  });

  it("编辑写盘失败：返回写盘前权威队列，内容未变", async () => {
    const { store, sessionId } = await seedTwoMessages();
    // 物理方式制造写盘失败：原子写 .tmp 路径被目录占用
    const tmpPath = path.join(store.getRootDir(), "sessions", `${sessionId}.json.tmp`);
    fs.mkdirSync(tmpPath, { recursive: true });

    const result = store.editPendingMessage(sessionId, "q-a", {
      rawContent: "不会落盘的编辑",
      visibleContent: "不会落盘的编辑",
    });
    expect(result).toEqual(expect.objectContaining({ ok: false, error: "write-failed" }));
    if (!result.ok) {
      expect(result.queue?.[0].rawContent).toBe("消息甲");
    }
    fs.rmdirSync(tmpPath);
    // 磁盘事实：编辑从未发生
    expect(store.getPendingMessages(sessionId)?.[0].rawContent).toBe("消息甲");
  });

  it("标记调整：绑定 runId 落盘；同 runId 重复幂等；其他 runId 拒绝", async () => {
    const { store, sessionId } = await seedTwoMessages();

    const first = store.markPendingAdjust(sessionId, "q-a", "run-1");
    expect(first).toEqual(expect.objectContaining({ ok: true }));
    expect(store.getPendingMessages(sessionId)?.[0]).toMatchObject({ id: "q-a", adjustRunId: "run-1" });

    // 同一运行重复请求：幂等成功
    expect(store.markPendingAdjust(sessionId, "q-a", "run-1")).toEqual(expect.objectContaining({ ok: true }));
    // 已标记其他运行（如旧运行复位前的新请求）：拒绝且不覆盖
    const conflict = store.markPendingAdjust(sessionId, "q-a", "run-2");
    expect(conflict).toEqual(expect.objectContaining({ ok: false, error: "already-adjusting" }));
    expect(store.getPendingMessages(sessionId)?.[0].adjustRunId).toBe("run-1");

    // 不存在的条目 / 会话
    expect(store.markPendingAdjust(sessionId, "ghost", "run-1")).toEqual(
      expect.objectContaining({ ok: false, error: "not-found" }),
    );
    expect(store.markPendingAdjust("missing", "q-a", "run-1")).toEqual(
      { ok: false, error: "session-not-found" },
    );
  });

  it("带附件的条目不能标记调整：明确拒绝并留队（绝不能只插文字）", async () => {
    const store = await import("./chats-store");
    store.initialize();
    const session = store.createSession({ mode: "work" });
    store.enqueuePendingMessage(session.id, entry({
      id: "q-att",
      rawContent: "看这张图",
      visibleContent: "看这张图",
      attachments: [{ kind: "image", name: "截图.png", filePath: "C:/tmp/shot.png", mime: "image/png" }],
    }));

    const result = store.markPendingAdjust(session.id, "q-att", "run-1");
    expect(result).toEqual(expect.objectContaining({ ok: false, error: "has-attachments" }));
    // 条目原样留在队列：无标记、附件完整
    const queue = store.getPendingMessages(session.id);
    expect(queue?.[0]).not.toHaveProperty("adjustRunId");
    expect(queue?.[0].attachments).toHaveLength(1);
  });

  it("已被认领的条目不能标记调整：already-claimed", async () => {
    const { store, sessionId } = await seedTwoMessages();
    const claim = store.claimPendingMessage(sessionId);
    expect(claim).toEqual(expect.objectContaining({ ok: true, claimed: true }));

    const result = store.markPendingAdjust(sessionId, "q-a", "run-1");
    expect(result).toEqual(expect.objectContaining({ ok: false, error: "already-claimed" }));
  });

  it("提交调整：单次写入完成移出队列与正式消息入册（含表情），不写派发状态", async () => {
    const store = await import("./chats-store");
    store.initialize();
    const session = store.createSession({
      mode: "work",
      initialMessages: [{ id: "m0", role: "user", content: "已有历史", at: 1 }],
    });
    store.enqueuePendingMessage(session.id, entry({
      id: "q-adj",
      rawContent: "插话：换个思路 [sticker:playful]",
      visibleContent: "插话：换个思路",
      userSticker: "playful",
    }));
    store.enqueuePendingMessage(session.id, entry({ id: "q-next", rawContent: "下一条", visibleContent: "下一条" }));
    store.markPendingAdjust(session.id, "q-adj", "run-1");

    const commit = store.commitPendingAdjust(session.id, "q-adj", "run-1");
    expect(commit).toEqual(expect.objectContaining({ ok: true }));
    if (commit.ok) {
      expect(commit.userMessage).toMatchObject({
        id: "q-adj",
        role: "user",
        content: "插话：换个思路 [sticker:playful]",
        sticker: "playful",
      });
      expect(commit.remainingQueue.map((item) => item.id)).toEqual(["q-next"]);
    }
    // 正式历史追加一条；队列少一条；没有派发状态（调整由当前运行直接消费）
    const persisted = store.getSession(session.id);
    expect(persisted?.messages.map((message) => message.id)).toEqual(["m0", "q-adj"]);
    expect(persisted?.pendingMessages?.map((item) => item.id)).toEqual(["q-next"]);
    expect(persisted?.pendingDispatch).toBeUndefined();
    // 认领等于历史入册的口径：列表计数刷新
    expect(store.listSessions().find((item) => item.id === session.id)?.messageCount).toBe(2);
  });

  it("v2 调整轮询先写 user:v1 轨迹再 commit，恢复后只保留一条 user 且磁盘无 messages", async () => {
    const store = await import("./chats-store");
    const { ConversationTranscriptStore } = await import("../orchestrator/conversation-transcript-store");
    const { ConversationJournalService } = await import("../orchestrator/conversation-journal-service");
    const { createRunAdjustmentPoller } = await import("./pending-adjustment");
    store.initialize();
    const session = store.createSession({ mode: "work" });
    const file = path.join(store.getRootDir(), "sessions", `${session.id}.json`);
    const persisted = JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>;
    delete persisted.messages;
    persisted.schemaVersion = 2;
    persisted.messageCount = 0;
    fs.writeFileSync(file, JSON.stringify(persisted));
    store.enqueuePendingMessage(session.id, entry({ id: "adjust-v2", rawContent: "插话内容" }));
    expect(store.markPendingAdjust(session.id, "adjust-v2", "run-v2")).toEqual(expect.objectContaining({ ok: true }));

    const transcriptStore = new ConversationTranscriptStore(mocks.userDataDir);
    const journal = new ConversationJournalService(transcriptStore);
    const order: string[] = [];
    const poll = createRunAdjustmentPoller(session.id, "run-v2", store, {
      appendUser: async ({ turnId, text, attachments }) => {
        order.push("transcript");
        await journal.appendUser(session.id, {
          id: `user:v1:${turnId}:r1`, turnId, text, attachments,
        });
      },
    });
    const injected = await poll();
    order.push("commit-returned");
    expect(injected?.map((item) => item.id)).toEqual(["adjust-v2"]);
    expect(order).toEqual(["transcript", "commit-returned"]);
    const projection = await journal.readProjection(session.id);
    expect(projection.messages.filter((message) => message.role === "user")).toHaveLength(1);
    expect(projection.messages[0]).toEqual(expect.objectContaining({ id: "user:v1:adjust-v2:r1" }));
    const disk = JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>;
    expect(disk.schemaVersion).toBe(2);
    expect(disk).not.toHaveProperty("messages");
  });

  it("提交调整的运行匹配与防重复：run-mismatch 拒绝；再提交已移出的条目 not-found", async () => {
    const { store, sessionId } = await seedTwoMessages();
    store.markPendingAdjust(sessionId, "q-a", "run-1");

    // 其他运行无权提交本运行标记的条目
    expect(store.commitPendingAdjust(sessionId, "q-a", "run-other")).toEqual(
      expect.objectContaining({ ok: false, error: "run-mismatch" }),
    );
    // 本运行提交成功后条目已移出：再次提交（如重复轮询竞态）not-found，绝不重复注入
    expect(store.commitPendingAdjust(sessionId, "q-a", "run-1")).toEqual(
      expect.objectContaining({ ok: true }),
    );
    expect(store.commitPendingAdjust(sessionId, "q-a", "run-1")).toEqual(
      expect.objectContaining({ ok: false, error: "not-found" }),
    );
    expect(store.getSession(sessionId)?.messages.filter((message) => message.id === "q-a")).toHaveLength(1);
  });

  it("提交调整写盘失败：条目保留标记在队列、历史不追加（绝不丢消息）", async () => {
    const { store, sessionId } = await seedTwoMessages();
    store.markPendingAdjust(sessionId, "q-a", "run-1");

    const tmpPath = path.join(store.getRootDir(), "sessions", `${sessionId}.json.tmp`);
    fs.mkdirSync(tmpPath, { recursive: true });
    const commit = store.commitPendingAdjust(sessionId, "q-a", "run-1");
    expect(commit).toEqual({ ok: false, error: "write-failed" });
    fs.rmdirSync(tmpPath);

    // 磁盘事实：条目仍在队列（保留标记，等下个边界重试）、历史未追加
    const persisted = store.getSession(sessionId);
    expect(persisted?.messages.map((message) => message.id)).toEqual(["m0"]);
    expect(persisted?.pendingMessages?.[0]).toMatchObject({ id: "q-a", adjustRunId: "run-1" });
  });

  it("运行终态复位：清掉本运行标记回普通队列（顺序内容不变），其他运行标记不动", async () => {
    const { store, sessionId } = await seedTwoMessages();
    store.markPendingAdjust(sessionId, "q-a", "run-1");
    store.markPendingAdjust(sessionId, "q-b", "run-2");

    const reset = store.resetPendingAdjustByRun(sessionId, "run-1");
    expect(reset).toEqual({ ok: true, reset: 1 });
    const queue = store.getPendingMessages(sessionId);
    // q-a 清标记回普通队列，q-b 的其他运行标记不受影响
    expect(queue?.[0]).not.toHaveProperty("adjustRunId");
    expect(queue?.[1]).toMatchObject({ id: "q-b", adjustRunId: "run-2" });
    // 复位后的条目可被编辑、可再次标记、可正常认领
    expect(store.editPendingMessage(sessionId, "q-a", {
      rawContent: "复位后编辑",
      visibleContent: "复位后编辑",
    }).ok).toBe(true);
    const claim = store.claimPendingMessage(sessionId);
    expect(claim).toEqual(expect.objectContaining({ ok: true, claimed: true }));
    if (claim.ok && claim.claimed) expect(claim.userMessage.content).toBe("复位后编辑");
    // 无匹配标记时不写盘（reset=0）
    expect(store.resetPendingAdjustByRun(sessionId, "run-none")).toEqual({ ok: true, reset: 0 });
  });

  it("刷新/进程重启恢复：标记已落盘，重启后由启动清扫统一清回普通队列", async () => {
    let store = await import("./chats-store");
    store.initialize();
    const session = store.createSession({ mode: "work" });
    store.enqueuePendingMessage(session.id, entry({ id: "q-1", rawContent: "插话一", visibleContent: "插话一" }));
    store.enqueuePendingMessage(session.id, entry({ id: "q-2", rawContent: "插话二", visibleContent: "插话二" }));
    store.markPendingAdjust(session.id, "q-1", "run-old");
    store.markPendingAdjust(session.id, "q-2", "run-old");
    expect(store.getPendingMessages(session.id)?.every((item) => item.adjustRunId === "run-old")).toBe(true);

    // 模拟进程重启（运行全部不复存在）：重新加载后调用启动清扫
    vi.resetModules();
    store = await import("./chats-store");
    store.initialize();
    store.clearStalePendingAdjustMarks();

    const restored = store.getPendingMessages(session.id);
    expect(restored?.map((item) => item.id)).toEqual(["q-1", "q-2"]);
    expect(restored?.every((item) => !item.adjustRunId)).toBe(true);
    // 清扫后条目可正常认领派发（消息不丢）
    const claim = store.claimPendingMessage(session.id);
    expect(claim).toEqual(expect.objectContaining({ ok: true, claimed: true }));
  });

  it("编辑 IPC handler：载荷校验 + 透传冲突结果（already-claimed 附最新队列）", async () => {
    const { registerChatsIpc } = await import("./chats-ipc");
    const { IPC } = await import("../../shared/ipc-channels");
    registerChatsIpc();

    const create = mocks.handlers.get(IPC.CHATS_CREATE);
    const enqueue = mocks.handlers.get(IPC.CHATS_PENDING_ENQUEUE);
    const edit = mocks.handlers.get(IPC.CHATS_PENDING_EDIT);
    if (!create || !enqueue || !edit) {
      throw new Error("pending edit IPC handler was not registered");
    }
    const event = { sender: {} };
    const session = await create(event, { mode: "work" }) as { id: string };
    await enqueue(event, {
      sessionId: session.id,
      entry: entry({ id: "ipc-edit", rawContent: "IPC 排队", visibleContent: "IPC 排队" }),
    });

    // 载荷非法：缺会话/条目/原文
    expect(await edit(event, null)).toEqual({ ok: false, error: "invalid-payload" });
    expect(await edit(event, { sessionId: session.id, messageId: "ipc-edit" })).toEqual({
      ok: false,
      error: "invalid-payload",
    });
    // 编辑成功：透传权威队列
    const ok = await edit(event, {
      sessionId: session.id,
      messageId: "ipc-edit",
      rawContent: "IPC 改后",
      visibleContent: "IPC 改后",
      userSticker: "shy",
    });
    expect(ok).toEqual(expect.objectContaining({
      ok: true,
      queue: [expect.objectContaining({ rawContent: "IPC 改后", userSticker: "shy" })],
    }));
    // 认领后编辑：冲突透传且附带最新队列
    const claim = mocks.handlers.get(IPC.CHATS_PENDING_CLAIM);
    await claim(event, session.id);
    const conflict = await edit(event, {
      sessionId: session.id,
      messageId: "ipc-edit",
      rawContent: "迟到编辑",
      visibleContent: "迟到编辑",
    });
    expect(conflict).toEqual(expect.objectContaining({ ok: false, error: "already-claimed", queue: [] }));
  });
});

describe("chats pending queue IPC", () => {
  beforeEach(() => {
    vi.resetModules();
    mocks.handlers.clear();
    mocks.userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "cyrene-pending-ipc-"));
  });

  it("入队/读取/删除三个 handler 透传结果且校验载荷", async () => {
    const { registerChatsIpc } = await import("./chats-ipc");
    const { IPC } = await import("../../shared/ipc-channels");
    registerChatsIpc();

    const create = mocks.handlers.get(IPC.CHATS_CREATE);
    const enqueue = mocks.handlers.get(IPC.CHATS_PENDING_ENQUEUE);
    const list = mocks.handlers.get(IPC.CHATS_PENDING_LIST);
    const remove = mocks.handlers.get(IPC.CHATS_PENDING_REMOVE);
    if (!create || !enqueue || !list || !remove) {
      throw new Error("pending queue IPC handlers were not registered");
    }
    const event = { sender: {} };
    const session = await create(event, { mode: "work" }) as { id: string };

    // 载荷非法
    expect(await enqueue(event, null)).toEqual({ ok: false, error: "invalid-payload" });
    expect(await enqueue(event, { sessionId: session.id })).toEqual({ ok: false, error: "invalid-payload" });
    // 正常入队返回权威队列（enqueued=true）
    const enqueuePayload = entry({ id: "ipc-1", rawContent: "IPC 排队", visibleContent: "IPC 排队" });
    expect(await enqueue(event, { sessionId: session.id, entry: enqueuePayload })).toEqual(expect.objectContaining({
      ok: true,
      enqueued: true,
      queue: [expect.objectContaining({ id: "ipc-1" })],
    }));
    // 读取
    expect(await list(event, session.id)).toEqual([
      expect.objectContaining({ id: "ipc-1", rawContent: "IPC 排队" }),
    ]);
    // 同载荷重试（回复丢失场景）：幂等成功 enqueued=false
    expect(await enqueue(event, { sessionId: session.id, entry: enqueuePayload })).toEqual(expect.objectContaining({
      ok: true,
      enqueued: false,
      queue: [expect.objectContaining({ id: "ipc-1" })],
    }));
    // 删除 + 幂等删除 + 不存在的会话
    expect(await remove(event, { sessionId: session.id, messageId: "ipc-1" })).toEqual({ ok: true, removed: true });
    expect(await remove(event, { sessionId: session.id, messageId: "ipc-1" })).toEqual({ ok: true, removed: false });
    expect(await remove(event, { sessionId: "missing", messageId: "ipc-1" })).toEqual({
      ok: false,
      error: "session-not-found",
    });
    expect(await list(event, session.id)).toEqual([]);
  });

  it("认领/派发确认 handler 透传结果且校验载荷", async () => {
    const { registerChatsIpc } = await import("./chats-ipc");
    const { IPC } = await import("../../shared/ipc-channels");
    registerChatsIpc();

    const create = mocks.handlers.get(IPC.CHATS_CREATE);
    const enqueue = mocks.handlers.get(IPC.CHATS_PENDING_ENQUEUE);
    const claim = mocks.handlers.get(IPC.CHATS_PENDING_CLAIM);
    const complete = mocks.handlers.get(IPC.CHATS_PENDING_COMPLETE_DISPATCH);
    if (!create || !enqueue || !claim || !complete) {
      throw new Error("claim/complete IPC handlers were not registered");
    }
    const event = { sender: {} };
    const session = await create(event, { mode: "work" }) as { id: string };
    await enqueue(event, {
      sessionId: session.id,
      entry: entry({ id: "ipc-claim", rawContent: "认领这条", visibleContent: "认领这条" }),
    });

    // 载荷非法
    expect(await claim(event, "")).toEqual({ ok: false, error: "invalid-payload" });
    expect(await complete(event, { sessionId: session.id })).toEqual({ ok: false, error: "invalid-payload" });
    // 认领成功：转正用户消息 + 派发状态 + 权威剩余队列与展示内容
    const claimed = await claim(event, session.id);
    expect(claimed).toEqual(expect.objectContaining({
      ok: true,
      claimed: true,
      visibleContent: "认领这条",
      remainingQueue: [],
      userMessage: expect.objectContaining({ id: "ipc-claim", role: "user" }),
    }));
    // 认领未确认前再认领：同一会话派发中的守卫拦截
    expect(await claim(event, session.id)).toEqual({ ok: false, error: "already-dispatching" });
    // 派发确认：匹配清除 + 不匹配幂等
    expect(await complete(event, { sessionId: session.id, messageId: "ipc-claim" })).toEqual({ ok: true, cleared: true });
    expect(await complete(event, { sessionId: session.id, messageId: "ipc-claim" })).toEqual({ ok: true, cleared: false });
    // 确认后队列空认领
    expect(await claim(event, session.id)).toEqual({ ok: true, claimed: false });
    // 会话不存在
    expect(await claim(event, "missing")).toEqual({ ok: false, error: "session-not-found" });
  });

  it("v2 claim 轨迹写失败不谎报成功，重试幂等落轨迹且不再自动补发", async () => {
    const { registerChatsIpc } = await import("./chats-ipc");
    const { IPC } = await import("../../shared/ipc-channels");
    const chatsStore = await import("./chats-store");
    const { ConversationTranscriptStore } = await import("../orchestrator/conversation-transcript-store");
    registerChatsIpc();

    const create = mocks.handlers.get(IPC.CHATS_CREATE);
    const enqueue = mocks.handlers.get(IPC.CHATS_PENDING_ENQUEUE);
    const claim = mocks.handlers.get(IPC.CHATS_PENDING_CLAIM);
    const complete = mocks.handlers.get(IPC.CHATS_PENDING_COMPLETE_DISPATCH);
    const get = mocks.handlers.get(IPC.CHATS_GET);
    if (!create || !enqueue || !claim || !complete || !get) throw new Error("v2 claim handlers were not registered");
    const event = { sender: {} };
    const session = await create(event, { mode: "chat" }) as { id: string };
    const file = path.join(chatsStore.getRootDir(), "sessions", `${session.id}.json`);
    const persisted = JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>;
    delete persisted.messages;
    persisted.schemaVersion = 2;
    persisted.messageCount = 0;
    fs.writeFileSync(file, JSON.stringify(persisted));
    await enqueue(event, {
      sessionId: session.id,
      entry: entry({ id: "v2-ipc-claim", rawContent: "耐久消息", visibleContent: "耐久消息" }),
    });

    const append = vi.spyOn(ConversationTranscriptStore.prototype, "append")
      .mockRejectedValueOnce(new Error("journal unavailable"));
    expect(await claim(event, session.id)).toEqual({
      ok: false,
      error: "transcript-write-failed",
    });
    const failedDisk = JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, any>;
    expect(failedDisk.pendingDispatch?.userMessage?.text).toBe("耐久消息");
    expect(failedDisk).not.toHaveProperty("messages");

    append.mockRestore();
    // 重试：残留认领被幂等 reconcile 进轨迹并清账；队列已空 → claimed:false。
    // 不再把旧消息当新认领返回——那等于替用户自动补发
    expect(await claim(event, session.id)).toEqual({ ok: true, claimed: false });
    // 旧消息已持久化在轨迹里（用户意图不丢失），以「已发送未回答」等用户下一条消息
    const composed = await get(event, session.id) as { messages: Array<{ id: string; role: string }> };
    expect(composed.messages).toEqual([expect.objectContaining({ id: "v2-ipc-claim", role: "user" })]);
    // complete 幂等：重试认领时已清账，这里 cleared=false
    expect(await complete(event, { sessionId: session.id, messageId: "v2-ipc-claim" })).toEqual({
      ok: true,
      cleared: false,
    });
    const completedDisk = JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>;
    expect(completedDisk.schemaVersion).toBe(2);
    expect(completedDisk.pendingDispatch).toBeUndefined();
    expect(completedDisk).not.toHaveProperty("messages");
  });

  it("v2 残留认领未确认时再认领：旧消息幂等落轨迹并清账，返回下一条而非自动补发", async () => {
    const { registerChatsIpc } = await import("./chats-ipc");
    const { IPC } = await import("../../shared/ipc-channels");
    const chatsStore = await import("./chats-store");
    registerChatsIpc();

    const create = mocks.handlers.get(IPC.CHATS_CREATE);
    const enqueue = mocks.handlers.get(IPC.CHATS_PENDING_ENQUEUE);
    const claim = mocks.handlers.get(IPC.CHATS_PENDING_CLAIM);
    const complete = mocks.handlers.get(IPC.CHATS_PENDING_COMPLETE_DISPATCH);
    const get = mocks.handlers.get(IPC.CHATS_GET);
    if (!create || !enqueue || !claim || !complete || !get) throw new Error("v2 claim handlers were not registered");
    const event = { sender: {} };
    const session = await create(event, { mode: "chat" }) as { id: string };
    const file = path.join(chatsStore.getRootDir(), "sessions", `${session.id}.json`);
    const persisted = JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>;
    delete persisted.messages;
    persisted.schemaVersion = 2;
    persisted.messageCount = 0;
    fs.writeFileSync(file, JSON.stringify(persisted));
    await enqueue(event, { sessionId: session.id, entry: entry({ id: "m-old", rawContent: "旧意图", visibleContent: "旧意图" }) });
    await enqueue(event, { sessionId: session.id, entry: entry({ id: "m-next", rawContent: "新意图", visibleContent: "新意图" }) });

    // 第一次认领成功但 run 从未被确认接受（不调 complete，模拟认领残留）
    const first = await claim(event, session.id) as Record<string, any>;
    expect(first).toEqual(expect.objectContaining({ ok: true, claimed: true }));
    expect(first.userMessage).toEqual(expect.objectContaining({ id: "m-old" }));

    // 残留下再认领：不再把 m-old 当新认领返回（那是自动补发），
    // 而是幂等落轨迹、清残留账，照常认领下一条 m-next
    const second = await claim(event, session.id) as Record<string, any>;
    expect(second).toEqual(expect.objectContaining({ ok: true, claimed: true }));
    expect(second.userMessage).toEqual(expect.objectContaining({ id: "m-next" }));

    // 轨迹同时保留旧意图与新意图：用户下一条消息的模型上下文能看到两者
    const composed = await get(event, session.id) as { messages: Array<{ id: string }> };
    expect(composed.messages.map((message) => message.id)).toEqual(["m-old", "m-next"]);

    expect(await complete(event, { sessionId: session.id, messageId: "m-next" })).toEqual({ ok: true, cleared: true });
    const disk = JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>;
    expect(disk.pendingDispatch).toBeUndefined();
  });
});
