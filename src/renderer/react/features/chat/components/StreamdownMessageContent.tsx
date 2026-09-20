import { CodeHighlighter } from "@ant-design/x";
import { createMathPlugin } from "@streamdown/math";
import {
  defaultRehypePlugins,
  Streamdown,
  type Components,
  type ControlsConfig,
} from "streamdown";
import type { PluggableList } from "unified";
import React, { isValidElement, useContext, type ReactNode } from "react";
import { FileLinkContext, MessageStreamingContext } from "./ChatMessageList";
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

function StreamdownAnchor({ href, children }: { href?: string; children?: ReactNode }) {
  const { workspaceRoot, openFile } = useContext(FileLinkContext);
  const fileHref = href ? decodeStreamdownFileHref(href) : null;
  const target = fileHref ? parseFileLinkHref(fileHref) : null;
  if (target) {
    const relPath = workspaceRoot ? relativePathInsideWorkspace(target.absPath, workspaceRoot) : null;
    if (relPath && openFile) {
      return (
        <button
          type="button"
          className="cy-file-link"
          title={target.absPath}
          onClick={() => openFile(relPath, target.lineStart)}
        >
          <svg className="cy-file-link__icon" viewBox="0 0 16 16" width="12" height="12" aria-hidden="true">
            <path
              d="M4 1.5h5L12.5 5v9a.5.5 0 0 1-.5.5H4a.5.5 0 0 1-.5-.5V2a.5.5 0 0 1 .5-.5Z"
              fill="none"
              stroke="currentColor"
              strokeLinejoin="round"
            />
            <path d="M9 1.5V5h3.5" fill="none" stroke="currentColor" strokeLinejoin="round" />
          </svg>
          <span className="cy-file-link__text">{children}</span>
        </button>
      );
    }
    return <span className="cy-file-link is-plain">{children}</span>;
  }
  return <a href={href} target="_blank" rel="noreferrer">{children}</a>;
}

const mathPlugin = createMathPlugin({ singleDollarTextMath: true });
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

export function StreamdownMessageContent({ content, streaming }: StreamdownMessageContentProps) {
  return (
    <Streamdown
      mode={streaming ? "streaming" : "static"}
      parseIncompleteMarkdown={streaming}
      plugins={{ math: mathPlugin }}
      components={messageComponents}
      rehypePlugins={rehypePlugins}
      controls={chatControls}
      className="cy-message-markdown cy-streamdown-message"
    >
      {content}
    </Streamdown>
  );
}
