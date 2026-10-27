// Vercel Serverless Function: 情報抽出（フィールド抽出）API V1.2
// 入力文章と抽出したいフィールド（カンマ/改行区切り）を受け取り、JSONで返す
import {
  MAX_CHARS, MIN_CHARS, clientIp, extractUrls, resolveSourceText, callLlm, jsonFromMarkdown
} from './_lib.js';

const RATE_LIMIT_WINDOW_MS = 60_000;
const RATE_LIMIT_MAX = 8;
const ipHits = new Map();
function rateLimited(ip) {
  const now = Date.now();
  const rec = ipHits.get(ip);
  if (!rec || now - rec.start > RATE_LIMIT_WINDOW_MS) { ipHits.set(ip, { start: now, count: 1 }); return false; }
  rec.count += 1;
  return rec.count > RATE_LIMIT_MAX;
}

function parseFields(raw) {
  return String(raw || '')
    .split(/[,、，\n\r\t;；]+/)
    .map((s) => s.trim())
    .filter(Boolean)
    .slice(0, 12);
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  if (rateLimited(clientIp(req))) {
    return res.status(429).json({ error: 'リクエストが多すぎます。しばらく待ってから再度お試しください。' });
  }

  const body = req.body || {};
  const rawText = typeof body.text === 'string' ? body.text.trim() : '';
  const fields = parseFields(body.fields);

  if (!rawText || rawText.length < MIN_CHARS) {
    return res.status(400).json({ error: `抽出対象の文章またはURLを${MIN_CHARS}文字以上入力してください。` });
  }
  if (rawText.length > MAX_CHARS && extractUrls(rawText).length === 0) {
    return res.status(400).json({ error: `${MAX_CHARS}文字以内で入力してください。` });
  }
  if (fields.length < 1) {
    return res.status(400).json({ error: '抽出したい項目（フィールド）を1つ以上入力してください。' });
  }

  let source = rawText;
  let fetched = [];
  if (extractUrls(rawText).length) {
    try {
      const r = await resolveSourceText(rawText);
      source = r.text; fetched = r.fetched;
    } catch (e) {
      if (e.message === 'FETCH_NO_KEY') {
        return res.status(503).json({ error: 'URL取得機能が現在利用できません（サーバー設定不足）。' });
      }
      return res.status(502).json({ error: 'URLの内容を取得できませんでした。' });
    }
  }

  const fieldList = fields.map((f) => `"${f}"`).join(', ');
  const system = 'あなたは日本語の情報抽出エンジンです。文章から指定された項目の値を正確に抽出し、JSONだけを返します。';
  const prompt = `以下の文章から、指定された項目を抽出してください。

【抽出項目】
${fields.map((f, i) => `${i + 1}. ${f}`).join('\n')}

【出力ルール】
・キーは指定された項目名をそのまま使い、値は日本語で簡潔に記入
・値が見つからない項目は "なし" とする
・金額・日付・人数などは文章中の表記をそのまま保つ
・複数ある場合は配列ではなく読点「、」で列挙する
・説明文や前後の言葉は一切付けず、JSONオブジェクトのみを出力
・キーの順序は指定順（${fieldList}）にする

【文章】
${source}

JSON:`;

  try {
    const out = await callLlm(system, prompt, { maxTokens: 1200, temperature: 0 });
    const obj = jsonFromMarkdown(out);
    // 指定された全フィールドを保証
    const result = {};
    for (const f of fields) result[f] = (obj[f] != null && String(obj[f]).trim()) ? String(obj[f]).trim() : 'なし';
    return res.status(200).json({ fields: fields, result, fetched });
  } catch (e) {
    if (e.message === 'LLM_NO_KEY') {
      const demo = {};
      for (const f of fields) demo[f] = '（デモ:LLM未設定）';
      return res.status(200).json({ fields, result: demo, demo: true, fetched });
    }
    if (e.message.startsWith('LLM_HTTP')) return res.status(502).json({ error: '抽出サービスから応答がありませんでした。' });
    return res.status(500).json({ error: '情報抽出に失敗しました。項目名を確認して再度お試しください。' });
  }
}
