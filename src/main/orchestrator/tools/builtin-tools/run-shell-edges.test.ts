// run_shell 边界分支测试：补齐 fail-closed / capture-limit / timeout 三个专项文件
// 之外的独立分支——非法 shell 值、灾难命令守卫、GBK 解码回落、stderr 超限丢弃、
// 预先取消的 signal、bash 不可用。
import { describe, expect, it, vi } from "vitest";

// bash 解析固定 mock 为"不可用"：BASH_UNAVAILABLE 分支需要确定性环境
// （本机可能装有 Git Bash，真实探测会让断言随环境翻转）。cmd 路径保持真实行为。
vi.mock("../../shell-runtime", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../shell-runtime")>();
  return {
    ...actual,
    resolveShellExecutable: async (kind: "cmd" | "bash") =>
      kind === "cmd"
        ? { kind: "cmd" as const, executable: process.env.ComSpec || "cmd.exe" }
        : null,
  };
});

import { runShellTool } from "./run-shell-tool";

interface RunShellResult {
  command: string;
  shell?: string;
  errorCode?: string;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  captureTruncated: boolean;
  timedOut: boolean;
  ranInBackground?: boolean;
  [key: string]: unknown;
}

async function run(
  args: Record<string, unknown>,
  context?: unknown,
): Promise<RunShellResult> {
  const raw = await runShellTool.execute(args, context as never);
  return JSON.parse(raw) as RunShellResult;
}

describe.runIf(process.platform === "win32")("run_shell 边界分支", () => {
  it("shell 为非法值（powershell）返回 SHELL_UNSUPPORTED，不尝试执行", async () => {
    const parsed = await run({ command: "echo hi", shell: "powershell" });
    expect(parsed.errorCode).toBe("SHELL_UNSUPPORTED");
    expect(parsed.exitCode).toBe(-1);
    expect(parsed.stderr).toContain("仅支持 cmd 或 bash");
    expect(parsed.stdout).toBe("");
  });

  it("灾难命令（shutdown）无论档位一律拒绝", async () => {
    const parsed = await run(
      { command: "shutdown /s /t 0", shell: "cmd" },
      { permissionMode: "allow_all" },
    );
    expect(parsed.exitCode).toBe(-1);
    expect(parsed.stderr).toContain("该命令被系统禁止执行");
    expect(parsed.stdout).toBe("");
  });

  it("bash 不可用时返回 BASH_UNAVAILABLE，不改用 cmd", async () => {
    const parsed = await run({ command: "ls -la", shell: "bash" });
    expect(parsed.errorCode).toBe("BASH_UNAVAILABLE");
    expect(parsed.shell).toBe("bash");
    expect(parsed.exitCode).toBe(-1);
    expect(parsed.stderr).toContain("未找到可用的 Bash");
    expect(parsed.stdout).toBe("");
  });

  it("输出含非法 UTF-8 序列时回落 GBK 解码（中文不乱码）", async () => {
    // 0xD6 0xD0 是"中"的 GBK 编码，也是非法 UTF-8 序列：
    // 严格 UTF-8 解码抛错 → GBK 解码得到正确汉字
    const parsed = await run(
      { command: 'node -e "process.stdout.write(Buffer.from([0xd6,0xd0]))"' },
      { permissionMode: "allow_all" },
    );
    expect(parsed.exitCode).toBe(0);
    expect(parsed.captureTruncated).toBe(false);
    expect(parsed.stdout).toBe("中");
  });

  it("stderr 超过 2MB 捕获上限：标记 captureTruncated 且停止累积", async () => {
    const parsed = await run(
      { command: 'node -e "process.stderr.write(Buffer.alloc(3*1024*1024, 97))"' },
      { permissionMode: "allow_all" },
    );
    expect(parsed.exitCode).toBe(0);
    expect(parsed.captureTruncated).toBe(true);
    expect(parsed.stderr.length).toBeLessThanOrEqual(2 * 1024 * 1024 + 8192);
    expect(parsed.stderr.length).toBeGreaterThan(1024 * 1024);
  });

  it("signal 已预先 abort：命令被立即取消，如实上报取消原因", async () => {
    const controller = new AbortController();
    controller.abort();
    const parsed = await run(
      { command: 'node -e "setTimeout(()=>{},3000)"' },
      { permissionMode: "allow_all", signal: controller.signal },
    );
    expect(parsed.timedOut).toBe(true);
    expect(parsed.exitCode).toBeNull();
    expect(parsed.stderr).toContain("所在任务已被用户取消");
  });

  it("传入未触发的 signal：注册监听但不影响命令正常完成", async () => {
    const controller = new AbortController();
    const parsed = await run(
      { command: 'node -e "console.log(\'with-signal-ok\')"' },
      { permissionMode: "allow_all", signal: controller.signal },
    );
    expect(parsed.exitCode).toBe(0);
    expect(parsed.timedOut).toBe(false);
    expect(parsed.stdout).toContain("with-signal-ok");
  });
});
