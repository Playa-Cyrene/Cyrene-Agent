import fs from "fs";
import os from "os";
import path from "path";
import { beforeEach, describe, expect, it, vi } from "vitest";

const electronMock = vi.hoisted(() => ({
  userDataDir: "",
}));

vi.mock("electron", () => ({
  app: {
    getPath: () => electronMock.userDataDir,
  },
  shell: {
    openPath: vi.fn(),
  },
}));

describe("chats store", () => {
  beforeEach(() => {
    vi.resetModules();
    electronMock.userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "cyrene-chats-store-"));
  });

  it("includes messageCount in paged session metadata", async () => {
    const { createSession, getSessionPage, initialize } = await import("./chats-store");
    initialize();

    const session = createSession({
      initialMessages: [
        { id: "1", role: "user", content: "one", at: 1 },
        { id: "2", role: "model", content: "two", at: 2 },
        { id: "3", role: "user", content: "three", at: 3 },
      ],
    });

    const page = getSessionPage(session.id, null, 2);

    expect(page?.messages).toHaveLength(2);
    expect(page?.session.messageCount).toBe(3);
  });

  it("v2 元数据记录保留 pending 状态往返且磁盘不写回 messages", async () => {
    const store = await import("./chats-store");
    store.initialize();
    const session = store.createSession({ title: "v2 会话" });
    const file = path.join(store.getRootDir(), "sessions", `${session.id}.json`);
    const persisted = JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>;
    delete persisted.messages;
    persisted.schemaVersion = 2;
    persisted.messageCount = 0;
    fs.writeFileSync(file, JSON.stringify(persisted));

    const entry = { id: "q-v2", rawContent: "原始", visibleContent: "原始" };
    expect(store.enqueuePendingMessage(session.id, entry)).toEqual(
      expect.objectContaining({ ok: true, enqueued: true }),
    );
    expect(store.getPendingMessages(session.id)?.map((item) => item.id)).toEqual(["q-v2"]);
    expect(store.editPendingMessage(session.id, "q-v2", {
      rawContent: "编辑后", visibleContent: "编辑后",
    })).toEqual(expect.objectContaining({ ok: true }));
    expect(store.markPendingAdjust(session.id, "q-v2", "run-v2")).toEqual(
      expect.objectContaining({ ok: true }),
    );
    expect(store.commitPendingAdjust(session.id, "q-v2", "run-v2")).toEqual(
      expect.objectContaining({ ok: true, userMessage: expect.objectContaining({ id: "q-v2" }) }),
    );
    expect(store.getPendingMessages(session.id)).toEqual([]);

    expect(store.enqueuePendingMessage(session.id, {
      id: "q-remove", rawContent: "待删除", visibleContent: "待删除",
    })).toEqual(expect.objectContaining({ ok: true }));
    expect(store.removePendingMessage(session.id, "q-remove")).toEqual(
      expect.objectContaining({ ok: true, removed: true }),
    );

    expect(store.enqueuePendingMessage(session.id, {
      id: "q-claim", rawContent: "认领", visibleContent: "认领",
    })).toEqual(expect.objectContaining({ ok: true }));
    const claim = store.claimPendingMessage(session.id);
    expect(claim).toEqual(expect.objectContaining({
      ok: true,
      claimed: true,
      userMessage: expect.objectContaining({ id: "q-claim" }),
    }));
    expect(store.completePendingDispatch(session.id, "q-claim")).toEqual(
      expect.objectContaining({ ok: true, cleared: true }),
    );
    expect(store.renameSession(session.id, "重命名")).not.toBeNull();
    expect(store.setSessionPinned(session.id, true)).not.toBeNull();

    const disk = JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>;
    expect(disk.schemaVersion).toBe(2);
    expect(disk).not.toHaveProperty("messages");
    expect(disk.pendingDispatch).toBeUndefined();
    expect(store.getSessionRecord(session.id)).toEqual(expect.objectContaining({
      schemaVersion: 2,
      title: "重命名",
      pinned: true,
    }));
  });

  it("v2 claim 持久化完整 user 快照以供轨迹恢复", async () => {
    const store = await import("./chats-store");
    store.initialize();
    const session = store.createSession({ title: "可恢复 claim" });
    const file = path.join(store.getRootDir(), "sessions", `${session.id}.json`);
    const persisted = JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>;
    delete persisted.messages;
    persisted.schemaVersion = 2;
    persisted.messageCount = 0;
    fs.writeFileSync(file, JSON.stringify(persisted));

    store.enqueuePendingMessage(session.id, {
      id: "pending-durable",
      rawContent: "原始输入",
      visibleContent: "展示输入",
      userSticker: "wave",
      attachments: [{ kind: "document", name: "notes.txt", filePath: "C:/notes.txt" }],
    });
    const claim = store.claimPendingMessage(session.id);
    expect(claim).toEqual(expect.objectContaining({ ok: true, claimed: true }));

    const disk = JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, any>;
    expect(disk.pendingDispatch).toEqual(expect.objectContaining({
      messageId: "pending-durable",
      claimedAt: expect.any(Number),
      userMessage: {
        id: "pending-durable",
        at: expect.any(Number),
        text: "原始输入",
        visibleContent: "展示输入",
        sticker: "wave",
        attachments: [{ kind: "document", name: "notes.txt", filePath: "C:/notes.txt" }],
      },
    }));
    expect(disk).not.toHaveProperty("messages");
  });

  it("用稳定 withdrawal id 原子标记并提交 v1/v2 pending 撤回", async () => {
    const store = await import("./chats-store");
    store.initialize();
    const v1 = store.createSession({ title: "v1" });
    const v2 = store.createSession({ title: "v2" });
    const v2File = path.join(store.getRootDir(), "sessions", `${v2.id}.json`);
    const v2Disk = JSON.parse(fs.readFileSync(v2File, "utf8")) as Record<string, unknown>;
    delete v2Disk.messages;
    v2Disk.schemaVersion = 2;
    v2Disk.messageCount = 0;
    fs.writeFileSync(v2File, JSON.stringify(v2Disk));

    for (const session of [v1, v2]) {
      expect(store.enqueuePendingMessage(session.id, {
        id: `withdraw-${session.id}`,
        rawContent: "待撤回",
        visibleContent: "待撤回",
      })).toEqual(expect.objectContaining({ ok: true }));
      const first = store.beginPendingWithdrawal(session.id, `withdraw-${session.id}`);
      expect(first).toEqual(expect.objectContaining({ ok: true, withdrawalId: expect.any(String) }));
      expect(store.beginPendingWithdrawal(session.id, `withdraw-${session.id}`)).toEqual(first);
      expect(store.getPendingMessages(session.id)?.[0].withdrawal).toEqual(expect.objectContaining({
        id: (first as { withdrawalId: string }).withdrawalId,
        status: "withdrawing",
        startedAt: expect.any(Number),
      }));
      expect(store.claimPendingMessage(session.id)).toEqual({ ok: false, error: "withdrawal-in-progress" });
      expect(store.editPendingMessage(session.id, `withdraw-${session.id}`, {
        rawContent: "不能改", visibleContent: "不能改",
      })).toEqual(expect.objectContaining({ ok: false, error: "withdrawal-in-progress" }));
      expect(store.markPendingAdjust(session.id, `withdraw-${session.id}`, "run-1")).toEqual(
        expect.objectContaining({ ok: false, error: "withdrawal-in-progress" }),
      );
      expect(store.commitPendingWithdrawal(
        session.id,
        `withdraw-${session.id}`,
        (first as { withdrawalId: string }).withdrawalId,
      )).toEqual({ ok: true, removed: true });
      expect(store.commitPendingWithdrawal(
        session.id,
        `withdraw-${session.id}`,
        (first as { withdrawalId: string }).withdrawalId,
      )).toEqual({ ok: true, removed: false });
      expect(store.getPendingMessages(session.id)).toEqual([]);
      const persisted = JSON.parse(fs.readFileSync(
        path.join(store.getRootDir(), "sessions", `${session.id}.json`),
        "utf8",
      )) as Record<string, unknown>;
      if (session.id === v2.id) expect(persisted).not.toHaveProperty("messages");
    }
  });

  it("includes the immutable session mode in every list item", async () => {
    const { createSession, initialize, listSessions } = await import("./chats-store");
    initialize();

    createSession({ mode: "chat" });
    createSession({ mode: "work" });
    createSession({ mode: "code" });
    createSession({ mode: "learn" });

    expect(listSessions().map((session) => session.mode).sort()).toEqual([
      "chat", "code", "learn", "work",
    ]);
  });

  it("filters session metadata by mode without changing the unfiltered result", async () => {
    const { createSession, initialize, listSessions } = await import("./chats-store");
    initialize();

    const chat = createSession({ mode: "chat" });
    const work = createSession({ mode: "work" });
    const code = createSession({ mode: "code" });

    expect(listSessions({ mode: "code" })).toEqual([
      expect.objectContaining({ id: code.id, mode: "code" }),
    ]);
    expect(new Set(listSessions().map((session) => session.id))).toEqual(
      new Set([chat.id, work.id, code.id]),
    );
  });

  it("migrates Daily sessions to Work without changing their project binding", async () => {
    const root = path.join(electronMock.userDataDir, "cyrene-chats");
    const sessionsDir = path.join(root, "sessions");
    fs.mkdirSync(sessionsDir, { recursive: true });
    const baseMeta = {
      title: "旧对话",
      identityId: null,
      createdAt: 1,
      updatedAt: 1,
      messageCount: 0,
    };
    fs.writeFileSync(path.join(root, "index.json"), JSON.stringify([
      { ...baseMeta, id: "legacy-work" },
      { ...baseMeta, id: "legacy-proactive", purpose: "proactive-chat" },
      { ...baseMeta, id: "existing-code" },
      { ...baseMeta, id: "daily-project", mode: "daily", workspaceRoot: "C:\\projects\\daily", workspaceDisplayName: "daily" },
      { ...baseMeta, id: "invalid-mode" },
    ]));
    const baseSession = {
      title: "旧对话",
      identityId: null,
      messages: [],
      createdAt: 1,
      updatedAt: 1,
      schemaVersion: 1,
    };
    fs.writeFileSync(path.join(sessionsDir, "legacy-work.json"), JSON.stringify({
      ...baseSession,
      id: "legacy-work",
    }));
    fs.writeFileSync(path.join(sessionsDir, "legacy-proactive.json"), JSON.stringify({
      ...baseSession,
      id: "legacy-proactive",
      purpose: "proactive-chat",
    }));
    fs.writeFileSync(path.join(sessionsDir, "existing-code.json"), JSON.stringify({
      ...baseSession,
      id: "existing-code",
      mode: "code",
      codeSession: { clineMode: "act", tasks: [] },
    }));
    fs.writeFileSync(path.join(sessionsDir, "daily-project.json"), JSON.stringify({
      ...baseSession,
      id: "daily-project",
      title: "原 Daily 项目",
      mode: "daily",
      messages: [{ id: "daily-message", role: "user", content: "保留这条消息", at: 1 }],
      workspaceBinding: { workspaceRoot: "C:\\projects\\daily", displayName: "daily", boundAt: 123 },
    }));
    fs.writeFileSync(path.join(sessionsDir, "invalid-mode.json"), JSON.stringify({
      ...baseSession,
      id: "invalid-mode",
      mode: "invalid",
    }));
    fs.writeFileSync(path.join(sessionsDir, "backfilled-work.json"), JSON.stringify({
      ...baseSession,
      id: "backfilled-work",
      mode: "work",
    }));
    const index = JSON.parse(fs.readFileSync(path.join(root, "index.json"), "utf8"));
    index.push({ ...baseMeta, id: "backfilled-work", mode: "work" });
    fs.writeFileSync(path.join(root, "index.json"), JSON.stringify(index));

    const { initialize, listSessions } = await import("./chats-store");
    initialize();

    expect(listSessions().map(({ id, mode }) => ({ id, mode }))).toEqual([
      { id: "legacy-work", mode: "work" },
      { id: "legacy-proactive", mode: "chat" },
      { id: "existing-code", mode: "code" },
      { id: "daily-project", mode: "work" },
      { id: "invalid-mode", mode: "work" },
      { id: "backfilled-work", mode: "work" },
    ]);
    const migrationRoot = path.join(electronMock.userDataDir, "迁移文件夹");
    expect(fs.existsSync(migrationRoot)).toBe(true);
    expect(fs.readdirSync(migrationRoot)).toEqual([]);
    expect(JSON.parse(fs.readFileSync(path.join(sessionsDir, "legacy-work.json"), "utf8"))).toEqual(
      expect.objectContaining({
        mode: "work",
        workspaceBinding: expect.objectContaining({
          workspaceRoot: migrationRoot,
          displayName: "迁移文件夹",
        }),
      }),
    );
    expect(JSON.parse(fs.readFileSync(path.join(root, "index.json"), "utf8"))).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "legacy-work", mode: "work", workspaceDisplayName: "迁移文件夹" }),
        expect.objectContaining({ id: "legacy-proactive", mode: "chat" }),
        expect.objectContaining({ id: "existing-code", mode: "code" }),
        expect.objectContaining({ id: "daily-project", mode: "work", workspaceRoot: "C:\\projects\\daily", workspaceDisplayName: "daily" }),
        expect.objectContaining({ id: "invalid-mode", mode: "work", workspaceDisplayName: "迁移文件夹" }),
      ]),
    );
    expect(JSON.parse(fs.readFileSync(path.join(sessionsDir, "daily-project.json"), "utf8"))).toEqual(
      expect.objectContaining({
        title: "原 Daily 项目",
        mode: "work",
        messages: [{ id: "daily-message", role: "user", content: "保留这条消息", at: 1 }],
        workspaceBinding: { workspaceRoot: "C:\\projects\\daily", displayName: "daily", boundAt: 123 },
      }),
    );
  });

  it("removes obsolete Cline metadata while retaining Code messages and workspace", async () => {
    const store = await import("./chats-store");
    store.initialize();
    const session = store.createSession({
      mode: "code",
      initialMessages: [{ id: "code-message", role: "user", content: "保留代码会话", at: 1 }],
    });

    const persisted = store.getSession(session.id) as unknown as Record<string, unknown>;
    expect(persisted.mode).toBe("code");
    expect(persisted.messages).toEqual([{ id: "code-message", role: "user", content: "保留代码会话", at: 1 }]);
    expect(persisted).not.toHaveProperty("codeSession");
  });

  it("keeps the legacy migration idempotent on restart", async () => {
    const root = path.join(electronMock.userDataDir, "cyrene-chats");
    const sessionsDir = path.join(root, "sessions");
    fs.mkdirSync(sessionsDir, { recursive: true });
    const session = {
      id: "legacy",
      title: "旧对话",
      identityId: null,
      messages: [],
      createdAt: 1,
      updatedAt: 1,
      schemaVersion: 1,
    };
    fs.writeFileSync(path.join(root, "index.json"), JSON.stringify([{
      id: "legacy", title: "旧对话", identityId: null, createdAt: 1, updatedAt: 1, messageCount: 0,
    }]));
    fs.writeFileSync(path.join(sessionsDir, "legacy.json"), JSON.stringify(session));

    let store = await import("./chats-store");
    store.initialize();
    const first = store.getSession("legacy");
    vi.resetModules();
    store = await import("./chats-store");
    store.initialize();
    const second = store.getSession("legacy");

    expect(second?.mode).toBe("work");
    expect(second?.workspaceBinding).toEqual(first?.workspaceBinding);
  });

  it("indexes workspace metadata for grouped conversation lists", async () => {
    const store = await import("./chats-store");
    store.initialize();
    const session = store.createSession({ mode: "work" });
    const workspaceRoot = path.join(electronMock.userDataDir, "project-a");
    fs.mkdirSync(workspaceRoot);

    store.setWorkspaceBinding(session.id, {
      workspaceRoot,
      displayName: "project-a",
      boundAt: 10,
    });

    expect(store.listSessions({ mode: "work" })).toContainEqual(expect.objectContaining({
      id: session.id,
      workspaceRoot,
      workspaceDisplayName: "project-a",
    }));
  });

  it("imports renderer legacy history into the Work migration project", async () => {
    const store = await import("./chats-store");
    store.initialize();

    const session = store.migrateLegacyMessages([
      { id: "old-1", role: "user", content: "以前的消息", at: 1 },
    ]);

    expect(session).toEqual(expect.objectContaining({
      mode: "work",
      workspaceBinding: expect.objectContaining({ displayName: "迁移文件夹" }),
    }));
    expect(store.listSessions({ mode: "work" })).toContainEqual(expect.objectContaining({
      id: session?.id,
      workspaceDisplayName: "迁移文件夹",
    }));
  });

  it("persists and indexes a session purpose", async () => {
    let store = await import("./chats-store");
    store.initialize();

    const created = store.createSession({
      title: "昔涟的主动消息",
      purpose: "proactive-chat",
    });

    expect(store.listSessions()).toContainEqual(expect.objectContaining({
      id: created.id,
      purpose: "proactive-chat",
    }));

    vi.resetModules();
    store = await import("./chats-store");
    store.initialize();

    expect(store.getSessionByPurpose("proactive-chat")?.id).toBe(created.id);
    expect(store.getSession(created.id)?.purpose).toBe("proactive-chat");
  });

  it("returns one proactive session for repeated singleton requests", async () => {
    const store = await import("./chats-store");
    store.initialize();

    const sessions = await Promise.all(Array.from({ length: 8 }, async () => (
      store.getOrCreateSessionByPurpose("proactive-chat", { title: "昔涟的主动消息" })
    )));

    expect(new Set(sessions.map((session) => session.id)).size).toBe(1);
    expect(store.listSessions().filter((session) => session.purpose === "proactive-chat")).toHaveLength(1);

    expect(store.getSession(sessions[0].id)?.title).toBe("昔涟的主动消息");
  });

  it("recreates the proactive singleton after it is deleted", async () => {
    const store = await import("./chats-store");
    store.initialize();

    const first = store.getOrCreateSessionByPurpose("proactive-chat", { title: "昔涟的主动消息" });
    expect(store.deleteSession(first.id)).toBe(true);

    const second = store.getOrCreateSessionByPurpose("proactive-chat", { title: "昔涟的主动消息" });
    expect(second.id).not.toBe(first.id);
    expect(store.getSessionByPurpose("proactive-chat")?.id).toBe(second.id);
  });

  it("persists a generated title without marking it as a manual rename or changing recency", async () => {
    const store = await import("./chats-store");
    store.initialize();
    const created = store.createSession({
      initialMessages: [{ id: "first-user", role: "user", content: "帮我设计一个待办应用", at: 1 }],
      mode: "work",
    });

    expect(store.setGeneratedTitle(created.id, "first-user", "待办应用设计")).toBe(true);

    expect(store.getSession(created.id)).toEqual(expect.objectContaining({
      title: "待办应用设计",
      updatedAt: created.updatedAt,
    }));
    expect(store.getSession(created.id)?.titleIsCustom).not.toBe(true);
    expect(store.listSessions().find((item) => item.id === created.id)?.title).toBe("待办应用设计");
  });

  it("does not overwrite a manual title or a session whose first user message changed", async () => {
    const store = await import("./chats-store");
    store.initialize();
    const renamed = store.createSession({
      initialMessages: [{ id: "first-user", role: "user", content: "原问题", at: 1 }],
    });
    store.renameSession(renamed.id, "我的自定义标题");

    expect(store.setGeneratedTitle(renamed.id, "first-user", "模型生成标题")).toBe(false);
    expect(store.getSession(renamed.id)?.title).toBe("我的自定义标题");

    const changed = store.createSession({
      initialMessages: [{ id: "new-first-user", role: "user", content: "修改后的问题", at: 2 }],
    });
    expect(store.setGeneratedTitle(changed.id, "old-first-user", "过期模型标题")).toBe(false);
    expect(store.getSession(changed.id)?.title).toBe("修改后的问题");
  });
});
