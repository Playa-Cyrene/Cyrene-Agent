// ── 工具：download_file ─────────────────────────────────────
// 从 URL 下载二进制文件（图片/压缩包/音频等）保存到本地磁盘。
//
// 与 fetch_url 的分工：fetch_url 把网页正文转 markdown 喂给模型读；
// download_file 把图片等二进制原样落盘给用户用，模型只拿到保存路径。
//
// 安全设计（对齐 document-tools 的落盘规则）：
// - filename 禁止绝对路径/.. 穿越；以工作区（未绑定时桌面）解析，由统一权限守卫检查真实目标
// - 危险后缀黑名单：拒绝下载 .exe/.bat 等可执行文件
// - 大小上限 64MiB + 30s 空闲超时（无总超时，大文件慢速下载不误杀）
// - 先完整缓冲校验再一次性落盘：下载中断不会留下半截文件
//
// 桌面回退路径在 execute 内按需读取，但 file-access 会在顶层引入权限宿主及 Electron。
// 普通 Node 测试须隔离权限或 Electron 宿主，不能只靠传入工作区避免该依赖。

import * as fs from "fs";
import * as path from "path";
import type { ToolDefinition } from "../registry/tool-registry";
import type { ToolContext } from "../registry/tool-context";
import { resolveFileAccessPath } from "../file-access";

const LOG_PREFIX = "[BuiltinTools]";

const DOWNLOAD_IDLE_TIMEOUT_MS = 30_000; // 空闲超时：连续 30s 无数据则中止
const DOWNLOAD_MAX_BYTES = 64 * 1024 * 1024; // 单文件上限 64MiB

/** 危险后缀黑名单：可执行/脚本文件不落盘，防"下载即执行"攻击面。 */
const DANGEROUS_EXTS = new Set([
  ".exe", ".bat", ".cmd", ".com", ".scr", ".msi",
  ".ps1", ".vbs", ".lnk", ".jar", ".sh",
]);

/** Content-Type → 扩展名：filename 缺扩展名时按响应类型补全。 */
const CONTENT_TYPE_EXT: Record<string, string> = {
  "image/png": ".png",
  "image/jpeg": ".jpg",
  "image/gif": ".gif",
  "image/webp": ".webp",
  "image/svg+xml": ".svg",
  "image/bmp": ".bmp",
  "image/x-icon": ".ico",
  "image/avif": ".avif",
  "application/pdf": ".pdf",
  "application/zip": ".zip",
  "application/x-7z-compressed": ".7z",
  "application/gzip": ".gz",
  "audio/mpeg": ".mp3",
  "audio/wav": ".wav",
  "audio/ogg": ".ogg",
  "video/mp4": ".mp4",
  "video/webm": ".webm",
  "text/plain": ".txt",
  "application/json": ".json",
};

/** 危险字符校验（与 document-tools validateFilename 同规则）。 */
function hasDangerousChars(filename: string): boolean {
  return /[<>:"|?*]/.test(filename);
}

/**
 * 解析输出路径：filename 可含子目录（如 "images/cat.png"）。
 * 有可信工作区绑定时根目录固定为工作区；否则懒加载 electron 回退桌面。
 * 安全校验：禁止 .. 穿越、禁止绝对路径。
 * 返回绝对路径，或 null 表示校验失败。
 */
function resolveOutputPath(filename: string, workspaceRoot?: string): string | null {
  const normalized = path.normalize(filename).replace(/\\/g, "/");
  if (normalized.includes("..") || path.isAbsolute(normalized)) return null;
  let root: string;
  if (workspaceRoot) {
    root = path.resolve(workspaceRoot);
  } else {
    // 绑定工作区时不调用此分支；仅未绑定时读取桌面回退路径。
    const { app } = require("electron") as typeof import("electron");
    root = app.getPath("desktop");
  }
  const fullPath = path.resolve(root, normalized);
  const relative = path.relative(root, fullPath);
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) return null;
  return fullPath;
}

/** 从 URL 推断文件名：取 pathname 最后一段（去查询串、URL 解码）。推断不出返回 null。 */
function filenameFromUrl(url: string): string | null {
  try {
    const pathname = new URL(url).pathname;
    const last = decodeURIComponent(pathname.split("/").filter(Boolean).pop() || "");
    // 必须像文件名：非空、含点、不是纯扩展名（如 ".png"）
    if (!last || !last.includes(".") || last.startsWith(".")) return null;
    return last;
  } catch {
    return null;
  }
}

async function executeDownloadFile(args: Record<string, unknown>, ctx?: ToolContext): Promise<string> {
  const url = String(args.url || "").trim();
  if (!/^https?:\/\//i.test(url)) {
    return "[错误] url 必须以 http:// 或 https:// 开头";
  }

  // ── 文件名：显式传入优先，否则从 URL 推断 ──
  let filename = String(args.filename || "").trim();
  if (!filename) {
    filename = filenameFromUrl(url) || "";
  }
  if (!filename) {
    // 推断不出先不报错：等拿到 Content-Type 再补扩展名；两者都没有才拒绝
    filename = "download";
  }
  if (hasDangerousChars(filename)) {
    return "[错误] filename 含非法字符（<>:\"|?*）";
  }

  // 路径沙箱校验（在联网之前，拒绝路径不走网络）
  const outputPath = resolveOutputPath(filename, ctx?.resolvedWorkspaceRoot);
  if (!outputPath) {
    return "[错误] 路径不合法（禁止目录穿越或绝对路径）: " + filename;
  }
  if (DANGEROUS_EXTS.has(path.extname(outputPath).toLowerCase())) {
    return "[错误] 禁止下载可执行/脚本文件: " + path.extname(outputPath);
  }
  const access = resolveFileAccessPath(outputPath, "write", ctx);
  if (!access.ok) return "[拒绝] " + access.message;

  console.log(LOG_PREFIX, "download_file:", url, "->", outputPath);

  const ac = new AbortController();
  const idleTimer = setTimeout(() => ac.abort(), DOWNLOAD_IDLE_TIMEOUT_MS);
  const combinedSignal = ctx?.signal ? AbortSignal.any([ctx.signal, ac.signal]) : ac.signal;
  try {
    const resp = await fetch(url, {
      signal: combinedSignal,
      headers: {
        "User-Agent": "Mozilla/5.0 (Cyrene Agent) Chrome/120 Safari/537.36",
        Accept: "*/*",
      },
      redirect: "follow",
    });
    if (!resp.ok) {
      return "[错误] HTTP " + resp.status + " " + resp.statusText;
    }
    if (!resp.body) {
      return "[错误] 响应无内容（空 body）";
    }

    // Content-Length 预检：服务端给了大小就直接判断，省得下到一半才发现超限
    const declaredLength = Number(resp.headers.get("content-length") || 0);
    if (declaredLength && declaredLength > DOWNLOAD_MAX_BYTES) {
      return `[错误] 文件过大：${declaredLength} 字节超过上限 ${DOWNLOAD_MAX_BYTES} 字节`;
    }

    // 缺扩展名时按 Content-Type 补全（"download" 占位名或 URL 无扩展名场景）
    let finalPath = outputPath;
    if (path.extname(outputPath) === "") {
      const ctype = (resp.headers.get("content-type") || "").split(";")[0].trim().toLowerCase();
      const ext = CONTENT_TYPE_EXT[ctype];
      if (!ext) {
        return "[错误] 无法确定文件扩展名（Content-Type: " + (ctype || "未知") + "），请显式传入 filename 参数（如 cat.png）";
      }
      finalPath = outputPath + ext;
    }

    // 流式读取 + 完整缓冲：超限/中断时磁盘上不会留半截文件
    const reader = resp.body.getReader();
    const chunks: Buffer[] = [];
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      idleTimer.refresh(); // 有数据流动，重置空闲计时
      total += value.byteLength;
      if (total > DOWNLOAD_MAX_BYTES) {
        return `[错误] 文件过大：超过上限 ${DOWNLOAD_MAX_BYTES} 字节，已中止`;
      }
      chunks.push(Buffer.from(value));
    }

    // 下载期间目录可能被替换；补扩展名后必须按最终实际目标再次检查。
    const finalAccess = resolveFileAccessPath(finalPath, "write", ctx);
    if (!finalAccess.ok) return "[拒绝] " + finalAccess.message;
    const writePath = finalAccess.path;
    const dir = path.dirname(writePath);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(writePath, Buffer.concat(chunks, total));
    const sizeText = total >= 1024 * 1024
      ? (total / 1024 / 1024).toFixed(1) + " MiB"
      : Math.round(total / 1024) + " KiB";
    console.log(LOG_PREFIX, "已下载:", writePath, `(${total} bytes)`);
    return `[download_file] 已保存：${finalPath}（${sizeText}）`;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return "[错误] 下载失败: " + msg;
  } finally {
    clearTimeout(idleTimer);
  }
}

export const downloadFileTool: ToolDefinition = {
  id: "download_file",
  name: "下载文件",
  description:
    "从 URL 下载文件（图片/压缩包/音频/PDF 等二进制）保存到本地磁盘，返回保存路径。" +
    "下载的文件归用户使用，你只拿到路径。\n\n" +
    "何时用：\n" +
    "- 用户说'把这个图片存下来''下载这个链接的文件'\n" +
    "- 对话或网页里出现图片 URL，用户想要本地副本\n" +
    "- 需要获取文件本体（而不是读内容）时\n\n" +
    "不要用于：\n" +
    "- 想读网页/文档的文字内容 → 用 fetch_url（省 token）\n" +
    "- 生成 Excel/Word/PDF/Markdown 文档 → 用 write_* 系列\n" +
    "- 下载可执行文件（.exe/.bat 等，会被拒绝）\n\n" +
    "参数：url (必填，完整 http(s) 地址)，filename (可选，保存的相对路径+文件名如 images/cat.png；" +
    "缺省从 URL 推断，推断不出时按 Content-Type 补扩展名)。\n" +
    "保存位置：绑定项目时存到项目目录，否则存到桌面。上限 64MiB。",
  enabled: true,
  risk: "fs-write",
  modes: ["learn", "code", "work"],
  needsContext: true,
  effectKind: "mutation" as const,
  verificationPolicy: "artifact" as const,
  inputSchema: {
    type: "object",
    properties: {
      url: { type: "string", description: "要下载的完整 URL（必须包含 https:// 或 http://）" },
      filename: { type: "string", description: "保存的相对路径+文件名（如 images/cat.png），可选" },
    },
    required: ["url"],
  },
  execute: executeDownloadFile,
};
