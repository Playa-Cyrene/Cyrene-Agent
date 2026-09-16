// 会话工作区只读文件 IPC：右侧面板的文件树（懒加载）与文件预览使用。
//
// 安全边界：
// - 一切访问基于会话绑定的工作区根目录（chatsStore.getWorkspaceBinding）；
// - 目标路径先 resolve 再 realpath，realpath 结果必须仍在根内——防 symlink 越界；
// - 隐藏文件（. 开头）不展示；目录条目数有上限；预览文件大小有上限；
// - 二进制启发：前 4KB 中 \0 占比超过 5% 视为二进制，拒绝预览。
//
// 错误只回传 code（见 workspace-files-types），渲染层负责按 i18n 映射文案。

import * as fs from "fs";
import * as path from "path";
import { IPC } from "../../shared/ipc-channels";
import type {
  WorkspaceFileEntry,
  WorkspaceListResult,
  WorkspaceReadResult,
} from "../../shared/workspace-files-types";
import { createIpcScope, type IpcScope } from "../application/ipc-scope";
import * as chatsStore from "./chats-store";

/** 目录条目上限：防超大目录一次性拖垮渲染层 */
const LIST_MAX_ENTRIES = 1000;
/** 预览文件大小上限 1MB */
const READ_MAX_BYTES = 1024 * 1024;
/** 二进制启发：只检查文件前 4KB */
const BINARY_HEAD_BYTES = 4096;
/** 二进制启发：\0 字节占比超过 5% 判为二进制 */
const BINARY_NULL_RATIO = 0.05;

/** 判断 target 是否位于 root 内（Windows 路径大小写不敏感） */
function isWithinRoot(root: string, target: string): boolean {
  const a = process.platform === "win32" ? root.toLowerCase() : root;
  const b = process.platform === "win32" ? target.toLowerCase() : target;
  return b === a || b.startsWith(a + path.sep);
}

/**
 * 把相对路径解析为根目录内的真实路径。
 * 抛错 code：NOT_FOUND（不存在）/ OUT_OF_ROOT（越界，含 symlink）。
 */
async function resolveWithinRoot(root: string, relPath: string): Promise<{ rootReal: string; targetReal: string }> {
  // 归一化：反斜杠转 /、去掉开头的 /，防绝对路径注入；.. 由 resolve + realpath 兜底
  const normalized = String(relPath ?? "").replaceAll("\\", "/").replace(/^\/+/, "");
  const rootReal = await fs.promises.realpath(root);
  const absolute = path.resolve(rootReal, normalized);
  let targetReal: string;
  try {
    targetReal = await fs.promises.realpath(absolute);
  } catch {
    throw Object.assign(new Error("path not found"), { code: "NOT_FOUND" });
  }
  if (!isWithinRoot(rootReal, targetReal)) {
    throw Object.assign(new Error("path escapes workspace root"), { code: "OUT_OF_ROOT" });
  }
  return { rootReal, targetReal };
}

/** 列出工作区内某目录：目录优先、名称排序、隐藏文件过滤（导出供安全测试直测） */
export async function listDirectory(root: string, relPath: string): Promise<WorkspaceListResult> {
  let resolved: { rootReal: string; targetReal: string };
  try {
    resolved = await resolveWithinRoot(root, relPath);
  } catch (err) {
    const code = (err as { code?: string }).code === "OUT_OF_ROOT" ? "OUT_OF_ROOT" : "NOT_FOUND";
    return { ok: false, code };
  }

  let dirents: fs.Dirent[];
  try {
    dirents = await fs.promises.readdir(resolved.targetReal, { withFileTypes: true });
  } catch (err) {
    return { ok: false, code: "LIST_FAILED", error: err instanceof Error ? err.message : String(err) };
  }

  const entries: WorkspaceFileEntry[] = [];
  for (const dirent of dirents) {
    if (dirent.name.startsWith(".")) continue; // 隐藏文件不展示
    entries.push({
      name: dirent.name,
      relPath: path.relative(resolved.rootReal, path.join(resolved.targetReal, dirent.name)).replaceAll("\\", "/"),
      // symlink 目录按文件处理：不展开（更安全），点击预览时由 realpath 校验兜底
      isDir: dirent.isDirectory(),
    });
  }
  entries.sort((a, b) => (a.isDir === b.isDir ? a.name.localeCompare(b.name) : a.isDir ? -1 : 1));

  const truncated = entries.length > LIST_MAX_ENTRIES;
  return { ok: true, entries: entries.slice(0, LIST_MAX_ENTRIES), truncated };
}

/** 读取工作区内某文件：大小上限 + 二进制识别（导出供安全测试直测） */
export async function readFile(root: string, relPath: string): Promise<WorkspaceReadResult> {
  let resolved: { rootReal: string; targetReal: string };
  try {
    resolved = await resolveWithinRoot(root, relPath);
  } catch (err) {
    const code = (err as { code?: string }).code === "OUT_OF_ROOT" ? "OUT_OF_ROOT" : "NOT_FOUND";
    return { ok: false, code };
  }

  let stat: fs.Stats;
  try {
    stat = await fs.promises.stat(resolved.targetReal);
  } catch {
    return { ok: false, code: "NOT_FOUND" };
  }
  if (stat.isDirectory()) return { ok: false, code: "IS_DIRECTORY" };
  if (stat.size > READ_MAX_BYTES) return { ok: false, code: "TOO_LARGE" };

  let buf: Buffer;
  try {
    buf = await fs.promises.readFile(resolved.targetReal);
  } catch (err) {
    return { ok: false, code: "READ_FAILED", error: err instanceof Error ? err.message : String(err) };
  }

  // 二进制启发：前 4KB 出现大量 \0 → 拒绝预览
  const head = buf.subarray(0, Math.min(buf.length, BINARY_HEAD_BYTES));
  let nullCount = 0;
  for (let i = 0; i < head.length; i++) if (head[i] === 0) nullCount++;
  if (head.length > 0 && nullCount / head.length > BINARY_NULL_RATIO) {
    return { ok: false, code: "BINARY" };
  }

  return { ok: true, content: buf.toString("utf8"), size: stat.size };
}

export function registerWorkspaceFilesIpc(ipcOption?: IpcScope): void {
  const ipc = ipcOption ?? createIpcScope();

  ipc.handle(IPC.WORKSPACE_FILES_LIST, (_event, payload: { sessionId?: string; relPath?: string }) => {
    if (!payload?.sessionId) return { ok: false as const, code: "NO_WORKSPACE" as const };
    const binding = chatsStore.getWorkspaceBinding(payload.sessionId);
    if (!binding) return { ok: false as const, code: "NO_WORKSPACE" as const };
    return listDirectory(binding.workspaceRoot, payload.relPath ?? "");
  });

  ipc.handle(IPC.WORKSPACE_FILES_READ, (_event, payload: { sessionId?: string; relPath?: string }) => {
    if (!payload?.sessionId) return { ok: false as const, code: "NO_WORKSPACE" as const };
    const binding = chatsStore.getWorkspaceBinding(payload.sessionId);
    if (!binding) return { ok: false as const, code: "NO_WORKSPACE" as const };
    return readFile(binding.workspaceRoot, payload.relPath ?? "");
  });
}
