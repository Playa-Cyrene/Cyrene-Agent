// @vitest-environment jsdom

import { act, createElement, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AppearanceSettingsPage } from "./AppearanceSettingsPage";

vi.mock("./ModelSettingsPanel", () => ({ ModelSettingsPanel: () => null }));
vi.mock("./McpSettingsPanel", () => ({ McpSettingsPanel: () => null }));
vi.mock("@lobehub/icons", () => ({ MCP: () => null }));
// ChannelsSettingsPanel 的飞书品牌图标来自 @lobehub/ui/icons，
// 其入口会连带加载浏览器端图标资产（同 @lobehub/icons）；
// 桩组件保留 aria-label，图标标注类断言才能找到飞书条目
vi.mock("@lobehub/ui/icons", () => ({
  Lark: { Color: (props: { "aria-label"?: string }) => createElement("span", { role: "img", "aria-label": props["aria-label"] }) },
}));

Object.assign(globalThis, {
  IS_REACT_ACT_ENVIRONMENT: true,
  ResizeObserver: class { observe() {} unobserve() {} disconnect() {} },
});

const roots: Root[] = [];

async function renderSettings() {
  function Harness() {
    const [section, setSection] = useState("appearance");
    return createElement(AppearanceSettingsPage, {
      section: section as never,
      onSelectSection: setSection as never,
      onBackToWorkspace: () => {},
    });
  }
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  roots.push(root);
  await act(async () => { root.render(createElement(Harness)); });
  return host;
}

function buttonByText(host: ParentNode, text: string): HTMLButtonElement | undefined {
  return Array.from(host.querySelectorAll("button")).find((button) => button.textContent?.trim() === text);
}

afterEach(async () => {
  await act(async () => { for (const root of roots) root.unmount(); });
  roots.length = 0;
  document.body.innerHTML = "";
  delete (window as Window & { tts?: unknown }).tts;
  delete (window as Window & { settings?: unknown }).settings;
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("ASR settings migration", () => {
  it("opens voice recognition in the existing settings workspace with the saved provider fields", async () => {
    Object.assign(window, {
      settings: { getGeneral: async () => ({}) },
      tts: { loadSettings: async () => ({
        asrEngine: "mossland",
        ttsMosslandKey: "shared-moss-key",
        asrLanguage: "zh",
        asrVadSilenceMs: 1400,
        asrVadThreshold: 0.02,
        asrShowTranscript: true,
      }) },
    });

    const host = await renderSettings();
    const nav = buttonByText(host, "语音识别");
    expect(nav).toBeDefined();
    await act(async () => { nav!.click(); });

    expect(nav?.getAttribute("aria-current")).toBe("page");
    expect(host.querySelector("h1")?.textContent).toBe("语音识别");
    expect(host.textContent).toContain("Mossland 配置");
    expect(host.textContent).not.toContain("阿里云配置");
    expect(host.querySelector<HTMLInputElement>('input[type="password"]')?.value).toBe("shared-moss-key");
    expect(host.querySelector('[role="switch"][aria-checked="true"]')).not.toBeNull();
  });

  it("persists the transcript switch through the existing voice settings bridge", async () => {
    const config = { asrEngine: "off", asrShowTranscript: false };
    Object.assign(window, {
      settings: { getGeneral: async () => ({}) },
      tts: {
        loadSettings: async () => ({ ...config }),
        saveSettings: async (patch: Record<string, unknown>) => { Object.assign(config, patch); return { ...config }; },
      },
    });
    const host = await renderSettings();
    await act(async () => { buttonByText(host, "语音识别")!.click(); });
    await act(async () => { host.querySelector<HTMLButtonElement>('[role="switch"]')!.click(); });
    expect(config.asrShowTranscript).toBe(true);
  });

  it("saves the shared Mossland key after typing stops", async () => {
    const config = { asrEngine: "mossland", ttsMosslandKey: "old-key" };
    Object.assign(window, {
      settings: { getGeneral: async () => ({}) },
      tts: {
        loadSettings: async () => ({ ...config }),
        saveSettings: async (patch: Record<string, unknown>) => { Object.assign(config, patch); return { ...config }; },
      },
    });
    const host = await renderSettings();
    await act(async () => { buttonByText(host, "语音识别")!.click(); });
    vi.useFakeTimers();
    const input = host.querySelector<HTMLInputElement>('input[type="password"]')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "new-key");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(config.ttsMosslandKey).toBe("old-key");
    await act(async () => { vi.advanceTimersByTime(850); });
    expect(config.ttsMosslandKey).toBe("new-key");
  });
});
