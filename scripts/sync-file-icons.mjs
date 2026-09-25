// 同步 devicon 品牌图标到渲染层资源目录，供文件卡片/正文文件链接按后缀显示图标。
// 用法：npm run sync:file-icons（升级 devicon 或调整下方映射表后跑一次）
//
// 产物（均为生成物，勿手改）：
//   src/renderer/assets/file-icons/*.svg                          拷贝的品牌图标 + 通用兜底轮廓
//   src/renderer/react/features/chat/components/file-icon-assets.ts  图标 url 表 + 文件名/后缀映射表
//
// 设计：devicon 只提供技术品牌图标（无 txt/cmd 等通用文件图标，也无后缀映射），
// 映射关系在本脚本维护；未识别的文件统一落到 default.svg 通用轮廓。

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

/** 后缀 → devicon 图标名（键统一小写；tsx 给 react 是刻意决策：React 组件文件） */
const EXT_MAP = {
  ts: "typescript", tsx: "react", mts: "typescript", cts: "typescript",
  js: "javascript", jsx: "react", mjs: "javascript", cjs: "javascript",
  md: "markdown", mdx: "markdown",
  html: "html5", htm: "html5", xhtml: "html5",
  css: "css3", scss: "sass", sass: "sass", less: "less",
  py: "python", pyw: "python", ipynb: "jupyter",
  go: "go",
  rs: "rust",
  java: "java",
  kt: "kotlin", kts: "kotlin",
  swift: "swift",
  c: "c", h: "c",
  cpp: "cplusplus", cc: "cplusplus", cxx: "cplusplus", hpp: "cplusplus", hh: "cplusplus", hxx: "cplusplus",
  cs: "csharp",
  php: "php",
  rb: "ruby",
  dart: "dart",
  lua: "lua",
  sh: "bash", bash: "bash", zsh: "bash",
  ps1: "powershell",
  vue: "vuejs",
  svelte: "svelte",
  astro: "astro",
  gradle: "gradle",
  // 数据 / 配置格式（json/yaml/xml 来自 devicon；toml/sql 是自绘徽章）
  json: "json", yaml: "yaml", yml: "yaml", xml: "xml",
  toml: "toml", sql: "sql", proto: "protobuf",
  graphql: "graphql", gql: "graphql",
  prisma: "prisma",
  // 更多语言
  r: "r",
  scala: "scala", sbt: "scala",
  groovy: "groovy",
  jl: "julia",
  pl: "perl", pm: "perl",
  ex: "elixir", exs: "elixir", heex: "elixir",
  erl: "erlang", hrl: "erlang",
  hs: "haskell",
  ml: "ocaml", mli: "ocaml",
  fs: "fsharp", fsx: "fsharp",
  zig: "zig",
  nim: "nim", nims: "nim",
  sol: "solidity",
  m: "objectivec", mm: "objectivec",
  // 基建 / 数据库
  tf: "terraform", tfvars: "terraform",
  sqlite: "sqlite", sqlite3: "sqlite", db: "sqlite",
};

/** 特殊文件名（小写）→ devicon 图标名；优先级高于后缀匹配 */
const NAME_MAP = {
  "package.json": "npm",
  "package-lock.json": "npm",
  "yarn.lock": "yarn",
  "pnpm-lock.yaml": "pnpm",
  "tsconfig.json": "typescript",
  "jsconfig.json": "javascript",
  "go.mod": "go",
  "go.sum": "go",
  "cargo.toml": "rust",
  "requirements.txt": "python",
  "pyproject.toml": "python",
  "setup.py": "python",
  "dockerfile": "docker",
  "docker-compose.yml": "docker",
  "docker-compose.yaml": "docker",
  ".dockerignore": "docker",
  ".gitignore": "git",
  ".gitattributes": "git",
  ".gitmodules": "git",
  "vite.config.ts": "vite",
  "vite.config.js": "vite",
  "next.config.js": "nextjs",
  "next.config.mjs": "nextjs",
  "angular.json": "angular",
  "vue.config.js": "vuejs",
  "deno.json": "deno",
  "webpack.config.js": "webpack",
  // vite 家族
  "vite.config.mts": "vite", "vite.config.cts": "vite",
  // 框架 / 运行时配置
  "next.config.ts": "nextjs",
  "nuxt.config.ts": "nuxtjs", "nuxt.config.js": "nuxtjs",
  "remix.config.js": "remix",
  "tailwind.config.js": "tailwindcss", "tailwind.config.ts": "tailwindcss", "tailwind.config.cjs": "tailwindcss",
  "jest.config.js": "jest", "jest.config.ts": "jest",
  "nest-cli.json": "nestjs",
  "tauri.conf.json": "tauri",
  "pubspec.yaml": "flutter", "pubspec.lock": "flutter",
  "bun.lockb": "bun", "bunfig.toml": "bun",
  "electron-builder.yml": "electron", "electron-builder.json": "electron", "electron.vite.config.ts": "electron",
  // Rust 生态（devicon 无独立 cargo 图标，统一用 Rust 齿轮）
  "cargo.lock": "rust", "rust-toolchain.toml": "rust", "rust-toolchain": "rust",
  // Python 生态（poetry 有图标；uv/pip 无，文件归 Python 图标）
  "poetry.lock": "poetry", "pipfile": "python", "pipfile.lock": "python",
  "uv.lock": "python", ".python-version": "python",
  // 构建 / 容器 / 基建
  "pom.xml": "maven", "cmakelists.txt": "cmake", "makefile": "make",
  "chart.yaml": "kubernetes", "k8s.yaml": "kubernetes",
  "ansible.cfg": "ansible",
  "nginx.conf": "nginx",
  // 其他生态
  "gemfile": "ruby", "rakefile": "ruby",
  "composer.json": "composer", "composer.lock": "composer",
  "mix.exs": "elixir",
  ".eslintrc": "eslint", ".eslintrc.json": "eslint", ".eslintrc.js": "eslint",
  "eslint.config.js": "eslint", "eslint.config.mjs": "eslint",
  ".babelrc": "babel", "babel.config.js": "babel",
  ".npmrc": "npm", ".nvmrc": "nodejs", ".node-version": "nodejs",
};

/** 图标染色覆盖：devicon 原版是黑白的图标（如 rust 黑齿轮）注入品牌色 */
const ICON_COLOR_OVERRIDES = {
  // Rust 官方/社区认知的橙色（GitHub linguist 语言色），原版黑色齿轮在深色主题下看不清
  rust: "#dea584",
};

/** 给无 fill 的 path 注入颜色（已有 fill 的 path 保持原样，避免破坏多色图标） */
function applyColorOverride(name, svgText) {
  const fill = ICON_COLOR_OVERRIDES[name];
  if (!fill) return svgText;
  return svgText.replace(/<path(?![^>]*\bfill=)/g, `<path fill="${fill}"`);
}

/** 自绘字母徽章：devicon 没有的数据格式/工具（品牌色圆角方块 + 居中字母） */
const BADGE_ICONS = {
  toml: { label: "T", color: "#9c4120" },
  sql: { label: "SQL", color: "#e38c00" },
  protobuf: { label: "PB", color: "#4285f4" },
  prettier: { label: "P", color: "#1a2b34" },
  make: { label: "M", color: "#427819" },
};

function badgeSvg(badge) {
  // 双字母用小字号避免溢出
  const fontSize = badge.label.length > 1 ? 42 : 64;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128"><rect x="6" y="6" width="116" height="116" rx="24" fill="${badge.color}"/><text x="64" y="84" font-family="Arial, Helvetica, sans-serif" font-size="${fontSize}" font-weight="bold" fill="#fff" text-anchor="middle">${badge.label}</text></svg>`;
}

/** 通用兜底图标（非技术文件 txt/cmd/log/zip 等都走这里） */
const DEFAULT_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" width="16" height="16">
  <path d="M4 1.5h5L12.5 5v9a.5.5 0 0 1-.5.5H4a.5.5 0 0 1-.5-.5V2a.5.5 0 0 1 .5-.5Z" fill="#9aa0a6" fill-opacity=".18" stroke="#9aa0a6" stroke-linejoin="round"/>
  <path d="M9 1.5V5h3.5" fill="none" stroke="#9aa0a6" stroke-linejoin="round"/>
</svg>
`;

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const deviconDir = path.join(projectRoot, "node_modules", "devicon");
const assetsDir = path.join(projectRoot, "src", "renderer", "react", "assets", "file-icons");
const assetsModule = path.join(projectRoot, "src", "renderer", "react", "features", "chat", "components", "file-icon-assets.ts");

// devicon 元数据：name → 可用 svg 版本列表
const meta = JSON.parse(fs.readFileSync(path.join(deviconDir, "devicon.json"), "utf8"));
const available = new Map(meta.map((icon) => [icon.name, icon.versions.svg ?? []]));

/** 选渲染版本：优先 original（彩色品牌 logo），其次 plain */
function pickVersion(name) {
  const versions = available.get(name);
  if (!versions) return null;
  return versions.includes("original") ? "original" : (versions.includes("plain") ? "plain" : versions[0] ?? null);
}

// 需要的图标 = 两组映射去重；缺失的从映射剔除（运行时兜底 default）
// 自绘徽章不查 devicon，直接视为可用
const wanted = [...new Set([...Object.values(EXT_MAP), ...Object.values(NAME_MAP)])];
const missing = [];
const okIcons = [];
for (const name of wanted) {
  if (BADGE_ICONS[name]) { okIcons.push({ name, version: null }); continue; }
  const version = pickVersion(name);
  if (!version) { missing.push(name); continue; }
  okIcons.push({ name, version });
}

// 清空产物目录后重拷（保证删除映射后旧图标不残留）
fs.rmSync(assetsDir, { recursive: true, force: true });
fs.mkdirSync(assetsDir, { recursive: true });
for (const { name, version } of okIcons) {
  const dest = path.join(assetsDir, `${name}.svg`);
  if (BADGE_ICONS[name]) {
    fs.writeFileSync(dest, badgeSvg(BADGE_ICONS[name]));
    continue;
  }
  const src = path.join(deviconDir, "icons", name, `${name}-${version}.svg`);
  fs.writeFileSync(dest, applyColorOverride(name, fs.readFileSync(src, "utf8")));
}
fs.writeFileSync(path.join(assetsDir, "default.svg"), DEFAULT_SVG);

// 剔除缺失图标对应的映射条目
const drop = (map) => Object.fromEntries(Object.entries(map).filter(([, v]) => !missing.includes(v)));
const extMap = drop(EXT_MAP);
const nameMap = drop(NAME_MAP);

// 生成 file-icon-assets.ts：静态 import 让 Vite 处理 svg（hash、打包、dev 热更都正确）
const varName = (name) => `_icon_${name.replace(/[^a-z0-9]/g, "_")}`;
const lines = [];
lines.push("// 由 scripts/sync-file-icons.mjs 生成，勿手改。映射表与图标源见该脚本。");
lines.push(`import _icon_default from "../../../assets/file-icons/default.svg";`);
for (const { name } of okIcons) {
  lines.push(`import ${varName(name)} from "../../../assets/file-icons/${name}.svg";`);
}
lines.push("");
lines.push("/** devicon 图标名（与 default）→ 打包后的 svg url */");
lines.push("export const FILE_ICON_URLS: Record<string, string> = {");
lines.push(`  default: _icon_default,`);
for (const { name } of okIcons) lines.push(`  ${name}: ${varName(name)},`);
lines.push("};");
lines.push("");
lines.push("/** 特殊文件名（小写）→ 图标名；优先于后缀匹配 */");
lines.push("export const FILE_NAME_MAP: Record<string, string> = " + JSON.stringify(nameMap) + ";");
lines.push("");
lines.push("/** 文件后缀（小写）→ 图标名 */");
lines.push("export const FILE_EXT_MAP: Record<string, string> = " + JSON.stringify(extMap) + ";");
fs.writeFileSync(assetsModule, lines.join("\n") + "\n");

console.log(`[file-icons] 已生成 ${okIcons.length + 1} 个图标到 src/renderer/react/assets/file-icons/`);
if (missing.length > 0) {
  console.warn(`[file-icons] devicon 缺少以下图标，相关映射已剔除（文件将显示通用图标）: ${missing.join(", ")}`);
}
