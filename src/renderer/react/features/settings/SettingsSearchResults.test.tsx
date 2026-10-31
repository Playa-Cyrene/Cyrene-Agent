// @vitest-environment jsdom
import React, { act, createRef } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { SettingsSearchResults } from "./SettingsSearchResults";
import type { SettingsSearchItem } from "./settings-search-index";

let root: Root;
let host: HTMLDivElement;
let observer: { callback: IntersectionObserverCallback; options: IntersectionObserverInit; unobserve: ReturnType<typeof vi.fn>; disconnect: ReturnType<typeof vi.fn> };
let now: number;
const container = createRef<HTMLDivElement>();
const items: SettingsSearchItem[] = Array.from({ length: 20 }, (_, index) => ({
  id: `item-${index}`, section: "appearance", category: "basic", titleKey: `Title ${index}`, sectionKey: "Appearance", source: "",
}));

beforeEach(() => {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  now = 1000;
  vi.spyOn(performance, "now").mockImplementation(() => now);
  vi.stubGlobal("IntersectionObserver", class {
    callback: IntersectionObserverCallback;
    options: IntersectionObserverInit;
    observe = vi.fn(); unobserve = vi.fn(); disconnect = vi.fn();
    constructor(callback: IntersectionObserverCallback, options: IntersectionObserverInit) {
      this.callback = callback; this.options = options; observer = this;
    }
  });
  HTMLElement.prototype.scrollIntoView = vi.fn();
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove(); vi.restoreAllMocks(); vi.unstubAllGlobals();
});
async function render(active = 0, direction: "forward" | "back" = "forward") {
  await act(async () => root.render(<SettingsSearchResults items={items} active={active} browsing direction={direction}
    containerRef={container} translate={(key) => key} onActivate={vi.fn()} onActiveChange={vi.fn()} />));
}
async function visible(indices: number[]) {
  await act(async () => observer.callback(indices.map((index) => ({
    target: host.querySelector(`[data-search-row="${index}"]`)!, isIntersecting: true, intersectionRatio: 1,
  } as IntersectionObserverEntry)), {} as IntersectionObserver));
}
const content = (index: number) => host.querySelector<HTMLElement>(`[data-search-row="${index}"] .cy-settings-search__row-content`)!;

it("mounts only visible content, orders the entry queue top to bottom and spaces rows by 50ms", async () => {
  await render();
  expect(observer.options.root).toBe(container.current);
  expect(host.querySelectorAll("[role=option]")).toHaveLength(1);
  expect(content(10)).toBeNull();
  await visible([2, 0, 1]);
  expect(host.querySelectorAll("[role=option]")).toHaveLength(3);
  expect([0, 1, 2].map((index) => content(index).style.animationDelay)).toEqual(["0ms", "50ms", "100ms"]);
  now = 1700;
  await visible([8, 7]);
  expect(content(7).style.animationDelay).toBe("0ms");
  expect(content(8).style.animationDelay).toBe("50ms");
  expect(content(6)).toBeNull();
});
it("retains completed rows on repeat visibility and does not restart their animations", async () => {
  await render(); await visible([1]);
  await act(async () => {
    for (const name of ["animationend", "webkitAnimationEnd"]) content(1).dispatchEvent(new Event(name, { bubbles: true }));
  });
  expect(content(1).classList.contains("is-entering")).toBe(false);
  const original = content(1);
  now = 2000; await visible([1, 2]);
  expect(content(1)).toBe(original);
  expect(content(1).classList.contains("is-entering")).toBe(false);
  expect(content(2).classList.contains("is-entering")).toBe(true);
});
it("loads and scrolls to an offscreen keyboard target, preserving its full-list position", async () => {
  await render(); await render(19);
  expect(content(19)).not.toBeNull();
  expect(host.querySelector("[data-result-index='19']")?.getAttribute("aria-posinset")).toBe("20");
  expect(host.querySelector("[data-result-index='19']")?.getAttribute("aria-setsize")).toBe("20");
  expect(HTMLElement.prototype.scrollIntoView).toHaveBeenCalledWith({ block: "nearest" });
  expect(content(18)).toBeNull();
});
it("uses reverse direction on return and disconnects viewport observers on departure", async () => {
  await render(0, "back");
  expect(content(0).dataset.direction).toBe("back");
  const previous = observer;
  await act(async () => root.render(<div>Another page</div>));
  expect(previous.disconnect).toHaveBeenCalledOnce();
  await visible([1]);
  expect(host.textContent).toBe("Another page");
});
