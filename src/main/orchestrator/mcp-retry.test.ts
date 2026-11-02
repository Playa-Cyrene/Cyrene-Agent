import os from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";

const remote = vi.hoisted(() => ({ tools: [] as unknown[], call: vi.fn(), llm: vi.fn() }));
vi.mock("electron", () => ({ app: { getPath: () => os.tmpdir() } }));
vi.mock("@modelcontextprotocol/sdk/client/index.js", () => ({ Client: class {
  async connect() {}
  async close() {}
  async listTools() { return { tools: remote.tools }; }
  callTool = remote.call;
} }));
vi.mock("@modelcontextprotocol/sdk/client/stdio.js", () => ({ StdioClientTransport: class { async close() {} } }));
vi.mock("./vendors", () => ({ getAdapterForConfig: () => ({ id: "test", transport: "openai" }) }));
vi.mock("./harness/harness-llm", () => ({ callLLM: remote.llm, summarizeHistory: vi.fn() }));

import { connectMcpServer, disconnectMcpServer } from "./mcp-adapter";
import { toolRegistry } from "./tools/registry/tool-registry";
import { runCyreneHarness } from "./harness/cyrene-harness";
import type { ChatMessage, ChatResponse, ToolCall } from "./vendors/types";

afterEach(async () => {
  await disconnectMcpServer("retry-test");
  remote.call.mockReset(); remote.llm.mockReset();
});

function response(toolCalls: ToolCall[] = []): ChatResponse {
  const text = toolCalls.length ? "" : "完成";
  return {
    assistantMessage: { role: "assistant", content: text, ...(toolCalls.length ? { toolCalls } : {}) },
    text, toolCalls, finishReason: toolCalls.length ? "tool_calls" : "stop", raw: {},
  };
}

async function run(readOnly: boolean) {
  remote.tools = [{ name: "action", annotations: readOnly ? { readOnlyHint: true } : { destructiveHint: true }, inputSchema: { type: "object", properties: {} } }];
  await connectMcpServer({ id: "retry-test", name: "Retry test", transport: "stdio", command: "unused" });
  remote.llm.mockResolvedValueOnce(response([{ id: "first", name: "retry-test-action", arguments: "{}" }]))
    .mockResolvedValueOnce(response());
  // 仅替换模型和 MCP 传输；真实 Harness 持有重试退避计时器，运行完成后由其自身清理。
  // MCP 连接由 afterEach 关闭，不注入磁盘存储或访问真实用户数据。
  return runCyreneHarness({
    systemPrompt: "test", messages: [{ role: "user", content: "执行工具" }],
    tools: [toolRegistry.getById("retry-test-action")!],
    vendorConfig: { provider: "test", baseUrl: "https://example.test/v1", model: "test", apiKey: "test" },
    includeInteractiveTools: false,
  });
}

describe("只读 MCP 保留 Harness 原有超时重试", () => {
  it.each(["请求抛出超时", "isError 返回超时"])("%s 后由同一次逻辑调用自动重试成功", async (kind) => {
    if (kind === "请求抛出超时") remote.call.mockRejectedValueOnce(new Error("请求超时"));
    else remote.call.mockResolvedValueOnce({ isError: true, content: [{ type: "text", text: "请求超时" }] });
    remote.call.mockResolvedValueOnce({ content: [{ type: "text", text: "recovered" }] });
    const result = await run(true);
    expect(remote.call).toHaveBeenCalledTimes(2);
    expect(remote.llm).toHaveBeenCalledTimes(2);
    const finalPrompt = remote.llm.mock.calls[1][2] as ChatMessage[];
    expect(finalPrompt.find((message) => message.role === "tool")?.content).toContain("recovered");
    expect(result.finalState.uncertainEffects).toEqual([]);
    expect(result.finalAnswer).toBe("完成");
  });

  it("非只读请求超时仍登记不确定效果，不自动重试", async () => {
    remote.call.mockRejectedValue(new Error("请求超时"));
    const result = await run(false);
    expect(remote.call).toHaveBeenCalledOnce();
    expect(result.finalState.uncertainEffects).toHaveLength(1);
  });
});
