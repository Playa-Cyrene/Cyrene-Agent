import * as fs from "fs"
import * as os from "os"
import * as path from "path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { MemoryCandidate } from "./memory-types"

const electronMock = vi.hoisted(() => ({
  userDataDir: "",
}))

const ragMock = vi.hoisted(() => ({
  addL2MemoryVector: vi.fn(),
  searchMemoryEntries: vi.fn(),
}))

vi.mock("electron", () => ({
  app: {
    getPath: () => electronMock.userDataDir,
  },
}))

vi.mock("../rag/index", () => ragMock)

// memoryStore.save() 会 fire-and-forget 动态加载 exporter；这里隔离该外围副作用，
// 避免 vi.resetModules() 与尚未 settle 的循环动态 import 在 Vitest 5 下竞争。
vi.mock("./obsidian-exporter", () => ({
  notifyMemoryChanged: vi.fn(),
}))

function readTraceEvents(): Array<Record<string, unknown>> {
  const tracePath = path.join(electronMock.userDataDir, "memory-trace.log")
  if (!fs.existsSync(tracePath)) return []
  return fs.readFileSync(tracePath, "utf8")
    .trim()
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>)
}

describe("MemoryManager L2 sync", () => {
  beforeEach(() => {
    electronMock.userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "memory-manager-"))
    ragMock.addL2MemoryVector.mockReset()
    ragMock.searchMemoryEntries.mockReset()
    ragMock.searchMemoryEntries.mockResolvedValue([])
    vi.resetModules()
  })

  afterEach(async () => {
    await vi.dynamicImportSettled()
  })

  it("creates L2 first, syncs it to RAG with l2Id metadata, then marks it synced", async () => {
    ragMock.addL2MemoryVector.mockResolvedValue("rag_synced")
    const { memoryManager } = await import("./memory-manager")
    const { memoryStore } = await import("./memory-store")
    const candidate: MemoryCandidate = {
      layer: "L2",
      content: "用户喜欢香菇",
      confidence: 0.91,
      triggerText: "我喜欢香菇",
    }

    await memoryManager.writeMemory([candidate])

    const allL2 = await memoryStore.getAllL2()
    const traceEvents = readTraceEvents()
    const addIndex = traceEvents.findIndex((event) => event.op === "l2.add" && event.l2Id === allL2[0].id)
    const syncIndex = traceEvents.findIndex((event) => event.op === "l2.sync.success" && event.l2Id === allL2[0].id)
    const reflectionLogs = await memoryStore.getReflectionLogs()

    expect(allL2).toHaveLength(1)
    expect(allL2[0].syncStatus).toBe("synced")
    expect(allL2[0].ragId).toBe("rag_synced")
    expect(addIndex).toBeGreaterThanOrEqual(0)
    expect(syncIndex).toBeGreaterThan(addIndex)
    expect(traceEvents[syncIndex].ragId).toBe("rag_synced")
    expect(reflectionLogs).toHaveLength(0)
    expect(ragMock.addL2MemoryVector).toHaveBeenCalledWith(
      candidate.content,
      allL2[0].id,
      expect.objectContaining({ confidence: candidate.confidence }),
    )
  })

  it("keeps L2 as sync_failed when RAG write fails", async () => {
    ragMock.addL2MemoryVector.mockRejectedValue(new Error("RAG down"))
    const { memoryManager } = await import("./memory-manager")
    const { memoryStore } = await import("./memory-store")
    const candidate: MemoryCandidate = {
      layer: "L2",
      content: "用户正在重构记忆系统",
      confidence: 0.95,
      triggerText: "我们继续重构记忆系统",
    }

    await memoryManager.writeMemory([candidate])

    const allL2 = await memoryStore.getAllL2()
    const traceEvents = readTraceEvents()
    const addIndex = traceEvents.findIndex((event) => event.op === "l2.add" && event.l2Id === allL2[0].id)
    const failureIndex = traceEvents.findIndex((event) => event.op === "l2.sync.failure" && event.l2Id === allL2[0].id)

    expect(allL2).toHaveLength(1)
    expect(allL2[0].syncStatus).toBe("sync_failed")
    expect(allL2[0].ragId).toBeUndefined()
    expect(addIndex).toBeGreaterThanOrEqual(0)
    expect(failureIndex).toBeGreaterThan(addIndex)
    expect(traceEvents[failureIndex].status).toBe("error")
    expect(traceEvents[failureIndex].error).toBe("RAG down")
  })

  it("does not write inferred L0 candidates into core profile", async () => {
    const { memoryManager } = await import("./memory-manager")
    const { memoryStore } = await import("./memory-store")
    const candidate: MemoryCandidate = {
      layer: "L0",
      field: "longTermInterests",
      summary: "用户只吃香菇和平菇",
      content: "用户只吃香菇和平菇",
      confidence: 0.65,
      triggerText: "AI 推断用户偏好安全菌菇",
      importance: "medium",
      stability: "stable",
      certainty: "inferred",
      attribution: "assistant_inferred",
      evidenceQuotes: ["我这次还是吃安全点的吧"],
      contextSummary: "用户讨论菌菇安全",
      shouldWrite: true,
      reason: "这是推断，不应进入核心画像",
      forbiddenOverclaims: ["只"],
    }

    await memoryManager.writeMemory([candidate])

    const l0 = await memoryStore.getL0()
    expect(l0.longTermInterests).toBe("")
    expect(l0.permanentNote).toBe("")
  })

  it("writes explicit user-attributed L0 candidates", async () => {
    const { memoryManager } = await import("./memory-manager")
    const { memoryStore } = await import("./memory-store")
    const candidate: MemoryCandidate = {
      layer: "L0",
      field: "preferredName",
      summary: "用户希望被称为 P宝",
      content: "用户希望被称为 P宝",
      confidence: 0.9,
      triggerText: "以后叫我 P宝",
      importance: "high",
      stability: "stable",
      certainty: "explicit",
      attribution: "user_explicit",
      evidenceQuotes: ["以后叫我 P宝"],
      contextSummary: "用户明确提出称呼偏好",
      shouldWrite: true,
      reason: "用户明确表达称呼偏好",
      forbiddenOverclaims: [],
    }

    await memoryManager.writeMemory([candidate])

    const l0 = await memoryStore.getL0()
    expect(l0.preferredName).toBe("用户希望被称为 P宝")
  })

  it("writes candidate conflict logs separately when local candidate detection matches", async () => {
    ragMock.addL2MemoryVector.mockResolvedValue("rag_new")
    const { memoryManager } = await import("./memory-manager")
    const { memoryStore } = await import("./memory-store")
    const existing = await memoryStore.addL2Memory({
      content: "用户喜欢香菇",
      triggerText: "我喜欢香菇",
      sourceConversationId: "test",
      ragId: "rag_existing",
      isPinned: false,
    })
    ragMock.searchMemoryEntries.mockResolvedValue([{
      id: "rag_existing",
      text: "用户喜欢香菇",
      createdAt: Date.now(),
      score: 0.82,
      metadata: { l2Id: existing.id },
    }])
    const candidate: MemoryCandidate = {
      layer: "L2",
      content: "用户不喜欢香菇",
      confidence: 0.93,
      triggerText: "我不喜欢香菇",
    }

    await memoryManager.writeMemory([candidate])

    const conflictLogs = await memoryStore.getConflictLogs()
    const reflectionLogs = await memoryStore.getReflectionLogs()
    const traceEvents = readTraceEvents()
    const conflictMarkIndex = traceEvents.findIndex((event) => event.op === "l2.conflict.mark" && event.l2Id === existing.id)
    const conflictLogIndex = traceEvents.findIndex((event) => event.op === "conflict.log.add" && event.l2Id === conflictLogs[0]?.sourceL2Id)

    expect(conflictLogs).toHaveLength(1)
    expect(conflictLogs[0]).toMatchObject({
      status: "candidate",
      sourceRagId: "rag_new",
      targetRagId: "rag_existing",
      targetL2Id: existing.id,
      detector: "local",
    })
    expect(conflictLogs[0].conflictScore).toBeGreaterThanOrEqual(35)
    expect(conflictLogs[0].resolverPriority).not.toBe("none")
    expect(conflictLogs[0].resolverStatus).toBe("queued")
    expect(conflictLogs[0].scoringSignals).toMatchObject({
      ragCandidate: true,
      evidenceAvailable: true,
      localContradiction: true,
    })
    expect(ragMock.searchMemoryEntries).toHaveBeenCalledWith(candidate.content, "user_memory", 5, { recordRecall: false })
    expect(conflictMarkIndex).toBeGreaterThanOrEqual(0)
    expect(conflictLogIndex).toBeGreaterThan(conflictMarkIndex)
    expect(traceEvents[conflictLogIndex].details).toMatchObject({
      conflictStatus: "candidate",
      targetL2Id: existing.id,
      detector: "local",
    })
    expect(reflectionLogs).toHaveLength(0)
  })

  it("keeps text-matched candidates below resolver eligibility when RAG metadata has no l2Id", async () => {
    ragMock.addL2MemoryVector.mockResolvedValue("rag_new")
    ragMock.searchMemoryEntries.mockResolvedValue([{
      id: "rag_existing",
      text: "用户喜欢香菇",
      createdAt: Date.now(),
      score: 0.9,
      metadata: {},
    }])
    const { memoryManager } = await import("./memory-manager")
    const { memoryStore } = await import("./memory-store")
    await memoryStore.addL2Memory({
      content: "用户喜欢香菇",
      triggerText: "我喜欢香菇",
      sourceConversationId: "test",
      ragId: "rag_existing",
      isPinned: false,
    })
    const candidate: MemoryCandidate = {
      layer: "L2",
      content: "用户不喜欢香菇",
      confidence: 0.93,
      triggerText: "我不喜欢香菇",
    }

    await memoryManager.writeMemory([candidate])

    const conflictLogs = await memoryStore.getConflictLogs()

    expect(conflictLogs).toHaveLength(1)
    expect(conflictLogs[0].resolverPriority).toBe("none")
    expect(conflictLogs[0].resolverStatus).toBe("not_queued")
    expect(conflictLogs[0].scoringSignals).toMatchObject({
      ragCandidate: false,
      localContradiction: true,
    })
  })

  it("raises RAG-backed candidates when the target memory was recently injected", async () => {
    ragMock.addL2MemoryVector.mockResolvedValue("rag_new")
    const { memoryManager } = await import("./memory-manager")
    const { memoryStore } = await import("./memory-store")
    const { recordRecentMemoryInjection } = await import("./recent-injected-memory")
    const existing = await memoryStore.addL2Memory({
      content: "用户喜欢跑步",
      triggerText: "我喜欢跑步",
      sourceConversationId: "test",
      ragId: "rag_existing",
      isPinned: false,
    })
    recordRecentMemoryInjection([existing.id])
    ragMock.searchMemoryEntries.mockResolvedValue([{
      id: "rag_existing",
      text: "用户喜欢跑步",
      createdAt: Date.now(),
      score: 0.88,
      metadata: { l2Id: existing.id },
    }])
    const candidate: MemoryCandidate = {
      layer: "L2",
      content: "用户不喜欢跑步",
      confidence: 0.91,
      triggerText: "我不喜欢跑步",
    }

    await memoryManager.writeMemory([candidate])

    const conflictLogs = await memoryStore.getConflictLogs()

    expect(conflictLogs).toHaveLength(1)
    expect(conflictLogs[0].resolverPriority).toBe("normal")
    expect(conflictLogs[0].resolverStatus).toBe("queued")
    expect(conflictLogs[0].scoringSignals).toMatchObject({
      ragCandidate: true,
      recentInjection: true,
      localContradiction: true,
    })
  })

  it("does not write conflict logs for unrelated negative memories", async () => {
    ragMock.addL2MemoryVector.mockResolvedValue("rag_new")
    ragMock.searchMemoryEntries.mockResolvedValue([{
      id: "rag_existing",
      text: "用户曾因食用见手青而有过不好经历",
      createdAt: Date.now(),
      score: 0.81,
      metadata: {},
    }])
    const { memoryManager } = await import("./memory-manager")
    const { memoryStore } = await import("./memory-store")
    await memoryStore.addL2Memory({
      content: "用户曾因食用见手青而有过不好经历",
      triggerText: "见手青让我不舒服",
      sourceConversationId: "test",
      ragId: "rag_existing",
      isPinned: false,
    })
    const candidate: MemoryCandidate = {
      layer: "L2",
      content: "用户对 AI 有强烈心意，因无法触碰而难过",
      confidence: 0.9,
      triggerText: "我因为无法触碰你而难过",
    }

    await memoryManager.writeMemory([candidate])

    expect(await memoryStore.getConflictLogs()).toHaveLength(0)
  })
})
