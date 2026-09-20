// 阶段切换后编辑/重生成目标 ID 的契约测试：footer 动作组件经 LastTurnIdsContext
// 消费最新 ID。流式阶段边界（推理结束间隙 → 正文开始 → 运行结束 → 新一轮）lastTurn
// 在 null 与非 null 间切换，动作必须始终指向当前可修订轮次，且不进 roles 闭包
// （否则全部条目 contentRender 失效，历史消息全量重渲染——阶段 2 修复的穿透源）。
import { act, createElement, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { JSDOM } from "jsdom";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@ant-design/x", () => ({
  Bubble: { List: () => null },
  CodeHighlighter: () => null,
  Think: () => null,
  ThoughtChain: () => null,
}));
vi.mock("../../../../../shared/renderer-base", () => ({ resolveAsset: (path: string) => path }));
vi.mock("./StreamdownMessageContent.css", () => ({}));
vi.mock("./MermaidBlock", () => ({ MermaidBlock: () => null }));
vi.mock("./SvgCardBlock", () => ({ SvgCardBlock: () => null }));

import { AssistantMessageFooter, LastTurnEditAction, LastTurnIdsContext, type LastTurnIds } from "./ChatMessageList";

const NULL_IDS: LastTurnIds = { userMessageId: null, assistantMessageId: null };

let dom: JSDOM | null = null;
let host: HTMLElement | null = null;
let root: Root | null = null;
const roots: Root[] = [];

function setupDom() {
  dom = new JSDOM("<!doctype html><html><body></body></html>");
  const scope = globalThis as typeof globalThis & {
    document?: Document;
    window?: Window & typeof globalThis;
    navigator?: Navigator;
    IS_REACT_ACT_ENVIRONMENT?: boolean;
  };
  scope.document = dom.window.document;
  scope.window = dom.window as unknown as Window & typeof globalThis;
  // Node 的 globalThis.navigator 是只读 getter，直接赋值抛错；defineProperty 覆盖
  Object.defineProperty(scope, "navigator", {
    value: dom.window.navigator,
    configurable: true,
    writable: true,
  });
  scope.IS_REACT_ACT_ENVIRONMENT = true;
  host = dom.window.document.createElement("div");
  dom.window.document.body.appendChild(host);
  root = createRoot(host);
  roots.push(root);
}

/** 在指定 lastTurnIds 下渲染动作组件（不动全局 DOM 状态，act 包裹保证提交） */
function renderAction(ids: LastTurnIds, ui: ReactElement) {
  if (!root) throw new Error("DOM 未初始化");
  act(() => {
    root!.render(createElement(LastTurnIdsContext.Provider, { value: ids }, ui));
  });
}

function queryAction(kind: "edit" | "regenerate"): HTMLElement | null {
  if (!host) throw new Error("DOM 未初始化");
  return host.querySelector(`.cy-last-turn-action--${kind}`);
}

afterEach(() => {
  for (const r of roots.splice(0)) {
    act(() => {
      r.unmount();
    });
  }
  host?.remove();
  const scope = globalThis as typeof globalThis & {
    document?: Document;
    window?: Window & typeof globalThis;
    navigator?: Navigator;
    IS_REACT_ACT_ENVIRONMENT?: boolean;
  };
  delete scope.document;
  delete scope.window;
  delete scope.navigator;
  delete scope.IS_REACT_ACT_ENVIRONMENT;
  dom?.window.close();
  dom = null;
  host = null;
  root = null;
});

describe("阶段切换后编辑/重生成目标 ID（LastTurnIdsContext 消费）", () => {
  it("推理结束间隙（lastTurn 非 null）：重生成按钮出现且点击作用于本轮 ID", () => {
    setupDom();
    const onRegenerate = vi.fn(async () => true);
    // 间隙态：流式消息无正文，动作只依赖 context 匹配
    renderAction(
      { userMessageId: "u-2", assistantMessageId: "a-2" },
      createElement(AssistantMessageFooter, {
        content: "",
        messageId: "a-2",
        streaming: false,
        mode: "chat",
        preferredAddress: "",
        revisionBusy: false,
        onRegenerateLastResponse: onRegenerate,
      }),
    );
    const button = queryAction("regenerate");
    expect(button).not.toBeNull();
    act(() => {
      button!.click();
    });
    expect(onRegenerate).toHaveBeenCalledTimes(1);
    expect(onRegenerate).toHaveBeenCalledWith("u-2", "a-2");
  });

  it("正文开始（streaming=true，lastTurn 回到 null）：重生成按钮消失", () => {
    setupDom();
    const onRegenerate = vi.fn(async () => true);
    const footer = createElement(AssistantMessageFooter, {
      content: "回答正文",
      messageId: "a-2",
      streaming: false,
      mode: "chat",
      preferredAddress: "",
      revisionBusy: false,
      onRegenerateLastResponse: onRegenerate,
    });
    // 完成态先渲染（streaming=false + 本轮 ID）出现按钮，再切到流式态
    renderAction({ userMessageId: "u-2", assistantMessageId: "a-2" }, footer);
    expect(queryAction("regenerate")).not.toBeNull();
    renderAction(NULL_IDS, createElement(AssistantMessageFooter, {
      content: "回答正文（增量）",
      messageId: "a-2",
      streaming: true,
      mode: "chat",
      preferredAddress: "",
      revisionBusy: false,
      onRegenerateLastResponse: onRegenerate,
    }));
    expect(queryAction("regenerate")).toBeNull();
  });

  it("新一轮完成后：旧轮消息不再出现重生成按钮，新轮按钮指向新 ID", () => {
    setupDom();
    const onRegenerate = vi.fn(async () => true);
    const propsFor = (messageId: string) => ({
      content: "回答",
      messageId,
      streaming: false,
      mode: "chat" as const,
      preferredAddress: "",
      revisionBusy: false,
      onRegenerateLastResponse: onRegenerate,
    });
    // 第 2 轮完成：a-2 是目标
    renderAction({ userMessageId: "u-2", assistantMessageId: "a-2" }, createElement(AssistantMessageFooter, propsFor("a-2")));
    expect(queryAction("regenerate")).not.toBeNull();
    // 第 3 轮完成：同一条 a-2 消息的 footer 不再有按钮
    renderAction({ userMessageId: "u-3", assistantMessageId: "a-3" }, createElement(AssistantMessageFooter, propsFor("a-2")));
    expect(queryAction("regenerate")).toBeNull();
    // 第 3 轮自己的 footer 有按钮且指向新 ID
    renderAction({ userMessageId: "u-3", assistantMessageId: "a-3" }, createElement(AssistantMessageFooter, propsFor("a-3")));
    const button = queryAction("regenerate");
    expect(button).not.toBeNull();
    act(() => {
      button!.click();
    });
    expect(onRegenerate).toHaveBeenCalledWith("u-3", "a-3");
  });

  it("编辑按钮：本轮 user 消息匹配渲染并回调原文，流式期间消失", () => {
    setupDom();
    const onBeginEdit = vi.fn();
    const propsFor = (messageId: string) => ({
      messageId,
      content: "问题原文",
      disabled: false,
      onBeginEdit,
    });
    renderAction({ userMessageId: "u-2", assistantMessageId: "a-2" }, createElement(LastTurnEditAction, propsFor("u-2")));
    const button = queryAction("edit");
    expect(button).not.toBeNull();
    act(() => {
      button!.click();
    });
    expect(onBeginEdit).toHaveBeenCalledWith("u-2", "问题原文");
    // 流式开始（lastTurn → null）：编辑按钮消失
    renderAction(NULL_IDS, createElement(LastTurnEditAction, propsFor("u-2")));
    expect(queryAction("edit")).toBeNull();
    // 历史 user 消息（非本轮）：不渲染
    renderAction({ userMessageId: "u-3", assistantMessageId: "a-3" }, createElement(LastTurnEditAction, propsFor("u-2")));
    expect(queryAction("edit")).toBeNull();
  });
});
