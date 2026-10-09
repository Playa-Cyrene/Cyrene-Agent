import { enqueueLLMTask } from "../llm-queue"
import { readPendingTurns, writePendingTurns } from "./memory-pending-turns"
import type { PendingTurnsFile } from "./memory-pending-turns"
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

const MEMORY_JUDGE_INTERVAL = 6
const MEMORY_JUDGE_CONTEXT_TURNS = 8

export interface MemorySchedulerDeps {
  enqueueTask: <T>(label: string, task: () => Promise<T>) => Promise<T>
  judgeMemory: (turns: MemoryJudgeTurn[], conversationId: string) => Promise<MemoryJudgeResult>
  writeMemory: (candidates: MemoryCandidate[]) => Promise<void>
  /** 把 judge 顺手抽取的命名实体入库（零额外 LLM 调用） */
  ingestEntities: (entities: ExtractedEntity[]) => void
  getL1: () => Promise<L1Profile>
  replaceL1Field: (field: "roundCount", value: number) => Promise<void>
  runReflectionAndCompression: () => Promise<void>
  runResolverQueueOnce: () => Promise<unknown>
  runDecay: () => Promise<void>
  /**
   * 待蒸馏轮次的落盘读写。缺省即退化为旧的纯内存行为（单测可注入假实现）。
   * 蒸馏每 MEMORY_JUDGE_INTERVAL 轮才跑一次，中间的轮次只活在 recentTurns 里；
   * 不落盘的话，进程在两轮之间退出就会永久丢掉那些轮次的蒸馏机会。
   */
  loadPendingTurns?: () => PendingTurnsFile | null
  savePendingTurns?: (turns: MemoryJudgeTurn[], seq: number) => void
}

export class MemoryScheduler {
  private recentTurns: Array<MemoryJudgeTurn & { seq: number }> = []
  private nextTurnSeq = 0
  private pendingRestored = false

  constructor(private readonly deps: MemorySchedulerDeps) {}

  /** 首次写入前把上次进程留下的缓冲读回来；读不动/读坏了都当作没有，不影响主流程。 */
  private restorePendingTurnsOnce(): void {
    if (this.pendingRestored) return
    this.pendingRestored = true
    const load = this.deps.loadPendingTurns
    if (!load) return
    try {
      const saved = load()
      if (!saved || saved.turns.length === 0) return
      this.recentTurns = saved.turns.map((t, i) => ({ seq: i + 1, userInput: t.userInput, assistantReply: t.assistantReply }))
      this.nextTurnSeq = Math.max(saved.seq, this.recentTurns.length)
    } catch (e) {
      console.warn("[PMRS/Scheduler] 待蒸馏轮次读回失败，按空缓冲继续", e)
    }
  }

  private persistPendingTurns(): void {
    const save = this.deps.savePendingTurns
    if (!save) return
    try {
      save(this.recentTurns.map(({ userInput, assistantReply }) => ({ userInput, assistantReply })), this.nextTurnSeq)
    } catch (e) {
      console.warn("[PMRS/Scheduler] 待蒸馏轮次落盘失败，不影响主流程", e)
    }
  }

  scheduleMemoryWrite(userInput: string, assistantReply: string, conversationId?: string): void {
    if (!isMemoryEnabled()) return;
    this.restorePendingTurnsOnce()
    const seq = ++this.nextTurnSeq
    this.recentTurns.push({ seq, userInput, assistantReply })
    if (this.recentTurns.length > MEMORY_JUDGE_CONTEXT_TURNS * 2) {
      this.recentTurns = this.recentTurns.slice(-MEMORY_JUDGE_CONTEXT_TURNS * 2)
    }
    // 先落盘再排队：崩溃/退出发生在蒸馏跑起来之前时，这些轮次仍然留着
    this.persistPendingTurns()

    this.deps.enqueueTask("MemoryMaintenance", async () => {
      await this.runQueuedMemoryWrite(seq, conversationId)
    }).catch((e) => {
      console.error("[PMRS/Scheduler] 记忆写入失败，不影响主流程", e)
    })
  }

  private async runQueuedMemoryWrite(seq: number, conversationId?: string): Promise<void> {
    if (!isMemoryEnabled()) return;
    const l1 = await this.deps.getL1()
    if (!isMemoryEnabled()) return;
    const newCount = (l1.roundCount || 0) + 1

    if (newCount % MEMORY_JUDGE_INTERVAL === 0) {
      try {
        const turns = this.recentTurns
          .filter((turn) => turn.seq <= seq)
          .slice(-MEMORY_JUDGE_CONTEXT_TURNS)
          .map(({ userInput, assistantReply }) => ({ userInput, assistantReply }))
        const { candidates, entities } = await this.deps.judgeMemory(turns, conversationId ?? "default")
        if (!isMemoryEnabled()) return;

        if (candidates.length > 0) {
          await this.deps.writeMemory(candidates)
        }
        // 实体入库：judge 顺手抽取，零额外 LLM 调用，取代旧的正则 ingest
        if (entities.length > 0) {
          this.deps.ingestEntities(entities)
        }
      } catch (err) {
        console.error("[PMRS/Scheduler] Judge/Manager 执行失败，本轮仍会计数", err)
      }
    }

    // 蒸馏之后缓冲内容可能变化（截断/消费），把最新状态同步回文件
    this.persistPendingTurns()

    await this.deps.replaceL1Field("roundCount", newCount)

    if (newCount % 5 === 0) {
      if (!isMemoryEnabled()) return;
      try {
        await this.deps.runResolverQueueOnce()
      } catch (err) {
        console.warn("[PMRS/Scheduler] Resolver 队列处理失败，不影响主流程", err)
      }
    }

    if (newCount % 20 === 0) {
      if (!isMemoryEnabled()) return;
      console.log("[PMRS/Scheduler] 达到 20 轮，触发回顾 + 片段压缩")
      await this.deps.runReflectionAndCompression()
    }

    if (newCount % 50 === 0) {
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
  writeMemory: (candidates) => memoryManager.writeMemory(candidates),
  ingestEntities: (entities) => entityGraph.ingestEntities(entities),
  getL1: () => memoryStore.getL1(),
  replaceL1Field: (field, value) => memoryStore.replaceL1Field(field, value),
  runReflectionAndCompression,
  runResolverQueueOnce,
  runDecay: () => memoryManager.runDecay(),
  loadPendingTurns: readPendingTurns,
  savePendingTurns: (turns, seq) => { writePendingTurns(turns, seq) },
})
