// 真实 sandbox-exec disabled 路径 + 真实命令执行；全部副作用仅发生在独立临时目录。
import type { SpawnOptions } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentFileAccessLevel } from "../../../permission-policy";
const state = vi.hoisted(() => ({ level: "read-only" as AgentFileAccessLevel, root: "", spawns: 0 }));
// 解释器和命令仅来自固定系统目录；不使用宿主 ComSpec/PATH 或当前目录查找。
// Windows CI 使用标准系统目录；夹具不再通过任何宿主变量定位解释器。
const systemRoot = "C:\\Windows";
const systemBin = process.platform === "win32" ? path.join(systemRoot, "System32") : "/usr/bin";
const shellExecutable = process.platform === "win32" ? path.join(systemBin, "cmd.exe") : "/bin/bash";
let nativeSpawn: typeof import("child_process").spawn;

function fixtureEnvironment(): NodeJS.ProcessEnv {
  return {
    PATH: process.platform === "win32" ? systemBin : "/usr/bin:/bin",
    PATHEXT: ".COM;.EXE", NoDefaultCurrentDirectoryInExePath: "1",
    ...(process.platform === "win32" ? { SystemRoot: systemRoot, WINDIR: systemRoot, ComSpec: shellExecutable } : {}),
    HOME: path.join(state.root, "home"), USERPROFILE: path.join(state.root, "home"),
    TMP: state.root, TEMP: state.root, TMPDIR: state.root, LANG: "C", LC_ALL: "C",
  };
}

function spawnFixture(command: string, args: readonly string[], options: SpawnOptions) {
  // 前后台共享同一替身边界；只隔离测试进程环境，命令/参数仍由真实执行计划构造。
  expect(command).toBe(shellExecutable);
  state.spawns++;
  return nativeSpawn(command, args, { ...options, env: fixtureEnvironment() });
}
vi.mock("electron", () => ({ app: { getPath: () => state.root } }));
vi.mock("../../../logger", () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() }, LogTag: {} }));
vi.mock("../../../permission", async () => ({
  ...await import("../../../permission-policy"), getCurrentLevel: () => state.level,
}));
vi.mock("child_process", async (original) => {
  const actual = await original<typeof import("child_process")>();
  return { ...actual, spawn: (...args: Parameters<typeof actual.spawn>) => {
    return spawnFixture(args[0], args[1] as string[], args[2] as SpawnOptions);
  } };
});
// 非 Windows 产品当前只探测 bash.exe；仅替换解释器发现，执行与 disabled 判定保持真实。
vi.mock("../../shell-runtime", async (original) => {
  const actual = await original<typeof import("../../shell-runtime")>();
  return { ...actual, resolveShellExecutable: async () => process.platform === "win32"
    ? { kind: "cmd", executable: shellExecutable }
    : { kind: "bash", executable: shellExecutable } };
});
const startJob = vi.hoisted(() => vi.fn());
vi.mock("./shell-job-manager", async (original) => ({
  ...await original<typeof import("./shell-job-manager")>(),
  startShellJob: (...args: unknown[]) => startJob(...args),
}));
let sandbox: typeof import("../../sandbox/sandbox-exec");
let runShellTool: typeof import("./run-shell-tool")["runShellTool"];

beforeEach(async () => {
  // initSandbox 是进程级幂等单例；每例重载才能独立验证 0 / false 两个环境值。
  nativeSpawn = (await vi.importActual<typeof import("child_process")>("child_process")).spawn;
  vi.resetModules();
  sandbox = await import("../../sandbox/sandbox-exec");
  ({ runShellTool } = await import("./run-shell-tool"));
  state.root = fs.mkdtempSync(path.join(os.tmpdir(), "cyrene-shell-disabled-"));
  fs.mkdirSync(path.join(state.root, "home"));
  state.level = "read-only";
  state.spawns = 0;
  startJob.mockReset().mockImplementation(async ({ spec }) => {
    // 后台测试仍启动真实进程；等待退出后再返回，避免测试泄漏进程或临时文件。
    const child = spawnFixture(spec.command, spec.args, { cwd: spec.cwd, env: spec.env,
      windowsVerbatimArguments: spec.windowsVerbatimArguments, shell: false, stdio: "ignore" });
    const exitCode = await new Promise<number | null>((resolve, reject) => {
      child.once("error", reject);
      child.once("close", resolve);
    });
    expect(exitCode).toBe(0);
    return { jobId: "test-completed", logFile: path.join(state.root, "test.log") };
  });
});
afterEach(async () => {
  await sandbox.resetSandbox();
  vi.unstubAllEnvs();
  fs.rmSync(state.root, { recursive: true, force: true });
});

async function run(background: boolean, command?: string, permissionMode?: "allow_all") {
  // 固定 ASCII + CRLF 文本夹具，避免把平台文本差异混入权限验证。
  fs.writeFileSync(path.join(state.root, "input.txt"), "z\r\na\r\n", "ascii");
  // sort 的写参数被首词分类误认 read：Windows 原生 /O 由 Windows CI 验证。
  command ??= process.platform === "win32" ? "sort /O output.txt input.txt" : "sort -o output.txt input.txt";
  const raw = await runShellTool.execute({ command, cwd: state.root,
    shell: process.platform === "win32" ? "cmd" : "bash", run_in_background: background },
    { userQuery: "test", resolvedWorkspaceRoot: state.root, permissionMode });
  return JSON.parse(raw);
}

describe.each(["0", "false"])("真实 CYRENE_SRT=%s", disabled => {
  describe.each([false, true])("background=%s", background => {
  beforeEach(async () => { vi.stubEnv("CYRENE_SRT", disabled); await sandbox.initSandbox(); });
  it.each(["project-read-only", "read-only", "scoped", "per-action"] as const)("%s 前后台均在 spawn 前拒绝伪只读写命令", async level => {
    state.level = level;
    {
      const result = await run(background);
      expect(fs.existsSync(path.join(state.root, "output.txt"))).toBe(false);
      expect(state.spawns).toBe(0);
      expect(startJob).not.toHaveBeenCalled();
      expect(result).toMatchObject({ exitCode: -1, effect: "read", sandboxed: false });
      expect(result.stderr).toContain("沙箱未启用");
      expect(result.jobId).toBeUndefined();
    }
  });
  it("普通读命令也不能降级", async () => {
    const result = await run(background, "echo boundary-control");
    expect(result.exitCode).toBe(-1);
    expect(state.spawns).toBe(0);
  });
  it("full 和 allow_all 保持显式直跑", async () => {
    state.level = "full";
    const full = await run(background);
    expect(full.sandboxed).toBe(false);
    if (!background) expect(full.exitCode).toBe(0);
    const fullOutput = fs.readFileSync(path.join(state.root, "output.txt"));
    expect(fullOutput.toString("utf8").replace(/\r/g, ""), `output hex: ${fullOutput.toString("hex")}`).toBe("a\nz\n");
    fs.unlinkSync(path.join(state.root, "output.txt"));
    state.level = "read-only";
    const override = await run(background, undefined, "allow_all");
    expect(override.sandboxed).toBe(false);
    if (!background) expect(override.exitCode).toBe(0);
    const overrideOutput = fs.readFileSync(path.join(state.root, "output.txt"));
    expect(overrideOutput.toString("utf8").replace(/\r/g, ""), `output hex: ${overrideOutput.toString("hex")}`).toBe("a\nz\n");
    expect(state.spawns).toBe(2);
  });
  it("宿主启动脚本、函数、PATH 与当前目录污染不进入真实前后台进程", async () => {
    const hostBin = path.join(state.root, "fake-host-bin");
    fs.mkdirSync(hostBin);
    const startup = path.join(state.root, "fake-bash-env");
    const marker = path.join(state.root, "host-startup-marker");
    const commandMarker = path.join(state.root, "host-command-marker");
    const quote = (value: string) => "'" + value.replace(/'/g, "'\\''") + "'";
    fs.writeFileSync(startup, `printf contaminated > ${quote(marker)}\n`);
    const fakeCommand = process.platform === "win32"
      ? `@echo contaminated>"${commandMarker}"\r\n@exit /b 0\r\n`
      : `#!/bin/sh\nprintf contaminated > ${quote(commandMarker)}\n`;
    for (const directory of [hostBin, state.root]) {
      fs.writeFileSync(path.join(directory, process.platform === "win32" ? "sort.cmd" : "sort"), fakeCommand, { mode: 0o755 });
    }
    const fakeShell = path.join(hostBin, process.platform === "win32" ? "cmd.cmd" : "bash");
    fs.writeFileSync(fakeShell, fakeCommand, { mode: 0o755 });
    // 仅用本例自建脚本证明污染触发器有效，绝不执行真实宿主启动文件。
    const poisoned: NodeJS.ProcessEnv = { ...fixtureEnvironment(), BASH_ENV: startup, PATH: hostBin, PATHEXT: ".CMD;.EXE" };
    delete poisoned.NoDefaultCurrentDirectoryInExePath;
    const control = nativeSpawn(shellExecutable, process.platform === "win32"
      ? ["/d", "/s", "/c", "sort"] : ["--noprofile", "--norc", "-lc", "sort"],
    { cwd: state.root, env: poisoned, shell: false, windowsVerbatimArguments: process.platform === "win32", stdio: "ignore" });
    expect(await new Promise<number | null>((resolve, reject) => {
      control.once("error", reject);
      control.once("close", resolve);
    })).toBe(0);
    expect(fs.readFileSync(commandMarker, "utf8").trim()).toBe("contaminated");
    fs.unlinkSync(commandMarker);
    if (process.platform !== "win32") {
      expect(fs.readFileSync(marker, "utf8")).toBe("contaminated");
      fs.unlinkSync(marker);
    }
    vi.stubEnv("BASH_ENV", startup);
    vi.stubEnv("ENV", startup);
    vi.stubEnv("BASH_FUNC_sort%%", `() { printf contaminated > ${quote(commandMarker)}; }`);
    vi.stubEnv("PATH", hostBin);
    vi.stubEnv("PATHEXT", ".CMD;.EXE");
    vi.stubEnv("ComSpec", fakeShell);
    vi.stubEnv("SystemRoot", hostBin);
    vi.stubEnv("WINDIR", hostBin);
    vi.stubEnv("NoDefaultCurrentDirectoryInExePath", "");

    // 先走拒绝路径，再验证 full / allow_all 的实际排序执行与输出都保持。
    expect((await run(background)).exitCode).toBe(-1);
    expect(state.spawns).toBe(0);
    for (const permissionMode of [undefined, "allow_all"] as const) {
      state.level = permissionMode ? "read-only" : "full";
      const result = await run(background, undefined, permissionMode);
      expect(result.sandboxed).toBe(false);
      if (!background) expect(result.exitCode).toBe(0);
      expect(fs.readFileSync(path.join(state.root, "output.txt"), "utf8").replace(/\r/g, "")).toBe("a\nz\n");
      fs.unlinkSync(path.join(state.root, "output.txt"));
      expect(fs.existsSync(marker)).toBe(false);
      expect(fs.existsSync(commandMarker)).toBe(false);
    }
    expect(state.spawns).toBe(2);
  });
  it("伪装成 echo 的工作区脚本也不能降级", async () => {
    const script = process.platform === "win32" ? "echo.cmd" : "echo.sh";
    fs.writeFileSync(path.join(state.root, script), process.platform === "win32"
      ? "@echo marker>output.txt\r\n" : "#!/bin/sh\nprintf marker > output.txt\n", { mode: 0o755 });
    const result = await run(background, process.platform === "win32" ? ".\\echo.cmd" : "./echo.sh");
    expect(result).toMatchObject({ exitCode: -1, effect: "read" });
    expect(state.spawns).toBe(0);
    expect(fs.existsSync(path.join(state.root, "output.txt"))).toBe(false);
  });
  });
});

it.runIf(process.platform !== "win32")("非 Windows 未设置禁用开关时也拒绝受限执行", async () => {
  vi.stubEnv("CYRENE_SRT", "1");
  await sandbox.initSandbox();
  for (const background of [false, true]) {
    const result = await run(background);
    expect(result.exitCode).toBe(-1);
    expect(state.spawns).toBe(0);
    expect(fs.existsSync(path.join(state.root, "output.txt"))).toBe(false);
  }
});
