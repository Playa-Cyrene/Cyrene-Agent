import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { JSDOM, VirtualConsole } from "jsdom";
import { describe, expect, it } from "vitest";
import { t } from "./i18n";

const html = fs.readFileSync(fileURLToPath(new URL("./index.html", import.meta.url)), "utf8");
const css = fs.readFileSync(fileURLToPath(new URL("./settings.css", import.meta.url)), "utf8");

function createSettingsDocument(): JSDOM {
  return new JSDOM(html, {
    pretendToBeVisual: true,
    virtualConsole: new VirtualConsole(),
  });
}

describe("settings i18n regressions", () => {
  it("does not expose the removed chat-history wipe control", () => {
    const dom = createSettingsDocument();
    const document = dom.window.document;

    expect(document.getElementById("clear-chat-history-btn") === null).toBe(true);
    expect(
      [...document.querySelectorAll("button")].some((button) =>
        button.textContent?.includes("清空记录"),
      ),
    ).toBe(false);
  });

  it("keeps inline GPU copy inline inside the translated description", () => {
    const dom = createSettingsDocument();
    const style = dom.window.document.createElement("style");
    style.textContent = css;
    dom.window.document.head.append(style);

    const description = dom.window.document.querySelector<HTMLElement>(
      '[data-i18n="panel.general.disableGpu.desc"]',
    );
    const linkPrefix = dom.window.document.querySelector<HTMLElement>(
      '[data-i18n="panel.general.disableGpu.descLink"]',
    );
    const restartNotice = dom.window.document.querySelector<HTMLElement>(
      '[data-i18n="panel.general.disableGpu.notice"]',
    );

    expect(description).not.toBeNull();
    expect(linkPrefix).not.toBeNull();
    expect(restartNotice).not.toBeNull();
    expect(dom.window.getComputedStyle(description!).display).toBe("inline");
    expect(dom.window.getComputedStyle(linkPrefix!).display).toBe("inline");
    expect(dom.window.getComputedStyle(restartNotice!).display).toBe("inline");
  });

  it("renders custom-style actions with white text", () => {
    const dom = createSettingsDocument();
    const style = dom.window.document.createElement("style");
    style.textContent = css;
    dom.window.document.head.append(style);

    for (const id of ["custom-style-sampling-btn", "custom-style-prompt-btn"]) {
      const button = dom.window.document.getElementById(id);
      expect(button).not.toBeNull();
      const label = button!.querySelector("span");
      expect(label).not.toBeNull();
      expect(dom.window.getComputedStyle(label!).color).toBe("rgb(255, 255, 255)");
    }
  });

  it("keeps translated navigation labels out of the fixed-width icon slot", () => {
    const dom = createSettingsDocument();
    const style = dom.window.document.createElement("style");
    style.textContent = css;
    dom.window.document.head.append(style);

    const label = dom.window.document.querySelector<HTMLElement>(
      '.nav-item[data-section="user"] > [data-i18n]',
    );

    expect(label).not.toBeNull();
    expect(dom.window.getComputedStyle(label!).width).not.toBe("18px");
    expect(dom.window.getComputedStyle(label!).whiteSpace).toBe("nowrap");
  });

  it("interpolates the saved-profile count", () => {
    expect(t("settings.profile.count", { count: 3 })).toBe("3 个档案");
  });

  it.each([
    ["settings.preset.websiteTitle", { shortName: "MiniMax" }, "前往 MiniMax 官网"],
    ["settings.profile.editing", { name: "大M" }, "正在编辑「大M」"],
    ["settings.profile.deleted", { name: "大M" }, "已删除「大M」"],
    [
      "settings.api.endpointPreview.default",
      { defaultSuffix: "/v1/messages" },
      "程序会按所选协议自动追加请求路径（默认 /v1/messages）。",
    ],
    [
      "settings.api.endpointPreview.suffix",
      { appendedSuffix: "/chat/completions", url: "https://example.test/chat/completions" },
      "程序会自动追加 /chat/completions；最终请求地址：https://example.test/chat/completions",
    ],
    [
      "settings.api.endpointPreview.full",
      { url: "https://example.test/v1/responses" },
      "已填写完整接口地址，不再追加后缀；最终请求地址：https://example.test/v1/responses",
    ],
    ["settings.api.testOk", { latency: 42, sample: "OK" }, "连接成功 42ms · OK"],
    ["settings.api.testFailed", { error: "超时" }, "连接失败：超时"],
    ["settings.vision.testOk", { latency: 42, sample: "OK" }, "✅ 连接成功 42ms · OK"],
    ["settings.vision.testFailed", { error: "超时" }, "❌ 超时"],
    [
      "settings.importDoc.deleteMessage",
      { fileName: "知识.md" },
      "确定删除导入知识？\n\n文件：\n《知识.md》\n\n删除后不可恢复，如需使用请重新导入。",
    ],
  ] as const)("interpolates dynamic copy for %s", (key, options, expected) => {
    expect(t(key, options)).toBe(expected);
  });
});
