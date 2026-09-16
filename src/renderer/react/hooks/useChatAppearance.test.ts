import { beforeEach, describe, expect, it, vi } from "vitest";
import { applyChatAppearance } from "./useChatAppearance";

describe("applyChatAppearance", () => {
  const setProperty = vi.fn();
  const dataset: Record<string, string> = {};

  beforeEach(() => {
    setProperty.mockReset();
    for (const key of Object.keys(dataset)) delete dataset[key];
    vi.stubGlobal("document", {
      documentElement: {
        dataset,
        style: { setProperty },
      },
    });
  });

  it("applies the line height and never toggles an assistant bubble dataset", () => {
    applyChatAppearance({ chatLineHeight: 1.6 });

    expect(setProperty).toHaveBeenCalledWith("--cy-chat-line-height", "1.6");
    expect(dataset.assistantBubble).toBeUndefined();
  });
});
