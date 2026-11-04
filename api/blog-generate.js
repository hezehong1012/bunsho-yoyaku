// Vercel Serverless Function: ブログ記事自動生成API
// テーマ（＋任意キーワード・長さ・文体）→ AIがSEOを意識した記事下書きを生成
import { clientIp, jevGuard, enforceRateLimit, cachedLlm } from './_lib.js';

export const config = { maxDuration: 60 };

const LENGTH_MAP = {
  short: { label: '短め（600〜900字）', maxTokens: 1400 },
  medium: { label: '標準（1200〜1800字）', maxTokens: 2400 },
  long: { label: '長め（2000〜2800字）', maxTokens: 3600 }
};

const TONE_MAP = {
  desu: { label: 'です・ます調（読みやすい一般的なブログ）' },
  casual: { label: 'カジュアルで親しみやすい口調' },
  pro: { label: '専門的で落ち着いた口調' }
};

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
  const topic = typeof body.topic === 'string' ? body.topic.trim() : '';
  const keywords = typeof body.keywords === 'string' ? body.keywords.trim() : '';
  const lengthKey = LENGTH_MAP[body.length] ? body.length : 'medium';
  const toneKey = TONE_MAP[body.tone] ? body.tone : 'desu';

  if (!topic || topic.length < 5) {
    return res.status(400).json({ error: 'テーマを5文字以上で入力してください。' });
  }
  if (topic.length > 500) {
    return res.status(400).json({ error: 'テーマは500文字以内で入力してください。' });
  }
  if (keywords.length > 200) {
    return res.status(400).json({ error: 'キーワードは200文字以内で入力してください。' });
  }

  const guard = await jevGuard(topic + (keywords ? ' ' + keywords : ''));
  if (guard.blocked) {
    return res.status(422).json({
      error: '入力内容が意味のある文章ではないと判定されました。記事のテーマを入力してください。',
      guarded: true
    });
  }

  const len = LENGTH_MAP[lengthKey];
  const tone = TONE_MAP[toneKey];
  const system = 'あなたは日本語SEO記事の編集者です。検索意図に沿った、読みやすく具体的なブログ記事を書きます。事実確認できない統計や固有名詞の捏造は行いません。';

  const prompt = `次の条件で、ブログ記事の下書きを書いてください。

【テーマ】${topic}
【狙うキーワード】${keywords || '（指定なし）'}
【文体】${tone.label}
【分量の目安】${len.label}

出力ルール:
・1行目は「タイトル：」で始め、記事タイトルの案を1つ書く
・2行目以降は本文（導入 → 見出し3〜5個 → まとめ）の順で書く
・見出しの行は行頭に「■」を付ける（例：■在宅ワークで集中力が切れる原因）
・本文は各見出しにつき2〜4文。具体例や読者が実践できる手順を入れる
・プレーンテキストのみ。Markdown記号（#、##、**、---）や番号付きリスト記号は使わない
・「以下が記事です」「承知しました」などの前置き・解説・後書きは一切書かない
・確認できない数値・統計・調査結果を作らない（一般的な傾向として書く場合は「〜といわれています」等にする）

記事:`;

  try {
    const { value: result, cached } = await cachedLlm(system, prompt, {
      maxTokens: len.maxTokens,
      temperature: 0.7
    });
    return res.status(200).json({
      result,
      cached,
      length: lengthKey,
      tone: toneKey,
      chars: result.length
    });
  } catch (e) {
    if (e.message === 'LLM_NO_KEY') {
      return res.status(200).json({
        result: '（デモ:LLM未設定）Vercel環境変数 LLM_API_KEY を設定すると本番の記事生成が有効になります。',
        demo: true,
        length: lengthKey,
        tone: toneKey,
        chars: 0
      });
    }
    return res.status(500).json({ error: '記事の生成に失敗しました。再度お試しください。' });
  }
}
