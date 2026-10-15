import { enqueueLLMTask } from "../llm-queue"
import { runReflectionAndCompression } from "./memory-compressor"
import { entityGraph } from "./entity-graph"
import type { ExtractedEntity } from "./entity-graph"
import { memoryJudge } from "./memory-judge"
import { memoryManager } from "./memory-manager"
import { runResolverQueueOnce } from "./memory-resolver"
import { memoryStore } from "./memory-store"
import type { MemoryJudgeResult } from "./memory-schemas"
import type { L1Profile, MemoryCandidate, MemoryJudgeTurn } from "./memory-types"
import { isMemoryEnabled } from "./memory-mode"
import { memoryPendingTurns } from "./memory-pending-turns"
import type { MemoryPendingStore, MemoryTurnSource } from "./memory-pending-types"

export interface MemorySchedulerDeps {
  enqueueTask: <T>(label: string, task: () => Promise<T>) => Promise<T>
  judgeMemory: (turns: MemoryJudgeTurn[], conversationId: string) => Promise<MemoryJudgeResult>
  writeMemory: (candidates: MemoryCandidate[], assertSourceCurrent: () => Promise<void>) => Promise<void>
  pending: MemoryPendingStore
  /** 把 judge 顺手抽取的命名实体入库（零额外 LLM 调用） */
  ingestEntities: (entities: ExtractedEntity[]) => void
  getL1: () => Promise<L1Profile>
  replaceL1Field: (field: "roundCount", value: number) => Promise<void>
  runReflectionAndCompression: () => Promise<void>
  runResolverQueueOnce: () => Promise<unknown>
  runDecay: () => Promise<void>
}

export class MemoryScheduler {
  private persistence = Promise.resolve()

  constructor(private readonly deps: MemorySchedulerDeps) {}

  async scheduleMemoryWrite(userInput: string, assistantReply: string, conversationId?: string, source?: MemoryTurnSource): Promise<void> {
    if (!isMemoryEnabled()) return;
    if (!conversationId || !source?.userTurnId || !source.assistantEntryId) {
      console.warn("[PMRS/Scheduler] 缺少消息来源，跳过无法校验的记忆轮次")
      return
    }
    // Persist outside the LLM queue: a busy judge must not delay durability of new replies.
    this.persistence = this.persistence.then(async () => {
      if (!isMemoryEnabled()) return
      const l1 = await this.deps.getL1()
      const recorded = await this.deps.pending.record({ userInput, assistantReply, conversationId, ...source }, l1.roundCount || 0)
      void this.deps.enqueueTask("MemoryMaintenance", () => this.runQueuedMemoryWrite(conversationId, recorded))
        .catch(e => console.error("[PMRS/Scheduler] 记忆维护失败", e))
    }).catch((e) => {
      console.error("[PMRS/Scheduler] 记忆写入失败，不影响主流程", e)
    })
    await this.persistence
  }

  private async runQueuedMemoryWrite(conversationId: string, recorded: { roundCount: number; added: boolean; seq?: number }): Promise<void> {
    if (!isMemoryEnabled()) return;
    // Six pending live user turns per conversation, plus two processed context turns.
    while (recorded.seq !== undefined && isMemoryEnabled()) {
      const batch = await this.deps.pending.batch(conversationId, recorded.seq)
      if (!batch) break
      const assertSourceCurrent = async () => {
        if (!isMemoryEnabled() || !await this.deps.pending.current(batch.turns)) throw new Error("MEMORY_SOURCE_CHANGED")
      }
      try {
        await assertSourceCurrent()
        const turns = batch.turns.map(({ userInput, assistantReply }) => ({ userInput, assistantReply }))
        const { candidates, entities } = await this.deps.judgeMemory(turns, conversationId)
        await assertSourceCurrent()
        if (candidates.length > 0) {
          await this.deps.writeMemory(candidates, assertSourceCurrent)
        }
        await assertSourceCurrent()
        if (entities.length > 0) {
          this.deps.ingestEntities(entities)
        }
        if (!await this.deps.pending.consume(batch)) break
      } catch (err) {
        console.error("[PMRS/Scheduler] Judge/Manager 失败或来源失效，保留有效待处理轮次", err)
        break
      }
    }
    // Regeneration/replayed completions must not repeat periodic maintenance.
    const newCount = await this.deps.pending.count()
    await this.deps.replaceL1Field("roundCount", newCount)
    if (!recorded.added || newCount < recorded.roundCount) return
    const maintenanceCount = recorded.roundCount
    if (maintenanceCount % 5 === 0) {
      if (!isMemoryEnabled()) return;
      try {
        await this.deps.runResolverQueueOnce()
      } catch (err) {
        console.warn("[PMRS/Scheduler] Resolver 队列处理失败，不影响主流程", err)
      }
    }

    if (maintenanceCount % 20 === 0) {
      if (!isMemoryEnabled()) return;
      console.log("[PMRS/Scheduler] 达到 20 轮，触发回顾 + 片段压缩")
      await this.deps.runReflectionAndCompression()
    }

    if (maintenanceCount % 50 === 0) {
      if (!isMemoryEnabled()) return;
      try {
        await this.deps.runDecay()
      } catch (err) {
        console.warn("[PMRS/Scheduler] L2 权重衰减失败，不影响主流程", err)
      }
    }
  }
}

export const memoryScheduler = new MemoryScheduler({
  enqueueTask: enqueueLLMTask,
  judgeMemory: (turns, conversationId) => memoryJudge.judgeRecentTurns(turns, conversationId),
  writeMemory: (candidates, assertSourceCurrent) => memoryManager.writeMemory(candidates, assertSourceCurrent),
  pending: memoryPendingTurns,
  ingestEntities: (entities) => entityGraph.ingestEntities(entities),
  getL1: () => memoryStore.getL1(),
  replaceL1Field: (field, value) => memoryStore.replaceL1Field(field, value),
  runReflectionAndCompression,
  runResolverQueueOnce,
  runDecay: () => memoryManager.runDecay(),
})
