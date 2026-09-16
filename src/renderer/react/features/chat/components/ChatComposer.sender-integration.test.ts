// @vitest-environment jsdom
/**
 * 真实 Sender（@ant-design/x，不 mock）× ChatComposer 集成测试。
 * 覆盖“运行中按 Enter 入队 + 输入框上方队列栏”：
 * - 忙闲路由：空闲 Enter 提交 / 运行中 Enter 入队
 * - Shift+Enter 换行（不提交、不拦截默认行为）
 * - 输入法组合期间 Enter 不提交，组合结束后恢复
 * - 停止按钮：运行中始终可点、点击触发 onCancel，且不再显示单独的入队按钮
 * - 附件与待发队列条目在运行中仍可见，可修改、调整和删除
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import React, { act, createElement, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { ComposerAttachment } from "./ChatComposer";

// 只 mock 与 IPC/资产耦合的子控件，保留 Sender / antd 真实渲染与键盘逻辑
vi.mock("./ReasoningControl", () => ({ ReasoningControl: () => null }));
vi.mock("./StyleControl", () => ({ StyleControl: () => null }));
vi.mock("./PermissionControl", () => ({ PermissionControl: () => null }));
vi.mock("./PlanModeToggle", () => ({ PlanModeToggle: () => null }));
vi.mock("./ModelSelector", () => ({ ModelSelector: () => null }));
vi.mock("./ContextUsageRing", () => ({ ContextUsageRing: () => null }));
vi.mock("../../../../../shared/renderer-base", () => ({ resolveAsset: (path: string) => path }));

import { ChatComposer } from "./ChatComposer";
import { t } from "../../../i18n";

let root: Root | null = null;
let host: HTMLElement | null = null;

const handlers = {
  onSubmit: vi.fn(),
  onQueueMessage: vi.fn(),
  onCancel: vi.fn(),
  onRemoveQueuedMessage: vi.fn(),
  onEditQueuedMessage: vi.fn().mockResolvedValue(true),
  onAdjustQueuedMessage: vi.fn().mockResolvedValue(true),
};

interface MountOptions {
  modelBusy?: boolean;
  attachments?: ComposerAttachment[];
  pendingQueue?: Array<{ id: string; content: string; attachmentCount?: number }>;
}

/** 挂载受控 Composer：value 由内部 state 驱动，走真实 onChange 流转。 */
async function mountComposer(options: MountOptions = {}) {
  handlers.onSubmit.mockClear();
  handlers.onQueueMessage.mockClear();
  handlers.onCancel.mockClear();
  handlers.onRemoveQueuedMessage.mockClear();
  handlers.onEditQueuedMessage.mockClear();
  handlers.onAdjustQueuedMessage.mockClear();

  function Harness() {
    const [value, setValue] = useState("");
    return createElement(ChatComposer, {
      value,
      mode: "chat",
      docked: true,
      attachments: options.attachments ?? [],
      modelBusy: options.modelBusy ?? false,
      pendingQueue: options.pendingQueue ?? [],
      onChange: setValue,
      onSubmit: handlers.onSubmit,
      onCancel: handlers.onCancel,
      onQueueMessage: handlers.onQueueMessage,
      onRemoveQueuedMessage: handlers.onRemoveQueuedMessage,
      onEditQueuedMessage: handlers.onEditQueuedMessage,
      onAdjustQueuedMessage: handlers.onAdjustQueuedMessage,
      onChooseWorkspace: vi.fn(),
      onChooseFiles: vi.fn(),
      onRemoveAttachment: vi.fn(),
      onScreenshot: vi.fn(),
      onChooseSticker: vi.fn(),
    });
  }

  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => {
    root!.render(createElement(Harness));
  });
  // flush 表情列表异步加载的 state 更新，避免 act 警告
  await act(async () => {});
}

function textarea(): HTMLTextAreaElement {
  const node = host!.querySelector("textarea");
  if (!node) throw new Error("textarea 未渲染");
  return node as HTMLTextAreaElement;
}

/** 模拟真实输入：原生 value setter + input 事件，让受控 state 完整流转。 */
function input(value: string) {
  const node = textarea();
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!;
  act(() => {
    setter.call(node, value);
    node.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

function pressEnter(modifiers: { shift?: boolean; ctrl?: boolean } = {}): KeyboardEvent {
  const node = textarea();
  const event = new KeyboardEvent("keydown", {
    key: "Enter",
    bubbles: true,
    cancelable: true,
    shiftKey: modifiers.shift ?? false,
    ctrlKey: modifiers.ctrl ?? false,
  });
  act(() => {
    node.dispatchEvent(event);
  });
  return event;
}

/** 输入法组合开始/结束（对应 React onCompositionStart/onCompositionEnd）。 */
function composition(phase: "start" | "end") {
  const node = textarea();
  act(() => {
    node.dispatchEvent(new CompositionEvent(
      phase === "start" ? "compositionstart" : "compositionend",
      { bubbles: true },
    ));
  });
}

function buttonByLabel(label: string): HTMLButtonElement {
  const button = [...host!.querySelectorAll("button")]
    .find((item) => item.getAttribute("aria-label") === label);
  if (!button) throw new Error(`未找到按钮：${label}`);
  return button as HTMLButtonElement;
}

beforeEach(() => {
  // 项目无根 tsconfig，vitest 将 .tsx 按 classic runtime 转换，React 需挂为全局
  vi.stubGlobal("React", React);
  vi.stubGlobal("chat", { getEnabledStickers: vi.fn().mockResolvedValue([]) });
  // rc-textarea autoSize 依赖 ResizeObserver，jsdom 未实现
  vi.stubGlobal("ResizeObserver", class {
    observe() {}
    unobserve() {}
    disconnect() {}
  });
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

afterEach(() => {
  if (root) {
    act(() => {
      root!.unmount();
    });
    root = null;
  }
  if (host) {
    host.remove();
    host = null;
  }
  vi.unstubAllGlobals();
});

describe("ChatComposer 忙闲路由（真实 Sender）", () => {
  it("空闲 Enter 提交消息", async () => {
    await mountComposer({ modelBusy: false });
    input("你好");
    pressEnter();
    expect(handlers.onSubmit).toHaveBeenCalledWith("你好");
    expect(handlers.onQueueMessage).not.toHaveBeenCalled();
  });

  it("空闲点击发送按钮提交消息", async () => {
    await mountComposer({ modelBusy: false });
    input("直接发送");
    // 空闲态保留内建发送键，无自定义 aria-label，按发送图标定位
    const sendButton = [...host!.querySelectorAll("button")]
      .find((item) => item.querySelector(".anticon-arrow-up"));
    expect(sendButton).toBeTruthy();
    act(() => {
      sendButton!.click();
    });
    expect(handlers.onSubmit).toHaveBeenCalledWith("直接发送");
  });

  it("运行中 Enter 加入待发队列而非提交", async () => {
    await mountComposer({ modelBusy: true });
    input("排队消息");
    pressEnter();
    expect(handlers.onQueueMessage).toHaveBeenCalledWith("排队消息");
    expect(handlers.onSubmit).not.toHaveBeenCalled();
    expect(handlers.onCancel).not.toHaveBeenCalled();
  });

  it("运行中不再显示单独的入队按钮", async () => {
    await mountComposer({ modelBusy: true });
    input("按钮排队");
    const queueButton = [...host!.querySelectorAll("button")]
      .find((item) => item.getAttribute("aria-label") === t("composer.queueSend"));
    expect(queueButton).toBeUndefined();
    expect(buttonByLabel(t("composer.stopRun"))).toBeTruthy();
    expect(handlers.onQueueMessage).not.toHaveBeenCalled();
    expect(handlers.onSubmit).not.toHaveBeenCalled();
  });

  it("运行中停止按钮始终可点且触发 onCancel", async () => {
    await mountComposer({ modelBusy: true });
    const stopButton = buttonByLabel(t("composer.stopRun"));
    expect(stopButton.disabled).toBe(false);
    act(() => {
      stopButton.click();
    });
    expect(handlers.onCancel).toHaveBeenCalledTimes(1);
    expect(handlers.onQueueMessage).not.toHaveBeenCalled();
  });

  it("运行中输入区保持可编辑并展示忙态占位文案", async () => {
    await mountComposer({ modelBusy: true });
    const node = textarea();
    expect(node.disabled).toBe(false);
    expect(node.placeholder).toBe(t("composer.placeholderBusy"));
    // 忙态下仍能继续输入（为下一条排队消息做准备）
    input("运行中继续打字");
    expect(node.value).toBe("运行中继续打字");
  });
});

describe("ChatComposer 键盘边界（真实 Sender）", () => {
  it("Shift+Enter 不提交且放行默认换行行为", async () => {
    await mountComposer({ modelBusy: false });
    input("第一行");
    const event = pressEnter({ shift: true });
    expect(handlers.onSubmit).not.toHaveBeenCalled();
    // 未 preventDefault，浏览器 textarea 默认插入换行
    expect(event.defaultPrevented).toBe(false);
  });

  it("运行中 Shift+Enter 同样只换行、不入队", async () => {
    await mountComposer({ modelBusy: true });
    input("排队草稿");
    const event = pressEnter({ shift: true });
    expect(handlers.onQueueMessage).not.toHaveBeenCalled();
    expect(handlers.onCancel).not.toHaveBeenCalled();
    expect(event.defaultPrevented).toBe(false);
  });

  it("输入法组合期间 Enter 不提交，组合结束后恢复", async () => {
    await mountComposer({ modelBusy: true });
    input("nihao");
    composition("start");
    pressEnter();
    expect(handlers.onQueueMessage).not.toHaveBeenCalled();
    composition("end");
    pressEnter();
    expect(handlers.onQueueMessage).toHaveBeenCalledWith("nihao");
  });

  it("Ctrl+Enter 不提交", async () => {
    await mountComposer({ modelBusy: false });
    input("带修饰键");
    pressEnter({ ctrl: true });
    expect(handlers.onSubmit).not.toHaveBeenCalled();
  });

  it("空内容 Enter 不提交", async () => {
    await mountComposer({ modelBusy: false });
    pressEnter();
    expect(handlers.onSubmit).not.toHaveBeenCalled();
  });
});

describe("ChatComposer 队列与附件展示", () => {
  it("待发队列在输入框上方展示并可单独移除", async () => {
    await mountComposer({
      modelBusy: true,
      pendingQueue: [{ id: "q1", content: "第一条排队消息" }, { id: "q2", content: "第二条排队消息" }],
    });
    const dock = host!.querySelector(".cy-queue-dock")!;
    const shell = host!.querySelector(".cy-composer-shell")!;
    expect(dock.compareDocumentPosition(shell) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    act(() => {
      (dock.querySelector(".cy-queue-dock__header") as HTMLButtonElement).click();
    });
    const items = [...host!.querySelectorAll(".cy-queue-dock__row")];
    expect(items).toHaveLength(2);
    expect(items[0].textContent).toContain("第一条排队消息");
    act(() => {
      buttonByLabel(t("composer.removeQueuedMessage")).click();
    });
    expect(handlers.onRemoveQueuedMessage).toHaveBeenCalledWith("q1");
  });

  it("待发条目支持修改和调整", async () => {
    await mountComposer({
      modelBusy: true,
      pendingQueue: [{ id: "q1", content: "原消息", attachmentCount: 1 }],
    });

    act(() => {
      buttonByLabel(t("composer.queueEdit")).click();
    });
    const editor = host!.querySelector(".cy-queue-dock__editor") as HTMLInputElement;
    const inputSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    act(() => {
      inputSetter.call(editor, "修改后的消息");
      editor.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => {
      buttonByLabel(t("composer.queueSave")).click();
    });
    expect(handlers.onEditQueuedMessage).toHaveBeenCalledWith("q1", "修改后的消息");

    await act(async () => {
      buttonByLabel(t("composer.queueAdjust")).click();
    });
    expect(handlers.onAdjustQueuedMessage).toHaveBeenCalledWith("q1");
  });

  it("运行中附件条目仍展示、上传入口仍可点", async () => {
    await mountComposer({
      modelBusy: true,
      attachments: [{ name: "report.txt", kind: "document" }],
    });
    expect(host!.querySelector(".cy-composer__attachment")?.textContent).toContain("report.txt");
    const uploadButton = buttonByLabel(t("composer.uploadFile"));
    expect(uploadButton.disabled).toBe(false);
  });
});
