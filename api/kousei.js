// Vercel Serverless Function: 文章校正（添削）API
// 誤字脱字・表記ゆれ・敬語・読みやすさをチェックし、添削後の本文と修正点を返す。
// モード: proof（誤字脱字・表記統一） / business（ビジネス敬語） / readable（読みやすさ）
import { MAX_CHARS, MIN_CHARS, clientIp, jevGuard, enforceRateLimit, cachedLlm } from './_lib.js';

const modeMap = {
  proof: {
    label: '誤字脱字・表記ゆれの校正',
    rules: [
      '・誤字脱字、助詞の抜けや重複、送り仮名の誤りを直す',
      '・表記ゆれ（「WEB/Web/ウェブ」「サーバー/サーバ」など）を本文内で統一する',
      '・句読点の抜けや二重句読点を整える',
      '・文章の言い回しや構成はできるだけ変えず、誤りだけを最小限に直す'
    ]
  },
  business: {
    label: 'ビジネス文書としての敬語・表現の校正',
    rules: [
      '・敬語の誤り（二重敬語、尊敬語と謙譲語の取り違え）を直す',
      '・「です・ます調」に統一し、社外文書として失礼のない表現にする',
      '・くだけた言い方、若者言葉、略語をビジネス表現に置き換える',
      '・事実・数値・固有名詞は変更しない'
    ]
  },
  readable: {
    label: '読みやすさの改善',
    rules: [
      '・1文が長すぎる箇所は意味の切れ目で分割する',
      '・冗長な重複表現や不要な修飾語を削る',
      '・主語と述語のねじれ、係り受けの分かりにくい箇所を直す',
      '・元の情報量と論点は保ち、文章量は元の±20%以内に収める'
    ]
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
  const mode = modeMap[body.mode] ? body.mode : 'proof';

  if (!rawText || rawText.length < MIN_CHARS) {
    return res.status(400).json({ error: `校正する文章を${MIN_CHARS}文字以上入力してください。` });
  }
  if (rawText.length > MAX_CHARS) {
    return res.status(400).json({ error: `${MAX_CHARS}文字以内で入力してください。` });
  }

  const guard = await jevGuard(rawText);
  if (guard.blocked) {
    return res.status(422).json({
      error: '入力内容が意味のある文章ではないと判定されました。校正したい本文を入力してください。',
      guarded: true
    });
  }

  const m = modeMap[mode];
  const system = 'あなたは日本語の校正・添削の専門家です。元の意味と事実を変えずに、指定された観点だけを直します。';
  const prompt = `次の日本語の文章を校正してください。

【校正の方針】${m.label}
${m.rules.join('\n')}
・元の文章にない事実・数値・意見を追加しない
・出力は必ず次の2ブロック構成にし、他の見出しや前置きは付けない

【添削後】
（校正済みの本文だけを、元の段落構成のまま書く）

【修正点】
・（直した箇所を「誤 → 正」の形で1行ずつ、最大6行。該当がなければ「・大きな修正はありません」の1行だけ）

【校正する文章】
${rawText}`;

  try {
    const { value: raw, cached } = await cachedLlm(system, prompt, { maxTokens: 2000, temperature: 0.2 });
    const parsed = parseOutput(raw, rawText);
    return res.status(200).json({ corrected: parsed.corrected, points: parsed.points, mode, cached });
  } catch (e) {
    if (e.message === 'LLM_NO_KEY') {
      return res.status(200).json({ corrected: '（デモ:LLM未設定）Vercel環境変数 LLM_API_KEY を設定すると本番の校正が有効になります。', points: [], demo: true, mode });
    }
    return res.status(500).json({ error: '校正に失敗しました。再度お試しください。' });
  }
}

// LLM出力を「添削後」「修正点」の2ブロックに分解する。崩れていても本文は必ず取り出す。
function parseOutput(raw, fallbackText) {
  const text = String(raw || '').trim();
  let corrected = '';
  let points = [];

  const pointIdx = text.indexOf('【修正点】');
  const bodyPart = pointIdx >= 0 ? text.slice(0, pointIdx) : text;
  const pointPart = pointIdx >= 0 ? text.slice(pointIdx + 5) : '';

  const afterIdx = bodyPart.indexOf('【添削後】');
  corrected = (afterIdx >= 0 ? bodyPart.slice(afterIdx + 5) : bodyPart).trim();

  points = pointPart
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => /^[・\-\*]/.test(l))
    .map((l) => l.replace(/^[・\-\*]\s*/, ''))
    .filter(Boolean)
    .slice(0, 8);

  if (!corrected || corrected.length < 10) {
    corrected = fallbackText;
    if (!points.length) points = ['添削結果を整形できなかったため、元の文章を表示しています。再度お試しください。'];
  }
  return { corrected, points };
}
