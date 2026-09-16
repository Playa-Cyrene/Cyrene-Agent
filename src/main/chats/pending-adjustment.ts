// 运行插话轮询：把"标记插入当前运行"的待发条目提交为正式用户消息，
// 供 harness 在模型请求边界（下一次请求前 / 最终结算前）按序取走。
//
// 核心不变量：提交成功才注入——写盘失败或并发冲突的条目跳过并保持标记，
// 等下个边界重试或运行结束复位回普通队列，绝不注入未可靠记录的消息，
// 也绝不重复注入已提交的条目（提交即移出队列，第二次提交按 not-found 跳过）。

import * as chatsStore from "./chats-store";
import type { PendingChatMessage } from "../../shared/chat-types";
import type { RunAdjustmentMessage } from "../orchestrator/harness/types";

/** 轮询所需的存储端口（生产用 chats-store，测试可注入替身）。 */
export interface PendingAdjustmentStore {
  getPendingMessages(sessionId: string): PendingChatMessage[] | null;
  commitPendingAdjust(
    sessionId: string,
    messageId: string,
    runId: string,
  ): { ok: true; userMessage: { id: string }; remainingQueue: PendingChatMessage[] }
    | { ok: false; error: string };
}

/**
 * 创建运行级插话轮询函数。
 * 返回 undefined 表示当前没有标记插入本运行的消息（同步快速路径，
 * harness 不产生 await 挂起点）；返回 Promise 表示有待提交的插话，
 * resolve 值为已按入队顺序提交成功的消息（提交失败的条目被跳过）。
 */
export function createRunAdjustmentPoller(
  sessionId: string,
  runId: string,
  store: PendingAdjustmentStore = chatsStore,
): () => Promise<RunAdjustmentMessage[]> | undefined {
  return () => {
    const queue = store.getPendingMessages(sessionId);
    if (!queue) return undefined;
    const marked = queue.filter((item) => item.adjustRunId === runId);
    if (marked.length === 0) return undefined;
    return (async () => {
      const injected: RunAdjustmentMessage[] = [];
      for (const item of marked) {
        const commit = store.commitPendingAdjust(sessionId, item.id, runId);
        if (commit.ok) {
          injected.push({ id: commit.userMessage.id, rawContent: item.rawContent });
        } else {
          console.warn(
            `[pending-adjustment] 插话提交失败（条目保留标记，等下个边界重试）: ${item.id}`,
            commit.error,
          );
        }
      }
      return injected;
    })();
  };
}
