import { afterEach, describe, expect, it, vi } from "vitest"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { ConversationDatabase } from "../storage/conversation-database"
import { runMemoryCommand } from "../storage/conversation-memory-repository"
import type { MemoryTurnSource } from "./memory-pending-types"
import { MemoryScheduler } from "./memory-scheduler"
import type { MemorySchedulerDeps } from "./memory-scheduler"
import type { MemoryJudgeResult } from "./memory-schemas"
import type { MemoryCandidate, MemoryJudgeTurn } from "./memory-types"

vi.mock("../llm-queue", () => ({ enqueueLLMTask: vi.fn() }))
vi.mock("./memory-compressor", () => ({ runReflectionAndCompression: vi.fn() }))
vi.mock("./entity-graph", () => ({ entityGraph: {} }))
vi.mock("./memory-judge", () => ({ memoryJudge: {} }))
vi.mock("./memory-manager", () => ({ memoryManager: {} }))
vi.mock("./memory-resolver", () => ({ runResolverQueueOnce: vi.fn() }))
vi.mock("./memory-store", () => ({ memoryStore: {} }))
vi.mock("./memory-pending-turns", () => ({ memoryPendingTurns: {} }))

const fixtures: Array<{ db: ConversationDatabase; root: string }> = []
afterEach(() => {
  for (const { db, root } of fixtures.splice(0)) {
    db.close()
    fs.rmSync(root, { recursive: true, force: true })
  }
})

function createScheduler(overrides: Partial<MemorySchedulerDeps> = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "memory-scheduler-"))
  const db = new ConversationDatabase(root)
  fixtures.push({ db, root })
  const command = async <T>(method: string, ...args: unknown[]): Promise<T> => db.transaction(() => runMemoryCommand(db, method, args)) as T
  const calls: string[] = []
  const enqueueLabels: string[] = []
  let roundCount = 0
  let queue = Promise.resolve()
  const deps: MemorySchedulerDeps = {
    pending: {
      record: (turn, count) => command("memory.record", turn, count),
      batch: (id, throughSeq) => command("memory.batch", id, throughSeq),
      current: turns => command("memory.current", turns),
      consume: batch => command("memory.consume", batch),
      count: () => command("memory.count"),
    },
    ingestEntities: vi.fn((entities: unknown[]) => {
      calls.push(`ingest:${entities.length}`)
    }),
    enqueueTask: <T>(label: string, task: () => Promise<T>) => {
      enqueueLabels.push(label)
      calls.push("enqueue")
      const run = queue.then(task)
      queue = run.then(() => undefined, () => undefined)
      return run
    },
    judgeMemory: vi.fn(async () => ({ candidates: [], entities: [] }) as MemoryJudgeResult),
    writeMemory: vi.fn(async () => {
      calls.push("write")
    }),
    getL1: vi.fn(async () => ({
      recentGoals: "",
      recentPreferences: "",
      currentProject: "",
      generatedAt: 0,
        roundCount,
      })),
    replaceL1Field: vi.fn(async (_field: "roundCount", value: number) => {
      roundCount = value
      calls.push(`round:${value}`)
    }),
    runReflectionAndCompression: vi.fn(async () => {
      calls.push("reflection")
    }),
    runResolverQueueOnce: vi.fn(async () => {
      calls.push("resolver")
    }),
    runDecay: vi.fn(async () => {
      calls.push("decay")
    }),
    ...overrides,
  }

  const rawScheduler = new MemoryScheduler(deps)
  let sequence = 0
  const scheduler = {
    scheduleMemoryWrite(userInput: string, assistantReply: string, conversationId = "c1", source?: MemoryTurnSource) {
      const n = ++sequence
      source ??= { userTurnId: `u${n}`, assistantEntryId: `a${n}` }
      const entries = db.entries(conversationId, true)
      if (!entries.some(e => e.id === source!.assistantEntryId)) {
        if (entries.some(e => e.kind === "user" && e.turnId === source!.userTurnId)) {
          db.append(conversationId, { id: `rewind-${n}`, kind: "turn_rewind", at: n, payload: { anchorUserTurnId: source.userTurnId, disposition: "keep_user", reason: "regenerate" } })
        } else db.append(conversationId, { id: `user-${source.userTurnId}`, kind: "user", turnId: source.userTurnId, revision: 1, at: n, payload: { text: userInput } })
        db.append(conversationId, { id: source.assistantEntryId, kind: "assistant", turnId: `assistant-${n}`, at: n, payload: { role: "assistant", content: assistantReply } })
      }
      rawScheduler.scheduleMemoryWrite(userInput, assistantReply, conversationId, source)
    },
  }
  return { scheduler, rawScheduler, deps, calls, enqueueLabels, db, root, command }
}

describe("MemoryScheduler", () => {
  it("does not count a regenerated user turn twice", async () => {
    const { scheduler, deps } = createScheduler()
    scheduler.scheduleMemoryWrite("U1", "old", "c1", { userTurnId: "u1", assistantEntryId: "a1" })
    await vi.waitFor(() => expect(deps.replaceL1Field).toHaveBeenCalledWith("roundCount", 1))
    scheduler.scheduleMemoryWrite("U1", "new", "c1", { userTurnId: "u1", assistantEntryId: "a2" })
    for (let i = 2; i <= 5; i++) {
      scheduler.scheduleMemoryWrite(`U${i}`, `A${i}`, "c1", { userTurnId: `u${i}`, assistantEntryId: `a${i + 1}` })
    }
    await vi.waitFor(() => expect(deps.replaceL1Field).toHaveBeenCalledWith("roundCount", 5))
    await new Promise(resolve => setImmediate(resolve))
    expect(deps.judgeMemory).not.toHaveBeenCalled()
  })

  it("defers MemoryJudge until every sixth round", async () => {
    const { scheduler, deps, enqueueLabels } = createScheduler()

    for (let i = 1; i <= 5; i++) {
      scheduler.scheduleMemoryWrite(`user ${i}`, `assistant ${i}`)
    }
    await vi.waitFor(() => expect(deps.replaceL1Field).toHaveBeenCalledWith("roundCount", 5))

    // 实体抽取改由 judge 顺手产出，非 judge 轮（5 < 6）不 ingest 实体
    expect(deps.ingestEntities).not.toHaveBeenCalled()
    expect(enqueueLabels).toEqual(["MemoryMaintenance", "MemoryMaintenance", "MemoryMaintenance", "MemoryMaintenance", "MemoryMaintenance"])
    expect(deps.judgeMemory).not.toHaveBeenCalled()
    expect(deps.writeMemory).not.toHaveBeenCalled()
  })

  it("runs MemoryJudge on the sixth round with turns 1 through 6", async () => {
    const candidate: MemoryCandidate = {
      layer: "L2",
      summary: "用户喜欢香菇",
      content: "用户喜欢香菇",
      confidence: 0.9,
      triggerText: "我喜欢香菇",
      slug: "喜欢香菇",
      sourceQuote: "我喜欢香菇，尤其爱吃鲜香菇",
      importance: "medium",
      stability: "situational",
      certainty: "explicit",
      attribution: "user_explicit",
      evidenceQuotes: ["我喜欢香菇"],
      contextSummary: "用户表达食物偏好",
      shouldWrite: true,
      reason: "用户明确表达",
      forbiddenOverclaims: [],
    }
    const { scheduler, deps } = createScheduler({
      judgeMemory: vi.fn(async () => ({ candidates: [candidate], entities: [] }) as MemoryJudgeResult),
    })

    for (let i = 1; i <= 6; i++) {
      scheduler.scheduleMemoryWrite(`user ${i}`, `assistant ${i}`)
    }
    await vi.waitFor(() => expect(deps.writeMemory).toHaveBeenCalledWith([candidate], expect.any(Function)))

    const turns = vi.mocked(deps.judgeMemory).mock.calls[0][0]
    expect(turns.map((turn: MemoryJudgeTurn) => turn.userInput)).toEqual([
      "user 1",
      "user 2",
      "user 3",
      "user 4",
      "user 5",
      "user 6",
    ])
    expect(deps.replaceL1Field).toHaveBeenCalledWith("roundCount", 6)
  })

  it("uses an overlapping 8-turn window on later MemoryJudge runs", async () => {
    const { scheduler, deps } = createScheduler()

    for (let i = 1; i <= 12; i++) {
      scheduler.scheduleMemoryWrite(`user ${i}`, `assistant ${i}`)
    }
    await vi.waitFor(() => expect(deps.judgeMemory).toHaveBeenCalledTimes(2))

    expect(deps.judgeMemory).toHaveBeenCalledTimes(2)
    const secondTurns = vi.mocked(deps.judgeMemory).mock.calls[1][0]
    expect(secondTurns.map((turn: MemoryJudgeTurn) => turn.userInput)).toEqual([
      "user 5",
      "user 6",
      "user 7",
      "user 8",
      "user 9",
      "user 10",
      "user 11",
      "user 12",
    ])
  })

  it("still increments round count when judging fails", async () => {
    const { scheduler, deps } = createScheduler({
      judgeMemory: vi.fn(async () => ({ candidates: [], entities: [] }) as MemoryJudgeResult)
        .mockRejectedValueOnce(new Error("judge failed")),
    })

    for (let i = 1; i <= 6; i++) scheduler.scheduleMemoryWrite(`U${i}`, `A${i}`)
    await vi.waitFor(() => expect(deps.replaceL1Field).toHaveBeenCalledTimes(6))
    expect(await deps.pending.count()).toBe(6)
    expect(deps.judgeMemory).toHaveBeenCalledTimes(1)
    expect(deps.writeMemory).not.toHaveBeenCalled()
    expect((await deps.pending.batch("c1"))?.pending).toHaveLength(6)
    scheduler.scheduleMemoryWrite("U7", "A7")
    await vi.waitFor(() => expect(deps.replaceL1Field).toHaveBeenCalledTimes(7))
    expect(deps.judgeMemory).toHaveBeenCalledTimes(2)
    expect(vi.mocked(deps.judgeMemory).mock.calls[1][0].map(t => t.userInput)).toEqual(["U1", "U2", "U3", "U4", "U5", "U6"])
  })

  it("runs reflection and compression on every twentieth round", async () => {
    const { scheduler, deps } = createScheduler({
      getL1: vi.fn(async () => ({
        recentGoals: "",
        recentPreferences: "",
        currentProject: "",
        generatedAt: 0,
        roundCount: 19,
      })),
    })

    scheduler.scheduleMemoryWrite("user", "assistant")
    await vi.waitFor(() => expect(deps.runReflectionAndCompression).toHaveBeenCalled())

    expect(deps.replaceL1Field).toHaveBeenCalledWith("roundCount", 20)
  })

  it("runs one resolver queue item every fifth round", async () => {
    const { scheduler, deps } = createScheduler({
      getL1: vi.fn(async () => ({
        recentGoals: "",
        recentPreferences: "",
        currentProject: "",
        generatedAt: 0,
        roundCount: 4,
      })),
    })

    scheduler.scheduleMemoryWrite("user", "assistant")
    await vi.waitFor(() => expect(deps.runResolverQueueOnce).toHaveBeenCalled())

    expect(deps.replaceL1Field).toHaveBeenCalledWith("roundCount", 5)
  })

  it("discards an in-flight judge after regeneration, then retries the current six turns", async () => {
    let release!: () => void
    const candidate = { layer: "L2", content: "old", confidence: 0.9, triggerText: "U6" } as MemoryCandidate
    const judge = vi.fn(async (_turns: MemoryJudgeTurn[]) => ({ candidates: [], entities: [] }) as MemoryJudgeResult)
      .mockImplementationOnce(async () => {
        await new Promise<void>(resolve => { release = resolve })
        return { candidates: [candidate], entities: [{ name: "old" }] } as MemoryJudgeResult
      })
    const { scheduler, deps } = createScheduler({ judgeMemory: judge })
    for (let i = 1; i <= 6; i++) scheduler.scheduleMemoryWrite(`U${i}`, `A${i}`)
    await vi.waitFor(() => expect(release).toBeTypeOf("function"))
    scheduler.scheduleMemoryWrite("U6", "new", "c1", { userTurnId: "u6", assistantEntryId: "a6-new" })
    release()
    await vi.waitFor(() => expect(judge).toHaveBeenCalledTimes(2))
    expect(deps.writeMemory).not.toHaveBeenCalled()
    expect(deps.ingestEntities).not.toHaveBeenCalled()
    expect(judge.mock.calls[1][0].slice(-1)[0]).toEqual({ userInput: "U6", assistantReply: "new" })
    expect(await deps.pending.count()).toBe(6)
  })

  it.each(["delete", "edit"])("invalidates in-flight evidence on %s without another completed reply", async action => {
    let release!: () => void
    const candidate = { layer: "L2", content: "old", confidence: 0.9, triggerText: "U6" } as MemoryCandidate
    const { scheduler, deps, db } = createScheduler({ judgeMemory: vi.fn(async () => {
      await new Promise<void>(resolve => { release = resolve })
      return { candidates: [candidate], entities: [] } as MemoryJudgeResult
    }) })
    for (let i = 1; i <= 6; i++) scheduler.scheduleMemoryWrite(`U${i}`, `A${i}`)
    await vi.waitFor(() => expect(release).toBeTypeOf("function"))
    if (action === "delete") db.append("c1", { id: "deleted", at: 20, kind: "turn_tombstone", payload: { targetUserTurnId: "u6", reason: "pending_withdrawn" } })
    else db.append("c1", { id: "edited", at: 20, kind: "turn_rewind", turnId: "u6", revision: 2, payload: { anchorUserTurnId: "u6", disposition: "replace_user", reason: "edit", replacementUser: { text: "edited U6" } } })
    // Invalidation and the count change commit with the transcript mutation.
    expect(await deps.pending.count()).toBe(5)
    release()
    await vi.waitFor(() => expect(deps.pending.batch("c1")).resolves.toBeNull())
    await new Promise(resolve => setImmediate(resolve))
    expect(deps.writeMemory).not.toHaveBeenCalled()
  })

  it("retains backlog beyond sixteen turns and preserves the 6/8 overlap", async () => {
    const { scheduler, deps, db } = createScheduler()
    for (let i = 1; i <= 24; i++) scheduler.scheduleMemoryWrite(`U${i}`, `A${i}`)
    await vi.waitFor(() => expect(deps.judgeMemory).toHaveBeenCalledTimes(4))
    const windows = vi.mocked(deps.judgeMemory).mock.calls.map(([turns]) => turns.map(t => t.userInput))
    expect(windows.map(t => t.length)).toEqual([6, 8, 8, 8])
    expect(windows[3]).toEqual(Array.from({ length: 8 }, (_, i) => `U${i + 17}`))
    await vi.waitFor(() => expect(db.db.prepare('SELECT COUNT(*) n FROM memory_pending_turns WHERE payload_json IS NOT NULL').get()!.n).toBe(2))
  })

  it("does not mix conversations or repeat an already consumed completion", async () => {
    const { scheduler, deps } = createScheduler()
    for (let i = 1; i <= 3; i++) {
      scheduler.scheduleMemoryWrite(`A${i}`, `a${i}`, "a", { userTurnId: `u${i}`, assistantEntryId: `reply${i}` })
      scheduler.scheduleMemoryWrite(`B${i}`, `b${i}`, "b", { userTurnId: `u${i}`, assistantEntryId: `reply${i}` })
    }
    await vi.waitFor(() => expect(deps.replaceL1Field).toHaveBeenCalledWith("roundCount", 6))
    expect(deps.judgeMemory).not.toHaveBeenCalled()
    for (let i = 4; i <= 6; i++) scheduler.scheduleMemoryWrite(`A${i}`, `a${i}`, "a", { userTurnId: `u${i}`, assistantEntryId: `reply${i}` })
    await vi.waitFor(() => expect(deps.judgeMemory).toHaveBeenCalledTimes(1))
    expect(vi.mocked(deps.judgeMemory).mock.calls[0][0].map(t => t.userInput)).toEqual(["A1", "A2", "A3", "A4", "A5", "A6"])
    scheduler.scheduleMemoryWrite("A6", "a6", "a", { userTurnId: "u6", assistantEntryId: "reply6" })
    await vi.waitFor(() => expect(deps.replaceL1Field).toHaveBeenCalledTimes(10))
    expect(await deps.pending.count()).toBe(9)
    expect(deps.judgeMemory).toHaveBeenCalledTimes(1)
  })

  it("persists before enqueue and does not poison later writes after a persistence failure", async () => {
    const { scheduler, deps, enqueueLabels } = createScheduler()
    const record = deps.pending.record
    vi.spyOn(deps.pending, "record").mockRejectedValueOnce(new Error("disk unavailable"))
      .mockImplementation(async (...args) => {
        const result = await record(...args)
        expect(enqueueLabels).toHaveLength(0)
        return result
      })
    scheduler.scheduleMemoryWrite("U1", "A1")
    scheduler.scheduleMemoryWrite("U2", "A2")
    await vi.waitFor(() => expect(enqueueLabels).toHaveLength(1))
    expect(await deps.pending.count()).toBe(1)
  })

  it("passes a live guard into the writer and leaves the batch pending on write failure", async () => {
    let release!: () => void
    let committed = false
    const { scheduler, deps, db } = createScheduler({
      judgeMemory: vi.fn(async () => ({ candidates: [{ content: "old" }], entities: [] }) as MemoryJudgeResult),
      writeMemory: vi.fn(async (_candidates, assertSourceCurrent) => {
        await new Promise<void>(resolve => { release = resolve })
        await assertSourceCurrent()
        committed = true
      }),
    })
    for (let i = 1; i <= 6; i++) scheduler.scheduleMemoryWrite(`U${i}`, `A${i}`)
    await vi.waitFor(() => expect(release).toBeTypeOf("function"))
    db.append("c1", { id: "deleted", at: 20, kind: "turn_tombstone", payload: { targetUserTurnId: "u6", reason: "pending_withdrawn" } })
    release()
    await new Promise(resolve => setImmediate(resolve))
    expect(committed).toBe(false)
    expect(deps.ingestEntities).not.toHaveBeenCalled()
    expect(db.db.prepare('SELECT COUNT(*) n FROM memory_pending_turns WHERE active=1 AND processed=0').get()!.n).toBe(5)
  })
})
