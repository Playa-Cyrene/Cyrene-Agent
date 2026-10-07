/**
 * Harness 可观测性（observability）：上下文容量快照 + 缓存结构诊断。
 *
 * 职责边界：
 * - 这里只负责"怎么算、怎么发"（快照构造、指纹计算、事件发射）。
 * - "什么时候发"（preRequest / terminal、每轮请求前）属于编排决策，
 *   调用点留在 cyrene-harness.ts 主循环里。
 */

import { createHash } from "node:crypto";
import { buildContextUsageSnapshot } from "../context-usage";
import type { ContextUsagePhase } from "../../../shared/context-usage";
import {
  buildStableSystemPrefix,
  projectCacheRelevantRequest,
  type PromptLayers,
} from "../prompt-layers";
import type { HarnessRun } from "./cyrene-harness";

/**
 * 上下文容量快照（docs/context-usage-viewer-construction-plan.md）：
 * - preCompaction：摘要请求前展示当前完整占用，避免停留在上一轮的快照；
 * - preRequest：每轮 compaction 后、callLLM 前，代表本轮真正发给模型的 input；
 * - terminal：settleRun 统一出口（所有终态共享），此时 final assistant 已写回 transcript，含最终回复。
 * harness 的动态事实已物化为 internal transcript 消息，无独立 runtimeContext 计量。
 */
export function emitContextUsage(run: HarnessRun, phase: ContextUsagePhase): void {
  const { input } = run;
  const stablePrefix = input.promptLayers?.stablePrefix ?? input.systemPrompt;
  const usageParts = input.usageParts
    ?? { personaContent: stablePrefix, toolLayerContent: "" };
  input.onEvent?.({
    type: "context_usage",
    snapshot: buildContextUsageSnapshot({
      phase,
      ...(input.runId ? { runId: input.runId } : {}),
      round: run.rounds,
      contextWindowTokens: run.config.contextWindowTokens,
      personaContent: usageParts.personaContent,
      toolLayerContent: usageParts.toolLayerContent,
      ...(usageParts.skillLayerContent ? { skillLayerContent: usageParts.skillLayerContent } : {}),
      toolSpecs: run.allToolSpecs,
      messages: run.messages,
    }),
  });
}

/** 请求前发送非敏感缓存结构诊断（hash + 计数，不含提示词正文）。 */
export function emitCacheDiagnostic(run: HarnessRun, promptLayers: PromptLayers): void {
  const cacheRequest = projectCacheRelevantRequest({
    stableSystem: buildStableSystemPrefix(promptLayers),
    tools: run.allToolSpecs,
    messages: run.messages,
  });
  run.input.onCacheDiagnostic?.({
    ...(run.input.runId ? { runId: run.input.runId } : {}),
    cacheEpoch: run.cache.cacheEpoch,
    round: run.rounds,
    stablePromptFingerprint: fingerprintCacheDiagnostic(cacheRequest.stableSystem),
    toolSchemaFingerprint: fingerprintCacheDiagnostic(cacheRequest.tools),
    messagePrefixFingerprint: fingerprintCacheDiagnostic(cacheRequest.messages),
    messageCount: cacheRequest.messages.length,
  });
}

/** 缓存诊断指纹：只对结构做 hash，禁止携带提示词或工具输出正文。 */
function fingerprintCacheDiagnostic(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}
