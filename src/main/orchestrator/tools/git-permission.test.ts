import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const fixture = vi.hoisted(() => ({
  root: "",
  send: vi.fn(),
  llm: vi.fn(),
  spawn: vi.fn(),
  planReadOnly: false,
  handlers: new Map<string, (...args: any[]) => unknown>(),
}));
vi.mock("electron", () => ({
  app: { getPath: () => fixture.root },
  BrowserWindow: { getAllWindows: () => [{ webContents: { send: fixture.send } }] },
  ipcMain: { handle: (channel: string, handler: (...args: any[]) => unknown) => fixture.handlers.set(channel, handler) },
}));
vi.mock("../plan-mode", () => ({ isPlanReadOnly: () => fixture.planReadOnly }));
vi.mock("../harness/harness-llm", () => ({ callLLM: (...args: unknown[]) => fixture.llm(...args), summarizeHistory: vi.fn() }));
vi.mock("../vendors", () => ({ getAdapterForConfig: () => ({ id: "test", transport: "openai" }) }));
vi.mock("child_process", async original => {
  const actual = await original<typeof import("child_process")>();
  return { ...actual, spawn: (...args: Parameters<typeof actual.spawn>) => {
    fixture.spawn(...args);
    return actual.spawn(...args);
  } };
});
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
import { runCyreneHarness } from "../harness/cyrene-harness";
import type { HarnessEvent } from "../harness/types";
import type { ToolDefinition } from "./registry/tool-registry";
import { runShellTool } from "./builtin-tools/run-shell-tool";
import { initSandbox } from "../sandbox/sandbox-exec";
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
  fixture.llm.mockReset();
  fixture.spawn.mockClear();
  fixture.planReadOnly = false;
});
afterEach(() => {
  try {
    controller?.abort();
    for (const [id] of mutations) toolRegistry.unregister(id);
    toolRegistry.unregister("run_shell");
    toolRegistry.unregister("other_input_control");
    vi.unstubAllEnvs();
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
    const allowed = await runtime.checkPermission(tool.id, args) === true;
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
      const allowed = await runtime.checkPermission(tool.id, args) === true;
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

/** 只替换模型网络调用；权限宿主、适配层、Harness 调度、模型历史和 UI 事件均走真实实现。 */
async function harnessObservation(tool: ToolDefinition, args: Record<string, unknown>, allowPermissionPrompt = true) {
  toolRegistry.register(tool);
  const runtime = await prepareToolRuntime({
    options: { conversationId: "code-session", conversationMode: "code", messages: [],
      resolvedWorkspaceRoot: fixture.root, allowPermissionPrompt } as never,
    signal: controller!.signal,
    prepared: { threadId: "code-session", runId: "git-run", tools: [tool] } as never,
    sendBaseEvent: vi.fn(),
  });
  const call = { id: "permission-call", name: tool.id, arguments: JSON.stringify(args) };
  fixture.llm.mockResolvedValueOnce({
    assistantMessage: { role: "assistant", content: "", toolCalls: [call] },
    text: "", toolCalls: [call], finishReason: "tool_calls", raw: {},
  }).mockResolvedValueOnce({
    assistantMessage: { role: "assistant", content: "done" }, text: "done", toolCalls: [], finishReason: "stop", raw: {},
  });
  const events: HarnessEvent[] = [];
  await runCyreneHarness({
    systemPrompt: "test", messages: [{ role: "user", content: "test" }], tools: [tool],
    vendorConfig: { model: "test", baseUrl: "https://test.invalid", apiKey: "test" } as never,
    runId: "git-run", signal: controller!.signal, config: { maxRounds: 2 }, includeInteractiveTools: false,
    toolContext: runtime.toolContext, checkPermission: runtime.checkPermission, onEvent: event => events.push(event),
  });
  expect(fixture.llm).toHaveBeenCalledTimes(2);
  const messages = fixture.llm.mock.calls[1][2] as Array<{ role: string; content: string }>;
  const observation = JSON.parse(messages.find(message => message.role === "tool")!.content);
  const toolEnd = events.find(event => event.type === "tool_end");
  if (toolEnd?.type !== "tool_end") throw new Error("缺少真实工具卡片完成事件");
  return { observation, toolEnd };
}

function answerApproval(allowed: boolean) {
  fixture.send.mockImplementation((channel, payload) => {
    if (channel === IPC.PERMISSION_APPROVAL_REQUEST) {
      queueMicrotask(() => fixture.handlers.get(IPC.PERMISSION_APPROVAL_RESOLVE)!(null, { id: payload.id, allowed }));
    }
  });
}

describe("真实 Harness 拒绝原因到模型与用户的完整链路", () => {
  it.each(mutations)("scoped %s 给出逐次审批建议且不虚构面板能力", async (id, method, args) => {
    setCurrentLevel("scoped");
    const execute = vi.fn(async () => "must not execute");
    const tool = createCodeGitTools({ [method]: execute } as unknown as GitService).find(item => item.id === id)!;
    const privateArgs = { ...args, privateNote: "PRIVATE_ARGUMENT_SENTINEL", workspaceRoot: "/PRIVATE_WORKSPACE_SENTINEL" };
    const { observation, toolEnd } = await harnessObservation(tool, privateArgs);
    expect(observation).toMatchObject({ outcome: "failure", category: "permission_denied" });
    expect(observation.message).toContain("hooks/filters");
    expect(observation.message).toContain("每次审批");
    expect(observation.message).not.toMatch(/完全访问|full|PRIVATE_|permission-call/);
    expect(toolEnd).toMatchObject({ outcome: "failure", preview: observation.message });
    if (id === "git_revert" || id === "git_init") expect(observation.message).not.toContain("Git 面板");
    else expect(observation.message).toContain("Git 面板可用时");
    expect(execute).not.toHaveBeenCalled();
    expect(fixture.send).not.toHaveBeenCalledWith(IPC.PERMISSION_APPROVAL_REQUEST, expect.anything());
  });

  it.each(["plan", "read-only", "user-refused", "background", "other-tool"] as const)("%s 保留原来的拒绝策略和通用提示", async reason => {
    const execute = vi.fn(async () => "must not execute");
    let tool = createCodeGitTools({ commit: execute } as unknown as GitService).find(item => item.id === "git_commit")!;
    setCurrentLevel(reason === "user-refused" || reason === "background" ? "per-action" : reason === "read-only" ? "read-only" : "scoped");
    fixture.planReadOnly = reason === "plan";
    if (reason === "user-refused") answerApproval(false);
    if (reason === "other-tool") tool = { ...tool, id: "other_input_control", execute };
    const { observation, toolEnd } = await harnessObservation(tool, { message: "test", paths: ["file.txt"] }, reason !== "background");
    expect(observation).toMatchObject({ outcome: "failure", category: "permission_denied", message: `工具 "${tool.id}" 被权限系统拒绝` });
    expect(toolEnd.preview).toBe(observation.message);
    expect(execute).not.toHaveBeenCalled();
    if (reason !== "user-refused") expect(fixture.send).not.toHaveBeenCalledWith(IPC.PERMISSION_APPROVAL_REQUEST, expect.anything());
  });

  it.each([false, true])("per-action 已批准也不能绕过 disabled 沙箱（background=%s）", async background => {
    setCurrentLevel("per-action");
    vi.stubEnv("CYRENE_SRT", "0");
    await initSandbox();
    answerApproval(true);
    const { observation, toolEnd } = await harnessObservation(runShellTool, {
      command: "sort /O PRIVATE_OUTPUT.txt PRIVATE_INPUT.txt", cwd: fixture.root, run_in_background: background,
    });
    expect(observation).toMatchObject({ outcome: "failure", category: "permission_denied" });
    const specs = fixture.llm.mock.calls[0][3] as Array<{ name: string; description: string }>;
    const description = specs.find(spec => spec.name === "run_shell")!.description;
    expect(description).toContain("前后台所有命令（包括只读命令）");
    expect(description).toContain("逐次批准不等于绕过已禁用的沙箱");
    expect(observation.message).toContain("沙箱未启用");
    expect(observation.message).toContain("包括只读命令");
    expect(observation.message).toContain("单次批准也不能绕过");
    expect(observation.message).toContain(process.platform === "win32" ? "已禁用的沙箱" : "当前平台尚不支持");
    expect(observation.message).not.toMatch(/PRIVATE_|完全访问|full/);
    expect(toolEnd).toMatchObject({ outcome: "failure", preview: observation.message });
    expect(fixture.spawn).not.toHaveBeenCalled();
    expect(fs.existsSync(path.join(fixture.root, "PRIVATE_OUTPUT.txt"))).toBe(false);
    expect(fixture.send).toHaveBeenCalledWith(IPC.PERMISSION_APPROVAL_REQUEST, expect.anything());
  });
});
