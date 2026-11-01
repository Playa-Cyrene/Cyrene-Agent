// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it } from "vitest";
import { useSettingsSearchSelection } from "./settings-search-selection";
import { settingsSearchIndex } from "./settings-search-index";
import type { SettingsSection } from "./AppearanceSettingsPage";

it("外部切页立即失效旧目标和提示，切回也不重新定位旧目标", async () => {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  let state!: ReturnType<typeof useSettingsSearchSelection>;
  const renders: ReturnType<typeof useSettingsSearchSelection>[] = [];
  function Harness({ section }: { section: SettingsSection }) {
    state = useSettingsSearchSelection(section); renders.push(state); return null;
  }
  const root = createRoot(document.createElement("div"));
  try {
    await act(async () => root.render(<Harness section="tts" />));
    await act(async () => {
      state.setSearchTarget(settingsSearchIndex.find((item) => item.id === "settingsPage.tts.engineTitle"));
      state.setSearchNotice(true);
    });
    expect(state.searchNotice).toBe(true);
    expect(state.searchTarget?.section).toBe("tts");
    const before = renders.length;
    await act(async () => root.render(<Harness section="general" />));
    // 包括清理 effect 执行前的第一次渲染。
    expect(renders[before].searchNotice).toBe(false);
    expect(renders[before].searchTarget).toBeUndefined();
    await act(async () => root.render(<Harness section="tts" />));
    expect(state.searchNotice).toBe(false);
    expect(state.searchTarget).toBeUndefined();
  } finally { await act(async () => root.unmount()); }
});
