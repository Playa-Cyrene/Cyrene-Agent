import * as fs from "fs";
import * as path from "path";
import { pathToFileURL } from "url";
import type { ImportedDocumentChunk, ImportedDocumentResult } from "./index";

// ── Public types ──
export type AttachmentKind = "text" | "indexed" | "empty" | "unsupported" | "image" | "document";

export type Attachment =
  | { kind: "text"; name: string; text: string; filePath?: string; mime?: string }
  | { kind: "indexed"; name: string; chunks: number; importId?: string; cached?: boolean; filePath?: string; mime?: string; reason?: string; retrievedChunks?: ImportedDocumentChunk[] }
  | { kind: "empty"; name: string; filePath?: string; mime?: string }
  | { kind: "unsupported"; name: string; reason: string; filePath?: string; mime?: string; status?: "error" }
  | { kind: "image"; name: string; filePath: string; mime?: string; status: "pending"; previewUrl?: string; caption?: string }
  | { kind: "document"; name: string; filePath: string; mime?: string; status: "pending" | "done" | "error" };

/** ingestOneFile 的大文件索引回调签名。由调用方（index.ts）注入具体实现（importDocument）。 */
export type DocumentImportProgress = {
  status: "chunking" | "embedding" | "cached";
  completedChunks?: number;
  totalChunks?: number;
};
export type DocumentImportControl = {
  isCancelled?: () => boolean;
  onProgress?: (progress: DocumentImportProgress) => void;
};
export type ImportFn = (text: string, fileName: string, control?: DocumentImportControl) => Promise<ImportedDocumentResult>;
export type SearchImportedChunksFn = (query: string, importIds: string[], topK?: number) => Promise<ImportedDocumentChunk[]>;
export type DocumentImportOptions = {
  importDocument: ImportFn;
  getCachedImport?: (text: string) => Promise<Pick<ImportedDocumentResult, "importId" | "chunkCount"> | null>;
  putCachedImport?: (text: string, fileName: string, imported: ImportedDocumentResult) => Promise<void>;
  isCancelled?: () => boolean;
  onProgress?: (progress: DocumentImportProgress) => void;
};
export type DocumentImport = ImportFn | DocumentImportOptions;

// ── Thresholds ──
/** 小文件 vs 大文件（→RAG）的分界，字符数。 */
export const SMALL_THRESHOLD = 30_000;

// ── 扩展名路由 ──
const TEXT_EXTS = new Set([
  ".txt", ".md", ".markdown", ".json", ".csv", ".tsv", ".log",
  ".xml", ".yaml", ".yml",
  ".js", ".mjs", ".ts", ".tsx", ".jsx",
  ".py", ".java", ".c", ".cpp", ".cc", ".h", ".hpp",
  ".rs", ".go", ".rb", ".php", ".sh", ".bash",
  ".css", ".scss", ".sql",
  ".ini", ".conf", ".toml", ".env",
  ".svg", ".html", ".htm",
]);

export const IMAGE_EXTS = new Set([
  ".png", ".jpg", ".jpeg", ".gif", ".bmp", ".webp",
]);

const UNSUPPORTED_EXTS = new Set([
  ".zip", ".7z", ".rar", ".tar", ".gz",
  ".pdf", ".doc", ".docx", ".xls", ".xlsx", ".ppt", ".pptx",
  ".png", ".jpg", ".jpeg", ".gif", ".bmp", ".webp", ".ico",
  ".mp3", ".mp4", ".wav", ".avi", ".mov",
  ".exe", ".dll", ".so", ".dylib", ".bin",
  ".class", ".jar", ".pyc",
  ".o", ".a", ".wasm",
]);

export function isTextExt(ext: string): boolean {
  return TEXT_EXTS.has(ext.toLowerCase());
}

export function isImageExt(ext: string): boolean {
  return IMAGE_EXTS.has(ext.toLowerCase());
}

export function getMimeFromExt(ext: string): string {
  switch (ext.toLowerCase()) {
    case ".png": return "image/png";
    case ".jpg":
    case ".jpeg": return "image/jpeg";
    case ".gif": return "image/gif";
    case ".bmp": return "image/bmp";
    case ".webp": return "image/webp";
    default: return "application/octet-stream";
  }
}

export function isUnsupportedExt(ext: string): boolean {
  return UNSUPPORTED_EXTS.has(ext.toLowerCase());
}

export function isDocumentExt(ext: string): boolean {
  const normalized = ext.toLowerCase();
  return normalized === "" || isTextExt(normalized);
}

/** 拖入阶段的 pending 附件描述：图片按「扩展名或 MIME」判定，与渲染端预览口径一致。 */
export function describePendingAttachment(filePath: string, mime?: string): Attachment {
  const ext = path.extname(filePath).toLowerCase();
  const name = path.basename(filePath);
  if (isImageExt(ext) || (typeof mime === "string" && mime.startsWith("image/"))) {
    return {
      name,
      kind: "image",
      filePath,
      // 扩展名优先；无扩展名（如截图工具产物）时用调用方传入的 MIME
      mime: isImageExt(ext) ? getMimeFromExt(ext) : (mime ?? getMimeFromExt(ext)),
      previewUrl: pathToFileURL(filePath).toString(),
      status: "pending",
    };
  }
  if (isDocumentExt(ext)) {
    return {
      name,
      kind: "document",
      filePath,
      status: "pending",
    };
  }
  return {
    name,
    kind: "unsupported",
    filePath,
    status: "error",
    reason: `暂不支持的文件格式 ${ext || "（无扩展名）"}`,
  };
}

/**
 * 判二进制：读前 8KB 中有无 null 字节。
 * 不要求读满，如果文件小于 8KB 就全读完。
 */
const BINARY_SCAN_BYTES = 8192;

export function isBinary(buf: Buffer): boolean {
  const len = Math.min(buf.length, BINARY_SCAN_BYTES);
  for (let i = 0; i < len; i++) {
    if (buf[i] === 0) return true;
  }
  return false;
}

async function indexLargeText(
  text: string,
  name: string,
  documentImport: DocumentImport,
): Promise<Attachment> {
  const options: DocumentImportOptions = typeof documentImport === "function"
    ? { importDocument: documentImport }
    : documentImport;

  if (options.isCancelled?.()) {
    return { name, kind: "indexed", chunks: 0, reason: "cancelled" };
  }

  if (options.getCachedImport) {
    try {
      const cached = await options.getCachedImport(text);
      if (cached) {
        options.onProgress?.({ status: "cached", completedChunks: cached.chunkCount, totalChunks: cached.chunkCount });
        return { name, kind: "indexed", chunks: cached.chunkCount, importId: cached.importId, cached: true };
      }
    } catch (err) {
      console.warn("[RAG] document cache lookup failed:", err);
    }
  }

  try {
    const control: DocumentImportControl = {
      isCancelled: options.isCancelled,
      onProgress: options.onProgress,
    };
    const imported = control.isCancelled || control.onProgress
      ? await options.importDocument(text, name, control)
      : await options.importDocument(text, name);
    if (options.isCancelled?.()) {
      return { name, kind: "indexed", chunks: 0, reason: "cancelled" };
    }
    if (options.putCachedImport) {
      try {
        await options.putCachedImport(text, name, imported);
      } catch (err) {
        console.warn("[RAG] document cache write failed:", err);
      }
    }
    return { name, kind: "indexed", chunks: imported.chunkCount, importId: imported.importId };
  } catch (err: any) {
    return { name, kind: "indexed", chunks: 0, reason: err?.message || String(err) };
  }
}

// ── 核心路由：处理单个文件 ──

/**
 * 摄入一个文件。
 * @param filePath 绝对路径
 * @param importFn 大文件时调用的导入函数（通常为 importDocument）
 */
export async function ingestOneFile(
  filePath: string,
  documentImport: DocumentImport,
): Promise<Attachment> {
  let stat: fs.Stats;
  try {
    stat = fs.statSync(filePath);
  } catch (err: any) {
    return { name: path.basename(filePath), kind: "unsupported", reason: err?.code || String(err) };
  }
  if (!stat.isFile()) {
    return { name: path.basename(filePath), kind: "unsupported", reason: "不是文件" };
  }

  const name = path.basename(filePath);
  const ext = path.extname(filePath).toLowerCase();

  // 显式不支持的类型
  if (isUnsupportedExt(ext)) {
    return { name, kind: "unsupported", reason: `暂不支持的文件格式 ${ext}（MVP-0 仅支持文本）` };
  }

  // 读取文件
  let buf: Buffer;
  try {
    buf = fs.readFileSync(filePath);
  } catch (err: any) {
    return { name, kind: "unsupported", reason: err?.code || String(err) };
  }

  // 类型判断与内容提取
  // 文本扩展名
  if (isTextExt(ext)) {
    // 二进制兜底：标题是文本但实际含 null 字节
    if (isBinary(buf)) {
      return { name, kind: "unsupported", reason: `文件 ${ext} 含二进制数据，暂不支持` };
    }
    const text = buf.toString("utf-8");
    if (!text.trim()) {
      return { name, kind: "empty" };
    }
    if (text.length > SMALL_THRESHOLD) {
      // 大文本 → 索引到 Vector DB
      return indexLargeText(text, name, documentImport);
    }
    return { name, kind: "text", text };
  }

  // 无扩展名或未知扩展名：用 null 字节检测
  if (isBinary(buf)) {
    return { name, kind: "unsupported", reason: "二进制文件，暂不支持" };
  }
  // 无扩展名的文本文件
  const text = buf.toString("utf-8");
  if (!text.trim()) {
    return { name, kind: "empty" };
  }
  if (text.length > SMALL_THRESHOLD) {
    return indexLargeText(text, name, documentImport);
  }
  return { name, kind: "text", text };
}

// ── 目录递归 ──

/**
 * 递归遍历目录，返回所有（非隐藏）文件的绝对路径。
 * 遇到无权限等异常时跳过该条目，不抛。
 */
export function walkDir(dirPath: string): string[] {
  const result: string[] = [];
  try {
    const items = fs.readdirSync(dirPath);
    for (const item of items) {
      // 跳过隐藏文件/目录（. 开头）
      if (item.startsWith(".")) continue;
      const fullPath = path.join(dirPath, item);
      try {
        const s = fs.statSync(fullPath);
        if (s.isDirectory()) {
          result.push(...walkDir(fullPath));
        } else if (s.isFile()) {
          result.push(fullPath);
        }
      } catch {
        // 无权限/已删除 → 跳过
      }
    }
  } catch {
    // 无权限浏览目录 → 跳过
  }
  return result;
}

// ── 批量摄入 ──

/**
 * 批量摄入多条路径（文件或目录）。
 * 目录 → walkDir 展开；重复路径去重（realpath）。
 */
export async function ingestPaths(
  paths: string[],
  documentImport: DocumentImport,
): Promise<Attachment[]> {
  // 展开目录，同时记录每个文件的"显示名"（相对输入目录的路径）
  const filesWithPaths: Array<{ absPath: string; displayName: string }> = [];
  for (const p of paths) {
    try {
      const s = fs.statSync(p);
      if (s.isDirectory()) {
        const children = walkDir(p);
        for (const child of children) {
          filesWithPaths.push({ absPath: child, displayName: path.relative(p, child) });
        }
      } else if (s.isFile()) {
        filesWithPaths.push({ absPath: p, displayName: path.basename(p) });
      }
    } catch {
      // 不存在 → 跳过
    }
  }

  // 去重（用 realpath）
  const seen = new Set<string>();
  const unique: Array<{ absPath: string; displayName: string }> = [];
  for (const entry of filesWithPaths) {
    try {
      const real = fs.realpathSync(entry.absPath);
      if (!seen.has(real)) {
        seen.add(real);
        unique.push({ ...entry, absPath: real });
      }
    } catch {
      // symlink broken → 跳过
    }
  }

  const results: Attachment[] = [];
  for (const { absPath, displayName } of unique) {
    const att = await ingestOneFile(absPath, documentImport);
    // 用保留相对路径的显示名覆盖 basename
    results.push({ ...att, name: displayName, filePath: absPath });
  }
  return results;
}

export async function processDocumentsForChat(
  filePaths: string[],
  query: string,
  documentImport: DocumentImport,
  searchImportedChunks: SearchImportedChunksFn,
): Promise<Attachment[]> {
  const results: Attachment[] = [];
  for (const filePath of filePaths) {
    try {
      const processed = await ingestPaths([filePath], documentImport);
      if (processed.length === 0) {
        results.push({
          name: path.basename(filePath),
          kind: "unsupported",
          filePath,
          status: "error",
          reason: "文件不存在或无法读取",
        });
        continue;
      }

      for (const attachment of processed) {
        if (attachment.kind === "indexed" && attachment.importId && query.trim()) {
          try {
            attachment.retrievedChunks = await searchImportedChunks(query, [attachment.importId]);
          } catch (err: any) {
            attachment.reason = err?.message || String(err);
          }
        }
        results.push(attachment);
      }
    } catch (err: any) {
      results.push({
        name: path.basename(filePath),
        kind: "unsupported",
        filePath,
        status: "error",
        reason: err?.message || String(err),
      });
    }
  }
  return results;
}
