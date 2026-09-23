import { describe, expect, it } from "vitest";
import {
  crashedInterruptionEntryId,
  reconcileCrashedInterruptions,
  type CrashReconciliationDeps,
} from "./conversation-interruption-reconciliation";
import { type TranscriptAppendInput, type TranscriptEntry, type TranscriptSnapshotV2 } from "./conversation-transcript-types";

/** 内存转录 store 假件：记录已追加条目，read 返回快照。 */
function createFakeTranscriptStore(initial: Record<string, TranscriptEntry[]> = {}) {
  const entriesByConversation = new Map<string, TranscriptEntry[]>(
    Object.entries(initial).map(([id, entries]) => [id, [...entries]]),
  );
  const appended: TranscriptEntry[] = [];
  let seqCounter = 100;
  return {
    appended,
    async read(conversationId: string): Promise<TranscriptSnapshotV2> {
      const entries = entriesByConversation.get(conversationId) ?? [];
      return {
        schemaVersion: 1 as never,
        throughSeq: entries.length ? Math.max(...entries.map((e) => e.seq)) : 0,
        entries,
        projection: { throughSeq: 0, messages: [] },
        seenEntryIds: entries.map((e) => e.id),
        seenUserRevisions: [],
      };
    },
    async append(conversationId: string, input: TranscriptAppendInput): Promise<TranscriptEntry> {
      const entry = {
        ...input,
        at: input.at ?? seqCounter,
        seq: ++seqCounter,
        id: input.id,
      } as TranscriptEntry;
      let list = entriesByConversation.get(conversationId);
      if (!list) {
        list = [];
        entriesByConversation.set(conversationId, list);
      }
      // 幂等：entryId 首写有效
      if (!list.some((e) => e.id === entry.id)) list.push(entry);
      appended.push(entry);
      return entry;
    },
    _entries: entriesByConversation,
  };
}

function interruptedRun(conversationId: string, runId: string) {
  return { conversationId, runId } as never;
}

describe("reconcileCrashedInterruptions", () => {
  it("无中断边界的 interrupted run 补写 crashed 边界，entryId 确定性生成", async () => {
    const transcript = createFakeTranscriptStore();
    const result = await reconcileCrashedInterruptions({
      runStore: {
        listInterruptedRuns: () => [
          interruptedRun("conv-crash", "run-crash"),
        ],
      },
      transcriptStore: transcript as never,
      now: () => 1234,
    });

    expect(result).toEqual({ written: 1, skipped: 0 });
    expect(transcript.appended).toHaveLength(1);
    const entry = transcript.appended[0];
    expect(entry.id).toBe(crashedInterruptionEntryId("run-crash"));
    expect(entry.kind).toBe("interruption");
    expect(entry.runId).toBe("run-crash");
    expect(entry).toMatchObject({ at: 1234, id: "run-crash:interruption:crashed" });
    expect((entry as Extract<TranscriptEntry, { kind: "interruption" }>).payload).toEqual({
      reason: "crashed",
    });
  });

  it("已有该 runId 的取消边界 → 跳过，不补写", async () => {
    const interruptionEntry = {
      seq: 5,
      id: "run-keep:interruption:user_cancel",
      at: 5,
      runId: "run-keep",
      kind: "interruption",
      payload: { reason: "user_cancel" },
    } as TranscriptEntry;
    const transcript = createFakeTranscriptStore({ "conv-keep": [interruptionEntry] });

    const result = await reconcileCrashedInterruptions({
      runStore: { listInterruptedRuns: () => [interruptedRun("conv-keep", "run-keep")] },
      transcriptStore: transcript as never,
    });

    expect(result).toEqual({ written: 0, skipped: 1 });
    expect(transcript.appended).toHaveLength(0);
  });

  it("已有崩溃边界（先前启动已补）→ 跳过，不重复补写（幂等）", async () => {
    const crashEntry = {
      seq: 5,
      id: crashedInterruptionEntryId("run-a"),
      at: 5,
      runId: "run-a",
      kind: "interruption",
      payload: { reason: "crashed" },
    } as TranscriptEntry;
    const transcript = createFakeTranscriptStore({ "conv-a": [crashEntry] });

    const result = await reconcileCrashedInterruptions({
      runStore: { listInterruptedRuns: () => [interruptedRun("conv-a", "run-a")] },
      transcriptStore: transcript as never,
    });

    expect(result).toEqual({ written: 0, skipped: 1 });
    expect(transcript.appended).toHaveLength(0);
  });

  it("多 run 混合：只补缺边界的，已有边界的跳过", async () => {
    const crashBoundary = {
      seq: 10,
      id: crashedInterruptionEntryId("run-done"),
      at: 10,
      runId: "run-done",
      kind: "interruption",
      payload: { reason: "crashed" },
    } as TranscriptEntry;
    const transcript = createFakeTranscriptStore({ "conv-done": [crashBoundary] });

    const result = await reconcileCrashedInterruptions({
      runStore: {
        listInterruptedRuns: () => [
          interruptedRun("conv-a", "run-a"),
          interruptedRun("conv-done", "run-done"),
          interruptedRun("conv-b", "run-b"),
        ],
      },
      transcriptStore: transcript as never,
    });

    expect(result).toEqual({ written: 2, skipped: 1 });
    expect(transcript.appended.map((e) => e.runId)).toEqual(["run-a", "run-b"]);
  });

  it("同一 run 补写后再次对账不重复（清单返回同一 run 也不双写）", async () => {
    const transcript = createFakeTranscriptStore();
    const deps: CrashReconciliationDeps = {
      runStore: { listInterruptedRuns: () => [interruptedRun("conv-a", "run-a")] },
      transcriptStore: transcript as never,
      now: () => 1,
    };

    await reconcileCrashedInterruptions(deps);
    const first = await reconcileCrashedInterruptions(deps);

    // 幂等：第二次对账不再补写，边界仅一条（entryId 首写有效）
    expect(first).toEqual({ written: 0, skipped: 1 });
    expect((await transcript.read("conv-a")).entries.filter((e) => e.kind === "interruption")).toHaveLength(1);
    expect(transcript.appended.filter((e) => e.id === crashedInterruptionEntryId("run-a"))).toHaveLength(1);
  });

  it("crashedInterruptionEntryId 与 runId 一一对应、可复现", () => {
    expect(crashedInterruptionEntryId("run-1")).toBe("run-1:interruption:crashed");
    expect(crashedInterruptionEntryId("run-2")).toBe("run-2:interruption:crashed");
  });
});