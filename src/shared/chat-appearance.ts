// Chat 排版设置 —— Main / Preload / React 共用类型与归一化。
//
// chatLineHeight 存储无单位数字（1.75），CSS 应用时直接使用。

export interface ChatAppearanceSettings {
  /** 行高，无单位数字 */
  chatLineHeight: number;
}

export const DEFAULT_CHAT_APPEARANCE: ChatAppearanceSettings = {
  chatLineHeight: 1.75,
};

export const CHAT_LINE_HEIGHT_MIN = 1.0;
export const CHAT_LINE_HEIGHT_MAX = 3.0;

/**
 * 将有限数值 clamp 到 [min, max]；非有限值（NaN / Infinity / 非 number）回退默认值。
 */
export function clampFiniteNumber(
  value: unknown,
  min: number,
  max: number,
  fallback: number,
): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return fallback;
  }
  return Math.min(max, Math.max(min, value));
}

/**
 * 从任意输入归一化为合法 ChatAppearanceSettings。
 * 输入可以是完整对象、部分对象、null、undefined 或其他任意值。
 */
export function normalizeChatAppearance(
  input: unknown,
): ChatAppearanceSettings {
  const source =
    input && typeof input === "object"
      ? (input as Record<string, unknown>)
      : {};

  return {
    chatLineHeight: clampFiniteNumber(
      source.chatLineHeight,
      CHAT_LINE_HEIGHT_MIN,
      CHAT_LINE_HEIGHT_MAX,
      DEFAULT_CHAT_APPEARANCE.chatLineHeight,
    ),
  };
}
