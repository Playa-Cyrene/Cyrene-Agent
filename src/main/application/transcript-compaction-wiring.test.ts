import { describe, expect, it, vi } from "vitest";
import type { ConversationTranscriptCompactor } from "../orchestrator/conversation-transcript-compactor";
import { createTranscriptCompactorGetter } from "./transcript-compaction-wiring";

describe("transcript compaction production wiring", () => {
  it("为 automatic 与 manual consumer 提供同一 compactor 实例", () => {
    const compactor = {} as ConversationTranscriptCompactor;
    const factory = vi.fn(() => compactor);
    const getCompactor = createTranscriptCompactorGetter(factory);

    const automaticCompactor = getCompactor();
    const manualCompactor = getCompactor();

    expect(automaticCompactor).toBe(compactor);
    expect(manualCompactor).toBe(automaticCompactor);
    expect(factory).toHaveBeenCalledTimes(1);
  });
});
