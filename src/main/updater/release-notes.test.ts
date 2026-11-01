import { describe, expect, it } from "vitest";
import { releaseNotesToSafeHtml } from "./release-notes";

// 与 GitHub 发布源实际给出的格式一致：GitHub 已把发布说明渲染成 HTML
const GITHUB_RELEASE_HTML = [
  "<h1>Cyrene-Agent 1.3.5</h1>",
  "<blockquote><p>本次更新没有新增功能。</p></blockquote>",
  "<h2>新增与改进</h2><ul><li>新增 GPT-6.1 Terra</li><li>内置浏览器新增自动显示模式</li></ul>",
  "<p>手动安装：Cyrene-Setup-1.3.5.exe<br>提示：安装包未做代码签名</p>",
  "<p><a href=\"https://github.com/Playa-Cyrene/Cyrene-Agent/compare/v1.3.4...v1.3.5\">完整源码比较</a></p>",
  "<hr><h1>Cyrene-Agent 1.3.5</h1>",
].join(" ");

describe("更新说明转成可安全渲染的 HTML", () => {
  it("GitHub 发布源的 HTML 原样保留排版标签与 https 链接", () => {
    const html = releaseNotesToSafeHtml(GITHUB_RELEASE_HTML)!;
    expect(html).toContain("<h1>Cyrene-Agent 1.3.5</h1>");
    expect(html).toContain("<ul><li>新增 GPT-6.1 Terra</li><li>内置浏览器新增自动显示模式</li></ul>");
    expect(html).toContain("<blockquote><p>本次更新没有新增功能。</p></blockquote>");
    expect(html).toContain("<br />");
    expect(html).toContain("<hr />");
    expect(html).toContain('<a href="https://github.com/Playa-Cyrene/Cyrene-Agent/compare/v1.3.4...v1.3.5">完整源码比较</a>');
  });

  it("去掉脚本、事件属性、样式、图片与非 https 链接", () => {
    const html = releaseNotesToSafeHtml([
      "<p onclick=\"steal()\" style=\"color:red\">正文</p>",
      "<script>alert(1)</script><style>body{display:none}</style>",
      "<img src=\"https://example.com/x.png\" onerror=\"steal()\">",
      "<iframe src=\"https://example.com\"></iframe>",
      "<a href=\"javascript:steal()\">a</a><a href=\"http://example.com\">b</a><a href=\"file:///C:/x\">c</a>",
    ].join(""))!;
    expect(html).toBe("<p>正文</p><a>a</a><a>b</a><a>c</a>");
  });

  it("Markdown 或纯文本发布说明转成 HTML", () => {
    expect(releaseNotesToSafeHtml("## 修复\n\n- 修复 A\n- 修复 B")).toBe("<h2>修复</h2>\n<ul>\n<li>修复 A</li>\n<li>修复 B</li>\n</ul>");
    expect(releaseNotesToSafeHtml("可靠性更新")).toBe("<p>可靠性更新</p>");
  });

  it("Markdown 代码片段里的标签按文字保留，其余 Markdown 照常转换", () => {
    const html = releaseNotesToSafeHtml("## 修复\n\n- 修复 `<webview>` 的导航行为\n\n```\n<script>alert(1)</script>\n```")!;
    expect(html).toContain("<h2>修复</h2>");
    expect(html).toContain("<li>修复 <code>&lt;webview&gt;</code> 的导航行为</li>");
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(html).not.toContain("<script>");
  });

  it("以普通文字开头、中间含行内标签的说明按 Markdown 处理", () => {
    expect(releaseNotesToSafeHtml("新增 <kbd>Ctrl</kbd> 快捷键说明")).toBe("<p>新增 Ctrl 快捷键说明</p>");
  });

  it("空白或净化后为空的说明返回 null，不显示空框", () => {
    expect(releaseNotesToSafeHtml("   ")).toBeNull();
    expect(releaseNotesToSafeHtml("<script>alert(1)</script>")).toBeNull();
  });
});
