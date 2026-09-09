/**
 * 聊天主界面（react/）的 i18n 基础设施。
 *
 * - 使用 i18next 核心包（框架无关）：React 组件用 useTranslation hook，
 *   非 React 的纯 ts 模块直接 import { t }。
 * - 资源文件：zh-CN.json（合并式单文件，按域名分节）。
 * - 语言来源：主进程 GeneralSettings.language（即 locale-context 的 uiLocale）。
 *   第一阶段只有中文资源；新增语言时补充 <locale>.json 并在 resources 注册。
 */
import i18next from "i18next";
import { useCallback, useSyncExternalStore } from "react";
import en from "./en.json";
import zhCN from "./zh-CN.json";

export const UI_LOCALE_FALLBACK = "zh-CN";

void i18next.init({
  lng: UI_LOCALE_FALLBACK,
  fallbackLng: UI_LOCALE_FALLBACK,
  resources: {
    en: { translation: en },
    "zh-CN": { translation: zhCN },
  },
  interpolation: { escapeValue: false },
  // 缺 key 时回退到 key 本身，便于发现漏抽的文案
  parseMissingKeyHandler: (key) => key,
});

/**
 * 从主进程读取语言设置并应用。
 * 失败（IPC 不可用 / 设置读取异常）时静默保持默认 zh-CN。
 */
export async function initUiLocale(): Promise<void> {
  try {
    const general = await window.chat?.getGeneralSettings?.();
    const lang = general?.language;
    if (typeof lang === "string" && lang.trim() && lang !== UI_LOCALE_FALLBACK) {
      await i18next.changeLanguage(lang.trim());
    }
  } catch {
    // 保持默认语言
  }
}

/** 运行时切换 UI 语言。 */
export function setUiLocale(locale: string): void {
  if (locale.trim()) void i18next.changeLanguage(locale.trim());
}

/** 供非 React 模块直接使用的翻译函数（语言切换时不会触发重渲染，按调用即时取值）。 */
export const t = i18next.t.bind(i18next);

function subscribe(onChange: () => void): () => void {
  i18next.on("languageChanged", onChange);
  return () => {
    i18next.off("languageChanged", onChange);
  };
}

/**
 * React 组件翻译 hook：语言切换时自动重渲染。
 * 用法：const { t } = useTranslation(); t("composer.uploadFile")
 */
export function useTranslation() {
  // 第三个参数 getServerSnapshot：renderToStaticMarkup 等服务端渲染路径必需，
  // 否则 React 抛 "Missing getServerSnapshot"（单测用静态渲染断言文案）。
  const locale = useSyncExternalStore(subscribe, () => i18next.language, () => i18next.language);
  const translate = useCallback(
    (key: string, options?: Record<string, unknown>) => i18next.t(key, options),
    // locale 变化时刷新 useCallback 缓存，确保子组件拿到新语言的翻译
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [locale],
  );
  return { t: translate, locale };
}
