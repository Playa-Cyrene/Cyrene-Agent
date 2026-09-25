import { describe, expect, it } from "vitest";
import { getWorkspaceInitialBounds } from "./workspace-window-bounds";

describe("getWorkspaceInitialBounds", () => {
  it("opens large and centered on a 2K work area", () => {
    expect(getWorkspaceInitialBounds({ x: 0, y: 0, width: 2560, height: 1400 })).toEqual({
      x: 320,
      y: 100,
      width: 1920,
      height: 1200,
    });
  });

  it("fits and centers a smaller display with a nonzero origin", () => {
    expect(getWorkspaceInitialBounds({ x: -1366, y: 40, width: 1366, height: 728 })).toEqual({
      x: -1257,
      y: 91,
      width: 1147,
      height: 626,
    });
  });

  it("never requests a window larger than a very small work area", () => {
    expect(getWorkspaceInitialBounds({ x: 0, y: 0, width: 800, height: 600 })).toEqual({
      x: 0,
      y: 30,
      width: 800,
      height: 540,
    });
  });
});
