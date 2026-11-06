import React from "react";
import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import i18next from "i18next";
import { afterEach, describe, expect, it } from "vitest";
import en from "../../i18n/en.json";
import ja from "../../i18n/ja-JP.json";
import zh from "../../i18n/zh-CN.json";
import builtin from "../../../../shared/builtin-terms.json";
import type { TermsSnapshot } from "../../../../shared/terms-types";
import { DisclaimerSettingsPanel } from "./DisclaimerSettingsPanel";

afterEach(async () => { await i18next.changeLanguage("zh-CN"); });

const documents = { en, "ja-JP": ja, "zh-CN": zh };

describe("完整条款与本地化", () => {
  it.each(Object.keys(documents) as Array<keyof typeof documents>)("%s 展示全部条款、真实联系和分开的贡献者/维护者链接", async (locale) => {
    await i18next.changeLanguage(locale);
    const html = renderToStaticMarkup(<DisclaimerSettingsPanel />);
    const terms = documents[locale].settingsPage.disclaimer;
    expect(terms.sections).toHaveLength(14); // 阅读提示和十三节正文。
    expect(html.match(/<article/g)).toHaveLength(14);
    expect(html.match(/<h2>/g)).toHaveLength(14);
    expect(html.match(/<h3>/g)).toHaveLength(3);
    expect(html).toContain(terms.sections[8].title); // 未成年人限制不能仅留在外部文档。
    expect(html).toContain('href="mailto:ky2569ly@gmail.com"');
    expect(html).toContain('href="https://github.com/Playa-Cyrene/Cyrene-Agent/blob/master/docs/CONTRIBUTORS.md"');
    expect(html).toContain('href="https://github.com/Playa-Cyrene/Cyrene-Agent/blob/master/docs/MAINTAINERS.md"');
    expect(html).not.toContain("Playa-0v0");
    expect(html.replace(/<[^>]*>/g, "")).not.toContain("settingsPage.disclaimer.");
    expect(html).not.toMatch(/维护者审阅附录|中文整合审阅稿|尚未发布或生效/);
    expect(html).toContain('rel="noopener noreferrer"');
  });

  it.each(Object.keys(documents) as Array<keyof typeof documents>)("%s 应用中的条款与随仓文档逐段一致", (locale) => {
    const terms = documents[locale].settingsPage.disclaimer;
    const markdown = [`# ${terms.heading}`, ...terms.sections.flatMap(section => [
      `## ${section.title}`,
      ...section.blocks.map(block => {
        if (block.kind === "list") return (block as { items: string[] }).items.map(item => `- ${item}`).join("\n");
        const text = (block as { text: string }).text;
        return block.kind === "heading" ? `### ${text}` : text;
      }),
    ])].join("\n\n") + "\n";
    const source = readFileSync(new URL(`../../../../../docs/disclaimer.${locale}.md`, import.meta.url), "utf8");
    // Windows 检出可能使用 CRLF；只归一化行尾，仍严格核对完整正文。
    expect(markdown).toBe(source.replace(/\r\n/g, "\n"));
  });

  it("保留用户确认的响应时限与责任边界，不恢复旧绝对免责", async () => {
    await i18next.changeLanguage("zh-CN");
    const html = renderToStaticMarkup(<DisclaimerSettingsPanel />);
    expect(html).toContain("通常于 7 个工作日内");
    expect(html).toContain("根据核实结果采取必要措施");
    expect(html).toContain("本声明不免除开发者依法应承担的责任");
    expect(html).toContain("本说明不否定这些感受");
    expect(html).not.toContain("7 个工作日内积极配合处理或下架");
    expect(html).not.toContain("开发者不承担任何连带责任");
  });

  it("译文中的标签只按文本显示，非 HTTPS/mailto 链接不成为可点击链接", async () => {
    const key = "settingsPage.disclaimer.sections.0.blocks.0.text";
    const original = (zh.settingsPage.disclaimer.sections[0].blocks[0] as { text: string }).text;
    await i18next.changeLanguage("zh-CN");
    i18next.addResource("zh-CN", "translation", key, '<img src=x onerror=alert(1)> [bad](javascript:alert) [local](file:///tmp/private) **notice**');
    try {
      const html = renderToStaticMarkup(<DisclaimerSettingsPanel />);
      expect(html).not.toContain("<img");
      expect(html).toContain("&lt;img");
      expect(html).not.toContain('href="javascript:');
      expect(html).not.toContain('href="file:');
      expect(html).toContain("<strong>notice</strong>");
    } finally {
      i18next.addResource("zh-CN", "translation", key, original);
    }
  });
});


it("展示传入的完整远程快照，不执行正文标签或危险链接", async () => {
  await i18next.changeLanguage("en");
  const snapshot = structuredClone({ ...builtin, contentHash: "a".repeat(64), accepted: false, source: "remote" }) as TermsSnapshot;
  snapshot.locales.en.heading = "Updated remote terms";
  snapshot.locales.en.sections[0].blocks[0] = { kind: "paragraph", text: '<script>alert(1)</script> [bad](javascript:alert) [safe](https://example.com) **notice**' };
  const html = renderToStaticMarkup(<DisclaimerSettingsPanel snapshot={snapshot} />);
  expect(html).toContain("Updated remote terms");
  expect(html.match(/<article/g)).toHaveLength(14);
  expect(html).not.toContain("<script>");
  expect(html).toContain("&lt;script&gt;");
  expect(html).not.toContain('href="javascript:');
  expect(html).toContain('href="https://example.com"');
  expect(html).toContain("<strong>notice</strong>");
  expect(html).toContain("Content revision 1");
});
