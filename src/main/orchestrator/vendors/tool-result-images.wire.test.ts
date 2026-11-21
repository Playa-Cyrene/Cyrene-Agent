import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { configureToolResultImageDirectory } from "../tool-result-images";
import { getAdapterForConfig, PROVIDER_CAPABILITIES } from "./index";
import { generateChatWithAiSdk } from "./model-runtime";
import { jsonResponse, responseBody } from "./sdk-stream/model-fixtures";
import type { ChatMessage, VendorConfig } from "./types";

// 截获 prompt dump 实际会落盘的请求体（经过同一个替换函数），不真的写磁盘。
const dumped = vi.hoisted(() => ({ bodies: [] as unknown[] }));
vi.mock("./prompt-dump", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./prompt-dump")>();
  return {
    ...actual,
    dumpRequest: (meta: Parameters<typeof actual.dumpRequest>[0]) => {
      dumped.bodies.push(actual.redactToolImageData(meta.body, meta.redactedImageData ?? new Set()));
      return "trace";
    },
  };
});

// 1×1 的真实 PNG：验证经 SDK 编码后发给厂商的请求里确实带着这张图，而不是只验证内部投影。
const TEST_PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
const FILE_NAME = "shot-1731200000000-1.png";

const providerName = (id: string) => PROVIDER_CAPABILITIES.find(cap => cap.id === id)!.displayName;
const configs: Record<"anthropic" | "responses" | "openai", VendorConfig> = {
  anthropic: { provider: providerName("claude"), model: "claude-sonnet-4-6", baseUrl: "https://example.test/v1", apiKey: "k", explicitTransport: "anthropic" },
  responses: { provider: providerName("chatgpt"), model: "gpt-5.6", baseUrl: "https://api.openai.com/v1", apiKey: "k", explicitTransport: "responses" },
  openai: { provider: providerName("chatgpt"), model: "gpt-5.6", baseUrl: "https://compatible.test/v1", apiKey: "k", explicitTransport: "openai" },
};

function history(): ChatMessage[] {
  return [
    { role: "user", content: "看一下屏幕" },
    { role: "assistant", content: "", toolCalls: [{ id: "call_shot", name: "computer_screenshot", arguments: "{}" }] },
    { role: "tool", toolCallId: "call_shot", name: "computer_screenshot", content: "已截取主屏",
      toolImages: [{ fileName: FILE_NAME, mediaType: "image/png", width: 1, height: 1 }] },
  ];
}

describe("工具结果图片经真实 SDK 请求链路发给主模型", () => {
  let directory: string;

  beforeEach(() => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), "cyrene-tool-image-wire-"));
    fs.writeFileSync(path.join(directory, FILE_NAME), Buffer.from(TEST_PNG, "base64"));
    configureToolResultImageDirectory(directory);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    configureToolResultImageDirectory(undefined);
    fs.rmSync(directory, { recursive: true, force: true });
  });

  async function send(transport: keyof typeof configs): Promise<Record<string, any>> {
    const config = configs[transport];
    let body: Record<string, any> | undefined;
    vi.stubGlobal("fetch", vi.fn(async (_url, init) => {
      body = JSON.parse(init.body);
      return jsonResponse(responseBody(getAdapterForConfig(config).transport));
    }));
    await generateChatWithAiSdk({ adapter: getAdapterForConfig(config), config, timeoutMs: 2000,
      request: { model: config.model, messages: history() } });
    return body!;
  }

  it("Claude Messages：图片在 tool_result 内，作为 base64 image 块", async () => {
    const body = await send("anthropic");
    const toolResult = body.messages.flatMap((message: any) => Array.isArray(message.content) ? message.content : [])
      .find((block: any) => block.type === "tool_result");
    expect(toolResult.tool_use_id).toBe("call_shot");
    expect(toolResult.content).toContainEqual(expect.objectContaining({
      type: "image", source: { type: "base64", media_type: "image/png", data: TEST_PNG },
    }));
  });

  it("OpenAI Responses：图片在 function_call_output 内", async () => {
    const body = await send("responses");
    const output = body.input.find((item: any) => item.type === "function_call_output");
    expect(output.call_id).toBe("call_shot");
    expect(output.output).toContainEqual({ type: "input_image", image_url: `data:image/png;base64,${TEST_PNG}` });
  });

  it("Chat Completions：tool 消息保留文字，图片由紧随其后的 user 消息携带", async () => {
    const body = await send("openai");
    const roles = body.messages.map((message: any) => message.role);
    const toolIndex = roles.indexOf("tool");
    expect(body.messages[toolIndex].tool_call_id).toBe("call_shot");
    expect(body.messages[toolIndex].content).toContain("[图片见紧随其后的消息]");
    const carrier = body.messages[toolIndex + 1];
    expect(carrier.role).toBe("user");
    expect(carrier.content).toContainEqual(expect.objectContaining({
      type: "image_url", image_url: expect.objectContaining({ url: `data:image/png;base64,${TEST_PNG}` }),
    }));
  });

  it("开启 prompt dump 时，落盘的请求体不含截图数据，发给模型的请求仍带图", async () => {
    for (const transport of ["anthropic", "responses", "openai"] as const) {
      dumped.bodies.length = 0;
      const body = await send(transport);
      expect(JSON.stringify(body)).toContain(TEST_PNG);
      expect(dumped.bodies).toHaveLength(1);
      const text = JSON.stringify(dumped.bodies[0]);
      expect(text).not.toContain(TEST_PNG);
      expect(text).toContain("[工具截图已省略");
    }
  });

  it("图片文件已被清理时，各协议都退化为文字说明且请求照常发出", async () => {
    fs.rmSync(path.join(directory, FILE_NAME));
    for (const transport of ["anthropic", "responses", "openai"] as const) {
      const body = await send(transport);
      const text = JSON.stringify(body);
      expect(text).not.toContain(TEST_PNG);
      expect(text).toContain("截图文件不可用");
    }
  });
});
