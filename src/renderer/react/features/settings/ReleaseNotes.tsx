import { useMemo, type MouseEvent } from "react";
import DOMPurify from "dompurify";
import { RELEASE_NOTES_ALLOWED_TAGS } from "../../../../shared/release-notes-html";

/**
 * 更新说明（主进程已按白名单净化成 HTML）。渲染前再净化一次作为纵深防御；
 * 链接一律交给系统浏览器打开，不能让设置窗口自身跳转离开应用页面。
 */
export function ReleaseNotes({ html, label }: { html: string; label: string }) {
  const safeHtml = useMemo(() => DOMPurify.sanitize(html, {
    ALLOWED_TAGS: [...RELEASE_NOTES_ALLOWED_TAGS],
    ALLOWED_ATTR: ["href"],
    ALLOWED_URI_REGEXP: /^https:/i,
    // DOMPurify 默认放行 data-* / aria-*；设置页搜索靠 data-settings-search-id 定位，不能让外部内容带上
    ALLOW_DATA_ATTR: false,
    ALLOW_ARIA_ATTR: false,
  }), [html]);

  function openLink(event: MouseEvent<HTMLDivElement>) {
    // auxclick 也包含右键（button 2）：只处理中键，右键菜单不打开链接
    if (event.type === "auxclick" && event.button !== 1) return;
    const link = (event.target as HTMLElement).closest("a");
    if (!link || !event.currentTarget.contains(link)) return;
    event.preventDefault();
    const href = link.getAttribute("href") ?? "";
    if (/^https:\/\//i.test(href)) void window.system?.openExternal(href);
  }

  return (
    <div
      className="cy-settings-release-notes"
      data-testid="settings-release-notes"
      role="region"
      aria-label={label}
      tabIndex={0}
      onClick={openLink}
      onAuxClick={openLink}
      dangerouslySetInnerHTML={{ __html: safeHtml }}
    />
  );
}
