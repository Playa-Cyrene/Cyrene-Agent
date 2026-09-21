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
    expect(store.appendMessage(session.id, {
      id: "u2", role: "user", content: "并发追加", at: 2,
    })).not.toBeNull();
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
});
