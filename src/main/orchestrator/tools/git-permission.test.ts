import path from "node:path";
import fs from "node:fs";
import { execFileSync } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const fixture = vi.hoisted(() => ({
  root: "",
  windows: [] as Array<{ webContents: { send: (channel: string, payload: any) => void } }>,
  handlers: new Map<string, (...args: any[]) => unknown>(),
}));
vi.mock("electron", () => ({
  app: { getPath: () => fixture.root },
  BrowserWindow: { getAllWindows: () => fixture.windows },
  ipcMain: { handle: (channel: string, handler: (...args: any[]) => unknown) => fixture.handlers.set(channel, handler) },
}));
vi.mock("../plan-mode", () => ({ isPlanReadOnly: () => false }));
vi.mock("../task-runtime", () => ({ createTaskExecutor: vi.fn(), createTaskCloser: vi.fn() }));
vi.mock("../../tasks/task-session-store", () => ({ getTaskSessionStore: () => ({ listOpenCompanions: async () => [] }) }));
vi.mock("../harness/tool-output/file-tool-output-store", () => ({ FileToolOutputStore: class {} }));
vi.mock("../harness/adapter/event-mapper", () => ({ sendTaskLifecycleAsAgui: vi.fn() }));

import { IPC } from "../../../shared/ipc-channels";
import { createGitService, type GitService } from "../../code-git/git-service";
import { registerCodeGitIpc } from "../../code-git/code-git-ipc";
import { cancelPendingApprovalsForRun, policyFor, registerPermissionIpc, setCurrentLevel } from "../../permission";
import { createCodeGitTools } from "./git-tools";
import { toolRegistry, type ToolDefinition } from "./registry/tool-registry";
import { prepareToolRuntime } from "../harness/adapter/tool-runtime";

const writes = [
  { id: "git_init", method: "initRepository", args: {} },
  { id: "git_commit", method: "commit", args: { message: "fixture commit", paths: ["file.txt"] } },
  { id: "git_switch_branch", method: "switchBranch", args: { branch: "fixture" } },
  { id: "git_push", method: "push", args: {} },
  { id: "git_revert", method: "revert", args: { commit: "1234567" } },
] as const;

let controller: AbortController | undefined;
beforeEach(() => {
  // 权限宿主会真实写配置；每例独占目录，afterEach 恢复档位后删除，避免跨用例残留。
  fixture.root = fs.mkdtempSync(path.join(process.cwd(), ".git-permission-"));
  fixture.windows = [];
  fixture.handlers.clear();
  registerPermissionIpc();
  // 当前运行的信号由 afterEach 取消，再注销工具并回收权限配置。
  controller = new AbortController();
});
afterEach(() => {
  try {
    controller?.abort();
    cancelPendingApprovalsForRun("git-run");
    for (const { id } of writes) toolRegistry.unregister(id);
    setCurrentLevel("read-only");
  } finally {
    vi.unstubAllEnvs();
    if (fixture.root) fs.rmSync(fixture.root, { recursive: true, force: true });
    fixture.root = "";
  }
});

async function runtimeFor(tool: ToolDefinition, workspaceRoot = path.resolve("workspace"), allowPrompt = false) {
  toolRegistry.register(tool);
  return prepareToolRuntime({
    options: { conversationId: "code-session", conversationMode: "code", messages: [], resolvedWorkspaceRoot: workspaceRoot, allowPermissionPrompt: allowPrompt } as never,
    signal: controller!.signal,
    prepared: { threadId: "code-session", runId: "git-run", tools: [tool] } as never,
    sendBaseEvent: vi.fn(),
  });
}

describe.each(writes)("$id 独立于沙箱 Shell 的权限边界", ({ id, method, args }) => {
  it.each([
    ["project-read-only", false], ["read-only", false], ["scoped", false], ["per-action", false], ["full", true],
  ] as const)("%s 通过真实 Harness 权限链决定是否调用 Git 服务", async (level, expected) => {
    const execute = vi.fn(async () => "done");
    const tool = createCodeGitTools({ [method]: execute } as unknown as GitService).find((item) => item.id === id)!;
    setCurrentLevel(level);
    const runtime = await runtimeFor(tool);
    const allowed = await runtime.checkPermission(tool.id, args);
    expect(allowed).toBe(expected);
    expect(policyFor("per-action", tool.risk!)).toBe("ask");
    if (allowed) await tool.execute(args, runtime.toolContext);
    expect(execute).toHaveBeenCalledTimes(expected ? 1 : 0);
  });

  it.each([false, true])("每次审批在用户答复 %s 后才决定执行", async (approved) => {
    const execute = vi.fn(async () => "done");
    const tool = createCodeGitTools({ [method]: execute } as unknown as GitService).find((item) => item.id === id)!;
    const send = vi.fn();
    fixture.windows = [{ webContents: { send } }];
    setCurrentLevel("per-action");
    const runtime = await runtimeFor(tool, undefined, true);
    const pending = runtime.checkPermission(tool.id, args);
    const request = send.mock.calls.find(([channel]) => channel === IPC.PERMISSION_APPROVAL_REQUEST)?.[1];
    expect(request).toMatchObject({ toolId: id, runId: "git-run", args });
    expect(execute).not.toHaveBeenCalled();
    fixture.handlers.get(IPC.PERMISSION_APPROVAL_RESOLVE)!({}, { id: request.id, allowed: approved });
    const allowed = await pending;
    expect(allowed).toBe(approved);
    if (allowed) await tool.execute(args, runtime.toolContext);
    expect(execute).toHaveBeenCalledTimes(approved ? 1 : 0);
  });

  it("显式 allow_all 也不能越过子任务自身的只读契约", async () => {
    const execute = vi.fn(async () => "done");
    const tool = createCodeGitTools({ [method]: execute } as unknown as GitService).find((item) => item.id === id)!;
    await expect(tool.execute(args, {
      userQuery: "", mode: "code", conversationId: "read-only-child", resolvedWorkspaceRoot: path.resolve("workspace"),
      readOnly: true, permissionMode: "allow_all",
    })).rejects.toThrow("只读");
    expect(execute).not.toHaveBeenCalled();
  });
});

function realRepository() {
  const workspaceRoot = path.join(fixture.root, "repo");
  fs.mkdirSync(workspaceRoot);
  const emptyConfig = path.join(fixture.root, "empty-git-config");
  fs.writeFileSync(emptyConfig, "");
  const env: NodeJS.ProcessEnv = { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: emptyConfig, GIT_CONFIG_COUNT: "0", GIT_TERMINAL_PROMPT: "0" };
  // 不继承宿主的 Git 覆盖项（也避免 CLI 的 GIT_PAGER 触发 simple-git 的安全拒绝）。
  for (const key of ["GIT_PAGER", "PAGER", "GIT_CONFIG_PARAMETERS", "GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_OBJECT_DIRECTORY", "GIT_ALTERNATE_OBJECT_DIRECTORIES"]) delete env[key];
  // 系统 Git 与应用一样继承进程环境；仅替换本测试进程的配置位置。
  for (const key of new Set([...Object.keys(process.env), ...Object.keys(env)])) {
    if (process.env[key] !== env[key]) vi.stubEnv(key, env[key]);
  }
  const git = (...args: string[]) => execFileSync("git", args, { cwd: workspaceRoot, env, encoding: "utf8", windowsHide: true });
  git("init", "--quiet", "--template=");
  git("config", "user.name", "Git permission fixture");
  git("config", "user.email", "fixture@example.invalid");
  git("config", "filter.boundary.clean", 'printf "filter ran\\n" > ../filter-marker; cat');
  fs.writeFileSync(path.join(workspaceRoot, ".gitattributes"), "file.txt filter=boundary\n");
  fs.writeFileSync(path.join(workspaceRoot, "file.txt"), "harmless fixture\n");
  fs.mkdirSync(path.join(workspaceRoot, ".git", "hooks"));
  fs.writeFileSync(path.join(workspaceRoot, ".git", "hooks", "pre-commit"), '#!/bin/sh\nprintf "hook ran\\n" > ../hook-marker\n', { mode: 0o755 });
  const service = createGitService({
    getSession: () => ({ mode: "code", workspaceBinding: { workspaceRoot, displayName: "fixture", boundAt: 1 } }),
    resolveExecutable: async () => ({ command: "git", source: "system", version: "fixture" }),
    workspaceWatcher: { subscribe: async () => undefined, unsubscribe: async () => undefined, dispose: async () => undefined },
  });
  return { workspaceRoot, service, git };
}

describe("真实 Git hooks/filter 的目录外副作用", () => {
  it.each([["scoped", false], ["full", true]] as const)("%s 经过 Harness 后的真实提交与副作用", async (level, allowedExpected) => {
    const { workspaceRoot, service, git } = realRepository();
    try {
      const tool = createCodeGitTools(service).find((item) => item.id === "git_commit")!;
      const runtime = await runtimeFor(tool, workspaceRoot);
      const args = { message: "fixture commit", paths: ["file.txt", ".gitattributes"] };
      setCurrentLevel(level);
      const allowed = await runtime.checkPermission(tool.id, args);
      if (allowed) await tool.execute(args, runtime.toolContext);
      // 标记只位于本用例临时目录内，但在被绑定的 repo 之外。
      expect(fs.existsSync(path.join(fixture.root, "hook-marker"))).toBe(allowedExpected);
      expect(fs.existsSync(path.join(fixture.root, "filter-marker"))).toBe(allowedExpected);
      expect(allowed).toBe(allowedExpected);
      if (allowedExpected) expect(git("log", "-1", "--format=%s").trim()).toBe("fixture commit");
    } finally {
      await service.dispose();
    }
  }, 15_000);

  it("用户手动 Git 面板沿会话绑定执行，不受 Agent 档位限制", async () => {
    const { workspaceRoot, service, git } = realRepository();
    const handlers = new Map<string, (...args: any[]) => unknown>();
    registerCodeGitIpc({ ipcMain: { handle: (channel, handler) => handlers.set(channel, handler) }, getWindows: () => [], service });
    setCurrentLevel("scoped");
    try {
      await handlers.get(IPC.CODE_GIT_COMMIT)!({}, {
        sessionId: "code-session", message: "manual commit", paths: ["file.txt", ".gitattributes"],
        workspaceRoot: path.join(fixture.root, "untrusted-model-path"),
      });
      expect(git("log", "-1", "--format=%s").trim()).toBe("manual commit");
      expect(fs.existsSync(path.join(workspaceRoot, ".git"))).toBe(true);
    } finally {
      await service.dispose();
    }
  }, 15_000);
});
