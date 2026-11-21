// Vercel Serverless Function: AI要約 API（URL自動取得／長文分割要約／構造化議事録対応 V1.4）
import {
  MIN_CHARS, SUMMARIZE_MAX_CHARS, CHUNK_CHARS, splitIntoChunks, buildSegments,
  assembleMeeting, jsonFromMarkdown, createRequestLogger,
  clientIp, extractUrls, resolveSourceText, jevGuard,
  enforceRateLimit, cachedLlm
} from './_lib.js';

const sceneMap = {
  report: 'レポート・報告書として、結論と根拠が伝わる構成で',
  minutes: '議事録として、決定事項・宿題・期限が分かる構成で',
  daily: '業務日報として、取り組んだ内容・成果・所感が伝わる形で',
  email: 'ビジネスメールとして、丁寧かつ簡潔な形で',
  general: '客観的で分かりやすい形で'
};

const SYSTEM_SUMMARY = 'あなたは日本語の要約専門家で、正確で読みやすい要約を書きます。';
const SYSTEM_PARTIAL = 'あなたは日本語の要約専門家です。長い文章の一部分を、後で全体統合する前提で正確に要約します。';
const SYSTEM_MEETING = 'あなたは日本語の議事録作成の専門家で、文字起こしを事実にもとづく構造化された議事録に変換します。推測で人名・日付・決定を補うことは決してしません。';

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  const body = req.body || {};
  const isMeeting = body.action === 'meeting' || body.structured === 'meeting';
  const log = createRequestLogger(req, isMeeting ? 'meeting_ja' : `summarize_ja:${sceneMap[body.scene] ? body.scene : 'general'}`);
  // 1リクエスト1行のログ（入力本文や結果は出さない）
  const rawJson = res.json.bind(res);
  let logged = false;
  const stats = {};
  res.json = (payload) => {
    if (!logged) {
      logged = true;
      log.emit(res.statusCode, {
        chars: stats.chars || 0,
        has_url: !!stats.hasUrl,
        cached: !!payload?.cached,
        demo: !!payload?.demo,
        structured: !!payload?.meeting,
        speakers: payload?.meeting?.speakers?.length
      });
    }
    return rawJson(payload);
  };

  const limit = enforceRateLimit(clientIp(req));
  if (!limit.allowed) {
    const msg = limit.reason === 'day'
      ? `本日のご利用回数が上限（${limit.limit}回）に達しました。日付が変わってから再度お試しください。`
      : 'リクエストが短時間に多すぎます。少し待ってから再度お試しください。';
    return res.status(429).json({ error: msg });
  }

  const rawText = typeof body.text === 'string' ? body.text.trim() : '';
  stats.chars = rawText.length;
  const maxLength = Number(body.max_length);
  const tone = body.tone === 'dearu' ? 'dearu' : 'desu';
  const keyword = typeof body.keyword === 'string' ? body.keyword.trim().slice(0, 30) : '';
  const ngword = typeof body.ngword === 'string' ? body.ngword.trim().slice(0, 30) : '';
  const scene = sceneMap[body.scene] ? body.scene : 'general';
  const outputForm = body.output_form === 'bullets' ? 'bullets' : 'paragraph';

  const hasUrl = extractUrls(rawText).length > 0;
  stats.hasUrl = hasUrl;
  if (!rawText || (rawText.length < MIN_CHARS && !hasUrl)) {
    return res.status(400).json({ error: `要約する文章またはURLを${MIN_CHARS}文字以上入力してください。URLのみの場合は短くても構いません。` });
  }
  if (rawText.length > SUMMARIZE_MAX_CHARS && !hasUrl) {
    return res.status(400).json({ error: `${SUMMARIZE_MAX_CHARS}文字以内で入力してください。それ以上の資料は章ごとに分けてご利用ください。` });
  }
  if (!isMeeting && (!Number.isFinite(maxLength) || maxLength < 50 || maxLength > 1000)) {
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

  // ---- 構造化議事録（日本語）: 話者・行内引用・決定/宿題/未解決/リスクの4区分 ----
  if (isMeeting) {
    try {
      const segments = buildSegments(source);
      const numbered = segments.map((s) => `[${s.id}] ${s.text}`).join('\n');
      const prompt = `次の会議の文字起こしを解析し、構造化された議事録として返してください。
各行には [1] [2] のような行番号が付いています。
マークダウンのコードフェンスを付けず、有効なJSONのみを次の形で返してください:
{"title":"会議タイトル（20文字以内）","speakers":["田中","佐藤"],"summary":"中立な1段落（80〜150文字、根拠の行番号を [n] で文中に付ける）","decisions":[{"text":"決定事項（根拠を [n] で付ける）","condition":"その決定が依存する前提条件。無ければ空文字"}],"action_items":[{"text":"動詞で始まるアクション（根拠を [n]）","owner":"担当者名または空文字","due":"期限または空文字"}],"open_questions":[{"text":"未解決の論点（根拠を [n]）"}],"risks":[{"text":"会議で挙がったリスクや懸念（根拠を [n]）"}]}
ルール:
- 文字起こしに書かれていない人名・日付・決定を創作しない。
- "speakers" には、コロンの前の話者名（「田中：」の「田中」）を初出順に列挙する。日本語名はそのまま表記する。
- 根拠は主張の直後に [3]、複数なら [3,5] の形で付ける。文字起こしに出ている番号だけを使う。
- summary と各項目には必ず1つ以上の根拠番号を付ける。
- 「〜かもしれない」「たぶん」「検討したい」は決定ではない。open_questions か risks に入れる。
- 決定に付随する条件（「〜が終わるまで」「〜の場合のみ」）は必ず condition に残す。
- owner と due は文字起こしに明記されている場合のみ。無ければ ""。
- 項目が無い区分は空配列を返す。キーは省略しない。
- 出力はすべて日本語。

---
${numbered}
---`;

      const r = await cachedLlm(SYSTEM_MEETING, prompt, { maxTokens: 2500, temperature: 0.2 });
      const obj = jsonFromMarkdown(r.value);
      const meeting = assembleMeeting(obj, segments);
      return res.status(200).json({ meeting, fetched, cached: r.cached });
    } catch (e) {
      if (e.message === 'LLM_NO_KEY') {
        return res.status(200).json({
          error: '[デモモード] LLM APIキーが未設定です。Vercel環境変数 LLM_API_KEY を設定すると本番の議事録作成が有効になります。',
          demo: true, fetched
        });
      }
      console.error('[MEETING_JA_ERROR]', e && e.message);
      return res.status(500).json({ error: '議事録の生成に失敗しました。再度お試しください。' });
    }
  }

  const toneText = tone === 'desu' ? '敬体（です・ます調）' : '常体（だ・である調）';
  const minLen = Math.max(40, Math.floor(maxLength * 0.8));
  const rules = [
    `・出力は${maxLength}文字を目標とし、原則として${minLen}文字以上${maxLength}文字以内に収める（元の文章の情報量が足りない場合を除く）`,
    `・文体は${toneText}`,
    `・${sceneMap[scene]}要約する`,
    '・要点と結論を漏らさず、重複を省く',
    '・要約文だけを出力し、前置きや解説は付けない'
  ];
  if (keyword) rules.push(`・キーワード「${keyword}」を自然に含める`);
  if (ngword) rules.push(`・「${ngword}」という語句は使わない`);
  if (outputForm === 'bullets') {
    rules.push('・出力形式は「リスト形式」とし、要点を4〜8個の「・」始まりの短い行で列挙する（接続の文章は付けない）');
  } else {
    rules.push('・出力形式は自然につながった1本の段落（まとまった文章）にする');
  }

  // 長文は分割→部分要約→統合（各チャンクもキャッシュ対象）
  const chunks = splitIntoChunks(source, CHUNK_CHARS);
  let chunked = 0;
  let sourceForFinal = source;
  let cached = false;
  try {
    if (chunks.length > 1) {
      chunked = chunks.length;
      const partials = [];
      for (let i = 0; i < chunks.length; i++) {
        const partPrompt = `次の文章は長い資料の一部です（全${chunks.length}分割中 ${i + 1} 番目）。
後で全体を統合する前提で、決定事項・数値・固有名詞・結論を落とさず、400文字以内で簡潔に要点をまとめてください。
出力は要約だけにしてください。

---
${chunks[i]}
---

部分要約:`;
        // eslint-disable-next-line no-await-in-loop
        const r = await cachedLlm(SYSTEM_PARTIAL, partPrompt, { maxTokens: 700, temperature: 0.2 });
        if (r.cached) cached = true;
        partials.push(r.value);
      }
      sourceForFinal = partials.map((p, i) => `【部分${i + 1}の要点】\n${p}`).join('\n\n');
    }

    const mergeNote = chunked
      ? `以下は長い文章を${chunked}分割して要約した中間結果です。内容の重複を統合し、全体の流れと結論が伝わる最終要約を作成してください。\n\n`
      : '';

    const prompt = `あなたは日本語の要約専門家です。次の文章（Webページ本文を含む）をルールに沿って要約してください。
${rules.join('\n')}

---
${mergeNote}${sourceForFinal}
---

要約文:`;

    const r = await cachedLlm(SYSTEM_SUMMARY, prompt, { maxTokens: 1200, temperature: 0.3 });
    cached = cached || r.cached;
    return res.status(200).json({ summary: r.value, fetched, cached, chunked, chunks: chunks.length });
  } catch (e) {
    if (e.message === 'LLM_NO_KEY') {
      return res.status(200).json({
        summary: '[デモモード] LLM APIキーが未設定です。Vercel環境変数 LLM_API_KEY を設定すると本番のAI要約が有効になります。',
        demo: true, fetched
      });
    }
    console.error('[SUMMARIZE_ERROR]', e && e.message);
    return res.status(500).json({ error: '要約の生成に失敗しました。再度お試しください。' });
  }
}
