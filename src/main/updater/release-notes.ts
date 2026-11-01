import sanitizeHtml from "sanitize-html";
import { marked } from "marked";

/**
 * 更新说明转成可安全渲染的 HTML。
 *
 * GitHub 发布源（electron-updater 的 GitHub provider）给出的是 GitHub 已渲染好的 HTML；
 * 其他发布源可能是 Markdown 或纯文本。两种都统一成经过白名单净化的 HTML 交给设置页渲染，
 * 只保留排版标签与 https 链接，脚本、事件属性、样式与其他协议一律丢弃。
 */
const RELEASE_NOTES_HTML_OPTIONS: sanitizeHtml.IOptions = {
  allowedTags: [
    "a", "b", "blockquote", "br", "code", "em", "h1", "h2", "h3", "h4", "hr", "i",
    "li", "ol", "p", "pre", "strong", "ul",
  ],
  allowedAttributes: { a: ["href"] },
  allowedSchemes: ["https"],
  allowedSchemesByTag: { a: ["https"] },
  allowProtocolRelative: false,
  disallowedTagsMode: "discard",
};

/** 发布说明不会很长；超长输入截断，避免异常数据拖慢设置页。 */
const MAX_RELEASE_NOTES_LENGTH = 100_000;

/**
 * 只有以块级 HTML 标签开头时才按 HTML 处理（GitHub 渲染结果总是以 h1 / p / ul 等开头）。
 * 不能按「含有任意标签」判断：Markdown 代码片段里的 `<webview>` 之类会被误判成 HTML，
 * 跳过 Markdown 转换后又被白名单删掉，导致文字丢失。
 */
const LEADING_BLOCK_HTML = /^<(?:h[1-6]|p|ul|ol|li|blockquote|pre|hr|div|table|details|section|article)\b[^>]*>/i;

export function releaseNotesToSafeHtml(notes: string): string | null {
  const source = notes.slice(0, MAX_RELEASE_NOTES_LENGTH).trim();
  if (!source) return null;
  const html = LEADING_BLOCK_HTML.test(source) ? source : marked.parse(source, { async: false, gfm: true, breaks: true });
  const safe = sanitizeHtml(html, RELEASE_NOTES_HTML_OPTIONS).trim();
  return safe || null;
}
