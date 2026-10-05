import sanitizeHtml from "sanitize-html";
import { marked } from "marked";

const EMAIL_HTML_OPTIONS: sanitizeHtml.IOptions = {
  allowedTags: [
    "a", "b", "blockquote", "br", "code", "del", "div", "em", "h1", "h2", "h3", "h4", "h5", "h6",
    "hr", "i", "li", "ol", "p", "pre", "s", "strong", "sub", "sup", "table", "tbody", "td", "th",
    "thead", "tr", "u", "ul",
  ],
  allowedAttributes: { a: ["href", "name"] },
  allowedSchemes: ["http", "https", "mailto"],
  allowedSchemesByTag: { a: ["http", "https", "mailto"] },
  allowProtocolRelative: false,
  disallowedTagsMode: "discard",
};

export function sanitizeEmailHtml(html: string): string {
  return sanitizeHtml(html, EMAIL_HTML_OPTIONS);
}

export async function markdownToEmailHtml(markdown: string): Promise<string> {
  const source = markdown.slice(0, 200_000);
  const rendered = await marked.parse(source, { async: false, gfm: true });
  return sanitizeEmailHtml(rendered);
}

export function htmlToPlainText(html: string): string {
  const withBreaks = sanitizeEmailHtml(html).replace(/<\/(?:p|div|li|h[1-6]|blockquote|tr)>/gi, "\n").replace(/<br\s*\/?>/gi, "\n");
  return sanitizeHtml(withBreaks, {
    allowedTags: [],
    allowedAttributes: {},
    allowedSchemes: [],
    allowProtocolRelative: false,
  }).replace(/\u00a0/g, " ").trim();
}
