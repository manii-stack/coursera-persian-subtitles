'use strict';

const DEFAULTS = {
  enabled: true,
  showEnglish: true,
  fontSize: 26,
  bottomOffset: 72,
  fontStack: '',
  keepTerms: true,
  model: 'gemini-3.5-flash-lite',
  apiKey: ''
};

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

// Is the font installed on this machine? Measure the text width against three base
// fonts; if it never differs, the browser fell back to the base, so the font is absent.
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

const $ = (id) => document.getElementById(id);
const statusEl = $('status');

function setStatus(text, cls) {
  statusEl.textContent = text || '';
  statusEl.className = cls || '';
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
  sel.value = selected || DEFAULTS.model;
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

async function load() {
  const got = await chrome.storage.local.get([...Object.keys(DEFAULTS), 'modelList']);
  const cfg = Object.assign({}, DEFAULTS, got);
  $('enabled').checked = !!cfg.enabled;
  $('showEnglish').checked = !!cfg.showEnglish;
  $('fontSize').value = cfg.fontSize;
  $('bottomOffset').value = cfg.bottomOffset;
  $('apiKey').value = cfg.apiKey || '';
  $('keepTerms').checked = cfg.keepTerms !== false;
  fillFonts(cfg.fontStack);
  fillModels(got.modelList, cfg.model);

  chrome.runtime.sendMessage({ type: 'cacheStats' }, (r) => {
    if (r && r.ok) $('cacheInfo').textContent = 'کش ترجمه: ' + r.count + ' دسته';
  });
}

// Instant changes — no save button needed
$('fontFamily').addEventListener('change', () =>
  chrome.storage.local.set({ fontStack: $('fontFamily').value }));

for (const id of ['enabled', 'showEnglish', 'keepTerms']) {
  $(id).addEventListener('change', () => chrome.storage.local.set({ [id]: $(id).checked }));
}
for (const id of ['fontSize', 'bottomOffset']) {
  $(id).addEventListener('input', () => chrome.storage.local.set({ [id]: Number($(id).value) }));
}

$('save').addEventListener('click', async () => {
  await chrome.storage.local.set({
    apiKey: $('apiKey').value.trim(),
    model: $('model').value
  });
  setStatus('ذخیره شد.', 'ok');
});

$('model').addEventListener('change', () => chrome.storage.local.set({ model: $('model').value }));

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
