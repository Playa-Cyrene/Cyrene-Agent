// 文件系统工具组 — 给 agent 装上"读文件 / 列目录 / 写文件 / 读图片"四件武器
// 不绕 run_shell，直接用 fs API。每个工具都有 risk 字段交给权限网关判定。

import * as fs from "fs";
import * as path from "path";
import { toolRegistry } from "./registry/tool-registry";
import { captionImage } from "../vision-captioner";
import type { ToolContext } from "./registry/tool-context";
import type { ToolFileChange } from "../../../shared/chat-types";
import { buildFullFileDiff, buildReplacedDiff, countLines, finalizeFileChanges } from "./registry/tool-evidence";
import { checkOverwriteDrop, overwriteDropMessage } from "./overwrite-guard";
import type { VerificationPolicy } from "./registry/tool-registry";
import { logger, LogTag } from "../../logger";
import { ToolExecutionError } from "./registry/tool-execution-error";
import { app } from "electron";
import { getRunReviewTracker } from "../review/run-review-tracker";

const LOG_PREFIX = "[FsTools]";

const READ_MAX_BYTES = 10 * 1024 * 1024;  // 内存保护上限：超过直接拒绝（不做静默截断）
const LIST_MAX_ENTRIES = 200;            // 单次目录列举最多 200 项
const IMAGE_MAX_BYTES = 5 * 1024 * 1024; // 图片最多 5MB

// 图片扩展名集合，用于 list_dir 标注 [图片] 和汇总计数
const IMAGE_EXTS = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".svg", ".ico"]);

function ensureAbsolute(p: string): string | null {
  if (!p) return null;
  if (!path.isAbsolute(p)) return null;
  return path.normalize(p);
}

function safeStat(p: string): fs.Stats | null {
  try { return fs.statSync(p); } catch { return null; }
}

function humanBytes(n: number): string {
  if (n < 1024) return n + "B";
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + "KB";
  if (n < 1024 * 1024 * 1024) return (n / 1024 / 1024).toFixed(1) + "MB";
  return (n / 1024 / 1024 / 1024).toFixed(2) + "GB";
}

// ── 工具 1：read_file ─────────────────────────────────────

async function executeReadFile(args: Record<string, unknown>): Promise<string> {
  const raw = String(args.path || "").trim();
  const filePath = ensureAbsolute(raw);
  if (!filePath) {
    console.log(LOG_PREFIX, "read_file 非绝对路径:", raw, "cwd=", process.cwd());
    return JSON.stringify({ success: false, errorCode: "INVALID_PATH", error: "path 必须是绝对路径: " + raw, retryable: false });
  }

  const stat = safeStat(filePath);
  if (!stat) {
    console.log(LOG_PREFIX, "read_file 文件不存在:", filePath, "raw=", raw, "cwd=", process.cwd());
    return JSON.stringify({
      success: false,
      errorCode: "FILE_NOT_FOUND",
      error: "文件不存在或无法访问: " + filePath + "。不要重复读取相同路径，请先用 search_text 或 list_dir 重新定位文件。",
      retryable: true,
    });
  }
  if (!stat.isFile()) return JSON.stringify({ success: false, errorCode: "NOT_A_FILE", error: "不是文件（是目录或其它）: " + filePath, retryable: false });

  const startLine = Math.max(1, Number(args.startLine) || 1);
  const maxLines = Math.max(1, Math.min(2000, Number(args.maxLines) || 500));

  console.log(LOG_PREFIX, "read_file:", filePath, "size=" + humanBytes(stat.size), "lines=" + startLine + "..+" + maxLines);

  let buf: Buffer;
  try {
    buf = fs.readFileSync(filePath);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return JSON.stringify({ success: false, errorCode: "READ_FAILED", error: "读取失败: " + msg, retryable: false });
  }

  // 超过内存保护上限直接拒绝：不做静默截断——截断后统计的 totalLines 会严重低报，
  // 模型翻页到低报行数时拿到空内容误判 EOF，后半文件静默丢失
  if (buf.length > READ_MAX_BYTES) {
    return JSON.stringify({
      success: false,
      errorCode: "FILE_TOO_LARGE",
      error: `文件超过 ${humanBytes(READ_MAX_BYTES)}（当前 ${humanBytes(stat.size)}），read_file 暂不支持读取。可用 search_text 直接获取匹配行的上下文。`,
      path: filePath,
      size: humanBytes(stat.size),
      retryable: false,
    });
  }

  // 二进制启发：前 4KB 出现大量 \0 → 当作二进制
  const head = buf.subarray(0, Math.min(buf.length, 4096));
  let nullCount = 0;
  for (let i = 0; i < head.length; i++) if (head[i] === 0) nullCount++;
  if (nullCount > head.length * 0.05) {
    return JSON.stringify({
      success: false,
      errorCode: "BINARY_FILE",
      error: "这看起来是二进制文件，read_file 只支持文本。如果是图片，请改用 read_image。",
      path: filePath,
      size: humanBytes(stat.size),
      retryable: false,
    });
  }

  const text = buf.toString("utf8");
  // 单次扫描：统计真实总行数，同时只收集 startLine 起的 maxLines 行。
  // 不用 split 建全量行数组——10MB 短行文件会产生百万级字符串对象。
  // 换行语义对齐旧的 split(/\r?\n/)：\n 是唯一分隔符，行内容不含结尾的 \r；EOF 无换行时末尾算一行。
  const windowLines: string[] = [];
  let totalLines = 1;
  let currentLine = 1;
  let lineStart = 0;
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) === 10 /* \n */) {
      if (currentLine >= startLine && windowLines.length < maxLines) {
        let lineEnd = i;
        if (lineEnd > lineStart && text.charCodeAt(lineEnd - 1) === 13 /* \r */) lineEnd--;
        windowLines.push(text.slice(lineStart, lineEnd));
      }
      currentLine++;
      totalLines++;
      lineStart = i + 1;
    }
  }
  if (currentLine >= startLine && windowLines.length < maxLines) {
    windowLines.push(text.slice(lineStart));
  }
  const endLine = startLine + windowLines.length - 1;

  // 结构化输出
  const result = {
    path: filePath,
    startLine,
    endLine,
    totalLines,
    content: windowLines.map((line, i) => {
      const ln = startLine + i;
      return String(ln).padStart(5, " ") + " | " + line;
    }).join("\n"),
    truncated: false,
  };

  console.log(LOG_PREFIX, "read_file 完成: lines=" + startLine + ".." + endLine + "/" + totalLines);
  return JSON.stringify(result);
}

toolRegistry.register({
  id: "read_file",
  name: "读取文件",
  description:
    "读取本地文本文件（小说、笔记、代码、配置、日志等）。返回带行号的文本内容。" +
    "支持最大 10MB 的文本文件；totalLines 是真实总行数，可用 startLine/maxLines 精确翻页。\n" +
    "文件超过 10MB 会明确报错，改用 search_text 直接获取匹配行的上下文。\n\n" +
    "何时用：\n" +
    "- 用户消息里出现任何本地文件路径、文件名、扩展名（.txt/.md/.json/.py/.log 等）\n" +
    "- 用户问'这个文件写了什么''看看 xxx'\n" +
    "- 需要拿文件实际内容才能回答的问题\n\n" +
    "不要用于：\n" +
    "- 凭印象猜内容（绝对不行，必须先 read）\n" +
    "- 读图片 → read_image\n" +
    "- 列目录 → list_dir\n\n" +
    "参数：path (必填，绝对路径)，startLine (可选，默认 1)，maxLines (可选，默认 500)。",
  enabled: true,
  risk: "fs-read",
  modes: ["learn", "code", "work"],
  effectKind: "read" as const,
  // 只读同步文件读取；不会改工作区或 Harness 父状态。
  isConcurrencySafe: () => true,
  verificationPolicy: "none" as const,
  inputSchema: {
    type: "object",
    properties: {
      path: { type: "string", description: "要读的文件绝对路径，例如 'C:\\\\Users\\\\me\\\\notes.txt'" },
      startLine: { type: "number", description: "起始行号，默认 1" },
      maxLines: { type: "number", description: "最多读多少行，默认 500，最大 2000" },
    },
    required: ["path"],
  },
  execute: executeReadFile,
});

// ── 工具 2：list_dir ──────────────────────────────────────

async function executeListDir(args: Record<string, unknown>): Promise<string> {
  const raw = String(args.path || "").trim();
  const dirPath = ensureAbsolute(raw);
  if (!dirPath) return "[错误] path 必须是绝对路径";

  const stat = safeStat(dirPath);
  if (!stat) return "[错误] 目录不存在或无法访问: " + dirPath;
  if (!stat.isDirectory()) return "[错误] 不是目录: " + dirPath;

  const showHidden = args.showHidden === true;
  const filter = typeof args.filter === "string" ? args.filter.trim() : "";
  console.log(LOG_PREFIX, "list_dir:", dirPath, "showHidden=" + showHidden);

  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dirPath, { withFileTypes: true });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return "[错误] 读取目录失败: " + msg;
  }

  if (!showHidden) {
    entries = entries.filter(e => !e.name.startsWith("."));
  }

  // 文件夹在前，文件在后；同类按名字排序
  entries.sort((a, b) => {
    const da = a.isDirectory() ? 0 : 1;
    const db = b.isDirectory() ? 0 : 1;
    if (da !== db) return da - db;
    return a.name.localeCompare(b.name);
  });

  const truncated = entries.length > LIST_MAX_ENTRIES;
  const slice = truncated ? entries.slice(0, LIST_MAX_ENTRIES) : entries;

  // 汇总图片数量，让模型不用逐个数就能回答"有几张图"
  const imageCount = entries.filter(e => e.isFile() && IMAGE_EXTS.has(path.extname(e.name).toLowerCase())).length;

  const lines: string[] = [];
  lines.push("dir: " + dirPath);
  lines.push(
    "count: " + entries.length +
    (imageCount > 0 ? " (其中图片 " + imageCount + " 张)" : "") +
    (filter ? " (filter: " + filter + ")" : "") +
    (truncated ? " (仅显示前 " + LIST_MAX_ENTRIES + " 项)" : ""),
  );
  lines.push("");

  for (const ent of slice) {
    const full = path.join(dirPath, ent.name);
    if (ent.isDirectory()) {
      lines.push("[D] " + ent.name + "/");
    } else if (ent.isFile()) {
      const st = safeStat(full);
      const size = st ? "  " + humanBytes(st.size) : "";
      // 标注文件类型，重点让图片显式可见，模型才能数清"有几张图"
      const ext = path.extname(ent.name).toLowerCase();
      const tag = IMAGE_EXTS.has(ext) ? "  [图片]" : "";
      lines.push("[F] " + ent.name + size + tag);
    } else if (ent.isSymbolicLink()) {
      lines.push("[L] " + ent.name);
    } else {
      lines.push("[?] " + ent.name);
    }
  }
  return lines.join("\n");
}

toolRegistry.register({
  id: "list_dir",
  name: "列出目录",
  description:
    "列出某个目录下的子目录和文件。输出会对图片文件标注 [图片]，并在 count 行汇总图片数量。\n\n" +
    "何时用：\n" +
    "- 用户问'我那里有什么文件''看看 D:/小说 下面''有几张图片'\n" +
    "- 用户提到目录名但不知道里面有什么\n" +
    "- 想确认某个文件是否存在于某个目录\n\n" +
    "不要用于：\n" +
    "- 读具体文件内容 → read_file\n" +
    "- 用户给了完整文件路径 → 直接 read_file\n\n" +
    "参数：path (必填，绝对路径)，showHidden (可选，是否显示以 . 开头的隐藏项，默认 false)。",
  enabled: true,
  risk: "fs-read",
  modes: ["learn", "code", "work"],
  effectKind: "read" as const,
  // 只读目录枚举；不会改工作区或 Harness 父状态。
  isConcurrencySafe: () => true,
  verificationPolicy: "none" as const,
  inputSchema: {
    type: "object",
    properties: {
      path: { type: "string", description: "要列举的目录绝对路径" },
      showHidden: { type: "boolean", description: "是否包含隐藏项（以 . 开头），默认 false" },
    },
    required: ["path"],
  },
  execute: executeListDir,
});

// ── 工具 3：write_file ────────────────────────────────────

/**
 * 解析写入路径：绝对路径照旧；相对路径收编自原 write_markdown——
 * 根目录固定为可信工作区（未绑定时回退桌面），禁止 .. 穿越和前缀碰撞绕过。
 * 返回绝对路径，或 null 表示校验失败。
 */
function resolveWritePath(rawPath: string, workspaceRoot?: string): string | null {
  if (path.isAbsolute(rawPath)) return path.normalize(rawPath);
  const normalized = path.normalize(rawPath).replace(/\\/g, "/");
  // 相对路径禁止目录穿越
  if (normalized.includes("..")) return null;
  const outputRoot = path.resolve(workspaceRoot || app.getPath("desktop"));
  const fullPath = path.resolve(outputRoot, normalized);
  const relative = path.relative(outputRoot, fullPath);
  // 最终校验：必须仍在根目录下，不能靠前缀碰撞绕过
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) return null;
  return fullPath;
}

async function executeWriteFile(args: Record<string, unknown>, ctx?: ToolContext): Promise<string> {
  const raw = String(args.path || "").trim();
  const filePath = resolveWritePath(raw, ctx?.resolvedWorkspaceRoot);
  if (!filePath) {
    throw new ToolExecutionError(
      "E_PATH_NOT_ABSOLUTE",
      "path 必须是绝对路径，或不含 .. 的相对文件名（相对路径以工作区/桌面为根）",
      "invalid_arguments",
    );
  }

  const content = typeof args.content === "string" ? args.content : "";
  const append = args.append === true;
  const createDirs = args.createDirs !== false; // 默认创建父目录
  const existedBefore = fs.existsSync(filePath);

  // 写前现读当前文件，同一份内容用于三处：骤降检查（软截断检测，仅覆盖写）、
  // 行级 diff 生成、追加写补换行。不走 review 基线——基线是本 run 第一次修改
  // 前的状态，本轮早前可能已改过该文件，用基线会把骤降口径和 diff 都算错。
  let existingContent: string | null = null;
  if (existedBefore) {
    try {
      existingContent = fs.readFileSync(filePath, "utf8");
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new ToolExecutionError(
        "E_READ_BEFORE_OVERWRITE_FAILED",
        "写前读取原文件失败，已拒绝覆盖写: " + msg,
        "permission_denied",
      );
    }
    if (!append) {
      const drop = checkOverwriteDrop(existingContent, content);
      if (drop.blocked) {
        // 拒绝发生在落盘之前，文件保持原样
        throw new ToolExecutionError(
          "E_OVERWRITE_DROP_BLOCKED",
          overwriteDropMessage(drop),
          "runtime_safety",
          false,
          "not_applied",
        );
      }
    }
  }

  console.log(LOG_PREFIX, "write_file:", filePath, "bytes=" + Buffer.byteLength(content, "utf8"), append ? "(append)" : "(overwrite)");

  if (createDirs) {
    try {
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new ToolExecutionError(
        "E_CREATE_PARENT_FAILED",
        "创建父目录失败: " + msg,
        "permission_denied",
      );
    }
  }

  // Review 基线捕获：在写文件之前保存 pre-mutation baseline
  if (ctx?.runId) {
    const tracker = getRunReviewTracker(app.getPath("userData"));
    tracker.captureBefore(ctx.runId, filePath);
  }

  try {
    if (append) {
      // 追加写：原文件末尾缺换行时补一个，避免两段内容粘在同一行
      const needsNewline = existingContent !== null && existingContent.length > 0 && !existingContent.endsWith("\n");
      fs.appendFileSync(filePath, (needsNewline ? "\n" : "") + content, "utf8");
    } else {
      fs.writeFileSync(filePath, content, "utf8");
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new ToolExecutionError(
      "E_WRITE_FILE_FAILED",
      "写入失败: " + msg,
      "semantic_failure",
      false,
      "unknown",
    );
  }

  let st: fs.Stats;
  try {
    st = fs.statSync(filePath);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new ToolExecutionError(
      "E_WRITE_EVIDENCE_FAILED",
      "写入完成但无法确认文件状态: " + msg,
      "partial_failure",
      false,
      "unknown",
    );
  }
  // Diff Review 卡片证据：新文件/追加=added，覆盖已有=modified
  // diff 展示统一按 LF 拆行，避免 CRLF 残留到卡片渲染
  const insertions = countLines(content);
  const change: ToolFileChange = append || !existedBefore
    ? {
        file: filePath,
        kind: "added",
        insertions,
        deletions: 0,
        diff: buildFullFileDiff(insertions === 0 ? [] : content.split("\n").slice(0, insertions), "add"),
      }
    : {
        file: filePath,
        kind: "modified",
        insertions,
        deletions: countLines(existingContent ?? ""),
        // 覆盖写 = 整文件替换：旧全文 remove + 新全文 add，行级上限由 finalizeFileChanges 控制
        diff: buildReplacedDiff(
          (existingContent ?? "").replace(/\r\n/g, "\n").split("\n"),
          content.replace(/\r\n/g, "\n").split("\n"),
        ),
      };

  return JSON.stringify({
    success: true,
    tool: "write_file",
    path: filePath,
    append,
    exists: st.isFile(),
    sizeBytes: st.size,
    writtenBytes: Buffer.byteLength(content, "utf8"),
    changes: finalizeFileChanges([change]),
  });
}

function resolveWriteFilePolicy(args: Record<string, unknown>): VerificationPolicy {
  const rawPath = String(args.path ?? "");
  const normalizedPath = rawPath.replace(/\\/g, "/").toLowerCase();
  const fileName = normalizedPath.split("/").pop() ?? "";
  const ext = normalizedPath.slice(normalizedPath.lastIndexOf("."));

  // 配置文件名 -> code（精确匹配）
  const codeConfigFiles = new Set([
    "package.json", "tsconfig.json", "tsconfig.main.json", "tsconfig.preload.json",
    "vite.config.ts", "vite.config.js", "vitest.config.ts",
    ".eslintrc", ".eslintrc.js", ".eslintrc.json", ".prettierrc",
    "babel.config.js", "babel.config.json", "webpack.config.js",
  ]);
  if (codeConfigFiles.has(fileName)) return "code";

  // 明确代码扩展名 -> code
  const codeExtensions = [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".py", ".go", ".rs", ".java", ".c", ".cpp", ".h", ".cs", ".rb", ".php", ".swift", ".kt"];
  if (codeExtensions.includes(ext)) return "code";

  // 明确产物扩展名 -> artifact
  const artifactExtensions = [".docx", ".xlsx", ".pdf", ".csv", ".png", ".jpg", ".jpeg", ".gif", ".svg", ".bmp", ".ico", ".mp3", ".mp4", ".zip", ".tar", ".gz"];
  if (artifactExtensions.includes(ext)) return "artifact";

  // 模糊扩展名 -> 检查路径上下文
  const ambiguousExtensions = [".json", ".md", ".html", ".htm", ".yml", ".yaml", ".xml", ".toml", ".ini", ".env"];
  if (ambiguousExtensions.includes(ext)) {
    if (/\/src\/|\/test[s]?\//.test(normalizedPath)) return "code";
    if (/\/dist\/|\/build\/|\/output\//.test(normalizedPath)) return "artifact";
    return "unknown";
  }

  return "unknown";
}

toolRegistry.register({
  id: "write_file",
  name: "写入文件",
  description:
    "把文本内容写入本地文件，覆盖或追加。会自动创建父目录。\n" +
    "覆盖已有大文件时若新内容行数骤降过半会被拒绝（防输出截断毁文件），此时改用 str_replace 做局部修改。\n" +
    "笔记很长时不要一次性写入：先写前半部分，再用 append=true 续写后半部分。\n\n" +
    "何时用：\n" +
    "- 用户要保存生成的笔记、改写后的文本、配置\n" +
    "- 用户要写笔记 / 纯文本文件（.md / .txt）\n" +
    "- 用户要新建文件\n" +
    "- 需要持久化一段内容到磁盘\n\n" +
    "不要用于：\n" +
    "- 修改已有文件的局部内容（用 str_replace/apply_patch 更安全）\n" +
    "- 生成 Excel/Word/PDF 文档（用对应专用工具）\n" +
    "- 写入危险系统路径\n\n" +
    "path 两种给法：绝对路径；或相对文件名（可含子目录，如 '笔记.md'、'test/report.md'）——" +
    "绑定项目时落到项目根目录，未绑定时落到桌面。\n" +
    "参数：path，content (要写的字符串)，append (可选，true=追加，默认 false=覆盖)，createDirs (可选，默认 true)。",
  enabled: true,
  risk: "fs-write",
  modes: ["learn", "code", "work"],
  effectKind: "mutation" as const,
  verificationPolicyResolver: resolveWriteFilePolicy,
  inputSchema: {
    type: "object",
    properties: {
      path: { type: "string", description: "目标文件绝对路径，或相对文件名（可含子目录，如 '笔记.md'；绑定项目时落到项目根目录，未绑定时落到桌面）" },
      content: { type: "string", description: "要写入的文本内容（UTF-8）" },
      append: { type: "boolean", description: "true=追加，false=覆盖（默认）" },
      createDirs: { type: "boolean", description: "是否自动创建父目录，默认 true" },
    },
    required: ["path", "content"],
  },
  execute: executeWriteFile,
});

// ── 工具 4：read_image ────────────────────────────────────
// 资源访问层：读图片→base64→交 vision-captioner 看图→返回文字。
// 不懂视觉，看图的活外包给 captioner。

// 懒加载图片转述视觉配置：动态 import，规避注册期副作用。
// 路由判定收口在 image-router（全项目唯一），本文件不再自行判断。
async function loadCaptionVisionConfigLazy(): Promise<import("../image-router").CaptionVisionConfig> {
  const settingsMod = await import("../../settings/model-settings");
  const settings = settingsMod.resolveModelSettingsProfile(settingsMod.loadModelSettings());
  const router = await import("../image-router");
  return router.resolveCaptionVisionConfig(settings);
}

async function executeReadImage(
  args: Record<string, unknown>,
  ctx?: ToolContext,
): Promise<string> {
  const raw = String(args.path || "").trim();
  const filePath = ensureAbsolute(raw);
  if (!filePath) return "[错误] path 必须是绝对路径";

  const stat = safeStat(filePath);
  if (!stat) return "[错误] 文件不存在或无法访问: " + filePath;
  if (!stat.isFile()) return "[错误] 不是文件: " + filePath;
  if (stat.size > IMAGE_MAX_BYTES) {
    return "[错误] 图片过大（>" + humanBytes(IMAGE_MAX_BYTES) + "），当前 " + humanBytes(stat.size);
  }

  const ext = path.extname(filePath).toLowerCase();
  const mimeMap: Record<string, string> = {
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".gif": "image/gif",
    ".webp": "image/webp",
    ".bmp": "image/bmp",
    ".svg": "image/svg+xml",
  };
  const mime = mimeMap[ext];
  if (!mime) {
    return "[错误] 不支持的图片格式: " + ext + "（支持 png/jpg/jpeg/gif/webp/bmp/svg）";
  }

  console.log(LOG_PREFIX, "read_image:", filePath, "mime=" + mime, "size=" + humanBytes(stat.size));

  let buf: Buffer;
  try {
    buf = fs.readFileSync(filePath);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return "[错误] 读取失败: " + msg;
  }

  // 查图片转述路由（image-router 统一判定；Anthropic 主模型未配视觉模型时在此明确拒绝）
  const captionVision = await loadCaptionVisionConfigLazy();
  if (!captionVision.ok) {
    return "[错误·配置] " + captionVision.error;
  }

  // 调视觉模型看图，用户问题从 ToolContext 来
  const userQuery = ctx?.userQuery ?? "";
  const result = await captionImage(
    { base64: buf.toString("base64"), mime },
    userQuery,
    captionVision.config,
  );
  return result;
}

toolRegistry.register({
  id: "read_image",
  name: "读取图片",
  description:
    "读取本地图片文件，交给视觉模型分析后返回文字描述。支持 png/jpg/jpeg/gif/webp/bmp/svg，最大 5MB。\n\n" +
    "何时用：\n" +
    "- 用户提到截图、图片，想知道内容\n" +
    "- 用户说'看看这张图''图片里是什么'\n" +
    "- 环境信息里说'当前模型支持查看图片'时\n\n" +
    "不要用于：\n" +
    "- 环境信息说'不支持查看图片'时（直接告诉用户看不了，不要调）\n" +
    "- 读文本文件 → read_file\n" +
    "- 批量读图（逐张调用，不要一次性塞多张）\n\n" +
    "若未配置视觉模型会返回错误，届时如实告诉用户看不了。" +
    "参数：path (必填，绝对路径)。",
  enabled: true,
  risk: "fs-read",
  modes: ["learn", "code", "work"],
  effectKind: "read" as const,
  verificationPolicy: "none" as const,
  needsContext: true,
  inputSchema: {
    type: "object",
    properties: {
      path: { type: "string", description: "图片文件绝对路径" },
    },
    required: ["path"],
  },
  execute: executeReadImage,
});

logger.info(LogTag.FsTools, "registered: read_file / list_dir / write_file / read_image");
