// C5 后台任务护栏验收测试（真实进程，Windows/Linux 双平台）：
// - 五态状态机：running → exited/stopped/timed_out/failed，终态不可被覆盖
// - 输出护栏：流式落盘 + 达到上限杀进程（生产常量 64MB，测试注入小值走同一代码路径）
// - kill 真实性：stop/超时/超限后进程（含孙进程）必须真的死亡，不是只改状态字段
// - wait 语义：任务先到终态提前返回；wait_ms 到期返回运行中快照；用户取消立即返回
// - 工具协议：MISSING_JOB_ID 回传实际参数键名 / JOB_NOT_FOUND / run_shell 后台模式集成

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

// electron mock：模块加载期（beforeAll 之前）getPath 抛错 → logger 的 try/catch 静默跳过
// 落盘，与其它测试文件"app 未定义"的行为对齐；测试开始后返回临时目录，
// 供 run_shell 后台集成的 defaultJobsDir（userData/shell-jobs）使用。
// vi.mock 工厂被提升到 import 之前，不能引用文件顶层变量，故走 globalThis 中转。
vi.mock("electron", () => ({
  app: {
    getPath: () => {
      const dir = (globalThis as Record<string, unknown>).__shellJobTestUserData;
      if (typeof dir !== "string") throw new Error("userData not ready in test");
      return dir;
    },
    on: () => {},
  },
}));

import {
  clampWaitMs,
  disposeAllShellJobs,
  startShellJob,
  stopShellJob,
  waitForShellJob,
  type ShellJobSnapshot,
  type ShellSpawnSpec,
} from "./shell-job-manager";
import { closeConversationDatabases } from "../../../storage/conversation-database-client";
import { toolRegistry } from "../registry/tool-registry";

let tmpDir: string;

/** 构造直跑 node 脚本的 spawn 规格（不经 shell，避免平台引号差异） */
function nodeSpec(args: string[]): ShellSpawnSpec {
  return {
    command: process.execPath,
    args,
    env: { ...process.env },
    cwd: tmpDir,
    windowsVerbatimArguments: false,
    ranViaSandbox: false,
  };
}

/** 写一个 .cjs 脚本到临时目录并返回路径 */
function writeScript(name: string, content: string): string {
  const file = path.join(tmpDir, name);
  fs.writeFileSync(file, content, "utf8");
  return file;
}

function start(scriptFile: string, opts: { totalMs?: number; logMaxBytes?: number } = {}) {
  return startShellJob({
    spec: nodeSpec([scriptFile]),
    command: `node ${path.basename(scriptFile)}`,
    shell: "cmd",
    ...opts,
  });
}

/** 轮询任务快照直到谓词成立（日志写盘是异步流，tail/终态都靠轮询收敛） */
async function snapshotEventually(
  jobId: string,
  predicate: (s: ShellJobSnapshot) => boolean,
  timeoutMs = 8000,
): Promise<ShellJobSnapshot> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const snap = await waitForShellJob(jobId, 0);
    if (!snap) throw new Error(`job ${jobId} not found`);
    if (predicate(snap)) return snap;
    if (Date.now() > deadline) {
      throw new Error(`timeout waiting job ${jobId}: status=${snap.status} reason=${snap.reason}`);
    }
    await new Promise((r) => setTimeout(r, 150));
  }
}

/** PID 是否存活（signal 0 = 存在性探测） */
function isPidAlive(pid: number | null): boolean {
  if (pid == null) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** 轮询等待一组进程全部死亡（kill 是异步动作，需要给 OS 收尸时间） */
async function waitPidsDead(pids: Array<number | null>, timeoutMs = 8000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const alive = pids.filter((p) => isPidAlive(p));
    if (alive.length === 0) return;
    if (Date.now() > deadline) throw new Error(`processes still alive: ${alive.join(", ")}`);
    await new Promise((r) => setTimeout(r, 150));
  }
}

beforeAll(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cyrene-shell-job-"));
  (globalThis as Record<string, unknown>).__shellJobTestUserData = tmpDir;
});

afterAll(async () => {
  // 兜底收尸：断言失败提前退出时仍终止所有运行中的任务
  await disposeAllShellJobs();
  await closeConversationDatabases();
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  } catch {
    // 日志流尚未完全释放时删除失败可接受（临时目录交给 OS 清理）
  }
});

describe("clampWaitMs（纯函数）", () => {
  it("缺省/非数字/负数归 0；字符串数字可解析；超过 60000 钳到上限", () => {
    expect(clampWaitMs(undefined)).toBe(0);
    expect(clampWaitMs(-5)).toBe(0);
    expect(clampWaitMs("abc")).toBe(0);
    expect(clampWaitMs("2500")).toBe(2500);
    expect(clampWaitMs(1500.6)).toBe(1501);
    expect(clampWaitMs(999_999)).toBe(60_000);
  });
});

describe("shell-job-manager 状态机与护栏（真实进程）", () => {
  it("启动即返回：running + pid + 日志文件已创建", async () => {
    const script = writeScript("sleeper-01.cjs", "setInterval(() => {}, 1000);");
    const { jobId, logFile } = await start(script, { totalMs: 60_000 });
    const snap = await waitForShellJob(jobId, 0);
    expect(snap?.status).toBe("running");
    expect(snap?.exitCode).toBeNull();
    expect(snap?.pid).toBeGreaterThan(0);
    expect(fs.existsSync(logFile)).toBe(true);
    await stopShellJob(jobId);
    await waitPidsDead([snap?.pid ?? null]);
  }, 15_000);

  it("阻塞等待自然退出：任务先结束提前返回 exited + exitCode=0 + tail 含输出", async () => {
    const script = writeScript("echo-once.cjs", 'console.log("hello-job");');
    const { jobId } = await start(script);
    const begin = Date.now();
    const snap = await waitForShellJob(jobId, 15_000);
    const elapsed = Date.now() - begin;
    expect(snap?.status).toBe("exited");
    expect(snap?.exitCode).toBe(0);
    // 任务秒退，等待必须提前结束而不是等满 15 秒
    expect(elapsed).toBeLessThan(10_000);
    // 日志写盘异步：轮询到 tail 出现输出
    const flushed = await snapshotEventually(jobId, (s) => s.tail.includes("hello-job"), 3000);
    expect(flushed.tail).toContain("hello-job");
  }, 20_000);

  it("wait_ms 到期任务仍在跑：返回 running 快照，不悬挂", async () => {
    const script = writeScript("sleeper-10.cjs", "setInterval(() => {}, 1000);");
    const { jobId } = await start(script, { totalMs: 60_000 });
    const begin = Date.now();
    const snap = await waitForShellJob(jobId, 500);
    const elapsed = Date.now() - begin;
    expect(snap?.status).toBe("running");
    expect(elapsed).toBeGreaterThanOrEqual(450);
    expect(elapsed).toBeLessThan(5_000);
    await stopShellJob(jobId);
    await waitPidsDead([snap?.pid ?? null]);
  }, 15_000);

  it("用户取消（signal abort）：立即返回当前快照，不等满 wait_ms", async () => {
    const script = writeScript("sleeper-20.cjs", "setInterval(() => {}, 1000);");
    const { jobId } = await start(script, { totalMs: 60_000 });
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 300);
    const begin = Date.now();
    const snap = await waitForShellJob(jobId, 30_000, controller.signal);
    const elapsed = Date.now() - begin;
    expect(snap?.status).toBe("running");
    expect(elapsed).toBeLessThan(5_000);
    await stopShellJob(jobId);
    await waitPidsDead([snap?.pid ?? null]);
  }, 15_000);

  it("stop 杀掉整棵进程树：主进程与孙进程都真实死亡（Windows taskkill /T、Unix 进程组）", async () => {
    const script = writeScript("tree-killer.cjs", [
      'console.log("parent-pid:" + process.pid);',
      'const { spawn } = require("child_process");',
      'const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000);"]);',
      'console.log("child-pid:" + child.pid);',
      "setInterval(() => {}, 1000);",
    ].join("\n"));
    const { jobId } = await start(script, { totalMs: 60_000 });
    // 等两个 pid 行落盘（孙进程由脚本负责拉起）
    const snap = await snapshotEventually(jobId, (s) => s.tail.includes("child-pid:"), 10_000);
    const parentPid = snap.pid;
    const childPid = Number(/child-pid:(\d+)/.exec(snap.tail)?.[1] ?? 0);
    expect(parentPid).toBeTruthy();
    expect(childPid).toBeGreaterThan(0);
    expect(isPidAlive(parentPid)).toBe(true);
    expect(isPidAlive(childPid)).toBe(true);

    const stopped = await stopShellJob(jobId);
    expect(stopped?.status).toBe("stopped");
    expect(stopped?.exitCode).toBeNull();
    await waitPidsDead([parentPid, childPid]);
  }, 25_000);

  it("终态不可变 + stop 幂等：已 exited 的任务 stop 后仍 exited；running 任务重复 stop 均 stopped", async () => {
    // 短命令先自然退出，再 stop → 状态保持 exited（迟到操作不覆盖终态）
    const quick = writeScript("quick.cjs", 'console.log("quick");');
    const { jobId: quickId } = await start(quick);
    const exited = await snapshotEventually(quickId, (s) => s.status === "exited", 10_000);
    expect(exited.exitCode).toBe(0);
    const afterStop = await stopShellJob(quickId);
    expect(afterStop?.status).toBe("exited");

    // running 任务连续 stop 两次 → 都是 stopped，第二次是幂等返回
    const sleeper = writeScript("sleeper-30.cjs", "setInterval(() => {}, 1000);");
    const { jobId: sleepId } = await start(sleeper, { totalMs: 60_000 });
    const first = await stopShellJob(sleepId);
    expect(first?.status).toBe("stopped");
    const second = await stopShellJob(sleepId);
    expect(second?.status).toBe("stopped");
    await waitPidsDead([first?.pid ?? null]);
  }, 20_000);

  it("输出超上限：达到上限即杀进程并判 failed（reason=output_limit_exceeded）", async () => {
    const script = writeScript("flood.cjs", [
      'const chunk = "x".repeat(512);',
      'setInterval(() => { process.stdout.write(chunk + "\\n"); }, 10);',
    ].join("\n"));
    // 注入 4KB 上限：与生产 64MB 走同一代码路径
    const { jobId } = await start(script, { totalMs: 60_000, logMaxBytes: 4096 });
    const snap = await snapshotEventually(jobId, (s) => s.status === "failed", 10_000);
    expect(snap.reason).toBe("output_limit_exceeded");
    expect(snap.totalBytes).toBeGreaterThanOrEqual(4096);
    await waitPidsDead([snap.pid]);
  }, 20_000);

  it("执行上限到期：强制终止并判 timed_out（reason=total_timeout_exceeded）", async () => {
    const script = writeScript("sleeper-60.cjs", "setInterval(() => {}, 1000);");
    const { jobId } = await start(script, { totalMs: 1200 });
    const snap = await snapshotEventually(jobId, (s) => s.status === "timed_out", 10_000);
    expect(snap.reason).toBe("total_timeout_exceeded");
    expect(snap.exitCode).toBeNull();
    await waitPidsDead([snap.pid]);
  }, 20_000);

  it("未知 jobId：wait 与 stop 均返回 null", async () => {
    expect(await waitForShellJob("job-19700101-000000-999", 0)).toBeNull();
    expect(await stopShellJob("job-19700101-000000-999")).toBeNull();
  });
});

describe("shell_job 工具协议（注册 + run_shell 后台集成）", () => {
  beforeAll(async () => {
    await import("../built-in-tools");
  });

  async function callShellJob(args: Record<string, unknown>) {
    const tool = toolRegistry.getById("shell_job");
    if (!tool) throw new Error("shell_job 未注册");
    return JSON.parse(await tool.execute(args, { userQuery: "" } as never)) as Record<string, unknown>;
  }

  it("缺 job_id → MISSING_JOB_ID，并回传实际收到的参数键名", async () => {
    const r = await callShellJob({ action: "status", wait_ms: 0 });
    expect(r.errorCode).toBe("MISSING_JOB_ID");
    expect(r.receivedParams).toBe("action, wait_ms");
  });

  it("未知 job_id → JOB_NOT_FOUND（status 与 stop 两路一致）", async () => {
    for (const action of ["status", "stop"] as const) {
      const r = await callShellJob({ action, job_id: "job-nope" });
      expect(r.errorCode).toBe("JOB_NOT_FOUND");
    }
  });

  it("run_shell run_in_background 集成：启动返回 jobId/logFile → status running → stop → 进程真死", async () => {
    const runShell = toolRegistry.getById("run_shell");
    if (!runShell) throw new Error("run_shell 未注册");
    const raw = JSON.parse(await runShell.execute(
      { command: 'node -e "setTimeout(()=>{},30000)"', run_in_background: true },
      { permissionMode: "allow_all" } as never,
    )) as Record<string, unknown>;
    expect(raw.ranInBackground).toBe(true);
    expect(raw.status).toBe("running");
    expect(String(raw.jobId)).toMatch(/^job-/);
    expect(fs.existsSync(String(raw.logFile))).toBe(true);

    const st = await callShellJob({ action: "status", job_id: raw.jobId });
    expect(st.status).toBe("running");
    expect(st.waitedMs).toBe(0);
    expect(Number(st.pid)).toBeGreaterThan(0);

    const stop = await callShellJob({ action: "stop", job_id: raw.jobId });
    expect(stop.status).toBe("stopped");
    expect(stop.stopped).toBe(true);
    await waitPidsDead([Number(st.pid)]);
  }, 20_000);
});