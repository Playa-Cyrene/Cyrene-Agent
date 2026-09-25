import { CodeHighlighter } from "@ant-design/x";
import { createMathPlugin } from "@streamdown/math";
import {
  defaultRehypePlugins,
  Streamdown,
  type Components,
  type ControlsConfig,
} from "streamdown";
import type { PluggableList } from "unified";
import React, { isValidElement, useCallback, useContext, useState, type ReactNode } from "react";
import { useTranslation } from "../../../i18n";
import { MessageStreamingContext } from "./ChatMessageList";
import { chatStore } from "../pages/chat-page-bridge";
import { copyTextToClipboard } from "./CopyButton";
import { FileContextMenu, clampMenuPosition, type FileContextMenuItem } from "./FileContextMenu";
import { FileLinkContext } from "./FileLinkContext";
import { FileIcon } from "./file-icon";
import { MermaidBlock } from "./MermaidBlock";
import { SvgCardBlock } from "./SvgCardBlock";
import { parseFileLinkHref, relativePathInsideWorkspace } from "./file-link";
import {
  decodeStreamdownFileHref,
  encodeStreamdownFileLinksInHast,
} from "./streamdown-file-link";
import "./StreamdownMessageContent.css";

interface StreamdownMessageContentProps {
  content: string;
  streaming: boolean;
}

function nodeText(node: ReactNode): string {
  if (node === null || node === undefined || typeof node === "boolean") return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(nodeText).join("");
  return isValidElement<{ children?: ReactNode }>(node) ? nodeText(node.props.children) : "";
}

function extractCodeBlock(children: ReactNode): { code: string; lang: string } | null {
  let result: { code: string; lang: string } | null = null;
  React.Children.forEach(children, (child) => {
    if (!isValidElement<{ className?: string; children?: ReactNode }>(child)) return;
    const langMatch = /language-([\S]+)/.exec(child.props.className ?? "");
    result = {
      code: nodeText(child.props.children).replace(/\n$/, ""),
      lang: langMatch?.[1] ?? "",
    };
  });
  return result;
}

function StreamdownPre({ children }: { children?: ReactNode }) {
  const streaming = useContext(MessageStreamingContext);
  const info = extractCodeBlock(children);
  if (!info) return <pre>{children}</pre>;
  if (info.lang === "mermaid") return <MermaidBlock code={info.code} streaming={streaming} />;
  if (info.lang === "svg") return <SvgCardBlock code={info.code} streaming={streaming} />;
  return (
    <CodeHighlighter lang={info.lang || "text"} prismLightMode={false}>
      {info.code}
    </CodeHighlighter>
  );
}

/** 网站链接（http/https）行内卡片：favicon + 文本 + 域名，favicon 失败降级地球图标 */
function WebLinkAnchor({ href, children }: { href: string; children?: ReactNode }) {
  const [iconFailed, setIconFailed] = useState(false);
  let domain = "";
  try {
    domain = new URL(href).hostname.replace(/^www\./, "");
  } catch {
    domain = "";
  }
  return (
    <a className="cy-web-link" href={href} target="_blank" rel="noreferrer" title={href}>
      {iconFailed || !domain ? (
        <svg className="cy-web-link__icon" viewBox="0 0 16 16" aria-hidden="true">
          <circle cx="8" cy="8" r="6.2" fill="none" stroke="currentColor" strokeWidth="1.2" />
          <path d="M1.8 8h12.4M8 1.8c2.6 2.6 2.6 7.8 0 12.4M8 1.8c-2.6 2.6-2.6 7.8 0 12.4" fill="none" stroke="currentColor" strokeWidth="1.2" />
        </svg>
      ) : (
        <img
          className="cy-web-link__favicon"
          src={`https://${domain}/favicon.ico`}
          alt=""
          loading="lazy"
          onError={() => setIconFailed(true)}
        />
      )}
      <span className="cy-web-link__text">{children}</span>
      {domain && <span className="cy-web-link__domain">{domain}</span>}
    </a>
  );
}

/** 链接里的正斜杠绝对路径 → 复制用显示格式（Windows 反斜杠，其他平台原样） */
function toDisplayAbsPath(absPath: string): string {
  return navigator.userAgent.includes("Windows") ? absPath.replaceAll("/", "\\") : absPath;
}

function StreamdownAnchor({ href, children }: { href?: string; children?: ReactNode }) {
  const { t } = useTranslation();
  const { sessionId, workspaceRoot, openFile } = useContext(FileLinkContext);
  const [menu, setMenu] = useState<{ absPath: string; relPath: string | null; x: number; y: number } | null>(null);
  const fileHref = href ? decodeStreamdownFileHref(href) : null;
  const target = fileHref ? parseFileLinkHref(fileHref) : null;

  const openLinkMenu = useCallback((event: React.MouseEvent, absPath: string) => {
    event.preventDefault();
    event.stopPropagation();
    const relPath = workspaceRoot ? relativePathInsideWorkspace(absPath, workspaceRoot) : null;
    const { x, y } = clampMenuPosition(event.clientX, event.clientY);
    setMenu({ absPath, relPath, x, y });
  }, [workspaceRoot]);

  // 打开/定位直接传绝对路径（主进程 realpath 校验，支持工作区外的桌面文件等场景）
  const runMenuAction = useCallback(
    async (action: "open" | "reveal" | "copyRel" | "copyAbs", target: { absPath: string; relPath: string | null }) => {
      setMenu(null);
      if (action === "open" || action === "reveal") {
        if (!sessionId) return;
        const result = await chatStore()?.shellFile(sessionId, target.absPath, action);
        if (result && !result.ok) console.warn("[StreamdownAnchor] shellFile 失败:", result.error);
        return;
      }
      if (action === "copyRel") {
        if (target.relPath) await copyTextToClipboard(target.relPath);
        return;
      }
      await copyTextToClipboard(toDisplayAbsPath(target.absPath));
    },
    [sessionId],
  );

  if (target) {
    const relPath = workspaceRoot ? relativePathInsideWorkspace(target.absPath, workspaceRoot) : null;
    const menuItems: FileContextMenuItem[] = menu ? [
      ...(sessionId ? [
        { key: "open", label: t("fileChange.menuOpen"), run: () => runMenuAction("open", menu) },
        { key: "reveal", label: t("fileChange.menuReveal"), run: () => runMenuAction("reveal", menu) },
      ] : []),
      ...(menu.relPath ? [
        { key: "copyRel", label: t("fileChange.menuCopyRelPath"), run: () => runMenuAction("copyRel", menu) },
      ] : []),
      { key: "copyAbs", label: t("fileChange.menuCopyAbsPath"), run: () => runMenuAction("copyAbs", menu) },
    ] : [];
    if (relPath && openFile) {
      return (
        <>
          <button
            type="button"
            className="cy-file-link"
            title={target.absPath}
            onClick={() => openFile(relPath, target.lineStart)}
            onContextMenu={(event) => openLinkMenu(event, target.absPath)}
          >
            <FileIcon fileName={target.absPath} className="cy-file-link__icon" />
            <span className="cy-file-link__text">{children}</span>
          </button>
          {menu && <FileContextMenu x={menu.x} y={menu.y} items={menuItems} onClose={() => setMenu(null)} />}
        </>
      );
    }
    return (
      <>
        <span className="cy-file-link is-plain" onContextMenu={(event) => openLinkMenu(event, target.absPath)}>
          <FileIcon fileName={target.absPath} className="cy-file-link__icon" />
          {children}
        </span>
        {menu && <FileContextMenu x={menu.x} y={menu.y} items={menuItems} onClose={() => setMenu(null)} />}
      </>
    );
  }
  // 网站链接渲染成行内卡片；其他协议（mailto:、obsidian:// 等）保持普通链接
  if (href && /^https?:\/\//i.test(href)) {
    return <WebLinkAnchor href={href}>{children}</WebLinkAnchor>;
  }
  return <a href={href} target="_blank" rel="noreferrer">{children}</a>;
}

const mathPlugin = createMathPlugin({ singleDollarTextMath: true });
const messagePlugins = { math: mathPlugin };
const chatControls: ControlsConfig = { table: false };
const messageComponents: Components = {
  a: (props) => <StreamdownAnchor {...props} />,
  pre: (props) => <StreamdownPre {...props} />,
};
const rehypePlugins: PluggableList = [
  defaultRehypePlugins.raw,
  encodeStreamdownFileLinksInHast,
  defaultRehypePlugins.sanitize,
  defaultRehypePlugins.harden,
];

function stripMarkdownCode(content: string): string {
  return content
    .replace(/(^|\n)[ \t]{0,3}(`{3,}|~{3,})[^\n]*(?:\n[\s\S]*?\n[ \t]{0,3}\2[ \t]*(?=\n|$)|$)/g, "$1")
    .replace(/(`+)[^\n]*?\1/g, "");
}

function isEscaped(content: string, index: number): boolean {
  let slashCount = 0;
  for (let cursor = index - 1; cursor >= 0 && content[cursor] === "\\"; cursor -= 1) {
    slashCount += 1;
  }
  return slashCount % 2 === 1;
}

function containsRenderedMath(content: string): boolean {
  const visibleContent = stripMarkdownCode(content);
  let inlineStart = -1;
  let displayStart = -1;

  for (let index = 0; index < visibleContent.length; index += 1) {
    if (visibleContent[index] !== "$" || isEscaped(visibleContent, index)) continue;

    if (visibleContent[index + 1] === "$" && !isEscaped(visibleContent, index + 1)) {
      if (displayStart >= 0 && visibleContent.slice(displayStart, index).trim()) return true;
      displayStart = index + 2;
      index += 1;
      continue;
    }

    if (inlineStart >= 0 && visibleContent.slice(inlineStart, index).trim()) return true;
    inlineStart = index + 1;
  }

  return false;
}

export function StreamdownMessageContent({ content, streaming }: StreamdownMessageContentProps) {
  // Streamdown's block mode preserves the already-rendered KaTeX blocks. Switching a long
  // math response to static mode on completion would tear down and rebuild the entire tree.
  const useBlockMode = streaming || containsRenderedMath(content);

  return (
    <Streamdown
      mode={useBlockMode ? "streaming" : "static"}
      parseIncompleteMarkdown={streaming}
      plugins={messagePlugins}
      components={messageComponents}
      rehypePlugins={rehypePlugins}
      controls={chatControls}
      className="cy-message-markdown cy-streamdown-message"
    >
      {content}
    </Streamdown>
  );
}
