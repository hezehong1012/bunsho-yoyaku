// Vercel Serverless Function: 乾杯挨拶 例文生成API
// シーン選択（歓迎会/送別会/忘年会/新年会/結婚式・二次会/懇親会）＋任意の主賓名・伝えたいこと
import { clientIp, jevGuard, enforceRateLimit, cachedLlm } from './_lib.js';

export const config = { maxDuration: 60 };

const SCENE_MAP = {
  welcome: {
    label: '歓迎会（新しいメンバーを迎える）',
    rule: '新しい仲間を温かく迎え入れる。相手の名前を呼び、今後の活躍への期待を伝える'
  },
  farewell: {
    label: '送別会（異動・退職）',
    rule: '在籍中の貢献への感謝と、新しい環境での活躍を願う気持ちを伝える。寂しさと温かさを両立させる'
  },
  bonenkai: {
    label: '忘年会',
    rule: '一年の労をねぎらう。明るく軽快に、笑いを少し入れつつ締める'
  },
  shinnenkai: {
    label: '新年会',
    rule: '新しい年の始まりを祝う。今年の抱負とチームの結束を語る'
  },
  wedding: {
    label: '結婚式・二次会',
    rule: '二人の門出を祝福する。人柄やエピソードに軽く触れ、温かい気持ちが伝わるように'
  },
  party: {
    label: '懇親会・立食パーティー',
    rule: '初対面が多い場。全員が聞きやすく、すぐ乾杯できる短い挨拶にする'
  }
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
  const sceneKey = SCENE_MAP[body.scene] ? body.scene : 'welcome';
  const guest = typeof body.guest === 'string' ? body.guest.trim() : '';
  const note = typeof body.note === 'string' ? body.note.trim() : '';

  if (guest.length > 100) {
    return res.status(400).json({ error: '主賓の名前・会社名は100文字以内で入力してください。' });
  }
  if (note.length > 500) {
    return res.status(400).json({ error: '伝えたいことは500文字以内で入力してください。' });
  }

  if (note.length >= 10) {
    const guard = await jevGuard(note);
    if (guard.blocked) {
      return res.status(422).json({
        error: '入力内容が意味のある文章ではないと判定されました。伝えたいことを入力してください。',
        guarded: true
      });
    }
  }

  const scene = SCENE_MAP[sceneKey];
  const system = 'あなたは日本の挨拶スピーチの専門家です。場の空気に合った、そのまま読める自然な乾杯挨拶を作ります。';
  const prompt = `次の条件で、乾杯の挨拶の例文を作ってください。

【シーン】${scene.label}
${scene.rule}
【主賓・会社名】${guest || '（指定なし）'}
【伝えたいこと・エピソード】${note || '（指定なし）'}

出力ルール:
・「【30秒ショート版】」の見出しの下に80〜130字の挨拶を1つ
・「【標準版（1分）】」の見出しの下に200〜300字の挨拶を1つ
・どちらも「それでは、乾杯！」で締める
・話し言葉として自然に。漢字の読みで詰まらない、短い文で区切る
・「〇〇様」など相手を呼ぶ一文を入れる（主賓名の指定があれば必ず使う）
・前置き・解説・補足コメントは一切書かない
・実在しない会社名・個人名・エピソードを作らない

挨拶例文:`;

  try {
    const { value: result, cached } = await cachedLlm(system, prompt, { maxTokens: 1400, temperature: 0.7 });
    return res.status(200).json({ result, cached, scene: sceneKey });
  } catch (e) {
    if (e.message === 'LLM_NO_KEY') {
      return res.status(200).json({
        result: '（デモ:LLM未設定）Vercel環境変数 LLM_API_KEY を設定すると本番の例文生成が有効になります。',
        demo: true,
        scene: sceneKey
      });
    }
    console.error('[SPEECH_FAIL]', e && e.message, e && e.stack);
    return res.status(500).json({ error: '挨拶例文の生成に失敗しました。再度お試しください。', debug: String(e && e.message) });
  }
}
