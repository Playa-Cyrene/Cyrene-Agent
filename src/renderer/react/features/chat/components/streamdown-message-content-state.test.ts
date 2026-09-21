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
