// @vitest-environment jsdom

// 阶段③ 验收测试：对话页模型子下拉。
// 覆盖：多模型档案才显示（单模型外观零变化）、当前项 = effectiveSessionModel
//（raw 失效值不显示，#18）、legacy 会话跟随档案默认、欢迎页不显示、切换回调。
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ModelSelector } from "./ModelSelector";

Object.assign(globalThis, {
  IS_REACT_ACT_ENVIRONMENT: true,
  ResizeObserver: class { observe() {} unobserve() {} disconnect() {} },
});

const PROFILES = [
  {
    id: "p-single",
    provider: "单模型厂商",
    displayName: "单模型档案",
    model: "only-model",
    apiKey: "k",
  },
  {
    id: "p-multi",
    provider: "多模型厂商",
    displayName: "多模型档案",
    model: "glm-x",
    models: ["glm-x", "glm-flash", "glm-mini"],
    apiKey: "k",
  },
];

function installSettings() {
  const listModelProfiles = vi.fn(async () => ({
    profiles: PROFILES,
    defaultModelProfileId: "p-single",
  }));
  Object.assign(window, { settings: { listModelProfiles } });
  return { listModelProfiles };
}

const roots: Root[] = [];

async function renderSelector(props: {
  activeProfileId?: string;
  sessionModel?: string;
  onSelectSessionModel?: (model: string) => void;
}) {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  roots.push(root);
  await act(async () => {
    root.render(createElement(ModelSelector, {
      activeProfileId: props.activeProfileId,
      sessionModel: props.sessionModel,
      onSelect: () => {},
      onSelectModel: props.onSelectSessionModel,
    }));
  });
  return host;
}

function modelButton(host: ParentNode): HTMLButtonElement | undefined {
  return host.querySelector<HTMLButtonElement>(".cy-model-selector--model") ?? undefined;
}

afterEach(async () => {
  await act(async () => { for (const root of roots) root.unmount(); });
  roots.length = 0;
  document.body.innerHTML = "";
  delete (window as Window & { settings?: unknown }).settings;
  vi.restoreAllMocks();
});

describe("模型子下拉", () => {
  it("单模型档案：不渲染子下拉按钮（外观与旧版零变化）", async () => {
    installSettings();
    const host = await renderSelector({ activeProfileId: "p-single", onSelectSessionModel: () => {} });
    expect(modelButton(host)).toBeUndefined();
  });

  it("多模型档案：渲染子下拉，当前项 = 会话 raw model（命中清单）", async () => {
    installSettings();
    const host = await renderSelector({
      activeProfileId: "p-multi",
      sessionModel: "glm-flash",
      onSelectSessionModel: () => {},
    });
    const button = modelButton(host);
    expect(button).toBeDefined();
    expect(button?.textContent).toContain("glm-flash");
  });

  it("#18 raw 失效：session.model 不在清单 → 子下拉显示档案默认，不显示 raw 值", async () => {
    installSettings();
    const host = await renderSelector({
      activeProfileId: "p-multi",
      sessionModel: "removed-model",
      onSelectSessionModel: () => {},
    });
    const button = modelButton(host);
    expect(button?.textContent).toContain("glm-x");
    expect(button?.textContent).not.toContain("removed-model");
  });

  it("legacy 会话（session.model 缺省）：子下拉跟随档案默认（兼容性例外）", async () => {
    installSettings();
    const host = await renderSelector({
      activeProfileId: "p-multi",
      sessionModel: undefined,
      onSelectSessionModel: () => {},
    });
    expect(modelButton(host)?.textContent).toContain("glm-x");
  });

  it("欢迎页（未传 onSelectModel）：多模型档案也不显示子下拉", async () => {
    installSettings();
    const host = await renderSelector({ activeProfileId: "p-multi" });
    expect(modelButton(host)).toBeUndefined();
  });

  it("切换：点开子下拉点选模型 → 回调携带所选模型；当前项带高亮标记", async () => {
    installSettings();
    const onSelectSessionModel = vi.fn();
    const host = await renderSelector({
      activeProfileId: "p-multi",
      sessionModel: "glm-x",
      onSelectSessionModel,
    });

    // 点开子下拉
    const button = modelButton(host);
    if (!button) throw new Error("model dropdown button not found");
    await act(async () => { button.click(); });

    // antd Popover 渲染到 body portal；点选 glm-mini
    const option = Array.from(document.querySelectorAll<HTMLButtonElement>(".cy-model-selector__models button"))
      .find((item) => item.textContent?.includes("glm-mini"));
    if (!option) throw new Error("model option not found");
    await act(async () => { option.click(); });

    expect(onSelectSessionModel).toHaveBeenCalledWith("glm-mini");

    // 当前项 glm-x 带高亮标记（data-current）
    const current = Array.from(document.querySelectorAll<HTMLButtonElement>(".cy-model-selector__models button"))
      .find((item) => item.dataset.current !== undefined);
    expect(current?.textContent).toContain("glm-x");
  });
});
