'use strict';

/* =========================================================================
 * Live Persian subtitles — content script
 *
 * The script decides for itself which site it is running on, picks the cue
 * source that site needs, and applies that site's own appearance settings.
 *
 *   SITES   — one entry per supported site: how to recognise it, which cue
 *             source it uses, and the appearance defaults that suit its player
 *   SOURCES — how to obtain cues. 'texttracks' reads the site's own caption
 *             track from video.textTracks; keeping the track in mode='hidden'
 *             loads the cues with exact timings without the browser drawing
 *             them, so we can draw them ourselves.
 *
 * Everything below the source layer — overlay, sync, batching, cache — is
 * shared by every site.
 * ========================================================================= */

(() => {
  if (window.__faSubLoaded) return;
  window.__faSubLoaded = true;

  const TAG = '[fa-sub]';

  /* --------------------------------------------------------------- sites */

  const SITES = [
    {
      id: 'coursera',
      label: 'Coursera',
      source: 'texttracks',
      match: (h) => /(^|\.)coursera\.org$/i.test(h),
      defaults: { bottomOffset: 72 }
    },
    {
      id: 'vimeo',
      label: 'Vimeo',
      source: 'texttracks',
      match: (h) => /(^|\.)vimeo\.com$/i.test(h),
      defaults: { bottomOffset: 64 }
    }
  ];

  const SITE = SITES.find((s) => s.match(location.hostname));
  if (!SITE) return;

  /* ------------------------------------------------------------ settings */

  // Global: the same everywhere. Appearance: per site, because players differ.
  const GLOBAL_DEFAULTS = { enabled: true };
  const APPEARANCE_DEFAULTS = {
    showEnglish: true,
    fontSize: 26,
    bottomOffset: 72,
    fontStack: ''
  };
  const APPEARANCE_KEYS = Object.keys(APPEARANCE_DEFAULTS);
  const SITE_KEY = 'site:' + SITE.id;

  let S = Object.assign({}, GLOBAL_DEFAULTS, APPEARANCE_DEFAULTS, SITE.defaults);

  function applySettings(got) {
    const legacy = {};   // v1.x stored appearance at the top level
    for (const k of APPEARANCE_KEYS) {
      if (got[k] !== undefined) legacy[k] = got[k];
    }
    Object.assign(
      S,
      GLOBAL_DEFAULTS,
      APPEARANCE_DEFAULTS,
      SITE.defaults,
      legacy,
      got[SITE_KEY] || {}
    );
    if (got.enabled !== undefined) S.enabled = got.enabled;
  }

  function loadSettings() {
    return chrome.storage.local
      .get(['enabled'].concat(APPEARANCE_KEYS, [SITE_KEY]))
      .then(applySettings);
  }

  /* ------------------------------------------------------------- helpers */

  const log = (...a) => console.debug(TAG, SITE.id, ...a);

  // Clean VTT text: strip tags and decode entities
  const DECODER = document.createElement('textarea');
  function cleanCue(text) {
    let t = String(text || '').replace(/<[^>]*>/g, '');
    if (t.indexOf('&') !== -1) {
      DECODER.innerHTML = t;
      t = DECODER.value;
    }
    return t.replace(/\r/g, '').trim();
  }

  // The form we send for translation: a single line
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

  const areaOf = (v) => {
    const r = v.getBoundingClientRect();
    return r.width * r.height;
  };

  // A page can hold several <video> elements and the biggest one is not
  // necessarily the one carrying the captions: Vimeo lays the real player out
  // lazily while a small preview player — with no caption track at all — is
  // already on screen. So a video that carries a usable track wins regardless
  // of its size, and area only breaks ties.
  function pickVideo() {
    const vs = Array.prototype.slice.call(document.querySelectorAll('video'));
    if (!vs.length) return null;

    const carriers = vs.filter((v) => source.candidate(v));
    if (carriers.length) {
      return carriers.sort((a, b) => areaOf(b) - areaOf(a))[0];
    }

    let best = null, bestArea = 0;
    for (const v of vs) {
      const a = areaOf(v);
      if (a > bestArea) { best = v; bestArea = a; }
    }
    return bestArea > 10000 ? best : null;
  }

  /* ------------------------------------------------------- cue sources */

  const SOURCES = {
    /* The site exposes its captions on video.textTracks (Coursera, Vimeo). */
    texttracks: {
      pick(video) {
        const tracks = Array.prototype.slice.call(video.textTracks || []);
        // 'en-x-autogen' (Vimeo auto-captions) must match too
        const en = tracks.filter((t) =>
          /^en/i.test(t.language || '') &&
          (t.kind === 'captions' || t.kind === 'subtitles')
        );
        if (!en.length) return null;
        return en.find((t) => t.cues && t.cues.length) || en[0];
      },

      // Does this element already carry a track we could use?
      candidate(video) {
        return !!SOURCES.texttracks.pick(video);
      },

      acquire(video, token, alive) {
        return new Promise((resolve) => {
          const t0 = Date.now();
          const tick = () => {
            if (!alive(token)) return resolve(null);
            const track = SOURCES.texttracks.pick(video);
            if (track) {
              const handle = { track, savedMode: track.mode };
              // 'showing' means the site is drawing captions itself — avoid doubling them
              if (track.mode !== 'hidden') track.mode = 'hidden';
              return resolve(handle);
            }
            if (Date.now() - t0 > 20000) return resolve(null);
            setTimeout(tick, 400);
          };
          tick();
        });
      },

      cues(handle, token, alive) {
        return new Promise((resolve) => {
          const t0 = Date.now();
          const tick = () => {
            if (!alive(token)) return resolve(null);
            const raw = handle.track.cues;
            if (raw && raw.length) {
              const out = [];
              for (let i = 0; i < raw.length; i++) {
                const c = raw[i];
                // Zero-length cues (Vimeo auto-captions produce a few) can never
                // satisfy s <= t < e, so they would be translated but never shown.
                if (!(c.endTime > c.startTime)) continue;
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
      },

      // Coursera and Vimeo both flip the track back to disabled once the media
      // loads, which empties track.cues. Hold it at hidden.
      hold(handle) {
        if (handle && handle.track && handle.track.mode !== 'hidden') {
          handle.track.mode = 'hidden';
        }
      },

      ready(handle) {
        return !!(handle && handle.track && handle.track.cues && handle.track.cues.length);
      },

      watch(handle, video, offs) {
        const keep = () => SOURCES.texttracks.hold(handle);
        try {
          video.textTracks.addEventListener('change', keep);
          offs.push(() => video.textTracks.removeEventListener('change', keep));
        } catch (e) {}
      },

      release(handle) {
        try {
          if (handle && handle.track && handle.savedMode &&
              handle.track.mode !== handle.savedMode) {
            handle.track.mode = handle.savedMode;
          }
        } catch (e) {}
      }
    }
  };

  const source = SOURCES[SITE.source];

  /* ------------------------------------------------------------- overlay */

  let st = null;

  function buildOverlay(video) {
    const host = video.parentElement;
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
    const w = st.video.getBoundingClientRect().width || 900;   // 0 while the player is still laid out
    const k = Math.max(0.65, Math.min(1.8, w / 900));
    st.ui.root.style.bottom = Math.round(S.bottomOffset * k) + 'px';
    st.ui.fa.style.fontSize = Math.round(S.fontSize * k) + 'px';
    st.ui.fa.style.fontFamily = S.fontStack || '';
    st.ui.en.style.fontSize = Math.round(S.fontSize * 0.68 * k) + 'px';
    st.ui.en.style.display = S.showEnglish ? '' : 'none';
  }

  // In fullscreen an overlay left outside the fullscreen element is invisible
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

  /* -------------------------------------------------------------- render */

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
    const faText = st.fa[i];
    st.ui.box.style.visibility = 'visible';
    st.ui.fa.textContent = faText || '';
    st.ui.fa.style.opacity = faText ? '1' : '0';
    // until the translation arrives, keep the English so the area is not blank
    st.ui.en.textContent = (S.showEnglish || !faText) ? cue.en : '';
    st.ui.en.style.display = (S.showEnglish || !faText) ? '' : 'none';
  }

  /* --------------------------------------------------------- translation */

  const FA_DIGITS = '۰۱۲۳۴۵۶۷۸۹';
  const faNum = (n) => String(n).replace(/\d/g, (d) => FA_DIGITS[+d]);

  function requestTranslation() {
    if (!st || !st.cues.length) return;
    if (st.port) { try { st.port.disconnect(); } catch (e) {} st.port = null; }

    const firstMissing = st.fa.findIndex((x, i) => !x && st.cues[i].flat);
    if (firstMissing === -1) { setChip('', null); return; }

    let port;
    try {
      port = chrome.runtime.connect({ name: 'coursera-fa-sub' });
    } catch (e) {
      setChip('اکستنشن بارگذاری مجدد شده — صفحه را تازه کنید', 'err');
      return;
    }
    st.port = port;
    const myToken = st.token;

    setChip('در حال ترجمه…', null);

    port.onMessage.addListener((m) => {
      if (!st || st.token !== myToken) return;
      if (m.type === 'start') {
        st.totalBatches = m.total;
        setChip('در حال ترجمه… ۰/' + faNum(m.total), null);
      } else if (m.type === 'batch') {
        for (let k = 0; k < m.texts.length; k++) {
          const idx = m.from + k;
          if (idx < st.fa.length && m.texts[k]) st.fa[idx] = m.texts[k];
        }
        st.lastIndex = -2;   // force render() to pick the text up again
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
      if (!st || st.token !== myToken || st.port !== port) return;
      st.port = null;
      // the service worker went to sleep; resume from the first untranslated batch
      const stillMissing = st.fa.some((x, i) => !x && st.cues[i].flat);
      if (stillMissing && st.reconnects < 5) {
        st.reconnects++;
        setTimeout(() => { if (st && st.token === myToken) requestTranslation(); }, 1200);
      }
    });

    port.postMessage({
      type: 'translate',
      startIndex: firstMissing,
      lines: st.cues.map((c) => c.flat)
    });
  }

  /* --------------------------------------------------------- attach flow */

  let tokenSeq = 0;
  const alive = (token) => !!st && st.token === token;

  function detach() {
    if (!st) return;
    try { if (st.port) st.port.disconnect(); } catch (e) {}
    try { if (st.ui && st.ui.root.parentElement) st.ui.root.remove(); } catch (e) {}
    source.release(st.handle);
    for (const off of st.offs) { try { off(); } catch (e) {} }
    st = null;
  }

  // retries only guards the cue-harvest retry; a new video resets it to zero.
  async function attach(video, retries) {
    detach();
    const token = ++tokenSeq;
    st = {
      token, video, ui: null, handle: null,
      cues: [], fa: [], lastIndex: -1, offs: [], port: null,
      totalBatches: 0, reconnects: 0, retries: retries || 0,
      srcKey: video.currentSrc || '', path: location.pathname
    };

    st.ui = buildOverlay(video);
    if (!st.ui) { st = null; return; }
    applyStyle();
    st.ui.box.style.visibility = 'hidden';

    const handle = await source.acquire(video, token, alive);
    if (!alive(token)) return;
    if (!handle) {
      setChip('این ویدیو زیرنویس انگلیسی ندارد', 'warn');
      return;
    }
    st.handle = handle;

    const cues = await source.cues(handle, token, alive);
    if (!alive(token)) return;
    if (!cues || !cues.length) {
      setChip('زیرنویس این ویدیو بارگذاری نشد', 'warn');
      return;
    }

    st.cues = cues;
    st.fa = new Array(cues.length).fill('');
    st.lastIndex = -1;
    log('cues', cues.length, location.pathname);

    const onTime = () => render();
    video.addEventListener('timeupdate', onTime);
    video.addEventListener('seeked', onTime);
    st.offs.push(() => {
      video.removeEventListener('timeupdate', onTime);
      video.removeEventListener('seeked', onTime);
    });

    source.watch(handle, video, st.offs);

    const ro = new ResizeObserver(() => applyStyle());
    ro.observe(video);
    st.offs.push(() => ro.disconnect());

    render();
    if (S.enabled) requestTranslation();
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
    if (st && st.video === v && !st.srcKey && src) st.srcKey = src;   // src filled in late, not a new video

    if (!st || st.video !== v || st.path !== location.pathname ||
        (st.srcKey && src && st.srcKey !== src)) {
      attach(v);
    } else if (st.ui && !st.ui.root.isConnected) {
      // the page threw the overlay away — rebuild it
      attach(v);
    } else {
      source.hold(st.handle);
      // if the cues never arrived (the track was disabled mid-flight), try again
      if (st.handle && !st.cues.length && st.retries < 3 && source.ready(st.handle)) {
        attach(v, st.retries + 1);
      }
    }
  }

  /* ------------------------------------------------------------- wiring */

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    let restyle = false, retranslate = false, toggled = false;

    for (const k of Object.keys(changes)) {
      if (k === 'enabled') { S.enabled = changes[k].newValue; toggled = true; }
      else if (k === SITE_KEY || APPEARANCE_KEYS.indexOf(k) !== -1) restyle = true;
      else if (k === 'model' || k === 'apiKey' || k === 'keepTerms') {
        retranslate = true;   // translation cached under the previous setting no longer applies
      }
    }

    if (!restyle && !retranslate && !toggled) return;

    loadSettings().then(() => {
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
  });

  // The popup asks the active tab which site it is on, so it can edit that
  // site's appearance settings.
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg && msg.type === 'whichSite') {
      sendResponse({ id: SITE.id, label: SITE.label, attached: !!(st && st.cues.length) });
    }
  });

  document.addEventListener('fullscreenchange', onFullscreenChange);
  document.addEventListener('webkitfullscreenchange', onFullscreenChange);

  loadSettings().then(() => {
    check();
    setInterval(check, 1000);
  });
})();
