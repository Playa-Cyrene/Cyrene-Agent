import { app, BrowserWindow, type WebContents } from "electron";
import { IPC } from "../../shared/ipc-channels";
import type { ChatSession, ConversationMode } from "../../shared/chat-types";
import type { IpcScope } from "../application/ipc-scope";
import { ConversationJournalService } from "../orchestrator/conversation-journal-service";
import { ConversationSessionMigration } from "../orchestrator/conversation-session-migration";
import { getConversationTranscriptStore } from "../orchestrator/conversation-transcript-store";
import { getDefaultModelProfile, loadModelSettings, resolveSessionModelSettings } from "../settings/model-settings";
import * as chatsStore from "./chats-store";
import * as sidebarOrganizationStore from "./sidebar-organization-store";

/** 读出口覆盖：把会话的上下文容量刷新为「按当前模型配置解析」的值。
 *  快照里的 contextWindowTokens 是生成那一刻的口径（run 前 / 压缩时），
 *  切换模型或在设置页改窗口后就会过期，导致环形图分母停在旧值。
 *  这里返回新对象而不回写磁盘——它是派生字段（见 ChatSession.contextWindowTokens）。 */
export function withLiveContextWindow(session: ChatSession): ChatSession {
  const contextWindowTokens = resolveSessionModelSettings(loadModelSettings(), session).contextWindowTokens;
  return contextWindowTokens ? { ...session, contextWindowTokens } : session;
}

export function broadcastChanged(senderWebContents?: WebContents | null): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (win.isDestroyed()) continue;
    // 跳过发起方：渲染进程自己的写不需要广播回自己（来源隔离）。
    if (senderWebContents && win.webContents === senderWebContents) continue;
    try {
      win.webContents.send(IPC.CHATS_CHANGED);
    } catch {
      // 某些刚创建/未 ready 的窗口 send 可能抛错，忽略即可
    }
  }
}

export function registerChatSurfaceIpc(scope: IpcScope) {
  const withdrawalListeners = new Set<(sessionId: string, messageId: string) => void>();
  const transcriptStore = getConversationTranscriptStore(app.getPath("userData"));
  const conversationJournal = new ConversationJournalService({
    store: transcriptStore,
    pendingStore: chatsStore,
  });
  const sessionMigration = new ConversationSessionMigration({ journal: conversationJournal, store: transcriptStore });
  // 进程刚启动时没有任何存活运行：磁盘上遗留的插话标记都是陈旧的，清回普通队列
  const initialized = chatsStore.initialize().then(() => chatsStore.clearStalePendingAdjustMarks());
  // 撤回对账是启动异步边界；显式吸收错误，且 journal 失败时不删除 pending。
  const pendingWithdrawalReconciliation = initialized.then(() => conversationJournal.reconcilePendingWithdrawals())
    .catch((error) => {
      console.error("[ChatsIpc] pending withdrawal reconciliation failed", error);
    });

  // 页面资源和数据库迁移并行加载。任何首屏读写都在同一次初始化完成后执行。
  const ipc: Pick<IpcScope, "handle"> = {
    handle: (channel, listener) => scope.handle(channel, async (...args) => {
      await initialized;
      return listener(...args);
    }),
  };
  ipc.handle(
    IPC.CHATS_LIST,
    async (_event, options?: { mode?: ConversationMode }) => (await chatsStore.listSessions(options)),
  );

  ipc.handle(IPC.CHATS_SIDEBAR_ORGANIZATION_GET, () => sidebarOrganizationStore.getSnapshot());
  ipc.handle(IPC.CHATS_SIDEBAR_ORGANIZATION_APPLY, async (event, payload: { expectedRevision: number; draft: Parameters<typeof sidebarOrganizationStore.applyDraft>[1] }) => {
    const result = await sidebarOrganizationStore.applyDraft(payload?.expectedRevision, payload?.draft);
    if (result.ok) {
      for (const win of BrowserWindow.getAllWindows()) {
        if (win.isDestroyed() || win.webContents === event.sender) continue;
        try { win.webContents.send(IPC.CHATS_SIDEBAR_ORGANIZATION_CHANGED); } catch { /* window may be closing */ }
      }
    }
    return result;
  });

  ipc.handle(IPC.CHATS_GET, async (_event, id: string) => {
    if (!id) return null;
    const session = await sessionMigration.loadComposedSession(id);
    return session ? withLiveContextWindow(session) : null;
  });
  ipc.handle(IPC.CHATS_GET_PAGE, async (_event, payload: { id: string; before?: number | null; limit?: number }) => {
    if (!payload?.id) return null;
    return sessionMigration.loadComposedSessionPage(
      payload.id,
      payload.before ?? null,
      payload.limit ?? 80,
    );
  });

  ipc.handle(
    IPC.CHATS_CREATE,
    async (
      event,
      payload?: { title?: string; identityId?: string | null; mode?: ConversationMode },
    ) => {
      // Invariant B：新会话创建即快照默认档案的默认模型（对话自持起点）
      const defaultProfile = getDefaultModelProfile();
      const session = (await chatsStore.createSession({
        title: payload?.title,
        identityId: payload?.identityId ?? null,
        mode: payload?.mode,
        modelProfileId: defaultProfile?.id,
        model: defaultProfile?.model || undefined,
      }));
      broadcastChanged(event.sender);
      return session;
    },
  );

  // ── 会话级待发队列：入队 / 读取 / 删除 ──────────────────
  // 入队成功才返回 ok:true 和权威队列；失败原因机器可读，渲染层据此保留草稿并提示。
  // 幂等命中（enqueued=false，同标识同内容重试）不广播：磁盘与队列均未变化。
  ipc.handle(
    IPC.CHATS_PENDING_ENQUEUE,
    async (event, payload: { sessionId?: unknown; entry?: unknown }) => {
      const sessionId = typeof payload?.sessionId === "string" ? payload.sessionId : "";
      const entry = payload?.entry as chatsStore.PendingChatMessageInput | undefined;
      if (!sessionId || !entry || typeof entry !== "object") {
        return { ok: false, error: "invalid-payload" };
      }
      const result = (await chatsStore.enqueuePendingMessage(sessionId, entry));
      if (result.ok && result.enqueued) broadcastChanged(event.sender);
      return result;
    },
  );

  ipc.handle(IPC.CHATS_PENDING_LIST, async (_event, sessionId: unknown) => {
    if (typeof sessionId !== "string" || !sessionId) return null;
    return (await chatsStore.getPendingMessages(sessionId));
  });

  // 删除按稳定标识处理竞争：条目恰好已被认领/移除时幂等成功（removed=false 不广播）。
  ipc.handle(
    IPC.CHATS_PENDING_REMOVE,
    async (event, payload: { sessionId?: unknown; messageId?: unknown }) => {
      const sessionId = typeof payload?.sessionId === "string" ? payload.sessionId : "";
      const messageId = typeof payload?.messageId === "string" ? payload.messageId : "";
      if (!sessionId || !messageId) return { ok: false, error: "invalid-payload" };
      await pendingWithdrawalReconciliation;
      let result;
      try {
        result = await conversationJournal.withdrawPendingMessage(sessionId, messageId);
      } catch (error) {
        console.error("[ChatsIpc] pending withdrawal failed", { sessionId, messageId, error });
        return { ok: false, error: "write-failed" } as const;
      }
      if (result.ok && result.removed) {
        for (const notify of withdrawalListeners) notify(sessionId, messageId);
        broadcastChanged(event.sender);
      }
      return result;
    },
  );

  return { withdrawalListeners, initialized, transcriptStore, conversationJournal, sessionMigration, pendingWithdrawalReconciliation };
}
