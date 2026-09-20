import React, { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { AskUserPanel } from "./InteractionPanel";
import type { AskUserInteraction } from "./run-presentation";

// 面板结构测试不覆盖 Markdown/LaTeX 渲染细节；真实渲染链在 node 测试环境
// 会加载带 CSS 的 CJS 模块而无法静态渲染，这里替换为直通文本
vi.mock("./ChatMessageList", () => ({
  MarkdownContent: ({ content }: { content: string }) => createElement("span", null, content),
}));

function renderAsk(interaction: AskUserInteraction): string {
  return renderToStaticMarkup(createElement(AskUserPanel, { interaction }));
}

describe("AskUserPanel", () => {
  beforeAll(() => {
    vi.stubGlobal("React", React);
  });

  it("renders a text-only Ask without an empty option group or skip action", () => {
    const html = renderAsk({
      kind: "ask",
      id: "choice-text",
      runId: "run-text",
      revision: 1,
      responseKind: "submission",
      question: "还有什么要求？",
      options: [],
      questions: [{
        id: "note",
        question: "还有什么要求？",
        options: [],
        allowCustomInput: true,
        multiple: false,
        freeTextPlaceholder: "请输入要求",
      }],
    });

    expect(html).toContain("请输入要求");
    expect(html).not.toContain('role="radiogroup"');
    expect(html).not.toContain("忽略");
    expect(html).not.toContain("跳过");
  });

  it("does not render a custom input for a runtime-owned fixed-choice Ask", () => {
    const html = renderAsk({
      kind: "ask",
      id: "choice-fixed",
      runId: "run-fixed",
      revision: 1,
      responseKind: "submission",
      question: "是否继续？",
      options: [{ id: "allow", label: "允许" }, { id: "deny", label: "拒绝" }],
      questions: [{
        id: "decision",
        question: "是否继续？",
        options: [{ id: "allow", label: "允许" }, { id: "deny", label: "拒绝" }],
        allowCustomInput: false,
        multiple: false,
      }],
    });

    expect(html).toContain('role="radiogroup"');
    expect(html).not.toContain("其他回答");
    expect(html).not.toContain("输入你的回答");
  });
});
