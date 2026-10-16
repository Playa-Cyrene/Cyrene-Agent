// @vitest-environment jsdom
/**
 * 端到端可达性矩阵（第 7 轮独立复测新增）：
 * 真实挂载 AppearanceSettingsPage，对 zh-CN 静态索引的每一条目，通过真实 SettingsSearch
 * 输入标题 → 点击结果 → 推进计时器，验证"目标存在则必闪、且闪在携带正确身份/文本的行上；
 * 目标不存在则不得误闪"；同时输出无法定位的条目及其原因，供产品决策与人工核对。
 * 这是与定位规则同口径的兼容性扫描，不能作为独立正确性证明，也不能证明未挂载分支正常。
 * 独立业务预期与明确数据条件由 SettingsSearch.independent.test.tsx 验证。
 */
import React, { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import i18next from "i18next";
import { AppearanceSettingsPage, type SettingsSection } from "./AppearanceSettingsPage";
import { SETTINGS_NAV_ITEMS } from "./settingsNavItems";
import { buildSettingEntries, type SettingsSearchEntry } from "./settingsSearchIndex";
import { AppProviders } from "../../app/providers/AppProviders";
import zh from "../../i18n/zh-CN.json";

// 图标入口间接导入浏览器专用 JSON；替身仅绕开无关资源，不替换待测面板。
vi.mock("@lobehub/icons", () => {
  const Icon = Object.assign(() => null, { Color: () => null });
  return Object.fromEntries(["MCP", "Anthropic", "DeepSeek", "Doubao", "Gemini", "Grok", "Minimax", "Kimi", "OpenAI", "Qwen", "XiaomiMiMo", "Zhipu"].map((name) => [name, Icon]));
});
vi.mock("@lobehub/ui/icons", () => ({ Lark: Object.assign(() => null, { Color: () => null }) }));

let host: HTMLDivElement;
let root: Root;
const w = window as any;

/** 万能宿主 API：任何属性访问得到"异步返回 {}"的方法；on* 方法返回退订函数。
 *  显式覆盖的属性优先于默认值（get 陷阱先查 overrides）。
 *  面板只依赖 stub 渲染标题与行结构；具体目录端点按面板需要单独覆盖。 */
function magicApi(): any {
  const overrides: Record<string, unknown> = {};
  const asyncMethod = () => Promise.resolve({});
  const unsubscribe = () => () => {};
  return new Proxy(asyncMethod, {
    get(_target, prop: string) {
      if (prop in overrides) return overrides[prop];
      if (prop === "then" || prop === "catch" || prop === "finally") return undefined;
      if (prop.startsWith("on")) return unsubscribe;
      return asyncMethod;
    },
    set(_target, prop: string, value: unknown) {
      overrides[prop] = value;
      return true;
    },
  });
}

function stubApis() {
  w.settings = Object.assign(magicApi(), {
    getGeneral: async () => ({}),
    getConfig: async () => ({}),
    getToolCatalog: async () => [],
    getSkillCatalog: async () => [],
    getToolModeOverrides: async () => ({}),
    listModelProfiles: async () => ({ profiles: [], defaultModelProfileId: "" }),
    channelsContextBindingsGet: async () => ({ externalChats: [], bindings: [], conversations: [] }),
    saveGeneral: async () => ({}),
    setPetAlwaysOnTop: () => {},
    setPetVisible: () => {},
  });
  w.plugins = Object.assign(magicApi(), { list: async () => ({ plugins: [], issues: [] }) });
  w.chat = { minimize: () => {}, toggleMaximize: () => {}, close: () => {} };
  w.cyreneTheme = { onChanged: () => () => {} };
  w.cyreneAvatar = Object.assign(magicApi(), { upload: async () => true, reset: async () => true });
  w.knowledgeBase = Object.assign(magicApi(), {
    getState: async () => ({ enabled: true, collections: [] }),
    listWorkspaces: async () => [],
    listDocuments: async () => [],
  });
  // 以下面板需要接近真实的结构化数据，空对象会让面板停留在加载/空态，误报"条件未满足"。
  w.tokenUsage = { get: async () => ({ days: [], models: [], totalTokens: 1234, requests: 10, peakDay: "2026-10-01", cacheHitRate: 0.5, currentStreak: 1, longestStreak: 2 }), clear: async () => {} };
  w.memoryPanel = { getData: async () => ({ l0: {}, l1: {}, reflections: [], events: [] }), getVaultConfig: async () => ({}), getSummaryMemory: async () => ({}) };
  w.settings.listMcpServerConfigs = async () => [{ id: "audit-server", name: "审计服务器", transport: "stdio", command: "node", args: [] }];
  w.settings.listMcpServers = async () => [{ id: "audit-server", connected: true, toolCount: 3 }];
  w.gmail = Object.assign(magicApi(), { getStatus: async () => ({ state: "connected" }) });
  for (const name of ["tts", "channels", "mcp", "asr", "sticker", "music"]) {
    if (!w[name]) w[name] = magicApi();
  }
}

function PageHost({ initial }: { initial: SettingsSection }) {
  const [section, setSection] = useState<SettingsSection>(initial);
  return <AppearanceSettingsPage section={section} onSelectSection={setSection} onBackToWorkspace={() => {}} />;
}

async function mount(initial: SettingsSection = "appearance") {
  await act(async () => {
    root.render(<AppProviders><PageHost initial={initial} /></AppProviders>);
  });
  await act(async () => { await Promise.resolve(); });
}

async function advance(ms: number) {
  await act(async () => { await vi.advanceTimersByTimeAsync(ms); });
}

const input = () => host.querySelector<HTMLInputElement>(".cy-settings-search__input")!;
const contentRoot = () => host.querySelector<HTMLElement>(".cy-settings-content")!;

async function fill(value: string) {
  await act(async () => {
    input().focus();
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input(), value);
    input().dispatchEvent(new Event("input", { bubbles: true }));
  });
}

function groupCardOf(section: SettingsSection): HTMLElement | null {
  const nav = SETTINGS_NAV_ITEMS.find((item) => item.section === section);
  const label = nav ? i18next.t(nav.labelKey) : "";
  return [...host.querySelectorAll<HTMLElement>(".cy-settings-search__group-card")]
    .find((card) => card.getAttribute("aria-label") === label) ?? null;
}

/** 与组件同口径的"目标存在性"判据：仅用于设定断言预期，闪烁本身走真实 locate 流程。 */
function isVisible(element: HTMLElement, root: HTMLElement): boolean {
  for (let node: HTMLElement | null = element; node; node = node.parentElement) {
    const style = getComputedStyle(node);
    if (node.hidden || node.getAttribute("aria-hidden") === "true" || style.display === "none" || style.visibility === "hidden" || style.visibility === "collapse") return false;
    if (node === root) break;
  }
  return true;
}

function targetOf(entry: SettingsSearchEntry, all: SettingsSearchEntry[], root: HTMLElement): { node: HTMLElement | null; reason: string } {
  const anchors = Array.from(root.querySelectorAll<HTMLElement>("[data-settings-search-key], [data-settings-search-id]"));
  const matches = anchors.filter((node) => isVisible(node, root) && !!entry.settingKey && node.dataset.settingsSearchKey === entry.settingKey);
  if (matches.length > 1) return { node: null, reason: "多处可见身份标记，需独立核查业务行" };
  if (matches.length === 1) return { node: matches[0], reason: "身份标记" };
  const ambiguous = all.some((other) => other.section === entry.section && other.label === entry.label && other.settingKey !== entry.settingKey);
  if (ambiguous) return { node: null, reason: "同部同名且无标记，回退被禁用" };
  const candidates = Array.from(root.querySelectorAll<HTMLElement>("h1,h2,h3,strong,span,label,button,p,div,li"))
    .filter((node) => (node.textContent?.trim() === entry.label || (/^[\u4e00-\u9fff]{2}$/.test(entry.label) && !!node.closest('button.ant-btn') && node.textContent?.trim() === `${entry.label[0]} ${entry.label[1]}`)) && isVisible(node, root))
    .filter((node) => {
      const key = node.closest<HTMLElement>("[data-settings-search-key]")?.dataset.settingsSearchKey;
      return !key || key === entry.settingKey;
    });
  const leaves = candidates.filter((node) => !candidates.some((other) => other !== node && node.contains(other)))
    .filter((node) => !node.querySelector("[data-settings-search-key]"));
  if (leaves.length === 1) return { node: leaves[0], reason: "唯一文本回退" };
  if (leaves.length > 1) return { node: null, reason: "文本回退不唯一" };
  return { node: null, reason: "无可见目标；原因未验证，需补具体数据场景" };
}

beforeEach(async () => {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  w.matchMedia = () => ({ matches: false, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {} });
  (globalThis as any).ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
  w.scrollTo = vi.fn();
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "requestAnimationFrame", "cancelAnimationFrame", "performance"] });
  await i18next.changeLanguage("zh-CN");
  stubApis();
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await mount("appearance");
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("可达性矩阵：静态索引每条目都能定位或按设计降级", () => {
  const entries = buildSettingEntries(zh);
  const sections = [...new Set(entries.map((entry) => entry.section))];

  for (const section of sections) {
    it(`分区 ${section}（${entries.filter((e) => e.section === section).length} 条）`, { timeout: 180000 }, async () => {
      const failures: string[] = [];
      const report: string[] = [];
      const sectionEntries = entries.filter((entry) => entry.section === section);
      for (const [index, entry] of sectionEntries.entries()) {
        await fill(entry.label);
        const group = groupCardOf(section);
        const matching = group
          ? [...group.querySelectorAll<HTMLButtonElement>(".cy-settings-search__item")]
            .filter((item) => item.querySelector(".cy-settings-search__item-label")?.textContent === entry.label)
          : [];
        // 同名条目按索引顺序与结果列表顺序一一对应（稳定排序），取本条目自己的那一行。
        const sameLabelBefore = sectionEntries.filter((other, i) => i < index && other.label === entry.label).length;
        const item = matching[sameLabelBefore];
        if (!item) {
          failures.push(`[${entry.settingKey}] 搜索结果里找不到自身标题 ${JSON.stringify(entry.label)}`);
          continue;
        }
        await act(async () => { item.click(); });
        await advance(380);
        const rootNow = contentRoot();
        const flashed = rootNow.querySelector<HTMLElement>(".cy-settings-search-flash");
        const expected = targetOf(entry, entries, rootNow);
        if (expected.node) {
          if (!flashed) {
            failures.push(`[${entry.settingKey}] ${expected.reason} 目标存在但未闪烁 ${JSON.stringify(entry.label)}`);
          } else if (!(flashed === expected.node || flashed.contains(expected.node))) {
            failures.push(`[${entry.settingKey}] 闪烁落在错误的行上（未包含目标 ${JSON.stringify(entry.label)}）`);
          }
        } else {
          if (flashed) failures.push(`[${entry.settingKey}] ${expected.reason} 却发生了闪烁`);
          report.push(`${entry.settingKey}\t${expected.reason}\t${JSON.stringify(entry.label)}`);
        }
        // 下一次 fill 会经 enter() 中止上一轮闪烁；保险起见在断言后直接清场。
        if (flashed) await advance(6000);
      }
      const counts = new Map<string, number>();
      for (const line of report) {
        const reason = line.split("\t")[1];
        counts.set(reason, (counts.get(reason) ?? 0) + 1);
      }
      console.log(`[${section}] 未定位 ${report.length} 条：${JSON.stringify([...counts.entries()])}`);
      for (const line of report) console.log(`  未定位\t${line}`);
      expect(failures, `分区 ${section} 失败 ${failures.length} 条`).toEqual([]);
    });
  }
});
