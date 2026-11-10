import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = await readFile(new URL("../../electron-builder.yml", import.meta.url), "utf8");
const installerInclude = await readFile(new URL("../../build/installer/installer.nsh", import.meta.url), "utf8");

test("the core package excludes optional model and music components", () => {
  assert.match(source, /-\s+"!dist\/components\/\*\*\/\*"/);
  assert.match(source, /-\s+"!models\/\*\*\/\*"/);
  assert.match(source, /-\s+"!vendor\/cloud-music-mcp\/\*\*\/\*"/);
  assert.doesNotMatch(source, /-\s+models\/\*\*\/\*/);
  assert.match(source, /-\s+from: resources\/components/);
  assert.match(source, /to: components/);
  assert.match(source, /artifactName:\s+Cyrene-Setup-\$\{version\}\.\$\{ext\}/);
});

test("the assisted installer exposes Cyrene setup choices and an uninstall entry", () => {
  assert.match(source, /createDesktopShortcut:\s+false/);
  assert.match(source, /include:\s+build\/installer\/installer\.nsh/);
  assert.match(source, /menuCategory:\s+Cyrene/);
});

test("the assisted installer stores launch preferences under the application package name", () => {
  assert.match(
    installerInclude,
    /!insertmacro CyreneSaveLaunchAtLoginSelection "\$APPDATA\\\$\{APP_PACKAGE_NAME\}"/,
  );
  assert.doesNotMatch(
    installerInclude,
    /\$APPDATA\\\$\{PRODUCT_FILENAME\}\\installer-options\.json/,
  );
});
