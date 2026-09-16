// 会话工作区只读文件接口的共享类型（主进程 IPC ↔ preload ↔ 渲染层）。
// 错误只回传 code，展示文案由渲染层按 i18n 映射；error 字段仅存放意外错误的原始信息。

/** 目录列表条目 */
export interface WorkspaceFileEntry {
  name: string;
  /** 相对工作区根的路径（统一用 / 分隔，根目录为空字符串） */
  relPath: string;
  isDir: boolean;
}

/** 工作区文件接口错误码 */
export type WorkspaceFileErrorCode =
  /** 会话未绑定工作区 */
  | "NO_WORKSPACE"
  /** 路径越出工作区根（含 symlink 越界） */
  | "OUT_OF_ROOT"
  /** 路径不存在或不可访问 */
  | "NOT_FOUND"
  /** 读取目标是目录 */
  | "IS_DIRECTORY"
  /** 文件超过预览大小上限 */
  | "TOO_LARGE"
  /** 二进制文件（前 4KB 出现大量 \0） */
  | "BINARY"
  /** 列目录失败 */
  | "LIST_FAILED"
  /** 读文件失败 */
  | "READ_FAILED";

export type WorkspaceListResult =
  | { ok: true; entries: WorkspaceFileEntry[]; truncated?: boolean }
  | { ok: false; code: WorkspaceFileErrorCode; error?: string };

export type WorkspaceReadResult =
  | { ok: true; content: string; size: number }
  | { ok: false; code: WorkspaceFileErrorCode; error?: string };
