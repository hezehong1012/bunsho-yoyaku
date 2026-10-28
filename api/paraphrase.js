// Vercel Serverless Function: 言い換え（リライト/Paraphrase）API
// 文章の意味を保ったまま表現を言い換える。モード: standard / polite / easy
import { MAX_CHARS, MIN_CHARS, clientIp, jevGuard, enforceRateLimit, cachedLlm } from './_lib.js';

const modeMap = {
  standard: {
    label: '自然で分かりやすい標準的な言い換え',
    rule: '・語句と語順を自然に組み替え、元の文章の意味・論点・数値を一切変えずに、読みやすく自然な日本語にする'
  },
  polite: {
    label: '丁寧・ビジネス向けの言い換え',
    rule: '・ビジネスの場で使える丁寧で敬意のある表現にする（です・ます調）。失礼な響きを避け、敬語やクッション言葉を自然に使い、意味は変えない'
  },
  easy: {
    label: 'やさしく言い換え',
    rule: '・専門用語や難しい言い回しを避け、短い文で誰にでも分かりやすくする。ただし幼稚にせず、元の内容・数値は正確に保つ'
  }
};

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  const limit = enforceRateLimit(clientIp(req));
  if (!limit.allowed) {
    const msg = limit.reason === 'day'
      ? `本日のご利用回数が上限（${limit.limit}回）に達しました。日付が変わってから再度お試しください。`
      : 'リクエストが短時間に多すぎます。少し待ってから再度お試しください。';
    return res.status(429).json({ error: msg });
  }

  const body = req.body || {};
  const rawText = typeof body.text === 'string' ? body.text.trim() : '';
  const mode = modeMap[body.mode] ? body.mode : 'standard';

  if (!rawText || rawText.length < MIN_CHARS) {
    return res.status(400).json({ error: `言い換えする文章を${MIN_CHARS}文字以上入力してください。` });
  }
  if (rawText.length > MAX_CHARS) {
    return res.status(400).json({ error: `${MAX_CHARS}文字以内で入力してください。` });
  }

  const guard = await jevGuard(rawText);
  if (guard.blocked) {
    return res.status(422).json({
      error: '入力内容が意味のある文章ではないと判定されました。言い換えしたい本文を入力してください。',
      guarded: true
    });
  }

  const m = modeMap[mode];
  const system = 'あなたは日本語のライティング専門家です。元の意味を正確に保ったまま自然で読みやすい文章に言い換えます。';
  const prompt = `次の日本語の文章を、指定方針で言い換えてください。

【方針】${m.label}
${m.rule}
・言い換えた本文だけを出力し、前置き・解説・見出し・「以下に」等の言葉は一切付けない
・元の文章にない事実や意見を追加しない
・文字数は元と同程度（前後20%）に保つ

【元の文章】
${rawText}

言い換え後の本文:`;

  try {
    const { value: result, cached } = await cachedLlm(system, prompt, { maxTokens: 1600, temperature: 0.5 });
    return res.status(200).json({ result, mode, cached });
  } catch (e) {
    if (e.message === 'LLM_NO_KEY') {
      return res.status(200).json({ result: '（デモ:LLM未設定）Vercel環境変数 LLM_API_KEY を設定すると本番の言い換えが有効になります。', demo: true, mode });
    }
    return res.status(500).json({ error: '言い換えに失敗しました。再度お試しください。' });
  }
}
