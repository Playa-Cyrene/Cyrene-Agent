"use strict";

/**
 * 本地视觉预览：使用完全虚构的数据加载生产 ui.html，不读取任何账号或凭据。
 * 运行：npx electron examples/subscription-oauth/test/ui-preview.cjs
 */
const path = require("node:path");
const fs = require("node:fs");
const { app, BrowserWindow, ipcMain } = require("electron");

const pluginRoot = path.resolve(__dirname, "..");
const captureFlag = process.argv.indexOf("--capture");
const capturePath = captureFlag >= 0 && process.argv[captureFlag + 1]
  ? path.resolve(process.argv[captureFlag + 1])
  : undefined;
let previewWindow;

function fakeStatus() {
  return {
    port: 6231,
    encrypted: true,
    providers: {
      chatgpt: {
        connected: true,
        accountLabel: "preview.one@example.com",
        expiresAt: Date.now() + 60 * 60 * 1000,
        activeAccountId: "preview-account-one",
        accounts: [
          { id: "preview-account-one", label: "preview.one@example.com", expiresAt: Date.now() + 60 * 60 * 1000 },
          { id: "preview-account-two", label: "preview.two@example.com", expiresAt: Date.now() + 2 * 60 * 60 * 1000 },
        ],
      },
      claude: { connected: false, accounts: [] },
      grok: { connected: false, accounts: [] },
    },
  };
}

app.whenReady().then(async () => {
  ipcMain.handle("plugin:subscription-oauth:status", () => fakeStatus());
  ipcMain.handle("plugin:subscription-oauth:login", () => ({ ok: false, error: "视觉预览不执行登录" }));
  ipcMain.handle("plugin:subscription-oauth:logout", () => ({ ok: true }));
  ipcMain.handle("plugin:subscription-oauth:switchAccount", () => ({ ok: true }));
  ipcMain.handle("plugin:subscription-oauth:removeAccount", () => ({ ok: true }));
  ipcMain.handle("plugin:subscription-oauth:catalog", () => ({
    ok: true,
    models: [
      { id: "gpt-6-sol", name: "GPT-6 Sol", contextWindow: 512000, efforts: ["low", "medium", "high", "xhigh", "max"] },
      { id: "gpt-5.6-luna", name: "GPT-5.6 Luna", contextWindow: 512000, efforts: ["low", "medium", "high"] },
    ],
    hidden: [{ id: "gpt-6-astra", name: "GPT-6 Astra", contextWindow: 512000 }],
  }));
  ipcMain.handle("plugin:subscription-oauth:usage", () => ({ ok: true, usage: { plan: "Preview", windows: [] } }));
  ipcMain.handle("plugin:subscription-oauth:syncProfiles", (_event, _provider, options) => ({
    ok: true, added: 0, updated: 1, modelCount: options?.includeHidden ? 3 : 2, removed: 1,
  }));
  ipcMain.handle("plugin:subscription-oauth:addModel", () => ({ ok: true, added: 0, updated: 1, modelCount: 3 }));

  previewWindow = new BrowserWindow({
    width: 860,
    height: 640,
    minWidth: 480,
    minHeight: 480,
    frame: false,
    backgroundColor: "#fff9fc",
    icon: path.join(pluginRoot, "icon.png"),
    webPreferences: { nodeIntegration: true, contextIsolation: false },
  });
  ipcMain.on("plugin:subscription-oauth:win-minimize", () => previewWindow?.minimize());
  ipcMain.on("plugin:subscription-oauth:win-close", () => previewWindow?.close());
  await previewWindow.loadFile(path.join(pluginRoot, "ui.html"));
  previewWindow.setTitle("订阅 OAuth · 本地预览");
  previewWindow.on("closed", () => app.quit());
  if (capturePath) {
    await new Promise((resolve) => setTimeout(resolve, 250));
    await previewWindow.webContents.executeJavaScript("selectProvider('chatgpt')");
    const result = await previewWindow.webContents.executeJavaScript(`(async () => {
      const sync = [...document.querySelectorAll('#detail button')].find((button) => button.textContent === '同步模型到渠道档案');
      if (!sync) throw new Error('渠道同步按钮未显示');
      await sync.onclick();
      const message = document.getElementById('status-msg').textContent;
      if (!message.includes('一个渠道档案') || !message.includes('2 个模型')) throw new Error(message);
      document.querySelector('.content-scroll').scrollTop = document.querySelector('.content-scroll').scrollHeight;
      return message;
    })()`);
    console.log(result);
    fs.mkdirSync(path.dirname(capturePath), { recursive: true });
    fs.writeFileSync(capturePath, (await previewWindow.capturePage()).toPNG());
    console.log(`预览截图已写入: ${capturePath}`);
    app.quit();
  }
});

app.on("window-all-closed", () => app.quit());
