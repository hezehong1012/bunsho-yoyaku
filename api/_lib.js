// 共通ヘルパー：URL検出・Webフェッチ・LLM呼び出し
// 環境変数:
//   LLM_API_URL / LLM_API_KEY / LLM_MODEL（要約・抽出に使うLLM、既定DeepSeek）
//   FETCH_API_URL / FETCH_API_KEY（Webページ取得ゲートウェイ）

export const MAX_CHARS = 5000;
export const MIN_CHARS = 50;
export const FETCHED_MAX_CHARS = 12000; // 取得したWeb本文の利用上限

const URL_RE = /https?:\/\/[^\s<>"'，。、）)】\]]+/g;

export function extractUrls(text) {
  const m = text.match(URL_RE) || [];
  return [...new Set(m)].slice(0, 3); // 最大3件
}

export function clientIp(req) {
  const xff = req.headers['x-forwarded-for'];
  if (typeof xff === 'string' && xff.length) return xff.split(',')[0].trim();
  return req.socket?.remoteAddress || 'unknown';
}

// ゲートウェイのレスポンスから本文らしい文字列を頑張って取り出す
function pickContent(data) {
  if (typeof data === 'string') return data;
  if (!data || typeof data !== 'object') return '';
  const direct = [
    data.content, data.text, data.markdown, data.result,
    data.data?.content, data.data?.text, data.data?.markdown, data.data?.result
  ];
  for (const v of direct) {
    if (typeof v === 'string' && v.trim()) return v;
    if (v && typeof v === 'object') {
      const inner = v.content || v.text || v.markdown || v.result;
      if (typeof inner === 'string' && inner.trim()) return inner;
    }
  }
  if (Array.isArray(data.results)) {
    return data.results.map((r) => r.content || r.text || r.markdown || '').filter(Boolean).join('\n\n');
  }
  try { return JSON.stringify(data); } catch { return ''; }
}

export async function fetchWebPage(url) {
  const endpoint =
    process.env.FETCH_API_URL ||
    'https://tokendance.space/gateway/deepseek/v1/tools/fetch';
  const key = process.env.FETCH_API_KEY || process.env.GATEWAY_API_KEY;
  if (!key) throw new Error('FETCH_NO_KEY');

  const r = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${key}`
    },
    body: JSON.stringify({ url })
  });
  if (!r.ok) throw new Error('FETCH_HTTP_' + r.status);
  const data = await r.json().catch(() => null);
  let content = pickContent(data).trim();
  if (content.length > FETCHED_MAX_CHARS) content = content.slice(0, FETCHED_MAX_CHARS);
  return { url, content };
}

// 入力にURLが含まれる場合、本文を取得して要約素材を組み立てる
export async function resolveSourceText(rawText) {
  const urls = extractUrls(rawText);
  if (!urls.length) return { text: rawText, fetched: [] };

  const parts = [];
  const fetched = [];
  const nonUrl = rawText.replace(URL_RE, '').trim();
  if (nonUrl) parts.push('【ユーザー入力の補足】\n' + nonUrl);

  for (const u of urls) {
    // eslint-disable-next-line no-await-in-loop
    const page = await fetchWebPage(u);
    fetched.push({ url: u, ok: true, length: page.content.length });
    parts.push(`【Webページ: ${u}】\n${page.content}`);
  }
  return { text: parts.join('\n\n'), fetched };
}

export async function callLlm(system, prompt, { maxTokens = 1600, temperature = 0.2 } = {}) {
  const apiUrl = process.env.LLM_API_URL || 'https://api.deepseek.com/v1/chat/completions';
  const apiKey = process.env.LLM_API_KEY;
  if (!apiKey) throw new Error('LLM_NO_KEY');

  const r = await fetch(apiUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`
    },
    body: JSON.stringify({
      model: process.env.LLM_MODEL || 'deepseek-chat',
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: prompt }
      ],
      temperature,
      max_tokens: maxTokens
    })
  });
  if (!r.ok) throw new Error('LLM_HTTP_' + r.status);
  const data = await r.json();
  const out = data.choices?.[0]?.message?.content?.trim();
  if (!out) throw new Error('LLM_EMPTY');
  return out;
}

export function jsonFromMarkdown(raw) {
  let s = raw.trim();
  s = s.replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
  // 最初の { から最後の } まで
  const a = s.indexOf('{');
  const b = s.lastIndexOf('}');
  if (a >= 0 && b > a) s = s.slice(a, b + 1);
  return JSON.parse(s);
}
