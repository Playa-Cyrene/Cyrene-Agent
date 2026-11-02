import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const remote = vi.hoisted(() => ({ root: "", tools: [] as unknown[], call: vi.fn() }));
vi.mock("electron", () => ({
  app: { getPath: () => remote.root },
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

let controller: AbortController | undefined;
beforeEach(() => {
  // 权限宿主会真实写配置；每例独占目录，由 afterEach 恢复档位后删除，避免互相污染。
  remote.root = fs.mkdtempSync(path.join(os.tmpdir(), "cyrene-mcp-permission-"));
  // 信号只属于当前权限检查；afterEach 先取消，再断开服务并回收目录。
  controller = new AbortController();
  remote.call.mockReset().mockResolvedValue({ content: [{ type: "text", text: "ok" }] });
});
afterEach(async () => {
  try {
    controller?.abort();
    await disconnectMcpServer("permission-test");
  } finally {
    setCurrentLevel("read-only");
    if (remote.root) fs.rmSync(remote.root, { recursive: true, force: true });
    remote.root = "";
  }
});

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
      signal: controller!.signal,
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
