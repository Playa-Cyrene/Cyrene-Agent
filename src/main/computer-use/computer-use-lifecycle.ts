import * as fs from "node:fs";
import * as path from "node:path";
import { spawn } from "node:child_process";
import { app, globalShortcut, Notification, type BrowserWindow } from "electron";
import { toolRegistry } from "../orchestrator/tools/registry/tool-registry";
import { captionImage } from "../orchestrator/vision-captioner";
import { getCurrentLevel, requestApproval } from "../permission";
import { loadModelSettings, resolveModelSettingsProfile } from "../settings/model-settings";
import { COMPUTER_TOOL_IDS, createComputerTools } from "./computer-tools";
import { ComputerUsePermission } from "./computer-use-permission";
import { resolveComputerViewing, type ComputerUseImageMode } from "./computer-viewing";
import { ComputerHelperClient } from "./helper-client";
import { resolveComputerHelperPath } from "./helper-path";
import { setComputerUseConversationRelease } from "./conversation-release";

/** 急停快捷键。只在功能开启时注册；不与系统保留组合（Ctrl+Alt+Del、Ctrl+Shift+Esc）冲突。 */
export const COMPUTER_USE_EMERGENCY_STOP_ACCELERATOR = "Control+Alt+Escape";
/** 隐藏悬浮层后等待桌面重新合成，否则截图里可能还留着半透明的桌宠。 */
const OVERLAY_SETTLE_MS = 120;

export interface ComputerUseSettingsSlice {
  computerUseEnabled: boolean;
  computerUseImageMode: ComputerUseImageMode;
}

export interface ComputerUseService {
  /** 同步设置；关闭时立即停掉 helper、撤销授权、注销急停快捷键。 */
  applySettings(settings: ComputerUseSettingsSlice): void;
  /** 会话删除时删掉它的截图并撤销授权。 */
  releaseConversation(conversationId: string): void;
  /** 受控退出：停掉 helper，同步删除本次运行产生的全部截图。 */
  shutdown(): void;
}

export interface ComputerUseOptions {
  settings: ComputerUseSettingsSlice;
  outputDirectory: string;
  /** 截图与指针动作期间需要隐藏的悬浮窗口（Live2D 桌宠等）；聊天和设置窗口不在其中。 */
  getOverlayWindows(): BrowserWindow[];
}

/** 注册 computer use 工具。helper 进程按需启动：功能关闭或从未调用时不会有任何进程。 */
export function initializeComputerUse(options: ComputerUseOptions): ComputerUseService {
  const { outputDirectory } = options;
  let settings = options.settings;
  let shortcutRegistered = false;
  const screenshotsByConversation = new Map<string, Set<string>>();

  const client = new ComputerHelperClient({
    spawnImpl: (command, args) => {
      // WIC 不会创建父目录；清理软件删掉 userData 子目录后必须能自愈。
      fs.mkdirSync(outputDirectory, { recursive: true });
      return spawn(command, args, { stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    },
    resolveHelperPath: () => resolveComputerHelperPath({
      isPackaged: app.isPackaged,
      appPath: app.getAppPath(),
      resourcesPath: process.resourcesPath,
      envOverride: process.env.CYRENE_COMPUTER_HELPER_PATH,
    }),
    outputDirectory,
    logger: console,
  });

  const permission = new ComputerUsePermission({
    getLevel: getCurrentLevel,
    requestSessionGrant: ({ runId, description }) => requestApproval({
      toolId: "computer_use_session",
      toolName: "桌面操作（本会话授权）",
      toolDescription: description,
      args: {},
      risk: "input-control",
      runId,
    }),
  });

  // 嵌套计数：两个会话的动作交错时，只有最外层负责恢复窗口。
  let overlayDepth = 0;
  let hiddenOverlays: BrowserWindow[] = [];
  async function withOverlaysHidden<T>(action: () => Promise<T>): Promise<T> {
    if (overlayDepth++ === 0) {
      hiddenOverlays = options.getOverlayWindows().filter((window) => !window.isDestroyed() && window.isVisible());
      for (const window of hiddenOverlays) window.hide();
      if (hiddenOverlays.length > 0) await new Promise((resolve) => setTimeout(resolve, OVERLAY_SETTLE_MS));
    }
    try {
      return await action();
    } finally {
      if (--overlayDepth === 0) {
        // showInactive：恢复桌宠时不能抢走刚被点击窗口的焦点，否则紧接着的输入会打到桌宠上。
        for (const window of hiddenOverlays) if (!window.isDestroyed()) window.showInactive();
        hiddenOverlays = [];
      }
    }
  }

  const tools = createComputerTools({
    client,
    authorize: (ctx, action) => permission.authorize(ctx, action),
    resolveViewing: () => resolveComputerViewing(settings.computerUseImageMode,
      resolveModelSettingsProfile(loadModelSettings())),
    askVision: async (image, instruction) => {
      const model = resolveModelSettingsProfile(loadModelSettings()).vision;
      if (!model?.baseUrl || !model.apiKey || !model.model) return "[错误·配置] 没有配置视觉模型。";
      return captionImage(image, "", { baseUrl: model.baseUrl, apiKey: model.apiKey, model: model.model }, { instruction });
    },
    withOverlaysHidden,
    onScreenshotCaptured: (conversationId, fileName) => {
      let files = screenshotsByConversation.get(conversationId);
      if (!files) screenshotsByConversation.set(conversationId, files = new Set());
      files.add(fileName);
    },
  });
  for (const tool of tools) toolRegistry.register(tool);

  function deleteScreenshots(conversationId: string): void {
    const files = screenshotsByConversation.get(conversationId);
    if (!files) return;
    screenshotsByConversation.delete(conversationId);
    for (const fileName of files) {
      try {
        fs.rmSync(path.join(outputDirectory, fileName), { force: true });
      } catch (error) {
        // 删除失败的文件由下次启动时的清理兜底。
        console.warn("[ComputerUse] 删除截图失败:", fileName, error);
      }
    }
  }

  function emergencyStop(): void {
    console.warn("[ComputerUse] 紧急停止：撤销全部会话授权并结束 helper");
    permission.emergencyStop();
    client.shutdown("EMERGENCY_STOP");
    if (Notification.isSupported()) {
      new Notification({ title: "桌面操作已停止", body: "已取消尚未执行的桌面动作，并撤销所有会话的授权。" }).show();
    }
  }

  function setShortcut(enabled: boolean): void {
    if (enabled && !shortcutRegistered) {
      shortcutRegistered = globalShortcut.register(COMPUTER_USE_EMERGENCY_STOP_ACCELERATOR, emergencyStop);
      if (!shortcutRegistered) {
        console.warn("[ComputerUse] 急停快捷键注册失败（可能被其他程序占用）:", COMPUTER_USE_EMERGENCY_STOP_ACCELERATOR);
      }
    } else if (!enabled && shortcutRegistered) {
      globalShortcut.unregister(COMPUTER_USE_EMERGENCY_STOP_ACCELERATOR);
      shortcutRegistered = false;
    }
  }

  const applySettings = (next: ComputerUseSettingsSlice): void => {
    settings = next;
    // 只在 Windows 上可用：helper 依赖 Win32 输入与截图接口。
    const enabled = next.computerUseEnabled && process.platform === "win32";
    setShortcut(enabled);
    // 急停是授权的前提：快捷键注册失败时不提供桌面工具，避免出现无法打断的桌面操作。
    const available = enabled && shortcutRegistered;
    for (const id of COMPUTER_TOOL_IDS) toolRegistry.setEnabled(id, available);
    if (!available) {
      client.shutdown();
      permission.revoke();
    }
  };
  applySettings(settings);

  const releaseConversation = (conversationId: string): void => {
    permission.revoke(conversationId);
    deleteScreenshots(conversationId);
  };
  setComputerUseConversationRelease(releaseConversation);

  activeService = {
    applySettings,
    releaseConversation,
    shutdown: () => {
      setComputerUseConversationRelease(undefined);
      setShortcut(false);
      client.shutdown();
      for (const conversationId of [...screenshotsByConversation.keys()]) deleteScreenshots(conversationId);
    },
  };
  return activeService;
}

let activeService: ComputerUseService | undefined;

/** 设置变更后同步；服务尚未初始化（例如测试环境）时无事可做。 */
export function applyComputerUseSettings(settings: ComputerUseSettingsSlice): void {
  activeService?.applySettings(settings);
}
