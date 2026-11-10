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
// svg 资产 import 在 node 测试环境不可加载，mock 掉只测正文渲染逻辑
vi.mock("./file-icon-assets", () => ({
  FILE_ICON_URLS: { default: "default-url" },
  FILE_NAME_MAP: {},
  FILE_EXT_MAP: {},
}));
vi.mock("./MermaidBlock", () => ({
  MermaidBlock: ({ streaming }: { streaming?: boolean }) => React.createElement("div", { className: streaming ? "cy-mermaid--pending" : "cy-mermaid" }),
}));
vi.mock("./SvgCardBlock", () => ({
  SvgCardBlock: () => React.createElement("div", { className: "cy-svg-card" }),
}));

import { MessageStreamingContext } from "./ChatMessageList";
import { FileLinkContext } from "./FileLinkContext";
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

function texAnnotations(markup: string): string[] {
  return [...markup.matchAll(/<annotation encoding="application\/x-tex">([\s\S]*?)<\/annotation>/g)]
    .map((match) => match[1].replaceAll("&gt;", ">").replaceAll("&lt;", "<").replaceAll("&amp;", "&"));
}

describe("StreamdownMessageContent", () => {

  it.each([false, true])("keeps multiline inline math out of flow fences (streaming=%s)", (streaming) => {
    const markup = render("\\(x\n+y\\) 价格 $5\n\n后文", streaming);
    expect(texAnnotations(markup)).toEqual(["x\n+y"]);
    expect(markup).toContain(" 价格 $5</p>");
    expect(markup).toContain("<p>后文</p>");
    expect(markup).not.toContain('class="katex-display"');
    expect(markup).not.toContain('class="katex-error"');
  });

  it.each([false, true])("preserves formatting around display math (streaming=%s)", (streaming) => {
    for (const [marker, tag] of [["**", "strong"], ["*", "em"], ["~~", "del"]]) {
      const markup = render(`${marker}结果 \\[x=1\\] 完成${marker}\n\n后文`, streaming);
      expect(texAnnotations(markup)).toEqual(["x=1"]);
      expect(markup).toContain(tag === "strong" ? 'data-streamdown="strong">结果 ' : `<${tag}>结果 `);
      expect(markup).toContain(` 完成</${tag === "strong" ? "span" : tag}>`);
      expect(markup).toContain('class="katex-display"');
      expect(markup).toContain("<p>后文</p>");
    }
  });

  it.each([false, true])("preserves trailing TeX control spaces (streaming=%s)", (streaming) => {
    for (const [open, close] of [["\\[", "\\]"], ["\\(", "\\)"]]) {
      const markup = render(`${open}x\\ ${close}\n\n后文`, streaming);
      expect(texAnnotations(markup)).toEqual(["x\\ "]);
      expect(markup).not.toContain('class="katex-error"');
      expect(markup).toContain("<p>后文</p>");
    }
  });
  it.each([false, true])("isolates backslash formulas from currency and adjacent math (streaming=%s)", (streaming) => {
    const currency = render(String.raw`价格 $5，税率 \(r=0.2\)。`, streaming);
    expect(texAnnotations(currency)).toEqual(["r=0.2"]);
    expect(currency).toContain("<p>价格 $5，税率 ");
    expect(currency).not.toContain("<!-- -->");
    expect(texAnnotations(render(String.raw`\(a\)\(b\)\(c\)`, streaming))).toEqual(["a", "b", "c"]);
    expect(texAnnotations(render(String.raw`$existing$\(a\)\(b\)$$other$$，价格 $5`, streaming)))
      .toEqual(["existing", "a", "b", "other"]);
  });

  it.each([false, true])("preserves exact inline TeX at dollar boundaries (streaming=%s)", (streaming) => {
    for (const [content, expected] of [
      [String.raw`\(a\)$`, ["a"]],
      [String.raw`$\(a\)`, ["a"]],
      [String.raw`\(a\)$existing$`, ["a", "existing"]],
      [String.raw`价格 \$5，\(a\)\(\text{cost }\$5\)`, ["a", String.raw`\text{cost }\$5`]],
      [String.raw`价格 $5，\(a\)\[b\]`, ["a", "b"]],
      [String.raw`# \(a\)\(b\)`, ["a", "b"]],
      ["| 公式 |\n| --- |\n| \\(a\\)\\(b\\) |", ["a", "b"]],
      ["> \\(x\n>y\\)", ["x\ny"]],
      ["- > \\(x\n  >y\\)", ["x\ny"]],
    ] as const) {
      expect(texAnnotations(render(content, streaming)), content).toEqual(expected);
    }
  });

  it.each([false, true])("removes actual quote prefixes without changing TeX (streaming=%s)", (streaming) => {
    for (const content of [
      "> \\[\n>x+1\n> \\]",
      ">> \\[\n> > x+1\n>>\\]",
      "- > \\[\n  >x+1\n  > \\]",
      "> - > \\[\n>   >x+1\n>   > \\]",
      "> \\[\nx+1\n>\\]",
      "1. > \\[\n   >x+1\n   > \\]",
      "> \\[\r\n>x+1\r\n> \\]",
    ]) {
      expect(texAnnotations(render(content, streaming)), content).toEqual(["x+1"]);
    }
    expect(texAnnotations(render("> \\[\n>x>0\n> \\]", streaming))).toEqual(["x>0"]);
    const aligned = String.raw`\begin{aligned}x&=1\\y&=2\end{aligned}`;
    expect(texAnnotations(render("> \\[\n>" + aligned + "\n> \\]", streaming))).toEqual([aligned]);
  });


  it.each([false, true])("keeps display math in task items without losing checkbox state (streaming=%s)", (streaming) => {
    const markup = render("- [x] \\[x\\]\n- [ ] \\[y\\] tail", streaming);
    expect(texAnnotations(markup)).toEqual(["x", "y"]);
    expect(markup.match(/type="checkbox"/g)).toHaveLength(2);
    expect(markup).toMatch(/type="checkbox"[^>]*checked/);
    expect(markup.match(/class="katex-display"/g)).toHaveLength(2);
    expect(markup).toContain(" tail");
  });

  it("keeps regular links and images after a complete display formula while streaming", () => {
    const markup = render(String.raw`\[x\] [site](https://example.com) ![alt](https://example.com/a.png)`, true);
    expect(texAnnotations(markup)).toEqual(["x"]);
    expect(markup).toContain("https://example.com");
    expect(markup).toContain('alt="alt"');
    expect(markup).toContain('src="https://example.com/a.png"');
  });

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

  it.each([false, true])("renders GPT backslash delimiters with their math semantics (streaming=%s)", (streaming) => {
    const markup = render(String.raw`高度 \(h=\dfrac{5b}{12}\)。结果 \[\boxed{B=(25,y-55)}.\]`, streaming);

    expect(markup.match(/class="katex"/g)).toHaveLength(2);
    expect(markup.match(/class="katex-display"/g)).toHaveLength(1);
    expect(markup).toContain(String.raw`h=\dfrac{5b}{12}`);
    expect(markup).not.toContain("(h=");
  });

  it.each([false, true])("renders multiline display math inside nested containers (streaming=%s)", (streaming) => {
    const markup = render("> 1. before \\[\n>    x^2 + y^2 = z^2\n>    \\] after\n>\n>    - inline \\(a+b\\)", streaming);
    expect(markup.match(/class="katex"/g)).toHaveLength(2);
    expect(markup.match(/class="katex-display"/g)).toHaveLength(1);
    expect(markup).toContain("<blockquote");
    expect(markup).toContain("<ol");
    expect(markup).toContain("before");
    expect(markup).toContain("after");
    expect(markup).toContain('encoding="application/x-tex">x^2 + y^2 = z^2</annotation>');
  });

  it.each([false, true])("does not turn protected backslash examples into mathematics (streaming=%s)", (streaming) => {
    const markup = render("`\\(example\\)`\n\n> ~~~text\n> \\[example\\]\n> ~~~\n\n    \\(example\\)\n\n\\\\(escaped\\\\)\n\n[link](https://example.com/\\(path\\))", streaming);
    expect(markup).not.toContain('class="katex"');
    expect(markup).toContain("example");
    expect(markup).toContain("https://example.com/");
  });

  it("keeps existing dollar formulas and backslash formulas in the same message", () => {
    const markup = render(String.raw`$a$ and \(b\)` + "\n\n$$\nc\n$$\n\n\\[d\\]", false);
    expect(markup.match(/class="katex"/g)).toHaveLength(4);
    expect(markup.match(/class="katex-display"/g)).toHaveLength(2);
  });

  it("keeps inline math in GFM table cells", () => {
    const markup = render("| 公式 |\n| --- |\n| \\(x+1\\) |", false);
    expect(markup).toContain('class="katex"');
    expect(markup).toContain("<td");
  });

  it.each([
    "> - > \\[x\\]",
    "- [ ] result \\[x\\]",
    "1. first\n\n   second \\[x\\] tail",
    "\\[\r\nx+y\r\n\\]",
    String.raw`\(a*b*c\)`,
    String.raw`\(x` + "\n" + String.raw`+y\)`,
    String.raw`\(\text{price }\$5\)`,
  ])("renders math in additional Markdown containers: %s", (content) => {
    const markup = render(content, false);
    expect(markup).toContain('class="katex"');
    expect(markup).not.toContain('class="katex-error"');
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

  it("renders a network file link as plain text without opening its placeholder URL", () => {
    const markup = render("[共享文件](file:///%5Chost/share/file.txt)", false, "E:/ws");
    expect(markup).toContain("共享文件");
    expect(markup).not.toContain("cyrene.invalid");
    expect(markup).not.toContain("cy-file-link");
  });

  it("strips dangerous links and raw script markup", () => {
    const markup = render("[危险](javascript:alert(1))\n\n<script>alert(1)</script>", false);

    expect(markup).not.toMatch(/href="javascript:/i);
    expect(markup).not.toContain("<script");
  });
});
