// Real builtin sync -> manager -> adapter, with fake SDK clients (no processes/network).
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const fixture = vi.hoisted(() => ({ userData: "", clients: [] as Array<{ close: ReturnType<typeof vi.fn> }> }));
const registry = vi.hoisted(() => new Map<string, { id: string }>());
vi.mock("electron", () => ({ app: { getPath: () => fixture.userData } }));
vi.mock("../logger", () => ({ logger: { info: vi.fn() }, LogTag: { MCP: "MCP" } }));
vi.mock("./tools/registry/tool-registry", () => ({ toolRegistry: {
  getById: (id: string) => registry.get(id),
  register: (tool: { id: string }) => registry.set(tool.id, tool),
  unregister: (id: string) => registry.delete(id),
} }));
vi.mock("@modelcontextprotocol/sdk/client/index.js", () => ({ Client: class {
  close = vi.fn(async () => {});
  constructor() { fixture.clients.push(this); }
  async connect() {}
  async listTools() { return { tools: [{ name: "read", inputSchema: { type: "object", properties: {} }, annotations: { readOnlyHint: true } }] }; }
} }));
vi.mock("@modelcontextprotocol/sdk/client/stdio.js", () => ({ StdioClientTransport: class { async close() {} } }));

import { syncFilesystemMcp, FILESYSTEM_MCP_ID } from "../sync-mcp-builtin";
import { initMcpManager, removeMcpServer } from "./mcp-manager";
import { disconnectMcpServer, getMcpServerStates } from "./mcp-adapter";

beforeEach(() => {
  fixture.userData = fs.mkdtempSync(path.join(os.tmpdir(), "cyrene-mcp-restore-"));
  fixture.clients.length = 0;
  registry.clear();
});
afterEach(async () => {
  for (const state of getMcpServerStates()) await disconnectMcpServer(state.id);
  fs.rmSync(fixture.userData, { recursive: true, force: true });
});

describe("builtin sync and restore", () => {
  it("首次启用后恢复保留同一连接，删除后可以重新启用", async () => {
    const settings = { filesystemMcpEnabled: true, allowedDir: fixture.userData };
    await syncFilesystemMcp(settings);
    const before = getMcpServerStates();
    expect(before[0].toolIds).toEqual([`${FILESYSTEM_MCP_ID}-read`]);
    await initMcpManager();
    expect(fixture.clients).toHaveLength(1);
    expect(getMcpServerStates()).toEqual(before);
    expect(registry.size).toBe(1);
    await removeMcpServer(FILESYSTEM_MCP_ID);
    expect(fixture.clients[0].close).toHaveBeenCalledTimes(1);
    expect(registry.size).toBe(0);
    await syncFilesystemMcp(settings);
    await initMcpManager();
    expect(fixture.clients).toHaveLength(2);
    expect(getMcpServerStates()[0].toolCount).toBe(1);
  });

  it("过期路径迁移关闭旧实例，恢复不再创建额外实例", async () => {
    await syncFilesystemMcp({ filesystemMcpEnabled: true, allowedDir: path.join(fixture.userData, "old") });
    await syncFilesystemMcp({ filesystemMcpEnabled: true, allowedDir: path.join(fixture.userData, "new") });
    await initMcpManager();
    expect(fixture.clients).toHaveLength(2);
    expect(fixture.clients[0].close).toHaveBeenCalledTimes(1);
    expect(fixture.clients[1].close).not.toHaveBeenCalled();
    expect(getMcpServerStates()[0].toolCount).toBe(1);
    expect(registry.size).toBe(1);
  });
});
