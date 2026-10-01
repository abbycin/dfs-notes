#!/usr/bin/env node
/**
 * 生成社交分享 / SEO 卡片图：public/images/og-<locale>.png（1200x630）
 *
 * 改了 i18n 语言文件里的站点名/简介（src/i18n/lang/*.ts 的 site 段）
 * 或 astro-paper.config.ts 里的作者后重跑：
 *   npm run og:generate
 *
 * 也可以直接把这两张 PNG 换成自己设计的图，尺寸保持 1200x630 即可。
 */
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import zh from '../src/i18n/lang/zh.ts';
import en from '../src/i18n/lang/en.ts';
import appConfig from '../astro-paper.config.ts';

// 站点名与简介按语言取自 UI 文案（与页面 <title>、og:site_name 同源）
const siteConfig = {
  name: { zh: zh.site.title, en: en.site.title },
  description: { zh: zh.site.description, en: en.site.description },
  author: appConfig.site.author,
};

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT_DIR = path.join(root, 'public/images');
const WIDTH = 1200;
const HEIGHT = 630;

const FONTS = {
  zh: "'Source Han Sans CN','Noto Sans CJK SC','Microsoft YaHei',sans-serif",
  en: "'Roboto','DejaVu Sans','Helvetica Neue',sans-serif",
};

/** 粗略估算字符串在给定字号下的像素宽度（CJK 约 1em，拉丁约 0.55em） */
function textWidth(text, size) {
  let units = 0;
  for (const ch of text) units += /[㐀-鿿＀-￯]/.test(ch) ? 1 : 0.55;
  return units * size;
}

/** 在 maxWidth 内自适应字号，区间 [min, max] */
function fitFontSize(text, max, min, maxWidth) {
  const ideal = textWidth(text, max);
  if (ideal <= maxWidth) return max;
  return Math.max(min, Math.floor((max * maxWidth) / ideal));
}

const esc = (s) =>
  s.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');

function buildSvg(locale) {
  const name = siteConfig.name[locale];
  const desc = siteConfig.description[locale];
  const author = siteConfig.author;
  const contentWidth = WIDTH - 96 * 2;

  const nameSize = fitFontSize(name, 80, 44, contentWidth);
  const descSize = fitFontSize(desc, 38, 24, contentWidth);
  const nameY = 300;
  const descY = nameY + nameSize * 0.9;

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${HEIGHT}" viewBox="0 0 ${WIDTH} ${HEIGHT}">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="#0b1220"/>
      <stop offset="55%" stop-color="#0f2440"/>
      <stop offset="100%" stop-color="#1d4ed8"/>
    </linearGradient>
    <radialGradient id="glow" cx="0.82" cy="0.12" r="0.65">
      <stop offset="0%" stop-color="#38bdf8" stop-opacity="0.42"/>
      <stop offset="100%" stop-color="#38bdf8" stop-opacity="0"/>
    </radialGradient>
    <radialGradient id="glow2" cx="0.05" cy="0.95" r="0.55">
      <stop offset="0%" stop-color="#818cf8" stop-opacity="0.30"/>
      <stop offset="100%" stop-color="#818cf8" stop-opacity="0"/>
    </radialGradient>
  </defs>
  <rect width="${WIDTH}" height="${HEIGHT}" fill="url(#bg)"/>
  <rect width="${WIDTH}" height="${HEIGHT}" fill="url(#glow)"/>
  <rect width="${WIDTH}" height="${HEIGHT}" fill="url(#glow2)"/>
  <rect x="48" y="48" width="${WIDTH - 96}" height="${HEIGHT - 96}" rx="28"
        fill="none" stroke="rgba(255,255,255,0.14)" stroke-width="2"/>
  <rect x="96" y="176" width="72" height="6" rx="3" fill="#38bdf8"/>
  <text x="96" y="${nameY}" font-family="${FONTS[locale]}" font-size="${nameSize}"
        font-weight="700" fill="#ffffff">${esc(name)}</text>
  <text x="96" y="${descY}" font-family="${FONTS[locale]}" font-size="${descSize}"
        fill="rgba(226,232,240,0.82)">${esc(desc)}</text>
  <text x="96" y="${HEIGHT - 96}" font-family="monospace" font-size="26"
        letter-spacing="6" fill="rgba(125,211,252,0.9)">${esc(author.toUpperCase())}</text>
</svg>`;
}

await mkdir(OUT_DIR, { recursive: true });

for (const locale of Object.keys(siteConfig.name)) {
  const svg = buildSvg(locale);
  const out = path.join(OUT_DIR, `og-${locale}.png`);
  await sharp(Buffer.from(svg)).png({ compressionLevel: 9 }).toFile(out);
  console.log(`✓ ${path.relative(root, out)}`);
}
