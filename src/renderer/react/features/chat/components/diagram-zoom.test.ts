// @vitest-environment jsdom
/**
 * 图卡片点击放大交互测试：SSR 静态渲染验证 zoomable 标记与 Modal 挂载结构。
 * useTranslation 需要 Provider，这里 mock 掉避免拉起完整 i18n。
 */

import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("../../../i18n", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

import { MermaidBlock } from "./MermaidBlock";
import { SvgCardBlock } from "./SvgCardBlock";

const MERMAID_CODE = ["graph TD", "A[开始] --> B[结束]"].join("\n");
const SVG_CODE = [
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 720 120">',
  '<rect x="0" y="0" width="720" height="120" rx="12" fill="#FFFBFC"/>',
  '<text x="40" y="60" font-size="16" fill="#1D1D1F">卡片</text>',
  "</svg>",
].join("\n");

describe("图卡片点击放大", () => {
  it("Mermaid 卡片带 zoomable 标记与放大提示，hover 有交互线索", () => {
    (globalThis as typeof globalThis & { React: typeof React }).React = React;
    const html = renderToStaticMarkup(
      React.createElement(MermaidBlock, { code: MERMAID_CODE }),
    );
    expect(html).toContain("cy-mermaid--zoomable");
    expect(html).toContain("messageList.diagramZoomHint");
    expect(html).toContain('src="data:image/svg+xml,');
    expect(html).not.toContain("<svg");
  });

  it("SVG 学习卡片同样带 zoomable 标记", () => {
    (globalThis as typeof globalThis & { React: typeof React }).React = React;
    const html = renderToStaticMarkup(
      React.createElement(SvgCardBlock, { code: SVG_CODE }),
    );
    expect(html).toContain("cy-svg-card--zoomable");
    expect(html).toContain("messageList.diagramZoomHint");
    expect(html).toContain('src="data:image/svg+xml,');
    expect(html).not.toContain("<svg");
  });

  it("流式期间不渲染图与放大交互（占位态）", () => {
    (globalThis as typeof globalThis & { React: typeof React }).React = React;
    const html = renderToStaticMarkup(
      React.createElement(MermaidBlock, { code: MERMAID_CODE, streaming: true }),
    );
    expect(html).toContain("cy-mermaid--pending");
    expect(html).not.toContain("cy-mermaid--zoomable");
    expect(html).not.toContain("<svg");
  });
});
