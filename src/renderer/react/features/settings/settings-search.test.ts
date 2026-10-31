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

describe("settings search", () => {
  it("uses translated labels, supports multiple words and category filtering", () => {
    const key = "settingsPage.messageFontSize";
    for (const resource of [zh, en, ja]) {
      const t = translate(resource);
      expect(searchSettings(t(key), t).some((item) => item.id === key)).toBe(true);
    }
    expect(searchSettings("FONT SIZE", translate(en)).some((item) => item.id === key)).toBe(true);
    expect(searchSettings("", translate(zh), "voice").every((item) => item.category === "voice")).toBe(true);
    expect(searchSettings("no-such-setting-123", translate(en))).toEqual([]);
  });

  it("every indexed item has translations and a stable target in its source", () => {
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

  it("restores history, removes duplicates, moves repeats to front and saves only 30 records", () => {
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

  it("handles corrupt records and unavailable storage", () => {
    localStorage.setItem(SETTINGS_SEARCH_HISTORY_KEY, "broken json");
    expect(readSearchHistory()).toEqual([]);
    localStorage.setItem(SETTINGS_SEARCH_HISTORY_KEY, JSON.stringify([null, 12, "", " a ", "a", "b"]));
    expect(readSearchHistory()).toEqual(["a", "b"]);
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => { throw new Error("denied"); });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("full"); });
    expect(readSearchHistory()).toEqual([]);
    expect(() => writeSearchHistory(["a"])).not.toThrow();
  });

  it("waits for asynchronous rendering and cancels pending navigation on departure", async () => {
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

  it("removes the row highlight after three 500ms cycles without changing its content", async () => {
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

  it("highlights only the selected item inside a multi-item card, including model fields", () => {
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

  it("reports unavailable conditional items without toggling settings", async () => {
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
