import { afterStartup } from "./ipc-scope";
import { setImmediate as yieldToEventLoop } from "node:timers/promises";
import type { registerChatSurfaceIpc } from "../chats/chat-surface-ipc";
import { disposeAllShellJobs } from "../orchestrator/tools/builtin-tools/shell-job-manager";
/**
 * 默认应用依赖装配（真正的组合根胶水层）：
 * 持有全部业务子系统的导入与工厂闭包，把它们按窄依赖喂给各启动阶段。
 * 首屏恢复后由 startup-dependencies 加载本模块。
 *
 * 本文件内的闭包只做构造与委托；任何长期任务都必须由对应启动阶段显式启动。
 */

import { app, BrowserWindow, screen, session } from "electron";
import http from "node:http";
import * as fs from "fs";
import * as path from "path";
import { autoUpdater } from "electron-updater";

import { getExternalContentPaths } from "../external-content-paths";
import { migrateStagedExternalContent } from "../external-content-migration";
import { logger, LogTag } from "../logger";
import { IPC } from "../../shared/ipc-channels";
import {
  loadGeneralSettings,
  saveGeneralSettings,
  onGeneralSettingsChanged,
} from "../settings/settings-facade";
import { markStartupPhaseReady, reactChatWindow } from "../windows/window-state";
import { loadModelSettings, saveModelSettings } from "../settings/model-settings";
import { getConversationTranscriptStore } from "../orchestrator/conversation-transcript-store";
import { getHarnessRunStore } from "../orchestrator/harness/run-store";
import { createModelBackedConversationTranscriptCompactor } from "../orchestrator/conversation-transcript-compactor";
import { ConversationJournalService } from "../orchestrator/conversation-journal-service";
import { activeConversationRegistry } from "../chats/active-conversation-registry";
import { registerSettingsIpc } from "../settings/settings-ipc";
import { registerNewsIpc } from "../news/news-feed";
import {
  applyGeneralSettings,
  handleGeneralSettingsChanged,
  syncVolcanoSearchMcp,
} from "../settings/general-settings-lifecycle";
import { registerMemoryUserToolIpc } from "../memory/memory-user-ipc";
import { registerWikiMemoryIpc } from "../memory/wiki-memory-ipc";
import { registerKnowledgeBaseIpc } from "../knowledge-base/knowledge-base-ipc";
import { initializeKnowledgeBase } from "../knowledge-base/knowledge-base-service";
import { createLlmClient } from "../services/llm/llm-client";
import { createTtsSynthesisService } from "../services/tts/tts-synthesis-service";
import { momentsService } from "../moments/moments-service";
import {
  addL2MemoryVector,
  deleteUserMemoryVectors,
  flushRAGStore,
  flushRAGStoreSync,
  getEntriesBySource,
  initWorldbook,
  initVectorMemory,
  disposeVectorMemory,
  isUserMemoryVectorStoreReady,
} from "../rag";
import { isMemoryEnabled, isSummaryMemoryEnabled, setMemoryMode, type MemoryMode } from "../memory/memory-mode";
import { initializeSummaryMemoryScheduler, enableSummaryMemoryScheduler, flushAllSummaryMemory, scheduleSummaryTurn } from "../memory/summary-memory-scheduler";
import { createConversationSessionMigration } from "../orchestrator/conversation-session-migration";
import { createWikiChatSourceReader } from "../memory/wiki-source";
import { initializeWikiMemoryScheduler, enableWikiMemoryScheduler, scheduleWikiTurn } from "../memory/wiki-memory-scheduler";
import { loadSummaryMemoryContext } from "../memory/summary-memory-context";
import { clearLegacyStickerEmbeddingCache, loadStickerTextIndex } from "../sticker-text-matcher";
import { toolRegistry } from "../orchestrator/tools/registry/tool-registry";
import { pluginPromptRegistry } from "../../plugins/prompts";
import type { PluginManager } from "../../plugins/manager";
import { LspManager } from "../lsp/manager";
import { initSandbox } from "../orchestrator/sandbox/sandbox-exec";
import {
  encodePlanSessionKey,
  enterPlanDiscussing,
  exitPlanMode,
  getPlanState,
  initPlanPaths,
  initPlanStateBroadcaster,
  initPlanStatePersister,
  restorePlanSession,
  type PlanStateSnapshot,
} from "../orchestrator/plan-mode";
import { restoreMcpServer, listMcpServerConfigs, pruneMcpServersByIds } from "../orchestrator/mcp-manager";
import { syncPlaywrightMcp, syncFilesystemMcp, PLAYWRIGHT_MCP_ID, FILESYSTEM_MCP_ID, REMOVED_BUILTIN_MCP_IDS } from "../sync-mcp-builtin";
import { registerAppUpdateIpc } from "../updater/app-update-ipc";
import { createGitHubAppUpdateService, scheduleStartupUpdateCheck } from "../updater/github-app-updater";
import { enqueueLLMTask } from "../llm-queue";
import { memoryStore } from "../memory/memory-store";
import { backupMemoryRagFiles, reconcileMemoryRag } from "../memory/memory-rag-reconciliation";
import { initReranker, resetReranker } from "../rag/reranker";
import { broadcastCompactionPhase, registerChatsIpc } from "../chats/chats-ipc";
import { registerWorkspaceFilesIpc } from "../chats/workspace-files-ipc";
import { registerOpenInAppIpc } from "../chats/open-in-app";
import { registerBrowserPanelIpc } from "../browser/browser-panel-ipc";
import { registerMomentsIpc } from "../moments/moments-ipc";
import { registerChatUiIpc, getActiveChatSessionId } from "../chats/chat-ui-ipc";
import { createToastWindowController } from "../toast/toast-window";
import { createToastService } from "../toast/toast-service";
import { toastEvents } from "../toast/toast-events";
import { createToastWindowShell } from "../windows/create-toast-window";
import * as chatsStore from "../chats/chats-store";
import { TtsSessionService } from "../tts/tts-session-service";
import { registerTtsIpc } from "../tts/tts-ipc";
import { loadUserProfile } from "../settings-store";
import { updateLocaleContext } from "../locale-context";
import { registerCallIpc } from "../call/call-manager";
import { initSkills, skillRegistry } from "../skills";
import { createSchedulerSubsystem } from "../scheduler/bootstrap";
import { createChannelsSubsystem } from "../channels/bootstrap";
import { createLifecyclePublisher } from "../plugin-host/lifecycle-publisher";
import { createPendingTurnLifecycle } from "../plugin-host/pending-turn-lifecycle";
import { createPluginRuntime } from "../plugin-runtime";
import { createAgentRuntime } from "../orchestrator/agent-runtime";
import { reconcileCrashedInterruptions } from "../orchestrator/conversation-interruption-reconciliation";
import { createRuntimeStateService } from "../orchestrator/runtime-state-service";
import { createTranscriptCompactorGetter } from "./transcript-compaction-wiring";
import { createProactiveLifecycle } from "../proactive/proactive-lifecycle";
import { createCitaService } from "../services/cita/cita-service";
import { createSocialContextService } from "../services/social-context/social-context-service";
import { createGitService } from "../code-git/git-service";
import { resolveGitExecutable, type ResolvedGitExecutable } from "../code-git/git-executable";
import { registerCodeGitIpc } from "../code-git/code-git-ipc";
import { bootstrapMusicService } from "../music/bootstrap";
import { resolveMusicPaths } from "../music/paths";
import { initializeScreenshotService } from "../screenshot/screenshot-lifecycle";
import { bootstrapConfigGetters } from "../startup/bootstrap-config";
import { bootstrapPermission } from "../permission/bootstrap";
import { registerPopQuizIpc, registerPopQuizTool } from "../orchestrator/pop-quiz";
import { createExamPaperStore } from "../learn/exam-paper-store";
import { createExamDraftStore } from "../learn/exam-draft";
import { registerExamPaperIpc } from "../learn/exam-paper-ipc";
import { registerLearnExamPageIpc } from "../learn/exam-page-ipc";
import { registerLearnExamTools } from "../orchestrator/learn-exam-tools";
import { GmailAuthService } from "../email/gmail-auth-service";
import { GmailService } from "../email/gmail-service";
import { registerGmailIpc } from "../email/gmail-ipc";
import { MailAttachmentStore } from "../email/mail-attachment-store";

import { configureNodeRequestProxy } from "../network/node-request-proxy";
import { startCore } from "./core-bootstrap";
import { startBackground } from "./background";
import { installUpdateShutdownFallback, type UpdateLifecycleLike } from "./electron-lifecycle";
import type { ConversationMode } from "../../shared/chat-types";
import { shouldExposeSearchTool } from "../orchestrator/search-backend-filter";
import { checkStartupActive } from "./startup-cancellation";
import type { ApplicationDependencies } from "./application";

function broadcastToAuxWindows(channel: string, payload: unknown): void {
  const win = reactChatWindow;
  if (win && !win.isDestroyed()) {
    win.webContents.send(channel, payload);
  }
}

/** 让 Node 自带的 fetch / http(s) 也走代理（见 network/node-request-proxy.ts）；失败只记日志，不阻断启动。 */
function configureProxyForNodeRequests(): Promise<void> {
  return configureNodeRequestProxy({
    env: process.env,
    resolveProxy: (url) => session.defaultSession.resolveProxy(url),
    setGlobalProxyFromEnv: (env) => http.setGlobalProxyFromEnv(env),
    log: {
      info: (message) => logger.info(LogTag.Runtime, message),
      warn: (message) => logger.warn(LogTag.Runtime, message),
    },
  });
}

async function reconcileUserMemoryIndex(): Promise<void> {
  if (!isMemoryEnabled()) return;
  if (!isUserMemoryVectorStoreReady()) {
    console.warn("[Memory/RAG] reconciliation skipped: vector store is not writable");
    return;
  }
  const report = await reconcileMemoryRag({
    getMemories: () => memoryStore.getAllL2(),
    getVectors: () => getEntriesBySource("user_memory"),
    backup: async () => backupMemoryRagFiles(app.getPath("userData")),
    addVector: addL2MemoryVector,
    markSynced: (l2Id, ragId) => memoryStore.markL2SyncStatus(l2Id, "synced", ragId),
    markSyncFailed: (l2Id, error) => memoryStore.markL2SyncStatus(l2Id, "sync_failed", undefined, error),
    deleteVectors: (ids) => deleteUserMemoryVectors(ids),
    warn: (message, error) => console.warn(`[Memory/RAG] ${message}:`, error),
  });
  logger.info(LogTag.RAG, "reconciliation:", report);
}

async function switchMemoryMode(mode: MemoryMode): Promise<void> {
  if (mode !== "vector") {
    setMemoryMode(mode);
    enableSummaryMemoryScheduler(mode === "summary");
    await enableWikiMemoryScheduler(mode === "wiki");
    resetReranker();
    await disposeVectorMemory();
    return;
  }

  enableSummaryMemoryScheduler(false);
  setMemoryMode("vector");
  await enableWikiMemoryScheduler(false);
  try {
    const modelSettings = loadModelSettings();
    await initVectorMemory("auto", undefined, undefined, modelSettings.embeddingModel, modelSettings.embeddingDimensions);
    await initReranker(modelSettings.rerankerMode);
    await reconcileUserMemoryIndex();
  } catch (error) {
    setMemoryMode("off");
    resetReranker();
    await disposeVectorMemory().catch(() => undefined);
    throw error;
  }
}

/**
 * 启动崩溃恢复：扫描 userData/plans/各会话目录/state.json，把中断的非 NORMAL 会话还原。
 * 只恢复事实不恢复执行权——统一降级 PLAN_DISCUSSING，REVIEW/EXECUTING 来源
 * 由 [PLAN_RECOVERY] 注入中断事实，模型先查证工作区再修订计划重新审批。
 * 快照的会话键取自文件内容（原始 conversationId），目录名只是物理位置；
 * 单个快照损坏只跳过该会话，不阻塞其他恢复。
 */
function recoverInterruptedPlanSessions(plansRoot: string): void {
  let entries: string[];
  try {
    entries = fs.readdirSync(plansRoot);
  } catch {
    return; // plans 目录不存在 = 从未用过计划模式
  }
  for (const entry of entries) {
    const stateFile = path.join(plansRoot, entry, "state.json");
    try {
      if (!fs.existsSync(stateFile)) continue;
      const snapshot = JSON.parse(fs.readFileSync(stateFile, "utf8")) as PlanStateSnapshot;
      const conversationId = typeof snapshot.conversationId === "string" ? snapshot.conversationId : entry;
      const result = restorePlanSession(conversationId, snapshot);
      if (result.ok) {
        console.log(`[PlanMode] 恢复中断会话 ${conversationId}: ${snapshot.state} → PLAN_DISCUSSING`);
      } else {
        console.warn(`[PlanMode] 跳过非法快照 ${entry}: ${result.reason}`);
      }
    } catch (err) {
      console.warn(`[PlanMode] 读取快照失败 ${stateFile}:`, err);
    }
  }
}

export async function createRuntimeDependencies(
  { readiness, activation, shutdown }: Pick<ApplicationDependencies, "readiness" | "activation" | "shutdown">,
  surface: ReturnType<typeof registerChatSurfaceIpc>,
): Promise<Pick<ApplicationDependencies, "startCore" | "startBackground">> {
  await yieldToEventLoop();
  checkStartupActive(shutdown);
  const { disposeShellCompletionDispatch, hasActiveConversationRun, prepareBackgroundSessionMutation, registerAgUiIpc }: typeof import("../agui-bridge") =
    require("../agui-bridge");
  // Agent Runtime 早于插件管理器构造；通过窄闭包在运行期转发宿主事件，避免反转启动顺序。
  let pluginManager: PluginManager | undefined;
  // 自动压缩与 CHATS_COMPACT 必须共享同一个会话级压缩器，避免两条路径各自组装 provider。
  const getTranscriptCompactor = createTranscriptCompactorGetter(() =>
    createModelBackedConversationTranscriptCompactor({
      store: getConversationTranscriptStore(app.getPath("userData")),
      runReader: getHarnessRunStore(app.getPath("userData")),
      // 统一向窗口推送运行前和运行中压缩的阶段及上下文占用。
      onPhase: (phase, conversationId, usage) => broadcastCompactionPhase(conversationId, phase, usage),
    }));
  // 生命周期事件发布器：插件系统就绪前发布的事件没有监听器，直接丢弃
  const lifecyclePublisher = createLifecyclePublisher({
    publish: (event, payload) => pluginManager
      ? pluginManager.publishHostEvent(event, payload)
      : Promise.resolve(),
  });
  // 桌面轮次协调器：turn:finished 等待"终态 + 渲染端落盘确认"双条件；
  // 计时器均 unref，应用退出前统一清理，不发布任何事件
  const pendingTurnLifecycle = createPendingTurnLifecycle({
    publisher: lifecyclePublisher,
    onAbandon: (runId, reason) => {
      console.warn(`[plugins] 桌面轮次事件放弃发布: runId=${runId} reason=${reason}`);
    },
  });
  app.on("will-quit", () => {
    pendingTurnLifecycle.disposeAll();
  });
  shutdown.register({ id: "shell-completion-dispatch", phase: "quiesce", dispose: disposeShellCompletionDispatch });
  shutdown.register({ id: "shell-jobs", phase: "stopLocalResources", dispose: disposeAllShellJobs });

  // Each dependency is initialized once. The background runner and first send share the same work.
  function startupTask(name: string, run: () => void | Promise<void>) {
    let task: Promise<void> | undefined;
    return () => {
      if (task) return task;
      checkStartupActive(shutdown);
      const unregister = shutdown.register({ id: "startup-" + name, phase: "quiesce", dispose: () => task });
      task = Promise.resolve().then(run).catch((error) => {
        console.warn(`[Startup] ${name} failed:`, error);
        readiness.markDegraded({ capability: name, message: String(error), at: Date.now(), error });
      }).finally(unregister);
      return task;
    };
  }
  const skillsReady = startupTask("skills", initSkills);
  const sandboxReady = startupTask("sandbox", () => initSandbox());
  const memoryReady = startupTask("rag", async () => {
    const modelSettings = loadModelSettings();
    const knowledgeBase = initializeKnowledgeBase(app.getPath("userData"));
    setMemoryMode(modelSettings.memoryMode);
    initializeSummaryMemoryScheduler({
      userDataRoot: app.getPath("userData"),
      sessions: chatsStore,
      onError: (conversationId, error) => logger.warn(LogTag.RAG, "summary memory update failed:", conversationId, error),
    });
    enableSummaryMemoryScheduler(isSummaryMemoryEnabled());
    const wikiMigration = createConversationSessionMigration(app.getPath("userData"));
    initializeWikiMemoryScheduler({
      userDataRoot: app.getPath("userData"),
      sourceReader: createWikiChatSourceReader({
        transcriptStore: getConversationTranscriptStore(app.getPath("userData")),
        listSessions: chatsStore.listSessions,
        ensureConversationMigrated: (id) => wikiMigration.ensureConversationMigrated(id),
      }),
      onError: (conversationId, error) => logger.warn(LogTag.RAG, "wiki memory update failed:", conversationId, error),
    });
    await enableWikiMemoryScheduler(modelSettings.memoryMode === "wiki");
    await initWorldbook();
    if (isMemoryEnabled()) {
      await initVectorMemory("auto", undefined, undefined, modelSettings.embeddingModel, modelSettings.embeddingDimensions);
    } else {
      logger.info(LogTag.RAG, "vector memory disabled by settings");
    }
    // 注册 RAG 落盘：受控退出在 flushPersistence 阶段刷盘；
    // Windows 会话结束（断电/强制关机）走同步紧急落盘兜底
    shutdown.register({
      id: "rag-store",
      phase: "flushPersistence",
      dispose: async () => { await flushRAGStore(); },
    });
    shutdown.registerEmergencyFlush("rag-store", () => flushRAGStoreSync());
    shutdown.register({
      id: "summary-memory",
      phase: "flushPersistence",
      dispose: async () => { await flushAllSummaryMemory(); },
    });
    shutdown.register({
      id: "wiki-memory",
      phase: "flushPersistence",
      dispose: async () => { await enableWikiMemoryScheduler(false); },
    });
    shutdown.register({
      id: "knowledge-base",
      phase: "flushPersistence",
      dispose: async () => { await knowledgeBase.close(); },
    });
    logger.info(LogTag.RAG, "RAG initialized OK");
  });
  const vectorReady = startupTask("vector-memory", async () => {
    await memoryReady();
    if (!isMemoryEnabled() || shutdown.isStopping()) return;
    try {
      await reconcileUserMemoryIndex();
    } finally {
      if (!shutdown.isStopping() && isMemoryEnabled()) await initReranker(loadModelSettings().rerankerMode);
    }
  });
  let momentsReady: Promise<void> = Promise.resolve();
  let pluginsReady: Promise<void> = Promise.resolve();
  const mcpTasks = new Map<string, Promise<void>>();
  let announceServers!: () => void;
  const serversDiscovered = new Promise<void>((resolve) => { announceServers = resolve; });

  async function waitForMcp(select: (id: string) => boolean = () => true): Promise<void> {
    await serversDiscovered;
    await Promise.all([...mcpTasks].filter(([id]) => select(id)).map(([, task]) => task));
    checkStartupActive(shutdown);
  }

  const waitForToolCatalog = () => Promise.all([
    skillsReady(), waitForMcp(), pluginManager!.waitForStartupTools(() => true),
  ]);

  async function waitForConversation(mode: ConversationMode, toolIds?: readonly string[] | "all"): Promise<void> {
    checkStartupActive(shutdown);
    await readiness.waitFor("core-ready");
    if (readiness.getPhase() === "ready" && !mcpTasks.size) return;
    const settings = loadGeneralSettings();
    const chatTools = Object.entries(settings.toolModeOverrides)
      .filter(([id, overrides]) => settings.chatToolsEnabled && overrides.chat && shouldExposeSearchTool(id, settings.searchEngine))
      .map(([id]) => id);
    // 调度任务按冻结的工具名单启动；插件无头运行只执行自己传入的回调。
    const selected = toolIds ?? (mode === "chat" ? chatTools : "all");
    const uses = (id: string) => selected === "all" || selected.includes(id);
    const usesPrefix = (prefix: string) => selected === "all" || selected.some((id) => id.startsWith(prefix));
    const tasks: Array<Promise<unknown>> = [loadModelSettings().memoryMode === "vector" ? vectorReady() : memoryReady()];
    if (mode !== "chat" || uses("invoke_skill") || uses("read_skill_reference")) tasks.push(skillsReady());
    if (uses("run_shell") && (toolIds !== undefined || settings.toolModeOverrides.run_shell?.[mode] !== false)) tasks.push(sandboxReady());
    const needsMomentsTools = toolIds !== undefined
      ? ["moments_view", "moments_post", "moments_interact"].some(uses)
      : toolRegistry.getEnabledToolsForMode(mode, settings.toolModeOverrides)
        .some((tool) => ["moments_view", "moments_post", "moments_interact"].includes(tool.id));
    if (settings.momentsEnabled && (needsMomentsTools || (mode === "chat" && settings.chatMomentsContextEnabled))) {
      tasks.push(momentsReady);
    }
    if (selected === "all" || selected.length) {
      tasks.push(pluginManager!.waitForStartupTools((id) => usesPrefix(id + "_")));
      tasks.push(waitForMcp((id) => (toolIds !== undefined || shouldExposeSearchTool(id + "-", settings.searchEngine)) && usesPrefix(id + "-")));
    }
    await Promise.all(tasks);
    checkStartupActive(shutdown);
  }

  return {
    // 代理需要已就绪的 Electron session 才能查询，且必须早于 core 中的第一个模型 / 嵌入请求
    startCore: (shell) => configureProxyForNodeRequests().then(() => startCore({
      shell,
      readiness,
      activation,
      shutdown,
      markStartupWindowsReady: () => markStartupPhaseReady(),

      // 升级迁移：NSIS 暂存的安装目录用户内容合并进 userData，
      // 必须在任何 prompts/skills 读取（initSkills、prompt 加载）之前执行
      migrateStagedExternalContent: () => migrateStagedExternalContent({
        isPackaged: app.isPackaged,
        ...getExternalContentPaths(),
      }),
      createLowCostServices: () => {
        const runtimeStateService = createRuntimeStateService();
        runtimeStateService.onChange(() => {
          broadcastToAuxWindows(IPC.RUNTIME_STATE_CHANGED, runtimeStateService.getState());
        });

        const llmClient = createLlmClient();
        const ttsSynthesisService = createTtsSynthesisService();
        clearLegacyStickerEmbeddingCache(app.getPath("userData"));
        const citaService = createCitaService({ llmClient });
        const socialContextService = createSocialContextService({ llmClient, enqueueLLMTask });
        const proactiveLifecycle = createProactiveLifecycle({
          loadGeneralSettings,
          // runReader 接入 harness 运行存储：孤儿工具按运行状态归类，避免误判 not_executed
          conversationJournal: new ConversationJournalService({
            store: getConversationTranscriptStore(app.getPath("userData")),
            runReader: getHarnessRunStore(app.getPath("userData")),
          }),
        });
        // 主动聊天服务初始化是纯装配；触发器由 background 阶段启动
        proactiveLifecycle.initializeProactiveChatService();

        // 崩溃对账：启动时对进程崩溃遗留的 interrupted run 幂等补写 crashed 中断边界。
        // 异步、失败仅日志，不阻塞启动关键路径；两 store 单例在此刻均已就绪。
        void reconcileCrashedInterruptions({
          runStore: getHarnessRunStore(app.getPath("userData")),
          transcriptStore: getConversationTranscriptStore(app.getPath("userData")),
          now: Date.now,
        }).then((result) => {
          if (result.written > 0) {
            console.log(`[CrashReconcile] 补写 ${result.written} 条崩溃边界，跳过 ${result.skipped} 个已有边界的中断 run`);
          }
        }).catch((error) => {
          console.error("[CrashReconcile] 崩溃对账失败（仅日志，不阻塞启动）:", error);
        });

        const ttsSessionService = new TtsSessionService((request, signal, emit) =>
          ttsSynthesisService.synthesizeSession(request, signal, emit),
        );

        // 应用图标 getter 已在工厂体开头注入（早于 shell 阶段的窗口壳/托盘创建）。

        // 内置工具配置 getter
        bootstrapConfigGetters({
          loadGeneralSettings,
        });

        // Locale Context（从 GeneralSettings 的语言配置同步）
        const generalSettings = loadGeneralSettings();
        updateLocaleContext({
          uiLocale: generalSettings.language,
          dateLocale: generalSettings.language,
          asrLanguage: generalSettings.asrLanguage,
        });

        // Git：服务对象预创建；仓库监听只在打开仓库后启动
        // 探测结果在进程内缓存：成功过一次就不再重复探测，避免启动高峰期
        // 偶发超时导致 Git 面板误报"未检测到可用 Git"；探测失败不缓存，下次自动重试
        let resolvedGit: ResolvedGitExecutable | null = null;
        const git = createGitService({
          getSession: chatsStore.getSessionRecord,
          resolveExecutable: async () => {
            resolvedGit ??= await resolveGitExecutable({
              systemCommand: "git",
              bundledPath: app.isPackaged
                ? path.join(process.resourcesPath, "mingit", "cmd", "git.exe")
                : path.join(app.getAppPath(), "resources", "mingit", "cmd", "git.exe"),
            });
            return resolvedGit;
          },
        });

        // LSP：管理器预创建；具体语言服务进程按需启动
        const lsp = new LspManager({
          getServerOverrides: () => loadGeneralSettings().lspServerOverrides,
        });

        // Gmail clients are lazy: service construction reads no mailbox data and starts no network request.
        const gmailAuth = new GmailAuthService();
        const mailAttachmentStore = new MailAttachmentStore();
        const gmail = new GmailService(gmailAuth, { resolveAttachment: (reference) => mailAttachmentStore.resolve(reference) });

        // 截图：原生 helper IPC、全局热键。预热在 background 阶段执行。
        const initialSettings = loadGeneralSettings();
        const screenshot = initializeScreenshotService({
          initialHotkey: initialSettings.screenshotHotkey ?? "Alt+Shift+S",
          getReactChatWindow: () => reactChatWindow,
          capturePetWindow: () => shell.windowManager.capturePetWindow(),
          ipc: shell.ipc,
        });

        // Cloud Music wiring（MusicService + IPC + Agent 工具）；
        // 后端由首次音乐动作惰性连接，退出清理由中心协调器负责。
        const music = bootstrapMusicService(resolveMusicPaths());

        // 应用更新服务（检查/下载按需；安装必须先走受控退出）
        const update = createGitHubAppUpdateService({
          currentVersion: app.getVersion(),
          isPackaged: app.isPackaged,
        });

        return {
          runtimeState: runtimeStateService,
          llm: llmClient,
          cita: citaService,
          social: socialContextService,
          tts: ttsSynthesisService,
          ttsSession: ttsSessionService,
          proactive: proactiveLifecycle,
          git,
          lsp,
          gmailAuth,
          gmail,
          mailAttachmentStore,
          screenshot,
          music,
          update,
        };
      },

      initPlanMode: () => {
        const plansRoot = path.join(app.getPath("userData"), "plans");
        // 计划模式路径根注入：write_plan / plan.md 读写基于 userData/plans/<会话键>/
        initPlanPaths(app.getPath("userData"));
        // 状态持久化（durable transition）：同步写盘，approvePlan 返回时 state.json 已落盘，
        // 崩溃恢复不丢"执行正在进行"的事实；null = 回 NORMAL，删除 state.json 清尸
        initPlanStatePersister((conversationId, snapshot) => {
          const stateFile = path.join(plansRoot, encodePlanSessionKey(conversationId), "state.json");
          if (!snapshot) {
            fs.rmSync(stateFile, { force: true });
            return;
          }
          fs.mkdirSync(path.dirname(stateFile), { recursive: true });
          fs.writeFileSync(stateFile, JSON.stringify(snapshot, null, 2), "utf8");
        });
        // 计划模式状态广播：所有状态切换都广播到所有窗口
        initPlanStateBroadcaster((conversationId, state) => {
          const payload = { conversationId, state };
          for (const win of BrowserWindow.getAllWindows()) {
            win.webContents.send(IPC.PLAN_STATE_CHANGED, payload);
          }
        });
        // 启动崩溃恢复：非 NORMAL 快照统一降级 PLAN_DISCUSSING，不自动恢复执行权
        recoverInterruptedPlanSessions(plansRoot);
      },

      // 工具注册：集中到一个显式入口（依赖沙箱/Git/LSP 就绪）
      registerAllTools: async (services) => {
        const { registerAllTools } = await import("../orchestrator/tools/registry/tool-registration.js");
        checkStartupActive(shutdown);
        registerAllTools({ lspManager: services.lsp, gmailService: services.gmail });
      },

      createRuntime: (services) => {
        const transcriptCompactor = getTranscriptCompactor();
        return createAgentRuntime({
          waitForStartup: waitForConversation,
          runtimeStateService: services.runtimeState,
          llmClient: services.llm,
          enqueueLLMTask,
          loadModelSettings,
          loadGeneralSettings,
          loadUserProfile,
          toolRegistry,
          skillRegistry,
          getStickerTextIndex: loadStickerTextIndex,
          broadcastRuntimeStateChanged: () => {
            broadcastToAuxWindows(IPC.RUNTIME_STATE_CHANGED, services.runtimeState.getState());
          },
          citaService: services.cita,
          socialContextScheduler: services.social.scheduler,
          chatsStore,
          buildSummaryMemoryContext: (conversationId) => loadSummaryMemoryContext({
            conversationId,
            userDataRoot: app.getPath("userData"),
            getSessionRecord: chatsStore.getSessionRecord,
          }),
          scheduleSummaryTurn: (input) => scheduleSummaryTurn(input),
          scheduleWikiTurn: (input) => scheduleWikiTurn(input),
          socialAtomStore: services.social.store,
          buildPluginPromptContext: (input) => pluginPromptRegistry.build(input),
          publishPluginHostEvent: (event, payload) => pluginManager
            ? pluginManager.publishHostEvent(event, payload)
            : Promise.resolve(),
          publishToolFinished: (event) => lifecyclePublisher.publishToolFinished(event),
          transcriptCompactor,
        });
      },

      createChannels: (runtime, services) => createChannelsSubsystem({
        agentRuntime: runtime,
        ttsSynthesisService: services.tts,
        getReactChatWindow: () => reactChatWindow,
        ipc: shell.ipc,
        publishLifecycle: lifecyclePublisher,
      }),

      startPlugins: async (services, scheduler, runtime) => {
        pluginManager = createPluginRuntime({
          llmClient: services.llm,
          ipc: shell.ipc,
          schedulerStore: scheduler.store,
          agentRuntime: runtime,
          // 插件启停后让调度引擎重新归一化逾期任务并重排计时器（不补跑）。
          onPluginRunningStateChange: () => scheduler.engine.refreshPluginTasks(),
          // 插件面板仅由工作区设置页承载。
          getPanelHostWebContents: () => [reactChatWindow]
            .filter((window) => window && !window.isDestroyed())
            .map((window) => window!.webContents),
        });
        pluginsReady = pluginManager.start(Promise.resolve().then(() => checkStartupActive(shutdown)));
        void pluginsReady.catch((error) => console.error("[Startup] plugins failed:", error));
        return pluginManager;
      },

      createScheduler: (runtime) => createSchedulerSubsystem({
        agentRuntime: runtime,
        waitForTools: (task) => waitForConversation(task.mode ?? "work", task.toolMode === "all-enabled" ? "all" : task.allowedToolIds),
        getReactChatWindow: () => reactChatWindow,
        ipc: afterStartup(shell.ipc, channel => channel === IPC.SCHEDULER_GET_TOOLS ? waitForToolCatalog() : undefined),
        publishLifecycle: lifecyclePublisher,
        // runReader 接入 harness 运行存储：孤儿工具按运行状态归类，避免误判 not_executed
        conversationJournal: new ConversationJournalService({
          store: getConversationTranscriptStore(app.getPath("userData")),
          runReader: getHarnessRunStore(app.getPath("userData")),
        }),
        getActiveConversation: () => activeConversationRegistry.getMostRecent(),
        // 插件任务只有在所属插件运行中才允许触发；用户任务不受影响。
        canRunTask: (task) => !task.ownerPluginId
          || (pluginManager?.isRunning(task.ownerPluginId) ?? false),
      }),

      registerCoreIpc: async ({ ipc, runtime, services }) => {
        const transcriptCompactor = getTranscriptCompactor();
        // 设置变更反应：窗口/托盘/截图热键/主动服务联动
        onGeneralSettingsChanged((before, after) =>
          handleGeneralSettingsChanged(before, after, {
            windowManager: shell.windowManager,
            tray: shell.tray,
            screenshotService: services.screenshot,
            proactiveLifecycle: services.proactive,
            broadcastToAuxWindows,
          }),
        );

        registerChatUiIpc({ ipc, windowManager: shell.windowManager, live2dWindowLifecycle: shell.live2dWindowLifecycle, windowIpcRegistered: true });
        registerSettingsIpc({
          surfaceRegistered: true,
          ipc: afterStartup(ipc, (channel, patch) => {
            if (channel === IPC.EMBEDDING_SET_MODEL || channel === IPC.RERANKER_SET_MODE) return vectorReady();
            if ((channel === IPC.SETTINGS_SAVE_GENERAL || channel === IPC.TTS_SAVE_SETTINGS) && patch && typeof patch === "object"
              && ["searchMinimaxKey", "searchEngine", "playwrightMcpEnabled", "filesystemMcpEnabled"].some(key => key in patch)) {
              return waitForMcp();
            }
          }),
          windowManager: shell.windowManager,
          getGeneralSettings: loadGeneralSettings,
          saveGeneralSettings,
          getModelSettings: loadModelSettings,
          saveModelSettings,
          runtimeStateService: services.runtimeState,
          proactiveLifecycle: services.proactive,
          reconcileUserMemoryIndex,
          switchMemoryMode: async (mode) => { await vectorReady(); await switchMemoryMode(mode); },
          syncVolcanoSearchMcp,
          syncPlaywrightMcp,
          syncFilesystemMcp,
        });
        registerGmailIpc({ ipc, auth: services.gmailAuth, service: services.gmail, attachmentStore: services.mailAttachmentStore });

        // 项目公告：渲染端首次打开时拉一次，之后主进程每 6 小时对一次版本
        registerNewsIpc(ipc);

        registerMemoryUserToolIpc({
          ipc: afterStartup(ipc, (channel) => {
            if (channel.startsWith("skill:")) return skillsReady();
            if (channel.startsWith("memory-panel:")) return memoryReady();
            if (channel === IPC.TOOL_GET_CATALOG || channel === IPC.TOOL_GET_ENABLED || channel === IPC.TOOL_SET_ENABLED) return waitForToolCatalog();
            if (channel === IPC.MCP_ADD_SERVER || channel === IPC.MCP_REMOVE_SERVER || channel === IPC.MCP_LIST_SERVERS) return waitForMcp();
          }),
          windowManager: shell.windowManager,
        });
        const memoryIpc = afterStartup(ipc, memoryReady);
        registerWikiMemoryIpc(memoryIpc);
        registerKnowledgeBaseIpc(memoryIpc);

        // ── TTS IPC ──
        registerTtsIpc({ ipc, ttsSessionService: services.ttsSession });

        // 聊天会话存储 IPC（chats-store.initialize 建好 cyrene-chats 目录并加载 index）
        await registerChatsIpc(ipc, {
          surface,
          beforePendingClaim: waitForConversation,
          llmClient: services.llm,
          isPrimaryModelBusy: hasActiveConversationRun,
          beforeWorkspaceBindingChange: prepareBackgroundSessionMutation,
          beforeSessionDelete: prepareBackgroundSessionMutation,
          transcriptCompactor,
        });
        momentsReady = registerMomentsIpc(ipc, Promise.resolve().then(() => checkStartupActive(shutdown)));
        void momentsReady.catch((error) => console.error("[Startup] moments failed:", error));
        registerCodeGitIpc({ ipc, service: services.git });
        // 会话工作区只读文件（右侧面板文件树 / 预览）
        registerWorkspaceFilesIpc(ipc);
        // 工作区右上角"打开"菜单：本机应用探测 + 打开执行
        registerOpenInAppIpc(ipc);
        const examPaperStore = createExamPaperStore(app.getPath("userData"));
        const browserPanel = registerBrowserPanelIpc({
          ipc,
          getWindow: () => reactChatWindow,
          getExamRecord: (examId) => examPaperStore.get(examId),
          getViewportMode: () => loadGeneralSettings().browserViewportMode,
        });
        shutdown.register({
          id: "browser-panel-session",
          phase: "flushPersistence",
          dispose: async () => { await browserPanel.persistSessionForShutdown(); },
        });

        // AG-UI 事件流桥：渲染进程 invoke(AGUI_RUN) → CyreneAgent 跑 Agent 循环 → 事件透传
        registerAgUiIpc(
          (input) => runtime.buildOptions(input),
          (result, latestUserText, context) => runtime.onRunFinished(result, latestUserText, context),
          () => reactChatWindow,
          services.proactive.proactiveConversationLifecycle,
          ipc,
          pendingTurnLifecycle,
        );

        // 应用更新 IPC：安装走受控退出；autoUpdater 兜底路径进入同一协调器
        registerAppUpdateIpc({
          ipc,
          service: services.update,
          requestControlledShutdown: (input) => shutdown.requestControlledShutdown(input),
        });
        installUpdateShutdownFallback({
          updater: autoUpdater as unknown as UpdateLifecycleLike,
          coordinator: shutdown,
          finalAction: () => services.update.install(),
        });

        // 计划模式开关/查询 IPC
        ipc.handle(IPC.PLAN_SET_MODE, (_event, payload: { conversationId?: string; target?: "on" | "off"; workspaceRoot?: string }) => {
          const conversationId = payload?.conversationId;
          const target = payload?.target;
          if (!conversationId) return { ok: false, reason: "缺少 conversationId" };
          if (target !== "on" && target !== "off") return { ok: false, reason: "target 必须是 on/off" };
          const current = getPlanState(conversationId);
          if (target === "on") {
            if (current !== "NORMAL") return { ok: true, state: current }; // 已激活：no-op
            const t = enterPlanDiscussing(conversationId, payload.workspaceRoot);
            if (!t.ok) return { ok: false, reason: t.reason, state: current };
            return { ok: true, state: getPlanState(conversationId) };
          }
          // target === "off"
          if (current === "EXECUTING") {
            return { ok: false, reason: "计划执行中，不可手动退出", state: current };
          }
          if (current === "NORMAL") return { ok: true, state: current };
          exitPlanMode(conversationId);
          return { ok: true, state: getPlanState(conversationId) };
        });
        ipc.handle(IPC.PLAN_GET_STATE, (_event, payload: { conversationId?: string }) => {
          const conversationId = payload?.conversationId;
          if (!conversationId) return { state: "NORMAL" as const };
          return { state: getPlanState(conversationId) };
        });

        // 权限模块：磁盘加载 + 权限/选择卡片 IPC（必须在 createWindow 之后、任意工具调用之前）
        bootstrapPermission(ipc);
        // pop_quiz 抽查工具：IPC（提交/跳过）与工具注册（learn 模式可见）
        registerPopQuizIpc(ipc);
        registerPopQuizTool();
        // 正式试卷：答案与评分资料仅由主进程存储；Learn 工具负责出卷、取卷批改与保存结果。
        const examDraftStore = createExamDraftStore(app.getPath("userData"), examPaperStore);
        void examDraftStore.deleteExpired().catch((error) => {
          console.warn("[LearnExam] 清理过期出卷草稿失败:", error);
        });
        void examPaperStore.recoverInterruptedGrading().catch((error) => {
          console.warn("[LearnExam] 恢复中断批改状态失败:", error);
        });
        registerExamPaperIpc(examPaperStore, ipc);
        registerLearnExamPageIpc(examPaperStore, ipc);
        registerLearnExamTools(examPaperStore, examDraftStore);
        registerCallIpc(ipc);
      },

      loadGeneralSettings,
      applyGeneralSettings: (settings, services) => applyGeneralSettings(settings, {
        windowManager: shell.windowManager,
        tray: shell.tray,
        screenshotService: services.screenshot,
        proactiveLifecycle: services.proactive,
        broadcastToAuxWindows,
      }),
      wireToastCenter: ({ ipc, windowManager }) => {
        // 提醒中心组合根：窗口控制器 + 生命周期权威服务 + 事件总线订阅
        const toastWindowController = createToastWindowController({
          createWindow: createToastWindowShell,
          getChatWindow: () => reactChatWindow,
          getDisplayMatching: (bounds) => screen.getDisplayMatching(bounds),
          getCursorScreenPoint: () => screen.getCursorScreenPoint(),
        });
        const toastService = createToastService({
          bus: toastEvents,
          window: toastWindowController,
          activate: (request) => { activation.request(request); },
          openTasksWindow: () => { void windowManager.openScheduledTasks(); },
          // 音效总开关：设置页可关；每次弹窗时读取，改动即时生效
          isSoundEnabled: () => loadGeneralSettings().toastSoundEnabled,
          shouldSuppressNotify: (event) => {
            // 焦点抑制三条件：事件带会话 + 聊天窗口聚焦 + 激活会话一致。
            // 调度任务结果落在任务历史（无会话落点），恒不抑制。
            if (!event.sessionId) return false;
            const chat = reactChatWindow;
            if (!chat || chat.isDestroyed() || !chat.isFocused()) return false;
            return getActiveChatSessionId() === event.sessionId;
          },
        });
        toastService.registerIpc(ipc);
        // 预创建隐藏窗口，提前加载渲染页，首次弹出零延迟
        void Promise.resolve().then(() => {
          if (!shutdown.isStopping()) toastWindowController.preload();
        }, () => undefined);
        shutdown.register({
          id: "toast-center",
          phase: "stopLocalResources",
          dispose: async () => {
            toastService.dispose();
            toastWindowController.dispose();
          },
        });
      },
    })),

    startBackground: (core) => {
      return startBackground({
        core,
        readiness,
        shutdown,
        channels: core.channels,
        scheduler: core.scheduler,
        pruneRemovedMcp: async () => {
          // 一次性清理已下架的内置 MCP（Firecrawl hosted 等）
          const removed = await pruneMcpServersByIds([...REMOVED_BUILTIN_MCP_IDS]);
          if (removed.length > 0) {
            console.log("[Cyrene] 已清理遗留的已下架内置 MCP:", removed.join(", "));
          }
        },
        prepareChatCapabilities: async () => { await Promise.all([skillsReady(), sandboxReady(), pluginsReady, momentsReady]); },
        restoreMcp: async (signal) => {
          let restoring: Promise<void>[];
          try {
            const settings = loadGeneralSettings();
            const saved = new Map(listMcpServerConfigs().map((config) => [config.id, config]));
            const ids = new Set([...saved.keys(), PLAYWRIGHT_MCP_ID, FILESYSTEM_MCP_ID]);
            restoring = [...ids].map(async (id) => {
              const restore = (async () => {
                if (id === PLAYWRIGHT_MCP_ID) await syncPlaywrightMcp(settings);
                if (id === FILESYSTEM_MCP_ID) await syncFilesystemMcp({
                  filesystemMcpEnabled: settings.filesystemMcpEnabled, allowedDir: app.getPath("downloads"),
                });
                const builtin = id === PLAYWRIGHT_MCP_ID || id === FILESYSTEM_MCP_ID;
                const config = builtin ? listMcpServerConfigs().find((entry) => entry.id === id) : saved.get(id);
                if (config) await restoreMcpServer(config, signal);
              })();
              // The 30s barrier releases background producers. A selected tool still waits for its own discovery.
              const settled = restore.catch((error) => console.warn("[MCP] startup failed:", id, error))
                .finally(() => mcpTasks.delete(id));
              mcpTasks.set(id, settled);
              await settled;
            });
          } finally {
            announceServers();
          }
          await Promise.all(restoring);
        },
        reconcileMemory: async () => { await memoryReady(); },
        initializeReranker: async () => { await vectorReady(); },
        prewarmScreenshot: async () => {
          await core.services.screenshot.prewarm();
        },
        scheduleUpdateCheck: async () => {
          const dispose = scheduleStartupUpdateCheck(core.services.update);
          return { dispose };
        },
        startProactiveTrigger: async () => {
          core.services.proactive.initializeProactiveTrigger();
          return { dispose: () => core.services.proactive.stopProactiveTrigger() };
        },
        startMomentsReactionScanner: async () => {
          // 启动即补扫一轮：重启前已逾期的反应任务尽快续上，不等第一个扫描周期
          momentsService.startReactionScanner();
          return { dispose: () => momentsService.stopReactionScanner() };
        },
      });
    },

  };
}
