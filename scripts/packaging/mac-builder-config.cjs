// 从 electron-builder.yml 派生 macOS（实验性）打包配置。
//
// 不另存一份 YAML：手抄的副本会随主配置演进悄悄过期（例如 asarUnpack 新增条目、
// 内置技能目录从 defaults/skills 改为 skills），这里在打包时现读主配置再做最小改写，
// Windows 正式打包仍只读 electron-builder.yml，不受影响。
const fs = require("node:fs");
const path = require("node:path");
const { load } = require("js-yaml");

/** 只在 Windows 上存在或只供 Windows 使用的打包资源（截图助手 .exe、mpv.exe、MinGit）。 */
const WINDOWS_ONLY_RESOURCES = [/cyrene-screenshot\.exe$/, /^resources\/bin\/mpv$/, /^resources\/mingit$/];
/** Windows 沙箱二进制，macOS 不需要。 */
const WINDOWS_ONLY_VENDOR = "vendor/srt-win";
/** 主配置为 Windows x64 排除了其他平台的 ONNX Runtime；macOS 改为保留 darwin、排除 win32。 */
const ONNX_DARWIN_EXCLUDE = "!**/onnxruntime-node/bin/napi-v3/darwin/**/*";
const ONNX_WIN32_EXCLUDE = "!**/onnxruntime-node/bin/napi-v3/win32/**/*";

function buildMacConfig(base) {
  const config = structuredClone(base);
  // Windows 专属段：NSIS 安装器、GitHub 自动更新发布源（未签名的 mac 包无法自动更新）
  delete config.win;
  delete config.nsis;
  delete config.publish;

  config.asarUnpack = (config.asarUnpack ?? []).filter((pattern) => !pattern.includes(WINDOWS_ONLY_VENDOR));
  config.files = (config.files ?? [])
    .filter((pattern) => pattern !== ONNX_DARWIN_EXCLUDE && !pattern.includes("onnxruntime-node/bin/napi-v3/win32/"))
    .concat(ONNX_WIN32_EXCLUDE, `!${WINDOWS_ONLY_VENDOR}/**/*`);

  // macOS 的 extraFiles 目标相对 Contents/；运行时在可执行文件同级（Contents/MacOS）查找，
  // 见 src/main/external-content-paths.ts
  config.extraFiles = (config.extraFiles ?? []).map((entry) => ({ ...entry, to: `MacOS/${entry.to}` }));
  config.extraResources = (config.extraResources ?? [])
    .filter((entry) => !WINDOWS_ONLY_RESOURCES.some((pattern) => pattern.test(entry.from)));

  config.mac = {
    category: "public.app-category.productivity",
    target: ["dir"],
    ...(base.win?.electronLanguages ? { electronLanguages: base.win.electronLanguages } : {}),
  };
  return config;
}

function loadMacBuilderConfig(baseConfigPath = path.join(__dirname, "..", "..", "electron-builder.yml")) {
  return buildMacConfig(load(fs.readFileSync(baseConfigPath, "utf8")));
}

module.exports = { buildMacConfig, loadMacBuilderConfig };
