// @vitest-environment jsdom
/**
 * 手写 SVG 学习卡片渲染管线测试：与 Mermaid 共用同一组恶意输入样本，
 * 另覆盖手写特有的降级路径（碎片无 svg 根、60KB 熔断阈值）。
 */

import { describe, expect, it } from "vitest";
import { renderSvgCardSafe } from "./SvgCardBlock";
import { HANDWRITTEN_SVG_SOURCE_LIMIT, svgImageSrc } from "./svg-sanitize";

/** 与 svg-sanitize.test.ts 同源的恶意样本：script 注入 / 事件属性 / javascript: 协议 / foreignObject 逃逸 */
const MALICIOUS_SAMPLES = [
  '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script><rect width="10" height="10"/></svg>',
  '<svg xmlns="http://www.w3.org/2000/svg" onload="alert(2)"><rect width="10" height="10" onclick="alert(3)"/></svg>',
  '<svg xmlns="http://www.w3.org/2000/svg"><a href="javascript:alert(4)"><text>x</text></a></svg>',
  '<svg xmlns="http://www.w3.org/2000/svg"><foreignObject><div xmlns="http://www.w3.org/1999/xhtml"><script>alert(5)</script></div></foreignObject></svg>',
];

const BENIGN_CARD = [
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 720 220">',
  '<rect x="0" y="0" width="720" height="220" rx="12" fill="#FFFBFC" stroke="#F2F2F2"/>',
  '<rect x="24" y="24" width="200" height="80" rx="8" fill="#FFF1F6"/>',
  '<text x="40" y="70" font-size="16" fill="#1D1D1F">材料概览</text>',
  '<rect x="260" y="24" width="200" height="80" rx="8" fill="#FFF1F6"/>',
  '<text x="276" y="70" font-size="16" fill="#FF5B8A">章节依赖</text>',
  '<rect x="496" y="24" width="200" height="80" rx="8" fill="#FFF1F6"/>',
  '<text x="512" y="70" font-size="16" fill="#8E8E93">建议起点</text>',
  "</svg>",
].join("\n");

describe("renderSvgCardSafe", () => {
  it("renders image sources with malformed UTF-16 without breaking valid Unicode", () => {
    const src = svgImageSrc("<svg><text>🌸\uD800</text></svg>");
    expect(decodeURIComponent(src)).toContain("🌸\uFFFD");
  });

  it("rejects markup alongside a valid SVG, including host styles and forms", () => {
    const svg = '<svg><text>x</text></svg>';
    expect(renderSvgCardSafe(`${svg}<style>body { display:none }</style>`).kind).toBe("error");
    expect(renderSvgCardSafe(`${svg}<form action="https://example.test"><input name="secret"></form>`).kind).toBe("error");
  });

  it("adds the SVG namespace and intrinsic size to a viewBox-only card", () => {
    const out = renderSvgCardSafe('<svg viewBox="0 0 720 120"><text>卡片</text></svg>');
    expect(out.kind).toBe("svg");
    if (out.kind !== "svg") return;
    const root = new DOMParser().parseFromString(out.svg, "image/svg+xml").documentElement;
    expect(root.namespaceURI).toBe("http://www.w3.org/2000/svg");
    expect(root.getAttribute("width")).toBe("720");
    expect(root.getAttribute("height")).toBe("120");
  });

  it.each([
    'width="100%"',
    'height="50%"',
    'width="100%" height="100%"',
    'width="calc(100% - 1px)" height="100%"',
    'style="width:100%;height:100%;--ink:black"',
    'style="width:400px;height:200px"',
  ])("gives an SVG card with no intrinsic dimensions its viewBox size (%s)", (size) => {
    const out = renderSvgCardSafe(`<svg viewBox="0 0 800 400" ${size}><text>卡片</text></svg>`);
    if (out.kind !== "svg") throw new Error("Expected a rendered SVG card");
    const root = new DOMParser().parseFromString(out.svg, "image/svg+xml").documentElement;
    expect(root.getAttribute("width")).toBe("800");
    expect(root.getAttribute("height")).toBe("400");
    if (size.startsWith("style")) expect(root.getAttribute("style")).toBe(size.slice(7, -1));
  });

  it.each(['height="100%"', 'height="100%" style="width:auto;height:100%"'])(
    "preserves an authored intrinsic width alongside a relative height (%s)", (size) => {
      const out = renderSvgCardSafe(`<svg viewBox="0 0 800 400" width="400" ${size}><text>卡片</text></svg>`);
      if (out.kind !== "svg") throw new Error("Expected a rendered SVG card");
      const root = new DOMParser().parseFromString(out.svg, "image/svg+xml").documentElement;
      expect(root.getAttribute("width")).toBe("400");
      expect(root.getAttribute("height")).toBe("100%");
    },
  );

  it("同一组恶意样本全部拦截（剥掉逃逸向量后仍可出图或降级，绝不带毒注入）", () => {
    for (const sample of MALICIOUS_SAMPLES) {
      const out = renderSvgCardSafe(sample);
      if (out.kind === "svg") {
        expect(out.svg).not.toMatch(/<script/i);
        expect(out.svg).not.toMatch(/\son[a-z]+\s*=/i);
        expect(out.svg).not.toMatch(/javascript\s*:/i);
        expect(out.svg.toLowerCase()).not.toContain("foreignobject");
      } else {
        // 降级路径同样安全
        expect(["fuse", "error"]).toContain(out.kind);
      }
    }
  });

  it("正常学习卡片原样保留（粉白主题、三栏结构、viewBox）", () => {
    const out = renderSvgCardSafe(BENIGN_CARD);
    expect(out.kind).toBe("svg");
    if (out.kind !== "svg") return;
    expect(out.svg).toContain("材料概览");
    expect(out.svg).toContain("#FF5B8A");
    expect(out.svg).toContain("viewBox");
  });

  it("非 svg 根的碎片内容降级为 error", () => {
    expect(renderSvgCardSafe("<div>这不是 SVG</div>").kind).toBe("error");
    expect(renderSvgCardSafe("<rect width=\"10\" height=\"10\"/>").kind).toBe("error");
  });

  it("超过手写阈值（60KB）直接熔断降级", () => {
    const huge = '<svg xmlns="http://www.w3.org/2000/svg">' + "x".repeat(HANDWRITTEN_SVG_SOURCE_LIMIT) + "</svg>";
    expect(renderSvgCardSafe(huge).kind).toBe("fuse");
  });

  it("手写阈值比 Mermaid 宽：20-60KB 之间的 SVG 正常渲染", () => {
    const mid = '<svg xmlns="http://www.w3.org/2000/svg">' + "x".repeat(30000) + "</svg>";
    expect(renderSvgCardSafe(mid).kind).toBe("svg");
  });

  it("外呼字体 @import 被剥掉", () => {
    const svg = '<svg xmlns="http://www.w3.org/2000/svg"><style>@import url(\'https://fonts.googleapis.com/css2?family=Inter\');</style><text>x</text></svg>';
    const out = renderSvgCardSafe(svg);
    expect(out.kind).toBe("svg");
    if (out.kind === "svg") {
      expect(out.svg).not.toContain("fonts.googleapis.com");
    }
  });
});
