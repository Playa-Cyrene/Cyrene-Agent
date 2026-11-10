import { createHash } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

/** 只在构建时读取仓库原厂内容，产物存于 app.asar 内，不与用户可编辑目录共用。 */
export function writeExternalContentManifest(repoRoot, outputFile) {
  const hashTree = (root, relative = "") => Object.fromEntries(
    readdirSync(path.join(root, relative), { withFileTypes: true })
      .sort((a, b) => a.name.localeCompare(b.name, "en"))
      .flatMap((entry) => {
        const name = relative ? `${relative}/${entry.name}` : entry.name;
        if (entry.isDirectory()) return Object.entries(hashTree(root, name));
        if (!entry.isFile()) throw new Error(`Unsupported external content entry: ${name}`);
        return [[name, createHash("sha1").update(readFileSync(path.join(root, name))).digest("hex")]];
      }),
  );
  const manifest = {
    formatVersion: 2,
    source: "build",
    prompts: hashTree(path.join(repoRoot, "prompts")),
    skills: hashTree(path.join(repoRoot, "skills")),
  };
  mkdirSync(path.dirname(outputFile), { recursive: true });
  writeFileSync(outputFile, JSON.stringify(manifest), "utf8");
  return manifest;
}
