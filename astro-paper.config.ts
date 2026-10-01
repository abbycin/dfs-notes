import { defineAstroPaperConfig } from "./src/types/config.ts";

export default defineAstroPaperConfig({
  site: {
    // SITE_URL 环境变量优先（GitHub Pages workflow 注入），否则用本地默认值
    url: process.env.SITE_URL || "https://db.o2c.fun",
    title: "dfs-notes",
    description: "mace 与 btree-store 的设计与实现、版本发布与踩坑记录",
    author: "AbbyCin",
    profile: "https://github.com/abbycin",
    ogImage: "default-og.jpg",
    lang: "zh",
    timezone: "Asia/Shanghai",
    dir: "ltr",
  },
  posts: {
    perPage: 10,
    perIndex: 5,
    scheduledPostMargin: 15 * 60 * 1000,
  },
  features: {
    lightAndDarkMode: true,
    // 动态 OG 需要 satori 渲染中文标题，中文字体子集选择复杂，
    // 本站改用静态双语卡片（scripts/generate-og.mjs 生成 og-zh/og-en.png）。
    dynamicOgImage: false,
    showArchives: true,
    showBackButton: true,
    editPost: {
      enabled: true,
      url: "https://github.com/abbycin/dfs-notes/edit/master/",
    },
    search: "pagefind",
  },
  socials: [{ name: "github", url: "https://github.com/abbycin" }],
  shareLinks: [],
});
