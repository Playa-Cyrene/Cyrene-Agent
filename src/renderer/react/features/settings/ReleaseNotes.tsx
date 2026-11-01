import { useMemo, type MouseEvent } from "react";
import DOMPurify from "dompurify";

const ALLOWED_TAGS = ["a", "b", "blockquote", "br", "code", "em", "h1", "h2", "h3", "h4", "hr", "i", "li", "ol", "p", "pre", "strong", "ul"];

/**
 * 更新说明（主进程已按白名单净化成 HTML）。渲染前再净化一次作为纵深防御；
 * 链接一律交给系统浏览器打开，不能让设置窗口自身跳转离开应用页面。
 */
export function ReleaseNotes({ html }: { html: string }) {
  const safeHtml = useMemo(() => DOMPurify.sanitize(html, {
    ALLOWED_TAGS,
    ALLOWED_ATTR: ["href"],
    ALLOWED_URI_REGEXP: /^https:/i,
  }), [html]);

  function onClick(event: MouseEvent<HTMLDivElement>) {
    const link = (event.target as HTMLElement).closest("a");
    if (!link) return;
    event.preventDefault();
    const href = link.getAttribute("href") ?? "";
    if (/^https:\/\//i.test(href)) void window.system?.openExternal(href);
  }

  return (
    <div
      className="cy-settings-release-notes"
      data-testid="settings-release-notes"
      onClick={onClick}
      dangerouslySetInnerHTML={{ __html: safeHtml }}
    />
  );
}
