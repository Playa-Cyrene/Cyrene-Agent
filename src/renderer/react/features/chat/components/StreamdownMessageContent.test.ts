import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("@ant-design/x", async () => {
  const ReactModule = await import("react");
  return {
    Bubble: { List: () => null },
    CodeHighlighter: ({ children }: { children?: React.ReactNode }) =>
      ReactModule.createElement("code", { "data-code-stub": "1" }, children),
    Think: () => null,
    ThoughtChain: () => null,
  };
});
vi.mock("../../../../../shared/renderer-base", () => ({ resolveAsset: (path: string) => path }));
vi.mock("./StreamdownMessageContent.css", () => ({}));
vi.mock("./MermaidBlock", () => ({
  MermaidBlock: ({ streaming }: { streaming?: boolean }) => React.createElement("div", { className: streaming ? "cy-mermaid--pending" : "cy-mermaid" }),
}));
vi.mock("./SvgCardBlock", () => ({
  SvgCardBlock: () => React.createElement("div", { className: "cy-svg-card" }),
}));

import { FileLinkContext, MessageStreamingContext } from "./ChatMessageList";
import { StreamdownMessageContent } from "./StreamdownMessageContent";

function render(content: string, streaming: boolean, workspaceRoot?: string): string {
  return renderToStaticMarkup(
    React.createElement(
      FileLinkContext.Provider,
      { value: { workspaceRoot, openFile: () => {} } },
      React.createElement(
        MessageStreamingContext.Provider,
        { value: streaming },
        React.createElement(StreamdownMessageContent, { content, streaming }),
      ),
    ),
  );
}

describe("StreamdownMessageContent", () => {
  it("keeps chat tables free of copy, download, and fullscreen controls", () => {
    const markup = render("| 报文 | 验证 |\n| --- | --- |\n| SYN | 客户端可发 |", false);

    expect(markup).not.toContain("<button");
  });

  it("emits the unprefixed utilities generated from the Streamdown source scan", () => {
    const markup = render("一段正文", false);

    expect(markup).toContain("space-y-4");
    expect(markup).not.toContain("sd:space-y-4");
  });

  it("renders inline and display mathematics with KaTeX", () => {
    const markup = render("行内 $E=mc^2$ 与块级：\n\n$$a^2+b^2=c^2$$", true);

    expect(markup).toContain("katex");
    expect(markup).toMatch(/<p><span class="katex">/);
  });

  it("keeps whole-document parsing for completed messages without math", () => {
    const markup = render("[引用][ref]\n\n[ref]: https://example.com", false);

    expect(markup).toContain('href="https://example.com/"');
  });

  it("keeps completed math messages in block mode instead of rebuilding the full KaTeX tree", () => {
    const markup = render("$E=mc^2$\n\n[引用][ref]\n\n[ref]: https://example.com", false);

    expect(markup).toContain("katex");
    expect(markup).not.toContain('href="https://example.com/"');
  });

  it("does not treat escaped dollars or code examples as rendered math", () => {
    const escaped = render("价格是 \\$5\n\n[引用][ref]\n\n[ref]: https://example.com", false);
    const inlineCode = render("`$HOME`\n\n[引用][ref]\n\n[ref]: https://example.com", false);
    const fencedCode = render("```sh\necho $HOME\n```\n\n[引用][ref]\n\n[ref]: https://example.com", false);

    expect(escaped).toContain('href="https://example.com/"');
    expect(inlineCode).toContain('href="https://example.com/"');
    expect(fencedCode).toContain('href="https://example.com/"');
  });

  it("preserves checked and unchecked GFM task states", () => {
    const markup = render("- [x] 已完成\n- [ ] 待完成", false);

    expect(markup).toMatch(/type="checkbox"[^>]*checked/);
    expect(markup.match(/type="checkbox"/g)).toHaveLength(2);
  });

  it("keeps incomplete code fences renderable during streaming", () => {
    const markup = render("~~~ts\nconst n = 1;", true);

    expect(markup).toContain("data-code-stub");
    expect(markup).toContain("const n = 1;");
  });

  it("keeps Mermaid pending while streaming", () => {
    const markup = render("~~~mermaid\ngraph TD\nA-->B", true);

    expect(markup).toContain("cy-mermaid--pending");
  });

  it("renders a workspace file link as the existing file chip", () => {
    const markup = render("[文件](file:///E:/ws/src/a.ts#L12)", false, "E:/ws");

    expect(markup).toContain("cy-file-link");
    expect(markup).not.toContain("is-plain");
  });

  it("strips dangerous links and raw script markup", () => {
    const markup = render("[危险](javascript:alert(1))\n\n<script>alert(1)</script>", false);

    expect(markup).not.toMatch(/href="javascript:/i);
    expect(markup).not.toContain("<script");
  });
});
