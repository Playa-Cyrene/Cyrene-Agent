import { describe, expect, it } from "vitest";
import { projectTaskTraceEvent } from "./task-events";

describe("projectTaskTraceEvent", () => {
  it("sanitizes a tool start into a private trace record", () => {
    const record = projectTaskTraceEvent({
      type: "tool_start",
      toolCallId: "call-1",
      toolName: "read_file",
      args: { path: "E:\\secret.txt", token: "do-not-store" },
    }, 1_000, () => "trace-1");

    expect(record).toEqual({
      id: "trace-1",
      at: 1_000,
      kind: "tool",
      phase: "start",
      label: "read_file",
      toolCallId: "call-1",
    });
    expect(JSON.stringify(record)).not.toContain("secret");
    expect(JSON.stringify(record)).not.toContain("token");
  });

  it("projects bounded public progress and terminal state", () => {
    const progress = projectTaskTraceEvent(
      { type: "progress_text", content: "x".repeat(2_100) },
      2_000,
      () => "trace-2",
    );
    const terminal = projectTaskTraceEvent(
      { type: "error", message: "模型断开" },
      3_000,
      () => "trace-3",
    );

    expect(progress).toMatchObject({ kind: "progress", content: `${"x".repeat(2_000)}…` });
    expect(terminal).toEqual({
      id: "trace-3",
      at: 3_000,
      kind: "terminal",
      status: "error",
      content: "模型断开",
    });
  });

  it("ignores events that do not form a child trace", () => {
    expect(projectTaskTraceEvent({ type: "ask_user", card: {} }, 1, () => "trace-4")).toBeUndefined();
  });
});
