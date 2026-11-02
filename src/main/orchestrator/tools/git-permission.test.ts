import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
vi.mock("electron", () => ({
  app: { getPath: () => path.join(process.env.TEMP!, "git-permission") },
  BrowserWindow: { getAllWindows: () => [] },
  ipcMain: { handle: vi.fn() },
}));
vi.mock("../plan-mode", () => ({ isPlanReadOnly: () => false }));
vi.mock("../task-runtime", () => ({ createTaskExecutor: vi.fn(), createTaskCloser: vi.fn() }));
vi.mock("../../tasks/task-session-store", () => ({ getTaskSessionStore: () => ({ listOpenCompanions: async () => [] }) }));
vi.mock("../harness/tool-output/file-tool-output-store", () => ({ FileToolOutputStore: class {} }));
vi.mock("../harness/adapter/event-mapper", () => ({ sendTaskLifecycleAsAgui: vi.fn() }));

import type { GitService } from "../../code-git/git-service";
import { policyFor, setCurrentLevel } from "../../permission";
import { createCodeGitTools } from "./git-tools";
import { toolRegistry } from "./registry/tool-registry";
import { prepareToolRuntime } from "../harness/adapter/tool-runtime";

afterEach(() => { toolRegistry.unregister("git_push"); setCurrentLevel("read-only"); });

describe("Git push 独立于沙箱 Shell 的权限边界", () => {
  it.each([
    ["project-read-only", false], ["read-only", false], ["scoped", false], ["per-action", false], ["full", true],
  ] as const)("%s 通过真实 Harness 权限链决定是否调用 Git 服务", async (level, expected) => {
    const push = vi.fn(async () => "pushed");
    const tool = createCodeGitTools({ push } as unknown as GitService).find((item) => item.id === "git_push")!;
    toolRegistry.register(tool);
    setCurrentLevel(level);
    const runtime = await prepareToolRuntime({
      options: { conversationId: "code-session", conversationMode: "code", messages: [], resolvedWorkspaceRoot: path.resolve("workspace"), allowPermissionPrompt: false } as never,
      signal: new AbortController().signal,
      prepared: { threadId: "code-session", runId: "git-run", tools: [tool] } as never,
      sendBaseEvent: vi.fn(),
    });
    const allowed = await runtime.checkPermission(tool.id, {});
    expect(allowed).toBe(expected);
    expect(policyFor("per-action", tool.risk!)).toBe("ask");
    if (allowed) await tool.execute({}, runtime.toolContext);
    expect(push).toHaveBeenCalledTimes(expected ? 1 : 0);
  });

  it("显式 allow_all 也不能越过子任务自身的只读契约", async () => {
    const push = vi.fn(async () => "pushed");
    const tool = createCodeGitTools({ push } as unknown as GitService).find((item) => item.id === "git_push")!;
    await expect(tool.execute({}, {
      userQuery: "", mode: "code", conversationId: "read-only-child", resolvedWorkspaceRoot: path.resolve("workspace"),
      readOnly: true, permissionMode: "allow_all",
    })).rejects.toThrow("只读");
    expect(push).not.toHaveBeenCalled();
  });
});
