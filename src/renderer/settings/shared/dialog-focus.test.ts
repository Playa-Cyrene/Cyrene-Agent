// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { activateDialogFocus } from "./dialog-focus";

describe("activateDialogFocus", () => {
  beforeEach(() => {
    document.body.innerHTML = '<button id="trigger">打开</button><div id="dialog"><button id="cancel">取消</button><button id="ok">确定</button></div>';
  });

  it("focuses the safe action and restores the trigger", () => {
    const trigger = document.getElementById("trigger") as HTMLButtonElement;
    const dialog = document.getElementById("dialog") as HTMLElement;
    const cancel = document.getElementById("cancel") as HTMLButtonElement;
    trigger.focus();
    const cleanup = activateDialogFocus(dialog, cancel, vi.fn());
    expect(document.activeElement).toBe(cancel);
    cleanup();
    expect(document.activeElement).toBe(trigger);
  });

  it("cycles Tab and maps Escape to cancellation", () => {
    const dialog = document.getElementById("dialog") as HTMLElement;
    const cancel = document.getElementById("cancel") as HTMLButtonElement;
    const ok = document.getElementById("ok") as HTMLButtonElement;
    const onEscape = vi.fn();
    const cleanup = activateDialogFocus(dialog, cancel, onEscape);
    ok.focus();
    dialog.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", bubbles: true }));
    expect(document.activeElement).toBe(cancel);
    dialog.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(onEscape).toHaveBeenCalledTimes(1);
    cleanup();
  });

  it("excludes a hidden summary from the focus cycle (dangerous confirm shape)", () => {
    // 危险确认：详情区隐藏（details 带 hidden），取消按钮是首个可见元素且默认聚焦。
    // Shift+Tab 必须环绕到末位的确认按钮，不能把隐藏的 summary 当作首元素而放任焦点逃出弹窗。
    document.getElementById("dialog")!.innerHTML =
      '<details hidden><summary id="detail">查看详情</summary><pre>堆栈</pre></details><button id="cancel">取消</button><button id="ok">确定</button>';
    const dialog = document.getElementById("dialog") as HTMLElement;
    const cancel = document.getElementById("cancel") as HTMLButtonElement;
    const ok = document.getElementById("ok") as HTMLButtonElement;
    const cleanup = activateDialogFocus(dialog, cancel, vi.fn());
    expect(document.activeElement).toBe(cancel);
    dialog.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", shiftKey: true, bubbles: true }));
    expect(document.activeElement).toBe(ok);
    ok.focus();
    dialog.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", bubbles: true }));
    expect(document.activeElement).toBe(cancel);
    cleanup();
  });

  it("keeps summary and links inside the focus cycle for keyboard users", () => {
    const dialog = document.getElementById("dialog") as HTMLElement;
    // 错误弹窗的"查看详情"是 summary：必须进入循环，否则键盘用户无法展开详情。
    // summary 排在按钮前（循环首位），从末位按钮 Tab 应环绕回首位的 summary
    document.getElementById("dialog")!.innerHTML =
      '<details open><summary id="detail">查看详情</summary><pre>堆栈</pre></details><button id="ok">知道了</button>';
    const ok = document.getElementById("ok") as HTMLButtonElement;
    const detail = document.getElementById("detail") as HTMLElement;
    let cleanup = activateDialogFocus(dialog, ok, vi.fn());
    ok.focus();
    dialog.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", bubbles: true }));
    expect(document.activeElement).toBe(detail);
    // Shift+Tab 从循环首位环绕回末位按钮
    detail.focus();
    dialog.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", shiftKey: true, bubbles: true }));
    expect(document.activeElement).toBe(ok);
    cleanup();

    // 链接同样进入循环：链接为末位时，从链接 Tab 环绕回首元素
    document.getElementById("dialog")!.innerHTML =
      '<button id="first">确定</button><a id="link" href="#">帮助</a>';
    const first = document.getElementById("first") as HTMLButtonElement;
    const link = document.getElementById("link") as HTMLElement;
    cleanup = activateDialogFocus(dialog, first, vi.fn());
    link.focus();
    dialog.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", bubbles: true }));
    expect(document.activeElement).toBe(first);
    cleanup();
  });
});
