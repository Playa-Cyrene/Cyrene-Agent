// @vitest-environment jsdom

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const componentDirectory = dirname(fileURLToPath(import.meta.url));

describe("chat Markdown style integration", () => {
  it("scans the installed Streamdown distribution for prefixed utilities", () => {
    const stylesheetPath = resolve(componentDirectory, "StreamdownMessageContent.css");
    const stylesheet = readFileSync(stylesheetPath, "utf8");
    const source = stylesheet.match(/@source\s+"([^"]+)"/)?.[1];

    expect(source).toBeDefined();

    const sourceDirectory = resolve(dirname(stylesheetPath), source!.replace(/\/\*\.js$/, ""));
    expect(existsSync(sourceDirectory)).toBe(true);
    expect(readdirSync(sourceDirectory).some((entry) => entry.endsWith(".js"))).toBe(true);
  });

  it("aligns expanded reasoning text with its title after the status icon", () => {
    const stylesheet = readFileSync(resolve(componentDirectory, "ChatMessageList.css"), "utf8");
    const style = document.createElement("style");
    style.textContent = stylesheet;
    document.head.append(style);

    const reasoning = document.createElement("section");
    reasoning.className = "cy-message-reasoning";
    const content = document.createElement("div");
    content.className = "ant-think-content";
    reasoning.append(content);
    document.body.append(reasoning);

    expect(getComputedStyle(content).paddingInlineStart).toBe("46px");
  });
});
