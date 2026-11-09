// @vitest-environment jsdom
import * as React from "react";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WorkspacePreviewContent, type WorkspacePreview } from "./WorkspacePreview";

vi.mock("../../../i18n", () => ({ t: (key: string) => key, useTranslation: () => ({ t: (key: string) => key }) }));
const closing = vi.hoisted(() => ({
  afterClose: undefined as (() => void) | undefined,
  completed: [] as Array<() => void>,
}));
vi.mock("./SvgPreviewModal", async importOriginal => {
  const actual = await importOriginal<typeof import("./SvgPreviewModal")>();
  return { ...actual, SvgPreviewModal: (props: React.ComponentProps<typeof actual.SvgPreviewModal>) => {
    // 保留真实 Modal 和焦点锁，捕获回调以模拟关闭完成通知的延迟交付。
    closing.afterClose = props.afterClose;
    const afterClose = props.afterClose;
    return createElement(actual.SvgPreviewModal, { ...props, afterClose: () => {
      if (afterClose) { closing.completed.push(afterClose); afterClose(); }
    } });
  } };
});
const svg: WorkspacePreview = { kind: "svg", svg: '<svg xmlns="http://www.w3.org/2000/svg"><text>fixture</text></svg>' };
const image: WorkspacePreview = { kind: "image", attachment: {
  kind: "image", id: "fixture", source: "model", status: "done", name: "fixture.png", filePath: "fixture.png",
  mime: "image/png", byteLength: 42, previewUrl: "data:image/png;base64,iVBORw0KGgo=",
} };
let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  closing.afterClose = undefined;
  closing.completed.length = 0;
  vi.stubGlobal("React", React);
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  // JSDOM 默认零尺寸会让 Ant Design 的焦点锁找不到目标，掩盖浏览器中的回拉。
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue(new DOMRect(0, 0, 100, 40));
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
async function render(preview: WorkspacePreview = svg, active = true) { await act(async () => root.render(createElement(WorkspacePreviewContent, { preview, active }))); }
async function click(selector: string, scope: ParentNode = document) {
  const node = scope.querySelector<HTMLElement>(selector); expect(node).not.toBeNull(); await act(async () => node!.click());
}
async function advanceCloseCycle() {
  await act(async () => {
    // JSDOM 不会生成 CSS 动画结束事件；沿真实关闭生命周期推进，而不绕过回调。
    for (const node of document.querySelectorAll(".ant-modal, .ant-modal-mask")) {
      node.dispatchEvent(new Event("animationend", { bubbles: true }));
      node.dispatchEvent(new Event("transitionend", { bubbles: true }));
    }
    await new Promise(resolve => setTimeout(resolve, 20));
  });
}
async function waitFor(condition: () => boolean) {
  const deadline = Date.now() + 1_500;
  while (!condition() && Date.now() < deadline) await advanceCloseCycle();
  expect(condition()).toBe(true);
}
describe("workspace preview focus after dialog cleanup", () => {
  it.each([image, svg].flatMap(preview => ["button", "Escape"].map(method => ({ preview, kind: preview.kind, method }))))(
    "restores $kind focus after $method closes its focus trap", async ({ preview, method }) => {
      await render(preview); await click(".cy-workspace-preview__zoom", host);
      expect(document.querySelector('[role="dialog"]')).not.toBeNull();
      if (method === "Escape") await act(async () => document.activeElement!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
      else await click(preview.kind === "svg" ? ".ant-modal-close" : ".cy-generated-image-preview__close");
      const trigger = host.querySelector(".cy-workspace-preview__zoom");
      await waitFor(() => !document.querySelector('[role="dialog"]') && document.activeElement === trigger);
    },
  );
  it("ignores an old SVG close callback after reopening and advancing its cycle", async () => {
    await render(); await click(".cy-workspace-preview__zoom", host);
    await click(".ant-modal-close");
    expect(closing.afterClose).toBeTypeOf("function");
    const oldClose = vi.fn(closing.afterClose!);
    await click(".cy-workspace-preview__zoom", host);
    const reopened = document.querySelector('[role="dialog"]')!;
    expect(reopened).not.toBeNull();
    await waitFor(() => reopened.contains(document.activeElement));
    const trigger = host.querySelector<HTMLElement>(".cy-workspace-preview__zoom")!;
    const focus = vi.spyOn(trigger, "focus");
    await advanceCloseCycle();
    await act(async () => { oldClose(); await new Promise(resolve => setTimeout(resolve, 20)); });
    await advanceCloseCycle();
    expect(oldClose).toHaveBeenCalledTimes(1);
    expect(document.querySelector('[role="dialog"]')).toBe(reopened);
    expect(reopened.isConnected).toBe(true);
    expect(reopened.contains(document.activeElement)).toBe(true);
    expect(focus).not.toHaveBeenCalled();
    await click(".ant-modal-close");
    await waitFor(() => !document.querySelector('[role="dialog"]') && document.activeElement === host.querySelector(".cy-workspace-preview__zoom"));
  });
  it("ignores the first close completion during a second close of the same SVG", async () => {
    await render(); await click(".cy-workspace-preview__zoom", host);
    await click(".ant-modal-close");
    expect(closing.afterClose).toBeTypeOf("function");
    const firstClose = vi.fn(closing.afterClose!);
    await click(".cy-workspace-preview__zoom", host);
    await waitFor(() => !!document.querySelector('[role="dialog"]')?.contains(document.activeElement));
    await click(".ant-modal-close");
    const secondClose = closing.afterClose!;
    const secondDialog = document.querySelector('[role="dialog"]');
    expect(secondDialog).not.toBeNull();
    expect(closing.completed).toHaveLength(0);
    expect(closing.completed).not.toContain(secondClose);
    const trigger = host.querySelector<HTMLElement>(".cy-workspace-preview__zoom")!;
    const focus = vi.spyOn(trigger, "focus");
    // 第二轮退出尚未完成时交付第一轮回调，不能把第二轮提前卸载或恢复焦点。
    await act(async () => { firstClose(); });
    expect(firstClose).toHaveBeenCalledTimes(1);
    expect(document.querySelector('[role="dialog"]')).toBe(secondDialog);
    expect(closing.completed).not.toContain(secondClose);
    expect(focus).not.toHaveBeenCalled();
    await waitFor(() => !document.querySelector('[role="dialog"]') && document.activeElement === trigger);
    expect(closing.completed).toContain(secondClose);
  });
  it("does not steal focus when a closing SVG is replaced by a new preview", async () => {
    await render(); await click(".cy-workspace-preview__zoom", host);
    await click(".ant-modal-close");
    expect(closing.afterClose).toBeTypeOf("function");
    const oldClose = vi.fn(closing.afterClose!);
    const replacement: WorkspacePreview = { kind: "svg", svg: '<svg xmlns="http://www.w3.org/2000/svg"><text>replacement</text></svg>' };
    const currentImage = () => decodeURIComponent(host.querySelector<HTMLImageElement>(".cy-workspace-preview__svg img")?.src ?? "");
    await render(replacement);
    await advanceCloseCycle();
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(currentImage()).toContain("<text>replacement</text>");
    const trigger = host.querySelector<HTMLElement>(".cy-workspace-preview__zoom")!;
    const focus = vi.spyOn(trigger, "focus");
    const canary = document.createElement("button"); document.body.append(canary);
    try {
      canary.focus();
      await act(async () => { oldClose(); await new Promise(resolve => setTimeout(resolve, 20)); });
      await advanceCloseCycle();
      expect(oldClose).toHaveBeenCalledTimes(1);
      expect(document.querySelector('[role="dialog"]')).toBeNull();
      expect(currentImage()).toContain("<text>replacement</text>");
      expect(document.activeElement).toBe(canary);
      expect(focus).not.toHaveBeenCalled();
    } finally { canary.remove(); }
  });
  it("removes a closing SVG immediately when its tab becomes inactive", async () => {
    await render(); await click(".cy-workspace-preview__zoom", host);
    await act(async () => {
      document.querySelector<HTMLElement>(".ant-modal-close")!.click();
      root.render(createElement(WorkspacePreviewContent, { preview: svg, active: false }));
    });
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    await render(); expect(document.querySelector('[role="dialog"]')).toBeNull();
  });
  it("does not focus a trigger removed while the SVG is closing", async () => {
    await render(); await click(".cy-workspace-preview__zoom", host);
    const trigger = host.querySelector<HTMLElement>(".cy-workspace-preview__zoom")!;
    const focus = vi.spyOn(trigger, "focus");
    await act(async () => { document.querySelector<HTMLElement>(".ant-modal-close")!.click(); trigger.remove(); });
    await waitFor(() => !document.querySelector('[role="dialog"]'));
    expect(focus).not.toHaveBeenCalled();
  });
});
