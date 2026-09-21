/**
 * 轨迹派发协调器（CTA Phase 1）。
 *
 * 职责：桌面四模式的 dispatch 提交——
 * 1. 首次派发时把 UI 会话历史确定性回填进轨迹（崩溃后按行幂等续传）；
 * 2. 正常派发追加当前 user（确定性 entryId，IPC 重试幂等）；
 * 3. edit / regenerate 写单行 turn_rewind（replace_user 同行携带替换 user，原子提交）。
 *
 * 关键规则：
 * - 回填跳过当前 userTurnId（无 rewind 时）——当前输入由 dispatch 路径写入；
 * - 带 rewind 时不跳过（锚点需要存在）：edit 的替换基准 revision = 轨迹中该
 *   turnId 的最大 revision + 1，regenerate 的 keep_user 锚点据此解析；
 * - UI role "model" 回填为 canonical assistant 纯文本，不捏造旧工具历史。
 */

import type { ChatMessage as UiChatMessage, ChatSession, PendingChatAttachment } from "../../shared/chat-types";
import type { ConversationTranscriptStore } from "./conversation-transcript-store";
import type {
  TranscriptAppendInput,
  TranscriptEntry,
  TranscriptPresentationPatch,
} from "./conversation-transcript-types";

export interface TranscriptRewindRequest {
  anchorUserTurnId: string;
  disposition: "keep_user" | "replace_user";
}

/** UI 消息的模型侧文本：优先 modelContext（拼入模型上下文的版本），兜底气泡文本。 */
export function modelText(message: UiChatMessage): string {
  return message.modelContext?.trim() || message.content;
}

/** UI 附件只保留稳定元数据；previewUrl / status 等瞬态字段不落轨迹。 */
export function stableAttachments(message: UiChatMessage): PendingChatAttachment[] | undefined {
  const items = message.attachments?.map(({ kind, name, filePath, ...rest }) => ({
    kind,
    name,
    filePath,
    ...(kind === "image" && "mime" in rest && rest.mime ? { mime: rest.mime } : {}),
    ...(kind === "image" && "caption" in rest && rest.caption ? { caption: rest.caption } : {}),
    ...(kind === "image" && "hasAnnotations" in rest && rest.hasAnnotations ? { hasAnnotations: true } : {}),
  }));
  return items?.length ? items : undefined;
}

export interface LegacyBackfillDraft {
  message: UiChatMessage;
  text: string;
  attachments?: PendingChatAttachment[];
  presentationPatch: TranscriptPresentationPatch;
}

/**
 * 统一旧 UI 历史的模型文本、稳定附件与展示补丁口径。
 * migration 与首次 dispatch 都只消费这个结果，不各自复制筛选规则。
 */
export function buildLegacyBackfillDrafts(
  messages: UiChatMessage[],
  excludedTurnId?: string,
): LegacyBackfillDraft[] {
  const patchKeys: Array<keyof TranscriptPresentationPatch> = [
    "content", "reasoning", "reasoningBlocks", "processMessages", "agentRounds",
    "taskDelegations", "channelSource", "sticker", "toolExecutions", "runActivity",
    "runSnapshot", "ttsCacheKey", "ttsCacheVersion", "musicCard", "contextUsage",
  ];
  return messages
    .filter((message) => (message.role === "user" || message.role === "model")
      && typeof message.content === "string")
    .filter((message) => message.id !== excludedTurnId)
    .map((message) => {
      const presentationPatch = Object.fromEntries(
        patchKeys
          .filter((key) => message[key] !== undefined)
          .map((key) => [key, message[key]]),
      ) as TranscriptPresentationPatch;
      return {
        message,
        text: modelText(message),
        attachments: stableAttachments(message),
        presentationPatch,
      };
    });
}

/** 派发前提交：回填（如需）→ rewind 或当前 user。全程 fail-closed，失败即上抛。 */
export async function prepareTranscriptDispatch(input: {
  store: ConversationTranscriptStore;
  session: ChatSession;
  userTurnId: string;
  runId: string;
  rewind?: TranscriptRewindRequest;
}): Promise<void> {
  const { store, session, userTurnId, runId, rewind } = input;
  const currentUser = session.messages.find(
    (message) => message.id === userTurnId && message.role === "user",
  );
  if (!currentUser) throw new Error("TRANSCRIPT_USER_TURN_NOT_FOUND");

  const snapshot = await store.read(session.id);
  // 本地条目视图：快照之后新写入的行（回填 / rewind）也计入，供 revision 求最大值
  const localEntries: TranscriptEntry[] = [...snapshot.entries];
  const seenIds = new Set(snapshot.entries.map((entry) => entry.id));
  const boundaryId = `backfill:v1:${session.id}`;

  // ── 首次回填：boundary 不存在时确定性续传（崩溃后按行幂等恢复）──
  if (!seenIds.has(boundaryId)) {
    // 无 rewind 时跳过当前 user（由 dispatch 路径写入）；有 rewind 时保留它作锚点基准
    for (const draft of buildLegacyBackfillDrafts(session.messages, rewind ? undefined : userTurnId)) {
      const { message } = draft;
      const entryId = `backfill:v1:${message.id}`;
      if (seenIds.has(entryId)) continue;
      const entry: TranscriptAppendInput = message.role === "user"
        ? {
            id: entryId,
            at: message.at,
            kind: "user",
            turnId: message.id,
            revision: 1,
            payload: { text: draft.text, attachments: draft.attachments },
          }
        : {
            id: entryId,
            at: message.at,
            kind: "assistant",
            turnId: message.id,
            payload: { role: "assistant", content: draft.text },
          };
      const appended = await store.append(session.id, entry);
      seenIds.add(appended.id);
      localEntries.push(appended);
    }
    const boundary = await store.append(session.id, {
      id: boundaryId,
      at: currentUser.at,
      kind: "backfill_boundary",
      payload: { note: "UI 会话历史确定性回填边界" },
    });
    seenIds.add(boundary.id);
    localEntries.push(boundary);
  }

  // ── rewind 提交：单行原子（replace_user 同行携带替换 user），不追加独立 user 行 ──
  if (rewind) {
    const rewindId = `${runId}:rewind:${rewind.anchorUserTurnId}`;
    if (!seenIds.has(rewindId)) {
      if (rewind.disposition === "replace_user") {
        // 替换条目修订号 = 轨迹中该 turnId 的最大 revision + 1（回填保证 ≥ 1）
        const maxRevision = localEntries
          .filter((entry) => entry.turnId === rewind.anchorUserTurnId && typeof entry.revision === "number")
          .reduce((max, entry) => Math.max(max, entry.revision ?? 0), 0);
        await store.append(session.id, {
          id: rewindId,
          at: currentUser.at,
          kind: "turn_rewind",
          runId,
          turnId: rewind.anchorUserTurnId,
          revision: maxRevision + 1,
          payload: {
            anchorUserTurnId: rewind.anchorUserTurnId,
            disposition: "replace_user",
            reason: "edit",
            replacementUser: {
              text: modelText(currentUser),
              attachments: stableAttachments(currentUser),
            },
          },
        });
      } else {
        await store.append(session.id, {
          id: rewindId,
          at: currentUser.at,
          kind: "turn_rewind",
          runId,
          turnId: rewind.anchorUserTurnId,
          payload: {
            anchorUserTurnId: rewind.anchorUserTurnId,
            disposition: "keep_user",
            reason: "regenerate",
          },
        });
      }
    }
    return;
  }

  // ── 正常派发：追加当前 user（revision 1）──
  // entryId 基于 turnId + revision 且不含运行标识：首次写入后若模型启动失败，
  // 重试会换 runId 但同 userTurnId 命中同一条目，主键幂等直接跳过；
  // user 条目也不写 runId（运行标识与轨迹内容无关，写入会破坏次级幂等的语义比较）。
  await store.append(session.id, {
    id: `user:v1:${userTurnId}:r1`,
    at: currentUser.at,
    kind: "user",
    turnId: userTurnId,
    revision: 1,
    payload: { text: modelText(currentUser), attachments: stableAttachments(currentUser) },
  });
}
