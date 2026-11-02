import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatSessionRecord } from "../../shared/chat-types";
import { SummaryMemoryScheduler } from "./summary-memory-scheduler";
import { summarizeMemory } from "./summary-memory-llm";
import { writeSummaryFileAtomic } from "./summary-memory-store";

vi.mock("./memory-mode", () => ({ isSummaryMemoryEnabled: () => true }));
vi.mock("./summary-memory-llm", () => ({ summarizeMemory: vi.fn() }));
vi.mock("./summary-memory-store", () => ({
  readSummaryFile: vi.fn(async () => ({ content: "", truncated: false })),
  writeSummaryFileAtomic: vi.fn(async () => undefined),
}));

function deferred<T>() {
  let resolve!: (value: T) => void;
  // 模型替身故意不响应 AbortSignal，由用例显式完成响应；此 Promise 不创建 I/O 或定时器。
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

const result = { sessionSummary: "new session summary", workspaceSummary: "new workspace summary" };
let scheduler: SummaryMemoryScheduler;
beforeEach(() => { vi.clearAllMocks(); });
afterEach(() => { scheduler?.dispose(); });

function setup(workspace = false) {
  const sessions = {
    getSessionRecord: vi.fn(async () => ({
      mode: workspace ? "code" : "chat",
      ...(workspace ? { workspaceBinding: { workspaceRoot: path.resolve("test-workspace") } } : {}),
    }) as ChatSessionRecord),
    getSummaryMemoryProgress: vi.fn(async () => ({ pendingTurns: [{
      assistantEntryId: "assistant-1", userText: "user", assistantText: "assistant",
    }] })),
    appendSummaryMemoryTurn: vi.fn(async () => true),
    markSummaryMemoryProcessed: vi.fn(async () => true),
    listSessions: vi.fn(async () => [{ id: "a" }, { id: "b" }]),
  };
  // 正常结束或断言失败均由 afterEach dispose，不能指望它完成忽略取消信号的模型替身。
  scheduler = new SummaryMemoryScheduler({ userDataRoot: path.resolve("test-user-data"), sessions });
  scheduler.setEnabled(true);
  return sessions;
}

describe("摘要任务取消与代际检查", () => {
  it.each(["取消会话", "关闭后重新启用"])("模型忽略取消信号返回后，%s仍阻止写盘和进度提交", async (action) => {
    const sessions = setup();
    const response = deferred<typeof result>();
    vi.mocked(summarizeMemory).mockReturnValueOnce(response.promise);
    const run = scheduler.flushSummary("a");
    await vi.waitFor(() => expect(summarizeMemory).toHaveBeenCalledOnce());
    let cancellation: Promise<void> | undefined;
    if (action === "取消会话") cancellation = scheduler.cancelSession("a");
    else { scheduler.setEnabled(false); scheduler.setEnabled(true); }
    response.resolve(result);
    await run;
    await cancellation;
    expect(writeSummaryFileAtomic).not.toHaveBeenCalled();
    expect(sessions.markSummaryMemoryProcessed).not.toHaveBeenCalled();
  });

  it("等待共享工作区队列期间失效的任务不再调用模型", async () => {
    const sessions = setup(true);
    const response = deferred<typeof result>();
    vi.mocked(summarizeMemory).mockReturnValue(response.promise);
    const first = scheduler.flushSummary("a");
    await vi.waitFor(() => expect(summarizeMemory).toHaveBeenCalledOnce());
    const second = scheduler.flushSummary("b");
    await vi.waitFor(() => expect(sessions.getSummaryMemoryProgress).toHaveBeenCalledWith("b"));
    scheduler.setEnabled(false);
    response.resolve(result);
    await Promise.all([first, second]);
    expect(summarizeMemory).toHaveBeenCalledOnce();
    expect(writeSummaryFileAtomic).not.toHaveBeenCalled();
    expect(sessions.markSummaryMemoryProcessed).not.toHaveBeenCalled();
  });

  it("有效任务仍会写入摘要并确认对应轮次", async () => {
    const sessions = setup();
    vi.mocked(summarizeMemory).mockResolvedValue(result);
    await scheduler.flushSummary("a");
    expect(writeSummaryFileAtomic).toHaveBeenCalledOnce();
    expect(sessions.markSummaryMemoryProcessed).toHaveBeenCalledWith("a", [{ assistantEntryId: "assistant-1" }]);
  });
});
