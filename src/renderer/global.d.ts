// Global type augmentations for renderer

import type { ReviewSnapshot, ReviewRestoreOutcome } from "../shared/review-types";
import type { AppUpdateApi } from "../shared/app-update";
import type { PluginManagementApi, PluginPanelApi } from "../shared/plugin-management";
import type { MomentsApi } from "../shared/moments-types";
import type { WorkspaceListResult, WorkspaceReadResult } from "../shared/workspace-files-types";

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

declare global {
  interface Window {
    system?: SystemApi;
    review?: ReviewApi;
    workspaceFiles?: WorkspaceFilesApi;
    appUpdate?: AppUpdateApi;
    plugins?: PluginManagementApi;
    pluginPanel?: PluginPanelApi;
    moments?: MomentsApi;
    toast?: ToastRendererApi;
  }
}

// 注意：静态资源（*.png / *.svg / *.md?raw 等）的 declare module 通配声明
// 不在此文件声明——本文件因类型导入而成为"模块"，模块内的通配声明不参与模块解析。
// 这些声明已移至脚本式的 assets.d.ts。

export {};
