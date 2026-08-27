'use strict';

const DEFAULTS = {
  enabled: true,
  showEnglish: true,
  fontSize: 26,
  bottomOffset: 72,
  model: 'gemini-2.5-flash',
  apiKey: ''
};

const FALLBACK_MODELS = [
  'gemini-2.5-flash',
  'gemini-2.5-flash-lite',
  'gemini-2.0-flash'
];

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

async function load() {
  const got = await chrome.storage.local.get([...Object.keys(DEFAULTS), 'modelList']);
  const cfg = Object.assign({}, DEFAULTS, got);
  $('enabled').checked = !!cfg.enabled;
  $('showEnglish').checked = !!cfg.showEnglish;
  $('fontSize').value = cfg.fontSize;
  $('bottomOffset').value = cfg.bottomOffset;
  $('apiKey').value = cfg.apiKey || '';
  fillModels(got.modelList, cfg.model);

  chrome.runtime.sendMessage({ type: 'cacheStats' }, (r) => {
    if (r && r.ok) $('cacheInfo').textContent = 'کش ترجمه: ' + r.count + ' دسته';
  });
}

// تغییرات فوری — بدون نیاز به دکمه‌ی ذخیره
for (const id of ['enabled', 'showEnglish']) {
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
