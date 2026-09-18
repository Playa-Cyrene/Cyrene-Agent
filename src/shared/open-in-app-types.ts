// "用本机应用打开工作区"的 IPC 数据类型（右上角"打开"菜单）。
// 错误只回传 code，渲染层负责按 i18n 映射文案（与 workspace-files 同一套约定）。

/** 一个可用的"打开方式"条目：id 传回主进程执行，name 是展示名（专有名词不翻译） */
export interface OpenInAppEntry {
  id: string;
  name: string;
  /** 应用图标（data URL，主进程从 exe 提取）；提取失败时缺省，渲染层显示占位方块 */
  icon?: string;
}

/** 探测结果：apps 固定项资源管理器在最前；preferred 是主按钮当前展示的应用（上次成功用过的） */
export type OpenInAppListResult =
  | { ok: true; apps: OpenInAppEntry[]; preferred: string }
  | { ok: false; code: "NO_WORKSPACE" | "DETECT_FAILED" };

/** 打开动作的执行结果 */
export type OpenInAppOpenResult =
  | { ok: true }
  | {
      ok: false;
      code: "NO_WORKSPACE" | "WORKSPACE_MISSING" | "APP_NOT_FOUND" | "LAUNCH_FAILED";
      error?: string;
    };
