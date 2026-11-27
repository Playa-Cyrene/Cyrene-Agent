import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { IPC } from "../shared/ipc-channels";

const repoRoot = process.cwd();

function mainScreenshotSources(): Array<{ relativePath: string; source: string }> {
  const directory = path.join(repoRoot, "src", "main", "screenshot");
  return fs.readdirSync(directory)
    .filter((fileName) => fileName.endsWith(".ts") && !fileName.endsWith(".test.ts"))
    .map((fileName) => ({
      relativePath: path.posix.join("src/main/screenshot", fileName),
      source: fs.readFileSync(path.join(directory, fileName), "utf8"),
    }));
}

describe("legacy screenshot overlay removal", () => {
  it("does not expose superseded overlay IPC channels", () => {
    for (const key of [
      "SCREENSHOT_OVERLAY_READY",
      "SCREENSHOT_DATA",
      "SCREENSHOT_RENDERED",
      "SCREENSHOT_REGION",
      "SCREENSHOT_CANCEL",
      "SCREENSHOT_START_SESSION",
      "SCREENSHOT_FRAME_READY",
      "SCREENSHOT_CONFIRM",
      "SCREENSHOT_SHOWN",
    ]) {
      expect(IPC).not.toHaveProperty(key);
    }
  });

  it("does not build a screenshot renderer page", () => {
    const viteSource = fs.readFileSync(path.join(repoRoot, "vite.config.mts"), "utf8");
    expect(viteSource).not.toMatch(/\bscreenshot\s*:/);
    expect(viteSource).not.toContain("src/renderer/screenshot");
  });

  it("keeps the native screenshot modules free of the Electron capture window", () => {
    const sources = mainScreenshotSources();

    for (const { relativePath, source } of sources) {
      expect(source, relativePath).not.toMatch(
        /\bdesktopCapturer\b|\bgetDisplayMedia\b|new\s+BrowserWindow\s*\(/,
      );
    }
  });
});
