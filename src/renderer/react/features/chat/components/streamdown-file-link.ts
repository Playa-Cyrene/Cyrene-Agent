import type { Plugin } from "unified";

const PLACEHOLDER_PREFIX = "https://cyrene.invalid/__file-link__/";
const BASE64_URL = /^[A-Za-z0-9_-]+$/;

type HastNode = {
  type?: string;
  tagName?: string;
  properties?: Record<string, unknown>;
  children?: HastNode[];
};

function toBase64Url(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function fromBase64Url(value: string): string | null {
  if (!BASE64_URL.test(value)) return null;
  const padded = value.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
  try {
    const binary = atob(padded);
    const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

export function encodeStreamdownFileHref(href: string): string {
  return href.startsWith("file:///") ? `${PLACEHOLDER_PREFIX}${toBase64Url(href)}` : href;
}

export function decodeStreamdownFileHref(href: string): string | null {
  if (!href.startsWith(PLACEHOLDER_PREFIX)) return null;
  const decoded = fromBase64Url(href.slice(PLACEHOLDER_PREFIX.length));
  return decoded?.startsWith("file:///") ? decoded : null;
}

function visitElementNodes(node: HastNode, visit: (element: HastNode) => void): void {
  if (node.type === "element") visit(node);
  node.children?.forEach((child) => visitElementNodes(child, visit));
}

/**
 * Runs between Streamdown's raw parser and its sanitizer. Workspace links are
 * made HTTPS before the default sanitizer and hardener see them; custom anchor
 * rendering decodes them again and still performs the workspace-boundary test.
 */
export const encodeStreamdownFileLinksInHast: Plugin = () => (tree: HastNode) => {
  visitElementNodes(tree, (node) => {
    const href = node.tagName === "a" ? node.properties?.href : undefined;
    if (typeof href === "string") node.properties!.href = encodeStreamdownFileHref(href);
  });
};
