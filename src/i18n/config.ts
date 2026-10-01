/**
 * 语言配置：新增语言时，在这里和 i18n/lang/ 里各加一项即可。
 */
export const locales = ["zh", "en"] as const;

export type Locale = (typeof locales)[number];

/** 默认语言（根路径 / 会跳转到它） */
export const defaultLocale: Locale = "zh";

/** 语言切换器里显示的名字 */
export const localeNames: Record<Locale, string> = {
  zh: "中文",
  en: "English",
};

/** <html lang> 与 sitemap hreflang（必须与页面 head 保持一致） */
export const htmlLang: Record<Locale, string> = {
  zh: "zh-CN",
  en: "en",
};

/** Giscus 评论框语言 */
export const giscusLang: Record<Locale, string> = {
  zh: "zh-CN",
  en: "en",
};

/** Open Graph 的 og:locale */
export const ogLocale: Record<Locale, string> = {
  zh: "zh_CN",
  en: "en_US",
};

export function isLocale(value: string): value is Locale {
  return (locales as readonly string[]).includes(value);
}
