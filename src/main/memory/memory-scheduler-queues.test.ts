import { afterEach, describe, expect, it, vi } from "vitest";
import { SummaryMemoryScheduler } from "./summary-memory-scheduler";
import { WikiMemoryScheduler } from "./wiki-memory-scheduler";

vi.mock("./memory-mode", () => ({ isSummaryMemoryEnabled: () => true, isWikiMemoryEnabled: () => true }));
vi.mock("./summary-memory-llm", () => ({ summarizeMemory: vi.fn() }));
vi.mock("./summary-memory-store", () => ({ readSummaryFile: vi.fn(), writeSummaryFileAtomic: vi.fn() }));
vi.mock("./wiki-memory-llm", () => ({ extractWikiClaims: vi.fn() }));
vi.mock("./wiki-memory-health", () => ({ markWikiSourcesFresh: vi.fn(), markWikiSourcesStale: vi.fn() }));
vi.mock("./wiki-store", () => ({ WikiStore: class { async close() {} } }));

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe("后台记忆队列拒绝清理", () => {
  it.each(["summary", "wiki"] as const)("%s 任务失败只向调用者传播，队列空闲时没有额外未处理拒绝且可继续工作", async (kind) => {
    // 仅替换 backfill 定时器；保留真实事件循环以观察 unhandledRejection。
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const failure = new Error("source unavailable");
    const read = vi.fn().mockRejectedValueOnce(failure).mockResolvedValue(null);
    const unhandled: unknown[] = [];
    const record = (error: unknown) => { unhandled.push(error); };
    process.on("unhandledRejection", record);
    const summary = new SummaryMemoryScheduler({
      userDataRoot: "unused-test-root",
      sessions: {
        getSessionRecord: read,
        getSummaryMemoryProgress: vi.fn(),
        appendSummaryMemoryTurn: vi.fn(),
        markSummaryMemoryProcessed: vi.fn(),
        listSessions: vi.fn(async () => []),
      },
    });
    const wiki = new WikiMemoryScheduler({
      userDataRoot: "unused-test-root",
      sourceReader: { readConversation: read, listConversationIds: async () => ["session"] },
    });
    try {
      if (kind === "summary") summary.setEnabled(true);
      else await wiki.setEnabled(true);
      const flush = () => kind === "summary" ? summary.flushSummary("session") : wiki.flushConversation("session");
      await expect(flush()).rejects.toBe(failure);
      await new Promise<void>((resolve) => setImmediate(resolve));
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(unhandled).toEqual([]);
      await expect(flush()).resolves.toBeUndefined();
      expect(read).toHaveBeenCalledTimes(2);
    } finally {
      summary.dispose();
      await wiki.setEnabled(false);
      process.off("unhandledRejection", record);
    }
  });
});
