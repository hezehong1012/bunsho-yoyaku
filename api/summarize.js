// Vercel Serverless Function: AI要約 API
// 環境変数: LLM_API_KEY, LLM_API_URL, LLM_MODEL (OpenAI互換, 既定DeepSeek)
// シンプルなインメモリーIPレート制限（サーバーレスのインスタンス単位・ベストエフォート）

const MAX_CHARS = 5000;
const MIN_CHARS = 50;
const RATE_LIMIT_WINDOW_MS = 60_000;
const RATE_LIMIT_MAX = 8;
const ipHits = new Map();

function clientIp(req) {
  const xff = req.headers['x-forwarded-for'];
  if (typeof xff === 'string' && xff.length) return xff.split(',')[0].trim();
  return req.socket?.remoteAddress || 'unknown';
}

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

// 古いキーを定期掃除
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
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const ip = clientIp(req);
  if (rateLimited(ip)) {
    return res.status(429).json({ error: 'リクエストが多すぎます。しばらく待ってから再度お試しください。' });
  }

  const body = req.body || {};
  const text = typeof body.text === 'string' ? body.text.trim() : '';
  const maxLength = Number(body.max_length);
  const tone = body.tone === 'dearu' ? 'dearu' : 'desu';
  const keyword = typeof body.keyword === 'string' ? body.keyword.trim().slice(0, 30) : '';
  const ngword = typeof body.ngword === 'string' ? body.ngword.trim().slice(0, 30) : '';
  const scene = sceneMap[body.scene] ? body.scene : 'general';

  if (!text || text.length < MIN_CHARS) {
    return res.status(400).json({ error: `要約する文章を${MIN_CHARS}文字以上入力してください。` });
  }
  if (text.length > MAX_CHARS) {
    return res.status(400).json({ error: `${MAX_CHARS}文字以内で入力してください。` });
  }
  if (!Number.isFinite(maxLength) || maxLength < 50 || maxLength > 1000) {
    return res.status(400).json({ error: '要約字数は50〜1000文字の間で指定してください。' });
  }

  const toneText = tone === 'desu'
    ? '敬体（です・ます調）'
    : '常体（だ・である調）';

  const rules = [
    `・出力は約${maxLength}文字（前後20%程度まで許容）にまとめる`,
    `・文体は${toneText}`,
    `・${sceneMap[scene]}要約する`,
    '・要点と結論を漏らさず、重複を省く',
    '・要約文だけを出力し、前置きや解説、見出し記号の追加は最小限にする'
  ];
  if (keyword) rules.push(`・キーワード「${keyword}」を自然に含める`);
  if (ngword) rules.push(`・「${ngword}」という語句は使わない`);

  const prompt = `あなたは日本語の要約の専門家です。次の文章を、以下のルールで要約してください。
${rules.join('\n')}

---
${text}
---

要約文:`;

  try {
    const apiUrl = process.env.LLM_API_URL || 'https://api.deepseek.com/v1/chat/completions';
    const apiKey = process.env.LLM_API_KEY;

    if (!apiKey) {
      // キー未設定時のフォールバック（デモ・レビュー用）
      const head = text.replace(/\s+/g, ' ').slice(0, Math.min(maxLength, text.length));
      const demo = '[デモモード] 現在LLM APIキーが未設定のため、先頭を切り詰めた仮の要約を返しています。Vercelの環境変数 LLM_API_KEY を設定すると本番のAI要約が有効になります。\n\n' + head + (text.length > maxLength ? '……' : '');
      return res.status(200).json({ summary: demo, demo: true });
    }

    const llmRes = await fetch(apiUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`
      },
      body: JSON.stringify({
        model: process.env.LLM_MODEL || 'deepseek-chat',
        messages: [
          { role: 'system', content: 'あなたは日本語の要約専門家で、正確で読みやすい要約を書きます。' },
          { role: 'user', content: prompt }
        ],
        temperature: 0.3,
        max_tokens: 1200
      })
    });

    if (!llmRes.ok) {
      const detail = await llmRes.text().catch(() => '');
      return res.status(502).json({ error: '要約サービスから応答がありませんでした。時間をおいて再度お試しください。' });
    }

    const data = await llmRes.json();
    const summary = data.choices?.[0]?.message?.content?.trim();
    if (!summary) throw new Error('empty summary');

    return res.status(200).json({ summary });
  } catch (e) {
    return res.status(500).json({ error: '要約の生成に失敗しました。再度お試しください。' });
  }
}
