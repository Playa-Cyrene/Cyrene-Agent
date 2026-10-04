"use strict";

// Hidden Electron smoke test of the real React card and production protocol.
// Builds a test-only bundle, saves no credentials, and never calls a provider.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const { app, BrowserWindow, ipcMain, nativeImage, protocol } = require("electron");
const { createGeneratedImageStore } = require("../../../dist/main/main/generated-image-store.js");
const { createGeneratedImageProtocol } = require("../../../dist/main/main/protocols/generated-image-protocol.js");
const { createElectronPreview } = require("../lib/image-generation.cjs");
const root = fs.mkdtempSync(path.join(os.tmpdir(), "cyrene-image-card-preview-"));
const repoRoot = path.resolve(__dirname, "../../..");
app.disableHardwareAcceleration();
app.setPath("userData", root);
protocol.registerSchemesAsPrivileged([{ scheme: "generated-image", privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } }]);
let win;
let saved = 0;
const timer = setTimeout(() => { console.error("图片卡片验证超时"); app.exit(1); }, 30000);
app.whenReady().then(async () => {
  require("esbuild").buildSync({
    entryPoints: [path.join(__dirname, "image-card-preview.tsx")], bundle: true, platform: "browser", jsx: "automatic",
    outfile: path.join(repoRoot, "dist/subscription-oauth-image-card-preview.js"), define: { "process.env.NODE_ENV": '"production"' },
  });
  // Deterministic noisy bitmap produces a valid >900 KiB fixture without network or AI.
  const bitmap = Buffer.alloc(1024 * 1024 * 4);
  let random = 12345;
  for (let offset = 0; offset < bitmap.length; offset += 4) {
    random = (Math.imul(random, 1664525) + 1013904223) >>> 0;
    bitmap[offset] = random >>> 24;
    bitmap[offset + 1] = (random >>> 16) & 255;
    bitmap[offset + 2] = (random >>> 8) & 255;
    bitmap[offset + 3] = random & 255;
  }
  const original = nativeImage.createFromBitmap(bitmap, { width: 1024, height: 1024 }).toPNG();
  assert.ok(original.length > 900 * 1024, "Smoke fixture must cover large original images");
  const preview = await createElectronPreview(original, { transparent: true });
  assert.ok(preview.buffer.length <= 512 * 1024);
  const decodedPreview = nativeImage.createFromBuffer(preview.buffer);
  assert.ok(decodedPreview.toBitmap().some((value, offset) => offset % 4 === 3 && value < 255), "Preview must preserve transparency");
  const id = "11111111-1111-4111-8111-111111111111";
  const store = createGeneratedImageStore(root);
  await store.save({ id, original, preview: preview.buffer });
  protocol.handle("generated-image", createGeneratedImageProtocol(root));
  ipcMain.handle("preview:save-original", async (_event, imageId) => {
    assert.equal(imageId, id);
    fs.copyFileSync(store.read(imageId, "original").filePath, path.join(root, "chosen-original.png"));
    saved++;
    return { ok: true };
  });
  // Use the CSP emitted by the actual chat build, not a permissive standalone
  // fixture. A missing image-scheme allowlist must fail this smoke test.
  const rendererHtml = fs.readFileSync(path.join(repoRoot, "dist/renderer/react/index.html"), "utf8");
  const cspMeta = rendererHtml.match(/<meta\s+http-equiv="Content-Security-Policy"\s+content="[^"]*"\s*\/?>/i)?.[0];
  assert.ok(cspMeta, "Build the production renderer before checking its image card");
  const csp = cspMeta.match(/content="([^"]*)"/i)[1];
  const directive = (name) => csp.split(";").map((value) => value.trim().split(/\s+/)).find((value) => value[0] === name)?.slice(1) ?? [];
  assert.deepEqual(directive("script-src"), ["'self'"], "Image support must not relax script execution");
  assert.deepEqual(directive("default-src"), ["'self'"], "Image support must not relax other resource types");
  assert.ok(!directive("img-src").some((source) => ["*", "http:", "file:"].includes(source)), "Image support must not allow arbitrary local or HTTP images");
  const fixture = fs.readFileSync(path.join(__dirname, "image-card-preview.html"), "utf8")
    .replace('<meta charset="UTF-8" />', `<meta charset="UTF-8" />\n    ${cspMeta}`)
    .replace("../../../dist/subscription-oauth-image-card-preview.css", pathToFileURL(path.join(repoRoot, "dist/subscription-oauth-image-card-preview.css")).href)
    .replace("../../../dist/subscription-oauth-image-card-preview.js", pathToFileURL(path.join(repoRoot, "dist/subscription-oauth-image-card-preview.js")).href);
  const fixturePath = path.join(root, "image-card-preview.html");
  fs.writeFileSync(fixturePath, fixture, { flag: "wx" });
  win = new BrowserWindow({ width: 720, height: 760, show: false, webPreferences: {
    preload: path.join(__dirname, "image-card-preload.cjs"),
    nodeIntegration: false, contextIsolation: true, sandbox: false,
  } });
  win.webContents.on("console-message", (event) => {
    if (/Content Security Policy|Refused to load|blocked/i.test(event.message ?? "")) console.error(event.message);
  });
  await win.loadFile(fixturePath);
  await win.webContents.executeJavaScript(`(async () => {
    for (let i = 0; i < 100; i++) {
      if (document.querySelector('.cy-generated-image') && typeof window.chat?.saveGeneratedImage === 'function') return;
      await new Promise(resolve => setTimeout(resolve, 30));
    }
    throw new Error('图片卡片或隔离预加载桥没有挂载');
  })()`);
  await win.webContents.executeJavaScript(`(async () => {
    for (let i = 0; i < 100; i++) {
      const img = document.querySelector('.cy-generated-image img');
      if (img?.complete && img.naturalWidth > 0) return;
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    throw new Error('图片卡片没有加载预览');
  })()`);
  await win.webContents.executeJavaScript("document.querySelector('.cy-generated-image button').click()");
  await win.webContents.executeJavaScript(`(async () => {
    for (let i = 0; i < 100; i++) {
      if (document.querySelector('[role=status]')?.textContent === '原图已保存') return;
      await new Promise(resolve => setTimeout(resolve, 30));
    }
    throw new Error('保存原图按钮没有完成');
  })()`);
  assert.equal(saved, 1);
  assert.deepEqual(fs.readFileSync(path.join(root, "chosen-original.png")), original);
  assert.equal(await win.webContents.executeJavaScript("document.querySelector('.cy-generated-image figcaption span').textContent"), "ChatGPT · 已恢复结果");
  const capture = path.join(repoRoot, "dist/subscription-oauth-image-card-production-csp.png");
  await win.webContents.executeJavaScript("new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))");
  fs.writeFileSync(capture, (await win.capturePage()).toPNG());
  await win.webContents.executeJavaScript("document.querySelector('.cy-generated-image .ant-image').click()");
  await win.webContents.executeJavaScript(`(async () => {
    for (let i = 0; i < 100; i++) {
      const img = [...document.querySelectorAll('img')].find(image => image.src.endsWith('/original'));
      if (img?.complete && img.naturalWidth > 0) return;
      await new Promise(resolve => setTimeout(resolve, 30));
    }
    throw new Error('放大查看原图失败');
  })()`);
  console.log(`正式 CSP / 图片卡片 / 持久协议 / 放大原图 / 保存按钮验证通过：原图 ${original.length} B，预览 ${preview.buffer.length} B；${capture}`);
  await require("esbuild").stop();
  clearTimeout(timer); win.destroy(); app.exit(0);
}).catch((error) => { console.error(error); clearTimeout(timer); app.exit(1); });
// Chromium may still hold its profile/cache files while quitting on Windows.
// Only clean our own generated-image artifacts at this point.
app.on("quit", () => {
  try {
    fs.rmSync(path.join(root, "generated-images"), { recursive: true, force: true });
    if (fs.existsSync(path.join(root, "chosen-original.png"))) fs.unlinkSync(path.join(root, "chosen-original.png"));
  } catch { /* The isolated temporary profile can be cleaned after exit. */ }
});
