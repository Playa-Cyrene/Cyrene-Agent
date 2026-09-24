import type {
  PluginPromptMode,
  PluginScheduledExecutionSpec,
  PluginScheduledTask,
  PluginScheduledTaskHistory,
  PluginScheduledTaskInput,
  PluginScheduledTaskPatch,
  PluginSchedulerService,
} from "../../plugins/api";
import {
  computeExecutionSpecFingerprint,
  isPluginTaskEffectivelyEnabled,
  taskExecutionSpec,
} from "../scheduler/execution-spec";
import { validateSchedule } from "../scheduler/scheduler-store";
import type {
  NewScheduledTaskInput,
  ScheduledTask,
  ScheduledTaskHistoryEntry,
  ScheduledTaskPatch,
} from "../scheduler/types";
import { pluginHostError } from "./errors";

/** 调度存储的最小只读视图；真实实现是 scheduler-store，测试注入内存假件。 */
export interface PluginSchedulerStore {
  getTasks(): ScheduledTask[];
  addTask(input: NewScheduledTaskInput): ScheduledTask;
  updateTask(id: string, patch: ScheduledTaskPatch): ScheduledTask;
  deleteTask(id: string): boolean;
  getHistory(taskId: string, limit?: number): ScheduledTaskHistoryEntry[];
}

export interface PluginSchedulerServiceOptions {
  pluginId: string;
  store: PluginSchedulerStore;
  /** 插件停止信号；停止后所有调用返回 E_PLUGIN_STOPPING。 */
  signal?: AbortSignal;
  /** 当前时间，测试注入固定值；默认真实时间。 */
  now?: () => Date;
}

const MODES: readonly PluginPromptMode[] = ["chat", "work", "learn", "code"];
const DEFAULT_HISTORY_LIMIT = 10;
const MAX_HISTORY_LIMIT = 100;

/**
 * 插件调度服务：只允许访问自己创建的任务。创建的任务永远以停用状态
 * 落盘（enabled: false、无授权指纹），必须由用户在宿主界面确认后才
 * 可能运行；插件改了执行规格（计划/提示词/模式/工具白名单）会立即
 * 撤销已有授权，改标题不会。
 */
export function createPluginSchedulerService(options: PluginSchedulerServiceOptions): PluginSchedulerService {
  const { pluginId, store, signal } = options;
  const now = options.now ?? (() => new Date());
  const logPrefix = `plugin:${pluginId}:scheduler`;

  function assertActive(): void {
    if (signal?.aborted) {
      throw pluginHostError("E_PLUGIN_STOPPING", `插件 ${pluginId} 已停止，调度服务不可用`);
    }
  }

  function assertMode(mode: unknown): void {
    if (!MODES.includes(mode as PluginPromptMode)) {
      throw pluginHostError("E_INVALID_ARGUMENT", `非法会话模式: ${String(mode)}`);
    }
  }

  function assertToolIds(allowedToolIds: unknown): void {
    if (!Array.isArray(allowedToolIds) || allowedToolIds.some((id) => typeof id !== "string")) {
      throw pluginHostError("E_INVALID_ARGUMENT", "工具白名单必须是字符串数组");
    }
  }

  function assertSchedule(schedule: unknown): void {
    try {
      validateSchedule(schedule as Parameters<typeof validateSchedule>[0]);
    } catch (err) {
      throw pluginHostError("E_INVALID_ARGUMENT", (err as Error).message);
    }
  }

  /** 校验完整执行规格输入；新传入的一次性任务时间必须晚于当前时间。 */
  function assertSpecInput(spec: PluginScheduledExecutionSpec, scheduleIsNew: boolean): void {
    if (typeof spec.prompt !== "string" || !spec.prompt.trim()) {
      throw pluginHostError("E_INVALID_ARGUMENT", "提示词不能为空");
    }
    assertSchedule(spec.schedule);
    assertMode(spec.mode);
    assertToolIds(spec.allowedToolIds);
    // 只检查本次新提交的计划：更新时保留的旧 once 计划可能已过期，
    // 只要不动它就不应阻止改标题之类的元数据修改。
    if (scheduleIsNew && spec.schedule.kind === "once" && new Date(spec.schedule.runAt).getTime() <= now().getTime()) {
      throw pluginHostError("E_INVALID_ARGUMENT", "一次性任务时间必须晚于当前时间");
    }
  }

  function findOwnedTask(id: string): ScheduledTask {
    const task = store.getTasks().find((t) => t.id === id);
    if (!task) {
      throw pluginHostError("E_NOT_FOUND", `任务不存在: ${id}`);
    }
    // 不是自己的任务一律拒绝，不区分"其他插件的"和"用户的"，避免探测。
    if (task.ownerPluginId !== pluginId) {
      throw pluginHostError("E_NOT_OWNER", `任务不属于插件 ${pluginId}: ${id}`);
    }
    return task;
  }

  function projectTask(task: ScheduledTask): PluginScheduledTask {
    const projected: PluginScheduledTask = {
      id: task.id,
      title: task.title,
      schedule: task.schedule as PluginScheduledTask["schedule"],
      prompt: task.prompt,
      mode: task.mode ?? "work",
      allowedToolIds: [...task.allowedToolIds],
      enabled: isPluginTaskEffectivelyEnabled(task),
      nextFireAt: task.nextFireAt,
      ...(task.lastFiredAt ? { lastFiredAt: task.lastFiredAt } : {}),
      createdAt: task.createdAt,
      updatedAt: task.updatedAt,
    };
    return projected;
  }

  function projectHistory(entry: ScheduledTaskHistoryEntry): PluginScheduledTaskHistory {
    const projected: PluginScheduledTaskHistory = {
      id: entry.id,
      taskId: entry.taskId,
      status: entry.status,
      startedAt: entry.firedAt,
      ...(entry.finishedAt ? { finishedAt: entry.finishedAt } : {}),
      ...(entry.outputPreview ? { summary: entry.outputPreview } : {}),
    };
    return projected;
  }

  return {
    async createTask(input) {
      assertActive();
      if (!input || typeof input.title !== "string" || !input.title.trim()) {
        throw pluginHostError("E_INVALID_ARGUMENT", "标题不能为空");
      }
      assertSpecInput(input, true);
      let task: ScheduledTask;
      try {
        // 宿主内部字段不来自插件输入：enabled/toolMode/pluginUserEnabled/
        // approvalFingerprint 全部由这里固定写入。
        task = store.addTask({
          title: input.title.trim(),
          prompt: input.prompt.trim(),
          enabled: false,
          schedule: input.schedule,
          toolMode: "allow-list",
          allowedToolIds: input.allowedToolIds,
          ownerPluginId: pluginId,
          pluginUserEnabled: false,
          approvalFingerprint: "",
          mode: input.mode,
        });
      } catch (err) {
        throw pluginHostError("E_INTERNAL", "创建调度任务失败", { cause: err, logPrefix });
      }
      return projectTask(task);
    },

    async listTasks() {
      assertActive();
      return store
        .getTasks()
        .filter((task) => task.ownerPluginId === pluginId)
        .map(projectTask);
    },

    async updateTask(id, patch: PluginScheduledTaskPatch) {
      assertActive();
      if (!id || typeof id !== "string") {
        throw pluginHostError("E_INVALID_ARGUMENT", `非法任务 id: ${String(id)}`);
      }
      const current = findOwnedTask(id);

      // 合并出更新后的执行规格，用于判断规格是否实际变化。
      const nextSpec: PluginScheduledExecutionSpec = {
        schedule: (patch.schedule ?? current.schedule) as PluginScheduledExecutionSpec["schedule"],
        prompt: patch.prompt !== undefined ? patch.prompt.trim() : current.prompt,
        mode: patch.mode ?? current.mode ?? "work",
        allowedToolIds: patch.allowedToolIds ?? current.allowedToolIds,
      };
      if (patch.title !== undefined && (typeof patch.title !== "string" || !patch.title.trim())) {
        throw pluginHostError("E_INVALID_ARGUMENT", "标题不能为空");
      }
      assertSpecInput(nextSpec, patch.schedule !== undefined);

      const specChanged = computeExecutionSpecFingerprint(taskExecutionSpec(current))
        !== computeExecutionSpecFingerprint(nextSpec);

      // 只挑插件可写的字段；enabled/pluginUserEnabled/approvalFingerprint/
      // toolMode 等宿主内部字段即使混进 patch 也会被丢弃。
      const internalPatch: ScheduledTaskPatch = {};
      if (patch.title !== undefined) internalPatch.title = patch.title.trim();
      if (patch.schedule !== undefined) internalPatch.schedule = patch.schedule;
      if (patch.prompt !== undefined) internalPatch.prompt = patch.prompt.trim();
      if (patch.mode !== undefined) internalPatch.mode = patch.mode;
      if (patch.allowedToolIds !== undefined) internalPatch.allowedToolIds = patch.allowedToolIds;
      if (specChanged) {
        // 执行规格变了：撤销用户授权并清空指纹，等待重新确认。
        internalPatch.pluginUserEnabled = false;
        internalPatch.approvalFingerprint = "";
      }

      let updated: ScheduledTask;
      try {
        updated = store.updateTask(id, internalPatch);
      } catch (err) {
        throw pluginHostError("E_INTERNAL", "更新调度任务失败", { cause: err, logPrefix });
      }
      return projectTask(updated);
    },

    async deleteTask(id) {
      assertActive();
      if (!id || typeof id !== "string") {
        throw pluginHostError("E_INVALID_ARGUMENT", `非法任务 id: ${String(id)}`);
      }
      findOwnedTask(id);
      try {
        return store.deleteTask(id);
      } catch (err) {
        throw pluginHostError("E_INTERNAL", "删除调度任务失败", { cause: err, logPrefix });
      }
    },

    async getHistory(id, limit) {
      assertActive();
      if (!id || typeof id !== "string") {
        throw pluginHostError("E_INVALID_ARGUMENT", `非法任务 id: ${String(id)}`);
      }
      const effectiveLimit = limit ?? DEFAULT_HISTORY_LIMIT;
      if (!Number.isInteger(effectiveLimit) || effectiveLimit < 1 || effectiveLimit > MAX_HISTORY_LIMIT) {
        throw pluginHostError("E_INVALID_ARGUMENT", `非法历史条数: ${String(limit)}（1-${MAX_HISTORY_LIMIT}）`);
      }
      findOwnedTask(id);
      return store
        .getHistory(id, effectiveLimit)
        .map(projectHistory);
    },
  };
}
