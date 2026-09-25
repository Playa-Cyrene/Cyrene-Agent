// ── 工具 2：run_shell ─────────────────────────────────────
// 在用户机器上跑一行命令，给 agent 装 MCP 时跑 git/npm/pip 等用
// 注意：不开 shell（spawn shell:false），命令必须是真正的可执行文件，避免 shell 注入
//
// 原样迁自 built-in-tools.ts（纯搬移，逻辑未改——killTree/双计时器/kill 宽限期/
// windowsVerbatimArguments/GBK 解码等平台细节一律保持原状）。注册方式调整：
// 本模块导出 runShellTool 常量，由 built-in-tools.ts facade 在原注册位置统一
// toolRegistry.register，显式保证 registry 插入顺序（= 工具目录 prompt 生成顺序，
// 门禁见 built-in-tools.snapshot.test.ts）。

import { spawn } from "child_process";
import type { ToolDefinition } from "../registry/tool-registry";
import type { ShellOutputUpdate } from "../registry/tool-context";
import { SHELL_VISIBLE_OUTPUT_LIMIT } from "../../../../shared/shell-output";
import { wrapWithSandbox, type SandboxWrapOutcome } from "../../sandbox/sandbox-exec";
import { getCurrentLevel } from "../../../permission";
import { classifyShellEffect, isCatastrophicCommand, type ShellEffect } from "../../shell-execution-policy";
import { logger, LogTag } from "../../../logger";
import {
  buildDirectShellInvocation,
  resolveShellExecutable,
  type ResolvedShellExecutable,
  type ShellKind,
} from "../../shell-runtime";
import { killTree, startShellJob, type ShellSpawnSpec } from "./shell-job-manager";

const LOG_PREFIX = "[BuiltinTools]";

// ── 工具 2：run_shell ─────────────────────────────────────
// 在用户机器上跑一行命令，给 agent 装 MCP 时跑 git/npm/pip 等用
// 注意：不开 shell（spawn shell:false），命令必须是真正的可执行文件，避免 shell 注入

// 双计时器：不看命令跑了多久，看它多久没动静。
// - idle：连续 2 分钟无任何 stdout/stderr → 判定卡死（serve/watch 类静默进程、网络死锁）。
//   npm install / git push / 打包这类"长但在动"的命令会持续输出，不会误杀。
// - total：30 分钟总上限，无论如何强制结束（兜底）。
// 调用方显式传 timeout_ms 时：total = timeout_ms（钳制 1s–30min），idle 检测直接禁用——
// "无输出=卡死"只是启发式，调用方给出明确执行上限后让位（rm -rf 大目录/链接器这类
// 无输出长任务不再被误杀）。
const SHELL_IDLE_TIMEOUT_MS = 2 * 60_000;
const SHELL_TOTAL_TIMEOUT_MS = 30 * 60_000;
// timeout_ms 钳制区间：下限 1s 防 0/负数瞬间自杀，上限与默认 total（30min）对齐
const SHELL_TIMEOUT_MS_MIN = 1_000;
const SHELL_TIMEOUT_MS_MAX = SHELL_TOTAL_TIMEOUT_MS;
// killTree 后等 close 的宽限期。taskkill /T 在进程链断开时会漏杀孙进程，
// 孙进程持有的 stdio 管道不关 → close 永不触发 → Promise 永不 resolve（655 分钟挂死的根因）。
// 宽限期一到无条件强制收尸，带上已收集的部分输出。
const SHELL_KILL_GRACE_MS = 2_000;
// 捕获上限按流独立计量（stdout ≤2MB、stderr ≤2MB）：不用合并预算，否则 stdout 洪流
// 会吃光预算、stderr 末尾的真正报错反而丢失。正常工程输出（npm test/build）远小于此，
// 不会过早截断；超限的 chunk 丢弃并标记 captureTruncated=true（数据真实丢失，
// 与 dispatcher 侧"数据完整、仅视图裁剪"的 truncatedForModel 是两个不同事实）。
const SHELL_CAPTURE_LIMIT_PER_STREAM = 2 * 1024 * 1024;
const SHELL_OUTPUT_FLUSH_MS = 100;

// ── Shell 输出解码 ─────────────────────────────────────
// 中文 Windows 的 cmd.exe 按系统 OEM 码页（GBK/CP936）输出（dir/echo/del 等内建命令），
// 直接 chunk.toString("utf8") 中文全是 U+FFFD 乱码。策略：Buffer 原样累积，
// 进程结束时先严格 UTF-8 解码（node/npm/git 等现代工具输出 UTF-8），
// 含非法序列时回落 GBK 解码（Electron 自带 full-icu，TextDecoder("gbk") 可用）。
const utf8StrictDecoder = new TextDecoder("utf-8", { fatal: true });
let gbkDecoder: typeof utf8StrictDecoder | null = null;
try {
  gbkDecoder = new TextDecoder("gbk");
} catch {
  // 非 full-ICU 环境无 GBK：最终兜底宽松 UTF-8（替换字符）
}

function decodeShellOutput(chunks: Buffer[]): string {
  if (chunks.length === 0) return "";
  const buf = Buffer.concat(chunks).subarray(0, SHELL_CAPTURE_LIMIT_PER_STREAM);
  try {
    return utf8StrictDecoder.decode(buf);
  } catch {
    if (gbkDecoder) {
      try {
        return gbkDecoder.decode(buf);
      } catch {
        // GBK 也解不动（如二进制输出）：落到宽松 UTF-8
      }
    }
    return buf.toString("utf8");
  }
}

type CapturedShellChunk = { stream: "stdout" | "stderr"; bytes: Buffer };

/** 最终预览按每条流分别判定编码，再按数据抵达顺序重建。 */
function decodeOrderedShellOutput(
  ordered: CapturedShellChunk[],
  stdoutChunks: Buffer[],
  stderrChunks: Buffer[],
): string {
  const encoding = (chunks: Buffer[]): string => {
    try {
      utf8StrictDecoder.decode(Buffer.concat(chunks));
      return "utf-8";
    } catch {
      return gbkDecoder ? "gbk" : "utf-8";
    }
  };
  const decoders = {
    stdout: new TextDecoder(encoding(stdoutChunks)),
    stderr: new TextDecoder(encoding(stderrChunks)),
  };
  let result = "";
  for (const entry of ordered) {
    result += decoders[entry.stream].decode(entry.bytes, { stream: true });
  }
  return result + decoders.stdout.decode() + decoders.stderr.decode();
}

function visibleOutputTail(value: string): string {
  if (value.length <= SHELL_VISIBLE_OUTPUT_LIMIT) return value;
  const tail = value.slice(-SHELL_VISIBLE_OUTPUT_LIMIT);
  // 不从 UTF-16 代理对的后半字符开始截取。
  return /^[\uDC00-\uDFFF]/u.test(tail) ? tail.slice(1) : tail;
}

// ── 超时策略 ─────────────────────────────────────────────
// timeout_ms 语义 = execution deadline（执行生命周期上限，超时杀进程），
// 不是 Codex yield_time_ms 那种"超时停靠转后台继续跑"。"等不到转后台"由二期的
// run_in_background/shell_job 承担，两者互补而非同一语义。
export interface ShellTimeoutPolicy {
  /** 无输出卡死检测时长；undefined = 禁用检测（调用方显式给了 deadline 时） */
  idleMs: number | undefined;
  /** 执行生命周期总上限（超时杀进程树） */
  totalMs: number;
  /** 是否调用方显式指定（影响超时原因与引导文案） */
  explicitDeadline: boolean;
}

/** 默认策略：idle 2 分钟 + total 30 分钟（未传 timeout_ms 时） */
const DEFAULT_TIMEOUT_POLICY: ShellTimeoutPolicy = {
  idleMs: SHELL_IDLE_TIMEOUT_MS,
  totalMs: SHELL_TOTAL_TIMEOUT_MS,
  explicitDeadline: false,
};

/**
 * 把调用方传入的 timeout_ms 解析为超时策略。
 * - 未传/null/空串/非数字 → 默认策略（idle 2min + total 30min）
 * - 数字（含字符串数字、0、负数、超大值）→ 钳制到 [1s, 30min] 作显式 deadline，
 *   并禁用 idle 检测（"无输出=卡死"启发式在明确 deadline 面前让位）
 */
export function resolveTimeoutPolicy(raw: unknown): ShellTimeoutPolicy {
  if (raw === undefined || raw === null || raw === "" || typeof raw === "boolean") {
    return DEFAULT_TIMEOUT_POLICY;
  }
  const value = Number(raw);
  if (!Number.isFinite(value)) return DEFAULT_TIMEOUT_POLICY;
  return {
    idleMs: undefined,
    totalMs: Math.min(Math.max(Math.round(value), SHELL_TIMEOUT_MS_MIN), SHELL_TIMEOUT_MS_MAX),
    explicitDeadline: true,
  };
}

/** 超时时长文案：不足 1 分钟按秒展示，否则按分钟展示 */
function formatTimeoutMs(ms: number): string {
  return ms >= 60_000 ? `${Math.round(ms / 60_000)} 分钟` : `${Math.round(ms / 1000)} 秒`;
}

interface ShellResult {
  shell: ShellKind;
  shellExecutable?: string;
  errorCode?: "BASH_UNAVAILABLE";
  exitCode: number | null;
  stdout: string;
  stderr: string;
  /** 捕获层截断：true = 该流超 2MB 后数据被丢弃，落盘内容也缺失（区别于 dispatcher 侧仅裁剪视图的 truncatedForModel） */
  captureTruncated: boolean;
  /** 遥测字段：是否经沙箱执行。仅用于日志/结果展示，不参与安全判定（判定在 spawn 前的 ExecutionPlan 完成） */
  ranViaSandbox: boolean;
  /** 因 idle/total 超时或外部取消而被强制终止 */
  timedOut: boolean;
}

// ── 执行计划：安全决策与副作用执行分离 ─────────────────────
// 不变量：非 full 档位下，任何命令在 ExecutionPlan 确定为可执行（sandboxed/direct）
// 之前不会触碰 spawn；wrap 失败一律 fail-closed，绝不"先跑完再事后拒绝"
// （旧实现曾在 wrap 抛错时静默直跑、执行完毕后才贴拒绝标签，构成 fail-open 漏洞）。
// rejected 计划在类型层面就进不了 executePlan（见 ExecutablePlan）。
type ExecutionPlan =
  | { kind: "sandboxed"; command: string; cwd?: string; requestedShell: ShellKind; argv: string[]; env: NodeJS.ProcessEnv }
  | { kind: "direct"; command: string; cwd?: string; requestedShell: ShellKind }
  | { kind: "rejected"; command: string; cwd?: string; requestedShell: ShellKind; reason: string };

/** 可执行计划：spawn 只接受这两种，rejected 在类型层面被挡在 executor 之外。 */
type ExecutablePlan = Exclude<ExecutionPlan, { kind: "rejected" }>;

/**
 * spawn 前完成全部安全决策（唯一调用沙箱 wrap 的地方）。
 *
 * 分流规则（按失败原因区分）：
 * - wrap 成功 → sandboxed
 * - wrap 失败 + reason "disabled"（用户显式无沙箱：CYRENE_SRT=0 / 非 Windows）+ read 类命令
 *   → direct（graceful degradation，保留开发环境可用性）
 * - wrap 失败（not_ready / wrap_failed），或 disabled + 写副作用命令，或 wrap 意外抛错
 *   → rejected（fail-closed，无论 read/write 都不执行）
 */
async function resolveExecutionPlan(
  command: string,
  cwd: string | undefined,
  requestedShell: ShellKind,
  resolvedShell: ResolvedShellExecutable,
  requiresSandbox: boolean,
): Promise<ExecutionPlan> {
  const base = { command, cwd, requestedShell };
  let outcome: SandboxWrapOutcome;
  try {
    outcome = await wrapWithSandbox(
      command,
      cwd,
      requestedShell === "bash" ? resolvedShell.executable : undefined,
    );
  } catch (err) {
    // 契约上 wrapWithSandbox 永不抛错；此处兜底防止 API 破约重新打开 fail-open 缺口
    const detail = err instanceof Error ? err.message : String(err);
    logger.warn(LogTag.BuiltinTools, `[run_shell] wrapWithSandbox threw unexpectedly, fail-closed: ${detail}`);
    return { ...base, kind: "rejected", reason: "沙箱包装异常，该命令已终止（未执行）" };
  }

  if (outcome.ok) {
    return { ...base, kind: "sandboxed", argv: outcome.argv, env: outcome.env };
  }

  // 用户显式无沙箱 + 只读命令 → 允许降级直跑
  if (outcome.reason === "disabled" && !requiresSandbox) {
    logger.warn(LogTag.BuiltinTools, `[run_shell] sandbox disabled, read-effect fallback to direct ${requestedShell}`);
    return { ...base, kind: "direct" };
  }

  const REJECT_REASON: Record<"disabled" | "not_ready" | "wrap_failed", string> = {
    disabled: "沙箱未启用，该命令可能修改工作区，已终止",
    not_ready: "沙箱不可用（初始化失败），该命令已终止。请在设置中安装沙箱或提升权限档位。",
    wrap_failed: "沙箱包装失败，该命令已终止（未执行）",
  };
  logger.warn(LogTag.BuiltinTools, `[run_shell] fail-closed before spawn: reason=${outcome.reason} detail=${outcome.detail ?? "(none)"} effect=${requiresSandbox ? "write/unknown" : "read"} command="${command.slice(0, 200)}"`);
  return { ...base, kind: "rejected", reason: REJECT_REASON[outcome.reason] };
}

/**
 * 从执行计划构造 spawn 规格：沙箱计划用 SRT 给的 argv/env，直跑计划包装 shell 调用。
 * 前台 executePlan 与后台 startShellJob 共用，保证两条路径的进程构造完全一致。
 */
function buildSpawnSpec(plan: ExecutablePlan, resolvedShell: ResolvedShellExecutable): ShellSpawnSpec {
  if (plan.kind === "sandboxed") {
    return {
      command: plan.argv[0],
      args: plan.argv.slice(1),
      // 沙箱 env 是 SRT 给的（含必要的 PATH/token 等）
      env: { ...plan.env },
      cwd: plan.cwd,
      windowsVerbatimArguments: false,
      ranViaSandbox: true,
    };
  }
  const directInvocation = buildDirectShellInvocation(resolvedShell, plan.command);
  return {
    command: directInvocation.command,
    args: directInvocation.args,
    env: { ...process.env },
    cwd: plan.cwd,
    // 直接 cmd.exe 路径必须 verbatim（引号语义交给 cmd），沙箱路径不加（见下方详细注释）
    windowsVerbatimArguments: directInvocation.windowsVerbatimArguments,
    ranViaSandbox: false,
  };
}

/**
 * 执行一个已通过安全决策的计划。
 *
 * spawn 只存在于本函数；`ranViaSandbox` 仅作遥测（日志/结果字段展示），
 * 不再承担任何安全判定职责（判定已在 resolveExecutionPlan 的 spawn 之前完成）。
 */
function executePlan(
  plan: ExecutablePlan,
  resolvedShell: ResolvedShellExecutable,
  signal?: AbortSignal,
  timeoutPolicy: ShellTimeoutPolicy = DEFAULT_TIMEOUT_POLICY,
  onOutput?: (update: ShellOutputUpdate) => void,
): Promise<ShellResult> {
  return new Promise((resolve) => {
    (async () => {
      const requestedShell = plan.requestedShell;
      const command = plan.command;
      const cwd = plan.cwd;
      const spec = buildSpawnSpec(plan, resolvedShell);
      const ranViaSandbox = spec.ranViaSandbox;

      const child = spawn(spec.command, spec.args, {
        cwd: spec.cwd || undefined,
        shell: false,
        windowsHide: true,
        env: spec.env,
        // 直接 cmd.exe 路径必须 verbatim：Node 默认对 argv 做 MSVCRT 转义（" → \"），
        // 而 cmd.exe 的 /s 规则只剥首尾引号、不认 \" 转义，字面引号会传给目标程序——
        // 带引号路径如 node "E:\video test\_check.js" 会变成非法模块名。
        // windowsVerbatimArguments 让 argv 原样空格拼接，引号语义完全交给 cmd。
        // 沙箱路径不加：srt-win 是 Rust 程序（MSVCRT 解析 argv），与 Node 自动转义配对正确。
        ...(spec.windowsVerbatimArguments ? { windowsVerbatimArguments: true } : {}),
        // stdin→/dev/null(NUL)：误启动交互式进程(python/node REPL)时让它读到 EOF 立即退出，
        // 不再卡在"等 stdin 输入"上耗满超时。stdout/stderr 仍 pipe 来收集输出。
        stdio: ["ignore", "pipe", "pipe"],
      });
      // Buffer 原样累积（每流 2MB 上限），进程结束时按 UTF-8→GBK 顺序解码（见 decodeShellOutput）
      const stdoutChunks: Buffer[] = [];
      const stderrChunks: Buffer[] = [];
      const orderedChunks: CapturedShellChunk[] = [];
      let stdoutBytes = 0;
      let stderrBytes = 0;
      let captureTruncated = false;
      const liveDecoders = {
        stdout: new TextDecoder("utf-8"),
        stderr: new TextDecoder("utf-8"),
      };
      let pendingOutput = "";
      let liveOutputTruncated = false;
      let outputTimer: NodeJS.Timeout | undefined;
      const publishOutput = (update: ShellOutputUpdate) => {
        try { onOutput?.(update); } catch { /* 界面观察者不得中断进程 */ }
      };
      const flushOutput = () => {
        outputTimer = undefined;
        if (!pendingOutput) return;
        publishOutput({
          action: "append",
          text: pendingOutput,
          ...(liveOutputTruncated ? { truncated: true } : {}),
        });
        pendingOutput = "";
        liveOutputTruncated = false;
      };
      const queueOutput = (stream: "stdout" | "stderr", bytes: Buffer) => {
        if (!onOutput || bytes.length === 0) return;
        pendingOutput += liveDecoders[stream].decode(bytes, { stream: true });
        if (pendingOutput.length > SHELL_VISIBLE_OUTPUT_LIMIT) {
          pendingOutput = visibleOutputTail(pendingOutput);
          liveOutputTruncated = true;
        }
        if (!outputTimer) outputTimer = setTimeout(flushOutput, SHELL_OUTPUT_FLUSH_MS);
      };

      // ── 双计时器 + 强制收尸 ──────────────────────────────
      // settled 保证只 resolve 一次；close/error/强制收尸任何一方先到都安全。
      let settled = false;
      let idleTimer: NodeJS.Timeout | undefined;
      let totalTimer: NodeJS.Timeout | undefined;
      let killGraceTimer: NodeJS.Timeout | undefined;
      const clearTimers = () => {
        clearTimeout(idleTimer);
        clearTimeout(totalTimer);
        clearTimeout(killGraceTimer);
      };
      const finish = (result: ShellResult) => {
        if (settled) return;
        settled = true;
        clearTimers();
        clearTimeout(outputTimer);
        if (onOutput) {
          const corrected = decodeOrderedShellOutput(orderedChunks, stdoutChunks, stderrChunks);
          publishOutput({
            action: "replace",
            text: visibleOutputTail(corrected),
            ...(captureTruncated || corrected.length > SHELL_VISIBLE_OUTPUT_LIMIT ? { truncated: true } : {}),
          });
        }
        if (signal) signal.removeEventListener("abort", onAbort);
        resolve(result);
      };
      type StuckReason = "idle" | "total" | "cancelled";
      const reasonText: Record<StuckReason, string> = {
        idle: `命令连续 ${formatTimeoutMs(timeoutPolicy.idleMs ?? SHELL_IDLE_TIMEOUT_MS)} 无任何输出（疑似常驻进程或卡死）`,
        total: timeoutPolicy.explicitDeadline
          ? `命令超过 timeout_ms=${timeoutPolicy.totalMs} 毫秒执行上限`
          : `命令超过 ${formatTimeoutMs(timeoutPolicy.totalMs)} 总上限`,
        cancelled: "所在任务已被用户取消",
      };
      // 超时引导：帮模型自纠（idle 误杀 → 传 timeout_ms 豁免无输出检测；时长不够 →
      // 调大 timeout_ms 或转 run_in_background 后台执行并用 shell_job 管理）。
      const hintByReason: Record<StuckReason, string> = {
        idle: "若这是正常的长时无输出任务（删除大目录/编译链接等），可传 timeout_ms 显式指定执行上限，设置后不再做无输出检测；若是需要长时间运行的进程，可改用 run_in_background:true 后台执行。",
        total: timeoutPolicy.explicitDeadline
          ? "如需更长时间，可增大 timeout_ms（1000–1800000 毫秒）后重试，或改用 run_in_background:true 后台执行。"
          : "如命令需要更长时间，可传 timeout_ms 参数（1000–1800000 毫秒）显式指定执行上限，或改用 run_in_background:true 后台执行。",
        cancelled: "",
      };
      // 已发起强制终止的原因。kill 后 close 常在宽限计时器之前到达（taskkill /F 收尸很快），
      // 此时也必须如实上报 timedOut=true + 终止原因，而不是伪装成正常退出（exitCode=1、原因文案丢失）
      let stuckReason: StuckReason | null = null;
      // 统一结果构造：被强制终止时 exitCode 置 null、stderr 追加终止原因与引导
      const buildResult = (exitCode: number | null, spawnError?: string): ShellResult => ({
        shell: requestedShell,
        shellExecutable: resolvedShell.executable,
        exitCode: stuckReason !== null ? null : exitCode,
        stderr: decodeShellOutput(stderrChunks)
          + (stuckReason !== null
            ? `\n[已终止] ${reasonText[stuckReason]}，进程树已被强制终止。${hintByReason[stuckReason]}`
            : "")
          + (spawnError ? "\n[spawn error] " + spawnError + (ranViaSandbox ? " [sandbox]" : "") : ""),
        stdout: decodeShellOutput(stdoutChunks),
        captureTruncated,
        ranViaSandbox,
        timedOut: stuckReason !== null,
      });
      const onStuck = (reason: StuckReason) => {
        if (stuckReason !== null) return; // 已在终止流程中，忽略后续触发（idle 与 abort 竞态）
        stuckReason = reason;
        console.warn(LOG_PREFIX, `run_shell 终止(${reason})，kill 进程树:`, command);
        killTree(child);
        // 宽限期后强制收尸：close 事件要求 stdio 管道全关，taskkill 漏杀孙进程时
        // 管道保持打开、close 永不触发。宽限期内 close 正常到达则由 close 路径带终止原因结算。
        killGraceTimer = setTimeout(() => {
          finish(buildResult(null));
        }, SHELL_KILL_GRACE_MS);
      };
      const resetIdle = () => {
        clearTimeout(idleTimer);
        // 显式 deadline 禁用 idle 检测：idleMs 为 undefined 时不再布防
        if (timeoutPolicy.idleMs === undefined) return;
        idleTimer = setTimeout(() => onStuck("idle"), timeoutPolicy.idleMs);
      };
      const onAbort = () => onStuck("cancelled");

      totalTimer = setTimeout(() => onStuck("total"), timeoutPolicy.totalMs);
      resetIdle();
      if (signal) {
        if (signal.aborted) onStuck("cancelled");
        else signal.addEventListener("abort", onAbort, { once: true });
      }

      child.stdout?.on("data", (chunk: Buffer) => {
        if (settled) return;
        resetIdle();
        const remaining = SHELL_CAPTURE_LIMIT_PER_STREAM - stdoutBytes;
        if (remaining <= 0) {
          captureTruncated = true;
          return;
        }
        const accepted = chunk.subarray(0, remaining);
        stdoutChunks.push(accepted);
        orderedChunks.push({ stream: "stdout", bytes: accepted });
        stdoutBytes += accepted.length;
        if (accepted.length < chunk.length) captureTruncated = true;
        queueOutput("stdout", accepted);
      });
      child.stderr?.on("data", (chunk: Buffer) => {
        if (settled) return;
        resetIdle();
        const remaining = SHELL_CAPTURE_LIMIT_PER_STREAM - stderrBytes;
        if (remaining <= 0) {
          captureTruncated = true;
          return;
        }
        const accepted = chunk.subarray(0, remaining);
        stderrChunks.push(accepted);
        orderedChunks.push({ stream: "stderr", bytes: accepted });
        stderrBytes += accepted.length;
        if (accepted.length < chunk.length) captureTruncated = true;
        queueOutput("stderr", accepted);
      });
      child.on("error", (err) => {
        finish(buildResult(-1, err.message));
      });
      child.on("close", (code) => {
        // kill 发起后 close 先到：buildResult 内部按 stuckReason 合并终止原因，不再伪装正常退出
        finish(buildResult(code));
      });
    })().catch((err) => {
      // async wrapper 异常兜底（理论上不会走到，wrapWithSandbox 内部已 try/catch，
      // 且安全决策在 resolveExecutionPlan 已完成，此处只影响单次执行的错误上报）
      const msg = err instanceof Error ? err.message : String(err);
      resolve({
        shell: plan.requestedShell,
        exitCode: -1,
        stderr: "[executePlan internal error] " + msg,
        stdout: "",
        captureTruncated: false,
        ranViaSandbox: false,
        timedOut: false,
      });
    });
  });
}

async function executeRunShell(args: Record<string, unknown>, context?: import("../registry/tool-context").ToolContext): Promise<string> {
  const command = String(args.command || "").trim();
  const cwd = args.cwd ? String(args.cwd) : undefined;
  // timeout_ms 显式 deadline：钳制 + 禁用 idle 检测（解析规则见 resolveTimeoutPolicy）
  const timeoutPolicy = resolveTimeoutPolicy(args.timeout_ms);
  if (timeoutPolicy.explicitDeadline) {
    logger.info(LogTag.BuiltinTools, `[run_shell] explicit deadline: raw=${String(args.timeout_ms)} → total=${timeoutPolicy.totalMs}ms, idle detection disabled`);
  }
  const requestedShell = args.shell === undefined || args.shell === "cmd"
    ? "cmd"
    : args.shell === "bash"
      ? "bash"
      : null;
  if (!command) return "[错误] command 不能为空";
  if (!requestedShell) {
    return JSON.stringify({
      command, cwd, shell: String(args.shell), errorCode: "SHELL_UNSUPPORTED",
      exitCode: -1, timedOut: false, captureTruncated: false, effect: "unknown", sandboxed: false,
      stderr: "[SHELL_UNSUPPORTED] shell 仅支持 cmd 或 bash", stdout: "",
    });
  }

  // 灾难命令守卫：无论档位都拒绝（format/shutdown/dd 等明显灾难操作）
  if (isCatastrophicCommand(command)) {
    logger.info(LogTag.BuiltinTools, `[run_shell] rejected: catastrophic command="${command}"`);
    return JSON.stringify({
      command, cwd, shell: requestedShell,
      exitCode: -1, timedOut: false, captureTruncated: false, effect: "unknown", sandboxed: false,
      stderr: "[拒绝] 该命令被系统禁止执行", stdout: "",
    });
  }

  const level = context?.permissionMode === "allow_all" ? "full" : getCurrentLevel();
  const effect: ShellEffect = classifyShellEffect(command);
  logger.info(LogTag.BuiltinTools, `[run_shell] entry: command="${command}" cwd=${cwd || "(undefined)"} effect=${effect} level=${level}`);

  // 解释器前置解析：直跑和沙箱包装都需要（bash 不可用在此提前返回，不进入执行计划）
  const resolvedShell = await resolveShellExecutable(requestedShell);
  if (!resolvedShell) {
    return JSON.stringify({
      command, cwd, shell: requestedShell, errorCode: "BASH_UNAVAILABLE",
      exitCode: -1, timedOut: false, captureTruncated: false, effect, sandboxed: false,
      stderr: "[BASH_UNAVAILABLE] 未找到可用的 Bash。请安装 Git Bash，并确保 bash.exe 可执行。", stdout: "",
    });
  }

  const requiresSandbox = effect !== "read";

  // 后台执行：spawn 后立即返回 jobId，输出流式写日志文件（状态机与护栏见 shell-job-manager）。
  // 后台任务不做"无输出判卡死"检测，执行上限沿用 timeout_ms（未传则 30 分钟）；
  // 与本轮 agent 调用解耦——取消本轮不杀后台任务，由用户 stop / 执行上限 / 应用退出控制。
  if (args.run_in_background === true || args.run_in_background === "true") {
    const plan: ExecutionPlan = level === "full"
      ? { kind: "direct", command, cwd, requestedShell }
      : await resolveExecutionPlan(command, cwd, requestedShell, resolvedShell, requiresSandbox);
    if (plan.kind === "rejected") {
      // 与前台一致的拒绝协议：spawn 从未被调用，stdout 必然为空
      return JSON.stringify({
        command, cwd, shell: requestedShell,
        exitCode: -1, timedOut: false, captureTruncated: false, effect, sandboxed: false,
        stderr: `[拒绝] ${plan.reason}`, stdout: "",
      });
    }
    const spec = buildSpawnSpec(plan, resolvedShell);
    const { jobId, logFile } = startShellJob({
      spec, command, shell: requestedShell, totalMs: timeoutPolicy.totalMs,
    });
    logger.info(LogTag.BuiltinTools, `[run_shell] background ${jobId} started: command="${command}" totalMs=${timeoutPolicy.totalMs}`);
    return JSON.stringify({
      command, cwd, shell: requestedShell,
      ranInBackground: true,
      jobId,
      logFile,
      status: "running",
      totalTimeoutMs: timeoutPolicy.totalMs,
      sandboxed: spec.ranViaSandbox,
      note: "命令已在后台启动，不阻塞本轮。用 shell_job (action=status, job_id) 查询状态，可传 wait_ms=0-60000 阻塞等待；action=stop 终止。日志持续写入 logFile（stdout+stderr 合计上限 64MB，超限自动终止）。",
    });
  }

  // full 档位：直接 spawn，不走沙箱（用户已选择完全信任）
  if (level === "full") {
    logger.info(LogTag.BuiltinTools, `[run_shell] full level → direct ${requestedShell} (no sandbox)`);
    const result = await executePlan({ kind: "direct", command, cwd, requestedShell }, resolvedShell, context?.signal, timeoutPolicy, context?.onShellOutput);
    logger.info(LogTag.BuiltinTools, `[run_shell] [full] done: exitCode=${result.exitCode} timedOut=${result.timedOut} stdout.len=${result.stdout.length} stderr.len=${result.stderr.length}`);
    // 字段顺序契约：stdout 排最后（command/cwd 等短字段之后），保证下游截断的
    // 尾窗始终覆盖 stdout 末尾——测试/构建命令的汇总行（Test Files/Tests passed）就在那里。
    return JSON.stringify({
      command, cwd, shell: result.shell, shellExecutable: result.shellExecutable, errorCode: result.errorCode,
      exitCode: result.exitCode,
      timedOut: result.timedOut,
      captureTruncated: result.captureTruncated,
      effect,
      sandboxed: false,
      stderr: result.stderr,
      stdout: result.stdout,
    });
  }

  // 非 full 档位：spawn 前通过 ExecutionPlan 完成全部安全决策
  // - read  → 仅当"用户显式无沙箱"（reason: disabled）时允许 direct 降级
  // - write/unknown → 必须 wrap 成功，否则 rejected（fail-closed，不执行）
  // （requiresSandbox 已在后台分支前声明，此处复用）
  const plan = await resolveExecutionPlan(command, cwd, requestedShell, resolvedShell, requiresSandbox);

  if (plan.kind === "rejected") {
    // 到达这里时 spawn 从未被调用——命令没有执行过，stdout 必然为空
    return JSON.stringify({
      command, cwd, shell: requestedShell,
      exitCode: -1, timedOut: false, captureTruncated: false, effect, sandboxed: false,
      stderr: `[拒绝] ${plan.reason}`, stdout: "",
    });
  }

  const result = await executePlan(plan, resolvedShell, context?.signal, timeoutPolicy, context?.onShellOutput);
  logger.info(LogTag.BuiltinTools, `[run_shell] [${level}] done: exitCode=${result.exitCode} timedOut=${result.timedOut} stdout.len=${result.stdout.length} stderr.len=${result.stderr.length} sandboxed=${result.ranViaSandbox}`);
  // 字段顺序契约同 full 档位：stdout 置尾，保证尾窗覆盖汇总行
  return JSON.stringify({
    command, cwd, shell: result.shell, shellExecutable: result.shellExecutable, errorCode: result.errorCode,
    exitCode: result.exitCode,
    timedOut: result.timedOut,
    captureTruncated: result.captureTruncated,
    effect,
    sandboxed: result.ranViaSandbox,
    stderr: result.stderr,
    stdout: result.stdout,
  });
}

export const runShellTool: ToolDefinition = {
  id: "run_shell",
  name: "执行命令",
  description:
    "在用户电脑上执行一条 Shell 命令字符串。默认由 cmd.exe 解析；需要类 Unix 语法时可显式选择 bash。返回 exitCode + stdout + stderr。\n\n" +
    "cmd 模式语义：\n" +
    "- 管道：git status | findstr TODO\n" +
    "- 重定向：npm run build > build.log 或 echo hello >> out.txt\n" +
    "- 命令串联：cd src && dir 或 git add . && git commit -m msg\n" +
    "- cmd 内建命令：dir / type / echo / del / copy / set 等可直接用\n" +
    "- 环境变量：%VAR% 会被展开\n\n" +
    "bash 模式语义：\n" +
    "- 设置 shell=\"bash\"，可使用 pwd / grep / sed / awk、$VAR、POSIX 管道及脚本语法\n" +
    "- 仅在检测到可用 Git Bash 时执行；不可用会明确返回 BASH_UNAVAILABLE，不会改用 cmd\n\n" +
    "何时用：\n" +
    "- git clone / git status / git log 等版本控制操作\n" +
    "- npm install / npm run / pip install / node xxx.js 等开发操作\n" +
    "- node --version / python --version 等查环境\n" +
    "- 用户明确要求'跑一下这条命令'\n" +
    "- 需要管道/重定向组合的命令\n" +
    "- 建目录/建文件等文件工具做不到时的兜底（如 mkdir、echo 内容 > 文件、type nul > 新建空文件）\n\n" +
    "不要用于：\n" +
    "- 读文件 → read_file（更安全）\n" +
    "- 列目录 → list_dir\n" +
    "- 搜索代码内容 → search_text\n" +
    "- 下载网页 → fetch_url\n" +
    "- 启动常驻进程（dev server / npx serve / watch / tail -f）→ 前台模式会在 2 分钟无输出后被强制终止，" +
    "确需后台长驻时传 run_in_background:true，随后用 shell_job 工具查询状态/终止\n" +
    "- 能用专用工具完成的事\n\n" +
    "超时行为：默认 2 分钟无任何输出即判卡死终止，30 分钟总上限。" +
    "长时间无输出的任务（删除大目录/编译链接等）可传 timeout_ms（1000–1800000 毫秒）显式指定执行上限，" +
    "设置后不再做无输出检测，仅受该上限约束。\n\n" +
    "后台模式：传 run_in_background:true 后命令在后台启动，立即返回 jobId 与 logFile（输出流式写日志文件，" +
    "stdout+stderr 合计上限 64MB，超限自动终止），不阻塞本轮对话。执行上限沿用 timeout_ms（未传则 30 分钟）。" +
    "之后用 shell_job 工具查询状态（可带 wait_ms 阻塞等待）或终止任务。\n\n" +
    "安全说明：非完全信任档位下，写副作用的命令会在沙箱中执行（限制文件系统访问范围）。" +
    "灾难命令（format/shutdown/dd 等）一律拒绝。\n" +
    "参数：command (完整命令行字符串，如 \"git status\")，cwd (可选工作目录)，shell (cmd 或 bash，默认 cmd)，" +
    "timeout_ms (可选执行上限毫秒数，1000–1800000，设置后禁用无输出检测)，" +
    "run_in_background (可选 true，后台执行并用 shell_job 管理)。",
  enabled: true,
  risk: "shell",
  modes: ["learn", "code", "work"],
  effectKind: "unknown" as const,
  inputSchema: {
    type: "object",
    properties: {
      command: { type: "string", description: "完整命令行字符串，如 \"git status\"、\"npm install\"、\"dir | findstr TODO\"" },
      cwd: { type: "string", description: "工作目录绝对路径，可选" },
      shell: {
        type: "string",
        enum: ["cmd", "bash"],
        default: "cmd",
        description: "命令解释器：cmd（默认，兼容旧命令）或 bash（需要用户已安装 Git Bash）",
      },
      timeout_ms: {
        type: "number",
        description: "执行上限毫秒数，可选（1000–1800000，超出范围自动钳制）。语义=执行生命周期上限，超时进程树被强制终止；设置后不再做\"2 分钟无输出判卡死\"检测，适合删除大目录/编译链接等长时间无输出任务。不传则默认：2 分钟无输出判卡死 + 30 分钟总上限",
      },
      run_in_background: {
        type: "boolean",
        description: "可选 true：后台执行命令，立即返回 jobId 与 logFile 不阻塞本轮。输出流式写日志文件（合计上限 64MB）。之后用 shell_job 工具查询状态（action=status，可带 wait_ms 阻塞等待 0–60000 毫秒）或终止（action=stop）。后台任务不受无输出检测，执行上限沿用 timeout_ms（未传则 30 分钟），取消本轮对话不杀后台任务",
      },
    },
    required: ["command"],
  },
  execute: executeRunShell,
};

