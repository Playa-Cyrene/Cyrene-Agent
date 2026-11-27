import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { test } from "node:test";

const exec = promisify(execFile);
const script = new URL("./issue-triage.mjs", import.meta.url).href;
const secret = "fixture-secret-do-not-log";
const issue = { number: 10, title: "sqlite persistence", body: "本 Issue 由我本人阅读、核对并整理", user: { type: "User" }, author_association: "NONE", labels: [] };
const json = (value) => ({ body: JSON.stringify(value) });
const verdict = { duplicateOf: 20, duplicateConfidence: "high", needsInfo: true, needsMaintainer: false };
const search = json({ items: [{ number: 20, title: "sqlite", body: "fixture" }] });
const modelContent = (content) => json({ choices: [{ message: { content } }] });
const model = modelContent(JSON.stringify(verdict));

// 在独立进程运行真实入口；fetch 完全替换，不会连接 GitHub、模型或写入外部状态。
async function run(responses, { event = { issue }, env = {} } = {}) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "issue-triage-test-"));
  try {
    const eventPath = path.join(dir, "event.json");
    await writeFile(eventPath, JSON.stringify(event));
    const harness = `
      const responses = ${JSON.stringify(responses)};
      const calls = [];
      globalThis.fetch = async (url, init = {}) => {
        calls.push({ url, method: init.method || "GET", body: init.body ? JSON.parse(init.body) : null });
        if (!responses.length) throw new Error("unexpected fetch");
        const fixture = responses.shift();
        if (fixture.reject) throw new Error(${JSON.stringify(secret)});
        if (fixture.readFailure) return { ok: true, status: 200, json: async () => { throw new Error(${JSON.stringify(secret)}); } };
        return new Response(fixture.body ?? "{}", { status: fixture.status ?? 200 });
      };
      try { await import(${JSON.stringify(script)}); }
      finally { console.log("TEST_RESULT=" + JSON.stringify({ calls, remaining: responses.length })); }
    `;
    let result;
    try {
      result = await exec(process.execPath, ["--input-type=module", "-e", harness], {
        env: { ...process.env, GITHUB_TOKEN: "fixture-token", GITHUB_REPOSITORY: "fixture/repo", GITHUB_EVENT_PATH: eventPath, LLM_BASE_URL: "", LLM_MODEL: "", LLM_API_KEY: "", ...env },
        timeout: 10_000,
      });
    } catch (error) {
      result = { stdout: error.stdout, stderr: error.stderr, code: error.code };
    }
    const match = result.stdout?.match(/TEST_RESULT=(.*)/);
    return { ...result, ...(match ? JSON.parse(match[1]) : {}) };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function noMutations(result) {
  assert.equal(result.code, undefined, result.stderr);
  assert.equal(result.remaining, 0);
  assert.equal(result.calls.filter(call => call.url.startsWith("https://api.github.com/repos/")).length, 0);
  assert.doesNotMatch(result.stderr, new RegExp(secret));
  assert.doesNotMatch(result.stdout, new RegExp(secret));
}

test("正常搜索和模型判断仍添加候选限定的标签", async () => {
  const result = await run([search, model, json({}), json({}), json({})]);
  assert.equal(result.code, undefined, result.stderr);
  assert.equal(result.remaining, 0);
  assert.deepEqual(result.calls.at(-1).body, { labels: ["possible-duplicate", "needs-info"] });
  assert.equal(result.calls.at(-1).method, "POST");
});

test("合法判断可包含理由及空白，理由不进入诊断或写入", async () => {
  const valid = { duplicateOf: null, duplicateConfidence: "low", needsInfo: false, needsMaintainer: true, reason: secret };
  const result = await run([search, modelContent(`\n${JSON.stringify(valid)}\n`), json({}), json({})]);
  assert.equal(result.code, undefined, result.stderr);
  assert.equal(result.remaining, 0);
  assert.deepEqual(result.calls.at(-1).body, { labels: ["needs-maintainer"] });
  assert.doesNotMatch(result.stdout, new RegExp(secret));
  assert.doesNotMatch(result.stderr, new RegExp(secret));
});

for (const [name, response] of [
  ["200 OK 文本", { body: `OK\n${secret}` }],
  ["HTML", { body: `<html>${secret}</html>` }],
  ["空响应", { body: "" }],
  ["损坏 JSON", { body: `{${secret}` }],
  ["HTTP 503", { status: 503, body: secret }],
  ["网络错误", { reject: true }],
  ["读取失败", { readFailure: true }],
  ["JSON null", json(null)],
  ["JSON 数组", json([])],
  ["JSON 原始值", json("OK")],
  ["错误搜索结构", json({ items: {} })],
  ["错误候选结构", json({ items: [null] })],
]) {
  test(`搜索 ${name} 有阶段诊断，保留其他判断但不误判重复`, async () => {
    const result = await run([response, model, json({}), json({})]);
    assert.equal(result.code, undefined, result.stderr);
    assert.equal(result.remaining, 0);
    assert.match(result.stderr, /\[issue-triage\]\[search\]/);
    assert.doesNotMatch(result.stderr, new RegExp(secret));
    assert.deepEqual(result.calls.at(-1).body, { labels: ["needs-info"] });
  });
}

for (const [name, response] of [
  ["200 OK 文本", { body: `OK\n${secret}` }],
  ["HTTP 429", { status: 429, body: secret }],
  ["网络错误", { reject: true }],
  ["读取失败", { readFailure: true }],
  ["错误 envelope", json({ choices: [] })],
  ["内容为 null", json({ choices: [{ message: { content: null } }] })],
  ["判断格式错误", json({ choices: [{ message: { content: "OK" } }] })],
  ["判断顶层不是对象", modelContent(JSON.stringify([verdict]))],
  ["判断附带非 JSON 文本", modelContent(`判断如下：${JSON.stringify(verdict)}`)],
  ["判断重复编号类型错误", modelContent(JSON.stringify({ ...verdict, duplicateOf: "20" }))],
  ["判断重复编号不是正的安全整数", modelContent(JSON.stringify({ ...verdict, duplicateOf: 0 }))],
  ["判断置信度超出枚举", modelContent(JSON.stringify({ ...verdict, duplicateConfidence: "undetermined" }))],
  ["判断缺少必要字段", modelContent(JSON.stringify({ ...verdict, needsMaintainer: undefined }))],
  ["判断布尔值类型错误", modelContent(JSON.stringify({ ...verdict, needsMaintainer: "false" }))],
  ["判断理由类型错误", modelContent(JSON.stringify({ ...verdict, reason: 42 }))],
  ["判断存在额外字段", modelContent(JSON.stringify({ ...verdict, note: "reviewed" }))],
]) {
  test(`模型 ${name} 有阶段诊断且不产生外部修改`, async () => {
    const result = await run([search, response]);
    noMutations(result);
    assert.match(result.stderr, /\[issue-triage\]\[model\]/);
  });
}

test("模板闸门正常评论、打标和关闭，不调用模型", async () => {
  const result = await run([json({}), json({}), json({}), json({})], { event: { issue: { ...issue, body: "missing template" } } });
  assert.equal(result.code, undefined, result.stderr);
  assert.equal(result.remaining, 0);
  assert.deepEqual(result.calls.map(call => call.method), ["POST", "POST", "POST", "PATCH"]);
  assert.deepEqual(result.calls[1].body, { labels: ["needs-template"] });
  assert.deepEqual(result.calls.at(-1).body, { state: "closed", state_reason: "not_planned" });
});

test("必要 GitHub 配置缺失仍失败，不被可选请求降级吞掉", async () => {
  const result = await run([], { env: { GITHUB_TOKEN: "" } });
  assert.equal(result.code, 1);
  assert.match(result.stderr, /缺少 GITHUB_TOKEN/);
});

test("自有模型半配置继续明确报告并跳过，不误回退 GitHub Models", async () => {
  const result = await run([], { env: { LLM_BASE_URL: "https://fixture.invalid/v1" } });
  noMutations(result);
  assert.equal(result.calls.length, 0);
  assert.match(result.stderr, /必须成对配置/);
});


test("自有模型无效 URL 明确报告配置问题，不归类为网络失败", async () => {
  const result = await run([], { env: { LLM_BASE_URL: "not-a-url", LLM_MODEL: "fixture", LLM_API_KEY: secret } });
  noMutations(result);
  assert.equal(result.calls.length, 0);
  assert.match(result.stderr, /LLM_BASE_URL 不是有效/);
  assert.doesNotMatch(result.stderr, /请求失败/);
});

test("自有模型缺少密钥明确报告，不回退默认提供方", async () => {
  const result = await run([], { env: { LLM_BASE_URL: "https://fixture.invalid/v1", LLM_MODEL: "fixture" } });
  noMutations(result);
  assert.equal(result.calls.length, 0);
  assert.match(result.stderr, /缺少 LLM_API_KEY/);
});
