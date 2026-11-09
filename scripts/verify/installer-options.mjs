// 编译并运行生产选项宏；所有读写仅发生在临时目录，不修改登录项或用户配置。
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const compileOnly = process.argv.includes("--compile-only");
if (process.platform !== "win32" && !compileOnly) {
  throw new Error("Native installer option tests require Windows; use --compile-only elsewhere.");
}
const require = createRequire(import.meta.url);
const builderRequire = createRequire(require.resolve("electron-builder/package.json"));
const { getMakeNsisPath, getNsisPluginsPath } = builderRequire("app-builder-lib/out/toolsets/windows.js");
const compiler = await getMakeNsisPath();
const plugins = await getNsisPluginsPath();
const temp = await mkdtemp(path.join(os.tmpdir(), "cyrene-installer-options-"));
const q = (value) => value.replaceAll("$", "$$").replaceAll('"', '$\\"');
const cases = [
  { name: "silent-existing-true", silent: true, submitted: false, checked: false, before: true, after: true },
  { name: "silent-existing-false", silent: true, submitted: false, checked: false, before: false, after: false },
  { name: "silent-first-install", silent: true, submitted: false, checked: false },
  { name: "silent-even-with-stale-selection", silent: true, submitted: true, checked: false, before: true, after: true },
  { name: "interactive-without-page-submit", silent: false, submitted: false, checked: false, before: true, after: true },
  { name: "interactive-checked", silent: false, submitted: true, checked: true, before: false, after: true },
  { name: "interactive-unchecked", silent: false, submitted: true, checked: false, before: true, after: false },
];
try {
  const installer = (await readFile(path.join(root, "build/installer/installer.nsh"), "utf8")).replaceAll("\r\n", "\n");
  const customInstall = installer.split("!macro customInstall\n")[1]?.split("!macroend")[0];
  assert.match(customInstall, /!insertmacro CyreneSaveLaunchAtLoginSelection "\$APPDATA\\\$\{APP_PACKAGE_NAME\}"/);
  assert.match(installer, /Function CyreneOptionsPageLeave[\s\S]*?StrCpy \$CyreneOptionsSubmitted "1"[\s\S]*?FunctionEnd/);
  for (const test of cases) {
    const target = path.join(temp, test.name, "用户选项");
    // Linux 只交叉编译；NSIS 的运行时目录参数仍须是 Windows 绝对路径。
    const runtimeTarget = process.platform === "win32" ? target : `C:\\cyrene-options-fixture\\${test.name}\\用户选项`;
    const exe = path.join(temp, `${test.name}.exe`);
    const script = path.join(temp, `${test.name}.nsi`);
    await mkdir(target, { recursive: true });
    const selection = path.join(target, "installer-options.json");
    if (test.before !== undefined) await writeFile(selection, JSON.stringify({ launchAtLogin: test.before }));
    await writeFile(script, `Unicode true
Name "Cyrene option regression fixture"
OutFile "${q(exe)}"
RequestExecutionLevel user
SilentInstall silent
!include "LogicLib.nsh"
!addplugindir /x86-unicode "${q(path.join(plugins, "x86-unicode"))}"
!include "${q(path.join(root, "build/installer/installer.nsh"))}"
Section
  SetSilent ${test.silent ? "silent" : "normal"}
  StrCpy $CyreneOptionsSubmitted "${test.submitted ? "1" : ""}"
  StrCpy $CyreneLaunchAtLogin "${test.checked ? "1" : "0"}"
  !insertmacro CyreneSaveLaunchAtLoginSelection "${q(runtimeTarget)}"
SectionEnd
`);
    execFileSync(compiler.path, ["-INPUTCHARSET", "UTF8", "-V2", script], {
      env: { ...process.env, ...compiler.env }, timeout: 60_000, stdio: "pipe",
    });
    if (compileOnly) continue;
    const result = spawnSync(exe, ["/S"], { encoding: "utf8", timeout: 30_000, windowsHide: true });
    assert.ifError(result.error);
    assert.equal(result.status, 0, `${test.name}: ${result.stderr}`);
    if (test.after === undefined) {
      await assert.rejects(readFile(selection), { code: "ENOENT" });
    } else {
      assert.deepEqual(JSON.parse(await readFile(selection, "utf8")), { launchAtLogin: test.after }, test.name);
    }
    console.log(`[installer-options] ${test.name} passed`);
  }
  console.log(compileOnly
    ? `[installer-options] ${cases.length} NSIS fixtures compiled; Windows runtime NOT tested.`
    : `[installer-options] ${cases.length} native cases passed.`);
} finally {
  await rm(temp, { recursive: true, force: true });
}
