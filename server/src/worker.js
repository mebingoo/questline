/**
 * Questline sync server (Cloudflare Worker)
 *
 * Three jobs:
 *   1. Serve the app itself (public/) so PC and phone always run the same version.
 *   2. Hold the single shared state blob in KV, so both devices see the same progress.
 *   3. Proxy WebUntis / YouTube / the AI provider, because a phone browser is
 *      blocked from calling those directly (CORS) while Electron is not.
 *
 * Every /api route requires the X-Questline-Token header to match the
 * SYNC_TOKEN secret, so the URL being public does not make the data public.
 */

const JSON_HEADERS = { 'Content-Type': 'application/json; charset=utf-8' };

function json(data, status = 200, extra = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...JSON_HEADERS, ...cors(), ...extra }
  });
}
function cors() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET,PUT,POST,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type,X-Questline-Token',
    'Access-Control-Max-Age': '86400'
  };
}
function authed(request, env) {
  const t = request.headers.get('X-Questline-Token') || '';
  const want = env.SYNC_TOKEN || '';
  if (!want) return false;
  // constant-ish time compare
  if (t.length !== want.length) return false;
  let diff = 0;
  for (let i = 0; i < t.length; i++) diff |= t.charCodeAt(i) ^ want.charCodeAt(i);
  return diff === 0;
}

const STATE_KEY = 'questline:state';

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;

    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors() });

    if (!path.startsWith('/api/')) {
      // Everything else is the app itself.
      return env.ASSETS.fetch(request);
    }

    if (path === '/api/ping') {
      return json({ ok: true, needsToken: !!env.SYNC_TOKEN, version: 1 });
    }

    if (!authed(request, env)) {
      return json({ ok: false, error: 'Wrong or missing sync token.' }, 401);
    }

    try {
      if (path === '/api/state' && request.method === 'GET') return await getState(env);
      if (path === '/api/state' && request.method === 'PUT') return await putState(request, env);
      if (path === '/api/untis/search' && request.method === 'POST') return await untisSearch(request);
      if (path === '/api/untis/sync' && request.method === 'POST') return await untisSync(request);
      if (path === '/api/yt/meta' && request.method === 'POST') return await ytMeta(request);
      if (path === '/api/yt/transcript' && request.method === 'POST') return await ytTranscript(request);
      if (path === '/api/ai/generate' && request.method === 'POST') return await aiGenerate(request);
      return json({ ok: false, error: 'Unknown endpoint ' + path }, 404);
    } catch (err) {
      return json({ ok: false, error: String((err && err.message) || err) }, 500);
    }
  }
};

/* ------------------------------------------------------------------ *
 * State: one blob, revision-guarded so a stale device can't clobber
 * a newer one without knowing it.
 * ------------------------------------------------------------------ */
async function getState(env) {
  const raw = await env.STATE.get(STATE_KEY);
  if (!raw) return json({ ok: true, empty: true, rev: 0, updatedAt: 0, data: null });
  const stored = JSON.parse(raw);
  return json({ ok: true, empty: false, rev: stored.rev || 0, updatedAt: stored.updatedAt || 0, data: stored.data });
}

async function putState(request, env) {
  const body = await request.json();
  const incomingRev = parseInt(body.rev, 10) || 0;
  const incomingAt = parseInt(body.updatedAt, 10) || 0;
  if (!body.data) return json({ ok: false, error: 'No data in request.' }, 400);

  const raw = await env.STATE.get(STATE_KEY);
  const stored = raw ? JSON.parse(raw) : { rev: 0, updatedAt: 0, data: null };

  // Accept when this write builds on what the server already has, or when the
  // caller explicitly forces (user chose "my version wins").
  const isNewer = incomingRev > (stored.rev || 0);
  if (!isNewer && !body.force) {
    return json({
      ok: false, conflict: true,
      error: 'The server has a newer version.',
      rev: stored.rev, updatedAt: stored.updatedAt, data: stored.data
    }, 409);
  }

  const next = {
    rev: Math.max(incomingRev, (stored.rev || 0) + 1),
    updatedAt: incomingAt || Date.now(),
    data: body.data
  };
  await env.STATE.put(STATE_KEY, JSON.stringify(next));
  return json({ ok: true, rev: next.rev, updatedAt: next.updatedAt });
}

/* ------------------------------------------------------------------ *
 * WebUntis proxy
 * ------------------------------------------------------------------ */
const RPC_ERRORS = {
  '-8500': 'That school key is not right. Use "Find my school" to fill it in.',
  '-8504': 'Login rejected — check your username and password.',
  '-8509': 'No permission for that data. Try your student login.',
  '-8998': 'WebUntis is busy right now. Try again in a moment.'
};

async function rpc(server, school, method, params, cookie) {
  const res = await fetch('https://' + server + '/WebUntis/jsonrpc.do?school=' + encodeURIComponent(school), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'User-Agent': 'Questline/1.0', ...(cookie ? { Cookie: cookie } : {}) },
    body: JSON.stringify({ id: 'questline', method, params: params || {}, jsonrpc: '2.0' })
  });
  const text = await res.text();
  let j = null;
  try { j = JSON.parse(text); } catch (e) {}
  if (j && j.error) {
    const c = String(j.error.code);
    throw new Error(RPC_ERRORS[c] || j.error.message || ('WebUntis error ' + c));
  }
  if (!j) throw new Error(res.status === 404 ? 'Not found at ' + server + ' — check the server address.' : 'Server did not return JSON (HTTP ' + res.status + ').');
  return j.result;
}

async function untisSearch(request) {
  const { query } = await request.json();
  if (!query || String(query).trim().length < 3) return json({ ok: false, error: 'Type at least 3 characters.' });
  const res = await fetch('https://mobile.webuntis.com/ms/schoolquery2', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'User-Agent': 'Questline/1.0' },
    body: JSON.stringify({ id: 'wu_schulsuche', method: 'searchSchool', params: [{ search: String(query).trim() }], jsonrpc: '2.0' })
  });
  const j = await res.json();
  if (j.error) {
    const m = j.error.message || '';
    return json({ ok: false, error: /too many/i.test(m) ? 'Too many matches — type more of the name.' : m });
  }
  const schools = (j.result && j.result.schools) || [];
  return json({
    ok: true,
    schools: schools.slice(0, 12).map(s => ({
      server: s.server, loginName: s.loginName, displayName: s.displayName, address: s.address || ''
    }))
  });
}

const byId = (list) => { const m = {}; (list || []).forEach(x => { m[x.id] = x; }); return m; };

async function untisSync(request) {
  const cfg = await request.json();
  if (!cfg.server || !cfg.school || !cfg.user) return json({ ok: false, error: 'Server, school and username are required.' });
  let cookie = null;
  try {
    const auth = await rpc(cfg.server, cfg.school, 'authenticate', { user: cfg.user, password: cfg.password || '', client: 'questline' });
    if (!auth || !auth.sessionId) return json({ ok: false, error: 'Login rejected — check username and password.' });
    cookie = 'JSESSIONID=' + auth.sessionId;

    const [subjects, teachers, rooms] = await Promise.all([
      rpc(cfg.server, cfg.school, 'getSubjects', {}, cookie).catch(() => []),
      rpc(cfg.server, cfg.school, 'getTeachers', {}, cookie).catch(() => []),
      rpc(cfg.server, cfg.school, 'getRooms', {}, cookie).catch(() => [])
    ]);
    const sm = byId(subjects), tm = byId(teachers), rm = byId(rooms);

    const raw = await rpc(cfg.server, cfg.school, 'getTimetable', {
      id: auth.personId, type: auth.personType, startDate: cfg.startDate, endDate: cfg.endDate
    }, cookie);

    const lessons = (raw || []).map(l => {
      const su = (l.su && l.su[0]) || {}, te = (l.te && l.te[0]) || {}, ro = (l.ro && l.ro[0]) || {};
      return {
        date: l.date, startTime: l.startTime, endTime: l.endTime,
        subject: su.name || (sm[su.id] && sm[su.id].name) || '?',
        teacher: te.name || (tm[te.id] && tm[te.id].name) || '',
        room: ro.name || (rm[ro.id] && rm[ro.id].name) || '',
        cancelled: l.code === 'cancelled'
      };
    }).filter(l => l.subject && l.subject !== '?');

    return json({ ok: true, lessons });
  } catch (err) {
    return json({ ok: false, error: String((err && err.message) || err) });
  } finally {
    if (cookie) { try { await rpc(cfg.server, cfg.school, 'logout', {}, cookie); } catch (e) {} }
  }
}

/* ------------------------------------------------------------------ *
 * YouTube proxy
 * ------------------------------------------------------------------ */
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0 Safari/537.36';

async function ytMeta(request) {
  const { videoId } = await request.json();
  if (!/^[\w-]{11}$/.test(String(videoId || ''))) return json({ ok: false, error: 'That does not look like a YouTube link.' });
  const r = await fetch('https://www.youtube.com/oembed?url=' +
    encodeURIComponent('https://www.youtube.com/watch?v=' + videoId) + '&format=json', { headers: { 'User-Agent': UA } });
  if (r.status === 401 || r.status === 403) return json({ ok: false, error: 'This video is private or embedding is blocked.' });
  if (r.status === 404) return json({ ok: false, error: 'Video not found — check the link.' });
  if (!r.ok) return json({ ok: false, error: 'YouTube returned HTTP ' + r.status + '.' });
  const j = await r.json();
  return json({
    ok: true,
    meta: {
      title: j.title || 'Untitled',
      author: j.author_name || '',
      thumb: j.thumbnail_url || ('https://i.ytimg.com/vi/' + videoId + '/hqdefault.jpg')
    }
  });
}

async function ytTranscript(request) {
  const { videoId } = await request.json();
  if (!/^[\w-]{11}$/.test(String(videoId || ''))) return json({ ok: false, error: 'Invalid video id.' });

  const page = await fetch('https://www.youtube.com/watch?v=' + videoId + '&hl=en', {
    headers: {
      'User-Agent': UA,
      'Accept-Language': 'en-US,en;q=0.9',
      'Cookie': 'CONSENT=YES+cb.20240101-00-p0.en+FX+000; SOCS=CAISEwgDEgk0ODE3Nzk3MjQaAmVuIAEaBgiA_LyaBg'
    }
  });
  const html = await page.text();

  let tracks = [];
  const m = html.match(/"captionTracks":(\[.*?\])/);
  if (m) { try { tracks = JSON.parse(m[1]); } catch (e) {} }
  if (!tracks.length) {
    const hasPlayer = /ytInitialPlayerResponse/.test(html);
    return json({
      ok: false,
      error: hasPlayer
        ? 'This video has no captions, so there is no transcript to pull.'
        : 'YouTube would not serve the page to the server (it blocks datacenter IPs). On your PC the desktop app fetches this directly instead.'
    });
  }

  const pick = tracks.find(t => t.languageCode === 'en' && t.kind !== 'asr')
    || tracks.find(t => t.languageCode === 'en')
    || tracks.find(t => t.languageCode === 'de')
    || tracks[0];

  const cr = await fetch(pick.baseUrl + '&fmt=json3', { headers: { 'User-Agent': UA } });
  if (!cr.ok) return json({ ok: false, error: 'Caption fetch failed (HTTP ' + cr.status + ').' });
  const cj = await cr.json();
  const cues = (cj.events || []).filter(e => e.segs).map(e => ({
    t: Math.round((e.tStartMs || 0) / 1000),
    text: e.segs.map(s => s.utf8).join('').replace(/\n/g, ' ').trim()
  })).filter(c => c.text);

  if (!cues.length) return json({ ok: false, error: 'Captions were empty.' });

  let duration = 0, title = '';
  const dm = html.match(/"lengthSeconds":"(\d+)"/); if (dm) duration = parseInt(dm[1], 10);
  const tm = html.match(/"title":"([^"]{1,200})"/); if (tm) title = tm[1];

  return json({ ok: true, cues, lang: pick.languageCode, auto: pick.kind === 'asr', duration, title });
}

/* ------------------------------------------------------------------ *
 * AI proxy — the key travels with the request and is never stored here.
 * ------------------------------------------------------------------ */
function buildPrompt(title, transcript, count) {
  return 'You are helping a student actively learn from a video tutorial.\n\n' +
    'VIDEO TITLE: ' + title + '\n\n' +
    'TRANSCRIPT (each line starts with its timestamp in seconds):\n' + transcript + '\n\n' +
    'Produce a JSON object with EXACTLY this shape and nothing else:\n' +
    '{\n  "summary": "3-5 sentence plain-English summary of what the video teaches",\n' +
    '  "keyPoints": ["4-7 short bullet points of the main takeaways"],\n' +
    '  "questions": [\n    {"difficulty":"easy","q":"question text","options":["A","B","C","D"],"correct":0,"why":"one sentence on why that answer is right","t":123}\n  ]\n}\n\n' +
    'Rules for the questions:\n' +
    '- Exactly ' + count + ' questions, ordered from easiest to hardest.\n' +
    '- Use these difficulty values in order: start with "easy", then "medium", then "hard", ending with at least two "expert".\n' +
    '- Easy = simple recall of something stated outright. Medium = understanding a concept in your own terms.\n' +
    '  Hard = applying it to a slightly new situation. Expert = reasoning about edge cases, trade-offs, or what would\n' +
    '  break if you did it differently. Expert questions may require combining two separate parts of the video.\n' +
    '- Every question must have exactly 4 options, with "correct" being the 0-based index of the right one.\n' +
    '- Wrong options must be genuinely plausible to someone who half-watched. Never use "all of the above" or joke options.\n' +
    '- "t" is the timestamp in seconds where the answer is covered, so the student can jump back.\n' +
    '- Base everything strictly on the transcript. Do not invent facts that are not in it.\n' +
    'Return ONLY the raw JSON object. No markdown fences, no commentary.';
}
function extractJSON(text) {
  if (!text) throw new Error('The AI returned an empty response.');
  let t = String(text).trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  const a = t.indexOf('{'), b = t.lastIndexOf('}');
  if (a === -1 || b === -1) throw new Error('The AI did not return JSON.');
  return JSON.parse(t.slice(a, b + 1));
}

async function aiGenerate(request) {
  const opts = await request.json();
  const key = String(opts.apiKey || '').trim();
  if (!key) return json({ ok: false, error: 'No API key set.' });
  if (!opts.transcript) return json({ ok: false, error: 'No transcript to work from.' });

  const count = Math.max(3, Math.min(20, parseInt(opts.count, 10) || 8));
  let transcript = String(opts.transcript);
  const LIMIT = 48000;
  if (transcript.length > LIMIT) {
    transcript = transcript.slice(0, Math.floor(LIMIT * 0.6)) +
      '\n...[middle of transcript trimmed for length]...\n' + transcript.slice(-Math.floor(LIMIT * 0.4));
  }
  const prompt = buildPrompt(opts.title || 'Untitled video', transcript, count);
  const isAnthropic = key.startsWith('sk-ant-');
  const model = String(opts.model || '').trim() || (isAnthropic ? 'claude-3-5-haiku-latest' : 'gpt-4o-mini');

  let text = '';
  if (isAnthropic) {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model, max_tokens: 4000, messages: [{ role: 'user', content: prompt }] })
    });
    const j = await r.json();
    if (j.error) return json({ ok: false, error: j.error.message || 'Anthropic error' });
    if (!r.ok) return json({ ok: false, error: 'Anthropic HTTP ' + r.status });
    text = (j.content || []).map(c => c.text || '').join('');
  } else {
    const r = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + key },
      body: JSON.stringify({ model, max_tokens: 4000, response_format: { type: 'json_object' }, messages: [{ role: 'user', content: prompt }] })
    });
    const j = await r.json();
    if (j.error) return json({ ok: false, error: j.error.message || 'OpenAI error' });
    if (!r.ok) return json({ ok: false, error: 'OpenAI HTTP ' + r.status });
    text = ((j.choices || [])[0] || {}).message ? j.choices[0].message.content : '';
  }

  let parsed;
  try { parsed = extractJSON(text); }
  catch (e) { return json({ ok: false, error: String(e.message || e) }); }

  const questions = (parsed.questions || []).filter(q =>
    q && typeof q.q === 'string' && Array.isArray(q.options) && q.options.length === 4 &&
    Number.isInteger(q.correct) && q.correct >= 0 && q.correct < 4
  ).map(q => ({
    difficulty: ['easy', 'medium', 'hard', 'expert'].includes(q.difficulty) ? q.difficulty : 'medium',
    q: String(q.q), options: q.options.map(String), correct: q.correct,
    why: String(q.why || ''), t: parseInt(q.t, 10) || 0
  }));
  if (!questions.length) return json({ ok: false, error: 'The AI returned no usable questions. Try again.' });

  return json({
    ok: true,
    summary: String(parsed.summary || ''),
    keyPoints: (parsed.keyPoints || []).map(String).slice(0, 10),
    questions
  });
}
