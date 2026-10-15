// 后台 Shell 任务管理器 — run_shell run_in_background:true 的执行底座
//
// 与前台 executePlan 的关键差异（后台任务护栏）：
// - 输出不在内存聚合：stdout/stderr chunk 收到即写日志文件，内存只保留字节计数器，
//   长驻任务不会随时间吃爆主进程内存
// - 磁盘日志上限 64MB/任务（stdout+stderr 合计）：计数达到即杀进程树并判 failed。
//   不做日志轮转：超限即失败是确定性契约（无上限后台日志曾把用户磁盘写出 297GB）
// - 五态状态机：running / exited / timed_out / stopped / failed。
//   终态一旦写入不可变——stop/超时/超限先到者生效，迟到的 close 事件不得覆盖
// - 不做"无输出判卡死"检测：后台 CPU 密集任务几分钟无输出是正常的，
//   只受 total 上限（默认 30 分钟）/ 用户 stop / 应用退出控制
//
// 状态查询协议（shell_job 工具消费）：快照必带输出尾部（最后 8KB）+ 累计字节数，
// 调用方对比两次查询的 totalBytes 增量即可区分"真在跑 / 已就绪 / 卡死"。

import { randomUUID } from "node:crypto";
import { raceWithSignal } from "../../../abort-utils";
import { getConversationDatabase } from "../../../storage/conversation-database-client";
import type { ShellJobRecord, ShellJobStatus } from "../../../storage/shell-job-repository";
import { spawn, type ChildProcess } from "child_process";
import * as fs from "fs";
import * as path from "path";
import { app } from "electron";
import { logger, LogTag } from "../../../logger";

// ── 常量 ─────────────────────────────────────────────
/** 单任务日志上限：stdout+stderr 合计 64MB，超限杀进程树并判 failed */
export const SHELL_JOB_LOG_MAX_BYTES = 64 * 1024 * 1024;
/** 后台任务执行上限（默认值，也是硬上限）：防进程泄漏，应用退出时也会统一终止 */
export const SHELL_JOB_TOTAL_TIMEOUT_MS = 30 * 60_000;
/** status 查询返回的输出尾部窗口：8KB 足够装下汇总行与最新错误 */
export const SHELL_JOB_TAIL_BYTES = 8192;
/** status 阻塞等待上限：防止把一次工具调用变成无限期挂起 */
export const SHELL_JOB_WAIT_MAX_MS = 60_000;
/** 日志保留期：超过 7 天的任务日志在首次创建任务时清理 */
const SHELL_JOB_LOG_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

// ── 类型 ─────────────────────────────────────────────
export type { ShellJobStatus } from "../../../storage/shell-job-repository";

/** spawn 规格：前台 executePlan 与后台任务共用，保证两条路径的进程构造完全一致 */
export interface ShellSpawnSpec {
  /** 可执行文件（沙箱包装后的 argv[0]，或直跑时的 shell 可执行文件） */
  command: string;
  args: string[];
  env: NodeJS.ProcessEnv;
  cwd?: string;
  /** 直接 cmd.exe 路径必须 verbatim（引号语义交给 cmd），沙箱路径不加 */
  windowsVerbatimArguments: boolean;
  ranViaSandbox: boolean;
}

interface ShellJob extends ShellJobRecord {
  /** stdout + stderr 的字节上限；测试可注入较小值。 */
  logMaxBytes: number;
  logStream: fs.WriteStream;
  child?: ChildProcess;
  totalTimer?: NodeJS.Timeout;
  /** 终态达成时唤醒 status 等待者。 */
  terminalWaiters: Set<() => void>;
  logClosed?: Promise<void>;
  persisted?: Promise<void>;
}

export interface ShellJobSnapshot {
  jobId: string;
  /** 主进程 PID（停止/调试用；进程未拿到 pid 时为 null） */
  pid: number | null;
  status: ShellJobStatus;
  exitCode: number | null;
  reason: string | null;
  totalBytes: number;
  logFile: string;
  command: string;
  shell: string;
  startedAt: string;
  durationMs: number;
  /** 日志文件最后 8KB 的文本预览（宽松 UTF-8 解码） */
  tail: string;
}

// ── 进程注册表（main 进程内存 Map）────────────────────
// 只保留运行中或尚未成功持久化的任务；历史元数据由 SQLite 按需读取。
const jobs = new Map<string, ShellJob>();
let ready: Promise<void> | undefined;
let stopping = false;
const starting = new Set<Promise<unknown>>();
function database() { return getConversationDatabase(app.getPath("userData")); }

function initializeJobs(): Promise<void> {
  return ready ??= (async () => {
    await database().call("shellJobs.recover", Date.now());
    await cleanupOldJobLogs(defaultJobsDir());
  })().catch(error => { ready = undefined; throw error; });
}

/** 可靠终止进程树。Windows 上 child.kill("SIGKILL") 只杀直接子进程，杀不掉孙进程。 */
export function killTree(child: ChildProcess | undefined | null): void {
  if (!child || child.pid == null) return;
  if (process.platform === "win32") {
    // /T=含整棵子树  /F=强制  砍掉进程树，避免孙进程成为孤儿
    spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], {
      windowsHide: true,
      shell: false,
      stdio: "ignore",
    });
  } else {
    // Unix：后台任务以 detached 启动（自成进程组组长），负 pid 组杀覆盖整棵子树；
    // 前台进程未 detached 时组杀抛 ESRCH，回落直杀（与迁移前行为一致）
    try { process.kill(-child.pid, "SIGKILL"); } catch {
      try { child.kill("SIGKILL"); } catch { /* 已退出则忽略 */ }
    }
  }
}

function defaultJobsDir(): string {
  return path.join(app.getPath("userData"), "shell-jobs");
}

function formatJobTimestamp(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

async function cleanupOldJobLogs(jobsDir: string): Promise<void> {
  const cutoff = Date.now() - SHELL_JOB_LOG_RETENTION_MS;
  const expired = await database().call<ShellJobRecord[]>("shellJobs.expired", cutoff);
  for (const record of expired) {
    try {
      // Only remove logs in the owned directory, never an arbitrary persisted path.
      if (path.dirname(path.resolve(record.logFile)) !== path.resolve(jobsDir)) continue;
      await fs.promises.rm(record.logFile, { force: true });
      await database().call("shellJobs.delete", record.jobId);
    } catch (error) {
      logger.warn(LogTag.BuiltinTools, `[shell_job] 清理失败 ${record.jobId}: ${String(error)}`);
    }
  }
  try {
    const names = await fs.promises.readdir(jobsDir);
    await Promise.all(names.filter((n) => n.endsWith(".log")).map(async (name) => {
      const file = path.join(jobsDir, name);
      try {
        // Registered logs follow ended_at retention above, not file mtime.
        if (await database().call("shellJobs.get", name.slice(0, -4))) return;
        const st = await fs.promises.stat(file);
        if (st.mtimeMs < cutoff) await fs.promises.unlink(file);
      } catch { /* 单个文件失败不影响其余清理 */ }
    }));
  } catch {
    // 目录不存在/不可读：本次跳过，目录创建后下次自然恢复
  }
}

/** 终态写入：只允许 running → 终态一次，先到先得。stop/超时/超限/close 竞态下保留首个事实。 */
function settleJob(
  job: ShellJob,
  status: Exclude<ShellJobStatus, "running">,
  patch: { exitCode?: number | null; reason?: string | null } = {},
): void {
  if (job.status !== "running") return;
  job.status = status;
  job.exitCode = status === "exited" ? (patch.exitCode ?? null) : null;
  job.reason = patch.reason ?? null;
  job.endedAtMs = Date.now();
  clearTimeout(job.totalTimer);
  job.logClosed = new Promise<void>(resolve => {
    if (job.logStream.closed) resolve();
    else job.logStream.once("close", resolve);
    job.logStream.end();
  });
  void persistTerminal(job);
  for (const wake of job.terminalWaiters) wake();
  job.terminalWaiters.clear();
  logger.info(LogTag.BuiltinTools, `[shell_job] ${job.jobId} → ${status}${job.reason ? ` (${job.reason})` : ""} bytes=${job.totalBytes}`);
}

/** 只重试同一终态的落盘，不重新执行命令；并发调用复用正在进行的写入。 */
function persistTerminal(job: ShellJob): Promise<void> {
  if (job.persisted) return job.persisted;
  const write = job.logClosed!.then(async () => {
    await database().call("shellJobs.finish", recordOf(job));
    jobs.delete(job.jobId);
  });
  job.persisted = write;
  void write.catch(error => {
    job.persisted = undefined;
    logger.warn(LogTag.BuiltinTools, `[shell_job] 状态保存失败 ${job.jobId}: ${String(error)}`);
  });
  return write;
}

/** 输出追加：计数 → 写盘 → 超限检查。终止后到达的残留 chunk 直接丢弃。 */
function appendJobOutput(job: ShellJob, chunk: Buffer): void {
  if (job.status !== "running") return;
  job.totalBytes += chunk.length;
  job.logStream.write(chunk);
  if (job.totalBytes >= job.logMaxBytes) {
    settleJob(job, "failed", { reason: "output_limit_exceeded" });
    killTree(job.child);
  }
}

/** 读取日志尾部（最后 8KB）：宽松 UTF-8 解码，不完整多字节序列显示为替换符 */
function readLogTail(logFile: string): string {
  try {
    const size = fs.statSync(logFile).size;
    if (size === 0) return "";
    const len = Math.min(size, SHELL_JOB_TAIL_BYTES);
    const fd = fs.openSync(logFile, "r");
    try {
      const buf = Buffer.alloc(len);
      fs.readSync(fd, buf, 0, len, size - len);
      return buf.toString("utf8");
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return "";
  }
}

function recordOf(job: ShellJobRecord): ShellJobRecord {
  const { jobId, command, shell, status, exitCode, reason, totalBytes, logFile, startedAtMs, endedAtMs } = job;
  return { jobId, command, shell, status, exitCode, reason, totalBytes, logFile, startedAtMs, endedAtMs };
}

async function savedSnapshot(jobId: string, signal?: AbortSignal): Promise<ShellJobSnapshot | null> {
  signal?.throwIfAborted();
  if (stopping) throw new Error("SHELL_JOBS_STOPPING");
  await raceWithSignal(initializeJobs(), signal);
  signal?.throwIfAborted();
  if (stopping) throw new Error("SHELL_JOBS_STOPPING");
  const record = await raceWithSignal(database().call<ShellJobRecord | null>("shellJobs.get", jobId), signal);
  if (!record) return null;
  if (record.reason === "app_restarted_execution_unknown") {
    try { record.totalBytes = fs.statSync(record.logFile).size; } catch { /* 日志可能已丢失 */ }
  }
  return snapshotJob(record);
}

function snapshotJob(job: ShellJobRecord, pid: number | null = null): ShellJobSnapshot {
  return {
    jobId: job.jobId,
    pid,
    status: job.status,
    exitCode: job.exitCode,
    reason: job.reason,
    totalBytes: job.totalBytes,
    logFile: job.logFile,
    command: job.command,
    shell: job.shell,
    startedAt: new Date(job.startedAtMs).toISOString(),
    durationMs: (job.endedAtMs ?? Date.now()) - job.startedAtMs,
    // tail 是唯一大字段，必须排在最后：下游头尾截断时尾窗优先覆盖最新输出
    tail: readLogTail(job.logFile),
  };
}

/**
 * 启动一个后台任务：spawn 后立即返回，输出流式写日志文件。
 * 任务生命周期由内部状态机管理，与本轮 agent 调用解耦（取消本轮不杀后台任务）。
 */
interface StartShellJobOptions {
  spec: ShellSpawnSpec;
  /** 原始命令行（快照展示用） */
  command: string;
  shell: string;
  signal?: AbortSignal;
  /** 执行上限毫秒数；缺省 30 分钟，钳制到 [1s, 30min] */
  totalMs?: number;
  /** 日志目录（测试注入用）；缺省 userData/shell-jobs */
  logDir?: string;
  /** 单任务日志上限（测试注入用）；缺省 64MB 生产常量 */
  logMaxBytes?: number;
}

export function startShellJob(opts: StartShellJobOptions): Promise<{ jobId: string; logFile: string }> {
  const operation = startJob(opts);
  starting.add(operation);
  void operation.finally(() => starting.delete(operation)).catch(() => {});
  return operation;
}

async function startJob(opts: StartShellJobOptions): Promise<{ jobId: string; logFile: string }> {
  if (stopping) throw new Error("SHELL_JOBS_STOPPING");
  opts.signal?.throwIfAborted();
  await initializeJobs();
  if (stopping) throw new Error("SHELL_JOBS_STOPPING");
  opts.signal?.throwIfAborted();
  const jobsDir = opts.logDir ?? defaultJobsDir();
  fs.mkdirSync(jobsDir, { recursive: true });

  const jobId = `job-${formatJobTimestamp()}-${randomUUID()}`;
  const logMaxBytes = opts.logMaxBytes ?? SHELL_JOB_LOG_MAX_BYTES;
  const logFile = path.join(jobsDir, `${jobId}.log`);
  const record: ShellJobRecord = {
    jobId, command: opts.command, shell: opts.shell, status: "running",
    exitCode: null, reason: null, totalBytes: 0, logFile,
    startedAtMs: Date.now(), endedAtMs: null,
  };
  await database().call("shellJobs.create", record);
  if (stopping || opts.signal?.aborted) {
    await database().call("shellJobs.finish", { ...record, status: "stopped",
      reason: stopping ? "app_exiting" : "cancelled_before_start", endedAtMs: Date.now() });
    opts.signal?.throwIfAborted();
    throw new Error("SHELL_JOBS_STOPPING");
  }
  try { fs.closeSync(fs.openSync(logFile, "wx")); }
  catch (error) {
    await database().call("shellJobs.finish", { ...record, status: "failed", reason: "log_create_failed", endedAtMs: Date.now() });
    throw error;
  }
  const logStream = fs.createWriteStream(logFile, { flags: "a" });
  logStream.on("error", err => {
    logger.warn(LogTag.BuiltinTools, `[shell_job] 日志写入失败 ${jobId}: ${err.message}`);
  });
  const job: ShellJob = { ...record, logMaxBytes, logStream, terminalWaiters: new Set() };
  jobs.set(jobId, job);

  let child: ChildProcess;
  try {
    child = spawn(opts.spec.command, opts.spec.args, {
      cwd: opts.spec.cwd || undefined,
      shell: false,
      windowsHide: true,
      // Unix 下 detached 让任务自成进程组组长，killTree 可用负 pid 组杀整棵子树；
      // Windows 用 taskkill /T 杀树，不需要 detached
      ...(process.platform !== "win32" ? { detached: true } : {}),
      env: opts.spec.env,
      ...(opts.spec.windowsVerbatimArguments ? { windowsVerbatimArguments: true } : {}),
      // stdin→NUL：误启动交互式进程时让它读到 EOF 立即退出，不悬挂
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (error) {
    settleJob(job, "failed", { reason: `spawn_error: ${String(error)}` });
    await job.persisted;
    throw error;
  }
  job.child = child;

  const totalMs = Math.min(Math.max(opts.totalMs ?? SHELL_JOB_TOTAL_TIMEOUT_MS, 1_000), SHELL_JOB_TOTAL_TIMEOUT_MS);
  job.totalTimer = setTimeout(() => {
    settleJob(job, "timed_out", { reason: "total_timeout_exceeded" });
    killTree(child);
  }, totalMs);

  child.stdout?.on("data", (chunk: Buffer) => appendJobOutput(job, chunk));
  child.stderr?.on("data", (chunk: Buffer) => appendJobOutput(job, chunk));
  child.on("error", (err) => {
    settleJob(job, "failed", { reason: `spawn_error: ${err.message}` });
  });
  child.on("close", (code) => {
    // 被 stop/超时/超限终止的进程 close 会迟到：settleJob 内部守卫保证终态不被覆盖
    settleJob(job, "exited", { exitCode: code });
  });

  logger.info(LogTag.BuiltinTools, `[shell_job] started ${jobId}: ${opts.command}`);
  return { jobId, logFile };
}

/** wait_ms 钳制：缺省/非数字/负数归 0（立即返回），上限 60s，四舍五入 */
export function clampWaitMs(raw: unknown): number {
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) return 0;
  return Math.min(Math.round(value), SHELL_JOB_WAIT_MAX_MS);
}

/**
 * 查询任务快照；waitMs > 0 时最多阻塞这么久（任务先到终态则提前返回）。
 * signal 中止时，内存任务立即返回当前快照；历史查询抛出取消错误。任务不存在返回 null。
 */
export async function waitForShellJob(jobId: string, waitMs: number, signal?: AbortSignal): Promise<ShellJobSnapshot | null> {
  const job = jobs.get(jobId);
  if (!job) return savedSnapshot(jobId, signal);
  if (job.status !== "running" || waitMs <= 0) {
    if (job.status !== "running") void persistTerminal(job);
    return snapshotJob(job, job.child?.pid ?? null);
  }
  await new Promise<void>((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      job.terminalWaiters.delete(onTerminal);
      resolve();
    };
    const onTerminal = () => finish();
    const onAbort = () => finish();
    const timer = setTimeout(finish, waitMs);
    job.terminalWaiters.add(onTerminal);
    if (signal) {
      if (signal.aborted) finish();
      else signal.addEventListener("abort", onAbort, { once: true });
    }
  });
  // status 返回当前事实，不是持久化回执；慢写入不能延长 wait_ms 或阻止取消。
  if (job.status !== "running") void persistTerminal(job);
  return snapshotJob(job, job.child?.pid ?? null);
}

/** 停止任务（幂等：已到终态的任务直接返回终态快照）。任务不存在返回 null。 */
export async function stopShellJob(jobId: string): Promise<ShellJobSnapshot | null> {
  const job = jobs.get(jobId);
  if (!job) return savedSnapshot(jobId);
  if (job.status === "running") {
    settleJob(job, "stopped");
    killTree(job.child);
  }
  await persistTerminal(job);
  return snapshotJob(job, job.child?.pid ?? null);
}

/** 应用退出收尾：终止所有仍在运行的后台任务 */
export async function disposeAllShellJobs(): Promise<void> {
  stopping = true;
  // 先发出停止动作，不能让另一任务的登记阻挡已有进程终止。
  for (const job of jobs.values()) {
    if (job.status === "running") {
      settleJob(job, "stopped", { reason: "app_exiting" });
      killTree(job.child);
    }
  }
  const writes = [...jobs.values()].map(persistTerminal);
  // 历史查询取消只结束调用方等待；其共享初始化/日志清理必须在数据库关闭前收尾。
  await Promise.allSettled([ready, ...starting]);
  const results = await Promise.allSettled(writes);
  const errors = results.filter((result): result is PromiseRejectedResult => result.status === "rejected");
  if (errors.length) throw new AggregateError(errors.map(result => result.reason), "SHELL_JOB_PERSISTENCE_FAILED");
}
