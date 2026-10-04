"use strict";

/** 端口冲突时，本地代理应自动后移到可用端口。 */
const assert = require("node:assert");
const http = require("node:http");
const { createProxy } = require("../lib/proxy.cjs");

function listen(server, port) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => resolve(server.address().port));
  });
}

function close(server) {
  return new Promise((resolve) => server.close(resolve));
}

function health(port) {
  return new Promise((resolve, reject) => {
    http.get({ host: "127.0.0.1", port, path: "/health" }, (response) => {
      let body = "";
      response.on("data", (chunk) => { body += chunk; });
      response.on("end", () => resolve(JSON.parse(body)));
    }).on("error", reject);
  });
}

(async () => {
  const blocker = http.createServer();
  const blockedPort = await listen(blocker, 0);
  const logs = [];
  const proxy = createProxy({
    getTokens: async () => null,
    log: (message) => logs.push(message),
  });

  try {
    const activePort = await proxy.start(blockedPort);
    assert.notStrictEqual(activePort, blockedPort, "不应继续使用已被占用的端口");
    assert.ok(activePort > 0 && activePort <= 65535);
    assert.deepStrictEqual(await health(activePort), { ok: true, port: activePort });
    assert.ok(logs.some((line) => line.includes("已自动改用")));
    console.log(`ok - ${blockedPort} 被占用时自动改用 ${activePort}`);
  } finally {
    await proxy.stop();
    await close(blocker);
  }
})().catch((error) => {
  console.error("PORT-FALLBACK-VERIFY 失败:", error);
  process.exit(1);
});
