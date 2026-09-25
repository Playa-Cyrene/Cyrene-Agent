// @vitest-environment jsdom

import { act, createElement, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { siObsidian } from "simple-icons";
import packageJson from "../../../../../package.json";
import { AppearanceSettingsPage } from "./AppearanceSettingsPage";

// The model page is outside these routes and pulls in browser-only icon assets.
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
const getComputedStyle = window.getComputedStyle.bind(window);
window.getComputedStyle = (element) => getComputedStyle(element);

const roots: Root[] = [];

async function renderSettings(initialSection = "appearance") {
  function Harness() {
    const [section, setSection] = useState(initialSection);
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
  return Array.from(host.querySelectorAll("button")).find((button) => button.textContent?.replace(/\s/g, "") === text.replace(/\s/g, ""));
}

afterEach(async () => {
  await act(async () => { for (const root of roots) root.unmount(); });
  roots.length = 0;
  document.body.innerHTML = "";
  delete (window as Window & { memoryPanel?: unknown }).memoryPanel;
  delete (window as Window & { settings?: unknown }).settings;
  vi.restoreAllMocks();
});

describe("agent settings migration", () => {
  it("shows the current app version in the settings sidebar footer", async () => {
    Object.assign(window, { settings: { getGeneral: async () => ({}) } });
    const host = await renderSettings();

    expect(host.querySelector(".cy-settings-sidebar__footer")?.textContent).toBe(`v${packageJson.version}`);
  });

  it("opens memory in the React settings workspace and saves an edited long-term profile", async () => {
    const payload = {
      l0: { preferredName: "小明", occupation: "学生", longTermInterests: "音乐", language: "中文", permanentNote: "" },
      l1: { recentGoals: "学习", recentPreferences: "", currentProject: "" },
      l2: [], importedDocs: [], reflections: [],
    };
    Object.assign(window, {
      settings: { getGeneral: async () => ({}) },
      memoryPanel: {
        getData: async () => payload,
        getVaultConfig: async () => ({ vaultPath: "", autoSync: false, lastSyncAt: 0 }),
        saveL0: async (patch: typeof payload.l0) => { payload.l0 = { ...patch }; return { ok: true }; },
      },
    });
    const host = await renderSettings();
    const memoryNav = buttonByText(host, "记忆");
    expect(memoryNav).toBeDefined();
    await act(async () => { memoryNav!.click(); });
    expect(host.textContent).toContain("长期画像");
    expect(host.querySelector<HTMLInputElement>('input[value="小明"]')).not.toBeNull();

    const edit = buttonByText(host, "编辑");
    expect(edit).toBeDefined();
    await act(async () => { edit!.click(); });
    const name = host.querySelector<HTMLInputElement>('input[value="小明"]')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(name, "小昔");
      name.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => { buttonByText(host, "保存")!.click(); });
    expect(payload.l0.preferredName).toBe("小昔");
    expect(host.querySelector<HTMLInputElement>('input[value="小昔"]')).not.toBeNull();
  });

  it("shows existing Cyrene settings and persists changed runtime and sticker options", async () => {
    const config = {
      runtimeSync: "local",
      stickerEnabled: true,
      stickerSize: "standard",
      stickerSimilarityThreshold: 0.55,
      embeddingDimensions: undefined as number | undefined,
    };
    Object.assign(window, {
      settings: {
        getGeneral: async () => ({}),
        getConfig: async () => ({ ...config }),
        saveConfig: async (patch: typeof config) => { Object.assign(config, patch); return { ...config }; },
        previewRuntimeSync: vi.fn(),
      },
    });
    const host = await renderSettings();
    const nav = buttonByText(host, "昔涟设置");
    expect(nav).toBeDefined();
    await act(async () => { nav!.click(); });
    expect(host.textContent).toContain("状态栏实时更新");
    expect(host.textContent).toContain("表情包发送");
    const llmOption = Array.from(host.querySelectorAll("label")).find((item) => item.textContent?.trim() === "LLM 分析");
    expect(llmOption).toBeDefined();
    await act(async () => { (llmOption as HTMLElement).click(); });
    await act(async () => { buttonByText(host, "保存昔涟设置")!.click(); });
    expect(config.runtimeSync).toBe("llm");
  });

  it("keeps memory document deletion behind confirmation and can bind a vault", async () => {
    const payload = {
      l0: { preferredName: "", occupation: "", longTermInterests: "", language: "", permanentNote: "" },
      l1: { recentGoals: "", recentPreferences: "", currentProject: "" },
      l2: [], reflections: [],
      importedDocs: [{ importId: "import-1", fileName: "notes.md", chunkCount: 3, lastImportedAt: 1000 }],
    };
    let vaultPath = "";
    const deleteImportedDoc = vi.fn(async () => { payload.importedDocs = []; return { ok: true, deleted: 1 }; });
    Object.assign(window, {
      settings: { getGeneral: async () => ({}) },
      memoryPanel: {
        getData: async () => payload,
        getVaultConfig: async () => ({ vaultPath, autoSync: false, lastSyncAt: 0 }),
        deleteImportedDoc,
        bindVault: async () => { vaultPath = "C:/Notes"; return { ok: true, vaultPath, fileCount: 2 }; },
      },
    });
    const host = await renderSettings();
    await act(async () => { buttonByText(host, "记忆")!.click(); });
    expect(host.textContent).toContain("notes.md");
    expect(host.querySelector('svg[aria-label="Obsidian"] path')?.getAttribute("d")).toBe(siObsidian.path);
    await act(async () => { host.querySelector<HTMLButtonElement>('button[aria-label="删除 notes.md"]')!.click(); });
    expect(deleteImportedDoc).not.toHaveBeenCalled();
    await act(async () => { buttonByText(document, "确认删除")!.click(); });
    expect(deleteImportedDoc).toHaveBeenCalledWith("import-1", "notes.md");
    expect(host.textContent).not.toContain("notes.md");
    await act(async () => { buttonByText(host, "绑定文件夹")!.click(); });
    expect(host.textContent).toContain("C:/Notes");
  });

  it("shows sticker validation feedback inside the add dialog", async () => {
    Object.assign(window, { settings: { getGeneral: async () => ({}), getConfig: async () => ({}) } });
    const host = await renderSettings();
    await act(async () => { buttonByText(host, "昔涟设置")!.click(); });
    await act(async () => { buttonByText(host, "添加表情包")!.click(); });
    const dialog = document.querySelector('[role="dialog"]');
    expect(dialog).not.toBeNull();
    await act(async () => { buttonByText(dialog!, "添加")!.click(); });
    expect(dialog?.textContent).toContain("请选择图片");

    const idInput = dialog!.querySelector<HTMLInputElement>("input")!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(idInput, "old-sticker");
      idInput.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => { dialog!.querySelector<HTMLButtonElement>(".ant-modal-footer button")!.click(); });
    await act(async () => { buttonByText(host, "添加表情包")!.click(); });
    expect(document.querySelector('[role="dialog"] input')?.getAttribute("value")).toBe("");
  });
});
