import { describe, expect, it } from "vitest";
import type { TaskSession, TaskTraceRecord } from "../../../../../shared/task-session";
import { buildFlatRunTimeline } from "./agent-rounds";
import { toTaskChatMessages } from "./task-session-presentation";

function session(patch: Partial<TaskSession> = {}): TaskSession {
  return {
    schemaVersion: 1, id: "task-1", parentConversationId: "parent", parentRunId: "parent-run",
    childRunId: "run-1", description: "检查文件", subagentType: "general", mode: "code",
    status: "completed", messages: [], trace: [], todoItems: [], createdAt: 1, updatedAt: 100,
    completedAt: 100, ...patch,
  };
}

function trace(records: Array<Omit<TaskTraceRecord, "id" | "at">>): TaskTraceRecord[] {
  return records.map((record, index) => ({ id: `trace-${index}`, at: index + 2, ...record }));
}

describe("task session chat presentation", () => {
  it("keeps process text and tools before one final answer using the main chat fields", () => {
    const messages = toTaskChatMessages(session({
      messages: [
        { role: "user", content: "检查文件" },
        { role: "assistant", content: "先读取文件", toolCalls: [{ id: "call-1", name: "read_file", arguments: '{"path":"a.ts"}' }] },
        { role: "tool", toolCallId: "call-1", content: "文件内容" },
        { role: "assistant", content: "检查完成" },
      ],
      resultText: "检查完成",
      trace: trace([
        { kind: "round", phase: "start", label: "round-0" },
        { kind: "reasoning", phase: "delta", label: "reason-0", content: "检查结构", roundId: "round-0" },
        { kind: "progress", content: "先读取文件", roundId: "round-0" },
        { kind: "tool", phase: "start", label: "read_file", roundId: "round-0" },
        { kind: "tool", phase: "end", label: "call-1", status: "success", roundId: "round-0" },
        { kind: "round", phase: "end", label: "round-0" },
      ]),
    }));
    expect(messages.map(({ role, content }) => [role, content])).toEqual([
      ["user", "检查文件"], ["assistant", "检查完成"],
    ]);
    const assistant = messages[1]!;
    expect(assistant.toolExecutions).toMatchObject([{ id: "call-1", status: "success", argsText: '{"path":"a.ts"}', result: "文件内容", roundId: "round-0" }]);
    expect(assistant.reasoningBlocks?.[0].streaming).toBe(false);
    expect(buildFlatRunTimeline({ processMessages: assistant.processMessages ?? [], reasoningBlocks: assistant.reasoningBlocks ?? [], tools: assistant.toolExecutions ?? [], taskDelegations: [] }).map((entry) => entry.kind)).toEqual(["reasoning", "process", "tool"]);
  });

  it("matches parallel calls by call id even when canonical calls use a different order", () => {
    const messages = toTaskChatMessages(session({
      messages: [
        { role: "user", content: "并行读取" },
        { role: "assistant", content: "", toolCalls: [
          { id: "a", name: "read_file", arguments: '{"path":"a.ts"}' },
          { id: "b", name: "read_file", arguments: '{"path":"b.ts"}' },
        ] },
        { role: "tool", toolCallId: "a", content: "A" },
        { role: "tool", toolCallId: "b", content: "B" },
      ],
      trace: trace([
        { kind: "tool", phase: "start", label: "read_file", toolCallId: "b", roundId: "round-0" },
        { kind: "tool", phase: "start", label: "read_file", toolCallId: "a", roundId: "round-1" },
        { kind: "tool", phase: "end", label: "a", status: "failure" },
        { kind: "tool", phase: "end", label: "b", status: "success" },
      ]),
    }));
    expect(messages[1]?.toolExecutions).toMatchObject([
      { id: "b", status: "success", result: "B", seq: 0, roundId: "round-0" },
      { id: "a", status: "error", result: "A", seq: 1, roundId: "round-1" },
    ]);
  });

  it("keeps resumed invocations below their own instructions even when round ids repeat", () => {
    const messages = toTaskChatMessages(session({
      childRunId: "run-2", resultText: "第二次结论",
      messages: [
        { role: "user", content: "第一次指令" },
        { role: "assistant", content: "第一次结论" },
        { role: "user", content: "第二次指令" },
        { role: "assistant", content: "第二次结论" },
      ],
      trace: trace([
        { kind: "round", phase: "start", label: "round-0" },
        { kind: "progress", content: "第一次过程", roundId: "round-0" },
        { kind: "round", phase: "end", label: "round-0" },
        { kind: "round", phase: "start", label: "round-0" },
        { kind: "progress", content: "第二次过程", roundId: "round-0" },
        { kind: "round", phase: "end", label: "round-0" },
      ]),
    }));
    expect(messages.map(({ role, content }) => [role, content])).toEqual([
      ["user", "第一次指令"], ["assistant", "第一次结论"],
      ["user", "第二次指令"], ["assistant", "第二次结论"],
    ]);
    expect(messages[1]?.processMessages?.map((message) => message.content)).toEqual(["第一次过程"]);
    expect(messages[3]?.processMessages?.map((message) => message.content)).toEqual(["第二次过程"]);
  });

  it("shows trace-only tools at terminal instead of dropping them with an old messages snapshot", () => {
    const messages = toTaskChatMessages(session({
      messages: [{ role: "user", content: "检查文件" }], resultText: "完成",
      trace: trace([
        { kind: "tool", phase: "start", label: "read_file", toolCallId: "call-1" },
        { kind: "tool", phase: "end", label: "call-1", status: "success" },
      ]),
    }));
    expect(messages[1]?.toolExecutions).toMatchObject([{ id: "call-1", name: "read_file", status: "success" }]);
  });

  it("uses canonical tool outcomes when the bounded trace no longer contains the call", () => {
    const messages = toTaskChatMessages(session({
      messages: [
        { role: "user", content: "检查" },
        { role: "assistant", content: "", toolCalls: [{ id: "call-1", name: "read_file", arguments: "{}" }] },
        { role: "tool", toolCallId: "call-1", content: "内容", presentation: { outcome: "success" } },
      ],
    }));
    expect(messages[1]?.toolExecutions).toMatchObject([{ id: "call-1", status: "success", result: "内容" }]);
  });

  it("preserves reasoning placement after tools when old trace round boundaries are missing", () => {
    const messages = toTaskChatMessages(session({
      messages: [{ role: "user", content: "检查" }],
      trace: trace([
        { kind: "tool", phase: "start", label: "read_file", toolCallId: "call-1" },
        { kind: "tool", phase: "end", label: "call-1", status: "success" },
        { kind: "reasoning", phase: "delta", label: "reason-1", content: "分析文件" },
      ]),
    }));
    expect(messages[1]?.agentRounds).toEqual([]);
    expect(messages[1]?.reasoningBlocks).toMatchObject([{ afterToolCount: 1 }]);
  });

  it("keeps only the current undiscarded candidate live and never repeats settled process text", () => {
    const messages = toTaskChatMessages(session({
      status: "running", completedAt: undefined,
      messages: [{ role: "user", content: "检查文件" }, { role: "assistant", content: "先检查", toolCalls: [] }],
      trace: trace([
        { kind: "candidate", phase: "delta", label: "round-0", content: "先检查" },
        { kind: "candidate", phase: "discard", label: "round-0" },
        { kind: "progress", content: "先检查", roundId: "round-0" },
        { kind: "candidate", phase: "delta", label: "round-1", content: "最终答" },
      ]),
    }));
    expect(messages.map((message) => message.content)).toEqual(["检查文件", ""]);
    expect(messages[1]).toMatchObject({ transientText: "最终答", streaming: true, loading: true });
    expect(messages[1]?.processMessages?.map((message) => message.content)).toEqual(["先检查"]);
  });

  it("does not leave reasoning or tools running after interruption", () => {
    const messages = toTaskChatMessages(session({
      status: "interrupted", messages: [{ role: "user", content: "检查" }],
      trace: trace([
        { kind: "round", phase: "start", label: "round-0" },
        { kind: "reasoning", phase: "delta", label: "reason-1", content: "分析", roundId: "round-0" },
        { kind: "tool", phase: "start", label: "read_file", toolCallId: "call-1", roundId: "round-0" },
      ]),
    }));
    expect(messages[1]?.reasoningBlocks).toMatchObject([{ streaming: false }]);
    expect(messages[1]?.toolExecutions).toMatchObject([{ status: "error" }]);
    expect(messages[1]?.runActivity?.keepExpanded).toBe(true);
  });

  it("keeps old activity with its invocation while a resumed run has not emitted its first event", () => {
    const messages = toTaskChatMessages(session({
      status: "running", childRunId: "run-2", completedAt: undefined,
      messages: [
        { role: "user", content: "第一次", presentation: { runId: "run-1" } },
        { role: "assistant", content: "第一次结论" },
        { role: "user", content: "第二次", presentation: { runId: "run-2" } },
      ],
      trace: trace([{ kind: "progress", content: "第一次过程", runId: "run-1" }]),
    }));
    expect(messages[1]?.processMessages?.map((message) => message.content)).toEqual(["第一次过程"]);
    expect(messages[3]?.processMessages).toEqual([]);
  });

  it("replaces bounded progress with its full canonical text without duplicating the same round", () => {
    const full = "说明".repeat(1100);
    const messages = toTaskChatMessages(session({
      messages: [
        { role: "user", content: "检查" },
        { role: "assistant", content: full, toolCalls: [{ id: "call-1", name: "read_file", arguments: "{}" }] },
        { role: "assistant", content: "完成" },
      ],
      trace: trace([
        { kind: "round", phase: "start", label: "round-0" },
        { kind: "progress", content: full.slice(0, 2000) + "…", roundId: "round-0" },
        { kind: "tool", phase: "start", label: "read_file", toolCallId: "call-1", roundId: "round-0" },
      ]),
    }));
    expect(messages[1]?.processMessages?.map((message) => message.content)).toEqual([full]);
  });
});
