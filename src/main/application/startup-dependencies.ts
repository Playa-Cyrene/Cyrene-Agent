import { setImmediate as yieldToEventLoop } from "node:timers/promises";
import { closeConversationDatabases } from "../storage/conversation-database-client";
import { app, dialog } from "electron";
import * as path from "path";
import { ensureGpuSandboxAcl } from "../gpu-sandbox-acl";
import { logger, LogTag } from "../logger";
import { renderBanner } from "../../shared/banner";
import { IPC } from "../../shared/ipc-channels";
import { isDev } from "../env";
import { loadGeneralSettings, saveGeneralSettings } from "../settings/settings-facade";
import { getCurrentAppIconPath, setGetCurrentAppIconPath } from "../windows/window-state";
import { loadModelSettings } from "../settings/model-settings";
import { registerWindowSystemIpc } from "../windows/window-system-ipc";
import {
  registerPrivilegedSchemes,
  registerProtocolHandlers,
} from "../protocols/bootstrap";
import { registerChatWindowIpc } from "../chats/chat-window-ipc";
import { flush as flushTokenUsage } from "../token-usage-store";
import { getAppIconPath } from "../app-icon";
import { installSingleInstanceGuard } from "../single-instance";
import { migrateLegacyUserData } from "../user-data-migration";
import { createWindowManager } from "../windows/window-manager";
import { createTray } from "../tray";
import { createSplashWindow } from "../startup/create-splash-window";
import { revealStartupWindows } from "../startup/startup-window-reveal";
import { createIpcScope } from "./ipc-scope";
import { createShutdownCoordinator } from "./shutdown";
import { createStartupReadiness } from "./readiness";
import { createWindowActivationBroker } from "./window-activation";
import { prepareBeforeReady } from "./pre-ready";
import { startShell } from "./shell-bootstrap";
import { checkStartupActive } from "./startup-cancellation";
import type { ApplicationDependencies } from "./application";
import { registerSurfaceSettingsIpc } from "../settings/surface-settings-ipc";
import { registerChatSurfaceIpc } from "../chats/chat-surface-ipc";
import { showInitialSurface } from "./core-bootstrap";

export function createDefaultApplicationDependencies(): ApplicationDependencies {
  const readiness = createStartupReadiness();
  const activation = createWindowActivationBroker();
  const shutdown = createShutdownCoordinator({ readiness, timeoutMs: 10_000 });
  shutdown.register({ id: "conversation-database", phase: "closePersistence", dispose: closeConversationDatabases });

  // 注入应用图标路径 getter（窗口工厂统一读取，避免循环依赖）。
  // 必须在 shell 阶段之前注入：聊天窗口壳与托盘在 shell 阶段创建时就会读取，
  // 若等到 core 阶段再注入，托盘会拿到空路径而显示 Electron 默认图标。
  // getter 为惰性求值，此处注册不触发磁盘读取。
  setGetCurrentAppIconPath(() => getAppIconPath(loadGeneralSettings().uiIcon));

  let chatHydrated!: () => void;
  const hydrated = new Promise<void>((resolve) => { chatHydrated = resolve; });
  let runtime: Pick<ApplicationDependencies, "startCore" | "startBackground">;
  return {
    app, dialog, readiness, activation, shutdown,
    prepare: () => prepareBeforeReady({
      installSingleInstance: (onSecondInstance) => installSingleInstanceGuard(app, onSecondInstance),
      migrateLegacyUserData: () => {
        return migrateLegacyUserData({
          appDataPath: app.getPath("appData"),
          targetUserDataPath: app.getPath("userData"),
        });
      },
      registerPrivilegedSchemes,
      configureGpuSwitches: () => {
        if (loadGeneralSettings().disableGpuElectron) {
          app.commandLine.appendSwitch("disable-gpu");
          app.commandLine.appendSwitch("enable-unsafe-swiftshader");
        }
      },
      ensureGpuSandboxAcl: () => ensureGpuSandboxAcl({
        isPackaged: app.isPackaged,
        exeDir: path.dirname(app.getPath("exe")),
        userDataDir: app.getPath("userData"),
      }),
      activation,
    }),

    startShell: () => startShell({
      readiness,
      activation,
      shutdown,
      writeStartupLog: () => {
        // banner 是纯文本（无色彩、无日志前缀），与 logger 输出区分开
        process.stdout.write("\n" + renderBanner() + "\n\n");
        logger.info(LogTag.Runtime, "starting Cyrene Agent");
      },
      createIpcScope: () => createIpcScope(),
      createSplashWindow: (options) => createSplashWindow({ isDev, onShown: options.onShown }),
      createWindowManager: () => createWindowManager({
        getCurrentAppIconPath,
        isDev,
        loadPetWindowSettingsSlice: loadGeneralSettings,
        persistPetWindowPosition: ({ x, y }) => saveGeneralSettings({ petWindowX: x, petWindowY: y }),
      }),
      createChatShell: (windowManager) => windowManager.createReactChatWindowShell(),
      registerProtocolHandlers,
      registerShellIpc: ({ ipc, windowManager }) => {
        // quit 由组合根注入：窗口系统 IPC 不直接依赖 electron app，且退出仍走受控链路。
        registerWindowSystemIpc({ ipc, windowManager, quit: () => app.quit() });
        registerChatWindowIpc(ipc, chatHydrated);
      },
      createTray: (input) => createTray({
        togglePetWindow: input.togglePetWindow,
        requestActivation: input.requestActivation,
        quit: () => app.quit(),
      }),
      flushTokenUsage,
    }),

    startCore: async (shell) => {
      const { ipc } = shell;
      ipc.handle(IPC.APP_RUNTIME_IPC_READY, () => readiness.waitFor("core-ready"));
      registerSurfaceSettingsIpc(ipc, { getGeneralSettings: loadGeneralSettings, getModelSettings: loadModelSettings });
      const surface = registerChatSurfaceIpc(ipc);
      const unregister = shutdown.register({ id: "startup-surface", phase: "quiesce", dispose: async () => {
        chatHydrated();
        await surface.initialized;
      } });
      try {
        await Promise.all([surface.initialized, showInitialSurface({
          shell, shutdown, loadGeneralSettings, revealStartupWindows, minimumSplashMs: 0,
          initialWindowShown: async (showingChat) => {
            if (!showingChat || shell.chat.window.isDestroyed()) return;
            const contents = shell.chat.window.webContents;
            if (!contents.isDestroyed() && !contents.isCrashed()) {
              // 页面仍存活却没有回报首屏时，后台渠道和调度器也要能启动。
              const timer = setTimeout(() => {
                console.warn("[Startup] 聊天首屏 5 秒内未报告就绪，继续启动运行时");
                chatHydrated();
              }, 5_000);
              contents.once("destroyed", chatHydrated);
              contents.once("render-process-gone", chatHydrated);
              try { await hydrated; } finally {
                clearTimeout(timer);
                contents.removeListener("destroyed", chatHydrated);
                contents.removeListener("render-process-gone", chatHydrated);
              }
            }
          },
        })]);
      } finally {
        unregister();
      }
      checkStartupActive(shutdown);
      // 让首屏发出的入队与窗口事件有机会先交给主进程。
      await yieldToEventLoop();
      checkStartupActive(shutdown);
      const { createRuntimeDependencies }: typeof import("./default-dependencies") = require("./default-dependencies");
      runtime = await createRuntimeDependencies({ readiness, activation, shutdown }, surface);
      return runtime.startCore(shell);
    },
    startBackground: (core) => runtime.startBackground(core),
    logFatal: (error) => {
      console.error("[Cyrene] fatal startup error:", error);
      logger.error(LogTag.Runtime, "fatal startup error:", error);
    },
  };
}
