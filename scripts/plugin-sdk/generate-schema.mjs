// 从 src/plugins/api.ts 的 PluginManifestInput 生成 Manifest JSON Schema。
// Schema 提交进仓库；CI 或本地校验时用 --check 重新生成并比对，
// 防止公开类型与 Schema 漂移。
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { createGenerator } from "ts-json-schema-generator";
import { fileURLToPath } from "node:url";

const checkMode = process.argv.includes("--check");
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const schema = createGenerator({
  path: path.join(repoRoot, "src/plugins/api.ts"),
  tsconfig: path.join(repoRoot, "tsconfig.main.json"),
  skipTypeCheck: true,
  type: "PluginManifestInput",
  topRef: false,
}).createSchema("PluginManifestInput");

const target = path.join(repoRoot, "src/plugins/manifest.schema.json");
const content = `${JSON.stringify(schema, null, 2)}\n`;
if (checkMode) {
  // CI 的 Windows runner 可能以 CRLF 检出文件（git autocrlf），比对前归一化行尾
  const existing = (await readFile(target, "utf8")).replace(/\r\n/g, "\n");
  if (existing !== content) {
    console.error("manifest.schema.json 与 PluginManifestInput 类型不一致，请运行 npm run generate:plugin-schema");
    process.exit(1);
  }
  console.log("manifest.schema.json 与类型一致");
} else {
  await writeFile(target, content, "utf8");
  console.log(`已生成 ${path.relative(repoRoot, target)}`);
}
