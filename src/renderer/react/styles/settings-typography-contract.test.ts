// @vitest-environment jsdom

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const settingsCss = readFileSync(
  resolve(__dirname, "../features/settings/AppearanceSettingsPage.css"),
  "utf8",
);

function rule(selector: string): string {
  const escapedSelector = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return settingsCss.match(new RegExp(`${escapedSelector}\\s*\\{([^}]+)\\}`))?.[1] ?? "";
}

describe("设置页文字层级契约", () => {
  it("侧栏未选中的导航项保持常规字重，选中项仅提升到中等字重", () => {
    const style = document.createElement("style");
    style.textContent = settingsCss;
    document.head.append(style);

    const settingsPage = document.createElement("div");
    settingsPage.className = "cy-settings-page";
    const normal = document.createElement("button");
    normal.className = "cy-settings-nav-item ant-btn ant-btn-variant-text";
    const active = document.createElement("button");
    active.className = "cy-settings-nav-item ant-btn ant-btn-variant-text is-active";
    const groupTitle = document.createElement("div");
    groupTitle.className = "cy-settings-sidebar__group-title";
    settingsPage.append(normal, active, groupTitle);
    document.body.append(settingsPage);

    expect(getComputedStyle(normal).fontSize).toBe("14px");
    expect(getComputedStyle(normal).fontWeight).toBe("400");
    expect(getComputedStyle(active).fontWeight).toBe("500");
    expect(getComputedStyle(groupTitle).fontSize).toBe("12px");
    expect(getComputedStyle(groupTitle).fontWeight).toBe("500");
  });

  it("使用 ZCode 的 14px 基础 UI 字号且不全局加宽字距", () => {
    const pageRule = rule(".cy-settings-page");

    expect(pageRule).toContain("font: var(--rb-text-small);");
    expect(pageRule).toContain("letter-spacing: normal;");
    expect(pageRule).toContain("--rb-font-sans: var(--rb-font-ui);");
    expect(pageRule).toContain("--rb-text-small-em: 500 14px/1.5 var(--rb-font-ui);");
    expect(pageRule).toContain("--rb-text-primary: #0d0d0d;");
    expect(pageRule).toContain("--rb-text-secondary: color-mix(in oklab, #404040 60%, transparent);");
  });

  it("设置项和分组说明使用 14px 正文而不是 13px 注释字号", () => {
    expect(rule(".cy-settings-row__copy span")).toContain("font: var(--rb-text-small);");
    expect(rule(".cy-settings-section__heading p")).toContain("font: var(--rb-text-small);");
  });

  it("页面标题使用 ZCode 的响应式 24px / 30px 标题字号", () => {
    expect(rule(".cy-settings-content h1")).toContain("font: 600 24px/1.2 var(--rb-font-sans);");
    expect(settingsCss).toMatch(/@media\s*\(min-width:\s*1024px\)[\s\S]*?\.cy-settings-content h1\s*\{[^}]*font-size:\s*30px;/);
  });
});
