// sandbox-exec 单元测试。
//
// 模块内部持有单例状态（SRT 模块句柄、就绪标记、会话缓存），因此每个用例前
// vi.resetModules() + 动态 import 重新加载一份干净的实例；
// SRT 依赖通过 vi.mock("@anthropic-ai/sandbox-runtime") 替身控制。
// 注意：vitest 会把 mock 工厂结果缓存整个文件（vi.resetModules 不会重跑工厂），
// 因此工厂必须永不抛错；mock 函数放在 vi.hoisted 里共享，
// init 阶段的故障路径用 checkStatus 抛错来覆盖同一个 catch 分支。

import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { resolveSandboxSessionFilesystem } from "./sandbox-exec";

// ── 可控的 mock 状态（vi.hoisted：vi.mock 工厂里可引用） ──

const mocks = vi.hoisted(() => ({
  resolveSrtWin: vi.fn(),
  checkStatus: vi.fn(),
  install: vi.fn(),
  initialize: vi.fn(),
  reset: vi.fn(),
  wrapArgv: vi.fn(),
}));

const permState = vi.hoisted(() => ({
  level: "read-only" as "project-read-only" | "read-only" | "scoped" | "per-action" | "full",
}));

// SRT 替身的 VENDORED_SRT_WIN_EXE 路径。工厂里不能引用顶层 import（如 path），
// 所以用 getter 在运行期读取；路径在模块体里用真实 path.sep 拼好注入，
// 保证 toUnpackedSrtWinPath 的 asar 重写在不同平台上都成立。
const srtState = vi.hoisted(() => ({ vendoredExe: "" }));

vi.mock("../../logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  LogTag: { Runtime: "Runtime" },
}));

vi.mock("../../permission", () => ({
  getCurrentLevel: () => permState.level,
}));

vi.mock("@anthropic-ai/sandbox-runtime", () => ({
  get VENDORED_SRT_WIN_EXE() {
    return srtState.vendoredExe;
  },
  resolveSrtWin: mocks.resolveSrtWin,
  checkWindowsSandboxStatusAsync: mocks.checkStatus,
  installWindowsSandboxAsync: mocks.install,
  SandboxManager: {
    initialize: mocks.initialize,
    reset: mocks.reset,
    wrapWithSandboxArgv: mocks.wrapArgv,
  },
}));

srtState.vendoredExe = ["C:", "cyrene", "app.asar", "vendor", "srt-win.exe"].join(path.sep);

// ── 测试基础设施 ──

type SandboxModule = typeof import("./sandbox-exec");
let sb: SandboxModule;

const origPlatform = Object.getOwnPropertyDescriptor(process, "platform");
const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cyrene-sandbox-test-"));
  tempDirs.push(dir);
  return dir;
}

beforeEach(async () => {
  // 沙箱模块有模块级单例，每个用例重新加载
  vi.resetModules();
  Object.defineProperty(process, "platform", { value: "win32", configurable: true });

  permState.level = "read-only";

  mocks.resolveSrtWin
    .mockReset()
    .mockImplementation(({ path: p }: { path: string }) => ({ exe: p, prependArgs: ["--srt-win"] }));
  mocks.checkStatus
    .mockReset()
    .mockResolvedValue({ user: { provisioned: true, sid: "S-1-5-21" }, wfp: { state: "active" } });
  mocks.install
    .mockReset()
    .mockResolvedValue({ user: { provisioned: true }, wfp: { state: "active" } });
  mocks.initialize.mockReset().mockResolvedValue(undefined);
  mocks.reset.mockReset().mockResolvedValue(undefined);
  mocks.wrapArgv.mockReset().mockResolvedValue({
    argv: ["srt-win.exe", "--srt-win", "--", "cmd.exe", "/c", "echo hi"],
    env: { CYRENE_SANDBOX: "1" },
  });

  sb = await import("./sandbox-exec");
});

afterEach(() => {
  if (origPlatform) Object.defineProperty(process, "platform", origPlatform);
  delete process.env.CYRENE_SRT;
});

afterAll(() => {
  for (const dir of tempDirs) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      // 清理失败不影响测试结果
    }
  }
});

// ── 纯函数：会话级 fs 授权 ──────────────────────────────

describe("resolveSandboxSessionFilesystem", () => {
  it("limits scoped Windows grants to the active workspace instead of the app or home directory", () => {
    expect(resolveSandboxSessionFilesystem("scoped", "E:\\user-workspace")).toEqual({
      allowWrite: ["E:\\user-workspace"],
      denyRead: [],
      denyWrite: [],
    });
  });

  it("keeps project-read-only session access read-only at the project root", () => {
    expect(resolveSandboxSessionFilesystem("project-read-only", "E:\\user-workspace")).toEqual({
      allowRead: ["E:\\user-workspace"],
      allowWrite: [],
      denyRead: [],
      denyWrite: [],
    });
  });

  it("grants an approved action only to its active workspace", () => {
    expect(resolveSandboxSessionFilesystem("per-action", "E:\\user-workspace")).toEqual({
      allowWrite: ["E:\\user-workspace"],
      denyRead: [],
      denyWrite: [],
    });
  });

  it("read-only 档：不授予任何读写授权", () => {
    expect(resolveSandboxSessionFilesystem("read-only", "E:\\user-workspace")).toEqual({
      allowWrite: [],
      denyRead: [],
      denyWrite: [],
    });
  });

  it("full 档：整个文件系统配置停用", () => {
    expect(resolveSandboxSessionFilesystem("full", "E:\\user-workspace")).toEqual({
      allowWrite: [],
      denyRead: [],
      denyWrite: [],
      disabled: true,
    });
  });
});

// ── initSandbox：启动检测 ────────────────────────────────

describe("initSandbox", () => {
  it("非 Windows 平台 → 跳过初始化，wrap 返回 disabled", async () => {
    Object.defineProperty(process, "platform", { value: "linux", configurable: true });

    await sb.initSandbox();

    expect(sb.isSandboxReady()).toBe(false);
    expect(mocks.resolveSrtWin).not.toHaveBeenCalled();
    await expect(sb.wrapWithSandbox("ls")).resolves.toMatchObject({ ok: false, reason: "disabled" });
  });

  it.each(["0", "false"])("CYRENE_SRT=%s → 沙箱被禁用，不加载 SRT", async (value) => {
    process.env.CYRENE_SRT = value;

    await sb.initSandbox();

    expect(sb.isSandboxReady()).toBe(false);
    expect(mocks.resolveSrtWin).not.toHaveBeenCalled();
    await expect(sb.wrapWithSandbox("echo hi", makeTempDir())).resolves.toMatchObject({
      ok: false,
      reason: "disabled",
    });
  });

  it("init 阶段出错（SRT 加载/状态检测失败）→ 不伪装成显式禁用，wrap 保持 not_ready（fail-closed）", async () => {
    mocks.checkStatus.mockRejectedValue(new Error("srt load failed"));

    await sb.initSandbox();

    // 模块已加载、未被禁用：isSandboxReady 仍允许尝试执行
    expect(sb.isSandboxReady()).toBe(true);
    await expect(sb.wrapWithSandbox("echo hi", makeTempDir())).resolves.toMatchObject({
      ok: false,
      reason: "not_ready",
    });
  });

  it("未 provisioned → 启动时不安装（避免 UAC 弹窗），但模块已就绪等待 lazy install", async () => {
    mocks.checkStatus.mockResolvedValue({ user: { provisioned: false }, wfp: { state: "absent" } });

    await sb.initSandbox();

    expect(mocks.install).not.toHaveBeenCalled();
    expect(sb.isSandboxReady()).toBe(true);
  });

  it("重复调用 initSandbox 幂等（状态只探测一次）", async () => {
    await sb.initSandbox();
    await sb.initSandbox();

    expect(mocks.checkStatus).toHaveBeenCalledTimes(1);
  });

  it("打包后 srt-win 路径从 app.asar 重写到 app.asar.unpacked", async () => {
    await sb.initSandbox();

    expect(mocks.resolveSrtWin).toHaveBeenCalledWith({
      path: ["C:", "cyrene", "app.asar.unpacked", "vendor", "srt-win.exe"].join(path.sep),
    });
  });
});

// ── wrapWithSandbox：档位路由与会话管理 ──────────────────

describe("wrapWithSandbox 档位路由", () => {
  it("read-only 档成功 wrap：会话授权为空、per-call 只带 deny 骨架", async () => {
    await sb.initSandbox();
    const cwd = makeTempDir();

    const r = await sb.wrapWithSandbox("git status", cwd);

    expect(r).toEqual({
      ok: true,
      argv: ["srt-win.exe", "--srt-win", "--", "cmd.exe", "/c", "echo hi"],
      env: { CYRENE_SANDBOX: "1" },
    });
    // 会话初始化：read-only 不授予任何写权限
    expect(mocks.initialize).toHaveBeenCalledWith(
      expect.objectContaining({
        filesystem: { allowWrite: [], denyRead: [], denyWrite: [] },
        windows: { srtWin: { path: expect.stringContaining("app.asar.unpacked") } },
      }),
    );
    // per-call 配置：不追加授权，仅 deny 骨架
    expect(mocks.wrapArgv).toHaveBeenCalledWith(
      "git status",
      undefined,
      { filesystem: { denyRead: [], denyWrite: [] } },
      undefined,
      cwd,
      undefined,
    );
    expect(sb.isSandboxReady()).toBe(true);
  });

  it("scoped 档：会话 allowWrite 限定工作区，per-call 不追加写授权", async () => {
    permState.level = "scoped";
    await sb.initSandbox();
    const cwd = makeTempDir();

    const r = await sb.wrapWithSandbox("npm test", cwd);

    expect(r.ok).toBe(true);
    expect(mocks.initialize).toHaveBeenCalledWith(
      expect.objectContaining({
        filesystem: { allowWrite: [cwd], denyRead: [], denyWrite: [] },
      }),
    );
    expect(mocks.wrapArgv).toHaveBeenCalledWith(
      "npm test",
      undefined,
      { filesystem: { denyRead: [], denyWrite: [] } },
      undefined,
      cwd,
      undefined,
    );
  });

  it("per-action 档：会话仍授权工作区写入，per-call fs 放行（用户已审批）", async () => {
    permState.level = "per-action";
    await sb.initSandbox();
    const cwd = makeTempDir();

    const r = await sb.wrapWithSandbox("rmdir dist", cwd);

    expect(r.ok).toBe(true);
    expect(mocks.initialize).toHaveBeenCalledWith(
      expect.objectContaining({
        filesystem: { allowWrite: [cwd], denyRead: [], denyWrite: [] },
      }),
    );
    expect(mocks.wrapArgv).toHaveBeenCalledWith(
      "rmdir dist",
      undefined,
      { filesystem: { disabled: true } },
      undefined,
      cwd,
      undefined,
    );
  });

  it("project-read-only 档：从子目录向上探测项目根，allowRead 限定在项目根", async () => {
    permState.level = "project-read-only";
    await sb.initSandbox();
    const root = makeTempDir();
    const nested = path.join(root, "pkg", "sub");
    fs.mkdirSync(nested, { recursive: true });
    fs.mkdirSync(path.join(root, ".git"));

    const r = await sb.wrapWithSandbox("git log", nested);

    expect(r.ok).toBe(true);
    expect(mocks.initialize).toHaveBeenCalledWith(
      expect.objectContaining({
        filesystem: { allowRead: [root], allowWrite: [], denyRead: [], denyWrite: [] },
      }),
    );
  });

  it("full 档 → 不走沙箱，直接返回 disabled 且不触碰 SRT", async () => {
    permState.level = "full";
    await sb.initSandbox();

    const r = await sb.wrapWithSandbox("del /s *", makeTempDir());

    expect(r).toEqual({ ok: false, reason: "disabled", detail: "full level" });
    expect(mocks.initialize).not.toHaveBeenCalled();
    expect(mocks.wrapArgv).not.toHaveBeenCalled();
  });

  it("binShell 参数透传给 SRT（Bash 模式）", async () => {
    await sb.initSandbox();
    const cwd = makeTempDir();
    const bash = "C:\\Program Files\\Git\\bin\\bash.exe";

    const r = await sb.wrapWithSandbox("ls -la", cwd, bash);

    expect(r.ok).toBe(true);
    expect(mocks.wrapArgv).toHaveBeenCalledWith("ls -la", bash, expect.anything(), undefined, cwd, undefined);
  });
});

describe("wrapWithSandbox 会话管理", () => {
  it("同一 cwd + 档位重复 wrap → 命中会话缓存，不重复初始化", async () => {
    await sb.initSandbox();
    const cwd = makeTempDir();

    await sb.wrapWithSandbox("echo 1", cwd);
    await sb.wrapWithSandbox("echo 2", cwd);

    expect(mocks.initialize).toHaveBeenCalledTimes(1);
    // init 探测 1 次 + 首次 ensure 探测 1 次；第二次 wrap 命中会话 fast path 不再探测
    expect(mocks.checkStatus).toHaveBeenCalledTimes(2);
    expect(mocks.wrapArgv).toHaveBeenCalledTimes(2);
  });

  it("cwd 变化 → 会话失效，reset 后按新工作区重新初始化", async () => {
    await sb.initSandbox();
    const cwdA = makeTempDir();
    const cwdB = makeTempDir();

    await sb.wrapWithSandbox("echo a", cwdA);
    await sb.wrapWithSandbox("echo b", cwdB);

    expect(mocks.reset).toHaveBeenCalledTimes(1);
    expect(mocks.initialize).toHaveBeenCalledTimes(2);
  });

  it("档位变化 → 会话失效，按新档位重新授权", async () => {
    await sb.initSandbox();
    const cwd = makeTempDir();

    await sb.wrapWithSandbox("echo a", cwd);
    permState.level = "scoped";
    await sb.wrapWithSandbox("echo b", cwd);

    expect(mocks.initialize).toHaveBeenCalledTimes(2);
    expect(mocks.reset).toHaveBeenCalledTimes(1);
    expect(mocks.initialize).toHaveBeenLastCalledWith(
      expect.objectContaining({
        filesystem: { allowWrite: [cwd], denyRead: [], denyWrite: [] },
      }),
    );
  });
});

// ── wrapWithSandbox：失败路径 ────────────────────────────

describe("wrapWithSandbox 失败路径", () => {
  it("SRT 未加载（未 init）→ not_ready", async () => {
    const r = await sb.wrapWithSandbox("echo hi", makeTempDir());

    expect(r).toMatchObject({ ok: false, reason: "not_ready" });
    expect(mocks.wrapArgv).not.toHaveBeenCalled();
  });

  it("SRT wrap 抛错 → wrap_failed 并带回错误信息", async () => {
    await sb.initSandbox();
    mocks.wrapArgv.mockRejectedValueOnce(new Error("sandbox exploded"));

    const r = await sb.wrapWithSandbox("boom", makeTempDir());

    expect(r).toEqual({ ok: false, reason: "wrap_failed", detail: "sandbox exploded" });
  });

  it("SRT wrap 返回空 argv → wrap_failed", async () => {
    await sb.initSandbox();
    mocks.wrapArgv.mockResolvedValueOnce({ argv: [], env: {} });

    const r = await sb.wrapWithSandbox("empty", makeTempDir());

    expect(r).toEqual({ ok: false, reason: "wrap_failed", detail: "empty argv" });
  });

  it("就绪检查持续抛错 → 一直 not_ready（fail-closed），连续失败达到上限后停止重试", async () => {
    await sb.initSandbox();
    mocks.checkStatus.mockRejectedValue(new Error("wfp query failed"));
    const cwd = makeTempDir();

    // 前 3 次每次都会重试就绪检查
    for (let i = 0; i < 3; i++) {
      const r = await sb.wrapWithSandbox(`echo ${i}`, cwd);
      expect(r).toMatchObject({ ok: false, reason: "not_ready" });
    }
    // init 探测 1 次 + 3 次 ensure 重试
    expect(mocks.checkStatus).toHaveBeenCalledTimes(4);

    // 第 4 次：达到失败上限，不再重试（checkStatus 不再被调用），但仍返回 not_ready
    const r4 = await sb.wrapWithSandbox("echo 4", cwd);
    expect(r4).toMatchObject({ ok: false, reason: "not_ready" });
    expect(mocks.checkStatus).toHaveBeenCalledTimes(4);
    // 故障不等于显式禁用：沙箱仍处于"可尝试"状态，不会降级成 disabled
    expect(sb.isSandboxReady()).toBe(true);
  });

  it("连续失败达到上限后，更换工作区会恢复重试预算", async () => {
    await sb.initSandbox();
    mocks.checkStatus.mockRejectedValue(new Error("wfp query failed"));
    const cwdA = makeTempDir();

    for (let i = 0; i < 3; i++) {
      await sb.wrapWithSandbox(`echo ${i}`, cwdA);
    }
    // 预算耗尽后再试一次：不会发起 checkStatus
    await sb.wrapWithSandbox("echo again", cwdA);
    expect(mocks.checkStatus).toHaveBeenCalledTimes(4);

    // 换工作区 → 预算恢复，恢复正常执行
    mocks.checkStatus.mockResolvedValue({ user: { provisioned: true }, wfp: { state: "active" } });
    const cwdB = makeTempDir();
    const r = await sb.wrapWithSandbox("echo b", cwdB);
    expect(r.ok).toBe(true);
    expect(mocks.checkStatus).toHaveBeenCalledTimes(5);
    expect(mocks.initialize).toHaveBeenCalledTimes(1);
  });

  it("UAC 取消不计入失败退避：连续取消多次后仍会重试安装", async () => {
    mocks.checkStatus.mockResolvedValue({ user: { provisioned: false }, wfp: { state: "absent" } });
    await sb.initSandbox();
    const cwd = makeTempDir();

    // 连续取消 3 次（达到失败上限次数，但取消不算失败）
    for (let i = 0; i < 3; i++) {
      mocks.install.mockResolvedValueOnce({ cancelled: true });
      const r = await sb.wrapWithSandbox(`echo ${i}`, cwd);
      expect(r).toMatchObject({ ok: false, reason: "not_ready" });
    }

    // 第 4 次安装成功 → 正常入沙箱执行
    mocks.install.mockResolvedValueOnce({ user: { provisioned: true }, wfp: { state: "active" } });
    const r = await sb.wrapWithSandbox("echo ok", cwd);
    expect(r.ok).toBe(true);
    expect(mocks.install).toHaveBeenCalledTimes(4);
  });

  it("未 provisioned 且用户取消 UAC → not_ready 但不永久禁用，下次重试安装", async () => {
    mocks.checkStatus.mockResolvedValue({ user: { provisioned: false }, wfp: { state: "absent" } });
    await sb.initSandbox();
    const cwd = makeTempDir();

    mocks.install.mockResolvedValueOnce({ cancelled: true });
    const r1 = await sb.wrapWithSandbox("echo 1", cwd);
    expect(r1).toMatchObject({ ok: false, reason: "not_ready" });
    expect(mocks.install).toHaveBeenCalledTimes(1);

    // 取消不算错误：下一次执行会重新尝试安装并成功
    mocks.install.mockResolvedValueOnce({ user: { provisioned: true }, wfp: { state: "active" } });
    const r2 = await sb.wrapWithSandbox("echo 2", cwd);
    expect(r2.ok).toBe(true);
    expect(mocks.install).toHaveBeenCalledTimes(2);
    expect(mocks.initialize).toHaveBeenCalledTimes(1);
  });
});

// ── resetSandbox：退出兜底 ────────────────────────────────

describe("resetSandbox", () => {
  it("未就绪时是 no-op，不触碰 SRT", async () => {
    await sb.resetSandbox();

    expect(mocks.reset).not.toHaveBeenCalled();
  });

  it("就绪后调用 SandboxManager.reset 释放会话", async () => {
    await sb.initSandbox();
    await sb.wrapWithSandbox("echo hi", makeTempDir());

    await sb.resetSandbox();

    expect(mocks.reset).toHaveBeenCalledTimes(1);
  });

  it("吞掉 SRT reset 异常（退出兜底不抛错）", async () => {
    await sb.initSandbox();
    await sb.wrapWithSandbox("echo hi", makeTempDir());
    mocks.reset.mockRejectedValueOnce(new Error("reset failed"));

    await expect(sb.resetSandbox()).resolves.toBeUndefined();
  });
});
