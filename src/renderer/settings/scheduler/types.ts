// Scheduler 面板类型定义
// 从 settings.ts 抽离的纯类型,无运行时依赖。
import type { ConversationWorkspaceBinding } from "../../../shared/chat-types";

export type ScheduleConfig =
  | { kind: "once"; runAt: string }
  | { kind: "daily"; timeOfDay: string }
  | { kind: "weekdays"; timeOfDay: string }
  | { kind: "weekly"; dayOfWeek: 0 | 1 | 2 | 3 | 4 | 5 | 6; timeOfDay: string }
  | { kind: "monthly"; dayOfMonth: number; timeOfDay: string }
  | { kind: "yearly"; month: number; dayOfMonth: number; timeOfDay: string }
  | { kind: "interval"; every: number; unit: "minutes" | "hours" };

export type SchedulerToolMode = "all-enabled" | "allow-list";

export interface ScheduledTask {
  id: string;
  title: string;
  prompt: string;
  enabled: boolean;
  schedule: ScheduleConfig;
  nextFireAt: string | null;
  runCount?: number;
  maxRuns?: number;
  endAt?: string;
  workspaceBinding?: ConversationWorkspaceBinding;
  lastFiredAt?: string;
  toolMode: SchedulerToolMode;
  allowedToolIds: string[];
  createdAt: string;
  updatedAt: string;
  /** 创建该任务的插件 id；缺失表示用户任务。主进程已把插件任务的有效授权映射进 enabled。 */
  ownerPluginId?: string;
  /** 插件任务冻结的会话模式；缺失按 work 执行。 */
  mode?: string;
}

export interface ScheduledTaskHistoryEntry {
  id: string;
  taskId: string;
  taskTitle: string;
  firedAt: string;
  finishedAt?: string;
  durationMs?: number;
  status: "running" | "success" | "failed" | "skipped";
  reason?: string;
  outputPreview?: string;
  errorMessage?: string;
  effectiveToolIds: string[];
  sessionId?: string;
}

export interface SchedulerToolInfo {
  id: string;
  name: string;
  description: string;
  enabled: boolean;
  risk: string;
}

export interface SchedulerResult<T> {
  ok: boolean;
  value?: T;
  error?: string;
  reason?: string;
}

export interface SchedulerApi {
  list: () => Promise<SchedulerResult<ScheduledTask[]>>;
  add: (input: unknown) => Promise<SchedulerResult<ScheduledTask>>;
  update: (id: string, patch: unknown) => Promise<SchedulerResult<ScheduledTask>>;
  delete: (id: string) => Promise<SchedulerResult<boolean>>;
  toggle: (id: string, enabled: boolean) => Promise<SchedulerResult<ScheduledTask>>;
  fireNow: (id: string) => Promise<SchedulerResult<boolean>>;
  getHistory: (taskId: string, limit?: number) => Promise<SchedulerResult<ScheduledTaskHistoryEntry[]>>;
  getTools: () => Promise<SchedulerResult<SchedulerToolInfo[]>>;
  onChanged?: (callback: () => void) => () => void;
}
