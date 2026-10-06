// 待蒸馏轮次的落盘（pending turns）。
//
// MemoryScheduler 的 recentTurns 原本只活在内存里，而记忆蒸馏每 MEMORY_JUDGE_INTERVAL
// 轮才触发一次：进程在第 1~5 轮之间退出（关窗口、崩溃、自动更新重启），这些轮次就永久
// 失去了被蒸馏的机会——逐字记录还在，但她不会再把它们变成记忆。轮次计数 roundCount 存
// 在 L1 里、本来就能跨重启存活，唯独它依赖的缓冲不能，所以补齐这一层即可。
//
// 读写都是同步的，与 memory-store-io.writeMemoryFile 的既有风格一致（文件最多 16 条、
// 几 KB），并走 tmp + rename 原子替换，避免半截文件。

import * as fs from "fs"
import * as path from "path"
import { app } from "electron"
import type { MemoryJudgeTurn } from "./memory-types"

/** 落盘格式：turns 按时间顺序，seq 是落盘时的序号水位。 */
export interface PendingTurnsFile {
  schemaVersion: 1
  seq: number
  turns: MemoryJudgeTurn[]
}

/** 与 MemoryScheduler 里的 recentTurns 截断上限保持一致。 */
export const PENDING_TURNS_CAP = 16

function resolvePendingTurnsPath(): string | null {
  // Electron 主进程之外（单测环境）app 可能不存在，直接放弃持久化
  try {
    return path.join(app.getPath("userData"), "memory-pending-turns.json")
  } catch {
    return null
  }
}

function isTurn(value: unknown): value is MemoryJudgeTurn {
  const t = value as MemoryJudgeTurn | null
  return !!t && typeof t.userInput === "string" && typeof t.assistantReply === "string"
}

/** 读回缓冲；文件缺失/损坏一律当作空，绝不因为落盘数据不干净而阻塞主流程。 */
export function readPendingTurns(): PendingTurnsFile | null {
  const filePath = resolvePendingTurnsPath()
  if (!filePath || !fs.existsSync(filePath)) return null
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf8")) as Partial<PendingTurnsFile>
    if (!parsed || !Array.isArray(parsed.turns)) return null
    const turns = parsed.turns.filter(isTurn).slice(-PENDING_TURNS_CAP)
    const seq = Number.isFinite(parsed.seq) ? Math.trunc(parsed.seq as number) : turns.length
    return { schemaVersion: 1, seq, turns }
  } catch {
    return null
  }
}

/** 原子写：先落 .tmp 再 rename。返回是否真的写了盘，调用方不需要等待它。 */
export function writePendingTurns(turns: MemoryJudgeTurn[], seq: number): boolean {
  const filePath = resolvePendingTurnsPath()
  if (!filePath) return false
  try {
    const dir = path.dirname(filePath)
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
    const payload: PendingTurnsFile = {
      schemaVersion: 1,
      seq,
      turns: turns.filter(isTurn).slice(-PENDING_TURNS_CAP),
    }
    const tmp = `${filePath}.${process.pid}.tmp`
    fs.writeFileSync(tmp, JSON.stringify(payload, null, 2), "utf8")
    fs.renameSync(tmp, filePath)
    return true
  } catch {
    return false
  }
}
