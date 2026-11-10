import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const fixture = vi.hoisted(() => ({
  root: "",
  send: vi.fn(),
  handlers: new Map<string, (...args: any[]) => unknown>(),
}));
vi.mock("electron", () => ({
  app: { getPath: () => fixture.root },
  BrowserWindow: { getAllWindows: () => [{ webContents: { send: fixture.send } }] },
  ipcMain: { handle: (channel: string, handler: (...args: any[]) => unknown) => fixture.handlers.set(channel, handler) },
}));
vi.mock("../plan-mode", () => ({ isPlanReadOnly: () => false }));
vi.mock("../task-runtime", () => ({ createTaskExecutor: vi.fn(), createTaskCloser: vi.fn() }));
vi.mock("../../tasks/task-session-store", () => ({ getTaskSessionStore: () => ({ listOpenCompanions: async () => [] }) }));
vi.mock("../harness/tool-output/file-tool-output-store", () => ({ FileToolOutputStore: class {} }));
vi.mock("../harness/adapter/event-mapper", () => ({ sendTaskLifecycleAsAgui: vi.fn() }));

import { execFileSync } from "node:child_process";
import { IPC } from "../../../shared/ipc-channels";
import type { ChatSession } from "../../../shared/chat-types";
import { createGitService } from "../../code-git/git-service";
import type { GitService } from "../../code-git/git-service";
import { policyFor, registerPermissionIpc, setCurrentLevel } from "../../permission";
import { createCodeGitTools } from "./git-tools";
import { toolRegistry } from "./registry/tool-registry";
import { prepareToolRuntime } from "../harness/adapter/tool-runtime";

const mutations = [
  ["git_init", "initRepository", {}],
  ["git_commit", "commit", { message: "test", paths: ["file.txt"] }],
  ["git_switch_branch", "switchBranch", { branch: "next", create: true }],
  ["git_revert", "revert", { commit: "abcdef0" }],
  ["git_push", "push", {}],
] as const;
registerPermissionIpc();

let controller: AbortController | undefined;
beforeEach(() => {
  // 权限宿主会真实写配置；每例独占目录，afterEach 恢复档位后删除，避免跨用例残留。
  fixture.root = fs.mkdtempSync(path.join(os.tmpdir(), "cyrene-git-permission-"));
  // 当前运行的信号由 afterEach 取消，再注销工具并回收权限配置。
  controller = new AbortController();
  fixture.send.mockReset();
});
afterEach(() => {
  try {
    controller?.abort();
    for (const [id] of mutations) toolRegistry.unregister(id);
    setCurrentLevel("read-only");
  } finally {
    if (fixture.root) fs.rmSync(fixture.root, { recursive: true, force: true });
    fixture.root = "";
  }
});

describe.each(mutations)("%s 独立于沙箱 Shell 的权限边界", (id, method, args) => {
  it.each([
    ["project-read-only", false], ["read-only", false], ["scoped", false], ["per-action", false], ["full", true],
  ] as const)("%s 通过真实 Harness 权限链决定是否调用 Git 服务", async (level, expected) => {
    const push = vi.fn(async () => "pushed");
    const tool = createCodeGitTools({ [method]: push } as unknown as GitService).find((item) => item.id === id)!;
    toolRegistry.register(tool);
    setCurrentLevel(level);
    const runtime = await prepareToolRuntime({
      options: { conversationId: "code-session", conversationMode: "code", messages: [], resolvedWorkspaceRoot: path.resolve("workspace"), allowPermissionPrompt: false } as never,
      signal: controller!.signal,
      prepared: { threadId: "code-session", runId: "git-run", tools: [tool] } as never,
      sendBaseEvent: vi.fn(),
    });
    const allowed = await runtime.checkPermission(tool.id, args);
    expect(allowed).toBe(expected);
    expect(policyFor("per-action", tool.risk!)).toBe("ask");
    if (allowed) await tool.execute(args, runtime.toolContext);
    expect(push).toHaveBeenCalledTimes(expected ? 1 : 0);
  });

  it("显式 allow_all 也不能越过子任务自身的只读契约", async () => {
    const push = vi.fn(async () => "pushed");
    const tool = createCodeGitTools({ [method]: push } as unknown as GitService).find((item) => item.id === id)!;
    await expect(tool.execute(args, {
      userQuery: "", mode: "code", conversationId: "read-only-child", resolvedWorkspaceRoot: path.resolve("workspace"),
      readOnly: true, permissionMode: "allow_all",
    })).rejects.toThrow("只读");
    expect(push).not.toHaveBeenCalled();
  });
});

async function runtimeFor(gitService: GitService) {
  const tool = createCodeGitTools(gitService).find(item => item.id === "git_commit")!;
  toolRegistry.register(tool);
  const runtime = await prepareToolRuntime({
    options: { conversationId: "code-session", conversationMode: "code", messages: [],
      resolvedWorkspaceRoot: path.join(fixture.root, "repo") } as never,
    signal: controller!.signal,
    prepared: { threadId: "code-session", runId: "git-run", tools: [tool] } as never,
    sendBaseEvent: vi.fn(),
  });
  return { tool, runtime };
}

describe.each(["hook", "filter"] as const)("真实 Git %s 权限回归", extension => {
  it.each([
    ["project-read-only", false], ["read-only", false], ["scoped", false],
    ["per-action", false], ["per-action", true], ["full", true],
  ] as const)("%s / approved=%s 在真实权限链前阻断或显式授权扩展", async (level, approved) => {
    const repo = path.join(fixture.root, "repo");
    const marker = path.join(fixture.root, "outside-marker");
    fs.mkdirSync(repo);
    const git = (...args: string[]) => execFileSync("git", args, { cwd: repo, stdio: "pipe" });
    git("init");
    git("config", "user.name", "Boundary Test");
    git("config", "user.email", "boundary@example.invalid");
    fs.writeFileSync(path.join(repo, "file.txt"), "test\n");
    // 扩展仅写测试临时目录；仓库外 marker 证明路径校验无法约束 Git 子进程。
    const script = `#!/bin/sh\nprintf marker > '../outside-marker'\n${extension === "filter" ? "cat\n" : ""}`;
    if (extension === "hook") {
      fs.writeFileSync(path.join(repo, ".git", "hooks", "pre-commit"), script, { mode: 0o755 });
    } else {
      fs.writeFileSync(path.join(repo, "clean-filter.sh"), script, { mode: 0o755 });
      fs.writeFileSync(path.join(repo, ".gitattributes"), "file.txt filter=boundary\n");
      git("config", "filter.boundary.clean", "sh clean-filter.sh");
      git("config", "filter.boundary.required", "true");
    }
    const service = createGitService({
      getSession: () => ({ id: "code-session", mode: "code", workspaceBinding: { workspaceRoot: repo } } as ChatSession),
      resolveExecutable: async () => ({ command: "git", source: "system", version: "test" }),
    });
    try {
      setCurrentLevel(level);
      const { tool, runtime } = await runtimeFor(service);
      fixture.send.mockImplementation((channel, payload) => {
        if (channel === IPC.PERMISSION_APPROVAL_REQUEST) {
          queueMicrotask(() => fixture.handlers.get(IPC.PERMISSION_APPROVAL_RESOLVE)!(null, { id: payload.id, allowed: approved }));
        }
      });
      const args = { message: "boundary", paths: ["file.txt"] };
      const allowed = await runtime.checkPermission(tool.id, args);
      if (allowed) await tool.execute(args, runtime.toolContext);
      expect(fs.existsSync(marker)).toBe(approved);
      expect(allowed).toBe(approved);
      if (level === "per-action") expect(fixture.send).toHaveBeenCalledWith(IPC.PERMISSION_APPROVAL_REQUEST, expect.anything());
      // 用户手动面板沿会话绑定入口执行，受限 Agent 的拒绝不改变面板语义。
      if (!approved) {
        await service.commitForSession("code-session", "manual", ["file.txt"]);
        expect(fs.existsSync(marker)).toBe(true);
      }
    } finally {
      await service.dispose();
    }
  });
});
