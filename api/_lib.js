// 共通ヘルパー：URL検出・Webフェッチ・LLM呼び出し
// 環境変数:
//   LLM_API_URL / LLM_API_KEY / LLM_MODEL（要約・抽出に使うLLM、既定DeepSeek）
//   FETCH_API_URL / FETCH_API_KEY（Webページ取得ゲートウェイ、直連失敗時のフォールバック）
//   FETCH_TIMEOUT_MS（1ページあたりのタイムアウト、既定20000）

import { createHash } from 'node:crypto';

export const MAX_CHARS = 5000;
export const MIN_CHARS = 50;
// 要約APIのみ上限を拡張（内部で分割要約→統合する）
export const SUMMARIZE_MAX_CHARS = 15000;
export const CHUNK_CHARS = 8000; // 1回のLLM呼び出しで扱う本文の目安（これ以下は分割せずに要約）
export const FETCHED_MAX_CHARS = 12000; // 取得したWeb本文の利用上限

const URL_RE = /https?:\/\/[^\s<>"'，。、）)】\]]+/g;

export function extractUrls(text) {
  const m = text.match(URL_RE) || [];
  return [...new Set(m)].slice(0, 3); // 最大3件
}

// 長文を分割して要約するための分割ヘルパー（段落→改行→句点の順に自然な位置で切る）
export function splitIntoChunks(text, size = CHUNK_CHARS) {
  const chunks = [];
  let rest = String(text || '').trim();
  while (rest.length > size) {
    let cut = rest.lastIndexOf('\n\n', size);
    if (cut < size * 0.5) cut = rest.lastIndexOf('\n', size);
    if (cut < size * 0.5) cut = rest.lastIndexOf('。', size);
    if (cut < size * 0.5) cut = size - 1;
    chunks.push(rest.slice(0, cut + 1).trim());
    rest = rest.slice(cut + 1).trim();
  }
  if (rest) chunks.push(rest);
  return chunks;
}

// ---- 溯源用：本文を番号付きセグメントに分割し、文字オフセットを保持する ----
// 字幕は行単位が基本。長い行だけ句読点でさらに切る。決定論的・単体テスト可能。
export const SEGMENT_LINE_MAX = 600;

export function buildSegments(text) {
  const src = String(text || '');
  const segs = [];
  let lineStart = 0;
  const lines = src.split('\n');
  // オフセットはトリム後の実際の文字位置を指す（前後の空白は span から除く）
  const push = (start, end) => {
    const raw = src.slice(start, end);
    const lead = raw.match(/^\s*/)[0].length;
    const trail = raw.match(/\s*$/)[0].length;
    const tStart = start + lead;
    const tEnd = end - trail;
    if (tEnd <= tStart) return;
    segs.push({ id: segs.length + 1, text: src.slice(tStart, tEnd), start: tStart, end: tEnd });
  };
  for (const line of lines) {
    const absStart = lineStart;
    const absEnd = lineStart + line.length;
    lineStart = absEnd + 1;
    if (!line.trim()) continue;
    if (line.length <= SEGMENT_LINE_MAX) {
      push(absStart, absEnd);
      continue;
    }
    // 長い行：文の区切りで分割し、SEGMENT_LINE_MAX を超えない範囲でまとめる
    const re = /[^.!?。！？]+[.!?。！？]?/g;
    let m;
    let bufRelStart = 0;
    let bufLen = 0;
    while ((m = re.exec(line)) !== null) {
      if (bufLen && bufLen + m[0].length > SEGMENT_LINE_MAX) {
        push(absStart + bufRelStart, absStart + m.index);
        bufRelStart = m.index;
        bufLen = 0;
      }
      bufLen += m[0].length;
    }
    if (bufLen) push(absStart + bufRelStart, absEnd);
  }
  return segs;
}

// ---- 说话人维度：从 "Name: ..." 前缀解析发言人（确定性、可单测）----
// 仅接受模型确认的参与者名，避免把 "Agenda:" / "NOTE:" 之类标签误判为发言人。
export const SPEAKER_PREFIX_MAX = 30;
// ラテン文字または日本語（ひらがな・カタカナ・漢字）で始まる名前のみ許可。
// 日本語の議事録は「田中：」「店長：」のように全角コロンで話者が付くことが多い。
// 「ー」(U+30FC) と「々」(U+3005) は長音・繰り返し記号として名前内で頻出するため明示的に許可する。
const SPEAKER_NAME_RE = /^(?:[A-Za-z\u3041-\u3096\u30A1-\u30FC\u4E00-\u9FFF])[A-Za-z0-9 .\-\u3041-\u3096\u30A1-\u30FC\u4E00-\u9FFF\u30FB\u3005]{0,29}$/;

// モデル给出的参与者名 → 规范名索引（同时收录全名与首词，兼容 "Dana" ↔ "Dana Lee"）
// 日本語は分かち書きをしないため、全名の先頭2〜6文字も索引に入れ「田中」↔「田中太郎」を吸収する。
function buildNameIndex(names) {
  const idx = new Map();
  for (const raw of names || []) {
    const canon = String(raw || '').trim();
    if (!canon) continue;
    const low = canon.toLowerCase();
    if (!idx.has(low)) idx.set(low, canon);
    const first = low.split(/\s+/)[0];
    if (first && !idx.has(first)) idx.set(first, canon);
    // 日本語名（空白なし・非ラテン）の先頭部分を索引化
    if (!/\s/.test(low) && !/^[a-z]/.test(low) && low.length >= 3) {
      for (let n = 2; n <= Math.min(6, low.length - 1); n++) {
        const head = low.slice(0, n);
        if (!idx.has(head)) idx.set(head, canon);
      }
    }
  }
  return idx;
}

// 文頭の話者プレフィックスを切り出す。ASCIIコロン「:」と全角コロン「：」の両対応。
function splitSpeakerPrefix(text) {
  const a = text.indexOf(':');
  const b = text.indexOf('：');
  let ci;
  if (a >= 0 && b >= 0) ci = Math.min(a, b);
  else ci = a >= 0 ? a : b;
  if (ci <= 0 || ci > SPEAKER_PREFIX_MAX) return null;
  return { pre: text.slice(0, ci).trim(), rest: text.slice(ci + 1).trim() };
}

export function annotateSpeakers(segments, confirmedNames) {
  const idx = buildNameIndex(confirmedNames);
  let last = null;
  return segments.map((s) => {
    let speaker = null;
    let spoken = s.text;
    const cut = splitSpeakerPrefix(s.text);
    if (cut && SPEAKER_NAME_RE.test(cut.pre)) {
      // 確認済み参加者にしか紐づけない（"議題：" "NOTE：" 等のラベル誤判定を防ぐ）
      const canon = idx.get(cut.pre.toLowerCase()) || idx.get(cut.pre.toLowerCase().split(/\s+/)[0]);
      if (canon) {
        speaker = canon;
        spoken = cut.rest;
        last = speaker;
      }
    }
    if (!speaker) speaker = last;
    return { ...s, speaker: speaker || 'Unknown', spoken };
  });
}

// 按发言人聚合：行数与对应 segment id（确定性）
export function buildRoster(annotated) {
  const map = new Map();
  for (const s of annotated) {
    if (!map.has(s.speaker)) map.set(s.speaker, { name: s.speaker, lines: 0, refs: [] });
    const r = map.get(s.speaker);
    r.lines += 1;
    r.refs.push(s.id);
  }
  return [...map.values()];
}

// ---- 行内引用：把正文里的 [n] / [n,m] 标记解析为可校验的 parts ----
// 有效编号 → {cite:n} 并收集去重；无效编号 → 原样保留为普通文本，杜绝编造。
export function parseInlineCites(raw, validIds) {
  const s = String(raw || '');
  const valid = new Set(validIds);
  const parts = [];
  const refs = [];
  const re = /\[(\d+(?:\s*,\s*\d+)*)\]/g;
  let last = 0;
  let m;
  while ((m = re.exec(s))) {
    if (m.index > last) parts.push({ text: s.slice(last, m.index) });
    const nums = m[1].split(',').map((x) => Number(x.trim()));
    const good = [];
    for (const n of nums) {
      if (valid.has(n)) {
        if (!refs.includes(n)) refs.push(n);
        good.push(n);
      }
    }
    if (good.length) {
      for (const n of good) parts.push({ cite: n });
    } else {
      parts.push({ text: m[0] }); // 全部无效 → 原样保留
    }
    last = re.lastIndex;
  }
  if (last < s.length) parts.push({ text: s.slice(last) });
  // 干净文本：移除有效标记、保留无效标记，收紧空白与标点间距
  const clean = s
    .replace(/\s*\[(\d+(?:\s*,\s*\d+)*)\]\s*/g, (mm, inner) => {
      const ok = inner.split(',').some((x) => valid.has(Number(x.trim())));
      return ok ? ' ' : mm;
    })
    .replace(/\s+([.,;:!?])/g, '$1')
    .replace(/\s{2,}/g, ' ')
    .trim();
  return { parts, refs, clean };
}

// ---- 議事録の組み立て：LLM の生JSON + 番号付きセグメント → 検証済みの契約 ----
// 日英の meeting が同じ形（decisions/action_items/open_questions/risks/speakers + 行内引用）を返すための単一実装。
export function assembleMeeting(obj, segments) {
  const validIds = segments.map((s) => s.id);
  const byId = new Map(segments.map((s) => [s.id, s]));
  const srcOf = (id) => {
    const s = byId.get(id);
    return s ? { ref: id, text: s.text, start: s.start, end: s.end } : null;
  };
  const enrichParts = (parts) => parts.map((p) => {
    if (!p.cite) return p;
    const s = byId.get(p.cite);
    return s ? { cite: p.cite, start: s.start, end: s.end } : p;
  });
  const arr = (v) => (Array.isArray(v)
    ? v.filter((x) => x && typeof x === 'object' && String(x.text || '').trim())
    : []);
  const toItem = (x, extra) => {
    const inline = parseInlineCites(String(x.text || ''), validIds);
    return {
      text: inline.clean,
      parts: enrichParts(inline.parts),
      sources: inline.refs.map(srcOf).filter(Boolean),
      ...extra
    };
  };

  // 条件文に含まれる [n] も解析し、本文から除去したうえで根拠として sources に統合する
  const decisions = arr(obj.decisions).map((x) => {
    const condRaw = String(x.condition || '');
    const condInline = condRaw ? parseInlineCites(condRaw, validIds) : null;
    const item = toItem(x, { condition: condInline ? condInline.clean : '' });
    if (condInline && condInline.refs.length) {
      const extra = condInline.refs
        .map(srcOf)
        .filter(Boolean)
        .filter((s) => !item.sources.some((o) => o.ref === s.ref));
      item.sources = item.sources.concat(extra);
    }
    return item;
  });
  const actionItems = arr(obj.action_items).map((x) => toItem(x, { owner: String(x.owner || ''), due: String(x.due || '') }));
  const openQuestions = arr(obj.open_questions).map((x) => toItem(x, {}));
  const risks = arr(obj.risks).map((x) => toItem(x, {}));

  const confirmed = [
    ...(Array.isArray(obj.speakers) ? obj.speakers : []),
    ...arr(obj.action_items).map((x) => x.owner)
  ];
  const annotated = annotateSpeakers(segments, confirmed);
  const speakerOf = new Map(annotated.map((s) => [s.id, s.speaker]));

  const sumInline = parseInlineCites(String(obj.summary || ''), validIds);
  const speakers = buildRoster(annotated).map((ro) => {
    const nameLow = ro.name.toLowerCase();
    return {
      name: ro.name,
      lines: ro.lines,
      actions: actionItems
        .filter((a) => a.owner && a.owner.toLowerCase() === nameLow)
        .map((a) => ({ text: a.text, due: a.due })),
      opens: openQuestions
        .filter((q) => q.sources.some((c) => speakerOf.get(c.ref) === ro.name))
        .map((q) => q.text),
      sources: ro.refs.map((id) => {
        const s = byId.get(id);
        return s ? { ref: id, start: s.start, end: s.end } : null;
      }).filter(Boolean)
    };
  });

  return {
    title: String(obj.title || '').slice(0, 120),
    summary: sumInline.clean,
    summary_parts: enrichParts(sumInline.parts),
    decisions,
    action_items: actionItems,
    open_questions: openQuestions,
    risks,
    speakers
  };
}

export function clientIp(req) {
  const xff = req.headers['x-forwarded-for'];
  if (typeof xff === 'string' && xff.length) return xff.split(',')[0].trim();
  return req.socket?.remoteAddress || 'unknown';
}

// ---- 可観測性：構造化ログ（Vercel Logs が stdout を収集する）----
// 方針: 入力本文・要約結果は絶対に出さない。IP は salt 付き SHA-256 の先頭12桁のみ。
const IP_HASH_SALT = process.env.LOG_IP_SALT || 'bunsho-yoyaku-2026';
function hashIp(ip) {
  try {
    return createHash('sha256').update(`${IP_HASH_SALT}:${ip}`).digest('hex').slice(0, 12);
  } catch (e) {
    return 'unavailable';
  }
}

// 1リクエスト＝1行の JSON。action / 成否 / 所要時間 / 文字数だけを残す。
export function createRequestLogger(req, action) {
  const started = Date.now();
  const h = req.headers || {};
  const referer = String(h.referer || h.referrer || '').slice(0, 200);
  const ua = String(h['user-agent'] || '').slice(0, 160);
  const host = String(h.host || '').slice(0, 80);
  const ipHash = hashIp(clientIp(req));
  let finished = false;

  function emit(status, extra) {
    if (finished) return;
    finished = true;
    const line = {
      evt: 'api_request',
      ts: new Date().toISOString(),
      action,
      host,
      status: Number(status) || 0,
      ms: Date.now() - started,
      ip_h: ipHash,
      referer,
      ua,
      region: String(h['x-vercel-ip-country'] || ''),
      ...extra
    };
    try {
      console.log(JSON.stringify(line));
    } catch (e) { /* ログ失敗は本処理に影響させない */ }
  }

  return { emit };
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
  return ''; // エラー応答などは本文として扱わない
}

// ---- Webページ取得：まず直連＋ローカルHTML→テキスト変換、失敗時のみゲートウェイ ----
const FETCH_TIMEOUT_MS = Number(process.env.FETCH_TIMEOUT_MS || 20000);
const BROWSER_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
const BLOCK_TAGS = /<\/?(?:p|div|section|article|header|footer|main|aside|nav|h[1-6]|li|ul|ol|tr|table|blockquote|pre|hr|figure|figcaption|dt|dd)\b[^>]*>/gi;

function decodeEntities(s) {
  return s
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#39;/g, "'")
    .replace(/&#x27;/g, "'")
    .replace(/&#(\d+);/g, (m, d) => String.fromCharCode(Number(d)))
    .replace(/&#x([0-9a-f]+);/gi, (m, h) => String.fromCharCode(parseInt(h, 16)));
}

// HTML を読みやすいプレーンテキストにする（外部API不要・決定論的）
export function htmlToText(html) {
  let s = String(html || '');
  s = s.replace(/<!--[\s\S]*?-->/g, ' ');
  s = s.replace(/<(script|style|noscript|template|svg|iframe|head)[\s\S]*?<\/\1>/gi, ' ');
  s = s.replace(/<br\s*\/?>/gi, '\n');
  s = s.replace(BLOCK_TAGS, '\n');
  s = s.replace(/<[^>]+>/g, ' ');
  s = decodeEntities(s);
  s = s.replace(/\r/g, '').replace(/[ \t\u00a0]+/g, ' ');
  s = s.replace(/\n[ ]*/g, '\n').replace(/\n{3,}/g, '\n\n');
  return s.trim();
}

async function fetchDirect(url) {
  let r;
  try {
    r = await fetch(url, {
      method: 'GET',
      redirect: 'follow',
      headers: {
        'User-Agent': BROWSER_UA,
        'Accept': 'text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.8',
        'Accept-Language': 'ja,en;q=0.8'
      },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS)
    });
  } catch (e) {
    const nm = (e && e.name) || '';
    throw new Error(nm === 'TimeoutError' || nm === 'AbortError' ? 'FETCH_TIMEOUT' : 'FETCH_NET');
  }
  if (!r.ok) throw new Error('FETCH_HTTP_' + r.status);
  const ct = (r.headers.get('content-type') || '').toLowerCase();
  const raw = await r.text();
  const content = (ct.includes('html') || /<[a-z][^>]*>/i.test(raw.slice(0, 3000))
    ? htmlToText(raw)
    : raw.trim());
  return content;
}

async function fetchViaGateway(url) {
  const endpoint =
    process.env.FETCH_API_URL ||
    'https://tokendance.space/gateway/deepseek/v1/tools/fetch';
  const key = process.env.FETCH_API_KEY || process.env.GATEWAY_API_KEY;
  if (!key) return '';
  let r;
  try {
    r = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
      body: JSON.stringify({ url }),
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS)
    });
  } catch (e) {
    console.error('[FETCH_GATEWAY_NET]', (e && e.message) || '');
    return '';
  }
  if (!r.ok) {
    console.error('[FETCH_GATEWAY_HTTP]', r.status);
    return '';
  }
  const data = await r.json().catch(() => null);
  if (data && data.error) {
    console.error('[FETCH_GATEWAY_ERROR]', JSON.stringify(data.error).slice(0, 300));
    return '';
  }
  return pickContent(data).trim().slice(0, FETCHED_MAX_CHARS);
}

export async function fetchWebPage(url) {
  if (!/^https?:\/\//i.test(url)) throw new Error('FETCH_BAD_URL');

  let direct = '';
  let directErr = null;
  try {
    direct = await fetchDirect(url);
  } catch (e) {
    directErr = e;
    console.error('[FETCH_DIRECT_FAIL]', url, (e && e.message) || '');
  }

  // 直連で十分な本文がとれていれば、外部モデルは使わない
  if (direct.length >= 600) {
    return { url, content: direct.slice(0, FETCHED_MAX_CHARS), via: 'direct' };
  }

  const gateway = await fetchViaGateway(url);
  const best = gateway.length > direct.length ? gateway : direct;
  const via = gateway.length > direct.length ? 'gateway' : 'direct';

  if (best.length >= 120) {
    return { url, content: best.slice(0, FETCHED_MAX_CHARS), via };
  }
  if (directErr && !gateway) throw new Error(directErr.message || 'FETCH_FAILED');
  throw new Error('FETCH_EMPTY');
}

// 入力にURLが含まれる場合、本文を取得して要約素材を組み立てる
// 一部のURLが失敗しても他のURLは使う。全部失敗したときだけエラーを投げる。
export async function resolveSourceText(rawText) {
  const urls = extractUrls(rawText);
  if (!urls.length) return { text: rawText, fetched: [] };

  const parts = [];
  const fetched = [];
  let firstErr = null;
  const nonUrl = rawText.replace(URL_RE, '').trim();
  if (nonUrl) parts.push('【ユーザー入力の補足】\n' + nonUrl);

  for (const u of urls) {
    try {
      // eslint-disable-next-line no-await-in-loop
      const page = await fetchWebPage(u);
      fetched.push({ url: u, ok: true, length: page.content.length, via: page.via });
      parts.push(`【Webページ: ${u}】\n${page.content}`);
    } catch (e) {
      if (!firstErr) firstErr = e;
      fetched.push({ url: u, ok: false, error: (e && e.message) || 'FETCH_FAILED' });
    }
  }

  if (!fetched.some((f) => f.ok)) throw new Error((firstErr && firstErr.message) || 'FETCH_FAILED');
  let joined = parts.join('\n\n');
  if (joined.length > FETCHED_MAX_CHARS + 4000) joined = joined.slice(0, FETCHED_MAX_CHARS + 4000);
  return { text: joined, fetched };
}

export async function callLlm(system, prompt, { maxTokens = 4000, temperature = 0.2 } = {}) {
  const apiUrl = process.env.LLM_API_URL || 'https://api.deepseek.com/v1/chat/completions';
  const apiKey = process.env.LLM_API_KEY;
  if (!apiKey) throw new Error('LLM_NO_KEY');

  let r;
  try {
    r = await fetch(apiUrl, {
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
        max_tokens: maxTokens,
        reasoning_effort: 'none'
      }),
      signal: AbortSignal.timeout(LLM_TIMEOUT_MS)
    });
  } catch (e) {
    const nm = (e && e.name) || 'ERROR';
    console.error('[LLM_NET_ERROR]', nm, e && e.message);
    throw new Error(nm === 'TimeoutError' || nm === 'AbortError' ? 'LLM_TIMEOUT' : 'LLM_NET_' + nm);
  }

  if (!r.ok) {
    const errBody = await r.text().catch(() => '');
    console.error('[LLM_ERROR] HTTP', r.status, 'URL:', apiUrl, 'Body:', errBody.slice(0, 500));
    throw new Error('LLM_HTTP_' + r.status);
  }
  const data = await r.json();
  const out = data.choices?.[0]?.message?.content?.trim();
  if (!out) {
    console.error('[LLM_EMPTY] data:', JSON.stringify(data).slice(0, 500));
    throw new Error('LLM_EMPTY');
  }
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

// ---- コスト対策：短時間レート制限 ＋ 1IP/日の回数上限 ＋ LLM結果キャッシュ ----
//   Vercel Serverless のインスタンスメモリ上なのでbest-effort（再起動・複数インスタンスで
//   リセットされうる）。それでも乱用対策・同一入力の重複呼び出し削減には十分効く。
//   環境変数で上限を上書き可能:
//     RATE_LIMIT_MAX（60秒あたり）/ DAILY_LIMIT_MAX（1IP・1日あたり、0で無制限）

const RATE_LIMIT_WINDOW_MS = 60_000;
const shortHits = new Map();   // ip -> {start,count}
const dayHits = new Map();     // ip -> {day:'YYYY-MM-DD',count}

function jstDayString(d = new Date()) {
  // JST(UTC+9) の日付。サーバTZに依らず一定にする。
  const t = d.getTime() + 9 * 3600_000;
  return new Date(t).toISOString().slice(0, 10);
}

export function enforceRateLimit(ip, {
  perMinute = Number(process.env.RATE_LIMIT_MAX) || 8,
  perDay = (() => { const v = Number(process.env.DAILY_LIMIT_MAX); return Number.isFinite(v) ? v : 60; })()
} = {}) {
  const now = Date.now();

  // 短時間（60秒）
  const s = shortHits.get(ip);
  let minuteCount;
  if (!s || now - s.start > RATE_LIMIT_WINDOW_MS) {
    shortHits.set(ip, { start: now, count: 1 });
    minuteCount = 1;
  } else {
    s.count += 1;
    minuteCount = s.count;
  }

  // 1日（JST）
  const today = jstDayString();
  const d = dayHits.get(ip);
  let dayCount;
  if (!d || d.day !== today) {
    dayHits.set(ip, { day: today, count: 1 });
    dayCount = 1;
  } else {
    d.count += 1;
    dayCount = d.count;
  }

  // 定期的に古いエントリを掃除
  if (shortHits.size > 5000) {
    for (const [k, v] of shortHits) if (now - v.start > RATE_LIMIT_WINDOW_MS * 10) shortHits.delete(k);
  }
  if (dayHits.size > 5000) {
    for (const [k, v] of dayHits) if (v.day !== today) dayHits.delete(k);
  }

  if (perMinute > 0 && minuteCount > perMinute) {
    return { allowed: false, reason: 'minute', minuteCount, dayCount };
  }
  if (perDay > 0 && dayCount > perDay) {
    return { allowed: false, reason: 'day', minuteCount, dayCount, limit: perDay };
  }
  return { allowed: true, minuteCount, dayCount };
}

// 同一入力の重複LLM呼び出しを省く、シンプルなTTL/LRUキャッシュ
const CACHE_TTL_MS = 6 * 3600_000; // 6時間
const CACHE_MAX = 500;
const llmCache = new Map();       // key -> {at, value}

function hashString(str) {
  // 衝突リスクの低いFNV-1a 32bit（キャッシュ専用、暗号用途ではない）
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return ('0000000' + h.toString(16)).slice(-8);
}

const LLM_TIMEOUT_MS = Number(process.env.LLM_TIMEOUT_MS || 25000);
const LLM_MAX_RETRY = Number(process.env.LLM_MAX_RETRY || 1);
const LLM_RETRY_DELAY_MS = Number(process.env.LLM_RETRY_DELAY_MS || 1200);

// 上流ゲートウェイの一時障害だけを再試行する（キー未設定・4xx は即失敗）
function llmRetryable(err) {
  const m = String((err && err.message) || '');
  if (m === 'LLM_NO_KEY') return false;
  const http = /^LLM_HTTP_(\d+)$/.exec(m);
  if (http) {
    const code = Number(http[1]);
    return code === 408 || code === 425 || code === 429 || code >= 500;
  }
  return m === 'LLM_EMPTY' || m === 'LLM_TIMEOUT' || m.indexOf('LLM_NET_') === 0;
}

async function callLlmWithRetry(system, prompt, opts) {
  let lastErr;
  for (let i = 0; i <= LLM_MAX_RETRY; i++) {
    try {
      return await callLlm(system, prompt, opts);
    } catch (e) {
      lastErr = e;
      const m = String((e && e.message) || '');
      if (!llmRetryable(e) || i === LLM_MAX_RETRY) throw e;
      console.error('[LLM_RETRY]', m, 'attempt', i + 1);
      // eslint-disable-next-line no-await-in-loop
      await new Promise((ok) => setTimeout(ok, LLM_RETRY_DELAY_MS * (i + 1)));
    }
  }
  throw lastErr;
}


export function cachedLlm(system, prompt, opts = {}) {
  const cacheKey = hashString([
    process.env.LLM_MODEL || 'deepseek-chat',
    opts.maxTokens ?? 1600,
    opts.temperature ?? 0.2,
    system,
    prompt
  ].join('\u0000'));

  const hit = llmCache.get(cacheKey);
  const now = Date.now();
  if (hit && now - hit.at < CACHE_TTL_MS) {
    // LRU: 参照を最新に
    llmCache.delete(cacheKey);
    llmCache.set(cacheKey, hit);
    return Promise.resolve({ value: hit.value, cached: true });
  }

  return callLlmWithRetry(system, prompt, opts).then((value) => {
    if (llmCache.size >= CACHE_MAX) {
      const oldest = llmCache.keys().next().value;
      llmCache.delete(oldest);
    }
    llmCache.set(cacheKey, { at: now, value });
    return { value, cached: false };
  });
}
