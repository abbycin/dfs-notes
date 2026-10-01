/**
 * Giscus 评论配置
 *
 * 官方三个前提（见 https://giscus.app/ 的 Repository 一节）：
 *   1. 仓库必须是 **公开** 的，否则访客看不到讨论 —— giscus 的硬性要求。
 *      GitHub Discussions 本身支持私有仓库，但 giscus 托管服务只支持公开仓库。
 *   2. 已安装 giscus GitHub App，否则访客无法评论与表态。
 *   3. 仓库已开启 Discussions。
 *
 * 源码仓库必须私有时：repo 可以指向另一个专门存评论的公开仓库，
 * giscus 只按 pathname 匹配页面，不校验站点源码所在的仓库。
 *
 * 获取步骤：
 *   1. 打开 https://giscus.app/zh-CN
 *   2. 按顺序选择：仓库（需开启 Discussions）、页面映射、分类、语言
 *   3. 把下方生成的 data-* 值复制进来，repo / repoId / category / categoryId 填好即可启用
 *
 * 仓库还没准备好时保持 repo 为空，评论区会自动隐藏（不会报错）。
 */
export const giscus = {
  /** 例：'your-name/dfs-notes'（必须是 **公开** 且开启了 Discussions 的仓库） */
  repo: '',
  repoId: '',

  /** 例：'Announcements' */
  category: '',
  categoryId: '',

  /** 页面映射方式，一般用 pathname */
  mapping: 'pathname',
  strict: '0',
  reactionsEnabled: '1',
  emitMetadata: '0',
  inputPosition: 'top' as 'top' | 'bottom',
  /** 'preferred_color_scheme' 会跟随系统；也可用 'light' / 'dark' / 高对比度主题名 */
  theme: 'preferred_color_scheme',
  loading: 'lazy',
};

/** 四个必填项齐了才加载脚本 */
export const giscusEnabled = Boolean(giscus.repo && giscus.repoId && giscus.category && giscus.categoryId);
