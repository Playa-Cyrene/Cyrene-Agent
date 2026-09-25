// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CharacterInfoPopover } from "./CharacterInfoPopover";
import { VoiceCallPreviewDialog } from "./VoiceCallPreviewDialog";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
const roots: Root[] = [];

afterEach(async () => {
  await act(async () => { for (const root of roots) root.unmount(); });
  roots.length = 0;
  document.body.innerHTML = "";
  window.history.replaceState({}, "", "/react/");
  vi.restoreAllMocks();
});

describe("voice call preview dialog", () => {
  it("opens directly when the dedicated preview query parameter is present", async () => {
    window.history.replaceState({}, "", "/react/?voiceCallPreview=1");
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    roots.push(root);
    await act(async () => { root.render(createElement(CharacterInfoPopover)); });

    expect(document.querySelector('[role="dialog"]')?.textContent).toContain("通话界面预览");
  });

  it("opens the visual preview separately from the existing voice-call action", async () => {
    const openCall = vi.fn();
    Object.assign(window, { character: { openCall } });
    Object.defineProperty(window, "matchMedia", {
      configurable: true,
      value: () => ({ matches: false, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {} }),
    });

    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    roots.push(root);
    await act(async () => { root.render(createElement(CharacterInfoPopover)); });

    const trigger = host.querySelector<HTMLButtonElement>(".cy-character-pill");
    expect(trigger).not.toBeNull();
    await act(async () => { trigger!.click(); });
    await act(async () => { await new Promise((resolve) => window.setTimeout(resolve, 250)); });

    const previewButton = document.querySelector<HTMLButtonElement>(".cy-character-card__preview");
    expect(previewButton).not.toBeNull();
    await act(async () => { previewButton!.click(); });
    await act(async () => { await new Promise((resolve) => window.setTimeout(resolve, 250)); });

    expect(document.querySelector('[role="dialog"]')?.textContent).toContain("通话界面预览");
    expect(openCall).not.toHaveBeenCalled();
  });

  it("switches from the avatar scene to a shared two-sided conversation when the avatar is clicked", async () => {
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    roots.push(root);
    await act(async () => {
      root.render(createElement(VoiceCallPreviewDialog, { open: true, onOpenChange: vi.fn() }));
    });

    const dialog = document.querySelector('[role="dialog"]');
    expect(dialog?.querySelector(".cy-call-preview__avatar-toggle")).not.toBeNull();
    expect(dialog?.querySelector(".cy-call-preview__conversation")).toBeNull();

    await act(async () => {
      dialog!.querySelector<HTMLButtonElement>(".cy-call-preview__avatar-toggle")!.click();
      await new Promise((resolve) => window.setTimeout(resolve, 250));
    });

    const conversation = document.querySelector('[role="dialog"] .cy-call-preview__conversation');
    expect(conversation).not.toBeNull();
    expect(conversation?.textContent).toContain("你");
    expect(conversation?.textContent).toContain("昔涟");
    expect(document.querySelector('[role="dialog"] .cy-call-preview__avatar-scene')).toBeNull();

    await act(async () => {
      document.querySelector<HTMLButtonElement>(".cy-call-preview__back")!.click();
      await new Promise((resolve) => window.setTimeout(resolve, 250));
    });
    expect(document.querySelector('[role="dialog"] .cy-call-preview__avatar-scene')).not.toBeNull();
  });
});
