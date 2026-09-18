// ── 工具 1：fetch_url ─────────────────────────────────────
// 拉一个 URL 的纯文本 / Markdown 形式的 body，给 agent 读 README 用
//
// 两条抓取路径：
// - GitHub 仓库主页（github.com/所有者/仓库）：走官方 API 直接取仓库元信息 + README 原文，
//   绕过几百 KB 的页面 HTML（导航/文件列表等噪音）
// - 普通网页：抓 HTML → 正文提取（剥导航/页头/页脚/侧栏，优先 article/main 正文区）→ 转 markdown
//
// 注册方式：本模块导出 fetchUrlTool 常量，由 built-in-tools.ts facade 在原注册位置统一
// toolRegistry.register，显式保证 registry 插入顺序（= 工具目录 prompt 生成顺序，门禁见
// built-in-tools.snapshot.test.ts）。

import TurndownService from "turndown";
import type { ToolDefinition } from "../registry/tool-registry";
import type { ToolContext } from "../registry/tool-context";
import { TtlResultCache } from "./ttl-result-cache";

const LOG_PREFIX = "[BuiltinTools]";

const FETCH_TIMEOUT_MS = 20_000;
const FETCH_MAX_BYTES = 512 * 1024; // 单次最多 512KB，防止 LLM 上下文爆炸

// ── 抓取结果缓存 ─────────────────────────────────────────
// 模型常在同一会话里对同一链接反复 fetch（web_search 结果里挑链接来回看），
// 30 分钟内同 URL 同格式直接复用。固定 TTL 不续期，到期重抓。
const FETCH_CACHE_TTL_MS = 30 * 60_000;
const fetchCache = new TtlResultCache<string>(FETCH_CACHE_TTL_MS);

/** 清空抓取缓存（测试隔离用） */
export function clearFetchUrlCache(): void {
  fetchCache.clear();
}

// 正文区域的最小文字量：article/main 剥掉标签后至少要有这么多字，才认定找对了容器；
// 否则视为空壳（比如只剩个挂件），回退用整页
const MAIN_REGION_MIN_TEXT_CHARS = 200;

// HTML → Markdown 清洗：用 turndown 转成 LLM 最易理解的 markdown 格式
// 保留标题层级/列表/代码块/表格/链接，比纯 strip 标签信息量大得多

const turndown = new TurndownService({
  headingStyle: "atx",        // <h1>→# <h2>→##
  codeBlockStyle: "fenced",   // <pre><code>→```围栏代码块（LLM 更认）
  bulletListMarker: "-",
  emDelimiter: "*",           // <em>→*斜体*
});

function stripHtml(html: string): string {
  // 先去 script/style/注释（turndown 不会自动去这些，留着会污染 markdown）
  let s = html.replace(/<script[\s\S]*?<\/script>/gi, " ");
  s = s.replace(/<style[\s\S]*?<\/style>/gi, " ");
  s = s.replace(/<!--[\s\S]*?-->/g, " ");
  // 整体移除页面骨架区块（导航/页头/页脚/侧栏），这些对正文没有贡献
  s = s.replace(/<(nav|header|footer|aside)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, " ");

  // 正文容器优先：GitHub README、博客文章在 <article> 里，文档站常用 <main>
  const region = extractMainRegion(s);
  const source = region ?? s;

  // 转 markdown（保留结构），失败则退回纯 strip 标签
  try {
    const md = turndown.turndown(source);
    // 压缩多余空行（turndown 有时会留连续空行）
    return md.replace(/\n{3,}/g, "\n\n").trim();
  } catch {
    // turndown 解析失败（畸形 HTML），退回纯标签剥离
    let t = source.replace(/<[^>]+>/g, " ");
    t = t.replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'");
    return t.replace(/[ \t]+/g, " ").replace(/\s*\n\s*/g, "\n").trim();
  }
}

/**
 * 从清洗后的 HTML 中找正文容器：先试 article，再试 main。
 * 开始标签取第一个、结束标签取最后一个（兼容容器嵌套的写法）；
 * 找不到、顺序不对、或剥掉标签后文字太少，都返回 null，由调用方回退整页。
 */
function extractMainRegion(cleaned: string): string | null {
  for (const tag of ["article", "main"]) {
    const open = cleaned.match(new RegExp(`<${tag}\\b[^>]*>`, "i"));
    if (!open || open.index === undefined) continue;
    const close = lastIndexOfTagClose(cleaned, tag);
    if (close < 0 || close <= open.index) continue;
    const region = cleaned.slice(open.index, close);
    const textLen = region.replace(/<[^>]+>/g, "").replace(/\s+/g, "").length;
    if (textLen >= MAIN_REGION_MIN_TEXT_CHARS) return region;
  }
  return null;
}

/** 找最后一个 </tag> 的结束下标（含闭合标签本身），兼容大小写写法 */
function lastIndexOfTagClose(html: string, tag: string): number {
  const re = new RegExp(`</${tag}\\s*>`, "gi");
  let last = -1;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) last = m.index + m[0].length;
  return last;
}

// ── GitHub 仓库主页特化 ───────────────────────────────────
// 仓库主页 HTML 有几百 KB 且 README 排在页面末尾，正文提取也难救；
// 官方 API 直接给结构化数据：元信息 + README 原文，干净又省上下文。
// 公共仓库读取不需要认证；失败（私有仓库/不存在/限流/超时）一律回退普通抓取。

// github.com 下这些一级路径不是用户名，对应的二级页面不是仓库主页
const GITHUB_RESERVED_PREFIXES = new Set([
  "topics", "orgs", "users", "settings", "sponsors", "collections", "features",
  "marketplace", "apps", "gists", "site", "security", "about", "pricing",
  "enterprise", "explore", "trending", "search", "notifications", "dashboard",
  "new", "pulls", "issues", "watching", "organizations", "codespaces",
]);

/** 识别 github.com/{owner}/{repo} 形式的仓库主页地址，其它地址返回 null */
function matchGithubRepoUrl(rawUrl: string): { owner: string; repo: string } | null {
  let u: URL;
  try {
    u = new URL(rawUrl);
  } catch {
    return null;
  }
  if (!/^(www\.)?github\.com$/i.test(u.hostname)) return null;
  const m = u.pathname.match(/^\/([^/]+)\/([^/]+?)(?:\.git)?\/?$/);
  if (!m) return null;
  const [, owner, repo] = m;
  if (!owner || !repo) return null;
  if (GITHUB_RESERVED_PREFIXES.has(owner.toLowerCase())) return null;
  return { owner, repo };
}

/** 拉取 GitHub 仓库元信息 + README 原文；任何失败返回 null，由调用方回退普通抓取 */
async function fetchGithubRepoSummary(
  repo: { owner: string; repo: string },
  url: string,
  ctx?: ToolContext,
): Promise<string | null> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), FETCH_TIMEOUT_MS);
  const combinedSignal = ctx?.signal ? AbortSignal.any([ctx.signal, ac.signal]) : ac.signal;
  const apiBase = `https://api.github.com/repos/${repo.owner}/${repo.repo}`;
  const headers = {
    "User-Agent": "Mozilla/5.0 (Cyrene Agent) Chrome/120 Safari/537.36",
    Accept: "application/vnd.github+json",
  };
  try {
    // 元信息和 README 并行拉；元信息失败不拖累 README
    const [metaResp, readmeResp] = await Promise.all([
      fetch(apiBase, { signal: combinedSignal, headers, redirect: "follow" }),
      fetch(apiBase + "/readme", {
        signal: combinedSignal,
        headers: { ...headers, Accept: "application/vnd.github.raw" },
        redirect: "follow",
      }),
    ]);
    if (!readmeResp.ok) return null;

    // README 同样按字节上限截断，与普通抓取保持一致
    const buf = await readmeResp.arrayBuffer();
    const truncated = buf.byteLength > FETCH_MAX_BYTES;
    const readme = new TextDecoder("utf-8").decode(
      truncated ? buf.slice(0, FETCH_MAX_BYTES) : buf,
    );

    let header = "";
    if (metaResp.ok) {
      try {
        header = formatGithubMeta((await metaResp.json()) as Record<string, unknown>, repo) + "\n\n---\n\n";
      } catch {
        // 元信息 JSON 解析失败不影响 README 输出
      }
    }

    const meta = "URL: " + url + "\n来源: GitHub API（仓库元信息 + README 原文）"
      + (truncated ? "\n[README 已截断到 " + FETCH_MAX_BYTES + " 字节]" : "") + "\n\n";
    return meta + header + readme.trim();
  } catch {
    // 网络失败或超时，回退普通抓取
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** 把仓库元信息整理成 markdown 头部，字段缺失就跳过不硬凑 */
function formatGithubMeta(
  meta: Record<string, unknown>,
  repo: { owner: string; repo: string },
): string {
  const lines: string[] = ["# " + repo.owner + "/" + repo.repo];
  const desc = typeof meta.description === "string" ? meta.description.trim() : "";
  if (desc) lines.push("", "> " + desc);
  const stats: string[] = [];
  if (typeof meta.stargazers_count === "number") stats.push("stars: " + meta.stargazers_count);
  if (typeof meta.forks_count === "number") stats.push("forks: " + meta.forks_count);
  if (typeof meta.language === "string" && meta.language) stats.push("language: " + meta.language);
  if (typeof meta.default_branch === "string" && meta.default_branch) stats.push("默认分支: " + meta.default_branch);
  const license = meta.license as { spdx_id?: string } | null | undefined;
  if (license?.spdx_id && license.spdx_id !== "NOASSERTION") stats.push("license: " + license.spdx_id);
  if (stats.length > 0) lines.push("", stats.join(" · "));
  return lines.join("\n");
}

async function executeFetchUrl(args: Record<string, unknown>, ctx?: ToolContext): Promise<string> {
  const url = String(args.url || "").trim();
  if (!/^https?:\/\//i.test(url)) {
    return "[错误] url 必须以 http:// 或 https:// 开头";
  }
  const asMarkdown = args.format === "markdown" || args.format === undefined;
  console.log(LOG_PREFIX, "fetch_url:", url, "format=" + (asMarkdown ? "markdown" : "raw"));

  // 缓存命中：直接复用并标注抓取时间，让模型自知内容的新鲜度
  const cacheKey = url + "|" + (asMarkdown ? "markdown" : "raw");
  const hit = fetchCache.get(cacheKey);
  if (hit) {
    const fetchedAt = new Date(hit.at).toLocaleString("zh-CN", { hour12: false });
    return "[缓存] 摄取于 " + fetchedAt + "，30 分钟内直接复用\n\n" + hit.value;
  }

  // GitHub 仓库主页特化：官方 API 直取 README + 元信息。
  // format=raw 表示用户明确要原始 HTML，不做特化
  if (asMarkdown) {
    const ghRepo = matchGithubRepoUrl(url);
    if (ghRepo) {
      console.log(LOG_PREFIX, "fetch_url: GitHub 仓库主页，走官方 API:", url);
      const summary = await fetchGithubRepoSummary(ghRepo, url, ctx);
      if (summary !== null) {
        fetchCache.set(cacheKey, summary);
        return summary;
      }
      console.log(LOG_PREFIX, "fetch_url: GitHub API 不可用，回退普通抓取:", url);
    }
  }

  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), FETCH_TIMEOUT_MS);
  // 组合父 signal 和超时 signal
  const combinedSignal = ctx?.signal ? AbortSignal.any([ctx.signal, ac.signal]) : ac.signal;
  try {
    const resp = await fetch(url, {
      signal: combinedSignal,
      headers: {
        "User-Agent": "Mozilla/5.0 (Cyrene Agent) Chrome/120 Safari/537.36",
        Accept: "text/html,text/markdown,text/plain,*/*;q=0.8",
      },
      redirect: "follow",
    });
    if (!resp.ok) {
      return "[错误] HTTP " + resp.status + " " + resp.statusText;
    }
    const ctype = resp.headers.get("content-type") || "";
    const buf = await resp.arrayBuffer();
    const truncated = buf.byteLength > FETCH_MAX_BYTES;
    const slice = truncated ? buf.slice(0, FETCH_MAX_BYTES) : buf;
    let text = new TextDecoder("utf-8").decode(slice);
    if (asMarkdown && /text\/html|application\/xhtml/i.test(ctype)) {
      text = stripHtml(text);
    }
    const meta = "URL: " + url + "\nContent-Type: " + ctype + (truncated ? "\n[已截断到 " + FETCH_MAX_BYTES + " 字节]" : "") + "\n\n";
    const result = meta + text;
    // 只有成功抓到内容才写缓存；上面的 [错误] 分支直接 return，不会进缓存
    fetchCache.set(cacheKey, result);
    return result;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return "[错误] fetch 失败: " + msg;
  } finally {
    clearTimeout(timer);
  }
}

export const fetchUrlTool: ToolDefinition = {
  id: "fetch_url",
  name: "读取网页",
  description:
    "下载指定 URL 的网页内容并返回正文。HTML 会先做正文提取（剥掉导航/页头/页脚/侧栏，" +
    "优先取 article/main 正文区），再转成结构化 markdown（保留标题/列表/代码块/表格），便于阅读。\n" +
    "GitHub 仓库主页（github.com/所有者/仓库）会走官方 API，直接返回仓库元信息 + README 原文。\n\n" +
    "何时用：\n" +
    "- 用户给了明确的网址（https://...），想看内容\n" +
    "- 用户说'看看这个链接''读一下这个网页'\n" +
    "- 需要读 GitHub README、MCP 安装文档、API 文档等具体页面\n" +
    "- web_search 之后拿到链接，想看具体内容\n\n" +
    "不要用于：\n" +
    "- 用户只给关键词没给网址 → 用 web_search\n" +
    "- 用户问'今天有什么新闻' → 用 web_search\n" +
    "- 本地文件路径 → 用 read_file\n\n" +
    "结果超过长度预算会被剪枝（保留开头结尾、省略中段），observation 里会附 tool-result:// 引用；" +
    "需要被剪掉的中段内容时，用 read_tool_result 读取，支持 offset/length 分段或 query 关键词定位。\n\n" +
    "参数：url (必填，完整 http(s) 地址)，format (可选 markdown|raw，默认 markdown)。",
  enabled: true,
  risk: "network",
  effectKind: "read" as const,
  verificationPolicy: "none" as const,
  inputSchema: {
    type: "object",
    properties: {
      url: { type: "string", description: "要拉取的完整 URL（必须包含 https:// 或 http://）" },
      format: { type: "string", description: "markdown=自动清洗 HTML 为纯文本（默认）；raw=原文不处理" },
    },
    required: ["url"],
  },
  execute: executeFetchUrl,
};
