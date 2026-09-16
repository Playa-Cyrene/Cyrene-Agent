// 文件类型图标 — VS Code 官方 vscode-icons 图标集（MIT，来源 vscode-icons/vscode-icons 仓库）。
// 图标资产在 assets/icons/vscode/，按扩展名 / 特殊文件名解析；
// 未识别的类型返回 null，由调用方回退到通用 lucide 图标。

import typescriptSvg from "../../../../../../assets/icons/vscode/file_type_typescript.svg";
import reacttsSvg from "../../../../../../assets/icons/vscode/file_type_reactts.svg";
import jsSvg from "../../../../../../assets/icons/vscode/file_type_light_js.svg";
import reactjsSvg from "../../../../../../assets/icons/vscode/file_type_reactjs.svg";
import jsonSvg from "../../../../../../assets/icons/vscode/file_type_light_json.svg";
import cssSvg from "../../../../../../assets/icons/vscode/file_type_css.svg";
import scssSvg from "../../../../../../assets/icons/vscode/file_type_scss.svg";
import lessSvg from "../../../../../../assets/icons/vscode/file_type_less.svg";
import htmlSvg from "../../../../../../assets/icons/vscode/file_type_html.svg";
import markdownSvg from "../../../../../../assets/icons/vscode/file_type_markdown.svg";
import pythonSvg from "../../../../../../assets/icons/vscode/file_type_python.svg";
import rustSvg from "../../../../../../assets/icons/vscode/file_type_light_rust.svg";
import goSvg from "../../../../../../assets/icons/vscode/file_type_go.svg";
import javaSvg from "../../../../../../assets/icons/vscode/file_type_java.svg";
import cSvg from "../../../../../../assets/icons/vscode/file_type_c.svg";
import cppSvg from "../../../../../../assets/icons/vscode/file_type_cpp.svg";
import cheaderSvg from "../../../../../../assets/icons/vscode/file_type_cheader.svg";
import csharpSvg from "../../../../../../assets/icons/vscode/file_type_csharp.svg";
import phpSvg from "../../../../../../assets/icons/vscode/file_type_php.svg";
import rubySvg from "../../../../../../assets/icons/vscode/file_type_ruby.svg";
import shellSvg from "../../../../../../assets/icons/vscode/file_type_shell.svg";
import yamlSvg from "../../../../../../assets/icons/vscode/file_type_light_yaml.svg";
import xmlSvg from "../../../../../../assets/icons/vscode/file_type_xml.svg";
import sqlSvg from "../../../../../../assets/icons/vscode/file_type_sql.svg";
import vueSvg from "../../../../../../assets/icons/vscode/file_type_vue.svg";
import svelteSvg from "../../../../../../assets/icons/vscode/file_type_svelte.svg";
import tomlSvg from "../../../../../../assets/icons/vscode/file_type_light_toml.svg";
import luaSvg from "../../../../../../assets/icons/vscode/file_type_lua.svg";
import dartSvg from "../../../../../../assets/icons/vscode/file_type_dartlang.svg";
import kotlinSvg from "../../../../../../assets/icons/vscode/file_type_kotlin.svg";
import swiftSvg from "../../../../../../assets/icons/vscode/file_type_swift.svg";
import batSvg from "../../../../../../assets/icons/vscode/file_type_bat.svg";
import powershellSvg from "../../../../../../assets/icons/vscode/file_type_powershell.svg";
import svgFileSvg from "../../../../../../assets/icons/vscode/file_type_svg.svg";
import imageSvg from "../../../../../../assets/icons/vscode/file_type_image.svg";
import textSvg from "../../../../../../assets/icons/vscode/file_type_text.svg";
import pdfSvg from "../../../../../../assets/icons/vscode/file_type_pdf.svg";
import zipSvg from "../../../../../../assets/icons/vscode/file_type_zip.svg";
import gitSvg from "../../../../../../assets/icons/vscode/file_type_git.svg";
import npmSvg from "../../../../../../assets/icons/vscode/file_type_npm.svg";
import dockerSvg from "../../../../../../assets/icons/vscode/file_type_docker.svg";
import nodeSvg from "../../../../../../assets/icons/vscode/file_type_node.svg";

/** 扩展名（小写）→ 图标 URL */
const EXT_ICON: Record<string, string> = {
  ts: typescriptSvg,
  tsx: reacttsSvg,
  js: jsSvg,
  mjs: jsSvg,
  cjs: jsSvg,
  jsx: reactjsSvg,
  json: jsonSvg,
  jsonc: jsonSvg,
  css: cssSvg,
  scss: scssSvg,
  sass: scssSvg,
  less: lessSvg,
  html: htmlSvg,
  htm: htmlSvg,
  md: markdownSvg,
  markdown: markdownSvg,
  mdx: markdownSvg,
  txt: textSvg,
  py: pythonSvg,
  pyw: pythonSvg,
  rs: rustSvg,
  go: goSvg,
  java: javaSvg,
  c: cSvg,
  cpp: cppSvg,
  cc: cppSvg,
  cxx: cppSvg,
  h: cheaderSvg,
  hpp: cheaderSvg,
  cs: csharpSvg,
  php: phpSvg,
  rb: rubySvg,
  sh: shellSvg,
  bash: shellSvg,
  zsh: shellSvg,
  yaml: yamlSvg,
  yml: yamlSvg,
  xml: xmlSvg,
  sql: sqlSvg,
  vue: vueSvg,
  svelte: svelteSvg,
  toml: tomlSvg,
  lua: luaSvg,
  dart: dartSvg,
  kt: kotlinSvg,
  kts: kotlinSvg,
  swift: swiftSvg,
  bat: batSvg,
  cmd: batSvg,
  ps1: powershellSvg,
  svg: svgFileSvg,
  png: imageSvg,
  jpg: imageSvg,
  jpeg: imageSvg,
  gif: imageSvg,
  webp: imageSvg,
  ico: imageSvg,
  bmp: imageSvg,
  pdf: pdfSvg,
  zip: zipSvg,
  gz: zipSvg,
  rar: zipSvg,
  "7z": zipSvg,
};

/** 特殊文件名（全小写精确匹配）→ 图标 URL */
const NAME_ICON: Record<string, string> = {
  "package.json": npmSvg,
  "package-lock.json": npmSvg,
  "pnpm-lock.yaml": npmSvg,
  "yarn.lock": npmSvg,
  ".gitignore": gitSvg,
  ".gitattributes": gitSvg,
  ".gitmodules": gitSvg,
  "dockerfile": dockerSvg,
  ".dockerignore": dockerSvg,
  "docker-compose.yml": dockerSvg,
  "docker-compose.yaml": dockerSvg,
  ".nvmrc": nodeSvg,
  ".node-version": nodeSvg,
};

/** 根据文件名取图标 URL；未识别返回 null（调用方回退到通用图标） */
export function vscodeIconForFile(name: string): string | null {
  const lower = name.toLowerCase();
  if (NAME_ICON[lower]) return NAME_ICON[lower];
  const dot = lower.lastIndexOf(".");
  if (dot > 0) return EXT_ICON[lower.slice(dot + 1)] ?? null;
  return null;
}
