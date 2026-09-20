// FileTreePanel — 右侧面板的会话工作区文件树 + 文件预览。
//
// 文件树：antd Tree.DirectoryTree，首次只拉根目录，展开目录节点时再拉该层；点击目录名即展开。
// 文件预览：点击文件由 ChatPage 打开 file:<relPath> 标签，内容走
// workspaceFiles.read（主进程 realpath 防越界、1MB 上限、二进制拒绝）。
// 高亮：shiki 单例 + github-light 主题，按扩展名选语言；渐进式渲染（先纯文本后上色），
// 高亮失败或语言不支持时保持纯文本，不阻塞阅读。

import { useCallback, useEffect, useRef, useState } from "react";
import { Tree } from "antd";
import type { DataNode, EventDataNode } from "antd/es/tree";
import { FileText } from "lucide-react";
import { createHighlighter, type BundledLanguage, type Highlighter, type ThemedToken } from "shiki";
import { useTranslation } from "../../../i18n";
import type { WorkspaceFileEntry, WorkspaceFileErrorCode } from "../../../../../shared/workspace-files-types";
import { MarkdownContent } from "./ChatMessageList";
import { releaseFocusedDescendant } from "./focus-handoff";
import { vscodeIconForFile } from "./vscodeFileIcon";
import "./FileTreePanel.css";

/** 预览最多渲染的行数：再多一次性铺 DOM 会卡 */
const PREVIEW_MAX_LINES = 2000;

/** shiki 主题：亮色 GitHub 主题，配色和应用的浅色界面匹配 */
const HIGHLIGHT_THEME = "github-light";

/** 按扩展名支持的语法（与 HIGHLIGHT_LANGS 列表保持一致） */
const EXT_LANG: Record<string, BundledLanguage> = {
  ts: "typescript", tsx: "tsx", mts: "typescript",
  js: "javascript", jsx: "jsx", mjs: "javascript", cjs: "javascript",
  json: "json", jsonc: "jsonc",
  css: "css", scss: "scss",
  html: "html", htm: "html",
  md: "markdown", markdown: "markdown",
  py: "python",
  sh: "bash", bash: "bash", zsh: "bash",
  yml: "yaml", yaml: "yaml",
  xml: "xml", svg: "xml",
  toml: "toml", sql: "sql", go: "go", rs: "rust", java: "java",
  c: "c", h: "c", cpp: "cpp", hpp: "cpp", cc: "cpp", cxx: "cpp",
};

/** 从相对路径取语言（不认识的扩展名返回 undefined → 纯文本） */
function langForPath(relPath: string): BundledLanguage | undefined {
  const name = relPath.slice(relPath.lastIndexOf("/") + 1);
  const dot = name.lastIndexOf(".");
  if (dot <= 0) return undefined;
  return EXT_LANG[name.slice(dot + 1).toLowerCase()];
}

/** 是否是 Markdown 文件（预览/源码可切换） */
function isMarkdownPath(relPath: string): boolean {
  return /\.(md|markdown)$/i.test(relPath);
}

/** 眼睛图标：渲染预览 */
function EyeIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 48 48" fill="none" aria-hidden="true">
      <path d="M24 36C35.0457 36 44 24 44 24C44 24 35.0457 12 24 12C12.9543 12 4 24 4 24C4 24 12.9543 36 24 36Z" stroke="currentColor" strokeWidth="4" strokeLinejoin="round" />
      <path d="M24 29C26.7614 29 29 26.7614 29 24C29 21.2386 26.7614 19 24 19C21.2386 19 19 21.2386 19 24C19 26.7614 21.2386 29 24 29Z" stroke="currentColor" strokeWidth="4" strokeLinejoin="round" />
    </svg>
  );
}

/** 代码图标：源码视图 */
function CodeIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 48 48" fill="none" aria-hidden="true">
      <path d="M18 16L10 24L18 32" stroke="currentColor" strokeWidth="4" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M30 16L38 24L30 32" stroke="currentColor" strokeWidth="4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

// shiki 高亮器全局单例：只创建一次，语言随初始化按需懒加载
let highlighterPromise: Promise<Highlighter> | null = null;
function getHighlighter(): Promise<Highlighter> {
  if (!highlighterPromise) {
    highlighterPromise = createHighlighter({
      themes: [HIGHLIGHT_THEME],
      langs: [...new Set(Object.values(EXT_LANG))],
    });
  }
  return highlighterPromise;
}

/** 错误码 → i18n key（树与预览共用） */
const ERROR_KEYS: Record<WorkspaceFileErrorCode, string> = {
  NO_WORKSPACE: "fileTree.errNoWorkspace",
  OUT_OF_ROOT: "fileTree.errOutOfRoot",
  NOT_FOUND: "fileTree.errNotFound",
  IS_DIRECTORY: "fileTree.errIsDirectory",
  TOO_LARGE: "fileTree.errTooLarge",
  BINARY: "fileTree.errBinary",
  LIST_FAILED: "fileTree.errListFailed",
  READ_FAILED: "fileTree.errReadFailed",
};

interface TreeItem extends DataNode {
  key: string;
  title: string;
  isDir: boolean;
  /** 目录子级是否已拉取（懒加载标记） */
  loaded?: boolean;
  /** 覆写 DataNode 的宽泛 children 类型，保证 attachChildren 递归参数匹配 */
  children?: TreeItem[];
}

/** 条目 → 树节点（文件按类型显示 VS Code 官方图标，目录用 📂/📁 emoji） */
function toTreeItem(entry: WorkspaceFileEntry): TreeItem {
  return {
    key: entry.relPath,
    title: entry.name,
    isDir: entry.isDir,
    isLeaf: !entry.isDir,
    icon: entry.isDir
      ? (props: { expanded?: boolean }) => (
          <span className="cy-file-tree__folder-icon" aria-hidden="true">
            {props.expanded ? "📁" : "📂"}
          </span>
        )
      : () => {
          const iconUrl = vscodeIconForFile(entry.name);
          return iconUrl
            ? <img className="cy-file-tree__type-icon" src={iconUrl} alt="" width={14} height={14} />
            : <FileText size={14} strokeWidth={1.75} aria-hidden="true" />;
        },
  };
}

/** 把拉取到的子级挂到指定目录节点上（递归查找） */
function attachChildren(items: TreeItem[], parentKey: string, children: TreeItem[]): TreeItem[] {
  return items.map((item) => {
    if (item.key === parentKey) return { ...item, children, loaded: true };
    if (item.children) return { ...item, children: attachChildren(item.children, parentKey, children) };
    return item;
  });
}

export function FileTreePanel({
  sessionId,
  workspaceRoot,
  onOpenFile,
}: {
  sessionId: string;
  /** 工作区根路径（仅用于判定是否绑定；实际访问全部走 sessionId 由主进程校验） */
  workspaceRoot?: string;
  onOpenFile: (relPath: string) => void;
}) {
  const { t } = useTranslation();
  const [treeData, setTreeData] = useState<TreeItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<WorkspaceFileErrorCode | null>(null);
  const [truncated, setTruncated] = useState(false);
  // 文件树根容器引用：切标签前用它释放焦点，避免 aria-hidden 区域持有 activeElement
  const treeRootRef = useRef<HTMLDivElement>(null);

  const listDirectory = useCallback(
    async (relPath: string): Promise<TreeItem[]> => {
      const api = window.workspaceFiles;
      if (!api) throw new Error("workspaceFiles API unavailable");
      const result = await api.list(sessionId, relPath);
      if (!result.ok) throw Object.assign(new Error(result.code), { code: result.code });
      setTruncated(Boolean(result.truncated));
      return result.entries.map(toTreeItem);
    },
    [sessionId],
  );

  // 根目录：sessionId / 工作区变化时重拉
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    listDirectory("")
      .then((items) => {
        if (!cancelled) setTreeData(items);
      })
      .catch((err: { code?: WorkspaceFileErrorCode }) => {
        if (!cancelled) {
          setError(err?.code ?? "LIST_FAILED");
          setTreeData([]);
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [listDirectory, workspaceRoot]);

  // 懒加载：展开目录时拉该层
  const loadData = useCallback(
    async (node: EventDataNode<TreeItem>) => {
      const item = node as unknown as TreeItem;
      if (!item.isDir || item.loaded) return;
      const children = await listDirectory(item.key);
      setTreeData((current) => attachChildren(current, item.key, children));
    },
    [listDirectory],
  );

  if (!workspaceRoot) {
    return <div className="cy-file-tree is-state">{t("fileTree.errNoWorkspace")}</div>;
  }
  if (loading && treeData.length === 0) {
    return <div className="cy-file-tree is-state">{t("fileTree.loading")}</div>;
  }
  if (error) {
    return <div className="cy-file-tree is-state">{t(ERROR_KEYS[error])}</div>;
  }
  if (treeData.length === 0) {
    return <div className="cy-file-tree is-state">{t("fileTree.empty")}</div>;
  }

  return (
    <div className="cy-file-tree" ref={treeRootRef}>
      {/* antd v6 的目录树挂在 Tree.DirectoryTree 上：点击目录名即展开/收起（expandAction 默认 click） */}
      <Tree.DirectoryTree
        treeData={treeData}
        loadData={loadData}
        showIcon
        blockNode
        onSelect={(_keys, info) => {
          const item = info.node as unknown as TreeItem;
          if (!item.isDir) {
            // 切标签前释放文件树焦点，避免 aria-hidden 面板持有 activeElement
            releaseFocusedDescendant(treeRootRef.current);
            onOpenFile(item.key);
          }
        }}
      />
      {truncated && <div className="cy-file-tree__truncated">{t("fileTree.truncated", { count: 1000 })}</div>}
    </div>
  );
}

export function FilePreviewContent({
  sessionId,
  relPath,
  scrollToLine,
  lineSeq,
}: {
  sessionId: string;
  relPath: string;
  /** 从消息文件链接跳转过来时定位到该行（居中滚动）；缺省不做定位 */
  scrollToLine?: number;
  /** 定位序号：同标签换行号时靠它变化触发重新滚动 */
  lineSeq?: number;
}) {
  const { t } = useTranslation();
  const [state, setState] = useState<
    | { phase: "loading" }
    | { phase: "error"; code: WorkspaceFileErrorCode }
    | { phase: "ok"; content: string; size: number }
  >({ phase: "loading" });
  // shiki 高亮结果（null = 未高亮/不支持，先按纯文本渲染）
  const [tokens, setTokens] = useState<ThemedToken[][] | null>(null);
  // Markdown 文件的查看方式：渲染预览 / 源码（非 md 文件不用）；
  // 带行号定位跳转过来时直接进源码视图（预览视图没有行号概念）
  const isMarkdown = isMarkdownPath(relPath);
  const [mdView, setMdView] = useState<"preview" | "source">(scrollToLine === undefined ? "preview" : "source");
  const scrollHostRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let cancelled = false;
    setState({ phase: "loading" });
    setTokens(null);
    // 切换文件时回到默认视图；带行号定位的打开方式下回源码视图
    setMdView(scrollToLine === undefined ? "preview" : "source");
    const api = window.workspaceFiles;
    if (!api) {
      setState({ phase: "error", code: "READ_FAILED" });
      return;
    }
    api.read(sessionId, relPath)
      .then((result) => {
        if (cancelled) return;
        if (!result.ok) {
          setState({ phase: "error", code: result.code });
          return;
        }
        setState({ phase: "ok", content: result.content, size: result.size });
        // 读取成功后异步上色：渐进式，失败保持纯文本
        const lang = langForPath(relPath);
        if (!lang) return;
        getHighlighter()
          .then((highlighter) => highlighter.codeToTokens(result.content, { lang, theme: HIGHLIGHT_THEME }))
          .then((highlight) => {
            if (!cancelled) setTokens(highlight.tokens);
          })
          .catch(() => {
            // 高亮失败不影响阅读，静默保持纯文本
          });
      })
      .catch(() => {
        if (!cancelled) setState({ phase: "error", code: "READ_FAILED" });
      });
    return () => {
      cancelled = true;
    };
  }, [sessionId, relPath]);

  // 行号定位：文件内容就绪后把目标行滚到视口中间；lineSeq 变化（同标签换行号）时重滚
  useEffect(() => {
    if (state.phase !== "ok" || scrollToLine === undefined) return;
    const host = scrollHostRef.current;
    if (!host) return;
    const row = host.querySelector<HTMLElement>(`[data-line="${scrollToLine}"]`);
    row?.scrollIntoView({ block: "center", behavior: "auto" });
  }, [state.phase, scrollToLine, lineSeq, mdView]);

  if (state.phase === "loading") {
    return <div className="cy-file-preview is-state">{t("fileTree.previewLoading")}</div>;
  }
  if (state.phase === "error") {
    return <div className="cy-file-preview is-state">{t(ERROR_KEYS[state.code])}</div>;
  }

  // 高亮结果与纯文本统一成"每行一个 token 列表"的结构再渲染
  const totalLines = tokens ? tokens.length : state.content.split("\n").length;
  const lineTokens: ThemedToken[][] = tokens ?? state.content.split("\n").map((line) => [{ content: line, offset: 0 }]);
  const lines = lineTokens.slice(0, PREVIEW_MAX_LINES);

  // Markdown 渲染预览同样限制行数，避免超大文档一次性铺满 DOM
  const renderedContent = isMarkdown && totalLines > PREVIEW_MAX_LINES
    ? state.content.split("\n").slice(0, PREVIEW_MAX_LINES).join("\n")
    : state.content;

  return (
    <div className="cy-file-preview" ref={scrollHostRef}>
      <div className="cy-file-preview__header">
        <span className="cy-file-preview__path" title={relPath}>{relPath}</span>
        <span className="cy-file-preview__size">{(state.size / 1024).toFixed(1)} KB</span>
        {isMarkdown && (
          <span className="cy-file-preview__md-toggle" role="group" aria-label={t("rightInspector.toggle")}>
            <button
              type="button"
              className={`cy-file-preview__md-btn ${mdView === "preview" ? "is-active" : ""}`}
              onClick={() => setMdView("preview")}
              aria-label={t("fileTree.viewPreview")}
              title={t("fileTree.viewPreview")}
            >
              <EyeIcon />
            </button>
            <button
              type="button"
              className={`cy-file-preview__md-btn ${mdView === "source" ? "is-active" : ""}`}
              onClick={() => setMdView("source")}
              aria-label={t("fileTree.viewSource")}
              title={t("fileTree.viewSource")}
            >
              <CodeIcon />
            </button>
          </span>
        )}
      </div>
      {isMarkdown && mdView === "preview" ? (
        <div className="cy-file-preview__markdown">
          <MarkdownContent content={renderedContent} />
        </div>
      ) : (
        <pre className="cy-file-preview__code">
          {lines.map((line, index) => (
            <div className="cy-file-preview__line" key={index} data-line={index + 1}>
              <span className="cy-file-preview__lineno">{index + 1}</span>
              <span className="cy-file-preview__text">
                {line.map((token, tokenIndex) =>
                  token.color ? (
                    <span key={tokenIndex} style={{ color: token.color }}>{token.content}</span>
                  ) : (
                    token.content
                  ),
                )}
              </span>
            </div>
          ))}
        </pre>
      )}
      {totalLines > PREVIEW_MAX_LINES && (
        <div className="cy-file-preview__truncated">
          {t("fileTree.previewLinesHint", { count: PREVIEW_MAX_LINES })}
        </div>
      )}
    </div>
  );
}
