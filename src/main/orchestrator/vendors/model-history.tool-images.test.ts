import { describe, expect, it } from "vitest";
import { MAX_LIVE_TOOL_IMAGES, projectModelHistory } from "./model-history";
import type { ChatMessage, ModelMessageOrigin, ToolResultImage } from "./types";

function origin(transport: ModelMessageOrigin["transport"]): ModelMessageOrigin {
  return { transport, provider: "test", model: "m", endpoint: "e", credentialScope: "c" };
}

function image(sequence: number): ToolResultImage {
  return { fileName: `shot-1-${sequence}.png`, mediaType: "image/png", width: 1568, height: 882 };
}

function screenshotRound(sequence: number): ChatMessage[] {
  return [
    { role: "assistant", content: "", toolCalls: [{ id: `call-${sequence}`, name: "computer_screenshot", arguments: "{}" }] },
    { role: "tool", toolCallId: `call-${sequence}`, name: "computer_screenshot", content: `result-${sequence}`, toolImages: [image(sequence)] },
  ];
}

const resolve = (reference: ToolResultImage) => ({ mediaType: "image/png", data: `data-of-${reference.fileName}` });

function toolOutputs(messages: ReturnType<typeof projectModelHistory>) {
  return messages.flatMap(message => message.role === "tool" ? message.content : [])
    .flatMap(part => part.type === "tool-result" ? [part.output] : []);
}

describe("projectModelHistory 工具结果图片", () => {
  it.each(["anthropic", "responses"] as const)("%s 协议把图片放进工具结果本身", (transport) => {
    const projected = projectModelHistory(screenshotRound(1), origin(transport), undefined, resolve);

    expect(toolOutputs(projected)).toEqual([{
      type: "content",
      value: [
        { type: "text", text: "result-1" },
        { type: "file", mediaType: "image/png", data: { type: "data", data: "data-of-shot-1-1.png" } },
      ],
    }]);
    expect(projected.some(message => message.role === "user")).toBe(false);
  });

  it("Chat Completions 协议在同一轮全部工具结果之后用 user 消息携带图片", () => {
    const history: ChatMessage[] = [
      { role: "assistant", content: "", toolCalls: [
        { id: "a", name: "computer_screenshot", arguments: "{}" },
        { id: "b", name: "read_file", arguments: "{}" },
      ] },
      { role: "tool", toolCallId: "a", name: "computer_screenshot", content: "shot", toolImages: [image(1)] },
      { role: "tool", toolCallId: "b", name: "read_file", content: "file" },
      { role: "assistant", content: "done" },
    ];

    const projected = projectModelHistory(history, origin("openai"), undefined, resolve);

    // tool 消息必须紧跟 tool_calls 且全部相邻，图片消息插在它们之后、下一条 assistant 之前。
    expect(projected.map(message => message.role)).toEqual(["assistant", "tool", "tool", "user", "assistant"]);
    expect(toolOutputs(projected)).toEqual([
      { type: "text", value: "shot\n[图片见紧随其后的消息]" },
      { type: "text", value: "file" },
    ]);
    const carrier = projected[3];
    expect(carrier.role === "user" && Array.isArray(carrier.content) ? carrier.content.slice(1) : undefined).toEqual([
      { type: "file", mediaType: "image/png", data: { type: "data", data: "data-of-shot-1-1.png" } },
    ]);
  });

  it("以工具结果结尾的历史也会补上图片消息", () => {
    const projected = projectModelHistory(screenshotRound(1), origin("openai"), undefined, resolve);

    expect(projected.map(message => message.role)).toEqual(["assistant", "tool", "user"]);
  });

  it("只发送最近几张图片，较早的截图退化为文字说明", () => {
    const rounds = MAX_LIVE_TOOL_IMAGES + 2;
    const history = Array.from({ length: rounds }, (_, index) => screenshotRound(index + 1)).flat();
    const requested: string[] = [];

    const outputs = toolOutputs(projectModelHistory(history, origin("anthropic"), undefined, (reference) => {
      requested.push(reference.fileName);
      return resolve(reference);
    }));

    expect(outputs.map(output => output.type)).toEqual(["text", "text", "content", "content", "content"]);
    expect(outputs[0]).toEqual({
      type: "text",
      value: "result-1\n[较早的截图已从上下文移除；需要查看当前界面请重新截图]",
    });
    // 被移除的截图不应再被读取：否则每次请求都要白读一遍磁盘上的全部历史截图。
    expect(requested).toEqual(["shot-1-3.png", "shot-1-4.png", "shot-1-5.png"]);
  });

  it("图片文件不可用时退化为文字说明而不是让请求失败", () => {
    const outputs = toolOutputs(projectModelHistory(screenshotRound(1), origin("anthropic"), undefined, () => undefined));

    expect(outputs).toEqual([{ type: "text", value: "result-1\n[截图文件不可用；需要查看当前界面请重新截图]" }]);
  });

  it("没有目标模型的预算估算投影不读取图片", () => {
    let calls = 0;
    const outputs = toolOutputs(projectModelHistory(screenshotRound(1), undefined, undefined, () => {
      calls += 1;
      return undefined;
    }));

    expect(calls).toBe(0);
    expect(outputs[0].type).toBe("text");
  });
});
