// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { siNeteasecloudmusic } from "simple-icons";
import { ToolSettingsPanel } from "./ToolSettingsPanel";

Object.assign(globalThis, {
  IS_REACT_ACT_ENVIRONMENT: true,
  ResizeObserver: class {
    observe() {}
    unobserve() {}
    disconnect() {}
  },
});
const roots: Root[] = [];

afterEach(async () => {
  await act(async () => { for (const root of roots) root.unmount(); });
  roots.length = 0;
  document.body.innerHTML = "";
  delete (window as Window & { settings?: unknown }).settings;
  delete (window as Window & { music?: unknown }).music;
});

describe("tool settings music entry", () => {
  it("uses the shared rounded switch and select without changing their settings behavior", async () => {
    const saveGeneral = vi.fn(async () => ({}));
    Object.assign(window, {
      settings: {
        getGeneral: async () => ({ weatherEnabled: false, weatherSource: "open-meteo" }),
        getPermissionLevel: async () => ({ level: "read-only" }),
        saveGeneral,
      },
      music: { getCachedTracks: async () => ({ ok: true, data: [] }) },
    });
    Object.defineProperty(window, "matchMedia", {
      configurable: true,
      value: () => ({ matches: false, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {} }),
    });
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    roots.push(root);
    await act(async () => { root.render(createElement(ToolSettingsPanel)); });

    expect(host.querySelector(".cy-settings-tools__select.cy-control-select")).not.toBeNull();
    const weatherToggle = host.querySelector<HTMLButtonElement>(".cy-control-switch[role=switch]");
    expect(weatherToggle).not.toBeNull();
    await act(async () => { weatherToggle!.click(); });
    expect(saveGeneral).toHaveBeenCalledWith({ weatherEnabled: true });
  });

  it("opens music configuration in this React window instead of the legacy settings window", async () => {
    const openLegacySettings = vi.fn(async () => true);
    Object.assign(window, {
      settings: {
        getGeneral: async () => ({}),
        getPermissionLevel: async () => ({ level: "read-only" }),
      },
      music: {
        getCachedTracks: async () => ({ ok: true, data: [] }),
        getOpenapiConfig: async () => ({ ok: true, data: { appId: "existing-app", privateKey: "" } }),
        getStatus: async () => ({ ok: true, data: { backend: "ready", account: "signed_out", player: "available", flow: "idle" } }),
        openSettings: openLegacySettings,
      },
    });
    Object.defineProperty(window, "matchMedia", {
      configurable: true,
      value: () => ({ matches: false, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {} }),
    });
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    roots.push(root);
    await act(async () => { root.render(createElement(ToolSettingsPanel)); });

    const button = Array.from(host.querySelectorAll("button")).find((item) => item.textContent?.includes("打开音乐设置"));
    expect(button).toBeDefined();
    await act(async () => { button!.click(); });

    expect(openLegacySettings).not.toHaveBeenCalled();
    const dialog = document.querySelector('[role="dialog"]');
    expect(dialog?.textContent).toContain("网易云音乐");
    expect(dialog?.querySelector('input[value="existing-app"]')).not.toBeNull();
    const brand = dialog?.querySelector('svg[aria-label="网易云音乐"]');
    expect(brand?.querySelector("path")?.getAttribute("d")).toBe(siNeteasecloudmusic.path);
    expect(brand?.getAttribute("fill")).toBe(`#${siNeteasecloudmusic.hex}`);
  });
});
