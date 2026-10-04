"use strict";

/**
 * token-store 多账号 + model-context 上下文长度自检。
 * 运行：node examples/subscription-oauth/test/multi-account-verify.cjs
 */
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

(async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "cyrene-multi-"));
  const Module = require("node:module");
  const originalRequire = Module.prototype.require;
  Module.prototype.require = function (specifier) {
    if (specifier === "electron") return { app: { getPath: () => tempDir, getAppPath: () => tempDir } };
    return originalRequire.apply(this, arguments);
  };

  const { createTokenStore, accountIdFor } = require("../lib/token-store.cjs");
  const { resolveContextWindow, contextByPattern } = require("../lib/model-context.cjs");

  let passed = 0;
  async function ok(name, fn) {
    await fn();
    passed += 1;
    console.log(`  ok - ${name}`);
  }

  // 内存 secrets（模拟宿主 safeStorage 加密存储）+ 内存 storage（遗留明文兼容）
  const secretsMap = new Map();
  const secrets = {
    get: async (k) => secretsMap.get(k),
    set: async (k, v) => { secretsMap.set(k, v); },
    delete: async (k) => secretsMap.delete(k),
  };
  const storageMap = new Map();
  const storage = {
    get: (k) => storageMap.get(k),
    set: (k, v) => storageMap.set(k, v),
    rootDir: () => tempDir,
  };
  const store = createTokenStore(secrets, storage);

  console.log("token-store 多账号");

  await ok("添加两个账号 → 列表两条，激活的是最后添加的", async () => {
    await store.addAccount("chatgpt", { accessToken: "t1", accountId: "acc-1", accountLabel: "user1@example.com", expiresAt: Date.now() + 3600_000 });
    await store.addAccount("chatgpt", { accessToken: "t2", accountId: "acc-2", accountLabel: "user2@example.com", expiresAt: Date.now() + 3600_000 });
    const info = await store.listAccounts("chatgpt");
    assert.strictEqual(info.accounts.length, 2);
    assert.strictEqual(info.activeAccountId, "acc-2");
    // get 返回激活账号
    const tokens = await store.get("chatgpt");
    assert.strictEqual(tokens.accessToken, "t2");
  });

  await ok("切换账号 → get 返回目标账号 token", async () => {
    const switched = await store.switchAccount("chatgpt", "acc-1");
    assert.strictEqual(switched, true);
    const tokens = await store.get("chatgpt");
    assert.strictEqual(tokens.accessToken, "t1");
    const info = await store.listAccounts("chatgpt");
    assert.strictEqual(info.activeAccountId, "acc-1");
  });

  await ok("同账号重复登录 → 更新而非新增", async () => {
    const result = await store.addAccount("chatgpt", { accessToken: "t1-new", accountId: "acc-1", accountLabel: "user1@example.com" });
    assert.strictEqual(result.added, false);
    const info = await store.listAccounts("chatgpt");
    assert.strictEqual(info.accounts.length, 2);
    assert.strictEqual((await store.get("chatgpt")).accessToken, "t1-new");
  });

  await ok("删除激活账号 → 自动切到剩余账号", async () => {
    await store.removeAccount("chatgpt", "acc-1");
    const info = await store.listAccounts("chatgpt");
    assert.strictEqual(info.accounts.length, 1);
    assert.strictEqual(info.activeAccountId, "acc-2");
    assert.strictEqual((await store.get("chatgpt")).accessToken, "t2");
  });

  await ok("邮箱账号（无 accountId）→ 用邮箱小写作 id", async () => {
    const id = accountIdFor("claude", { accessToken: "x", accountLabel: "User@Example.com" });
    assert.strictEqual(id, "user@example.com");
  });

  await ok("旧版单账号结构自动升级（storage 明文遗留仍可读）", async () => {
    storageMap.set("tokens.grok", { accessToken: "legacy-token", accountLabel: "old@example.com" });
    const tokens = await store.get("grok");
    assert.strictEqual(tokens.accessToken, "legacy-token");
    const info = await store.listAccounts("grok");
    assert.strictEqual(info.accounts.length, 1);
  });

  await ok("secrets 不可用时拒绝写入（不落明文）", async () => {
    const unsafe = createTokenStore(null, storage);
    await assert.rejects(
      () => unsafe.addAccount("chatgpt", { accessToken: "plain", accountLabel: "x@example.com" }),
      /密钥服务不可用/,
    );
  });

  await ok("清空账号后 get 返回 null", async () => {
    await store.remove("chatgpt");
    assert.strictEqual(await store.get("chatgpt"), null);
    const info = await store.listAccounts("chatgpt");
    assert.strictEqual(info.accounts.length, 0);
  });

  console.log("刷新回写（防幽灵账号）");

  await ok("updateAccount 原地更新指定账号，不改激活账号、不新增", async () => {
    await store.addAccount("claude", { accessToken: "c1", accountLabel: "a@example.com", expiresAt: 1 });
    await store.addAccount("claude", { accessToken: "c2", accountLabel: "b@example.com", expiresAt: 1 });
    // 激活的是 b；对 a 做刷新回写
    const updated = await store.updateAccount("claude", "a@example.com", { accessToken: "c1-refreshed", expiresAt: Date.now() + 3600_000 });
    assert.strictEqual(updated, true);
    const info = await store.listAccounts("claude");
    assert.strictEqual(info.accounts.length, 2, "不应新增账号");
    assert.strictEqual(info.activeAccountId, "b@example.com", "激活账号不应被改动");
    // 切到 a 验证刷新后的 token 已写入
    await store.switchAccount("claude", "a@example.com");
    const tokens = await store.get("claude");
    assert.strictEqual(tokens.accessToken, "c1-refreshed");
  });

  await ok("updateAccount 回填缺失的 accountId/标签", async () => {
    await store.addAccount("chatgpt", { accessToken: "t", accountId: "acc-x", accountLabel: "x@example.com" });
    await store.updateAccount("chatgpt", "acc-x", { accessToken: "t-new", expiresAt: Date.now() + 3600_000 });
    const tokens = await store.get("chatgpt");
    assert.strictEqual(tokens.accountId, "acc-x", "accountId 应回填");
    assert.strictEqual(tokens.accountLabel, "x@example.com", "标签应回填");
  });

  console.log("model-context 上下文长度");

  await ok("目录值优先", () => {
    assert.strictEqual(resolveContextWindow("gpt-5.6-sol", 512000), 512000);
    assert.strictEqual(resolveContextWindow("gpt-5.6-sol", "400000"), 400000);
  });

  await ok("目录缺失 → 按模型族兜底", () => {
    assert.strictEqual(contextByPattern("gpt-6-astra"), 512000);
    assert.strictEqual(contextByPattern("gpt-5.6-terra"), 512000);
    assert.strictEqual(contextByPattern("gpt-5.5"), 400000);
    assert.strictEqual(contextByPattern("claude-opus-4-8"), 200000);
    assert.strictEqual(contextByPattern("grok-4.6"), 256000);
  });

  await ok("目录条目多字段名兼容", () => {
    assert.strictEqual(resolveContextWindow("x", undefined, { max_input_tokens: 200000 }), 200000);
    assert.strictEqual(resolveContextWindow("x", undefined, { context_window: 128000 }), 128000);
  });

  await ok("未知模型 → 全局兜底", () => {
    assert.strictEqual(resolveContextWindow("mystery-model"), 256000);
  });

  fs.rmSync(tempDir, { recursive: true, force: true });
  console.log(`\n${passed} 项断言全部通过`);
})().catch((e) => { console.error("MULTI-ACCOUNT-VERIFY 失败:", e); process.exit(1); });
