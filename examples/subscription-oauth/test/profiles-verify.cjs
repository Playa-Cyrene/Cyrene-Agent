"use strict";

// 运行生产渲染桥接脚本，验证多模型同步、旧会话迁移及失败恢复。
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const vm = require("node:vm");
const Module = require("node:module");

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "cyrene-profiles-"));
const settingsFile = path.join(tempDir, "model-settings.json");
let mockWindows = [];
const originalRequire = Module.prototype.require;
Module.prototype.require = function (specifier) {
  if (specifier === "electron") return {
    app: { getPath: () => tempDir },
    BrowserWindow: { getAllWindows: () => mockWindows },
  };
  return originalRequire.apply(this, arguments);
};
const profiles = require("../lib/profiles.cjs");
const copy = (value) => JSON.parse(JSON.stringify(value));
const read = () => JSON.parse(fs.readFileSync(settingsFile, "utf8"));
const write = (value) => fs.writeFileSync(settingsFile, JSON.stringify(value, null, 2), "utf8");
const userProfile = { id: "user-1", provider: "自定义渠道", model: "grok-4.6", baseUrl: "https://example.test/v1", apiKey: "user-key" };
const models = [
  { id: "grok-4.6", name: "Grok 4.6", efforts: ["xhigh", "high", "medium", "low"], contextWindow: 256000 },
  { id: "grok-4.6-lite", name: "Grok 4.6 Lite", contextWindow: 131072 },
];

function hostWindow(sessions = new Map(), controls = {}) {
  const calls = [];
  const catalog = () => { const s = read(); return { profiles: s.modelProfiles, defaultModelProfileId: s.defaultModelProfileId }; };
  const settings = {
    listModelProfiles: async () => catalog(),
    saveModelProfile: async (profile) => {
      calls.push(["save", profile.id]);
      const s = read();
      const normalized = copy(profile);
      if (controls.singleModelOnly || normalized.models?.length <= 1) delete normalized.models;
      const i = s.modelProfiles.findIndex((saved) => saved.id === profile.id);
      if (i >= 0) s.modelProfiles[i] = normalized;
      else s.modelProfiles.push(normalized);
      s.defaultModelProfileId ??= normalized.id;
      write(s);
      return { added: true, ...catalog() };
    },
    setDefaultModelProfile: async (id) => { const s = read(); s.defaultModelProfileId = id; write(s); return catalog(); },
    deleteModelProfile: async (id) => {
      calls.push(["delete", id]);
      const s = read();
      s.modelProfiles = s.modelProfiles.filter((p) => p.id !== id);
      if (s.defaultModelProfileId === id) s.defaultModelProfileId = s.modelProfiles[0]?.id;
      write(s);
      return catalog();
    },
  };
  const chatStore = controls.noChats ? undefined : {
    list: async () => [...sessions.values()].map((session) => ({ id: session.id, mode: session.mode })),
    get: async (id) => copy(sessions.get(id) || null),
    setModelProfile: async (id, modelProfileId) => {
      calls.push(["bind", id, modelProfileId]);
      if (controls.failRollback && modelProfileId.endsWith("legacy-multi")) throw new Error("simulated-rollback-failure");
      const session = sessions.get(id);
      if (!session) return null;
      session.modelProfileId = modelProfileId;
      session.model = read().modelProfiles.find((p) => p.id === modelProfileId)?.model;
      return copy(session);
    },
    setSessionModel: async (id, model) => {
      calls.push(["model", id, model]);
      const session = sessions.get(id);
      if (controls.failSession === id) return { ok: false, error: "simulated-failure" };
      const p = read().modelProfiles.find((profile) => profile.id === session?.modelProfileId);
      if (!p || !(p.models || [p.model]).includes(model)) return { ok: false, error: "invalid-model" };
      session.model = model;
      return { ok: true, session: copy(session) };
    },
  };
  return {
    calls,
    isDestroyed: () => false,
    webContents: { executeJavaScript: (script) => vm.runInNewContext(script, { window: { settings, chatStore } }) },
  };
}

function legacyFixture() {
  return {
    provider: "自定义渠道", defaultModelProfileId: "oauth-sub-chatgpt-gpt-5.6-luna",
    modelProfiles: [
      copy(userProfile),
      { id: "oauth-sub-chatgpt-gpt-6-sol", provider: "ChatGPT（OpenAI）订阅", displayName: "ChatGPT（OpenAI）订阅 · GPT-6 Sol", model: "gpt-6-sol", baseUrl: "http://127.0.0.1:6231/v1", contextWindowTokens: 256000, multimodal: false },
      { id: "oauth-sub-chatgpt-gpt-5.6-luna", provider: "ChatGPT（OpenAI）订阅", model: "gpt-5.6-luna", baseUrl: "http://127.0.0.1:6231/v1", contextWindowTokens: 512000, reasoning: { mode: "on", effort: "low" } },
      { id: "oauth-sub-chatgpt-gpt-6-astra", provider: "ChatGPT（OpenAI）订阅", model: "gpt-6-astra", baseUrl: "http://127.0.0.1:6231/v1", contextWindowTokens: 400000, modelOptions: { "gpt-6-astra": { manualReasoning: { style: "openai-effort", supportedEfforts: ["low", "xhigh"], defaultEffort: "xhigh", supportsDisable: false } } } },
      { id: "oauth-sub-grok", provider: "Grok（xAI）订阅", model: "grok-4.6", baseUrl: "http://127.0.0.1:6231/v1" },
    ],
  };
}

let passed = 0;
async function ok(name, fn) { await fn(); passed += 1; console.log(`  ok - ${name}`); }

(async () => {
  await ok("一个渠道一个档案，能力按模型分别保存", () => {
    const built = profiles.buildProfiles("grok", models, { port: 6231 });
    assert.equal(built.length, 1);
    const p = built[0];
    assert.equal(p.id, "oauth-sub-grok");
    assert.deepEqual(p.models, models.map((m) => m.id));
    assert.equal(p.displayName, "Grok（xAI）订阅");
    assert.equal(p.baseUrl, "http://127.0.0.1:6231/v1");
    assert.equal(p.apiKey, "oauth-subscription");
    assert.equal(p.nativeWebSearch, true);
    assert.equal(p.explicitTransport, "responses");
    assert.equal(p.modelOptions[models[0].id].contextWindowTokens, 256000);
    assert.equal(p.modelOptions[models[1].id].contextWindowTokens, 131072);
    assert.equal(p.modelOptions[models[0].id].manualReasoning.defaultEffort, "medium");
    assert.equal(profiles.buildProfiles("claude", [{ id: "claude-sonnet-4.6" }], { port: 6231 })[0].explicitTransport, "anthropic");
  });

  await ok("推理档位排序包含 max，忽略未知值；空目录不生成无效档案", () => {
    assert.deepEqual(profiles.reasoningFromModel({ efforts: ["max", "xhigh", "high", "medium", "low", "invalid"] }), { mode: "on", effort: "high" });
    assert.equal(profiles.reasoningFromModel({ efforts: ["none", "invalid"] }), undefined);
    assert.deepEqual(profiles.buildProfiles("grok", [], { port: 6231 }), []);
    assert.throws(() => profiles.buildProfiles("unknown", models, { port: 6231 }), /未知/);
  });

  await ok("公开 API 写入一个渠道档案，保留非插件档案与默认设置", async () => {
    write({ provider: "自定义渠道", modelProfiles: [copy(userProfile)], defaultModelProfileId: "user-1" });
    mockWindows = [hostWindow()];
    const result = await profiles.syncProfilesIntoModelSettings("grok", models, { port: 6231 });
    assert.equal(result.ok, true, result.error);
    assert.equal(result.added, 1);
    assert.equal(result.modelCount, 2);
    assert.equal(result.profiles, 2);
    assert.equal(result.degraded, undefined);
    assert.deepEqual(read().modelProfiles[0], userProfile);
    assert.equal(read().defaultModelProfileId, "user-1");
  });

  await ok("重复同步及并发手动添加不产生重复档案、不丢模型", async () => {
    const repeated = await profiles.syncProfilesIntoModelSettings("grok", models, { port: 6231 });
    assert.equal(repeated.added, 0);
    assert.equal(repeated.updated, 1);
    await Promise.all([
      profiles.syncProfilesIntoModelSettings("grok", [{ id: "grok-manual-a" }], { port: 6231 }),
      profiles.syncProfilesIntoModelSettings("grok", [{ id: "grok-manual-b" }], { port: 6231 }),
    ]);
    const p = read().modelProfiles.find((p) => p.id === "oauth-sub-grok");
    assert.deepEqual(p.models, [...models.map((m) => m.id), "grok-manual-a", "grok-manual-b"]);
    assert.equal(read().modelProfiles.length, 2);
  });

  await ok("重新同步保留用户的默认模型、昵称、上下文、视觉开关和手动推理规则", async () => {
    const s = read();
    const p = s.modelProfiles.find((p) => p.id === "oauth-sub-grok");
    p.model = "grok-4.6-lite";
    p.displayName = "我的 Grok";
    p.modelOptions["grok-4.6"] = { contextWindowTokens: 64000, multimodal: false, manualReasoning: { style: "openai-effort", supportedEfforts: ["low"], defaultEffort: "low", supportsDisable: false } };
    write(s);
    await profiles.syncProfilesIntoModelSettings("grok", models, { port: 6232 });
    const after = read().modelProfiles.find((p) => p.id === "oauth-sub-grok");
    assert.equal(after.model, "grok-4.6-lite");
    assert.equal(after.displayName, "我的 Grok");
    assert.deepEqual(after.modelOptions["grok-4.6"], p.modelOptions["grok-4.6"]);
    assert.ok(after.models.includes("grok-manual-a"));
    assert.equal(after.baseUrl, "http://127.0.0.1:6232/v1");
  });

  await ok("合并旧档案，迁移所有模式的会话，保留默认模型与手动/隐藏模型", async () => {
    const fixture = legacyFixture();
    write(fixture);
    const sessions = new Map([
      ["chat", { id: "chat", mode: "chat", modelProfileId: fixture.modelProfiles[1].id }],
      ["work", { id: "work", mode: "work", modelProfileId: fixture.modelProfiles[3].id, model: "gpt-6-astra" }],
      ["code", { id: "code", mode: "code", modelProfileId: fixture.modelProfiles[1].id, model: "invalid" }],
      ["other", { id: "other", modelProfileId: "user-1", model: "grok-4.6" }],
    ]);
    const win = hostWindow(sessions);
    mockWindows = [win];
    const result = await profiles.refreshProfilesInHostCache(6240);
    assert.equal(result.ok, true, result.error);
    assert.equal(result.synced, 2);
    assert.equal(result.removed, 2);
    assert.equal(result.migratedSessions, 3);
    const s = read();
    assert.equal(s.modelProfiles.length, 3);
    assert.equal(s.defaultModelProfileId, fixture.defaultModelProfileId);
    const p = s.modelProfiles.find((p) => p.id === fixture.defaultModelProfileId);
    assert.equal(p.model, "gpt-5.6-luna");
    assert.deepEqual(p.models, ["gpt-5.6-luna", "gpt-6-sol", "gpt-6-astra"]);
    assert.equal(p.modelOptions["gpt-6-sol"].multimodal, false);
    assert.deepEqual(p.modelOptions["gpt-6-astra"].manualReasoning, fixture.modelProfiles[3].modelOptions["gpt-6-astra"].manualReasoning);
    for (const id of ["chat", "work", "code"]) assert.equal(sessions.get(id).modelProfileId, p.id);
    assert.equal(sessions.get("chat").model, "gpt-6-sol");
    assert.equal(sessions.get("work").model, "gpt-6-astra");
    assert.equal(sessions.get("code").model, "gpt-6-sol");
    assert.equal(sessions.get("other").modelProfileId, "user-1");
    assert.ok(win.calls.findIndex((call) => call[0] === "delete") > win.calls.findLastIndex((call) => call[0] === "model"));
  });

  await ok("会话迁移中途失败时保留旧档案，重试后完成清理", async () => {
    const fixture = legacyFixture(); write(fixture);
    const oldId = fixture.modelProfiles[1].id;
    const sessions = new Map([["failure", { id: "failure", modelProfileId: oldId, model: "gpt-6-sol" }]]);
    const controls = { failSession: "failure" };
    mockWindows = [hostWindow(sessions, controls)];
    const pending = await profiles.refreshProfilesInHostCache(6231);
    assert.equal(pending.migrationPending, true);
    assert.equal(read().modelProfiles.length, 5);
    assert.equal(sessions.get("failure").modelProfileId, oldId);
    assert.equal(sessions.get("failure").model, "gpt-6-sol");
    delete controls.failSession;
    const completed = await profiles.refreshProfilesInHostCache(6231);
    assert.equal(completed.migrationPending, undefined);
    assert.equal(read().modelProfiles.length, 3);
    assert.equal(sessions.get("failure").model, "gpt-6-sol");
  });

  await ok("会话 API 未就绪时不删除旧档案", async () => {
    write(legacyFixture()); mockWindows = [hostWindow(new Map(), { noChats: true })];
    const result = await profiles.refreshProfilesInHostCache(6231);
    assert.equal(result.migrationPending, true);
    assert.equal(read().modelProfiles.length, 5);
  });

  await ok("模型恢复与回滚同时失败，持久化记录仍能恢复原来选择的非默认模型", async () => {
    write({
      modelProfiles: [
        { id: "oauth-sub-chatgpt", model: "gpt-6-sol", models: ["gpt-6-sol", "gpt-5.6-luna", "gpt-6-astra"] },
        { id: "oauth-sub-chatgpt-legacy-multi", model: "gpt-5.6-luna", models: ["gpt-5.6-luna", "gpt-6-astra"] },
      ],
      defaultModelProfileId: "oauth-sub-chatgpt",
    });
    const sessions = new Map([["recover", { id: "recover", modelProfileId: "oauth-sub-chatgpt-legacy-multi", model: "gpt-6-astra" }]]);
    const controls = { failSession: "recover", failRollback: true };
    mockWindows = [hostWindow(sessions, controls)];
    const failed = await profiles.refreshProfilesInHostCache(6231);
    assert.equal(failed.migrationPending, true);
    assert.equal(sessions.get("recover").modelProfileId, "oauth-sub-chatgpt");
    assert.equal(sessions.get("recover").model, "gpt-6-sol");
    const journal = path.join(tempDir, "plugin-data", "subscription-oauth", "profile-migration.json");
    assert.equal(JSON.parse(fs.readFileSync(journal, "utf8"))[0].model, "gpt-6-astra");
    mockWindows = [hostWindow(sessions)];
    const restored = await profiles.refreshProfilesInHostCache(6231);
    assert.equal(restored.migrationPending, undefined);
    assert.equal(sessions.get("recover").model, "gpt-6-astra");
    assert.equal(read().modelProfiles.length, 1);
    assert.deepEqual(JSON.parse(fs.readFileSync(journal, "utf8")), []);
  });

  await ok("无窗口回退只更新渠道档案，宿主窗口就绪后继续迁移", async () => {
    write(legacyFixture()); mockWindows = [];
    const result = await profiles.syncProfilesIntoModelSettings("chatgpt", [{ id: "gpt-new-hidden" }], { port: 6233 });
    assert.equal(result.degraded, true);
    assert.equal(result.migrationPending, true);
    assert.equal(result.modelCount, 4);
    assert.equal(read().modelProfiles.length, 5);
    mockWindows = [hostWindow()];
    await profiles.refreshProfilesInHostCache(6233);
    assert.equal(read().modelProfiles.length, 3);
    assert.ok(read().modelProfiles.find((p) => p.id.startsWith("oauth-sub-chatgpt")).models.includes("gpt-new-hidden"));
  });

  await ok("端口迁移同时识别新渠道 id 和旧模型 id，不改用户档案", () => {
    write(legacyFixture());
    assert.equal(profiles.preferredProxyPortFromProfiles(6239), 6231);
    const rebound = profiles.rebindProfilesToProxyPort(6244);
    assert.equal(rebound.updated, 4);
    assert.equal(profiles.preferredProxyPortFromProfiles(6231), 6244);
    assert.deepEqual(read().modelProfiles[0], userProfile);
    assert.ok(read().modelProfiles.slice(1).every((p) => p.nativeWebSearch && p.explicitTransport === "responses" && p.baseUrl.endsWith(":6244/v1")));
  });

  await ok("无窗口删除渠道时保留有效的其他默认档案，只修复已删除的默认档案", async () => {
    const fixture = legacyFixture(); fixture.defaultModelProfileId = "user-1";
    write(fixture); mockWindows = [];
    const removed = await profiles.removeProfilesForProvider("grok");
    assert.equal(removed.removed, 1);
    assert.equal(read().defaultModelProfileId, "user-1");
    const s = read(); s.defaultModelProfileId = s.modelProfiles[1].id; write(s);
    await profiles.removeProfilesForProvider("chatgpt");
    assert.deepEqual(read().modelProfiles, [userProfile]);
    assert.equal(read().defaultModelProfileId, "user-1");
  });

  await ok("旧宿主不支持模型清单时拒绝迁移，不删除旧档案", async () => {
    write(legacyFixture()); mockWindows = [hostWindow(new Map(), { singleModelOnly: true })];
    const result = await profiles.syncProfilesIntoModelSettings("chatgpt", [{ id: "gpt-6-sol" }], { port: 6231 });
    assert.equal(result.ok, false);
    assert.equal(result.incompatibleHost, true);
    assert.equal(result.degraded, undefined);
    assert.equal(read().modelProfiles.length, 5);
  });

  await ok("首次无配置文件可创建渠道档案；损坏的配置不会被覆盖", async () => {
    fs.unlinkSync(settingsFile); mockWindows = [];
    const created = await profiles.syncProfilesIntoModelSettings("grok", models, { port: 6231 });
    assert.equal(created.ok, true, created.error);
    assert.equal(read().defaultModelProfileId, "oauth-sub-grok");
    fs.writeFileSync(settingsFile, "invalid-json", "utf8");
    const failed = await profiles.syncProfilesIntoModelSettings("grok", models, { port: 6231 });
    assert.equal(failed.ok, false);
    assert.equal(fs.readFileSync(settingsFile, "utf8"), "invalid-json");
  });

  console.log(`\n${passed} 项订阅渠道档案验证全部通过`);
})().catch((error) => { console.error(error); process.exitCode = 1; }).finally(() => {
  Module.prototype.require = originalRequire;
  fs.rmSync(tempDir, { recursive: true, force: true });
});
