// @vitest-environment jsdom
import React, { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { AskUserPanel, PlanApprovalPanel } from "./InteractionPanel";
import type { AskUserInteraction } from "./run-presentation";

// 面板结构测试不覆盖 Markdown/LaTeX 渲染细节；真实渲染链在 node 测试环境
// 会加载带 CSS 的 CJS 模块而无法静态渲染，这里替换为直通文本
vi.mock("./ChatMessageList", () => ({
  MarkdownContent: ({ content }: { content: string }) => createElement("span", null, content),
}));

function renderAsk(interaction: AskUserInteraction): string {
  return renderToStaticMarkup(createElement(AskUserPanel, { interaction }));
}

const roots: ReturnType<typeof createRoot>[] = [];
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
afterEach(async () => {
  for (const root of roots.splice(0)) await act(async () => root.unmount());
  document.body.replaceChildren();
});

async function mountAsk(count = 1) {
  const interaction: AskUserInteraction = {
    kind: "ask", id: "keyboard", runId: "run", revision: 1,
    responseKind: "submission", question: "Question 1", options: [],
    questions: Array.from({ length: count }, (_, index) => ({
      id: `q${index + 1}`, question: `Question ${index + 1}`, options: [],
      allowCustomInput: true,
    })),
  };
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);
  const onAnswer = vi.fn();
  const render = async (disabled = false) => {
    await act(async () => root.render(createElement(AskUserPanel, { interaction, onAnswer, disabled })));
  };
  await render();
  const input = container.querySelector("input")!;
  const type = async (value: string) => {
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
  };
  const press = async (init: KeyboardEventInit = {}) => {
    await act(async () => {
      input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true, ...init }));
    });
  };
  return { container, input, onAnswer, render, type, press };
}

describe("AskUserPanel", () => {
  beforeAll(() => {
    vi.stubGlobal("React", React);
  });

  it("submits a single custom answer on Enter using the existing payload", async () => {
    const panel = await mountAsk();
    await panel.type(" answer ");
    await panel.press();
    expect(panel.onAnswer).toHaveBeenCalledExactlyOnceWith({
      interactionId: "keyboard", runId: "run", revision: 1,
      answers: [{ questionId: "q1", source: "custom", text: "answer" }],
    });
  });

  it("advances to the next question and submits all answers on the last", async () => {
    const panel = await mountAsk(2);
    panel.input.focus();
    await panel.type("first");
    await panel.press();
    expect(panel.container.textContent).toContain("Question 2");
    expect(panel.input.value).toBe("");
    expect(document.activeElement).toBe(panel.input);
    expect(panel.onAnswer).not.toHaveBeenCalled();
    await panel.type("second");
    await panel.press();
    expect(panel.onAnswer).toHaveBeenCalledExactlyOnceWith({
      interactionId: "keyboard", runId: "run", revision: 1,
      answers: [
        { questionId: "q1", source: "custom", text: "first" },
        { questionId: "q2", source: "custom", text: "second" },
      ],
    });
  });

  it("does not advance with a blank answer or submit with an earlier unanswered question", async () => {
    const panel = await mountAsk(2);
    await panel.type("   ");
    await panel.press();
    expect(panel.container.textContent).toContain("Question 1");
    await act(async () => {
      (panel.container.querySelector(".cy-interaction-panel__pager button:last-child") as HTMLButtonElement).click();
    });
    await panel.type("second");
    await panel.press();
    expect(panel.onAnswer).not.toHaveBeenCalled();
  });

  it.each([
    { isComposing: true }, { keyCode: 229 }, { repeat: true },
    { shiftKey: true }, { ctrlKey: true }, { altKey: true }, { metaKey: true }, { key: "Escape" },
  ])("ignores composition, repeat, modified and non-Enter keys: %j", async (init) => {
    const panel = await mountAsk(2);
    await panel.type("answer");
    await panel.press(init);
    expect(panel.container.textContent).toContain("Question 1");
    expect(panel.onAnswer).not.toHaveBeenCalled();
  });

  it("does not submit while disabled", async () => {
    const panel = await mountAsk();
    await panel.type("answer");
    await panel.render(true);
    await panel.press();
    expect(panel.onAnswer).not.toHaveBeenCalled();
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

describe("PlanApprovalPanel", () => {
  beforeAll(() => {
    vi.stubGlobal("React", React);
  });

  const planInteraction: AskUserInteraction = {
    kind: "ask",
    id: "choice-plan",
    runId: "run-plan",
    revision: 1,
    cardMode: "plan_approval",
    responseKind: "submission",
    intro: "计划已提交，请审阅计划内容后决定",
    question: "是否批准此计划？",
    options: [
      { id: "question-1-option-1", label: "批准" },
      { id: "question-1-option-2", label: "需要修改" },
      { id: "question-1-option-3", label: "不批准" },
    ],
    questions: [{
      id: "question-1",
      question: "是否批准此计划？",
      options: [
        { id: "question-1-option-1", label: "批准" },
        { id: "question-1-option-2", label: "需要修改" },
        { id: "question-1-option-3", label: "不批准" },
      ],
      allowCustomInput: true,
      multiple: false,
      freeTextPlaceholder: "请描述你想修改的内容…",
    }],
  };

  it("renders three flat decision buttons without the revise textarea up front", () => {
    const html = renderToStaticMarkup(createElement(PlanApprovalPanel, { interaction: planInteraction }));

    // 三档平级主按钮就位；输入框未展开（点"需要修改"后原地展开）
    expect(html).toContain("批准");
    expect(html).toContain("需要修改");
    expect(html).toContain("不批准");
    expect(html).not.toContain("<textarea");
    // 审批卡没有"忽略/跳过"逃生口：三档就是全部出口
    expect(html).not.toContain("忽略");
    expect(html).not.toContain("跳过");
  });
});
