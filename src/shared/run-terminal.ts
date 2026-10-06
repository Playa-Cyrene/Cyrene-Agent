/**
 * Run 终态与 ACK 的共享类型。
 *
 * 设计依据（@ag-ui/core@0.0.57 的约束）：
 * - RUN_FINISHED.result 是可选 any，outcome 只支持 success/interrupt。
 * - cancelled / timeout 只写 result: { status, reason, externalEffectsMayContinue }，不写 outcome。
 * - runtime error 仍走 RUN_ERROR，但必须经过同一个 exactly-once settlement gate。
 *   gate 内部状态名一律用 `runtime_error`（冻结边界），AG-UI 事件名仍为 `RUN_ERROR`。
 *
 * 本文件只定义类型与最小常量，不引入 main / renderer 专属依赖，
 * 因此可以同时被 main、preload、renderer 安全 import。
 */

/** Canonical 终态分类。CyreneAgent / Harness / Bridge 三方共用。 */
export type CyreneTerminalStatus = "success" | "cancelled" | "timeout" | "runtime_error";

/**
 * RUN_FINISHED.result 与 CyreneAgent 内部终态共用的描述。
 * - success：正常完成（含 max_rounds 之外的正常退出）。
 * - cancelled：用户/上游主动取消（abortSource = user_cancelled）。
 * - timeout：总超时或 max_rounds 触发；reason 进一步细分。
 * - runtime_error：仅用于 runtime error 路径；事件本身仍是 RUN_ERROR，但 gate 内部统一记账。
 */
export interface CyreneRunTerminalResult {
  status: CyreneTerminalStatus;
  /** 机器可读原因码（max_rounds / call_timeout / user_cancelled / run_timeout 等）。 */
  reason?: string;
  /**
   * 已冻结的 invariant：渲染端据此决定是否假定 run 已干净结束。
   * - 普通成功、无 unresolved uncertainty → false
   * - 成功但仍有 uncertainEffects → true
   * - cancelled / timeout / runtime_error → true（保守）
   *
   * 必填字段：调用方必须显式声明，不允许省略。
   */
  externalEffectsMayContinue: boolean;
}

/**
 * AGUI_RUN invoke 立即返回的 ACK。
 *
 * 渲染端拿到 ack.runId 后即可：
 *  - 与 RUN_STARTED.runId 强一致校验；
 *  - 在 RUN_STARTED 事件到达前就能发起 cancel；
 *  - 在终态事件（RUN_FINISHED / RUN_ERROR）到达前作为占位 runId。
 *
 * 终态仍由事件流承载，ack.success=false 仅表示 run 没能开始（如 sessionId 缺失）。
 */
export interface AguiRunAck {
  /** A prior request returns its durable receipt rather than starting again. */
  duplicate?: boolean;
  status?: string;
  success: boolean;
  /** Bridge 创建的 canonical runId；与 RUN_STARTED.runId 一致。 */
  runId: string;
  /** ack.success=false 时的原因（不暴露内部错误细节）。 */
  error?: string;
}
