/**
 * 会话轨迹读取路径（CTA Phase 1）。
 *
 * 职责：从轨迹条目物化模型上下文——
 * 1. 应用 turn_rewind 活动视图语义（锚点始终解析为当前活动视图中最大 revision 的 user）；
 * 2. assistant 与 tool_result 原样展开 canonical ChatMessage（不从展示事件重建）；
 * 3. 崩溃孤儿按 runStore 执行状态分类闭合：started/unknown → unknown（非幂等另记
 *    uncertainEffects），无记录/planned/not_executed → not_executed；
 * 4. 完整 canonical 数组物化后才调用 findSafeCutPointForRetainedTokens 取安全尾窗。
 */

import { findSafeCutPointForRetainedTokens } from "./harness/compaction";
import type { HarnessRunSession } from "./harness/run-store";
import {
  DEFAULT_HARNESS_CONFIG,
  parseToolCallArgs,
  toolCallFingerprint,
  type UncertainEffect,
} from "./harness/types";
import type { ConversationTranscriptStore } from "./conversation-transcript-store";
import type { TranscriptEntry } from "./conversation-transcript-types";
import type { ChatMessage, ToolCall } from "./vendors/types";

export interface TranscriptRunReader {
  get(runId: string): HarnessRunSession | null;
}

export interface MaterializedTranscript {
  messages: ChatMessage[];
  uncertainEffects: UncertainEffect[];
  throughSeq: number;
}

type TranscriptUserEntry = Extract<TranscriptEntry, { kind: "user" }>;
type TranscriptAssistantEntry = Extract<TranscriptEntry, { kind: "assistant" }>;
type TranscriptRewindEntry = Extract<TranscriptEntry, { kind: "turn_rewind" }>;

/** 活动视图节点：user（含 replace_user 合成的）或 assistant（含已提交工具结果）。 */
type ActiveNode =
  | { kind: "user"; entry: TranscriptUserEntry | TranscriptRewindEntry; text: string }
  | { kind: "assistant"; entry: TranscriptAssistantEntry; toolResults: Map<string, ChatMessage> };

/** 锚点解析：当前活动视图中该 turnId 下 revision 最大的 user（盘上历史 revision 不参与）。 */
function findActiveUserIndex(active: ActiveNode[], turnId: string): number {
  let best = -1;
  let bestRevision = -Infinity;
  for (let index = 0; index < active.length; index++) {
    const node = active[index];
    if (node.kind !== "user" || node.entry.turnId !== turnId) continue;
    const revision = node.entry.revision ?? 0;
    if (revision > bestRevision) {
      best = index;
      bestRevision = revision;
    }
  }
  return best;
}

/** 合成孤儿 tool 消息（语义与施工包 A 的恢复闭合一致，outcome 复用四态）。 */
function syntheticToolMessage(call: ToolCall, outcome: "unknown" | "not_executed"): ChatMessage {
  return {
    role: "tool",
    toolCallId: call.id,
    name: call.name,
    content: JSON.stringify({
      outcome,
      tool: call.name,
      message: outcome === "unknown"
        ? "该工具已启动但结果未知（中断或轨迹写入失败）；不得自动重放，先查证或询问用户。"
        : "该工具从未执行（排队未启动即中断）；请根据当前任务自行决定是否重新调用。",
    }),
  };
}

function addUncertainEffect(
  effects: UncertainEffect[],
  runId: string | undefined,
  call: ToolCall,
): void {
  if (effects.some((effect) => effect.toolCallId === call.id)) return;
  effects.push({
    id: `${runId ?? "unknown-run"}:${call.id}`,
    toolCallId: call.id,
    fingerprint: toolCallFingerprint(call.name, parseToolCallArgs(call)),
    toolName: call.name,
    message: "该外部副作用在应用中断时尚未确认结果",
  });
}

/** 物化活动视图：rewind 语义 + canonical 消息展开 + 崩溃孤儿分类闭合。 */
export function materializeTranscript(
  entries: TranscriptEntry[],
  runReader: TranscriptRunReader,
): MaterializedTranscript {
  const active: ActiveNode[] = [];
  const uncertainEffects: UncertainEffect[] = [];
  let throughSeq = 0;

  for (const entry of entries) {
    throughSeq = Math.max(throughSeq, entry.seq);
    switch (entry.kind) {
      case "user":
        active.push({ kind: "user", entry, text: entry.payload.text });
        break;
      case "assistant":
        active.push({ kind: "assistant", entry, toolResults: new Map() });
        break;
      case "tool_result": {
        // 挂到活动视图中的 assistant；若已被 rewind 移除则忽略（属于被删分支）
        const node = active.find(
          (item) => item.kind === "assistant" && item.entry.id === entry.payload.assistantEntryId,
        );
        if (node && node.kind === "assistant" && !node.toolResults.has(entry.payload.toolCallId)) {
          node.toolResults.set(entry.payload.toolCallId, entry.payload.message);
        }
        break;
      }
      case "turn_rewind": {
        const anchorIndex = findActiveUserIndex(active, entry.payload.anchorUserTurnId);
        if (entry.payload.disposition === "keep_user") {
          // 保留锚点 user 及之前的活动条目，删除其后的 assistant 尾部
          if (anchorIndex >= 0) active.length = anchorIndex + 1;
        } else {
          // replace_user：删锚点及之后，再从 rewind 行本身合成新 user（原子单行的读取侧体现）
          if (anchorIndex >= 0) active.length = anchorIndex;
          active.push({
            kind: "user",
            entry,
            text: entry.payload.replacementUser?.text ?? "",
          });
        }
        break;
      }
      default:
        // 边界记录（backfill_boundary / interruption / compaction_checkpoint）不参与模型消息
        break;
    }
  }

  const messages: ChatMessage[] = [];
  for (const node of active) {
    if (node.kind === "user") {
      messages.push({ role: "user", content: node.text });
      continue;
    }
    const payload = node.entry.payload;
    messages.push(payload);
    if (!payload.toolCalls?.length) continue;

    // 缺失结果按 runStore 执行状态分类闭合；读取侧按信封 runId 分流
    const runSession = node.entry.runId ? runReader.get(node.entry.runId) : null;
    const statusById = new Map(runSession?.toolCalls.map((call) => [call.toolCallId, call]));
    for (const call of payload.toolCalls) {
      const persisted = node.toolResults.get(call.id);
      if (persisted) {
        messages.push(persisted);
        continue;
      }
      const record = statusById.get(call.id);
      const isUnknown = record?.status === "started" || record?.status === "unknown";
      if (isUnknown) {
        // 仅已启动且非幂等副作用的调用才提示未知副作用
        if (record?.sideEffect === "non_idempotent_side_effect") {
          addUncertainEffect(uncertainEffects, node.entry.runId, call);
        }
        messages.push(syntheticToolMessage(call, "unknown"));
      } else {
        messages.push(syntheticToolMessage(call, "not_executed"));
      }
    }
  }

  return { messages, uncertainEffects, throughSeq };
}

/** 权威上下文构建：等队列清空 → 读轨迹 → 物化 → 安全 token 尾窗。 */
export async function buildModelContext(input: {
  store: ConversationTranscriptStore;
  conversationId: string;
  retainTokens: number;
  runReader: TranscriptRunReader;
}): Promise<MaterializedTranscript> {
  // fail-closed 读取前置：先等该会话写队列清空，禁止读到半更新状态
  await input.store.waitForIdle(input.conversationId);
  const snapshot = await input.store.read(input.conversationId);
  const materialized = materializeTranscript(snapshot.entries, input.runReader);
  // 先物化、后裁剪：只在完整 canonical 数组存在后调用安全裁剪点
  const cutIndex = findSafeCutPointForRetainedTokens(materialized.messages, input.retainTokens);
  return {
    messages: materialized.messages.slice(cutIndex),
    uncertainEffects: materialized.uncertainEffects,
    throughSeq: snapshot.throughSeq,
  };
}

/** 轨迹尾窗预算：沿用 Harness 既有 token 预算体系，不另立标准。 */
export function resolveTranscriptRetainTokens(contextWindowTokens: number): number {
  const usable = Math.max(
    1,
    contextWindowTokens
      - DEFAULT_HARNESS_CONFIG.reservedOutputTokens
      - DEFAULT_HARNESS_CONFIG.safetyMarginTokens,
  );
  return Math.max(1, Math.floor(usable * DEFAULT_HARNESS_CONFIG.compactionThreshold));
}
