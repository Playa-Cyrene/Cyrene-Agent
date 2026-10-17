// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GeneralSettingsPanel } from "./GeneralSettingsPanel";

Object.assign(globalThis, {
  IS_REACT_ACT_ENVIRONMENT: true,
  ResizeObserver: class { observe() {} unobserve() {} disconnect() {} },
});
const getComputedStyle = window.getComputedStyle.bind(window);
window.getComputedStyle = (element) => getComputedStyle(element);

const DATA_DIR = "C:\\Users\\demo\\AppData\\Roaming\\Cyrene";
const roots: Root[] = [];

function installSettings(overrides: Record<string, unknown> = {}) {
  const api = {
    getGeneral: vi.fn(async () => ({})),
    saveGeneral: vi.fn(async () => ({})),
    getDataDir: vi.fn(async () => DATA_DIR),
    openDataDir: vi.fn(async () => ({ ok: true })),
    ...overrides,
  };
  (window as unknown as { settings: unknown }).settings = api;
  return api;
}

async function renderPanel() {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  roots.push(root);
  await act(async () => { root.render(createElement(GeneralSettingsPanel)); });
  await act(async () => { await Promise.resolve(); });
  return host;
}

function buttonByText(host: ParentNode, text: string): HTMLButtonElement | undefined {
  return Array.from(host.querySelectorAll("button")).find((button) => button.textContent?.replace(/\s/g, "") === text.replace(/\s/g, ""));
}

afterEach(async () => {
  await act(async () => { for (const root of roots) root.unmount(); });
  roots.length = 0;
  document.body.innerHTML = "";
  delete (window as Window & { settings?: unknown }).settings;
  vi.restoreAllMocks();
});

describe("通用设置：数据目录", () => {
  it("显示当前数据目录路径，点击按钮打开该目录", async () => {
    const api = installSettings();
    const host = await renderPanel();

    expect(host.querySelector("[data-testid='settings-data-dir']")?.textContent).toBe(DATA_DIR);
    const open = buttonByText(host, "打开文件夹");
    expect(open).toBeDefined();

    await act(async () => { open!.click(); });
    expect(api.openDataDir).toHaveBeenCalledTimes(1);
  });

  it("取不到路径时隐藏整行，其余设置照常显示", async () => {
    installSettings({ getDataDir: vi.fn(async () => { throw new Error("ipc unavailable"); }) });
    const host = await renderPanel();

    expect(host.querySelector("[data-testid='settings-data-dir']")).toBeNull();
    expect(buttonByText(host, "打开文件夹")).toBeUndefined();
    expect(host.textContent).toContain("软件更新");
  });

  it("旧版 preload 没有该接口时不报错，也不显示该行", async () => {
    installSettings({ getDataDir: undefined, openDataDir: undefined });
    const host = await renderPanel();

    expect(host.querySelector("[data-testid='settings-data-dir']")).toBeNull();
    expect(host.textContent).toContain("软件更新");
  });
});
