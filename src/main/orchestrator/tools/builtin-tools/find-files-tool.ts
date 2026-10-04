// ── 工具：find_files（面向普通用户的文件搜索）──────────────────────
//
// 定位（与上游 Glob/Grep/list_dir 的差异，写进 PR）：
//   Glob/Grep 锁在「当前工作区内、只收相对 glob 模式」，结果不含大小/修改时间；
//   list_dir 只列单层目录。find_files 补的是：
//     - 地址别名（桌面/下载/文档/图片/音乐/home → os.homedir() 下对应目录），可搜工作区外
//     - 一次调用「模糊文件名 + 可选内容」混合搜索
//     - 每个命中带元数据（大小 / 修改时间 / 扩展名）
//     - 结构化 JSON 供渲染层出「可点击文件卡片」
//
// 内容读取分级（全部进程内、只读，绝不改文件）：
//   L1 纯文本/代码：readFileSync 读前 N KB 直接匹配。
//   L2 Word/Excel：docx(extract-zip) / xlsx(exceljs) 抽正文后匹配——不需视觉模型。
//   L3a 图片：只按文件名匹配，命中项标 unreadable，如需识别内容用 read_image（视觉）。
//   L3b PDF/旧二进制(.doc/.xls)/音视频/压缩包：本轮无解析库，只按文件名匹配，标 unreadable。
//   ※ 搜索阶段会真正读进候选文件内容做匹配；但呈现给用户只给文件名+元数据，
//     命中至多附 ≤200 字 snippet 作证据，绝不把整篇正文贴出来（要读全文请对单个文件用 read_file）。
//
// 注意：本模块顶层不 import electron（用 os.homedir() 解析别名），测试可直接调用。

import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import type { ToolDefinition } from "../registry/tool-registry";
import type { ToolContext } from "../registry/tool-context";
import { extractDocText, isOfficeTextExt } from "./office-text-extract";

const LOG_PREFIX = "[BuiltinTools]";

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;
const BFS_TIMEOUT_MS = 5_000;
const MAX_VISITED = 20_000;
const TEXT_SAMPLE_BYTES = 64 * 1024;   // 内容匹配只读文件前 64KB
const CONTENT_MAX_BYTES = 5 * 1024 * 1024; // 超过 5MB 不做内容读取
const SNIPPET_LEN = 200;

const OMIT_DIRS = new Set([
  "node_modules", ".git", ".hg", ".svn", "dist", "build", "out", "output",
  "coverage", ".next", ".nuxt", ".cache", "target", ".venv", "venv", "__pycache__",
  ".gradle", ".maven", "vendor", "$RECYCLE.BIN", "system volume information",
]);

// L1：可直接读文本/代码（readFileSync 前 N KB）
const L1_TEXT_EXTS = new Set([
  ".txt", ".md", ".markdown", ".rst", ".adoc", ".tex", ".bib", ".csv", ".tsv", ".log",
  ".json", ".jsonl", ".yaml", ".yml", ".toml", ".ini", ".cfg", ".conf", ".env", ".properties",
  ".xml", ".proto", ".graphql", ".gql", ".html", ".htm", ".css", ".scss", ".less",
  ".js", ".jsx", ".mjs", ".cjs", ".ts", ".tsx", ".vue", ".svelte",
  ".py", ".rb", ".go", ".rs", ".java", ".kt", ".kts", ".scala", ".c", ".h", ".cpp", ".hpp",
  ".cc", ".cs", ".swift", ".php", ".pl", ".lua", ".r", ".dart", ".groovy",
  ".sh", ".bash", ".zsh", ".ps1", ".psm1", ".bat", ".cmd", ".fish",
  ".svg", ".gitignore", ".editorconfig", ".eslintrc", ".prettierrc",
]);
// L3a：图片，内容需视觉模型（read_image）
const IMAGE_EXTS = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".tiff", ".tif", ".heic", ".ico"]);
// L3b：本轮无解析库、不可读内容（旧二进制 / PDF / 音视频 / 压缩包 / 可执行等）
const L3B_EXTS = new Set([
  ".pdf", ".doc", ".xls", ".ppt", ".pptx",
  ".mp3", ".wav", ".m4a", ".flac", ".ogg", ".mp4", ".avi", ".mkv", ".mov", ".wmv",
  ".zip", ".rar", ".7z", ".tar", ".gz", ".bz2", ".xz",
  ".exe", ".dll", ".so", ".dylib", ".bin", ".iso", ".ttf", ".otf", ".woff", ".woff2",
  ".db", ".sqlite", ".pdb",
]);

interface FileCardEntry {
  path: string;
  name: string;
  sizeBytes: number;
  modifiedAt: number;
  ext: string;
  matchedBy: "name" | "content";
  snippet?: string;
  unreadable?: boolean;
}

/** 把别名/绝对/相对路径解析成搜索根目录。返回 null 表示无法解析或不存在/不是目录。 */
export function resolveSearchRoot(raw: string, ctx?: ToolContext): string | null {
  const home = os.homedir();
  const aliases: Record<string, string> = {
    home: home, homedir: home, "~": home,
    desktop: path.join(home, "Desktop"), "桌面": path.join(home, "Desktop"),
    downloads: path.join(home, "Downloads"), download: path.join(home, "Downloads"),
    "下载": path.join(home, "Downloads"),
    documents: path.join(home, "Documents"), document: path.join(home, "Documents"),
    "文档": path.join(home, "Documents"), "文稿": path.join(home, "Documents"),
    pictures: path.join(home, "Pictures"), picture: path.join(home, "Pictures"),
    "图片": path.join(home, "Pictures"), "照片": path.join(home, "Pictures"),
    music: path.join(home, "Music"), "音乐": path.join(home, "Music"),
  };
  const key = (raw || "").trim();
  let root: string;
  if (!key) {
    root = ctx?.resolvedWorkspaceRoot || home;
  } else if (aliases[key.toLowerCase()] || aliases[key]) {
    root = aliases[key.toLowerCase()] || aliases[key];
  } else if (path.isAbsolute(key)) {
    root = path.normalize(key);
  } else {
    // 相对：优先工作区，回落 home
    root = path.resolve(ctx?.resolvedWorkspaceRoot || home, key);
  }
  try {
    if (!fs.statSync(root).isDirectory()) return null;
    return root;
  } catch {
    return null;
  }
}

/** 读文件前 N KB 作为 utf8 文本样本（L1）。失败返回 null。 */
function readTextSample(filePath: string, sizeBytes: number): string | null {
  if (sizeBytes > CONTENT_MAX_BYTES) return null;
  let fd: number | null = null;
  try {
    fd = fs.openSync(filePath, "r");
    const len = Math.min(sizeBytes, TEXT_SAMPLE_BYTES);
    const buf = Buffer.alloc(len);
    const read = fs.readSync(fd, buf, 0, len, 0);
    return buf.subarray(0, read).toString("utf8");
  } catch {
    return null;
  } finally {
    if (fd !== null) { try { fs.closeSync(fd); } catch { /* ignore */ } }
  }
}

/** 围绕首个匹配位置取 ≤SNIPPET_LEN 的单行证据。 */
function makeSnippet(text: string, queryLower: string): string {
  const idx = text.toLowerCase().indexOf(queryLower);
  const start = idx < 0 ? 0 : Math.max(0, idx - 40);
  let slice = text.slice(start, start + SNIPPET_LEN * 2);
  slice = slice.replace(/\s+/g, " ").trim();
  if (slice.length > SNIPPET_LEN) slice = slice.slice(0, SNIPPET_LEN) + "…";
  return slice;
}

async function executeFindFiles(args: Record<string, unknown>, ctx?: ToolContext): Promise<string> {
  const query = String(args.query ?? "").trim();
  if (!query) return JSON.stringify({ success: false, errorCode: "INVALID_ARGUMENT", error: "query 不能为空" });
  const queryLower = query.toLowerCase();

  const root = resolveSearchRoot(String(args.path ?? ""), ctx);
  if (!root) {
    return JSON.stringify({
      success: false, errorCode: "ROOT_NOT_FOUND",
      error: "搜索目录无法解析或不存在（可用别名：桌面/下载/文档/图片/音乐/home，或给绝对路径）",
      path: String(args.path ?? ""),
    });
  }

  // extensions 过滤（如 ["pdf","docx"] 或 ".pdf,.docx"）
  const extSet = new Set<string>();
  const rawExt = args.extensions;
  const extList = Array.isArray(rawExt) ? rawExt : (typeof rawExt === "string" ? rawExt.split(/[,\s]+/) : []);
  for (const e of extList) {
    const s = String(e).trim().toLowerCase().replace(/^\./, "");
    if (s) extSet.add("." + s);
  }

  const searchContent = args.searchContent === true;
  const limit = Math.min(MAX_LIMIT, Math.max(1, Number(args.limit) || DEFAULT_LIMIT));
  const startedAt = Date.now();

  const files: FileCardEntry[] = [];
  let truncated = false;
  let visited = 0;

  const queue: string[] = [root];
  while (queue.length > 0 && files.length < limit) {
    if (Date.now() - startedAt > BFS_TIMEOUT_MS) { truncated = true; break; }
    const dir = queue.shift() as string;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const ent of entries) {
      if (visited++ > MAX_VISITED) { truncated = true; break; }
      if (Date.now() - startedAt > BFS_TIMEOUT_MS) { truncated = true; break; }
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) {
        if (OMIT_DIRS.has(ent.name.toLowerCase()) || ent.name.startsWith(".")) continue;
        queue.push(full);
        continue;
      }
      if (!ent.isFile()) continue;

      const ext = path.extname(ent.name).toLowerCase();
      if (extSet.size > 0 && !extSet.has(ext)) continue;

      let sizeBytes = 0;
      let mtimeMs = 0;
      try {
        const st = fs.statSync(full);
        sizeBytes = st.size; mtimeMs = Math.round(st.mtimeMs);
      } catch { continue; }

      const nameMatched = ent.name.toLowerCase().includes(queryLower);
      let matchedBy: "name" | "content" = "name";
      let snippet: string | undefined;

      if (!nameMatched) {
        // 文件名没中：仅在开启内容搜索、且该类型可读内容时才进内容匹配
        if (!searchContent) continue;
        if (isOfficeTextExt(ext)) {
          const text = await extractDocText(full, ext);
          if (!text || !text.toLowerCase().includes(queryLower)) continue;
          matchedBy = "content"; snippet = makeSnippet(text, queryLower);
        } else if (L1_TEXT_EXTS.has(ext)) {
          const text = readTextSample(full, sizeBytes);
          if (!text || !text.toLowerCase().includes(queryLower)) continue;
          matchedBy = "content"; snippet = makeSnippet(text, queryLower);
        } else {
          // 图片 / PDF / 旧二进制 / 音视频 / 压缩包：本轮读不了内容，不匹配内容
          continue;
        }
      }

      const entry: FileCardEntry = {
        path: full,
        name: ent.name,
        sizeBytes,
        modifiedAt: mtimeMs,
        ext,
        matchedBy,
      };
      if (snippet) entry.snippet = snippet;
      if (IMAGE_EXTS.has(ext)) entry.unreadable = true;   // 需 read_image（视觉）
      else if (L3B_EXTS.has(ext)) entry.unreadable = true; // 本轮无解析库
      files.push(entry);
      if (files.length >= limit) break;
    }
    if (files.length >= limit) break;
  }

  // 命中排序：内容命中优先？保持遍历顺序即可，仅按修改时间倒序更利于人看
  files.sort((a, b) => b.modifiedAt - a.modifiedAt);

  return JSON.stringify({
    success: true,
    query,
    root,
    total: files.length,
    truncated,
    contentSearch: searchContent,
    // 呈现纪律：只给文件名+元数据，模型不要把 snippet 之外的正文整篇贴出来
    files,
  });
}

export const findFilesTool: ToolDefinition = {
  id: "find_files",
  name: "搜索文件",
  description:
    "按模糊文件名（可选叠加文件内容）在本地磁盘搜索文件，返回带大小、修改时间的结果，供界面渲染成可点击的文件卡片。\n\n" +
    "与 Glob/Grep 的差别：Glob/Grep 只能在工作区内按相对模式找；find_files 能用「桌面/下载/文档/图片/音乐/home」等别名搜工作区外的任意目录，且一次同时按名字+内容混搜、附元数据。\n\n" +
    "内容读取分级（搜索时会真正读进文件内容做匹配，但回给你时只列文件名+元数据、命中最多一句证据，不要把正文整篇贴给用户）：\n" +
    "- 可直接读（不需模型）：文本/代码/配置（L1）；Word(.docx)、Excel(.xlsx/.xlsm)（L2，进程内解析正文）。\n" +
    "- 需视觉模型：图片(.png/.jpg/.gif/.webp/.bmp 等)——按名字命中后标 unreadable，要看内容请用 read_image。\n" +
    "- 本轮读不了内容（无解析库）：PDF、旧版 .doc/.xls、音视频、压缩包、可执行——按名字命中后标 unreadable，可用 open_file 交给系统程序打开、或 send_file 发回。\n" +
    "- 用户明确要读某个文件的全文时：对单个文件调 read_file/Read（文本/Office 支持），不要在这里贴全文。\n\n" +
    "何时用：用户说「帮我找…」「下载/桌面/文档里有没有…」「内容里有 XX 的文件」。不要用于已知完整路径（直接 read_file）。\n" +
    "参数：query (必填，模糊名或要搜的词)，path (可选，别名或绝对路径；缺省=工作区或 home)，extensions (可选，如 [\"pdf\",\"docx\"] 或 \"pdf,docx\")，searchContent (可选，true 才进文件内容匹配)，limit (可选，默认 50，最大 200)。\n" +
    "已知边界：Windows OneDrive 重定向的桌面/文档可能不在 os.homedir() 下，届时让用户给绝对路径。",
  enabled: true,
  risk: "fs-read",
  modes: ["chat", "learn", "code", "work"],
  chatBuiltin: true,
  effectKind: "read" as const,
  isConcurrencySafe: () => true,
  verificationPolicy: "none" as const,
  needsContext: true,
  inputSchema: {
    type: "object",
    properties: {
      query: { type: "string", description: "要匹配的模糊文件名或关键词" },
      path: { type: "string", description: "搜索目录：别名（桌面/下载/文档/图片/音乐/home）或绝对路径；缺省=工作区或 home" },
      extensions: {
        type: "array",
        description: "限定扩展名，如 [\"pdf\",\"docx\"]",
        items: { type: "string" },
      },
      searchContent: { type: "boolean", description: "是否进入文件内容匹配（仅对可读类型生效），默认 false" },
      limit: { type: "number", description: "最多返回条数，默认 50，最大 200" },
    },
    required: ["query"],
  },
  execute: executeFindFiles,
};
