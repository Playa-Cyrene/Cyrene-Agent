import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { makeOverlay, verifyOverlay, version, upstreamHashes } from "./nsis-overlay.mjs";

const require = createRequire(import.meta.url);
const builderRequire = createRequire(require.resolve("electron-builder/package.json"));
const actualTemplates = path.join(path.dirname(builderRequire.resolve("app-builder-lib/package.json")), "templates/nsis");
test("生产 NSIS 覆盖与锁定的上游完全一致，仅插入保护钩子", () => verifyOverlay(actualTemplates));
test("初始化在安装器提权前释放旧安装工作目录，调用旧卸载器前再次释放", () => {
  const installer = readFileSync(new URL("../../build/installer/installer.nsh", import.meta.url), "utf8");
  const upgrade = readFileSync(new URL("../../build/installer/upgrade-preservation.nsh", import.meta.url), "utf8");
  const body = (text, name) => text.replaceAll("\r\n", "\n").split(`!macro ${name}\n`)[1]?.split("!macroend")[0];
  const init = body(installer, "customInit").split("\n").map(line => line.split(";")[0].trim()).filter(Boolean);
  assert.deepEqual(init, ['SetOutPath "$TEMP"'], "初始化仅释放目录句柄，不得搬移用户内容");
  assert.match(body(upgrade, "CyreneBeforeOldUninstall"), /SetOutPath "\$TEMP"[\s\S]*CyreneCanonicalInstallDir/);
  const template = readFileSync(path.join(actualTemplates, "installer.nsi"), "utf8");
  const onInit = template.split("Function .onInit")[1].split("FunctionEnd")[0];
  assert(onInit.indexOf("SetOutPath $INSTDIR") < onInit.indexOf("!insertmacro customInit"));
  assert(!onInit.includes("UAC_RunElevated"));
  const assisted = readFileSync(path.join(actualTemplates, "assistedInstaller.nsh"), "utf8");
  const multi = readFileSync(path.join(actualTemplates, "multiUser.nsh"), "utf8");
  assert(!body(assisted, "initMultiUser").includes("UAC_RunElevated"));
  // 当前 assisted 模板初始化调用的设置范围宏，仅卸载器分支可能在初始化中提升。
  const setAll = body(multi, "setInstallModePerAllUsers").replace(/!ifdef BUILD_UNINSTALLER[\s\S]*?!endif/g, "");
  assert(!setAll.includes("UAC_RunElevated"));
});
for (const scenario of ["version-drift", "template-drift", "installer-drift", "section-drift", "overlay-drift", "overlay-missing"]) {
  test(`构建遇到 ${scenario} 必须停止`, () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "cyrene-nsis-overlay-"));
    try {
      const templates = path.join(root, "templates/nsis"), overlay = path.join(root, "override.nsh");
      mkdirSync(path.join(templates, "include"), { recursive: true });
      writeFileSync(path.join(root, "package.json"), JSON.stringify({ version: scenario === "version-drift" ? "26.16.0" : version }));
      const upstream = readFileSync(path.join(actualTemplates, "include/installUtil.nsh"), "utf8").replaceAll("\r\n", "\n");
      const changedFile = { "template-drift": "include/installUtil.nsh", "installer-drift": "installer.nsi", "section-drift": "installSection.nsh" }[scenario];
      for (const file of Object.keys(upstreamHashes)) {
        const source = readFileSync(path.join(actualTemplates, file), "utf8");
        writeFileSync(path.join(templates, file), source + (file === changedFile ? "\n; changed call ordering\n" : ""));
      }
      if (scenario !== "overlay-missing") writeFileSync(overlay, makeOverlay(upstream) + (scenario === "overlay-drift" ? "\n; unexpected local change\n" : ""));
      assert.throws(() => verifyOverlay(templates, overlay));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
}
