import { describe, expect, it } from "vitest";
import { collectGeneratedImages, sanitizeGeneratedImageRaw, stripGeneratedImageReplay } from "./generated-image-output";

const imageData = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).toString("base64");

describe("generated image SDK output", () => {
  it("collects provider tool results once across stream and terminal snapshots", () => {
    const stream = [
      { type: "tool-result", toolName: "image_generation", toolCallId: "call-1", result: { result: imageData } },
      { type: "tool-result", toolName: "image_generation", toolCallId: "call-2", output: { result: imageData } },
    ];
    const terminal = [{ type: "tool-result", toolName: "image_generation", toolCallId: "call-1", output: { result: imageData } }];

    const collected = collectGeneratedImages(terminal, collectGeneratedImages(stream));

    expect(collected).toEqual([
      { id: "call-1", toolCallId: "call-1", base64: imageData, mime: "image/png" },
      { id: "call-2", toolCallId: "call-2", base64: imageData, mime: "image/png" },
    ]);
  });

  it("strips image call and result while preserving other assistant replay content", () => {
    const content = [
      { type: "reasoning", text: "think" },
      { type: "tool-call", toolCallId: "call-image", toolName: "image_generation", input: {}, providerExecuted: true },
      { type: "tool-result", toolCallId: "call-image", toolName: "image_generation", result: { result: imageData } },
      { type: "tool-call", toolCallId: "call-weather", toolName: "weather", input: { city: "上海" } },
      { type: "text", text: "完成" },
    ] as any;

    const stripped = stripGeneratedImageReplay(content);

    expect(stripped).toEqual([content[0], content[3], content[4]]);
    expect(JSON.stringify(stripped)).not.toContain(imageData);
  });

  it("removes image bytes from nested raw response snapshots", () => {
    const raw = { response: { body: { output: [{ type: "image_generation_call", id: "call-image", result: imageData }] } } };

    expect(JSON.stringify(sanitizeGeneratedImageRaw(raw))).not.toContain(imageData);
  });
});
