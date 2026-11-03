// Vercel Serverless Function: ビジネスメール自動生成API
// シーン選択（お礼/お詫び/依頼/催促/謝罪/お願い/返信）→ AIが自然なビジネスメールを生成
import { clientIp, jevGuard, enforceRateLimit, cachedLlm } from './_lib.js';

const sceneMap = {
  orei: {
    label: 'お礼メール',
    rule: '・感謝の気持ちを丁寧に伝える。具体的なエピソードや相手の行動に触れるとより自然になる'
  },
  owabi: {
    label: 'お詫びメール',
    rule: '・誠意を持って謝罪する。言い訳や責任転嫁をせず、今後の対応策を簡潔に示す'
  },
  iraI: {
    label: '依頼メール',
    rule: '・何を・いつまでに・なぜ依頼するのかを明確に。相手への配慮とクッション言葉を忘れずに'
  },
  saisoku: {
    label: '催促メール',
    rule: '・角が立たないように柔らかく促す。相手を責めず、確認のニュアンスで伝える'
  },
  shazai: {
    label: '謝罪メール（重大）',
    rule: '・迅速かつ誠実に謝罪する。問題の原因・今後の対応・再発防止策を具体的に示す'
  },
  onegai: {
    label: 'お願いメール',
    rule: '・相手にお願いする立場をわきまえ、丁寧に。なぜお願いしたいのか理由も添える'
  },
  henshin: {
    label: '返信メール',
    rule: '・相手のメールの内容に的確に応える。「ご連絡ありがとうございます」から始める'
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
  const scene = sceneMap[body.scene] ? body.scene : 'orei';
  const toName = typeof body.toName === 'string' ? body.toName.trim() : '';
  const rawText = typeof body.body === 'string' ? body.body.trim() : '';

  if (!rawText || rawText.length < 10) {
    return res.status(400).json({ error: '要件・内容を10文字以上入力してください。' });
  }
  if (rawText.length > 2000) {
    return res.status(400).json({ error: '要件は2000文字以内で入力してください。' });
  }

  const guard = await jevGuard(rawText);
  if (guard.blocked) {
    return res.status(422).json({
      error: '入力内容が意味のある文章ではないと判定されました。メールの要件・内容を入力してください。',
      guarded: true
    });
  }

  const s = sceneMap[scene];
  const system = 'あなたは日本のビジネスメール作成の専門家です。相手に失礼のない、自然で丁寧なビジネスメールを作成します。';
  const prompt = `次の情報から、ビジネスメールを作成してください。

【シーン】${s.label}
${s.rule}
・「件名」「宛名」「本文」「差出人」の順で出力する
・本文はです・ます調で、300〜600文字程度にまとめる
・時候の挨拶やクッション言葉を適切に入れる
・生成したメール本文だけを出力し、前置き・解説は一切付けない
・架空の会社名・個人名を勝手に作らない（差出人は「[あなたの名前]」としておく）

【宛名】${toName || '（未入力）'}
【要件・内容】
${rawText}

ビジネスメール:`;

  try {
    const { value: result, cached } = await cachedLlm(system, prompt, { maxTokens: 1200, temperature: 0.6 });
    return res.status(200).json({ result, scene, cached });
  } catch (e) {
    if (e.message === 'LLM_NO_KEY') {
      return res.status(200).json({ result: '（デモ:LLM未設定）Vercel環境変数 LLM_API_KEY を設定すると本番のメール生成が有効になります。', demo: true, scene });
    }
    return res.status(500).json({ error: 'メール生成に失敗しました。再度お試しください。' });
  }
}