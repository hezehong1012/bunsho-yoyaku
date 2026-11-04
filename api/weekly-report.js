// Vercel Serverless Function: 週報自動生成API
// 今週の作業内容 → 上司に伝わる週報（業務内容/成果/課題/来週の予定）に整形
import { clientIp, jevGuard, enforceRateLimit, cachedLlm } from './_lib.js';

export const config = { maxDuration: 60 };

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const limit = enforceRateLimit(clientIp(req));
  if (!limit.allowed) {
    const msg = limit.reason === 'day'
      ? `本日のご利用回数が上限（${limit.limit}回）に達しました。日付が変わってから再度お試しください。`
      : 'リクエストが短時間に多すぎます。少し待ってから再度お試しください。';
    return res.status(429).json({ error: msg, reason: limit.reason });
  }

  const body = req.body || {};
  const work = typeof body.work === 'string' ? body.work.trim() : '';
  const owner = typeof body.owner === 'string' ? body.owner.trim() : '';

  if (!work || work.length < 10) {
    return res.status(400).json({ error: '今週の作業内容を10文字以上で入力してください。' });
  }
  if (work.length > 2000) {
    return res.status(400).json({ error: '作業内容は2000文字以内で入力してください。' });
  }
  if (owner.length > 60) {
    return res.status(400).json({ error: '氏名・部署は60文字以内で入力してください。' });
  }

  const guard = await jevGuard(work);
  if (guard.blocked) {
    return res.status(422).json({
      error: '入力内容が意味のある文章ではないと判定されました。今週の作業内容を入力してください。',
      guarded: true
    });
  }

  const system = 'あなたは日本のビジネス文書作成の専門家です。箇条書きの作業メモを、上司が読んで状況を把握できる週報に整えます。';
  const prompt = `次の作業メモから、週報を作成してください。

【氏名・部署】${owner || '（未入力）'}
【今週の作業メモ】
${work}

出力ルール:
・1行目は「週報」だけ。2行目に氏名・部署（未入力なら書かない）
・続けて次の4見出しを、この順番で必ず入れる
　■今週の業務内容
　■成果・進捗
　■課題・懸念
　■来週の予定
・各見出しの下は「・」で始まる箇条書き（1〜4項目）。1項目は40字程度まで
・作業メモに書かれていない事実を作らない。メモから読み取れない項目は「特になし」と書く
・です・ます調ではなく、週報らしい簡潔な体言止め・「〜を実施」の形で書く
・前置き・解説・補足コメントは一切書かない
・全体で400〜700字に収める

週報:`;

  try {
    const { value: result, cached } = await cachedLlm(system, prompt, { maxTokens: 1800, temperature: 0.4 });
    return res.status(200).json({ result, cached });
  } catch (e) {
    if (e.message === 'LLM_NO_KEY') {
      return res.status(200).json({
        result: '（デモ:LLM未設定）Vercel環境変数 LLM_API_KEY を設定すると本番の週報生成が有効になります。',
        demo: true
      });
    }
    return res.status(500).json({ error: '週報の生成に失敗しました。再度お試しください。' });
  }
}
