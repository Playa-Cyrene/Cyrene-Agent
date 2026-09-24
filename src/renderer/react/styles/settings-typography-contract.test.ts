// @vitest-environment jsdom

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const settingsCss = readFileSync(
  resolve(__dirname, "../features/settings/AppearanceSettingsPage.css"),
  "utf8",
);
const sidebarActionCss = readFileSync(
  resolve(__dirname, "../components/ui/NewTaskButton.css"),
  "utf8",
);
const settingsPageSource = readFileSync(
  resolve(__dirname, "../features/settings/AppearanceSettingsPage.tsx"),
  "utf8",
);

function rule(selector: string): string {
  const escapedSelector = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return settingsCss.match(new RegExp(`${escapedSelector}\\s*\\{([^}]+)\\}`))?.[1] ?? "";
}

describe("设置页文字层级契约", () => {
  it("设置导航复用工作区四个主操作项的侧栏按钮参数", () => {
    const style = document.createElement("style");
    style.textContent = `${sidebarActionCss}\n${settingsCss}`;
    document.head.append(style);

    const action = document.createElement("button");
    action.className = "cy-side-action cy-settings-nav-item is-active";
    const icon = document.createElement("span");
    icon.className = "cy-side-action-icon";
    const label = document.createElement("span");
    label.className = "cy-side-action-label";
    label.textContent = "常规";
    action.append(icon, label);
    const groupTitle = document.createElement("div");
    groupTitle.className = "cy-settings-sidebar__group-title";
    document.body.append(action, groupTitle);

    expect(settingsPageSource).toContain("cy-side-action cy-settings-nav-item");
    expect(settingsPageSource).toContain('className="cy-side-action-icon"');
    expect(settingsPageSource).toContain('className="cy-side-action-label"');
    expect(getComputedStyle(action).height).toBe("38px");
    expect(getComputedStyle(action).gap).toBe("12px");
    expect(getComputedStyle(label).fontSize).toBe("13px");
    expect(getComputedStyle(label).fontWeight).toBe("500");
    expect(getComputedStyle(groupTitle).fontSize).toBe("12px");
    expect(getComputedStyle(groupTitle).fontWeight).toBe("400");
  });

  it("使用 ZCode 的 14px 基础 UI 字号且不全局加宽字距", () => {
    const pageRule = rule(".cy-settings-page");

    expect(pageRule).toContain("padding: 50px 10px 10px;");
    expect(pageRule).toContain("font: var(--rb-text-small);");
    expect(pageRule).toContain("letter-spacing: normal;");
    expect(pageRule).toContain("--rb-font-sans: var(--rb-font-ui);");
    expect(pageRule).toContain("--rb-text-title: 400 20px/1.4 var(--rb-font-ui);");
    expect(pageRule).toContain("--rb-text-small-em: 400 14px/1.5 var(--rb-font-ui);");
    expect(pageRule).toContain("--rb-text-primary: #0d0d0d;");
    expect(pageRule).toContain("--rb-text-secondary: color-mix(in oklab, #404040 60%, transparent);");
  });

  it("设置项和分组说明使用 14px 正文而不是 13px 注释字号", () => {
    expect(rule(".cy-settings-row__copy span")).toContain("font: var(--rb-text-small);");
    expect(rule(".cy-settings-section__heading p")).toContain("font: var(--rb-text-small);");
  });

  it("页面标题使用 ZCode 的响应式 24px / 30px 标题字号", () => {
    expect(rule(".cy-settings-content h1")).toContain("font: 400 24px/1.2 var(--rb-font-sans);");
    expect(settingsCss).toMatch(/@media\s*\(min-width:\s*1024px\)[\s\S]*?\.cy-settings-content h1\s*\{[^}]*font-size:\s*30px;/);
  });

  it("React 设置页的插件标题不覆盖轻字重层级", () => {
    const pluginCss = readFileSync(
      resolve(__dirname, "../features/settings/PluginSettingsPanel.css"),
      "utf8",
    );
    expect(pluginCss).toContain("font: 500 24px/1.2 var(--rb-font-sans);");
    expect(pluginCss).not.toContain("font: 600 24px/1.2 var(--rb-font-sans);");
  });
});
