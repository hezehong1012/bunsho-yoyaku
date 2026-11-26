#!/usr/bin/env node
/**
 * IndexNow 全量/增量提交脚本（bunsho-yoyaku.com）
 *
 * IndexNow 是 Bing / Yandex / Seznam / Naver 等引擎共用的即时收录协议。
 * key 文件 <KEY>.txt 已部署在站点根目录，内容即 key 本身（keyLocation 校验用）。
 *
 * 用法：
 *   node scripts/indexnow-submit.mjs              # 提交 sitemap.xml 全部 URL（每次发布后运行）
 *   node scripts/indexnow-submit.mjs url1 url2…   # 只提交指定 URL（单页更新时）
 *
 * 频率建议：同一 URL 每天最多提交 1 次，避免被判定滥用。
 */
import { readFileSync, existsSync } from 'node:fs';
import { resolve, basename } from 'node:path';

const SITE = 'https://bunsho-yoyaku.com';
const HOST = 'bunsho-yoyaku.com';

const KEY_FILE = resolve('67cd6204a465ab4fe3fa2ae986eb0c0f.txt');
if (!existsSync(KEY_FILE)) {
  console.error('key 文件不存在，先确认 67cd6204a465ab4fe3fa2ae986eb0c0f.txt 在仓库根目录。');
  process.exit(1);
}
const key = readFileSync(KEY_FILE, 'utf8').trim();

const args = process.argv.slice(2);
let urls = [];
if (args.length > 0) {
  urls = args.map((u) => (u.startsWith('http') ? u : SITE + (u.startsWith('/') ? u : '/' + u)));
} else {
  const sm = resolve('sitemap.xml');
  if (!existsSync(sm)) {
    console.error('sitemap.xml 不存在，无法提取 URL。');
    process.exit(1);
  }
  const xml = readFileSync(sm, 'utf8');
  urls = [...xml.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]);
}

if (urls.length === 0) {
  console.error('没有可提交的 URL');
  process.exit(1);
}

const chunks = [];
for (let i = 0; i < urls.length; i += 10000) chunks.push(urls.slice(i, i + 10000));

console.log(`提交 ${urls.length} 个 URL 到 IndexNow（key ${key.slice(0, 8)}…）`);

for (const [i, chunk] of chunks.entries()) {
  const res = await fetch('https://api.indexnow.org/IndexNow', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'User-Agent': 'Mozilla/5.0 (compatible; indexnow-submit/1.0)',
    },
    body: JSON.stringify({
      host: HOST,
      key,
      keyLocation: `${SITE}/${basename(KEY_FILE)}`,
      urlList: chunk,
    }),
  });
  const ok = res.status === 200 || res.status === 202;
  console.log(
    `批次 ${i + 1}: HTTP ${res.status} ${ok ? '✓ 已受理' : '(400=key/域不匹配 422=URL 超限 429=过频)'}`
  );
}
