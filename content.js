'use strict';

/* =========================================================================
 * Coursera Persian Subtitles — content script
 *
 * منبع متن: خودِ تراک زیرنویس انگلیسیِ Coursera روی عنصر <video>
 * (video.textTracks). با mode='hidden' کیوها با تایمینگ دقیق لود می‌شوند
 * بدون اینکه مرورگر آن‌ها را رسم کند؛ ما خودمان روی ویدیو رسم می‌کنیم.
 * ========================================================================= */

(() => {
  if (window.__courseraFaSubLoaded) return;
  window.__courseraFaSubLoaded = true;

  const TAG = '[coursera-fa]';
  const DEFAULTS = {
    enabled: true,
    showEnglish: true,
    fontSize: 26,
    bottomOffset: 72,
    model: 'gemini-2.5-flash'
  };

  let S = Object.assign({}, DEFAULTS);
  let st = null;          // وضعیت اتصال فعلی به یک ویدیو
  let watchdog = null;

  /* ------------------------------------------------------------- helpers */

  const log = (...a) => console.debug(TAG, ...a);

  // پاک‌سازی متن VTT: حذف تگ‌ها و رمزگشایی موجودیت‌ها
  const DECODER = document.createElement('textarea');
  function cleanCue(text) {
    let t = String(text || '').replace(/<[^>]*>/g, '');
    if (t.indexOf('&') !== -1) {
      DECODER.innerHTML = t;
      t = DECODER.value;
    }
    return t.replace(/\r/g, '').trim();
  }

  // متنی که برای ترجمه می‌فرستیم: تک‌خطی
  const flat = (t) => t.replace(/\n+/g, ' ').replace(/\s{2,}/g, ' ').trim();

  function cueIndexAt(cues, t) {
    let lo = 0, hi = cues.length - 1;
    while (lo <= hi) {
      const m = (lo + hi) >> 1;
      if (cues[m].e <= t) lo = m + 1;
      else if (cues[m].s > t) hi = m - 1;
      else return m;
    }
    return -1;
  }

  function pickVideo() {
    const vs = Array.prototype.slice.call(document.querySelectorAll('video'));
    let best = null, bestArea = 0;
    for (const v of vs) {
      const r = v.getBoundingClientRect();
      const area = r.width * r.height;
      if (area > bestArea) { best = v; bestArea = area; }
    }
    return bestArea > 10000 ? best : null;
  }

  function pickEnglishTrack(video) {
    const tracks = Array.prototype.slice.call(video.textTracks || []);
    const en = tracks.filter((t) =>
      /^en/i.test(t.language || '') &&
      (t.kind === 'captions' || t.kind === 'subtitles')
    );
    if (!en.length) return null;
    // تراکی که کیو دارد را ترجیح بده
    return en.find((t) => t.cues && t.cues.length) || en[0];
  }

  /* ------------------------------------------------------------- overlay */

  function buildOverlay(video) {
    let host = video.parentElement;
    if (!host) return null;
    if (getComputedStyle(host).position === 'static') host.style.position = 'relative';

    const root = document.createElement('div');
    root.className = 'cfsub-root';
    root.setAttribute('dir', 'rtl');

    const chip = document.createElement('div');
    chip.className = 'cfsub-chip';
    chip.style.display = 'none';

    const box = document.createElement('div');
    box.className = 'cfsub-box';

    const fa = document.createElement('div');
    fa.className = 'cfsub-fa';

    const en = document.createElement('div');
    en.className = 'cfsub-en';
    en.setAttribute('dir', 'ltr');

    box.appendChild(fa);
    box.appendChild(en);
    root.appendChild(chip);
    root.appendChild(box);
    host.appendChild(root);

    return { host, root, box, fa, en, chip };
  }

  function applyStyle() {
    if (!st || !st.ui) return;
    const w = st.video.getBoundingClientRect().width || 900;
    const k = Math.max(0.65, Math.min(1.8, w / 900));
    st.ui.root.style.bottom = Math.round(S.bottomOffset * k) + 'px';
    st.ui.fa.style.fontSize = Math.round(S.fontSize * k) + 'px';
    st.ui.en.style.fontSize = Math.round(S.fontSize * 0.68 * k) + 'px';
    st.ui.en.style.display = S.showEnglish ? '' : 'none';
  }

  // در حالت تمام‌صفحه اگر پوشش بیرون از عنصر تمام‌صفحه بماند دیده نمی‌شود
  function onFullscreenChange() {
    if (!st || !st.ui) return;
    const fsEl = document.fullscreenElement || document.webkitFullscreenElement;
    if (fsEl && !fsEl.contains(st.ui.root)) {
      if (getComputedStyle(fsEl).position === 'static') fsEl.style.position = 'relative';
      fsEl.appendChild(st.ui.root);
    } else if (!fsEl && st.ui.host && st.ui.root.parentElement !== st.ui.host) {
      st.ui.host.appendChild(st.ui.root);
    }
    applyStyle();
  }

  function setChip(text, kind) {
    if (!st || !st.ui) return;
    const c = st.ui.chip;
    if (!text) { c.style.display = 'none'; return; }
    c.textContent = text;
    c.className = 'cfsub-chip' + (kind ? ' cfsub-chip--' + kind : '');
    c.style.display = '';
  }

  /* ------------------------------------------------------------- render */

  function render() {
    if (!st || !st.ui || !st.cues.length) return;
    const i = cueIndexAt(st.cues, st.video.currentTime);
    if (i === st.lastIndex) return;
    st.lastIndex = i;

    if (i < 0) {
      st.ui.box.style.visibility = 'hidden';
      st.ui.fa.textContent = '';
      st.ui.en.textContent = '';
      return;
    }

    const cue = st.cues[i];
    const fa = st.fa[i];
    st.ui.box.style.visibility = 'visible';
    st.ui.fa.textContent = fa || '';
    st.ui.fa.style.opacity = fa ? '1' : '0';
    // تا وقتی ترجمه نرسیده، انگلیسی را نگه می‌داریم تا صفحه خالی نماند
    st.ui.en.textContent = (S.showEnglish || !fa) ? cue.en : '';
    st.ui.en.style.display = (S.showEnglish || !fa) ? '' : 'none';
  }

  /* -------------------------------------------------------- translation */

  function requestTranslation() {
    if (!st || !st.cues.length) return;
    if (st.port) { try { st.port.disconnect(); } catch (e) {} st.port = null; }

    const firstMissing = st.fa.findIndex((x, i) => !x && st.cues[i].flat);
    const curIdx = Math.max(0, cueIndexAt(st.cues, st.video.currentTime));
    const startIndex = firstMissing === -1 ? curIdx : Math.max(firstMissing, 0);
    if (firstMissing === -1) { setChip('', null); return; }

    let port;
    try {
      port = chrome.runtime.connect({ name: 'coursera-fa-sub' });
    } catch (e) {
      setChip('اکستنشن بارگذاری مجدد شده — صفحه را تازه کنید', 'err');
      return;
    }
    st.port = port;
    const myVideoToken = st.token;

    setChip('در حال ترجمه…', null);

    port.onMessage.addListener((m) => {
      if (!st || st.token !== myVideoToken) return;
      if (m.type === 'start') {
        st.totalBatches = m.total;
        setChip('در حال ترجمه… ۰/' + faNum(m.total), null);
      } else if (m.type === 'batch') {
        for (let k = 0; k < m.texts.length; k++) {
          const idx = m.from + k;
          if (idx < st.fa.length && m.texts[k]) st.fa[idx] = m.texts[k];
        }
        st.lastIndex = -2;   // رندر را مجبور کن دوباره متن را بردارد
        render();
        setChip(m.done >= m.total ? '' : 'در حال ترجمه… ' + faNum(m.done) + '/' + faNum(m.total), null);
      } else if (m.type === 'done') {
        setChip('', null);
        st.reconnects = 0;
      } else if (m.type === 'error') {
        st.port = null;
        if (m.code === 'nokey') {
          setChip('کلید Google AI تنظیم نشده — روی آیکن اکستنشن بزنید', 'err');
        } else {
          setChip('خطا: ' + m.message, 'err');
        }
      }
    });

    port.onDisconnect.addListener(() => {
      if (!st || st.token !== myVideoToken) return;
      if (st.port !== port) return;
      st.port = null;
      // service worker خوابیده؛ از اولین دسته‌ی ترجمه‌نشده ادامه بده
      const stillMissing = st.fa.some((x, i) => !x && st.cues[i].flat);
      if (stillMissing && st.reconnects < 5) {
        st.reconnects++;
        setTimeout(() => { if (st && st.token === myVideoToken) requestTranslation(); }, 1200);
      }
    });

    port.postMessage({
      type: 'translate',
      startIndex,
      lines: st.cues.map((c) => c.flat)
    });
  }

  // عدد فارسی برای نمایش
  const FA_DIGITS = '۰۱۲۳۴۵۶۷۸۹';
  const faNum = (n) => String(n).replace(/\d/g, (d) => FA_DIGITS[+d]);

  /* --------------------------------------------------------- attach flow */

  let tokenSeq = 0;

  function detach() {
    if (!st) return;
    try { if (st.port) st.port.disconnect(); } catch (e) {}
    try { if (st.ui && st.ui.root.parentElement) st.ui.root.remove(); } catch (e) {}
    try {
      if (st.track && st.savedMode && st.track.mode !== st.savedMode) st.track.mode = st.savedMode;
    } catch (e) {}
    for (const off of st.offs) { try { off(); } catch (e) {} }
    st = null;
  }

  // retries فقط برای تلاش دوباره‌ی برداشت کیو است؛ ویدیوی جدید آن را صفر می‌کند.
  async function attach(video, retries) {
    detach();
    const token = ++tokenSeq;
    st = {
      token, video, ui: null, track: null, savedMode: null,
      cues: [], fa: [], lastIndex: -1, offs: [], port: null,
      totalBatches: 0, reconnects: 0, retries: retries || 0,
      srcKey: video.currentSrc || '', path: location.pathname
    };

    st.ui = buildOverlay(video);
    if (!st.ui) { st = null; return; }
    applyStyle();
    st.ui.box.style.visibility = 'hidden';

    const track = await waitForTrack(video, token);
    if (!st || st.token !== token) return;
    if (!track) {
      setChip('این ویدیو زیرنویس انگلیسی ندارد', 'warn');
      return;
    }

    st.track = track;
    st.savedMode = track.mode;
    // 'showing' یعنی خودِ Coursera دارد زیرنویس را رسم می‌کند — دوتایی نشود
    if (track.mode !== 'hidden') track.mode = 'hidden';

    const cues = await waitForCues(track, token);
    if (!st || st.token !== token) return;
    if (!cues || !cues.length) {
      setChip('زیرنویس این ویدیو بارگذاری نشد', 'warn');
      return;
    }

    st.cues = cues;
    st.fa = new Array(cues.length).fill('');
    st.lastIndex = -1;
    log('cues', cues.length, 'path', location.pathname);

    const onTime = () => render();
    video.addEventListener('timeupdate', onTime);
    video.addEventListener('seeked', onTime);
    st.offs.push(() => {
      video.removeEventListener('timeupdate', onTime);
      video.removeEventListener('seeked', onTime);
    });

    try {
      track.addEventListener('cuechange', onTime);
      st.offs.push(() => track.removeEventListener('cuechange', onTime));
    } catch (e) {}

    const ro = new ResizeObserver(() => applyStyle());
    ro.observe(video);
    st.offs.push(() => ro.disconnect());

    // پلیر Coursera گاهی مود تراک را به disabled برمی‌گرداند و cues تهی می‌شود
    const keepHidden = () => { if (st && st.track && st.track.mode !== 'hidden') st.track.mode = 'hidden'; };
    try {
      video.textTracks.addEventListener('change', keepHidden);
      st.offs.push(() => video.textTracks.removeEventListener('change', keepHidden));
    } catch (e) {}

    render();
    if (S.enabled) requestTranslation();
  }

  function waitForTrack(video, token) {
    return new Promise((resolve) => {
      const t0 = Date.now();
      const tick = () => {
        if (!st || st.token !== token) return resolve(null);
        const tr = pickEnglishTrack(video);
        if (tr) return resolve(tr);
        if (Date.now() - t0 > 20000) return resolve(null);
        setTimeout(tick, 400);
      };
      tick();
    });
  }

  function waitForCues(track, token) {
    return new Promise((resolve) => {
      const t0 = Date.now();
      const tick = () => {
        if (!st || st.token !== token) return resolve(null);
        const raw = track.cues;
        if (raw && raw.length) {
          const out = [];
          for (let i = 0; i < raw.length; i++) {
            const c = raw[i];
            const en = cleanCue(c.text);
            out.push({ s: c.startTime, e: c.endTime, en, flat: flat(en) });
          }
          out.sort((a, b) => a.s - b.s);
          return resolve(out);
        }
        if (Date.now() - t0 > 20000) return resolve(null);
        setTimeout(tick, 250);
      };
      tick();
    });
  }

  /* ------------------------------------------------------------ watchdog */

  function check() {
    if (!S.enabled) {
      if (st) detach();
      return;
    }
    const v = pickVideo();
    if (!v) {
      if (st) detach();
      return;
    }
    const src = v.currentSrc || '';
    if (st && st.video === v && !st.srcKey && src) st.srcKey = src;   // src دیر پر شده، نه ویدیوی جدید

    if (!st || st.video !== v || st.path !== location.pathname ||
        (st.srcKey && src && st.srcKey !== src)) {
      attach(v);
    } else if (st.ui && !st.ui.root.isConnected) {
      // React پوشش را دور انداخته — دوباره بساز
      attach(v);
    } else {
      if (st.track && st.track.mode !== 'hidden') st.track.mode = 'hidden';
      // اگر کیوها نیامدند (تراک وسط کار disabled شده بود) دوباره تلاش کن
      if (st.track && !st.cues.length && st.retries < 3 && st.track.cues && st.track.cues.length) {
        attach(v, st.retries + 1);
      }
    }
  }

  /* ------------------------------------------------------------ settings */

  function loadSettings() {
    return chrome.storage.local.get(Object.keys(DEFAULTS)).then((got) => {
      for (const k of Object.keys(DEFAULTS)) {
        S[k] = (got[k] === undefined) ? DEFAULTS[k] : got[k];
      }
    });
  }

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    let restyle = false, retranslate = false, toggled = false;
    for (const k of Object.keys(changes)) {
      if (k === 'enabled') { S.enabled = changes[k].newValue; toggled = true; }
      else if (k === 'showEnglish' || k === 'fontSize' || k === 'bottomOffset') {
        S[k] = changes[k].newValue; restyle = true;
      } else if (k === 'model' || k === 'apiKey') {
        if (k === 'model') S.model = changes[k].newValue;
        retranslate = true;
      }
    }
    if (toggled) { check(); return; }
    if (restyle && st) { applyStyle(); st.lastIndex = -2; render(); }
    if (retranslate && st && st.cues.length) {
      st.fa = new Array(st.cues.length).fill('');
      st.reconnects = 0;
      st.lastIndex = -2;
      render();
      requestTranslation();
    }
  });

  document.addEventListener('fullscreenchange', onFullscreenChange);
  document.addEventListener('webkitfullscreenchange', onFullscreenChange);

  loadSettings().then(() => {
    check();
    watchdog = setInterval(check, 1000);
  });
})();
