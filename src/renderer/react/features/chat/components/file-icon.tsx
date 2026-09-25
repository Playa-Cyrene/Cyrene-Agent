// 文件图标：按文件名/后缀解析 devicon 品牌图标（数据见 file-icon-assets.ts，
// 由 scripts/sync-file-icons.mjs 生成），未识别的后缀显示通用文件轮廓。

import { FILE_EXT_MAP, FILE_ICON_URLS, FILE_NAME_MAP } from "./file-icon-assets";

/** 解析文件（可含目录）的图标 url：特殊文件名优先，其次后缀，兜底通用轮廓 */
export function resolveFileIconUrl(filePath: string): string {
  const base = filePath.replaceAll("\\", "/").split("/").pop() ?? "";
  const lower = base.toLowerCase();
  const byName = FILE_NAME_MAP[lower];
  if (byName && FILE_ICON_URLS[byName]) return FILE_ICON_URLS[byName];
  const dot = lower.lastIndexOf(".");
  if (dot > 0) {
    const byExt = FILE_EXT_MAP[lower.slice(dot + 1)];
    if (byExt && FILE_ICON_URLS[byExt]) return FILE_ICON_URLS[byExt];
  }
  return FILE_ICON_URLS.default;
}

/** 行内文件图标；尺寸/对齐由 className 对应的样式控制 */
export function FileIcon({ fileName, className }: { fileName: string; className?: string }) {
  return (
    <img
      src={resolveFileIconUrl(fileName)}
      alt=""
      aria-hidden="true"
      draggable={false}
      className={className}
    />
  );
}
