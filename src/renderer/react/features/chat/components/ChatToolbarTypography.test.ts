// @vitest-environment jsdom

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const componentDirectory = dirname(fileURLToPath(import.meta.url));

describe("chat toolbar typography", () => {
  it("darkens composer toolbar controls without changing Markdown body typography", () => {
    const composerCss = readFileSync(resolve(componentDirectory, "ChatComposer.css"), "utf8");
    const messageCss = readFileSync(resolve(componentDirectory, "ChatMessageList.css"), "utf8");
    const style = document.createElement("style");
    style.textContent = `${composerCss}\n${messageCss}`;
    document.head.append(style);

    const shell = document.createElement("div");
    shell.className = "cy-composer-shell";
    const toolbar = document.createElement("button");
    toolbar.className = "cy-composer__footer-button";
    shell.append(toolbar);
    document.body.append(shell);

    const markdown = document.createElement("div");
    markdown.className = "cy-message-markdown";
    document.body.append(markdown);

    const toolbarStyle = getComputedStyle(toolbar);
    const markdownStyle = getComputedStyle(markdown);
    expect(toolbarStyle.fontSize).toBe("13px");
    expect(toolbarStyle.fontWeight).toBe("500");
    expect(toolbarStyle.color).toBe("rgb(13, 13, 13)");
    expect(markdownStyle.fontSize).toBe("14px");
    expect(markdownStyle.fontWeight).toBe("400");
  });
});
