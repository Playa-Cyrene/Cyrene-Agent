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
const { AsarPackager } = appBuilderRequire("./out/asar/asarUtil.js");
const { getFileMatchers } = appBuilderRequire("./out/fileMatcher.js");
const { statFile } = appBuilderRequire("@electron/asar");

test("packaged filesystem MCP runs without node_modules and retains its allowed-directory boundary", { timeout: 60_000 }, async () => {
  // 在系统临时目录构造真实 ASAR，不能意外从开发仓库的祖先目录解析依赖。
  const temp = await mkdtemp(path.join(os.tmpdir(), "cyrene-mcp-package-"));
  try {
    // @electron/asar 按 path.sep 遍历归档目录，Windows 下不能传固定的 POSIX 路径。
    const relativeEntry = path.join("dist", "main", "main", "filesystem-mcp.mjs");
    const app = path.join(temp, "app");
    const source = path.join(app, relativeEntry);
    await buildFilesystemMcp({ repoRoot: root, outfile: source });
    const config = parse(await readFile(path.join(root, "electron-builder.yml"), "utf8"));
    const resourcePath = path.join(temp, "resources");
    // 与 electron-builder 使用相同的匹配器和归档流程，包括 Windows 路径处理。
    const [matcher] = getFileMatchers(config, "asarUnpack", app, {
      defaultSrc: app,
      globalOutDir: resourcePath,
      macroExpander: (value) => value,
      customBuildOptions: config.win ?? {},
    }) ?? [];
    const packager = new AsarPackager({ info: { getWorkspaceRoot: async () => app } }, {
      resourcePath,
      defaultDestination: app,
      options: { smartUnpack: false },
      unpackPattern: matcher?.createFilter(),
    });
    await packager.pack([{ src: app, destination: app, files: [source], metadata: new Map([[source, await stat(source)]]) }]);
    const asar = path.join(resourcePath, "app.asar");
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
