// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { isSettingsSearchAvailable as available, useSettingsSearchAvailability, type SearchAvailability } from "./settings-search-availability";

afterEach(() => { vi.unstubAllGlobals(); });

it("关闭引擎和邮件时隐藏分支项目，开关和页面入口仍可搜索", () => {
  const state = { asrEngine: "off", ttsEngine: "off", emailEnabled: false, memoryMode: "off" };
  for (const id of ["settingsPage.asr.aliyunTitle", "settingsPage.tts.minimaxConfig", "settingsPage.tts.streamingTitle", "settingsPage.tools.smtpHost", "settingsPage.emailSettings.smtpIdentity", "settingsPage.memory.summaryTitle", "settingsPage.cyrene.embeddingModel"]) expect(available(id, state), id).toBe(false);
  for (const id of ["section:asr", "section:tts", "settingsPage.asr.engineTitle", "settingsPage.tts.engineTitle", "settingsPage.tools.emailEnabled", "settingsPage.memory.modeLabel"]) expect(available(id, state), id).toBe(true);
});

it("只显示当前引擎和记忆模式对应的配置，不隐藏仅被禁用的控件", () => {
  expect(available("settingsPage.asr.aliyunTitle", { asrEngine: "aliyun" })).toBe(true);
  expect(available("settingsPage.asr.minimaxTitle", { asrEngine: "aliyun" })).toBe(false);
  for (const [id, engine] of Object.entries({ minimaxConfig: "minimax", streamingTitle: "minimax", vocalEnhanceTitle: "minimax", gptConfig: "gptsovits", customCloudConfig: "custom-cloud", mimoConfig: "mimo", mosslandConfig: "mossland" })) {
    expect(available(`settingsPage.tts.${id}`, { ttsEngine: engine })).toBe(true);
    expect(available(`settingsPage.tts.${id}`, { ttsEngine: "off" })).toBe(false);
  }
  expect(available("settingsPage.tts.splitModeTitle", {})).toBe(true);
  expect(available("settingsPage.tools.smtpHost", { emailEnabled: true })).toBe(true);
  expect(available("settingsPage.memory.sessionSummary", { memoryMode: "summary" })).toBe(true);
  expect(available("settingsPage.memory.workspaceSummary", { memoryMode: "summary", hasWorkspaceSummary: false })).toBe(false);
  expect(available("settingsPage.memory.workspaceSummary", { memoryMode: "summary", hasWorkspaceSummary: true })).toBe(true);
  expect(available("settingsPage.memory.vault.autoSync", { memoryMode: "vector", hasVault: true })).toBe(true);
  expect(available("settingsPage.memory.vault.title", { memoryMode: "wiki" })).toBe(false);
  expect(available("settingsPage.memory.l2Title", { memoryMode: "vector" })).toBe(true);
});

it("每次打开读取最新开关，关闭后忽略旧请求且不保存凭据", async () => {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  let resolveOld!: (value: unknown) => void;
  const voice = vi.fn().mockReturnValueOnce(new Promise((resolve) => { resolveOld = resolve; }))
    .mockResolvedValue({ asrEngine: "minimax", ttsEngine: "mimo", ttsMinimaxKey: "secret" });
  vi.stubGlobal("window", { tts: { loadSettings: voice }, settings: { getGeneral: async () => ({ emailEnabled: true }), getConfig: async () => ({ memoryMode: "wiki" }) } });
  let state: SearchAvailability = {};
  function Harness({ open }: { open: boolean }) { state = useSettingsSearchAvailability(open); return null; }
  const host = document.createElement("div"); const root = createRoot(host);
  try {
    await act(async () => root.render(<Harness open />));
    await act(async () => root.render(<Harness open={false} />));
    await act(async () => root.render(<Harness open />));
    expect(state).toMatchObject({ asrEngine: "minimax", ttsEngine: "mimo", emailEnabled: true, memoryMode: "wiki" });
    await act(async () => resolveOld({ asrEngine: "aliyun", ttsEngine: "minimax" }));
    expect(state.asrEngine).toBe("minimax");
    expect(JSON.stringify(state)).not.toContain("secret");
    expect(voice).toHaveBeenCalledTimes(2);
  } finally { await act(async () => root.unmount()); }
});
