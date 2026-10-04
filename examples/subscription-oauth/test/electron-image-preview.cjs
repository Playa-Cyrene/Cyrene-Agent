"use strict";

/**
 * Electron nativeImage 预览编码冒烟。必须用 Electron 运行：
 *   electron examples/subscription-oauth/test/electron-image-preview.cjs
 */
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const { app } = require("electron");

const { PREVIEW_MAX_BYTES, createElectronPreview, imageTypeOf } = require("../lib/image-generation.cjs");

app.whenReady().then(async () => {
  const source = fs.readFileSync(path.join(__dirname, "..", "icon.png"));
  const preview = await createElectronPreview(source);
  assert.strictEqual(imageTypeOf(preview.buffer)?.mime, "image/jpeg");
  assert.ok(preview.buffer.length > 0);
  assert.ok(preview.buffer.length <= PREVIEW_MAX_BYTES, `预览 ${preview.buffer.length} B 超过上限`);
  assert.ok(Math.max(preview.width, preview.height) <= 1024);
  console.log(`Electron 预览编码通过：${preview.width}x${preview.height}，${preview.buffer.length} B ✓`);
  const transparent = await createElectronPreview(source, { transparent: true });
  assert.strictEqual(imageTypeOf(transparent.buffer)?.mime, "image/png");
  assert.ok(transparent.buffer.length <= PREVIEW_MAX_BYTES);
  console.log(`透明 PNG 预览通过：${transparent.buffer.length} B ✓`);
  app.quit();
}).catch((error) => {
  console.error("ELECTRON IMAGE PREVIEW 失败:", error);
  app.exit(1);
});
