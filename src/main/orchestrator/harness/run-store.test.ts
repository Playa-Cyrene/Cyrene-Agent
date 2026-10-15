import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { HarnessRunStore } from "./run-store";
import { closeConversationDatabases } from "../../storage/conversation-database-client";
const roots: string[] = [];
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cyrene-harness-run-")); roots.push(root);
  return { root, store: new HarnessRunStore(root, { now: () => 1000 }) };
}
afterEach(async () => { await closeConversationDatabases(); for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });
describe("HarnessRunStore SQLite", () => {
  it("stores only metadata and returns isolated snapshots", async () => {
    const { store } = fixture();
    const record = await store.create({ conversationId: "c1", runId: "r1" });
    expect(Object.keys(record).sort()).toEqual(["conversationId", "createdAt", "runId", "schemaVersion", "status", "updatedAt"]);
    record.status = "failed"; expect(store.get("r1")?.status).toBe("running");
    expect(() => store.checkpoint("r1", { rounds: 2 })).toThrow("HARNESS_RUN_CHECKPOINT_DISABLED");
    expect(() => store.recordTool("r1", { toolCallId: "t1", toolName: "write", sideEffect: "idempotent_mutation", status: "started" })).toThrow("HARNESS_RUN_TOOL_LIFECYCLE_DISABLED");
  });
  it("keeps one active run and never overwrites a terminal identity", async () => {
    const { store } = fixture(); await store.create({ conversationId: "c1", runId: "r1" });
    await expect(store.create({ conversationId: "c1", runId: "r1" })).rejects.toThrow("HARNESS_RUN_EXISTS");
    await expect(store.create({ conversationId: "c1", runId: "r2" })).rejects.toThrow();
    await store.markTerminal("r1", "completed");
    await expect(store.create({ conversationId: "c1", runId: "r1" })).rejects.toThrow("HARNESS_RUN_EXISTS");
    await expect(store.create({ conversationId: "c1", runId: "r2" })).resolves.toMatchObject({ status: "running" });
  });
  it("interrupts unfinished runs on worker restart without resending", async () => {
    const { root, store } = fixture(); await store.create({ conversationId: "c1", runId: "r1" });
    await closeConversationDatabases(); const restarted = new HarnessRunStore(root); await restarted.ready;
    expect(restarted.get("r1")?.status).toBe("interrupted");
    expect(restarted.listInterruptedRuns().map(run => run.runId)).toEqual(["r1"]);
    await expect(restarted.create({ conversationId: "c1", runId: "r2" })).resolves.toMatchObject({ status: "running" });
  });
  it("imports legacy runs and leaves the source unchanged", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "cyrene-harness-legacy-")); roots.push(root);
    const directory = path.join(root, "cyrene-runs", "sessions"); fs.mkdirSync(directory, { recursive: true });
    const original = JSON.stringify({ schemaVersion: 1, conversationId: "c1", runId: "r1", status: "running", createdAt: 1, updatedAt: 1,
      messages: [], state: { todoItems: [], uncertainEffects: [] }, toolOutputs: [], toolCalls: [], rounds: 1,
      request: { provider: "test", model: "test", contextWindowTokens: 128000, promptFingerprint: "p", toolSchemaFingerprint: "t" } });
    const file = path.join(directory, "r1.json"); fs.writeFileSync(file, original);
    const store = new HarnessRunStore(root); await store.ready;
    expect(store.get("r1")?.status).toBe("interrupted"); expect(fs.readFileSync(file, "utf8")).toBe(original);
    await expect(store.markTerminal("r1", "completed")).rejects.toThrow("HARNESS_RUN_LEGACY_READ_ONLY");
    await store.deleteConversation("c1"); expect(store.get("r1")).toBeNull();
  });
});
