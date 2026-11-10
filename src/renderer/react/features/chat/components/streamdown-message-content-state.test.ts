// @vitest-environment jsdom
import * as React from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@ant-design/x", async () => {
  const ReactModule = await import("react");
  return {
    Bubble: { List: () => null },
    CodeHighlighter: ({ children }: { children?: React.ReactNode }) => ReactModule.createElement("code", null, children),
    Think: () => null,
    ThoughtChain: () => null,
  };
});
vi.mock("../../../../../shared/renderer-base", () => ({ resolveAsset: (path: string) => path }));
vi.mock("./StreamdownMessageContent.css", () => ({}));
// svg 资产 import 在 node 测试环境不可加载，mock 掉图标资产表
vi.mock("./file-icon-assets", () => ({
  FILE_ICON_URLS: { default: "default-url" },
  FILE_NAME_MAP: {},
  FILE_EXT_MAP: {},
}));
vi.mock("./MermaidBlock", () => ({ MermaidBlock: () => React.createElement("div", null, "diagram") }));
vi.mock("./SvgCardBlock", () => ({ SvgCardBlock: () => React.createElement("div", null, "svg") }));

import { MarkdownContent } from "./ChatMessageList";
import * as streamdownMath from "./streamdown-math";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

function update(content: string, streaming: boolean) {
  act(() => {
    root.render(React.createElement(MarkdownContent, { content, streaming }));
  });
}

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe("MarkdownContent Streamdown lifecycle", () => {

  it.each([
    String.raw`\(a \(b\) + \(c\)\)`,
    String.raw`\[a \[b\] + \[c\]\]`,
    String.raw`\(a \[b\] + \(c\)\)`,
    String.raw`\[a \(b\) + \[c\]\]`,
    String.raw`\(a \[b\] + \[c\]`,
  ])("never renders a partial nested group while streaming: %s", (nested) => {
    const first = String.raw`\(p\)`;
    const last = String.raw`\(q\)`;
    const content = first + "\n\n" + nested + "\n\n" + last + "\n\n后文";
    const lastClosedAt = content.indexOf(last) + last.length;
    for (let index = 0; index <= content.length; index += 1) {
      update(content.slice(0, index), true);
      const expected = index < first.length ? [] : index < lastClosedAt ? ["p"] : ["p", "q"];
      expect([...container.querySelectorAll("annotation")].map((node) => node.textContent)).toEqual(expected);
    }
    expect(container.querySelector("p:last-child")?.textContent).toBe("后文");
    const nodes = [...container.querySelectorAll(".katex")];
    update(content, false);
    nodes.forEach((node, index) => expect(container.querySelectorAll(".katex")[index]).toBe(node));
    expect([...container.querySelectorAll("annotation")].map((node) => node.textContent)).toEqual(["p", "q"]);
    expect(container.querySelector("p:last-child")?.textContent).toBe("后文");
  });


  it("keeps ordinary message completion stable without math-range analysis", () => {
    const detect = vi.spyOn(streamdownMath, "analyzeCompletedMarkdown");
    const ranges = vi.spyOn(streamdownMath, "getStreamingMathRanges");
    try {
      update("普通", true);
      update("普通正文", true);
      expect(detect).not.toHaveBeenCalled();
      expect(ranges).not.toHaveBeenCalled();
      update("普通正文", false);
      expect(detect).toHaveBeenCalledTimes(1);
      const paragraph = container.querySelector("p");
      expect(paragraph?.textContent).toBe("普通正文");
      update("普通正文", false);
      expect(detect).toHaveBeenCalledTimes(1);
      expect(container.querySelector("p")).toBe(paragraph);
      expect(ranges).not.toHaveBeenCalled();
    } finally {
      detect.mockRestore();
      ranges.mockRestore();
    }
  });

  it.each([String.raw`x\in [0,1)`, String.raw`f([a,b),\{x\})`])("protects real math ranges through every character prefix: %s", (tex) => {
    const formula = `\\(${tex}\\)`;
    const content = formula + " 完成\n\n后文";
    for (let index = 0; index <= content.length; index += 1) {
      update(content.slice(0, index), true);
      expect([...container.querySelectorAll("annotation")].map((node) => node.textContent))
        .toEqual(index < formula.length ? [] : [tex]);
      expect(container.querySelector(".katex-error")).toBeNull();
    }
    const math = container.querySelector(".katex");
    expect(math).not.toBeNull();
    update(content, false);
    expect(container.querySelector(".katex")).toBe(math);
    expect(container.querySelector("p:last-child")?.textContent).toBe("后文");
  });

  it.each(["```text\n\\[\n```", String.raw`<code>\[</code>`, String.raw`[文档](https://example.com/\[)`])("keeps later image completion through streaming with a pseudo opener: %s", (prefix) => {
    const start = prefix + "\n\n![示意](https://example.com/";
    const content = start + "image";
    for (let index = start.length; index <= content.length; index += 1) {
      update(content.slice(0, index), true);
      expect(container.querySelector('[data-streamdown="image-placeholder"]')).not.toBeNull();
    }
    update(content + ".png)", true);
    expect(container.querySelector('img[alt="示意"]')?.getAttribute("src")).toBe("https://example.com/image.png");
    update(content + ".png)", false);
    expect(container.querySelector('img[alt="示意"]')?.getAttribute("src")).toBe("https://example.com/image.png");
    expect(container.querySelector(".katex")).toBeNull();
  });

  it.each([String.raw`\(x\)`, "$x$"])("restores cross-block reference hrefs on completion: %s", (formula) => {
    for (const definitionFirst of [false, true]) {
      const parts = [formula, "[引用][ref]", "后文"];
      parts.splice(definitionFirst ? 0 : parts.length, 0, "[ref]: https://example.com");
      const content = parts.join("\n\n");
      for (let index = 0; index <= content.length; index += 1) update(content.slice(0, index), true);
      update(content, false);
      expect([...container.querySelectorAll("annotation")].map((node) => node.textContent)).toEqual(["x"]);
      expect(container.querySelector('a[href="https://example.com/"]')).not.toBeNull();
      expect(container.textContent).not.toContain("[引用][ref]");
      expect(container.textContent).toContain("后文");
    }
  });

  it("skips whole-document detection while streaming and detects once on completion without rebuilding math", () => {
    const detect = vi.spyOn(streamdownMath, "analyzeCompletedMarkdown");
    try {
      const content = String.raw`\(x\)` + "\n\n已冻结正文。\n\n后续流式文字。";
      for (let index = 0; index <= content.length; index += 1) update(content.slice(0, index), true);
      expect(detect).not.toHaveBeenCalled();
      expect([...container.querySelectorAll("annotation")].map((node) => node.textContent)).toEqual(["x"]);
      const math = container.querySelector(".katex");
      expect(math).not.toBeNull();
      update(content, false);
      expect(detect).toHaveBeenCalledTimes(1);
      expect(detect).toHaveBeenLastCalledWith(content);
      expect(container.querySelector(".katex")).toBe(math);
      expect(container.querySelector("p:last-child")?.textContent).toBe("后续流式文字。");
      update(content, false);
      expect(detect).toHaveBeenCalledTimes(1);
      expect(container.querySelector(".katex")).toBe(math);
      update(content + "追加", true);
      expect(detect).toHaveBeenCalledTimes(1);
      update(content + "追加", false);
      expect(detect).toHaveBeenCalledTimes(2);
      expect(detect).toHaveBeenLastCalledWith(content + "追加");
      expect(container.querySelector(".katex")).toBe(math);
    } finally {
      detect.mockRestore();
    }
  });

  it.each([
    ["inline", "aligned", String.raw`\begin{aligned}a&=b\\[4pt]c&=d\end{aligned}`],
    ["display", "aligned", String.raw`\begin{aligned}a&=b\\[4pt]c&=d\end{aligned}`],
    ["inline", "matrix", String.raw`\begin{matrix}a&b\\[4pt]c&d\end{matrix}`],
    ["display", "matrix", String.raw`\begin{matrix}a&b\\[4pt]c&d\end{matrix}`],
  ])("keeps row spacing through character streaming: %s %s", (kind, _environment, tex) => {
    const open = kind === "inline" ? "\\(" : "\\[";
    const close = kind === "inline" ? "\\)" : "\\]";
    const content = `${open}${tex}${close}\n\n后文`;
    const closedAt = open.length + tex.length + close.length;
    for (let index = 0; index <= content.length; index += 1) {
      update(content.slice(0, index), true);
      expect([...container.querySelectorAll("annotation")].map((node) => node.textContent))
        .toEqual(index < closedAt ? [] : [tex]);
      expect(container.querySelector(".katex-error")).toBeNull();
    }
    expect(container.querySelector("p:last-child")?.textContent).toBe("后文");
    expect(container.querySelectorAll(".katex-display")).toHaveLength(kind === "display" ? 1 : 0);
    const node = container.querySelector(".katex");
    update(content, false);
    expect([...container.querySelectorAll("annotation")].map((node) => node.textContent)).toEqual([tex]);
    expect(container.querySelector(".katex")).toBe(node);
    expect(container.querySelector("p:last-child")?.textContent).toBe("后文");
  });

  it.each([
    ["\\(x\n+y\\) 价格 $5\n\n后文", "x\n+y", undefined],
    ["**结果 \\[x=1\\] 完成**\n\n后文", "x=1", '[data-streamdown="strong"]'],
    ["*结果 \\[x=1\\] 完成*\n\n后文", "x=1", "em"],
    ["~~结果 \\[x=1\\] 完成~~\n\n后文", "x=1", "del"],
    ["\\[x\\ \\]\n\n后文", "x\\ ", undefined],
    ["\\(x\\ \\)\n\n后文", "x\\ ", undefined],
  ])("keeps exact math, following prose and formatting through every prefix: %s", (content, tex, tag) => {
    const close = Math.max(content.indexOf("\\)"), content.indexOf("\\]")) + 2;
    for (let index = 0; index <= content.length; index += 1) {
      update(content.slice(0, index), true);
      expect([...container.querySelectorAll("annotation")].map((node) => node.textContent))
        .toEqual(index < close ? [] : [tex]);
      expect(container.querySelector(".katex-error")).toBeNull();
    }
    expect(container.querySelector("p:last-child")?.textContent).toBe("后文");
    if (content.includes("价格")) expect(container.textContent).toContain("价格 $5");
    if (tag) expect(container.querySelector(tag)?.textContent).toMatch(/^结果 .* 完成$/s);
    const nodes = [...container.querySelectorAll(".katex")];
    update(content, false);
    expect([...container.querySelectorAll("annotation")].map((node) => node.textContent)).toEqual([tex]);
    nodes.forEach((node, index) => expect(container.querySelectorAll(".katex")[index]).toBe(node));
    if (tag) expect(container.querySelector(tag)?.textContent).toMatch(/^结果 .* 完成$/s);
    expect(container.querySelector("p:last-child")?.textContent).toBe("后文");
  });
  it("keeps exact math and currency text through character-by-character streaming", () => {
    const content = String.raw`价格 $5，税率 \(r=0.2\)\(a\)` + "\n\n> - > \\[\n>   >x>0\n>   > \\]";
    const expected = ["r=0.2", "a", "x>0"];
    for (let index = 0; index <= content.length; index += 1) {
      update(content.slice(0, index), true);
      if (index >= content.indexOf("\\)") + 2) {
        const annotations = [...container.querySelectorAll("annotation")].map((node) => node.textContent);
        expect(annotations).toEqual(expected.slice(0, annotations.length));
      }
    }
    expect([...container.querySelectorAll("annotation")].map((node) => node.textContent)).toEqual(expected);
    const copy = container.cloneNode(true) as HTMLElement;
    copy.querySelectorAll(".katex").forEach((node) => node.remove());
    expect(copy.textContent).toContain("价格 $5，税率 ");
    const nodes = [...container.querySelectorAll(".katex")];
    update(content, false);
    expect([...container.querySelectorAll("annotation")].map((node) => node.textContent)).toEqual(expected);
    nodes.forEach((node, index) => expect(container.querySelectorAll(".katex")[index]).toBe(node));
  });

  it("waits for a closing backslash delimiter and preserves the completed KaTeX nodes", () => {
    const content = "行内 \\(h=\\dfrac{5b}{12}\\)\n\n\\[\nx^2+y^2=z^2\n\\]";
    const displayStart = content.indexOf("\\[");
    for (let index = 0; index <= displayStart; index += 1) {
      update(content.slice(0, index), true);
      if (index < content.indexOf("\\)") + 2) expect(container.querySelector(".katex")).toBeNull();
    }
    update(content.slice(0, -1), true);
    expect(container.querySelectorAll(".katex")).toHaveLength(1);
    expect(container.querySelector(".katex-display")).toBeNull();
    update(content, true);
    const nodes = [...container.querySelectorAll(".katex")];
    expect(nodes).toHaveLength(2);
    expect(container.querySelectorAll(".katex-display")).toHaveLength(1);
    update(content, false);
    expect([...container.querySelectorAll(".katex")]).toEqual(nodes);
    nodes.forEach((node, index) => expect(container.querySelectorAll(".katex")[index]).toBe(node));
    update(content, false);
    nodes.forEach((node, index) => expect(container.querySelectorAll(".katex")[index]).toBe(node));
  });

  it("preserves the rendered KaTeX tree when a math response completes and later state updates repeat", () => {
    const content = "公式：$E=mc^2$\n\n$$a^2+b^2=c^2$$";
    update(content, true);
    const streamedMath = container.querySelector(".katex");
    expect(streamedMath).not.toBeNull();

    update(content, false);
    expect(container.querySelector(".katex")).toBe(streamedMath);

    update(content, false);
    expect(container.querySelector(".katex")).toBe(streamedMath);
  });

  it("replaces an incomplete streamed fence with completed unrelated content without stale blocks", () => {
    update("~~~ts\nconst oldAnswer = true;", true);
    expect(container.textContent).toContain("oldAnswer");

    update("完全替换 BBB", false);

    expect(container.textContent).toContain("完全替换 BBB");
    expect(container.textContent).not.toContain("oldAnswer");
  });

  it("contains neither XMarkdown nor the performance renderer injection", () => {
    const source = readFileSync(resolve(__dirname, "ChatMessageList.tsx"), "utf8");

    expect(source).not.toContain("@ant-design/x-markdown");
    expect(source).not.toContain("__cyreneChatPerfMarkdownRenderer");
  });
});
