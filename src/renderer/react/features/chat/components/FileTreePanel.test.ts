import { createElement } from "react";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

// JSX 经典运行时（React.createElement）：被测 .tsx 需要全局 React（项目测试惯例）
vi.stubGlobal("React", React);

// FileTreePanel 会引入 ChatMessageList 的 MarkdownContent（MD 预览用），
// 正文渲染涉及浏览器样式与插件链；该结构测试只需轻量替身。
vi.mock("./ChatMessageList", () => ({
  MarkdownContent: ({ content }: { content: string }) => createElement("div", null, content),
}));

import { FilePreviewContent } from "./FileTreePanel";

describe("FilePreviewContent", () => {
  it("renders its loading state without an undeclared React hook", () => {
    expect(() => renderToStaticMarkup(createElement(FilePreviewContent, {
      sessionId: "session-1",
      relPath: "README.md",
    }))).not.toThrow();
  });
});
