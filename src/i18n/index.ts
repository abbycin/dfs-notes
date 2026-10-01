import type { UIStrings } from "./types";
import { defaultLocale } from "./config";

export { tplStr } from "./format";
export {
  defaultLocale,
  htmlLang,
  isLocale,
  localeNames,
  locales,
  ogLocale,
  type Locale,
} from "./config";

const modules = import.meta.glob<{ default: UIStrings }>("./lang/*.ts", {
  eager: true,
});

const translations: Record<string, UIStrings> = {};
for (const [path, mod] of Object.entries(modules)) {
  const locale = path.slice("./lang/".length, -".ts".length);
  translations[locale] = mod.default;
}

/** Returns UI strings for the given locale, falling back to the default language. */
export function useTranslations(locale?: string | null): UIStrings {
  return translations[locale ?? defaultLocale] ?? translations[defaultLocale];
}
