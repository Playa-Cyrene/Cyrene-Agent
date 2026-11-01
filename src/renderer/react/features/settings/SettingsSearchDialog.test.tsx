// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import i18next from "i18next";
import { SettingsSearchDialog } from "./SettingsSearchDialog";
import { readSearchHistory, writeSearchHistory } from "./settings-search-history";

let root: Root;
let host: HTMLDivElement;
let select: ReturnType<typeof vi.fn>;
let close: ReturnType<typeof vi.fn>;
beforeEach(async () => {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
  window.matchMedia = vi.fn().mockImplementation(() => ({ matches: false, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {} }));
  HTMLElement.prototype.scrollIntoView = vi.fn();
  localStorage.clear();
  await i18next.changeLanguage("zh-CN");
  host = document.createElement("div"); document.body.append(host);
  root = createRoot(host); select = vi.fn(); close = vi.fn();
});
afterEach(async () => {
  await act(async () => root.unmount());
  document.body.innerHTML = ""; localStorage.clear(); vi.unstubAllGlobals();
});
async function render(open = true) {
  await act(async () => root.render(<SettingsSearchDialog open={open} onClose={close} onSelect={select} />));
}
async function click(element: Element) { await act(async () => (element as HTMLElement).click()); }
async function fill(value: string) {
  const input = document.querySelector("input")!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
it("每次只显示当前层的列表项目，返回按钮逐层回退", async () => {
  await render();
  const categories = document.querySelectorAll(".cy-settings-search__categories button");
  expect(categories).toHaveLength(5);
  await click(categories[3]);
  expect(document.querySelector(".cy-settings-search__back")?.textContent).toBe("搜索设置\\语音能力");
  const rows = () => [...document.querySelectorAll("[role=option]")];
  expect(rows().map(node => node.textContent)).toEqual([i18next.t("settingsPage.tts.title"), i18next.t("settingsPage.asr.title")]);
  (document.querySelector(".cy-settings-search__results") as HTMLElement).scrollTop = 120;
  await click(rows()[0]);
  expect(document.querySelector(".cy-settings-search__results")?.scrollTop).toBe(0);
  expect(select).not.toHaveBeenCalled();
  expect(close).not.toHaveBeenCalled();
  expect(document.querySelector(".cy-settings-search__back")?.textContent).toBe("搜索设置\\语音能力\\语音合成");
  expect(document.querySelector(".cy-settings-search__row-content")?.getAttribute("data-direction")).toBe("forward");
  expect(rows().map(node => node.textContent)).toContain(i18next.t("settingsPage.tts.autoReadTitle"));
  expect(rows().map(node => node.textContent)).not.toContain(i18next.t("settingsPage.asr.title"));
  expect(document.querySelector(".cy-settings-search__back")?.textContent).toContain(i18next.t("settingsPage.tts.title"));
  expect(document.querySelectorAll("[aria-expanded=true]:not(input)")).toHaveLength(0);
  expect(document.querySelectorAll(".cy-settings-search__results small")).toHaveLength(0);
  await click(document.querySelector(".cy-settings-search__back")!);
  expect(rows()).toHaveLength(2);
  expect(document.querySelector(".cy-settings-search__back")?.textContent).toBe("搜索设置\\语音能力");
  expect(document.querySelector(".cy-settings-search__row-content")?.getAttribute("data-direction")).toBe("back");
  await click(document.querySelector(".cy-settings-search__back")!);
  expect(document.querySelectorAll(".cy-settings-search__categories button")).toHaveLength(5);
  expect(document.querySelector(".cy-settings-search__categories button")?.getAttribute("data-direction")).toBe("back");
});
it("回车进入下一层，仅选择具体设置项时跳转", async () => {
  writeSearchHistory(["existing search"]);
  await render();
  await click(document.querySelectorAll(".cy-settings-search__categories button")[3]);
  await act(async () => document.querySelector("input")!.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true })));
  expect(select).not.toHaveBeenCalled();
  const leaf = [...document.querySelectorAll("[role=option]")].find(node => node.textContent === i18next.t("settingsPage.tts.autoReadTitle"))!;
  await click(leaf);
  expect(select).toHaveBeenCalledWith(expect.objectContaining({ id: "settingsPage.tts.autoReadTitle", section: "tts" }));
  expect(close).toHaveBeenCalledOnce();
  expect(readSearchHistory()).toEqual(["existing search"]);
  await render(false); await render(true);
  await click(document.querySelectorAll(".cy-settings-search__categories button")[3]);
  expect([...document.querySelectorAll("[role=option]")].map(node => node.textContent)).toEqual([i18next.t("settingsPage.tts.title"), i18next.t("settingsPage.asr.title")]);
});
it("关键词只搜索当前页面，清空后恢复当前层级", async () => {
  await render();
  await click(document.querySelectorAll(".cy-settings-search__categories button")[3]);
  await click(document.querySelector("[role=option]")!);
  await fill(i18next.t("settingsPage.tts.autoReadTitle"));
  expect(document.querySelectorAll("[role=option]")).toHaveLength(1);
  await fill(i18next.t("settingsPage.asr.vadThreshold"));
  expect(document.querySelectorAll("[role=option]")).toHaveLength(0);
  await fill("");
  const titles = [...document.querySelectorAll("[role=option]")].map(node => node.textContent);
  expect(titles).toContain(i18next.t("settingsPage.tts.autoReadTitle"));
  expect(titles).not.toContain(i18next.t("settingsPage.asr.title"));
  expect(document.querySelector("input")?.getAttribute("aria-activedescendant")).toBe("settings-search-result-0");
});
it("没有登记子项的页面可直接打开", async () => {
  await render();
  await click(document.querySelectorAll(".cy-settings-search__categories button")[4]);
  await click(document.querySelector("[role=option]")!);
  expect(select).toHaveBeenCalledWith(expect.objectContaining({ id: "section:disclaimer" }));
  expect(readSearchHistory()).toEqual([]);
});
it("方向键接管鼠标悬停项，鼠标实际移动后才恢复鼠标选择", async () => {
  await render();
  await click(document.querySelectorAll(".cy-settings-search__categories button")[3]);
  const input = document.querySelector("input")!;
  expect(document.activeElement).toBe(input);
  const rows = [...document.querySelectorAll<HTMLElement>("[role=option]")];
  const move = async (x: number) => {
    await act(async () => rows[1].dispatchEvent(new MouseEvent("mousemove", { bubbles: true, clientX: x, clientY: 80 })));
  };
  await move(50);
  expect(rows[1].getAttribute("aria-selected")).toBe("true");
  await act(async () => input.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowUp", bubbles: true, cancelable: true })));
  expect(rows[0].getAttribute("aria-selected")).toBe("true");
  expect(input.getAttribute("aria-activedescendant")).toBe(rows[0].id);
  await move(50); // 静止鼠标下的布局或滚动事件不能抢回键盘选择。
  expect(rows[0].getAttribute("aria-selected")).toBe("true");
  await move(51);
  expect(rows[1].getAttribute("aria-selected")).toBe("true");
  expect(document.querySelectorAll("[role=option].is-active")).toHaveLength(1);
  expect(input.getAttribute("aria-activedescendant")).toBe(rows[1].id);
});
it("结果按钮获得焦点后仍可用方向键切换，回车选择与高亮同步", async () => {
  await render();
  await click(document.querySelectorAll(".cy-settings-search__categories button")[3]);
  const rows = [...document.querySelectorAll<HTMLElement>("[role=option]")];
  await act(async () => rows[0].focus());
  await act(async () => rows[0].dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true, cancelable: true })));
  const input = document.querySelector("input")!;
  expect(document.activeElement).toBe(input);
  expect(rows[1].getAttribute("aria-selected")).toBe("true");
  await act(async () => input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true })));
  expect(document.querySelector(".cy-settings-search__back")?.textContent).toBe("搜索设置\\语音能力\\语音识别");
  expect(select).not.toHaveBeenCalled();
});
it("分类内关键词搜索计入历史，清空关键词后浏览项目不写入历史", async () => {
  await render();
  await click(document.querySelectorAll(".cy-settings-search__categories button")[3]);
  await click(document.querySelector("[role=option]")!);
  const keyword = i18next.t("settingsPage.tts.autoReadTitle");
  await fill(keyword);
  await click(document.querySelector("[role=option]")!);
  expect(readSearchHistory()).toEqual([keyword]);
  await render(false); await render(true);
  await click(document.querySelectorAll(".cy-settings-search__categories button")[3]);
  await click(document.querySelector("[role=option]")!);
  await fill(i18next.t("settingsPage.tts.volumeTitle"));
  await fill("   ");
  await click(document.querySelector("[role=option]")!);
  expect(readSearchHistory()).toEqual([keyword]);
});
it("回车选择搜索结果后保存关键词并关闭弹窗", async () => {
  await render(); await fill(i18next.t("settingsPage.messageFontSize"));
  await act(async () => document.querySelector("input")!.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true })));
  expect(select).toHaveBeenCalledWith(expect.objectContaining({ id: "settingsPage.messageFontSize", section: "appearance" }));
  expect(close).toHaveBeenCalledOnce();
  expect(readSearchHistory()).toEqual([i18next.t("settingsPage.messageFontSize")]);
});
it("具体匹配项上方仅显示一次所属页，辅助技术选中项与键盘一致", async () => {
  await render(); await fill(i18next.t("settingsPage.messageFontSize"));
  expect(document.querySelector(".cy-settings-search__section")?.textContent).toBe(i18next.t("settingsPage.appearance"));
  expect(document.querySelectorAll("[role=option]")).toHaveLength(1);
  expect(document.querySelector("[role=option]")?.textContent).toBe(i18next.t("settingsPage.messageFontSize"));
  expect(document.querySelector("input")?.getAttribute("aria-activedescendant")).toBe("settings-search-result-0");
});
it("输入法组合期间不选择结果，无匹配时显示空状态", async () => {
  await render(); await fill(i18next.t("settingsPage.messageFontSize"));
  await act(async () => document.querySelector("input")!.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", isComposing: true, bubbles: true })));
  expect(select).not.toHaveBeenCalled();
  await fill("not-a-setting-987");
  expect(document.querySelectorAll("[role=option]")).toHaveLength(0);
  expect(document.querySelector("[role=status]")?.textContent).toBe(i18next.t("settingsSearch.empty"));
});
it("恢复历史并支持单条删除，重新打开时清空查询", async () => {
  writeSearchHistory(["one", "two"]); await render();
  await click(document.querySelector(".cy-settings-search__history-heading button")!);
  await click(document.querySelector(".cy-settings-search__delete")!);
  expect(readSearchHistory()).toEqual(["two"]);
  await fill("temporary"); await render(false); await render(true);
  expect(document.querySelector<HTMLInputElement>("input")?.value).toBe("");
  expect(document.querySelectorAll(".cy-settings-search__categories button")).toHaveLength(5);
});
it("清空历史需要确认，取消后保留原记录", async () => {
  writeSearchHistory(["one", "two"]); await render();
  await click(document.querySelector(".cy-settings-search__history-heading button")!);
  const clear = () => document.querySelector(`[aria-label="${i18next.t("settingsSearch.clear")}"]`)!;
  await click(clear());
  expect(readSearchHistory()).toEqual(["one", "two"]);
  const confirmation = () => [...document.querySelectorAll(".ant-modal")].find(node => node.textContent?.includes(i18next.t("settingsSearch.clearConfirm")))!;
  await click(confirmation().querySelector(".ant-modal-footer .ant-btn-default")!);
  expect(readSearchHistory()).toEqual(["one", "two"]);
  await click(clear());
  await click(confirmation().querySelector(".ant-btn-dangerous")!);
  expect(readSearchHistory()).toEqual([]);
});
