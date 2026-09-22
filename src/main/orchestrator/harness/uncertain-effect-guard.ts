/**
 * Uncertain Effect Guard：结果不确定副作用的拦截与解除。
 *
 * 仅保留副作用 fingerprint 拦截：
 * - isBlockedByUncertainEffect：阻止相同 non-idempotent 副作用的自动重放
 * - resolveUncertainEffect：通过 reconcile / ask_user 解除一次 uncertain effect
 *
 * 重要边界：本文件只决定"是否允许下一次相同危险调用"，
 * 不参与 final settlement、不否决模型诚实 final。
 * 原因：Runtime 只能对它能机械确定的事实（重复副作用）拥有强制权；
 * 任务是否完成的语义判断由模型决定。
 *
 * 与 completion-policy.ts 的差异：原 completion-policy.ts 同时承担
 * obligation 生命周期 + uncertainEffect 拦截 + final gate；重构时
 * obligation + final gate 已移除，只保留本文件的副作用拦截。
 */

import type { AgentState } from "./types";

/**
 * 检查某工具调用是否被 uncertainEffects 拦截（相同 fingerprint）。
 *
 * 触发条件：state.uncertainEffects 中已存在相同 fingerprint 的未确认副作用。
 * 行为：返回 true 表示该危险调用应被 runtime safety 拦截，
 * dispatcher 会给出结构化 failure observation，而不是再次执行。
 */
export function isBlockedByUncertainEffect(
  state: AgentState,
  fingerprint: string,
): boolean {
  const openParen = fingerprint.indexOf("(");
  const toolName = openParen > 0 ? fingerprint.slice(0, openParen) : "";
  const failSafeFingerprint = toolName ? `${toolName}(*)` : undefined;
  return state.uncertainEffects.some((effect) =>
    effect.fingerprint === fingerprint || effect.fingerprint === failSafeFingerprint,
  );
}

/**
 * 解除 uncertain effect（通过 reconcile 工具验证或 ask_user 用户确认）。
 *
 * 只清理匹配 toolCallId 的记录；其他 uncertain effect 不受影响。
 */
export function resolveUncertainEffect(
  state: AgentState,
  toolCallId: string,
): void {
  state.uncertainEffects = state.uncertainEffects.filter(
    (effect) => effect.toolCallId !== toolCallId,
  );
}
