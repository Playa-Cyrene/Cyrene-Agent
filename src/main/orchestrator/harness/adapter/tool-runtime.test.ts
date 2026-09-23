import { beforeEach, describe, expect, it, vi } from "vitest";

const { getById, checkPermission, createTaskExecutor, isPlanReadOnly, taskStore, toolOutputStore } = vi.hoisted(() => ({
  getById: vi.fn(),
  checkPermission: vi.fn(),
  createTaskExecutor: vi.fn(() => ({ execute: vi.fn() })),
  isPlanReadOnly: vi.fn(),
  taskStore: vi.fn(),
  toolOutputStore: vi.fn(),
}));

vi.mock("../../tools/registry/tool-registry", () => ({
  toolRegistry: { getById },
  // 与真实 resolveEffectKind 同语义：无工具 → unknown，否则取静态声明
  resolveEffectKind: (tool: unknown) =>
    (tool as { effectKind?: string } | undefined)?.effectKind ?? "unknown",
}));
vi.mock("../../../permission", () => ({ checkPermission }));
vi.mock("../../plan-mode", () => ({ isPlanReadOnly }));
vi.mock("../../task-runtime", () => ({ createTaskExecutor }));
vi.mock("../../../tasks/task-session-store", () => ({ TaskSessionStore: taskStore }));
vi.mock("../tool-output/file-tool-output-store", () => ({ FileToolOutputStore: toolOutputStore }));
vi.mock("./event-mapper", () => ({ sendTaskLifecycleAsAgui: vi.fn() }));
vi.mock("electron", () => ({ app: { getPath: vi.fn(() => "C:\\cyrene-runtime") } }));

import { prepareToolRuntime } from "./tool-runtime";

/** 构造一次 code 模式 run 的 tool runtime（Plan Guard 生效条件：code/chat + isPlanReadOnly）。 */
function makeRuntime(permissionMode: "prompt" | "allow_all") {
  return prepareToolRuntime({
    options: {
      conversationId: "thread-1",
      conversationMode: "code",
      settings: { provider: "test", baseUrl: "", model: "model", apiKey: "" },
      messages: [{ role: "user", content: "做个计划" }],
      requestUserClarification: vi.fn(async () => ({ answers: [] })),
      permissionMode,
    } as never,
    signal: new AbortController().signal,
    prepared: {
      threadId: "thread-1",
      runId: "run-1",
      systemPrompt: "system",
      vendorConfig: {},
      tools: [],
      runStore: {},
    } as never,
    sendBaseEvent: vi.fn(),
  });
}

describe("harness tool runtime", () => {
  beforeEach(() => {
    getById.mockReset();
    checkPermission.mockReset();
    isPlanReadOnly.mockReset();
    isPlanReadOnly.mockReturnValue(false);
    createTaskExecutor.mockClear();
    checkPermission.mockResolvedValue({ allowed: true });
    getById.mockReturnValue({
      id: "read_file",
      name: "Read File",
      description: "reads a file",
      risk: "safe",
    });
  });

  it("uses one signal for context, permission, and task execution", async () => {
    const controller = new AbortController();
    const clarify = vi.fn(async () => ({ answers: [] }));
    const runtime = prepareToolRuntime({
      options: {
        conversationId: "thread-1",
        conversationMode: "work",
        settings: { provider: "test", baseUrl: "", model: "model", apiKey: "" },
        messages: [{ role: "user", content: "读文件" }],
        requestUserClarification: clarify,
        permissionMode: "prompt",
      } as never,
      signal: controller.signal,
      prepared: {
        threadId: "thread-1",
        runId: "run-1",
        systemPrompt: "system",
        vendorConfig: {},
        tools: [],
        runStore: {},
      } as never,
      sendBaseEvent: vi.fn(),
    });

    expect(runtime.toolContext.signal).toBe(controller.signal);
    await runtime.checkPermission("read_file", { path: "x" });
    expect(checkPermission).toHaveBeenCalledWith(expect.objectContaining({
      runId: "run-1",
      signal: controller.signal,
    }));
    await runtime.taskExecutor;
    expect(createTaskExecutor).toHaveBeenCalledWith(expect.objectContaining({
      parent: expect.objectContaining({ signal: controller.signal }),
    }));
  });

  describe("Plan 只读不变量（先于 allow_all，按 effectKind 判断）", () => {
    beforeEach(() => {
      isPlanReadOnly.mockReturnValue(true);
    });

    it("allow_all 也拦不住 run_verification：契约压过权限档位", async () => {
      getById.mockReturnValue({
        id: "run_verification",
        name: "Run Verification",
        description: "typecheck/test/build/lint",
        effectKind: "verification",
      });
      const runtime = makeRuntime("allow_all");

      expect(await runtime.checkPermission("run_verification", { kind: "test" })).toBe(false);
      expect(checkPermission).not.toHaveBeenCalled();
    });

    it("write_memory（mutation、未声明 risk）被拒——修复按 risk 放行的旧 bug", async () => {
      getById.mockReturnValue({
        id: "write_memory",
        name: "更新记忆",
        description: "write user memory",
        effectKind: "mutation",
      });
      const runtime = makeRuntime("prompt");

      expect(await runtime.checkPermission("write_memory", { layer: "L2", content: "x" })).toBe(false);
      expect(checkPermission).not.toHaveBeenCalled();
    });

    it("run_shell（unknown）被拒——计划阶段有意禁用，git/文件/搜索走专用 read 工具", async () => {
      getById.mockReturnValue({
        id: "run_shell",
        name: "Run Shell",
        description: "run shell command",
        effectKind: "unknown",
      });
      const runtime = makeRuntime("allow_all");

      expect(await runtime.checkPermission("run_shell", { command: "git status" })).toBe(false);
      expect(checkPermission).not.toHaveBeenCalled();
    });

    it("未注册工具（未声明 effectKind 的 MCP/插件工具）被拒——fail-closed", async () => {
      getById.mockReturnValue(undefined);
      const runtime = makeRuntime("prompt");

      expect(await runtime.checkPermission("mcp-test-unknown", {})).toBe(false);
      expect(checkPermission).not.toHaveBeenCalled();
    });

    it("read 工具放行后继续走原权限链：per-action 档位仍会询问", async () => {
      getById.mockReturnValue({
        id: "read_file",
        name: "Read File",
        description: "reads a file",
        effectKind: "read",
      });
      checkPermission.mockResolvedValue({ allowed: false });
      const runtime = makeRuntime("prompt");

      expect(await runtime.checkPermission("read_file", { path: "x" })).toBe(false);
      expect(checkPermission).toHaveBeenCalledTimes(1);
    });

    it("read 工具在 allow_all 下放行且不触发询问", async () => {
      getById.mockReturnValue({
        id: "web_search",
        name: "Web Search",
        description: "search the web",
        effectKind: "read",
      });
      const runtime = makeRuntime("allow_all");

      expect(await runtime.checkPermission("web_search", { query: "x" })).toBe(true);
      expect(checkPermission).not.toHaveBeenCalled();
    });

    it("非 Plan 模式行为不变：allow_all 直接放行全部工具", async () => {
      isPlanReadOnly.mockReturnValue(false);
      getById.mockReturnValue({
        id: "run_verification",
        name: "Run Verification",
        description: "typecheck/test/build/lint",
        effectKind: "verification",
      });
      const runtime = makeRuntime("allow_all");

      expect(await runtime.checkPermission("run_verification", { kind: "test" })).toBe(true);
      expect(checkPermission).not.toHaveBeenCalled();
    });
  });
});
