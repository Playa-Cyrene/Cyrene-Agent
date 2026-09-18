import { app, dialog, safeStorage } from "electron";
import path from "node:path";
import { channelManager } from "./channels/manager";
import type { ChannelAdapter } from "./channels/adapters/base";
import type { ChannelId } from "./channels/types";
import * as chatsStore from "./chats/chats-store";
import { toolRegistry, type ToolDefinition } from "./orchestrator/tools/registry/tool-registry";
import { loadGeneralSettings, saveGeneralSettings } from "./settings/settings-facade";
import { loadModelSettings, resolveModelSettingsProfile } from "./settings/model-settings";
import { pluginGenerateText } from "./plugin-llm";
import { createPluginAgentRunner } from "./plugin-agent";
import { createHostServiceFactory } from "./plugin-host/host-services";
import type { PluginSchedulerStore } from "./plugin-host/scheduler-service";
import { activeChatTargetRegistry } from "./plugin-host/active-chat-target";
import { createSpeechInputService } from "./plugin-host/speech-input-service";
import { createSpeechInputCommitBridge } from "./plugin-host/speech-input-commit-bridge";
import { createSpeechInputCallController } from "./plugin-host/speech-input-call-controller";
import { installPluginPanelProtocol } from "./plugin-panel-protocol";
import { createPluginIpcRouter } from "../plugins/ipc-router";
import { PluginManager } from "../plugins/manager";
import { pluginPromptRegistry } from "../plugins/prompts";
import {
  MARKET_REGISTRY_URLS,
  MARKET_ZIP_URL_PREFIXES,
  createPluginMarketplaceService,
} from "./plugin-marketplace";
import { IPC } from "../shared/ipc-channels";
import type { LlmClient } from "./services/llm/llm-client";
import { enqueueLLMTask } from "./llm-queue";
import type { IpcScope } from "./application/ipc-scope";
import type { AgentRuntime } from "./orchestrator/agent-runtime";

/** 调度存储视图：插件服务读写任务，卸载清理时按归属批量删除插件任务。 */
export type PluginRuntimeSchedulerStore = PluginSchedulerStore & {
  deleteTasksByOwner(pluginId: string): number;
};

export interface PluginRuntimeDeps {
  llmClient: LlmClient;
  ipc: IpcScope;
  /** 统一人设与提示词管线；供无头插件 Agent 复用。 */
  agentRuntime: Pick<AgentRuntime, "buildOptions">;
  /** 调度存储；必须已完成 load()（scheduler.initialize() 先于启动插件）。 */
  schedulerStore: PluginRuntimeSchedulerStore;
  /** 插件启停后回调：宿主让调度引擎重排计时器（不补跑）。 */
  onPluginRunningStateChange?: (pluginId: string, running: boolean) => void;
  /**
   * 面板宿主窗口查询（首版=设置窗口）：主进程对 PLUGINS_PANEL_INVOKE 做
   * sender 校验的依据；未提供时面板转发一律拒绝（fail-closed）。
   */
  getPanelHostWebContents?: () => Electron.WebContents | null;
}

export async function startPluginRuntime(deps: PluginRuntimeDeps): Promise<PluginManager> {
  const userPluginRoot = path.join(app.getPath("userData"), "plugins");
  const pluginDataRoot = path.join(app.getPath("userData"), "plugin-data");
  // 插件 IPC 路由器：面板转发与既有 ipcMain 直达共用一套执行路径
  const router = createPluginIpcRouter();
  // 独占语音输入租约：全局单例，随插件运行时启动创建；
  // 普通聊天经 IPC 提交桥送入聊天窗口渲染页，活动通话经控制器落到通话管理器
  const speechInput = createSpeechInputService({
    registry: activeChatTargetRegistry,
    sessionStore: { getSession: (id) => chatsStore.getSession(id) ?? null },
    commitBridge: createSpeechInputCommitBridge(deps.ipc),
    callController: createSpeechInputCallController(),
  });
  const manager = new PluginManager({
    scanRoots: [
      { path: path.join(__dirname, "..", "plugins"), source: "builtin" },
      { path: userPluginRoot, source: "user" },
    ],
    storageRoot: pluginDataRoot,
    runtime: {
      // 宿主工具注册表端口：插件侧传 PluginTool（宽松端口类型），
      // 在此信任边界处适配进主进程注册表；缺省字段由运行时默认值兜底
      toolRegistry: {
        register: (tool) => toolRegistry.register(tool as ToolDefinition),
        unregister: (id) => toolRegistry.unregister(id),
        getById: (id) => toolRegistry.getById(id),
      },
      // 宿主渠道管理器端口：同样在宿主侧完成 PluginChannelAdapter → ChannelAdapter 的适配
      channelManager: {
        has: (id) => channelManager.has(id as ChannelId),
        register: (adapter) => channelManager.register(adapter as unknown as ChannelAdapter),
        unregister: (id) => channelManager.unregister(id as ChannelId),
        startOne: (id) => channelManager.startOne(id as ChannelId),
      },
      registerIpc: (channel, handler) => {
        // 两条调用来源（既有 ipcMain 直达 + 面板转发）共用同一张路由表
        router.register(channel, handler);
        deps.ipc.handle(channel, (_event, ...args: unknown[]) => router.invokeRegistered(channel, args));
      },
      unregisterIpc: (channel) => {
        router.unregister(channel);
        deps.ipc.removeHandler(channel);
      },
      promptRegistry: pluginPromptRegistry,
      // 宿主服务统一从工厂注入：channels、llm、secrets、workspace、
      // conversations 和 scheduler 在 plugin-host/host-services.ts 装配；
      // 后续新服务只扩展装配工厂，不再向 PluginContext 加特例。
      hostServices: createHostServiceFactory({
        pluginDataRoot,
        channelManager: { has: (channelId) => channelManager.has(channelId as ChannelId) },
        llm: {
          generateText: (messages, options) => pluginGenerateText(
            messages,
            resolveModelSettingsProfile(loadModelSettings()),
            deps.llmClient,
            enqueueLLMTask,
            options,
          ),
        },
        createAgentRunner: ({ pluginId, signal }) => createPluginAgentRunner({
          pluginId,
          pluginSignal: signal,
          userDataPath: app.getPath("userData"),
          agentRuntime: deps.agentRuntime,
        }),
        storage: safeStorage,
        chatsReader: chatsStore,
        schedulerStore: deps.schedulerStore,
        speechInput,
      }),
    },
    loadEnabledMap: () => loadGeneralSettings().plugins,
    saveEnabledMap: (plugins) => saveGeneralSettings({ plugins }),
    // 真正卸载时删除该插件创建的定时任务；清理失败由管理器中止目录删除。
    cleanupPersistentResources: async (pluginId) => {
      deps.schedulerStore.deleteTasksByOwner(pluginId);
    },
    selectPluginZip: async () => {
      const result = await dialog.showOpenDialog({
        title: "导入 Cyrene 插件",
        properties: ["openFile"],
        filters: [{ name: "Cyrene 插件包", extensions: ["zip"] }],
      });
      return result.canceled ? undefined : result.filePaths[0];
    },
    confirmPluginReplace: async (plugin) => {
      const result = await dialog.showMessageBox({
        type: "warning",
        title: "替换已有插件",
        message: `用户插件 ${plugin.name}（${plugin.id}）已经存在。`,
        detail: `是否用 ZIP 中的 ${plugin.version} 版本替换现有程序？插件私有数据将保留。`,
        buttons: ["取消", "替换"],
        defaultId: 0,
        cancelId: 0,
        noLink: true,
      });
      return result.response === 1;
    },
  });
  // 插件市场：列表来自官方索引快照，安装下载后走管理器的 ZIP 导入管线（含身份校验与来源记录）
  const market = createPluginMarketplaceService({
    registryUrls: MARKET_REGISTRY_URLS,
    zipUrlPrefixes: MARKET_ZIP_URL_PREFIXES,
    cacheDir: path.join(app.getPath("userData"), "plugin-market-cache"),
    installZip: (zipPath, opts) => manager.installZip(zipPath, opts),
  });
  deps.ipc.handle(IPC.PLUGINS_MARKET_LIST, (_event, preferred: unknown) =>
    market.listMarket(typeof preferred === "string" ? preferred : undefined),
  );
  deps.ipc.handle(IPC.PLUGINS_MARKET_INSTALL, (_event, id: unknown) => {
    if (typeof id !== "string" || !id) {
      return { ok: false, error: "id 必须是非空字符串" };
    }
    return market.installFromMarket(id);
  });
  if (deps.onPluginRunningStateChange) {
    manager.onRunningStateChange(deps.onPluginRunningStateChange);
  }
  // 设置面板统一转发通道：主进程强制 sender 必须是面板宿主窗口（首版=设置
  // 窗口）；pluginId 语法与通道归属由路由器校验，面板无法构造跨插件通道
  deps.ipc.handle(
    IPC.PLUGINS_PANEL_INVOKE,
    (event: Electron.IpcMainInvokeEvent, pluginId: unknown, channel: unknown, args: unknown) => {
      if (typeof pluginId !== "string" || typeof channel !== "string" || !Array.isArray(args)) {
        return { ok: false, error: "面板调用参数格式非法" };
      }
      const host = deps.getPanelHostWebContents?.() ?? null;
      if (!host || event.sender !== host) {
        return { ok: false, error: "面板调用来源窗口不受信任" };
      }
      return router.dispatch({ pluginId, channel, args, caller: "panel" });
    },
  );
  // 设置面板静态资源协议：禁用插件立即 404，查询实时反映启停状态
  installPluginPanelProtocol((pluginId) => manager.getSettingsPanelDir(pluginId));
  await manager.start();
  return manager;
}
