import {
  DEFAULT_MESSAGE_TYPOGRAPHY,
  normalizeMessageTypography,
  type MessageTypography,
} from "../../shared/message-typography";

/** 把排版设置写到根节点 CSS 变量，AI 回复气泡的样式消费这些变量。 */
export function applyMessageTypography(value: unknown): MessageTypography {
  const typography = normalizeMessageTypography(value);
  const root = document.documentElement.style;
  root.setProperty("--cy-msg-size", `${typography.fontSize}px`);
  root.setProperty("--cy-msg-line-height", `${typography.lineHeight}`);
  root.setProperty("--cy-msg-spacing", `${typography.letterSpacing}px`);
  root.setProperty("--cy-msg-weight", `${typography.fontWeight}`);
  return typography;
}

applyMessageTypography(DEFAULT_MESSAGE_TYPOGRAPHY);

// 启动时从通用设置恢复；设置页拖动滑块时直接调用 applyMessageTypography 实时预览
void window.settings?.getGeneral()
  .then((config) => applyMessageTypography((config as { messageTypography?: unknown } | null | undefined)?.messageTypography))
  .catch(() => applyMessageTypography(DEFAULT_MESSAGE_TYPOGRAPHY));
