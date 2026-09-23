/**
 * 崩溃对账（CTA 第三层）：
 *
 * 正常终态（completed / cancelled / failed）都会 markTerminal 写 run-store 终态，
 * 并写 interruption 边界。只有进程崩溃会让 run 在 run-store 里滞留 running
 * （closeInterruption 从未执行、transcript 无该 runId 的 interruption 边界）。
 * 启动时 run-store initialize() 把这些 running 翻转为 interrupted【见 run-store】，
 * 本模块据此做一次幂等补写：对每个 interrupted run，若其会话轨迹没有本 run 的
 * interruption 边界，则补一条 reason="crashed" 的 interruption 条目。
 *
 * 不重放、不修补旧 run 的消息——工具 unknown/not_executed 与 uncertainEffects
 * 已由投影依据 run-store 持久化的工具状态合成，无需在此重复。
 */

import type { HarnessRunSession } from "./harness/run-store";
import type {
  ConversationTranscriptStore,
} from "./conversation-transcript-store";

/** 崩溃边界的确定性 entryId：与 closeInterruption 的 `${runId}:interruption:${reason}` 同构。 */
export function crashedInterruptionEntryId(runId: string): string {
  return `${runId}:interruption:crashed`;
}

export interface CrashReconciliationResult {
  /** 本次补写的崩溃边界数 */
  written: number;
  /** 已有边界（取消/系统错误/先前幂写）而跳过的 run 数 */
  skipped: number;
}

/** 纯函数依赖：注入 store 接口便于单元测试，不绑定磁盘实现。 */
export interface CrashReconciliationDeps {
  runStore: { listInterruptedRuns(): HarnessRunSession[] };
  transcriptStore: Pick<ConversationTranscriptStore, "read" | "append">;
  now?: () => number;
}

/**
 * 崩溃对账主逻辑：对所有 interrupted run 幂等补写 crashed 边界。
 * 幂等性：边界 entryId 由 runId 确定性生成，store 首写有效；
 * 下次启动时 interrupted run 已带 crashed 边界 → 直接跳过。
 */
export async function reconcileCrashedInterruptions(
  deps: CrashReconciliationDeps,
): Promise<CrashReconciliationResult> {
  const { runStore, transcriptStore, now = Date.now } = deps;
  let written = 0;
  let skipped = 0;
  for (const run of runStore.listInterruptedRuns()) {
    const snapshot = await transcriptStore.read(run.conversationId);
    const hasBoundary = snapshot.entries.some(
      (entry) => entry.kind === "interruption" && entry.runId === run.runId,
    );
    if (hasBoundary) {
      skipped += 1;
      continue;
    }
    await transcriptStore.append(run.conversationId, {
      kind: "interruption",
      id: crashedInterruptionEntryId(run.runId),
      at: now(),
      runId: run.runId,
      payload: { reason: "crashed" },
    });
    written += 1;
  }
  return { written, skipped };
}