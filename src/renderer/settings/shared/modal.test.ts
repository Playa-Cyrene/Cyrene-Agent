// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { modalState } from "./modal-state";
import { showAlert, showConfirm, showHtmlModal, showInputModal, showNotice } from "./modal";

describe("settings feedback", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    document.body.innerHTML = '<button id="trigger">打开</button>';
    Object.assign(modalState, {
      cyOverlay: null,
      cyHtmlOverlay: null,
      cyInputOverlay: null,
      noticeContainer: null,
      blockingQueue: [],
      blockingActive: false,
    });
  });

  it("renders at most three notices and merges duplicate messages", () => {
    showNotice({ tone: "success", message: "设置已保存" });
    showNotice({ tone: "success", message: "设置已保存" });
    showNotice({ tone: "info", message: "第一条" });
    showNotice({ tone: "warning", message: "第二条" });
    showNotice({ tone: "error", message: "第三条" });
    expect(document.querySelectorAll(".cy-notice")).toHaveLength(3);
    expect(document.body.textContent?.match(/设置已保存/g)).toHaveLength(1);
  });

  it("auto closes a notice after the approved duration", () => {
    showNotice({ tone: "success", message: "设置已保存" });
    vi.advanceTimersByTime(3000);
    expect(document.querySelector(".cy-notice")).toBeNull();
  });

  it("shows alert details as text and only one action", async () => {
    const promise = showAlert({ tone: "error", title: "打开失败", message: "请查看详情", details: '<img src=x onerror="alert(1)">' });
    expect(document.querySelectorAll("#cy-modal-overlay button")).toHaveLength(1);
    expect(document.querySelector(".cy-modal__details")?.textContent).toContain("<img src=x");
    (document.getElementById("cy-modal-confirm") as HTMLButtonElement).click();
    await expect(promise).resolves.toBeUndefined();
  });

  it("keeps Shift+Tab inside a dangerous confirm with hidden details", async () => {
    const promise = showConfirm({ title: "删除任务", message: "无法恢复，确认删除？", dangerous: true });
    const dialog = document.querySelector("#cy-modal-overlay .cy-modal") as HTMLElement;
    const cancel = document.getElementById("cy-modal-cancel") as HTMLButtonElement;
    const confirmBtn = document.getElementById("cy-modal-confirm") as HTMLButtonElement;
    // 危险确认默认聚焦取消；详情区隐藏时取消是首个可见元素
    expect(document.activeElement).toBe(cancel);
    // 反向 Tab 环绕到确认按钮，焦点不逃出弹窗
    dialog.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", shiftKey: true, bubbles: true }));
    expect(document.activeElement).toBe(confirmBtn);
    dialog.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", bubbles: true }));
    expect(document.activeElement).toBe(cancel);
    cancel.click();
    await expect(promise).resolves.toBe(false);
  });

  it("makes dangerous confirmation safe by default", async () => {
    const trigger = document.getElementById("trigger") as HTMLButtonElement;
    trigger.focus();
    const promise = showConfirm({ title: "删除任务？", message: "删除后无法恢复。", dangerous: true, confirmText: "删除任务" });
    expect(document.activeElement?.id).toBe("cy-modal-cancel");
    document.getElementById("cy-modal-overlay")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(document.getElementById("cy-modal-overlay")?.classList.contains("is-hidden")).toBe(false);
    (document.getElementById("cy-modal-cancel") as HTMLButtonElement).click();
    await expect(promise).resolves.toBe(false);
    expect(document.activeElement).toBe(trigger);
  });

  it("opens blocking requests in first-in-first-out order", async () => {
    const first = showAlert({ tone: "info", title: "第一条", message: "先处理" });
    const second = showConfirm({ title: "第二条", message: "后处理" });
    expect(document.getElementById("cy-modal-title")?.textContent).toBe("第一条");
    (document.getElementById("cy-modal-confirm") as HTMLButtonElement).click();
    await first;
    expect(document.getElementById("cy-modal-title")?.textContent).toBe("第二条");
    (document.getElementById("cy-modal-cancel") as HTMLButtonElement).click();
    await expect(second).resolves.toBe(false);
  });

  it("queues an input modal behind a confirm and resolves its value", async () => {
    const confirmPromise = showConfirm({ title: "先确认", message: "输入弹窗必须排队" });
    const inputPromise = showInputModal({ title: "命名", message: "输入名称" });
    // 输入弹窗排队期间不显示（overlay 懒创建：不存在或处于隐藏态）
    const queuedOverlay = document.getElementById("cy-input-overlay");
    expect(queuedOverlay === null || queuedOverlay.classList.contains("is-hidden")).toBe(true);
    (document.getElementById("cy-modal-confirm") as HTMLButtonElement).click();
    await confirmPromise;
    // 确认弹窗关闭后输入弹窗才展示并聚焦输入框
    expect(document.getElementById("cy-input-overlay")?.classList.contains("is-hidden")).toBe(false);
    expect(document.activeElement?.id).toBe("cy-input-field");
    const field = document.getElementById("cy-input-field") as HTMLInputElement;
    field.value = "新任务";
    (document.getElementById("cy-input-confirm") as HTMLButtonElement).click();
    await expect(inputPromise).resolves.toBe("新任务");
  });

  it("prevents a second input modal from stacking listeners on the same overlay", async () => {
    const first = showInputModal({ title: "第一次", message: "请输入" });
    const second = showInputModal({ title: "第二次", message: "请输入" });
    // 第二次调用排队：标题仍是第一次的
    expect(document.getElementById("cy-input-title")?.textContent).toBe("第一次");
    const field = document.getElementById("cy-input-field") as HTMLInputElement;
    field.value = "第一条结果";
    (document.getElementById("cy-input-confirm") as HTMLButtonElement).click();
    await expect(first).resolves.toBe("第一条结果");
    // 第一条解析后第二条才展示；一次点击只解析一个 Promise
    expect(document.getElementById("cy-input-title")?.textContent).toBe("第二次");
    (document.getElementById("cy-input-cancel") as HTMLButtonElement).click();
    await expect(second).resolves.toBeNull();
  });

  it("resolves a pending input modal as null on window unload", async () => {
    const inputPromise = showInputModal({ title: "命名", message: "输入名称" });
    const confirmPromise = showConfirm({ title: "排队的确认", message: "卸载时安全取消" });
    window.dispatchEvent(new Event("beforeunload"));
    await expect(inputPromise).resolves.toBeNull();
    await expect(confirmPromise).resolves.toBe(false);
  });

  it("queues a html modal behind an alert", async () => {
    const alertPromise = showAlert({ tone: "info", title: "先说明", message: "富文本弹窗排队" });
    const htmlPromise = showHtmlModal({ title: "规格说明", htmlBody: "<p>规格</p>" });
    // 富文本弹窗排队期间不显示（overlay 懒创建：不存在或处于隐藏态）
    const queuedOverlay = document.getElementById("cy-html-modal-overlay");
    expect(queuedOverlay === null || queuedOverlay.classList.contains("is-hidden")).toBe(true);
    (document.getElementById("cy-modal-confirm") as HTMLButtonElement).click();
    await alertPromise;
    expect(document.getElementById("cy-html-modal-overlay")?.classList.contains("is-hidden")).toBe(false);
    expect(document.getElementById("cy-html-modal-title")?.textContent).toBe("规格说明");
    (document.getElementById("cy-html-modal-confirm") as HTMLButtonElement).click();
    await expect(htmlPromise).resolves.toBeUndefined();
  });
});
