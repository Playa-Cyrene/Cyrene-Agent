// Scheduler 面板纯函数：日期/时间格式化与校验
// 从 settings.ts 抽离，无 DOM/状态依赖。

import type { ScheduleConfig } from "./types";

/** 将任意时间字符串转为 <input type="datetime-local"> 需要的本地时间格式 YYYY-MM-DDTHH:mm。 */
export function toLocalDateTimeInputValue(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** 校验时间字符串是否为 HH:mm（00:00 ~ 23:59）。 */
export function isValidTimeOfDay(value: string): boolean {
  return /^([01]\d|2[0-3]):[0-5]\d$/.test(value);
}

/** 将时间值格式化为本地可读字符串；空/无效返回固定占位符。 */
export function formatSchedulerDate(value: string | null | undefined): string {
  if (!value) return "未安排";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "时间无效";
  return date.toLocaleString();
}

/** 依据 ScheduleConfig 生成一句话描述（用于列表项 meta）。 */
export function describeSchedule(schedule: ScheduleConfig): string {
  if (schedule.kind === "once") return "仅一次 " + formatSchedulerDate(schedule.runAt);
  if (schedule.kind === "daily") return "每天 " + schedule.timeOfDay;
  if (schedule.kind === "weekdays") return "工作日 " + schedule.timeOfDay;
  if (schedule.kind === "weekly") {
    const names = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];
    return `${names[schedule.dayOfWeek]} ${schedule.timeOfDay}`;
  }
  if (schedule.kind === "monthly") return `每月 ${schedule.dayOfMonth} 日 ${schedule.timeOfDay}`;
  if (schedule.kind === "yearly") return `每年 ${schedule.month} 月 ${schedule.dayOfMonth} 日 ${schedule.timeOfDay}`;
  return `每隔 ${schedule.every} ${schedule.unit === "minutes" ? "分钟" : "小时"}`;
}
