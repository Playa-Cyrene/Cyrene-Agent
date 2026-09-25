/** 昔涟回复正文的排版设置：只作用于聊天里 AI 回复气泡的 Markdown 正文。 */
export interface MessageTypography {
  /** 字号（px） */
  fontSize: number;
  /** 行高（字号的倍数） */
  lineHeight: number;
  /** 字间距（px） */
  letterSpacing: number;
  /** 字重：300 细体 ~ 700 粗体，400 为常规 */
  fontWeight: number;
}

export const DEFAULT_MESSAGE_TYPOGRAPHY: MessageTypography = {
  fontSize: 15,
  lineHeight: 1.85,
  letterSpacing: 0.8,
  fontWeight: 400,
};

/** 各数值的合法调节范围，设置页滑块与归一化共用。 */
export const MESSAGE_TYPOGRAPHY_RANGES = {
  fontSize: { min: 12, max: 20 },
  lineHeight: { min: 1.2, max: 2.2 },
  letterSpacing: { min: 0, max: 2 },
  fontWeight: { min: 300, max: 700 },
} as const;

function clampNumber(value: unknown, min: number, max: number, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, value));
}

/** 兼容旧配置：缺失或非法的项逐个回落默认值，再夹回合法范围。 */
export function normalizeMessageTypography(value: unknown): MessageTypography {
  const input = value && typeof value === "object" ? value as Record<string, unknown> : {};
  return {
    fontSize: clampNumber(input.fontSize, MESSAGE_TYPOGRAPHY_RANGES.fontSize.min, MESSAGE_TYPOGRAPHY_RANGES.fontSize.max, DEFAULT_MESSAGE_TYPOGRAPHY.fontSize),
    lineHeight: clampNumber(input.lineHeight, MESSAGE_TYPOGRAPHY_RANGES.lineHeight.min, MESSAGE_TYPOGRAPHY_RANGES.lineHeight.max, DEFAULT_MESSAGE_TYPOGRAPHY.lineHeight),
    letterSpacing: clampNumber(input.letterSpacing, MESSAGE_TYPOGRAPHY_RANGES.letterSpacing.min, MESSAGE_TYPOGRAPHY_RANGES.letterSpacing.max, DEFAULT_MESSAGE_TYPOGRAPHY.letterSpacing),
    fontWeight: clampNumber(input.fontWeight, MESSAGE_TYPOGRAPHY_RANGES.fontWeight.min, MESSAGE_TYPOGRAPHY_RANGES.fontWeight.max, DEFAULT_MESSAGE_TYPOGRAPHY.fontWeight),
  };
}
