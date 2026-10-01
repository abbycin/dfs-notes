import { defineCollection } from "astro:content";
import { z } from "astro/zod";
import { glob } from "astro/loaders";
import config from "@/config";

export const BLOG_PATH = "src/content/posts";

const posts = defineCollection({
  loader: glob({
    pattern: "**/[^_]*.{md,mdx}",
    base: `./${BLOG_PATH}`,
    // 文件命名约定 `<slug>.<locale>.md`（如 hello.zh.md / hello.en.md），
    // 同 slug 的文件互为翻译。默认 generateId 会把 `.zh` 后缀 slugify 掉
    // （hello.zh → hellozh），这里显式保留原始文件名（去扩展名）。
    generateId: ({ entry }) => entry.replace(/\.(md|mdx|markdown)$/i, ""),
  }),
  schema: ({ image }) =>
    z.object({
      author: z.string().default(config.site.author),
      pubDatetime: z.date(),
      modDatetime: z.date().optional().nullable(),
      title: z.string(),
      featured: z.boolean().optional(),
      draft: z.boolean().optional(),
      tags: z.array(z.string()).default(["others"]),
      ogImage: image().or(z.string()).optional(),
      /** 必填：用于 meta description 与列表页摘要，每篇都要独一无二 */
      description: z
        .string()
        .min(1, "每篇文章都需要填写 description（用于 SEO meta 与列表摘要）"),
      canonicalURL: z.string().optional(),
      hideEditPost: z.boolean().optional(),
      timezone: z.string().optional(),

      // ---- 以下为本站自定义字段（链接型文章等） ----
      /**
       * 链接型文章：设置后详情页顶部显示醒目的「前往外部链接」按钮，
       * 例：https://github.com/abbycin/mace
       */
      externalUrl: z.url().optional(),
      /** 不出现在首页、文章列表、标签页与上下篇导航中（仅可直接访问） */
      unlisted: z.boolean().default(false),
      /** 在导航栏显示本文的标题作为入口（常与 unlisted 搭配） */
      nav: z.boolean().default(false),
    }),
});

const pages = defineCollection({
  loader: glob({
    pattern: "**/[^_]*.{md,mdx}",
    base: "./src/content/pages",
    // 关于页同样按 `<name>.<locale>.md` 配对
    generateId: ({ entry }) => entry.replace(/\.(md|mdx|markdown)$/i, ""),
  }),
  schema: z.object({
    title: z.string(),
    description: z.string().optional(),
    ogImage: z.string().optional(),
    canonicalURL: z.string().optional(),
  }),
});

export const collections = { posts, pages };
