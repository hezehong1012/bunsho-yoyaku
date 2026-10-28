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
  const a = s.indexOf('{');
  const b = s.lastIndexOf('}');
  if (a >= 0 && b > a) s = s.slice(a, b + 1);
  return JSON.parse(s);
}

// ---- 無料の判定モデル Ateve Jev（ateve-jev-v1）による前置フィルタ ----
//   JEV_API_KEY（未設定なら無効＝常に放行）/ JEV_API_URL / JEV_MODEL / JEV_ENABLED / JEV_BLOCK_PROB
// 失敗・タイムアウト時は必ず放行（fail-open）。通常の要約・抽出は壊さない。
const JEV_TIMEOUT_MS = 2500;

function jevConfigured() {
  if (process.env.JEV_ENABLED === '0' || process.env.JEV_ENABLED === 'false') return false;
  return !!(process.env.JEV_API_KEY || process.env.GATEWAY_API_KEY);
}

function extractProb(data, key) {
  const node = data?.answers?.[key] ?? data?.questions?.[key] ?? data?.[key];
  if (node == null) return 0;
  if (typeof node === 'number') return clamp01(node);
  if (typeof node === 'boolean') return node ? 1 : 0;
  if (typeof node === 'string') return clamp01(stringToProb(node));

  // オブジェクト形: { type:'noul', noul:0.96 } / { probability|prob|score|confidence|answer|value }
  // 実績フィールド名を優先し、その中から [0,1] の数値（または真偽/文字列）を取る。
  const PRIORITY = [
    node.type,                 // 'noul' / 'choice' / 'score' 等の型名キー（実API: noul）
    'noul', 'probability', 'prob', 'score', 'confidence', 'answer', 'value', 'choice', 'result'
  ].filter(Boolean);

  for (const k of PRIORITY) {
    if (k in node && k !== 'type') {
      const v = node[k];
      const p = toProb(v);
      if (p != null) return clamp01(p);
    }
  }
  // フォールバック: オブジェクト内の最初の [0,1] 数値（'type' のような文字列キーは除外）
  for (const [k, v] of Object.entries(node)) {
    if (k === 'type' || typeof v === 'string') continue;
    const p = toProb(v);
    if (p != null) return clamp01(p);
  }
  return 0;
}

function clamp01(n) {
  const x = Number(n);
  if (!Number.isFinite(x)) return 0;
  return Math.max(0, Math.min(1, x > 1 ? x / 100 : x));
}
function stringToProb(s) {
  const t = String(s).trim();
  const n = Number(t);
  if (!Number.isNaN(n)) return n;
  if (/^(true|yes|はい|該当|スパム|ゴミ)/i.test(t)) return 1;
  if (/^(false|no|いいえ)/i.test(t)) return 0;
  return null;
}
function toProb(v) {
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (typeof v === 'number') return v;
  if (typeof v === 'string') return stringToProb(v);
  return null;
}

export async function jevGuard(rawText) {
  if (!jevConfigured()) return { blocked: false };
  const preview = rawText.replace(URL_RE, ' ').replace(/\s+/g, ' ').trim().slice(0, 1500);
  if (!preview) return { blocked: false };

  const endpoint = process.env.JEV_API_URL || 'https://tokendance.space/gateway/typesafe/v1/systemone';
  const key = process.env.JEV_API_KEY || process.env.GATEWAY_API_KEY;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), JEV_TIMEOUT_MS);

  try {
    const r = await fetch(endpoint, {
      method: 'POST',
      signal: controller.signal,
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
      body: JSON.stringify({
        model: process.env.JEV_MODEL || 'ateve-jev-v1',
        state: `これは「AI要約/情報抽出ツール」にユーザーが入力したテキストです。\n\n${preview}`,
        questions: {
          is_spam_or_garbage: {
            type: 'noul',
            instructions: 'Is this input spam, gibberish, random repeated characters, pure punctuation, advertising, abuse, or otherwise NOT meaningful text a real person would want summarized or have fields extracted from? Return true ONLY when clearly junk/abuse. Short-but-meaningful notes, code, a URL with real context, and non-English (including Japanese) text must be false.'
          }
        }
      })
    });
    if (!r.ok) return { blocked: false };
    const data = await r.json().catch(() => null);
    const prob = extractProb(data, 'is_spam_or_garbage');
    const t = Number(process.env.JEV_BLOCK_PROB);
    const threshold = Number.isFinite(t) && t > 0 && t <= 1 ? t : 0.8;
    return { blocked: prob >= threshold, prob };
  } catch {
    return { blocked: false };
  } finally {
    clearTimeout(timer);
  }
}
