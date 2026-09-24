import { useCallback, useEffect, useMemo, useState } from "react";
import { Button, Card, Checkbox, Empty, Input, Modal, Select, Space, Switch, Tag, message } from "antd";
import { CalendarClock, CalendarRange, ChevronRight, Clock3, Code2, History, LoaderCircle, Pencil, Play, Plus, RefreshCw, Sparkles, Trash2 } from "lucide-react";
import type { ConversationWorkspaceBinding } from "../../../../shared/chat-types";
import type { ScheduleConfig, ScheduledTask, ScheduledTaskHistoryEntry, SchedulerToolInfo } from "../../../settings/scheduler/types";
import { useTranslation } from "../../i18n";
import { materializeScheduledTaskTemplate, scheduledTaskTemplates } from "./scheduledTaskTemplates";
import "./ScheduledTasksPanel.css";

type TaskMode = "work" | "code";
type ScheduleKind = ScheduleConfig["kind"];
export type EditorValues = {
  title: string;
  prompt: string;
  mode: TaskMode;
  enabled: boolean;
  kind: ScheduleKind;
  runAt: string;
  timeOfDay: string;
  dayOfWeek: number;
  dayOfMonth: number;
  month: number;
  every: number;
  unit: "minutes" | "hours";
  endMode: "never" | "date" | "runs";
  endDate: string;
  maxRuns: number;
  limitTools: boolean;
  allowedToolIds: string[];
};

const DEFAULT_VALUES: EditorValues = {
  title: "", prompt: "", mode: "work", enabled: true, kind: "daily", runAt: "", timeOfDay: "08:00",
  dayOfWeek: 1, dayOfMonth: 1, month: 1, every: 1, unit: "hours", endMode: "never", endDate: "", maxRuns: 10,
  limitTools: false, allowedToolIds: [],
};

function localDateTime(value?: string): string {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  const offset = date.getTimezoneOffset() * 60_000;
  return new Date(date.getTime() - offset).toISOString().slice(0, 16);
}

export function scheduleFromEditor(values: EditorValues): ScheduleConfig {
  if (values.kind !== "once" && !/^([01]\d|2[0-3]):[0-5]\d$/.test(values.timeOfDay)) {
    throw new Error("时间格式必须是 HH:mm");
  }
  if (values.kind === "once") {
    if (!values.runAt) throw new Error("请选择运行时间");
    const date = new Date(values.runAt);
    if (!Number.isFinite(date.getTime()) || date.getTime() <= Date.now()) throw new Error("一次性任务时间必须晚于当前时间");
    return { kind: "once", runAt: date.toISOString() };
  }
  if (values.kind === "weekly") return { kind: "weekly", dayOfWeek: values.dayOfWeek as 0 | 1 | 2 | 3 | 4 | 5 | 6, timeOfDay: values.timeOfDay };
  if (values.kind === "weekdays") return { kind: "weekdays", timeOfDay: values.timeOfDay };
  if (values.kind === "monthly") return { kind: "monthly", dayOfMonth: values.dayOfMonth, timeOfDay: values.timeOfDay };
  if (values.kind === "yearly") return { kind: "yearly", month: values.month, dayOfMonth: values.dayOfMonth, timeOfDay: values.timeOfDay };
  if (values.kind === "interval") {
    if (!Number.isInteger(values.every) || values.every <= 0) throw new Error("间隔必须是正整数");
    if ((values.unit === "minutes" && values.every > 1440) || (values.unit === "hours" && values.every > 168)) throw new Error("间隔超出允许范围");
    return { kind: "interval", every: values.every, unit: values.unit };
  }
  return { kind: "daily", timeOfDay: values.timeOfDay };
}

function editorFromTask(task?: ScheduledTask): EditorValues {
  if (!task) return { ...DEFAULT_VALUES };
  const base = { ...DEFAULT_VALUES, title: task.title, prompt: task.prompt, mode: task.mode === "code" ? "code" as const : "work" as const,
    enabled: task.enabled, limitTools: task.toolMode === "allow-list", allowedToolIds: task.allowedToolIds ?? [],
    endMode: task.maxRuns ? "runs" as const : task.endAt ? "date" as const : "never" as const,
    maxRuns: task.maxRuns ?? 10, endDate: task.endAt ? task.endAt.slice(0, 10) : "" };
  switch (task.schedule.kind) {
    case "once": return { ...base, kind: "once", runAt: localDateTime(task.schedule.runAt) };
    case "weekly": return { ...base, kind: "weekly", dayOfWeek: task.schedule.dayOfWeek, timeOfDay: task.schedule.timeOfDay };
    case "weekdays": return { ...base, kind: "weekdays", timeOfDay: task.schedule.timeOfDay };
    case "monthly": return { ...base, kind: "monthly", dayOfMonth: task.schedule.dayOfMonth, timeOfDay: task.schedule.timeOfDay };
    case "yearly": return { ...base, kind: "yearly", month: task.schedule.month, dayOfMonth: task.schedule.dayOfMonth, timeOfDay: task.schedule.timeOfDay };
    case "interval": return { ...base, kind: "interval", every: task.schedule.every, unit: task.schedule.unit };
    default: return { ...base, kind: "daily", timeOfDay: task.schedule.timeOfDay };
  }
}

function describeSchedule(schedule: ScheduleConfig, t: (key: string, options?: Record<string, unknown>) => string): string {
  switch (schedule.kind) {
    case "once": return new Date(schedule.runAt).toLocaleString();
    case "daily": return t("scheduler.dailyAt", { time: schedule.timeOfDay });
    case "weekdays": return t("scheduler.weekdaysAt", { time: schedule.timeOfDay });
    case "weekly": return t("scheduler.weeklyAt", { day: t(`scheduler.weekdays.${schedule.dayOfWeek}`), time: schedule.timeOfDay });
    case "monthly": return t("scheduler.monthlyAt", { date: schedule.dayOfMonth, time: schedule.timeOfDay });
    case "yearly": return t("scheduler.yearlyAt", { month: schedule.month, date: schedule.dayOfMonth, time: schedule.timeOfDay });
    case "interval": return t("scheduler.intervalEvery", { count: schedule.every, unit: t(schedule.unit === "hours" ? "scheduler.hours" : "scheduler.minutes") });
  }
}

function formatDate(value?: string): string {
  if (!value) return "—";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "—" : date.toLocaleString();
}

function resultError(error?: string): Error {
  return new Error(error || "操作失败，请稍后重试");
}

export function ScheduledTasksPanel({
  onPickWorkspace,
  onOpenSession,
}: {
  onPickWorkspace: () => Promise<{ ok: boolean; path?: string; displayName?: string; error?: string }>;
  onOpenSession: (sessionId: string) => void;
}) {
  const { t } = useTranslation();
  const [tasks, setTasks] = useState<ScheduledTask[]>([]);
  const [tools, setTools] = useState<SchedulerToolInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [editorOpen, setEditorOpen] = useState(false);
  const [editing, setEditing] = useState<ScheduledTask | undefined>();
  const [values, setValues] = useState<EditorValues>(DEFAULT_VALUES);
  const [binding, setBinding] = useState<ConversationWorkspaceBinding | undefined>();
  const [historyTask, setHistoryTask] = useState<ScheduledTask | undefined>();
  const [history, setHistory] = useState<ScheduledTaskHistoryEntry[]>([]);
  const [historyLoading, setHistoryLoading] = useState(false);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const [taskResult, toolResult] = await Promise.all([window.cyreneScheduler?.list(), window.cyreneScheduler?.getTools()]);
      if (!taskResult?.ok) throw resultError(taskResult?.error);
      setTasks(taskResult.value ?? []);
      if (toolResult?.ok) setTools(toolResult.value ?? []);
    } catch (error) {
      message.error(error instanceof Error ? error.message : String(error));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);
  useEffect(() => window.cyreneScheduler?.onChanged?.(() => void refresh()), [refresh]);

  const sortedTasks = useMemo(() => [...tasks].sort((a, b) => {
    if (a.enabled !== b.enabled) return a.enabled ? -1 : 1;
    return (a.nextFireAt ?? "￿").localeCompare(b.nextFireAt ?? "￿");
  }), [tasks]);

  function openEditor(task?: ScheduledTask) {
    setEditing(task);
    setValues(editorFromTask(task));
    setBinding(task?.workspaceBinding);
    setEditorOpen(true);
  }

  function useTemplate(templateId: (typeof scheduledTaskTemplates)[number]["id"]) {
    const template = scheduledTaskTemplates.find((item) => item.id === templateId);
    if (!template) return;
    const draft = materializeScheduledTaskTemplate(template, (key) => t(key));
    setEditing(undefined);
    setBinding(undefined);
    setValues({
      ...DEFAULT_VALUES,
      title: draft.title,
      prompt: draft.prompt,
      mode: draft.mode,
      kind: draft.schedule.kind,
      timeOfDay: draft.schedule.timeOfDay,
      ...(draft.schedule.kind === "weekly" ? { dayOfWeek: draft.schedule.dayOfWeek } : {}),
    });
    setEditorOpen(true);
  }

  function updateValues(patch: Partial<EditorValues>) {
    setValues((current) => ({ ...current, ...patch }));
  }

  async function chooseWorkspace() {
    try {
      const picked = await onPickWorkspace();
      if (!picked.ok || !picked.path) {
        if (picked.error) message.error(picked.error);
        return;
      }
      setBinding({ workspaceRoot: picked.path, displayName: picked.displayName || picked.path, boundAt: Date.now() });
    } catch (error) {
      message.error(error instanceof Error ? error.message : String(error));
    }
  }

  async function saveTask() {
    try {
      const title = values.title.trim();
      const prompt = values.prompt.trim();
      if (!title) throw new Error(t("scheduler.titleRequired"));
      if (!prompt) throw new Error(t("scheduler.promptRequired"));
      if (!binding) throw new Error(t("scheduler.workspaceRequired"));
      const payload = {
        title, prompt, mode: values.mode, enabled: values.enabled, schedule: scheduleFromEditor(values),
        workspaceBinding: binding,
        toolMode: values.limitTools ? "allow-list" : "all-enabled",
        allowedToolIds: values.limitTools ? values.allowedToolIds : [],
        maxRuns: values.endMode === "runs" ? values.maxRuns : null,
        endAt: values.endMode === "date" && values.endDate ? new Date(`${values.endDate}T23:59:59.999`).toISOString() : null,
      };
      const result = editing
        ? await window.cyreneScheduler?.update(editing.id, payload)
        : await window.cyreneScheduler?.add(payload);
      if (!result?.ok) throw resultError(result?.error);
      message.success(t("scheduler.saved"));
      setEditorOpen(false);
      await refresh();
    } catch (error) {
      message.error(error instanceof Error ? error.message : String(error));
    }
  }

  async function runAction(task: ScheduledTask, action: "toggle" | "run" | "delete", enabled?: boolean) {
    setBusyId(task.id);
    try {
      if (action === "toggle" && enabled && task.ownerPluginId) {
        const approved = await new Promise<boolean>((resolve) => {
          const preview = task.prompt.length > 120 ? `${task.prompt.slice(0, 120)}…` : task.prompt;
          Modal.confirm({
            title: t("scheduler.pluginEnableTitle"),
            content: t("scheduler.pluginEnableDescription", {
              plugin: task.ownerPluginId,
              schedule: describeSchedule(task.schedule, t),
              prompt: preview,
              mode: task.mode ?? "work",
              tools: task.allowedToolIds.length ? task.allowedToolIds.join(", ") : t("scheduler.noTools"),
            }),
            okText: t("scheduler.pluginEnableConfirm"),
            cancelText: t("scheduler.cancel"),
            onOk: () => resolve(true),
            onCancel: () => resolve(false),
          });
        });
        if (!approved) return;
      }
      const result = action === "toggle"
        ? await window.cyreneScheduler?.toggle(task.id, Boolean(enabled))
        : action === "run"
          ? await window.cyreneScheduler?.fireNow(task.id)
          : await window.cyreneScheduler?.delete(task.id);
      if (!result?.ok) throw resultError(result?.error);
      if (action === "run") message.success(t("scheduler.runQueued"));
      if (action === "delete") message.success(t("scheduler.deleted"));
      await refresh();
    } catch (error) {
      message.error(error instanceof Error ? error.message : String(error));
    } finally {
      setBusyId(null);
    }
  }

  async function openHistory(task: ScheduledTask) {
    setHistoryTask(task);
    setHistory([]);
    setHistoryLoading(true);
    try {
      const result = await window.cyreneScheduler?.getHistory(task.id, 20);
      if (!result?.ok) throw resultError(result?.error);
      setHistory(result.value ?? []);
    } catch (error) {
      message.error(error instanceof Error ? error.message : String(error));
    } finally {
      setHistoryLoading(false);
    }
  }

  function confirmDelete(task: ScheduledTask) {
    Modal.confirm({
      title: t("scheduler.deleteTitle"),
      content: t("scheduler.deleteDescription", { title: task.title }),
      okText: t("scheduler.delete"), cancelText: t("scheduler.cancel"), okButtonProps: { danger: true },
      onOk: () => runAction(task, "delete"),
    });
  }

  const scheduleOptions = [
    { value: "once", label: t("scheduler.once") }, { value: "daily", label: t("scheduler.daily") },
    { value: "weekdays", label: t("scheduler.weekdaysOnly") }, { value: "weekly", label: t("scheduler.weekly") },
    { value: "monthly", label: t("scheduler.monthly") }, { value: "yearly", label: t("scheduler.yearly") },
    { value: "interval", label: t("scheduler.interval") },
  ];
  const statusLabel = (status: ScheduledTaskHistoryEntry["status"]) => t(`scheduler.status.${status}`);
  const isFinished = (task: ScheduledTask) => (task.schedule.kind === "once" && Boolean(task.lastFiredAt))
    || (task.maxRuns !== undefined && (task.runCount ?? 0) >= task.maxRuns)
    || Boolean(task.endAt && Date.parse(task.endAt) <= Date.now());

  return (
    <main className="cy-scheduled-page">
      <header className="cy-scheduled-header">
        <div>
          <div className="cy-scheduled-eyebrow"><CalendarClock size={15} /> {t("scheduler.eyebrow")}</div>
          <h1>{t("scheduler.title")}</h1>
          <p>{t("scheduler.description")}</p>
        </div>
        <Space>
          <Button icon={<RefreshCw size={15} />} onClick={() => void refresh()}>{t("scheduler.refresh")}</Button>
          <Button type="primary" icon={<Plus size={16} />} onClick={() => openEditor()}>{t("scheduler.newTask")}</Button>
        </Space>
      </header>

      <div className="cy-scheduled-summary">
        <span><strong>{tasks.length}</strong>{t("scheduler.totalTasks")}</span>
        <span><strong>{tasks.filter((task) => task.enabled).length}</strong>{t("scheduler.activeTasks")}</span>
        <span className="cy-scheduled-summary-note">{t("scheduler.runtimeNote")}</span>
      </div>

      {loading ? <div className="cy-scheduled-loading"><LoaderCircle className="cy-scheduled-spin" />{t("scheduler.loading")}</div> : sortedTasks.length === 0 ? (
        <Card className="cy-scheduled-empty"><Empty description={t("scheduler.empty")}><Button type="primary" icon={<Plus size={15} />} onClick={() => openEditor()}>{t("scheduler.createFirst")}</Button></Empty></Card>
      ) : (
        <section className="cy-scheduled-list" aria-label={t("scheduler.title")}>
          {sortedTasks.map((task) => (
            <Card key={task.id} className={`cy-scheduled-card ${task.enabled ? "is-enabled" : "is-paused"}`}>
              <div className="cy-scheduled-card-main">
                <div className="cy-scheduled-card-copy">
                  <div className="cy-scheduled-card-title-row">
                    <h2>{task.title}</h2>
                    <Tag color={task.enabled ? "green" : "default"}>{isFinished(task) ? t("scheduler.completed") : task.enabled ? t("scheduler.enabled") : t("scheduler.paused")}</Tag>
                    <Tag>{task.mode === "code" ? "Code" : task.mode === "work" || !task.mode ? "Work" : task.mode}</Tag>
                    {task.ownerPluginId && <Tag>{t("scheduler.pluginTask")}</Tag>}
                  </div>
                  <p className="cy-scheduled-prompt">{task.prompt}</p>
                  <div className="cy-scheduled-meta">
                    <span><Clock3 size={14} />{describeSchedule(task.schedule, t)}</span>
                    <span className="cy-scheduled-workspace" title={task.workspaceBinding?.workspaceRoot ?? ""}>
                      {task.workspaceBinding?.displayName ?? t("scheduler.workspaceMissing")}
                    </span>
                  </div>
                  {(task.maxRuns !== undefined || task.endAt) && <div className="cy-scheduled-next">{task.maxRuns !== undefined ? t("scheduler.runProgress", { count: task.runCount ?? 0, max: task.maxRuns }) : t("scheduler.endsAt", { date: formatDate(task.endAt) })}</div>}
                  <div className="cy-scheduled-next">{t("scheduler.nextRun")}: {formatDate(task.nextFireAt ?? undefined)}</div>
                </div>
                <div className="cy-scheduled-card-actions">
                  <Switch checked={task.enabled} disabled={isFinished(task) || busyId === task.id || (!task.ownerPluginId && !task.workspaceBinding)} onChange={(checked) => void runAction(task, "toggle", checked)} aria-label={task.enabled ? t("scheduler.pause") : t("scheduler.enable")} />
                  <Button type="text" icon={<Play size={16} />} disabled={!task.enabled} loading={busyId === task.id} title={t("scheduler.runNow")} onClick={() => void runAction(task, "run")} />
                  <Button type="text" icon={<History size={16} />} title={t("scheduler.history")} onClick={() => void openHistory(task)} />
                  <Button type="text" icon={<Pencil size={16} />} disabled={Boolean(task.ownerPluginId)} title={t("scheduler.edit")} onClick={() => openEditor(task)} />
                  <Button type="text" danger icon={<Trash2 size={16} />} title={t("scheduler.delete")} onClick={() => confirmDelete(task)} />
                </div>
              </div>
            </Card>
          ))}
        </section>
      )}

      <section className="cy-scheduled-templates">
        <div className="cy-scheduled-templates-heading">
          <div><h2>{t("scheduler.templates.title")}</h2><p>{t("scheduler.templates.description")}</p></div>
          <Sparkles size={17} aria-hidden="true" />
        </div>
        <div className="cy-scheduled-template-grid">
          {scheduledTaskTemplates.map((template) => {
            const draft = materializeScheduledTaskTemplate(template, (key) => t(key));
            const Icon = template.id === "codeReview" ? Code2 : template.id === "weeklyReview" ? CalendarRange : CalendarClock;
            return (
              <button className="cy-scheduled-template" key={template.id} type="button" onClick={() => useTemplate(template.id)}>
                <span className="cy-scheduled-template-icon"><Icon size={17} strokeWidth={1.8} /></span>
                <span className="cy-scheduled-template-copy"><strong>{draft.title}</strong><small>{draft.description}</small></span>
                <span className="cy-scheduled-template-frequency">{describeSchedule(draft.schedule, t)}</span>
              </button>
            );
          })}
        </div>
      </section>

      <Modal open={editorOpen} title={editing ? t("scheduler.editTask") : t("scheduler.newTask")} onCancel={() => setEditorOpen(false)} onOk={() => void saveTask()} okText={t("scheduler.save")} cancelText={t("scheduler.cancel")} width={680} destroyOnClose>
        <div className="cy-scheduled-form">
          <label>{t("scheduler.taskName")}<Input maxLength={80} value={values.title} onChange={(event) => updateValues({ title: event.target.value })} placeholder={t("scheduler.taskNamePlaceholder")} /></label>
          <label>{t("scheduler.instruction")}<Input.TextArea value={values.prompt} onChange={(event) => updateValues({ prompt: event.target.value })} autoSize={{ minRows: 3, maxRows: 8 }} placeholder={t("scheduler.instructionPlaceholder")} /></label>
          <div className="cy-scheduled-form-grid">
            <label>{t("scheduler.mode")}<Select value={values.mode} onChange={(mode: TaskMode) => updateValues({ mode })} options={[{ value: "work", label: t("scheduler.workMode") }, { value: "code", label: t("scheduler.codeMode") }]} /></label>
            <label>{t("scheduler.schedule")}<Select value={values.kind} onChange={(kind: ScheduleKind) => updateValues({ kind })} options={scheduleOptions} /></label>
          </div>
          {values.kind === "once" && <label>{t("scheduler.runAt")}<Input type="datetime-local" value={values.runAt} onChange={(event) => updateValues({ runAt: event.target.value })} /></label>}
          {(["daily", "weekdays", "weekly", "monthly", "yearly"].includes(values.kind)) && <div className="cy-scheduled-form-grid">
            {values.kind === "weekly" && <label>{t("scheduler.weekday")}<Select value={values.dayOfWeek} onChange={(dayOfWeek: number) => updateValues({ dayOfWeek })} options={Array.from({ length: 7 }, (_, day) => ({ value: day, label: t(`scheduler.weekdays.${day}`) }))} /></label>}
            {values.kind === "monthly" && <label>{t("scheduler.dayOfMonth")}<Input type="number" min={1} max={31} value={values.dayOfMonth} onChange={(event) => updateValues({ dayOfMonth: Number(event.target.value) })} /></label>}
            {values.kind === "yearly" && <><label>{t("scheduler.month")}<Select value={values.month} onChange={(month) => updateValues({ month })} options={Array.from({ length: 12 }, (_, index) => ({ value: index + 1, label: t("scheduler.monthLabel", { month: index + 1 }) }))} /></label><label>{t("scheduler.dayOfMonth")}<Input type="number" min={1} max={31} value={values.dayOfMonth} onChange={(event) => updateValues({ dayOfMonth: Number(event.target.value) })} /></label></>}
            <label>{t("scheduler.time")}<Input type="time" value={values.timeOfDay} onChange={(event) => updateValues({ timeOfDay: event.target.value })} /></label>
          </div>}
          {values.kind === "interval" && <div className="cy-scheduled-form-grid cy-scheduled-interval">
            <label>{t("scheduler.repeatEvery")}<Input type="number" min={1} value={values.every} onChange={(event) => updateValues({ every: Number(event.target.value) })} /></label>
            <label>{t("scheduler.intervalUnit")}<Select value={values.unit} onChange={(unit) => updateValues({ unit })} options={[{ value: "minutes", label: t("scheduler.minutes") }, { value: "hours", label: t("scheduler.hours") }]} /></label>
          </div>}
          {values.kind !== "once" && <><label>{t("scheduler.endCondition")}<Select value={values.endMode} onChange={(endMode: EditorValues["endMode"]) => updateValues({ endMode })} options={[{ value: "never", label: t("scheduler.neverEnds") }, { value: "date", label: t("scheduler.endOnDate") }, { value: "runs", label: t("scheduler.endAfterRuns") }]} /></label>
            {values.endMode === "date" && <label>{t("scheduler.endDate")}<Input type="date" value={values.endDate} onChange={(event) => updateValues({ endDate: event.target.value })} /></label>}
            {values.endMode === "runs" && <label>{t("scheduler.maxRuns")}<Input type="number" min={1} max={10000} value={values.maxRuns} onChange={(event) => updateValues({ maxRuns: Number(event.target.value) })} /></label>}
          </>}
          <div className="cy-scheduled-workspace-picker">
            <div><strong>{t("scheduler.workspace")}</strong><span>{binding?.displayName ?? t("scheduler.workspaceRequired")}</span></div>
            <Button onClick={() => void chooseWorkspace()}>{binding ? t("scheduler.changeWorkspace") : t("scheduler.chooseWorkspace")}</Button>
          </div>
          <div className="cy-scheduled-form-inline"><span>{t("scheduler.startEnabled")}</span><Switch checked={values.enabled} onChange={(enabled) => updateValues({ enabled })} /></div>
          <div className="cy-scheduled-form-inline cy-scheduled-tool-heading"><div><strong>{t("scheduler.toolScope")}</strong><small>{t("scheduler.toolScopeDescription")}</small></div><Checkbox checked={values.limitTools} onChange={(event) => updateValues({ limitTools: event.target.checked })}>{t("scheduler.limitTools")}</Checkbox></div>
          {values.limitTools && <Checkbox.Group className="cy-scheduled-tool-list" value={values.allowedToolIds} onChange={(checked) => updateValues({ allowedToolIds: checked as string[] })}>
            {tools.filter((tool) => tool.enabled).map((tool) => <Checkbox key={tool.id} value={tool.id}>{tool.name}</Checkbox>)}
            {tools.filter((tool) => tool.enabled).length === 0 && <span>{t("scheduler.noTools")}</span>}
          </Checkbox.Group>}
        </div>
      </Modal>

      <Modal open={Boolean(historyTask)} title={historyTask ? t("scheduler.historyFor", { title: historyTask.title }) : t("scheduler.history")} onCancel={() => setHistoryTask(undefined)} footer={null} width={660}>
        {historyLoading ? <div className="cy-scheduled-loading"><LoaderCircle className="cy-scheduled-spin" />{t("scheduler.loading")}</div> : history.length === 0 ? <Empty description={t("scheduler.noHistory")} /> : (
          <div className="cy-scheduled-history-list">
            {history.map((entry) => (
              <div className="cy-scheduled-history-item" key={entry.id}>
                <div className="cy-scheduled-history-top"><strong>{formatDate(entry.firedAt)}</strong><Tag color={entry.status === "success" ? "green" : entry.status === "failed" ? "red" : "default"}>{statusLabel(entry.status)}</Tag></div>
                <p>{entry.outputPreview || entry.errorMessage || entry.reason || t("scheduler.noRunDetail")}</p>
                <div className="cy-scheduled-history-footer">
                  <span>{entry.durationMs ? t("scheduler.durationSeconds", { seconds: (entry.durationMs / 1000).toFixed(1) }) : ""}</span>
                  {entry.sessionId && <Button type="link" icon={<ChevronRight size={15} />} onClick={() => { onOpenSession(entry.sessionId!); setHistoryTask(undefined); }}>{t("scheduler.openSession")}</Button>}
                </div>
              </div>
            ))}
          </div>
        )}
      </Modal>
    </main>
  );
}
