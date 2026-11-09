import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import { buildFilesystemMcp } from "../build/filesystem-mcp.mjs";
import { verifyFilesystemMcp } from "../verify/filesystem-mcp.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const require = createRequire(import.meta.url);
const builderRequire = createRequire(require.resolve("electron-builder/package.json"));
const appBuilderRequire = createRequire(builderRequire.resolve("app-builder-lib/package.json"));
const { createPackageWithOptions, statFile } = appBuilderRequire("@electron/asar");

test("packaged filesystem MCP runs without node_modules and retains its allowed-directory boundary", { timeout: 60_000 }, async () => {
  // 在系统临时目录构造真实 ASAR，不能意外从开发仓库的祖先目录解析依赖。
  const temp = await mkdtemp(path.join(os.tmpdir(), "cyrene-mcp-package-"));
  try {
    const relativeEntry = "dist/main/main/filesystem-mcp.mjs";
    const app = path.join(temp, "app");
    await buildFilesystemMcp({ repoRoot: root, outfile: path.join(app, relativeEntry) });
    const config = parse(await readFile(path.join(root, "electron-builder.yml"), "utf8"));
    const asar = path.join(temp, "resources/app.asar");
    await createPackageWithOptions(app, asar, { unpack: `{${config.asarUnpack.join(",")}}` });
    assert.equal(statFile(asar, relativeEntry).unpacked, true);
    const entry = path.join(`${asar}.unpacked`, relativeEntry);
    assert.ok((await stat(entry)).size > 0);
    const result = await verifyFilesystemMcp({ entry });
    assert.ok(result.toolCount >= 1);
    assert.equal(result.allowedRead, true);
    assert.equal(result.outsideReadDenied, true);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});
