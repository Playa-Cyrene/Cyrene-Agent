// 插话仅在持久化提交成功后注入运行；生产存储在同一数据库事务中提交用户条目与队列消费。

import * as chatsStore from "./chats-store";
import type { PendingChatAttachment, PendingChatMessage } from "../../shared/chat-types";
import type { RunAdjustmentMessage } from "../orchestrator/harness/types";
import { pendingAdjustmentUserMessage } from "../../shared/pending-adjustment";

/** 轮询所需的存储端口（生产用 chats-store，测试可注入替身）。 */
export interface PendingAdjustmentStore {
  getPendingMessages(sessionId: string): (PendingChatMessage[] | null) | Promise<PendingChatMessage[] | null>;
  commitPendingAdjust(
    sessionId: string,
    messageId: string,
    runId: string,
  ): ({ ok: true; userMessage: { id: string }; remainingQueue: PendingChatMessage[] }
    | { ok: false; error: string }) | Promise<{ ok: true; userMessage: { id: string }; remainingQueue: PendingChatMessage[] }
    | { ok: false; error: string }>;
}

/** 权威轨迹的 user 写入端口：稳定 turnId + 附件元数据，重试幂等。 */
export interface TranscriptUserWritePort {
  appendUser(input: {
    turnId: string;
    text: string;
    attachments?: PendingChatAttachment[];
  }): Promise<void>;
}

/** 创建运行级插话轮询函数；自定义存储可注入轨迹适配端口。 */
export function createRunAdjustmentPoller(
  sessionId: string,
  runId: string,
  store: PendingAdjustmentStore = chatsStore,
  transcript?: TranscriptUserWritePort,
  onCommitted?: () => void,
): () => Promise<RunAdjustmentMessage[]> {
  return async () => {
    const queue = (await store.getPendingMessages(sessionId));
    if (!queue) return [];
    const marked = queue.filter((item) => item.adjustRunId === runId)
      .sort((left, right) => (left.adjustAcceptedAt ?? left.enqueuedAt) - (right.adjustAcceptedAt ?? right.enqueuedAt));
    if (marked.length === 0) return [];
    return (async () => {
      const injected: RunAdjustmentMessage[] = [];
      for (const item of marked) {
        // ① 权威轨迹先写（稳定 turnId + 附件元数据，同 entryId 重试幂等吸收）。
        //    写失败上抛：聊天历史不动，pending 保留。兼容调用无端口时跳过。
        if (transcript) {
          await transcript.appendUser({
            turnId: item.id,
            text: item.rawContent,
            ...(item.attachments?.length ? { attachments: item.attachments } : {}),
          });
        }
        // ② 聊天历史后写。失败同样上抛：pending 保留，下次轮询时轨迹幂等命中、只重试本步。
        const commit = (await store.commitPendingAdjust(sessionId, item.id, runId));
        if (!commit.ok) {
          throw new Error(`PENDING_ADJUST_COMMIT_FAILED:${item.id}:${commit.error}`);
        }
        // ③ 双写成功才注入运行
        injected.push({ id: commit.userMessage.id, rawContent: item.rawContent,
          userMessage: pendingAdjustmentUserMessage(item) });
        onCommitted?.();
      }
      return injected;
    })();
  };
}
