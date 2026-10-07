import * as fs from "node:fs";
import * as path from "node:path";
import { ACCESS_LEVEL_LABEL, getCurrentLevel, policyFor } from "../../permission";
import type { ToolContext } from "./registry/tool-context";

export type FileAccessOperation = "read" | "write";
export type FileAccessPath = { ok: true; path: string } | { ok: false; message: string };

export function getFileAccessLevel(context?: Pick<ToolContext, "permissionMode">) {
  return context?.permissionMode === "allow_all" ? "full" : getCurrentLevel();
}

/** 新文件也按最近存在的父目录解析，保证检查的目标与实际写入位置一致。 */
function realTargetPath(target: string): string {
  let existing = path.resolve(target);
  const missing: string[] = [];
  const links = new Set<string>();
  for (;;) {
    try {
      return path.join(fs.realpathSync.native(existing), ...missing.reverse());
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      let symbolic = false;
      try {
        symbolic = fs.lstatSync(existing).isSymbolicLink();
      } catch (statError) {
        if ((statError as NodeJS.ErrnoException).code !== "ENOENT") throw statError;
      }
      if (symbolic) {
        if (links.has(existing)) throw new Error("路径包含循环符号链接");
        links.add(existing);
        existing = path.resolve(path.dirname(existing), fs.readlinkSync(existing));
        continue;
      }
      const parent = path.dirname(existing);
      if (parent === existing) throw error;
      missing.push(path.basename(existing));
      existing = parent;
    }
  }
}

function isWithin(target: string, root: string): boolean {
  const relative = path.relative(root, target);
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

/** 审批沿用调度层；这里统一落实当前权限档位的文件范围和只读限制。 */
export function resolveFileAccessPath(
  target: string,
  operation: FileAccessOperation,
  context?: ToolContext,
): FileAccessPath {
  const level = getFileAccessLevel(context);
  if (operation === "write" && context?.readOnly) return { ok: false, message: "本子任务处于只读模式，不允许修改文件。" };
  if (policyFor(level, operation === "read" ? "fs-read" : "fs-write") === "deny") {
    return { ok: false, message: `当前权限「${ACCESS_LEVEL_LABEL[level]}」不允许${operation === "read" ? "读取" : "写入"}文件。` };
  }
  try {
    const resolved = realTargetPath(target);
    if (level === "project-read-only" || (level === "scoped" && operation === "write")) {
      if (!context?.resolvedWorkspaceRoot || !isWithin(resolved, realTargetPath(context.resolvedWorkspaceRoot))) {
        return { ok: false, message: `目标路径在当前工作区外，权限「${ACCESS_LEVEL_LABEL[level]}」不允许此次访问：${resolved}` };
      }
    }
    return { ok: true, path: resolved };
  } catch (error) {
    return { ok: false, message: `无法解析目标路径：${error instanceof Error ? error.message : String(error)}` };
  }
}

/** 工作区内保留相对路径，外部结果返回绝对路径，便于后续直接读取。 */
export function formatFileAccessPath(target: string, workspaceRoot: string): string {
  try {
    const root = realTargetPath(workspaceRoot);
    return isWithin(target, root) ? path.relative(root, target).split(path.sep).join("/") : target;
  } catch {
    return target;
  }
}
