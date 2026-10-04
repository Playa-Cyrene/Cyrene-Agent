"use strict";

// 用真实 Electron 运行时验证宿主安装器，读取本地构建包，不安装到用户目录。
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { app } = require("electron");
const { preparePluginZip } = require("../../../dist/main/plugins/installer.js");

app.whenReady().then(async () => {
  const repoRoot = path.resolve(__dirname, "..", "..", "..");
  const sourceRoot = path.join(repoRoot, "examples", "subscription-oauth");
  const manifest = JSON.parse(fs.readFileSync(path.join(sourceRoot, "manifest.json"), "utf8"));
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "cyrene-oauth-installer-test-"));
  const timer = setTimeout(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
    console.error("宿主安装器验证超时");
    app.exit(1);
  }, 10000);
  try {
    const prepared = await preparePluginZip(
      path.join(repoRoot, "dist", `${manifest.id}-${manifest.version}.zip`),
      path.join(tempDir, "plugins"),
      { expectedIdentity: { id: manifest.id, version: manifest.version } },
    );
    const files = fs.readdirSync(prepared.pluginDir, { recursive: true })
      .filter((file) => fs.statSync(path.join(prepared.pluginDir, file)).isFile());
    const expected = ["manifest.json", "index.cjs", "ui.html", "README.md", "icon.png",
      ...fs.readdirSync(path.join(sourceRoot, "lib")).filter((file) => file.endsWith(".cjs")).map((file) => path.join("lib", file))];
    assert.deepEqual(files.sort(), expected.sort());
    for (const file of files) assert.deepEqual(
      fs.readFileSync(path.join(prepared.pluginDir, file)), fs.readFileSync(path.join(sourceRoot, file)),
    );
    console.log(`宿主安装器通过：${manifest.id}@${manifest.version}，${files.length} 个文件与源码逐字节一致`);
  } finally {
    clearTimeout(timer);
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
  app.quit();
}).catch((error) => {
  console.error(error);
  app.exit(1);
});
