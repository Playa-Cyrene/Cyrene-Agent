// 实际编译并运行安装器的内容保护宏；仅操作独立夹具，不执行产品安装/卸载。
// Windows: node scripts/verify/installer-content-preservation.mjs --nsis-dir <NSIS目录> [--work-dir <证据目录>]
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const option = (name) => { const at = process.argv.indexOf(name); return at < 0 ? undefined : process.argv[at + 1]; };
const nsis = option("--nsis-dir");
if (process.platform !== "win32" || !nsis) throw new Error("需要 Windows 和 --nsis-dir；不会自动下载或运行产品安装器。");
const work = path.resolve(option("--work-dir") ?? path.join(projectRoot, ".build-temp"));
fs.mkdirSync(work, { recursive: true });
const root = fs.mkdtempSync(path.join(work, "installer-preservation-"));
const q = (text) => text.replaceAll("$", "$$").replaceAll('"', '$\\"');
const cases = [
  { name: "remove-normal", macro: "customRemoveFiles", expectedCode: 0 },
  ...["prompts", "skills", "models"].map((collision) => ({ name: `remove-stale-${collision}`, macro: "customRemoveFiles", collision, expectedCode: 2 })),
  { name: "remove-staging-parent-file", macro: "customRemoveFiles", stagingFile: true, expectedCode: 2 },
  { name: "remove-unknown-staging", macro: "customRemoveFiles", unknownStaging: true, expectedCode: 2 },
  { name: "remove-empty-staging", macro: "customRemoveFiles", emptyStaging: true, expectedCode: 0 },
  { name: "remove-rename-failed", macro: "customRemoveFiles", lock: "skills", expectedCode: 2 },
  { name: "remove-cleanup-failed", macro: "customRemoveFiles", lock: "program.bin", expectedCode: 2 },
  { name: "init-normal", macro: "customInit", expectedCode: 0 },
  { name: "init-interactive", macro: "customInit", interactive: true, expectedCode: 0 },
  { name: "init-stale-models", macro: "customInit", collision: "models", expectedCode: 0 },
  { name: "restore-normal", macro: "CyreneRestoreModels", restore: true, expectedCode: 0 },
  { name: "restore-conflict", macro: "CyreneRestoreModels", restore: true, collision: "models", expectedCode: 2 },
  { name: "restore-rename-failed", macro: "CyreneRestoreModels", restore: true, lock: "staged-models", expectedCode: 2 },
];
const results = [];
for (const scenario of cases.filter((item) => !option("--filter") || item.name.startsWith(option("--filter")))) {
  const directory = path.join(root, scenario.name), install = path.join(directory, "Cyrene");
  const exe = path.join(directory, "fixture.exe"), script = path.join(directory, "fixture.nsi");
  const staging = (name) => name === "models" ? path.join(directory, ".Cyrene.models-preserve") : path.join(directory, ".Cyrene.content-preserve", name);
  fs.mkdirSync(install, { recursive: true });
  fs.writeFileSync(path.join(install, "program.bin"), "OLD PROGRAM");
  for (const name of scenario.restore ? ["models"] : ["prompts", "skills", "models"]) {
    const target = scenario.restore ? staging(name) : path.join(install, name);
    fs.mkdirSync(target, { recursive: true });
    fs.writeFileSync(path.join(target, "current.txt"), "CURRENT USER CONTENT");
  }
  if (scenario.collision) {
    const target = scenario.restore ? path.join(install, scenario.collision) : staging(scenario.collision);
    fs.mkdirSync(target, { recursive: true });
    fs.writeFileSync(path.join(target, "prior.txt"), "PRIOR CONTENT");
  }
  if (scenario.stagingFile) fs.writeFileSync(path.join(directory, ".Cyrene.content-preserve"), "PRIOR FILE");
  if (scenario.unknownStaging || scenario.emptyStaging) {
    fs.mkdirSync(path.join(directory, ".Cyrene.content-preserve"), { recursive: true });
    if (scenario.unknownStaging) fs.writeFileSync(path.join(directory, ".Cyrene.content-preserve/legacy-backup.txt"), "PRIOR UNKNOWN CONTENT");
  }
  let locked = "";
  if (scenario.lock) {
    const target = scenario.lock === "staged-models" ? staging("models") : path.join(install, scenario.lock);
    // 不共享 DELETE 权限的句柄让真实 Rename/RMDir 失败，退出时 OS 自动释放。
    locked = `System::Call 'kernel32::CreateFileW(w "${q(target)}", i 0x80000000, i 1, p 0, i 3, i 0x02000000, p 0) p.r9'\n`;
  }
  fs.writeFileSync(script, `Unicode true
Name "Cyrene content preservation fixture"
OutFile "${q(exe)}"
InstallDir "${q(install)}"
RequestExecutionLevel user
SilentInstall silent
!include "LogicLib.nsh"
${scenario.macro === "customRemoveFiles" ? '!define BUILD_UNINSTALLER\n' : ""}!define isUpdated '1 = 1'
!include "${q(path.join(projectRoot, "build/installer/installer.nsh"))}"
Section
${scenario.interactive ? "SetSilent normal\n" : ""}${locked}  !insertmacro ${scenario.macro}
SectionEnd
`, "utf8");
  try {
    let run = spawnSync(path.join(nsis, "Bin/makensis.exe"), ["-INPUTCHARSET", "UTF8", "-V2", script], { encoding: "utf8", windowsHide: true, env: { ...process.env, NSISDIR: nsis }, timeout: 30_000 });
    assert.ifError(run.error); assert.equal(run.status, 0, run.stdout + run.stderr);
    run = spawnSync(exe, ["/S"], { encoding: "utf8", windowsHide: true, timeout: 30_000 });
    assert.ifError(run.error); assert.equal(run.status, scenario.expectedCode, `exit=${run.status}`);
    for (const name of scenario.restore ? ["models"] : ["prompts", "skills", "models"]) {
      const current = [path.join(install, name, "current.txt"), path.join(staging(name), "current.txt")].find(fs.existsSync);
      assert.ok(current, `${name} 的当前用户内容丢失`);
      assert.equal(fs.readFileSync(current, "utf8"), "CURRENT USER CONTENT");
    }
    if (scenario.collision) {
      const prior = scenario.restore ? path.join(install, scenario.collision, "prior.txt") : path.join(staging(scenario.collision), "prior.txt");
      assert.equal(fs.readFileSync(prior, "utf8"), "PRIOR CONTENT");
    }
    if (scenario.unknownStaging) assert.equal(fs.readFileSync(path.join(directory, ".Cyrene.content-preserve/legacy-backup.txt"), "utf8"), "PRIOR UNKNOWN CONTENT");
    if (scenario.expectedCode !== 0) assert.ok(fs.existsSync(path.join(install, "program.bin")), "失败后不应继续删除旧安装目录");
    if (scenario.name === "remove-normal" || scenario.name === "remove-empty-staging") {
      assert.ok(!fs.existsSync(path.join(install, "program.bin")));
      assert.ok(fs.existsSync(path.join(install, "models/current.txt")));
      for (const name of ["prompts", "skills"]) assert.ok(fs.existsSync(path.join(staging(name), "current.txt")));
    }
    if (scenario.macro === "customInit") {
      for (const name of ["prompts", "skills", "models"]) {
        assert.ok(fs.existsSync(path.join(install, name, "current.txt")), "初始化/取消向导不应搬移旧内容");
        assert.ok(!fs.existsSync(path.join(staging(name), "current.txt")));
      }
    }
    if (scenario.name === "restore-normal") assert.ok(fs.existsSync(path.join(install, "models/current.txt")));
    results.push({ name: scenario.name, passed: true, exitCode: run.status });
  } catch (error) { results.push({ name: scenario.name, passed: false, error: String(error) }); }
}
fs.writeFileSync(path.join(root, "results.json"), JSON.stringify({ root, results }, null, 2));
console.log(JSON.stringify({ root, results }, null, 2));
if (results.some((result) => !result.passed)) process.exitCode = 1;
