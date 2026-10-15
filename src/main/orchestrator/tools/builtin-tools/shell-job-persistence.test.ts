import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { getConversationDatabase, closeConversationDatabases } from "../../../storage/conversation-database-client";
import type { ShellJobRecord } from "../../../storage/shell-job-repository";
import { createShutdownCoordinator } from "../../../application/shutdown";
import { createStartupReadiness } from "../../../application/readiness";
import { executeToolDefinition } from "../registry/tool-executor";

const mocks = vi.hoisted(() => ({ root: "", spawn: vi.fn() }));
vi.mock("electron", () => ({ app: { getPath: () => mocks.root } }));
vi.mock("child_process", () => ({ spawn: mocks.spawn }));
vi.mock("../../../logger", () => ({ logger: { info: vi.fn(), warn: vi.fn() }, LogTag: { BuiltinTools: "tools" } }));

let manager: typeof import("./shell-job-manager");
let child: EventEmitter & { stdout: PassThrough; stderr: PassThrough };
const options = () => ({ command: "fixture", shell: "cmd", spec: {
  command: "never-executed", args: [], env: { TEST_SECRET: "not-persisted" },
  windowsVerbatimArguments: false, ranViaSandbox: false,
} });
const database = () => getConversationDatabase(mocks.root);
function record(jobId: string, patch: Partial<ShellJobRecord> = {}): ShellJobRecord {
  return { jobId, command: "old command", shell: "cmd", status: "running", exitCode: null,
    reason: null, totalBytes: 0, logFile: path.join(mocks.root, "shell-jobs", `${jobId}.log`),
    startedAtMs: Date.now() - 1000, endedAtMs: null, ...patch };
}
beforeEach(async () => {
  vi.resetModules();
  mocks.root = fs.mkdtempSync(path.join(os.tmpdir(), "cyrene-shell-persistence-"));
  fs.mkdirSync(path.join(mocks.root, "shell-jobs"));
  child = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough() });
  mocks.spawn.mockReset().mockReturnValue(child);
  manager = await import("./shell-job-manager");
});
afterEach(async () => {
  vi.restoreAllMocks();
  await manager.disposeAllShellJobs().catch(() => {});
  await closeConversationDatabases();
  fs.rmSync(mocks.root, { recursive: true, force: true });
});

describe("shell job SQLite lifecycle (isolated data, mocked processes)", () => {
  it("reads terminal output from SQLite after worker restart, with stable duration and no process handle", async () => {
    const { jobId } = await manager.startShellJob(options());
    child.stdout.emit("data", Buffer.from("hello😀"));
    child.emit("close", 7);
    const first = await manager.stopShellJob(jobId);
    await database().close();
    vi.resetModules();
    manager = await import("./shell-job-manager");
    const restored = await manager.waitForShellJob(jobId, 0);
    expect(restored).toEqual(first);
    expect(restored).toMatchObject({ status: "exited", exitCode: 7, tail: "hello😀", pid: null });
    expect(await database().call("shellJobs.get", jobId)).not.toHaveProperty("spec");
    expect(await manager.stopShellJob(jobId)).toEqual(restored);
    expect(mocks.spawn).toHaveBeenCalledTimes(1);
  });

  it("reconciles old running records without restarting commands or reusing a PID", async () => {
    const old = record("old");
    await database().call("shellJobs.create", old);
    fs.writeFileSync(old.logFile, "partial output");
    const snapshot = await manager.waitForShellJob("old", 60000);
    expect(snapshot).toMatchObject({ status: "failed", reason: "app_restarted_execution_unknown",
      exitCode: null, pid: null, totalBytes: 14, tail: "partial output" });
    expect(await manager.stopShellJob("old")).toEqual(snapshot);
    const { shellJobTool } = await import("./shell-job-tool");
    const response = JSON.parse(await shellJobTool.execute({ action: "status", job_id: "old" }, {} as never));
    expect(response.statusHint).toContain("不要直接重跑");
    expect(mocks.spawn).not.toHaveBeenCalled();
  });

  it.each(["completed", "restarted"])("cancels a %s status query during a real SQLite lock without cancelling shared work", async mode => {
    let jobId = "historical";
    if (mode === "completed") {
      ({ jobId } = await manager.startShellJob(options()));
      child.emit("close", 7);
      await manager.stopShellJob(jobId); // terminal save removes the in-memory entry
    } else {
      await database().call("shellJobs.create", record(jobId));
      await database().close(); // next query must also wait for startup recovery
    }
    const { shellJobTool } = await import("./shell-job-tool");
    const lock = new DatabaseSync(path.join(mocks.root, "cyrene.sqlite"));
    lock.exec("BEGIN IMMEDIATE");
    const controller = new AbortController();
    const query = executeToolDefinition(shellJobTool, { action: "status", job_id: jobId, wait_ms: 60000 },
      { signal: controller.signal } as never);
    const outcome = query.then(() => "resolved", error => error.name);
    // A second caller shares initialization / the worker, but must not inherit cancellation.
    const other = manager.waitForShellJob(jobId, 0);
    try {
      await new Promise(resolve => setTimeout(resolve, 30));
      controller.abort();
      expect(await Promise.race([outcome, new Promise(resolve => {
        const timer = setTimeout(() => resolve("still blocked"), 500);
        timer.unref();
      })])).toBe("AbortError");
    } finally {
      lock.exec("ROLLBACK");
      lock.close();
      await outcome;
      await other;
    }
    const expected = mode === "completed" ? { status: "exited", exitCode: 7 }
      : { status: "failed", reason: "app_restarted_execution_unknown" };
    expect(await other).toMatchObject(expected);
    expect(JSON.parse(await shellJobTool.execute({ action: "status", job_id: jobId }, {} as never)))
      .toMatchObject(expected);
    expect(mocks.spawn).toHaveBeenCalledTimes(mode === "completed" ? 1 : 0);
  });

  it("rejects a pre-cancelled historical query before accessing SQLite", async () => {
    const call = vi.spyOn(database(), "call");
    const { shellJobTool } = await import("./shell-job-tool");
    const controller = new AbortController();
    controller.abort();
    await expect(executeToolDefinition(shellJobTool, { action: "status", job_id: "historical" },
      { signal: controller.signal } as never)).rejects.toMatchObject({ name: "AbortError" });
    expect(call).not.toHaveBeenCalled();
    expect(mocks.spawn).not.toHaveBeenCalled();
  });

  it("does not reconcile live jobs merely because the SQLite worker reopened", async () => {
    const { jobId } = await manager.startShellJob(options());
    await database().close();
    expect(await database().call("shellJobs.get", jobId)).toMatchObject({ status: "running" });
    child.emit("close", 0);
    expect(await manager.waitForShellJob(jobId, 0)).toMatchObject({ status: "exited", exitCode: 0 });
  });

  it("does not spawn when the initial database write fails", async () => {
    const client = database();
    const call = client.call.bind(client);
    vi.spyOn(client, "call").mockImplementation((method, ...args) => {
      if (method === "shellJobs.create") return Promise.reject(new Error("INJECTED_WRITE_FAILURE"));
      return call(method, ...args);
    });
    await expect(manager.startShellJob(options())).rejects.toThrow("INJECTED_WRITE_FAILURE");
    expect(mocks.spawn).not.toHaveBeenCalled();
    expect(fs.readdirSync(path.join(mocks.root, "shell-jobs"))).toEqual([]);
  });

  it("stop reports terminal write failure while status remains readable", async () => {
    const { jobId } = await manager.startShellJob(options());
    const client = database();
    const call = client.call.bind(client);
    vi.spyOn(client, "call").mockImplementation((method, ...args) => {
      if (method === "shellJobs.finish") return Promise.reject(new Error("INJECTED_FINISH_FAILURE"));
      return call(method, ...args);
    });
    child.emit("close", 0);
    await expect(manager.stopShellJob(jobId)).rejects.toThrow("INJECTED_FINISH_FAILURE");
    expect(await manager.waitForShellJob(jobId, 0)).toMatchObject({ status: "exited", exitCode: 0 });
    expect(await call("shellJobs.get", jobId)).toMatchObject({ status: "running" });
  });

  it("preserves the first terminal fact against late close events and database retries", async () => {
    const { jobId } = await manager.startShellJob(options());
    const stopped = await manager.stopShellJob(jobId);
    child.emit("close", 0);
    const saved = await database().call<ShellJobRecord>("shellJobs.get", jobId);
    await database().call("shellJobs.finish", { ...saved, status: "exited", exitCode: 0 });
    expect(await manager.waitForShellJob(jobId, 0)).toEqual(stopped);
  });

  it("cleans expired metadata and logs while retaining recent records and legacy evidence", async () => {
    const oldTime = Date.now() - 8 * 86400000;
    const old = record("expired", { status: "exited", endedAtMs: oldTime });
    const recent = record("recent", { status: "exited", endedAtMs: Date.now() });
    for (const item of [old, recent]) {
      await database().call("shellJobs.create", item);
      fs.writeFileSync(item.logFile, "evidence");
      fs.utimesSync(item.logFile, oldTime / 1000, oldTime / 1000);
    }
    const legacy = path.join(mocks.root, "shell-jobs", "legacy.log");
    fs.writeFileSync(legacy, "unmapped legacy output");
    expect(await manager.waitForShellJob("expired", 0)).toBeNull();
    expect(fs.existsSync(old.logFile)).toBe(false);
    expect(await manager.waitForShellJob("recent", 0)).toMatchObject({ tail: "evidence" });
    expect(fs.readFileSync(legacy, "utf8")).toBe("unmapped legacy output");
  });

  it("flushes shutdown terminal state and refuses subsequent starts", async () => {
    const { jobId } = await manager.startShellJob(options());
    const shutdown = createShutdownCoordinator({ readiness: createStartupReadiness() });
    shutdown.register({ id: "shell-jobs", phase: "stopLocalResources", dispose: manager.disposeAllShellJobs });
    shutdown.register({ id: "database", phase: "closePersistence", dispose: closeConversationDatabases });
    const finalAction = vi.fn();
    await shutdown.requestControlledShutdown({ reason: "test", finalAction });
    expect(finalAction).toHaveBeenCalledOnce();
    expect(await database().call("shellJobs.get", jobId)).toMatchObject({ status: "stopped", reason: "app_exiting" });
    await expect(manager.startShellJob(options())).rejects.toThrow("SHELL_JOBS_STOPPING");
  });

  it.each(["shutdown", "cancel"])("does not spawn when %s races with initial persistence", async mode => {
    const client = database();
    const call = client.call.bind(client);
    let release!: () => void;
    let entered!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const created = new Promise<void>(resolve => { entered = resolve; });
    vi.spyOn(client, "call").mockImplementation(async (method, ...args) => {
      const result = await call(method, ...args);
      if (method === "shellJobs.create") { entered(); await gate; }
      return result;
    });
    const controller = new AbortController();
    const start = manager.startShellJob({ ...options(), signal: controller.signal });
    const rejected = expect(start).rejects.toThrow();
    await created;
    const shutdown = mode === "shutdown" ? manager.disposeAllShellJobs() : Promise.resolve();
    if (mode === "cancel") controller.abort();
    release();
    await rejected;
    await shutdown;
    expect(mocks.spawn).not.toHaveBeenCalled();
    const records = await call<ShellJobRecord[]>("shellJobs.expired", Date.now() + 1);
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ status: "stopped",
      reason: mode === "shutdown" ? "app_exiting" : "cancelled_before_start" });
  });

  it("keeps terminal metadata readable when its log has gone missing", async () => {
    await database().call("shellJobs.create", record("missing", { status: "exited", exitCode: 0, endedAtMs: Date.now() }));
    expect(await manager.waitForShellJob("missing", 0)).toMatchObject({ status: "exited", exitCode: 0, tail: "" });
  });

  it("stops existing work before waiting for a pending create during shutdown", async () => {
    const active = await manager.startShellJob(options());
    const client = database(), call = client.call.bind(client);
    let release!: () => void, entered!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const arrived = new Promise<void>(resolve => { entered = resolve; });
    vi.spyOn(client, "call").mockImplementation(async (method, ...args) => {
      if (method === "shellJobs.create") { entered(); await gate; }
      return call(method, ...args);
    });
    const pending = manager.startShellJob(options()).catch(() => {});
    await arrived;
    const shutdown = manager.disposeAllShellJobs();
    try {
      expect(await manager.waitForShellJob(active.jobId, 0)).toMatchObject({ status: "stopped", reason: "app_exiting" });
    } finally { release(); await pending; await shutdown; }
    expect(await call("shellJobs.get", active.jobId)).toMatchObject({ status: "stopped" });
  });

  it("does not close SQLite before all terminal writes settle when one fails", async () => {
    const first = await manager.startShellJob(options());
    const second = await manager.startShellJob(options());
    const client = database(), call = client.call.bind(client);
    let release!: () => void, entered!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const arrived = new Promise<void>(resolve => { entered = resolve; });
    vi.spyOn(client, "call").mockImplementation(async (method, ...args) => {
      if (method === "shellJobs.finish") {
        if (args[0].jobId === first.jobId) throw new Error("INJECTED");
        entered(); await gate;
      }
      return call(method, ...args);
    });
    const log = vi.fn(), close = vi.fn(closeConversationDatabases), finalAction = vi.fn();
    const shutdown = createShutdownCoordinator({ readiness: createStartupReadiness(), log });
    shutdown.register({ id: "shell-jobs", phase: "stopLocalResources", dispose: manager.disposeAllShellJobs });
    shutdown.register({ id: "database", phase: "closePersistence", dispose: close });
    const done = shutdown.requestControlledShutdown({ reason: "test", finalAction });
    await arrived;
    try {
      await new Promise(resolve => setTimeout(resolve, 20));
      expect(close).not.toHaveBeenCalled();
      expect(finalAction).not.toHaveBeenCalled();
    } finally { release(); await done; }
    expect(log).toHaveBeenCalledWith(expect.stringContaining("dispose failed"), expect.any(AggregateError));
    expect(close).toHaveBeenCalledOnce();
    expect(finalAction).toHaveBeenCalledOnce();
    expect(await call("shellJobs.get", second.jobId)).toMatchObject({ status: "stopped" });
  });

  it("retries a transient finish failure without rerunning or changing the terminal fact", async () => {
    const { jobId } = await manager.startShellJob(options());
    const client = database(), call = client.call.bind(client);
    let attempts = 0;
    vi.spyOn(client, "call").mockImplementation((method, ...args) => {
      if (method === "shellJobs.finish" && ++attempts === 1) return Promise.reject(new Error("TRANSIENT"));
      return call(method, ...args);
    });
    child.emit("close", 7);
    await expect(manager.stopShellJob(jobId)).rejects.toThrow("TRANSIENT");
    const known = await manager.waitForShellJob(jobId, 0); // triggers the retry without blocking status
    expect(await manager.stopShellJob(jobId)).toEqual(known);
    expect(await call("shellJobs.get", jobId)).toMatchObject({ status: "exited", exitCode: 7 });
    expect(attempts).toBe(2);
    expect(mocks.spawn).toHaveBeenCalledTimes(1);
  });

  it.each(["abort", "deadline", "immediate"])("status honors %s while the terminal write is delayed", async mode => {
    const { jobId } = await manager.startShellJob(options());
    const client = database(), call = client.call.bind(client);
    let release!: () => void, entered!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const arrived = new Promise<void>(resolve => { entered = resolve; });
    vi.spyOn(client, "call").mockImplementation(async (method, ...args) => {
      if (method === "shellJobs.finish") { entered(); await gate; }
      return call(method, ...args);
    });
    const abort = new AbortController();
    const { shellJobTool } = await import("./shell-job-tool");
    const query = () => shellJobTool.execute({ action: "status", job_id: jobId,
      wait_ms: mode === "abort" ? 60000 : mode === "deadline" ? 20 : 0 }, { signal: abort.signal } as never);
    const pending = mode === "immediate" ? undefined : query();
    child.emit("close", 0);
    await arrived;
    abort.abort();
    try {
      const response = await Promise.race([pending ?? query(), new Promise<never>((_, reject) => {
        const timer = setTimeout(() => reject(new Error("status blocked on persistence")), 500);
        timer.unref();
      })]);
      expect(JSON.parse(response)).toMatchObject({ status: "exited", exitCode: 0 });
      expect(await call("shellJobs.get", jobId)).toMatchObject({ status: "running" });
    } finally { release(); await manager.stopShellJob(jobId); }
  });
});

it.each([false, true])("drains cold historical cleanup before shutdown (cancelled=%s)", async cancelled => {
  const old = record("expired", { status: "exited", exitCode: 0, endedAtMs: Date.now() - 8 * 86400000 });
  await database().call("shellJobs.create", old);
  fs.writeFileSync(old.logFile, "expired");
  let release!: () => void, entered!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const arrived = new Promise<void>(resolve => { entered = resolve; });
  const rm = fs.promises.rm.bind(fs.promises);
  vi.spyOn(fs.promises, "rm").mockImplementation(async (file, options) => {
    if (file === old.logFile) { entered(); await gate; }
    return rm(file, options);
  });
  const abort = new AbortController();
  const query = manager.waitForShellJob(old.jobId, 0, abort.signal).catch(error => error);
  await arrived;
  if (cancelled) { abort.abort(); expect(await query).toMatchObject({ name: "AbortError" }); }
  let stopped = false;
  const shutdown = manager.disposeAllShellJobs().then(() => { stopped = true; });
  try {
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(stopped).toBe(false);
    await expect(manager.waitForShellJob("new-query", 0)).rejects.toThrow("SHELL_JOBS_STOPPING");
  } finally { release(); await shutdown; }
  if (!cancelled) expect(await query).toMatchObject({ message: "SHELL_JOBS_STOPPING" });
  expect(await database().call("shellJobs.get", old.jobId)).toBeNull();
  await closeConversationDatabases();
  const call = vi.spyOn(database(), "call");
  await expect(manager.stopShellJob(old.jobId)).rejects.toThrow("SHELL_JOBS_STOPPING");
  expect(call).not.toHaveBeenCalled();
});

it.each(["upstream-v7", "memory-v8", "shell-draft-v8"])("upgrades %s without losing existing data, then reopens", async version => {
  const client = database();
  await client.call("shellJobs.get", "fixture");
  await client.close();
  const sqlite = new DatabaseSync(path.join(mocks.root, "cyrene.sqlite"));
  try {
    // 从目标历史 schema 建 fixture，不依赖当前构建是否已包含独立的记忆迁移 8。
    sqlite.exec("DELETE FROM schema_migrations WHERE version IN (8,9); DROP TABLE IF EXISTS memory_pending_turns; DROP TABLE IF EXISTS memory_scheduler_state;");
    if (version === "shell-draft-v8") {
      sqlite.exec("INSERT INTO schema_migrations VALUES(8)");
    } else {
      sqlite.exec("DROP TABLE shell_jobs");
      if (version === "memory-v8") {
        // The independent memory PR owns migration 8; shell migration 9 must not skip or overwrite it.
        sqlite.exec(`CREATE TABLE memory_scheduler_state(id INTEGER PRIMARY KEY CHECK(id=1), legacy_count INTEGER NOT NULL);
          CREATE TABLE memory_pending_turns(seq INTEGER PRIMARY KEY AUTOINCREMENT,
            conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
            user_turn_id TEXT NOT NULL, user_entry_id TEXT NOT NULL, assistant_entry_id TEXT NOT NULL,
            payload_json TEXT, active INTEGER NOT NULL, processed INTEGER NOT NULL,
            UNIQUE(conversation_id,user_turn_id));
          CREATE INDEX memory_pending_batch ON memory_pending_turns(conversation_id,active,processed,seq);
          INSERT INTO schema_migrations VALUES(8);
          INSERT INTO memory_scheduler_state VALUES(1,123)`);
      }
    }
  } finally { sqlite.close(); }
  const { jobId } = await manager.startShellJob(options());
  child.emit("close", 0);
  await manager.stopShellJob(jobId);
  await client.close();
  expect(await client.call("shellJobs.get", jobId)).toMatchObject({ status: "exited", exitCode: 0 });
  await client.close();
  const verify = new DatabaseSync(path.join(mocks.root, "cyrene.sqlite"));
  try {
    expect(verify.prepare("SELECT version FROM schema_migrations WHERE version=9").get()).toBeTruthy();
    if (version === "memory-v8") expect(verify.prepare("SELECT legacy_count FROM memory_scheduler_state").get()?.legacy_count).toBe(123);
  } finally { verify.close(); }
});
