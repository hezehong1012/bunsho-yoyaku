// Vercel Serverless Function: AI要約 API（URL自動取得対応 V1.2）
import {
  MAX_CHARS, MIN_CHARS, clientIp, extractUrls, resolveSourceText, callLlm, jevGuard
} from './_lib.js';

const RATE_LIMIT_WINDOW_MS = 60_000;
const RATE_LIMIT_MAX = 8;
const ipHits = new Map();

function rateLimited(ip) {
  const now = Date.now();
  const rec = ipHits.get(ip);
  if (!rec || now - rec.start > RATE_LIMIT_WINDOW_MS) {
    ipHits.set(ip, { start: now, count: 1 });
    return false;
  }
  rec.count += 1;
  return rec.count > RATE_LIMIT_MAX;
}
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of ipHits) if (now - v.start > RATE_LIMIT_WINDOW_MS * 5) ipHits.delete(k);
}, RATE_LIMIT_WINDOW_MS * 5).unref?.();

const sceneMap = {
  report: 'レポート・報告書として、結論と根拠が伝わる構成で',
  minutes: '議事録として、決定事項・宿題・期限が分かる構成で',
  daily: '業務日報として、取り組んだ内容・成果・所感が伝わる形で',
  email: 'ビジネスメールとして、丁寧かつ簡潔な形で',
  general: '客観的で分かりやすい形で'
};

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  if (rateLimited(clientIp(req))) {
    return res.status(429).json({ error: 'リクエストが多すぎます。しばらく待ってから再度お試しください。' });
  }

  const body = req.body || {};
  const rawText = typeof body.text === 'string' ? body.text.trim() : '';
  const maxLength = Number(body.max_length);
  const tone = body.tone === 'dearu' ? 'dearu' : 'desu';
  const keyword = typeof body.keyword === 'string' ? body.keyword.trim().slice(0, 30) : '';
  const ngword = typeof body.ngword === 'string' ? body.ngword.trim().slice(0, 30) : '';
  const scene = sceneMap[body.scene] ? body.scene : 'general';

  const hasUrl = extractUrls(rawText).length > 0;
  if (!rawText || (rawText.length < MIN_CHARS && !hasUrl)) {
    return res.status(400).json({ error: `要約する文章またはURLを${MIN_CHARS}文字以上入力してください。URLのみの場合は短くても構いません。` });
  }
  if (rawText.length > MAX_CHARS && !hasUrl) {
    return res.status(400).json({ error: `${MAX_CHARS}文字以内で入力してください。` });
  }
  if (!Number.isFinite(maxLength) || maxLength < 50 || maxLength > 1000) {
    return res.status(400).json({ error: '要約字数は50〜1000文字の間で指定してください。' });
  }

  // 無料判定モデルでゴミ/乱用を前段ブロック（失敗時は放行）
  const guard = await jevGuard(rawText);
  if (guard.blocked) {
    return res.status(422).json({
      error: '入力内容が意味のある文章ではないと判定されました。要約したい本文（またはURL）を入力してください。',
      guarded: true
    });
  }

  let source = rawText;
  let fetched = [];
  const urls = extractUrls(rawText);
  if (urls.length) {
    try {
      const r = await resolveSourceText(rawText);
      source = r.text;
      fetched = r.fetched;
    } catch (e) {
      if (e.message === 'FETCH_NO_KEY') {
        return res.status(503).json({ error: 'URL取得機能が現在利用できません（サーバー設定不足）。URLを除いて文章だけを入力してください。' });
      }
      return res.status(502).json({ error: 'URLの内容を取得できませんでした。公開されているページか確認してください。' });
    }
  }

  const toneText = tone === 'desu' ? '敬体（です・ます調）' : '常体（だ・である調）';
  const rules = [
    `・出力は約${maxLength}文字（前後20%程度まで許容）にまとめる`,
    `・文体は${toneText}`,
    `・${sceneMap[scene]}要約する`,
    '・要点と結論を漏らさず、重複を省く',
    '・要約文だけを出力し、前置きや解説は付けない'
  ];
  if (keyword) rules.push(`・キーワード「${keyword}」を自然に含める`);
  if (ngword) rules.push(`・「${ngword}」という語句は使わない`);

  const prompt = `あなたは日本語の要約専門家です。次の文章（Webページ本文を含む）をルールに沿って要約してください。
${rules.join('\n')}

---
${source}
---

要約文:`;

  try {
    const summary = await callLlm(
      'あなたは日本語の要約専門家で、正確で読みやすい要約を書きます。',
      prompt,
      { maxTokens: 1200, temperature: 0.3 }
    );
    return res.status(200).json({ summary, fetched });
  } catch (e) {
    if (e.message === 'LLM_NO_KEY') {
      return res.status(200).json({
        summary: '[デモモード] LLM APIキーが未設定です。Vercel環境変数 LLM_API_KEY を設定すると本番のAI要約が有効になります。',
        demo: true, fetched
      });
    }
    return res.status(500).json({ error: '要約の生成に失敗しました。再度お試しください。' });
  }
}
