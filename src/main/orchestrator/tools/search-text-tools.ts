// 文本搜索工具 — 在工作区文件内容中搜索字面文本或正则匹配
//
// search_text 在工作区文件内容中做安全的文本搜索：
// - workspaceRoot 改用 ctx.resolvedWorkspaceRoot，不再依赖 process.cwd()
// - glob 自动扩展：*.ts → **/*.ts，覆盖子目录
// - 名字和描述明确声明为"文本搜索"，避免误导模型
//
// 安全约束：
// - 文件访问范围跟随当前权限档位
// - 忽略 .git、node_modules、构建产物
// - 结果数量和上下文长度限制
// - AbortSignal 和超时支持

import * as fs from "fs";
import * as path from "path";
import { toolRegistry, type ToolEffectKind, type VerificationPolicy } from "./registry/tool-registry";
import type { ToolContext } from "./registry/tool-context";
import { formatFileAccessPath, resolveFileAccessPath } from "./file-access";

const LOG_PREFIX = "[SearchText]";

// ── 常量 ──────────────────────────────────────────────────

const MAX_MATCHES = 100;           // 单次最多返回匹配数
const MAX_CONTEXT_LINES = 5;       // 上下文行数上限
const MAX_LINE_LENGTH = 500;       // 单行最大字符数（超长截断）
const MAX_FILE_SIZE = 1024 * 1024; // 跳过 >1MB 的文件
const SEARCH_TIMEOUT_MS = 30000;   // 搜索超时 30s

/** 忽略的目录名 */
const IGNORED_DIRS = new Set([
  ".git", ".svn", ".hg",
  "node_modules", "bower_components",
  "dist", "build", "out", "output", "release",
  ".next", ".nuxt", ".cache",
  "__pycache__", ".pytest_cache",
  ".idea", ".vscode",
  "coverage", ".nyc_output",
  "target", "vendor", ".venv", "venv",
  // git worktree 镜像目录：内容是工作区旧副本，搜出来会伪装成"当前代码仍有残留"
  ".worktrees", "worktrees",
]);

/** 忽略的文件扩展名（二进制/生成文件） */
const IGNORED_EXTS = new Set([
  ".exe", ".dll", ".so", ".dylib",
  ".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".ico", ".svg",
  ".mp3", ".mp4", ".wav", ".avi", ".mov",
  ".zip", ".tar", ".gz", ".rar", ".7z",
  ".pdf", ".doc", ".docx", ".xls", ".xlsx", ".ppt", ".pptx",
  ".woff", ".woff2", ".ttf", ".eot",
  ".pyc", ".pyo", ".class", ".o", ".obj",
]);

// ── 路径安全 ──────────────────────────────────────────────

/** 检查文件是否应被忽略 */
function shouldIgnoreFile(filePath: string): boolean {
  const ext = path.extname(filePath).toLowerCase();
  if (IGNORED_EXTS.has(ext)) return true;
  return false;
}

/** 检查目录是否应被忽略 */
function shouldIgnoreDir(dirName: string): boolean {
  return IGNORED_DIRS.has(dirName);
}

// ── Glob 匹配 ─────────────────────────────────────────────

// 将用户写的 glob 模式规范化：无路径前缀的模式自动加上 globstar 前缀以覆盖子目录
function normalizeGlob(pattern: string): string {
  if (pattern.includes("/") || pattern.startsWith("**/")) return pattern;
  return "**/" + pattern;
}

// 简单 glob 匹配，支持单星号和双星号
function matchesGlob(filePath: string, pattern: string): boolean {
  const normalized = normalizeGlob(pattern);
  const regexStr = normalized
    .replace(/\./g, "\\.")
    .replace(/\*\*/g, "⟨GLOBSTAR⟩")
    .replace(/\*/g, "[^/]*")
    .replace(/⟨GLOBSTAR⟩/g, ".*")
    .replace(/\?/g, "[^/]");
  const regex = new RegExp("^" + regexStr + "$");
  return regex.test(filePath);
}

// ── 搜索结果类型 ──────────────────────────────────────────

interface SearchMatch {
  path: string;         // 相对于工作区根目录的路径
  line: number;         // 行号（1-based）
  column?: number;      // 列号（1-based，可选）
  preview: string;      // 匹配行内容
  before: string[];     // 上文行
  after: string[];      // 下文行
}

interface SearchResult {
  matches: SearchMatch[];
  totalMatches: number;
  returnedMatches: number;
  truncated: boolean;
}

// ── 核心搜索逻辑 ──────────────────────────────────────────

function searchInFile(
  filePath: string,
  relativePath: string,
  query: string,
  mode: "literal" | "regex",
  caseSensitive: boolean,
  contextLines: number,
  maxMatches: number,
  remainingMatches: number,
  signal?: AbortSignal,
): SearchMatch[] {
  if (remainingMatches <= 0) return [];

  const stat = safeStat(filePath);
  if (!stat || !stat.isFile() || stat.size > MAX_FILE_SIZE) return [];

  const matches: SearchMatch[] = [];
  let lines: string[];
  try {
    lines = fs.readFileSync(filePath, "utf8").split("\n");
  } catch {
    return [];
  }

  // 构建搜索正则
  let searchRegex: RegExp;
  try {
    if (mode === "regex") {
      searchRegex = new RegExp(query, caseSensitive ? "g" : "gi");
    } else {
      const escaped = query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      searchRegex = new RegExp(escaped, caseSensitive ? "g" : "gi");
    }
  } catch {
    return []; // 无效正则
  }

  for (let i = 0; i < lines.length; i++) {
    if (signal?.aborted) break;
    if (matches.length >= remainingMatches) break;

    const line = lines[i];
    if (line.length > MAX_LINE_LENGTH) continue; // 跳过超长行

    const lineMatches = line.match(searchRegex);
    if (!lineMatches) continue;

    // 重置 lastIndex
    searchRegex.lastIndex = 0;
    const matchIndex = line.search(searchRegex);

    // 收集上下文
    const before: string[] = [];
    const after: string[] = [];
    for (let j = Math.max(0, i - contextLines); j < i; j++) {
      before.push(lines[j].slice(0, MAX_LINE_LENGTH));
    }
    for (let j = i + 1; j <= Math.min(lines.length - 1, i + contextLines); j++) {
      after.push(lines[j].slice(0, MAX_LINE_LENGTH));
    }

    matches.push({
      path: relativePath,
      line: i + 1,
      column: matchIndex >= 0 ? matchIndex + 1 : undefined,
      preview: line.slice(0, MAX_LINE_LENGTH),
      before,
      after,
    });
  }

  return matches;
}

function walkDir(
  dir: string,
  workspaceRoot: string,
  query: string,
  mode: "literal" | "regex",
  caseSensitive: boolean,
  contextLines: number,
  maxMatches: number,
  fileGlobs: string[] | undefined,
  fileExtension: string | undefined,
  signal?: AbortSignal,
  skippedDirs?: Set<string>,
  ctx?: ToolContext,
): SearchMatch[] {
  const allMatches: SearchMatch[] = [];

  function walk(currentDir: string): void {
    if (signal?.aborted) return;
    if (allMatches.length >= maxMatches) return;

    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(currentDir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      if (signal?.aborted) return;
      if (allMatches.length >= maxMatches) return;
      if (entry.isDirectory() && shouldIgnoreDir(entry.name)) {
        skippedDirs?.add(entry.name);
        continue;
      }
      if (!entry.isDirectory() && !entry.isFile()) continue;
      if (entry.isFile() && (shouldIgnoreFile(entry.name)
        || (fileExtension && path.extname(entry.name).toLowerCase() !== `.${fileExtension}`))) continue;

      const fullPath = path.join(currentDir, entry.name);
      const access = resolveFileAccessPath(fullPath, "read", ctx);
      if (!access.ok) continue;
      const relativePath = formatFileAccessPath(access.path, workspaceRoot);
      const filterPath = path.isAbsolute(relativePath) ? path.relative(dir, fullPath).split(path.sep).join("/") : relativePath;

      if (entry.isDirectory()) {
        walk(access.path);
      } else if (entry.isFile()) {

        // 文件 glob 过滤
        if (fileGlobs && fileGlobs.length > 0) {
          const matchesAny = fileGlobs.some(g => matchesGlob(filterPath, g));
          if (!matchesAny) continue;
        }

        const remaining = maxMatches - allMatches.length;
        const fileMatches = searchInFile(
          access.path, relativePath, query, mode, caseSensitive,
          contextLines, maxMatches, remaining, signal,
        );
        allMatches.push(...fileMatches);
      }
    }
  }

  walk(dir);
  return allMatches;
}

function safeStat(p: string): fs.Stats | null {
  try { return fs.statSync(p); } catch { return null; }
}

// ── 工具执行器 ────────────────────────────────────────────

async function executeSearchText(args: Record<string, unknown>, ctx?: ToolContext): Promise<string> {
  const query = String(args.query || "").trim();
  if (!query) return JSON.stringify({ success: false, errorCode: "INVALID_QUERY", error: "query 不能为空", retryable: false, matches: [], totalMatches: 0, returnedMatches: 0, truncated: false });

  const mode = (args.mode === "regex" ? "regex" : "literal") as "literal" | "regex";
  const maxMatches = Math.min(MAX_MATCHES, Math.max(1, Number(args.maxMatches) || 20));
  const contextLines = Math.min(MAX_CONTEXT_LINES, Math.max(0, Number(args.contextLines) || 2));
  const caseSensitive = args.caseSensitive === true;

  // 路径参数：默认工作区根目录
  const paths = Array.isArray(args.paths) ? args.paths.map(String) : ["."];
  const fileGlobs = Array.isArray(args.fileGlobs) ? args.fileGlobs.map(String) : undefined;
  const fileExtension = typeof args.fileExtension === "string"
    ? args.fileExtension.trim().replace(/^\./, "").toLowerCase()
    : undefined;

  // 工作区根目录：优先从 ToolContext 获取，再回退到 process.cwd()
  const workspaceRoot = ctx?.resolvedWorkspaceRoot ?? path.resolve(process.cwd());

  // AbortSignal
  const signal = ctx?.signal;

  // 超时保护
  const timeoutMs = SEARCH_TIMEOUT_MS;
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(() => reject(new Error("搜索超时")), timeoutMs);
  });

  try {
    const searchPromise = (async (): Promise<SearchResult & { success?: boolean; errorCode?: string; category?: string; error?: string; searchType?: string; message?: string; rejectedPaths?: string[]; skippedDirs?: string[] }> => {
      const allMatches: SearchMatch[] = [];
      const rejectedPaths: string[] = [];
      const skippedDirs = new Set<string>();
      let accessiblePaths = 0;

      for (const p of paths) {
        if (signal?.aborted) break;
        if (allMatches.length >= maxMatches) break;

        const access = resolveFileAccessPath(path.resolve(workspaceRoot, p), "read", ctx);
        if (!access.ok) {
          console.warn(LOG_PREFIX, "文件权限拒绝:", p);
          rejectedPaths.push(p);
          continue;
        }
        const resolvedPath = access.path;

        const stat = safeStat(resolvedPath);
        if (!stat) continue;
        accessiblePaths++;

        if (stat.isDirectory()) {
          const dirMatches = walkDir(
            resolvedPath, workspaceRoot, query, mode, caseSensitive,
            contextLines, maxMatches - allMatches.length, fileGlobs, fileExtension, signal, skippedDirs, ctx,
          );
          allMatches.push(...dirMatches);
        } else if (stat.isFile()) {
          const relativePath = formatFileAccessPath(resolvedPath, workspaceRoot);
          const filterPath = path.isAbsolute(relativePath) ? path.basename(resolvedPath) : relativePath;
          if (!shouldIgnoreFile(path.basename(resolvedPath))) {
            if (fileExtension && path.extname(resolvedPath).toLowerCase() !== `.${fileExtension}`) continue;
            if (fileGlobs && fileGlobs.length > 0) {
              const matchesAny = fileGlobs.some(g => matchesGlob(filterPath, g));
              if (!matchesAny) continue;
            }
            const fileMatches = searchInFile(
              resolvedPath, relativePath, query, mode, caseSensitive,
              contextLines, maxMatches, maxMatches - allMatches.length, signal,
            );
            allMatches.push(...fileMatches);
          }
        }
      }

      // 根据搜索结果生成明确的 message
      let message: string | undefined;
      const deniedAll = rejectedPaths.length > 0 && accessiblePaths === 0;
      if (deniedAll) {
        message = `当前权限不允许访问路径 ${rejectedPaths.join(", ")}，搜索未执行。请检查主代理当前的文件权限档位。`;
      } else if (rejectedPaths.length > 0) {
        message = `当前权限不允许访问路径 ${rejectedPaths.join(", ")}，已跳过。`;
      } else if (allMatches.length === 0) {
        message = "未找到匹配内容。这不代表目标文件不存在——Grep 搜索的是文件内容，不是文件名。要查找文件请用 Glob。";
      }
      if (skippedDirs.size > 0) {
        const note = `已排除镜像/依赖目录：${[...skippedDirs].slice(0, 5).join(", ")}。这些目录里的内容不是当前工作区代码，不参与匹配。`;
        message = message ? `${message} ${note}` : note;
      }

      return {
        ...(deniedAll ? { success: false, errorCode: "PERMISSION_DENIED", category: "permission_denied", error: message } : {}),
        matches: allMatches.slice(0, maxMatches),
        totalMatches: allMatches.length,
        returnedMatches: Math.min(allMatches.length, maxMatches),
        truncated: allMatches.length > maxMatches,
        searchType: "content",
        ...(message ? { message } : {}),
        ...(rejectedPaths.length > 0 ? { rejectedPaths } : {}),
        ...(skippedDirs.size > 0 ? { skippedDirs: [...skippedDirs].slice(0, 10) } : {}),
      };
    })();

    const result = await Promise.race([searchPromise, timeoutPromise]);
    if (timeoutId) clearTimeout(timeoutId);

    console.log(LOG_PREFIX, `搜索完成: query="${query}" mode=${mode} matches=${result.returnedMatches}/${result.totalMatches} truncated=${result.truncated}`);
    return JSON.stringify(result);
  } catch (err) {
    if (timeoutId) clearTimeout(timeoutId);
    const msg = err instanceof Error ? err.message : String(err);
    console.error(LOG_PREFIX, "搜索失败:", msg);
    return JSON.stringify({ success: false, errorCode: "SEARCH_FAILED", error: msg, retryable: false, matches: [], totalMatches: 0, returnedMatches: 0, truncated: false });
  }
}

// ── 注册 ──────────────────────────────────────────────────

export function registerSearchTextTool(): void {
  toolRegistry.register({
    id: "search_text",
    name: "文本搜索",
    catalogHint: "【文本级】在工作区文件内容中搜索字面文本或正则表达式，返回路径、行号和上下文。",
    description:
      "在当前工作区的真实文件内容中实时搜索字面文本或正则表达式，返回匹配的文件路径、行号和少量上下文。\n\n" +
      "何时用：\n" +
      "- 已知某个字面文本（URL、错误消息、硬编码字符串）在哪些文件里\n" +
      "- 用正则表达式查找符合模式的文本片段\n" +
      "- 快速定位包含特定字符串的文件\n\n" +
      "不要用于：\n" +
      "- 判断某个函数/类是否存在（纯文本会命中注释/字符串）→ 用 ast_grep_search 或 lsp\n" +
      "- 读取完整文件内容 → read_file\n" +
      "- 列出目录结构 → list_dir\n" +
      "- 查找文件名 → list_dir 或 Glob\n" +
      "- 修改代码 → str_replace/apply_patch\n\n" +
      "参数：query（搜索文本），mode（可选，literal 默认 / regex 正则），paths（可选，搜索路径），" +
      "fileGlobs（可选，文件过滤如 '*.ts' 自动扩展为 '**/*.ts'），" +
      "maxMatches（可选，最多返回数），contextLines（可选，上下文行数），caseSensitive（可选，区分大小写）。",
    enabled: true,
    risk: "fs-read",
    modes: ["code", "work"],
    effectKind: "read" as const,
    isConcurrencySafe: () => true,
    verificationPolicy: "none" as const,
    needsContext: true,
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "要搜索的文本" },
        mode: { type: "string", enum: ["literal", "regex"], description: "搜索模式：literal（默认，字面匹配）或 regex（正则表达式）" },
        paths: { type: "array", description: "搜索路径（相对于工作区根目录，默认 '.'）", items: { type: "string" } },
        fileGlobs: { type: "array", description: "文件过滤 glob（如 '*.ts' 会自动扩展为 '**/*.ts' 覆盖子目录）", items: { type: "string" } },
        maxMatches: { type: "number", description: "最多返回匹配数（默认 20，上限 100）" },
        contextLines: { type: "number", description: "上下文行数（默认 2，上限 5）" },
        caseSensitive: { type: "boolean", description: "是否区分大小写（默认 false）" },
      },
      required: ["query"],
    },
    execute: executeSearchText,
  });

  console.log(LOG_PREFIX, "已注册：search_text");
}
