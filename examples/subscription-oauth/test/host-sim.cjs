"use strict";

/**
 * 插件 register 流程的宿主模拟测试：mock electron 与 ctx，
 * 验证 register() 能启动代理并注册 IPC/工具，unregister() 能清理。
 * 运行：node examples/subscription-oauth/test/host-sim.cjs
 */
const assert = require("node:assert");
const fs = require("node:fs");
const http = require("node:http");
const https = require("node:https");
const dns = require("node:dns/promises");
const { EventEmitter } = require("node:events");
const { PassThrough } = require("node:stream");
const os = require("node:os");
const path = require("node:path");

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "cyrene-oauth-host-sim-"));
fs.writeFileSync(path.join(tempDir, "model-settings.json"), JSON.stringify({ modelProfiles: [] }), "utf8");

// 在 require index.cjs 之前 mock electron；注册用不到 shell，但模块顶层会解构
const Module = require("node:module");
const originalRequire = Module.prototype.require;
Module.prototype.require = function (specifier) {
  if (specifier === "electron") {
    return {
      app: { getPath: () => tempDir },
      BrowserWindow: { getAllWindows: () => [] },
      shell: { openExternal: async () => {} },
      nativeImage: { createFromBuffer: () => ({
        isEmpty: () => false, getSize: () => ({ width: 1, height: 1 }),
        toJPEG: () => Buffer.from([0xff, 0xd8, 0xff, 0xdb, 0x00, 0x43, 0xff, 0xd9]),
      }) },
    };
  }
  return originalRequire.apply(this, arguments);
};

const plugin = require("../index.cjs");

// 模拟 ctx：收集 registerIpc / registerTool 的注册结果
// 并模拟宿主框架的自动清理（真实宿主用 resource tracker 在 dispose 时清理 IPC）
const ipcRegistry = new Map();
const tools = [];
const promptProviders = [];
const storageMap = new Map();
const pluginLogs = [];
const ctx = {
  id: "subscription-oauth",
  log: (...args) => {
    pluginLogs.push(args.join(" "));
    console.log("[plugin-log]", ...args);
  },
  registerIpc: (channel, handler) => ipcRegistry.set(`plugin:subscription-oauth:${channel}`, handler),
  unregisterIpc: (channel) => ipcRegistry.delete(`plugin:subscription-oauth:${channel}`),
  registerTool: (tool) => tools.push(tool),
  registerPromptProvider: (provider) => promptProviders.push(provider),
  storage: {
    get: (k) => storageMap.get(k),
    set: (k, v) => storageMap.set(k, v),
    rootDir: () => tempDir,
  },
  deps: {
    // 模拟 secrets：enc: 前缀加密
    secrets: {
      get: async (k) => storageMap.get(`enc:${k}`),
      set: async (k, v) => { storageMap.set(`enc:${k}`, v); },
      delete: async (k) => storageMap.delete(`enc:${k}`),
    },
  },
};

(async () => {
  console.log("1) register() 启动代理…");
  await plugin.register(ctx);

  // 断言 proxy 已启动：取 status IPC 看 port
  console.log("2) 验证 IPC 注册（status/login/logout/catalog/usage）");
  for (const ch of ["status", "login", "logout", "catalog", "usage"]) {
    assert.ok(ipcRegistry.has(`plugin:subscription-oauth:${ch}`), `IPC ${ch} 未注册`);
  }
  assert.strictEqual(tools.length, 2, "应注册状态与生图 2 个工具");
  assert.strictEqual(tools[0].id, "subscription-oauth_status");
  assert.strictEqual(tools[1].id, "subscription-oauth_generate_image");
  assert.strictEqual(tools[1].name, "订阅生图（ChatGPT / Grok）");
  assert.strictEqual(tools[1].ledgerPolicy, "bypass", "重复提示词也应允许重新生图");
  assert.strictEqual(tools[1].needsContext, true, "生图应接收取消信号");
  assert.deepStrictEqual(tools[1].inputSchema.properties.provider.enum, ["auto", "chatgpt", "grok"]);
  assert.ok(tools[1].inputSchema.required.includes("provider"), "模型必须明确选择订阅商或 auto");
  assert.deepStrictEqual(
    tools[1].inputSchema.properties.aspect_ratio.enum,
    ["auto", "1:1", "16:9", "9:16", "3:2", "2:3"],
  );
  assert.strictEqual(promptProviders.length, 1, "应注册生图能力提示词 Provider");
  assert.strictEqual(promptProviders[0].id, "image-generation-capability");
  assert.deepStrictEqual(promptProviders[0].sources, ["conversation"]);
  const imageCapabilityPrompt = await promptProviders[0].provide({
    source: "conversation",
    mode: "chat",
    userText: "你能生图吗",
    signal: new AbortController().signal,
  });
  assert.ok(imageCapabilityPrompt.includes("subscription-oauth_generate_image"));
  assert.ok(imageCapabilityPrompt.includes("Grok Build"));
  assert.ok(imageCapabilityPrompt.includes("`provider`"));
  assert.ok(imageCapabilityPrompt.includes("传 `grok`"));
  assert.ok(imageCapabilityPrompt.includes("不要声称自己没有生图能力"));
  assert.ok(imageCapabilityPrompt.includes("原样保留"));
  assert.ok(!imageCapabilityPrompt.includes("本轮生图前置检索规则"), "只询问能力时不应注入生图任务细则");

  const selfPortraitPrompt = await promptProviders[0].provide({
    source: "conversation",
    mode: "chat",
    userText: "请生成一张你自己的立绘",
    signal: new AbortController().signal,
  });
  assert.ok(selfPortraitPrompt.includes("本轮生图前置检索规则"));
  assert.ok(selfPortraitPrompt.includes("必须先使用本轮可用的联网搜索"));
  assert.ok(selfPortraitPrompt.includes("官方立绘、设定图"));
  assert.ok(selfPortraitPrompt.includes("不得只输出、展示或解释生图提示词"));

  const status = await ipcRegistry.get("plugin:subscription-oauth:status")();
  assert.ok(status.port > 0, `代理端口应为正数，实际 ${status.port}`);
  assert.strictEqual(status.encrypted, true, "secrets 可用时应标记加密");
  for (const id of ["chatgpt", "claude", "grok"]) {
    assert.strictEqual(status.providers[id].connected, false, `${id} 初始应未登录`);
  }
  console.log(`   代理地址: http://127.0.0.1:${status.port}/v1`);

  // 代理服务器真实接收请求：POST /health
  console.log("3) 代理端口实际响应");
  const health = await new Promise((resolve, reject) => {
    http.get({ host: "127.0.0.1", port: status.port, path: "/health" }, (res) => {
      let text = "";
      res.on("data", (c) => { text += c; });
      res.on("end", () => resolve(JSON.parse(text)));
    }).on("error", reject);
  });
  assert.strictEqual(health.ok, true);

  // 4) 模拟登录后 token 存储 → status 显示已连接
  console.log("4) 模拟登录（直接写 token）");
  await ctx.deps.secrets.set("tokens.grok", JSON.stringify({
    accessToken: "test-jwt",
    expiresAt: Date.now() + 3600_000,
    accountLabel: "test@grok.example",
  }));
  const statusAfter = await ipcRegistry.get("plugin:subscription-oauth:status")();
  assert.strictEqual(statusAfter.providers.grok.connected, true);
  assert.strictEqual(statusAfter.providers.grok.accountLabel, "test@grok.example");

  // 5) 工具 execute
  console.log("5) 工具 execute 输出");
  const toolOutput = await tools[0].execute({});
  assert.ok(toolOutput.includes("已登录") || toolOutput.includes("未登录"));
  assert.ok(!toolOutput.includes("test@grok.example"), "AI 工具不得输出账号标签");
  assert.ok(!pluginLogs.join("\n").includes("test@grok.example"), "主进程日志不得输出账号标签");
  console.log("   " + toolOutput.replace(/\n/g, " | "));

  // 注册后的生产工具：仅使用虚构 token 与模拟网络响应，不消耗真实订阅。
  console.log("6) 生图工具参考图 / 图片卡片 / 退出登录后恢复");
  const previousFetch = global.fetch;
  const previousLookup = dns.lookup;
  const previousRequest = https.request;
  const referencePng = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64");
  let referenceDownloads = 0;
  dns.lookup = async (hostname) => {
    assert.strictEqual(hostname, "official.test");
    return [{ address: "8.8.8.8", family: 4 }];
  };
  https.request = (url, options, callback) => {
    assert.strictEqual(url.href, "https://official.test/reference.png");
    assert.ok(!options.headers.authorization && !options.headers.cookie, "参考图 CDN 不得收到账号凭据");
    options.lookup(url.hostname, {}, (error, address, family) => {
      assert.ifError(error); assert.strictEqual(address, "8.8.8.8"); assert.strictEqual(family, 4);
    });
    const response = Object.assign(new PassThrough(), { statusCode: 200, headers: { "content-type": "image/png" } });
    return Object.assign(new EventEmitter(), {
      end: () => queueMicrotask(() => { referenceDownloads++; callback(response); response.end(referencePng); }),
      destroy: () => response.destroy(),
    });
  };
  let imageRequests = 0;
  global.fetch = async (url, init) => {
    imageRequests++;
    assert.strictEqual(url, "https://cli-chat-proxy.grok.com/v1/images/edits");
    assert.strictEqual(JSON.parse(init.body).image.url, `data:image/png;base64,${referencePng.toString("base64")}`);
    return new Response(JSON.stringify({ data: [{ b64_json: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=" }] }), { status: 200 });
  };
  try {
    const toolContext = {
      conversationId: "test-conversation", userMessageId: "test-user-action", runId: "test-run", userQuery: "画一张角色图",
      metadata: { provider: "Grok（xAI）", model: "grok-code" }, reportProgress: () => {},
      storeGeneratedImage: async (image) => {
        assert.ok(Buffer.isBuffer(image.original) && Buffer.isBuffer(image.preview));
        return { kind: "cyrene.generated-image", id: image.id };
      },
    };
    const result = JSON.parse(await tools[1].execute({
      provider: "auto", prompt: "portrait", subject: "Character / official", visual_description: "Pink hair",
      reference_urls: ["https://official.test/reference.png"], source_urls: ["https://official.test/character"],
    }, toolContext));
    assert.strictEqual(result.kind, "cyrene.generated-image");
    const cachedPrompt = await promptProviders[0].provide({ source: "conversation", mode: "chat", userText: "给我一张照片", conversationId: toolContext.conversationId });
    assert.ok(cachedPrompt.includes("Pink hair") && cachedPrompt.includes("本会话已核对"));
    await ipcRegistry.get("plugin:subscription-oauth:logout")("grok");
    const recovered = JSON.parse(await tools[1].execute({ provider: "auto", prompt: "rewritten portrait" }, { ...toolContext, runId: "retry" }));
    assert.strictEqual(recovered.id, result.id);
    assert.strictEqual(recovered.reused, true);
    assert.strictEqual(imageRequests, 1);
    assert.strictEqual(referenceDownloads, 1, "已保存结果恢复时无需再次下载参考图");
    assert.ok(!result.id.includes(referencePng.toString("base64")), "聊天输出只能携带图片 ID");
  } finally { global.fetch = previousFetch; dns.lookup = previousLookup; https.request = previousRequest; }

  // 7) unregister 清理（真实宿主在 dispose() 里自动清 IPC；这里验证插件自身的资源清理）
  console.log("7) unregister() 清理");
  await plugin.unregister();
  // 插件自身不直接清 IPC（宿主框架负责），但代理端口应已关闭
  const stopHealth = await new Promise((resolve) => {
    http.get({ host: "127.0.0.1", port: status.port, path: "/health" }, () => resolve("up"))
      .on("error", () => resolve("down"));
  });
  assert.strictEqual(stopHealth, "down", "unregister 后代理端口应已关闭");
  fs.rmSync(tempDir, { recursive: true, force: true });

  console.log("\n全部宿主模拟断言通过 ✓");
})().catch((e) => { console.error("HOST-SIM 失败:", e); process.exit(1); });
