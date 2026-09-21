// 聊天会话 IPC 桥接：把 chats-store 的纯数据 API 暴露给渲染进程。
//
// 写操作成功后会向渲染窗口广播 `chats:changed`，以便：
// - 设置中心 💬聊天面板刷新列表；
// - 聊天窗口在标题被改名等情况下同步显示。
//
// 来源隔离：渲染进程发起的写操作广播时会跳过发起方窗口（sender）--发起方已经
// 持有最新状态，不需要被自己的写唤醒；只让其它窗口（以及"外部主动消息提交"这种
// 主进程发起的写）触发的广播到达聊天窗口。这样聊天窗口的 onChanged 只会因真正的
// 外部变更触发，避免本窗口 saveSession() 的广播回来重载当前会话、清掉 transient
// 思考消息的竞态。
//
// 注意：`chats:open-in-chat-window` 涉及 BrowserWindow 创建逻辑，
// 由 src/main/index.ts 自行注册，不在本模块；本模块只管纯数据操作。

import { app, BrowserWindow, type WebContents, dialog, shell } from "electron";
import { randomUUID } from "crypto";
import { IPC } from "../../shared/ipc-channels";
import { createIpcScope, type IpcScope } from "../application/ipc-scope";
import type { ChatMessage, ConversationMode, ConversationWorkspaceBinding } from "../../shared/chat-types";
import * as chatsStore from "./chats-store";
import * as fs from "fs";
import * as path from "path";
import { ensureVaultStructure, isEmptyDirectory } from "../learn/obsidian/vault-init";
import { getDefaultModelProfile, loadModelSettings, resolveModelSettingsProfile } from "../settings/model-settings";
import { FileToolOutputStore } from "../orchestrator/harness/tool-output/file-tool-output-store";
import { getHarnessRunStore } from "../orchestrator/harness/run-store";
import { getConversationTranscriptStore } from "../orchestrator/conversation-transcript-store";
import { ConversationJournalService } from "../orchestrator/conversation-journal-service";
import { ConversationSessionMigration } from "../orchestrator/conversation-session-migration";
import { getRunReviewTracker } from "../orchestrator/review/run-review-tracker";
import { getAdapterForConfig } from "../orchestrator/vendors";
import { activeChatTargetRegistry } from "../plugin-host/active-chat-target";
import { callSummarizeModel } from "../orchestrator/context-manager";
import { buildContextUsageSnapshot } from "../orchestrator/context-usage";
import type { LlmClient } from "../services/llm/llm-client";
import { enqueueLLMTask } from "../llm-queue";
import {
  createConversationTitleService,
  type ConversationTitleService,
} from "./conversation-title-service";

function broadcastChanged(senderWebContents?: WebContents | null): void {
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

/** 主动压缩的模型窗口大小：与渲染层 ChatPage 每轮 run 的 slice(-16) 保持一致。 */
const COMPACT_MODEL_WINDOW = 16;
/** 主动压缩保留的最近消息条数（约 3 轮对话），其余窗口内消息摘要成一条记忆。 */
const COMPACT_KEEP_RECENT = 6;
/** 并发保护：同一会话压缩进行中时拒绝重复触发。 */
const compactingSessions = new Set<string>();

function visibleUserText(content: string): string {
  return content.replace(/\[sticker:[^\]]+\]/gi, "").trim();
}

export function registerChatsIpc(
  ipcOption?: IpcScope,
  options: {
    titleService?: ConversationTitleService;
    llmClient?: LlmClient;
    isPrimaryModelBusy?: () => boolean;
  } = {},
): void {
  const ipc = ipcOption ?? createIpcScope();
  const titleService = options.titleService ?? (options.llmClient
    ? createConversationTitleService({
        getSession: chatsStore.getSession,
        setGeneratedTitle: chatsStore.setGeneratedTitle,
        resolveSettings: (session) => resolveModelSettingsProfile(loadModelSettings(), session.modelProfileId),
        isPrimaryModelBusy: options.isPrimaryModelBusy,
        llmClient: options.llmClient,
        enqueueTask: enqueueLLMTask,
        onTitleChanged: () => broadcastChanged(),
      })
    : undefined);
  chatsStore.initialize();
  const transcriptStore = getConversationTranscriptStore(app.getPath("userData"));
  const conversationJournal = new ConversationJournalService(
    transcriptStore,
  );
  const sessionMigration = new ConversationSessionMigration({ journal: conversationJournal, store: transcriptStore });
  // 进程刚启动时没有任何存活运行：磁盘上遗留的插话标记都是陈旧的，清回普通队列
  chatsStore.clearStalePendingAdjustMarks();

  ipc.handle(
    IPC.CHATS_LIST,
    (_event, options?: { mode?: ConversationMode }) => chatsStore.listSessions(options),
  );

  ipc.handle(IPC.CHATS_GET, async (_event, id: string) => {
    if (!id) return null;
    const record = await sessionMigration.ensureConversationMigrated(id);
    if (!record) return null;
    const projection = await conversationJournal.readProjection(id);
    return chatsStore.composeSession(record, projection.messages);
  });
  ipc.handle(IPC.CHATS_GET_PAGE, async (_event, payload: { id: string; before?: number | null; limit?: number }) => {
    if (!payload?.id) return null;
    const record = await sessionMigration.ensureConversationMigrated(payload.id);
    if (!record) return null;
    const page = await conversationJournal.readProjectionPage(
      payload.id,
      payload.before ?? null,
      payload.limit ?? 80,
    );
    const composed = chatsStore.composeSession(record, page.messages);
    const { messages: _messages, ...session } = composed;
    return {
      session: { ...session, messageCount: page.messageCount },
      messages: page.messages,
      hasMore: page.hasMore,
    };
  });

  ipc.handle(
    IPC.CHATS_CREATE,
    (
      event,
      payload?: { title?: string; identityId?: string | null; mode?: ConversationMode },
    ) => {
      const session = chatsStore.createSession({
        title: payload?.title,
        identityId: payload?.identityId ?? null,
        mode: payload?.mode,
        modelProfileId: getDefaultModelProfile()?.id,
      });
      broadcastChanged(event.sender);
      return session;
    },
  );

  ipc.handle(
    IPC.CHATS_APPEND,
    (event, payload: { id: string; message: ChatMessage }) => {
      if (!payload || !payload.id || !payload.message) return null;
      const session = chatsStore.appendMessage(payload.id, payload.message);
      if (session) {
        broadcastChanged(event.sender);
        if (payload.message.role === "user") {
          titleService?.schedule({
            sessionId: payload.id,
            userMessageId: payload.message.id,
            text: visibleUserText(payload.message.content),
          });
        }
      }
      return session;
    },
  );

  ipc.handle(
    IPC.CHATS_UPSERT,
    (event, payload: { id: string; message: ChatMessage } | null | undefined) => {
      if (!payload?.id || !payload.message) return null;
      const session = chatsStore.upsertMessage(payload.id, payload.message);
      if (session) broadcastChanged(event.sender);
      return session;
    },
  );

  ipc.handle(
    IPC.CHATS_SET_MESSAGE_TTS_CACHE,
    (event, payload: { id: string; messageId: string; cacheKey: string; converterVersion: string }) => {
      if (!payload?.id || !payload.messageId || !payload.cacheKey || !payload.converterVersion) return null;
      const session = chatsStore.setMessageTtsCacheKey(
        payload.id,
        payload.messageId,
        payload.cacheKey,
        payload.converterVersion,
      );
      if (session) broadcastChanged(event.sender);
      return session;
    },
  );

  ipc.handle(
    IPC.CHATS_REPLACE_MESSAGES,
    (event, payload: { id: string; messages: ChatMessage[] }) => {
      if (!payload || !payload.id || !Array.isArray(payload.messages)) return null;
      const session = chatsStore.replaceMessages(payload.id, payload.messages);
      if (session) broadcastChanged(event.sender);
      return session;
    },
  );
  ipc.handle(
    IPC.CHATS_REPLACE_TAIL,
    (event, payload: { id: string; startIndex: number; messages: ChatMessage[] }) => {
      if (!payload?.id || !Array.isArray(payload.messages)) return null;
      const session = chatsStore.replaceMessagesTail(payload.id, payload.startIndex, payload.messages);
      if (session) broadcastChanged(event.sender);
      return session;
    },
  );

  // ── 主动压缩：上下文容量菜单小人点击触发 ──────────────
  // 口径与渲染层每轮 run 的 slice(-16) 模型窗口对齐：窗口外是纯 UI 历史
  // （不进模型上下文，原样保留）；窗口内保留最近 COMPACT_KEEP 条，其余
  // 摘要成一条记忆消息（与 Chat 模式循环内自动压缩同格式，下一轮 run
  // normalize 后作为 assistant 消息进入模型上下文）。
  ipc.handle(
    IPC.CHATS_COMPACT,
    async (_event, payload: { sessionId?: unknown }) => {
      const sessionId = payload && typeof payload === "object"
        ? (payload as { sessionId?: unknown }).sessionId
        : undefined;
      if (typeof sessionId !== "string" || !sessionId) {
        return { ok: false, error: "missing sessionId" };
      }
      if (compactingSessions.has(sessionId)) {
        return { ok: false, error: "正在压缩，请稍候" };
      }
      const session = chatsStore.getSession(sessionId);
      if (!session) return { ok: false, error: "会话不存在" };

      const windowMessages = session.messages.slice(-COMPACT_MODEL_WINDOW);
      const keepMessages = windowMessages.slice(-COMPACT_KEEP_RECENT);
      const oldMessages = windowMessages.slice(0, -COMPACT_KEEP_RECENT);
      if (oldMessages.length === 0) {
        return { ok: false, error: "对话还很短，不需要压缩" };
      }

      // UI 消息 → 模型消息（与 normalizeChatMessages 同口径：model→assistant，空内容丢弃）。
      const history = oldMessages
        .filter((message) => typeof message.content === "string" && message.content.trim())
        .map((message) => ({
          role: message.role === "user" ? ("user" as const) : ("assistant" as const),
          content: message.content,
        }));
      if (history.length === 0) {
        return { ok: false, error: "对话还很短，不需要压缩" };
      }

      compactingSessions.add(sessionId);
      try {
        const base = loadModelSettings();
        const settings = session.modelProfileId
          ? resolveModelSettingsProfile(base, session.modelProfileId)
          : base;
        if (!settings.baseUrl) {
          return { ok: false, error: "还没有填写 API URL，请先在设置里保存 API 配置。" };
        }
        const adapter = getAdapterForConfig({
          provider: settings.provider,
          baseUrl: settings.baseUrl,
          model: settings.model,
          apiKey: settings.apiKey,
          ...(settings.explicitTransport ? { explicitTransport: settings.explicitTransport } : {}),
          ...(settings.reasoning ? { reasoning: settings.reasoning } : {}),
        });

        // 摘要失败直接报错返回，绝不落库、不动原消息（历史安全优先）。
        const summary = await callSummarizeModel(history, adapter, settings);
        const summaryMessage: ChatMessage = {
          id: `compact-${randomUUID().slice(0, 8)}`,
          role: "model",
          content: `[此前对话已压缩为记忆摘要]\n${summary}`,
          at: Date.now(),
        };

        const head = session.messages.slice(0, session.messages.length - COMPACT_MODEL_WINDOW);
        const nextMessages = [...head, summaryMessage, ...keepMessages];
        const updated = chatsStore.replaceMessages(sessionId, nextMessages);
        if (!updated) return { ok: false, error: "会话不存在" };

        // 压缩成功后写 session 级上下文快照，环形图立即可见压缩效果
        // （known-issues 问题 3：手动压缩不产生 run，没有 preRequest 快照）。
        // 非 conversation 桶（systemPrompt/tools/skills 等）压缩前后不变，
        // 从最近一条消息级快照继承；conversation 桶按压缩后消息重算。
        const lastSnapshot = session.messages.filter((message) => message.contextUsage).pop()?.contextUsage;
        const compactModelMessages = nextMessages
          .filter((message) => typeof message.content === "string" && message.content.trim())
          .map((message) => ({
            role: message.role === "user" ? ("user" as const) : ("assistant" as const),
            content: message.content as string,
          }));
        const snapshot = buildContextUsageSnapshot({
          phase: "terminal",
          contextWindowTokens: lastSnapshot?.contextWindowTokens
            ?? settings.contextWindowTokens
            ?? 256000,
          personaContent: "",
          messages: compactModelMessages as never,
        });
        if (lastSnapshot) {
          snapshot.categories = snapshot.categories.map((category) => (
            category.key === "conversation" || category.key === "toolDefinitions"
              ? category
              : {
                  key: category.key,
                  tokens: lastSnapshot.categories.find((item) => item.key === category.key)?.tokens ?? 0,
                }
          ));
          snapshot.totalTokens = snapshot.categories.reduce((sum, category) => sum + category.tokens, 0);
        }
        chatsStore.setSessionContextUsage(sessionId, snapshot);

        // 压缩结果由主进程改写，发起窗口并不知情；必须广播给所有窗口
        // （含 sender）触发聊天窗口重载，不能走跳过 sender 的来源隔离。
        broadcastChanged();
        return { ok: true, before: session.messages.length, after: nextMessages.length };
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) };
      } finally {
        compactingSessions.delete(sessionId);
      }
    },
  );

  ipc.handle(
    IPC.CHATS_RENAME,
    (event, payload: { id: string; title: string }) => {
      if (!payload || !payload.id) return null;
      const session = chatsStore.renameSession(payload.id, payload.title ?? "");
      if (session) broadcastChanged(event.sender);
      return session;
    },
  );

  ipc.handle(IPC.CHATS_DELETE, async (event, id: string) => {
    if (!id) return false;
    const ok = chatsStore.deleteSession(id);
    if (ok) {
      // 删除当前活动目标会话时使语音输入租约目标失效（登记表内部判断是否命中）
      activeChatTargetRegistry.notifySessionDeleted(id);
      try {
        await new FileToolOutputStore(app.getPath("userData")).deleteConversation(id);
      } catch (error) {
        // 会话已经删除；结果存储清理失败不能把 UI 回滚成“删除失败”。
        console.error("[ChatsIpc] failed to delete persisted tool outputs", error);
      }
      try {
        getHarnessRunStore(app.getPath("userData")).deleteConversation(id);
      } catch (error) {
        console.error("[ChatsIpc] failed to delete persisted harness runs", error);
      }
      try {
        await getConversationTranscriptStore(app.getPath("userData")).deleteConversation(id);
      } catch (error) {
        // 会话已删除；权威轨迹清理失败只记日志，不得把 UI 回滚成"删除失败"
        console.error("[ChatsIpc] failed to delete conversation transcript", error);
      }
      broadcastChanged(event.sender);
    }
    return ok;
  });

  ipc.handle(IPC.CHATS_SET_PINNED, (event, payload: { id: string; pinned: boolean }) => {
    if (!payload || typeof payload.id !== "string") return null;
    const session = chatsStore.setSessionPinned(payload.id, Boolean(payload.pinned));
    if (session) broadcastChanged(event.sender);
    return session;
  });

  // ── 会话级待发队列：入队 / 读取 / 删除 ──────────────────
  // 入队成功才返回 ok:true 和权威队列；失败原因机器可读，渲染层据此保留草稿并提示。
  // 幂等命中（enqueued=false，同标识同内容重试）不广播：磁盘与队列均未变化。
  ipc.handle(
    IPC.CHATS_PENDING_ENQUEUE,
    (event, payload: { sessionId?: unknown; entry?: unknown }) => {
      const sessionId = typeof payload?.sessionId === "string" ? payload.sessionId : "";
      const entry = payload?.entry as chatsStore.PendingChatMessageInput | undefined;
      if (!sessionId || !entry || typeof entry !== "object") {
        return { ok: false, error: "invalid-payload" };
      }
      const result = chatsStore.enqueuePendingMessage(sessionId, entry);
      if (result.ok && result.enqueued) broadcastChanged(event.sender);
      return result;
    },
  );

  ipc.handle(IPC.CHATS_PENDING_LIST, (_event, sessionId: unknown) => {
    if (typeof sessionId !== "string" || !sessionId) return null;
    return chatsStore.getPendingMessages(sessionId);
  });

  // 删除按稳定标识处理竞争：条目恰好已被认领/移除时幂等成功（removed=false 不广播）。
  ipc.handle(
    IPC.CHATS_PENDING_REMOVE,
    (event, payload: { sessionId?: unknown; messageId?: unknown }) => {
      const sessionId = typeof payload?.sessionId === "string" ? payload.sessionId : "";
      const messageId = typeof payload?.messageId === "string" ? payload.messageId : "";
      if (!sessionId || !messageId) return { ok: false, error: "invalid-payload" };
      const result = chatsStore.removePendingMessage(sessionId, messageId);
      if (result.ok && result.removed) broadcastChanged(event.sender);
      return result;
    },
  );

  // 认领队首：单次会话文件写入完成待发条目 → 正式用户消息 + 派发状态。
  // 认领产生真实历史消息，广播刷新；队列空/认领冲突原样透传。
  ipc.handle(IPC.CHATS_PENDING_CLAIM, (event, sessionId: unknown) => {
    if (typeof sessionId !== "string" || !sessionId) {
      return { ok: false, error: "invalid-payload" };
    }
    const result = chatsStore.claimPendingMessage(sessionId);
    if (result.ok && result.claimed) {
      broadcastChanged(event.sender);
      titleService?.schedule({
        sessionId,
        userMessageId: result.userMessage.id,
        text: result.visibleContent,
      });
    }
    return result;
  });

  // 派发确认：run 被主进程接受后清除认领状态；纯簿记，不广播。
  ipc.handle(
    IPC.CHATS_PENDING_COMPLETE_DISPATCH,
    (event, payload: { sessionId?: unknown; messageId?: unknown }) => {
      const sessionId = typeof payload?.sessionId === "string" ? payload.sessionId : "";
      const messageId = typeof payload?.messageId === "string" ? payload.messageId : "";
      if (!sessionId || !messageId) return { ok: false, error: "invalid-payload" };
      return chatsStore.completePendingDispatch(sessionId, messageId);
    },
  );

  // 修改未认领条目文字：内容按页面现有解析规则产出（原文/展示文字/表情标记），
  // 条目标识、入队时间、顺序与附件保持不变。冲突与失败返回最新权威队列。
  ipc.handle(
    IPC.CHATS_PENDING_EDIT,
    (
      event,
      payload: {
        sessionId?: unknown;
        messageId?: unknown;
        rawContent?: unknown;
        visibleContent?: unknown;
        userSticker?: unknown;
      },
    ) => {
      const sessionId = typeof payload?.sessionId === "string" ? payload.sessionId : "";
      const messageId = typeof payload?.messageId === "string" ? payload.messageId : "";
      if (!sessionId || !messageId || typeof payload.rawContent !== "string") {
        return { ok: false, error: "invalid-payload" };
      }
      const result = chatsStore.editPendingMessage(sessionId, messageId, {
        rawContent: payload.rawContent,
        visibleContent: typeof payload.visibleContent === "string" ? payload.visibleContent : payload.rawContent,
        ...(typeof payload.userSticker === "string" ? { userSticker: payload.userSticker } : {}),
      });
      if (result.ok) broadcastChanged(event.sender);
      return result;
    },
  );

  ipc.handle(IPC.CHATS_SET_MODEL_PROFILE, (event, payload: { id: string; modelProfileId?: string }) => {
    if (!payload || typeof payload.id !== "string") return null;
    const session = chatsStore.setSessionModelProfile(payload.id, payload.modelProfileId);
    if (session) broadcastChanged(event.sender);
    return session;
  });

  ipc.handle(IPC.CHATS_OPEN_FOLDER, async () => {
    await chatsStore.openStorageFolder();
    return true;
  });

  ipc.handle(IPC.CHATS_OPEN_WORKSPACE, async (_event, workspaceRoot: unknown) => {
    if (typeof workspaceRoot !== "string" || !workspaceRoot.trim()) {
      return { ok: false, error: "missing workspaceRoot" };
    }
    try {
      const resolved = validateAndNormalizeWorkspace(workspaceRoot);
      const isBoundWorkspace = chatsStore.listSessions().some((session) =>
        session.workspaceRoot === resolved,
      );
      if (!isBoundWorkspace) {
        return { ok: false, error: "workspace is not bound to a conversation" };
      }
      const error = await shell.openPath(resolved);
      return error ? { ok: false, error } : { ok: true };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  });

  ipc.handle(
    IPC.CHATS_MIGRATE_LEGACY,
    (event, messages: ChatMessage[]) => {
      const session = chatsStore.migrateLegacyMessages(messages);
      if (session) broadcastChanged(event.sender);
      return session;
    },
  );

  // ── 对话工作区绑定 ──────────────────────────────────────

  ipc.handle(
    IPC.CHATS_SET_WORKSPACE,
    async (event, payload: { sessionId: string; workspaceRoot: string }) => {
      if (!payload?.sessionId || !payload?.workspaceRoot) {
        return { ok: false, error: "missing sessionId or workspaceRoot" };
      }
      const existing = chatsStore.getSession(payload.sessionId);
      if (!existing) return { ok: false, error: "session not found" };
      if (existing.mode !== "work" && existing.mode !== "code" && existing.mode !== "learn") {
        return { ok: false, error: `${existing.mode ?? "unknown"} mode does not support workspace binding` };
      }
      // 路径验证：目录存在 + realpath 解析
      try {
        const resolved = validateAndNormalizeWorkspace(payload.workspaceRoot);
        const binding: ConversationWorkspaceBinding = {
          workspaceRoot: resolved,
          displayName: path.basename(resolved),
          boundAt: Date.now(),
        };
        const session = chatsStore.setWorkspaceBinding(payload.sessionId, binding);
        if (!session) return { ok: false, error: "session not found" };
        console.log("[Workspace] 绑定成功:",
          "sessionId=" + payload.sessionId.slice(0, 8) + "...",
          "workspaceRoot=" + resolved,
        );
        // 广播工作区变更
        for (const win of BrowserWindow.getAllWindows()) {
          if (win.isDestroyed()) continue;
          try {
            win.webContents.send(IPC.CHATS_WORKSPACE_CHANGED, {
              sessionId: payload.sessionId,
              binding,
            });
          } catch { /* ignore */ }
        }
        // Learn 模式：检测目录是否为空，让 renderer 决定是否初始化结构
        const empty = existing.mode === "learn" ? await isEmptyDirectory(resolved) : false;
        return { ok: true, binding, isEmpty: empty };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return { ok: false, error: msg };
      }
    },
  );

  ipc.handle(
    IPC.CHATS_INIT_LEARN_WORKSPACE,
    async (_event, sessionId: string) => {
      if (!sessionId) return { ok: false, error: "missing sessionId" };
      const binding = chatsStore.getWorkspaceBinding(sessionId);
      if (!binding) return { ok: false, error: "no workspace binding" };
      const session = chatsStore.getSession(sessionId);
      if (!session || session.mode !== "learn") {
        return { ok: false, error: "session is not in learn mode" };
      }
      const result = await ensureVaultStructure(binding.workspaceRoot);
      if (result.error) return { ok: false, error: result.error };
      return { ok: true, created: result.created, skipped: result.skipped };
    },
  );

  ipc.handle(
    IPC.CHATS_GET_WORKSPACE,
    (_event, sessionId: string) => {
      if (!sessionId) return null;
      return chatsStore.getWorkspaceBinding(sessionId) ?? null;
    },
  );

  ipc.handle(
    IPC.CHATS_CLEAR_WORKSPACE,
    (event, sessionId: string) => {
      if (!sessionId) return { ok: false, error: "missing sessionId" };
      const session = chatsStore.clearWorkspaceBinding(sessionId);
      if (!session) return { ok: false, error: "session not found" };
      // 广播工作区变更
      for (const win of BrowserWindow.getAllWindows()) {
        if (win.isDestroyed()) continue;
        try {
          win.webContents.send(IPC.CHATS_WORKSPACE_CHANGED, {
            sessionId,
            binding: null,
          });
        } catch { /* ignore */ }
      }
      return { ok: true };
    },
  );

  ipc.handle(
    IPC.CHATS_PICK_WORKSPACE_FOLDER,
    async (event) => {
      const win = BrowserWindow.fromWebContents(event.sender);
      if (!win) return { ok: false, error: "no window" };
      const result = await dialog.showOpenDialog(win, {
        properties: ["openDirectory"],
        title: "选择工作区目录",
      });
      if (result.canceled || result.filePaths.length === 0) {
        return { ok: false, canceled: true };
      }
      const selected = result.filePaths[0];
      try {
        const resolved = validateAndNormalizeWorkspace(selected);
        return { ok: true, path: resolved, displayName: path.basename(resolved) };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return { ok: false, error: msg };
      }
    },
  );

  // ── Review 快照：获取指定 Run 的不可变文件变更审查数据 ──
  // 正常终止的 Run 已在 harness-adapter 主动 finalize；
  // 崩溃恢复（interrupted）的 Run 在此按 "halted" 状态补生成。
  // 仍在运行的 Run（status=running）不生成快照，避免拿到不完整的 diff。
  ipc.handle(IPC.REVIEW_GET, (_event, runId: string) => {
    if (!runId || typeof runId !== "string") return null;
    const tracker = getRunReviewTracker(app.getPath("userData"));
    // 先尝试直接加载（正常终止的 Run 已在 harness-adapter 主动 finalize）
    const existing = tracker.loadReview(runId);
    if (existing) return existing;
    // 检查 Run 状态：只有非 running 的 Run 才补生成快照
    const session = getHarnessRunStore(app.getPath("userData")).get(runId);
    if (!session || session.status === "running") return null;
    // 崩溃恢复（interrupted）或异常终止的 Run：按 halted 补生成
    return tracker.finalizeIfPending(runId, session.createdAt, "halted");
  });

  // ── Review 恢复：把本次 Run 修改过的文件回滚到运行前状态 ──
  // 以 journal + before/ 基线为准；二进制文件只存元数据，无法恢复，计入 skipped。
  // 单文件恢复失败不阻断其他文件（错误隔离），failed 非空时 ok=false。
  ipc.handle(IPC.REVIEW_RESTORE, (_event, runId: string) => {
    if (!runId || typeof runId !== "string") {
      return { ok: false, restored: 0, skipped: [], failed: [], error: "invalid runId" };
    }
    const tracker = getRunReviewTracker(app.getPath("userData"));
    try {
      const outcome = tracker.restoreRun(runId);
      return { ok: outcome.failed.length === 0, ...outcome };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { ok: false, restored: 0, skipped: [], failed: [], error: msg };
    }
  });
}

// ── 路径验证 ──────────────────────────────────────────────

/**
 * 验证并规范化工作区路径：
 * - 目录存在
 * - realpath 解析（消除 symlink/junction）
 * - Windows 路径标准化
 */
function validateAndNormalizeWorkspace(inputPath: string): string {
  // 1. 检查目录存在
  if (!fs.existsSync(inputPath)) {
    throw new Error(`目录不存在: ${inputPath}`);
  }
  const stat = fs.statSync(inputPath);
  if (!stat.isDirectory()) {
    throw new Error(`不是目录: ${inputPath}`);
  }
  // 2. realpath 解析（消除 symlink/junction）
  const resolved = fs.realpathSync(inputPath);
  // 3. Windows 路径标准化（正斜杠 → 反斜杠，统一大小写盘符）
  const normalized = path.resolve(resolved);
  return normalized;
}

// 给 main/index.ts 用的便捷 broadcast（删除当前活跃会话后由 index.ts 调一次；
// 主动消息提交 commitLocalProactiveMessage 也用它）。
// 这些都是主进程发起的写，没有 sender，广播给所有窗口（含聊天窗口）--对聊天窗口
// 而言属于"真正的外部变更"，应当触发重载。
export { broadcastChanged as broadcastChatsChanged };
