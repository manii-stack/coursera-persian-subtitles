'use strict';

/* Settings panel.
 *
 * Global settings (key, model, terms switch, master on/off) apply everywhere.
 * Appearance settings are stored per site under "site:<id>", because the
 * players differ — the control bar of one site sits higher than another's.
 * The active tab is asked which site it is on, so the panel edits that site.
 */

const GLOBAL_DEFAULTS = {
  enabled: true,
  keepTerms: true,
  model: 'gemini-3.5-flash-lite',
  apiKey: ''
};

// Mirrors the SITES table in content.js
const SITE_DEFAULTS = {
  coursera: { bottomOffset: 72 },
  vimeo: { bottomOffset: 64 }
};

const APPEARANCE_DEFAULTS = {
  showEnglish: true,
  fontSize: 26,
  bottomOffset: 72,
  fontStack: ''
};
const APPEARANCE_KEYS = Object.keys(APPEARANCE_DEFAULTS);

const FALLBACK_MODELS = [
  'gemini-3.5-flash-lite',
  'gemini-2.5-flash',
  'gemini-2.5-flash-lite',
  'gemini-2.0-flash'
];

// Shared tail for every choice, so the text never breaks if the font is missing
const FONT_TAIL = '"SF Pro Text", "Segoe UI", Tahoma, "Geeza Pro", sans-serif';

const FONTS = [
  { probe: null,        label: 'پیش‌فرض سیستم' },
  { probe: 'Vazirmatn', label: 'Vazirmatn' },
  { probe: 'IRANSans',  label: 'IRANSans' },
  { probe: 'IRANYekan', label: 'IRANYekan' },
  { probe: 'Shabnam',   label: 'Shabnam' },
  { probe: 'Sahel',     label: 'Sahel' },
  { probe: 'Estedad',   label: 'Estedad' },
  { probe: 'B Nazanin', label: 'B Nazanin' },
  { probe: 'Tahoma',    label: 'Tahoma' },
  { probe: 'Geeza Pro', label: 'Geeza Pro' },
  { probe: 'Segoe UI',  label: 'Segoe UI' }
];

const stackFor = (probe) => (probe ? '"' + probe + '", ' + FONT_TAIL : '');

const $ = (id) => document.getElementById(id);
const statusEl = $('status');

let siteId = null;   // null means the active tab is not a supported site

function setStatus(text, cls) {
  statusEl.textContent = text || '';
  statusEl.className = cls || '';
}

// Is the font installed on this machine? Measure the text width against three
// base fonts; if it never differs, the browser fell back, so the font is absent.
function fontAvailable(name) {
  const sample = 'آزمایش فونت Wgi ۱۲۳';
  const ctx = document.createElement('canvas').getContext('2d');
  return ['monospace', 'sans-serif', 'serif'].some((base) => {
    ctx.font = '72px ' + base;
    const w0 = ctx.measureText(sample).width;
    ctx.font = '72px "' + name + '", ' + base;
    return Math.abs(ctx.measureText(sample).width - w0) > 0.5;
  });
}

function fillFonts(selectedStack) {
  const sel = $('fontFamily');
  sel.innerHTML = '';
  let missing = 0;
  for (const f of FONTS) {
    const have = !f.probe || fontAvailable(f.probe);
    if (!have) missing++;
    const o = document.createElement('option');
    o.value = stackFor(f.probe);
    o.textContent = f.label + (have ? '' : ' (نصب نیست)');
    o.disabled = !have;
    if (f.probe) o.style.fontFamily = stackFor(f.probe);
    sel.appendChild(o);
  }
  // if the saved choice is no longer available, fall back to the default
  sel.value = selectedStack || '';
  if (sel.selectedIndex < 0 || sel.options[sel.selectedIndex].disabled) sel.value = '';
  $('fontHint').textContent = missing
    ? 'فونت‌های نصب‌نشده غیرفعال‌اند. Vazirmatn را می‌توانید از vazirmatn.com نصب کنید.'
    : '';
}

function fillModels(list, selected) {
  const sel = $('model');
  const models = Array.from(new Set([...(list || []), ...FALLBACK_MODELS, selected].filter(Boolean)));
  sel.innerHTML = '';
  for (const m of models) {
    const o = document.createElement('option');
    o.value = m; o.textContent = m;
    sel.appendChild(o);
  }
  sel.value = selected || GLOBAL_DEFAULTS.model;
}

/* ------------------------------------------------------- site detection */

function detectSite() {
  return new Promise((resolve) => {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      const tab = tabs && tabs[0];
      if (!tab) return resolve(null);
      try {
        chrome.tabs.sendMessage(tab.id, { type: 'whichSite' }, (res) => {
          void chrome.runtime.lastError;   // no content script on this page
          resolve(res && res.id ? res : null);
        });
      } catch (e) {
        resolve(null);
      }
    });
  });
}

/* ------------------------------------------------------------- settings */

// Same merge order as content.js, so panel and page always agree
function effectiveAppearance(stored) {
  const legacy = {};
  for (const k of APPEARANCE_KEYS) {
    if (stored[k] !== undefined) legacy[k] = stored[k];
  }
  return Object.assign(
    {},
    APPEARANCE_DEFAULTS,
    (siteId && SITE_DEFAULTS[siteId]) || {},
    legacy,
    (siteId && stored['site:' + siteId]) || {}
  );
}

async function saveAppearance(key, value) {
  if (!siteId) return;
  const k = 'site:' + siteId;
  const got = await chrome.storage.local.get(k);
  const next = Object.assign({}, got[k] || {}, { [key]: value });
  await chrome.storage.local.set({ [k]: next });
}

async function load() {
  const site = await detectSite();
  siteId = site && site.id;

  const line = $('siteLine');
  if (siteId) {
    line.className = 'siteline';
    line.innerHTML = 'سایت این تب: <b></b> — تنظیمات ظاهری فقط برای همین سایت ذخیره می‌شود.';
    line.querySelector('b').textContent = site.label;
  } else {
    line.className = 'siteline off';
    line.innerHTML = '<b>این صفحه پشتیبانی نمی‌شود.</b> فعلاً Coursera و Vimeo. تنظیمات ترجمه را همین‌جا می‌توانید عوض کنید.';
    $('appearance').classList.add('dim');
  }

  const stored = await chrome.storage.local.get(null);
  const g = Object.assign({}, GLOBAL_DEFAULTS, {
    enabled: stored.enabled,
    keepTerms: stored.keepTerms,
    model: stored.model,
    apiKey: stored.apiKey
  });
  const a = effectiveAppearance(stored);

  $('enabled').checked = g.enabled !== false;
  $('keepTerms').checked = g.keepTerms !== false;
  $('apiKey').value = g.apiKey || '';
  $('showEnglish').checked = a.showEnglish !== false;
  $('fontSize').value = a.fontSize;
  $('bottomOffset').value = a.bottomOffset;
  fillFonts(a.fontStack);
  fillModels(stored.modelList, g.model || GLOBAL_DEFAULTS.model);

  chrome.runtime.sendMessage({ type: 'cacheStats' }, (r) => {
    void chrome.runtime.lastError;
    if (r && r.ok) $('cacheInfo').textContent = 'کش ترجمه: ' + r.count + ' دسته';
  });
}

/* -------------------------------------------------------------- wiring */

// Instant changes — no save button needed
$('enabled').addEventListener('change', () =>
  chrome.storage.local.set({ enabled: $('enabled').checked }));
$('keepTerms').addEventListener('change', () =>
  chrome.storage.local.set({ keepTerms: $('keepTerms').checked }));

$('showEnglish').addEventListener('change', () =>
  saveAppearance('showEnglish', $('showEnglish').checked));
$('fontSize').addEventListener('input', () =>
  saveAppearance('fontSize', Number($('fontSize').value)));
$('bottomOffset').addEventListener('input', () =>
  saveAppearance('bottomOffset', Number($('bottomOffset').value)));
$('fontFamily').addEventListener('change', () =>
  saveAppearance('fontStack', $('fontFamily').value));

$('model').addEventListener('change', () =>
  chrome.storage.local.set({ model: $('model').value }));

$('save').addEventListener('click', async () => {
  await chrome.storage.local.set({
    apiKey: $('apiKey').value.trim(),
    model: $('model').value
  });
  setStatus('ذخیره شد.', 'ok');
});

$('test').addEventListener('click', async () => {
  await chrome.storage.local.set({ apiKey: $('apiKey').value.trim(), model: $('model').value });
  setStatus('در حال آزمایش…', '');
  $('test').disabled = true;
  chrome.runtime.sendMessage({ type: 'testKey' }, (r) => {
    $('test').disabled = false;
    if (r && r.ok) setStatus('کلید کار می‌کند ✓  نمونه: ' + r.sample, 'ok');
    else setStatus('ناموفق: ' + ((r && r.error) || 'پاسخی نیامد'), 'err');
  });
});

$('refresh').addEventListener('click', async () => {
  await chrome.storage.local.set({ apiKey: $('apiKey').value.trim() });
  setStatus('در حال گرفتن فهرست مدل‌ها…', '');
  $('refresh').disabled = true;
  chrome.runtime.sendMessage({ type: 'listModels' }, async (r) => {
    $('refresh').disabled = false;
    if (r && r.ok) {
      await chrome.storage.local.set({ modelList: r.models });
      fillModels(r.models, $('model').value);
      setStatus(r.models.length + ' مدل پیدا شد.', 'ok');
    } else {
      setStatus('ناموفق: ' + ((r && r.error) || 'پاسخی نیامد'), 'err');
    }
  });
});

$('clear').addEventListener('click', () => {
  chrome.runtime.sendMessage({ type: 'clearCache' }, (r) => {
    if (r && r.ok) {
      $('cacheInfo').textContent = 'کش ترجمه: ۰ دسته';
      setStatus(r.removed + ' دسته پاک شد.', 'ok');
    }
  });
});

load();
