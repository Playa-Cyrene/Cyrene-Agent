import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { describe, expect, it, vi } from "vitest";
import { SchedulerEngine } from "./scheduler-engine";
import { computeExecutionSpecFingerprint, taskExecutionSpec } from "./execution-spec";
import { createSchedulerStore } from "./scheduler-store";
import type { ScheduledTask, ScheduledTaskHistoryEntry, ScheduledRunResult } from "./types";

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "cyrene-engine-"));
}

function dailyTask(patch: Partial<ScheduledTask> = {}): ScheduledTask {
  return {
    id: "task-1",
    title: "Task",
    prompt: "Run",
    enabled: true,
    schedule: { kind: "daily", timeOfDay: "08:00" },
    nextFireAt: "2026-06-22T08:00:00.000Z",
    toolMode: "all-enabled",
    allowedToolIds: [],
    createdAt: "2026-06-21T00:00:00.000Z",
    updatedAt: "2026-06-21T00:00:00.000Z",
    ...patch,
  };
}

/** 已获用户授权的插件任务：enabled:false 落盘 + 匹配的授权指纹。 */
function authorizedPluginTask(patch: Partial<ScheduledTask> = {}): ScheduledTask {
  const task = dailyTask({
    id: "plugin-task-1",
    ownerPluginId: "demo-plugin",
    enabled: false,
    pluginUserEnabled: true,
    approvalFingerprint: "",
    ...patch,
  });
  return { ...task, approvalFingerprint: computeExecutionSpecFingerprint(taskExecutionSpec(task)) };
}

function makeStore(initial: ScheduledTask[]) {
  let tasks = initial;
  const history: ScheduledTaskHistoryEntry[] = [];
  const listeners: Array<(tasks: ScheduledTask[]) => void> = [];
  return {
    getTasks: () => tasks.map(task => ({ ...task, allowedToolIds: [...task.allowedToolIds] })),
    updateTask: vi.fn((id: string, patch: Partial<ScheduledTask>) => {
      const index = tasks.findIndex(task => task.id === id);
      if (index < 0) throw new Error("missing task");
      tasks = [...tasks.slice(0, index), { ...tasks[index], ...patch }, ...tasks.slice(index + 1)];
      for (const listener of listeners) listener(tasks);
      return tasks[index];
    }),
    recordHistory: vi.fn((entry: ScheduledTaskHistoryEntry) => { history.push(entry); }),
    onChange: vi.fn((listener: (tasks: ScheduledTask[]) => void) => {
      listeners.push(listener);
      return () => undefined;
    }),
    history,
  };
}

describe("SchedulerEngine", () => {
  it("caps timer delay to one hour for far future tasks", () => {
    vi.useFakeTimers();
    try {
      const store = makeStore([dailyTask({ nextFireAt: "2026-08-22T08:00:00.000Z" })]);
      const engine = new SchedulerEngine({
        store,
        now: () => new Date("2026-06-22T08:00:00.000Z"),
        runTask: async (): Promise<ScheduledRunResult> => ({ ok: true, historyId: "h", effectiveToolIds: [] }),
      });

      engine.start();

      expect(vi.getTimerCount()).toBe(1);
      vi.advanceTimersByTime(60 * 60 * 1000 - 1);
      expect(store.recordHistory).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("returns a clear fireNow error when the task is already running", async () => {
    let resolveRun!: () => void;
    const store = makeStore([dailyTask()]);
    const engine = new SchedulerEngine({
      store,
      now: () => new Date("2026-06-22T08:00:00.000Z"),
      runTask: () => new Promise<ScheduledRunResult>((resolve) => {
        resolveRun = () => resolve({ ok: true, historyId: "h", effectiveToolIds: [] });
      }),
    });

    const first = engine.fireNow("task-1");
    const second = await engine.fireNow("task-1");
    resolveRun();
    await first;

    expect(second).toEqual({ ok: false, reason: "task already running" });
  });

  it("rolls delayed recurring fires forward without backfilling multiple runs", async () => {
    vi.useFakeTimers();
    try {
      let now = new Date("2026-06-22T07:59:00.000Z");
      const store = makeStore([dailyTask({
        schedule: { kind: "interval", every: 1, unit: "hours" },
        nextFireAt: "2026-06-22T08:00:00.000Z",
      })]);
      const runTask = vi.fn(async (): Promise<ScheduledRunResult> => ({ ok: true, historyId: "h", effectiveToolIds: [] }));
      const engine = new SchedulerEngine({ store, now: () => now, runTask });

      engine.start();
      now = new Date("2026-06-22T12:15:00.000Z");
      await vi.advanceTimersByTimeAsync(60 * 1000);
      now = new Date("2026-06-22T12:15:01.000Z");
      await vi.runOnlyPendingTimersAsync();

      expect(runTask).toHaveBeenCalledTimes(1);
      expect(store.getTasks()[0].nextFireAt).toBe("2026-06-22T13:00:00.000Z");
    } finally {
      vi.useRealTimers();
    }
  });

  it("ignores invalid nextFireAt instead of scheduling a zero-delay loop", () => {
    vi.useFakeTimers();
    try {
      const store = makeStore([dailyTask({ nextFireAt: "not-a-date" })]);
      const engine = new SchedulerEngine({
        store,
        now: () => new Date("2026-06-22T08:00:00.000Z"),
        runTask: async (): Promise<ScheduledRunResult> => ({ ok: true, historyId: "h", effectiveToolIds: [] }),
      });

      engine.start();

      expect(vi.getTimerCount()).toBe(0);
      expect(store.updateTask).toHaveBeenCalledWith("task-1", { enabled: false, nextFireAt: null });
    } finally {
      vi.useRealTimers();
    }
  });

  it("normalizes stale recurring tasks through the real store", () => {
    const dir = tmpDir();
    const store = createSchedulerStore({
      tasksFile: path.join(dir, "scheduled-tasks.json"),
      historyFile: path.join(dir, "scheduled-tasks-history.jsonl"),
      now: () => new Date("2026-06-22T08:00:00.000Z"),
      id: () => "task-a",
    });
    store.load();
    store.addTask({ title: "Hourly", prompt: "Run", schedule: { kind: "interval", every: 1, unit: "hours" }, workspaceBinding: { workspaceRoot: "E:/project", displayName: "project", boundAt: 1 } });
    const engine = new SchedulerEngine({
      store,
      now: () => new Date("2026-06-22T12:15:00.000Z"),
      runTask: async (): Promise<ScheduledRunResult> => ({ ok: true, historyId: "h", effectiveToolIds: [] }),
    });

    engine.start();

    expect(store.getTasks()[0].nextFireAt).toBe("2026-06-22T13:00:00.000Z");
  });

  it("advances recurring nextFireAt through the real store after firing", async () => {
    vi.useFakeTimers();
    try {
      const dir = tmpDir();
      const store = createSchedulerStore({
        tasksFile: path.join(dir, "scheduled-tasks.json"),
        historyFile: path.join(dir, "scheduled-tasks-history.jsonl"),
        now: () => new Date("2026-06-22T07:00:00.000Z"),
        id: () => "task-a",
      });
      store.load();
      store.addTask({ title: "Hourly", prompt: "Run", schedule: { kind: "interval", every: 1, unit: "hours" }, workspaceBinding: { workspaceRoot: "E:/project", displayName: "project", boundAt: 1 } });
      let now = new Date("2026-06-22T07:59:00.000Z");
      const engine = new SchedulerEngine({
        store,
        now: () => now,
        runTask: async (): Promise<ScheduledRunResult> => ({ ok: true, historyId: "h", effectiveToolIds: [] }),
      });

      engine.start();
      now = new Date("2026-06-22T08:00:00.000Z");
      await vi.advanceTimersByTimeAsync(60 * 1000);

      expect(store.getTasks()[0].nextFireAt).toBe("2026-06-22T09:00:00.000Z");
    } finally {
      vi.useRealTimers();
    }
  });

  it("stops a recurring task when its run limit is reached", async () => {
    vi.useFakeTimers();
    try {
      const dir = tmpDir();
      const store = createSchedulerStore({
        tasksFile: path.join(dir, "scheduled-tasks.json"),
        historyFile: path.join(dir, "scheduled-tasks-history.jsonl"),
        now: () => new Date("2026-06-22T07:00:00.000Z"),
        id: () => "limited-task",
      });
      store.load();
      store.addTask({
        title: "Limited",
        prompt: "Run",
        schedule: { kind: "interval", every: 1, unit: "hours" },
        workspaceBinding: { workspaceRoot: "E:/project", displayName: "project", boundAt: 1 },
        maxRuns: 1,
      });
      let now = new Date("2026-06-22T07:59:00.000Z");
      const engine = new SchedulerEngine({
        store,
        now: () => now,
        runTask: async (): Promise<ScheduledRunResult> => ({ ok: true, historyId: "h", effectiveToolIds: [] }),
      });
      engine.start();
      now = new Date("2026-06-22T08:00:00.000Z");
      await vi.advanceTimersByTimeAsync(60 * 1000);
      expect(store.getTasks()[0].runCount).toBe(1);
      expect(store.getTasks()[0].enabled).toBe(false);
      expect(store.getTasks()[0].nextFireAt).toBeNull();
      engine.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it("disables invalid persisted nextFireAt through the real store without throwing", () => {
    const dir = tmpDir();
    const tasksFile = path.join(dir, "scheduled-tasks.json");
    fs.writeFileSync(tasksFile, JSON.stringify({ tasks: [dailyTask({ nextFireAt: "not-a-date" })] }), "utf8");
    const store = createSchedulerStore({
      tasksFile,
      historyFile: path.join(dir, "scheduled-tasks-history.jsonl"),
      now: () => new Date("2026-06-22T08:00:00.000Z"),
      id: () => "task-a",
    });
    store.load();
    const engine = new SchedulerEngine({
      store,
      now: () => new Date("2026-06-22T08:00:00.000Z"),
      runTask: async (): Promise<ScheduledRunResult> => ({ ok: true, historyId: "h", effectiveToolIds: [] }),
    });

    expect(() => engine.start()).not.toThrow();
    expect(store.getTasks()[0].enabled).toBe(false);
    expect(store.getTasks()[0].nextFireAt).toBeNull();
  });

  it("拒绝手动触发插件不在运行状态的任务", async () => {
    const store = makeStore([authorizedPluginTask()]);
    const engine = new SchedulerEngine({
      store,
      now: () => new Date("2026-06-22T08:00:00.000Z"),
      runTask: async (): Promise<ScheduledRunResult> => ({ ok: true, historyId: "h", effectiveToolIds: [] }),
      canRunTask: () => false,
    });

    const result = await engine.fireNow("plugin-task-1");
    expect(result).toEqual({ ok: false, reason: "plugin not running" });
  });

  it("未获用户授权的插件任务不排计时器", () => {
    vi.useFakeTimers();
    try {
      const store = makeStore([
        authorizedPluginTask({ pluginUserEnabled: false, approvalFingerprint: "" }),
      ]);
      const engine = new SchedulerEngine({
        store,
        now: () => new Date("2026-06-22T08:00:00.000Z"),
        runTask: async (): Promise<ScheduledRunResult> => ({ ok: true, historyId: "h", effectiveToolIds: [] }),
      });

      engine.start();
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("插件停用时定时触发被跳过并推进下一次时间（不补跑）", async () => {
    vi.useFakeTimers();
    try {
      const store = makeStore([authorizedPluginTask({
        schedule: { kind: "interval", every: 1, unit: "hours" },
      })]);
      const runTask = vi.fn(async (): Promise<ScheduledRunResult> => ({ ok: true, historyId: "h", effectiveToolIds: [] }));
      let now = new Date("2026-06-22T07:59:00.000Z");
      const engine = new SchedulerEngine({
        store,
        now: () => now,
        runTask,
        canRunTask: () => false,
      });

      engine.start();
      now = new Date("2026-06-22T08:00:00.000Z");
      await vi.advanceTimersByTimeAsync(60 * 1000);

      expect(runTask).not.toHaveBeenCalled();
      const skipped = store.history.find((entry) => entry.status === "skipped");
      expect(skipped?.reason).toBe("plugin not running");
      expect(store.getTasks()[0].nextFireAt).toBe("2026-06-22T09:00:00.000Z");
    } finally {
      vi.useRealTimers();
    }
  });

  it("refreshPluginTasks 归一化逾期插件任务并重排计时器", async () => {
    vi.useFakeTimers();
    try {
      const store = makeStore([authorizedPluginTask({
        schedule: { kind: "interval", every: 1, unit: "hours" },
        nextFireAt: "2026-06-22T07:00:00.000Z",
      })]);
      const runTask = vi.fn(async (): Promise<ScheduledRunResult> => ({ ok: true, historyId: "h", effectiveToolIds: [] }));
      let now = new Date("2026-06-22T12:15:00.000Z");
      const engine = new SchedulerEngine({
        store,
        now: () => now,
        runTask,
        canRunTask: () => true,
      });

      engine.refreshPluginTasks();

      // 插件重新启用：逾期时间归一化到未来，到点后任务可正常触发
      expect(store.getTasks()[0].nextFireAt).toBe("2026-06-22T13:00:00.000Z");
      now = new Date("2026-06-22T13:00:00.000Z");
      await vi.advanceTimersByTimeAsync(60 * 60 * 1000);
      expect(runTask).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });
});
