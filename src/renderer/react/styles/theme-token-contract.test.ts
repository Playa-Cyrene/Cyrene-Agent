import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const uiRoot = resolve(__dirname, "../../ui");
const requiredTokens = [
  "--rb-surface-page",
  "--rb-surface-workspace",
  "--rb-surface-elevated",
  "--rb-surface-hover",
  "--rb-surface-active",
  "--rb-text-primary",
  "--rb-text-secondary",
  "--rb-text-disabled",
  "--rb-text-on-accent",
  "--rb-border-default",
  "--rb-border-subtle",
  "--rb-border-focus",
  "--rb-accent",
  "--rb-accent-hover",
  "--rb-danger",
  "--rb-success",
  "--rb-warning",
  "--rb-info",
  "--rb-shadow-workspace",
  "--rb-shadow-bubble-neutral",
  "--rb-shadow-bubble-accent",
  "--rb-shadow-control-hover",
  "--rb-shadow-control-focus",
];

function readStyle(path: string): string {
  return readFileSync(path, "utf8");
}

describe("React 主题令牌契约", () => {
  it("在默认与珍珠白主题中声明完整的语义令牌", () => {
    const defaultPath = resolve(uiRoot, "tokens.css");
    const pearlPath = resolve(uiRoot, "themes", "pearl-white.css");

    const stylesheets = [
      readStyle(defaultPath),
      readStyle(pearlPath),
    ];

    for (const token of requiredTokens) {
      for (const stylesheet of stylesheets) {
        expect(stylesheet).toContain(`${token}:`);
      }
    }
  });

  it("保留 theme.css 作为主题导入入口", () => {
    const themeEntry = readStyle(resolve(uiRoot, "theme.css"));

    expect(themeEntry).toContain('@import url("./themes/pearl-white.css")');
    expect(themeEntry).not.toContain("cyrene-dark");
  });

  it("不让 React 根层和消息列表依赖旧主题变量", () => {
    for (const path of [
      resolve(__dirname, "react-root.css"),
      resolve(__dirname, "../features/chat/components/ChatMessageList.css"),
    ]) {
      expect(readStyle(path)).not.toMatch(/var\(--cy-(?!window-radius\b)/);
    }
  });

  it("不让任意 React 样式依赖旧主题变量", () => {
    const cssFiles = readdirSync(resolve(__dirname, ".."), { recursive: true })
      .filter((file): file is string => typeof file === "string" && file.endsWith(".css"));

    for (const file of cssFiles) {
      expect(readStyle(resolve(__dirname, "..", file))).not.toMatch(/var\(--cy-(?!window-radius\b)/);
    }
  });

  it("让天气卡片复用共享天气令牌而不是定义局部主题调色板", () => {
    const weather = readStyle(resolve(__dirname, "../features/chat/components/weather/weather-card.css"));

    expect(weather).toContain("var(--rb-weather-bg)");
    expect(weather).not.toMatch(/--(?:card-bg|text-primary|accent):/);
  });

  it("不在 React 样式中硬编码核心品牌和基础界面颜色", () => {
    const protectedLiterals = [
      "#ff5b8a",
      "#fde0ed",
      "#fff1f6",
      "#1d1d1f",
      "#8e8e93",
      "#efb5c6",
      "#fffbfc",
      "#f2f2f2",
    ];
    const cssFiles = readdirSync(resolve(__dirname, ".."), { recursive: true })
      .filter((file): file is string => typeof file === "string" && file.endsWith(".css"));

    for (const file of cssFiles) {
      const stylesheet = readStyle(resolve(__dirname, "..", file)).toLowerCase()
        .replace(/var\([^)]*\)/g, "");
      for (const literal of protectedLiterals) {
        expect(stylesheet, `${file} should use a semantic token instead of ${literal}`).not.toContain(literal);
      }
    }
  });

  it("只引用已声明的表面语义令牌", () => {
    const forbiddenSurfaceTokens = /--rb-surface-page-(?:page|hover|active|workspace|elevated)\b|--rb-surface(?!-(?:page|workspace|elevated|hover|active)\b)/;
    const cssFiles = readdirSync(resolve(__dirname, ".."), { recursive: true })
      .filter((file): file is string => typeof file === "string" && file.endsWith(".css"));

    for (const file of cssFiles) {
      expect(readStyle(resolve(__dirname, "..", file)), `${file} should reference a declared surface token`).not.toMatch(forbiddenSurfaceTokens);
    }
  });

  it("让主输入和附件使用语义表面", () => {
    const composer = readStyle(resolve(__dirname, "../features/chat/components/ChatComposer.css"));

    expect(composer).toMatch(/\.cy-queue-dock__editor\s*\{[^}]*background: var\(--rb-surface-elevated\)/s);
    expect(composer).toMatch(/\.cy-composer__attachment\s*\{[^}]*background: var\(--rb-surface-hover\)/s);
  });
});
