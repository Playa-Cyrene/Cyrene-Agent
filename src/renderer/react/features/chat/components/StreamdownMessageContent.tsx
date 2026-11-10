import { CodeHighlighter } from "@ant-design/x";
import {
  defaultRehypePlugins,
  Streamdown,
  type Components,
  type ControlsConfig,
} from "streamdown";
import type { PluggableList, Plugin } from "unified";
import React, { isValidElement, useCallback, useContext, useMemo, useState, type ReactNode } from "react";
import { messageMathPlugin, containsBackslashMath } from "./streamdown-math";
import { useTranslation } from "../../../i18n";
import { MessageStreamingContext } from "./ChatMessageList";
import { chatStore } from "../pages/chat-page-bridge";
import { copyTextToClipboard } from "./CopyButton";
import { FileContextMenu, clampMenuPosition, type FileContextMenuItem } from "./FileContextMenu";
import { FileLinkContext } from "./FileLinkContext";
import { FileIcon, hasFileIconMapping } from "./file-icon";
import { DEMO_FILE_PREVIEW_REL_PATH } from "./demoFilePreview";
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
    <CodeHighlighter
      className="cy-message-code-block"
      lang={info.lang || "text"}
      prismLightMode={false}
      styles={{
        root: {
          color: "var(--rb-text-primary)",
          background: "var(--rb-code-bg)",
        },
        header: {
          color: "var(--rb-text-primary)",
          background: "var(--rb-bg-2)",
        },
        code: {
          color: "var(--rb-text-primary)",
          background: "transparent",
          borderColor: "var(--rb-border-default)",
        },
      }}
    >
      {info.code}
    </CodeHighlighter>
  );
}

/** 演示会话中的文件名代码片段：复用项目后缀映射，仅展示图标，不改变交互。 */
function StreamdownInlineCode({
  children,
  className,
  ...props
}: React.ComponentProps<"code">) {
  const { sessionId, openFile } = useContext(FileLinkContext);
  const fileName = typeof children === "string" ? children : "";
  const isDemoFileName =
    sessionId === "preview-code" &&
    !className &&
    /^[\w.-]+\.[a-z\d]{1,10}$/i.test(fileName) &&
    hasFileIconMapping(fileName);

  if (!isDemoFileName || !openFile) return <code className={className} {...props}>{children}</code>;

  return (
    <code className="cy-demo-file-code" {...props}>
      <button
        type="button"
        className="cy-demo-file-action"
        title={`预览 ${fileName}`}
        aria-label={`预览文件 ${fileName}`}
        onClick={() => openFile(DEMO_FILE_PREVIEW_REL_PATH)}
      >
        <FileIcon fileName={fileName} className="cy-demo-file-code__icon" />
        {children}
      </button>
    </code>
  );
}

/** 表格与列表中的普通文本也按文件名匹配；只在演示会话中添加装饰图标。 */
function renderDemoFileNames(node: ReactNode, openFile?: (relPath: string) => void): ReactNode {
  if (typeof node === "string") {
    const parts: ReactNode[] = [];
    const pattern = /[A-Za-z0-9_.-]+\.[A-Za-z0-9]{1,10}/g;
    let cursor = 0;
    let match: RegExpExecArray | null;

    while ((match = pattern.exec(node)) !== null) {
      const fileName = match[0];
      const start = match.index;
      const end = start + fileName.length;
      const hasFilenameBoundary =
        (start === 0 || !/[A-Za-z0-9_./\\-]/.test(node[start - 1])) &&
        (end === node.length || !/[A-Za-z0-9_./\\-]/.test(node[end]));
      if (!hasFilenameBoundary || !hasFileIconMapping(fileName)) continue;

      parts.push(node.slice(cursor, start));
      parts.push(
        <button
          type="button"
          className="cy-demo-file-name"
          key={`file-${start}`}
          title={`预览 ${fileName}`}
          aria-label={`预览文件 ${fileName}`}
          onClick={openFile ? () => openFile(DEMO_FILE_PREVIEW_REL_PATH) : undefined}
          disabled={!openFile}
        >
          <FileIcon fileName={fileName} className="cy-demo-file-name__icon" />
          {fileName}
        </button>,
      );
      cursor = end;
    }

    if (cursor === 0) return node;
    parts.push(node.slice(cursor));
    return <>{parts}</>;
  }

  if (Array.isArray(node)) return node.map((child) => renderDemoFileNames(child, openFile));
  if (!isValidElement<{ children?: ReactNode }>(node)) return node;
  if (
    node.type === "code" ||
    node.type === "a" ||
    node.type === StreamdownInlineCode ||
    (typeof node.type !== "string" && node.type !== React.Fragment)
  ) {
    return node;
  }
  if (node.props.children === undefined) return node;
  return React.cloneElement(node, {}, renderDemoFileNames(node.props.children, openFile));
}

function DemoFileNameListItem(props: React.ComponentProps<"li">) {
  const { sessionId, openFile } = useContext(FileLinkContext);
  return (
    <li {...props}>
      {sessionId === "preview-code" ? renderDemoFileNames(props.children, openFile) : props.children}
    </li>
  );
}

function DemoFileNameTableCell(props: React.ComponentProps<"td">) {
  const { sessionId, openFile } = useContext(FileLinkContext);
  return (
    <td {...props}>
      {sessionId === "preview-code" ? renderDemoFileNames(props.children, openFile) : props.children}
    </td>
  );
}

function DemoFileNameTableHeader(props: React.ComponentProps<"th">) {
  const { sessionId, openFile } = useContext(FileLinkContext);
  return (
    <th {...props}>
      {sessionId === "preview-code" ? renderDemoFileNames(props.children, openFile) : props.children}
    </th>
  );
}

/** 网站链接（http/https）行内卡片：favicon + 文本 + 域名，favicon 失败降级地球图标 */
function WebLinkAnchor({ href, children }: { href: string; children?: ReactNode }) {
  const { t } = useTranslation();
  const { openWebLink } = useContext(FileLinkContext);
  const [iconFailed, setIconFailed] = useState(false);
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  let domain = "";
  try {
    domain = new URL(href).hostname.replace(/^www\./, "");
  } catch {
    domain = "";
  }
  const open = useCallback((destination: "cyrene" | "external") => {
    setMenu(null);
    if (openWebLink) {
      void openWebLink(href, destination);
    } else if (destination === "external") {
      void window.system?.openExternal(href);
    }
  }, [href, openWebLink]);
  const openContextMenu = useCallback((event: React.MouseEvent) => {
    event.preventDefault();
    event.stopPropagation();
    const { x, y } = clampMenuPosition(event.clientX, event.clientY);
    setMenu({ x, y });
  }, []);
  const menuItems: FileContextMenuItem[] = menu ? [
    ...(openWebLink ? [{ key: "cyrene", label: t("browserPanel.openInCyrene"), run: () => open("cyrene") }] : []),
    { key: "external", label: t("browserPanel.openExternal"), run: () => open("external") },
  ] : [];
  return (
    <>
      <a
        className="cy-web-link"
        href={href}
        title={href}
        onClick={(event) => {
          event.preventDefault();
          open(openWebLink ? "cyrene" : "external");
        }}
        onAuxClick={(event) => {
          if (event.button !== 1 || !openWebLink) return;
          event.preventDefault();
          open("cyrene");
        }}
        onContextMenu={openContextMenu}
      >
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
      {menu && <FileContextMenu x={menu.x} y={menu.y} items={menuItems} onClose={() => setMenu(null)} />}
    </>
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
  if (fileHref) return <span>{children}</span>;
  // 网站链接渲染成行内卡片；其他协议（mailto:、obsidian:// 等）保持普通链接
  if (href && /^https?:\/\//i.test(href)) {
    return <WebLinkAnchor href={href}>{children}</WebLinkAnchor>;
  }
  return <a href={href} target="_blank" rel="noreferrer">{children}</a>;
}

const messagePlugins = { math: messageMathPlugin };
const chatControls: ControlsConfig = { table: false };
const messageComponents: Components = {
  a: (props) => <StreamdownAnchor {...props} />,
  code: (props) => <StreamdownInlineCode {...props} />,
  li: (props) => <DemoFileNameListItem {...props} />,
  pre: (props) => <StreamdownPre {...props} />,
  td: (props) => <DemoFileNameTableCell {...props} />,
  th: (props) => <DemoFileNameTableHeader {...props} />,
};
// 保留 KaTeX 的显示/行内类名；其余清洗规则沿用 Streamdown 的锁定默认 schema。
const [sanitize, sanitizeSchema] = defaultRehypePlugins.sanitize as [Plugin, {
  attributes: Record<string, (string | [string, ...unknown[]])[]>;
}];
const mathSanitizeSchema = {
  ...sanitizeSchema,
  attributes: {
    ...sanitizeSchema.attributes,
    code: sanitizeSchema.attributes.code.map((attribute) =>
      Array.isArray(attribute) && attribute[0] === "className"
        ? [...attribute, "math-display", "math-inline"] : attribute),
  },
};
// remend 1.4.0 把未闭合的 \[ 当成链接，可能补造 \]；数学配对必须来自原文。
const backslashMathRemend = { links: false, images: false };
const rehypePlugins: PluggableList = [
  defaultRehypePlugins.raw,
  encodeStreamdownFileLinksInHast,
  [sanitize, mathSanitizeSchema],
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
  const hasBackslashMath = useMemo(() => !streaming && containsBackslashMath(content), [content, streaming]);
  // Streamdown's block mode preserves the already-rendered KaTeX blocks. Switching a long
  // math response to static mode on completion would tear down and rebuild the entire tree.
  const useBlockMode = streaming || hasBackslashMath || containsRenderedMath(content);

  return (
    <Streamdown
      mode={useBlockMode ? "streaming" : "static"}
      parseIncompleteMarkdown={streaming}
      remend={content.lastIndexOf("\\[") > content.lastIndexOf("\\]") ? backslashMathRemend : undefined}
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
