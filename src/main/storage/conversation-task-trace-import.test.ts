import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ConversationDatabase } from "./conversation-database";
import { importTaskSessions, runTaskCommand } from "./conversation-task-repository";
import type { TaskSession } from "../../shared/task-session";

const fixtures: Array<{ root: string; db: ConversationDatabase }> = [];
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cyrene-task-migration-"));
  const db = new ConversationDatabase(root);
  fixtures.push({ root, db });
  const session: TaskSession = { schemaVersion: 1, id: "old", parentConversationId: "parent", parentRunId: "parent-old", childRunId: "child-old",
    description: "old", subagentType: "general", companionId: "风堇", contextOpen: true, mode: "code", status: "completed",
    messages: [{ role: "user", content: "old question" }, { role: "assistant", content: "old answer" }],
    trace: [{ id: "old-trace", at: 1, kind: "candidate", phase: "end", label: "old" }],
    todoItems: [{ id: "todo", content: "old work", status: "pending" }], createdAt: 1, updatedAt: 2 };
  const directory = path.join(root, "cyrene-tasks", "sessions");
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, "valid.json"), JSON.stringify(session));
  return { root, db, session, directory };
}
afterEach(() => {
  vi.restoreAllMocks();
  for (const { root, db } of fixtures.splice(0)) {
    db.db.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
describe("旧任务轨迹幂等导入", () => {
  it("损坏文件触发导入重试时保留已更新的任务轨迹", () => {
    const { db, directory } = fixture();
    vi.spyOn(console, "warn").mockImplementation(() => {});
    fs.writeFileSync(path.join(directory, "broken.json"), "{");
    importTaskSessions(db);
    const trace = [{ id: "new-trace", at: 3, kind: "candidate", phase: "end", label: "new" }];
    runTaskCommand(db, "tasks.checkpoint", ["old", { trace }, 3]);
    importTaskSessions(db);
    expect((runTaskCommand(db, "tasks.get", ["old"]) as TaskSession).trace).toEqual(trace);
    fs.unlinkSync(path.join(directory, "broken.json"));
    importTaskSessions(db);
    expect((runTaskCommand(db, "tasks.get", ["old"]) as TaskSession).trace).toEqual(trace);
    expect(db.db.prepare("SELECT version FROM schema_migrations WHERE version=102").get()).toBeTruthy();
  });

});
