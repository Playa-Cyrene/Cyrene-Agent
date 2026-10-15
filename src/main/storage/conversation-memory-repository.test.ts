import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ConversationDatabaseClient } from "./conversation-database-client";
import type { PendingMemoryBatch } from "../memory/memory-pending-types";
import { withConversationDatabase } from "../../test-utils/conversation-storage";

describe("durable pending memory turns in the database worker", () => {
  let root: string;
  let client: ConversationDatabaseClient;
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "memory-worker-"));
    client = new ConversationDatabaseClient(root);
  });
  afterEach(async () => {
    await client.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  async function record(n: number, conversationId = "c1", legacyCount = 0) {
    await client.call("transcript.append", conversationId, { id: `user-${n}`, kind: "user", turnId: `u${n}`, revision: 1, at: n, payload: { text: `U${n}` } });
    await client.call("transcript.append", conversationId, { id: `reply-${n}`, kind: "assistant", turnId: `a${n}`, at: n, payload: { role: "assistant", content: `A${n}` } });
    return client.call("memory.record", { conversationId, userTurnId: `u${n}`, assistantEntryId: `reply-${n}`, userInput: `U${n}`, assistantReply: `A${n}` }, legacyCount);
  }
  it("restores five pending turns after a worker restart and consumes only the matching batch", async () => {
    for (let i = 1; i <= 5; i++) await record(i);
    expect(await client.call("memory.batch", "c1")).toBeNull();
    await client.close();
    client = new ConversationDatabaseClient(root);
    await record(6);
    const batch = await client.call<PendingMemoryBatch>("memory.batch", "c1");
    expect(batch.turns.map(t => t.userInput)).toEqual(["U1", "U2", "U3", "U4", "U5", "U6"]);
    expect(await client.call("memory.count")).toBe(6);
    expect(await client.call("memory.consume", batch)).toBe(true);
    await client.close();
    client = new ConversationDatabaseClient(root);
    for (let i = 7; i <= 12; i++) await record(i);
    const next = await client.call<PendingMemoryBatch>("memory.batch", "c1");
    expect(next.turns.map(t => t.userInput)).toEqual(["U5", "U6", "U7", "U8", "U9", "U10", "U11", "U12"]);
  });
  it("rewind invalidates the stored version and rejects delayed old completions", async () => {
    for (let i = 1; i <= 6; i++) await record(i);
    const batch = await client.call<PendingMemoryBatch>("memory.batch", "c1");
    await client.call("transcript.append", "c1", { id: "rewind", kind: "turn_rewind", at: 10, payload: { anchorUserTurnId: "u6", disposition: "keep_user", reason: "regenerate" } });
    expect(await client.call("memory.count")).toBe(5);
    expect(await client.call("memory.current", batch.turns)).toBe(false);
    expect(await client.call("memory.consume", batch)).toBe(false);
    expect(await client.call("memory.record", { conversationId: "c1", userTurnId: "u6", assistantEntryId: "reply-6", userInput: "U6", assistantReply: "A6" }, 6)).toMatchObject({ roundCount: 5 });
    await client.call("transcript.append", "c1", { id: "reply-new", kind: "assistant", turnId: "a-new", at: 11, payload: { role: "assistant", content: "new" } });
    await client.call("memory.record", { conversationId: "c1", userTurnId: "u6", assistantEntryId: "reply-new", userInput: "U6", assistantReply: "new" }, 6);
    expect(await client.call("memory.count")).toBe(6);
    expect((await client.call<PendingMemoryBatch>("memory.batch", "c1")).turns.at(-1)?.assistantReply).toBe("new");
  });
  it("deleting a conversation removes its pending buffer and counted rounds durably", async () => {
    const session = await client.call<{ id: string }>("chats.createSession", { mode: "chat" });
    await record(1, session.id);
    expect(await client.call("chats.deleteSession", session.id)).toBe(true);
    expect(await client.call("memory.count")).toBe(0);
    await client.close();
    client = new ConversationDatabaseClient(root);
    expect(await client.call("memory.count")).toBe(0);
    expect(await client.call("memory.current", [{ conversationId: session.id, userTurnId: "u1", assistantEntryId: "reply-1", userEntryId: "user-1", seq: 1 }])).toBe(false);
  });
  it("initializes the legacy round-count baseline only once", async () => {
    await record(1, "c1", 19);
    expect(await client.call("memory.count")).toBe(20);
    await client.close();
    client = new ConversationDatabaseClient(root);
    await record(2, "c1", 20);
    expect(await client.call("memory.count")).toBe(21);
  });

  it("rolls back transcript rewind if pending-source invalidation cannot commit", async () => {
    await record(1);
    withConversationDatabase(root, db => db.exec(`CREATE TRIGGER fail_memory_invalidation BEFORE UPDATE ON memory_pending_turns
      BEGIN SELECT RAISE(ABORT, 'injected failure'); END`));
    await expect(client.call("transcript.append", "c1", { id: "rewind", kind: "turn_rewind", at: 10, payload: { anchorUserTurnId: "u1", disposition: "keep_user", reason: "regenerate" } })).rejects.toBeDefined();
    expect(await client.call("memory.count")).toBe(1);
    expect((await client.call<Array<{ id: string }>>("transcript.audit", "c1")).map(entry => entry.id)).toEqual(["user-1", "reply-1"]);
    withConversationDatabase(root, db => db.exec('DROP TRIGGER fail_memory_invalidation'));
    await client.call("transcript.append", "c1", { id: "rewind", kind: "turn_rewind", at: 10, payload: { anchorUserTurnId: "u1", disposition: "keep_user", reason: "regenerate" } });
    expect(await client.call("memory.count")).toBe(0);
  });
});
