"use strict";

const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const {
  sanitizeLogText,
  sanitizeLogArg,
  sanitizeDiagnosticPayload,
  sensitiveDiagnosticKey,
} = require("../lib/privacy.cjs");

let passed = 0;
function ok(name, fn) {
  fn();
  passed += 1;
  console.log(`  ok - ${name}`);
}

console.log("日志与诊断脱敏");
ok("邮箱 / accountId / UUID / Bearer / token 字段均被清洗", () => {
  const input = "user@example.com account_deadbeef1234 123e4567-e89b-42d3-a456-426614174000 "
    + "Bearer abcdefghijklmnop access_token=secret-value";
  const output = sanitizeLogText(input);
  for (const secret of ["user@example.com", "account_deadbeef1234", "123e4567-e89b-42d3-a456-426614174000", "abcdefghijklmnop", "secret-value"]) {
    assert.ok(!output.includes(secret), `仍包含敏感片段: ${secret}`);
  }
});

ok("对象不会被日志框架展开", () => {
  assert.strictEqual(sanitizeLogArg({ accessToken: "secret" }), "[redacted-object]");
});

ok("诊断副本递归移除敏感键并保留用量结构", () => {
  const source = {
    plan: "pro",
    accountId: "account_deadbeef1234",
    nested: { email: "user@example.com", access_token: "secret", used_percent: 0 },
    model_usage: { "gpt-6-astra": { available: true } },
  };
  const output = sanitizeDiagnosticPayload(source);
  assert.strictEqual(output.accountId, "[redacted]");
  assert.strictEqual(output.nested.email, "[redacted]");
  assert.strictEqual(output.nested.access_token, "[redacted]");
  assert.strictEqual(output.nested.used_percent, 0);
  assert.strictEqual(output.model_usage["gpt-6-astra"].available, true);
  assert.strictEqual(source.nested.access_token, "secret", "不得修改原对象");
});

ok("敏感键判断不会误伤 max_tokens", () => {
  assert.strictEqual(sensitiveDiagnosticKey("refreshToken"), true);
  assert.strictEqual(sensitiveDiagnosticKey("organization_id"), true);
  assert.strictEqual(sensitiveDiagnosticKey("max_tokens"), false);
});

console.log("无边框 UI 与 manifest");
const root = path.resolve(__dirname, "..");
const indexSource = fs.readFileSync(path.join(root, "index.cjs"), "utf8");
const uiSource = fs.readFileSync(path.join(root, "ui.html"), "utf8");
const manifest = JSON.parse(fs.readFileSync(path.join(root, "manifest.json"), "utf8"));

ok("BrowserWindow 使用 frame:false 与插件图标", () => {
  assert.match(indexSource, /frame:\s*false/);
  assert.match(indexSource, /icon:\s*path\.join\(__dirname,\s*"icon\.png"\)/);
});

ok("自绘按钮使用 SVG 与 aria-label，不依赖易错位的 title 提示", () => {
  assert.match(uiSource, /id="btn-min"[^>]*aria-label="最小化"/);
  assert.match(uiSource, /id="btn-close"[^>]*aria-label="关闭"/);
  assert.ok(!/id="btn-(?:min|close)"[^>]*\btitle=/.test(uiSource));
});

ok("manifest 版本、署名与 icon 一致", () => {
  assert.strictEqual(manifest.version, "1.3.4");
  assert.strictEqual(manifest.author, "1971687396");
  assert.strictEqual(manifest.icon, "icon.png");
  assert.ok(fs.statSync(path.join(root, manifest.icon)).size <= 2 * 1024 * 1024);
});

ok("生产日志源码不再主动拼接账号标签或 accountId", () => {
  assert.ok(!indexSource.includes("accountTag"));
  assert.ok(!indexSource.includes("slice(0, 8)"));
  const toolBlock = indexSource.slice(indexSource.indexOf('id: "subscription-oauth_status"'));
  assert.ok(!toolBlock.includes("info.accountLabel"));
});

console.log(`\n${passed} 项隐私 / UI 断言全部通过`);
