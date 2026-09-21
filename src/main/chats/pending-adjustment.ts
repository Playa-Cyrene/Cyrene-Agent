// 运行插话轮询：把"标记插入当前运行"的待发条目提交为正式用户消息，
// 供 harness 在模型请求边界（下一次请求前 / 最终结算前）按序取走。
//
// 核心不变量：双写成功才注入——每条插话先写权威轨迹（稳定 ID，含附件元数据），
// 再提交聊天历史；任一步失败抛错且 pending 标记保留（fail-closed），
// 下次轮询轨迹幂等命中后只重试聊天历史，绝不注入未可靠记录的消息，
// 也绝不重复注入已提交的条目（提交即移出队列，第二次提交按 not-found 跳过）。

import * as chatsStore from "./chats-store";
import type { PendingChatAttachment, PendingChatMessage } from "../../shared/chat-types";
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

/** 权威轨迹的 user 写入端口：稳定 turnId + 附件元数据，重试幂等。 */
export interface TranscriptUserWritePort {
  appendUser(input: {
    turnId: string;
    text: string;
    attachments?: PendingChatAttachment[];
  }): Promise<void>;
}

/**
 * 创建运行级插话轮询函数。
 * 返回 undefined 表示当前没有标记插入本运行的消息（同步快速路径，
 * harness 不产生 await 挂起点）；返回 Promise 表示有待提交的插话，
 * resolve 值为已按入队顺序双写成功的消息；任一步写失败则 reject
 * （pending 标记保留，等下个边界重试），由 harness fail-closed 终止运行。
 * transcript 端口缺省（缺 userTurnId 的兼容调用）：不写轨迹，只提交聊天历史。
 */
export function createRunAdjustmentPoller(
  sessionId: string,
  runId: string,
  store: PendingAdjustmentStore = chatsStore,
  transcript?: TranscriptUserWritePort,
): () => Promise<RunAdjustmentMessage[]> | undefined {
  return () => {
    const queue = store.getPendingMessages(sessionId);
    if (!queue) return undefined;
    const marked = queue.filter((item) => item.adjustRunId === runId);
    if (marked.length === 0) return undefined;
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
        const commit = store.commitPendingAdjust(sessionId, item.id, runId);
        if (!commit.ok) {
          throw new Error(`PENDING_ADJUST_COMMIT_FAILED:${item.id}:${commit.error}`);
        }
        // ③ 双写成功才注入运行
        injected.push({ id: commit.userMessage.id, rawContent: item.rawContent });
      }
      return injected;
    })();
  };
}
