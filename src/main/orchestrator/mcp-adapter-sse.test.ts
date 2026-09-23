import { describe, it, expect, vi, beforeEach } from "vitest";

// tool-registry 通过 ../rag/index 间接 import electron；这里 stub 掉避免 electron 二进制检查
vi.mock("electron", () => ({
	app: { getPath: vi.fn(() => "/tmp") },
}));

// mock 整个 SDK,在测试里不需要真连
vi.mock("@modelcontextprotocol/sdk/client/index.js", () => ({
	Client: vi.fn(),
}));

const mockStdioConnect = vi.fn().mockResolvedValue(undefined);
const mockSseConnect = vi.fn().mockResolvedValue(undefined);
const mockSseClose = vi.fn().mockResolvedValue(undefined);
const mockStdioClose = vi.fn().mockResolvedValue(undefined);

vi.mock("@modelcontextprotocol/sdk/client/stdio.js", () => ({
	StdioClientTransport: vi.fn().mockImplementation(function (this: unknown, opts: unknown) {
		return {
			close: mockStdioClose,
			_opts: opts,
		};
	}),
}));

vi.mock("@modelcontextprotocol/sdk/client/sse.js", () => ({
	SSEClientTransport: vi.fn().mockImplementation(function (this: unknown, url: unknown) {
		return {
			close: mockSseClose,
			onerror: null as ((err: Error) => void) | null,
			_url: url,
		};
	}),
}));

const mockHttpClose = vi.fn().mockResolvedValue(undefined);

vi.mock("@modelcontextprotocol/sdk/client/streamableHttp.js", () => ({
	StreamableHTTPClientTransport: vi.fn().mockImplementation(function (this: unknown, url: unknown) {
		return {
			close: mockHttpClose,
			onerror: null as ((err: Error) => void) | null,
			_url: url,
		};
	}),
}));

import { connectMcpServer, disconnectMcpServer, getMcpServerStates } from "./mcp-adapter";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { toolRegistry } from "./tools/registry/tool-registry";

describe("mcp-adapter transport split", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		// 清空 registry,避免互相污染
		for (const t of toolRegistry.getAllTools()) toolRegistry.unregister(t.id);
	});

	it("stdio transport uses StdioClientTransport with command/args", async () => {
		const Client = (await import("@modelcontextprotocol/sdk/client/index.js")).Client as any;
		Client.mockImplementation(function (this: unknown) {
			return {
				connect: vi.fn().mockResolvedValue(undefined),
				listTools: vi.fn().mockResolvedValue({ tools: [] }),
				close: vi.fn().mockResolvedValue(undefined),
			};
		});

		await connectMcpServer({
			id: "test-stdio",
			name: "Test Stdio",
			transport: "stdio",
			command: "node",
			args: ["foo.js"],
		});

		expect(StdioClientTransport).toHaveBeenCalledWith({
			command: "node",
			args: ["foo.js"],
			env: undefined,
			cwd: undefined,
		});
		expect(SSEClientTransport).not.toHaveBeenCalled();
	});

	it("sse transport uses SSEClientTransport with URL", async () => {
		const Client = (await import("@modelcontextprotocol/sdk/client/index.js")).Client as any;
		Client.mockImplementation(function (this: unknown) {
			return {
				connect: vi.fn().mockResolvedValue(undefined),
				listTools: vi.fn().mockResolvedValue({ tools: [] }),
				close: vi.fn().mockResolvedValue(undefined),
			};
		});

		await connectMcpServer({
			id: "test-sse",
			name: "Test SSE",
			transport: "sse",
			url: "https://example.com/sse",
		});

		expect(SSEClientTransport).toHaveBeenCalledWith(new URL("https://example.com/sse"), {
			requestInit: { headers: undefined },
		});
		expect(StdioClientTransport).not.toHaveBeenCalled();
	});

	it("http transport uses StreamableHTTPClientTransport with url and headers", async () => {
		const Client = (await import("@modelcontextprotocol/sdk/client/index.js")).Client as any;
		Client.mockImplementation(function (this: unknown) {
			return {
				connect: vi.fn().mockResolvedValue(undefined),
				listTools: vi.fn().mockResolvedValue({ tools: [] }),
				close: vi.fn().mockResolvedValue(undefined),
			};
		});

		await connectMcpServer({
			id: "test-http",
			name: "Test HTTP",
			transport: "http",
			url: "https://example.com/mcp",
			headers: { Authorization: "Bearer token" },
		});

		expect(StreamableHTTPClientTransport).toHaveBeenCalledWith(new URL("https://example.com/mcp"), {
			requestInit: { headers: { Authorization: "Bearer token" } },
		});
		expect(SSEClientTransport).not.toHaveBeenCalled();
		expect(StdioClientTransport).not.toHaveBeenCalled();
	});

	it("sse transport without url throws", async () => {
		await expect(
			connectMcpServer({
				id: "test-sse-bad",
				name: "Bad SSE",
				transport: "sse",
			})
		).rejects.toThrow(/sse transport requires url/);
	});

	it("propagates MCP isError as a failed tool execution", async () => {
		const callTool = vi.fn().mockResolvedValue({
			isError: true,
			content: [{ type: "text", text: "remote tool failed" }],
		});
		const Client = (await import("@modelcontextprotocol/sdk/client/index.js")).Client as any;
		Client.mockImplementation(function (this: unknown) {
			return {
				connect: vi.fn().mockResolvedValue(undefined),
				listTools: vi.fn().mockResolvedValue({
					tools: [{
						name: "explode",
						description: "always fails",
						inputSchema: { type: "object", properties: { value: { type: "string" } } },
					}],
				}),
				callTool,
				close: vi.fn().mockResolvedValue(undefined),
			};
		});

		await connectMcpServer({
			id: "test-error",
			name: "Test Error",
			transport: "stdio",
			command: "node",
			args: ["server.js"],
		});
		const tool = toolRegistry.getById("test-error-explode");

		await expect(tool?.execute({ value: "x" })).rejects.toThrow("E_MCP_TOOL_FAILED");
		expect(callTool).toHaveBeenCalledWith({ name: "explode", arguments: { value: "x" } });
	});
});

/** 构造 mock Client：listTools 返回给定工具列表。返回 client.close 的 spy 供断言。 */
async function mockClientReturning(tools: unknown[], overrides: { connect?: () => Promise<void>; close?: () => Promise<void> } = {}) {
	const Client = (await import("@modelcontextprotocol/sdk/client/index.js")).Client as any;
	const close = vi.fn().mockImplementation(overrides.close ?? (() => Promise.resolve(undefined)));
	Client.mockImplementation(function (this: unknown) {
		return {
			connect: vi.fn().mockImplementation(overrides.connect ?? (() => Promise.resolve(undefined))),
			listTools: vi.fn().mockResolvedValue({ tools }),
			close,
		};
	});
	return close;
}

describe("mcp-adapter effectKind 推导（安全放行依据）", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		for (const t of toolRegistry.getAllTools()) toolRegistry.unregister(t.id);
	});

	const baseConfig = {
		id: "ef",
		name: "EF",
		transport: "stdio" as const,
		command: "node",
		args: ["server.js"],
	};

	it("destructiveHint 优先于 readOnlyHint（第三方 annotations 矛盾时保守处理）", async () => {
		await mockClientReturning([{
			name: "t",
			inputSchema: { type: "object", properties: {} },
			annotations: { readOnlyHint: true, destructiveHint: true },
		}]);
		await connectMcpServer(baseConfig);
		expect(toolRegistry.getById("ef-t")?.effectKind).toBe("external_side_effect");
	});

	it("仅 readOnlyHint 时放行为 read", async () => {
		await mockClientReturning([{
			name: "t",
			inputSchema: { type: "object", properties: {} },
			annotations: { readOnlyHint: true },
		}]);
		await connectMcpServer(baseConfig);
		expect(toolRegistry.getById("ef-t")?.effectKind).toBe("read");
	});

	it("无 annotations 时为 unknown（会被 ExecutionPolicyGuard 拒绝）", async () => {
		await mockClientReturning([{ name: "t", inputSchema: { type: "object", properties: {} } }]);
		await connectMcpServer(baseConfig);
		expect(toolRegistry.getById("ef-t")?.effectKind).toBe("unknown");
	});

	it("本地 effectKindOverrides 优先级最高", async () => {
		await mockClientReturning([{
			name: "t",
			inputSchema: { type: "object", properties: {} },
			annotations: { destructiveHint: true },
		}]);
		await connectMcpServer({ ...baseConfig, effectKindOverrides: { t: "read" } });
		expect(toolRegistry.getById("ef-t")?.effectKind).toBe("read");
	});
});

describe("mcp-adapter 连接失败清理与生命周期", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		for (const t of toolRegistry.getAllTools()) toolRegistry.unregister(t.id);
	});

	it("client.connect 失败时关闭 transport 并上抛错误", async () => {
		await mockClientReturning([], {
			connect: () => Promise.reject(new Error("connect refused")),
		});

		await expect(connectMcpServer({
			id: "cf",
			name: "CF",
			transport: "stdio",
			command: "node",
		})).rejects.toThrow("connect refused");
		expect(mockStdioClose).toHaveBeenCalledTimes(1);
	});

	it("listTools 失败时关闭 client 并上抛错误", async () => {
		const Client = (await import("@modelcontextprotocol/sdk/client/index.js")).Client as any;
		const close = vi.fn().mockResolvedValue(undefined);
		Client.mockImplementation(function (this: unknown) {
			return {
				connect: vi.fn().mockResolvedValue(undefined),
				listTools: vi.fn().mockRejectedValue(new Error("listTools boom")),
				close,
			};
		});

		await expect(connectMcpServer({
			id: "lt",
			name: "LT",
			transport: "stdio",
			command: "node",
		})).rejects.toThrow("listTools boom");
		expect(close).toHaveBeenCalledTimes(1);
	});

	it("重复注册同 toolId 的工具会被跳过", async () => {
		const tools = [{ name: "dup", inputSchema: { type: "object", properties: {} } }];
		await mockClientReturning(tools);
		const first = await connectMcpServer({ id: "dup", name: "DUP", transport: "stdio", command: "node" });
		expect(first).toEqual(["dup-dup"]);

		// 第二次连接同 id：toolId 已存在，全部跳过
		await mockClientReturning(tools);
		const second = await connectMcpServer({ id: "dup", name: "DUP", transport: "stdio", command: "node" });
		expect(second).toEqual([]);
	});

	it("disconnectMcpServer 注销工具；未知的 id 返回 false", async () => {
		await mockClientReturning([{ name: "tool1", inputSchema: { type: "object", properties: {} } }]);
		await connectMcpServer({ id: "dc", name: "DC", transport: "stdio", command: "node" });
		expect(toolRegistry.getById("dc-tool1")).toBeDefined();

		expect(await disconnectMcpServer("dc")).toBe(true);
		expect(toolRegistry.getById("dc-tool1")).toBeUndefined();
		expect(await disconnectMcpServer("dc")).toBe(false);
	});

	it("client.close 失败时仍兜底关闭 transport", async () => {
		await mockClientReturning(
			[{ name: "tool1", inputSchema: { type: "object", properties: {} } }],
			{ close: () => Promise.reject(new Error("close failed")) },
		);
		await connectMcpServer({ id: "cf2", name: "CF2", transport: "stdio", command: "node" });

		// close 失败不应让 disconnect 抛错（transport 兜底保证资源释放）
		await expect(disconnectMcpServer("cf2")).resolves.toBe(true);
		expect(mockStdioClose).toHaveBeenCalled();
	});

	it("getMcpServerStates 返回连接态与工具数", async () => {
		await mockClientReturning([
			{ name: "a", inputSchema: { type: "object", properties: {} } },
			{ name: "b", inputSchema: { type: "object", properties: {} } },
		]);
		await connectMcpServer({ id: "st", name: "ST", transport: "stdio", command: "node" });

		const states = getMcpServerStates();
		const st = states.find((s) => s.id === "st");
		expect(st).toMatchObject({ name: "ST", connected: true, toolCount: 2 });
		expect(st?.toolIds).toEqual(["st-a", "st-b"]);
	});
});
