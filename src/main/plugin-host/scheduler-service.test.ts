import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { isPluginHostError } from "../../plugins/api";
import { computeExecutionSpecFingerprint, taskExecutionSpec } from "../scheduler/execution-spec";
import { createSchedulerStore } from "../scheduler/scheduler-store";
import type { ScheduledTask } from "../scheduler/types";
import { createPluginSchedulerService } from "./scheduler-service";

let dir: string;
let store: ReturnType<typeof createSchedulerStore>;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "cyrene-plugin-scheduler-"));
  store = createSchedulerStore({
    tasksFile: path.join(dir, "scheduled-tasks.json"),
    historyFile: path.join(dir, "scheduled-tasks-history.jsonl"),
    now: () => new Date("2026-06-22T08:00:00.000Z"),
    id: (() => {
      let n = 0;
      return () => `task-${++n}`;
    })(),
  });
  store.load();
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

const taskInput = {
  title: "每日总结",
  prompt: "总结今天的待办",
  schedule: { kind: "daily", timeOfDay: "09:00" },
  mode: "work" as const,
  allowedToolIds: ["weather", "calendar"],
};

function service(pluginId = "demo-plugin", signal?: AbortSignal) {
  return createPluginSchedulerService({ pluginId, store, signal, now: () => new Date("2026-06-22T08:00:00.000Z") });
}

/** 模拟大步 3 的宿主确认链路：用户确认后由宿主写授权指纹。 */
function grantAuthorization(taskId: string): void {
  const task = store.getTasks().find((t) => t.id === taskId);
  if (!task) throw new Error("task missing");
  store.updateTask(taskId, {
    pluginUserEnabled: true,
    approvalFingerprint: computeExecutionSpecFingerprint(taskExecutionSpec(task)),
  });
}

function expectHostError(promise: Promise<unknown>, code: string): Promise<void> {
  return promise.then(
    () => { throw new Error(`期望抛出 ${code}`); },
    (err: unknown) => {
      expect(isPluginHostError(err)).toBe(true);
      expect((err as { code: string }).code).toBe(code);
    },
  );
}

describe("插件调度服务", () => {
  it("创建的任务以停用状态落盘，无授权指纹", async () => {
    const task = await service().createTask(taskInput);
    expect(task.enabled).toBe(false);
    expect(task.id).toBeTruthy();
    expect(task.nextFireAt).toBeTruthy();
    expect(task.mode).toBe("work");
    expect(task.allowedToolIds).toEqual(["weather", "calendar"]);
    // 落盘校验：内部字段
    const persisted = store.getTasks().find((t) => t.id === task.id) as ScheduledTask;
    expect(persisted.ownerPluginId).toBe("demo-plugin");
    expect(persisted.pluginUserEnabled).toBe(false);
    expect(persisted.approvalFingerprint).toBe("");
    expect(persisted.enabled).toBe(false);
    expect(persisted.toolMode).toBe("allow-list");
  });

  it("listTasks 只返回自己的任务", async () => {
    const mine = await service("plugin-a").createTask(taskInput);
    await service("plugin-b").createTask({ ...taskInput, title: "别人的" });
    store.addTask({ title: "用户任务", prompt: "p", schedule: { kind: "daily", timeOfDay: "10:00" }, workspaceBinding: { workspaceRoot: "E:/project", displayName: "project", boundAt: 1 } });

    const tasks = await service("plugin-a").listTasks();
    expect(tasks).toHaveLength(1);
    expect(tasks[0].id).toBe(mine.id);
  });

  it("宿主写入授权后投影为启用", async () => {
    const created = await service().createTask(taskInput);
    grantAuthorization(created.id);
    const listed = await service().listTasks();
    expect(listed[0].enabled).toBe(true);
  });

  it("改标题不撤销授权，改执行规格立即撤销", async () => {
    const created = await service().createTask(taskInput);
    grantAuthorization(created.id);

    const retitled = await service().updateTask(created.id, { title: "新标题" });
    expect(retitled.enabled).toBe(true);

    const reprompted = await service().updateTask(created.id, { prompt: "新的提示词" });
    expect(reprompted.enabled).toBe(false);
    const persisted = store.getTasks().find((t) => t.id === created.id) as ScheduledTask;
    expect(persisted.pluginUserEnabled).toBe(false);
    expect(persisted.approvalFingerprint).toBe("");

    // 工具白名单、模式、计划变化同样撤销
    grantAuthorization(created.id);
    await service().updateTask(created.id, { allowedToolIds: ["weather"] });
    expect(store.getTasks().find((t) => t.id === created.id)?.pluginUserEnabled).toBe(false);

    grantAuthorization(created.id);
    await service().updateTask(created.id, { mode: "chat" });
    expect(store.getTasks().find((t) => t.id === created.id)?.pluginUserEnabled).toBe(false);

    grantAuthorization(created.id);
    await service().updateTask(created.id, { schedule: { kind: "daily", timeOfDay: "09:30" } });
    expect(store.getTasks().find((t) => t.id === created.id)?.pluginUserEnabled).toBe(false);
  });

  it("updateTask 混入宿主内部字段也会被丢弃", async () => {
    const created = await service().createTask(taskInput);
    grantAuthorization(created.id);

    // 运行时混入内部字段（类型层面不允许，防御性校验运行时行为）
    await service().updateTask(created.id, {
      title: "改名",
      ...({ enabled: true, pluginUserEnabled: false, approvalFingerprint: "forged", toolMode: "all-enabled" } as object),
    } as never);

    const persisted = store.getTasks().find((t) => t.id === created.id) as ScheduledTask;
    expect(persisted.enabled).toBe(false);
    expect(persisted.pluginUserEnabled).toBe(true);
    expect(persisted.approvalFingerprint).not.toBe("forged");
    expect(persisted.toolMode).toBe("allow-list");
    expect(persisted.title).toBe("改名");
  });

  it("不能改删查看其他插件或用户的任务", async () => {
    const other = await service("plugin-b").createTask(taskInput);
    const userTask = store.addTask({ title: "用户任务", prompt: "p", schedule: { kind: "daily", timeOfDay: "10:00" }, workspaceBinding: { workspaceRoot: "E:/project", displayName: "project", boundAt: 1 } });

    const a = service("plugin-a");
    await expectHostError(a.updateTask(other.id, { title: "x" }), "E_NOT_OWNER");
    await expectHostError(a.deleteTask(other.id), "E_NOT_OWNER");
    await expectHostError(a.getHistory(other.id), "E_NOT_OWNER");
    await expectHostError(a.updateTask(userTask.id, { title: "x" }), "E_NOT_OWNER");
    await expectHostError(a.deleteTask(userTask.id), "E_NOT_OWNER");
    // 任务仍存在，未被改动
    expect(store.getTasks().find((t) => t.id === other.id)?.title).toBe(taskInput.title);
  });

  it("deleteTask 删除自己的任务并返回 true，重复删除返回 false", async () => {
    const created = await service().createTask(taskInput);
    expect(await service().deleteTask(created.id)).toBe(true);
    expect(store.getTasks().find((t) => t.id === created.id)).toBeUndefined();
    await expectHostError(service().deleteTask(created.id), "E_NOT_FOUND");
  });

  it("getHistory 只返回自己任务的历史摘要投影", async () => {
    const created = await service().createTask(taskInput);
    store.recordHistory({
      id: "hist-1",
      taskId: created.id,
      taskTitle: created.title,
      firedAt: "2026-06-22T09:00:00.000Z",
      finishedAt: "2026-06-22T09:00:05.000Z",
      status: "success",
      outputPreview: "执行完成",
      effectiveToolIds: ["weather"],
    });

    const history = await service().getHistory(created.id);
    expect(history).toHaveLength(1);
    expect(history[0]).toEqual({
      id: "hist-1",
      taskId: created.id,
      status: "success",
      startedAt: "2026-06-22T09:00:00.000Z",
      finishedAt: "2026-06-22T09:00:05.000Z",
      summary: "执行完成",
    });
  });

  it("非法输入返回 E_INVALID_ARGUMENT", async () => {
    const svc = service();
    await expectHostError(svc.createTask({ ...taskInput, title: " " }), "E_INVALID_ARGUMENT");
    await expectHostError(svc.createTask({ ...taskInput, prompt: " " }), "E_INVALID_ARGUMENT");
    await expectHostError(
      svc.createTask({ ...taskInput, mode: "invalid" as never }),
      "E_INVALID_ARGUMENT",
    );
    await expectHostError(
      svc.createTask({ ...taskInput, schedule: { kind: "daily", timeOfDay: "25:00" } }),
      "E_INVALID_ARGUMENT",
    );
    await expectHostError(
      svc.createTask({ ...taskInput, allowedToolIds: [1] as never }),
      "E_INVALID_ARGUMENT",
    );
    // 一次性任务时间已过
    await expectHostError(
      svc.createTask({
        ...taskInput,
        schedule: { kind: "once", runAt: "2026-01-01T00:00:00.000Z" },
      }),
      "E_INVALID_ARGUMENT",
    );
    await expectHostError(svc.getHistory("task-x", 0), "E_INVALID_ARGUMENT");
    await expectHostError(svc.getHistory("task-x", 101), "E_INVALID_ARGUMENT");
  });

  it("插件停止后所有调用返回 E_PLUGIN_STOPPING", async () => {
    const controller = new AbortController();
    const svc = service("demo-plugin", controller.signal);
    const created = await svc.createTask(taskInput);
    controller.abort();

    await expectHostError(svc.createTask(taskInput), "E_PLUGIN_STOPPING");
    await expectHostError(svc.listTasks(), "E_PLUGIN_STOPPING");
    await expectHostError(svc.updateTask(created.id, { title: "x" }), "E_PLUGIN_STOPPING");
    await expectHostError(svc.deleteTask(created.id), "E_PLUGIN_STOPPING");
    await expectHostError(svc.getHistory(created.id), "E_PLUGIN_STOPPING");
  });
});
