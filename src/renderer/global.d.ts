// Global type augmentations for renderer

import type { ReviewSnapshot, ReviewRestoreOutcome } from "../shared/review-types";
import type { AppUpdateApi } from "../shared/app-update";
import type { PluginManagementApi, PluginPanelApi } from "../shared/plugin-management";
import type { MomentsApi } from "../shared/moments-types";
import type { WorkspaceListResult, WorkspaceReadResult } from "../shared/workspace-files-types";
import type { OpenInAppListResult, OpenInAppOpenResult } from "../shared/open-in-app-types";

interface SystemApi {
  openExternal: (url: string) => Promise<{ ok: boolean; error?: string }>;
}

interface ReviewApi {
  get: (runId: string) => Promise<ReviewSnapshot | null>;
  /** 把本次 Run 修改过的文件恢复到运行前状态 */
  restore: (runId: string) => Promise<ReviewRestoreOutcome>;
}

interface WorkspaceFilesApi {
  /** 列出工作区内某目录的条目（懒加载；隐藏文件已过滤，目录优先排序） */
  list: (sessionId: string, relPath: string) => Promise<WorkspaceListResult>;
  /** 读取工作区内某文件内容（预览用；1MB 上限、二进制拒绝） */
  read: (sessionId: string, relPath: string) => Promise<WorkspaceReadResult>;
}

interface OpenInAppApi {
  /** 探测本机可打开工作区的应用（主进程进程内缓存；不含固定的资源管理器项） */
  listApps: (sessionId: string) => Promise<OpenInAppListResult>;
  /** 执行打开动作：explorer 固定项 + 探测到的应用 id */
  open: (sessionId: string, appId: string) => Promise<OpenInAppOpenResult>;
}

/** 聊天窗口通过 contextBridge 暴露的 window.chat（对应 preload 的 chatApi）。
 *  只声明渲染端实际使用的方法面，完整实现见 src/preload/index.ts。 */
interface ChatWindowApi {
  minimize: () => void;
  close: () => void;
  toggleMaximize: () => void;
  /** 已启用的贴纸列表（主进程返回 { id, src } 结构） */
  getEnabledStickers: () => Promise<Array<{ id: string; src: string }>>;
  /** 读取本地图片并转为 dataUrl 预览；失败返回 ok=false + error */
  getImagePreview: (filePath: string) => Promise<{ ok: boolean; dataUrl?: string; error?: string }>;
  /** 主进程通用设置（只声明渲染端读取的字段） */
  getGeneralSettings: () => Promise<{
    language?: string;
    currentStyleId?: string;
    ttsEarlyReadSplitEnabled?: boolean;
    ttsEarlyReadSplitMode?: "sentence" | "paragraph";
  }>;
}

/** 设置窗口通过 contextBridge 暴露的 window.settings（对应 preload 的 settingsApi）。
 *  只声明聊天页技能/工具模式面板用到的子集，完整实现见 src/preload/index.ts。 */
interface SettingsWindowApi {
  getSkillCatalog: () => Promise<unknown>;
  getSkillModeOverrides: () => Promise<unknown>;
  /** 重新扫描技能目录；失败返回 ok=false + error */
  rescanSkills: () => Promise<{ ok: boolean; error?: string }>;
  setSkillModeOverride: (skillId: string, mode: string, next: boolean) => Promise<unknown>;
  getToolCatalog: () => Promise<unknown>;
  getToolModeOverrides: () => Promise<unknown>;
  getGeneral: () => Promise<unknown>;
  setToolModeOverride: (toolId: string, mode: string, next: boolean) => Promise<unknown>;
  saveGeneral: (payload: Record<string, unknown>) => Promise<unknown>;
}

declare global {
  interface Window {
    system?: SystemApi;
    review?: ReviewApi;
    workspaceFiles?: WorkspaceFilesApi;
    openInApp?: OpenInAppApi;
    appUpdate?: AppUpdateApi;
    plugins?: PluginManagementApi;
    pluginPanel?: PluginPanelApi;
    moments?: MomentsApi;
    toast?: ToastRendererApi;
    chat?: ChatWindowApi;
    settings?: SettingsWindowApi;
  }
}

// 注意：静态资源（*.png / *.svg / *.md?raw 等）的 declare module 通配声明
// 不在此文件声明——本文件因类型导入而成为"模块"，模块内的通配声明不参与模块解析。
// 这些声明已移至脚本式的 assets.d.ts。

export {};
