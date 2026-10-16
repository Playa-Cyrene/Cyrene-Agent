// @vitest-environment jsdom
/**
 * 组件层对抗测试：只打既有测试没覆盖的路径。
 * 1) 大小写折叠改变长度时，<mark> 的切片位置会错位；
 * 2) 连续两次跳转之间必须彻底交还上一次的行；
 * 3) 跳转进行中卸载组件不得留下监听器或抛错；
 * 4) 索引规模变大时检索耗时不能失控。
 */
import React, { act, useRef, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import i18next from "i18next";
import { SettingsSearch } from "./SettingsSearch";
import type { SettingsSection } from "./AppearanceSettingsPage";
import { searchSettings, type SettingsSearchEntry } from "./settingsSearchIndex";

// 图标入口会连带引入浏览器专用 JSON；替身只绕开无关资源，不替换待测逻辑。
vi.mock("@lobehub/icons", () => {
  const Icon = Object.assign(() => null, { Color: () => null });
  return Object.fromEntries(["MCP", "Anthropic", "DeepSeek", "Doubao", "Gemini", "Grok", "Minimax", "Kimi", "OpenAI", "Qwen", "XiaomiMiMo", "Zhipu"].map((name) => [name, Icon]));
});
vi.mock("@lobehub/ui/icons", () => ({ Lark: () => null }));

const w = window as any;
let host: HTMLDivElement;
let root: Root;

function Harness({ initial = "toolToggle" }: { initial?: SettingsSection }) {
  const [section, setSection] = useState<SettingsSection>(initial);
  const content = useRef<HTMLElement>(null);
  return (
    <>
      <aside className="cy-settings-sidebar">
        <SettingsSearch section={section} onSelectSection={setSection} getContentRoot={() => content.current} />
      </aside>
      <main ref={content} data-section={section}>
        <div id="row-istanbul" className="tool-card" data-settings-search-kind="tool" data-settings-search-id="istanbul"><span className="tool-card__name">{"\u0130"}stanbul 模型</span></div>
        <div id="row-alpha" className="tool-card" data-settings-search-kind="tool" data-settings-search-id="alpha"><span className="tool-card__name">甲乙丙</span></div>
        <div id="row-beta" className="tool-card" data-settings-search-kind="tool" data-settings-search-id="beta"><span className="tool-card__name">丁戊己</span></div>
      </main>
    </>
  );
}

async function mount() {
  await act(async () => { root.render(<Harness />); });
}
async function advance(ms: number) { await act(async () => { await vi.advanceTimersByTimeAsync(ms); }); }
function input() { return host.querySelector<HTMLInputElement>("input.cy-settings-search__input")!; }
async function fill(value: string) {
  await act(async () => {
    input().focus();
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input(), value);
    input().dispatchEvent(new Event("input", { bubbles: true }));
  });
}
function marks() { return [...host.querySelectorAll("mark")].map((node) => node.textContent); }
async function pick(label: string) {
  const row = [...host.querySelectorAll<HTMLButtonElement>(".cy-settings-search__item")]
    .find((node) => node.querySelector(".cy-settings-search__item-label")?.textContent === label);
  expect(row, `结果里应有 ${label}`).toBeTruthy();
  await act(async () => { row!.click(); });
}

beforeEach(async () => {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  w.matchMedia = () => ({ matches: false, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {} });
  (globalThis as any).ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
  w.scrollTo = vi.fn();
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "requestAnimationFrame", "cancelAnimationFrame", "performance"] });
  await i18next.changeLanguage("zh-CN");
  const items = [
    { id: "istanbul", name: "İstanbul 模型", description: "土耳其语", enabled: true },
    { id: "alpha", name: "甲乙丙", description: "第一组", enabled: true },
    { id: "beta", name: "丁戊己", description: "第二组", enabled: true },
  ];
  w.plugins = { list: async () => ({ plugins: [], issues: [] }) };
  w.settings = { getToolCatalog: async () => items, getSkillCatalog: async () => [], getToolModeOverrides: async () => ({}), getGeneral: async () => ({}) };
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => { root.unmount(); });
  host.remove();
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.restoreAllMocks();
  delete w.plugins;
  delete w.settings;
});

describe("高亮切片位置", () => {
  it("大小写折叠会加长文本时，mark 必须仍然等于用户输入的子串", async () => {
    await mount();
    // İ 的小写是 i + 组合点，长度 +1；若按小写串的下标去切原串，标注就会整体偏一位。
    await fill("stanbul");
    expect(marks(), `实际标注 ${JSON.stringify(marks())}`).toEqual(["stanbul"]);
  });

  it("前后空白的查询应正常命中且只标注词本身", async () => {
    await mount();
    await fill("  甲乙  ");
    expect(marks()).toEqual(["甲乙"]);
  });
});

describe("连续跳转的交接", () => {
  it("第二次跳转必须彻底清掉第一次行的闪烁类", async () => {
    await mount();
    await fill("甲乙丙");
    await pick("甲乙丙");
    await advance(500);
    expect(host.querySelector("#row-alpha")!.classList.contains("cy-settings-search-flash-host")).toBe(true);
    await fill("丁戊己");
    await pick("丁戊己");
    await advance(500);
    const first = host.querySelector("#row-alpha")!;
    const second = host.querySelector("#row-beta")!;
    expect(first.classList.contains("cy-settings-search-flash"), "上一行的闪烁必须结束").toBe(false);
    expect(first.classList.contains("cy-settings-search-flash-host"), "上一行的过渡类必须移除").toBe(false);
    expect(second.classList.contains("cy-settings-search-flash-host")).toBe(true);
  });

  it("一次跳转超时释放后，下一次正常跳转仍要能闪", async () => {
    await mount();
    // 目标卡片不在当前页面上：查找会耗尽 5 秒超时后干净释放，不能卡死后续跳转
    await fill("丁戊己");
    await pick("丁戊己");
    await advance(6000);
    expect(host.querySelector("#row-beta")!.classList.contains("cy-settings-search-flash-host"), "超时后不应残留过渡类").toBe(false);
    await fill("甲乙丙");
    await pick("甲乙丙");
    await advance(500);
    expect(host.querySelector("#row-alpha")!.classList.contains("cy-settings-search-flash-host")).toBe(true);
  });

  it("跳转进行中卸载组件不抛错且不再改 DOM", async () => {
    await mount();
    await fill("丁戊己");
    await pick("丁戊己");
    await advance(80);
    const target = host.querySelector("#row-beta")!;
    await act(async () => { root.unmount(); });
    await expect(advance(6000)).resolves.toBeUndefined();
    expect(target.classList.contains("cy-settings-search-flash")).toBe(false);
    expect(target.classList.contains("cy-settings-search-flash-host")).toBe(false);
  });

});

describe("规模", () => {
  it("两万条索引时单次检索仍在一帧内完成", () => {
    const many: SettingsSearchEntry[] = Array.from({ length: 20000 }, (_, index) => ({
      kind: "tool" as const, section: "toolToggle" as const, label: `工具 ${index} 名称`, itemId: `t${index}`,
    }));
    const started = Date.now();
    const hits = searchSettings(many, "名称", 40);
    expect(Date.now() - started).toBeLessThan(120);
    expect(hits.length).toBe(40);
  });
});
