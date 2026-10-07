// ZCode Read/Write/Edit/Glob/Grep interfaces adapted to Cyrene's tool runtime.
// ZCode source: E:\ZCode\apps\zcode-cli\packages\core\src\tool\handlers
// Licensed under Apache-2.0; see THIRD_PARTY_NOTICES.md.

import { glob as globFiles } from "node:fs/promises";
import * as fs from "node:fs";
import * as path from "node:path";
import type { ToolContext } from "./registry/tool-context";
import { toolRegistry, type ToolDefinition } from "./registry/tool-registry";
import { formatFileAccessPath, resolveFileAccessPath, type FileAccessOperation } from "./file-access";

const MAX_GLOB_RESULTS = 100;
const MAX_GREP_RESULTS = 100;
const OMIT_GLOB_SEGMENTS = new Set([
  ".git", ".worktrees", "worktrees", "node_modules", "vendor", "dist", "build", "out",
  "output", "coverage", ".next", ".nuxt", ".cache", "target", ".venv", "venv",
]);

type LegacyTool = ToolDefinition;

export function registerZCodeFileTools(legacy: {
  read: LegacyTool;
  readImage: LegacyTool;
  write: LegacyTool;
  edit: LegacyTool;
  grep: LegacyTool;
}): void {
  toolRegistry.register({
    id: "Read",
    name: "Read",
    description:
      "读取本地文本文件并返回带行号的内容；支持图片分析。路径必须是绝对路径。" +
      "长文件可用 offset 和 limit 分段读取。编辑文件前先读取目标文件。",
    enabled: true,
    risk: "fs-read",
    modes: ["learn", "code", "work"],
    effectKind: "read",
    verificationPolicy: "none",
    isConcurrencySafe: () => true,
    needsContext: true,
    inputSchema: {
      type: "object",
      properties: {
        file_path: { type: "string", description: "待读取文件的绝对路径" },
        offset: { type: "number", description: "从第几行开始，0 表示第一行" },
        limit: { type: "number", description: "最多读取多少行，默认 2000" },
      },
      required: ["file_path"],
    },
    execute: async (args, context) => {
      const filePath = requireAbsolutePath(args.file_path, context);
      if (!filePath.ok) return filePath.message;
      const extension = path.extname(filePath.path).toLowerCase();
      if ([".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".svg"].includes(extension)) {
        return legacy.readImage.execute({ path: filePath.path }, context);
      }
      const offset = Math.max(0, Math.trunc(Number(args.offset) || 0));
      const limit = Math.max(1, Math.min(2000, Math.trunc(Number(args.limit) || 2000)));
      const output = await legacy.read.execute({
        path: filePath.path,
        startLine: offset + 1,
        maxLines: limit,
      }, context);
      try {
        const parsed = JSON.parse(output) as { success?: boolean; error?: string; content?: string };
        if (parsed.success === false) return output;
        return parsed.content ?? output;
      } catch {
        return output;
      }
    },
  });

  toolRegistry.register({
    id: "Write",
    name: "Write",
    description:
      "创建文件或完整覆写已读取的文件。路径必须是绝对路径；写入会经过 Cyrene 文件权限与变更审查。" +
      "局部修改请用 Edit。",
    enabled: true,
    risk: "fs-write",
    modes: ["learn", "code", "work"],
    effectKind: "mutation",
    verificationPolicyResolver: (args) => legacy.write.verificationPolicyResolver?.({ path: args.file_path })
      ?? legacy.write.verificationPolicy
      ?? "unknown",
    inputSchema: {
      type: "object",
      properties: {
        file_path: { type: "string", description: "目标文件的绝对路径" },
        content: { type: "string", description: "写入文件的完整内容" },
      },
      required: ["file_path", "content"],
    },
    needsContext: true,
    execute: async (args, context) => {
      const filePath = requireAbsolutePath(args.file_path, context, "write");
      if (!filePath.ok) return filePath.message;
      const output = await legacy.write.execute({ path: filePath.path, content: String(args.content ?? "") }, context);
      return renameResultTool(output, "Write");
    },
  });

  toolRegistry.register({
    id: "Edit",
    name: "Edit",
    description:
      "对文件中的文本做精确替换。先 Read 目标文件；old_string 必须能唯一定位，" +
      "需要替换所有匹配时设置 replace_all=true。写入会经过 Cyrene 文件权限与变更审查。",
    enabled: true,
    risk: "fs-write",
    modes: ["learn", "code", "work"],
    effectKind: "mutation",
    verificationPolicy: "code",
    needsContext: true,
    inputSchema: {
      type: "object",
      properties: {
        file_path: { type: "string", description: "目标文件的绝对路径" },
        old_string: { type: "string", description: "要替换的原文本" },
        new_string: { type: "string", description: "替换成的文本" },
        replace_all: { type: "boolean", description: "是否替换所有匹配，默认 false" },
      },
      required: ["file_path", "old_string", "new_string"],
    },
    execute: async (args, context) => {
      const filePath = requireAbsolutePath(args.file_path, context, "write");
      if (!filePath.ok) return filePath.message;
      const oldString = String(args.old_string ?? "");
      const newString = String(args.new_string ?? "");
      if (args.replace_all !== true) {
        const output = await legacy.edit.execute({ file_path: filePath.path, old_string: oldString, new_string: newString }, context);
        return renameResultTool(output, "Edit");
      }
      if (!oldString || oldString === newString) {
        return JSON.stringify({ success: false, errorCode: "INVALID_INPUT", error: "old_string 必须非空，且必须与 new_string 不同。" });
      }
      let original: string;
      try {
        original = fs.readFileSync(filePath.path, "utf8");
      } catch (error) {
        return JSON.stringify({ success: false, errorCode: "READ_FAILED", error: error instanceof Error ? error.message : String(error) });
      }
      const occurrences = original.split(oldString).length - 1;
      if (occurrences === 0) {
        return JSON.stringify({ success: false, errorCode: "OLD_STRING_NOT_FOUND", error: "String to replace not found in file." });
      }
      const updated = original.split(oldString).join(newString);
      const output = await legacy.write.execute({ path: filePath.path, content: updated }, context);
      return renameResultTool(output, "Edit");
    },
  });

  toolRegistry.register({
    id: "Glob",
    name: "Glob",
    description:
      "按 glob 文件模式查找文件名，例如 **/*.ts 或 src/**/*.tsx。默认从当前工作区搜索；" +
      "忽略依赖、构建产物和 Git 镜像目录，最多返回 100 个结果。",
    enabled: true,
    risk: "fs-read",
    modes: ["learn", "code", "work"],
    effectKind: "read",
    verificationPolicy: "none",
    isConcurrencySafe: () => true,
    needsContext: true,
    inputSchema: {
      type: "object",
      properties: {
        pattern: { type: "string", description: "匹配文件路径的 glob 模式" },
        path: { type: "string", description: "可选的搜索目录" },
      },
      required: ["pattern"],
    },
    execute: async (args, context) => executeGlob(args, context),
  });

  toolRegistry.register({
    id: "Grep",
    name: "Grep",
    description:
      "用正则表达式搜索文件内容。可按 glob 或文件类型筛选，并返回匹配行、文件名或计数；" +
      "默认跳过依赖、二进制和构建目录。",
    enabled: true,
    risk: "fs-read",
    modes: ["learn", "code", "work"],
    effectKind: "read",
    verificationPolicy: "none",
    isConcurrencySafe: () => true,
    needsContext: true,
    inputSchema: {
      type: "object",
      properties: {
        pattern: { type: "string", description: "正则表达式" },
        path: { type: "string", description: "文件或目录，默认为当前工作区" },
        glob: { type: "string", description: "文件 glob 筛选条件" },
        output_mode: { type: "string", enum: ["content", "files_with_matches", "count"], default: "files_with_matches" },
        "-B": { type: "number", description: "匹配行前显示的上下文行数" },
        "-A": { type: "number", description: "匹配行后显示的上下文行数" },
        "-C": { type: "number", description: "匹配行前后显示的上下文行数" },
        context: { type: "number", description: "匹配行前后显示的上下文行数" },
        "-n": { type: "boolean", description: "是否显示行号，默认 true" },
        "-i": { type: "boolean", description: "是否忽略大小写" },
        "-o": { type: "boolean", description: "仅显示匹配部分" },
        type: { type: "string", description: "文件类型筛选，例如 ts、js、py" },
        head_limit: { type: "number", description: "最多返回条目数，默认 250，0 表示使用工具上限" },
        offset: { type: "number", description: "跳过的结果条目数" },
      },
      required: ["pattern"],
    },
    execute: async (args, context) => executeGrep(legacy.grep, args, context),
  });

  for (const id of ["read_file", "read_image", "list_dir", "write_file", "str_replace", "search_text"]) {
    const previous = toolRegistry.getById(id);
    if (previous) previous.deprecated = true;
  }
}

function requireAbsolutePath(
  raw: unknown,
  context?: ToolContext,
  operation: FileAccessOperation = "read",
): { ok: true; path: string } | { ok: false; message: string } {
  const input = typeof raw === "string" ? raw.trim() : "";
  if (!input || !path.isAbsolute(input)) {
    return { ok: false, message: JSON.stringify({ success: false, errorCode: "INVALID_INPUT", error: "file_path must be an absolute path." }) };
  }
  const access = resolveFileAccessPath(input, operation, context);
  return access.ok ? access : { ok: false, message: JSON.stringify({
    success: false, errorCode: "PERMISSION_DENIED", category: "permission_denied", error: access.message,
  }) };
}

async function executeGlob(args: Record<string, unknown>, context?: ToolContext): Promise<string> {
  const pattern = typeof args.pattern === "string" ? args.pattern.trim() : "";
  if (!pattern || path.isAbsolute(pattern) || pattern.split(/[\\/]/).includes("..")) {
    return JSON.stringify({ success: false, errorCode: "INVALID_PATTERN", error: "pattern must be a relative glob without '..'." });
  }
  const workspaceRoot = context?.resolvedWorkspaceRoot ? path.resolve(context.resolvedWorkspaceRoot) : process.cwd();
  const requestedPath = typeof args.path === "string" && args.path.trim()
    ? path.resolve(workspaceRoot, args.path)
    : workspaceRoot;
  const access = resolveFileAccessPath(requestedPath, "read", context);
  if (!access.ok) return JSON.stringify({ success: false, errorCode: "PERMISSION_DENIED", category: "permission_denied", error: access.message });
  const requestedRoot = access.path;
  if (!fs.existsSync(requestedRoot) || !fs.statSync(requestedRoot).isDirectory()) {
    return JSON.stringify({ success: false, errorCode: "INVALID_PATH", error: "path must be an accessible directory." });
  }
  const startedAt = Date.now();
  const filenames: Array<{ path: string; mtimeMs: number }> = [];
  let truncated = false;
  try {
    for await (const match of globFiles(pattern, {
      cwd: requestedRoot,
      followSymlinks: false,
      exclude: (entry) => entry.split(/[\\/]/).some((part) => OMIT_GLOB_SEGMENTS.has(part)),
    })) {
      const absolute = path.resolve(requestedRoot, match);
      const matchAccess = resolveFileAccessPath(absolute, "read", context);
      if (!matchAccess.ok) continue;
      let stat: fs.Stats;
      try {
        stat = await fs.promises.stat(matchAccess.path);
      } catch {
        continue;
      }
      if (!stat.isFile()) continue;
      if (filenames.length === MAX_GLOB_RESULTS) {
        truncated = true;
        break;
      }
      filenames.push({
        path: formatFileAccessPath(matchAccess.path, workspaceRoot),
        mtimeMs: stat.mtimeMs,
      });
    }
  } catch (error) {
    return JSON.stringify({ success: false, errorCode: "GLOB_FAILED", error: error instanceof Error ? error.message : String(error) });
  }
  filenames.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return JSON.stringify({
    durationMs: Date.now() - startedAt,
    numFiles: filenames.length,
    filenames: filenames.map((item) => item.path),
    truncated,
  });
}

async function executeGrep(
  legacy: LegacyTool,
  args: Record<string, unknown>,
  context?: ToolContext,
): Promise<string> {
  const pattern = typeof args.pattern === "string" ? args.pattern : "";
  if (!pattern) return JSON.stringify({ success: false, errorCode: "INVALID_PATTERN", error: "pattern is required." });
  const outputMode = args.output_mode === "content" || args.output_mode === "count"
    ? args.output_mode
    : "files_with_matches";
  const offset = Math.max(0, Math.trunc(Number(args.offset) || 0));
  const requestedLimit = Math.max(0, Math.trunc(Number(args.head_limit) || 250));
  const limit = requestedLimit === 0 ? MAX_GREP_RESULTS : Math.min(MAX_GREP_RESULTS, requestedLimit);
  const contextLines = Math.max(0, Math.min(5, Math.trunc(Number(args.context ?? args["-C"]) || 0)));
  const beforeCount = Math.max(0, Math.min(5, Math.trunc(Number(args["-B"] ?? args["-C"] ?? args.context) || 0)));
  const afterCount = Math.max(0, Math.min(5, Math.trunc(Number(args["-A"] ?? args["-C"] ?? args.context) || 0)));
  const type = typeof args.type === "string" ? args.type.trim().replace(/^\./, "") : "";
  const fileGlobs = [
    ...(typeof args.glob === "string" && args.glob ? [args.glob] : []),
  ];
  const startedAt = Date.now();
  const output = await legacy.execute({
    query: pattern,
    mode: "regex",
    paths: typeof args.path === "string" && args.path ? [args.path] : ["."],
    ...(fileGlobs.length ? { fileGlobs } : {}),
    ...(type ? { fileExtension: type } : {}),
    maxMatches: Math.min(MAX_GREP_RESULTS, offset + limit || MAX_GREP_RESULTS),
    contextLines: Math.max(contextLines, beforeCount, afterCount),
    caseSensitive: args["-i"] !== true,
  }, context);
  let result: { success?: boolean; error?: string; message?: string; rejectedPaths?: string[]; matches?: Array<{ path: string; line: number; preview: string; before: string[]; after: string[] }>; totalMatches?: number; truncated?: boolean };
  try {
    result = JSON.parse(output);
  } catch {
    return output;
  }
  if (result.success === false) return output;
  const matches = result.matches ?? [];
  const visibleMatches = matches.slice(offset, offset + limit);
  const fileMatches = new Map<string, number>();
  for (const match of matches) fileMatches.set(match.path, (fileMatches.get(match.path) ?? 0) + 1);
  const selectedFiles = [...fileMatches.keys()].slice(offset, offset + limit);
  const content = visibleMatches.map((match) => {
    const before = match.before.slice(-beforeCount);
    const after = match.after.slice(0, afterCount);
    let preview = match.preview;
    if (args["-o"] === true) {
      try {
        const flags = args["-i"] === true ? "gi" : "g";
        preview = [...match.preview.matchAll(new RegExp(pattern, flags))].map((entry) => entry[0]).join(" ");
      } catch {
        preview = match.preview;
      }
    }
    const contextRows = [
      ...before.map((line, index) => `${match.path}${args["-n"] === false ? ":" : `:${match.line - before.length + index}-`}${line}`),
      `${match.path}${args["-n"] === false ? ":" : `:${match.line}:`}${preview}`,
      ...after.map((line, index) => `${match.path}${args["-n"] === false ? ":" : `:${match.line + index + 1}-`}${line}`),
    ];
    return contextRows.join("\n");
  }).join("\n");
  return JSON.stringify({
    mode: outputMode,
    durationMs: Date.now() - startedAt,
    numFiles: fileMatches.size,
    filenames: outputMode === "files_with_matches" ? selectedFiles : [],
    ...(outputMode === "content" ? { content, numLines: visibleMatches.length } : {}),
    ...(outputMode === "count" ? { content: selectedFiles.map((file) => `${file}:${fileMatches.get(file) ?? 0}`).join("\n") } : {}),
    numMatches: result.totalMatches ?? matches.length,
    truncated: result.truncated === true,
    appliedLimit: limit,
    appliedOffset: offset,
    ...(result.message ? { message: result.message } : {}),
    ...(result.rejectedPaths?.length ? { rejectedPaths: result.rejectedPaths } : {}),
  });
}

function renameResultTool(output: string, toolName: string): string {
  try {
    const result = JSON.parse(output) as { tool?: unknown };
    if (typeof result.tool !== "string") return output;
    result.tool = toolName;
    return JSON.stringify(result);
  } catch {
    return output;
  }
}
