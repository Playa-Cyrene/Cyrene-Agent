import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { afterEach, beforeEach, expect, it, vi } from "vitest"
import type { MemoryJudgeResult } from "./memory-schemas"
import type { MemoryJudgeTurn } from "./memory-types"
import { PipelineCleanupGuard, PipelineFixture } from "../../../tests/helpers/memory-pipeline-fixture"
import type { OnRunFinishedDeps } from "../orchestrator/build-options"

const state = vi.hoisted(() => ({ current: {
  root: "",
  queue: Promise.resolve(),
  judge: vi.fn<(turns: MemoryJudgeTurn[]) => Promise<MemoryJudgeResult>>(),
  ingest: vi.fn(),
} }))
vi.mock("electron", () => ({ app: { getPath: () => state.current.root } }))
vi.mock("../llm-queue", () => ({ enqueueLLMTask: (_label: string, task: () => Promise<void>) => {
  const current = state.current
  const result = current.queue.then(task)
  current.queue = result.catch(() => {})
  return result
} }))
vi.mock("./memory-judge", () => ({ memoryJudge: { judgeRecentTurns: state.current.judge } }))
vi.mock("./entity-graph", () => ({ entityGraph: { ingestEntities: state.current.ingest } }))
vi.mock("./memory-compressor", () => ({ runReflectionAndCompression: vi.fn() }))
vi.mock("./memory-resolver", () => ({ runResolverQueueOnce: vi.fn() }))
vi.mock("./obsidian-exporter", () => ({ notifyMemoryChanged: vi.fn() }))
vi.mock("../rag/index", () => ({
  addL2MemoryVector: vi.fn(async () => "fixture-vector"),
  searchMemoryEntries: vi.fn(async () => []),
}))

let fixture: PipelineFixture
const cleanup = new PipelineCleanupGuard()
const cases = new Map<string, { owner: PipelineFixture; current: typeof state.current }>()
beforeEach(({ task }) => {
  cleanup.assertReady()
  fixture = new PipelineFixture()
  state.current = {
    root: fs.mkdtempSync(path.join(os.tmpdir(), "memory-pipeline-")),
    queue: Promise.resolve(),
    judge: state.current.judge.mockReset(),
    ingest: state.current.ingest.mockReset(),
  }
  vi.resetModules()
  cases.set(task.id, { owner: fixture, current: state.current })
})
afterEach(async ({ task }) => {
  const owned = cases.get(task.id)
  if (!owned) return // beforeEach refused to start while an earlier teardown was pending.
  const { current, owner } = owned
  await cleanup.finish(async () => {
    if (task.result?.state === "fail") console.error(owner.diagnostic())
    // Capture ownership before any await: late teardown must never close/delete the next case.
    await owner.stop()
    await vi.dynamicImportSettled()
    const { getConversationDatabase } = await import("../storage/conversation-database-client")
    try {
      await current.queue
    } finally {
      await getConversationDatabase(current.root).close()
      fs.rmSync(current.root, { recursive: true, force: true })
    }
    cases.delete(task.id)
  })
})

function runPipeline(work: (fixture: PipelineFixture, current: typeof state.current) => Promise<void>) {
  const owner = fixture
  const current = state.current
  return owner.run(() => work(owner, current))
}

it("passes completion through the real scheduler, worker and memory writer while rejecting a superseded judge result", () => runPipeline(async (fixture, current) => {
  const { onAgentRunFinished } = await fixture.step("import:build-options", () => import("../orchestrator/build-options"))
  const { scheduleMemoryWrite } = await fixture.step("import:context-builder", () => import("../orchestrator/context-builder"))
  const { getConversationDatabase } = await fixture.step("import:conversation-database-client", () => import("../storage/conversation-database-client"))
  const client = getConversationDatabase(current.root)
  const call = <T = unknown>(method: string, ...args: unknown[]) =>
    fixture.step(`database:${method}`, () => client.call<T>(method, ...args))
  const deps: OnRunFinishedDeps = {
    loadModelSettings: () => ({ provider: "fixture", baseUrl: "", model: "", apiKey: "", memoryMode: "vector", runtimeSync: "off" }),
    scheduleMemoryWrite,
    inferRuntimeState: () => ({}),
    runtimeState: { status: "", feeling: "", expression: 0, updatedAt: 0 },
    feelingToExpression: {},
    setRuntimeState: () => {},
    stickerTextIndex: [],
    matchSticker: () => null,
    loadStickerSettings: () => ({}),
    broadcastRuntimeStateChanged: () => {},
    observeRuntimeState: async () => {},
    recordRelationshipTurn: async () => {},
  }
  const judge = fixture.gate<MemoryJudgeResult>({ candidates: [], entities: [] } as MemoryJudgeResult)
  current.judge.mockImplementationOnce(judge.wait)
  current.judge.mockResolvedValue({ candidates: [{ layer: "L2", content: "current", triggerText: "U6", confidence: 0.9 }], entities: [] } as MemoryJudgeResult)
  async function finish(n: number, replyId = `a${n}`, reply = `A${n}`) {
    await call("transcript.append", "c1", { id: replyId, kind: "assistant", turnId: replyId, at: n, payload: { role: "assistant", content: reply } })
    await fixture.step("completion", () => onAgentRunFinished({ reply, toolResults: [] }, `U${n}`, deps, undefined, "c1",
      { vectorMemorySource: { userTurnId: `u${n}`, assistantEntryId: replyId } }))
  }
  for (let n = 1; n <= 6; n++) {
    await call("transcript.append", "c1", { id: `user-${n}`, kind: "user", turnId: `u${n}`, revision: 1, at: n, payload: { text: `U${n}` } })
    await finish(n)
  }
  await fixture.step("judge entered", () => judge.entered)
  expect(current.judge).toHaveBeenCalledTimes(1)
  // The old LLM response arrives after the canonical rewind and replacement are durable.
  await call("transcript.append", "c1", { id: "rewind", kind: "turn_rewind", at: 7, payload: { anchorUserTurnId: "u6", disposition: "keep_user", reason: "regenerate" } })
  await finish(6, "replacement", "new reply")
  judge.release({ candidates: [{ layer: "L2", content: "stale", triggerText: "U6", confidence: 0.9 }], entities: [{ name: "stale", type: "person" }] } as MemoryJudgeResult)
  await fixture.step("memory queue drained", () => current.queue)
  expect(current.judge).toHaveBeenCalledTimes(2)
  expect(current.judge.mock.calls[1][0].at(-1)?.assistantReply).toBe("new reply")
  const persisted = JSON.parse(fs.readFileSync(path.join(current.root, "memory.json"), "utf8"))
  expect(persisted.l2.map((memory: { content: string }) => memory.content)).toEqual(["current"])
  expect(persisted.l1.roundCount).toBe(6)
  expect(current.ingest).not.toHaveBeenCalled()
  expect(await call("memory.batch", "c1")).toBeNull()
  expect(await call("memory.count")).toBe(6)
}))

it.each(["unchanged", "regenerate", "edit", "delete"])("keeps run ownership through multiple adjustments, restart and %s", change => runPipeline(async (fixture, current) => {
  const { onAgentRunFinished } = await fixture.step("import:build-options", () => import("../orchestrator/build-options"))
  const { scheduleMemoryWrite } = await fixture.step("import:context-builder", () => import("../orchestrator/context-builder"))
  const { getConversationDatabase } = await fixture.step("import:conversation-database-client", () => import("../storage/conversation-database-client"))
  const { createRunAdjustmentPoller } = await fixture.step("import:pending-adjustment", () => import("../chats/pending-adjustment"))
  const { createTranscriptSink } = await fixture.step("import:transcript-sink", () => import("../orchestrator/transcript-sink"))
  const { ConversationTranscriptStore } = await fixture.step("import:conversation-transcript-store", () => import("../orchestrator/conversation-transcript-store"))
  const client = getConversationDatabase(current.root)
  const call = <T = unknown>(method: string, ...args: unknown[]) =>
    fixture.step(`database:${method}`, () => client.call<T>(method, ...args))
  const session = await call<{id:string}>("chats.createSession", { mode: "work" })
  const deps: OnRunFinishedDeps = {
    loadModelSettings: () => ({ provider: "fixture", baseUrl: "", model: "", apiKey: "", memoryMode: "vector", runtimeSync: "off" }),
    scheduleMemoryWrite,
    inferRuntimeState: () => ({}),
    runtimeState: { status: "", feeling: "", expression: 0, updatedAt: 0 },
    feelingToExpression: {},
    setRuntimeState: () => {},
    stickerTextIndex: [],
    matchSticker: () => null,
    loadStickerSettings: () => ({}),
    broadcastRuntimeStateChanged: () => {},
    observeRuntimeState: async () => {},
    recordRelationshipTurn: async () => {},
  }

  const judge = fixture.gate<MemoryJudgeResult>({ candidates: [], entities: [] } as MemoryJudgeResult)
  current.judge.mockImplementationOnce(judge.wait)
  current.judge.mockResolvedValue({ candidates: [{ layer: "L2", content: "current", triggerText: "U6", confidence: 0.9 }], entities: [] } as MemoryJudgeResult)
  async function finish(runId: string, userTurnId: string, replyId: string, text: string, input = userTurnId.toUpperCase()) {
    const sink = createTranscriptSink({ store: new ConversationTranscriptStore(current.root), conversationId: session.id, runId, assistantTurnId: replyId })
    await fixture.step("transcript append", () => sink.appendAssistant({ message: { role: "assistant", content: text }, roundId: "final" }))
    await call("runs.terminal", runId, "completed")
    await fixture.step("completion", () => onAgentRunFinished({ reply: text, toolResults: [] }, input, deps, undefined, session.id,
      { vectorMemorySource: { userTurnId, assistantEntryId: sink.getLastAssistantEntryId!()! } }))
  }
  for (let n = 1; n <= 6; n++) {
    const runId = "run" + n, userTurnId = "u" + n
    await call("runs.admit", session.id, userTurnId,
      { currentUser: { turnId: userTurnId, text: "U" + n, visibleContent: "U" + n } }, runId)
    if (n === 6) {
      await call("transcript.append", session.id, { id: "intermediate", kind: "assistant", runId, turnId: "intermediate", at: 6, payload: { role: "assistant", content: "working" } })
      for (const id of ["adjust-a", "adjust-b"]) {
        await call("chats.enqueuePendingMessage", session.id, { id, rawContent: id, visibleContent: id })
        await call("chats.markPendingAdjust", session.id, id, runId)
      }
      expect(await fixture.step("pending adjustments", createRunAdjustmentPoller(session.id, runId))).toHaveLength(2)
      await fixture.step("database:restart close", () => client.close()) // 来源归属必须能从数据库重建，不能依赖进程内缓存。
    }
    await finish(runId, userTurnId, "a" + n, "A" + n)
    if (n < 6) await fixture.step("memory queue drained", () => current.queue)
  }
  try {
    await fixture.step("judge entered", () => judge.entered)
    expect(current.judge).toHaveBeenCalledTimes(1)
    expect(await call("memory.count")).toBe(6)
    expect(current.judge.mock.calls[0][0].at(-1)?.assistantReply).toBe("A6")
    if (change === "delete") {
      await call("transcript.append", session.id, { id: "delete", kind: "turn_tombstone", at: 10, payload: { targetUserTurnId: "u6", reason: "pending_withdrawn" } })
    } else if (change !== "unchanged") {
      await call("runs.admit", session.id, "replacement-request", {
        currentUser: { turnId: "u6", text: change === "edit" ? "edited" : "U6", visibleContent: "U6" },
        transcriptRewind: { anchorUserTurnId: "u6", disposition: change === "edit" ? "replace_user" : "keep_user" },
      }, "replacement-run")
      await finish("replacement-run", "u6", "replacement", "replacement reply", change === "edit" ? "edited" : "U6")
    }
  } finally {
    judge.release({ candidates: [{ layer: "L2", content: change === "unchanged" ? "current" : "stale", triggerText: "U6", confidence: 0.9 }], entities: [] } as MemoryJudgeResult)
  }
  await fixture.step("memory queue drained", () => current.queue)
  expect(await call("memory.count")).toBe(change === "delete" ? 5 : 6)
  const persisted = JSON.parse(fs.readFileSync(path.join(current.root, "memory.json"), "utf8"))
  expect(persisted.l2.map((item: {content:string}) => item.content)).toEqual(change === "delete" ? [] : ["current"])
  expect(current.judge).toHaveBeenCalledTimes(["regenerate", "edit"].includes(change) ? 2 : 1)
  expect(await call("memory.batch", session.id)).toBeNull()
}))
