import { createHash } from "node:crypto";
import type { PluginScheduledExecutionSpec } from "../../plugins/api";
import type { ScheduleConfig, ScheduledTask, ScheduledTaskPatch } from "./types";

/** 规范化计划：按固定字段顺序重建对象，同样语义的计划指纹必然一致。 */
function canonicalSchedule(schedule: ScheduleConfig): Record<string, unknown> {
  switch (schedule.kind) {
    case "once":
      return { kind: "once", runAt: schedule.runAt };
    case "daily":
      return { kind: "daily", timeOfDay: schedule.timeOfDay };
    case "weekdays":
      return { kind: "weekdays", timeOfDay: schedule.timeOfDay };
    case "weekly":
      return { kind: "weekly", dayOfWeek: schedule.dayOfWeek, timeOfDay: schedule.timeOfDay };
    case "monthly":
      return { kind: "monthly", dayOfMonth: schedule.dayOfMonth, timeOfDay: schedule.timeOfDay };
    case "yearly":
      return { kind: "yearly", month: schedule.month, dayOfMonth: schedule.dayOfMonth, timeOfDay: schedule.timeOfDay };
    case "interval":
      return { kind: "interval", every: schedule.every, unit: schedule.unit };
  }
}

/**
 * 规范化执行规格：固定键序、工具 ID 排序去重。
 * 标题是给用户看的元数据，不属于执行规格，改标题不会改变指纹。
 */
function canonicalExecutionSpec(spec: PluginScheduledExecutionSpec): Record<string, unknown> {
  return {
    schedule: canonicalSchedule(spec.schedule),
    prompt: spec.prompt,
    mode: spec.mode,
    allowedToolIds: Array.from(new Set(spec.allowedToolIds)).sort(),
  };
}

/** 执行规格的 SHA-256 授权指纹；用户确认启用时写入任务，执行前重新计算比对。 */
export function computeExecutionSpecFingerprint(spec: PluginScheduledExecutionSpec): string {
  return createHash("sha256")
    .update(JSON.stringify(canonicalExecutionSpec(spec)), "utf8")
    .digest("hex");
}

/** 任务当前生效的执行规格；旧任务缺 mode 时按 work 归一化。 */
export function taskExecutionSpec(task: ScheduledTask): PluginScheduledExecutionSpec {
  return {
    schedule: task.schedule as PluginScheduledExecutionSpec["schedule"],
    prompt: task.prompt,
    mode: task.mode ?? "work",
    allowedToolIds: task.allowedToolIds,
  };
}

/**
 * 插件任务的有效启用状态：用户已确认授权（pluginUserEnabled）且当前
 * 执行规格与授权时的指纹一致。规格被插件改过会立刻失去授权。
 * 用户任务不走本函数（直接看 enabled）。
 */
export function isPluginTaskEffectivelyEnabled(task: ScheduledTask): boolean {
  if (!task.ownerPluginId) return false;
  if (task.pluginUserEnabled !== true) return false;
  const fingerprint = task.approvalFingerprint;
  if (!fingerprint) return false;
  return fingerprint === computeExecutionSpecFingerprint(taskExecutionSpec(task));
}

/**
 * 任务统一启用判断：用户任务看磁盘 enabled；插件任务看有效授权
 * （用户已确认且执行规格指纹一致）。引擎里所有"是否可运行/是否排计时器"
 * 的判断都必须走本函数，不能直接读 task.enabled。
 */
export function isTaskEnabled(task: ScheduledTask): boolean {
  return task.ownerPluginId ? isPluginTaskEffectivelyEnabled(task) : task.enabled === true;
}

/**
 * 渲染层启停插件任务时转换成的 store patch。
 * 启用即用户对该任务当前执行规格的一次明确授权，按当前规格写入指纹；
 * 执行前引擎会重新计算并比对，插件此后改规格会立刻失去授权。
 */
export function pluginTaskTogglePatch(task: ScheduledTask, enable: boolean): ScheduledTaskPatch {
  if (!enable) return { pluginUserEnabled: false };
  return {
    pluginUserEnabled: true,
    approvalFingerprint: computeExecutionSpecFingerprint(taskExecutionSpec(task)),
  };
}

/**
 * 渲染层保存插件任务编辑时转换成的 store patch。
 * 用户在编辑器里核对并保存视为对保存后规格的同一次确认：
 * - 明确勾选启用，或任务此前已处于授权状态 → 按合并后的新规格重算指纹并保持授权；
 * - 明确取消启用 → 撤销授权，等用户下次重新确认；
 * enabled 与 toolMode 是宿主不变量，从这里剔除，插件任务只能走白名单模式。
 */
export function authorizePluginTaskUpdatePatch(
  current: ScheduledTask,
  patch: ScheduledTaskPatch,
): ScheduledTaskPatch {
  const next: ScheduledTaskPatch = { ...patch };
  delete next.enabled;
  delete next.toolMode;
  const authorize = next.pluginUserEnabled === true
    || (next.pluginUserEnabled === undefined && isPluginTaskEffectivelyEnabled(current));
  if (authorize) {
    const merged: ScheduledTask = {
      ...current,
      schedule: next.schedule ?? current.schedule,
      prompt: next.prompt ?? current.prompt,
      mode: next.mode !== undefined ? next.mode : current.mode,
      allowedToolIds: next.allowedToolIds ?? current.allowedToolIds,
    };
    next.pluginUserEnabled = true;
    next.approvalFingerprint = computeExecutionSpecFingerprint(taskExecutionSpec(merged));
  }
  return next;
}
