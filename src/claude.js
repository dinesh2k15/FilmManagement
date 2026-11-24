import { HttpError } from './permissions.js';

const PROMPT = `You are a first assistant director on an Indian film. Break down the scene text below for production.
The text may be in Telugu, Tamil, Hindi, Kannada, Malayalam or English, or a mix.
Reply with JSON only, no prose, in this shape:
{"scenes":[{"heading":"scene heading in English, e.g. EXT. RAILWAY STATION - NIGHT","intExt":"INT or EXT","dayNight":"DAY or NIGHT","location":"in English","language":"language of the text","characters":["names, with ages if given"],"props":[],"costumes":[],"special":["rain, stunts, VFX, song, crowd, animals, vehicles"],"pages":"length in eighths, e.g. 6/8","summary_en":"two sentences in English"}]}`;

/** Calls the Claude Messages API. Needs ANTHROPIC_API_KEY; the model can be set with SLATE_MODEL. */
export async function breakdownScene(sceneText, { fetchImpl = fetch } = {}) {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) throw new HttpError(503, 'Script breakdown is not set up: add ANTHROPIC_API_KEY on the server');
  const res = await fetchImpl('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({
      model: process.env.SLATE_MODEL || 'claude-sonnet-5-5',
      max_tokens: 2000,
      messages: [{ role: 'user', content: `${PROMPT}\n\nSCENE TEXT:\n${sceneText}` }],
    }),
  });
  if (!res.ok) throw new HttpError(502, `Claude returned ${res.status}`);
  const body = await res.json();
  const out = (body.content || []).filter(b => b.type === 'text').map(b => b.text).join('');
  const json = out.slice(out.indexOf('{'), out.lastIndexOf('}') + 1);
  try {
    const parsed = JSON.parse(json);
    if (!Array.isArray(parsed.scenes)) throw new Error();
    return parsed.scenes.slice(0, 50);
  } catch {
    throw new HttpError(502, 'Claude did not return a readable breakdown. Try again.');
  }
}
