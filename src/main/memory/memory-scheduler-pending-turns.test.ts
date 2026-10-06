// 待蒸馏轮次的持久化回归测试。
//
// 蒸馏每 6 轮才跑一次，中间轮次只待在 recentTurns 里。原来的实现是纯内存数组，
// 所以进程在第 1~5 轮之间退出，这些轮次就再也不会被蒸馏成记忆。这里用一个共享的
// "假磁盘"跑两个 scheduler 实例来模拟重启，锁住两件事：
//   1) 重启后补齐到第 6 轮时，judge 能看到重启前的轮次；
//   2) 只重启不继续聊，缓冲也还在文件里（不是延后触发，而是根本没丢）。

import { describe, expect, it, vi } from "vitest"
import { MemoryScheduler } from "./memory-scheduler"
import type { MemorySchedulerDeps } from "./memory-scheduler"
import type { MemoryJudgeResult } from "./memory-schemas"
import type { MemoryJudgeTurn } from "./memory-types"

function createHarness() {
  let disk: { seq: number; turns: MemoryJudgeTurn[] } | null = null
  let roundCount = 0
  const queueRef: { current: Promise<unknown> } = { current: Promise.resolve() }
  const judged: MemoryJudgeTurn[][] = []

  const makeDeps = (): MemorySchedulerDeps => ({
    ingestEntities: vi.fn(),
    enqueueTask: <T>(_label: string, task: () => Promise<T>): Promise<T> => {
      const run = queueRef.current.then(task)
      queueRef.current = run.then(() => undefined, () => undefined)
      return run
    },
    judgeMemory: vi.fn(async (turns: MemoryJudgeTurn[]): Promise<MemoryJudgeResult> => {
      judged.push(turns)
      return { candidates: [], entities: [] } as unknown as MemoryJudgeResult
    }),
    writeMemory: vi.fn(async () => undefined),
    getL1: vi.fn(async () => ({
      recentGoals: "",
      recentPreferences: "",
      currentProject: "",
      generatedAt: 0,
      roundCount,
    })),
    replaceL1Field: vi.fn(async (_field: "roundCount", value: number) => {
      roundCount = value
    }),
    runReflectionAndCompression: vi.fn(async () => undefined),
    runResolverQueueOnce: vi.fn(async () => undefined),
    runDecay: vi.fn(async () => undefined),
    loadPendingTurns: () => disk,
    savePendingTurns: (turns: MemoryJudgeTurn[], seq: number) => {
      disk = { seq, turns: turns.map((t) => ({ userInput: t.userInput, assistantReply: t.assistantReply })) }
    },
  })

  // 排空队列，避免上一进程的迟到落盘和断言抢跑
  const drain = async () => { await queueRef.current }
  const readDisk = () => disk
  return { makeDeps, judged, drain, readDisk }
}

describe("MemoryScheduler 待蒸馏轮次落盘", () => {
  it("重启后补齐到第 6 轮时，judge 能看到重启前的轮次", async () => {
    const h = createHarness()

    const first = new MemoryScheduler(h.makeDeps())
    for (let i = 1; i <= 3; i++) first.scheduleMemoryWrite(`user ${i}`, `reply ${i}`)
    await h.drain()
    expect(h.readDisk()?.turns.map((t) => t.userInput)).toEqual(["user 1", "user 2", "user 3"])
    expect(h.judged.length).toBe(0)

    // 模拟进程重启：新实例、同一块"磁盘"、roundCount 本来就存在 L1 里所以继续累计
    const second = new MemoryScheduler(h.makeDeps())
    for (let i = 4; i <= 6; i++) second.scheduleMemoryWrite(`user ${i}`, `reply ${i}`)
    await h.drain()

    expect(h.judged.length).toBe(1)
    expect(h.judged[0].map((t) => t.userInput)).toEqual([
      "user 1", "user 2", "user 3", "user 4", "user 5", "user 6",
    ])
  })

  it("只重启不继续聊，缓冲也还在文件里而不是被丢掉", async () => {
    const h = createHarness()

    const first = new MemoryScheduler(h.makeDeps())
    for (let i = 1; i <= 2; i++) first.scheduleMemoryWrite(`keep ${i}`, `reply ${i}`)
    await h.drain()
    expect(h.readDisk()?.turns.length).toBe(2)

    const restored = new MemoryScheduler(h.makeDeps())
    restored.scheduleMemoryWrite("keep 3", "reply 3")
    expect(h.readDisk()?.turns.map((t) => t.userInput)).toEqual(["keep 1", "keep 2", "keep 3"])
    await h.drain()
    expect(h.readDisk()?.turns.map((t) => t.userInput)).toEqual(["keep 1", "keep 2", "keep 3"])
  })
})
