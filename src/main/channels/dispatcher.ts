// channels/dispatcher —— 入站消息处理核心。
//
// 设计原则：
//   - 不知道任何具体平台。平台信息只用于查找适配器、记录日志和生成会话标识。
//   - 统一编排限速、智能体执行、响应发送与上下文提交，具体能力由外部依赖提供。
//
// sessionId 生成规则：
//   `channel:<channel>:<sha256(channel:senderId).slice(0,16)>`
//   加 channel 前缀防止跨平台 ID 冲突；hash 截断 16 字符节约空间且日志脱敏。
//
// capability 降级：
//   把 OutgoingMessage 按目标渠道的 cap 翻译 —— image→text 描述 / card→markdown / sticker 跳过。
import type {
  IncomingMessage,
  OutgoingMessage,
} from "./types";
import { randomUUID } from "node:crypto";
import type { MaterializedTranscript } from "../orchestrator/conversation-transcript-projection";
import type { TranscriptSink } from "../orchestrator/transcript-sink";
import type { ChannelsSettings } from "./settings-store";
import { appendLog } from "./message-log";
import type { MobileMessageSegmentationMode } from "../../shared/preferences";
import { rememberProactiveChannelRecipient } from "./proactive-delivery";
import type { ChannelRateLimiter } from "./rate-limiter";
import type { KeyedQueue } from "./keyed-queue";
import type { ChannelDeliveryService } from "./delivery-service";
import type { OutgoingComposer } from "./outgoing-composer";
import {
  makeSessionId,
  formatChannelUserText,
  type ChannelContext,
  type DispatchContext,
  type ChannelConversationTarget,
  resolveChannelConversationTarget,
} from "./channel-context";

export {
  formatChannelUserText,
  lookupOriginalSender,
  makeSessionId,
} from "./channel-context";
export type {
  DispatchContext,
  ChannelConversationTarget,
} from "./channel-context";

const LOG = "[ChannelDispatcher]";

/** Task 11 只依赖 journal 的业务入口，不引入新的存储或 outbox。 */
export interface ChannelConversationJournal {
  appendUser(conversationId: string, input: {
    id?: string;
    turnId: string;
    text: string;
    at?: number;
    attachments?: Array<{ kind: "image" | "document"; name: string; filePath: string; mime?: string; caption?: string }>;
  }): Promise<{ id: string }>;
  appendPresentation(conversationId: string, messageId: string, patchRevision: number, patch: Record<string, unknown>): Promise<unknown>;
  buildModelContext(conversationId: string): Promise<MaterializedTranscript>;
  getChannelTurnState?(conversationId: string, input: {
    userTurnId: string;
    assistantTurnId: string;
  }): Promise<{
    userEntry: unknown;
    assistantEntry?: unknown;
    latestReceipt?: unknown;
  } | null>;
  createRunSink(input: { conversationId: string; runId: string; assistantTurnId: string }): TranscriptSink;
  appendDeliveryReceipt(conversationId: string, input: {
    assistantTurnId: string;
    channel: IncomingMessage["channel"];
    status: "delivered" | "failed";
    errorCode?: string;
    runId?: string;
    revision?: number;
  }): Promise<unknown>;
}

export interface ChannelAgentInput {
  sessionId: string;
  target: ChannelConversationTarget;
  modelContext: MaterializedTranscript;
  transcriptSink: TranscriptSink;
  userTurnId: string;
  assistantTurnId: string;
  /** 渠道轮次运行标识：由 dispatcher 生成，贯通 sink、runStore 与生命周期事件。 */
  runId: string;
}

/** Dispatcher 配置（依赖注入）。 */
export interface DispatcherDeps {
  /** 按外部会话和绑定桌面会话串行执行。 */
  readonly queue: KeyedQueue;
  /** 原子消费渠道和用户限速额度。 */
  readonly limiter: ChannelRateLimiter;
  /** 读取和提交渠道与绑定桌面会话上下文。 */
  readonly context: ChannelContext;
  /** Canonical journal; it is the sole model-history source. */
  readonly journal: ChannelConversationJournal;
  /** 根据渠道能力组装出站消息。 */
  readonly composer: OutgoingComposer;
  /** 统一渠道发送边界。 */
  readonly delivery: ChannelDeliveryService;
  /** 执行完整智能体调用。 */
  readonly buildAndRunAgent: (
    msg: IncomingMessage,
    inputOrSessionId: ChannelAgentInput,
  ) => Promise<{ text: string; sticker: string | null }>;
  /** 延迟读取渠道设置，避免应用就绪前访问加密存储。 */
  readonly loadSettings: () => ChannelsSettings;
  /** 读取与渠道发送有关的通用设置。 */
  readonly loadGeneralSettings: () => {
    mobileMessageSegmentation?: MobileMessageSegmentationMode;
  };
  /** 记录最近见到的外部聊天，供设置页列出可绑定的来源。 */
  readonly observeExternalChat?: (sessionId: string, msg: IncomingMessage) => void;
  /** 可选 — 桌面端镜像广播：bot 入站/出站消息通知给 chatWindow。 */
  readonly broadcastChat?: (event: {
    type: "bot:incoming" | "bot:outgoing";
    channel: string;
    senderId: string;
    senderName?: string;
    chatId: string;
    text: string;
    at: number;
  }) => void;
}

export class ChannelDispatcher {
  private settingsCache: ChannelsSettings | null = null;

  constructor(private readonly deps: DispatcherDeps) {}

  /** 首次处理消息时再读取设置，避免应用就绪前访问加密存储。 */
  private get settings(): ChannelsSettings {
    if (!this.settingsCache) {
      this.settingsCache = this.deps.loadSettings();
      this.deps.limiter.reconfigure({
        perUser: this.settingsCache.rateLimitPerUser,
        perChannel: this.settingsCache.rateLimitPerChannel,
      });
    }
    return this.settingsCache;
  }

  /** 重新加载设置，并按新配置清空和更新限速器。 */
  reloadSettings(): void {
    this.settingsCache = null;
    void this.settings;
  }

  /**
   * 处理一条入站消息。这是 manager 注入到 adapter.onMessage 的回调。
   *
   * 流程：计算会话标识 → 限速 → 加载历史滑窗 → 本条落历史 → 调用智能体 →
   * 组装并发送出站消息 → 确认成功后提交助手状态。
   * 返回的出站消息仅供调用方观测和测试，不要求适配器再次发送。
   */
  async handleIncoming(msg: IncomingMessage): Promise<OutgoingMessage | null> {
    const sessionId = makeSessionId(msg.channel, msg.chatId);
    // 读取设置会同步刷新限速器，必须发生在本轮额度消费之前。
    void this.settings;
    return this.deps.queue.run(`external:${sessionId}`, async () => {
      if (!this.deps.limiter.tryConsume(msg.channel, msg.senderId)) {
        console.warn(LOG, `限速: ${msg.channel}:${msg.senderId}`);
        return null;
      }

      try {
        this.deps.observeExternalChat?.(sessionId, msg);
      } catch (err) {
        console.warn(LOG, "observeExternalChat 失败（继续处理消息）:", err);
      }

      const context = this.deps.context.resolveDispatchContext(sessionId);
      const execute = () => this.processIncoming(msg, context);
      return context.boundConversationId
        ? this.deps.queue.run(`conversation:${context.boundConversationId}`, execute)
        : execute();
    });
  }

  private async processIncoming(
    msg: IncomingMessage,
    context: DispatchContext,
  ): Promise<OutgoingMessage | null> {
    return this.processIncomingCanonical(msg, context);
  }

  /**
   * Canonical CTA channel path. Target and all journal writes happen inside
   * the keyed queue; a binding change can therefore only affect the next turn.
   */
  private async processIncomingCanonical(
    msg: IncomingMessage,
    context: DispatchContext,
  ): Promise<OutgoingMessage | null> {
    const journal = this.deps.journal!;
    const target = resolveChannelConversationTarget(context);
    const turnId = makeChannelTurnId(msg, "user");
    const assistantTurnId = makeChannelTurnId(msg, "assistant");
    const runId = randomUUID();
    this.deps.context.recordIncomingSession(msg, context);
    rememberProactiveChannelRecipient(msg, context.sessionId);
    this.broadcastIncoming(msg);
    this.appendIncomingAuditLog(msg);

    const userEntry = await journal.appendUser(target.conversationId, {
      id: `channel:${turnId}`,
      turnId,
      text: formatChannelUserText(msg),
      at: msg.at.getTime(),
      attachments: toJournalAttachments(msg),
    });
    const existingTurn = await journal.getChannelTurnState?.(target.conversationId, {
      userTurnId: turnId,
      assistantTurnId,
    });
    if (existingTurn?.assistantEntry) {
      if (!existingTurn.latestReceipt) {
        try {
          await journal.appendDeliveryReceipt(target.conversationId, {
            assistantTurnId,
            channel: msg.channel,
            status: "failed",
            errorCode: "DELIVERY_UNCONFIRMED",
            runId,
            revision: 1,
          });
        } catch (error) {
          console.warn(LOG, "重放补写渠道未确认回执失败，保持 fail-safe:", error);
        }
      }
      return null;
    }
    await journal.appendPresentation(target.conversationId, userEntry.id, 1, {
      content: msg.text,
      channelSource: {
        channel: msg.channel,
        chatType: msg.chatType ?? "private",
        ...(msg.senderName ? { senderName: msg.senderName } : {}),
      },
    });
    const modelContext = await journal.buildModelContext(target.conversationId);
    const transcriptSink = journal.createRunSink({
      conversationId: target.conversationId,
      runId,
      assistantTurnId,
    });

    let result: { text: string; sticker: string | null };
    try {
      result = await this.deps.buildAndRunAgent(msg, {
        sessionId: context.sessionId,
        target,
        modelContext,
        transcriptSink,
        userTurnId: turnId,
        assistantTurnId,
        runId,
      });
    } catch (err) {
      this.logAgentFailure(msg, err);
      return null;
    }

    const prepared = await this.deps.composer.compose({
      incoming: msg,
      replyText: result.text,
      sticker: result.sticker,
      settings: {
        ttsEnabled: this.settings.ttsEnabled,
        stickerEnabled: this.settings.stickerEnabled,
      },
      mobileMessageSegmentation: this.deps.loadGeneralSettings().mobileMessageSegmentation,
    });
    try {
      // 先落盘保守状态：若进程在远端发送窗口崩溃，下一轮只能看到
      // 未确认，不得把 assistant 的持久化误当成已送达并盲重发。
      try {
        await journal.appendDeliveryReceipt(target.conversationId, {
          assistantTurnId,
          channel: msg.channel,
          status: "failed",
          errorCode: "DELIVERY_UNCONFIRMED",
          runId,
          revision: 1,
        });
      } catch (error) {
        console.warn(LOG, "写入渠道送达预回执失败，已禁止发送:", error);
        return null;
      }

      let deliveryResult: Awaited<ReturnType<ChannelDeliveryService["send"]>>;
      try {
        deliveryResult = await this.deps.delivery.send(prepared.message);
      } catch (error) {
        deliveryResult = {
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        };
      }
      if (!deliveryResult.ok) {
        try {
          await journal.appendDeliveryReceipt(target.conversationId, {
            assistantTurnId,
            channel: msg.channel,
            status: "failed",
            errorCode: deliveryResult.error,
            runId,
            revision: 2,
          });
        } catch (error) {
          console.warn(LOG, "写入渠道送达失败回执失败，保留未确认状态:", error);
        }
        this.logDeliveryFailure(msg, deliveryResult.error);
        return null;
      }

      const assistantEntryId = transcriptSink.getLastAssistantEntryId?.();
      if (assistantEntryId) {
        await journal.appendPresentation(target.conversationId, assistantEntryId, 1, {
          content: prepared.assistantText,
          channelSource: {
            channel: msg.channel,
            chatType: msg.chatType ?? "private",
            ...(msg.senderName ? { senderName: msg.senderName } : {}),
          },
          ...(result.sticker && prepared.message.parts.some((part) => part.kind === "sticker")
            ? { sticker: result.sticker } : {}),
        });
      }
      try {
        await journal.appendDeliveryReceipt(target.conversationId, {
          assistantTurnId,
          channel: msg.channel,
          status: "delivered",
          runId,
          revision: 2,
        });
      } catch (error) {
        // 预回执仍在盘中，保守地保留未确认状态；调用方不得据此自动重发。
        console.warn(LOG, "写入渠道送达成功回执失败，保留未确认状态:", error);
      }
      this.broadcastOutgoing(msg, prepared.assistantText);
      this.appendOutgoingAuditLog(msg, prepared.assistantText, prepared.message);
      return prepared.message;
    } finally {
      try {
        await this.deps.composer.cleanupTransientFiles(prepared.transientFiles);
      } catch (err) {
        console.warn(LOG, "清理出站临时文件失败:", err);
      }
    }
  }

  private broadcastIncoming(msg: IncomingMessage): void {
    if (!this.settings.mirrorToDesktop) return;
    try {
      this.deps.broadcastChat?.({ type: "bot:incoming", channel: msg.channel, senderId: msg.senderId, senderName: msg.senderName, chatId: msg.chatId, text: msg.text, at: msg.at.getTime() });
    } catch (err) { console.warn(LOG, "broadcastChat (incoming) 失败:", err); }
  }

  private broadcastOutgoing(msg: IncomingMessage, text: string): void {
    if (!this.settings.mirrorToDesktop) return;
    try {
      this.deps.broadcastChat?.({ type: "bot:outgoing", channel: msg.channel, senderId: msg.senderId, senderName: msg.senderName, chatId: msg.chatId, text, at: Date.now() });
    } catch (err) { console.warn(LOG, "broadcastChat (outgoing) 失败:", err); }
  }

  private appendIncomingAuditLog(msg: IncomingMessage): void {
    try { appendLog({ dir: "incoming", channel: msg.channel, senderId: msg.senderId, senderName: msg.senderName, chatId: msg.chatId, text: msg.text, hasAttachments: (msg.attachments?.length ?? 0) > 0 }); }
    catch (err) { console.warn(LOG, "appendLog (incoming) 失败:", err); }
  }

  private appendOutgoingAuditLog(msg: IncomingMessage, text: string, outgoing: OutgoingMessage): void {
    try { appendLog({ dir: "outgoing", channel: msg.channel, senderId: msg.senderId, senderName: msg.senderName, chatId: msg.chatId, text, hasAttachments: outgoing.parts.some((part) => part.kind === "audio") }); }
    catch (err) { console.warn(LOG, "appendLog (outgoing) 失败:", err); }
  }

  private logAgentFailure(msg: IncomingMessage, err: unknown): void {
    const error = err instanceof Error ? err.message : String(err);
    console.error(LOG, "agent 调用失败:", error);
    try { appendLog({ dir: "error", channel: msg.channel, senderId: msg.senderId, senderName: msg.senderName, chatId: msg.chatId, text: `[agent 调用失败] ${error}` }); }
    catch (logErr) { console.warn(LOG, "appendLog (error) 失败:", logErr); }
  }

  private logDeliveryFailure(msg: IncomingMessage, error: string): void {
    console.warn(LOG, `发送失败 [${msg.channel}]:`, error);
    try { appendLog({ dir: "error", channel: msg.channel, senderId: msg.senderId, senderName: msg.senderName, chatId: msg.chatId, text: `[发送失败] ${error}` }); }
    catch (logErr) { console.warn(LOG, "appendLog (delivery error) 失败:", logErr); }
  }
}

export function makeChannelTurnId(msg: IncomingMessage, role: "user" | "assistant"): string {
  // 回退源（时间+正文）可能含换行：多行/附件正文会生成非法 entry ID 被拒绝写入 journal，
  // 这里压成单行空格，保证任何适配器都能得到合法的 turn ID
  const source = (msg.messageId || `${msg.at.getTime()}:${msg.text}`).replace(/[\r\n]+/g, " ");
  return `${msg.channel}:${msg.chatId}:${source}:${role}`;
}

function toJournalAttachments(msg: IncomingMessage): Array<{ kind: "image" | "document"; name: string; filePath: string; mime?: string; caption?: string }> | undefined {
  const attachments = (msg.attachments ?? []).map((attachment, index) => ({
    kind: attachment.kind === "image" ? "image" as const : "document" as const,
    name: attachment.caption || attachment.filePath?.split(/[\\/]/).pop() || `${attachment.kind}-${index + 1}`,
    filePath: attachment.filePath || attachment.url || attachment.caption || attachment.kind,
    ...(attachment.mime ? { mime: attachment.mime } : {}),
    ...(attachment.caption ? { caption: attachment.caption } : {}),
  }));
  return attachments.length > 0 ? attachments : undefined;
}
