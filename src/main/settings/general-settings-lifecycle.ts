import { app, nativeImage, type Tray } from "electron";
import { IPC } from "../../shared/ipc-channels";
import type { WindowManager } from "../windows/window-manager";
import { setGetCurrentAppIconPath } from "../windows/window-state";
import { updateLocaleContext } from "../locale-context";
import { validateSearchApiKey } from "../orchestrator/search-backend-filter";
import { addMcpServer, listMcpServers, removeMcpServer } from "../orchestrator/mcp-manager";
import { getAppIconPath } from "../app-icon";
import { syncBuiltInToolToggles } from "../orchestrator/tools/registry/tool-registration";
import { loadModelSettings, getPublicModelConfig } from "./model-settings";
import type { GeneralSettings } from "./general-settings";
import type { UiIcon } from "../../shared/ui-icon";
import { syncLaunchAtLogin } from "./launch-at-login";

export interface GeneralSettingsLifecycleDependencies {
  get windowManager(): WindowManager | null;
  get tray(): Tray | null;
  get screenshotService(): { replaceHotkey: (hotkey: string) => { ok: boolean } | null } | null;
  get proactiveLifecycle(): { getProactiveChatService: () => { invalidate: () => void } | null };
  broadcastToAuxWindows(channel: string, payload: unknown): void;
}

/** MiniMax 搜索 MCP Server 的固定 ID。 */
const MINIMAX_SEARCH_MCP_ID = "minimax-web-search";

export function applyGeneralSettings(
  settings: GeneralSettings,
  deps: GeneralSettingsLifecycleDependencies,
  before?: GeneralSettings,
): void {
  // 启动时完整应用；保存设置时只应用变化项，保留托盘临时隐藏等窗口状态。
  if (!before || before.petAlwaysOnTop !== settings.petAlwaysOnTop) {
    deps.windowManager?.setPetWindowAlwaysOnTop(settings.petAlwaysOnTop);
  }
  if (!before || before.petVisible !== settings.petVisible) {
    if (settings.petVisible) deps.windowManager?.showPetWindow();
    else deps.windowManager?.hidePetWindow();
  }
  if (!before || before.launchAtLogin !== settings.launchAtLogin) {
    syncLaunchAtLogin(settings.launchAtLogin, app);
  }
  if (!before || before.petZoom !== settings.petZoom) {
    deps.windowManager?.applyPetWindowZoom(settings.petZoom);
  }
}

export function applyUiIcon(iconSetting: UiIcon, deps: GeneralSettingsLifecycleDependencies): void {
  const icon = nativeImage.createFromPath(getAppIconPath(iconSetting));
  if (icon.isEmpty()) {
    console.warn("[Cyrene] failed to load selected app icon:", iconSetting);
    return;
  }
  deps.tray?.setImage(icon);
  deps.windowManager?.setIconForAllWindows(icon);
}

export async function syncVolcanoSearchMcp(settings: GeneralSettings): Promise<{ mcpSyncResult: string }> {
  const minimaxEnable = settings.searchEngine === "minimax";
  const minimaxExists = listMcpServers().some((s) => s.id === MINIMAX_SEARCH_MCP_ID);

  if (minimaxEnable) {
    const keyValidation = validateSearchApiKey(settings.searchMinimaxKey, "MiniMax API Key");
    console.log(`[Cyrene] MiniMax Key 校验: length=${keyValidation.diagnostics.length} trimmed=${keyValidation.diagnostics.trimmed} nonAscii=${keyValidation.diagnostics.hasNonAscii} controlChars=${keyValidation.diagnostics.hasControlChars}`);
    if (!keyValidation.valid) {
      console.error(`[Cyrene] MiniMax Key 校验失败: ${keyValidation.error}`);
      if (minimaxExists) {
        try { await removeMcpServer(MINIMAX_SEARCH_MCP_ID); } catch (err) { console.error("[Cyrene] MiniMax 搜索 MCP 移除异常:", err); }
      }
      return { mcpSyncResult: `key_invalid: ${keyValidation.error}` };
    }
  }

  if (minimaxEnable && !minimaxExists) {
    console.log("[Cyrene] 注册 MiniMax 搜索 MCP Server...");
    try {
      const result = await addMcpServer({
        id: MINIMAX_SEARCH_MCP_ID,
        name: "MiniMax搜索",
        transport: "stdio",
        command: "uvx",
        args: ["minimax-coding-plan-mcp", "-y"],
        env: {
          MINIMAX_API_KEY: settings.searchMinimaxKey.trim(),
          MINIMAX_API_HOST: "https://api.minimaxi.com",
        },
      });
      if (result.ok) {
        console.log("[Cyrene] MiniMax 搜索 MCP 注册成功，工具:", result.toolIds?.join(", "));
        return { mcpSyncResult: `registered: ${result.toolIds?.join(", ") ?? "none"}` };
      }
      console.error("[Cyrene] MiniMax 搜索 MCP 注册失败:", result.error);
      return { mcpSyncResult: `register_failed: ${result.error}` };
    } catch (err) {
      console.error("[Cyrene] MiniMax 搜索 MCP 注册异常:", err);
      return { mcpSyncResult: `register_exception: ${err}` };
    }
  } else if (!minimaxEnable && minimaxExists) {
    console.log("[Cyrene] 移除 MiniMax 搜索 MCP Server...");
    try { await removeMcpServer(MINIMAX_SEARCH_MCP_ID); return { mcpSyncResult: "removed" }; } catch (err) { console.error("[Cyrene] MiniMax 搜索 MCP 移除异常:", err); return { mcpSyncResult: `remove_exception: ${err}` }; }
  } else if (minimaxEnable && minimaxExists) {
    console.log("[Cyrene] MiniMax 搜索 key 变化，重新注册 MCP Server...");
    try {
      await removeMcpServer(MINIMAX_SEARCH_MCP_ID);
      await addMcpServer({
        id: MINIMAX_SEARCH_MCP_ID, name: "MiniMax搜索", transport: "stdio",
        command: "uvx",
        args: ["minimax-coding-plan-mcp", "-y"],
        env: { MINIMAX_API_KEY: settings.searchMinimaxKey.trim(), MINIMAX_API_HOST: "https://api.minimaxi.com" },
      });
      return { mcpSyncResult: "reregistered" };
    } catch (err) { console.error("[Cyrene] MiniMax 搜索 MCP 重新注册异常:", err); return { mcpSyncResult: `reregister_exception: ${err}` }; }
  }
  return { mcpSyncResult: "no_change" };
}

export function broadcastModelConfigChanged(
  broadcastToAuxWindows: (channel: string, payload: unknown) => void,
  settings = loadModelSettings(),
): void {
  broadcastToAuxWindows(IPC.MODEL_CONFIG_CHANGED, getPublicModelConfig(settings));
}

export function handleGeneralSettingsChanged(
  before: GeneralSettings,
  after: GeneralSettings,
  deps: GeneralSettingsLifecycleDependencies,
): void {
  applyGeneralSettings(after, deps, before);
  syncBuiltInToolToggles(after);
  if (before.language !== after.language || before.asrLanguage !== after.asrLanguage) {
    updateLocaleContext({
      uiLocale: after.language,
      dateLocale: after.language,
      asrLanguage: after.asrLanguage,
    });
  }
  if (before.uiTheme !== after.uiTheme) {
    deps.windowManager?.broadcast(IPC.UI_THEME_CHANGED, after.uiTheme);
  }
  if (before.uiThemeRadius !== after.uiThemeRadius) {
    deps.windowManager?.broadcast(IPC.UI_THEME_RADIUS_CHANGED, after.uiThemeRadius);
  }
  if (before.windowCornerRadius !== after.windowCornerRadius) {
    deps.windowManager?.broadcast(IPC.UI_WINDOW_CORNER_RADIUS_CHANGED, after.windowCornerRadius);
  }
  if (JSON.stringify(before.uiFont) !== JSON.stringify(after.uiFont)) {
    deps.windowManager?.broadcast(IPC.UI_FONT_CHANGED, after.uiFont);
  }
  if (before.uiIcon !== after.uiIcon) {
    applyUiIcon(after.uiIcon, deps);
  }
  if (before.screenshotHotkey !== after.screenshotHotkey) {
    const result = deps.screenshotService?.replaceHotkey(after.screenshotHotkey);
    if (result && !result.ok) {
      console.warn("[Cyrene] 截图热键注册失败，可能被其他应用占用:", after.screenshotHotkey);
    }
  }
  if (
    before.proactiveChatMode !== after.proactiveChatMode
    || before.proactiveDeliveryTarget !== after.proactiveDeliveryTarget
  ) {
    deps.proactiveLifecycle.getProactiveChatService()?.invalidate();
  }
  setGetCurrentAppIconPath(() => getAppIconPath(after.uiIcon));
  void syncVolcanoSearchMcp(after);
}
