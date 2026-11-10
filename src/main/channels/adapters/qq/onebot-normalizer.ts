import type { IncomingMessage, ChannelMention, ChannelReplyContext } from "../../types";
import { OneBotActionClient } from "./onebot-action-client";
import { OneBotMediaManager } from "./onebot-media";
import type { OneBotMessageEvent, OneBotSegment } from "./onebot-types";
import { oneBotId } from "./onebot-types";

interface MemberCacheEntry {
  name: string;
  expiresAt: number;
}

const memberNameCache = new Map<string, MemberCacheEntry>();
const MEMBER_CACHE_TTL_MS = 5 * 60_000;

function textFromSegments(segments: unknown): string {
  if (!Array.isArray(segments)) return "";
  return segments
    .map((segment) => {
      if (!segment || typeof segment !== "object") return "";
      const item = segment as OneBotSegment;
      if (item.type === "text") return String(item.data?.text ?? "");
      if (item.type === "markdown") return String(item.data?.markdown ?? item.data?.content ?? "");
      return "";
    })
    .join("")
    .trim();
}

async function resolveMemberName(
  client: OneBotActionClient,
  groupId: string,
  userId: string,
): Promise<string | undefined> {
  const cacheKey = `${groupId}:${userId}`;
  const cached = memberNameCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) return cached.name;
  try {
    const info = await client.call<Record<string, unknown>>("get_group_member_info", {
      group_id: groupId,
      user_id: userId,
      no_cache: false,
    });
    const name = String(info.card || info.nickname || "").trim();
    if (name) memberNameCache.set(cacheKey, { name, expiresAt: Date.now() + MEMBER_CACHE_TTL_MS });
    return name || undefined;
  } catch {
    return undefined;
  }
}

async function resolveReply(
  client: OneBotActionClient,
  segment: OneBotSegment,
): Promise<ChannelReplyContext> {
  const messageId = oneBotId(segment.data.id);
  if (!messageId) return { messageId: "" };
  try {
    const data = await client.call<Record<string, unknown>>("get_msg", { message_id: messageId });
    const sender = data.sender && typeof data.sender === "object"
      ? data.sender as Record<string, unknown>
      : {};
    return {
      messageId,
      senderId: oneBotId(sender.user_id),
      senderName: String(sender.card || sender.nickname || "").trim() || undefined,
      text: textFromSegments(data.message),
    };
  } catch {
    return { messageId };
  }
}

export function messageMentionsSelf(event: OneBotMessageEvent, selfId: string): boolean {
  return event.message.some((segment) =>
    segment.type === "at" && oneBotId(segment.data.qq) === selfId,
  );
}

export async function normalizeOneBotMessage(
  event: OneBotMessageEvent,
  context: {
    selfId: string;
    client: OneBotActionClient;
    media: OneBotMediaManager;
    supportsStream: boolean;
    signal?: AbortSignal;
  },
): Promise<IncomingMessage> {
  const senderId = oneBotId(event.user_id);
  const groupId = oneBotId(event.group_id);
  const senderName = String(event.sender?.card || event.sender?.nickname || "").trim() || undefined;
  const mentions: ChannelMention[] = [];
  const attachments: NonNullable<IncomingMessage["attachments"]> = [];
  const textParts: string[] = [];
  let reply: ChannelReplyContext | undefined;
  let skippedFirstSelfMention = false;

  for (const segment of event.message) {
    context.signal?.throwIfAborted();
    if (!segment || typeof segment !== "object") continue;
    if (segment.type === "text") {
      textParts.push(String(segment.data.text ?? ""));
      continue;
    }
    if (segment.type === "markdown") {
      textParts.push(String(segment.data.markdown ?? segment.data.content ?? ""));
      continue;
    }
    if (segment.type === "at") {
      const userId = oneBotId(segment.data.qq);
      const isBot = userId === context.selfId;
      const name = groupId && userId && userId !== "all"
        ? await resolveMemberName(context.client, groupId, userId)
        : userId === "all" ? "全体成员" : undefined;
      mentions.push({ userId, name, isBot });
      if (isBot && !skippedFirstSelfMention) {
        skippedFirstSelfMention = true;
      } else {
        textParts.push(` @${name || userId} `);
      }
      continue;
    }
    if (segment.type === "reply") {
      if (!reply) reply = await resolveReply(context.client, segment);
      continue;
    }
    if (["image", "mface", "record", "file", "video"].includes(segment.type)) {
      try {
        attachments.push(await context.media.downloadSegment(segment, context.supportsStream, context.signal));
        textParts.push(`[${segment.type === "record" ? "语音" : segment.type === "mface" ? "图片表情" : segment.type}]`);
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        textParts.push(`[附件处理失败：${reason}]`);
      }
      continue;
    }
    if (segment.type === "face") {
      textParts.push(`[QQ表情:${String(segment.data.id ?? "")}]`);
      continue;
    }
    if (segment.type === "json") {
      textParts.push("[JSON卡片]");
      continue;
    }
    // 位置/分享/合并转发/戳一戳等未适配段：显式占位，避免内容静默丢失后 agent 毫无感知
    textParts.push(`[未支持的消息类型:${segment.type}]`);
  }

  const text = textParts.join("").trim() || String(event.raw_message ?? "").trim() || "[空消息]";
  context.signal?.throwIfAborted();
  return {
    channel: "qq",
    chatType: event.message_type,
    messageId: oneBotId(event.message_id),
    senderId,
    senderName,
    chatId: event.message_type === "group" ? groupId : senderId,
    text,
    attachments: attachments.length > 0 ? attachments : undefined,
    mentions: mentions.length > 0 ? mentions : undefined,
    reply,
    at: new Date((Number(event.time) || Math.floor(Date.now() / 1000)) * 1000),
    _raw: event,
  };
}
