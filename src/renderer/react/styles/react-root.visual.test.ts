import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { JSDOM } from "jsdom";
import { describe, expect, it } from "vitest";

const stylesheet = readFileSync(resolve(__dirname, "react-root.css"), "utf8");
const sharedTokens = readFileSync(resolve(__dirname, "../../ui/tokens.css"), "utf8");
const pearlTheme = readFileSync(resolve(__dirname, "../../ui/themes/pearl-white.css"), "utf8");

describe("chat workspace surface", () => {
  it("uses the neutral page and workspace surfaces with the installer motif", () => {
    const dom = new JSDOM(`
    <html data-ui-theme="pearl-white"><head><style>${sharedTokens}\n${stylesheet}\n${pearlTheme}</style></head><body>
      <main class="cy-page">
        <section class="cy-workspace is-empty"></section>
      </main>
    </body></html>
    `, { pretendToBeVisual: true });
    const { document } = dom.window;
    const rootStyle = dom.window.getComputedStyle(document.documentElement);
    const rules = Array.from(document.styleSheets[0].cssRules) as CSSStyleRule[];
    const emptyPattern = rules.find((rule) => rule.selectorText === ".cy-workspace::before");
    const filledPattern = rules.find((rule) => rule.selectorText === ".cy-workspace.has-messages::before");

    expect(rootStyle.getPropertyValue("--rb-surface-page").trim()).toBe("#ECECEE");
    expect(rootStyle.getPropertyValue("--rb-surface-workspace").trim()).toBe("#FFFFFF");
    expect(emptyPattern).toBeDefined();
    expect(emptyPattern?.style.backgroundImage).toContain("cyrene-surface-pattern.svg");
    expect(emptyPattern?.style.opacity).toBe("0.9");
    expect(emptyPattern?.style.pointerEvents).toBe("none");
    expect(filledPattern?.style.opacity).toBe("0.55");
  });
});
