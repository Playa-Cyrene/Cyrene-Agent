import { describe, expect, it } from "vitest";
import { assertValidPresentationPatch } from "./conversation-transcript-types";

describe("terminal output presentation persistence", () => {
  it("accepts a bounded shell output record for reload", () => {
    expect(() => assertValidPresentationPatch({ toolExecutions: [{
      id: "shell-1", name: "run_shell", status: "success",
      terminalOutput: "编译成功\n", terminalOutputTruncated: false,
    }] })).not.toThrow();
  });

  it("rejects malformed terminal output fields", () => {
    expect(() => assertValidPresentationPatch({ toolExecutions: [{
      id: "shell-1", name: "run_shell", status: "success", terminalOutput: 123,
    }] })).toThrow("TRANSCRIPT_INVALID_PRESENTATION_PATCH");
  });
});
