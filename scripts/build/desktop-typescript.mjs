import { build } from "esbuild";
import { copyFileSync, cpSync, globSync, mkdirSync, rmSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { assertRelativeDynamicImports } from "./verify-dynamic-imports.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const target = process.argv[2];
if (target !== "main" && target !== "preload") {
  throw new Error("Usage: node scripts/build/desktop-typescript.mjs <main|preload>");
}

const configPath = path.join(repoRoot, `tsconfig.${target}.json`);
const { config, error } = ts.readConfigFile(configPath, ts.sys.readFile);
if (error) throw new Error(ts.flattenDiagnosticMessageText(error.messageText, "\n"));

const parsed = ts.parseJsonConfigFileContent(config, ts.sys, repoRoot, undefined, configPath);
if (parsed.errors.length > 0) {
  throw new Error(parsed.errors.map((issue) => ts.flattenDiagnosticMessageText(issue.messageText, "\n")).join("\n"));
}

const entryPoints = parsed.fileNames.filter((file) => /\.[cm]?tsx?$/.test(file) && !/\.d\.[cm]?ts$/.test(file));
const outDir = parsed.options.outDir;
if (target === "main") rmSync(path.join(outDir, "plugins"), { recursive: true, force: true });

await build({
  entryPoints,
  outbase: parsed.options.rootDir,
  outdir: outDir,
  bundle: false,
  platform: "node",
  target: "es2022",
  format: "cjs",
  sourcemap: true,
  tsconfig: configPath,
  ...(target === "main"
    ? {
        define: {
          __CYRENE_GMAIL_CLIENT_ID__: JSON.stringify(process.env.CYRENE_GMAIL_CLIENT_ID ?? ""),
          __CYRENE_GMAIL_CLIENT_SECRET__: JSON.stringify(process.env.CYRENE_GMAIL_CLIENT_SECRET ?? ""),
        },
      }
    : {}),
  logLevel: "warning",
});

// tsc also copies imported JSON files. Keep their relative paths for runtime require().
for (const dir of target === "main" ? ["main", "shared"] : ["preload", "shared"]) {
  const sourceDir = path.join(repoRoot, "src", dir);
  for (const relative of globSync("**/*.json", { cwd: sourceDir })) {
    const destination = path.join(outDir, dir, relative);
    mkdirSync(path.dirname(destination), { recursive: true });
    copyFileSync(path.join(sourceDir, relative), destination);
  }
}

if (target === "main") {
  cpSync(path.join(repoRoot, "src", "plugins"), path.join(outDir, "plugins"), {
    recursive: true,
    filter: (source) => statSync(source).isDirectory() ||
      source.endsWith("manifest.json") ||
      source.endsWith("manifest.schema.json") ||
      source.endsWith("native-import.cjs"),
  });
  cpSync(path.join(repoRoot, "src", "main", "plugin-panel"), path.join(outDir, "plugin-panel"), { recursive: true });
  assertRelativeDynamicImports(outDir);
}

console.log(`[desktop] built ${entryPoints.length} ${target} TypeScript files`);
