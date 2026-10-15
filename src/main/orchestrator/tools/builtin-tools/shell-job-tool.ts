// ── 工具：shell_job（后台任务管理）──────────────────────────
// run_shell run_in_background:true 的配套查询/终止工具。
//
// ledgerPolicy=bypass：任务状态随时间变化，相同参数每次都必须返回最新快照，
// 绝不能因为"参数没变"复用旧结果（缓存会把 running 谎报成终态或反之）。
//
// risk="safe"：不产生新的副作用——status 纯读注册表，stop 只终止一个
// run_shell 启动时已通过安全决策的进程（风险递减方向），两者都不应被权限闸门拦截。
// needsContext：取 ToolContext.signal，用户取消本轮对话时提前结束阻塞等待。

import type { ToolDefinition } from "../registry/tool-registry";
import { clampWaitMs, stopShellJob, waitForShellJob } from "./shell-job-manager";
import { logger, LogTag } from "../../../logger";

/** 任务五态的说明文案：模型据此决定下一步（等待/读日志/放弃） */
const STATUS_HINTS: Record<string, string> = {
  running: "任务仍在执行。对比两次查询的 totalBytes 增量可判断活跃度：有增量=正常在跑；连续多次零增量且非预期静默任务=疑似卡死，可考虑 action=stop。",
  exited: "任务已自然退出。exitCode=0 成功；非 0 失败，tail 里有错误输出。",
  timed_out: "任务超过执行上限被强制终止。",
  stopped: "任务被用户/应用主动终止。",
  failed: "任务异常或执行结果无法确认，见 reason 字段。",
};

export const shellJobTool: ToolDefinition = {
  id: "shell_job",
  name: "后台任务管理",
  description:
    "查询或终止 run_shell 后台任务（run_in_background:true 启动的命令）。\n\n" +
    "何时用：\n" +
    "- run_shell 返回 jobId 后想知道命令跑完没有 → action=status\n" +
    "- 需要等一个后台命令出结果再继续 → action=status + wait_ms（阻塞等待，任务到终态提前返回）\n" +
    "- 后台任务卡死/不再需要 → action=stop（幂等，已终止的任务直接返回终态）\n\n" +
    "状态含义（五态）：running=执行中 / exited=自然退出（看 exitCode）/ timed_out=超时终止 / " +
    "stopped=主动终止 / failed=异常或结果未知（看 reason）。\n" +
    "重启后 reason=app_restarted_execution_unknown 表示无法确认原命令的执行结果，不代表命令没有执行；先核对实际结果，不要直接重跑。\n\n" +
    "判活技巧：status 返回 totalBytes（累计输出字节数）+ tail（日志最后 8KB）。" +
    "两次查询 totalBytes 有增量说明任务真在跑；长时间零增量且任务本应持续输出则可能卡死。\n" +
    "完整日志在 run_shell 返回的 logFile 路径，需要全文时用 Read 读取。\n\n" +
    "参数：action（status 或 stop，默认 status），job_id（run_shell 后台模式返回的任务 ID），" +
    "wait_ms（可选，仅 status：阻塞等待毫秒数 0–60000，超范围自动钳制，默认 0 立即返回）。",
  enabled: true,
  risk: "safe",
  modes: ["learn", "code", "work"],
  effectKind: "unknown" as const,
  ledgerPolicy: "bypass" as const,
  needsContext: true,
  inputSchema: {
    type: "object",
    properties: {
      action: {
        type: "string",
        enum: ["status", "stop"],
        default: "status",
        description: "status=查询任务状态（可带 wait_ms 阻塞等待）；stop=终止任务（幂等）",
      },
      job_id: {
        type: "string",
        description: "run_shell run_in_background:true 返回的 jobId，如 \"job-20260906-103000-001\"",
      },
      wait_ms: {
        type: "number",
        description: "仅 action=status：阻塞等待毫秒数（0–60000，超范围自动钳制，默认 0 立即返回当前快照）。任务先到终态则提前返回",
      },
    },
    required: ["job_id"],
  },
  execute: async (args, context) => {
    const receivedKeys = Object.keys(args).join(", ") || "(无)";
    const action = args.action === "stop" ? "stop" : "status";
    const jobId = String(args.job_id ?? "").trim();

    if (!jobId) {
      // 缺参报错回传实际收到的参数键名，帮模型自纠
      return JSON.stringify({
        action, errorCode: "MISSING_JOB_ID",
        error: "job_id 不能为空。请传 run_shell 后台模式返回的 jobId。",
        receivedParams: receivedKeys,
        exitCode: -1, stdout: "",
        stderr: "[错误] job_id 不能为空（实际收到参数：" + receivedKeys + "）",
      });
    }

    if (action === "stop") {
      const snap = await stopShellJob(jobId);
      if (!snap) {
        logger.warn(LogTag.BuiltinTools, `[shell_job] stop unknown job: ${jobId}`);
        return JSON.stringify({
          action, jobId, errorCode: "JOB_NOT_FOUND",
          error: `未找到任务 ${jobId}。任务可能已过保留期，或来自升级前未保存的注册表。请先确认原命令是否已执行，避免重复操作。`,
          exitCode: -1, stdout: "",
          stderr: `[JOB_NOT_FOUND] 未找到任务 ${jobId}`,
        });
      }
      logger.info(LogTag.BuiltinTools, `[shell_job] stop ${jobId} → ${snap.status}`);
      // 字段顺序契约：tail 是唯一大字段，必须排最后（下游头尾截断时尾窗覆盖最新输出）
      return JSON.stringify({
        action, jobId, pid: snap.pid, stopped: snap.status === "stopped",
        status: snap.status, exitCode: snap.exitCode, reason: snap.reason,
        totalBytes: snap.totalBytes, logFile: snap.logFile,
        command: snap.command, shell: snap.shell,
        startedAt: snap.startedAt, durationMs: snap.durationMs,
        tail: snap.tail,
      });
    }

    // status：wait_ms 钳制；取消时内存任务返回快照，历史查询抛出取消错误。
    const waitMs = clampWaitMs(args.wait_ms);
    const snap = await waitForShellJob(jobId, waitMs, context?.signal);
    if (!snap) {
      logger.warn(LogTag.BuiltinTools, `[shell_job] status unknown job: ${jobId}`);
      return JSON.stringify({
        action, jobId, errorCode: "JOB_NOT_FOUND",
        error: `未找到任务 ${jobId}。任务可能已过保留期，或来自升级前未保存的注册表。请先确认原命令是否已执行，避免重复操作。`,
        exitCode: -1, stdout: "",
        stderr: `[JOB_NOT_FOUND] 未找到任务 ${jobId}`,
      });
    }
    if (waitMs > 0) {
      logger.info(LogTag.BuiltinTools, `[shell_job] status ${jobId} (waited≤${waitMs}ms) → ${snap.status}`);
    }
    return JSON.stringify({
      action, jobId, pid: snap.pid, waitedMs: waitMs,
      status: snap.status, exitCode: snap.exitCode, reason: snap.reason,
      totalBytes: snap.totalBytes, logFile: snap.logFile,
      command: snap.command, shell: snap.shell,
      startedAt: snap.startedAt, durationMs: snap.durationMs,
      statusHint: snap.reason === "app_restarted_execution_unknown"
        ? "应用重启后无法确认执行结果。durationMs 截至恢复检查时间，不是实际执行耗时；先核对实际结果，不要直接重跑命令。"
        : STATUS_HINTS[snap.status] ?? "",
      tail: snap.tail,
    });
  },
};
