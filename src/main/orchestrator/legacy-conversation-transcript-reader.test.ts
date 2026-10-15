import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ConversationDatabaseClient } from "../storage/conversation-database-client";
import { transcriptStorageKey } from "./legacy-conversation-transcript-reader";
import { withConversationDatabase } from "../../test-utils/conversation-storage";
let root: string, client: ConversationDatabaseClient;
beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), "cyrene-legacy-reader-")); client = new ConversationDatabaseClient(root); });
afterEach(async () => { await client.close(); fs.rmSync(root, { recursive: true, force: true }); });
const user = (seq: number) => ({ seq, id: `u${seq}`, kind: "user", turnId: `t${seq}`, revision: 1, at: seq, payload: { text: `text${seq}` } });
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
function generation() {
  const dir = path.join(root, "transcripts", "c1");
  fs.mkdirSync(path.join(dir, "active"), { recursive: true });
  fs.mkdirSync(path.join(dir, "segments"));
  const archived = JSON.stringify(user(1)) + "\n", active = JSON.stringify(user(2)) + "\n";
  fs.writeFileSync(path.join(dir, "segments", "1-1.jsonl"), archived);
  fs.writeFileSync(path.join(dir, "active", "current.jsonl"), active);
  const manifest = { schemaVersion: 1, activeFile: "active/current.jsonl", archives: [{ fromSeq: 1, throughSeq: 1, file: "segments/1-1.jsonl", sha256: hash(archived) }], seenEntryIds: ["u1", "u2"], seenUserRevisions: ["t1\u00001", "t2\u00001"] };
  fs.writeFileSync(path.join(dir, "generation.json"), JSON.stringify(manifest));
  return { dir, manifest, archived, active };
}
describe("read-only transcript generation import", () => {
  it("imports exactly the referenced generation and retains every original byte", async () => {
    const fixture = generation();
    const orphan = path.join(fixture.dir, "active", "old.jsonl");
    fs.writeFileSync(orphan, JSON.stringify(user(99)) + "\n");
    expect(await client.call("transcript.audit", "c1")).toEqual([user(1), user(2)]);
    expect(fs.readFileSync(path.join(fixture.dir, "segments", "1-1.jsonl"), "utf8")).toBe(fixture.archived);
    expect(fs.readFileSync(path.join(fixture.dir, "active", "current.jsonl"), "utf8")).toBe(fixture.active);
    expect(fs.readFileSync(orphan, "utf8")).toContain('"seq":99');
    await client.close();
    expect(await client.call("transcript.audit", "c1")).toEqual([user(1), user(2)]);
  });
  it("rejects a changed archive without committing any imported row", async () => {
    const { dir } = generation();
    fs.appendFileSync(path.join(dir, "segments", "1-1.jsonl"), " ");
    await expect(client.call("transcript.audit", "c1")).rejects.toThrow("TRANSCRIPT_ARCHIVE_CORRUPT_SEGMENT");
    expect(withConversationDatabase(root, db => db.prepare("SELECT count(*) AS n FROM transcript_entries").get()?.n)).toBe(0);
  });
  it.each(["../outside.jsonl", "active/../outside.jsonl"])("rejects manifest path %s", async (activeFile) => {
    const { dir, manifest } = generation();
    fs.writeFileSync(path.join(dir, "generation.json"), JSON.stringify({ ...manifest, activeFile }));
    await expect(client.call("transcript.read", "c1")).rejects.toThrow("TRANSCRIPT_ARCHIVE_CORRUPT_MANIFEST");
  });
  it("refuses a torn manifest-selected active tail", async () => {
    const { dir } = generation();
    fs.appendFileSync(path.join(dir, "active", "current.jsonl"), '{"seq":');
    await expect(client.call("transcript.read", "c1")).rejects.toThrow("TRANSCRIPT_ARCHIVE_CORRUPT_ACTIVE");
  });
  it("refuses an identity mismatch and preserves its source", async () => {
    const dir = path.join(root, "transcripts", transcriptStorageKey("c1"));
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "identity.json"), JSON.stringify({ schemaVersion: 1, conversationId: "other" }));
    const source = JSON.stringify(user(1)) + "\n";
    fs.writeFileSync(path.join(dir, "transcript.jsonl"), source);
    await expect(client.call("transcript.read", "c1")).rejects.toThrow("TRANSCRIPT_IDENTITY_MISMATCH");
    expect(fs.readFileSync(path.join(dir, "transcript.jsonl"), "utf8")).toBe(source);
  });
  it("refuses missing canonical rows referenced by old seen IDs", async () => {
    const { dir, manifest } = generation();
    fs.writeFileSync(path.join(dir, "generation.json"), JSON.stringify({ ...manifest, seenEntryIds: [...manifest.seenEntryIds, "missing"] }));
    await expect(client.call("transcript.read", "c1")).rejects.toThrow("CONVERSATION_STORE_INTEGRITY_ERROR");
  });
  it("rejects a legacy snapshot sequence gap", async () => {
    const dir = path.join(root, "transcripts", "c1");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "snapshot.json"), JSON.stringify({ schemaVersion: 1, throughSeq: 2, entries: [user(2)] }));
    await expect(client.call("transcript.read", "c1")).rejects.toThrow("CONVERSATION_STORE_INTEGRITY_ERROR");
  });
  it("isolates a malformed legacy run file from valid conversations", async () => {
    const dir = path.join(root, "cyrene-runs", "sessions");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "broken.json"), "{");
    fs.writeFileSync(path.join(dir, "valid.json"), JSON.stringify({ schemaVersion: 2, conversationId: "c1", runId: "old", status: "running", createdAt: 1, updatedAt: 1 }));
    expect(await client.call("runs.all")).toEqual([expect.objectContaining({ runId: "old", status: "interrupted" })]);
    expect(await client.call("chats.createSession", { mode: "chat" })).toHaveProperty("id");
    expect(fs.readFileSync(path.join(dir, "broken.json"), "utf8")).toBe("{");
  });
});
