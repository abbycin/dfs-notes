import type { CollectionEntry } from "astro:content";
import { getCollection } from "astro:content";
import { defaultLocale, locales, type Locale } from "@/i18n/config";
import { getSortedPosts } from "./getSortedPosts";

export type PostEntry = CollectionEntry<"posts">;

/**
 * 文章文件名约定：`<slug>.<locale>.md`，例如 `hello-world.zh.md` / `hello-world.en.md`
 * 同一个 slug 的多个文件互为翻译。
 * id 由 glob loader 生成（保留原始文件名，见 content.config.ts 的 generateId）。
 * 没写语言后缀的文件按默认语言处理。
 */
export function splitId(id: string): { slug: string; locale: Locale } {
  const clean = id.replace(/\.(md|mdx|markdown)$/i, "");
  const idx = clean.lastIndexOf(".");
  if (idx > 0) {
    const suffix = clean.slice(idx + 1);
    if ((locales as readonly string[]).includes(suffix)) {
      return { slug: clean.slice(0, idx), locale: suffix as Locale };
    }
  }
  return { slug: clean, locale: defaultLocale };
}

/**
 * 某语言下可列出的文章（首页 / 文章列表 / 标签 / 归档 / 上下篇 / RSS 共用）：
 * 只保留该语言，排除草稿、定时未到与 unlisted（链接型文章）。
 */
export async function getLocaleSortedPosts(
  locale: Locale
): Promise<PostEntry[]> {
  const posts = await getCollection("posts", ({ id }) => {
    return splitId(id).locale === locale;
  });
  return getSortedPosts(posts).filter(post => !post.data.unlisted);
}

/** 导航栏入口文章（frontmatter 标了 nav: true，如「链接」页），按发布时间倒序 */
export async function getNavPosts(locale: Locale): Promise<PostEntry[]> {
  const posts = await getCollection("posts", ({ id }) => {
    return splitId(id).locale === locale;
  });
  return getSortedPosts(posts).filter(post => post.data.nav);
}

/**
 * 同 slug 各语言版本的存在情况（用于 head hreflang 与语言切换器）。
 * 只收录真实存在的文件，避免生成指向 404 的 alternate。
 */
export async function getTranslationEntries(
  slug: string
): Promise<Map<Locale, PostEntry>> {
  const entries = await getCollection("posts", ({ id }) => {
    return splitId(id).slug === slug;
  });
  const map = new Map<Locale, PostEntry>();
  for (const entry of entries) {
    const locale = splitId(entry.id).locale;
    if (!map.has(locale)) map.set(locale, entry);
  }
  return map;
}
