// 安装包产物验证：NSIS 安装器、更新元数据与随包二进制是否齐全。
// 在 electron-builder --win nsis 构建完成后运行，检查输出目录（electron-builder.yml
// 的 directories.output，默认 release/）：
//   1. Cyrene-Setup-<version>.exe 存在且体积合理
//   2. latest.yml 的 version 与 package.json 一致，path 指向同一安装器，sha512 存在
//   3. win-unpacked/resources 内截图辅助程序、mpv、MinGit、skills 快照齐全
// 用法：node scripts/verify/installer-artifacts.mjs [--expect-version x.y.z]
//   --expect-version：标签构建时传入标签版本，校验「产物版本与标签一致」
import { stat } from "node:fs/promises";
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as yaml from "yaml";
import { verifyScreenshotHelper } from "./screenshot-helper.mjs";
import { verifyMpvHelper } from "./mpv-helper.mjs";

const parseYaml = yaml.parse;
const execFileAsync = promisify(execFile);
const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(scriptDir, "..", "..");

// 安装器小于该值必然缺资源（Electron 本体 + mpv + MinGit 远大于此）
const MIN_INSTALLER_BYTES = 20 * 1024 * 1024;

export async function verifyInstallerArtifacts(options = {}) {
  const { expectVersion } = options;

  const pkg = JSON.parse(await readFile(path.join(projectRoot, "package.json"), "utf8"));
  const builderConfig = parseYaml(
    await readFile(path.join(projectRoot, "electron-builder.yml"), "utf8"),
  );
  const outputDir = path.join(projectRoot, builderConfig.directories?.output ?? "release");
  const artifactName = (builderConfig.nsis?.artifactName ?? "Cyrene-Setup-${version}.${ext}")
    .replace("${version}", pkg.version)
    .replace("${ext}", "exe");

  if (expectVersion && expectVersion !== pkg.version) {
    throw new Error(`标签版本 ${expectVersion} 与 package.json 版本 ${pkg.version} 不一致`);
  }

  // 1. 安装器本体
  const installerPath = path.join(outputDir, artifactName);
  const installerStat = await stat(installerPath);
  if (installerStat.size <= MIN_INSTALLER_BYTES) {
    throw new Error(`安装器体积异常（${installerStat.size} bytes）：${installerPath}`);
  }

  // 2. 更新元数据（electron-updater 下载依据；不校验内容等于放走更新路径回归）
  const latest = parseYaml(await readFile(path.join(outputDir, "latest.yml"), "utf8"));
  if (latest.version !== pkg.version) {
    throw new Error(`latest.yml 版本 ${latest.version} 与 package.json 版本 ${pkg.version} 不一致`);
  }
  if (latest.path !== artifactName) {
    throw new Error(`latest.yml path ${latest.path} 与安装器文件名 ${artifactName} 不一致`);
  }
  if (!latest.sha512 || typeof latest.sha512 !== "string") {
    throw new Error("latest.yml 缺少 sha512 校验值");
  }

  // 3. win-unpacked 内的随包二进制（与安装器内容一致，免去装机检查）
  const resourcesDir = path.join(outputDir, "win-unpacked", "resources");
  const screenshot = await verifyScreenshotHelper(path.join(resourcesDir, "bin", "cyrene-screenshot.exe"));
  const mpv = await verifyMpvHelper(path.join(resourcesDir, "bin", "mpv", "mpv.exe"));
  // MinGit 的 cmd/git.exe 只是启动器（几十 KB），真二进制在 mingw64/bin/，
  // 体积阈值无意义，以 --version 运行探测为准（与 prepare-mingit 同一判定）
  const gitExe = path.join(resourcesDir, "mingit", "cmd", "git.exe");
  await stat(gitExe);
  const { stdout: gitVersion } = await execFileAsync(gitExe, ["--version"], {
    windowsHide: true,
    timeout: 10_000,
  });
  await stat(path.join(resourcesDir, "cyrene-skills", "skills-snapshot.zip"));

  return {
    installerPath,
    installerSize: installerStat.size,
    version: pkg.version,
    mpvVersion: mpv.version,
    gitVersion: gitVersion.trim(),
    screenshotSize: screenshot.size,
  };
}

const isDirectRun =
  process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isDirectRun) {
  const expectIndex = process.argv.indexOf("--expect-version");
  const expectVersion = expectIndex !== -1 ? process.argv[expectIndex + 1] : undefined;
  verifyInstallerArtifacts({ expectVersion })
    .then((result) => {
      console.log(
        `[installer] verified ${result.installerPath} (${result.installerSize} bytes) — v${result.version}`,
      );
      console.log(`[installer] mpv: ${result.mpvVersion}`);
      console.log(`[installer] mingit: ${result.gitVersion}`);
      console.log(`[installer] screenshot helper: ${result.screenshotSize} bytes`);
    })
    .catch((error) => {
      console.error(`[installer] verification failed: ${error.message}`);
      process.exitCode = 1;
    });
}
