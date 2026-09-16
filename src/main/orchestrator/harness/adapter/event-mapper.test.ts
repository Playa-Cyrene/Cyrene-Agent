import { describe, expect, it } from "vitest";
import type { BaseEvent } from "@ag-ui/core";
import type { HarnessEvent } from "../types";
import { sendHarnessEventAsAgui, sendTaskLifecycleAsAgui } from "./event-mapper";

describe("harness event mapper", () => {
  const capture = (event: HarnessEvent): BaseEvent[] => {
    const sent: BaseEvent[] = [];
    sendHarnessEventAsAgui(event, "msg-1", "thread-1", "run-1", (value) => sent.push(value));
    return sent;
  };

  it("stamps and orders terminal tool result before tool end", () => {
    const sent = capture({
      type: "tool_end",
      toolCallId: "call-1",
      preview: "done",
      outcome: "success",
    });

    expect(sent).toHaveLength(2);
    expect(sent[0]).toMatchObject({ type: "TOOL_CALL_RESULT", runId: "run-1", status: "success" });
    expect(sent[1]).toMatchObject({ type: "TOOL_CALL_END", runId: "run-1" });
  });

  it("maps final answers into one AG-UI text message", () => {
    expect(capture({ type: "final_answer", content: "完成" })).toEqual([
      expect.objectContaining({ type: "TEXT_MESSAGE_START", runId: "run-1" }),
      expect.objectContaining({ type: "TEXT_MESSAGE_CONTENT", delta: "完成", runId: "run-1" }),
      expect.objectContaining({ type: "TEXT_MESSAGE_END", runId: "run-1" }),
    ]);
  });

  it("maps candidate text as a round-scoped custom event without opening a formal message", () => {
    expect(capture({
      type: "candidate_text_delta",
      roundId: "round-2",
      delta: "正在生成",
    } as HarnessEvent)).toEqual([
      expect.objectContaining({
        type: "CUSTOM",
        name: "cyrene.candidate_text",
        value: { action: "delta", roundId: "round-2", delta: "正在生成" },
        runId: "run-1",
      }),
    ]);
  });

  it("maps candidate discard without emitting formal text events", () => {
    expect(capture({
      type: "candidate_text_discard",
      roundId: "round-2",
    } as HarnessEvent)).toEqual([
      expect.objectContaining({
        type: "CUSTOM",
        name: "cyrene.candidate_text",
        value: { action: "discard", roundId: "round-2" },
        runId: "run-1",
      }),
    ]);
  });

  it("maps task lifecycle presentation to a stamped custom event", () => {
    const sent: BaseEvent[] = [];
    sendTaskLifecycleAsAgui({ taskId: "task-1", status: "running" } as never, "thread-1", "run-1", (event) => sent.push(event));
    expect(sent).toEqual([
      expect.objectContaining({ type: "CUSTOM", name: "cyrene.task", runId: "run-1" }),
    ]);
  });
});
