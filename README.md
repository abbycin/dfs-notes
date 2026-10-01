# dfs-notes

基于 [Astro](https://astro.build) + [AstroPaper](https://github.com/satnaing/astro-paper) v6 主题的中英双语静态博客，内置 Pagefind 搜索、Giscus 评论与 GitHub Pages 自动部署。

在 AstroPaper 原有能力（深浅色、归档、标签、RSS、无障碍、响应式）之上，本站扩展了：

- **双语路由**：`/zh/`（默认）与 `/en/`，根路径 `/` 自动跳转；同名文件互为翻译；
- **链接型文章**：外部链接跳转按钮、不进列表、导航栏入口（如「链接」页）；
- **SEO 套件**：hreflang（head + sitemap + x-default）、canonical、每语言 RSS、JSON-LD、双语 og 卡片、404/根跳转 noindex；
- **Giscus 评论**（占位配置，参数填齐即启用）。

## 快速开始

```bash
npm install
npm run dev      # http://localhost:4321/zh/
npm run build    # 检查 + 构建 + Pagefind 索引，输出到 dist/
npm run preview  # 预览构建结果
npm run check    # 类型 / 模板检查
npm run og:generate  # 重新生成双语分享卡片图
```

> UI 字体（Google Sans Code）随仓库分发在 `src/assets/fonts/`（woff2，约 144K），
> dev / build / CI 全程零网络依赖；换字体时替换该目录并在 `astro.config.ts` 的
> `fonts` 里改 `options.variants` 即可。

## 目录结构

```
.
├── astro.config.ts             # i18n 路由 / site / base（环境变量驱动）/ sitemap / markdown
├── astro-paper.config.ts       # 站点名、简介、作者、社交链接、主题功能开关
├── src/
│   ├── config.ts               # 配置解析与默认值（一般不用改）
│   ├── content.config.ts       # 内容集合 schema（含链接型文章字段）
│   ├── content/
│   │   ├── posts/              # 文章：<slug>.zh.md / <slug>.en.md
│   │   └── pages/              # 关于页等静态内容（about.<locale>.md）
│   ├── i18n/
│   │   ├── config.ts           # 语言列表、html lang、og:locale、Giscus 语言
│   │   ├── index.ts            # useTranslations()
│   │   └── lang/               # 界面文案：zh.ts / en.ts（含站点名与简介）
│   ├── config/giscus.ts        # Giscus 评论参数（待填）
│   ├── layouts/                # Layout.astro（SEO 收口）/ PostLayout.astro
│   ├── components/             # Header / Footer / Card / Giscus / LanguageSwitcher ...
│   ├── pages/
│   │   ├── index.astro         # / → /zh/（noindex 跳转页）
│   │   ├── 404.astro           # noindex
│   │   ├── robots.txt.ts
│   │   └── [locale]/
│   │       ├── index.astro     # /zh/ /en/ 首页
│   │       ├── posts/          # 列表（分页）与详情
│   │       ├── tags/           # 标签索引与标签页
│   │       ├── archives/       # 按时间归档
│   │       ├── search/         # Pagefind 搜索
│   │       ├── about.astro     # 关于页
│   │       └── rss.xml.ts      # /zh/rss.xml、/en/rss.xml
│   └── utils/
│       ├── postLocale.ts       # 语言配对、列表过滤、导航文章
│       ├── getPostPaths.ts     # 文章 URL（语言后缀不进 URL）
│       └── ...
├── scripts/generate-og.mjs     # 生成分享卡片图（npm run og:generate）
├── public/images/og-<locale>.png  # og:image，1200×630
└── .github/workflows/deploy.yml
```

## 写文章

1. 在 `src/content/posts/` 新建文件，命名 **`<slug>.<locale>.md`**：

   ```
   my-post.zh.md   # 中文
   my-post.en.md   # 英文（同 slug 即互为翻译）
   ```

   同一个 `slug` 会自动配对：文章页的 hreflang、语言切换器都会指向对方。
   只写一种语言也可以，切换器会把缺失的语言显示为不可用。
   URL 不含语言后缀：`my-post.zh.md` → `/zh/posts/my-post/`。

2. Frontmatter：

   ```yaml
   ---
   title: 标题
   description: 一句话摘要（必填，用于列表与 SEO）
   pubDatetime: 2026-09-28      # 必填
   modDatetime: 2026-09-29      # 可选，更新时间（会进 article:modified_time）
   tags: [Astro, 教程]
   draft: false                 # true 则不发布
   featured: false              # 可选，首页「精选」区
   ogImage: /images/cover.png   # 可选，该文专属分享卡片图

   # 以下三个为可选，用于「链接型文章」：
   externalUrl: https://github.com/abbycin/mace  # 详情页顶部显示跳转按钮
   unlisted: true             # 不进首页 / 文章列表 / 标签 / 归档 / 上下篇 / sitemap
   nav: true                  # 把本文标题作为导航栏入口
   ---
   ```

3. **链接型文章**：`src/content/posts/links.zh.md` 与 `links.en.md` 是现成示例。
   三个字段可以任意组合：

   | 字段 | 作用 |
   | --- | --- |
   | `externalUrl` | 详情页顶部出现醒目的「前往外部链接」按钮，并显示目标域名；导航栏入口带 ↗ 图标 |
   | `unlisted: true` | 从各处列表与 sitemap 隐藏，只能通过直接访问或导航栏进入；详情页仍会生成 |
   | `nav: true` | 文章标题出现在导航栏（语言版本各自的标题，天然双语） |

   想再加一条：复制 `links.zh.md` / `links.en.md` 改个文件名和 `externalUrl` 即可。

4. 新增语言：
   1. `src/i18n/config.ts`：`locales` 加一项，并补 `localeNames` / `htmlLang` / `ogLocale` / `giscusLang`；
   2. 新建 `src/i18n/lang/<locale>.ts`（复制 en.ts 翻译，含 `site` 段的站点名与简介）。

## 图片与附件

### 图片：和文章放一起，用相对路径（推荐）

```text
src/content/posts/
├── my-post.zh.md
├── my-post.en.md
└── my-post-cover.png     ← 图片和文章同目录
```

```md
![架构图](./my-post-cover.png)
```

Astro 会自动处理：压缩并转 WebP、文件名加哈希（可长缓存）、补齐
`width`/`height`（防止图片加载时页面抖动），并自动带上部署路径前缀。
中英两篇文章可以共用同一张图，也可以各自配一张。

### 附件（PDF / zip 等）：放 `public/`

```text
public/
├── images/    # 不想跟着文章走的图片（og-*.png 也在这里）
└── files/     # PDF、zip 等附件
```

正文里写以 `/` 开头的绝对路径：

```md
[下载设计文档](/files/design.pdf)
![示意图](/images/flow.png)
```

`astro.config.ts` 里的 rehype 插件（`rehypeBasePrefix`）会在渲染阶段给这类
路径补上 `base` 前缀，所以本地和 GitHub Pages 项目页都能正常访问——
**不要**自己把仓库名写进路径（`/dfs-notes/files/design.pdf` 在本地反而 404）。

### 一句话总结

| 文件 | 放哪儿 | 正文怎么写 | 会自动处理 |
| --- | --- | --- | --- |
| 文章配图 | `src/content/posts/` | `![x](./a.png)` | 压缩、哈希、宽高、base |
| 独立图片 / 附件 | `public/images/`、`public/files/` | `/images/a.png`、`/files/a.pdf` | 只补 base |

## 配置 Giscus

> **仓库必须是公开的** —— 这是 giscus 官方要求（"The repository is public,
> otherwise visitors will not be able to view the discussion"）。
> GitHub Discussions 本身支持私有仓库，但 giscus 托管服务只支持公开仓库。
> 若源码仓库必须私有，可以把 `repo` 指向另一个专门存评论的公开仓库：
> giscus 只按 pathname 匹配页面，不校验站点源码所在的仓库。

1. 仓库 **Settings → General → Features** 勾选 **Discussions**（仓库需为公开）；
2. 打开 <https://giscus.app/zh-CN>，依次选好仓库、页面映射（一般选 `pathname`）、分类、语言；
3. 把生成的值填进 `src/config/giscus.ts`：

   ```ts
   export const giscus = {
     repo: 'your-name/dfs-notes',
     repoId: 'R_xxx',
     category: 'Announcements',
     categoryId: 'DIC_xxx',
     ...
   };
   ```

四项都填了才会加载评论脚本，留空时页面正常、只是不显示评论区。

## 部署到 GitHub Pages

1. 推送仓库到 GitHub（默认分支 `master`，日常写作与部署在 `dev` 分支）；
2. 仓库 **Settings → Pages → Build and deployment** 中，**Source** 选 **GitHub Actions**；
3. push 到 `dev` 会自动构建并发布（`.github/workflows/deploy.yml` 只监听 `dev`，不监听 `master`）：
   - 自定义域名 `db.o2c.fun` → 挂在域名根路径（`BASE_PATH=/`，产物无前缀）
   - 如需回退 github.io 项目页（`https://<user>.github.io/<repo>/`），把 workflow 里
     `BASE_PATH` 改回 `/<仓库名>`、`SITE_URL` 改回 `https://<user>.github.io`

   `SITE_URL` 与 `BASE_PATH` 在 workflow 里固定设置；本地不设置时按根路径构建，
   站点地址取 `astro-paper.config.ts` 的 `site.url`（默认 `https://db.o2c.fun`）。
   构建包含 Pagefind 索引步骤，搜索开箱即用。

   **分支与贡献图**：GitHub 贡献图只统计默认分支（`master`）的提交，`dev` 上的
   日常提交不会出现在活动日历。要把发布内容同步回 `master` 时用
   `git merge --squash dev` 生成单个提交后再提交（普通 `git merge` 会让 dev 的
   全部提交进入默认分支并被回头计账）。

4. 本地想覆盖站点地址（用于 canonical / og:url）：

   ```bash
   SITE_URL=http://localhost:4321 npm run build
   ```

## SEO 与收录

### 已经内置的东西

| 能力 | 位置 |
| --- | --- |
| `sitemap-index.xml`（含 hreflang + x-default；自动排除 unlisted 文章、404、根跳转页） | `astro.config.ts` → `sitemap()` |
| `robots.txt`（声明 sitemap 地址） | `src/pages/robots.txt.ts` |
| 每页唯一的 title / description / canonical / hreflang / og:\* / twitter:\* | `src/layouts/Layout.astro` |
| hreflang 只输出真实存在的翻译（缺翻译不指向 404） | 文章页传 `alternates`（`getTranslationEntries`） |
| 结构化数据 JSON-LD：首页 `Blog`，文章 `BlogPosting` + `BreadcrumbList` | `Layout.astro` / `PostLayout.astro` |
| RSS 订阅源：`/zh/rss.xml`、`/en/rss.xml` | `src/pages/[locale]/rss.xml.ts` |
| 分享卡片图 og:image（1200×630，按语言各一张） | `public/images/og-<locale>.png` |
| 404 与根跳转页 `noindex`（同时不输出 canonical / hreflang，避免信号冲突） | `src/pages/404.astro`、`src/pages/index.astro` |
| 文章必须写 `description`（构建期强制，保证 meta 不重复） | `src/content.config.ts` |
| 文章 frontmatter 的 `ogImage` 作为该文的 og:image | `src/content.config.ts` |
| Pagefind 站内搜索（中文分词按语言分片） | 构建脚本 + `src/pages/[locale]/search.astro` |

> 动态 OG（satori 渲染）已关闭：中文字体子集选择复杂，改用静态双语卡片。
> 需要时在 `astro-paper.config.ts` 打开 `dynamicOgImage` 并恢复对应路由即可。

改了站点名 / 简介 / 作者后，重新生成分享卡片图：

```bash
npm run og:generate
```

### 让 Google 收录（Search Console 就是它）

1. 部署完成后打开 <https://search.google.com/search-console> → **添加资源** → 选 **网址前缀**，填
   `https://<user>.github.io/<repo>/`。
   > 用 github.io 时只能选「网址前缀」：域名资源类型需要在 DNS 里加 TXT 记录，而 `github.io` 不归你管。
2. 验证方式选 **HTML 标记**，把 `<meta name="google-site-verification" ...>` 里的令牌填进
   `astro-paper.config.ts` 的 `site.googleVerification`（或环境变量 `PUBLIC_GOOGLE_SITE_VERIFICATION`），
   推送部署后再回去点「验证」。
3. 验证通过后，左侧 **站点地图** → 提交 `sitemap-index.xml`。
4. **网址检查** → 粘贴重要页面 → **请求编入索引**（新站可以先手动请求几个核心页面）。
5. Bing 可用同一个标签：Bing Webmaster Tools 支持直接导入 Google Search Console。

## 常用改动

| 想改什么 | 改哪里 |
| --- | --- |
| 站点名、简介、作者、社交链接、功能开关 | `astro-paper.config.ts`（站点名/简介按语言在 `src/i18n/lang/*.ts` 的 `site` 段） |
| 导航栏额外入口（链接型文章） | 文章 frontmatter 加 `nav: true` |
| 导航、按钮等界面文字 | `src/i18n/lang/zh.ts` / `en.ts` |
| 语言列表与默认语言 | `src/i18n/config.ts` |
| 深浅色配色 | `src/styles/theme.css` |
| 每页文章数、精选区数量 | `astro-paper.config.ts` → `posts.perPage` / `perIndex` |
| 语法高亮主题 | `astro.config.ts` → `markdown.shikiConfig` |
| UI 字体 | `src/assets/fonts/`（woff2 入库）+ `astro.config.ts` → `fonts` |
| Google 验证令牌 | `astro-paper.config.ts` → `site.googleVerification` |
| sitemap 排除规则（哪些页面不进） | `astro.config.ts` → `sitemap({ filter })` |
| 分享卡片图 | `scripts/generate-og.mjs` + `npm run og:generate` |
| 日期显示格式（中文为「2026年9月30日」） | `src/components/Datetime.astro` |
