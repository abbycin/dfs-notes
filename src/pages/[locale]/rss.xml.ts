import rss from "@astrojs/rss";
import { getLocaleSortedPosts } from "@/utils/postLocale";
import { getPostUrl } from "@/utils/getPostPaths";
import { useTranslations } from "@/i18n";
import { defaultLocale, htmlLang, locales, type Locale } from "@/i18n/config";
import config from "@/config";

// 每个语言一个 feed：/zh/rss.xml 与 /en/rss.xml
export function getStaticPaths() {
  return locales.map(locale => ({ params: { locale } }));
}

export async function GET({ params }: { params: Record<string, string> }) {
  const locale = (params.locale ?? defaultLocale) as Locale;
  const t = useTranslations(locale);

  const sortedPosts = await getLocaleSortedPosts(locale);

  return rss({
    title: t.site.title,
    description: t.site.description,
    site: config.site.url,
    items: sortedPosts.map(({ data, id, filePath }) => ({
      link: getPostUrl(id, filePath, locale),
      title: data.title,
      description: data.description,
      pubDate: new Date(data.modDatetime ?? data.pubDatetime),
    })),
    // 声明 feed 语言（与 head 的 html lang 同源）
    customData: `<language>${htmlLang[locale]}</language>`,
  });
}
