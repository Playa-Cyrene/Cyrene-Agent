// 真实 NSIS/Win32 路径回归：目标父目录完全不存在时仍可规范化，API 失败/截断必须停止。
// node scripts/verify/installer-upgrade-paths.mjs --nsis-dir <NSIS目录> [--work-dir <证据目录>]
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const option = name => { const at = process.argv.indexOf(name); return at < 0 ? undefined : process.argv[at + 1]; };
const nsis = option("--nsis-dir");
if (process.platform !== "win32" || !nsis) throw new Error("需要 Windows 和 --nsis-dir；不会运行产品安装器。");
const work = path.resolve(option("--work-dir") ?? path.join(project, ".build-temp"));
fs.mkdirSync(work, { recursive: true });
const root = fs.mkdtempSync(path.join(work, "installer-paths-"));
const q = text => text.replaceAll("$", "$$").replaceAll('"', '$\\"');
const results = [];
for (const scenario of [
  { name: "uncreated-parents", parts: ["uncreated", "nested", "target", "Cyrene"] },
  { name: "uncreated-dot-segments", parts: ["uncreated", "unused", "..", "nested", "Cyrene"], trailing: true },
  { name: "short-existing-directory", shortPath: true },
  { name: "short-uncreated-descendants", shortPath: true, suffix: "new\\nested" },
  { name: "uncreated-below-volume-root", rootChild: true },
  { name: "invalid-long-path-name", parts: ["invalid|name"], invalid: "name" },
  { name: "empty-path", invalid: "empty" },
  { name: "volume-root", invalid: "root" },
  { name: "api-buffer-too-small", invalid: "length" },
]) {
  const directory = path.join(root, scenario.name);
  fs.mkdirSync(directory);
  const input = scenario.shortPath ? path.join(directory, "Existing Long Installation Directory") : scenario.rootChild ? path.join(path.parse(root).root, `cyrene-path-${path.basename(root)}`, "new", "nested") : scenario.invalid === "root" ? path.parse(root).root : scenario.parts ? directory + "\\" + scenario.parts.join("\\") + (scenario.trailing ? "\\" : "") : "";
  const expected = scenario.shortPath ? path.join(input, scenario.suffix ?? "") : (scenario.parts || scenario.rootChild) && path.resolve(input);
  if (scenario.shortPath) fs.mkdirSync(input);
  const script = path.join(directory, "fixture.nsi"), exe = path.join(directory, "fixture.exe"), normalized = path.join(directory, "normalized.txt");
  // 该宿主只展开路径宏；仅关闭未使用变量警告，其他警告仍以 -WX 失败。
  fs.writeFileSync(script, `Unicode true
Name "Cyrene upgrade path fixture"
OutFile "${q(exe)}"
RequestExecutionLevel user
SilentInstall silent
!pragma warning disable 6001
!include "${q(path.join(project, "build/installer/content-preservation.nsh"))}"
!include "${q(path.join(project, "build/installer/upgrade-preservation.nsh"))}"
Section
  SetOutPath "$EXEDIR"
  StrCpy $CyreneOtherDir "${q(input)}"
${scenario.shortPath ? `  System::Call 'kernel32::GetShortPathNameW(w "$CyreneOtherDir", w .r0, i \${NSIS_MAX_STRLEN}) i.r1'
  \${If} $1 <= 0
  \${OrIf} $1 >= \${NSIS_MAX_STRLEN}
    SetErrorLevel 9
    Quit
  \${EndIf}
  \${If} $0 == $CyreneOtherDir
    SetErrorLevel 77
    Quit
  \${EndIf}
  StrCpy $CyreneOtherDir "$0${scenario.suffix ? "\\" + q(scenario.suffix) : ""}"
` : ""}
${scenario.invalid === "length" ? `  StrCpy $9 0
  IntOp $8 \${NSIS_MAX_STRLEN} - 16
  \${DoWhile} $9 < $8
    StrCpy $CyreneOtherDir "a$CyreneOtherDir"
    IntOp $9 $9 + 1
  \${Loop}
` : ""}  !insertmacro CyreneCanonicalInstallDir "$CyreneOtherDir" $CyreneTargetDir $CyreneTargetRoot
  !insertmacro CyreneRequirePlainPath "$CyreneTargetDir"
  FileOpen $0 "${q(normalized)}" w
  FileWrite $0 "$CyreneTargetDir"
  FileClose $0
SectionEnd
`, "utf8");
  try {
    if (scenario.rootChild) assert(!fs.existsSync(input));
    assert(!fs.existsSync(path.join(directory, "uncreated")), "目标父目录必须在运行前完全不存在");
    const compile = spawnSync(path.join(nsis, "Bin/makensis.exe"), ["-WX", "-INPUTCHARSET", "UTF8", "-V2", script], { encoding: "utf8", windowsHide: true, env: { ...process.env, NSISDIR: nsis }, timeout: 30_000 });
    fs.writeFileSync(path.join(directory, "compile.log"), compile.stdout + compile.stderr);
    assert.ifError(compile.error); assert.equal(compile.status, 0, compile.stdout + compile.stderr);
    const run = spawnSync(exe, ["/S"], { encoding: "utf8", windowsHide: true, timeout: 30_000 });
    assert.ifError(run.error);
    if (scenario.shortPath && run.status === 77) {
      results.push({ name: scenario.name, skipped: true, reason: "测试卷未提供 8.3 别名，不能把短路径场景计为通过" });
      continue;
    }
    assert.equal(run.status, scenario.invalid ? 2 : 0);
    if (scenario.invalid) assert(!fs.existsSync(normalized), "失败后不得继续执行");
    else assert.equal(fs.readFileSync(normalized, "utf8"), expected);
    if (scenario.shortPath) assert.deepEqual(fs.readdirSync(input), [], "规范化不能创建尚不存在的后缀目录");
    if (scenario.rootChild) assert(!fs.existsSync(path.join(path.parse(root).root, `cyrene-path-${path.basename(root)}`)), "规范化不能在磁盘根下创建目录");
    assert(!fs.existsSync(path.join(directory, "uncreated")), "路径规范化不能预建或改动目标目录");
    results.push({ name: scenario.name, passed: true, exitCode: run.status });
  } catch (error) { results.push({ name: scenario.name, passed: false, error: String(error) }); }
}
fs.writeFileSync(path.join(root, "results.json"), JSON.stringify({ root, results }, null, 2));
console.log(JSON.stringify({ root, results }, null, 2));
if (results.some(result => !result.passed && !result.skipped)) process.exitCode = 1;
