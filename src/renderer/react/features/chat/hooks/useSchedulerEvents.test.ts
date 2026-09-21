// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { useSchedulerEvents } from "./useSchedulerEvents";
import type { ChatMessageItem } from "../components/ChatMessageList";
import { ConversationJournalService } from "../../../../../main/orchestrator/conversation-journal-service";
import { ConversationTranscriptStore } from "../../../../../main/orchestrator/conversation-transcript-store";

type EventCallback = (event: unknown) => void;

let root: Root | null = null;
let host: HTMLElement | null = null;
let listener: EventCallback | null = null;
let appended: Array<{ sessionId: string; items: ChatMessageItem[] }> = [];
let patched: Array<{ sessionId: string; id: string; patch: Partial<ChatMessageItem> }> = [];
let liveMessages = new Map<string, ChatMessageItem>();

function emit(event: unknown): void {
  act(() => {
    listener?.(event);
  });
}

beforeEach(() => {
  listener = null;
  appended = [];
  patched = [];
  liveMessages = new Map();
  (window as unknown as { schedulerEvents?: unknown }).schedulerEvents = {
    onEvent: (callback: EventCallback) => {
      listener = callback;
      return () => { listener = null; };
    },
  };
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

  function Probe() {
    useSchedulerEvents({
      appendMessages: (sessionId, items) => {
        appended.push({ sessionId, items });
        for (const item of items) liveMessages.set(item.id, item);
      },
      patchMessage: (sessionId, id, patch) => {
        patched.push({ sessionId, id, patch });
        const current = liveMessages.get(id);
        if (current) liveMessages.set(id, { ...current, ...patch });
      },
    });
    return null;
  }

  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => {
    root!.render(createElement(Probe));
  });
});

afterEach(() => {
  if (root) {
    act(() => {
      root!.unmount();
    });
    root = null;
  }
  if (host) {
    host.remove();
    host = null;
  }
  delete (window as unknown as { schedulerEvents?: unknown }).schedulerEvents;
});

describe("useSchedulerEvents", () => {
  it("触发事件按主进程冻结的会话插入提示消息与助手占位", () => {
    emit({
      type: "CUSTOM",
      name: "scheduler.started",
      schedulerRunId: "hist-1",
      schedulerTaskId: "task-1",
      conversationId: "session-a",
      value: { taskId: "task-1", title: "每日摘要", manual: true, runId: "hist-1" },
    });

    expect(appended).toHaveLength(1);
    expect(appended[0].sessionId).toBe("session-a");
    const [notice, reply] = appended[0].items;
    expect(notice.content).toBe("定时任务「每日摘要」已触发");
    expect(notice.role).toBe("user");
    expect(reply.loading).toBe(true);
    expect(reply.waitingForFirstEvent).toBe(true);
  });

  it("无激活会话时不插入消息且后续事件被忽略", () => {
    emit({
      type: "CUSTOM",
      name: "scheduler.started",
      schedulerRunId: "hist-2",
      conversationId: undefined,
      value: { title: "清理任务" },
    });
    emit({ type: "TEXT_MESSAGE_CONTENT", delta: "hello", schedulerRunId: "hist-2" });
    emit({ type: "RUN_FINISHED", schedulerRunId: "hist-2" });

    expect(appended).toHaveLength(0);
    expect(patched).toHaveLength(0);
  });

  it("流式文本累积补丁到占位消息，终态落库完整回复", () => {
    emit({
      type: "CUSTOM",
      name: "scheduler.started",
      schedulerRunId: "hist-3",
      conversationId: "session-a",
      value: { title: "天气播报" },
    });
    emit({ type: "TEXT_MESSAGE_START", schedulerRunId: "hist-3" });
    emit({ type: "TEXT_MESSAGE_CONTENT", delta: "今天", schedulerRunId: "hist-3" });
    emit({ type: "TEXT_MESSAGE_CONTENT", delta: "晴天", schedulerRunId: "hist-3" });
    emit({ type: "TEXT_MESSAGE_END", schedulerRunId: "hist-3" });
    emit({ type: "RUN_FINISHED", schedulerRunId: "hist-3" });

    const contentPatches = patched.filter((entry) => entry.patch.content !== undefined);
    expect(contentPatches.at(-1)!.patch.content).toBe("今天晴天");
    const finalPatch = patched.at(-1)!;
    expect(finalPatch.patch.streaming).toBe(false);
    expect(finalPatch.patch.loading).toBe(false);
  });

  it("工具调用事件补丁 toolExecutions，无文本时终态汇总工具结果", () => {
    emit({
      type: "CUSTOM",
      name: "scheduler.started",
      schedulerRunId: "hist-4",
      conversationId: "session-a",
      value: { title: "磁盘巡检" },
    });
    emit({ type: "TOOL_CALL_START", toolCallId: "t1", toolCallName: "disk_usage", schedulerRunId: "hist-4" });
    emit({ type: "TOOL_CALL_RESULT", toolCallId: "t1", content: "C: 80%", status: "success", schedulerRunId: "hist-4" });
    const runSnapshot = { runId: "hist-4", status: "terminal" as const, terminalStatus: "success" as const, updatedAt: 42 };
    emit({ type: "RUN_FINISHED", content: "disk_usage：完成", toolExecutions: [{ id: "t1", name: "disk_usage", status: "success", result: "C: 80%" }], runSnapshot, schedulerRunId: "hist-4" });

    const toolPatches = patched.filter((entry) => entry.patch.toolExecutions !== undefined);
    expect(toolPatches.at(-1)!.patch.toolExecutions).toEqual([
      { id: "t1", name: "disk_usage", status: "success", result: "C: 80%" },
    ]);
    expect(patched.at(-1)!.patch.content).toBe("disk_usage：完成");
    expect(patched.at(-1)!.patch.runSnapshot).toEqual(runSnapshot);
  });

  it("live hook reducer matches a real journal reload projection", async () => {
    const rootPath = fs.mkdtempSync(path.join(os.tmpdir(), "cta-scheduler-hook-reload-"));
    try {
      const journal = new ConversationJournalService(new ConversationTranscriptStore(rootPath, { now: () => 1_000 }));
      const conversationId = "session-hook-reload";
      const runId = "hist-hook-reload";
      const replyId = "scheduler-reply-hist-hook-reload";
      const tools = [{ id: "t1", name: "disk_usage", status: "success" as const, result: "C: 80%" }];
      const runSnapshot = { runId, status: "terminal" as const, terminalStatus: "success" as const, updatedAt: 2_000 };
      await journal.appendUser(conversationId, { id: "scheduler-notice-hist-hook-reload", turnId: runId, text: "整理资料", runId });
      const sink = journal.createRunSink({ conversationId, runId, assistantTurnId: replyId });
      const assistantId = await sink.appendAssistant({ message: { role: "assistant", content: "disk_usage：完成", toolCalls: [{ id: "t1", name: "disk_usage", arguments: "{}" }] } });
      await sink.appendToolResult({ assistantEntryId: assistantId, message: { role: "tool", toolCallId: "t1", content: "C: 80%" }, outcome: "success" });
      await journal.appendPresentationNext(conversationId, replyId, "scheduler:hook-reload:reply", { content: "disk_usage：完成", toolExecutions: tools, runSnapshot });

      emit({ type: "CUSTOM", name: "scheduler.started", schedulerRunId: runId, conversationId, value: { title: "整理资料", runId, noticeId: "scheduler-notice-hist-hook-reload", replyId } });
      emit({ type: "TOOL_CALL_START", schedulerRunId: runId, toolCallId: "t1", toolCallName: "disk_usage" });
      emit({ type: "TOOL_CALL_RESULT", schedulerRunId: runId, toolCallId: "t1", content: "C: 80%", status: "success" });
      emit({ type: "RUN_FINISHED", schedulerRunId: runId, messageId: replyId, content: "disk_usage：完成", toolExecutions: tools, runSnapshot });

      const reloaded = (await journal.readProjection(conversationId)).messages.find((message) => message.id === replyId);
      const live = liveMessages.get(replyId);
      expect({ id: live?.id, content: live?.content, toolExecutions: live?.toolExecutions, runSnapshot: live?.runSnapshot })
        .toEqual({ id: reloaded?.id, content: reloaded?.content, toolExecutions: reloaded?.toolExecutions, runSnapshot: reloaded?.runSnapshot });
    } finally {
      fs.rmSync(rootPath, { recursive: true, force: true });
    }
  });

  it("RUN_ERROR 终态展示并落库失败信息", () => {
    emit({
      type: "CUSTOM",
      name: "scheduler.started",
      schedulerRunId: "hist-5",
      conversationId: "session-a",
      value: { title: "失败任务" },
    });
    emit({ type: "RUN_ERROR", message: "模型超时", schedulerRunId: "hist-5" });

    expect(patched.at(-1)!.patch.content).toBe("定时任务执行失败：模型超时");
  });

  it("卸载后解除监听：回调不再触发消息写入", () => {
    act(() => {
      root!.unmount();
    });
    root = null;
    listener?.({ type: "CUSTOM", name: "scheduler.started", schedulerRunId: "hist-6" });
    expect(appended).toHaveLength(0);
  });
});
