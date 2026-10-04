"use strict";

/**
 * 用量解析自检：重点是 used_percent=0 的窗口不能被丢弃。
 * 运行：node examples/subscription-oauth/test/usage-verify.cjs
 */
const assert = require("node:assert");

(async () => {
  const { parseChatgptUsage, parseClaudeUsage, parseGrokUsage } = require("../lib/usage.cjs");

  let passed = 0;
  function ok(name, fn) {
    fn();
    passed += 1;
    console.log(`  ok - ${name}`);
  }

  console.log("parseChatgptUsage");

  ok("用量为 0 的窗口必须保留（真实响应里新周期就是 0%）", () => {
    const usage = parseChatgptUsage({
      plan_type: "plus",
      rate_limit: {
        allowed: true,
        primary_window: { used_percent: 0, reset_at: 1788900879 },
        secondary_window: { used_percent: 0, reset_at: 1789487679 },
      },
    });
    assert.strictEqual(usage.plan, "plus");
    assert.strictEqual(usage.windows.length, 2, "0% 窗口不应被丢弃");
    assert.strictEqual(usage.windows[0].usedPercent, 0);
    assert.strictEqual(usage.windows[1].usedPercent, 0);
    assert.ok(usage.windows[0].resetsAt > 0, "重置时间应解析出来");
  });

  ok("非零用量窗口照常解析", () => {
    const usage = parseChatgptUsage({
      plan_type: "plus",
      rate_limit: {
        primary_window: { used_percent: 2.0, reset_at: 1788900879 },
        secondary_window: { used_percent: 32.0, reset_at: 1789487679 },
      },
    });
    assert.strictEqual(usage.windows.length, 2);
    assert.strictEqual(usage.windows[0].usedPercent, 2);
    assert.strictEqual(usage.windows[1].usedPercent, 32);
  });

  ok("小数形式 0.5 归一化为 50%", () => {
    const usage = parseChatgptUsage({
      rate_limit: { primary_window: { used_percent: 0.5 } },
    });
    assert.strictEqual(usage.windows[0].usedPercent, 50);
  });

  console.log("parseClaudeUsage");

  ok("limits 形式：0% 窗口保留", () => {
    const usage = parseClaudeUsage({
      plan: "pro",
      limits: [
        { kind: "session", percent: 0, resets_at: "2026-09-09T04:00:00Z" },
        { kind: "weekly_all", percent: 0 },
      ],
    });
    assert.strictEqual(usage.windows.length, 2);
    assert.strictEqual(usage.windows[0].usedPercent, 0);
    assert.strictEqual(usage.windows[0].label, "5 小时窗口");
  });

  console.log("parseGrokUsage");

  ok("credits 形式：0% 保留", () => {
    const usage = parseGrokUsage({
      config: { creditUsagePercent: 0, currentPeriod: { type: "USAGE_PERIOD_TYPE_WEEKLY", end: "2026-09-15T00:00:00Z" } },
    });
    assert.strictEqual(usage.windows.length, 1);
    assert.strictEqual(usage.windows[0].usedPercent, 0);
    assert.strictEqual(usage.windows[0].label, "每周");
  });

  console.log(`\n${passed} 项用量解析断言全部通过`);
})().catch((e) => { console.error("USAGE-VERIFY 失败:", e); process.exit(1); });
