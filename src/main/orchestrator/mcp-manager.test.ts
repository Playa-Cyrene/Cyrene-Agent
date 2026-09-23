// MCP Manager 测试 — 覆盖配置持久化、增删流程、启动自动连接的取消语义
// 真实文件系统写入临时目录；mcp-adapter 与 electron 均 mock，不发起真实连接。
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// userData 目录在每个用例中指向独立临时目录（vi.hoisted 保证 mock 工厂可引用）
const testEnv = vi.hoisted(() => ({ userDataDir: "" }));

vi.mock("electron", () => ({
  app: { getPath: vi.fn(() => testEnv.userDataDir) },
}));

const adapterMocks = vi.hoisted(() => ({
  connectMcpServer: vi.fn(),
  disconnectMcpServer: vi.fn(),
  getMcpServerStates: vi.fn((): unknown[] => []),
}));

vi.mock("./mcp-adapter", () => adapterMocks);

vi.mock("../logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  LogTag: { MCP: "MCP" },
}));

import { addMcpServer, initMcpManager, listMcpServerConfigs, pruneMcpServersByIds, removeMcpServer } from "./mcp-manager";

function configFilePath(): string {
  return path.join(testEnv.userDataDir, "mcp-servers.json");
}

function writeConfigFile(configs: unknown[]): void {
  fs.writeFileSync(configFilePath(), JSON.stringify(configs, null, 2), "utf-8");
}

function readConfigFile(): Array<{ id: string }> {
  return JSON.parse(fs.readFileSync(configFilePath(), "utf-8"));
}

const stdioConfig = { id: "srv", name: "Srv", transport: "stdio" as const, command: "node", args: ["a.js"] };

beforeEach(() => {
  vi.clearAllMocks();
  adapterMocks.getMcpServerStates.mockReturnValue([]);
  testEnv.userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-manager-test-"));
});

afterEach(() => {
  fs.rmSync(testEnv.userDataDir, { recursive: true, force: true });
});

describe("addMcpServer 持久化", () => {
  it("连接成功后写入配置文件", async () => {
    adapterMocks.connectMcpServer.mockResolvedValue(["srv-tool1"]);

    const result = await addMcpServer(stdioConfig);

    expect(result).toEqual({ ok: true, toolIds: ["srv-tool1"] });
    expect(adapterMocks.connectMcpServer).toHaveBeenCalledWith(stdioConfig);
    expect(readConfigFile()).toEqual([stdioConfig]);
  });

  it("重复 id 拒绝且不发起连接", async () => {
    writeConfigFile([stdioConfig]);

    const result = await addMcpServer({ ...stdioConfig, name: "另一个" });

    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/已存在相同 ID/);
    expect(adapterMocks.connectMcpServer).not.toHaveBeenCalled();
  });

  it("连接失败时不写盘（失败的配置不残留）", async () => {
    adapterMocks.connectMcpServer.mockRejectedValue(new Error("connect fail"));

    const result = await addMcpServer(stdioConfig);

    expect(result).toEqual({ ok: false, error: "connect fail" });
    expect(fs.existsSync(configFilePath())).toBe(false);
  });
});

describe("removeMcpServer", () => {
  it("配置存在但从未连接成功时也能清理（disconnect 返回 false 不阻塞）", async () => {
    writeConfigFile([{ id: "ghost" }, { id: "keep" }]);
    adapterMocks.disconnectMcpServer.mockResolvedValue(false);

    const result = await removeMcpServer("ghost");

    expect(result).toEqual({ ok: true });
    expect(readConfigFile().map((c) => c.id)).toEqual(["keep"]);
  });
});

describe("listMcpServerConfigs", () => {
  it("以配置文件为事实源（含连接失败的条目）", () => {
    writeConfigFile([stdioConfig, { id: "broken" }]);

    const configs = listMcpServerConfigs();

    expect(configs.map((c) => c.id)).toEqual(["srv", "broken"]);
  });
});

describe("initMcpManager 启动自动连接", () => {
  it("无配置时跳过连接", async () => {
    await initMcpManager();
    expect(adapterMocks.connectMcpServer).not.toHaveBeenCalled();
  });

  it("逐个连接已保存的配置", async () => {
    writeConfigFile([stdioConfig, { id: "b", name: "B", transport: "sse", url: "https://b.example.com/sse" }]);
    adapterMocks.connectMcpServer.mockResolvedValue([]);

    await initMcpManager();

    expect(adapterMocks.connectMcpServer).toHaveBeenCalledTimes(2);
    expect(adapterMocks.connectMcpServer).toHaveBeenNthCalledWith(1, stdioConfig);
  });

  it("单个连接失败不阻塞其余配置", async () => {
    writeConfigFile([{ id: "bad" }, { id: "good" }]);
    adapterMocks.connectMcpServer
      .mockRejectedValueOnce(new Error("boom"))
      .mockResolvedValueOnce([]);

    await initMcpManager();

    expect(adapterMocks.connectMcpServer).toHaveBeenCalledTimes(2);
  });

  it("信号已中止时不再发起新连接", async () => {
    writeConfigFile([stdioConfig]);
    const controller = new AbortController();
    controller.abort();

    await initMcpManager({ signal: controller.signal });

    expect(adapterMocks.connectMcpServer).not.toHaveBeenCalled();
  });

  it("连接完成时发现信号已中止，立即断开迟到连接", async () => {
    writeConfigFile([stdioConfig]);
    const controller = new AbortController();
    adapterMocks.connectMcpServer.mockImplementation(async () => {
      controller.abort(); // 模拟：连接刚完成时应用开始退出
      return [];
    });
    adapterMocks.disconnectMcpServer.mockResolvedValue(true);

    await initMcpManager({ signal: controller.signal });

    expect(adapterMocks.disconnectMcpServer).toHaveBeenCalledWith("srv");
  });
});

describe("pruneMcpServersByIds 白名单清理", () => {
  it("只删除指定 id，不误删用户自定义配置", async () => {
    writeConfigFile([{ id: "builtin-a" }, { id: "user-keep" }]);

    const removed = await pruneMcpServersByIds(["builtin-a"]);

    expect(removed).toEqual(["builtin-a"]);
    expect(readConfigFile().map((c) => c.id)).toEqual(["user-keep"]);
  });

  it("条目不存在时幂等（不报错、不写盘）", async () => {
    writeConfigFile([{ id: "user-keep" }]);
    const before = fs.statSync(configFilePath()).mtimeMs;

    const removed = await pruneMcpServersByIds(["builtin-gone"]);

    expect(removed).toEqual([]);
    expect(readConfigFile().map((c) => c.id)).toEqual(["user-keep"]);
    expect(fs.statSync(configFilePath()).mtimeMs).toBe(before);
  });
});
