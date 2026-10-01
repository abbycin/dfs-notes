import {
  defineConfig,
  envField,
  fontProviders,
  svgoOptimizer,
} from "astro/config";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import tailwindcss from "@tailwindcss/vite";
import mdx from "@astrojs/mdx";
import sitemap, { type SitemapItem } from "@astrojs/sitemap";
import { unified } from "@astrojs/markdown-remark";
import remarkToc from "remark-toc";
import remarkCollapse from "remark-collapse";
import rehypeCallouts from "rehype-callouts";
import {
  transformerNotationDiff,
  transformerNotationHighlight,
  transformerNotationWordHighlight,
} from "@shikijs/transformers";
import { transformerFileName } from "./src/utils/transformers/fileName";
import config from "./astro-paper.config";
import { defaultLocale, htmlLang, locales } from "./src/i18n/config.ts";

// 部署路径由环境变量控制：
//   本地开发：不设置，默认在根路径下运行
//   GitHub Pages 项目仓库：BASE_PATH=/仓库名  SITE_URL=https://<user>.github.io
//   GitHub Pages 用户主页仓库（xxx.github.io）：BASE_PATH=/  SITE_URL=https://<user>.github.io
const rawBase = process.env.BASE_PATH ?? "";
const base = rawBase === "/" ? "" : rawBase.replace(/\/+$/, "");

/**
 * markdown 正文里以 `/` 开头的链接和图片（/images/xx.png、/files/xx.pdf）
 * 指向 public/，Astro 不会自动加 base 前缀，部署到 GitHub Pages 项目页时会 404。
 * 渲染阶段（标准 hast 插件）统一补上；相对路径与外链不受影响。
 */
const rehypeBasePrefix = () => (tree: unknown) => {
  if (!base) return;
  const walk = (node: {
    type?: string;
    tagName?: string;
    properties?: Record<string, unknown>;
    children?: unknown[];
  }) => {
    if (
      node.type === "element" &&
      (node.tagName === "a" || node.tagName === "img")
    ) {
      for (const key of ["href", "src"]) {
        const value = node.properties?.[key];
        if (typeof value !== "string") continue;
        if (!value.startsWith("/") || value.startsWith("//")) continue; // 外链、锚点、相对路径
        if (value === base || value.startsWith(`${base}/`)) continue; // 已带前缀
        node.properties![key] = `${base}${value}`;
      }
    }
    node.children?.forEach(child => walk(child as typeof node));
  };
  walk(tree as Parameters<typeof walk>[0]);
};

/**
 * 找出 frontmatter 里 `unlisted: true` 的文章，它们不进 sitemap。
 * astro.config 里拿不到 astro:content，所以直接用 fs 扫一遍 frontmatter。
 * 返回值是文章 URL 中的路径片段，如 `/posts/links/`。
 */
function unlistedPostPaths(): string[] {
  const dir = path.resolve("src/content/posts");
  const suffix = new RegExp(`\\.(${locales.join("|")})$`);
  const found: string[] = [];
  const files = readdirSync(dir, { recursive: true, encoding: "utf8" });
  for (const file of files) {
    if (!/\.(md|mdx|markdown)$/i.test(file)) continue;
    const text = readFileSync(path.join(dir, file), "utf8");
    const frontmatter = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
    if (!frontmatter || !/^unlisted:\s*true\b/m.test(frontmatter[1])) continue;
    const id = file.replace(/\.(md|mdx|markdown)$/i, "").replace(suffix, "");
    found.push(`/posts/${id}/`);
  }
  return found;
}

const UNLISTED_POST_PATHS = unlistedPostPaths();
/** 根路径（Astro 未设置 base 时默认是 '/'），用路径判断，不依赖 site 的写法 */
const BASE_PATH = base || "/";
const trimmedPath = (s: string) => s.replace(/\/+$/, "");
const ROOT_PATH = trimmedPath(BASE_PATH);

export default defineConfig({
  site: config.site.url,
  ...(base ? { base } : {}),
  trailingSlash: "ignore",
  i18n: {
    locales: [...locales],
    defaultLocale,
    routing: {
      // /zh/ /en/ 都带前缀；根路径 / 由本站自己的跳转页（noindex）接管
      prefixDefaultLocale: true,
      redirectToDefaultLocale: false,
    },
  },
  integrations: [
    mdx(),
    sitemap({
      // hreflang 与页面 <head> 里的保持一致（zh-CN / en），并补上 x-default
      i18n: { defaultLocale, locales: { ...htmlLang } },
      filter: (page: string) => {
        const pathname = trimmedPath(new URL(page).pathname);
        if (pathname === ROOT_PATH) return false; // 根路径只是跳转页
        if (/\/404(\.html)?$/.test(pathname)) return false; // 404 不进 sitemap
        // 链接型文章（unlisted）不进 sitemap
        return !UNLISTED_POST_PATHS.some((suffix: string) =>
          page.includes(suffix)
        );
      },
      serialize: (item: SitemapItem) => {
        const def = item.links?.find(l => l.lang === htmlLang[defaultLocale]);
        if (def && !item.links?.some(l => l.lang === "x-default")) {
          item.links?.push({ url: def.url, lang: "x-default" });
        }
        return item;
      },
    }),
  ],
  markdown: {
    processor: unified({
      remarkPlugins: [
        remarkToc,
        [remarkCollapse, { test: "Table of contents" }],
      ],
      rehypePlugins: [rehypeCallouts, rehypeBasePrefix],
    }),
    shikiConfig: {
      themes: { light: "min-light", dark: "night-owl" },
      defaultColor: false,
      wrap: false,
      transformers: [
        transformerFileName({ style: "v2", hideDot: false }),
        transformerNotationHighlight(),
        transformerNotationWordHighlight(),
        transformerNotationDiff({ matchAlgorithm: "v3" }),
      ],
    },
  },
  vite: {
    plugins: [tailwindcss()],
  },
  fonts: [
    {
      name: "Google Sans Code",
      cssVariable: "--font-google-sans-code",
      // 字体文件随仓库分发（src/assets/fonts/，来自 fontsource 的 woff2），
      // dev / build / CI 全程零网络依赖——沙箱与内网环境也能直接跑
      provider: fontProviders.local(),
      fallbacks: ["monospace"],
      options: {
        variants: [
          { src: ["./src/assets/fonts/google-sans-code-latin-300-normal.woff2"], weight: 300, style: "normal" },
          { src: ["./src/assets/fonts/google-sans-code-latin-300-italic.woff2"], weight: 300, style: "italic" },
          { src: ["./src/assets/fonts/google-sans-code-latin-400-normal.woff2"], weight: 400, style: "normal" },
          { src: ["./src/assets/fonts/google-sans-code-latin-400-italic.woff2"], weight: 400, style: "italic" },
          { src: ["./src/assets/fonts/google-sans-code-latin-500-normal.woff2"], weight: 500, style: "normal" },
          { src: ["./src/assets/fonts/google-sans-code-latin-500-italic.woff2"], weight: 500, style: "italic" },
          { src: ["./src/assets/fonts/google-sans-code-latin-600-normal.woff2"], weight: 600, style: "normal" },
          { src: ["./src/assets/fonts/google-sans-code-latin-600-italic.woff2"], weight: 600, style: "italic" },
          { src: ["./src/assets/fonts/google-sans-code-latin-700-normal.woff2"], weight: 700, style: "normal" },
          { src: ["./src/assets/fonts/google-sans-code-latin-700-italic.woff2"], weight: 700, style: "italic" },
        ],
      },
    },
  ],
  env: {
    schema: {
      PUBLIC_GOOGLE_SITE_VERIFICATION: envField.string({
        access: "public",
        context: "client",
        optional: true,
      }),
    },
  },
  experimental: {
    svgOptimizer: svgoOptimizer(),
  },
});
