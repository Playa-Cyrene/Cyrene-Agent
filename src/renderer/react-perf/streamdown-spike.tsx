// A1-S spike：Streamdown 流式正文渲染器。
// 本文件只被 react-perf/main.tsx 静态导入并注册到 window.__cyreneChatPerfMarkdownRenderer；
// 正式产品构建的入口不含 react-perf，不会解析本文件及 streamdown 依赖（vite 构建图隔离）。
// 消费端见 ChatMessageList.tsx 的 MarkdownContent（streamdown 分支）。
// 行为对齐基线：anchor/code 的界内外文件链接、mermaid/svg 分流逻辑与 XMarkdown 版一致。

import React, { useContext, isValidElement, type ReactNode } from "react";
import {
  Streamdown,
  defaultRehypePlugins,
  defaultUrlTransform,
  type Components,
  type UrlTransform,
} from "streamdown";
import type { PluggableList } from "unified";
import { math as mathPlugin } from "@streamdown/math";
import { CodeHighlighter } from "@ant-design/x";
import "./streamdown-spike.css";
import {
  FileLinkContext,
  MessageStreamingContext,
} from "../react/features/chat/components/ChatMessageList";
import { MermaidBlock } from "../react/features/chat/components/MermaidBlock";
import { SvgCardBlock } from "../react/features/chat/components/SvgCardBlock";
import {
  parseFileLinkHref,
  relativePathInsideWorkspace,
} from "../react/features/chat/components/file-link";

/** 递归收集 React 子树里的纯文本（代码块内容提取用） */
function nodeText(node: ReactNode): string {
  if (node === null || node === undefined || typeof node === "boolean") return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(nodeText).join("");
  if (isValidElement<{ children?: ReactNode }>(node)) return nodeText(node.props.children);
  return "";
}

/** 从 react-markdown 的 <pre> 子树中提取代码块语言与内容 */
function extractCodeBlock(children: ReactNode): { code: string; lang: string } | null {
  let result: { code: string; lang: string } | null = null;
  React.Children.forEach(children, (child) => {
    if (!isValidElement<{ className?: string; children?: ReactNode }>(child)) return;
    const props = child.props;
    const langMatch = /language-([\S]+)/.exec(props.className ?? "");
    const code = nodeText(props.children).replace(/\n$/, "");
    result = { code, lang: langMatch?.[1] ?? "" };
  });
  return result;
}

/**
 * 代码块分流：与 ChatMessageList 的 MarkdownCode 保持一致——
 * mermaid/svg 走现有块组件（流式占位经 MessageStreamingContext），其余走 CodeHighlighter。
 * 若 streamdown 的 <pre> 覆盖生效，此组件接管全部围栏代码块。
 */
function SpikePre({ children }: { children?: ReactNode }) {
  const streaming = useContext(MessageStreamingContext);
  const info = extractCodeBlock(children);
  if (!info) return <pre>{children}</pre>;
  if (info.lang === "mermaid") {
    return <MermaidBlock code={info.code} streaming={streaming} />;
  }
  if (info.lang === "svg") {
    return <SvgCardBlock code={info.code} streaming={streaming} />;
  }
  return (
    <CodeHighlighter lang={info.lang || "text"} prismLightMode={false}>
      {info.code}
    </CodeHighlighter>
  );
}

/**
 * 链接渲染：与 ChatMessageList 的 MarkdownAnchor 行为一致——
 * file:/// 且工作区内 → 可点 chip；越界/未绑定工作区 → 降级纯文本；其余 → 新窗口打开。
 * 判断逻辑复用 file-link 模块与 FileLinkContext，不复制业务规则。
 */
function SpikeAnchor({ href, children }: { href?: string; children?: ReactNode }) {
  const { workspaceRoot, openFile } = useContext(FileLinkContext);
  const target = href ? parseFileLinkHref(href) : null;
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
              fill="none" stroke="currentColor" strokeLinejoin="round"
            />
            <path d="M9 1.5V5h3.5" fill="none" stroke="currentColor" strokeLinejoin="round" />
          </svg>
          <span className="cy-file-link__text">{children}</span>
        </button>
      );
    }
    return <span className="cy-file-link is-plain">{children}</span>;
  }
  return (
    <a href={href} target="_blank" rel="noreferrer">
      {children}
    </a>
  );
}

const spikeComponents: Components = { a: SpikeAnchor, pre: SpikePre };

/**
 * Streamdown 默认的 URL 安全转换会拦截 file:/// 协议（渲染为 [blocked] 文本），
 * 而 Cyrene 的文件链接语义依赖 file:/// href 交给 anchor 组件判断界内/越界。
 * 这里放行 file:///，其余协议保持库默认安全转换（http/https/mailto 等白名单）。
 */
const spikeUrlTransform: UrlTransform = (url, key, node) => {
  if (url.startsWith("file:///")) return url;
  return defaultUrlTransform(url, key, node);
};

/**
 * 默认 rehype 链（raw→sanitize→harden）对 file:/// 有两层拦截：
 * 1. rehype-sanitize 的 href 协议白名单不含 file，先剥掉 href；
 * 2. rehype-harden 的内部协议黑名单写死 file:（源码 line 69-74，无任何配置项可放行，
 *    allowedProtocols 检查在黑名单之后），sanitize 放行了也仍渲染 [blocked]。
 * 这里基于 streamdown 导出的默认链重组：
 * - sanitize schema 的 href 协议白名单显式补 "file"（工作区文件链接语义需要）；
 * - 去掉 harden，由 rehype-sanitize 白名单独立承担安全边界（script/事件属性/
 *   javascript: 等仍被剥除，见语义清单第 9 项）；代价是危险链接不再有 [blocked] 占位，
 *   而是被 sanitize 静默去 href，该行为差异记录进 A1-S 报告。
 * 注意：此链仅限 spike 实验，不等价于 streamdown 默认安全能力，不得原样迁入产品——
 * 产品迁移的首选路径：解析前把内部 file 链接编码成受控占位链接，由 anchor 适配器
 * 解码并做工作区边界检查，保留默认 harden 链（占位链接走 http(s) 语义，harden 无需放行）。
 * 注意：必须保持模块级引用稳定——Block 的 memo 相等性检查包含 rehypePlugins 引用比较，
 * 每次渲染新建数组会使逐块 memo 全部失效，直接摧毁 spike 的性能假设。
 */
const [defaultSanitizePlugin, defaultSanitizeSchema] = defaultRehypePlugins.sanitize as unknown as [
  PluggableList[number],
  { protocols?: { href?: string[] } },
];
const spikeRehypePlugins: PluggableList = [
  defaultRehypePlugins.raw,
  [
    defaultSanitizePlugin,
    {
      ...defaultSanitizeSchema,
      protocols: {
        ...defaultSanitizeSchema.protocols,
        href: [...(defaultSanitizeSchema.protocols?.href ?? []), "file"],
      },
    },
  ],
];

/**
 * 流式正文渲染（A1-S 对照组）：
 * - mode="streaming" + parseIncompleteMarkdown：remend 补全未闭合语法（强调/链接/代码/公式）
 * - 内置按块分割 + 逐块 memo：稳定块不随尾部 delta 重建（性能假设的验证对象）
 * - plugins.math：remark-math + rehype-katex（KaTeX CSS 在 spike css 中显式引入）
 */
export function StreamdownSpikeContent({ content }: { content: string }) {
  return (
    <Streamdown
      mode="streaming"
      parseIncompleteMarkdown
      plugins={{ math: mathPlugin }}
      components={spikeComponents}
      rehypePlugins={spikeRehypePlugins}
      urlTransform={spikeUrlTransform}
      className="cy-spike-streamdown"
    >
      {content}
    </Streamdown>
  );
}
