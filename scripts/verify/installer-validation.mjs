// 真实 NSIS 回归：编译生产校验函数，在独立临时目录运行 /S 安装夹具。
// 不安装应用、不写注册表/快捷方式，不启动 Cyrene。
// Windows: node scripts/verify/installer-validation.mjs
// 其他平台仅验证编译: node scripts/verify/installer-validation.mjs --compile-only
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { mkdtemp, mkdir, readFile, writeFile, rm, chmod, access } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const compileOnly = process.argv.includes("--compile-only");
if (process.platform !== "win32" && !compileOnly) {
  throw new Error("Native installer validation requires Windows; use --compile-only for compilation only.");
}
const require = createRequire(import.meta.url);
const builderRequire = createRequire(require.resolve("electron-builder/package.json"));
// 使用项目已锁定的 electron-builder 编译器下载/校验机制，不另装系统 NSIS。
const { getMakeNsisPath, getNsisPluginsPath } = builderRequire("app-builder-lib/out/toolsets/windows.js");
const compiler = await getMakeNsisPath();
const temp = await mkdtemp(path.join(os.tmpdir(), "cyrene-installer-check-"));
const target = path.join(temp, "安装 target");
const exe = path.join(temp, "guard-fixture.exe");
const script = path.join(temp, "guard-fixture.nsi");
const quoteNsis = (value) => value.replaceAll("$", "$$").replaceAll('"', '$\\"');
const q = quoteNsis;
const exists = async (file) => access(file).then(() => true, () => false);
try {
  // 接入位置也须守住：暂存模型先恢复，校验通过后才保存安装选项。
  const installer = await readFile(path.join(root, "build/installer/installer.nsh"), "utf8");
  const getCustomInstall = (source) => source.replaceAll("\r\n", "\n").split("!macro customInstall\n")[1]?.split("!macroend")[0];
  const customInstall = getCustomInstall(installer);
  assert.ok(customInstall, "customInstall macro must exist");
  assert.equal(getCustomInstall(installer.replace(/\r?\n/g, "\r\n")), customInstall, "CRLF checkout must preserve the integration check");
  assert.ok(customInstall.indexOf("!insertmacro CyreneValidateInstallation") > customInstall.indexOf('Rename "$INSTDIR\\..\\.Cyrene.models-preserve"'));
  assert.ok(customInstall.indexOf("!insertmacro CyreneValidateInstallation") < customInstall.indexOf("CreateShortCut"));

  await writeFile(script, `Unicode true
Name "Cyrene guard regression fixture"
OutFile "${q(exe)}"
InstallDir "${q(target)}"
RequestExecutionLevel user
Page instfiles
!define APP_EXECUTABLE_FILENAME "Cyrene.exe"
!include "${q(path.join(root, "build/installer/install-validation.nsh"))}"
Function .onInstSuccess
  FileOpen $0 "$INSTDIR\\success-hook.txt" w
  FileWrite $0 "success"
  FileClose $0
FunctionEnd
Section
  StrCpy $0 "register-zero"
  StrCpy $1 "register-one"
  StrCpy $2 "register-two"
  Push "stack-sentinel"
  !insertmacro CyreneValidateInstallation
  StrCmp $0 "register-zero" 0 badState
  StrCmp $1 "register-one" 0 badState
  StrCmp $2 "register-two" 0 badState
  Pop $0
  StrCmp $0 "stack-sentinel" 0 badState
  FileOpen $0 "$INSTDIR\\after-guard.txt" w
  FileWrite $0 "success"
  FileClose $0
  Goto done
badState:
  SetErrorLevel 9
  Quit
done:
SectionEnd
`);
  // writeFile 输出 UTF-8；Windows makensis 默认系统代码页会损坏中文夹具路径。
  execFileSync(compiler.path, ["-INPUTCHARSET", "UTF8", "-V2", script], {
    env: { ...process.env, ...compiler.env }, timeout: 60_000, stdio: "pipe",
  });
  assert.ok(await exists(exe), "NSIS must emit a fixture executable");
  // 再编译真实 customInstall 接入，防止只有孤立 include 可编译。
  // 此宿主夹具绝不执行：customInstall 含快捷方式和选项写入，仅用于编译检查。
  const plugins = await getNsisPluginsPath();
  const integrationScript = path.join(temp, "custom-install-compile.nsi");
  await writeFile(integrationScript, `Unicode true
Name "Cyrene customInstall compile fixture"
OutFile "${q(path.join(temp, "custom-install-compile.exe"))}"
RequestExecutionLevel user
!include "LogicLib.nsh"
!addplugindir /x86-unicode "${q(path.join(plugins, "x86-unicode"))}"
!define APP_EXECUTABLE_FILENAME "Cyrene.exe"
!define APP_DESCRIPTION "Test fixture"
!define APP_ID "test.cyrene.installer"
!define APP_PACKAGE_NAME "cyrene-installer-test"
!define SHORTCUT_NAME "Cyrene test"
!define MENU_FILENAME "Cyrene test"
!define PRODUCT_FILENAME "Cyrene"
!define UNINSTALL_FILENAME "uninstall.exe"
Var appExe
!include "${q(path.join(root, "build/installer/installer.nsh"))}"
Section
  !insertmacro customInstall
SectionEnd
`);
  execFileSync(compiler.path, ["-INPUTCHARSET", "UTF8", "-V2", integrationScript], {
    env: { ...process.env, ...compiler.env }, timeout: 60_000, stdio: "pipe",
  });
  if (compileOnly) {
    console.log("[installer-validation] NSIS compilation passed; Windows runtime tests NOT run.");
  } else {
    const cases = [
      { name: "complete", valid: true },
      { name: "missing-exe", file: "Cyrene.exe", operation: "missing" },
      { name: "missing-asar", file: "resources/app.asar", operation: "missing" },
      { name: "empty-exe", file: "Cyrene.exe", operation: "empty" },
      { name: "empty-asar", file: "resources/app.asar", operation: "empty" },
      { name: "directory-exe", file: "Cyrene.exe", operation: "directory" },
      { name: "directory-asar", file: "resources/app.asar", operation: "directory" },
      { name: "read-only-files", valid: true, operation: "read-only" },
      { name: "locked-exe", file: "Cyrene.exe", operation: "locked" },
      { name: "locked-asar", file: "resources/app.asar", operation: "locked" },
    ];
    for (const test of cases) {
      await rm(target, { recursive: true, force: true });
      await mkdir(path.join(target, "resources"), { recursive: true });
      // 一个 NUL 字节也必须被识别为非空；不把内容格式验证混入本项保护。
      await writeFile(path.join(target, "Cyrene.exe"), Buffer.from([0]));
      await writeFile(path.join(target, "resources/app.asar"), Buffer.from([0]));
      const invalid = test.file && path.join(target, test.file);
      if (test.operation === "missing" || test.operation === "directory") await rm(invalid);
      if (test.operation === "directory") await mkdir(invalid);
      if (test.operation === "empty") await writeFile(invalid, "");
      if (test.operation === "read-only") {
        await chmod(path.join(target, "Cyrene.exe"), 0o444);
        await chmod(path.join(target, "resources/app.asar"), 0o444);
      }
      let result;
      if (test.operation === "locked") {
        // FileShare.None 制造真实 Windows 共享冲突；finally 释放，不改变 ACL。
        const ps = (value) => `'${value.replaceAll("'", "''")}'`;
        result = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", `
$ErrorActionPreference = 'Stop'
$stream = [System.IO.File]::Open(${ps(invalid)}, 'Open', 'Read', 'None')
try {
  $process = Start-Process -FilePath ${ps(exe)} -ArgumentList '/S' -PassThru -Wait
  $code = $process.ExitCode
} finally { $stream.Dispose() }
exit $code
`], { encoding: "utf8", timeout: 30_000, windowsHide: true });
      } else {
        result = spawnSync(exe, ["/S"], { encoding: "utf8", timeout: 30_000, windowsHide: true });
      }
      assert.ifError(result.error);
      assert.equal(result.status, test.valid ? 0 : 2, `${test.name}: ${result.stderr ?? ""}`);
      assert.equal(await exists(path.join(target, "after-guard.txt")), Boolean(test.valid), `${test.name}: continued after guard`);
      assert.equal(await exists(path.join(target, "success-hook.txt")), Boolean(test.valid), `${test.name}: reported success`);
      console.log(`[installer-validation] ${test.name} passed`);
      // Windows 的只读属性会阻止后续 rm，测试自行恢复自己的 fixture 属性。
      if (test.operation === "read-only") {
        await chmod(path.join(target, "Cyrene.exe"), 0o666);
        await chmod(path.join(target, "resources/app.asar"), 0o666);
      }
    }
    console.log(`[installer-validation] ${cases.length} native NSIS cases passed (silent fixtures, not full application installs).`);
  }
} finally {
  await rm(temp, { recursive: true, force: true });
}
