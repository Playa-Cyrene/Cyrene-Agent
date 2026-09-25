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

    // 排版重构后字号由场景规则声明：AI 回复正文走 --cy-msg-* 变量，
    // 未设置变量时回落默认 15px / 400，这里包一层 assistant-body 验证默认档
    const assistantBody = document.createElement("div");
    assistantBody.className = "cy-message__assistant-body";
    const markdown = document.createElement("div");
    markdown.className = "cy-message-markdown";
    assistantBody.append(markdown);
    document.body.append(assistantBody);

    const toolbarStyle = getComputedStyle(toolbar);
    const markdownStyle = getComputedStyle(markdown);
    expect(toolbarStyle.fontSize).toBe("13px");
    expect(toolbarStyle.fontWeight).toBe("500");
    expect(toolbarStyle.color).toBe("rgb(13, 13, 13)");
    // jsdom 不解析 CSS 变量，getComputedStyle 返回原始声明；
    // 断言变量写法本身即验证「默认 15px 且可被设置页覆盖」的机制
    expect(markdownStyle.fontSize).toBe("var(--cy-msg-size, 15px)");
    expect(markdownStyle.fontWeight).toBe("var(--cy-msg-weight, 400)");
  });
});
