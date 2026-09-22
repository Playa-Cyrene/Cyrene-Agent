import fs from "fs";
import os from "os";
import path from "path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { GeneralSettings } from "./general-settings";
import { normalizeGeneralSettings } from "./settings-facade";

const electronMock = vi.hoisted(() => ({
  userDataDir: "",
}));

vi.mock("electron", () => ({
  app: {
    getPath: () => electronMock.userDataDir,
  },
}));

describe("general window state persistence setting", () => {
  beforeEach(() => {
    vi.resetModules();
    electronMock.userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "cyrene-window-state-settings-"));
  });

  it("defaults to true for fresh and legacy settings", () => {
    expect(normalizeGeneralSettings({}).rememberWindowState).toBe(true);
    expect(normalizeGeneralSettings({ petAlwaysOnTop: false } as never).rememberWindowState).toBe(true);
  });

  it("keeps an explicit false value", () => {
    expect(normalizeGeneralSettings({ rememberWindowState: false }).rememberWindowState).toBe(false);
  });

  it("round trips through general-settings.json", async () => {
    const first = await import("./settings-facade");
    first.saveGeneralSettings({ rememberWindowState: false });

    vi.resetModules();
    const reloaded = await import("./settings-facade");
    expect(reloaded.loadGeneralSettings().rememberWindowState).toBe(false);
  });
});

describe("general LSP settings", () => {
  it("keeps valid user server overrides and safely drops malformed settings", () => {
    const settings = normalizeGeneralSettings({
      lspServerOverrides: [
        { id: "python-pyright", command: "basedpyright-langserver", args: ["--stdio"] },
        { id: "python-pyright", command: "duplicate" },
        { id: "unknown-server", command: "not-allowed" },
        { id: "gopls", command: "  " },
        { id: "typescript-language-server", initializationOptions: { preferences: { includeCompletionsForModuleExports: true } }, constructor: "unsafe" },
      ] as unknown as GeneralSettings["lspServerOverrides"],
    });

    expect(settings.lspServerOverrides).toEqual([
      { id: "python-pyright", command: "basedpyright-langserver", args: ["--stdio"] },
      { id: "typescript-language-server", initializationOptions: { preferences: { includeCompletionsForModuleExports: true } } },
    ]);
  });

  it("loads older settings without requiring an LSP migration", () => {
    expect(normalizeGeneralSettings({}).lspServerOverrides).toEqual([]);
  });
});

describe("general Harness tool concurrency settings", () => {
  it("defaults to four and normalizes the configured safe range", () => {
    expect(normalizeGeneralSettings({}).maxParallelToolCalls).toBe(4);
    expect(normalizeGeneralSettings({ maxParallelToolCalls: 0 } as never).maxParallelToolCalls).toBe(1);
    expect(normalizeGeneralSettings({ maxParallelToolCalls: 99 } as never).maxParallelToolCalls).toBe(8);
    expect(normalizeGeneralSettings({ maxParallelToolCalls: 3.8 } as never).maxParallelToolCalls).toBe(3);
    expect(normalizeGeneralSettings({ maxParallelToolCalls: "invalid" } as never).maxParallelToolCalls).toBe(4);
  });
});

describe("general ASR settings", () => {
  it("keeps Mossland as a supported ASR provider", () => {
    const settings = normalizeGeneralSettings({ asrEngine: "mossland" } as never);

    expect(settings.asrEngine).toBe("mossland");
  });
});

describe("general Mossland TTS settings", () => {
  it("uses the current flash model by default", () => {
    expect(normalizeGeneralSettings({}).ttsMosslandModel).toBe("moss-tts-1.5-flash");
  });

  it("migrates the legacy model and synchronous pcm format", () => {
    const settings = normalizeGeneralSettings({
      ttsMosslandModel: "moss-tts",
      ttsMosslandFormat: "pcm",
    } as never);

    expect(settings.ttsMosslandModel).toBe("moss-tts-1.5-flash");
    expect(settings.ttsMosslandFormat).toBe("mp3");
  });

  it("keeps both documented synchronous models", () => {
    expect(normalizeGeneralSettings({ ttsMosslandModel: "moss-tts-1.5-flash" } as never).ttsMosslandModel)
      .toBe("moss-tts-1.5-flash");
    expect(normalizeGeneralSettings({ ttsMosslandModel: "moss-tts-1.0-pro" } as never).ttsMosslandModel)
      .toBe("moss-tts-1.0-pro");
  });

  it("defaults an empty Mossland model and trims a saved snapshot id", () => {
    expect(normalizeGeneralSettings({ ttsMosslandModel: "   " } as never).ttsMosslandModel)
      .toBe("moss-tts-1.5-flash");
    expect(normalizeGeneralSettings({ ttsMosslandModel: "  moss-tts-1.5-flash-20260828  " } as never).ttsMosslandModel)
      .toBe("moss-tts-1.5-flash-20260828");
  });
});

describe("tool switch persistence round trip (chatToolsEnabled + toolModeOverrides)", () => {
  beforeEach(() => {
    vi.resetModules();
    electronMock.userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "cyrene-settings-rt-"));
  });

  /** 模拟"重启"：resetModules 后重新 import，generalSettingsCache 归零、从磁盘重读 */
  async function importFresh() {
    return import("./settings-facade");
  }

  it("keeps chatToolsEnabled and toolModeOverrides across a simulated restart", async () => {
    const { saveGeneralSettings } = await importFresh();
    // 首次开启 Chat 工具增强（ToolModePanel.toggleChatTools → saveGeneral）
    saveGeneralSettings({
      chatToolsEnabled: true,
      toolModeOverrides: { music_search: { chat: true }, weather: { chat: true } },
    });

    // 重启后读取
    const reloaded = await importFresh();
    const afterRestart = reloaded.loadGeneralSettings();
    expect(afterRestart.chatToolsEnabled).toBe(true);
    expect(afterRestart.toolModeOverrides).toEqual({
      music_search: { chat: true },
      weather: { chat: true },
    });

    // 逐工具开关（TOOL_SET_MODE_OVERRIDE handler → saveGeneral 合并写入）
    reloaded.saveGeneralSettings({
      toolModeOverrides: { ...afterRestart.toolModeOverrides, run_shell: { code: false } },
    });

    const third = await importFresh();
    const finalSettings = third.loadGeneralSettings();
    expect(finalSettings.toolModeOverrides).toEqual({
      music_search: { chat: true },
      weather: { chat: true },
      run_shell: { code: false },
    });
    expect(finalSettings.chatToolsEnabled).toBe(true);
  });

  it("toggling chatToolsEnabled off preserves the per-tool override records", async () => {
    const { saveGeneralSettings } = await importFresh();
    saveGeneralSettings({
      chatToolsEnabled: true,
      toolModeOverrides: { music_search: { chat: true } },
    });

    // 关闭总开关只写 chatToolsEnabled，不应清空 overrides
    const again = await importFresh();
    again.saveGeneralSettings({ chatToolsEnabled: false });

    const third = await importFresh();
    const finalSettings = third.loadGeneralSettings();
    expect(finalSettings.chatToolsEnabled).toBe(false);
    expect(finalSettings.toolModeOverrides).toEqual({ music_search: { chat: true } });
  });
});

describe("general early-read TTS split settings", () => {
  it("defaults split enabled with sentence mode when settings are empty", () => {
    const settings = normalizeGeneralSettings({});
    expect(settings.ttsEarlyReadSplitEnabled).toBe(true);
    expect(settings.ttsEarlyReadSplitMode).toBe("sentence");
  });

  it("keeps an explicitly disabled split switch", () => {
    expect(normalizeGeneralSettings({ ttsEarlyReadSplitEnabled: false } as never).ttsEarlyReadSplitEnabled)
      .toBe(false);
  });

  it("falls back to enabled when the stored switch is not a boolean", () => {
    expect(normalizeGeneralSettings({ ttsEarlyReadSplitEnabled: "no" } as never).ttsEarlyReadSplitEnabled)
      .toBe(true);
  });

  it("keeps paragraph mode and falls back to sentence for unknown modes", () => {
    expect(normalizeGeneralSettings({ ttsEarlyReadSplitMode: "paragraph" } as never).ttsEarlyReadSplitMode)
      .toBe("paragraph");
    expect(normalizeGeneralSettings({ ttsEarlyReadSplitMode: "chapter" } as never).ttsEarlyReadSplitMode)
      .toBe("sentence");
  });
});
