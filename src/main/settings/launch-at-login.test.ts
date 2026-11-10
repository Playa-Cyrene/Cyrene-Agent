import { describe, expect, it, vi } from "vitest";
import {
  applyInstallerLaunchAtLoginSelection,
  consumeInstallerLaunchAtLoginSelection,
  syncLaunchAtLogin,
} from "./launch-at-login";

describe("syncLaunchAtLogin", () => {
  it("enables Windows login launch when the setting is enabled", () => {
    const setLoginItemSettings = vi.fn();

    syncLaunchAtLogin(true, { setLoginItemSettings });

    expect(setLoginItemSettings).toHaveBeenCalledWith({ openAtLogin: true });
  });

  it("removes Windows login launch when the setting is disabled", () => {
    const setLoginItemSettings = vi.fn();

    syncLaunchAtLogin(false, { setLoginItemSettings });

    expect(setLoginItemSettings).toHaveBeenCalledWith({ openAtLogin: false });
  });
});

describe("consumeInstallerLaunchAtLoginSelection", () => {
  it("uses the checked installer option on the first app launch", () => {
    const readFileSync = vi.fn(() => '{"launchAtLogin":true}');
    const unlinkSync = vi.fn();

    expect(consumeInstallerLaunchAtLoginSelection("installer-options.json", { readFileSync, unlinkSync })).toBe(true);
    expect(unlinkSync).toHaveBeenCalledWith("installer-options.json");
  });

  it("does not force a preference when the installer did not leave a selection", () => {
    const readFileSync = vi.fn(() => "not json");
    const unlinkSync = vi.fn();

    expect(consumeInstallerLaunchAtLoginSelection("installer-options.json", { readFileSync, unlinkSync })).toBeNull();
    expect(unlinkSync).not.toHaveBeenCalled();
  });
});

describe("applyInstallerLaunchAtLoginSelection", () => {
  it.each([true, false])("preserves existing launchAtLogin=%s without an installer selection", (enabled) => {
    expect(applyInstallerLaunchAtLoginSelection(
      { launchAtLogin: enabled, language: "zh-CN" },
      null,
    )).toEqual({ launchAtLogin: enabled, language: "zh-CN" });
  });

  it("honors an explicit unchecked interactive selection", () => {
    expect(applyInstallerLaunchAtLoginSelection({ launchAtLogin: true }, false))
      .toEqual({ launchAtLogin: false });
  });

  it("persists the one-shot installer selection into the normal settings payload", () => {
    expect(applyInstallerLaunchAtLoginSelection(
      { launchAtLogin: false, language: "zh-CN" },
      true,
    )).toEqual({ launchAtLogin: true, language: "zh-CN" });
  });
});
