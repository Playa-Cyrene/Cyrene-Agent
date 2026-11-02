import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const remote = vi.hoisted(() => ({ tools: [] as unknown[], call: vi.fn() }));
vi.mock("electron", () => ({
  app: { getPath: () => path.join(process.env.TEMP!, "mcp-permission") },
  BrowserWindow: { getAllWindows: () => [] },
  ipcMain: { handle: vi.fn() },
}));
vi.mock("@modelcontextprotocol/sdk/client/index.js", () => ({ Client: class {
  async connect() {}
  async close() {}
  async listTools() { return { tools: remote.tools }; }
  callTool = remote.call;
} }));
vi.mock("@modelcontextprotocol/sdk/client/stdio.js", () => ({ StdioClientTransport: class { async close() {} } }));
vi.mock("./plan-mode", () => ({ isPlanReadOnly: () => false }));
vi.mock("./task-runtime", () => ({ createTaskExecutor: vi.fn(), createTaskCloser: vi.fn() }));
vi.mock("../tasks/task-session-store", () => ({ getTaskSessionStore: vi.fn() }));
vi.mock("./harness/tool-output/file-tool-output-store", () => ({ FileToolOutputStore: class {} }));
vi.mock("./harness/adapter/event-mapper", () => ({ sendTaskLifecycleAsAgui: vi.fn() }));

import { connectMcpServer, disconnectMcpServer } from "./mcp-adapter";
import { toolRegistry } from "./tools/registry/tool-registry";
import { prepareToolRuntime } from "./harness/adapter/tool-runtime";
import { policyFor, setCurrentLevel } from "../permission";

beforeEach(() => { remote.call.mockReset().mockResolvedValue({ content: [{ type: "text", text: "ok" }] }); });
afterEach(async () => { await disconnectMcpServer("permission-test"); setCurrentLevel("read-only"); });

describe("MCP 注册到真实 Harness 权限链", () => {
  it.each([
    { name: "无 annotations", annotations: undefined, effectKindOverrides: undefined },
    { name: "第三方只读提示", annotations: { readOnlyHint: true }, effectKindOverrides: undefined },
    { name: "破坏性工具", annotations: { readOnlyHint: true, destructiveHint: true }, effectKindOverrides: undefined },
    { name: "本地效果 override", annotations: { destructiveHint: true }, effectKindOverrides: { action: "read" as const } },
  ])("$name 不会把未隔离的第三方执行降为 safe", async ({ annotations, effectKindOverrides }) => {
    remote.tools = [{ name: "action", annotations, inputSchema: { type: "object", properties: {} } }];
    await connectMcpServer({ id: "permission-test", name: "Permission test", transport: "stdio", command: "unused", effectKindOverrides });
    const tool = toolRegistry.getById("permission-test-action")!;
    expect(policyFor("per-action", tool.risk!)).toBe("ask");
    const runtime = await prepareToolRuntime({
      options: { conversationId: "thread", conversationMode: "chat", messages: [], allowPermissionPrompt: false } as never,
      signal: new AbortController().signal,
      prepared: { threadId: "thread", runId: "permission-run", tools: [] } as never,
      sendBaseEvent: vi.fn(),
    });
    for (const level of ["project-read-only", "read-only", "scoped", "per-action"] as const) {
      setCurrentLevel(level);
      expect(await runtime.checkPermission(tool.id, {}), level).toBe(false);
    }
    expect(remote.call).not.toHaveBeenCalled();
    setCurrentLevel("full");
    expect(await runtime.checkPermission(tool.id, {})).toBe(true);
    await tool.execute({});
    expect(remote.call).toHaveBeenCalledOnce();
  });
});
