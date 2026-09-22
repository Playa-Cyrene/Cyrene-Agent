import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ userDataDir: "" }));

vi.mock("electron", () => ({
  app: { getPath: () => mocks.userDataDir },
  shell: { openPath: vi.fn(async () => "") },
}));

const roots: string[] = [];

describe("ConversationSessionMigration", () => {
  beforeEach(() => {
    vi.resetModules();
    mocks.userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "cyrene-session-migration-"));
    roots.push(mocks.userDataDir);
  });

  afterEach(() => {
    for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
  });

  it("播种完成后元数据改写前崩溃，重启只生成一份消息", async () => {
    const { createSession, getRootDir, initialize } = await import("../chats/chats-store");
    initialize();
    const { ConversationTranscriptStore } = await import("./conversation-transcript-store");
    const { ConversationJournalService } = await import("./conversation-journal-service");
    const { ConversationSessionMigration } = await import("./conversation-session-migration");

    const session = createSession({
      title: "旧会话",
      initialMessages: [
        { id: "u1", role: "user", content: "hello", at: 1 },
        { id: "a1", role: "model", content: "world", at: 2 },
      ],
    });
    const transcriptStore = new ConversationTranscriptStore(mocks.userDataDir);
    const journal = new ConversationJournalService(transcriptStore);
    const migration = new ConversationSessionMigration({ journal, store: transcriptStore });
    migration.failAfterCheckpointOnce();

    await expect(migration.ensureConversationMigrated(session.id)).rejects.toThrow("TEST_CRASH");

    const secondStore = new ConversationTranscriptStore(mocks.userDataDir);
    const second = new ConversationSessionMigration({
      journal: new ConversationJournalService(secondStore),
      store: secondStore,
    });
    const secondRecord = await second.ensureConversationMigrated(session.id);

    const projection = await second.getJournal().readProjection(session.id);
    const { composeSession } = await import("../chats/chats-store");
    expect(composeSession(secondRecord!, projection.messages).messages.map((message) => message.id))
      .toEqual(["u1", "a1"]);
    const persisted = JSON.parse(fs.readFileSync(
      path.join(getRootDir(), "sessions", `${session.id}.json`),
      "utf8",
    )) as Record<string, unknown>;
    expect(persisted).not.toHaveProperty("messages");
    expect(persisted).toMatchObject({ schemaVersion: 2, messageCount: 2 });
  });

  it("v1 与 v2 会话都能通过迁移入口组合为既有消息形状", async () => {
    const { createSession, initialize } = await import("../chats/chats-store");
    initialize();
    const { ConversationTranscriptStore } = await import("./conversation-transcript-store");
    const { ConversationJournalService } = await import("./conversation-journal-service");
    const { ConversationSessionMigration } = await import("./conversation-session-migration");

    const session = createSession({
      initialMessages: [{ id: "u1", role: "user", content: "hello", at: 1 }],
    });
    const transcriptStore = new ConversationTranscriptStore(mocks.userDataDir);
    const migration = new ConversationSessionMigration({
      journal: new ConversationJournalService(transcriptStore),
      store: transcriptStore,
    });
    const migrated = await migration.ensureConversationMigrated(session.id);
    expect(migrated).toMatchObject({ schemaVersion: 2, messageCount: 1 });

    const again = await migration.ensureConversationMigrated(session.id);
    expect(again).toEqual(migrated);
    const record = await migration.ensureConversationMigrated(session.id);
    const { composeSession } = await import("../chats/chats-store");
    expect(composeSession(record!, (await migration.getJournal().readProjection(session.id)).messages).messages).toEqual([
      expect.objectContaining({ id: "u1", role: "user", content: "hello" }),
    ]);
  });

  it("checkpoint 后并发追加 v1 消息时不覆盖新消息", async () => {
    const store = await import("../chats/chats-store");
    const { getRootDir } = store;
    store.initialize();
    const session = store.createSession({
      initialMessages: [{ id: "u1", role: "user", content: "旧消息", at: 1 }],
    });
    const { ConversationTranscriptStore } = await import("./conversation-transcript-store");
    const { ConversationJournalService } = await import("./conversation-journal-service");
    const { ConversationSessionMigration } = await import("./conversation-session-migration");
    const transcriptStore = new ConversationTranscriptStore(mocks.userDataDir);
    const migration = new ConversationSessionMigration({
      journal: new ConversationJournalService(transcriptStore),
      store: transcriptStore,
    });
    const gate = migration.pauseAfterCheckpoint();
    const pending = migration.ensureConversationMigrated(session.id);
    await gate.entered;
    // 模拟仍处于 v1 格式的外部写入；生产 writer 已退休，迁移 reader 必须能读到这次追加。
    const file = path.join(getRootDir(), "sessions", `${session.id}.json`);
    const legacy = JSON.parse(fs.readFileSync(file, "utf8")) as { messages: unknown[] };
    legacy.messages.push({ id: "u2", role: "user", content: "并发追加", at: 2 });
    fs.writeFileSync(file, JSON.stringify(legacy));
    gate.release();

    const record = await pending;
    expect(record?.schemaVersion).toBe(2);
    const projection = await migration.getJournal().readProjection(session.id);
    expect(projection.messages.map((message) => message.id)).toEqual([
      expect.stringContaining("migration:v2:u1:canonical"),
      expect.stringContaining("migration:v2:u2:canonical"),
    ]);
  });

  it("checkpoint 后会话被删除时不复活 v2 元数据", async () => {
    const store = await import("../chats/chats-store");
    store.initialize();
    const session = store.createSession({
      initialMessages: [{ id: "u1", role: "user", content: "待删除", at: 1 }],
    });
    const { ConversationTranscriptStore } = await import("./conversation-transcript-store");
    const { ConversationJournalService } = await import("./conversation-journal-service");
    const { ConversationSessionMigration } = await import("./conversation-session-migration");
    const transcriptStore = new ConversationTranscriptStore(mocks.userDataDir);
    const migration = new ConversationSessionMigration({
      journal: new ConversationJournalService(transcriptStore),
      store: transcriptStore,
    });
    const gate = migration.pauseAfterCheckpoint();
    const pending = migration.ensureConversationMigrated(session.id);
    await gate.entered;
    expect(store.deleteSession(session.id)).toBe(true);
    gate.release();

    expect(await pending).toBeNull();
    expect(store.getSessionRecord(session.id)).toBeNull();
  });

  it("v2 pendingDispatch 快照在 composed load 时补写 canonical user 且重启幂等", async () => {
    const store = await import("../chats/chats-store");
    store.initialize();
    const session = store.createSession({ title: "待恢复" });
    const file = path.join(store.getRootDir(), "sessions", `${session.id}.json`);
    const persisted = JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>;
    delete persisted.messages;
    persisted.schemaVersion = 2;
    persisted.messageCount = 0;
    fs.writeFileSync(file, JSON.stringify(persisted));
    store.enqueuePendingMessage(session.id, {
      id: "recover-user",
      rawContent: "崩溃前输入",
      visibleContent: "崩溃前输入",
      userSticker: "calm",
    });
    expect(store.claimPendingMessage(session.id)).toEqual(expect.objectContaining({ claimed: true }));

    const { ConversationTranscriptStore } = await import("./conversation-transcript-store");
    const { ConversationJournalService } = await import("./conversation-journal-service");
    const { ConversationSessionMigration } = await import("./conversation-session-migration");
    const transcriptStore = new ConversationTranscriptStore(mocks.userDataDir);
    const migration = new ConversationSessionMigration({
      journal: new ConversationJournalService(transcriptStore),
      store: transcriptStore,
    });
    const composed = await migration.loadComposedSession(session.id);
    expect(composed?.messages).toEqual([
      expect.objectContaining({ id: "recover-user", role: "user", content: "崩溃前输入", sticker: "calm" }),
    ]);

    const restarted = new ConversationSessionMigration({
      journal: new ConversationJournalService(new ConversationTranscriptStore(mocks.userDataDir)),
      store: new ConversationTranscriptStore(mocks.userDataDir),
    });
    const again = await restarted.loadComposedSession(session.id);
    expect(again?.messages.filter((message) => message.id === "recover-user")).toHaveLength(1);
    const entries = await new ConversationTranscriptStore(mocks.userDataDir).read(session.id);
    expect(entries.entries.filter((entry) => entry.kind === "user")).toHaveLength(1);
    const disk = JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>;
    expect(disk.schemaVersion).toBe(2);
    expect(disk).not.toHaveProperty("messages");
  });

  it("旧 v2 pendingDispatch 缺快照时 fail-closed，不猜测用户内容", async () => {
    const store = await import("../chats/chats-store");
    store.initialize();
    const session = store.createSession({ title: "旧认领状态" });
    const file = path.join(store.getRootDir(), "sessions", `${session.id}.json`);
    const persisted = JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>;
    delete persisted.messages;
    persisted.schemaVersion = 2;
    persisted.messageCount = 0;
    persisted.pendingDispatch = { messageId: "legacy-claim", claimedAt: 1 };
    fs.writeFileSync(file, JSON.stringify(persisted));

    const { ConversationTranscriptStore } = await import("./conversation-transcript-store");
    const { ConversationJournalService } = await import("./conversation-journal-service");
    const { ConversationSessionMigration } = await import("./conversation-session-migration");
    const transcriptStore = new ConversationTranscriptStore(mocks.userDataDir);
    const migration = new ConversationSessionMigration({
      journal: new ConversationJournalService(transcriptStore),
      store: transcriptStore,
    });
    const composed = await migration.loadComposedSession(session.id);
    expect(composed?.messages).toEqual([]);
    expect((await transcriptStore.read(session.id)).entries).toEqual([]);
    expect(store.getPendingDispatch(session.id)).toEqual({ messageId: "legacy-claim", claimedAt: 1 });
  });

  it("两个 factory loader 并发恢复同一 pending intent 只写一条 canonical user", async () => {
    const store = await import("../chats/chats-store");
    store.initialize();
    const session = store.createSession({ title: "并发恢复" });
    const file = path.join(store.getRootDir(), "sessions", `${session.id}.json`);
    const persisted = JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>;
    delete persisted.messages;
    persisted.schemaVersion = 2;
    persisted.messageCount = 0;
    fs.writeFileSync(file, JSON.stringify(persisted));
    store.enqueuePendingMessage(session.id, {
      id: "race-user",
      rawContent: "并发恢复输入",
      visibleContent: "并发恢复输入",
    });
    expect(store.claimPendingMessage(session.id)).toEqual(expect.objectContaining({ claimed: true }));

    const { ConversationTranscriptStore } = await import("./conversation-transcript-store");
    const { createConversationSessionMigration } = await import("./conversation-session-migration");
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let appendCalls = 0;
    let bothStarted!: () => void;
    const both = new Promise<void>((resolve) => { bothStarted = resolve; });
    const originalAppend = ConversationTranscriptStore.prototype.append;
    const appendSpy = vi.spyOn(ConversationTranscriptStore.prototype, "append")
      .mockImplementation(function (this: ConversationTranscriptStore, conversationId, input) {
        appendCalls += 1;
        if (appendCalls === 2) bothStarted();
        return gate.then(() => originalAppend.call(this, conversationId, input));
      });

    const first = createConversationSessionMigration(mocks.userDataDir);
    const second = createConversationSessionMigration(mocks.userDataDir);
    const firstLoad = first.loadComposedSession(session.id);
    const secondLoad = second.loadComposedSession(session.id);
    await both;
    release();
    const [firstComposed, secondComposed] = await Promise.all([firstLoad, secondLoad]);
    appendSpy.mockRestore();

    expect(firstComposed?.messages.filter((message) => message.id === "race-user")).toHaveLength(1);
    expect(secondComposed?.messages.filter((message) => message.id === "race-user")).toHaveLength(1);
    const transcript = await new ConversationTranscriptStore(mocks.userDataDir).read(session.id);
    expect(transcript.entries.filter((entry) => entry.kind === "user")).toHaveLength(1);
    expect(transcript.entries.filter((entry) => entry.id === "user:v1:race-user:r1")).toHaveLength(1);
  });

  it("79fad414 之前的旧格式轨迹条目：迁移跳过已落盘轮次，不再撞幂等冲突", async () => {
    const { createSession, initialize } = await import("../chats/chats-store");
    initialize();
    const { ConversationTranscriptStore } = await import("./conversation-transcript-store");

    const session = createSession({
      title: "旧格式轨迹会话",
      initialMessages: [
        { id: "u1", role: "user", content: "拿抽查工具查我几个四则运算题", at: 1 },
        { id: "a1", role: "model", content: "3 + 5 = 8", at: 2 },
      ],
    });

    // 模拟 79fad414 之前落盘的旧格式：user 条目 id 为 ${runId}:user:${turnId} 且带顶层 runId 字段；
    // assistant 为 backfill:v1 条目（turnId 与 v1 消息 id 一致）
    const transcriptStore = new ConversationTranscriptStore(mocks.userDataDir);
    type AppendInput = Parameters<typeof transcriptStore.append>[1];
    await transcriptStore.append(session.id, {
      id: "run-1789951197496-fbw3t3:user:u1",
      at: 1,
      kind: "user",
      turnId: "u1",
      revision: 1,
      runId: "run-1789951197496-fbw3t3",
      payload: { text: "拿抽查工具查我几个四则运算题" },
    } as unknown as AppendInput);
    await transcriptStore.append(session.id, {
      id: "backfill:v1:a1:assistant",
      at: 2,
      kind: "assistant",
      turnId: "a1",
      payload: { role: "assistant", content: "3 + 5 = 8" },
    });

    const { createConversationSessionMigration } = await import("./conversation-session-migration");
    const migration = createConversationSessionMigration(mocks.userDataDir);
    const record = await migration.ensureConversationMigrated(session.id);
    expect(record?.schemaVersion).toBe(2);

    const transcript = await transcriptStore.read(session.id);
    expect(transcript.entries.filter((entry) => entry.id.startsWith("migration:v2:"))).toHaveLength(0);
    expect(transcript.entries.filter((entry) => entry.kind === "user")).toHaveLength(1);
    expect(transcript.entries.filter((entry) => entry.kind === "assistant")).toHaveLength(1);

    const journal = migration.getJournal();
    const projection = await journal.readProjection(session.id);
    expect(projection.messages).toHaveLength(2);
  });
});
