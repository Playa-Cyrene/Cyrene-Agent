/**
 * 更新说明允许保留的 HTML 标签。主进程净化与设置页二次净化共用这一份，避免两边不一致。
 * 属性只放行链接的 href，链接只放行 https。
 */
export const RELEASE_NOTES_ALLOWED_TAGS: readonly string[] = [
  "a", "b", "blockquote", "br", "code", "del", "details", "em",
  "h1", "h2", "h3", "h4", "h5", "h6", "hr", "i", "li", "ol", "p", "pre", "strong", "summary",
  "table", "tbody", "td", "th", "thead", "tr", "ul",
];
