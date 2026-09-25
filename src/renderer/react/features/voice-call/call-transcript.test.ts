import { describe, expect, it } from "vitest";
import { applyCallTranscriptEvent, type CallTranscriptMessage } from "./call-transcript";

describe("call transcript events", () => {
  it("updates one user bubble from partial to final text and appends the spoken reply", () => {
    const partial = applyCallTranscriptEvent([], { speaker: "user", text: "今天天气", final: false });
    const final = applyCallTranscriptEvent(partial, { speaker: "user", text: "今天天气不错", final: true });
    const conversation = applyCallTranscriptEvent(final, { speaker: "assistant", text: "是呀，很适合出去走走。" });

    expect(conversation).toEqual<CallTranscriptMessage[]>([
      { id: 1, speaker: "user", text: "今天天气不错", final: true },
      { id: 2, speaker: "assistant", text: "是呀，很适合出去走走。", final: true },
    ]);
  });
});
