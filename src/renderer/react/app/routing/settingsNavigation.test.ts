import { describe, expect, it } from "vitest";
import { resolveSettingsDestination } from "./settingsNavigation";

describe("resolveSettingsDestination", () => {
  it("routes legacy settings sections to their React workspace equivalents", () => {
    expect(resolveSettingsDestination("api")).toEqual({ kind: "settings", section: "models" });
    expect(resolveSettingsDestination("api-advanced")).toEqual({ kind: "settings", section: "models" });
    expect(resolveSettingsDestination("tokens")).toEqual({ kind: "settings", section: "usage" });
    expect(resolveSettingsDestination("plugins")).toEqual({ kind: "settings", section: "tools" });
  });

  it("routes the removed schedule window to the workspace task panel", () => {
    expect(resolveSettingsDestination("tasks")).toEqual({ kind: "scheduledTasks" });
  });

  it("opens migrated music settings from the music player entry", () => {
    expect(resolveSettingsDestination("music")).toEqual({ kind: "settings", section: "tools", openMusicModal: true });
  });

  it("defaults unknown legacy sections to appearance", () => {
    expect(resolveSettingsDestination("missing-section")).toEqual({ kind: "settings", section: "appearance" });
  });
});
