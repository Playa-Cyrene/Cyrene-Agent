// @vitest-environment jsdom

// 阶段② 验收测试：档案编辑区的模型清单组件。
// 覆盖：清单展示与编辑视图不变量（旧档案单元素）、radio 切换默认、
// 增删与"删默认顺位首项"、最后一条禁删、新建档案 presets 预填。
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ModelSettingsPanel } from "./ModelSettingsPanel";
import { MODEL_PRESETS } from "../../../settings/api/presets";

// 图标库带浏览器专用资源，jsdom 里统一替换为空组件
vi.mock("@lobehub/icons", () => {
  const make = () => () => null;
  const colored = () => Object.assign(make(), { Color: make() });
  return {
    Anthropic: colored(),
    DeepSeek: colored(),
    Doubao: colored(),
    Gemini: colored(),
    Grok: colored(),
    Minimax: colored(),
    Kimi: colored(),
    OpenAI: colored(),
    Qwen: colored(),
    XiaomiMiMo: colored(),
    Zhipu: colored(),
  };
});

Object.assign(globalThis, {
  IS_REACT_ACT_ENVIRONMENT: true,
  ResizeObserver: class { observe() {} unobserve() {} disconnect() {} },
});

const PROVIDER = MODEL_PRESETS[0].providerName;

const MULTI_PROFILE = {
  id: "p-multi",
  provider: PROVIDER,
  displayName: "多模型档案",
  baseUrl: "https://example.test/v1",
  model: "glm-x",
  models: ["glm-x", "glm-flash", "glm-mini"],
  apiKey: "sk-test",
};

const LEGACY_PROFILE = {
  id: "p-legacy",
  provider: PROVIDER,
  displayName: "旧档案",
  baseUrl: "https://example.test/v1",
  model: "old-model",
  apiKey: "sk-test",
};

const roots: Root[] = [];

/** 安装 window.settings mock；saveModelProfile 捕获保存载荷供断言 */
function installSettings(profiles: unknown[], defaultId?: string) {
  const saveModelProfile = vi.fn(async () => ({ added: true, profiles: [], defaultModelProfileId: defaultId }));
  const settings = {
    listModelProfiles: vi.fn(async () => ({ profiles, defaultModelProfileId: defaultId })),
    getConfig: vi.fn(async () => ({})),
    getTimeoutSettings: vi.fn(async () => ({ userChoiceTimeout: 45000, testTimeout: 15000 })),
    getGeneral: vi.fn(async () => ({})),
    saveTimeoutSettings: vi.fn(async () => ({})),
    saveModelProfile,
    saveConfig: vi.fn(async () => ({})),
    deleteModelProfile: vi.fn(async () => ({})),
    setDefaultModelProfile: vi.fn(async () => ({})),
    testConnection: vi.fn(async () => ({ ok: true })),
    testVision: vi.fn(async () => ({ ok: true })),
  };
  Object.assign(window, { settings });
  return settings;
}

async function renderPanel() {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  roots.push(root);
  await act(async () => { root.render(createElement(ModelSettingsPanel)); });
  return host;
}

function listItems(host: ParentNode): HTMLElement[] {
  return Array.from(host.querySelectorAll(".cy-model-list-item"));
}

function rowText(row: HTMLElement): string {
  return row.querySelector("code")?.textContent ?? "";
}

function removeButton(row: HTMLElement): HTMLButtonElement | undefined {
  return row.querySelector<HTMLButtonElement>(".cy-model-list-item__remove");
}

function radioOf(row: HTMLElement): HTMLInputElement | undefined {
  return row.querySelector<HTMLInputElement>("input[type='radio']");
}

/** 在添加行输入模型名并完成配置弹窗（受控输入需走原型 setter 才触发 React 状态更新） */
async function addModel(host: ParentNode, value: string) {
  const input = host.querySelector<HTMLInputElement>(".cy-model-list-add input");
  if (!input) throw new Error("add-row input not found");
  const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
  await act(async () => {
    setValue?.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  const addButton = Array.from(host.querySelectorAll<HTMLButtonElement>(".cy-model-list-add button"))
    .find((button) => button.getAttribute("aria-label")?.includes("添加"));
  if (!addButton) throw new Error("add button not found");
  await act(async () => { addButton.click(); });
  const dialog = document.querySelector<HTMLElement>("[role='dialog']");
  if (!dialog) throw new Error("model option dialog not found");
  const confirmButton = Array.from(dialog.querySelectorAll<HTMLButtonElement>("button"))
    .find((button) => button.textContent?.replace(/\s/g, "") === "添加模型");
  if (!confirmButton) throw new Error("model option confirm button not found");
  await act(async () => { confirmButton.click(); });
}

/** 点击"保存档案"并返回 saveModelProfile 收到的载荷 */
async function saveAndGetPayload(settings: { saveModelProfile: ReturnType<typeof vi.fn> }): Promise<Record<string, unknown>> {
  const saveButton = Array.from(document.querySelectorAll<HTMLButtonElement>("button"))
    .find((button) => button.textContent?.replace(/\s/g, "") === "保存档案");
  if (!saveButton) throw new Error("save button not found");
  await act(async () => { saveButton.click(); });
  const calls = settings.saveModelProfile.mock.calls;
  if (!calls.length) throw new Error("saveModelProfile was not called");
  return calls[calls.length - 1][0] as Record<string, unknown>;
}

afterEach(async () => {
  await act(async () => { for (const root of roots) root.unmount(); });
  roots.length = 0;
  document.body.innerHTML = "";
  delete (window as Window & { settings?: unknown }).settings;
  vi.restoreAllMocks();
});

describe("模型清单编辑组件", () => {
  it("保留未收录模型的手动推理规则并随档案保存", async () => {
    const manualReasoning = {
      style: "openai-effort",
      supportedEfforts: ["low", "medium", "high"],
      defaultEffort: "medium",
      supportsDisable: true,
    };
    const settings = installSettings([{
      ...LEGACY_PROFILE,
      modelOptions: { "old-model": { contextWindowTokens: 128000, multimodal: true, manualReasoning } },
    }], "p-legacy");
    await renderPanel();

    const payload = await saveAndGetPayload(settings);
    expect(payload.modelOptions).toMatchObject({ "old-model": { manualReasoning } });
  });

  it("多模型档案：清单完整渲染，默认模型行带标记且单选选中", async () => {
    installSettings([MULTI_PROFILE], "p-multi");
    const host = await renderPanel();

    const rows = listItems(host);
    expect(rows.map(rowText)).toEqual(["glm-x", "glm-flash", "glm-mini"]);
    expect(rows[0].classList.contains("is-selected")).toBe(true);
    expect(rows[1].classList.contains("is-selected")).toBe(false);
    expect(rows[0].textContent).toContain("默认");
    expect(rows[1].textContent).not.toContain("默认");
  });

  it("旧档案（无 models）：按编辑视图不变量显示为单元素清单，保存载荷回传单元素列表", async () => {
    const settings = installSettings([LEGACY_PROFILE], "p-legacy");
    const host = await renderPanel();

    const rows = listItems(host);
    expect(rows.map(rowText)).toEqual(["old-model"]);
    expect(rows[0].classList.contains("is-selected")).toBe(true);

    // 单元素清单照常传给主进程；主进程 normalize 剥除后旧档案零变化（阶段①已锁）
    const payload = await saveAndGetPayload(settings);
    expect(payload.model).toBe("old-model");
    expect(payload.models).toEqual(["old-model"]);
  });

  it("切换默认：点击其他行的单选后保存，payload 的默认模型已切换", async () => {
    const settings = installSettings([MULTI_PROFILE], "p-multi");
    const host = await renderPanel();

    const second = listItems(host)[1];
    const radio = radioOf(second);
    if (!radio) throw new Error("radio not found");
    await act(async () => { radio.click(); });

    const payload = await saveAndGetPayload(settings);
    expect(payload.model).toBe("glm-flash");
    expect(payload.models).toEqual(["glm-x", "glm-flash", "glm-mini"]);
  });

  it("增删：添加行入列、重复被拒；删除默认模型时默认顺位首项", async () => {
    const settings = installSettings([MULTI_PROFILE], "p-multi");
    const host = await renderPanel();

    // 添加新模型
    await addModel(host, "glm-new");
    expect(listItems(host).map(rowText)).toEqual(["glm-x", "glm-flash", "glm-mini", "glm-new"]);

    // 重复添加被拒（清单不变）
    await addModel(host, "glm-new");
    expect(listItems(host)).toHaveLength(4);
    expect(document.body.textContent).toContain("该模型已在清单中");

    // 删除默认模型 glm-x → 默认顺位剩余首项 glm-flash
    const firstRow = listItems(host)[0];
    const remove = removeButton(firstRow);
    if (!remove) throw new Error("remove button not found");
    await act(async () => { remove.click(); });

    const rows = listItems(host);
    expect(rows.map(rowText)).toEqual(["glm-flash", "glm-mini", "glm-new"]);
    expect(rows[0].classList.contains("is-selected")).toBe(true);

    const payload = await saveAndGetPayload(settings);
    expect(payload.model).toBe("glm-flash");
    expect(payload.models).toEqual(["glm-flash", "glm-mini", "glm-new"]);
  });

  it("最后一条禁删：单元素清单的移除按钮 disabled", async () => {
    installSettings([LEGACY_PROFILE], "p-legacy");
    const host = await renderPanel();

    const remove = removeButton(listItems(host)[0]);
    expect(remove?.disabled).toBe(true);
  });

  it("新建档案预填：清单 = preset mainModels 去重、默认模型居首", async () => {
    const settings = installSettings([MULTI_PROFILE], "p-multi");
    const host = await renderPanel();

    const draftButton = Array.from(host.querySelectorAll<HTMLButtonElement>("button"))
      .find((button) => button.textContent?.replace(/\s/g, "").includes("新建模型档案"));
    if (!draftButton) throw new Error("new-profile button not found");
    await act(async () => { draftButton.click(); });

    const preset = MODEL_PRESETS[0];
    const expected = [...new Set(preset.mainModels[0] ? [preset.mainModels[0], ...preset.mainModels] : preset.mainModels)];
    const rows = listItems(host);
    expect(rows.map(rowText)).toEqual(expected);
    expect(rows[0].classList.contains("is-selected")).toBe(true);

    // 新建档案保存时清单随载荷提交
    const payload = await saveAndGetPayload(settings);
    expect(payload.models).toEqual(expected);
    expect(payload.model).toBe(expected[0]);
  });
});
