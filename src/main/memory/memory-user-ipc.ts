import { dialog } from "electron";
import * as fs from "fs";
import * as path from "path";
import { IPC } from "../../shared/ipc-channels";
import { createIpcScope, type IpcScope } from "../application/ipc-scope";
import { getStickerManagerConfig, setStickerEnabled } from "../orchestrator/sticker-settings";
import { addUserSticker, deleteUserSticker } from "../sticker-storage";
import { loadMemoryPanelData } from "./panel";
import { deleteImportedDoc } from "../rag";
import { loadUserProfile, saveUserProfile, getAvatarPath } from "../settings-store";
import { addMcpServer, removeMcpServer, listMcpServers, listMcpServerConfigs } from "../orchestrator/mcp-manager";
import { toolRegistry } from "../orchestrator/tools/registry/tool-registry";
import type { ConversationMode } from "../../shared/chat-types";
import { loadGeneralSettings, saveGeneralSettings } from "../settings/settings-facade";
import { listSkillsForUi, setSkillEnabled, skillRegistry, rescanSkills } from "../skills";
import type { SkillMode } from "../skills/types";
import type { WindowManager } from "../windows/window-manager";
import {
  reactChatWindow,
  stickerManagerWindow,
} from "../windows/window-state";
import type { EmbeddingIndexService } from "../services/embedding/embedding-index-service";
import { memoryStore } from "./memory-store";
import { exportMemoryToObsidianVault, syncToBoundVault } from "./obsidian-exporter";
import { loadObsidianVaultConfig, saveObsidianVaultConfig, unbindVault } from "./obsidian-vault-config";
import { startVaultWatcher, stopVaultWatcher } from "./obsidian-importer";

export interface MemoryUserToolIpcDependencies {
  get windowManager(): WindowManager | null;
  embeddingIndexService: EmbeddingIndexService;
  /** 传入共享 scope 以便退出时统一注销；缺省时使用独立 scope。 */
  ipc?: IpcScope;
}

function broadcastToAuxWindows(channel: string, payload: unknown): void {
  const win = reactChatWindow;
  if (win && !win.isDestroyed()) {
    win.webContents.send(channel, payload);
  }
}

const L0_EDITABLE_KEYS = ["preferredName", "occupation", "longTermInterests", "language", "permanentNote"];
const L1_EDITABLE_KEYS = ["recentGoals", "recentPreferences", "currentProject"];

export function registerMemoryUserToolIpc(deps: MemoryUserToolIpcDependencies): void {
  const { embeddingIndexService } = deps;
  const ipc = deps.ipc ?? createIpcScope();
  // 注意：windowManager 不解构，统一用 deps.windowManager 实时读取 getter。
  // registerMemoryUserToolIpc 在模块加载阶段调用，那时 windowManager 仍为 null，
  // 解构会捕获 null 并导致后续 ?. 永远短路（表情包管理窗口打不开）。

  // Sticker manager window controls
  ipc.handle(IPC.SETTINGS_OPEN_STICKER_MANAGER, async () => {
    console.log("[stickers] open sticker manager requested");
    return deps.windowManager?.createStickerManagerWindow();
  });

  ipc.on(IPC.STICKERS_MINIMIZE, () => {
    stickerManagerWindow?.minimize();
  });

  ipc.on(IPC.STICKERS_CLOSE, () => {
    stickerManagerWindow?.close();
  });

  ipc.handle(IPC.STICKERS_GET_CONFIG, () => getStickerManagerConfig());

  ipc.handle(IPC.STICKERS_SET_ENABLED, (_event, payload: unknown) => {
    const record = payload as { id?: unknown; enabled?: unknown };
    const id = typeof record?.id === "string" ? record.id : null;
    if (!id) return getStickerManagerConfig();
    setStickerEnabled(id, Boolean(record.enabled));
    return getStickerManagerConfig();
  });

  ipc.handle(IPC.STICKERS_PICK_FILE, async () => {
    const result = await dialog.showOpenDialog({
      properties: ["openFile"],
      filters: [{ name: "图片", extensions: ["png", "jpg", "jpeg", "gif", "webp"] }],
    });
    return result.canceled ? null : result.filePaths[0];
  });

  ipc.handle(IPC.STICKERS_ADD, async (_event, payload: unknown) => {
    const { sourcePath, id, description, phrases } = payload as {
      sourcePath: string;
      id: string;
      description: string;
      phrases: string[];
    };
    try {
      await addUserSticker(sourcePath, id, description, phrases);
      embeddingIndexService.invalidateStickerEmbeddingIndex();
      embeddingIndexService.refreshStickerEmbeddingIndex("user-sticker-add");
    } catch (err) {
      console.error("[stickers] add failed:", err);
      throw err;
    }
    return getStickerManagerConfig();
  });

  ipc.handle(IPC.STICKERS_DELETE, async (_event, id: string) => {
    try {
      await deleteUserSticker(id);
      embeddingIndexService.invalidateStickerEmbeddingIndex();
      embeddingIndexService.refreshStickerEmbeddingIndex("user-sticker-delete");
    } catch (err) {
      console.error("[stickers] delete failed:", err);
      throw err;
    }
    return getStickerManagerConfig();
  });

  ipc.handle(IPC.STICKERS_GET_ENABLED, () => {
    return getStickerManagerConfig().filter((s) => s.enabled);
  });

  // User avatar / profile
  ipc.handle(IPC.USER_GET_AVATAR, () => {
    const avatarPath = getAvatarPath();
    if (!fs.existsSync(avatarPath)) return null;
    const buf = fs.readFileSync(avatarPath);
    const ext = path.extname(avatarPath).toLowerCase();
    const mime =
      ext === ".png"
        ? "image/png"
        : ext === ".jpg" || ext === ".jpeg"
          ? "image/jpeg"
          : ext === ".webp"
            ? "image/webp"
            : "image/png";
    return "data:" + mime + ";base64," + buf.toString("base64");
  });

  // Memory panel
  ipc.handle(IPC.MEMORY_PANEL_GET_DATA, () => loadMemoryPanelData());

  ipc.handle(IPC.MEMORY_PANEL_DELETE_IMPORTED_DOC, (_event, payload: { importId: string; fileName?: string }) => {
    const deleted = deleteImportedDoc(payload.importId, payload.fileName);
    return { ok: true, deleted };
  });

  ipc.handle(IPC.MEMORY_PANEL_SAVE_L0, async (_event, raw: Record<string, unknown>) => {
    const patch: Partial<{
      preferredName: string;
      occupation: string;
      longTermInterests: string;
      language: string;
      permanentNote: string;
    }> = {};
    for (const key of L0_EDITABLE_KEYS) {
      if (key in raw && typeof raw[key] === "string") {
        (patch as Record<string, unknown>)[key] = (raw[key] as string).trim();
      }
    }
    await memoryStore.updateL0(patch);
    return { ok: true };
  });

  ipc.handle(IPC.MEMORY_PANEL_SAVE_L1, async (_event, raw: Record<string, unknown>) => {
    const patch: Partial<{
      recentGoals: string;
      recentPreferences: string;
      currentProject: string;
    }> = {};
    for (const key of L1_EDITABLE_KEYS) {
      if (key in raw && typeof raw[key] === "string") {
        (patch as Record<string, unknown>)[key] = (raw[key] as string).trim();
      }
    }
    await memoryStore.updateL1(patch);
    return { ok: true };
  });

  // ── Obsidian Vault 绑定 / 同步 / 配置 ──

  // 一次性导出（不绑定）：弹目录选择框 → 调导出器
  ipc.handle(IPC.MEMORY_EXPORT_OBSIDIAN_VAULT, async () => {
    const result = await dialog.showOpenDialog({
      title: "选择 Obsidian Vault 导出位置",
      properties: ["openDirectory", "createDirectory"],
    });
    if (result.canceled || result.filePaths.length === 0) {
      return { ok: false, canceled: true };
    }
    return exportMemoryToObsidianVault(result.filePaths[0]);
  });

  // 绑定 vault：弹目录选择 → 保存路径 → 立即同步一次 → 启动回流监听
  ipc.handle(IPC.OBSIDIAN_VAULT_BIND, async () => {
    const result = await dialog.showOpenDialog({
      title: "选择要绑定的 Obsidian Vault 文件夹",
      properties: ["openDirectory", "createDirectory"],
    });
    if (result.canceled || result.filePaths.length === 0) {
      return { ok: false, canceled: true };
    }
    const vaultPath = result.filePaths[0];
    saveObsidianVaultConfig({ vaultPath });
    // 绑定后立即同步一次
    const syncResult = await syncToBoundVault();
    // 启动 Obsidian → PMRS 回流监听
    startVaultWatcher(vaultPath);
    return { ok: syncResult.ok, vaultPath, fileCount: syncResult.fileCount, error: syncResult.error };
  });

  // 解绑：先停监听再清配置
  ipc.handle(IPC.OBSIDIAN_VAULT_UNBIND, () => {
    stopVaultWatcher();
    unbindVault();
    return { ok: true };
  });

  // 读配置
  ipc.handle(IPC.OBSIDIAN_VAULT_GET_CONFIG, () => {
    return loadObsidianVaultConfig();
  });

  // 设置自动同步开关
  ipc.handle(IPC.OBSIDIAN_VAULT_SET_AUTO_SYNC, (_event, autoSync: boolean) => {
    const updated = saveObsidianVaultConfig({ autoSync: Boolean(autoSync) });
    return { ok: true, config: updated };
  });

  // 立即同步
  ipc.handle(IPC.OBSIDIAN_VAULT_SYNC_NOW, async () => {
    return syncToBoundVault();
  });

  ipc.handle(IPC.USER_GET_PROFILE, () => loadUserProfile());

  ipc.handle(IPC.USER_SAVE_PROFILE, (_event, profile: Partial<{ avatarPath?: string } & Record<string, unknown>>) => {
    const saved = saveUserProfile(profile);
    broadcastToAuxWindows(IPC.USER_PROFILE_CHANGED, saved);
    return saved;
  });

  ipc.handle(IPC.USER_UPLOAD_AVATAR, async () => {
    const result = await dialog.showOpenDialog({
      properties: ["openFile"],
      filters: [{ name: "图片", extensions: ["png", "jpg", "jpeg", "webp", "bmp"] }],
    });
    if (result.canceled || result.filePaths.length === 0) return null;
    const srcPath = result.filePaths[0];
    const avatarPath = getAvatarPath();
    fs.mkdirSync(path.dirname(avatarPath), { recursive: true });
    fs.copyFileSync(srcPath, avatarPath);
    const profile = saveUserProfile({ avatarPath });
    broadcastToAuxWindows(IPC.USER_AVATAR_CHANGED, null);
    return { avatarPath, profile };
  });

  // MCP servers
  ipc.handle(IPC.MCP_ADD_SERVER, async (_event, config: unknown) => {
    console.log("[MCP IPC] add-server:", JSON.stringify(config).slice(0, 200));
    const result = await addMcpServer(config as Parameters<typeof addMcpServer>[0]);
    console.log("[MCP IPC] add-server result:", JSON.stringify(result));
    return result;
  });

  ipc.handle(IPC.MCP_REMOVE_SERVER, async (_event, serverId: string) => {
    console.log("[MCP IPC] remove-server:", serverId);
    const result = await removeMcpServer(serverId);
    console.log("[MCP IPC] remove-server result:", JSON.stringify(result));
    return result;
  });

  ipc.handle(IPC.MCP_LIST_SERVERS, () => {
    const servers = listMcpServers();
    console.log("[MCP IPC] list-servers:", servers.length + " servers");
    return servers;
  });

  // 持久化配置（含连接失败的），设置页列表以此为准
  ipc.handle(IPC.MCP_LIST_SERVER_CONFIGS, () => {
    return listMcpServerConfigs();
  });

  // Tool toggles
  ipc.handle(IPC.TOOL_SET_ENABLED, (_event, payload: unknown) => {
    const p = payload as { id?: string; enabled?: boolean };
    if (!p.id) return { ok: false, error: "missing tool id" };
    toolRegistry.setEnabled(p.id, p.enabled !== false);
    console.log("[Tool] " + p.id + " enabled=" + (p.enabled !== false));
    return { ok: true };
  });

  ipc.handle(IPC.TOOL_GET_ENABLED, () => {
    const tools = toolRegistry.getAllTools();
    const result: Record<string, boolean> = {};
    for (const t of tools) {
      result[t.id] = t.enabled;
    }
    return result;
  });

  // 工具目录元数据（工具页展示用；只暴露可序列化字段，不含 execute/zod schema）
  ipc.handle(IPC.TOOL_GET_CATALOG, () => {
    return toolRegistry.getAllTools().map((t) => ({
      id: t.id,
      name: t.name,
      description: t.description,
      enabled: t.enabled,
      modes: t.modes ?? null,
      chatBuiltin: t.chatBuiltin === true,
      deprecated: t.deprecated ?? null,
    }));
  });

  // 三模适配层：工具-模式覆盖层读写。
  // 覆盖层持久化在 general-settings.toolModeOverrides，覆盖优先于工具声明的 modes 字段。
  ipc.handle(IPC.TOOL_GET_MODE_OVERRIDES, () => {
    return loadGeneralSettings().toolModeOverrides;
  });

  ipc.handle(IPC.TOOL_SET_MODE_OVERRIDE, (_event, payload: unknown) => {
    const p = payload as { toolId?: string; mode?: string; enabled?: boolean };
    if (!p.toolId || !p.mode) return { ok: false, error: "missing toolId or mode" };
    const validModes = ["chat", "work", "code", "learn"];
    if (!validModes.includes(p.mode)) return { ok: false, error: "invalid mode" };
    const mode = p.mode as ConversationMode;
    const before = loadGeneralSettings().toolModeOverrides;
    const next = { ...before };
    next[p.toolId] = { ...(next[p.toolId] ?? {}), [mode]: p.enabled !== false };
    saveGeneralSettings({ toolModeOverrides: next });
    console.log(`[Tool] override ${p.toolId}@${mode}=${p.enabled !== false}`);
    return { ok: true };
  });

  ipc.handle(IPC.TOOL_CLEAR_MODE_OVERRIDE, (_event, payload: unknown) => {
    const p = payload as { toolId?: string; mode?: string };
    if (!p.toolId) return { ok: false, error: "missing toolId" };
    const before = loadGeneralSettings().toolModeOverrides;
    const next = { ...before };
    if (p.mode) {
      // 清除单个模式：删除该 mode 键，若工具已无任何覆盖则整个删除
      const validModes = ["chat", "work", "code", "learn"];
      if (!validModes.includes(p.mode)) return { ok: false, error: "invalid mode" };
      const mode = p.mode as ConversationMode;
      if (next[p.toolId]) {
        const { [mode]: _removed, ...rest } = next[p.toolId];
        if (Object.keys(rest).length > 0) {
          next[p.toolId] = rest;
        } else {
          delete next[p.toolId];
        }
      }
    } else {
      // 未指定 mode：清除该工具的所有模式覆盖
      delete next[p.toolId];
    }
    saveGeneralSettings({ toolModeOverrides: next });
    console.log(`[Tool] override cleared ${p.toolId}@${p.mode ?? "all"}`);
    return { ok: true };
  });

  // Skill toggles
  ipc.handle(IPC.SKILL_LIST, () => listSkillsForUi());

  ipc.handle(IPC.SKILL_SET_ENABLED, (_event, payload: unknown) => {
    const p = payload as { id?: string; enabled?: boolean };
    if (!p.id) return { ok: false, error: "missing skill id" };
    setSkillEnabled(p.id, p.enabled !== false);
    console.log("[Skill] " + p.id + " enabled=" + (p.enabled !== false));
    return { ok: true };
  });

  // Skill 目录元数据（skill 页展示用；只暴露可序列化字段）
  // hiddenFromUi = true 的技能（如角色语气校准）不显示在设置面板。
  ipc.handle(IPC.SKILL_GET_CATALOG, () => {
    return skillRegistry
      .getAll()
      .filter((s) => !s.hiddenFromUi)
      .map((s) => ({
        id: s.id,
        name: s.name,
        description: s.description,
        enabled: s.enabled,
        source: s.source,
        modes: s.modes ?? null,
        version: s.version,
        references: s.references,
      }));
  });

  // 重新扫描 user skills 目录，安装/删除 skill 后无需重启即可刷新 UI。
  ipc.handle(IPC.SKILL_RESCAN, () => {
    const count = rescanSkills();
    return { ok: true, count };
  });

  // 三模适配层：skill-模式覆盖层读写。
  // 覆盖层持久化在 general-settings.skillModeOverrides，覆盖优先于 skill 声明的 modes 字段。
  ipc.handle(IPC.SKILL_GET_MODE_OVERRIDES, () => {
    return loadGeneralSettings().skillModeOverrides;
  });

  ipc.handle(IPC.SKILL_SET_MODE_OVERRIDE, (_event, payload: unknown) => {
    const p = payload as { skillId?: string; mode?: string; enabled?: boolean };
    if (!p.skillId || !p.mode) return { ok: false, error: "missing skillId or mode" };
    const validModes = ["work", "code", "learn"];
    if (!validModes.includes(p.mode)) return { ok: false, error: "invalid mode" };
    const mode = p.mode as SkillMode;
    const before = loadGeneralSettings().skillModeOverrides;
    const next = { ...before };
    next[p.skillId] = { ...(next[p.skillId] ?? {}), [mode]: p.enabled !== false };
    saveGeneralSettings({ skillModeOverrides: next });
    console.log(`[Skill] override ${p.skillId}@${mode}=${p.enabled !== false}`);
    return { ok: true };
  });

  ipc.handle(IPC.SKILL_CLEAR_MODE_OVERRIDE, (_event, payload: unknown) => {
    const p = payload as { skillId?: string; mode?: string };
    if (!p.skillId) return { ok: false, error: "missing skillId" };
    const before = loadGeneralSettings().skillModeOverrides;
    const next = { ...before };
    if (p.mode) {
      const validModes = ["work", "code", "learn"];
      if (!validModes.includes(p.mode)) return { ok: false, error: "invalid mode" };
      const mode = p.mode as SkillMode;
      if (next[p.skillId]) {
        const { [mode]: _removed, ...rest } = next[p.skillId];
        if (Object.keys(rest).length > 0) {
          next[p.skillId] = rest;
        } else {
          delete next[p.skillId];
        }
      }
    } else {
      delete next[p.skillId];
    }
    saveGeneralSettings({ skillModeOverrides: next });
    console.log(`[Skill] override cleared ${p.skillId}@${p.mode ?? "all"}`);
    return { ok: true };
  });

  // 启动时：若已绑定 vault，恢复 Obsidian → PMRS 回流监听
  const existingConfig = loadObsidianVaultConfig();
  if (existingConfig.vaultPath) {
    startVaultWatcher(existingConfig.vaultPath);
  }
}
