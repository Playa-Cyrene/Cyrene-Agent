import { app, BrowserWindow, dialog, shell } from "electron";
import * as fs from "fs";
import * as path from "path";
import { randomUUID } from "crypto";
import { IPC } from "../../shared/ipc-channels";
import { createIpcScope, type IpcScope } from "../application/ipc-scope";
import { DEFAULT_UI_FONT, isSupportedFontFileName } from "../../shared/ui-font";
import type { GeneralSettings } from "./general-settings";
import type { TimeoutSettings } from "../../shared/timeout-types";
import { ensureCustomStylePrompt } from "../style-prompt";
import type { WindowManager } from "../windows/window-manager";
import {
  reactChatWindow,
  sidebarWindow,
  tasksWindow,
  settingsWindow,
} from "../windows/window-state";
import type { RuntimeStateService } from "../orchestrator/runtime-state-service";
import type { EmbeddingIndexService } from "../services/embedding/embedding-index-service";
import { initReranker, getRerankerInstallStatus } from "../rag/reranker";
import { switchEmbeddingModel } from "../rag";
import { testVendorConnection } from "../orchestrator/vendors/test-connection";
import type { VendorConfig } from "../orchestrator/vendors";
import { normalizeModelSettings, getPublicModelConfig, listSavedModelProfiles, saveModelProfile, setDefaultModelProfile, saveModelSettings } from "./model-settings";
import type { ModelSettings } from "./model-settings";
import { getTimeoutSettings, saveTimeoutSettings } from "../timeout-manager";
import type { syncVolcanoSearchMcp } from "./general-settings-lifecycle";
import type { syncPlaywrightMcp } from "../sync-mcp-builtin";

export interface SettingsIpcDependencies {
  get windowManager(): WindowManager | null;
  getGeneralSettings: () => GeneralSettings;
  saveGeneralSettings: (settings: Partial<GeneralSettings>) => GeneralSettings;
  getModelSettings: () => ModelSettings;
  saveModelSettings: (settings: Partial<ModelSettings>) => ModelSettings;
  runtimeStateService: RuntimeStateService;
  proactiveLifecycle: { getProactiveChatService: () => { invalidate: () => void } | null };
  reconcileUserMemoryIndex: () => Promise<void>;
  embeddingIndexService: EmbeddingIndexService;
  syncVolcanoSearchMcp: typeof syncVolcanoSearchMcp;
  syncPlaywrightMcp: typeof syncPlaywrightMcp;
  /** 传入共享 scope 以便退出时统一注销；缺省时使用独立 scope。 */
  ipc?: IpcScope;
}

function getUiFontsDir(): string {
  return path.join(app.getPath("userData"), "ui-fonts");
}

function getCustomFontDisplayName(filePath: string): string {
  return (
    path.basename(filePath, path.extname(filePath)).replace(/[-_]+/g, " ").trim().slice(0, 80) || "自定义字体"
  );
}

const VISION_TEST_IMAGE_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAIAAAD8GO2jAAAAJ0lEQVR42u3NsQkAAAjAsP7/tF7hIASyp6lTCQQCgUAgEAgEgi/BAjLD/C5w/SM9AAAAAElFTkSuQmCC";

export function registerSettingsIpc(deps: SettingsIpcDependencies): void {
  const ipc = deps.ipc ?? createIpcScope();
  const {
    getGeneralSettings,
    saveGeneralSettings,
    getModelSettings,
    saveModelSettings,
    runtimeStateService,
    proactiveLifecycle,
    reconcileUserMemoryIndex,
    embeddingIndexService,
    syncVolcanoSearchMcp,
    syncPlaywrightMcp,
  } = deps;
  // 注意：windowManager 不解构，统一用 deps.windowManager 实时读取 getter。
  // registerSettingsIpc 在模块加载阶段调用，那时 windowManager 仍为 null，
  // 解构会捕获 null 并导致后续 ?. 永远短路（设置里的打开侧边栏/日程等会失效）。

  function broadcastToAuxWindows(channel: string, payload: unknown): void {
    for (const win of [reactChatWindow, sidebarWindow, tasksWindow, settingsWindow]) {
      if (win && !win.isDestroyed()) {
        win.webContents.send(channel, payload);
      }
    }
  }

  function broadcastModelConfigChanged(settings = getModelSettings()): void {
    broadcastToAuxWindows(IPC.MODEL_CONFIG_CHANGED, getPublicModelConfig(settings));
  }

  function broadcastRuntimeStateChanged(): void {
    broadcastToAuxWindows(IPC.RUNTIME_STATE_CHANGED, runtimeStateService.getState());
  }

  ipc.handle(IPC.SETTINGS_GET_CONFIG, () => getModelSettings());
  ipc.handle(IPC.SETTINGS_MODEL_PROFILES_LIST, () => ({
    profiles: listSavedModelProfiles(getModelSettings()),
    defaultModelProfileId: getModelSettings().defaultModelProfileId,
  }));
  ipc.handle(IPC.SETTINGS_MODEL_PROFILE_SAVE, (_event, profile) => {
    const saved = saveModelProfile(profile as Parameters<typeof saveModelProfile>[0]);
    if (saved.added && saved.settings.defaultModelProfileId === saved.settings.modelProfiles?.at(-1)?.id) {
      broadcastModelConfigChanged(saved.settings);
    }
    return { added: saved.added, profiles: listSavedModelProfiles(saved.settings), defaultModelProfileId: saved.settings.defaultModelProfileId };
  });
  ipc.handle(IPC.SETTINGS_MODEL_PROFILE_DELETE, (_event, id: unknown) => {
    if (typeof id !== "string") return null;
    const settings = getModelSettings();
    const profiles = listSavedModelProfiles(settings).filter((profile) => profile.id !== id);
    const defaultModelProfileId = settings.defaultModelProfileId === id ? profiles[0]?.id : settings.defaultModelProfileId;
    const saved = saveModelSettings({ modelProfiles: profiles, defaultModelProfileId });
    broadcastModelConfigChanged(saved);
    return { profiles: listSavedModelProfiles(saved), defaultModelProfileId: saved.defaultModelProfileId };
  });
  ipc.handle(IPC.SETTINGS_MODEL_PROFILE_SET_DEFAULT, (_event, id: unknown) => {
    if (typeof id !== "string") return null;
    const saved = setDefaultModelProfile(id);
    broadcastModelConfigChanged(saved);
    return { profiles: listSavedModelProfiles(saved), defaultModelProfileId: saved.defaultModelProfileId };
  });

  ipc.handle(IPC.SETTINGS_GET_GENERAL, () => getGeneralSettings());

  ipc.handle(IPC.SETTINGS_GET_TIMEOUT_SETTINGS, () => getTimeoutSettings());

  ipc.handle(IPC.SETTINGS_SAVE_TIMEOUT_SETTINGS, (_event, settings: Partial<TimeoutSettings>) =>
    saveTimeoutSettings(settings),
  );

  ipc.handle(IPC.UI_THEME_GET, () => getGeneralSettings().uiTheme);

  ipc.handle(IPC.UI_THEME_RADIUS_GET, () => getGeneralSettings().uiThemeRadius);

  ipc.handle(IPC.UI_WINDOW_CORNER_RADIUS_GET, () => getGeneralSettings().windowCornerRadius);

  ipc.handle(IPC.UI_FONT_GET, () => getGeneralSettings().uiFont);

  ipc.handle(IPC.SETTINGS_PICK_UI_FONT, async () => {
    const result = await dialog.showOpenDialog({
      properties: ["openFile"],
      filters: [{ name: "字体文件", extensions: ["ttf", "otf"] }],
    });
    return result.canceled ? null : result.filePaths[0] ?? null;
  });

  ipc.handle(IPC.SETTINGS_IMPORT_UI_FONT, (_event, sourcePath: unknown) => {
    if (typeof sourcePath !== "string" || !sourcePath) throw new Error("未选择字体文件");
    const extension = path.extname(sourcePath).toLowerCase();
    if (extension !== ".ttf" && extension !== ".otf") throw new Error("仅支持 .ttf 或 .otf 字体文件");
    const stat = fs.statSync(sourcePath);
    if (!stat.isFile() || stat.size <= 0 || stat.size > 50 * 1024 * 1024) throw new Error("字体文件无效或超过 50 MB");

    const fileName = `custom-${randomUUID()}${extension}`;
    if (!isSupportedFontFileName(fileName)) throw new Error("字体文件名无效");
    const fontsDir = getUiFontsDir();
    fs.mkdirSync(fontsDir, { recursive: true });
    const targetPath = path.join(fontsDir, fileName);
    fs.copyFileSync(sourcePath, targetPath);

    const before = getGeneralSettings().uiFont;
    const saved = saveGeneralSettings({
      uiFont: { kind: "custom", fileName, displayName: getCustomFontDisplayName(sourcePath) },
    });
    if (before.kind === "custom" && before.fileName !== fileName) {
      const oldPath = path.join(fontsDir, before.fileName);
      if (isSupportedFontFileName(before.fileName)) fs.rmSync(oldPath, { force: true });
    }
    return saved.uiFont;
  });

  ipc.handle(IPC.SETTINGS_RESET_UI_FONT, () => {
    const before = getGeneralSettings().uiFont;
    const saved = saveGeneralSettings({ uiFont: DEFAULT_UI_FONT });
    if (before.kind === "custom" && isSupportedFontFileName(before.fileName)) {
      fs.rmSync(path.join(getUiFontsDir(), before.fileName), { force: true });
    }
    return saved.uiFont;
  });

  ipc.handle(IPC.SETTINGS_SAVE_GENERAL, (_event, settings: Partial<GeneralSettings>) => {
    const saved = saveGeneralSettings(settings);
    if ("proactiveChatMode" in settings || "proactiveDeliveryTarget" in settings) {
      proactiveLifecycle.getProactiveChatService()?.invalidate();
    }
    return saved;
  });

  // TTS 面板调用的通用设置读写入口（历史命名遗留）
  ipc.handle(IPC.TTS_LOAD_SETTINGS, () => getGeneralSettings());

  ipc.handle(IPC.TTS_SAVE_SETTINGS, async (_event, tts: Partial<GeneralSettings>) => {
    const before = getGeneralSettings();
    const saved = saveGeneralSettings({ ...before, ...tts });

    // 搜索 MCP 自动注册/移除：选 MiniMax+有key→注册，否则→移除
    const searchConfigChanged = "searchMinimaxKey" in tts || "searchEngine" in tts;
    if (searchConfigChanged) {
      await syncVolcanoSearchMcp(saved);
    }

    // Playwright MCP：按 settings 字段自动连接/断开
    if ("playwrightMcpEnabled" in tts) {
      await syncPlaywrightMcp(saved);
    }

    // 主动聊天总开关变化时使现有评估失效（频率档位由 ProactiveChat 内部判定，无需重启）。
    if ("proactiveChatMode" in tts) {
      proactiveLifecycle.getProactiveChatService()?.invalidate();
    }

    // 返回不含密钥明文的副本（前端展示用）
    return saved;
  });

  ipc.handle(IPC.SETTINGS_OPEN_CUSTOM_STYLE_PROMPT, async () => {
    const filePath = ensureCustomStylePrompt();
    await shell.showItemInFolder(filePath);
    return { ok: true, filePath };
  });

  ipc.on(IPC.SETTINGS_OPEN_SIDEBAR, () => {
    deps.windowManager?.createSidebarWindow();
  });

  ipc.on(IPC.SETTINGS_CLOSE_SIDEBAR, async () => {
    sidebarWindow?.close();
  });

  ipc.on(IPC.SETTINGS_OPEN_TASKS, () => {
    deps.windowManager?.createTasksWindow();
  });

  ipc.on(IPC.SETTINGS_CLOSE_TASKS, async () => {
    tasksWindow?.close();
  });

  ipc.on(IPC.SETTINGS_SET_PET_ALWAYS_ON_TOP, (_event, value: boolean) => {
    const saved = saveGeneralSettings({ ...getGeneralSettings(), petAlwaysOnTop: Boolean(value) });
    deps.windowManager?.setPetWindowAlwaysOnTop(saved.petAlwaysOnTop);
  });

  ipc.on(IPC.SETTINGS_SET_PET_VISIBLE, (_event, value: boolean) => {
    saveGeneralSettings({ ...getGeneralSettings(), petVisible: Boolean(value) });
  });

  ipc.on(IPC.SETTINGS_SET_PET_ZOOM, (_event, value: number) => {
    const saved = saveGeneralSettings({ ...getGeneralSettings(), petZoom: Number(value) });
    deps.windowManager?.applyPetWindowZoom(saved.petZoom);
  });

  ipc.handle(IPC.MODEL_CONFIG_GET, () => getPublicModelConfig());

  ipc.handle(IPC.RUNTIME_STATE_GET, () => runtimeStateService.getState());

  ipc.handle(IPC.SETTINGS_SAVE_CONFIG, (_event, settings: Partial<ModelSettings>) => {
    const saved = saveModelSettings(settings);
    broadcastModelConfigChanged(saved);
    return saved;
  });

  ipc.handle(IPC.SETTINGS_TEST_CONNECTION, async (_event, cfg: VendorConfig) => testVendorConnection(cfg));

  /**
   * 测试视觉模型连通性。
   * 用一张 32x32 纯红 PNG（约 100 字节 base64）做测试图——纯色位图所有视觉模型都能识别，
   * 比 SVG 兼容性好（SVG 是矢量，部分模型不支持）。
   * 32x32 是折中：足够小保持 payload 轻，又满足千问等厂商对图片长宽 > 10 像素的限制。
   * 验连通性（HTTP 2xx + 有内容返回）而非对答案——模型可能只说"一张红色图片"也算成功。
   */
  ipc.handle(
    IPC.SETTINGS_TEST_VISION,
    async (_event, cfg: { baseUrl: string; apiKey: string; model: string }) => {
      const start = Date.now();
      console.log("[Cyrene] test vision: model=" + cfg.model + " url=" + cfg.baseUrl);
      try {
        const { captionImage } = await import("../orchestrator/vision-captioner");
        const result = await captionImage(
          { base64: VISION_TEST_IMAGE_BASE64, mime: "image/png" },
          "这张图是什么颜色？用一个词回答。",
          { baseUrl: cfg.baseUrl, apiKey: cfg.apiKey, model: cfg.model },
        );
        const latency = Date.now() - start;
        if (result.startsWith("[错误")) {
          return { ok: false, latency, error: result };
        }
        return { ok: true, latency, sample: result.slice(0, 80) };
      } catch (e) {
        return { ok: false, latency: Date.now() - start, error: e instanceof Error ? e.message : String(e) };
      }
    },
  );

  ipc.handle(IPC.EMBEDDING_SET_MODEL, async (_event, modelKey: string) => {
    console.log("[Cyrene] embedding model switch requested:", modelKey);
    try {
      const result = await switchEmbeddingModel(modelKey);
      if (result.ok) {
        await reconcileUserMemoryIndex();
        saveModelSettings({ embeddingModel: "bgem3" });
        broadcastModelConfigChanged();
        embeddingIndexService.invalidateStickerEmbeddingIndex();
        embeddingIndexService.refreshStickerEmbeddingIndex("embedding-model-switch");
      }
      return result;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error("[Cyrene] embedding model switch failed:", message);
      return { ok: false, clearedEntries: 0, error: message };
    }
  });

  ipc.handle(IPC.RERANKER_SET_MODE, async (_event, mode: "standard" | "none") => {
    const current = getModelSettings();
    saveModelSettings({ ...current, rerankerMode: mode });
    await initReranker(mode);
    console.log("[Cyrene] reranker mode switched to", mode);
    return true;
  });

  ipc.handle(IPC.RERANKER_GET_STATUS, () => getRerankerInstallStatus());

  ipc.handle(IPC.MODEL_GET_INSTALL_STATUS, () => {
    const { getModelInstallStatus } = require("../rag/model-status");
    return getModelInstallStatus();
  });

  ipc.handle(IPC.OPEN_EXTERNAL, async (_event, url: string) => {
    if (!url.startsWith("http://") && !url.startsWith("https://")) {
      return { ok: false, error: "Invalid URL" };
    }
    try {
      await shell.openExternal(url);
      return { ok: true };
    } catch (err) {
      return { ok: false, error: String(err) };
    }
  });

  ipc.on(IPC.SETTINGS_PREVIEW_RUNTIME_SYNC, (_event, value: "off" | "local" | "llm") => {
    const current = getModelSettings();
    const preview = normalizeModelSettings({
      ...current,
      runtimeSync: value === "llm" ? "llm" : value === "local" ? "local" : "off",
    });
    broadcastModelConfigChanged(preview);
  });
}
