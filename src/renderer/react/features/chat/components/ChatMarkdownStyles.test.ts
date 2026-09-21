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

  it("uses a compact table rhythm and a soft fading Markdown divider", () => {
    const stylesheet = readFileSync(resolve(componentDirectory, "ChatMessageList.css"), "utf8");
    const style = document.createElement("style");
    style.textContent = `.text-sm { font-size: 14px; }\n${stylesheet}`;
    document.head.append(style);

    const message = document.createElement("article");
    message.className = "cy-message cy-message--assistant";
    const markdown = document.createElement("div");
    markdown.className = "cy-message-markdown";
    const heading = document.createElement("h2");
    const divider = document.createElement("hr");
    divider.dataset.streamdown = "horizontal-rule";
    const cell = document.createElement("td");
    cell.className = "text-sm";
    const table = document.createElement("table");
    table.dataset.streamdown = "table";
    table.append(cell);
    markdown.append(heading, divider, table);
    message.append(markdown);
    document.body.append(message);

    expect(getComputedStyle(heading).fontSize).toBe("20px");
    expect(getComputedStyle(cell).fontSize).toBe("13px");
    expect(getComputedStyle(divider).borderTopWidth).toBe("0px");
    expect(getComputedStyle(divider).backgroundImage).toContain("linear-gradient");
  });

  it("polishes file links, display math, lists, and task controls", () => {
    const stylesheet = readFileSync(resolve(componentDirectory, "ChatMessageList.css"), "utf8");
    const style = document.createElement("style");
    style.textContent = stylesheet;
    document.head.append(style);

    const markdown = document.createElement("div");
    markdown.className = "cy-message-markdown";
    const fileLink = document.createElement("button");
    fileLink.className = "cy-file-link";
    const formula = document.createElement("p");
    const katex = document.createElement("span");
    katex.className = "katex";
    formula.append(katex);
    const list = document.createElement("ul");
    list.dataset.streamdown = "unordered-list";
    const listItem = document.createElement("li");
    listItem.dataset.streamdown = "list-item";
    const taskItem = document.createElement("li");
    taskItem.dataset.streamdown = "list-item";
    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.checked = true;
    checkbox.disabled = true;
    taskItem.append(checkbox);
    list.append(listItem, taskItem);
    markdown.append(fileLink, formula, list);
    document.body.append(markdown);

    expect(getComputedStyle(fileLink).borderTopWidth).toBe("0px");
    expect(getComputedStyle(fileLink).backgroundColor).toBe("rgba(0, 0, 0, 0)");
    expect(getComputedStyle(fileLink).fontWeight).toBe("600");
    expect(getComputedStyle(formula).fontSize).toBe("16.24px");
    expect(getComputedStyle(formula).marginBottom).toBe("18px");
    expect(getComputedStyle(list).listStylePosition).toBe("outside");
    expect(getComputedStyle(list).paddingInlineStart).toBe("22px");
    expect(getComputedStyle(listItem).marginTop).toBe("4px");
    expect(getComputedStyle(checkbox).appearance).toBe("none");
    expect(getComputedStyle(checkbox).opacity).toBe("1");
    expect(getComputedStyle(taskItem).listStyleType).toBe("none");
  });
});
