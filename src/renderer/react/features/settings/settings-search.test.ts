// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { searchSettings, settingsSearchIndex } from "./settings-search-index";
import { readSearchHistory, rememberSearch, SETTINGS_SEARCH_HISTORY_KEY, writeSearchHistory } from "./settings-search-history";
import { locateSettingsSearchTarget } from "./settings-search-navigation";
import en from "../../i18n/en.json";
import ja from "../../i18n/ja-JP.json";
import zh from "../../i18n/zh-CN.json";

const translate = (resource: unknown) => (key: string): string => key.split(".").reduce((value: any, part) => value?.[part], resource) ?? key;

afterEach(() => { localStorage.clear(); vi.restoreAllMocks(); vi.useRealTimers(); document.body.innerHTML = ""; });

describe("设置搜索", () => {
  it("按当前语言标签搜索，支持多个关键词和分类筛选", () => {
    const key = "settingsPage.messageFontSize";
    for (const resource of [zh, en, ja]) {
      const t = translate(resource);
      expect(searchSettings(t(key), t).some((item) => item.id === key)).toBe(true);
    }
    expect(searchSettings("FONT SIZE", translate(en)).some((item) => item.id === key)).toBe(true);
    const voice = searchSettings("", translate(zh), "voice");
    expect(voice.length).toBeGreaterThan(2);
    expect(voice.some((item) => item.id === "section:asr")).toBe(true);
    expect(voice.every((item) => item.category === "voice")).toBe(true);
    expect(searchSettings("no-such-setting-123", translate(en))).toEqual([]);
  });

  it("所有索引项均有三语翻译，具体项目在源面板中有稳定定位标记", () => {
    expect(new Set(settingsSearchIndex.map((item) => item.id)).size).toBe(settingsSearchIndex.length);
    for (const item of settingsSearchIndex) {
      for (const resource of [zh, en, ja]) {
        expect(translate(resource)(item.titleKey), item.titleKey).not.toBe(item.titleKey);
        expect(translate(resource)(item.sectionKey), item.sectionKey).not.toBe(item.sectionKey);
      }
      if (!item.id.startsWith("section:")) {
        expect(readFileSync(resolve(item.source), "utf8")).toContain(`data-settings-search-id="${item.id}"`);
      }
    }
  });

  it("历史可恢复并去重，重复搜索移到首位且最多保存三十条", () => {
    let history: string[] = [];
    for (let i = 0; i < 35; i++) history = rememberSearch(history, `query-${i}`);
    history = rememberSearch(history, " query-10 ");
    writeSearchHistory(history);
    const restored = readSearchHistory();
    expect(restored).toHaveLength(30);
    expect(restored[0]).toBe("query-10");
    expect(restored.filter((entry) => entry === "query-10")).toHaveLength(1);
    expect(restored).not.toContain("query-0");
    writeSearchHistory(restored.filter((entry) => entry !== "query-10"));
    expect(readSearchHistory()).not.toContain("query-10");
    writeSearchHistory([]);
    expect(readSearchHistory()).toEqual([]);
  });

  it("历史损坏或存储不可用时不阻断搜索", () => {
    localStorage.setItem(SETTINGS_SEARCH_HISTORY_KEY, "broken json");
    expect(readSearchHistory()).toEqual([]);
    localStorage.setItem(SETTINGS_SEARCH_HISTORY_KEY, JSON.stringify([null, 12, "", " a ", "a", "b"]));
    expect(readSearchHistory()).toEqual(["a", "b"]);
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => { throw new Error("denied"); });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("full"); });
    expect(readSearchHistory()).toEqual([]);
    expect(() => writeSearchHistory(["a"])).not.toThrow();
  });

  it("等待异步目标挂载，离开页面后取消待执行定位", async () => {
    vi.useFakeTimers();
    const scroll = vi.fn();
    vi.spyOn(HTMLElement.prototype, "getClientRects").mockReturnValue([{}] as unknown as DOMRectList);
    HTMLElement.prototype.scrollIntoView = scroll;
    const container = document.createElement("div");
    const unavailable = vi.fn();
    const dispose = locateSettingsSearchTarget(container, "font", unavailable);
    container.innerHTML = '<div class="cy-settings-row"><strong data-settings-search-id="font">Font</strong></div>';
    await Promise.resolve();
    expect(scroll).toHaveBeenCalledOnce();
    expect(container.querySelector(".cy-settings-search-highlight")).not.toBeNull();
    dispose();
    expect(container.querySelector(".cy-settings-search-highlight")).toBeNull();
    const cancel = locateSettingsSearchTarget(container, "missing", unavailable);
    cancel();
    await vi.advanceTimersByTimeAsync(4000);
    expect(unavailable).not.toHaveBeenCalled();
  });

  it("定位提示每次五百毫秒，重复三次后清理且不改变设置内容", async () => {
    vi.useFakeTimers();
    vi.spyOn(HTMLElement.prototype, "getClientRects").mockReturnValue([{}] as unknown as DOMRectList);
    HTMLElement.prototype.scrollIntoView = vi.fn();
    const container = document.createElement("div");
    container.innerHTML = '<div class="cy-settings-row"><strong data-settings-search-id="font">Font</strong><input value="15" /></div>';
    const unavailable = vi.fn();
    const dispose = locateSettingsSearchTarget(container, "font", unavailable);
    const row = container.firstElementChild!;
    expect(row.classList.contains("cy-settings-search-highlight")).toBe(true);
    expect(row.classList.contains("cy-settings-search-highlight--item")).toBe(true);
    await vi.advanceTimersByTimeAsync(1499);
    expect(row.classList.contains("cy-settings-search-highlight")).toBe(true);
    await vi.advanceTimersByTimeAsync(1);
    expect(row.classList.contains("cy-settings-search-highlight")).toBe(false);
    expect(row.classList.contains("cy-settings-search-highlight--item")).toBe(false);
    expect(container.querySelector("input")!.value).toBe("15");
    await vi.advanceTimersByTimeAsync(3000);
    expect(unavailable).not.toHaveBeenCalled();
    expect(row.classList.contains("cy-settings-search-highlight")).toBe(false);
    dispose();
  });

  it("仅高亮分组卡片内的目标项目或模型字段，不影响相邻项目", () => {
    vi.spyOn(HTMLElement.prototype, "getClientRects").mockReturnValue([{}] as unknown as DOMRectList);
    HTMLElement.prototype.scrollIntoView = vi.fn();
    const container = document.createElement("div");
    container.innerHTML = '<div class="cy-shadcn-card"><div class="cy-settings-row"><strong data-settings-search-id="one">One</strong></div><div class="cy-settings-row"><strong data-settings-search-id="two">Two</strong></div></div><label class="cy-model-field"><span data-settings-search-id="model">Model</span><input /></label>';
    const dispose = locateSettingsSearchTarget(container, "two", vi.fn());
    const card = container.firstElementChild!;
    expect(card.classList.contains("cy-settings-search-highlight")).toBe(false);
    expect(card.children[0].classList.contains("cy-settings-search-highlight")).toBe(false);
    expect(card.children[1].classList.contains("cy-settings-search-highlight--item")).toBe(true);
    dispose();
    expect(container.querySelector(".cy-settings-search-highlight--item")).toBeNull();
    const disposeModel = locateSettingsSearchTarget(container, "model", vi.fn());
    expect(container.querySelector("label")!.classList.contains("cy-settings-search-highlight--item")).toBe(true);
    disposeModel();
  });

  it("条件项目未显示时报告不可用，不自动修改设置开关", async () => {
    vi.useFakeTimers();
    const container = document.createElement("div");
    container.innerHTML = "<h1>Speech</h1>";
    HTMLElement.prototype.scrollIntoView = vi.fn();
    const unavailable = vi.fn();
    const dispose = locateSettingsSearchTarget(container, "disabled-option", unavailable);
    await vi.advanceTimersByTimeAsync(3000);
    expect(unavailable).toHaveBeenCalledOnce();
    dispose();
  });
});

// 从定位标记反查索引，保证已标记的界面项目不会静默漏收录。
it("所有定位标记均在索引中登记，两个遗漏设置可按名称搜索", () => {
  const ids = new Set(settingsSearchIndex.map((item) => item.id));
  for (const source of new Set(settingsSearchIndex.map((item) => item.source))) {
    const content = readFileSync(resolve(source), "utf8");
    for (const match of content.matchAll(/data-settings-search-id="([^"]+)"/g)) expect(ids.has(match[1]), match[1]).toBe(true);
  }
  for (const key of ["settingsPage.general.dataDir", "settingsPage.browserControl.viewportMode"]) {
    expect(searchSettings(translate(zh)(key), translate(zh)).some((item) => item.id === key)).toBe(true);
  }
  expect(ids.has("settingsPage.usage.emptyTitle")).toBe(false);
});

it("面板加载超过三秒仍可定位，完成加载后缺失目标立即提示且不高亮标题", async () => {
  vi.useFakeTimers();
  vi.spyOn(HTMLElement.prototype, "getClientRects").mockReturnValue([{}] as unknown as DOMRectList);
  HTMLElement.prototype.scrollIntoView = vi.fn();
  const container = document.createElement("div");
  container.innerHTML = '<h1 data-settings-search-loading="true">Speech</h1>';
  const unavailable = vi.fn();
  const dispose = locateSettingsSearchTarget(container, "late", unavailable);
  await vi.advanceTimersByTimeAsync(4000);
  expect(unavailable).not.toHaveBeenCalled();
  container.innerHTML = '<h1 data-settings-search-loading="false">Speech</h1><strong data-settings-search-id="late">Late</strong>';
  await Promise.resolve();
  expect(container.querySelector("strong")?.classList.contains("cy-settings-search-highlight")).toBe(true);
  dispose();
  const missing = locateSettingsSearchTarget(container, "hidden", unavailable);
  expect(unavailable).toHaveBeenCalledOnce();
  expect(container.querySelector(".cy-settings-search-highlight")).toBeNull();
  expect(container.querySelector("h1")?.className).toBe("");
  missing();
});

it("未声明加载状态的面板超时只报告不可用，不把页面标题当作成功目标", async () => {
  vi.useFakeTimers();
  const container = document.createElement("div"); container.innerHTML = "<h1>Page</h1>";
  const unavailable = vi.fn();
  const dispose = locateSettingsSearchTarget(container, "missing", unavailable);
  await vi.advanceTimersByTimeAsync(3000);
  expect(unavailable).toHaveBeenCalledOnce();
  expect(container.querySelector(".cy-settings-search-highlight")).toBeNull();
  dispose();
});

it("搜索动画样式保持百毫秒双向入场和三次半秒闪烁", () => {
  const css = readFileSync(resolve("src/renderer/react/features/settings/SettingsSearchDialog.css"), "utf8");
  expect(css).toMatch(/animation: cy-settings-search-enter 100ms/);
  expect(css).toMatch(/data-direction="back"[^}]*--search-enter-x: -28px/);
  expect(css).toMatch(/animation: cy-settings-search-flash 500ms ease-in-out 3/);
  expect(css).toMatch(/animation-name: cy-settings-search-item-flash/);
  expect(css).toMatch(/prefers-reduced-motion: reduce/);
});


it("固定设置行的标题不能在新增时漏出索引，动态重复行显式排除", () => {
  const indexed = new Set(settingsSearchIndex.map((item) => item.titleKey));
  // 搜索密钥包含供应商参数；频道开关在多个频道重复，需要复合身份后才能索引。
  const dynamicRows = new Set(["settingsPage.tools.searchKey", "settingsPage.channels.enableChannel", "settingsPage.channels.qqbot.allowAnyPrivate"]);
  for (const source of new Set(settingsSearchIndex.map((item) => item.source))) {
    const content = readFileSync(resolve(source), "utf8");
    const rows = content.matchAll(/className="cy-settings-row__copy"><strong[^>]*>(?:<[^>]+\/>)?\{t\("([^"]+)"/g);
    for (const match of rows) expect(indexed.has(match[1]) || dynamicRows.has(match[1]), match[1]).toBe(true);
  }
});
