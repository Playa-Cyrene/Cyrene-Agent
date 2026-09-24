import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { describe, expect, it } from "vitest";
import { createSchedulerStore } from "./scheduler-store";

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "cyrene-scheduler-"));
}

describe("scheduler store", () => {
  it("rejects a user scheduled task that is not bound to a workspace", () => {
    const dir = tmpDir();
    const store = createSchedulerStore({
      tasksFile: path.join(dir, "scheduled-tasks.json"),
      historyFile: path.join(dir, "scheduled-tasks-history.jsonl"),
      now: () => new Date("2026-06-22T08:00:00.000Z"),
      id: () => "id-1",
    });
    store.load();

    expect(() => store.addTask({
      title: "Workspace-bound",
      prompt: "Run in a selected folder",
      schedule: { kind: "daily", timeOfDay: "09:00" },
    })).toThrow("必须绑定工作区");
  });

  it("rejects modes other than work and code for user scheduled tasks", () => {
    const dir = tmpDir();
    const store = createSchedulerStore({
      tasksFile: path.join(dir, "scheduled-tasks.json"),
      historyFile: path.join(dir, "scheduled-tasks-history.jsonl"),
      now: () => new Date("2026-06-22T08:00:00.000Z"),
      id: () => "id-1",
    });
    store.load();

    expect(() => store.addTask({
      title: "Invalid mode",
      prompt: "Run",
      schedule: { kind: "daily", timeOfDay: "09:00" },
      workspaceBinding: { workspaceRoot: "E:/project", displayName: "project", boundAt: 1 },
      mode: "chat",
    })).toThrow("模式仅支持");
  });

  it("adds and persists a normalized task", () => {
    const dir = tmpDir();
    const store = createSchedulerStore({
      tasksFile: path.join(dir, "scheduled-tasks.json"),
      historyFile: path.join(dir, "scheduled-tasks-history.jsonl"),
      now: () => new Date("2026-06-22T08:00:00.000Z"),
      id: () => "id-1",
    });

    store.load();
    const task = store.addTask({
      title: "  Morning  ",
      prompt: "  Summarize my day  ",
      schedule: { kind: "daily", timeOfDay: "09:00" },
      workspaceBinding: { workspaceRoot: "E:/project", displayName: "project", boundAt: 1 },
      mode: "code",
      toolMode: "allow-list",
      allowedToolIds: ["weather", "weather", "calendar"],
    });

    expect(task.title).toBe("Morning");
    expect(task.prompt).toBe("Summarize my day");
    expect(task.allowedToolIds).toEqual(["weather", "calendar"]);
    expect(task.workspaceBinding).toEqual({ workspaceRoot: "E:/project", displayName: "project", boundAt: 1 });
    expect(task.mode).toBe("code");
    expect(task.nextFireAt).toBeTruthy();

    const store2 = createSchedulerStore({
      tasksFile: path.join(dir, "scheduled-tasks.json"),
      historyFile: path.join(dir, "scheduled-tasks-history.jsonl"),
      now: () => new Date("2026-06-22T08:00:00.000Z"),
      id: () => "id-2",
    });
    store2.load();
    expect(store2.getTasks()).toHaveLength(1);
    expect(store2.getTasks()[0].title).toBe("Morning");
  });

  it("increments runCount on each scheduled occurrence and accepts an end condition", () => {
    const dir = tmpDir();
    const store = createSchedulerStore({
      tasksFile: path.join(dir, "scheduled-tasks.json"),
      historyFile: path.join(dir, "scheduled-tasks-history.jsonl"),
      now: () => new Date("2026-06-22T08:00:00.000Z"),
      id: () => "limited-task",
    });
    store.load();
    const task = store.addTask({
      title: "Limited",
      prompt: "Run",
      schedule: { kind: "weekdays", timeOfDay: "09:00" },
      workspaceBinding: { workspaceRoot: "E:/project", displayName: "project", boundAt: 1 },
      maxRuns: 3,
    });
    expect(task.runCount).toBe(0);
    expect(store.updateTask(task.id, { lastFiredAt: "2026-06-22T09:00:00.000Z" }).runCount).toBe(1);
    expect(store.updateTask(task.id, { lastFiredAt: "2026-06-23T09:00:00.000Z" }).runCount).toBe(2);
    expect(() => store.updateTask(task.id, { maxRuns: 0 })).toThrow("1-10000");
  });

  it("keeps 50 history entries per task and 1000 globally", () => {
    const dir = tmpDir();
    const store = createSchedulerStore({
      tasksFile: path.join(dir, "scheduled-tasks.json"),
      historyFile: path.join(dir, "scheduled-tasks-history.jsonl"),
      now: () => new Date("2026-06-22T08:00:00.000Z"),
      id: (() => {
        let n = 0;
        return () => `id-${++n}`;
      })(),
    });
    store.load();

    for (let i = 0; i < 60; i += 1) {
      store.recordHistory({
        id: `a-${i}`,
        taskId: "task-a",
        taskTitle: "A",
        firedAt: new Date(2026, 5, 22, 8, i).toISOString(),
        status: "success",
        effectiveToolIds: [],
      });
    }

    expect(store.getHistory("task-a", 100)).toHaveLength(50);
    expect(store.getHistory("task-a", 1)[0].id).toBe("a-59");
  });

  it("generates a unique task id when the id provider collides", () => {
    const dir = tmpDir();
    const store = createSchedulerStore({
      tasksFile: path.join(dir, "scheduled-tasks.json"),
      historyFile: path.join(dir, "scheduled-tasks-history.jsonl"),
      now: () => new Date("2026-06-22T08:00:00.000Z"),
      id: () => "same-id",
    });
    store.load();

    const first = store.addTask({ title: "A", prompt: "Run A", schedule: { kind: "daily", timeOfDay: "08:00" }, workspaceBinding: { workspaceRoot: "E:/project", displayName: "project", boundAt: 1 } });
    const second = store.addTask({ title: "B", prompt: "Run B", schedule: { kind: "daily", timeOfDay: "09:00" }, workspaceBinding: { workspaceRoot: "E:/project", displayName: "project", boundAt: 1 } });

    expect(first.id).toBe("same-id");
    expect(second.id).not.toBe("same-id");
    expect(new Set(store.getTasks().map(task => task.id)).size).toBe(2);
  });

  it("replaces a running history entry when the final entry has the same id", () => {
    const dir = tmpDir();
    const store = createSchedulerStore({
      tasksFile: path.join(dir, "scheduled-tasks.json"),
      historyFile: path.join(dir, "scheduled-tasks-history.jsonl"),
      now: () => new Date("2026-06-22T08:00:00.000Z"),
      id: () => "id-1",
    });
    store.load();

    store.recordHistory({ id: "hist-1", taskId: "task-a", taskTitle: "A", firedAt: "2026-06-22T08:00:00.000Z", status: "running", effectiveToolIds: [] });
    store.recordHistory({ id: "hist-1", taskId: "task-a", taskTitle: "A", firedAt: "2026-06-22T08:00:00.000Z", finishedAt: "2026-06-22T08:00:05.000Z", status: "success", outputPreview: "done", effectiveToolIds: [] });

    const history = store.getHistory("task-a", 10);
    expect(history).toHaveLength(1);
    expect(history[0].status).toBe("success");
  });

  it("normalizes persisted tasks instead of crashing on old missing optional arrays", () => {
    const dir = tmpDir();
    const tasksFile = path.join(dir, "scheduled-tasks.json");
    fs.writeFileSync(tasksFile, JSON.stringify({
      tasks: [{
        id: "task-a",
        title: "A",
        prompt: "Run A",
        enabled: true,
        schedule: { kind: "daily", timeOfDay: "08:00" },
        nextFireAt: "2026-06-22T08:00:00.000Z",
        toolMode: "allow-list",
        createdAt: "2026-06-22T00:00:00.000Z",
        updatedAt: "2026-06-22T00:00:00.000Z",
      }],
    }), "utf8");
    const store = createSchedulerStore({
      tasksFile,
      historyFile: path.join(dir, "scheduled-tasks-history.jsonl"),
      now: () => new Date("2026-06-22T08:00:00.000Z"),
      id: () => "id-1",
    });

    store.load();

    expect(store.getTasks()[0].allowedToolIds).toEqual([]);
  });

  it("rolls a stale recurring nextFireAt forward when re-enabled", () => {
    const dir = tmpDir();
    let now = new Date("2026-06-22T08:00:00.000Z");
    const store = createSchedulerStore({
      tasksFile: path.join(dir, "scheduled-tasks.json"),
      historyFile: path.join(dir, "scheduled-tasks-history.jsonl"),
      now: () => now,
      id: () => "task-a",
    });
    store.load();

    const task = store.addTask({
      title: "Hourly",
      prompt: "Run hourly",
      schedule: { kind: "interval", every: 1, unit: "hours" },
      workspaceBinding: { workspaceRoot: "E:/project", displayName: "project", boundAt: 1 },
    });
    expect(task.nextFireAt).toBe("2026-06-22T09:00:00.000Z");

    store.toggleTask(task.id, false);
    now = new Date("2026-06-22T12:15:00.000Z");
    const enabled = store.toggleTask(task.id, true);

    expect(enabled.nextFireAt).toBe("2026-06-22T13:00:00.000Z");
  });

  describe("插件任务不变量", () => {
    it("创建时无视 enabled/toolMode 输入，永远以停用 + allow-list 落盘", () => {
      const dir = tmpDir();
      const store = createSchedulerStore({
        tasksFile: path.join(dir, "scheduled-tasks.json"),
        historyFile: path.join(dir, "scheduled-tasks-history.jsonl"),
        now: () => new Date("2026-06-22T08:00:00.000Z"),
        id: () => "id-1",
      });
      store.load();

      const task = store.addTask({
        title: "插件任务",
        prompt: "Run",
        schedule: { kind: "daily", timeOfDay: "09:00" },
        enabled: true,
        toolMode: "all-enabled",
        allowedToolIds: ["a", "b"],
        ownerPluginId: "demo-plugin",
        pluginUserEnabled: false,
        approvalFingerprint: "",
        mode: "chat",
      });

      expect(task.enabled).toBe(false);
      expect(task.toolMode).toBe("allow-list");
      expect(task.ownerPluginId).toBe("demo-plugin");
      expect(task.mode).toBe("chat");
      expect(task.pluginUserEnabled).toBe(false);
      expect(task.approvalFingerprint).toBe("");
    });

    it("加载时把旧版可能启用的插件任务归一化回停用", () => {
      const dir = tmpDir();
      const tasksFile = path.join(dir, "scheduled-tasks.json");
      fs.writeFileSync(tasksFile, JSON.stringify({
        tasks: [{
          id: "task-p",
          title: "插件任务",
          prompt: "Run",
          enabled: true,
          schedule: { kind: "daily", timeOfDay: "08:00" },
          nextFireAt: "2026-06-22T08:00:00.000Z",
          toolMode: "all-enabled",
          createdAt: "2026-06-22T00:00:00.000Z",
          updatedAt: "2026-06-22T00:00:00.000Z",
          ownerPluginId: "demo-plugin",
          pluginUserEnabled: true,
          approvalFingerprint: "abc",
        }, {
          id: "task-u",
          title: "用户任务",
          prompt: "Run",
          enabled: true,
          schedule: { kind: "daily", timeOfDay: "08:00" },
          toolMode: "all-enabled",
          createdAt: "2026-06-22T00:00:00.000Z",
          updatedAt: "2026-06-22T00:00:00.000Z",
        }],
      }), "utf8");
      const store = createSchedulerStore({
        tasksFile,
        historyFile: path.join(dir, "scheduled-tasks-history.jsonl"),
        now: () => new Date("2026-06-22T08:00:00.000Z"),
        id: () => "id-1",
      });

      store.load();

      const pluginTask = store.getTasks().find(t => t.id === "task-p");
      const userTask = store.getTasks().find(t => t.id === "task-u");
      expect(pluginTask?.enabled).toBe(false);
      expect(pluginTask?.toolMode).toBe("allow-list");
      expect(pluginTask?.pluginUserEnabled).toBe(true);
      expect(pluginTask?.approvalFingerprint).toBe("abc");
      // 旧版用户任务没有冻结的工作区，不能静默在当前工作区执行。
      expect(userTask?.enabled).toBe(false);
      expect(userTask?.ownerPluginId).toBeUndefined();
    });

    it("任何 patch 都改不掉插件任务的 enabled 和 toolMode", () => {
      const dir = tmpDir();
      const store = createSchedulerStore({
        tasksFile: path.join(dir, "scheduled-tasks.json"),
        historyFile: path.join(dir, "scheduled-tasks-history.jsonl"),
        now: () => new Date("2026-06-22T08:00:00.000Z"),
        id: () => "id-1",
      });
      store.load();
      const task = store.addTask({
        title: "插件任务",
        prompt: "Run",
        schedule: { kind: "daily", timeOfDay: "09:00" },
        ownerPluginId: "demo-plugin",
      });

      const updated = store.updateTask(task.id, { enabled: true, toolMode: "all-enabled" } as never);

      expect(updated.enabled).toBe(false);
      expect(updated.toolMode).toBe("allow-list");
    });

    it("pluginUserEnabled 启用时同样重排过期的 nextFireAt", () => {
      const dir = tmpDir();
      let now = new Date("2026-06-22T08:00:00.000Z");
      const store = createSchedulerStore({
        tasksFile: path.join(dir, "scheduled-tasks.json"),
        historyFile: path.join(dir, "scheduled-tasks-history.jsonl"),
        now: () => now,
        id: () => "task-a",
      });
      store.load();
      const task = store.addTask({
        title: "Hourly",
        prompt: "Run hourly",
        schedule: { kind: "interval", every: 1, unit: "hours" },
        ownerPluginId: "demo-plugin",
      });
      expect(task.nextFireAt).toBe("2026-06-22T09:00:00.000Z");

      now = new Date("2026-06-22T12:15:00.000Z");
      const enabled = store.updateTask(task.id, { pluginUserEnabled: true, approvalFingerprint: "fp" });

      expect(enabled.pluginUserEnabled).toBe(true);
      expect(enabled.approvalFingerprint).toBe("fp");
      expect(enabled.nextFireAt).toBe("2026-06-22T13:00:00.000Z");
    });

    it("deleteTasksByOwner 只删除该插件的任务并持久化", () => {
      const dir = tmpDir();
      const tasksFile = path.join(dir, "scheduled-tasks.json");
      const store = createSchedulerStore({
        tasksFile,
        historyFile: path.join(dir, "scheduled-tasks-history.jsonl"),
        now: () => new Date("2026-06-22T08:00:00.000Z"),
        id: (() => {
          let n = 0;
          return () => `id-${++n}`;
        })(),
      });
      store.load();
      store.addTask({ title: "用户任务", prompt: "A", schedule: { kind: "daily", timeOfDay: "08:00" }, workspaceBinding: { workspaceRoot: "E:/project", displayName: "project", boundAt: 1 } });
      store.addTask({ title: "插件 A 任务", prompt: "B", schedule: { kind: "daily", timeOfDay: "08:00" }, ownerPluginId: "plugin-a" });
      store.addTask({ title: "插件 A 任务 2", prompt: "C", schedule: { kind: "daily", timeOfDay: "09:00" }, ownerPluginId: "plugin-a" });
      store.addTask({ title: "插件 B 任务", prompt: "D", schedule: { kind: "daily", timeOfDay: "10:00" }, ownerPluginId: "plugin-b" });

      expect(store.deleteTasksByOwner("plugin-a")).toBe(2);
      expect(store.deleteTasksByOwner("plugin-a")).toBe(0);
      const remaining = store.getTasks();
      expect(remaining.map(t => t.title).sort()).toEqual(["插件 B 任务", "用户任务"]);

      // 持久化后重新加载仍是删除后的状态
      const store2 = createSchedulerStore({
        tasksFile,
        historyFile: path.join(dir, "scheduled-tasks-history.jsonl"),
        now: () => new Date("2026-06-22T08:00:00.000Z"),
        id: () => "id-x",
      });
      store2.load();
      expect(store2.getTasks().map(t => t.title).sort()).toEqual(["插件 B 任务", "用户任务"]);
    });
  });
});
