import { memoryStore } from "./memory-store"
import type { L0WritableField } from "./memory-store"
import { MemoryCandidate, L0_FIELD_DESCRIPTIONS, L2Memory } from "./memory-types"
import { findPossibleConflictCandidate } from "./memory-conflict"
import { scoreMemoryConflict, type ConflictEvidenceLevel } from "./memory-conflict-score"
import { wasRecentlyInjectedMemory } from "./recent-injected-memory"
import { addL2MemoryVector, searchMemoryEntries } from "../rag/index"

type L1Field = "recentGoals" | "recentPreferences" | "currentProject"

const VALID_L1_FIELDS: ReadonlySet<string> = new Set(["recentGoals", "recentPreferences", "currentProject"])

function preview(content: string, maxLength: number): string {
  return content.slice(0, maxLength)
}

/** 兜底分流：当 LLM 没有返回 field 时，用关键词猜测 L1 字段 */
function guessL1Field(content: string): L1Field {
  if (/目标|想要|计划|打算/.test(content)) return "recentGoals"
  if (/项目|在做|开发|写/.test(content)) return "currentProject"
  return "recentPreferences"
}

/** 解析 L1 field：优先用 LLM 返回的 field，非法或缺失时用关键词兜底 */
export function resolveL1Field(field: string | undefined, content: string): L1Field {
  if (field && VALID_L1_FIELDS.has(field)) return field as L1Field
  return guessL1Field(content)
}

function hasCorrectionIntent(text: string): boolean {
  return ["不是这样", "你记错了", "记错了", "我现在不这样", "现在不这样"].some((phrase) => text.includes(phrase))
}

function getImpactScope(memory: L2Memory): "low" | "medium" | "high" {
  if (memory.isPinned) return "high"
  if (memory.status === "active") return "medium"
  return "low"
}

function shouldSkipCandidate(candidate: MemoryCandidate): boolean {
  return candidate.shouldWrite === false || Boolean(candidate.forbiddenOverclaims && candidate.forbiddenOverclaims.length > 0)
}

function canWriteCoreProfile(candidate: MemoryCandidate): boolean {
  return candidate.certainty === "explicit" && candidate.attribution === "user_explicit"
}

export class MemoryManager {
  private async appendToPermanentNote(content: string): Promise<void> {
    const l0 = await memoryStore.getL0()
    const existing = l0.permanentNote || ""
    const updated = existing ? `${existing}；${content}` : content
    await memoryStore.upsertL0Field("permanentNote", updated)
  }

  async writeMemory(candidates: MemoryCandidate[], assertSourceCurrent?: () => Promise<void>): Promise<void> {
    for (const candidate of candidates) {
      if (assertSourceCurrent) await assertSourceCurrent()
      if (shouldSkipCandidate(candidate)) {
        console.log("[PMRS/Manager] 候选标记为不写入或存在过度概括，跳过")
        continue
      }

      if (candidate.layer === "L0") {
        if (!canWriteCoreProfile(candidate)) {
          console.log("[PMRS/Manager] L0 候选不是用户明确事实，跳过自动写核心画像")
          continue
        }

        // 如果 L0 被用户锁定，跳过
        const l0 = await memoryStore.getL0()
        if (l0.isPinned) {
          console.log("[PMRS/Manager] L0 已锁定，跳过自动更新")
          continue
        }

        // 从唯一事实来源获取合法字段列表
        const validFields = Object.keys(L0_FIELD_DESCRIPTIONS)

        // 情况一：AI 没有输出 field 字段（理论上不该发生）
        if (!candidate.field) {
          console.warn("[PMRS/Manager] L0 候选缺少 field 字段，跳过自动写核心画像")
          continue
        }

        // 情况二：AI 输出了非法字段名（幻觉）
        if (!validFields.includes(candidate.field)) {
          console.warn(`[PMRS/Manager] AI 返回非法字段 "${candidate.field}"，跳过自动写核心画像`)
          continue
        }

        // 情况三：合法字段，直接写入
        await memoryStore.upsertL0Field(candidate.field as L0WritableField, candidate.content, assertSourceCurrent)
        console.log(`[PMRS/Manager] L0 更新字段: ${candidate.field} = "${candidate.content.slice(0, 20)}"`)
      } else if (candidate.layer === "L1") {
        const field = resolveL1Field(candidate.field, candidate.content)
        await memoryStore.replaceL1Field(field, candidate.content, assertSourceCurrent)
        console.log(`[PMRS/Manager] L1 更新字段: ${field}`)
      } else if (candidate.layer === "L2") {
        await this.writeL2(candidate, assertSourceCurrent)
      }
    }
  }

  private async writeL2(candidate: MemoryCandidate, assertSourceCurrent?: () => Promise<void>): Promise<void> {
    const l2Input: Omit<L2Memory, "id" | "createdAt" | "lastAccessedAt" | "accessCount" | "weight" | "status"> = {
      content: candidate.content,
      triggerText: candidate.triggerText,
      sourceConversationId: candidate.sourceConversationId ?? "",
      embedding: [],
      isPinned: false,
      syncStatus: "pending_sync",
    }
    // LLM 生成的精炼标题，缺失时 obsidian-exporter 会回退到内部 id 作为文件名
    if (candidate.slug) l2Input.slug = candidate.slug
    // L2 原文对话片段（展示用），缺失时不注入
    if (candidate.sourceQuote) l2Input.sourceQuote = candidate.sourceQuote

    const l2 = await memoryStore.addL2Memory(l2Input, assertSourceCurrent)

    let ragId: string | undefined
    try {
      ragId = await addL2MemoryVector(candidate.content, l2.id, {
        triggerText: candidate.triggerText,
        confidence: candidate.confidence,
      })
      await memoryStore.markL2SyncStatus(l2.id, "synced", ragId)
    } catch (err) {
      await memoryStore.markL2SyncStatus(l2.id, "sync_failed", undefined, err)
      console.warn("[PMRS/Manager] L2 已写入，但 RAG 同步失败:", err)
      return
    }

    console.log(`[PMRS/Manager] L2 写入: "${preview(candidate.content, 30)}"（l2Id: ${l2.id}, ragId: ${ragId}）`)

    // ── 冲突检测：检查新记忆是否与现有记忆矛盾 ──
    try {
      await this.detectAndMarkConflicts(candidate.content, l2.id, ragId, candidate.triggerText)
    } catch (err) {
      console.warn("[PMRS/Manager] 冲突检测失败:", err)
    }
  }

  /** 检测新记忆是否与现有 active 记忆矛盾，如有则标记 */
  private async detectAndMarkConflicts(content: string, newL2Id: string, newRagId: string, triggerText: string): Promise<void> {
    // 搜索语义相似的现有 L2 条目
    const allL2 = await memoryStore.getAllL2()
    const activeL2 = allL2.filter((m) => (m.status === "active" || m.status === "aging") && m.ragId && m.ragId !== newRagId)

    // 用 RAG entry 做向量相似度匹配，优先读取 metadata.l2Id 精确定位 L2。
    const similarEntries = await searchMemoryEntries(content, "user_memory", 5, { recordRecall: false })
    if (similarEntries.length === 0) return

    const entriesByL2Id = new Map<string, (typeof similarEntries)[number]>()
    for (const entry of similarEntries) {
      const l2Id = entry.metadata?.l2Id
      if (typeof l2Id === "string" && l2Id.length > 0) {
        entriesByL2Id.set(l2Id, entry)
      }
    }

    // 在 activeL2 中找 RAG 定位到的候选，再检查是否存在本地弱矛盾信号。
    for (const existing of activeL2) {
      const metadataMatch = entriesByL2Id.get(existing.id)
      const textMatch = similarEntries.find((entry) => (
        entry.text === existing.content ||
        existing.content.includes(entry.text.slice(0, 20)) ||
        entry.text.includes(existing.content.slice(0, 20))
      ))
      const matchedEntry = metadataMatch ?? textMatch
      if (!matchedEntry) continue

      const candidate = findPossibleConflictCandidate(content, existing.content)
      if (candidate.isCandidate) {
        // 本地规则只产出疑似候选，不确认冲突真伪。
        const marked = await memoryStore.markL2Conflict(existing.id, newRagId)
        if (marked) {
          const log = await memoryStore.appendConflictLog({
            status: "candidate",
            sourceL2Id: newL2Id,
            targetL2Id: existing.id,
            sourceRagId: newRagId,
            targetRagId: existing.ragId,
            reason: candidate.reason ?? "possible local lexical contradiction",
            confidence: candidate.confidence,
            detector: "local",
          })
          const score = scoreMemoryConflict({
            candidateSource: wasRecentlyInjectedMemory(existing.id) ? "recent_injection" : metadataMatch ? "rag" : "local",
            ragScore: metadataMatch ? matchedEntry.score : undefined,
            correctionIntent: hasCorrectionIntent(triggerText),
            recentInjection: wasRecentlyInjectedMemory(existing.id),
            localContradiction: true,
            evidence: await this.getEvidenceLevel(newL2Id, existing.id),
            activeTarget: existing.status !== "archived",
            impactScope: getImpactScope(existing),
          })
          await memoryStore.scoreConflictLog(log.id, score)
          console.log(`[PMRS/Manager] ⚠️ 发现疑似记忆冲突候选: "${preview(existing.content, 30)}" ↔ "${preview(content, 30)}"`)
        }
      }
    }
  }

  private async getEvidenceLevel(sourceL2Id: string, targetL2Id: string): Promise<ConflictEvidenceLevel> {
    const [sourceEvidence, targetEvidence] = await Promise.all([
      memoryStore.getEvidenceByMemoryId(sourceL2Id),
      memoryStore.getEvidenceByMemoryId(targetL2Id),
    ])
    if (sourceEvidence.length > 0 && targetEvidence.length > 0) return "both"
    if (sourceEvidence.length > 0 || targetEvidence.length > 0) return "one_side"
    return "none"
  }

  /**
   * 手动触发的片段权重衰减。当前尚未挂载到生产调度；
   * 后续会由 memory-scheduler 统一决定触发策略。
   */
  async runDecay(): Promise<void> {
    const changed = await memoryStore.decayL2Weights()
    console.log(`[PMRS/Manager] L2 权重衰减完成，更新 ${changed} 条`)
  }
}

export const memoryManager = new MemoryManager()
