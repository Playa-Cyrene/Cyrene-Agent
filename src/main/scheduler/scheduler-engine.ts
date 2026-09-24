import { isTaskEnabled } from "./execution-spec";
import { computeNextFireAtAfter, normalizeOverdueNextFireAt } from "./schedule-calculator";
import type { ScheduledRunResult, ScheduledTask, ScheduledTaskHistoryEntry } from "./types";

const MAX_TIMER_DELAY_MS = 60 * 60 * 1000;

interface SchedulerStoreLike {
  getTasks(): ScheduledTask[];
  updateTask(id: string, patch: Partial<ScheduledTask>): ScheduledTask;
  recordHistory(entry: ScheduledTaskHistoryEntry): void;
  onChange(listener: (tasks: ScheduledTask[]) => void): () => void;
}

export interface SchedulerEngineDeps {
  store: SchedulerStoreLike;
  runTask: (task: ScheduledTask, scheduledFireAt: Date, manual: boolean) => Promise<ScheduledRunResult>;
  /**
   * 运行条件检查（在有效启用状态之上）：宿主注入"插件是否正在运行"，
   * 插件停用时定时触发和手动触发都被跳过。缺省视为无条件可运行。
   */
  canRunTask?: (task: ScheduledTask) => boolean;
  now?: () => Date;
  id?: () => string;
}

export class SchedulerEngine {
  private timer: NodeJS.Timeout | null = null;
  private runningTaskIds = new Set<string>();
  private readonly now: () => Date;
  private readonly id: () => string;
  private unsubscribeStore?: () => void;

  constructor(private readonly deps: SchedulerEngineDeps) {
    this.now = deps.now ?? (() => new Date());
    this.id = deps.id ?? (() => `hist-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  }

  start(): void {
    this.normalizeOverdueTasks();
    this.unsubscribeStore?.();
    this.unsubscribeStore = this.deps.store.onChange(() => this.scheduleNextTimer());
    this.scheduleNextTimer();
  }

  stop(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.unsubscribeStore?.();
    this.unsubscribeStore = undefined;
  }

  /**
   * 插件启停后调用：重新归一化逾期任务并重排计时器。
   * 只推进下一次触发时间，不补跑停用期间错过的任务。
   */
  refreshPluginTasks(): void {
    this.normalizeOverdueTasks();
    this.scheduleNextTimer();
  }

  async fireNow(taskId: string): Promise<{ ok: boolean; reason?: string }> {
    const task = this.deps.store.getTasks().find(t => t.id === taskId);
    if (!task) return { ok: false, reason: "task not found" };
    if (!isTaskEnabled(task)) return { ok: false, reason: "task is disabled" };
    if (!this.canRun(task)) return { ok: false, reason: "plugin not running" };
    if (this.runningTaskIds.has(task.id)) return { ok: false, reason: "task already running" };
    await this.runOne(task, this.now(), true);
    return { ok: true };
  }

  private canRun(task: ScheduledTask): boolean {
    return this.deps.canRunTask ? this.deps.canRunTask(task) : true;
  }

  /** 关停任务时写入的 patch：用户任务清 enabled，插件任务清用户授权。 */
  private disablePatch(task: ScheduledTask): Partial<ScheduledTask> {
    return task.ownerPluginId
      ? { pluginUserEnabled: false, nextFireAt: null }
      : { enabled: false, nextFireAt: null };
  }

  private normalizeOverdueTasks(): void {
    const now = this.now();
    for (const task of this.deps.store.getTasks()) {
      if (!isTaskEnabled(task) || !task.nextFireAt) continue;
      if ((task.maxRuns !== undefined && (task.runCount ?? 0) >= task.maxRuns)
        || (task.endAt && Date.parse(task.endAt) <= now.getTime())) {
        this.deps.store.updateTask(task.id, this.disablePatch(task));
        continue;
      }
      const next = new Date(task.nextFireAt);
      if (Number.isNaN(next.getTime())) {
        this.deps.store.updateTask(task.id, this.disablePatch(task));
        continue;
      }
      if (next.getTime() > now.getTime()) continue;
      if (task.schedule.kind === "once") {
        this.deps.store.recordHistory({
          id: this.id(),
          taskId: task.id,
          taskTitle: task.title,
          firedAt: now.toISOString(),
          status: "skipped",
          reason: "missed while app was closed",
          effectiveToolIds: [],
        });
        this.deps.store.updateTask(task.id, this.disablePatch(task));
        continue;
      }
      const normalized = normalizeOverdueNextFireAt(task.schedule, next, now);
      if ((task.maxRuns !== undefined && (task.runCount ?? 0) >= task.maxRuns)
        || (task.endAt && (!normalized || normalized.getTime() > Date.parse(task.endAt)))) {
        this.deps.store.updateTask(task.id, this.disablePatch(task));
        continue;
      }
      this.deps.store.updateTask(task.id, { nextFireAt: normalized ? normalized.toISOString() : null });
    }
  }

  private scheduleNextTimer(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    const now = this.now();
    const nextTask = this.deps.store.getTasks()
      .filter(t => {
        if (!isTaskEnabled(t) || !t.nextFireAt) return false;
        return !Number.isNaN(new Date(t.nextFireAt).getTime());
      })
      .sort((a, b) => String(a.nextFireAt).localeCompare(String(b.nextFireAt)))[0];
    if (!nextTask?.nextFireAt) return;
    const delay = Math.max(0, new Date(nextTask.nextFireAt).getTime() - now.getTime());
    this.timer = setTimeout(() => void this.fireDueTasks(), Math.min(delay, MAX_TIMER_DELAY_MS));
  }

  private async fireDueTasks(): Promise<void> {
    const now = this.now();
    const due = this.deps.store.getTasks().filter(task => {
      if (!isTaskEnabled(task) || !task.nextFireAt) return false;
      return new Date(task.nextFireAt).getTime() <= now.getTime();
    });
    for (const task of due) {
      const scheduledFireAt = task.nextFireAt ? new Date(task.nextFireAt) : now;
      if (task.maxRuns !== undefined && (task.runCount ?? 0) >= task.maxRuns) {
        this.deps.store.updateTask(task.id, this.disablePatch(task));
        continue;
      }
      if (task.endAt && scheduledFireAt.getTime() > Date.parse(task.endAt)) {
        this.deps.store.updateTask(task.id, this.disablePatch(task));
        continue;
      }
      const nextRunCount = (task.runCount ?? 0) + 1;
      if (!this.canRun(task)) {
        // 插件停用：跳过本次执行，但照常推进下一次时间，既不补跑，
        // 也避免逾期任务让计时器进入零延迟循环。
        this.deps.store.recordHistory({
          id: this.id(),
          taskId: task.id,
          taskTitle: task.title,
          firedAt: scheduledFireAt.toISOString(),
          status: "skipped",
          reason: "plugin not running",
          effectiveToolIds: [],
        });
        const rawNext = computeNextFireAtAfter(task.schedule, scheduledFireAt);
        const next = rawNext && rawNext.getTime() <= now.getTime()
          ? normalizeOverdueNextFireAt(task.schedule, rawNext, now)
          : rawNext;
        const finished = task.schedule.kind === "once"
          || (task.maxRuns !== undefined && nextRunCount >= task.maxRuns)
          || Boolean(task.endAt && (!next || next.getTime() > Date.parse(task.endAt)));
        this.deps.store.updateTask(task.id, {
          ...(finished ? this.disablePatch(task) : { nextFireAt: next ? next.toISOString() : null }),
          lastFiredAt: scheduledFireAt.toISOString(),
        });
        continue;
      }
      void this.runOne(task, scheduledFireAt, false);
      const rawNext = computeNextFireAtAfter(task.schedule, scheduledFireAt);
      const next = rawNext && rawNext.getTime() <= now.getTime()
        ? normalizeOverdueNextFireAt(task.schedule, rawNext, now)
        : rawNext;
      const finished = task.schedule.kind === "once"
        || (task.maxRuns !== undefined && nextRunCount >= task.maxRuns)
        || Boolean(task.endAt && (!next || next.getTime() > Date.parse(task.endAt)));
      this.deps.store.updateTask(task.id, {
        ...(finished ? this.disablePatch(task) : { nextFireAt: next ? next.toISOString() : null }),
        lastFiredAt: scheduledFireAt.toISOString(),
      });
    }
    this.scheduleNextTimer();
  }

  private async runOne(task: ScheduledTask, scheduledFireAt: Date, manual: boolean): Promise<void> {
    if (this.runningTaskIds.has(task.id)) {
      if (!manual) {
        this.deps.store.recordHistory({
          id: this.id(),
          taskId: task.id,
          taskTitle: task.title,
          firedAt: scheduledFireAt.toISOString(),
          status: "skipped",
          reason: "previous run still active",
          effectiveToolIds: [],
        });
      }
      return;
    }
    this.runningTaskIds.add(task.id);
    try {
      await this.deps.runTask(task, scheduledFireAt, manual);
    } finally {
      this.runningTaskIds.delete(task.id);
    }
  }
}
