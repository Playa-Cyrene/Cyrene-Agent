// @vitest-environment jsdom

import { createElement as h } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { FeedbackApi } from "../../../shared/feedback-types";

// 只 mock Ant Design 的两个 hook，验证 provider 到语义 API 的精确映射
const messageOpen = vi.fn();
const modalConfirm = vi.fn();

vi.mock("antd", async () => {
  const React = await import("react");
  return {
    message: { useMessage: () => [{ open: messageOpen }, React.createElement("span")] },
    Modal: { useModal: () => [{ confirm: modalConfirm }, React.createElement("span")] },
  };
});

import { FeedbackProvider, useFeedback } from "./FeedbackProvider";

describe("FeedbackProvider", () => {
  let api: FeedbackApi;
  function Probe() { api = useFeedback(); return null; }

  function renderProvider(): Promise<void> {
    const host = document.createElement("div");
    return act(async () => { createRoot(host).render(h(FeedbackProvider, null, h(Probe))); });
  }

  beforeEach(() => {
    messageOpen.mockClear();
    modalConfirm.mockClear();
  });

  it("maps notice tone, duration, dedupe key and class", async () => {
    await renderProvider();
    api!.notice({ tone: "success", message: "设置已保存" });
    expect(messageOpen).toHaveBeenCalledWith(expect.objectContaining({
      type: "success", content: "设置已保存", duration: 3, className: "cy-feedback-notice",
    }));
  });

  it("maps dangerous confirm to a cancel-focused modal", async () => {
    await renderProvider();
    api!.confirm({ title: "删除任务？", message: "无法恢复。", dangerous: true });
    // 单一 Promise 链：首条经一个微任务打开
    await Promise.resolve();
    expect(modalConfirm).toHaveBeenCalledWith(expect.objectContaining({
      maskClosable: false,
      autoFocusButton: "cancel",
      okButtonProps: { danger: true },
      rootClassName: "cy-feedback-modal cy-feedback-modal--danger",
    }));
  });

  it("serializes blocking dialogs", async () => {
    await renderProvider();
    const first = api!.alert({ tone: "info", title: "第一条", message: "先处理" });
    const second = api!.confirm({ title: "第二条", message: "后处理" });
    // 首条经一个微任务打开
    await Promise.resolve();
    expect(modalConfirm).toHaveBeenCalledTimes(1);
    modalConfirm.mock.calls[0][0].onOk();
    await first;
    await Promise.resolve();
    expect(modalConfirm).toHaveBeenCalledTimes(2);
    modalConfirm.mock.calls[1][0].onCancel();
    await expect(second).resolves.toBe(false);
  });

  it("serializes a late request that arrives right after the first resolves", async () => {
    await renderProvider();
    const first = api!.alert({ tone: "info", title: "第一条", message: "先处理" });
    const second = api!.confirm({ title: "第二条", message: "后处理" });
    await Promise.resolve();
    expect(modalConfirm).toHaveBeenCalledTimes(1);
    modalConfirm.mock.calls[0][0].onOk();
    // 第一条结束、第二条尚未打开的窗口：不加额外 await，立即请求第三条（审查复现场景）
    await first;
    const third = api!.confirm({ title: "第三条", message: "最后处理" });
    await Promise.resolve();
    await Promise.resolve();
    // 第二条先打开，第三条仍在排队
    expect(modalConfirm).toHaveBeenCalledTimes(2);
    expect(modalConfirm.mock.calls[1][0].title).toBe("第二条");
    modalConfirm.mock.calls[1][0].onOk();
    await expect(second).resolves.toBe(true);
    await Promise.resolve();
    await Promise.resolve();
    // 第二条关闭后第三条才打开
    expect(modalConfirm).toHaveBeenCalledTimes(3);
    expect(modalConfirm.mock.calls[2][0].title).toBe("第三条");
    modalConfirm.mock.calls[2][0].onCancel();
    await expect(third).resolves.toBe(false);
  });
});
