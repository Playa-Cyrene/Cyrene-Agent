// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from "vitest";

const REQUIRED_INPUT_IDS = [
  "tts-auto-read",
  "tts-speed",
  "tts-volume",
  "tts-minimax-key",
  "tts-minimax-voice",
  "tts-streaming",
  "tts-minimax-vocal-enhance",
  "tts-gptsovits-url",
  "tts-gptsovits-ref-audio",
  "tts-gptsovits-prompt-text",
  "tts-gptsovits-timeout",
  "tts-custom-cloud-url",
  "tts-custom-cloud-key",
  "tts-custom-cloud-voice",
  "tts-custom-cloud-timeout",
  "tts-mimo-key",
  "tts-mimo-voice-audio",
  "tts-mimo-style",
  "tts-mossland-key",
  "tts-mossland-voice",
  "tts-mossland-text",
  "tts-early-read-split-enabled",
];

function addInput(id: string): void {
  const input = document.createElement("input");
  input.id = id;
  document.body.appendChild(input);
}

function addSelect(id: string, values: string[]): HTMLSelectElement {
  const select = document.createElement("select");
  select.id = id;
  for (const value of values) {
    const option = document.createElement("option");
    option.value = value;
    option.textContent = value;
    select.appendChild(option);
  }
  document.body.appendChild(select);
  return select;
}

function addOptionGroup(id: string, values: string[]): HTMLElement {
  const group = document.createElement("div");
  group.id = id;
  group.className = "option-blocks";
  group.setAttribute("role", "group");
  for (const value of values) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "option-block";
    button.dataset.value = value;
    button.textContent = value;
    button.setAttribute("aria-pressed", "false");
    group.appendChild(button);
  }
  document.body.appendChild(group);
  return group;
}

function splitModeButtons(): HTMLButtonElement[] {
  const group = document.getElementById("tts-early-read-split-mode");
  if (!group) return [];
  return Array.from(group.querySelectorAll<HTMLButtonElement>(".option-block"));
}

describe("TTS settings panel", () => {
  beforeEach(() => {
    vi.resetModules();
    document.body.replaceChildren();
    REQUIRED_INPUT_IDS.forEach(addInput);
    addSelect("tts-minimax-model", ["speech-2.8-turbo", "speech-2.8-hd"]);
    addOptionGroup("tts-early-read-split-mode", ["sentence", "paragraph"]);
    addSelect("tts-gptsovits-format", ["wav", "mp3"]);
    addSelect("tts-custom-cloud-format", ["mp3", "wav"]);
    addSelect("tts-mossland-model", ["moss-tts-1.5-flash", "moss-tts-1.0-pro"]);
    addSelect("tts-mossland-format", ["mp3", "wav"]);
  });

  it("persists the MiniMax model immediately when the select changes", async () => {
    const saveSettings = vi.fn(async () => ({}));
    Object.assign(window, {
      tts: {
        loadSettings: vi.fn(async () => ({ ttsMinimaxModel: "speech-2.8-turbo" })),
        saveSettings,
      },
    });
    await import("./panel");
    await Promise.resolve();
    saveSettings.mockClear();

    const select = document.getElementById("tts-minimax-model") as HTMLSelectElement;
    select.value = "speech-2.8-hd";
    select.dispatchEvent(new Event("change", { bubbles: true }));
    await Promise.resolve();

    expect(saveSettings).toHaveBeenCalledWith({ ttsMinimaxModel: "speech-2.8-hd" });
  });

  it("restores the saved Mossland model instead of forcing the legacy model", async () => {
    Object.assign(window, {
      tts: {
        loadSettings: vi.fn(async () => ({ ttsMosslandModel: "moss-tts-1.0-pro" })),
        saveSettings: vi.fn(async () => ({})),
      },
    });

    await import("./panel");
    await Promise.resolve();

    expect((document.getElementById("tts-mossland-model") as HTMLSelectElement).value)
      .toBe("moss-tts-1.0-pro");
  });

  it("persists the early-read split mode when the paragraph button is clicked", async () => {
    const saveSettings = vi.fn(async () => ({}));
    Object.assign(window, {
      tts: {
        loadSettings: vi.fn(async () => ({ ttsEarlyReadSplitMode: "sentence" })),
        saveSettings,
      },
    });
    await import("./panel");
    await Promise.resolve();
    saveSettings.mockClear();

    const paragraph = splitModeButtons().find((button) => button.dataset.value === "paragraph");
    expect(paragraph).toBeDefined();
    paragraph!.click();
    await Promise.resolve();

    expect(saveSettings).toHaveBeenCalledWith({ ttsEarlyReadSplitMode: "paragraph" });
    expect(paragraph!.classList.contains("is-active")).toBe(true);
    expect(paragraph!.getAttribute("aria-pressed")).toBe("true");
    expect(splitModeButtons().find((button) => button.dataset.value === "sentence")!.classList.contains("is-active")).toBe(false);
  });

  it("restores the early-read split switch and disables buttons when saved off", async () => {
    Object.assign(window, {
      tts: {
        loadSettings: vi.fn(async () => ({
          ttsEarlyReadSplitEnabled: false,
          ttsEarlyReadSplitMode: "paragraph",
        })),
        saveSettings: vi.fn(async () => ({})),
      },
    });

    await import("./panel");
    await Promise.resolve();

    const toggle = document.getElementById("tts-early-read-split-enabled") as HTMLInputElement;
    const buttons = splitModeButtons();
    expect(toggle.checked).toBe(false);
    expect(buttons.every((button) => button.disabled)).toBe(true);
    const paragraph = buttons.find((button) => button.dataset.value === "paragraph")!;
    expect(paragraph.classList.contains("is-active")).toBe(true);
    expect(paragraph.getAttribute("aria-pressed")).toBe("true");
  });

  it("persists the early-read split switch when toggled off and disables buttons", async () => {
    const saveSettings = vi.fn(async () => ({}));
    Object.assign(window, {
      tts: {
        loadSettings: vi.fn(async () => ({ ttsEarlyReadSplitEnabled: true })),
        saveSettings,
      },
    });
    await import("./panel");
    await Promise.resolve();
    saveSettings.mockClear();

    const toggle = document.getElementById("tts-early-read-split-enabled") as HTMLInputElement;
    toggle.checked = false;
    toggle.dispatchEvent(new Event("change", { bubbles: true }));
    await Promise.resolve();

    expect(splitModeButtons().every((button) => button.disabled)).toBe(true);
    expect(saveSettings).toHaveBeenCalledWith({ ttsEarlyReadSplitEnabled: false });
  });

  it("shows a warning notice instead of window.alert when GPT-SoVITS fields are empty", async () => {
    const alertSpy = vi.spyOn(window, "alert").mockImplementation(() => {});
    Object.assign(window, {
      tts: {
        loadSettings: vi.fn(async () => ({})),
        saveSettings: vi.fn(async () => ({})),
        synthesizeGptsovits: vi.fn(async () => { throw new Error("不应到达"); }),
      },
    });

    // 测试按钮不在常规输入夹具里，且事件绑定发生在模块加载时：
    // 按钮必须在导入前存在
    const testBtn = document.createElement("button");
    testBtn.type = "button";
    testBtn.id = "tts-gptsovits-test";
    document.body.appendChild(testBtn);

    await import("./panel");
    await Promise.resolve();

    // 参考音频路径默认为空（url 有默认值）：点击测试按钮应触发字段校验轻提示，而非阻塞 alert
    testBtn.click();
    await Promise.resolve();
    // 模块加载时的 loadSettings 异步回填 url，等待其完成后再触发校验
    await Promise.resolve();
    await Promise.resolve();
    testBtn.click();
    await Promise.resolve();

    expect(alertSpy).not.toHaveBeenCalled();
    const notice = document.querySelector(".cy-notice--warning");
    expect(notice).not.toBeNull();
    expect(notice!.textContent).toContain("请先选择参考音频文件");
    alertSpy.mockRestore();
  });

  it("shows an error alert dialog when the synthesis call throws", async () => {
    const alertSpy = vi.spyOn(window, "alert").mockImplementation(() => {});
    Object.assign(window, {
      tts: {
        loadSettings: vi.fn(async () => ({})),
        saveSettings: vi.fn(async () => ({})),
        synthesizeGptsovits: vi.fn(async () => { throw new Error("网络超时"); }),
      },
    });

    // 测试按钮不在常规输入夹具里，且事件绑定发生在模块加载时：
    // 按钮必须在导入前存在
    const testBtn = document.createElement("button");
    testBtn.type = "button";
    testBtn.id = "tts-gptsovits-test";
    document.body.appendChild(testBtn);

    await import("./panel");
    // 等模块加载时的 loadSettings 回填完成，再写测试值（避免被异步覆盖）
    for (let i = 0; i < 5; i++) await Promise.resolve();

    // 三个必填字段都填上，走合成路径并抛错
    (document.getElementById("tts-gptsovits-url") as HTMLInputElement).value = "http://127.0.0.1:9880";
    (document.getElementById("tts-gptsovits-ref-audio") as HTMLInputElement).value = "C:\\a.wav";
    (document.getElementById("tts-gptsovits-prompt-text") as HTMLInputElement).value = "示例文本";

    testBtn.click();
    for (let i = 0; i < 5; i++) await Promise.resolve();

    expect(alertSpy).not.toHaveBeenCalled();
    const dialog = document.getElementById("cy-modal-overlay");
    expect(dialog).not.toBeNull();
    expect(dialog!.textContent).toContain("测试失败");
    expect(dialog!.textContent).toContain("网络超时");
    alertSpy.mockRestore();
  });
});
