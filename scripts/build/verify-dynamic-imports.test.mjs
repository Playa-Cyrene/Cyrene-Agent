import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import { assertRelativeDynamicImports } from "./verify-dynamic-imports.mjs";

function fixture(t, files) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "cyrene-import-guard-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  for (const [relative, content] of Object.entries(files)) {
    const filename = path.join(dir, relative);
    mkdirSync(path.dirname(filename), { recursive: true });
    writeFileSync(filename, content);
  }
  return dir;
}

for (const expression of ['await import("./b")', 'import("./b").then(() => {})']) {
  test(`拒绝无扩展名动态导入：${expression}`, (t) => {
    const dir = fixture(t, { "a.js": `async function load() { ${expression}; }`, "b.js": "exports.answer = 42;" });
    assert.throws(() => assertRelativeDynamicImports(dir), /a\.js:1.*\.\/b/);
  });
}

test("拒绝目录动态导入", (t) => {
  const dir = fixture(t, { "a.js": 'import("./vendors");', "vendors/index.js": "exports.answer = 42;" });
  assert.throws(() => assertRelativeDynamicImports(dir), /a\.js:1.*\.\/vendors/);
});

test("拒绝目标缺失的显式文件路径", (t) => {
  const dir = fixture(t, { "a.js": 'import("./missing.js");' });
  assert.throws(() => assertRelativeDynamicImports(dir), /a\.js:1.*\.\/missing\.js/);
});

test("允许裸包导入，忽略字符串和注释中的导入文本", (t) => {
  const dir = fixture(t, {
    "a.js": `import("@anthropic-ai/sandbox-runtime");
      // import("./missing")
      const text = 'import("./missing")';`,
  });
  assert.doesNotThrow(() => assertRelativeDynamicImports(dir));
});

test("显式 .js、目录 index.js 和带查询参数的路径能通过守卫并在 Node 中加载", async (t) => {
  const dir = fixture(t, {
    "a.cjs": `exports.load = async () => {
      const b = await import("./b.js");
      const vendor = await import("./vendors/index.js");
      const queried = await import("./b.js?version=1");
      return [b.answer, vendor.answer, queried.answer];
    };`,
    "b.js": "exports.answer = 42;",
    "vendors/index.js": "exports.answer = 7;",
  });
  assert.doesNotThrow(() => assertRelativeDynamicImports(dir));
  const entry = await import(pathToFileURL(path.join(dir, "a.cjs")).href);
  assert.deepEqual(await entry.default.load(), [42, 7, 42]);
});
