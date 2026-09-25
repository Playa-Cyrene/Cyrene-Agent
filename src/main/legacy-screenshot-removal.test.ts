import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { IPC } from "../shared/ipc-channels";

const repoRoot = process.cwd();
const legacyFiles = [
  "src/main/screenshot/screenshot-manager.ts",
  "src/preload/screenshot.ts",
  "src/renderer/screenshot/index.html",
  "src/renderer/screenshot/screenshot.css",
  "src/renderer/screenshot/screenshot.ts",
];

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

  it("does not ship the Electron overlay files", () => {
    for (const relativePath of legacyFiles) {
      expect(fs.existsSync(path.join(repoRoot, relativePath)), relativePath).toBe(false);
    }
  });

  it("does not build a screenshot renderer page", () => {
    // vite 配置已改为 ESM（vite.config.mts）；找不到时视为未配置，不应构建截图页
    const viteConfigPath = ["vite.config.mts", "vite.config.ts"]
      .map((name) => path.join(repoRoot, name))
      .find((p) => fs.existsSync(p));
    expect(viteConfigPath, "vite.config.mts / vite.config.ts 均不存在").toBeDefined();
    const viteSource = fs.readFileSync(viteConfigPath!, "utf8");
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
