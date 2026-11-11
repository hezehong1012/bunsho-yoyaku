// Vercel Serverless Function: English AI tool API for /en/
// One endpoint, action-based, with native English prompts written for a US/EU audience.
import {
  MIN_CHARS, SUMMARIZE_MAX_CHARS, CHUNK_CHARS, splitIntoChunks,
  MAX_CHARS, clientIp, extractUrls, resolveSourceText, jevGuard,
  enforceRateLimit, cachedLlm, jsonFromMarkdown
} from './_lib.js';

const SCENE = {
  general: 'plain, neutral English a busy professional can skim',
  report: 'a short business report section with the conclusion first and evidence second',
  minutes: 'meeting notes that make decisions, owners and due dates impossible to miss',
  daily: 'a day-end work log covering what got done, what slipped and what is next',
  email: 'a professional email a US or EU colleague would actually send (greeting, 2-3 short paragraphs, clear ask, sign-off)',
  social: 'a punchy LinkedIn-style post: one hook line, 3 short points, one takeaway'
};

const SYSTEM = {
  summarize: 'You are a senior editor who writes tight, accurate English summaries. You never invent facts and you never pad.',
  partial: 'You are a senior editor. You condense one section of a long document so the sections can be merged into a single summary later.',
  paraphrase: 'You are an English line editor who rewrites text so it reads better without changing meaning.',
  proofread: 'You are a meticulous English copy editor specializing in grammar, usage, punctuation and consistency of style.',
  email: 'You are an executive assistant who drafts clear, warm, professional English emails.',
  weekly: 'You are an operations lead who turns messy daily notes into a crisp weekly status update.',
  speech: 'You are a speechwriter for corporate and family occasions who writes in natural spoken English.',
  blog: 'You are an SEO content writer who drafts helpful, specific English blog posts without hype.'
};

const err = (res, code, message) => res.status(code).json({ error: message });

function toInt(v, d) {
  const n = Number(v);
  return Number.isFinite(n) ? Math.round(n) : d;
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return err(res, 405, 'Method not allowed');
  const limit = enforceRateLimit(clientIp(req));
  if (!limit.allowed) {
    return err(res, 429, limit.reason === 'day'
      ? `You have used today's free allowance (${limit.limit} runs). It resets at midnight JST — or use the Japanese site if you are in a hurry.`
      : 'Too many requests in a short window. Give it a few seconds and try again.');
  }

  const body = req.body || {};
  const action = typeof body.action === 'string' ? body.action : '';
  const text = typeof body.text === 'string' ? body.text.trim() : '';
  const urls = extractUrls(text || '');

  if (!Object.prototype.hasOwnProperty.call(SYSTEM, action)) return err(res, 400, 'Unknown action.');

  const allowed = ['paraphrase', 'proofread'].includes(action) ? MAX_CHARS : SUMMARIZE_MAX_CHARS;
  if (!text && !urls.length) return err(res, 400, 'Paste some text (or a public URL) first.');
  if (text.length < MIN_CHARS && !urls.length) return err(res, 400, `Please paste at least ${MIN_CHARS} characters — a single line of context is not enough to work with.`);
  if (text.length > allowed && !urls.length) return err(res, 400, `That is ${text.length.toLocaleString()} characters; the limit is ${allowed.toLocaleString()}. Split the document into sections and run them separately.`);

  const guard = await jevGuard(text);
  if (guard.blocked) return res.status(422).json({ error: 'This does not look like real text (it reads as spam or gibberish). Paste the actual content you want worked on.', guarded: true });

  try {
    switch (action) {
      case 'summarize': {
        let source = text;
        let fetched = [];
        if (urls.length) {
          const r = await resolveSourceText(text);
          source = r.text; fetched = r.fetched;
        }
        const target = Math.min(1000, Math.max(50, toInt(body.max_length, 250)));
        const floorLen = Math.max(40, Math.floor(target * 0.8));
        const style = body.style === 'plain' ? 'plain and direct — short sentences, active voice, no corporate filler' : 'professional and neutral — confident, no slang, no exclamation marks';
        const scene = SCENE[body.scene] || SCENE.general;
        const format = body.format === 'bullets'
          ? 'Output as a bullet list: 4 to 8 lines, each starting with "- ", no intro sentence.'
          : 'Output as ONE flowing paragraph, not a list.';
        const extra = [];
        if (body.keyword) extra.push(`Work the phrase "${String(body.keyword).slice(0, 40)}" in naturally.`);
        if (body.ngword) extra.push(`Do not use the word "${String(body.ngword).slice(0, 40)}".`);

        const rules = [
          `Aim for ${target} characters (stay between ${floorLen} and ${target} unless the source really is shorter).`,
          `Tone: ${style}.`,
          `Shape it as ${scene}.`,
          'Keep every hard fact — numbers, dates, names, decisions. Cut repetition, hedges and boilerplate.',
          'Return the work product only: no preamble, no "Here is a summary", no notes to the reader.',
          format, ...extra
        ].join('\n');

        const chunks = splitIntoChunks(source, CHUNK_CHARS);
        let chunked = 0;
        let input = source;
        let cached = false;
        if (chunks.length > 1) {
          chunked = chunks.length;
          const notes = [];
          for (let i = 0; i < chunks.length; i++) {
            const r = await cachedLlm(SYSTEM.partial, `Section ${i + 1} of ${chunks.length} of one long document.
Write at most 400 characters of working notes: keep decisions, numbers, names, dates and conclusions so the sections can be merged later. No headings, no commentary.

---
${chunks[i]}
---

Notes:`, { maxTokens: 700, temperature: 0.2 });
            if (r.cached) cached = true;
            notes.push(r.value);
          }
          input = notes.map((n, i) => `[Section ${i + 1} notes]\n${n}`).join('\n\n');
        }
        const prompt = `Summarize the text below (it may include web page body text).

Rules:
${rules}

${chunked ? `The text below is an intermediate result: ${chunked} sections already condensed. Merge them, remove duplication, and make the final summary read as one piece.\n\n` : ''}---
${input}
---

Summary:`;
        const r = await cachedLlm(SYSTEM.summarize, prompt, { maxTokens: 1200, temperature: 0.3 });
        return res.status(200).json({ result: r.value, fetched, cached: cached || r.cached, chunked, chunks: chunks.length });
      }

      case 'paraphrase': {
        const mode = body.mode === 'formal' ? 'more formal and polished' : body.mode === 'plain' ? 'simpler and plainer — imagine explaining it to a smart 12-year-old' : 'clearer and more natural without changing the level of formality';
        const prompt = `Rewrite the text so it is ${mode}. Keep every fact, number and name. Same language as the input. Return only the rewritten text.

---
${text}
---

Rewrite:`;
        const r = await cachedLlm(SYSTEM.paraphrase, prompt, { maxTokens: 1500, temperature: 0.4 });
        return res.status(200).json({ result: r.value, cached: r.cached });
      }

      case 'proofread': {
        const prompt = `Proofread the text. Fix spelling, grammar, punctuation, agreement, word choice and inconsistent style. Do not rewrite for taste and do not add content.
Return valid JSON only, no markdown fence, in this shape:
{"corrected":"the full corrected text","points":[{"original":"short excerpt as written","fixed":"the fixed excerpt","reason":"why, max 12 words"}]}
If the text is already clean, return the original text as "corrected" and an empty points array.

---
${text}
---`;
        const r = await cachedLlm(SYSTEM.proofread, prompt, { maxTokens: 1800, temperature: 0.2 });
        const obj = jsonFromMarkdown(r.value);
        return res.status(200).json({
          corrected: (obj && obj.corrected) || r.value,
          points: (obj && Array.isArray(obj.points)) ? obj.points : [],
          cached: r.cached
        });
      }

      case 'email': {
        const kind = String(body.kind || 'follow-up').slice(0, 40);
        const tone = body.style === 'casual' ? 'friendly but still workplace-appropriate' : 'professional and warm';
        const prompt = `Draft an email. Purpose: ${kind}. Tone: ${tone}.
Context the sender gave:
${text}

Requirements:
- Subject line on the first line, prefixed "Subject: ".
- Then the body: greeting, 2-3 short paragraphs, one clear ask or next step, sign-off.
- No placeholders like [Name] unless the sender's context leaves a real gap — then use "Name" once and keep it minimal.
- Keep it under 180 words. Plain English, no buzzwords, no emoji.
Output the email only.`;
        const r = await cachedLlm(SYSTEM.email, prompt, { maxTokens: 700, temperature: 0.4 });
        return res.status(200).json({ result: r.value, cached: r.cached });
      }

      case 'weekly': {
        const prompt = `Turn the notes below into a weekly status update a manager can read in 60 seconds.

Format:
## Highlights
- 2-4 bullets: outcomes, with numbers where the notes give them
## In progress
- bullets, each with the current state
## Risks and blockers
- bullets, or "None this week."
## Next week
- 2-4 bullets, each starting with a verb

Rules: use only facts in the notes, no invented metrics, no filler adjectives. Markdown only, no intro line.

Notes:
${text}`;
        const r = await cachedLlm(SYSTEM.weekly, prompt, { maxTokens: 900, temperature: 0.3 });
        return res.status(200).json({ result: r.value, cached: r.cached });
      }

      case 'speech': {
        const occasion = String(body.occasion || 'a short workplace toast').slice(0, 60);
        const minutes = Math.min(5, Math.max(1, toInt(body.minutes, 2)));
        const prompt = `Write a spoken ${occasion} of about ${minutes} minute(s) (roughly ${minutes * 130} words).

Requirements:
- Open with a concrete moment or detail, not "Today we gather".
- One short story or specific anecdote, then 2-3 points of appreciation or advice.
- Close with a line the audience can raise a glass to.
- Write for the ear: short sentences, contractions, no bullet points, no stage directions.
- Audience is a Western (US/EU) workplace or family gathering.

Context the speaker gave:
${text}

Output the speech only.`;
        const r = await cachedLlm(SYSTEM.speech, prompt, { maxTokens: 1200, temperature: 0.6 });
        return res.status(200).json({ result: r.value, cached: r.cached });
      }

      case 'blog': {
        const topic = String(body.topic || '').slice(0, 120) || text.slice(0, 120);
        const audience = String(body.audience || 'US/EU readers who found this via Google').slice(0, 80);
        const prompt = `Draft a blog post. Topic: ${topic}. Audience: ${audience}.
Brief from the writer:
${text}

Requirements:
- Working title as an H1 that promises a concrete outcome, under 65 characters, no clickbait.
- 600-900 words in Markdown with 2-3 H2 sections and at least one practical checklist or steps list.
- Answer the main question in the first 80 words, then expand.
- Concrete examples over generalities; no "in today's fast-paced world" openings.
- End with a short FAQ of 3 questions a searcher would actually type.
Output the post only.`;
        const r = await cachedLlm(SYSTEM.blog, prompt, { maxTokens: 1800, temperature: 0.5 });
        return res.status(200).json({ result: r.value, cached: r.cached });
      }

      default:
        return err(res, 400, 'Unknown action.');
    }
  } catch (e) {
    if (e && e.message === 'LLM_NO_KEY') return err(res, 503, 'AI is not configured on this deployment yet.');
    if (e && e.message === 'FETCH_NO_KEY') return err(res, 503, 'URL fetching is unavailable right now — paste the text instead.');
    console.error('[EN_TOOL_ERROR]', action, e && e.message);
    return err(res, 500, 'Generation failed. Please try again.');
  }
}
