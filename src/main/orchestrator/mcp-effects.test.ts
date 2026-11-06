import { afterEach, describe, expect, it, vi } from "vitest";
const remote = vi.hoisted(() => ({ tools: [] as unknown[], call: vi.fn() }));
vi.mock("electron", () => ({ app: { getPath: () => process.env.TEMP! } }));
vi.mock("@modelcontextprotocol/sdk/client/index.js", () => ({ Client: class {
  async connect() {}
  async close() {}
  async listTools() { return { tools: remote.tools }; }
  callTool = remote.call;
} }));
vi.mock("@modelcontextprotocol/sdk/client/stdio.js", () => ({ StdioClientTransport: class { async close() {} } }));

import { connectMcpServer, disconnectMcpServer } from "./mcp-adapter";
import { toolRegistry } from "./tools/registry/tool-registry";
import { dispatchToolCall } from "./harness/tool-dispatcher";
import type { AgentState } from "./harness/types";

afterEach(async () => { await disconnectMcpServer("effects"); remote.call.mockReset(); });

async function context(annotations?: Record<string, boolean>) {
  remote.tools = [{ name: "action", annotations, inputSchema: { type: "object", properties: {} } }];
  await connectMcpServer({ id: "effects", name: "Effects", transport: "stdio", command: "unused" });
  return {
    state: { todoItems: [], uncertainEffects: [] } as AgentState,
    tools: [toolRegistry.getById("effects-action")!],
    toolContext: { userQuery: "", runId: "effects-run" },
  };
}
const call = (id: string) => ({ id, name: "effects-action", arguments: '{"target":"same"}' });

describe("MCP 不确定效果沿真实执行器传播至 Harness", () => {
  it.each([
    { kind: "无 annotations / 响应丢失", annotations: undefined, responseError: false },
    { kind: "破坏性操作 / 响应丢失", annotations: { destructiveHint: true }, responseError: false },
    { kind: "无 annotations / 服务端部分失败", annotations: undefined, responseError: true },
    { kind: "破坏性操作 / 服务端部分失败", annotations: { destructiveHint: true }, responseError: true },
  ])("$kind 不会被记为未生效或以新调用 ID 再次执行", async ({ annotations, responseError }) => {
    remote.call.mockImplementation(async () => {
      if (responseError) return { isError: true, content: [{ type: "text", text: "partial failure" }] };
      throw new Error("response connection lost after dispatch");
    });
    const ctx = await context(annotations);
    const result = await dispatchToolCall(call("first"), ctx);
    expect(result.outcome).toBe("unknown");
    expect(result.rawResult).toMatchObject({ status: "failed", effectState: "unknown", retryable: false });
    expect(ctx.state.uncertainEffects).toHaveLength(1);
    expect(await dispatchToolCall(call("second"), ctx)).toMatchObject({ outcome: "not_executed", category: "runtime_safety" });
    expect(remote.call).toHaveBeenCalledOnce();
  });

  it("只读调用失败不登记外部副作用，也不阻止后续新调用", async () => {
    remote.call.mockRejectedValue(new Error("read unavailable"));
    const ctx = await context({ readOnlyHint: true });
    expect(await dispatchToolCall(call("first"), ctx)).toMatchObject({ outcome: "failure", rawResult: { effectState: "not_applied" } });
    expect(await dispatchToolCall(call("second"), ctx)).toMatchObject({ outcome: "failure" });
    expect(ctx.state.uncertainEffects).toEqual([]);
    expect(remote.call).toHaveBeenCalledTimes(2);
  });

  it("明确成功的外部操作仍正常返回，不登记不确定效果", async () => {
    remote.call.mockResolvedValue({ content: [{ type: "text", text: "created" }] });
    const ctx = await context({ destructiveHint: true });
    expect(await dispatchToolCall(call("success"), ctx)).toMatchObject({ outcome: "success", output: "created" });
    expect(ctx.state.uncertainEffects).toEqual([]);
  });
});
