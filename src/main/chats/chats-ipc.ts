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
import { IPC } from "../../shared/ipc-channels";
import { createIpcScope, type IpcScope } from "../application/ipc-scope";
import type { ChatMessage, ChatSession, ChatsSetSessionModelResult, ConversationMode, ConversationWorkspaceBinding } from "../../shared/chat-types";
import * as chatsStore from "./chats-store";
import * as sidebarOrganizationStore from "./sidebar-organization-store";
import { resolveSessionWorkspaceFile } from "./workspace-files-ipc";
import * as fs from "fs";
import * as path from "path";
import { ensureVaultStructure, isEmptyDirectory } from "../learn/obsidian/vault-init";
import {
  getDefaultModelProfile,
  listSavedModelProfiles,
  loadModelSettings,
  resolveSessionModelSettings,
} from "../settings/model-settings";
import { planSessionModelUpdate } from "../../shared/session-model";
import { FileToolOutputStore } from "../orchestrator/harness/tool-output/file-tool-output-store";
import { getHarnessRunStore } from "../orchestrator/harness/run-store";
import { getConversationTranscriptStore } from "../orchestrator/conversation-transcript-store";
import { ConversationJournalService } from "../orchestrator/conversation-journal-service";
import { ConversationSessionMigration } from "../orchestrator/conversation-session-migration";
import {
  ConversationTranscriptCompactor,
  createTranscriptCompactionRequiredError,
  TRANSCRIPT_COMPACTION_REQUIRED,
} from "../orchestrator/conversation-transcript-compactor";
import { buildContextUsageSnapshot } from "../orchestrator/context-usage";
import type { ContextUsageSnapshot } from "../../shared/context-usage";
import { getRunReviewTracker } from "../orchestrator/review/run-review-tracker";
import { activeChatTargetRegistry } from "../plugin-host/active-chat-target";
import { getTaskSessionStore } from "../tasks/task-session-store";
import { projectTaskTodoItems, projectTaskTranscriptMessages } from "../orchestrator/task-transcript-projection";
import { cancelSummaryMemorySession, releaseSummaryMemorySessionCancellation } from "../memory/summary-memory-scheduler";
import { cancelWikiMemorySession, getWikiMemoryStore, releaseWikiMemorySessionCancellation } from "../memory/wiki-memory-scheduler";
import { resolveSummaryMemoryPaths } from "../memory/summary-memory-paths";
import { deleteSummaryFile } from "../memory/summary-memory-store";
import { createGeneratedImageStore } from "./generated-image-store";
import type { LlmClient } from "../services/llm/llm-client";
import { enqueueLLMTask } from "../llm-queue";
import { assertValidPresentationPatch, type TranscriptPresentationPatch } from "../orchestrator/conversation-transcript-types";
import type { ChatMessage as VendorChatMessage } from "../orchestrator/vendors/types";
import {
  createConversationTitleService,
  type ConversationTitleService,
} from "./conversation-title-service";
import {
  loadGeneralSettings,
  recordRecentProject,
  saveGeneralSettings,
  MAX_RECENT_PROJECTS,
} from "../settings/settings-facade";

function latestContextUsage(session: ChatSession | null): ContextUsageSnapshot | undefined {
  return session?.messages.reduce<ContextUsageSnapshot | undefined>((latest, message) => {
    const usage = message.contextUsage;
    return usage && (!latest || usage.updatedAt > latest.updatedAt) ? usage : latest;
  }, session.currentContextUsage);
}

/** 压缩（手动/演示）后重算会话的 session 级 context usage 快照：
 *  消息侧按压缩后的 compaction 视图重算；persona、工具、技能三类与压缩无关，
 *  继承旧快照口径，避免环形图出现 systemPrompt 归零的跳变。 */
async function recordCompactionUsage(
  sessionId: string,
  compactedMessages: VendorChatMessage[],
  previous?: ContextUsageSnapshot,
): Promise<void> {
  previous ??= (await chatsStore.getSessionView(sessionId))?.currentContextUsage;
  const inheritable = new Map(
    (previous?.categories ?? [])
      .filter((category) => category.key === "systemPrompt" || category.key === "tools" || category.key === "skills")
      .map((category) => [category.key, category.tokens]),
  );
  const sessionRecord = (await chatsStore.getSessionView(sessionId));
  const contextWindowTokens = (sessionRecord
    ? resolveSessionModelSettings(loadModelSettings(), sessionRecord).contextWindowTokens
    : undefined) ?? 256000;
  const computed = buildContextUsageSnapshot({
    phase: "preRequest",
    contextWindowTokens,
    personaContent: "",
    messages: compactedMessages,
  });
  const categories = computed.categories.map((category) => {
    const tokens = inheritable.get(category.key);
    return tokens === undefined ? category : { ...category, tokens };
  });
  const usage: ContextUsageSnapshot = {
    ...computed,
    categories,
    totalTokens: categories.reduce((sum, category) => sum + category.tokens, 0),
  };
  (await chatsStore.setSessionContextUsage(sessionId, usage));
}

/** 读出口覆盖：把会话的上下文容量刷新为「按当前模型配置解析」的值。
 *  快照里的 contextWindowTokens 是生成那一刻的口径（run 前 / 压缩时），
 *  切换模型或在设置页改窗口后就会过期，导致环形图分母停在旧值。
 *  这里返回新对象而不回写磁盘——它是派生字段（见 ChatSession.contextWindowTokens）。 */
function withLiveContextWindow(session: ChatSession): ChatSession {
  const contextWindowTokens = resolveSessionModelSettings(loadModelSettings(), session).contextWindowTokens;
  return contextWindowTokens ? { ...session, contextWindowTokens } : session;
}

/** 冷启动回填：按会话最近更新顺序收集已绑定的工作区，去重后截断并落盘。
 *  只在 recentProjects 为空时执行一次；之后由 setWorkspace 绑定继续维护列表。 */
async function backfillRecentProjects(): Promise<string[]> {
  const projects: string[] = [];
  for (const session of (await chatsStore.listSessions())) {
    if (!session.workspaceRoot || projects.includes(session.workspaceRoot)) continue;
    projects.push(session.workspaceRoot);
    if (projects.length >= MAX_RECENT_PROJECTS) break;
  }
  if (projects.length > 0) {
    saveGeneralSettings({ recentProjects: projects });
  }
  return projects;
}

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

/** 广播上下文压缩阶段：run 开始前的自动压缩只在主进程发生，
 *  渲染端靠这条推送在消息流尾部显示「正在触发压缩」的呼吸提示。 */
export function broadcastCompactionPhase(sessionId: string, phase: "running" | "finished"): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (win.isDestroyed()) continue;
    try {
      win.webContents.send(IPC.CHATS_COMPACTION_PHASE, { sessionId, phase });
    } catch {
      // 窗口可能正在关闭，忽略
    }
  }
}

function visibleUserText(content: string): string {
  return content.replace(/\[sticker:[^\]]+\]/gi, "").trim();
}

export async function registerChatsIpc(
  ipcOption?: IpcScope,
  options: {
    titleService?: ConversationTitleService;
    llmClient?: LlmClient;
    isPrimaryModelBusy?: () => boolean;
    transcriptCompactor?: ConversationTranscriptCompactor;
  } = {},
): Promise<void> {
  const ipc = ipcOption ?? createIpcScope();
  const titleService = options.titleService ?? (options.llmClient
    ? createConversationTitleService({
      getSession: chatsStore.getSessionView,
      setGeneratedTitle: chatsStore.setGeneratedTitle,
        resolveSettings: (session) => resolveSessionModelSettings(loadModelSettings(), session),
        isPrimaryModelBusy: options.isPrimaryModelBusy,
        llmClient: options.llmClient,
        enqueueTask: enqueueLLMTask,
        onTitleChanged: () => broadcastChanged(),
      })
    : undefined);
  (await chatsStore.initialize());
  const transcriptStore = getConversationTranscriptStore(app.getPath("userData"));
  const conversationJournal = new ConversationJournalService({
    store: transcriptStore,
    pendingStore: chatsStore,
  });
  const transcriptCompactor = options.transcriptCompactor ?? new ConversationTranscriptCompactor({
    store: transcriptStore,
    runReader: getHarnessRunStore(app.getPath("userData")),
    summarize: async () => { throw new Error(TRANSCRIPT_COMPACTION_REQUIRED); },
  });
  const sessionMigration = new ConversationSessionMigration({ journal: conversationJournal, store: transcriptStore });
  // 进程刚启动时没有任何存活运行：磁盘上遗留的插话标记都是陈旧的，清回普通队列
  (await chatsStore.clearStalePendingAdjustMarks());
  // 撤回对账是启动异步边界；显式吸收错误，且 journal 失败时不删除 pending。
  const pendingWithdrawalReconciliation = conversationJournal.reconcilePendingWithdrawals()
    .catch((error) => {
      console.error("[ChatsIpc] pending withdrawal reconciliation failed", error);
    });

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
  ipc.handle(IPC.TASK_SESSION_GET, async (_event, payload: { taskId?: unknown; parentConversationId?: unknown }) => {
    if (typeof payload?.taskId !== "string" || typeof payload.parentConversationId !== "string") return null;
    const task = await getTaskSessionStore(app.getPath("userData")).get(payload.taskId);
    if (!task || task.parentConversationId !== payload.parentConversationId) return null;
    // 对话内容自增量子任务落库起以 SQLite transcript 为源（含 assistant.toolCalls 与 tool 消息，
    // 检查器的工具执行面板依赖它们）；旧任务没有条目，回退读迁移前的 messages 快照。
    const transcript = getConversationTranscriptStore(app.getPath("userData"));
    const snapshot = await transcript.read(task.id);
    if (snapshot.entries.length > 0) {
      task.messages = projectTaskTranscriptMessages(snapshot.entries);
      task.todoItems = projectTaskTodoItems(snapshot.entries);
    }
    return task;
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

  ipc.handle(
    IPC.CTA_PRESENTATION_CHECKPOINT,
    async (_event, payload: {
      sessionId?: unknown;
      messageId?: unknown;
      mutationKey?: unknown;
      patch?: unknown;
    }) => {
      if (
        typeof payload?.sessionId !== "string" || !payload.sessionId
        || typeof payload.messageId !== "string" || !payload.messageId
        || typeof payload.mutationKey !== "string" || !payload.mutationKey
      ) {
        return { ok: false as const, error: "invalid-payload" as const };
      }
      try {
        assertValidPresentationPatch(payload.patch);
        await conversationJournal.appendPresentationNext(
          payload.sessionId,
          payload.messageId,
          payload.mutationKey,
          payload.patch as TranscriptPresentationPatch,
        );
        return { ok: true as const };
      } catch (error) {
        const code = error instanceof Error ? error.message : "TRANSCRIPT_PRESENTATION_WRITE_FAILED";
        return {
          ok: false as const,
          error: code === "TRANSCRIPT_INVALID_PRESENTATION_PATCH" || code === "TRANSCRIPT_CORRUPT_ROW"
            ? "invalid-presentation-patch"
            : code,
        };
      }
    },
  );

  // Manual compaction is a transcript checkpoint operation; it never rewrites
  // the renderer-owned session.messages compatibility record.
  ipc.handle(IPC.CHATS_COMPACT, async (_event, payload: { sessionId?: unknown; retainTokens?: unknown }) => {
    if (typeof payload?.sessionId !== "string" || !payload.sessionId) {
      return { ok: false as const, error: "TRANSCRIPT_COMPACTION_REQUIRED" as const };
    }
    try {
      // 正常 run 的最新快照写在消息上；压缩前从组合会话取出，避免归档后丢失来源。
      const previousUsage = latestContextUsage(await sessionMigration.loadComposedSession(payload.sessionId));
      const result = await transcriptCompactor.compact({
        conversationId: payload.sessionId,
        trigger: "manual",
        ...(typeof payload.retainTokens === "number" && Number.isFinite(payload.retainTokens)
          ? { retainTokens: payload.retainTokens }
          : {}),
      });
      // 压缩只改变消息侧 token；三类无关项继承旧快照，见 recordCompactionUsage。
      await recordCompactionUsage(payload.sessionId, result.compactedMessages, previousUsage);
      // 压缩是主进程侧的 journal 变更：发起方渲染端没有任何本地乐观更新
      // （且压缩仅在会话空闲时可用，无 transient 思考消息竞态），必须连同发起方
      // 一起广播，聊天页重载投影后压缩分隔条与环形图快照立即生效。
      broadcastChanged();
      return { ok: true as const, ...result };
    } catch (error) {
      return {
        ok: false as const,
        error: error instanceof Error && error.message === TRANSCRIPT_COMPACTION_REQUIRED
          ? error.message
          : createTranscriptCompactionRequiredError(error).message,
      };
    }
  });

  // dev-only 压缩链路演示：新建独立「压缩演示」会话，写入含工具调用的假历史后
  // 走真实压缩检查点链路（摘要为本地假文本，零 token），用于在聊天页验证
  // 压缩分隔条、环形图快照与 rewind 失效行为；不注册进正式包。
  if (!app.isPackaged) {
    ipc.handle(IPC.CHATS_SEED_COMPACTION_DEMO, async () => {
      try {
        const session = (await chatsStore.createSession({ title: "压缩演示", identityId: null, mode: "chat" }));
        const conversationId = session.id;
        let at = 1;
        // 假历史：两轮带工具调用的任务对话（投影会把同一 turn 的
        // assistant/tool rounds 合并成一条 UI 消息）+ 一轮普通对话。
        await transcriptStore.append(conversationId, { id: "demo-u1", at: at++, kind: "user", turnId: "demo-1", revision: 1, payload: { text: "帮我把项目里所有 TODO 注释整理成清单" } });
        await transcriptStore.append(conversationId, { id: "demo-a1", at: at++, kind: "assistant", turnId: "demo-1-a", payload: { role: "assistant", content: "我先扫描一下源码目录。", toolCalls: [{ id: "demo-call-1", name: "shell", arguments: "{\"command\":\"grep -rn TODO src\"}" }] } });
        await transcriptStore.append(conversationId, { id: "demo-t1", at: at++, kind: "tool_result", payload: { assistantEntryId: "demo-a1", toolCallId: "demo-call-1", outcome: "success", message: { role: "tool", toolCallId: "demo-call-1", name: "shell", content: "src/main/index.ts:12: TODO 优化启动速度\nsrc/renderer/app.tsx:40: TODO 拆分路由\n...（共 17 条）" } } });
        await transcriptStore.append(conversationId, { id: "demo-a1b", at: at++, kind: "assistant", turnId: "demo-1-a", payload: { role: "assistant", content: "共找到 17 处 TODO，已按模块整理成清单。" } });
        await transcriptStore.append(conversationId, { id: "demo-u2", at: at++, kind: "user", turnId: "demo-2", revision: 1, payload: { text: "顺便统计一下测试覆盖率" } });
        await transcriptStore.append(conversationId, { id: "demo-a2", at: at++, kind: "assistant", turnId: "demo-2-a", payload: { role: "assistant", content: "好的，跑一下覆盖率脚本。", toolCalls: [{ id: "demo-call-2", name: "shell", arguments: "{\"command\":\"npm run test:coverage\"}" }] } });
        await transcriptStore.append(conversationId, { id: "demo-t2", at: at++, kind: "tool_result", payload: { assistantEntryId: "demo-a2", toolCallId: "demo-call-2", outcome: "success", message: { role: "tool", toolCallId: "demo-call-2", name: "shell", content: "Statements: 73.2% | Branches: 68.5% | Functions: 71.0% | Lines: 74.1%\n未覆盖集中在 plugin-host 与 channels 模块。" } } });
        await transcriptStore.append(conversationId, { id: "demo-a2b", at: at++, kind: "assistant", turnId: "demo-2-a", payload: { role: "assistant", content: "覆盖率 73.2%，未覆盖集中在 plugin-host 与 channels 模块。" } });
        await transcriptStore.append(conversationId, { id: "demo-u3", at: at++, kind: "user", turnId: "demo-3", revision: 1, payload: { text: "先记下来，晚点再看" } });
        await transcriptStore.append(conversationId, { id: "demo-a3", at: at++, kind: "assistant", turnId: "demo-3-a", payload: { role: "assistant", content: "好的，已记录。需要时随时叫我。" } });
        // 走真实压缩链路：trigger = automatic，摘要本地生成，保留最近一轮不压。
        const demoCompactor = new ConversationTranscriptCompactor({
          store: transcriptStore,
          summarize: async () => "演示摘要：用户要求整理项目里的 TODO 注释，工具扫描到 17 处并按模块汇总成清单；随后统计了测试覆盖率（73.2%，未覆盖集中在 plugin-host 与 channels）。此摘要由演示入口本地生成，未调用模型。",
        });
        const result = await demoCompactor.compact({ conversationId, trigger: "automatic", retainTokens: 80 });
        await recordCompactionUsage(conversationId, result.compactedMessages);
        // 压缩后的一轮新对话：用于观察「压旧留新」的分隔条位置。
        await transcriptStore.append(conversationId, { id: "demo-u4", at: at++, kind: "user", turnId: "demo-4", revision: 1, payload: { text: "现在把刚才的 TODO 清单按优先级排一下" } });
        await transcriptStore.append(conversationId, { id: "demo-a4", at: at++, kind: "assistant", turnId: "demo-4-a", payload: { role: "assistant", content: "好的，从压缩摘要里恢复清单并按优先级排序如下：……" } });
        broadcastChanged();
        return { ok: true as const, sessionId: conversationId };
      } catch (error) {
        return { ok: false as const, error: error instanceof Error ? error.message : String(error) };
      }
    });
  }

  ipc.handle(
    IPC.CHATS_RENAME,
    async (event, payload: { id: string; title: string }) => {
      if (!payload || !payload.id) return null;
      const session = (await chatsStore.renameSession(payload.id, payload.title ?? ""));
      if (session) broadcastChanged(event.sender);
      return session;
    },
  );

  ipc.handle(IPC.CHATS_DELETE, async (event, id: string) => {
    if (!id) return false;
    const sessionRecord = (await chatsStore.getSessionRecord(id));
    await cancelSummaryMemorySession(id);
    await cancelWikiMemorySession(id);
    const wikiStore = fs.existsSync(path.join(app.getPath("userData"), "memory", "wiki"))
      ? getWikiMemoryStore() : null;
    try {
      await wikiStore?.tombstoneConversation(id);
    } catch (error) {
      releaseSummaryMemorySessionCancellation(id);
      releaseWikiMemorySessionCancellation(id);
      console.error("[ChatsIpc] failed to tombstone wiki sources", error);
      return false;
    }
    let summaryMemoryTarget: { filePath: string; allowedRoot: string } | null = null;
    if (sessionRecord) {
      try {
        const paths = resolveSummaryMemoryPaths({ conversationId: id, userDataRoot: app.getPath("userData"), session: sessionRecord });
        const allowedRoot = paths.workspacePath
          ? sessionRecord.workspaceBinding!.workspaceRoot
          : app.getPath("userData");
        summaryMemoryTarget = { filePath: paths.sessionPath, allowedRoot };
      } catch (error) {
        console.warn("[ChatsIpc] failed to resolve session summary memory path:", id, error);
      }
    }
    let ok: boolean;
    try {
      ok = (await chatsStore.deleteSession(id));
      if (!ok) await wikiStore?.untombstoneConversation(id);
    } catch (error) {
      await wikiStore?.untombstoneConversation(id).catch((rollbackError) =>
        console.error("[ChatsIpc] failed to restore wiki sources after delete failure", rollbackError));
      throw error;
    } finally {
      releaseSummaryMemorySessionCancellation(id);
      releaseWikiMemorySessionCancellation(id);
    }
    if (ok) {
      try {
        await wikiStore?.reconcileConversationSources(id, []);
      } catch (error) {
        // The durable tombstone hides deleted sources until a later reconciliation.
        console.error("[ChatsIpc] failed to reconcile deleted wiki sources", error);
      }
      if (summaryMemoryTarget) {
        try {
          await deleteSummaryFile(summaryMemoryTarget.filePath, summaryMemoryTarget.allowedRoot);
        } catch (error) {
          console.warn("[ChatsIpc] failed to delete session summary memory:", id, error);
        }
      }
      // 删除当前活动目标会话时使语音输入租约目标失效（登记表内部判断是否命中）
      activeChatTargetRegistry.notifySessionDeleted(id);
      try {
        await new FileToolOutputStore(app.getPath("userData")).deleteConversation(id);
      } catch (error) {
        // 会话已经删除；结果存储清理失败不能把 UI 回滚成“删除失败”。
        console.error("[ChatsIpc] failed to delete persisted tool outputs", error);
      }
      try {
        await getHarnessRunStore(app.getPath("userData")).deleteConversation(id);
      } catch (error) {
        console.error("[ChatsIpc] failed to delete persisted harness runs", error);
      }
      try {
        await getConversationTranscriptStore(app.getPath("userData")).deleteConversation(id);
      } catch (error) {
        // 会话已删除；权威轨迹清理失败只记日志，不得把 UI 回滚成"删除失败"
        console.error("[ChatsIpc] failed to delete conversation transcript", error);
      }
      try {
        await createGeneratedImageStore({
          rootDirectory: path.join(app.getPath("userData"), "chat-media", "generated-images"),
        }).deleteConversation(id);
      } catch (error) {
        console.error("[ChatsIpc] failed to delete generated images", error);
      }
      broadcastChanged(event.sender);
    }
    return ok;
  });

  ipc.handle(IPC.CHATS_SET_PINNED, async (event, payload: { id: string; pinned: boolean }) => {
    if (!payload || typeof payload.id !== "string") return null;
    const session = (await chatsStore.setSessionPinned(payload.id, Boolean(payload.pinned)));
    if (session) broadcastChanged(event.sender);
    return session;
  });

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
      if (result.ok && result.removed) broadcastChanged(event.sender);
      return result;
    },
  );

  // 认领队首：单次会话文件写入完成待发条目 → 正式用户消息 + 派发状态。
  // 认领产生真实历史消息，广播刷新；队列空/认领冲突原样透传。
  ipc.handle(IPC.CHATS_PENDING_CLAIM, async (event, sessionId: unknown) => {
    if (typeof sessionId !== "string" || !sessionId) {
      return { ok: false, error: "invalid-payload" };
    }
    await pendingWithdrawalReconciliation;
    const result = await sessionMigration.claimPendingMessage(sessionId);
    if (result.ok && result.claimed) {
      broadcastChanged(event.sender);
      await titleService?.schedule({
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
    async (event, payload: { sessionId?: unknown; messageId?: unknown }) => {
      const sessionId = typeof payload?.sessionId === "string" ? payload.sessionId : "";
      const messageId = typeof payload?.messageId === "string" ? payload.messageId : "";
      if (!sessionId || !messageId) return { ok: false, error: "invalid-payload" };
      return (await chatsStore.completePendingDispatch(sessionId, messageId));
    },
  );

  // 修改未认领条目文字：内容按页面现有解析规则产出（原文/展示文字/表情标记），
  // 条目标识、入队时间、顺序与附件保持不变。冲突与失败返回最新权威队列。
  ipc.handle(
    IPC.CHATS_PENDING_EDIT,
    async (
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
      await pendingWithdrawalReconciliation;
      const result = (await chatsStore.editPendingMessage(sessionId, messageId, {
        rawContent: payload.rawContent,
        visibleContent: typeof payload.visibleContent === "string" ? payload.visibleContent : payload.rawContent,
        ...(typeof payload.userSticker === "string" ? { userSticker: payload.userSticker } : {}),
      }));
      if (result.ok) broadcastChanged(event.sender);
      return result;
    },
  );

  // 切档案 = 原子状态转换（Invariant B）：绑定 + 模型重置为新档案默认，串行提交（Invariant D）。
  // 新档案默认模型在提交时刻解析（不依赖 handler 同步执行的实现细节）。
  ipc.handle(IPC.CHATS_SET_MODEL_PROFILE, async (event, payload: { id: string; modelProfileId?: string }) => {
    if (!payload || typeof payload.id !== "string") return null;
    const session = await chatsStore.enqueueSessionModelMutation(payload.id, async () => {
      const settings = loadModelSettings();
      const target = payload.modelProfileId
        ? listSavedModelProfiles(settings).find((profile) => profile.id === payload.modelProfileId)
        : getDefaultModelProfile(settings);
      return (await chatsStore.setSessionModelProfile(payload.id, payload.modelProfileId, target?.model || undefined));
    });
    if (session) broadcastChanged(event.sender);
    // 返回值带实时容量：发起方窗口不回读 CHATS_GET（来源隔离跳过了自己），
    // 靠这个派生字段就能把环形图分母换成新模型的窗口。
    return session ? withLiveContextWindow(session) : session;
  });

  // 会话级当前模型窄 IPC：只写会话（绑定 + 模型），不碰档案。
  // validator 唯一规则 = selectableModels 成员校验（不留 free-form 旁门，决策 P0-2）；
  // stale binding 时用户主动选择 = 确认接受回退档案，原子修复绑定（决策 13）。
  ipc.handle(IPC.CHATS_SET_SESSION_MODEL, async (event, payload: { id?: unknown; model?: unknown }) => {
    const sessionId = typeof payload?.id === "string" ? payload.id : "";
    const model = typeof payload?.model === "string" ? payload.model.trim() : "";
    if (!sessionId || !model) return { ok: false as const, error: "invalid-payload" as const };
    const result = await chatsStore.enqueueSessionModelMutation(sessionId, async (): Promise<ChatsSetSessionModelResult> => {
      const record = (await chatsStore.getSessionRecord(sessionId));
      if (!record) return { ok: false as const, error: "session-not-found" as const };
      const plan = planSessionModelUpdate(loadModelSettings(), record, model);
      if (!plan.ok) return { ok: false as const, error: plan.error };
      const session = (await chatsStore.setSessionModel(sessionId, plan.modelProfileId, plan.model));
      if (!session) return { ok: false as const, error: "session-not-found" as const };
      return { ok: true as const, session: withLiveContextWindow(session) };
    });
    if (result.ok) broadcastChanged(event.sender);
    return result;
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
      const isBoundWorkspace = (await chatsStore.listSessions()).some((session) =>
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

  // FileChangeCard 右键菜单：用本机默认方式打开 / 在资源管理器中定位工作区内的文件。
  // 路径解析复用 workspace-files 的安全校验（realpath 防 symlink 越界）；
  // 已删除文件解析为 NOT_FOUND 属预期，渲染层静默即可。
  ipc.handle(
    IPC.CHATS_SHELL_FILE,
    async (_event, payload: { sessionId?: unknown; relPath?: unknown; action?: unknown }) => {
      const sessionId = typeof payload?.sessionId === "string" ? payload.sessionId : "";
      const relPath = typeof payload?.relPath === "string" ? payload.relPath : "";
      const action = payload?.action === "reveal" ? "reveal" : payload?.action === "open" ? "open" : null;
      if (!sessionId || !relPath || !action) {
        return { ok: false as const, error: "invalid-payload" as const };
      }
      // 绝对路径（正文文件链接可能指向工作区外，如桌面的 cmd 脚本）：
      // 只做 realpath 存在性归一，不做工作区边界限制；相对路径走会话工作区校验
      let absPath: string;
      if (path.isAbsolute(relPath)) {
        try {
          absPath = await fs.promises.realpath(relPath);
        } catch {
          return { ok: false as const, error: "NOT_FOUND" as const };
        }
      } else {
        const resolved = await resolveSessionWorkspaceFile(sessionId, relPath);
        if (!resolved.ok) return { ok: false as const, error: resolved.code };
        absPath = resolved.absPath;
      }
      if (action === "reveal") {
        shell.showItemInFolder(absPath);
        return { ok: true as const };
      }
      const error = await shell.openPath(absPath);
      return error ? { ok: false as const, error } : { ok: true as const };
    },
  );

  ipc.handle(
    IPC.CHATS_MIGRATE_LEGACY,
    async (event, messages: ChatMessage[]) => {
      const session = (await chatsStore.migrateLegacyMessages(messages));
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
      // v1/v2 双兼容读取：会话一旦被组合读取（CHATS_GET）迁移成 v2 落盘，
      // 只认 v1 的 getSession 会把它误判成 "session not found"
      const existing = (await chatsStore.getSessionRecord(payload.sessionId));
      if (!existing) {
        console.warn(
          "[Workspace] 绑定失败：会话不存在 sessionId=" + String(payload.sessionId).slice(0, 8) + "...",
          "workspaceRoot=" + payload.workspaceRoot,
        );
        return { ok: false, error: "session not found" };
      }
      if (existing.mode !== "work" && existing.mode !== "code" && existing.mode !== "learn") {
        console.warn(
          "[Workspace] 绑定失败：模式不支持 workspace sessionId=" + String(payload.sessionId).slice(0, 8) + "...",
          "mode=" + String(existing.mode),
        );
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
        const session = (await chatsStore.setWorkspaceBinding(payload.sessionId, binding));
        if (!session) return { ok: false, error: "session not found" };
        // 绑定成功即记入最近项目列表，供工作文件夹下拉复选
        recordRecentProject(resolved);
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
      const binding = (await chatsStore.getWorkspaceBinding(sessionId));
      if (!binding) return { ok: false, error: "no workspace binding" };
      // 同 CHATS_SET_WORKSPACE：用 v1/v2 双兼容读取，v2 会话不得误判
      const session = (await chatsStore.getSessionRecord(sessionId));
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
    async (_event, sessionId: string) => {
      if (!sessionId) return null;
      return (await chatsStore.getWorkspaceBinding(sessionId)) ?? null;
    },
  );

  ipc.handle(
    IPC.CHATS_CLEAR_WORKSPACE,
    async (event, sessionId: string) => {
      if (!sessionId) return { ok: false, error: "missing sessionId" };
      const session = (await chatsStore.clearWorkspaceBinding(sessionId));
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

  // 最近绑定的项目文件夹：工作文件夹下拉的候选列表，只返回仍存在的目录
  ipc.handle(IPC.CHATS_RECENT_PROJECTS, async () => {
    const stored = loadGeneralSettings().recentProjects;
    const listed = stored.length > 0
      ? stored
      // 列表为空说明是升级后的首次使用，用存量会话绑过的工作区回填
      : await backfillRecentProjects();
    return listed.filter((dir) => fs.existsSync(dir));
  });

  // 验证工作区目录当前是否可用：最近项目下拉快照可能过期（选中前目录被移走），
  // 旧会话继承的工作区也不经过 recentProjects 过滤，选择入口落地前用这里把好关
  ipc.handle(IPC.CHATS_VALIDATE_WORKSPACE, (_event, workspaceRoot: string) => {
    if (!workspaceRoot || typeof workspaceRoot !== "string") {
      return { ok: false, error: "missing workspaceRoot" };
    }
    try {
      const resolved = validateAndNormalizeWorkspace(workspaceRoot);
      return { ok: true, path: resolved };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  });

  // ── Review 快照：获取指定 Run 的不可变文件变更审查数据 ──
  // 正常终止的 Run 已在 harness-adapter 主动 finalize；
  // 崩溃恢复（interrupted）的 Run 在此按 "halted" 状态补生成。
  // 仍在运行的 Run（status=running）不生成快照，避免拿到不完整的 diff。
  ipc.handle(IPC.REVIEW_GET, async (_event, runId: string) => {
    if (!runId || typeof runId !== "string") return null;
    const tracker = getRunReviewTracker(app.getPath("userData"));
    // 先尝试直接加载（正常终止的 Run 已在 harness-adapter 主动 finalize）
    const existing = tracker.loadReview(runId);
    if (existing) return existing;
    // 检查 Run 状态：只有非 running 的 Run 才补生成快照
    const runStore = getHarnessRunStore(app.getPath("userData"));
    await runStore.refresh();
    const session = runStore.get(runId);
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
