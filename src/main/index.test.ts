import { describe, it, expect, vi, beforeEach } from "vitest";

// mock electron — sync 函数 import 时不依赖它,但防万一
vi.mock("electron", () => ({
  app: { getPath: vi.fn() },
  ipcMain: { handle: vi.fn() },
}));

// vi.mock 工厂会被 hoist 到文件顶部,不能直接引用顶层 const;
// 用 vi.hoisted 把 mock 函数提到 mock 工厂之前。
const { mockAdd, mockRemove, mockListConfigs } = vi.hoisted(() => ({
  mockAdd: vi.fn().mockResolvedValue({ ok: true, toolIds: [] }),
  mockRemove: vi.fn().mockResolvedValue({ ok: true }),
  mockListConfigs: vi.fn().mockReturnValue([]),
}));

vi.mock("./orchestrator/mcp-manager", () => ({
  addMcpServer: mockAdd,
  removeMcpServer: mockRemove,
  listMcpServerConfigs: mockListConfigs,
}));

import { syncPlaywrightMcp, buildPlaywrightMcpConfig, PLAYWRIGHT_MCP_ID, syncFilesystemMcp, buildFilesystemMcpConfig, FILESYSTEM_MCP_ID } from "./sync-mcp-builtin";

describe("syncPlaywrightMcp", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockListConfigs.mockReturnValue([]);
  });

  it("does nothing when disabled and no stored config", async () => {
    await syncPlaywrightMcp({ playwrightMcpEnabled: false });
    expect(mockAdd).not.toHaveBeenCalled();
    expect(mockRemove).not.toHaveBeenCalled();
  });

  it("adds stdio server (execPath + ELECTRON_RUN_AS_NODE + msedge) when enabled and no stored config", async () => {
    await syncPlaywrightMcp({ playwrightMcpEnabled: true });
    expect(mockAdd).toHaveBeenCalledTimes(1);
    expect(mockAdd).toHaveBeenCalledWith(expect.objectContaining({
      id: PLAYWRIGHT_MCP_ID,
      transport: "stdio",
      command: process.execPath,
      args: expect.arrayContaining([
        expect.stringContaining("cli.js"),
        "--isolated",
        "--headless",
        "--browser",
        "msedge",
      ]),
      env: { ELECTRON_RUN_AS_NODE: "1" },
    }));
  });

  it("removes stored config when disabled", async () => {
    mockListConfigs.mockReturnValue([buildPlaywrightMcpConfig()]);
    await syncPlaywrightMcp({ playwrightMcpEnabled: false });
    expect(mockRemove).toHaveBeenCalledWith(PLAYWRIGHT_MCP_ID);
    expect(mockAdd).not.toHaveBeenCalled();
  });

  it("no-op when enabled and stored config matches expected", async () => {
    mockListConfigs.mockReturnValue([buildPlaywrightMcpConfig()]);
    await syncPlaywrightMcp({ playwrightMcpEnabled: true });
    expect(mockAdd).not.toHaveBeenCalled();
    expect(mockRemove).not.toHaveBeenCalled();
  });

  it("migrates stale npx config (remove + re-add) when enabled", async () => {
    mockListConfigs.mockReturnValue([{
      id: PLAYWRIGHT_MCP_ID,
      name: "Playwright 浏览器",
      transport: "stdio",
      command: "npx",
      args: ["-y", "@playwright/mcp@latest", "--isolated", "--headless", "--no-sandbox"],
    }]);
    await syncPlaywrightMcp({ playwrightMcpEnabled: true });
    expect(mockRemove).toHaveBeenCalledWith(PLAYWRIGHT_MCP_ID);
    expect(mockAdd).toHaveBeenCalledTimes(1);
    expect(mockAdd).toHaveBeenCalledWith(expect.objectContaining({
      command: process.execPath,
    }));
  });
});

describe("syncFilesystemMcp", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockListConfigs.mockReturnValue([]);
  });

  it("does nothing when disabled and no stored config", async () => {
    await syncFilesystemMcp({ filesystemMcpEnabled: false, allowedDir: "C:/Downloads" });
    expect(mockAdd).not.toHaveBeenCalled();
    expect(mockRemove).not.toHaveBeenCalled();
  });

  it("adds stdio server with allowed dir as argument when enabled", async () => {
    await syncFilesystemMcp({ filesystemMcpEnabled: true, allowedDir: "C:/Users/u/Downloads" });
    expect(mockAdd).toHaveBeenCalledTimes(1);
    expect(mockAdd).toHaveBeenCalledWith(expect.objectContaining({
      id: FILESYSTEM_MCP_ID,
      transport: "stdio",
      command: process.execPath,
      args: expect.arrayContaining([
        expect.stringContaining("index.js"),
        "C:/Users/u/Downloads",
      ]),
      env: { ELECTRON_RUN_AS_NODE: "1" },
    }));
  });

  it("removes stored config when disabled", async () => {
    mockListConfigs.mockReturnValue([buildFilesystemMcpConfig("C:/Downloads")]);
    await syncFilesystemMcp({ filesystemMcpEnabled: false, allowedDir: "C:/Downloads" });
    expect(mockRemove).toHaveBeenCalledWith(FILESYSTEM_MCP_ID);
    expect(mockAdd).not.toHaveBeenCalled();
  });

  it("no-op when enabled and stored config matches expected", async () => {
    mockListConfigs.mockReturnValue([buildFilesystemMcpConfig("C:/Downloads")]);
    await syncFilesystemMcp({ filesystemMcpEnabled: true, allowedDir: "C:/Downloads" });
    expect(mockAdd).not.toHaveBeenCalled();
    expect(mockRemove).not.toHaveBeenCalled();
  });

  it("migrates stale config when allowed dir changes (下载目录迁移)", async () => {
    mockListConfigs.mockReturnValue([buildFilesystemMcpConfig("C:/Old/Downloads")]);
    await syncFilesystemMcp({ filesystemMcpEnabled: true, allowedDir: "D:/New/Downloads" });
    expect(mockRemove).toHaveBeenCalledWith(FILESYSTEM_MCP_ID);
    expect(mockAdd).toHaveBeenCalledTimes(1);
    expect(mockAdd).toHaveBeenCalledWith(expect.objectContaining({
      args: expect.arrayContaining(["D:/New/Downloads"]),
    }));
  });
});
