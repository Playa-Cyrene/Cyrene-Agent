import { copyFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { verifyScreenshotHelper } from "../verify/screenshot-helper.mjs";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDirectory, "..", "..");
const crateDirectory = path.join(repoRoot, "native", "cyrene-computer");
const builtHelperPath = path.join(crateDirectory, "target", "release", "cyrene-computer.exe");
const stagedHelperPath = path.join(repoRoot, "resources", "bin", "cyrene-computer.exe");

const result = spawnSync("cargo", [
  "build",
  "--release",
  "--locked",
  "--manifest-path",
  path.join(crateDirectory, "Cargo.toml"),
], {
  cwd: repoRoot,
  shell: false,
  stdio: "inherit",
});

if (result.error) {
  console.error(`[computer-helper] failed to launch Cargo: ${result.error.message}`);
  process.exit(1);
}
if (result.status !== 0) {
  process.exit(result.status ?? 1);
}

await mkdir(path.dirname(stagedHelperPath), { recursive: true });
await copyFile(builtHelperPath, stagedHelperPath);
// 校验逻辑（存在、体积、PE 签名）与截图 helper 完全相同，直接复用。
const verified = await verifyScreenshotHelper(stagedHelperPath);
console.log(`[computer-helper] staged ${verified.helperPath} (${verified.size} bytes)`);
