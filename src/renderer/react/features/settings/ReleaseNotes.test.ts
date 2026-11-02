// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ReleaseNotes } from "./ReleaseNotes";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const roots: Root[] = [];

async function render(html: string) {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  roots.push(root);
  await act(async () => { root.render(createElement(ReleaseNotes, { html, label: "更新说明" })); });
  return host.querySelector<HTMLElement>("[data-testid='settings-release-notes']")!;
}

afterEach(async () => {
  await act(async () => { for (const root of roots) root.unmount(); });
  roots.length = 0;
  document.body.innerHTML = "";
  delete (window as Window & { system?: unknown }).system;
});

describe("设置页的更新说明", () => {
  it("把 HTML 渲染成标题和列表，而不是把标签当文字显示", async () => {
    const notes = await render("<h2>新增与改进</h2><ul><li>新增 GPT-6.1 Terra</li><li>自动显示模式</li></ul>");
    expect(notes.querySelector("h2")?.textContent).toBe("新增与改进");
    expect(Array.from(notes.querySelectorAll("li"), (li) => li.textContent)).toEqual(["新增 GPT-6.1 Terra", "自动显示模式"]);
    expect(notes.textContent).not.toContain("<li>");
  });

  it("渲染前再次净化：即使主进程漏网也不会执行脚本或保留事件属性", async () => {
    const notes = await render("<p onclick=\"steal()\">正文</p><img src=x onerror=\"steal()\"><script>steal()</script><a href=\"javascript:steal()\">x</a>");
    expect(notes.innerHTML).toBe("<p>正文</p><a>x</a>");
  });

  it("不保留 data-* / aria-* 属性：外部内容不能伪造设置页搜索定位标记", async () => {
    const notes = await render("<p data-settings-search-id=\"settingsPage.theme\" aria-label=\"伪造\">正文</p>");
    expect(notes.innerHTML).toBe("<p>正文</p>");
  });

  it("保留表格与折叠块结构", async () => {
    const notes = await render("<table><tbody><tr><td>值</td></tr></tbody></table><details><summary>详情</summary>内容</details>");
    expect(notes.querySelector("td")?.textContent).toBe("值");
    expect(notes.querySelector("details summary")?.textContent).toBe("详情");
  });

  it("滚动框可用键盘聚焦并带无障碍标签", async () => {
    const notes = await render("<p>正文</p>");
    expect(notes.getAttribute("role")).toBe("region");
    expect(notes.getAttribute("aria-label")).toBe("更新说明");
    expect(notes.tabIndex).toBe(0);
  });

  it("中键点击同样交给系统浏览器；右键不打开链接", async () => {
    const openExternal = vi.fn(async () => undefined);
    (window as unknown as { system: unknown }).system = { openExternal };
    const notes = await render("<p><a href=\"https://example.com/a\">链接</a></p>");
    const link = notes.querySelector("a")!;
    const middle = new MouseEvent("auxclick", { bubbles: true, cancelable: true, button: 1 });
    await act(async () => { link.dispatchEvent(middle); });
    expect(middle.defaultPrevented).toBe(true);
    expect(openExternal).toHaveBeenCalledTimes(1);
    await act(async () => { link.dispatchEvent(new MouseEvent("auxclick", { bubbles: true, cancelable: true, button: 2 })); });
    expect(openExternal).toHaveBeenCalledTimes(1);
  });

  it("点击链接交给系统浏览器打开，设置窗口本身不跳转", async () => {
    const openExternal = vi.fn(async () => undefined);
    (window as unknown as { system: unknown }).system = { openExternal };
    const notes = await render("<p><a href=\"https://github.com/Playa-Cyrene/Cyrene-Agent/compare/v1.3.4...v1.3.5\">完整源码比较</a></p>");
    const link = notes.querySelector("a")!;
    const event = new MouseEvent("click", { bubbles: true, cancelable: true });
    await act(async () => { link.dispatchEvent(event); });
    expect(event.defaultPrevented).toBe(true);
    expect(openExternal).toHaveBeenCalledWith("https://github.com/Playa-Cyrene/Cyrene-Agent/compare/v1.3.4...v1.3.5");
  });
});
