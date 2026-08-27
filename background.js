'use strict';

/* =========================================================================
 * Coursera Persian Subtitles — service worker
 *
 * What this file does:
 *   - receives the array of English subtitle lines from the content script
 *   - translates them in batches with Google AI (Gemini), delivering results as they arrive
 *   - keeps a translation cache in chrome.storage.local so re-watching is free
 *
 * The API key is read only here; the content script never sees it.
 * ========================================================================= */

const API_BASE = 'https://generativelanguage.googleapis.com/v1beta';
const DEFAULT_MODEL = 'gemini-3.5-flash-lite';
const BATCH_LINES = 40;        // subtitle lines per request
const CONTEXT_LINES = 3;       // preceding lines sent as context (never translated)
const MAX_CACHE_ENTRIES = 600; // cap on the number of cached batches

// Two variants of rule 4 — the "technical terms" switch in the popup selects between them.
// Each variant gets its own cache key, otherwise flipping the switch would return the old
// translation straight from the cache and look like it had no effect.
const TERMS_RULE = {
  keep: [
    '4. Do NOT translate technical, product or brand terms. Keep them in their original Latin',
    '   script inside the Persian sentence (for example: AI, prompt, model, dataset, API,',
    '   machine learning, Google Workspace, Gemini). Inflect only the Persian around them so',
    '   the sentence still reads as fluent, natural Persian.'
  ],
  adapt: [
    '4. Technical and product terms: use the form Persian speakers actually use — either the',
    '   standard Persian term (AI → هوش مصنوعی) or the Latin original when that is what people',
    '   say (prompt → پرامپت، Google Workspace → Google Workspace، Gemini → Gemini).'
  ]
};

function buildSystemPrompt(keepTerms) {
  return [
    'You translate English subtitle lines from online course videos into natural, fluent Persian (Farsi).',
    '',
    'Input: a JSON object with "context" (previous English lines, for continuity only) and "lines"',
    '(a JSON array of English subtitle lines to translate, in order).',
    'Output: a JSON array of Persian strings.',
    '',
    'Hard rules:',
    '1. The output array MUST contain exactly one element per element of "lines", in the same order.',
    '   Never merge, split, drop, reorder or add lines. Never translate the "context" lines.',
    '2. Each line is a subtitle fragment and a sentence usually continues across several lines.',
    '   Translate so the lines read correctly when played in sequence, but keep the fragment boundaries.',
    '3. Fluency comes first. Write the Persian a person would actually say, not a word-by-word',
    '   rendering of the English. Use the ZWNJ correctly (می‌شود، می‌کنیم).'
  ].concat(keepTerms ? TERMS_RULE.keep : TERMS_RULE.adapt).concat([
    '5. Keep numbers, URLs, file names and code identifiers unchanged.',
    '6. A line that is only a marker such as "[MUSIC]" or "- " becomes a short Persian equivalent',
    '   (for example «[موسیقی]») or an empty string.',
    '7. Plain text only: no numbering, no surrounding quotes, no notes, no explanations.'
  ]).join('\n');
}

/* ---------------------------------------------------------------- utils */

// cyrb53 — fast 53-bit hash used for cache keys
function hash(str) {
  let h1 = 0xdeadbeef, h2 = 0x41c6ce57;
  for (let i = 0; i < str.length; i++) {
    const ch = str.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function safePost(port, msg) {
  try { port.postMessage(msg); return true; } catch (e) { return false; }
}

/* ---------------------------------------------------------------- cache */

async function cacheGet(key) {
  const got = await chrome.storage.local.get(key);
  return got[key] || null;
}

async function cacheSet(key, texts) {
  await chrome.storage.local.set({ [key]: { texts, ts: Date.now() } });
  pruneCache().catch(() => {});
}

let pruning = false;
async function pruneCache() {
  if (pruning) return;
  pruning = true;
  try {
    const all = await chrome.storage.local.get(null);
    const keys = Object.keys(all).filter((k) => k.startsWith('tb:'));
    if (keys.length <= MAX_CACHE_ENTRIES) return;
    keys.sort((a, b) => (all[a].ts || 0) - (all[b].ts || 0));
    await chrome.storage.local.remove(keys.slice(0, keys.length - MAX_CACHE_ENTRIES));
  } finally {
    pruning = false;
  }
}

/* ------------------------------------------------------------ Gemini API */

function extractText(data) {
  const parts = data?.candidates?.[0]?.content?.parts;
  if (!Array.isArray(parts)) return '';
  return parts.map((p) => p.text || '').join('');
}

function describeError(status, data) {
  const m = data?.error?.message;
  if (m) return m;
  if (status === 400) return 'درخواست نامعتبر (کلید API یا نام مدل را بررسی کنید).';
  if (status === 403) return 'دسترسی رد شد — کلید API معتبر نیست یا فعال نشده است.';
  if (status === 404) return 'این مدل در دسترس کلید شما نیست.';
  if (status === 429) return 'محدودیت نرخ Google AI (سهمیه‌ی رایگان). کمی بعد دوباره تلاش کنید.';
  return 'خطای HTTP ' + status;
}

async function callGemini(apiKey, model, lines, context, keepTerms) {
  const body = {
    systemInstruction: { parts: [{ text: buildSystemPrompt(keepTerms) }] },
    contents: [{
      role: 'user',
      parts: [{ text: JSON.stringify({ context, lines }) }]
    }],
    generationConfig: {
      temperature: 0.3,
      responseMimeType: 'application/json',
      responseSchema: { type: 'ARRAY', items: { type: 'STRING' } }
    }
  };

  const res = await fetch(
    API_BASE + '/models/' + encodeURIComponent(model) + ':generateContent',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
      body: JSON.stringify(body)
    }
  );

  let data = null;
  try { data = await res.json(); } catch (e) { /* non-JSON body */ }

  if (!res.ok) {
    const err = new Error(describeError(res.status, data));
    err.status = res.status;
    throw err;
  }

  const raw = extractText(data);
  let out;
  try {
    out = JSON.parse(raw);
  } catch (e) {
    // the model sometimes wraps the array in a code block
    const m = raw.match(/\[[\s\S]*\]/);
    if (!m) throw new Error('پاسخ مدل قابل تجزیه نبود.');
    out = JSON.parse(m[0]);
  }
  if (!Array.isArray(out)) throw new Error('پاسخ مدل آرایه نبود.');
  return out.map((x) => (typeof x === 'string' ? x : String(x ?? '')));
}

// Align the output length with the input: pad when short, truncate when long.
function align(out, lines) {
  if (out.length === lines.length) return out;
  const fixed = out.slice(0, lines.length);
  while (fixed.length < lines.length) fixed.push('');
  return fixed;
}

async function translateBatch(apiKey, model, lines, context, keepTerms) {
  const key = 'tb:' + model + ':' + (keepTerms ? 'k1' : 'k0') + ':' + hash(JSON.stringify(lines));
  const hit = await cacheGet(key);
  if (hit && Array.isArray(hit.texts) && hit.texts.length === lines.length) {
    return { texts: hit.texts, cached: true };
  }

  let lastErr = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      let out = await callGemini(apiKey, model, lines, context, keepTerms);
      if (out.length !== lines.length && attempt === 0) {
        // one more attempt with the same input — the second usually aligns
        out = await callGemini(apiKey, model, lines, context, keepTerms);
      }
      const texts = align(out, lines);
      await cacheSet(key, texts);
      return { texts, cached: false };
    } catch (e) {
      lastErr = e;
      // only transient errors are worth retrying
      if (e.status === 429 || e.status === 500 || e.status === 503 || !e.status) {
        await sleep([2000, 6000, 15000][attempt]);
        continue;
      }
      throw e;
    }
  }
  throw lastErr || new Error('ترجمه ناموفق بود.');
}

/* ------------------------------------------------------------ port jobs */

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== 'coursera-fa-sub') return;

  let cancelled = false;
  port.onDisconnect.addListener(() => { cancelled = true; });

  port.onMessage.addListener((msg) => {
    if (msg && msg.type === 'translate') {
      runJob(port, msg, () => cancelled).catch((e) => {
        safePost(port, { type: 'error', code: 'internal', message: String(e && e.message || e) });
      });
    }
  });
});

async function runJob(port, msg, isCancelled) {
  const lines = Array.isArray(msg.lines) ? msg.lines : [];
  if (!lines.length) { safePost(port, { type: 'done', total: 0 }); return; }

  const cfg = await chrome.storage.local.get(['apiKey', 'model', 'keepTerms']);
  const model = cfg.model || DEFAULT_MODEL;
  const keepTerms = cfg.keepTerms !== false;
  if (!cfg.apiKey) {
    safePost(port, { type: 'error', code: 'nokey', message: 'کلید Google AI تنظیم نشده است.' });
    return;
  }

  const batches = [];
  for (let i = 0; i < lines.length; i += BATCH_LINES) {
    batches.push({ from: i, lines: lines.slice(i, i + BATCH_LINES) });
  }

  // Start with the batch being watched, move forward, then wrap around to the earlier ones
  const startB = Math.min(batches.length - 1, Math.max(0, Math.floor((msg.startIndex || 0) / BATCH_LINES)));
  const order = [];
  for (let k = 0; k < batches.length; k++) order.push(batches[(startB + k) % batches.length]);

  safePost(port, { type: 'start', total: batches.length });

  let done = 0;
  for (const b of order) {
    if (isCancelled()) return;
    const context = lines.slice(Math.max(0, b.from - CONTEXT_LINES), b.from);
    try {
      const { texts, cached } = await translateBatch(cfg.apiKey, model, b.lines, context, keepTerms);
      if (isCancelled()) return;
      done++;
      if (!safePost(port, { type: 'batch', from: b.from, texts, done, total: batches.length, cached })) return;
    } catch (e) {
      safePost(port, {
        type: 'error',
        code: e.status === 429 ? 'rate' : 'api',
        message: String(e && e.message || e),
        done,
        total: batches.length
      });
      return;
    }
  }
  safePost(port, { type: 'done', total: batches.length });
}

/* --------------------------------------------------------- popup helpers */

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || !msg.type) return;

  if (msg.type === 'listModels') {
    (async () => {
      const cfg = await chrome.storage.local.get(['apiKey']);
      if (!cfg.apiKey) return sendResponse({ ok: false, error: 'ابتدا کلید API را ذخیره کنید.' });
      try {
        const res = await fetch(API_BASE + '/models?pageSize=200', {
          headers: { 'x-goog-api-key': cfg.apiKey }
        });
        const data = await res.json();
        if (!res.ok) return sendResponse({ ok: false, error: describeError(res.status, data) });
        const models = (data.models || [])
          .filter((m) => (m.supportedGenerationMethods || []).includes('generateContent'))
          .map((m) => String(m.name || '').replace(/^models\//, ''))
          .filter((n) => /gemini/i.test(n) && !/embedding|aqa|vision/i.test(n))
          .sort();
        sendResponse({ ok: true, models });
      } catch (e) {
        sendResponse({ ok: false, error: String(e && e.message || e) });
      }
    })();
    return true;
  }

  if (msg.type === 'testKey') {
    (async () => {
      const cfg = await chrome.storage.local.get(['apiKey', 'model', 'keepTerms']);
      if (!cfg.apiKey) return sendResponse({ ok: false, error: 'ابتدا کلید API را ذخیره کنید.' });
      try {
        const out = await callGemini(
          cfg.apiKey,
          cfg.model || DEFAULT_MODEL,
          ['Hello and welcome to this course.'],
          [],
          cfg.keepTerms !== false
        );
        sendResponse({ ok: true, sample: out[0] || '' });
      } catch (e) {
        sendResponse({ ok: false, error: String(e && e.message || e) });
      }
    })();
    return true;
  }

  if (msg.type === 'clearCache') {
    (async () => {
      const all = await chrome.storage.local.get(null);
      const keys = Object.keys(all).filter((k) => k.startsWith('tb:'));
      if (keys.length) await chrome.storage.local.remove(keys);
      sendResponse({ ok: true, removed: keys.length });
    })();
    return true;
  }

  if (msg.type === 'cacheStats') {
    (async () => {
      const all = await chrome.storage.local.get(null);
      const keys = Object.keys(all).filter((k) => k.startsWith('tb:'));
      sendResponse({ ok: true, count: keys.length });
    })();
    return true;
  }
});
