// 编译器入口也执行此校验，直接 electron-builder --prepackaged 不能绕过版本约束。
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
export const version = "26.15.3";
export const upstreamHash = "97bd546b5cd2aaf16b77bc9e2be8a18962dd74ab5c4d23b35b163ca89bf4dd2a";
export const upstreamHashes = {
  "include/installUtil.nsh": upstreamHash,
  "installer.nsi": "8811964416d122612c3e7601728af5d3f998d677918df829a4e8b4c739c8b9f8",
  "installSection.nsh": "74c4dbb4163cdd90ca4850b75d304e916235c882d6af7b5cdad63bffbc977072",
};
export const overlayPrefix = `; Derived from electron-builder/app-builder-lib ${version}, MIT; see LICENSE.electron-builder.
; Restore the compiler directory immediately; only this include is overridden.
!cd "\${CYRENE_NSIS_TEMPLATE_DIR}"
`;
const anchor = '  StrCpy $uninstallerFileNameTemp "$PLUGINSDIR\\old-uninstaller.exe"';
const missingAnchor = '    ${if} $uninstallString == ""\n      ClearErrors\n      Return';
const invalidAnchor = '  ${andIf} $uninstallerFileName == ""\n    ClearErrors\n    Return';
export function makeOverlay(upstream) {
  assert.equal(upstream.split(anchor).length, 2, "旧卸载调用锚点必须唯一");
  assert.equal(upstream.split(missingAnchor).length, 2, "无卸载信息的返回锚点必须唯一");
  assert.equal(upstream.split(invalidAnchor).length, 2, "无效卸载信息的返回锚点必须唯一");
  return overlayPrefix + upstream
    .replace(missingAnchor, missingAnchor.replace("      ClearErrors", "      !insertmacro CyreneCheckMissingUninstaller\n      ClearErrors"))
    .replace(invalidAnchor, invalidAnchor.replace("    ClearErrors", "    !insertmacro CyreneCheckMissingUninstaller\n    ClearErrors"))
    .replace(anchor, "  !insertmacro CyreneBeforeOldUninstall\n\n" + anchor);
}
export function verifyOverlay(templates, overlay = path.join(root, "build/installer/nsis-overrides/installUtil.nsh")) {
  const pkg = JSON.parse(readFileSync(path.join(templates, "../../package.json"), "utf8"));
  assert.equal(pkg.version, version, "electron-builder 版本改变，须重新审查旧卸载器覆盖层");
  for (const [file, hash] of Object.entries(upstreamHashes)) {
    const source = readFileSync(path.join(templates, file), "utf8").replaceAll("\r\n", "\n");
    assert.equal(createHash("sha256").update(source).digest("hex"), hash, `electron-builder ${file} 已改变，禁止静默套用旧覆盖层`);
  }
  const upstream = readFileSync(path.join(templates, "include/installUtil.nsh"), "utf8").replaceAll("\r\n", "\n");
  assert.equal(readFileSync(overlay, "utf8").replaceAll("\r\n", "\n"), makeOverlay(upstream), "局部覆盖必须仅增加目录恢复和用户内容保护钩子");
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const require = createRequire(import.meta.url);
  const builderRequire = createRequire(require.resolve("electron-builder/package.json"));
  const templates = process.argv[2] ?? path.join(path.dirname(builderRequire.resolve("app-builder-lib/package.json")), "templates/nsis");
  verifyOverlay(templates);
  console.log(`[nsis-overlay] app-builder-lib ${version}: upstream and local overlay verified`);
}
