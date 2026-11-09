/**
 * SVG 消毒与熔断 —— Mermaid 引擎产物和手写 SVG 围栏共用。
 *
 * 四层防护：
 * 1. 长度熔断：源码超过上限直接降级，不进同步渲染（防 UI 线程卡死）
 * 2. 字体外呼剥离：删掉引擎硬编码注入的 Google Fonts @import（隐私 + 离线可用）
 * 3. DOMPurify 消毒：剥 script / 事件属性 / javascript: 协议 / foreignObject 逃逸
 * 4. 调用方兜底：消毒后仍为空则按渲染失败降级
 */

import DOMPurify from "dompurify";

const SVG_NAMESPACE = "http://www.w3.org/2000/svg";

/** 源码长度熔断阈值（字符数）：千节点级流程图源码约 23KB / 渲染 265ms，再大就该降级 */
export const SVG_SOURCE_LIMIT = 20000;

/** 手写 SVG 围栏的熔断阈值：每个节点都是显式标签，比 Mermaid 源码更冗长，放宽到 3 倍 */
export const HANDWRITTEN_SVG_SOURCE_LIMIT = 60000;

/** 判断源码是否超过熔断阈值 */
export function isOverSourceLimit(source: string): boolean {
  return source.length > SVG_SOURCE_LIMIT;
}

/** 判断手写 SVG 是否超过熔断阈值 */
export function isOverHandwrittenSvgLimit(source: string): boolean {
  return source.length > HANDWRITTEN_SVG_SOURCE_LIMIT;
}

/**
 * 剥离 <style> 块里的外部字体 @import。
 * beautiful-mermaid 会无条件注入 Google Fonts 导入，渲染端不该为一张图外呼网络。
 */
export function stripFontImports(svg: string): string {
  return svg.replace(/@import\s+url\([^)]*fonts\.googleapis\.com[^)]*\);?/g, "");
}

/**
 * DOMPurify 消毒 SVG 字符串。
 * 返回空字符串说明内容被清空，调用方按渲染失败处理。
 */
export function sanitizeSvg(svg: string): string {
  const fragment = DOMPurify.sanitize(svg, {
    // 模型产出的图可能用到 foreignObject 内容，但那正是逃逸向量，直接整体禁掉
    FORBID_TAGS: ["script", "foreignObject", "iframe", "embed", "object", "link"],
    FORBID_ATTR: ["src", "href", "xlink:href"],
    RETURN_DOM_FRAGMENT: true,
  });
  const root = fragment.firstElementChild;
  if (root?.localName !== "svg" || root.namespaceURI !== SVG_NAMESPACE || fragment.childElementCount !== 1
    || Array.from(fragment.childNodes).some((node) => node.nodeType === Node.TEXT_NODE && node.textContent?.trim())) {
    return "";
  }
  // viewBox-only SVGs need intrinsic dimensions to zoom past the default image size.
  if (!root.hasAttribute("width") && !root.hasAttribute("height")) {
    const [, , width, height] = (root.getAttribute("viewBox") ?? "").trim().split(/[\s,]+/).map(Number);
    if (Number.isFinite(width) && Number.isFinite(height) && width > 0 && height > 0) {
      root.setAttribute("width", String(width));
      root.setAttribute("height", String(height));
    }
  }
  return new XMLSerializer().serializeToString(root);
}

/** The SVG is only ever displayed as a non-interactive image. */
export function svgImageSrc(svg: string): string {
  // JSON can contain unpaired surrogates. Preserve valid Unicode pairs and keep render from throwing.
  return `data:image/svg+xml,${encodeURIComponent(svg.replace(/[\uD800-\uDFFF]/gu, "\uFFFD"))}`;
}
