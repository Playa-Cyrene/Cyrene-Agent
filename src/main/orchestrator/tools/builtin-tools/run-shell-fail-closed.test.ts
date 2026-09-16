// run_shell 沙箱 fail-closed 安全门测试。
//
// 不变量：非 full 档位下，ExecutionPlan 未确定为可执行（sandboxed/direct）之前
// 不允许出现任何 spawn 调用。本测试用故障注入验证：
// wrap 抛错 / wrap_failed / not_ready / disabled+写副作用 → spawn 调用次数 === 0；
// 仅 disabled + read 命令允许降级直跑（用户显式无沙箱的 graceful degradation）。
//
// 断言优先级：spawn 调用次数（直接验证安全不变量）> marker 文件不存在（行为验证）。
import { beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

const wrapMock = vi.fn();
const spawnCalls: Array<{ command: string; args: string[] }> = [];

vi.mock("../../sandbox/sandbox-exec", () => ({
  wrapWithSandbox: (...args: unknown[]) => wrapMock(...args),
  isSandboxReady: () => true,
  ensureSandboxReady: async () => true,
  initSandbox: async () => undefined,
  resetSandbox: async () => undefined,
}));

vi.mock("../../../permission", () => ({
  getCurrentLevel: () => "ask",
}));

vi.mock("child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("child_process")>();
  return {
    ...actual,
    spawn: (command: string, args: string[], options: unknown) => {
      spawnCalls.push({ command, args });
      return actual.spawn(command, args, options as never);
    },
  };
});

import { runShellTool } from "./run-shell-tool";

interface RunShellResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  sandboxed: boolean;
}

async function run(command: string): Promise<RunShellResult> {
  const raw = await runShellTool.execute({ command, shell: "cmd" }, undefined);
  return JSON.parse(raw) as RunShellResult;
}

describe.runIf(process.platform === "win32")("run_shell sandbox fail-closed gate", () => {
  let markerDir: string;
  let markerPath: string;

  beforeEach(() => {
    wrapMock.mockReset();
    spawnCalls.length = 0;
    markerDir = fs.mkdtempSync(path.join(os.tmpdir(), "cyrene-fc-"));
    markerPath = path.join(markerDir, "marker.txt");
  });

  // 写副作用命令（带重定向 → classifyShellEffect = write）
  const writeCommand = () => `echo CYRENE_FAIL_CLOSED> "${markerPath.replace(/"/g, '\\"')}"`;
  // git status → classifyShellEffect = read（无操作符、git 只读子命令）
  const readCommand = () => "git status";

  it("wrap 抛错：写命令 0 次 spawn，marker 不存在，返回拒绝", async () => {
    wrapMock.mockImplementation(() => {
      throw new Error("TEST_FORCE_SANDBOX_WRAP_FAILURE");
    });
    const result = await run(writeCommand());
    expect(spawnCalls).toHaveLength(0);
    expect(fs.existsSync(markerPath)).toBe(false);
    expect(result.exitCode).toBe(-1);
    expect(result.sandboxed).toBe(false);
    expect(result.stderr).toContain("拒绝");
  });

  it("wrap 返回 wrap_failed：写命令 0 次 spawn，marker 不存在", async () => {
    wrapMock.mockResolvedValue({ ok: false, reason: "wrap_failed", detail: "empty argv" });
    const result = await run(writeCommand());
    expect(spawnCalls).toHaveLength(0);
    expect(fs.existsSync(markerPath)).toBe(false);
    expect(result.exitCode).toBe(-1);
    expect(result.stderr).toContain("沙箱包装失败");
  });

  it("wrap 返回 not_ready：写命令 0 次 spawn", async () => {
    wrapMock.mockResolvedValue({ ok: false, reason: "not_ready" });
    const result = await run(writeCommand());
    expect(spawnCalls).toHaveLength(0);
    expect(fs.existsSync(markerPath)).toBe(false);
    expect(result.stderr).toContain("沙箱不可用");
  });

  it("wrap 返回 not_ready：read 命令同样 fail-closed（0 次 spawn）", async () => {
    wrapMock.mockResolvedValue({ ok: false, reason: "not_ready" });
    const result = await run(readCommand());
    expect(spawnCalls).toHaveLength(0);
    expect(result.exitCode).toBe(-1);
    expect(result.stderr).toContain("沙箱不可用");
  });

  it("wrap 返回 disabled：写命令 fail-closed（0 次 spawn）", async () => {
    wrapMock.mockResolvedValue({ ok: false, reason: "disabled", detail: "sandboxDisabled=true" });
    const result = await run(writeCommand());
    expect(spawnCalls).toHaveLength(0);
    expect(fs.existsSync(markerPath)).toBe(false);
    expect(result.stderr).toContain("沙箱未启用");
  });

  it("wrap 返回 disabled：read 命令允许降级直跑（1 次 spawn，sandboxed=false）", async () => {
    wrapMock.mockResolvedValue({ ok: false, reason: "disabled" });
    const result = await run("echo cyrene-fc-direct");
    expect(spawnCalls).toHaveLength(1);
    expect(result.sandboxed).toBe(false);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("cyrene-fc-direct");
  });

  it("wrap 返回 not_ready：后台模式同样 fail-closed（0 次 spawn，无 jobId）", async () => {
    wrapMock.mockResolvedValue({ ok: false, reason: "not_ready" });
    const raw = await runShellTool.execute({ command: writeCommand(), shell: "cmd", run_in_background: true }, undefined);
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    expect(spawnCalls).toHaveLength(0);
    expect(fs.existsSync(markerPath)).toBe(false);
    expect(parsed.ranInBackground).toBeUndefined();
    expect(parsed.jobId).toBeUndefined();
    expect(parsed.stderr).toContain("[拒绝]");
    expect(parsed.stderr).toContain("沙箱不可用");
  });

  it("wrap 成功：仅 spawn 包装后的 argv，sandboxed=true", async () => {
    wrapMock.mockResolvedValue({
      ok: true,
      argv: ["cyrene-srt-stub.exe", "--run", writeCommand()],
      env: {},
    });
    const result = await run(writeCommand());
    // srt stub 不存在 → spawn error，但恰好证明只有这一条包装后的 spawn 被发起
    expect(spawnCalls).toHaveLength(1);
    expect(spawnCalls[0].command).toBe("cyrene-srt-stub.exe");
    expect(result.sandboxed).toBe(true);
    // 原始命令未被直跑：marker 不存在（只有包装进程被启动且立即失败）
    expect(fs.existsSync(markerPath)).toBe(false);
  });
});
