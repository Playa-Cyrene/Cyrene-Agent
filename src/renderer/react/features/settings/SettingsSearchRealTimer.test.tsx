// @vitest-environment jsdom
/**
 * 第 7 轮独立复测新增：真实时钟下的闪烁生命周期与折叠区揭示副作用。
 * 前面所有用例都跑在 fake timers 上，无法证明"真实调度节律"成立：
 * fake timers 会把 rAF 与 setTimeout 混在一个队列里推进，掩盖真实环境才出现的
 * 问题（如真实 rAF 与 setTimeout 交错时闪烁脉冲被合并、揭示点击依赖同步提交等）。
 * 这里刻意不使用 useFakeTimers，全部用真实计时等待；代价是每条用例多花几秒。
 */
import React, { act, useRef, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import i18next from "i18next";
import { SettingsSearch } from "./SettingsSearch";

// 图标入口间接导入浏览器专用 JSON（@emoji-mart/data）；替身仅绕开无关资源，不替换待测组件。
vi.mock("@lobehub/icons", () => {
  const Icon = Object.assign(() => null, { Color: () => null });
  return Object.fromEntries(["MCP", "Anthropic", "DeepSeek", "Doubao", "Gemini", "Grok", "Minimax", "Kimi", "OpenAI", "Qwen", "XiaomiMiMo", "Zhipu"].map((name) => [name, Icon]));
});
vi.mock("@lobehub/ui/icons", () => ({ Lark: Object.assign(() => null, { Color: () => null }) }));

let host: HTMLDivElement;
let root: Root;
let onSelect: ReturnType<typeof vi.fn>;
const w = window as any;

function setApis() {
  w.plugins = { list: vi.fn(async () => ({ plugins: [], issues: [] })) };
  w.settings = { getToolCatalog: vi.fn(async () => []), getSkillCatalog: vi.fn(async () => []) };
}

function Harness({ children }: { children: React.ReactNode }) {
  const [section, setSection] = useState("appearance");
  const content = useRef<HTMLElement>(null);
  return (
    <>
      <aside className="cy-settings-sidebar">
        <SettingsSearch
          section={section}
          onSelectSection={(s) => { onSelect(s); setSection(s); }}
          getContentRoot={() => content.current}
        />
      </aside>
      <main ref={content} data-section={section}>{children}</main>
    </>
  );
}

async function mount(children: React.ReactNode) {
  await act(async () => { root.render(<Harness>{children}</Harness>); });
}

function input() { return host.querySelector<HTMLInputElement>("input.cy-settings-search__input")!; }

async function fill(value: string) {
  await act(async () => {
    input().focus();
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input(), value);
    input().dispatchEvent(new Event("input", { bubbles: true }));
  });
}

async function pick(label: string) {
  const row = [...host.querySelectorAll<HTMLButtonElement>(".cy-settings-search__item")]
    .find((x) => x.querySelector(".cy-settings-search__item-label")?.textContent === label);
  expect(row, "search result exists: " + label).toBeTruthy();
  await act(async () => { row!.click(); });
}

function row(label: string, id = "target") {
  return (
    <div id={id} className="cy-settings-row">
      <div className="cy-settings-row__copy"><strong>{label}</strong><span>说明</span></div>
      <button>控件</button>
    </div>
  );
}

const sleep = (ms: number) => new Promise<void>((resolve) => { setTimeout(resolve, ms); });
/** 真实时钟轮询：条件成立即返回 true；超时返回 false。轮询本身不算测试断言的一部分。 */
async function waitFor(condition: () => boolean, timeoutMs: number, stepMs = 25): Promise<boolean> {
  const start = Date.now();
  while (!condition()) {
    if (Date.now() - start > timeoutMs) return false;
    await sleep(stepMs);
  }
  return true;
}

beforeEach(async () => {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  w.matchMedia = () => ({ matches: false, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {} });
  w.scrollTo = vi.fn();
  await i18next.changeLanguage("zh-CN");
  setApis(); onSelect = vi.fn();
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});

afterEach(async () => {
  await act(async () => { root.unmount(); });
  host.remove(); vi.restoreAllMocks();
});

describe("Real-clock flash lifecycle (no fake timers)", () => {
  it("RT01 real scheduling produces exactly three 400ms pulses and full cleanup", async () => {
    await mount(row("保持置顶"));
    await fill("保持置顶"); await pick("保持置顶");
    const target = host.querySelector("#target")!;
    const started = performance.now();
    let pulses = 0; let previous = false;
    // 分两段等：先等闪烁宿主类出现，再等它消失；"宿主类不存在"在开始时就是真，不能直接轮询。
    const began = await waitFor(() => target.classList.contains("cy-settings-search-flash-host"), 2500);
    expect(began, "flash host must appear").toBe(true);
    const finished = await waitFor(() => {
      const on = target.classList.contains("cy-settings-search-flash");
      if (on && !previous) pulses += 1;
      previous = on;
      return !target.classList.contains("cy-settings-search-flash-host");
    }, 4000);
    const elapsed = performance.now() - started;
    expect(finished, "flash host must be removed by the real timers").toBe(true);
    expect(pulses).toBe(3);
    expect(elapsed).toBeGreaterThanOrEqual(1700);
    expect(elapsed).toBeLessThan(3200);
    expect(target.classList.contains("cy-settings-search-flash")).toBe(false);
    expect(target.classList.contains("cy-settings-search-flash-host")).toBe(false);
  }, 10000);

  it("RT02 a real user wheel mid-flash cancels synchronously and leaves no zombie pulse", async () => {
    await mount(row("保持置顶"));
    await fill("保持置顶"); await pick("保持置顶");
    await sleep(450);
    expect(host.querySelector(".cy-settings-search-flash"), "first pulse must be running").not.toBeNull();
    window.dispatchEvent(new Event("wheel"));
    expect(host.querySelector(".cy-settings-search-flash"), "cancel must be immediate").toBeNull();
    expect(host.querySelector(".cy-settings-search-flash-host")).toBeNull();
    await sleep(2200);
    expect(host.querySelector(".cy-settings-search-flash"), "no scheduled pulse may fire after cancel").toBeNull();
  }, 10000);

  it("RT03 revealTarget expands only the registered collapsed region and never re-clicks", async () => {
    let regionAClicks = 0; let regionBClicks = 0;
    function RevealPage() {
      const [open, setOpen] = useState(false);
      return (
        <div>
          <div data-settings-search-reveal="settingsPage.petAlwaysOnTop">
            <div
              className="ant-collapse-header"
              aria-expanded={String(open)}
              onClick={() => { regionAClicks += 1; setOpen((o) => !o); }}
            >
              折叠区A
            </div>
            {open && row("保持置顶")}
          </div>
          <div data-settings-search-reveal="settingsPage.general.customStyleModalTitle">
            <div
              className="ant-collapse-header"
              aria-expanded="false"
              onClick={() => { regionBClicks += 1; }}
            >
              折叠区B
            </div>
          </div>
        </div>
      );
    }
    await mount(<RevealPage />);
    await fill("保持置顶"); await pick("保持置顶");
    // 揭示点击 → React 提交折叠内容 → MutationObserver 重新查找 → 命中并闪烁。
    const flashed = await waitFor(() => host.querySelector("#target")?.classList.contains("cy-settings-search-flash-host") ?? false, 2500);
    expect(flashed, "revealed target must be found and flashed").toBe(true);
    expect(regionAClicks, "only the registered region may be clicked").toBe(1);
    expect(regionBClicks).toBe(0);
    expect(host.querySelector("[data-settings-search-reveal] .ant-collapse-header")?.getAttribute("aria-expanded")).toBe("true");
    expect(host.querySelectorAll(".ant-collapse-header[aria-expanded=\"true\"]")).toHaveLength(1);
    await sleep(2300);
    expect(host.querySelector(".cy-settings-search-flash-host")).toBeNull();
    expect(regionAClicks, "observer callbacks must not re-click an expanded header").toBe(1);
  }, 10000);

  it("RT04 a panel mounting late on the real clock is still located via the observer", async () => {
    function Slow() {
      const [ready, setReady] = useState(false);
      React.useEffect(() => {
        const timer = setTimeout(() => setReady(true), 1100);
        return () => clearTimeout(timer);
      }, []);
      return ready ? row("保持置顶") : null;
    }
    await mount(<Slow />);
    await fill("保持置顶"); await pick("保持置顶");
    const flashed = await waitFor(() => host.querySelector("#target")?.classList.contains("cy-settings-search-flash-host") ?? false, 3500);
    expect(flashed).toBe(true);
    await sleep(2300);
    expect(host.querySelector(".cy-settings-search-flash-host")).toBeNull();
  }, 12000);

  it("RT05 real 5s lookup expiry must not flash a row that mounts after the window", async () => {
    function Slow() {
      const [ready, setReady] = useState(false);
      React.useEffect(() => {
        const timer = setTimeout(() => setReady(true), 6000);
        return () => clearTimeout(timer);
      }, []);
      return ready ? row("保持置顶") : null;
    }
    await mount(<Slow />);
    await fill("保持置顶"); await pick("保持置顶");
    await sleep(5200);
    expect(host.querySelector("#target")).toBeNull();
    expect(host.querySelector(".cy-settings-search-flash-host"), "lookup window must have closed").toBeNull();
    await sleep(1100);
    expect(host.querySelector("#target"), "late render happens after expiry").not.toBeNull();
    await sleep(400);
    expect(host.querySelector(".cy-settings-search-flash-host"), "expired lookup must not flash the late row").toBeNull();
  }, 15000);
});
