import { build } from "esbuild";
import { createRequire, isBuiltin } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const defaultRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

export async function buildFilesystemMcp({ repoRoot = defaultRoot, outfile = path.join(repoRoot, "dist/main/main/filesystem-mcp.mjs") } = {}) {
  const require = createRequire(path.join(repoRoot, "package.json"));
  const packageRoot = path.dirname(require.resolve("@modelcontextprotocol/server-filesystem/package.json"));
  // 独立子进程不能从 app.asar.unpacked 的祖先目录解析到 app.asar 内的依赖。
  // 整体打包依赖闭包，避免新增传递依赖时再次依靠手工维护 asarUnpack 白名单。
  const result = await build({
    entryPoints: [path.join(packageRoot, "dist/index.js")],
    outfile,
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node24",
    banner: { js: 'import { createRequire as __cyreneCreateRequire } from "node:module"; const require = __cyreneCreateRequire(import.meta.url);' },
    metafile: true,
    logLevel: "warning",
  });
  for (const output of Object.values(result.metafile.outputs)) {
    for (const dependency of output.imports) {
      if (dependency.external && !isBuiltin(dependency.path)) {
        throw new Error(`Filesystem MCP bundle has an external package dependency: ${dependency.path}`);
      }
    }
  }
  return outfile;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await buildFilesystemMcp();
}
