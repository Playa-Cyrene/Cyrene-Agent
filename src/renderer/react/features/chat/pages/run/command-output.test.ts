import { describe, expect, it } from "vitest";
import { applyVisibleOutput, normalizeShellOutputEvent } from "./command-output";

describe("command output presentation", () => {
  it("appends chunks and replaces temporary decoding with the final text", () => {
    expect(applyVisibleOutput("start", { action: "append", text: "中" }, false)).toEqual({
      text: "start中", truncated: false,
    });
    expect(applyVisibleOutput("乱码", { action: "replace", text: "中文" }, true)).toEqual({
      text: "中文", truncated: false,
    });
  });

  it("keeps only the recent 64000 characters without starting at a low surrogate", () => {
    const result = applyVisibleOutput("", { action: "append", text: `😀${"x".repeat(63_999)}` }, false);
    expect(result.text).toBe("x".repeat(63_999));
    expect(result.truncated).toBe(true);
  });

  it("rejects malformed output events before they reach a tool record", () => {
    expect(normalizeShellOutputEvent({ toolCallId: "", action: "append", text: "x" })).toBeNull();
    expect(normalizeShellOutputEvent({ toolCallId: "a", action: "clear", text: "x" })).toBeNull();
    expect(normalizeShellOutputEvent({ toolCallId: "a", action: "append", text: 42 })).toBeNull();
    expect(normalizeShellOutputEvent({ toolCallId: "a", action: "replace", text: "ok" })).toEqual({
      toolCallId: "a", action: "replace", text: "ok", truncated: false,
    });
  });
});
