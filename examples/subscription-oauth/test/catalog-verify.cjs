"use strict";

/**
 * catalog.cjs 自检：可见/隐藏模型拆分（mock fetch + mock electron）。
 * 运行：node examples/subscription-oauth/test/catalog-verify.cjs
 */
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

(async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "cyrene-catalog-"));
  const Module = require("node:module");
  const originalRequire = Module.prototype.require;
  Module.prototype.require = function (specifier) {
    if (specifier === "electron") {
      return { app: { getPath: () => tempDir } };
    }
    return originalRequire.apply(this, arguments);
  };

  const calls = [];
  global.fetch = async (url) => {
    const target = String(url);
    calls.push(target);
    if (target.includes("codex/models")) {
      const version = (target.match(/client_version=([\d.]+)/) || [])[1];
      // 模拟后端按 client_version 过滤：旧版看不到 gpt-6-astra，新版才可见
      if (version === "0.147.0") {
        return new Response(JSON.stringify({
          models: [
            { slug: "gpt-5.6-sol", visibility: "list", display_name: "GPT-5.6 Sol", context_window: 512000, supported_reasoning_levels: [{ effort: "low" }, { effort: "high" }] },
            { slug: "gpt-6-astra", visibility: "hide", display_name: "GPT-6 Astra" },
            { slug: "gpt-5.5", display_name: "GPT-5.5" },
            { slug: "gpt-4.5-hidden", visibility: "none" },
          ],
        }), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      if (version === "0.152.0") {
        return new Response(JSON.stringify({
          models: [
            { slug: "gpt-5.6-sol", visibility: "list", display_name: "GPT-5.6 Sol" },
            { slug: "gpt-6-astra", visibility: "list", display_name: "GPT-6 Astra" },
            { slug: "gpt-6-astra", visibility: "list", display_name: "GPT-6 Astra 重复" },
          ],
        }), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      return new Response(JSON.stringify({ models: [] }), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    return new Response("{}", { status: 404 });
  };

  const { fetchCatalog } = require("../lib/catalog.cjs");

  let passed = 0;
  async function ok(name, fn) {
    await fn();
    passed += 1;
    console.log(`  ok - ${name}`);
  }

  const result = await fetchCatalog("chatgpt", { accessToken: "t", accountId: "a" });

  await ok("多版本探测：合并可见模型并去重", () => {
    assert.strictEqual(result.ok, true);
    const ids = result.models.map((m) => m.id).sort();
    assert.deepStrictEqual(ids, ["gpt-5.5", "gpt-5.6-sol", "gpt-6-astra"]);
    // 0.147.0 里 astra 是 hide，0.152.0 里是 list → 最终应出现在可见组且只一次
    assert.strictEqual(result.models.filter((m) => m.id === "gpt-6-astra").length, 1);
  });

  await ok("隐藏模型收集（仅 hide/none 且未在可见组出现）", () => {
    const ids = result.hidden.map((m) => m.id).sort();
    assert.deepStrictEqual(ids, ["gpt-4.5-hidden"]);
  });

  await ok("可见模型保留 reasoning efforts / contextWindow", () => {
    const sol = result.models.find((m) => m.id === "gpt-5.6-sol");
    assert.deepStrictEqual(sol.efforts, ["low", "high"]);
    assert.strictEqual(sol.contextWindow, 512000);
  });

  await ok("四个版本都被探测且结果落盘（排查用，不含凭证）", () => {
    assert.strictEqual(calls.filter((u) => u.includes("codex/models")).length, 4);
    const dumpPath = path.join(tempDir, "plugin-data", "subscription-oauth", "catalog-chatgpt-raw.json");
    assert.ok(fs.existsSync(dumpPath));
    const dump = JSON.parse(fs.readFileSync(dumpPath, "utf8"));
    assert.ok(dump.versions["0.147.0"]);
    assert.ok(dump.versions["0.147.0"].hidden.includes("gpt-6-astra"));
    assert.ok(dump.versions["0.152.0"].visible.includes("gpt-6-astra"));
  });

  fs.rmSync(tempDir, { recursive: true, force: true });
  console.log(`\n${passed} 项 catalog 断言全部通过`);
})().catch((e) => { console.error("CATALOG-VERIFY 失败:", e); process.exit(1); });
