import { describe, expect, it } from "vitest";
import { normalizeWindowVisibilitySettings } from "./window-visibility-settings";

describe("normalizeWindowVisibilitySettings", () => {
  it("defaults the sidebar to visible", () => {
    expect(normalizeWindowVisibilitySettings({})).toEqual({
      sidebarVisible: true,
    });
  });

  it("preserves explicit false values", () => {
    expect(normalizeWindowVisibilitySettings({ sidebarVisible: false })).toEqual({
      sidebarVisible: false,
    });
  });
});
