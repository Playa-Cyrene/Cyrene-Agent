import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { afterEach, beforeEach, expect, it, vi } from "vitest"
import type { MemoryJudgeResult } from "./memory-schemas"
import type { MemoryJudgeTurn } from "./memory-types"
import type { OnRunFinishedDeps } from "../orchestrator/build-options"

const state = vi.hoisted(() => ({
  root: "",
  queue: Promise.resolve(),
  judge: vi.fn<(turns: MemoryJudgeTurn[]) => Promise<MemoryJudgeResult>>(),
  ingest: vi.fn(),
}))
vi.mock("electron", () => ({ app: { getPath: () => state.root } }))
vi.mock("../llm-queue", () => ({ enqueueLLMTask: (_label: string, task: () => Promise<void>) => {
  const result = state.queue.then(task)
  state.queue = result.catch(() => {})
  return result
} }))
vi.mock("./memory-judge", () => ({ memoryJudge: { judgeRecentTurns: state.judge } }))
vi.mock("./entity-graph", () => ({ entityGraph: { ingestEntities: state.ingest } }))
vi.mock("./memory-compressor", () => ({ runReflectionAndCompression: vi.fn() }))
vi.mock("./memory-resolver", () => ({ runResolverQueueOnce: vi.fn() }))
vi.mock("./obsidian-exporter", () => ({ notifyMemoryChanged: vi.fn() }))
vi.mock("../rag/index", () => ({
  addL2MemoryVector: vi.fn(async () => "fixture-vector"),
  searchMemoryEntries: vi.fn(async () => []),
}))

beforeEach(() => {
  state.root = fs.mkdtempSync(path.join(os.tmpdir(), "memory-pipeline-"))
  state.queue = Promise.resolve()
  state.judge.mockReset()
  state.ingest.mockReset()
  vi.resetModules()
})
afterEach(async () => {
  await state.queue
  await vi.dynamicImportSettled()
  const { closeConversationDatabases } = await import("../storage/conversation-database-client")
  await closeConversationDatabases()
  fs.rmSync(state.root, { recursive: true, force: true })
})

it("passes completion through the real scheduler, worker and memory writer while rejecting a superseded judge result", async () => {
  const { onAgentRunFinished } = await import("../orchestrator/build-options")
  const { scheduleMemoryWrite } = await import("../orchestrator/context-builder")
  const { getConversationDatabase } = await import("../storage/conversation-database-client")
  const client = getConversationDatabase(state.root)
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
  let releaseJudge!: (result: MemoryJudgeResult) => void
  state.judge.mockImplementationOnce(() => new Promise(resolve => { releaseJudge = resolve }))
  state.judge.mockResolvedValue({ candidates: [{ layer: "L2", content: "current", triggerText: "U6", confidence: 0.9 }], entities: [] } as MemoryJudgeResult)
  async function finish(n: number, replyId = `a${n}`, reply = `A${n}`) {
    await client.call("transcript.append", "c1", { id: replyId, kind: "assistant", turnId: replyId, at: n, payload: { role: "assistant", content: reply } })
    await onAgentRunFinished({ reply, toolResults: [] }, `U${n}`, deps, undefined, "c1",
      { vectorMemorySource: { userTurnId: `u${n}`, assistantEntryId: replyId } })
  }
  for (let n = 1; n <= 6; n++) {
    await client.call("transcript.append", "c1", { id: `user-${n}`, kind: "user", turnId: `u${n}`, revision: 1, at: n, payload: { text: `U${n}` } })
    await finish(n)
  }
  await vi.waitFor(() => expect(state.judge).toHaveBeenCalledTimes(1))
  // The old LLM response arrives after the canonical rewind and replacement are durable.
  await client.call("transcript.append", "c1", { id: "rewind", kind: "turn_rewind", at: 7, payload: { anchorUserTurnId: "u6", disposition: "keep_user", reason: "regenerate" } })
  await finish(6, "replacement", "new reply")
  releaseJudge({ candidates: [{ layer: "L2", content: "stale", triggerText: "U6", confidence: 0.9 }], entities: [{ name: "stale", type: "person" }] } as MemoryJudgeResult)
  await state.queue
  expect(state.judge).toHaveBeenCalledTimes(2)
  expect(state.judge.mock.calls[1][0].at(-1)?.assistantReply).toBe("new reply")
  const persisted = JSON.parse(fs.readFileSync(path.join(state.root, "memory.json"), "utf8"))
  expect(persisted.l2.map((memory: { content: string }) => memory.content)).toEqual(["current"])
  expect(persisted.l1.roundCount).toBe(6)
  expect(state.ingest).not.toHaveBeenCalled()
  expect(await client.call("memory.batch", "c1")).toBeNull()
  expect(await client.call("memory.count")).toBe(6)
})

it.each(["unchanged", "regenerate", "edit", "delete"])("keeps run ownership through multiple adjustments, restart and %s", async change => {
  const { onAgentRunFinished } = await import("../orchestrator/build-options")
  const { scheduleMemoryWrite } = await import("../orchestrator/context-builder")
  const { getConversationDatabase } = await import("../storage/conversation-database-client")
  const { createRunAdjustmentPoller } = await import("../chats/pending-adjustment")
  const { createTranscriptSink } = await import("../orchestrator/transcript-sink")
  const { ConversationTranscriptStore } = await import("../orchestrator/conversation-transcript-store")
  const client = getConversationDatabase(state.root)
  const session = await client.call<{id:string}>("chats.createSession", { mode: "work" })
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

  let release: ((result: MemoryJudgeResult) => void) | undefined
  state.judge.mockImplementationOnce(() => new Promise(resolve => { release = resolve }))
  state.judge.mockResolvedValue({ candidates: [{ layer: "L2", content: "current", triggerText: "U6", confidence: 0.9 }], entities: [] } as MemoryJudgeResult)
  async function finish(runId: string, userTurnId: string, replyId: string, text: string, input = userTurnId.toUpperCase()) {
    const sink = createTranscriptSink({ store: new ConversationTranscriptStore(state.root), conversationId: session.id, runId, assistantTurnId: replyId })
    await sink.appendAssistant({ message: { role: "assistant", content: text }, roundId: "final" })
    await client.call("runs.terminal", runId, "completed")
    await onAgentRunFinished({ reply: text, toolResults: [] }, input, deps, undefined, session.id,
      { vectorMemorySource: { userTurnId, assistantEntryId: sink.getLastAssistantEntryId!()! } })
  }
  for (let n = 1; n <= 6; n++) {
    const runId = "run" + n, userTurnId = "u" + n
    await client.call("runs.admit", session.id, userTurnId,
      { currentUser: { turnId: userTurnId, text: "U" + n, visibleContent: "U" + n } }, runId)
    if (n === 6) {
      await client.call("transcript.append", session.id, { id: "intermediate", kind: "assistant", runId, turnId: "intermediate", at: 6, payload: { role: "assistant", content: "working" } })
      for (const id of ["adjust-a", "adjust-b"]) {
        await client.call("chats.enqueuePendingMessage", session.id, { id, rawContent: id, visibleContent: id })
        await client.call("chats.markPendingAdjust", session.id, id, runId)
      }
      expect(await createRunAdjustmentPoller(session.id, runId)()).toHaveLength(2)
      await client.close() // 来源归属必须能从数据库重建，不能依赖进程内缓存。
    }
    await finish(runId, userTurnId, "a" + n, "A" + n)
    if (n < 6) await state.queue
  }
  try {
    await vi.waitFor(() => expect(state.judge).toHaveBeenCalledTimes(1))
    expect(await client.call("memory.count")).toBe(6)
    expect(state.judge.mock.calls[0][0].at(-1)?.assistantReply).toBe("A6")
    if (change === "delete") {
      await client.call("transcript.append", session.id, { id: "delete", kind: "turn_tombstone", at: 10, payload: { targetUserTurnId: "u6", reason: "pending_withdrawn" } })
    } else if (change !== "unchanged") {
      await client.call("runs.admit", session.id, "replacement-request", {
        currentUser: { turnId: "u6", text: change === "edit" ? "edited" : "U6", visibleContent: "U6" },
        transcriptRewind: { anchorUserTurnId: "u6", disposition: change === "edit" ? "replace_user" : "keep_user" },
      }, "replacement-run")
      await finish("replacement-run", "u6", "replacement", "replacement reply", change === "edit" ? "edited" : "U6")
    }
  } finally {
    release?.({ candidates: [{ layer: "L2", content: change === "unchanged" ? "current" : "stale", triggerText: "U6", confidence: 0.9 }], entities: [] } as MemoryJudgeResult)
  }
  await state.queue
  expect(await client.call("memory.count")).toBe(change === "delete" ? 5 : 6)
  const persisted = JSON.parse(fs.readFileSync(path.join(state.root, "memory.json"), "utf8"))
  expect(persisted.l2.map((item: {content:string}) => item.content)).toEqual(change === "delete" ? [] : ["current"])
  expect(state.judge).toHaveBeenCalledTimes(["regenerate", "edit"].includes(change) ? 2 : 1)
  expect(await client.call("memory.batch", session.id)).toBeNull()
})
