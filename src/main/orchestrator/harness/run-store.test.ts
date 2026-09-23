import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { HarnessRunStore } from "./run-store";
import type { AgentState } from "./types";
import type { ChatMessage } from "../vendors/types";

const roots: string[] = [];

function createStore() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cyrene-harness-run-"));
  roots.push(root);
  let now = 1_000;
  return {
    root,
    tick: () => { now += 1; },
    store: new HarnessRunStore(root, { now: () => now }),
  };
}

function createRun(store: HarnessRunStore) {
  return store.create({
    conversationId: "chat-1",
    runId: "run-1",
    messages: [{ role: "user", content: "整理项目结构" }],
    request: {
      provider: "openai",
      model: "test-model",
      contextWindowTokens: 128_000,
      mode: "work",
      promptFingerprint: "prompt-v1",
      toolSchemaFingerprint: "tools-v1",
    },
  });
}

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("HarnessRunStore", () => {
  it("persists a main-run checkpoint separately from the chat transcript", () => {
    const { root, store, tick } = createStore();
    createRun(store);
    tick();

    store.checkpoint("run-1", {
      rounds: 2,
      todoItems: [{ id: "inspect", content: "检查入口", status: "in_progress" }],
      toolOutputs: [{
        recordId: "a".repeat(64), resultRef: "tool-result://v1/test", runId: "run-1", toolCallId: "call-1",
        toolName: "read_file", bytes: 10, codePoints: 10, truncatedForModel: false, createdAt: 1_001,
      }],
    });

    expect(store.get("run-1")).toMatchObject({
      status: "running",
      rounds: 2,
      state: { todoItems: [{ id: "inspect", status: "in_progress" }] },
      toolOutputs: [{ toolCallId: "call-1" }],
    });
    expect(fs.existsSync(path.join(root, "cyrene-runs", "sessions", "run-1.json"))).toBe(true);
  });

  it("persists a committed compaction cache epoch in the run checkpoint", () => {
    const { store } = createStore();
    createRun(store);

    store.checkpoint("run-1", {
      cache: { cacheEpoch: 2, epochReason: "compaction" },
    });

    expect(store.get("run-1")).toMatchObject({
      cache: { cacheEpoch: 2, epochReason: "compaction" },
    });
  });

  it("marks an unfinished main run interrupted after process restart", () => {
    const { root, store } = createStore();
    createRun(store);

    const restarted = new HarnessRunStore(root);

    expect(restarted.get("run-1")).toMatchObject({ status: "interrupted", runId: "run-1" });
  });

  it("listInterruptedRuns 只返回崩溃遗留的 interrupted run，排除终态 run", () => {
    const { root, store } = createStore();
    // run-1 正常完成（终态，不应出现在崩溃对账集合）
    createRun(store); // run-1
    store.markTerminal("run-1", "completed");
    // run-2 以 running 留存在磁盘（模拟进程崩溃遗留）
    store.create({
      conversationId: "chat-1",
      runId: "run-2",
      messages: [{ role: "user", content: "再次整理" }],
      request: {
        provider: "openai", model: "test-model", contextWindowTokens: 128_000,
        mode: "work", promptFingerprint: "p1", toolSchemaFingerprint: "t1",
      },
    });

    // 重启：finished 保持，running 翻转为 interrupted
    const restored = new HarnessRunStore(root);
    const interrupted = restored.listInterruptedRuns();
    expect(interrupted.map((session) => session.runId)).toEqual(["run-2"]);
    expect(interrupted.every((session) => session.status === "interrupted")).toBe(true);

    // 崩溃对账是幂等定位源：再次实例化仍返回同一崩溃集合
    const again = new HarnessRunStore(root).listInterruptedRuns();
    expect(again.map((session) => session.runId)).toEqual(["run-2"]);
  });

  it("returns isolated snapshots and keeps a lifecycle journal", () => {
    const { store } = createStore();
    createRun(store);
    store.recordTool("run-1", { toolCallId: "call-1", toolName: "write_file", sideEffect: "idempotent_mutation", status: "started" });

    const snapshot = store.get("run-1")!;
    snapshot.messages.push({ role: "assistant", content: "不应写回" });

    expect(store.get("run-1")?.messages).toEqual([{ role: "user", content: "整理项目结构" }]);
    expect(store.get("run-1")?.toolCalls).toEqual([
      expect.objectContaining({ toolCallId: "call-1", status: "started" }),
    ]);
  });

  it("rejects only a live duplicate run id, allowing a stale terminal record to be replaced", () => {
    const { store } = createStore();
    createRun(store);
    expect(() => createRun(store)).toThrow("HARNESS_RUN_EXISTS");

    store.markTerminal("run-1", "completed");
    expect(createRun(store)).toMatchObject({ runId: "run-1", status: "running", rounds: 0 });
  });

  // ── 存储写放大减法 ──────────────────────────────────────

  it("clones live references from checkpoint patches before persisting", () => {
    // 消费方克隆契约：harness 删除 deepClone 后传活引用，
    // store 必须在 checkpoint 返回前完成克隆，调用方后续修改不得影响已落盘内容。
    const { store } = createStore();
    createRun(store);
    const messages: ChatMessage[] = [{ role: "user", content: "v1" }];
    const state: AgentState = { todoItems: [], uncertainEffects: [] };

    store.checkpoint("run-1", { messages, state });

    messages.push({ role: "assistant", content: "later" });
    state.todoItems.push({ id: "t1", content: "later", status: "pending" });

    expect(store.get("run-1")?.messages).toEqual([{ role: "user", content: "v1" }]);
    expect(store.get("run-1")?.state.todoItems).toEqual([]);
  });

  it("writes session and index files as single-line JSON", () => {
    const { root, store } = createStore();
    createRun(store);

    const sessionRaw = fs.readFileSync(path.join(root, "cyrene-runs", "sessions", "run-1.json"), "utf8");
    const indexRaw = fs.readFileSync(path.join(root, "cyrene-runs", "index.json"), "utf8");
    // 机器格式（events.jsonl 本就单行）：去掉 pretty-print 后文件不得含换行
    expect(sessionRaw).not.toContain("\n");
    expect(indexRaw).not.toContain("\n");
    expect(JSON.parse(sessionRaw)).toMatchObject({ runId: "run-1" });
    expect(JSON.parse(indexRaw)).toEqual([expect.objectContaining({ runId: "run-1" })]);
  });

  it("debounces index writes during recordTool and checkpoint, flushing once", () => {
    vi.useFakeTimers();
    try {
      const { root, store } = createStore();
      createRun(store);
      const indexPath = path.join(root, "cyrene-runs", "index.json");
      const afterCreate = fs.readFileSync(indexPath, "utf8");

      store.recordTool("run-1", { toolCallId: "call-1", toolName: "read_file", sideEffect: "read_only", status: "started" });
      store.recordTool("run-1", { toolCallId: "call-1", toolName: "read_file", sideEffect: "read_only", status: "committed" });
      store.checkpoint("run-1", { rounds: 2 });

      // 防抖窗口内 index 不落盘（session 文件每次都写，index 是唯一防抖对象）
      expect(fs.readFileSync(indexPath, "utf8")).toBe(afterCreate);

      vi.advanceTimersByTime(500);
      const flushed = JSON.parse(fs.readFileSync(indexPath, "utf8"));
      expect(flushed).toEqual([expect.objectContaining({ runId: "run-1", status: "running" })]);
      // 消费方侧的 session 数据不受 index 防抖影响
      expect(store.get("run-1")?.rounds).toBe(2);
      expect(store.get("run-1")?.toolCalls).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("flushes the index immediately on markTerminal and never writes stale state back", () => {
    vi.useFakeTimers();
    try {
      const { root, store } = createStore();
      createRun(store);
      // 调度 lazy 写（pending 状态下进入终态）
      store.recordTool("run-1", { toolCallId: "call-1", toolName: "read_file", sideEffect: "read_only", status: "committed" });
      store.markTerminal("run-1", "completed");
      const indexPath = path.join(root, "cyrene-runs", "index.json");
      // 未推进 fake timer，index 已是终态（markTerminal 立即刷盘）
      expect(JSON.parse(fs.readFileSync(indexPath, "utf8")))
        .toEqual([expect.objectContaining({ runId: "run-1", status: "completed" })]);

      // stale 防御：残留的 lazy 回调触发后也不得把 stale 状态写回
      vi.advanceTimersByTime(1000);
      expect(JSON.parse(fs.readFileSync(indexPath, "utf8")))
        .toEqual([expect.objectContaining({ runId: "run-1", status: "completed" })]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("corrects stale index rows from session files on initialize", () => {
    const { root, store } = createStore();
    createRun(store);
    store.markTerminal("run-1", "completed");

    // 模拟防抖/崩溃遗留的 stale index：行还是 running，但 session 文件已是 completed
    const indexPath = path.join(root, "cyrene-runs", "index.json");
    const rows = JSON.parse(fs.readFileSync(indexPath, "utf8")) as Array<{ runId: string; status: string }>;
    rows[0]!.status = "running";
    fs.writeFileSync(indexPath, JSON.stringify(rows, null, 2), "utf8");

    // 重启：以 session 文件为权威校正行状态
    new HarnessRunStore(root);
    expect(JSON.parse(fs.readFileSync(indexPath, "utf8")))
      .toEqual([expect.objectContaining({ runId: "run-1", status: "completed" })]);
  });

  it("drops orphan index rows whose session file is missing on initialize", () => {
    const { root, store } = createStore();
    createRun(store);
    fs.rmSync(path.join(root, "cyrene-runs", "sessions", "run-1.json"));

    new HarnessRunStore(root);

    const rows = JSON.parse(fs.readFileSync(path.join(root, "cyrene-runs", "index.json"), "utf8"));
    expect(rows).toEqual([]);
  });

  it("logs write amplification metrics on markTerminal", () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      const { store } = createStore();
      createRun(store);
      store.recordTool("run-1", { toolCallId: "call-1", toolName: "read_file", sideEffect: "read_only", status: "committed" });
      store.checkpoint("run-1", { rounds: 1 });
      store.markTerminal("run-1", "completed");

      const metricLine = logSpy.mock.calls.map((call) => call.join(" ")).find((line) => line.includes("HarnessRunStore"));
      expect(metricLine).toBeDefined();
      expect(metricLine).toMatch(/run-1/);
      expect(metricLine).toMatch(/completed/);
    } finally {
      logSpy.mockRestore();
    }
  });
});
