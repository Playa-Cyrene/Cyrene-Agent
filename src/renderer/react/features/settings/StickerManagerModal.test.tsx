// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import i18next from "i18next";
import { ConfigProvider } from "antd";
import type { StickerConfigItem } from "../../../../shared/sticker-types";
import { StickerManagerModal } from "./StickerManagerModal";

const builtin: StickerConfigItem = { id: "calm", src: "/stickers/calm.png", builtIn: true, enabled: true };
const custom: StickerConfigItem = { id: "cat", src: "local-sticker:///cat.png", builtIn: false, enabled: true };
let root: Root;
let host: HTMLDivElement;
let api: NonNullable<Window["stickerManager"]>;
let close: ReturnType<typeof vi.fn>;
beforeEach(async () => {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  window.matchMedia = vi.fn().mockReturnValue({ matches: false, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {} });
  await i18next.changeLanguage("zh-CN");
  api = {
    getConfig: vi.fn().mockResolvedValue([builtin, custom]),
    setEnabled: vi.fn().mockResolvedValue([builtin, { ...custom, enabled: false }]),
    deleteSticker: vi.fn().mockResolvedValue([builtin]),
  };
  window.stickerManager = api;
  host = document.createElement("div"); document.body.append(host);
  root = createRoot(host);
  close = vi.fn();
});
afterEach(async () => {
  await act(async () => root.unmount());
  document.body.innerHTML = "";
  delete window.stickerManager;
  vi.restoreAllMocks();
});
async function render(open = true) {
  await act(async () => root.render(<ConfigProvider theme={{ token: { motion: false } }}><StickerManagerModal open={open} onClose={close} /></ConfigProvider>));
}
async function click(element: Element) { await act(async () => (element as HTMLElement).click()); }
const remove = () => document.querySelector('[aria-label="删除 cat"]')!;
const confirm = () => document.querySelector(".ant-modal-confirm") ?? [...document.querySelectorAll(".ant-modal")].find(el => el.textContent?.includes("此操作不可撤销"))!;
const ok = () => confirm().querySelector(".ant-modal-footer .ant-btn-dangerous")!;
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

it("只给自定义项显示删除，确认说明历史图片影响，取消不发 IPC", async () => {
  await render();
  expect(document.querySelector('[aria-label="删除 calm"]')).toBeNull();
  expect(document.querySelector('[aria-label="切换 calm"]')).not.toBeNull();
  await click(remove());
  expect(confirm().textContent).toContain("历史聊天和动态");
  expect(confirm().textContent).toContain("cat");
  await click(confirm().querySelector(".ant-modal-footer .ant-btn-default")!);
  expect(api.deleteSticker).not.toHaveBeenCalled();
  expect(remove()).not.toBeNull();
});

it("成功使用主进程返回列表刷新，重开重新读取", async () => {
  await render(); await click(remove()); await click(ok());
  expect(api.deleteSticker).toHaveBeenCalledExactlyOnceWith("cat");
  expect(remove()).toBeNull();
  vi.mocked(api.getConfig).mockResolvedValue([builtin]);
  await render(false); await render(true);
  expect(remove()).toBeNull();
  expect(api.getConfig).toHaveBeenCalledTimes(2);
});

it("删除失败明确显示错误，保留原项且可重试", async () => {
  vi.mocked(api.deleteSticker).mockRejectedValueOnce(new Error("EPERM"));
  await render(); await click(remove()); await click(ok());
  expect(document.querySelector('[role="alert"]')?.textContent).toContain("删除失败：EPERM");
  expect(remove()).not.toBeNull();
  await click(remove()); await click(ok());
  expect(remove()).toBeNull();
});

it("同一事件循环重复确认只删除一次，禁用其他修改直到完成", async () => {
  const pending = deferred<StickerConfigItem[]>();
  vi.mocked(api.deleteSticker).mockReturnValue(pending.promise);
  await render(); await click(remove());
  await act(async () => { (ok() as HTMLElement).click(); (ok() as HTMLElement).click(); });
  expect(api.deleteSticker).toHaveBeenCalledOnce();
  expect([...document.querySelectorAll<HTMLButtonElement>('[role="switch"]')].every(el => el.disabled)).toBe(true);
  await click(document.querySelector('[aria-label="切换 calm"]')!);
  expect(api.setEnabled).not.toHaveBeenCalled();
  await act(async () => pending.resolve([builtin]));
  expect(remove()).toBeNull();
});

it("关闭会丢弃未提交的确认，重新打开不会自动删除", async () => {
  await render(); await click(remove());
  await render(false); await render(true);
  expect(api.deleteSticker).not.toHaveBeenCalled();
  expect(document.querySelectorAll(".ant-modal-footer .ant-btn-dangerous")).toHaveLength(0);
});

it("关闭重开丢弃旧加载响应", async () => {
  const old = deferred<StickerConfigItem[]>();
  vi.mocked(api.getConfig).mockReturnValueOnce(old.promise).mockResolvedValue([builtin]);
  await render(); await render(false); await render(true);
  await act(async () => old.resolve([builtin, custom]));
  expect(remove()).toBeNull();
});

it.each(["delete", "toggle"])("%s 未完成时重开，等待操作后读取且不接受旧列表", async kind => {
  const pending = deferred<StickerConfigItem[]>();
  if (kind === "delete") vi.mocked(api.deleteSticker).mockReturnValueOnce(pending.promise);
  else vi.mocked(api.setEnabled).mockReturnValueOnce(pending.promise);
  await render();
  if (kind === "delete") { await click(remove()); await click(ok()); }
  else await click(document.querySelector('[aria-label="切换 cat"]')!);
  vi.mocked(api.getConfig).mockResolvedValue([builtin]);
  await render(false); await render(true);
  expect(api.getConfig).toHaveBeenCalledOnce();
  await act(async () => pending.resolve([builtin, custom]));
  expect(api.getConfig).toHaveBeenCalledTimes(2);
  expect(remove()).toBeNull();
});

it("切换失败反馈错误且解除操作锁", async () => {
  vi.mocked(api.setEnabled).mockRejectedValueOnce(new Error("write failed"));
  await render(); await click(document.querySelector('[aria-label="切换 cat"]')!);
  expect(document.querySelector('[role="alert"]')?.textContent).toContain("更新失败");
  expect((remove() as HTMLButtonElement).disabled).toBe(false);
});

it.each([true, false])("关闭期间删除失败，重开仍显示错误（先重开：%s）", async reopenFirst => {
  const pending = deferred<StickerConfigItem[]>();
  vi.mocked(api.deleteSticker).mockReturnValueOnce(pending.promise);
  await render(); await click(remove()); await click(ok()); await render(false);
  if (reopenFirst) await render(true);
  await act(async () => pending.reject(new Error("EPERM")));
  if (!reopenFirst) await render(true);
  expect(remove()).not.toBeNull();
  expect(document.querySelector('[role="alert"]')?.textContent).toContain("删除失败：EPERM");
});

it("最后一项删除后展示空列表", async () => {
  vi.mocked(api.getConfig).mockResolvedValue([custom]);
  vi.mocked(api.deleteSticker).mockResolvedValue([]);
  await render(); await click(remove()); await click(ok());
  expect(document.querySelector(".cy-sticker-modal__empty")?.textContent).toBe("还没有表情包。");
});

it("读取失败或服务缺失显示错误，不将 undefined 当作删除成功", async () => {
  vi.mocked(api.getConfig).mockRejectedValueOnce(new Error("read failed"));
  await render();
  expect(document.querySelector('[role="alert"]')?.textContent).toContain("无法加载");
  await render(false); await render(true);
  vi.mocked(api.deleteSticker).mockResolvedValueOnce(undefined as any);
  await click(remove()); await click(ok());
  expect(document.querySelector('[role="alert"]')?.textContent).toContain("删除失败");
  expect(remove()).not.toBeNull();
  await render(false); delete window.stickerManager; await render(true);
  expect(document.querySelector('[role="alert"]')?.textContent).toContain("无法加载");
});
