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
