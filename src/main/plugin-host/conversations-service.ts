import type {
  PluginConversationMessage,
  PluginConversationPage,
  PluginConversationSummary,
  PluginConversationsService,
  PluginMessagePage,
  PluginMessagePageInput,
} from "../../plugins/api";
import type { ChatMessage, ChatSession, ChatSessionMeta } from "../../shared/chat-types";
import { pluginHostError } from "./errors";

const DEFAULT_LIST_LIMIT = 20;
const MAX_LIST_LIMIT = 100;
const DEFAULT_MESSAGE_LIMIT = 50;
const MAX_MESSAGE_LIMIT = 100;

/** 会话存储的最小只读视图；真实实现是 chats-store，测试注入内存假件。 */
export interface PluginChatsStoreReader {
  listSessions(): (ChatSessionMeta[]) | Promise<ChatSessionMeta[]>;
  getSession(id: string): (ChatSession | null) | Promise<ChatSession | null>;
}

export interface PluginConversationsServiceOptions {
  reader: PluginChatsStoreReader;
  /** 插件停止信号；停止后所有调用返回 E_PLUGIN_STOPPING。 */
  signal?: AbortSignal;
}

// 游标只是不透明的分页状态，不是安全令牌；带版本号是为了
// 未来改变游标内容时旧游标能被明确拒绝而不是解析出错。
interface ListCursorPayload {
  v: 1;
  kind: "list";
  offset: number;
}

interface MessagesCursorPayload {
  v: 1;
  kind: "messages";
  conversationId: string;
  /** 首次调用时冻结的包含式起点。 */
  from?: string;
  /** 首次调用时冻结的包含式终点。 */
  through?: string;
  /** 上一页最后一条原始消息在会话消息数组中的下标。 */
  lastIndex: number;
}

function encodeCursor(payload: ListCursorPayload | MessagesCursorPayload): string {
  return Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
}

function decodeCursorJson(cursor: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
  } catch {
    throw pluginHostError("E_INVALID_ARGUMENT", "非法分页游标");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw pluginHostError("E_INVALID_ARGUMENT", "非法分页游标");
  }
  return parsed as Record<string, unknown>;
}

function decodeListCursor(cursor: string): ListCursorPayload {
  const parsed = decodeCursorJson(cursor);
  if (parsed.v !== 1 || parsed.kind !== "list" || !Number.isInteger(parsed.offset) || (parsed.offset as number) < 0) {
    throw pluginHostError("E_INVALID_ARGUMENT", "非法会话列表游标");
  }
  return parsed as unknown as ListCursorPayload;
}

function decodeMessagesCursor(cursor: string): MessagesCursorPayload {
  const parsed = decodeCursorJson(cursor);
  const valid = parsed.v === 1
    && parsed.kind === "messages"
    && typeof parsed.conversationId === "string"
    && Number.isInteger(parsed.lastIndex)
    && (parsed.lastIndex as number) >= 0
    && (parsed.from === undefined || typeof parsed.from === "string")
    && (parsed.through === undefined || typeof parsed.through === "string");
  if (!valid) {
    throw pluginHostError("E_INVALID_ARGUMENT", "非法消息分页游标");
  }
  return parsed as unknown as MessagesCursorPayload;
}

function normalizeLimit(value: number | undefined, defaultValue: number, maxValue: number, label: string): number {
  if (value === undefined) return defaultValue;
  if (!Number.isInteger(value) || value < 1 || value > maxValue) {
    throw pluginHostError("E_INVALID_ARGUMENT", `非法${label}页大小: ${String(value)}（1-${maxValue}）`);
  }
  return value;
}

function toSummary(meta: ChatSessionMeta): PluginConversationSummary {
  return {
    id: meta.id,
    title: meta.title,
    mode: meta.mode,
    createdAt: new Date(meta.createdAt).toISOString(),
    updatedAt: new Date(meta.updatedAt).toISOString(),
  };
}

function toProjection(message: ChatMessage): PluginConversationMessage {
  return {
    id: message.id,
    role: message.role === "model" ? "assistant" : "user",
    text: message.content,
    at: new Date(message.at).toISOString(),
  };
}

/**
 * 只读会话服务。getMessages 的核心语义是冻结边界：首次调用把
 * fromMessageId / throughMessageId 冻结进游标，后续页重新验证边界
 * 消息仍存在，不会悄悄扩到最新消息，因此后续轮次的内容不会混入。
 */
export function createPluginConversationsService(
  options: PluginConversationsServiceOptions,
): PluginConversationsService {
  const { reader, signal } = options;

  function assertActive(): void {
    if (signal?.aborted) {
      throw pluginHostError("E_PLUGIN_STOPPING", "插件已停止，会话服务不可用");
    }
  }

  return {
    async list(input): Promise<PluginConversationPage> {
      assertActive();
      const limit = normalizeLimit(input?.limit, DEFAULT_LIST_LIMIT, MAX_LIST_LIMIT, "会话列表");
      let offset = 0;
      if (input?.cursor !== undefined) {
        offset = decodeListCursor(input.cursor).offset;
      }
      // 列表分页不承诺跨并发编辑的完整快照，按当前顺序切片即可。
      const sessions = (await reader.listSessions());
      const page: PluginConversationPage = {
        items: sessions.slice(offset, offset + limit).map(toSummary),
      };
      if (offset + limit < sessions.length) {
        page.nextCursor = encodeCursor({ v: 1, kind: "list", offset: offset + limit });
      }
      return page;
    },

    async getMessages(input: PluginMessagePageInput): Promise<PluginMessagePage> {
      assertActive();
      if (!input || typeof input.conversationId !== "string" || !input.conversationId) {
        throw pluginHostError("E_INVALID_ARGUMENT", `非法会话 id: ${String(input?.conversationId)}`);
      }
      const limit = normalizeLimit(input.limit, DEFAULT_MESSAGE_LIMIT, MAX_MESSAGE_LIMIT, "消息");

      let cursor: MessagesCursorPayload | undefined;
      if (input.cursor !== undefined) {
        cursor = decodeMessagesCursor(input.cursor);
        // 游标换会话或显式边界与冻结边界不一致时直接拒绝，
        // 不允许中途改变读取范围。
        if (cursor.conversationId !== input.conversationId) {
          throw pluginHostError("E_INVALID_ARGUMENT", "分页游标与请求的会话不一致");
        }
        if (input.fromMessageId !== undefined && input.fromMessageId !== cursor.from) {
          throw pluginHostError("E_INVALID_ARGUMENT", "fromMessageId 与分页游标冻结的起点不一致");
        }
        if (input.throughMessageId !== undefined && input.throughMessageId !== cursor.through) {
          throw pluginHostError("E_INVALID_ARGUMENT", "throughMessageId 与分页游标冻结的终点不一致");
        }
      }

      const from = cursor?.from ?? input.fromMessageId;
      const through = cursor?.through ?? input.throughMessageId;

      const session = (await reader.getSession(input.conversationId));
      if (!session) {
        throw pluginHostError("E_NOT_FOUND", `会话不存在: ${input.conversationId}`);
      }
      const messages = session.messages;

      let startIndex = 0;
      let endIndex = messages.length - 1;
      if (from !== undefined) {
        const idx = messages.findIndex((m) => m.id === from);
        // 边界消息被删除或替换时明确失败，不悄悄扩到最新消息。
        if (idx === -1) {
          throw pluginHostError("E_NOT_FOUND", `起点消息不存在于会话: ${from}`);
        }
        startIndex = idx;
      }
      if (through !== undefined) {
        const idx = messages.findIndex((m) => m.id === through);
        if (idx === -1) {
          throw pluginHostError("E_NOT_FOUND", `终点消息不存在于会话: ${through}`);
        }
        endIndex = idx;
      }
      if (startIndex > endIndex) {
        throw pluginHostError("E_INVALID_ARGUMENT", "起点消息在终点消息之后");
      }

      let lastIndex = -1;
      if (cursor && cursor.lastIndex >= messages.length) {
        throw pluginHostError("E_INVALID_ARGUMENT", "分页游标已失效");
      }
      if (cursor) {
        lastIndex = cursor.lastIndex;
      }

      const items: PluginConversationMessage[] = [];
      let nextCursor: string | undefined;
      // 只投影 user/assistant 两种角色；内部角色（将来可能引入）跳过但
      // 仍推进下标，保证下一页从正确位置继续。
      for (let i = Math.max(lastIndex + 1, startIndex); i <= endIndex; i++) {
        const message = messages[i];
        if (message.role !== "user" && message.role !== "model") continue;
        if (items.length === limit) {
          nextCursor = encodeCursor({
            v: 1,
            kind: "messages",
            conversationId: input.conversationId,
            from,
            through,
            lastIndex: i - 1,
          });
          break;
        }
        items.push(toProjection(message));
      }

      const page: PluginMessagePage = {
        items,
        nextCursor,
        range: {
          ...(from !== undefined ? { fromMessageId: from } : {}),
          ...(through !== undefined ? { throughMessageId: through } : {}),
        },
      };
      return page;
    },
  };
}
