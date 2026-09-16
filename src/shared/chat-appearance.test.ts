import { describe, expect, it } from "vitest";
import { normalizeChatAppearance } from "./chat-appearance";

describe("normalizeChatAppearance", () => {
  it("normalizes the line height and ignores removed bubble fields", () => {
    expect(normalizeChatAppearance({ chatLineHeight: 1.6, assistantBubbleEnabled: true })).toEqual({
      chatLineHeight: 1.6,
    });
  });

  it("falls back to the default line height for invalid input", () => {
    expect(normalizeChatAppearance(null)).toEqual({ chatLineHeight: 1.75 });
    expect(normalizeChatAppearance({ chatLineHeight: "wide" })).toEqual({ chatLineHeight: 1.75 });
  });
});
