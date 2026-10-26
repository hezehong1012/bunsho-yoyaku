// Vercel Serverless Function: AI要約 API
// 環境変数: LLM_API_KEY, LLM_API_URL (DeepSeek/Gemini/OpenAI互換)
export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { text, length = 'medium', style = 'normal' } = req.body || {};

  if (!text || text.length < 50) {
    return res.status(400).json({ error: '50文字以上入力してください' });
  }
  if (text.length > 5000) {
    return res.status(400).json({ error: '5000文字以内で入力してください' });
  }

  // 長さのマッピング
  const lengthMap = {
    short: '100文字程度',
    medium: '300文字程度',
    long: '500文字程度'
  };

  // スタイルのマッピング
  const styleMap = {
    normal: '標準的なトーンで',
    business: 'ビジネス文書として適切な、丁寧で論理的なトーンで',
    simple: 'できるだけ簡潔で分かりやすい言葉で'
  };

  const prompt = `あなたは日本語の要約専門家です。以下の文章を${lengthMap[length]}、${styleMap[style]}要約してください。
要点を漏らさず、しかし簡潔にまとめてください。要約のみを出力し、説明や前置きは不要です。

---
${text}
---

要約:`;

  try {
    // DeepSeek API (OpenAI互換) - デフォルト
    const apiUrl = process.env.LLM_API_URL || 'https://api.deepseek.com/v1/chat/completions';
    const apiKey = process.env.LLM_API_KEY;

    if (!apiKey) {
      // APIキー未設定時はデモ応答
      return res.status(200).json({
        summary: '[デモモード] APIキーが設定されていません。Vercelの環境変数に LLM_API_KEY を設定してください。\n\n設定後は、ここにAIが生成した要約文が表示されます。\n\nデモ用サンプル:\n' + text.substring(0, 100) + '...(以下略)'
      });
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
          { role: 'system', content: 'あなたは日本語の要約専門家です。' },
          { role: 'user', content: prompt }
        ],
        temperature: 0.3,
        max_tokens: 800
      })
    });

    const data = await llmRes.json();
    const summary = data.choices?.[0]?.message?.content?.trim();

    if (!summary) {
      throw new Error('要約の生成に失敗しました');
    }

    return res.status(200).json({ summary });
  } catch (e) {
    return res.status(500).json({ error: 'サーバーエラー: ' + e.message });
  }
}
