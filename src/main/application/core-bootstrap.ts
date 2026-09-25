/**
 * Core 启动阶段（coreReady）：建立聊天可用所需的最小核心。
 * 按严格依赖顺序构造：迁移 → 技能 → 低成本服务 → 沙箱 → 计划模式 → 工具
 * → RAG（可降级）→ Agent Runtime → scheduler/channels（只装配不启动）
 * → 全部渲染进程可能调用的 IPC → 加载聊天页面 → 桌宠/辅助窗口 → core-ready
 * → reveal → 激活代理放行。
 * 技能/RAG/沙箱失败只记录降级；聊天页面加载失败是致命错误，向上抛出。
 */

import type { IpcScope } from "./ipc-scope";
import type { StartupReadiness } from "./readiness";
import type { ShutdownCoordinator } from "./shutdown";
import type { WindowActivationBroker } from "./window-activation";
import type { ShellResult } from "./shell-bootstrap";
import type { RevealStartupWindowsOptions } from "../startup/startup-window-reveal";
import type { AgentRuntime } from "../orchestrator/agent-runtime";
import type { RuntimeStateService } from "../orchestrator/runtime-state-service";
import type { TtsSynthesisService } from "../services/tts/tts-synthesis-service";
import type { TtsSessionService } from "../tts/tts-session-service";
import type { EmbeddingIndexService } from "../services/embedding/embedding-index-service";
import type { ProactiveLifecycle } from "../proactive/proactive-lifecycle";
import type { GitService } from "../code-git/git-service";
import type { LspManager } from "../lsp/manager";
import type { ScreenshotService } from "../screenshot/screenshot-lifecycle";
import type { MusicBootstrap } from "../music/bootstrap";
import type { AppUpdateService } from "../updater/app-update-service";
import type { LlmClient } from "../services/llm/llm-client";
import type { CitaService } from "../cita";
import type { SocialContextService } from "../services/social-context/social-context-service";
import type { ChannelsSubsystem } from "../channels/bootstrap";
import type { SchedulerSubsystem } from "../scheduler/bootstrap";
import type { GeneralSettings } from "../settings/general-settings";
import type { WindowManager } from "../windows/window-manager";
import type { PluginManager } from "../../plugins/manager";

export interface CoreServices {
  runtimeState: RuntimeStateService;
  llm: LlmClient;
  cita: CitaService;
  social: SocialContextService;
  tts: TtsSynthesisService;
  ttsSession: TtsSessionService;
  embedding: EmbeddingIndexService;
  proactive: ProactiveLifecycle;
  git: GitService;
  lsp: LspManager;
  screenshot: ScreenshotService;
  music: MusicBootstrap;
  update: AppUpdateService;
}

export interface CoreResult {
  runtime: AgentRuntime;
  services: CoreServices;
  channels: ChannelsSubsystem;
  plugins: PluginManager;
  scheduler: SchedulerSubsystem;
}

export interface RegisterCoreIpcInput {
  ipc: IpcScope;
  runtime: AgentRuntime;
  services: CoreServices;
  channels: ChannelsSubsystem;
  scheduler: SchedulerSubsystem;
}

export interface CoreDependencies {
  shell: ShellResult;
  readiness: StartupReadiness;
  activation: WindowActivationBroker;
  shutdown: ShutdownCoordinator;
  migrateStagedExternalContent(): void;
  initSkills(): void | Promise<void>;
  /** 低成本服务与配置 getter；只构造，不建立网络连接。 */
  createLowCostServices(): CoreServices;
  initSandbox(): void | Promise<void>;
  initPlanMode(): void;
  registerAllTools(services: CoreServices): void;
  initRag(): Promise<void>;
  createRuntime(services: CoreServices): AgentRuntime;
  createChannels(runtime: AgentRuntime, services: CoreServices): ChannelsSubsystem;
  /** 必须在内置渠道适配器注册完成后调用；scheduler 先于本步完成 initialize。 */
  startPlugins(services: CoreServices, scheduler: SchedulerSubsystem, runtime: AgentRuntime): Promise<PluginManager>;
  createScheduler(runtime: AgentRuntime, services: CoreServices): SchedulerSubsystem;
  registerCoreIpc(input: RegisterCoreIpcInput): void;
  /** 组合根装配提醒中心：注册 toast IPC、订阅事件总线、预创建隐藏窗口。 */
  wireToastCenter(input: { ipc: IpcScope; windowManager: WindowManager }): void;
  loadGeneralSettings(): GeneralSettings;
  /** 启动期一次性应用通用设置（登录项同步、桌宠偏好等）。 */
  applyGeneralSettings(settings: GeneralSettings, services: CoreServices): void;
  revealStartupWindows(input: RevealStartupWindowsOptions): Promise<void>;
  /** Loading 最短展示时长（ms）。 */
  minimumSplashMs: number;
  /** 放行启动期间 pending 的辅助窗口（window-state 的 STARTUP_READY）。 */
  markStartupWindowsReady(): void;
}

function degradedMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// 启动耗时埋点：无条件打印各阶段耗时与结束时刻（相对进程启动），供启动性能排查
async function timedStep<T>(name: string, fn: () => T | Promise<T>): Promise<T> {
  const start = performance.now();
  try {
    return await fn();
  } finally {
    const end = performance.now();
    console.log(`[StartupTiming] core/${name} ${Math.round(end - start)}ms (at ${Math.round(end)}ms)`);
  }
}

export async function startCore(deps: CoreDependencies): Promise<CoreResult> {
  const { shell, readiness, activation, shutdown } = deps;

  // 升级迁移：必须在任何 prompts/skills 读取之前
  deps.migrateStagedExternalContent();

  // Skill 系统：失败只降级，不阻塞聊天
  try {
    await timedStep("initSkills", () => deps.initSkills());
  } catch (error) {
    console.error("[Core] initSkills failed:", error);
    readiness.markDegraded({ capability: "skills", message: degradedMessage(error), at: Date.now(), error });
  }

  // 低成本服务（runtimeState/tts/embedding/proactive/git/lsp/screenshot/music/update）
  const services = deps.createLowCostServices();

  // SRT 沙箱：失败不阻塞启动（fallback 到直接 spawn）
  try {
    await timedStep("initSandbox", () => deps.initSandbox());
  } catch (error) {
    console.error("[Core] initSandbox failed at startup:", error);
    readiness.markDegraded({ capability: "sandbox", message: degradedMessage(error), at: Date.now(), error });
  }

  deps.initPlanMode();
  deps.registerAllTools(services);

  // RAG：失败记录降级，聊天仍允许启动
  try {
    await timedStep("initRag", () => deps.initRag());
  } catch (error) {
    console.error("[Core] RAG init FAILED:", error);
    readiness.markDegraded({ capability: "rag", message: degradedMessage(error), at: Date.now(), error });
  }

  const runtime = deps.createRuntime(services);

  // channels 只装配并同步注册内置 adapter；网络启动仍在 background 阶段。
  const channels = deps.createChannels(runtime, services);
  await timedStep("channels-adapters", async () => {
    channels.initialize();
    await channels.adaptersRegistered;
  });

  // scheduler store 先加载并注册 IPC，再启动插件：插件调度服务写入的是
  // 已加载的 store，不会覆盖磁盘任务；插件启停联动也在此时接线。
  const scheduler = deps.createScheduler(runtime, services);
  scheduler.initialize();

  // 插件严格晚于内置 adapter id 预留，避免插件抢占 feishu/wechat/qq 等内置 id。
  const plugins = await timedStep("startPlugins", () => deps.startPlugins(services, scheduler, runtime));

  // 注册聊天渲染进程可能调用的全部 IPC 处理器 —— 必须先于 chat.load()
  deps.registerCoreIpc({ ipc: shell.ipc, runtime, services, channels, scheduler });

  // 提醒中心装配：IPC 注册先于 toast 窗口预加载（渲染页加载即可能 invoke getAll）
  deps.wireToastCenter({ ipc: shell.ipc, windowManager: shell.windowManager });

  // 全部处理器就绪后才加载聊天页面；页面加载失败属于致命错误（向上抛出）
  await timedStep("chat-load", () => shell.chat.load());

  // 桌宠：窗口始终创建，petVisible 只决定是否显示（隐藏时不闪现）。
  // 始终创建是为了保证托盘"显示/隐藏桌宠"与设置面板开关随时能把窗口救回来，
  // 且 alwaysOnTop / zoom / live2d 生命周期在隐藏状态下同样完成接线。
  const generalSettings = deps.loadGeneralSettings();
  // 启动期一次性完整应用通用设置（登录项同步等）；此时桌宠未创建，show/hide 为 no-op
  deps.applyGeneralSettings(generalSettings, services);
  // showOnReady=petVisible：页面就绪才显示，避免空窗口闪现；创建本身在核心 IPC 注册之后
  shell.windowManager.createPetWindow(generalSettings.petVisible);
  shell.windowManager.onPetWindowReady((win) => {
    shell.live2dWindowLifecycle.attach(win);
  });
  shell.windowManager.onPetWindowClosed(() => {
    shell.live2dWindowLifecycle.clear();
  });
  shell.windowManager.setPetWindowAlwaysOnTop(generalSettings.petAlwaysOnTop);
  shell.windowManager.applyPetWindowZoom(generalSettings.petZoom);

  // 注册核心资源清理（固定阶段）；scheduler/proactive/更新定时器由 background 注册
  shutdown.register({
    id: "plugins",
    phase: "stopActiveWork",
    dispose: async () => { await plugins.stop(); },
  });
  shutdown.register({
    id: "channels",
    phase: "stopExternalConsumers",
    dispose: async () => { await channels.shutdown(); },
  });
  shutdown.register({
    id: "screenshot",
    phase: "stopLocalResources",
    dispose: async () => { await services.screenshot.shutdown(); },
  });
  shutdown.register({
    id: "lsp",
    phase: "stopLocalResources",
    dispose: async () => { await services.lsp.disposeAll(); },
  });
  shutdown.register({
    id: "git",
    phase: "stopLocalResources",
    dispose: async () => { await services.git.dispose(); },
  });
  shutdown.register({
    id: "music",
    phase: "stopLocalResources",
    dispose: async () => { await services.music.shutdown(); },
  });

  readiness.transition("core-ready");

  // 等待最短展示剩余时长 → 关 Loading → 显示聊天 → 放行 pending 辅助窗口
  await deps.revealStartupWindows({
    splashWindow: shell.splashWindow,
    chatWindow: shell.chat.window,
    loadingShownAt: shell.loadingShownAt,
    minimumDurationMs: deps.minimumSplashMs,
  });
  // 窗口已对用户可见的时刻锚点：在此之后打印结束的后台任务，都是“窗口出来后还在跑”的部分
  console.log(`[StartupTiming] core/windows-revealed (at ${Math.round(performance.now())}ms)`);
  deps.markStartupWindowsReady();

  // 主窗口可激活：消费启动期间排队的激活请求
  await activation.markReady();
  console.log(`[StartupTiming] core/startCore-total ${Math.round(performance.now())}ms`);

  return { runtime, services, channels, plugins, scheduler };
}
