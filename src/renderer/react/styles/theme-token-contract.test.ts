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
  "--rb-surface-soft",
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

  it("让应用外壳直接消费页面和工作区角色令牌", () => {
    const root = readStyle(resolve(__dirname, "react-root.css"));

    expect(root).toMatch(/\.cy-page\s*\{[^}]*background:\s*var\(--rb-surface-page\)/s);
    expect(root).toMatch(/\.cy-workspace\s*\{[^}]*background:\s*var\(--rb-surface-workspace\)/s);
  });

  it("共享颜色使用角色令牌，运行时排版变量保留局部命名", () => {
    const sharedColorAliases = /var\(--cy-(?:accent(?:-hover)?|bg(?:-(?:page|workspace|elevated|hover|active))?|border|danger|surface|text(?:-(?:primary|secondary|muted))?|shadow-(?:workspace|bubble-(?:neutral|accent)|control-(?:hover|focus)))\b/;
    const styleFiles = readdirSync(resolve(__dirname, ".."), { recursive: true })
      .filter((file): file is string => typeof file === "string" && /\.(?:css|tsx)$/.test(file));

    for (const file of styleFiles) {
      expect(readStyle(resolve(__dirname, "..", file)), `${file} should use shared role variables for colors`).not.toMatch(sharedColorAliases);
    }
  });

  it("允许天气卡片维护独立于应用主题的明暗与插画配色", () => {
    const weather = readStyle(resolve(__dirname, "../features/chat/components/weather/weather-card.css"));

    expect(weather).toMatch(/\.weather-card\[data-theme="light"\]\s*\{[^}]*--card-bg:/s);
    expect(weather).toMatch(/\.weather-card\[data-theme="dark"\]\s*\{[^}]*--card-bg:/s);
    expect(weather).toMatch(/\.weather-card\[data-theme="light"\]\s*\{[^}]*--sun-core-1:/s);
    expect(weather).toMatch(/\.weather-card\[data-theme="dark"\]\s*\{[^}]*--sun-core-1:/s);
  });

  it("只引用已声明的表面语义令牌", () => {
    const declarations = [
      readStyle(resolve(uiRoot, "tokens.css")),
      readStyle(resolve(uiRoot, "themes", "pearl-white.css")),
    ].join("\n");
    const declaredTokens = new Set(Array.from(declarations.matchAll(/(--rb-surface-[\w-]+)\s*:/g), (match) => match[1]));
    const cssFiles = readdirSync(resolve(__dirname, ".."), { recursive: true })
      .filter((file): file is string => typeof file === "string" && file.endsWith(".css"));

    for (const file of cssFiles) {
      const references = Array.from(readStyle(resolve(__dirname, "..", file)).matchAll(/var\(\s*(--rb-surface-[\w-]+)/g), (match) => match[1]);
      for (const token of references) {
        expect(declaredTokens.has(token), `${file} references undeclared token ${token}`).toBe(true);
      }
    }
  });

  it("让主输入和附件使用语义表面", () => {
    const composer = readStyle(resolve(__dirname, "../features/chat/components/ChatComposer.css"));

    expect(composer).toMatch(/\.cy-queue-dock__editor\s*\{[^}]*background: var\(--rb-surface-elevated\)/s);
    expect(composer).toMatch(/\.cy-composer__attachment\s*\{[^}]*background: var\(--rb-surface-hover\)/s);
  });
});
