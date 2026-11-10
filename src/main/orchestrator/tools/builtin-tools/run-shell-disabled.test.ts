// 使用真实权限模块、SRT 环境开关与 run_shell 执行路径；仅替换 Electron 宿主目录。
// sort /O 虽被首词分类为 read，仍会写文件，不能成为无隔离执行的依据。
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentFileAccessLevel } from "../../../permission-policy";

const host = vi.hoisted(() => ({ userData: "" }));
const spawnCalls = vi.hoisted(() => [] as string[]);

vi.mock("electron", () => ({
  app: {
    getPath: () => {
      if (!host.userData) throw new Error("test userData not ready");
      return host.userData;
    },
    on: () => {},
  },
  BrowserWindow: { getAllWindows: () => [] },
}));

vi.mock("child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("child_process")>();
  return {
    ...actual,
    spawn: (command: string, args: string[], options: unknown) => {
      spawnCalls.push(command);
      return actual.spawn(command, args, options as never);
    },
  };
});

import { setCurrentLevel } from "../../../permission";
import { initSandbox } from "../../sandbox/sandbox-exec";
import { closeConversationDatabases } from "../../../storage/conversation-database-client";
import { runShellTool } from "./run-shell-tool";
import { disposeAllShellJobs, waitForShellJob } from "./shell-job-manager";

describe.runIf(process.platform === "win32")("run_shell 在显式禁用 SRT 时保持权限边界", () => {
  let root: string;
  let workspace: string;

  beforeAll(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "cyrene-srt-disabled-"));
    host.userData = path.join(root, "profile");
    vi.stubEnv("CYRENE_SRT", "0");
    vi.stubEnv("NODE_NO_WARNINGS", "1");
    await initSandbox();
  });

  beforeEach(() => {
    workspace = fs.mkdtempSync(path.join(root, "workspace-"));
    fs.writeFileSync(path.join(workspace, "input.txt"), "z\r\na\r\n");
    setCurrentLevel("read-only");
    spawnCalls.length = 0;
  });

  afterAll(async () => {
    await disposeAllShellJobs();
    await closeConversationDatabases();
    vi.unstubAllEnvs();
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  });

  const levels: AgentFileAccessLevel[] = ["project-read-only", "read-only", "scoped", "per-action"];

  for (const level of levels) {
    for (const background of [false, true]) {
      it(`${level} ${background ? "后台" : "前台"}拒绝被误判为 read 的真实写文件命令`, async () => {
        setCurrentLevel(level);
        const result = JSON.parse(await runShellTool.execute(
          { command: "sort /O output.txt input.txt", run_in_background: background },
          { resolvedWorkspaceRoot: workspace },
        ));
        expect(result.effect).toBe("read");
        expect(result.exitCode).toBe(-1);
        expect(result.sandboxed).toBe(false);
        expect(result.stderr).toContain("沙箱未启用");
        expect(result.stdout).toBe("");
        expect(result.jobId).toBeUndefined();
        expect(spawnCalls).toHaveLength(0);
        expect(fs.existsSync(path.join(workspace, "output.txt"))).toBe(false);
        expect(fs.existsSync(path.join(host.userData, "shell-jobs"))).toBe(false);
      });
    }
  }

  it("真正的只读命令也不会在无隔离的受限档位静默直跑", async () => {
    const result = JSON.parse(await runShellTool.execute(
      { command: "type input.txt" },
      { resolvedWorkspaceRoot: workspace },
    ));
    expect(result.exitCode).toBe(-1);
    expect(result.stderr).toContain("沙箱未启用");
    expect(spawnCalls).toHaveLength(0);
  });

  it("full 档位仍可直接运行同一命令并生成文件", async () => {
    setCurrentLevel("full");
    const result = JSON.parse(await runShellTool.execute(
      { command: "sort /O output.txt input.txt" },
      { resolvedWorkspaceRoot: workspace },
    ));
    expect(result.exitCode).toBe(0);
    expect(result.sandboxed).toBe(false);
    expect(spawnCalls).toHaveLength(1);
    expect(fs.statSync(path.join(workspace, "output.txt")).size).toBeGreaterThan(0);
  });

  it("allow_all 上下文保持现有直跑语义", async () => {
    const result = JSON.parse(await runShellTool.execute(
      { command: "echo CYRENE_FULL_OK" },
      { permissionMode: "allow_all", resolvedWorkspaceRoot: workspace },
    ));
    expect(result.exitCode).toBe(0);
    expect(result.sandboxed).toBe(false);
    expect(result.stdout).toContain("CYRENE_FULL_OK");
    expect(spawnCalls).toHaveLength(1);
  });

  it("full 后台任务仍可完成并持久化状态", async () => {
    setCurrentLevel("full");
    const result = JSON.parse(await runShellTool.execute(
      { command: "sort /O output.txt input.txt", run_in_background: true },
      { resolvedWorkspaceRoot: workspace },
    ));
    expect(result.jobId).toBeTruthy();
    const job = await waitForShellJob(result.jobId, 5_000);
    expect(job?.status).toBe("exited");
    expect(job?.exitCode).toBe(0);
    expect(fs.statSync(path.join(workspace, "output.txt")).size).toBeGreaterThan(0);
  }, 10_000);
});
