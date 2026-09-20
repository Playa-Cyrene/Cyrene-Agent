import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("./PlanReviewPanel", () => ({
  PlanContent: () => null,
  planTabDotClass: () => "is-review",
  planTabLabel: () => "计划 · 待审批",
}));
vi.mock("./ReviewInspector", () => ({ ReviewDiffContent: () => null }));
// FileTreePanel 会引入 ChatMessageList 的 MarkdownContent（MD 预览用），
// 正文渲染涉及浏览器样式与插件链；该结构测试只需轻量替身。
vi.mock("./ChatMessageList", () => ({
  MarkdownContent: ({ content }: { content: string }) => createElement("div", null, content),
}));

import { ChatPageInspector } from "./ChatPageInspector";

describe("ChatPageInspector", () => {
  it("renders nothing when no inspector tab is available", () => {
    const html = renderToStaticMarkup(createElement(ChatPageInspector, {
      sessionId: undefined,
      workspaceRoot: undefined,
      filesTabOpen: false,
      filesTabPinned: false,
      fileTabs: [],
      diffTabs: [],
      activePlan: null,
      planDrawerOpen: false,
      planTabId: "plan:session",
      activeTabId: null,
      onTabChange: () => undefined,
      onCloseTab: () => undefined,
      onOpenFile: () => undefined,
    }));

    expect(html).toBe("");
  });
});
