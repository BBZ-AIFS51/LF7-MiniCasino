/* Mini Casino viewer: the UI shell. Builds and binds the top bar, the stage overlays (loader,
   tooltip, focus chips, camera dock, webgl fallback) and the five panels: play, explore,
   schematic, build and admin.
   - the simulation is reached through sim.state(), sim.accounts(), sim.setDebugLog() and, for
     everything the admin console does, sim.admin(line) only (the real AdminSerial.h protocol);
   - the 3D view through MC.Scene, once app.js hands it over with MC.UI.attachScene();
   - app.js through the two callbacks given to MC.UI.init(): pressKey(ch, source), tapCard(uid, source).
   All wiring of bus events happens in app.js, which calls the UI.* entry points at the bottom. */
(function () {
  'use strict';
  const MC = window.MC = window.MC || {};
  const UI = MC.UI = MC.UI || {};
  const SVGNS = 'http://www.w3.org/2000/svg';
  const doc = document;

  // ------------------------------------------------------------------ helpers
  const $ = (s, r) => (r || doc).querySelector(s);
  const $$ = (s, r) => Array.prototype.slice.call((r || doc).querySelectorAll(s));
  const mq = q => (window.matchMedia ? window.matchMedia(q) : { matches: false, addEventListener() {} });
  const media = {
    light: mq('(prefers-color-scheme: light)'),
    reduce: mq('(prefers-reduced-motion: reduce)'),
    phone: mq('(max-width: 760px)')
  };
  const listen = (m, fn) => { if (m.addEventListener) m.addEventListener('change', fn); else if (m.addListener) m.addListener(fn); };
  const store = MC.storage || { get: (k, f) => f, set() {} };
  const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
  const now = () => (window.performance ? performance.now() : Date.now());
  const raf = window.requestAnimationFrame ? window.requestAnimationFrame.bind(window) : fn => setTimeout(fn, 16);

  function el(tag, props, children) {
    const n = doc.createElement(tag);
    if (props) {
      for (const k in props) {
        const v = props[k];
        if (v === undefined || v === null || v === false) continue;
        if (k === 'class') n.className = v;
        else if (k === 'text') n.textContent = v;
        else if (k === 'html') n.innerHTML = v;
        else if (k === 'style') { for (const sk in v) n.style.setProperty(sk, v[sk]); }
        else if (k === 'dataset') Object.assign(n.dataset, v);
        else if (k.slice(0, 2) === 'on' && typeof v === 'function') n.addEventListener(k.slice(2), v);
        else n.setAttribute(k, v === true ? '' : String(v));
      }
    }
    append(n, children);
    return n;
  }
  function append(n, children) {
    if (children === undefined || children === null || children === false) return n;
    (Array.isArray(children) ? children : [children]).forEach(c => {
      if (c === undefined || c === null || c === false) return;
      n.appendChild(typeof c === 'string' || typeof c === 'number' ? doc.createTextNode(String(c)) : c);
    });
    return n;
  }
  function icon(name, cls) {
    const s = doc.createElementNS(SVGNS, 'svg');
    s.setAttribute('class', 'ico' + (cls ? ' ' + cls : ''));
    s.setAttribute('aria-hidden', 'true');
    const u = doc.createElementNS(SVGNS, 'use');
    u.setAttribute('href', '#i-' + name);
    s.appendChild(u);
    return s;
  }
  function setIcon(svg, name) { const u = svg && svg.querySelector('use'); if (u) u.setAttribute('href', '#i-' + name); }
  const cssEsc = s => (window.CSS && CSS.escape ? CSS.escape(s) : String(s).replace(/["\\]/g, '\\$&'));

  const NBSP = '\u00A0', THIN = '\u202F';
  function money(n) {
    if (n === undefined || n === null || isNaN(n)) return '–';
    const s = String(Math.round(Math.abs(n))).replace(/\B(?=(\d{3})+(?!\d))/g, THIN);
    return (n < 0 ? '−' : '') + s + NBSP + '€';
  }
  const pad2 = n => (n < 10 ? '0' : '') + n;
  const part = id => (MC.part ? MC.part(id) : null);
  const net = id => (MC.net ? MC.net(id) : null);
  const fw = () => window.MC_FW || {};
  const rules = () => fw().rules || {};
  const SOUND_NAMES = ['loud', 'quiet', 'off'];
  const SOUND_DE = ['laut', 'leise', 'aus'];
  const KEYS = '123A456B789C*0#D';
  const sessionSeconds = () => Math.round((rules().SITZUNG_MS || 60000) / 1000);

  function cardOf(uid) {
    uid = String(uid || '').toUpperCase();
    return (MC.CARDS || []).find(c => c.uid === uid) || null;
  }
  function cardLabel(uid) {
    const c = cardOf(uid);
    if (!c) return 'manual uid';
    const p = part(c.part);
    return p ? p.name.replace(c.uid, '').trim() : c.kind;
  }
  function partShort(id) { const p = part(id); return p ? p.short : id; }

  // ------------------------------------------------------------------ state
  const ctx = { sim: null, oled: null, audio: null, scene: null, pressKey: null, tapCard: null };
  const caseColors = (MC.tokens && MC.tokens.caseColors) || [];
  const settings = {
    view: { xray: false, body: true, lid: true, wires: true, parts: true, labels: false, autoRotate: !media.reduce.matches },
    explode: 0,
    camera: 'hero',
    caseColor: store.get('caseColor', caseColors[0] ? caseColors[0].hex : '#E4E6EA'),
    oledVariant: store.get('oledVariant', 'white'),
    quality: store.get('quality', 'auto'),
    debugLog: !!store.get('debugLog', false)
  };
  if (['white', 'blue', 'yellow-blue'].indexOf(settings.oledVariant) < 0) settings.oledVariant = 'white';
  if (['auto', 'high', 'low'].indexOf(settings.quality) < 0) settings.quality = 'auto';
  const focus = { hover: null, pinned: null, isolated: null, sceneHover: null };
  let theme = doc.documentElement.getAttribute('data-theme') === 'light' ? 'light' : 'dark';
  let tab = null;
  let accounts = [];
  let sceneMode = 'loading';   // 'loading' | 'ready' | 'fallback'
  const oledViews = [];
  let lastFb = null;

  // Scene call guarded: no-op until the scene is attached, never throws into the UI.
  function S(method) {
    const sc = ctx.scene;
    if (!sc || typeof sc[method] !== 'function') return undefined;
    const args = Array.prototype.slice.call(arguments, 1);
    try { return sc[method].apply(sc, args); } catch (err) { console.error('[ui] MC.Scene.' + method, err); return undefined; }
  }

  // ------------------------------------------------------------------ theme
  function storedTheme() { const t = store.get('theme', null); return t === 'light' || t === 'dark' ? t : null; }
  function systemTheme() { return media.light.matches ? 'light' : 'dark'; }
  function applyTokens(t) {
    const tok = MC.tokens && MC.tokens[t];
    if (!tok) return;
    const st = doc.documentElement.style;
    for (const k in tok) st.setProperty('--' + k, tok[k]);
    const g = MC.tokens.game;
    if (g) { st.setProperty('--game-black', g.black); st.setProperty('--game-red', g.red); st.setProperty('--game-green', g.green); }
  }
  function setTheme(t, persist) {
    theme = t === 'light' ? 'light' : 'dark';
    doc.documentElement.setAttribute('data-theme', theme);
    applyTokens(theme);
    if (persist) store.set('theme', theme);
    const meta = $('meta[name="theme-color"]');
    if (meta && MC.tokens && MC.tokens[theme]) meta.setAttribute('content', MC.tokens[theme].bg);
    const b = $('#btn-theme');
    if (b) {
      const next = theme === 'dark' ? 'light' : 'dark';
      setIcon(b.querySelector('svg'), theme === 'dark' ? 'sun' : 'moon');
      b.setAttribute('aria-label', 'switch to the ' + next + ' theme');
      b.title = next + ' theme';
    }
    S('setTheme', theme);
    schemRender();
    MC.bus && MC.bus.emit('ui:theme', theme);
  }

  // ------------------------------------------------------------------ tabs
  const TABS = ['play', 'explore', 'schematic', 'build', 'admin'];
  const tabScroll = {};
  function initTabs() {
    const list = $('#tabs');
    $$('.tab', list).forEach(b => b.addEventListener('click', () => selectTab(b.dataset.tab)));
    list.addEventListener('keydown', e => {
      const i = TABS.indexOf(tab);
      let n = -1;
      if (e.key === 'ArrowRight') n = (i + 1) % TABS.length;
      else if (e.key === 'ArrowLeft') n = (i + TABS.length - 1) % TABS.length;
      else if (e.key === 'Home') n = 0;
      else if (e.key === 'End') n = TABS.length - 1;
      if (n < 0) return;
      e.preventDefault();
      selectTab(TABS[n], { focus: true });
    });
    if (window.ResizeObserver) new ResizeObserver(moveInk).observe(list);
    window.addEventListener('resize', moveInk);
  }
  function moveInk() {
    const b = $('#tab-' + tab), ink = $('#tabs-ink');
    if (!b || !ink) return;
    ink.style.width = b.offsetWidth + 'px';
    ink.style.transform = 'translateX(' + b.offsetLeft + 'px)';
  }
  function selectTab(name, opts) {
    if (TABS.indexOf(name) < 0) name = 'play';
    const prev = tab;
    if (prev === name) return;
    const body = $('#panel-body');
    if (prev && body) tabScroll[prev] = body.scrollTop;
    tab = name;
    TABS.forEach(t => {
      const b = $('#tab-' + t), v = $('#view-' + t);
      const on = t === name;
      b.setAttribute('aria-selected', on ? 'true' : 'false');
      b.tabIndex = on ? 0 : -1;
      v.hidden = !on;
    });
    moveInk();
    if (body && !media.phone.matches) body.scrollTop = tabScroll[name] || 0;
    store.set('tab', name);
    if (opts && opts.focus) $('#tab-' + name).focus();
    if (prev === 'build') buildLeave();
    if (name === 'build') buildEnter();
    if (name === 'schematic') schemShow();
    if (name === 'admin') adminRefresh({ silent: true });
    if (name === 'play') { refreshAccounts(); oledViews.forEach(v => v.layout()); }
  }

  // ------------------------------------------------------------------ top bar
  function initTopbar() {
    $('#btn-theme').addEventListener('click', () => setTheme(theme === 'dark' ? 'light' : 'dark', true));
    $('#btn-shot').addEventListener('click', screenshot);
    const full = $('#btn-full');
    const fsEnabled = doc.fullscreenEnabled || doc.webkitFullscreenEnabled;
    if (!fsEnabled) full.hidden = true;
    full.addEventListener('click', () => {
      const fe = doc.fullscreenElement || doc.webkitFullscreenElement;
      try {
        if (fe) (doc.exitFullscreen || doc.webkitExitFullscreen).call(doc);
        else {
          const r = doc.documentElement;
          const p = (r.requestFullscreen || r.webkitRequestFullscreen).call(r);
          if (p && p.catch) p.catch(() => toast('fullscreen was blocked by the browser', 'warn'));
        }
      } catch (e) { toast('fullscreen is not available here', 'warn'); }
    });
    const syncFull = () => {
      const on = !!(doc.fullscreenElement || doc.webkitFullscreenElement);
      setIcon(full.querySelector('svg'), on ? 'shrink' : 'expand');
      full.setAttribute('aria-label', on ? 'leave fullscreen' : 'enter fullscreen');
      full.title = on ? 'leave fullscreen' : 'fullscreen';
    };
    doc.addEventListener('fullscreenchange', syncFull);
    doc.addEventListener('webkitfullscreenchange', syncFull);
    $('#brand').addEventListener('click', e => { e.preventDefault(); setCamera('hero'); });
  }

  function screenshot() {
    if (sceneMode !== 'ready') { toast('the 3d view is not ready yet', 'warn'); return; }
    const done = url => {
      if (!url || typeof url !== 'string') { toast('screenshot failed', 'err'); return; }
      const d = new Date();
      const name = 'mini-casino-v11-' + d.getFullYear() + pad2(d.getMonth() + 1) + pad2(d.getDate()) + '-' + pad2(d.getHours()) + pad2(d.getMinutes()) + pad2(d.getSeconds()) + '.png';
      const a = el('a', { href: url, download: name, style: { display: 'none' } });
      doc.body.appendChild(a);
      a.click();
      a.remove();
      if (!media.reduce.matches) { const f = $('#flash'); f.classList.remove('is-on'); void f.offsetWidth; f.classList.add('is-on'); }
      toast('saved ' + name, 'ok');
    };
    const r = S('screenshot');
    if (r && typeof r.then === 'function') r.then(done, () => toast('screenshot failed', 'err'));
    else done(r);
  }

  // ------------------------------------------------------------------ toasts
  function toast(text, kind, ms) {
    const host = $('#toasts');
    if (!host) return;
    kind = kind || 'info';
    const ico = kind === 'ok' ? 'check' : kind === 'err' || kind === 'warn' ? 'alert' : 'info';
    const t = el('div', { class: 'toast toast-' + kind, role: kind === 'err' ? 'alert' : 'status' }, [icon(ico), el('span', { text })]);
    host.appendChild(t);
    while (host.children.length > 3) host.firstChild.remove();
    setTimeout(() => { t.classList.add('is-out'); setTimeout(() => t.remove(), 220); }, ms || (kind === 'err' ? 4200 : 2600));
  }

  // ------------------------------------------------------------------ stage: loader, fallback, hint, chips
  function progress(p, label) {
    const fill = $('#loader-fill');
    if (fill) fill.style.transform = 'scaleX(' + clamp(p, 0, 1).toFixed(3) + ')';
    const pct = $('#loader-pct');
    if (pct) pct.textContent = Math.round(clamp(p, 0, 1) * 100) + ' %';
    if (label) { const l = $('#loader-label'); if (l) l.textContent = label; }
  }
  function ready() {
    sceneMode = 'ready';
    progress(1, 'ready');
    const l = $('#loader');
    l.classList.add('is-done');
    setTimeout(() => { l.hidden = true; }, 460);
    showHint();
  }
  function fallback(reason) {
    sceneMode = 'fallback';
    $('#loader').hidden = true;
    const f = $('#fallback');
    f.hidden = false;
    if (reason) $('#fallback-msg').textContent = reason;
    // a large OLED mirror becomes the hero of the stage
    if (!$('#oled-stage')) {
      const fig = el('figure', { class: 'oled', id: 'oled-stage', 'data-variant': settings.oledVariant }, [
        el('div', { class: 'oled-module' }),
        el('figcaption', { class: 'oled-caption', text: '1.3" oled · sh1106 · 128 × 64' })
      ]);
      $('#fallback-oled').appendChild(fig);
      const view = OledView(fig, { max: 560, avail: () => Math.min($('#stage').clientWidth - 48, 560) });
      oledViews.push(view);
      view.setVariant(settings.oledVariant);
      view.draw(lastFb);
    }
    $('#dock').hidden = true;
    $('#btn-shot').disabled = true;
    $$('#view-explore .switch, #view-explore .range, #explode-play, #view-explore .seg-btn, #view-explore .swatch').forEach(n => { n.disabled = true; });
    $$('#view-explore .switch-row').forEach(n => n.setAttribute('aria-disabled', 'true'));
    const note = el('p', { class: 'note', text: 'these controls need the 3d view, which this browser cannot show.' });
    const first = $('#view-explore .sec');
    if (first && !first.querySelector('.note')) first.appendChild(note);
    oledViews.forEach(v => v.layout());
  }

  let hintTimer = 0;
  function showHint() {
    const h = $('#stage-hint');
    if (!h || store.get('hintSeen', false)) return;
    if (media.phone.matches) h.textContent = 'drag to orbit · pinch to zoom · tap keys and cards';
    h.hidden = false;
    hintTimer = setTimeout(hideHint, 7000);
  }
  function hideHint() {
    const h = $('#stage-hint');
    if (!h || h.hidden || h.classList.contains('is-out')) return;
    clearTimeout(hintTimer);
    h.classList.add('is-out');
    store.set('hintSeen', true);
    setTimeout(() => { h.hidden = true; }, 300);
  }

  function renderChips() {
    const host = $('#stage-chips');
    if (!host) return;
    host.textContent = '';
    const chip = (kind, label, swatch, onClear, clearLabel) => {
      const c = el('div', { class: 'chip' }, [
        swatch ? el('span', { class: 'wire', style: { '--wire': swatch } }) : null,
        el('span', { class: 'chip-kind', text: kind }),
        el('span', { text: label }),
        el('button', { type: 'button', class: 'chip-x', 'aria-label': clearLabel, title: clearLabel, onclick: onClear }, icon('close'))
      ]);
      host.appendChild(c);
    };
    if (build.active) chip('build', 'step ' + build.step + ' of ' + steps().length, null, () => { buildOff(); setCamera('hero'); }, 'leave the build guide');
    if (focus.isolated) { const p = part(focus.isolated); chip('isolated', p ? p.name : focus.isolated, null, () => isolate(null), 'show every part'); }
    if (focus.pinned) {
      if (focus.pinned.net) { const n = net(focus.pinned.net); chip('net', n ? n.label : focus.pinned.net, n ? n.color : null, () => pin(null), 'clear the highlight'); }
      else if (focus.pinned.part) { const p = part(focus.pinned.part); chip('part', p ? p.name : focus.pinned.part, null, () => pin(null), 'clear the highlight'); }
    }
  }

  // ------------------------------------------------------------------ highlight / isolate
  const same = (a, b) => !!a && !!b && a.net === b.net && a.part === b.part;
  function hover(h) { focus.hover = h || null; applyHighlight(); }
  function pin(h) {
    focus.pinned = h && !same(focus.pinned, h) ? { net: h.net || undefined, part: h.net ? undefined : h.part } : null;
    applyHighlight();
    renderChips();
    syncPressed();
  }
  function isolate(id) {
    focus.isolated = id && focus.isolated !== id ? id : null;
    S('isolate', focus.isolated);
    renderChips();
    syncPressed();
  }
  function applyHighlight() {
    const h = focus.hover || focus.pinned;
    S('highlight', h ? { part: h.part || null, net: h.net || null } : null);
    schemMark(focus.sceneHover || h);
    netlistMark(h);
    schemInfo(h);
  }
  function syncPressed() {
    $$('#parts-list .row-btn').forEach(b => b.setAttribute('aria-pressed', focus.isolated === b.dataset.part ? 'true' : 'false'));
    $$('#nets-list .row-btn').forEach(b => b.setAttribute('aria-pressed', focus.pinned && focus.pinned.net === b.dataset.net ? 'true' : 'false'));
  }

  // ------------------------------------------------------------------ stage: tooltip from scene:hover
  const pointer = { x: 0, y: 0, inside: false };
  let tipHideTimer = 0;
  function initStage() {
    const stage = $('#stage');
    stage.addEventListener('pointermove', e => {
      const r = stage.getBoundingClientRect();
      pointer.x = e.clientX - r.left; pointer.y = e.clientY - r.top; pointer.inside = true;
      const tip = $('#tooltip');
      if (!tip.hidden) placeTip();
    }, { passive: true });
    stage.addEventListener('pointerleave', () => { pointer.inside = false; hideTip(); });
    const canvas = $('#scene-canvas');
    let down = null;
    canvas.addEventListener('pointerdown', e => { down = { x: e.clientX, y: e.clientY }; hideHint(); });
    canvas.addEventListener('pointermove', e => {
      if (down && Math.hypot(e.clientX - down.x, e.clientY - down.y) > 6) { down = null; markCamera(null); }
    });
    canvas.addEventListener('pointerup', () => { down = null; });
    canvas.addEventListener('wheel', () => { hideHint(); markCamera(null); }, { passive: true });
    $$('#dock [data-cam]').forEach(b => b.addEventListener('click', () => setCamera(b.dataset.cam)));
    $('#dock-rotate').addEventListener('click', () => setView('autoRotate', !settings.view.autoRotate));
  }
  let tipKey = '';
  function sceneHover(h) {
    const tip = $('#tooltip');
    const has = h && (h.part || h.net || h.pin || h.key || h.card || h.wire);
    $('#stage').dataset.hover = has ? 'true' : 'false';
    focus.sceneHover = has && (h.net || h.part) ? { net: h.net || null, part: h.net ? null : h.part } : null;
    schemMark(focus.sceneHover || focus.hover || focus.pinned);
    if (!has) { tipKey = ''; hideTip(); return; }
    clearTimeout(tipHideTimer);
    if (!pointer.inside && typeof h.x === 'number') { pointer.x = h.x; pointer.y = h.y; }
    const key = [h.part, h.net, h.pin, h.key, h.card, h.wire].join('|');
    if (key !== tipKey || tip.hidden) {
      tipKey = key;
      tip.textContent = '';
      append(tip, tipContent(h));
      tip.hidden = false;
      raf(() => tip.classList.add('is-on'));
    }
    placeTip();
  }
  function hideTip() {
    const tip = $('#tooltip');
    clearTimeout(tipHideTimer);
    tip.classList.remove('is-on');
    tipHideTimer = setTimeout(() => { tip.hidden = true; }, 160);
  }
  function placeTip() {
    const tip = $('#tooltip'), stage = $('#stage');
    const W = stage.clientWidth, H = stage.clientHeight, w = tip.offsetWidth, h = tip.offsetHeight;
    let x = pointer.x + 18, y = pointer.y + 18;
    if (x + w > W - 12) x = pointer.x - w - 18;
    if (y + h > H - 12) y = pointer.y - h - 18;
    tip.style.transform = '';
    tip.style.left = Math.round(clamp(x, 12, Math.max(12, W - w - 12))) + 'px';
    tip.style.top = Math.round(clamp(y, 12, Math.max(12, H - h - 12))) + 'px';
  }
  function wiresOfNet(id) { return (MC.WIRES || []).filter(w => w.net === id); }
  function endText(e) {
    if (e.part === 'breadboard') return 'bb ' + e.pin.replace('gnd_lower_inner:', 'gnd rail ');
    return partShort(e.part) + ' ' + e.pin;
  }
  function netsOfPart(id) {
    const ids = [];
    (MC.WIRES || []).forEach(w => { if ((w.from.part === id || w.to.part === id) && ids.indexOf(w.net) < 0) ids.push(w.net); });
    if (id === 'buzzer' || id === 'resistor') ['BUZ_S', id === 'buzzer' ? 'GND' : 'BUZ'].forEach(n => { if (ids.indexOf(n) < 0) ids.push(n); });
    return ids;
  }
  function tipContent(h) {
    const out = [];
    if (h.key) {
      const info = KEY_INFO[h.key] || '';
      out.push(el('div', { class: 'tt-kind', text: '4×4 keypad' }));
      out.push(el('div', { class: 'tt-title', text: 'key ' + h.key }));
      if (info) out.push(el('div', { class: 'tt-desc', text: info }));
      out.push(el('div', { class: 'tt-pins', text: 'click to press · keyboard ' + h.key.toLowerCase() }));
      return out;
    }
    const cardId = h.card || (h.part && /^card_/.test(h.part) ? h.part.slice(5) : null);
    if (cardId) {
      const acc = accounts.find(a => a.uid === cardId);
      const p = part('card_' + cardId);
      out.push(el('div', { class: 'tt-kind', text: 'transponder' }));
      out.push(el('div', { class: 'tt-title', text: p ? p.name : cardId }));
      if (p) out.push(el('div', { class: 'tt-desc', text: p.desc }));
      out.push(el('div', { class: 'tt-pins' }, [
        el('div', {}, ['uid ', el('b', { text: MC.formatUid ? MC.formatUid(cardId) : cardId })]),
        el('div', { text: acc ? (acc.flag === 1 ? 'banned' : acc.flag === 2 ? 'admin card, unlimited' : 'balance ' + money(acc.balance)) : 'not registered, gets ' + (rules().STARTGUTHABEN || 100) + ' € on the first tap' }),
        el('div', { text: 'click to hold it to the reader' })
      ]));
      return out;
    }
    const n = h.net ? net(h.net) : null;
    const p = h.part ? part(h.part) : null;
    const wire = h.wire ? (MC.WIRES || []).find(w => w.id === h.wire) : null;
    if (wire) {
      const others = wiresOfNet(wire.net).filter(w => w !== wire);
      out.push(el('div', { class: 'tt-kind', text: 'jumper wire · ' + (wire.endA === 'female' || wire.endB === 'female' ? 'female–male' : 'male–male') }));
      out.push(el('div', { class: 'tt-head' }, [n ? el('span', { class: 'wire', style: { '--wire': n.color } }) : null, el('span', { class: 'tt-title', text: n ? n.label : wire.net })]));
      out.push(el('div', { class: 'tt-desc' }, [el('b', { text: endText(wire.from) }), ' → ', el('b', { text: endText(wire.to) })]));
      if (n) out.push(el('div', { class: 'tt-desc', text: n.desc }));
      if (others.length) out.push(el('div', { class: 'tt-pins' }, [el('div', { text: 'same net' })].concat(others.slice(0, 4).map(w => el('div', {}, [el('b', { text: endText(w.from) }), ' → ', endText(w.to)])))));
      out.push(el('div', { class: 'tt-pins', text: 'click to trace the net' }));
      return out;
    }
    if (p && h.pin) {
      out.push(el('div', { class: 'tt-kind', text: p.short + ' · pin' }));
      out.push(el('div', { class: 'tt-head' }, [n ? el('span', { class: 'wire', style: { '--wire': n.color } }) : null, el('span', { class: 'tt-title', text: h.pin + (n ? ' · ' + n.label : '') })]));
      if (n) out.push(el('div', { class: 'tt-desc', text: n.desc }));
      const ws = (MC.WIRES || []).filter(w => (w.from.part === h.part && w.from.pin === h.pin) || (w.to.part === h.part && w.to.pin === h.pin));
      if (ws.length) out.push(el('div', { class: 'tt-pins' }, ws.map(w => el('div', {}, [el('b', { text: endText(w.from) }), ' → ', endText(w.to)]))));
      out.push(el('div', { class: 'tt-pins', text: 'click to trace the net' }));
      return out;
    }
    if (n) {
      out.push(el('div', { class: 'tt-kind', text: 'net · ' + n.group }));
      out.push(el('div', { class: 'tt-head' }, [el('span', { class: 'wire', style: { '--wire': n.color } }), el('span', { class: 'tt-title', text: n.label })]));
      out.push(el('div', { class: 'tt-desc', text: n.desc }));
      const ws = wiresOfNet(n.id);
      if (ws.length) out.push(el('div', { class: 'tt-pins' }, ws.slice(0, 5).map(w => el('div', {}, [el('b', { text: endText(w.from) }), ' → ', endText(w.to)])).concat(ws.length > 5 ? [el('div', { text: '+ ' + (ws.length - 5) + ' more' })] : [])));
      return out;
    }
    if (p) {
      out.push(el('div', { class: 'tt-kind', text: 'part' }));
      out.push(el('div', { class: 'tt-title', text: p.name }));
      out.push(el('div', { class: 'tt-desc', text: p.desc }));
      const nets = netsOfPart(p.id).map(net).filter(Boolean);
      const pinsText = p.pins ? el('div', { class: 'tt-wrap', text: p.pins }) : null;
      if (pinsText || nets.length) {
        out.push(el('div', { class: 'tt-pins' }, [
          pinsText,
          nets.length ? el('div', { style: { display: 'flex', 'flex-wrap': 'wrap', gap: '4px 10px', 'margin-top': pinsText ? '6px' : '0', 'white-space': 'normal' } },
            nets.slice(0, 10).map(x => el('span', { style: { display: 'inline-flex', 'align-items': 'center', gap: '5px' } }, [el('span', { class: 'wire', style: { '--wire': x.color, width: '12px', height: '5px' } }), x.id === 'V5' ? '5V' : x.id === 'V3V3' ? '3.3V' : x.id]))) : null
        ]));
      }
      return out;
    }
    out.push(el('div', { class: 'tt-title', text: h.pin || '' }));
    return out;
  }

  // ------------------------------------------------------------------ camera & view
  function markCamera(name) {
    settings.camera = name;
    $$('[data-cam]').forEach(b => b.setAttribute('aria-pressed', b.dataset.cam === name ? 'true' : 'false'));
  }
  function setCamera(name) {
    markCamera(name);
    S('camera', name);
    hideHint();
  }
  function setView(key, value) {
    settings.view[key] = !!value;
    S('setView', Object.assign({}, settings.view));
    const sw = $('#view-switches [data-view="' + key + '"]');
    if (sw) sw.checked = !!value;
    if (key === 'autoRotate') $('#dock-rotate').setAttribute('aria-pressed', value ? 'true' : 'false');
  }
  // the dock floats over the bottom of the canvas: centre the product in the space above it
  function layoutInsets() {
    if (sceneMode === 'fallback' || !ctx.scene) return;
    const dock = $('#dock');
    const b = dock && !dock.hidden ? dock.offsetHeight + (media.phone.matches ? 12 : 20) : 0;
    S('setInsets', { bottom: Math.round(b) });
  }

  // the scene reports its view after every change (also when an orbit stops the auto-rotate)
  let lastPreset = null;
  function sceneView(v) {
    if (!v || !ctx.scene) return;
    ['xray', 'body', 'lid', 'wires', 'parts', 'labels', 'autoRotate'].forEach(k => {
      if (typeof v[k] !== 'boolean' || v[k] === settings.view[k]) return;
      settings.view[k] = v[k];
      const sw = $('#view-switches [data-view="' + k + '"]');
      if (sw) sw.checked = v[k];
      if (k === 'autoRotate') $('#dock-rotate').setAttribute('aria-pressed', v[k] ? 'true' : 'false');
    });
    if (typeof v.explode === 'number' && !explodeDragging) { settings.explode = v.explode; syncExplodeButton(); }
    if (v.preset && v.preset !== lastPreset) { lastPreset = v.preset; markCamera(v.preset); }
    if ((v.step === null || v.step === undefined) && build.active && tab !== 'build') { build.active = false; renderStep(false); renderChips(); }
    if ((v.isolated || null) !== focus.isolated) { focus.isolated = v.isolated || null; renderChips(); syncPressed(); }
  }
  function sceneExplode(ex) {
    if (typeof ex !== 'number' || explodeDragging) return;
    showExplode(ex);
    // the target is known for our own moves; moves the scene starts itself settle at an end
    if (ex <= 0.001 || ex >= 0.999) { settings.explode = ex; syncExplodeButton(); }
  }


  // ------------------------------------------------------------------ OLED mirror
  // Module geometry in 0.1 mm, the same numbers as MC.parts.oledModule (parts_boards.js):
  // PCB 35.4 x 33.5, holes 2.0 from the edges, pins 1.6 below the top edge, glass 34.5 x 23.0 at
  // 5.0 with a 3.4 mm COG ledge, viewing area 31.42 x 16.70, active area 29.42 x 14.70 at 2.35.
  const PCB = { w: 354, h: 335 };
  const GLASS = { x: 4.5, y: 50, w: 345, h: 230, ledge: 34 };
  const VIEW = { x: 19.9, y: 63.5, w: 314.2, h: 167 };
  const AA = { x: 29.9, y: 73.5, w: 294.2, h: 147 };
  const OLED_ON = { white: '#EEF5FF', blue: '#38B6FF', yellow: '#FFD84A' };
  function oledPcbSvg() {
    const pins = ['GND', 'VCC', 'SCL', 'SDA'];
    const px = i => 177 + (i - 1.5) * 25.4;
    const holes = [[20, 20], [334, 20], [20, 315], [334, 315]];
    const encH = GLASS.h - GLASS.ledge, ledgeY = GLASS.y + encH, glassB = GLASS.y + GLASS.h;
    const r = v => Math.round(v * 10) / 10;
    let s = '<svg class="oled-pcb" viewBox="0 0 ' + PCB.w + ' ' + PCB.h + '" aria-hidden="true" focusable="false">' +
      '<defs>' +
      '<linearGradient id="oledPcbShade" x1="0" y1="0" x2="0.35" y2="1"><stop offset="0" stop-color="#FFFFFF" stop-opacity=".10"/><stop offset=".45" stop-color="#FFFFFF" stop-opacity="0"/><stop offset="1" stop-color="#000000" stop-opacity=".22"/></linearGradient>' +
      '<radialGradient id="oledSolder" cx=".36" cy=".3" r=".75"><stop offset="0" stop-color="#FFFFFF"/><stop offset=".4" stop-color="#D4D8DD"/><stop offset="1" stop-color="#7F8790"/></radialGradient>' +
      '<linearGradient id="oledGlass" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#2A2E35"/><stop offset=".05" stop-color="#121418"/><stop offset="1" stop-color="#0A0B0D"/></linearGradient>' +
      '<linearGradient id="oledFpc" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="#7E5418"/><stop offset=".15" stop-color="#B98232"/><stop offset=".5" stop-color="#C9913C"/><stop offset=".85" stop-color="#B07A2C"/><stop offset="1" stop-color="#7A5016"/></linearGradient>' +
      '</defs>' +
      '<rect class="pcb" width="354" height="335" rx="6"/>' +
      '<rect width="354" height="335" rx="6" fill="url(#oledPcbShade)"/>' +
      '<rect class="pcb-edge" x="1" y="1" width="352" height="333" rx="5"/>';
    // traces under the mask: from the header pins, and down both sides to the flex bond
    pins.forEach((p, i) => { const x = px(i), x2 = x + (i - 1.5) * 16; s += '<path class="trace" d="M' + r(x) + ' 16V46L' + r(x2) + ' 60V90"/>'; });
    s += '<path class="trace" d="M36 60V290H110M318 60V290H244" style="stroke-width:5"/>';
    // mounting holes with tinned rings
    holes.forEach(h => { s += '<circle class="ring" cx="' + h[0] + '" cy="' + h[1] + '" r="18.5"/><circle cx="' + h[0] + '" cy="' + h[1] + '" r="18.5" fill="url(#oledSolder)" opacity=".4"/><circle class="hole" cx="' + h[0] + '" cy="' + h[1] + '" r="10.5"/>'; });
    // header: plastic on the back, pins pointing away from the glass, solder joints on the front
    s += '<rect class="silk-line" x="124.2" y="2" width="105.6" height="28" rx="1.5"/>';
    pins.forEach((p, i) => {
      const x = r(px(i));
      s += '<circle class="ring" cx="' + x + '" cy="16" r="9.5"/>' +
        '<circle cx="' + x + '" cy="16" r="7.6" fill="url(#oledSolder)"/>' +
        '<rect x="' + r(x - 3.2) + '" y="12.8" width="6.4" height="6.4" rx="1" fill="#EEF0F2" stroke="#9AA1A9" stroke-width=".8"/>' +
        '<text class="silk" x="' + x + '" y="41" text-anchor="middle">' + p + '</text>';
    });
    // glass: substrate with the printed frame, viewing area and active area
    s += '<rect x="' + (GLASS.x - 0.6) + '" y="' + (GLASS.y - 0.4) + '" width="' + (GLASS.w + 1.2) + '" height="' + (GLASS.h + 1.4) + '" rx="2" fill="#000" opacity=".4"/>' +
      '<rect x="' + GLASS.x + '" y="' + GLASS.y + '" width="' + GLASS.w + '" height="' + GLASS.h + '" rx="1.4" fill="#16181B"/>' +
      '<rect x="' + GLASS.x + '" y="' + GLASS.y + '" width="' + GLASS.w + '" height="' + encH + '" rx="1.4" fill="url(#oledGlass)"/>' +
      '<rect x="' + (GLASS.x + 5.5) + '" y="' + (GLASS.y + 5.5) + '" width="' + (GLASS.w - 11) + '" height="' + (encH - 11) + '" fill="none" stroke="rgba(70,74,80,.35)" stroke-width="4.5"/>' +
      '<rect class="glass-view" x="' + VIEW.x + '" y="' + VIEW.y + '" width="' + VIEW.w + '" height="' + VIEW.h + '" fill="#121418" stroke="rgba(120,126,134,.25)" stroke-width=".6"/>' +
      '<rect x="' + (AA.x - 1.2) + '" y="' + (AA.y - 1.2) + '" width="' + (AA.w + 2.4) + '" height="' + (AA.h + 2.4) + '" fill="#030304"/>';
    // COG ledge: traces fanning into the driver, the driver chip, the flex bond
    let fan = '';
    for (let i = 0; i <= 48; i++) {
      const x0 = GLASS.x + 12 + i * (GLASS.w - 24) / 48, x1 = 177 - 85 + i * 170 / 48;
      fan += 'M' + r(x0) + ' ' + ledgeY + 'v2.5L' + r(x1) + ' ' + (ledgeY + 10);
    }
    s += '<path d="' + fan + '" stroke="rgba(150,156,164,.38)" stroke-width=".6" fill="none"/>' +
      '<rect x="92" y="' + r(ledgeY + 10.5) + '" width="170" height="9" rx="1" fill="#24272C"/>' +
      '<rect x="92" y="' + r(ledgeY + 10.5) + '" width="170" height="2" rx="1" fill="#454A52"/>' +
      '<rect x="117" y="' + r(glassB - 12) + '" width="120" height="12" fill="rgba(200,170,90,.35)"/>' +
      '<path d="M114 ' + r(glassB - 3) + 'h126v' + r(PCB.h - glassB + 3) + 'h-126z" fill="url(#oledFpc)"/>' +
      '<path d="M' + [124, 136, 148, 160, 194, 206, 218, 230].map(x => x + ' ' + r(glassB) + 'v' + r(PCB.h - glassB)).join('M') + '" stroke="#F1C46E" stroke-width="2" opacity=".45"/>' +
      '<rect x="' + GLASS.x + '" y="' + GLASS.y + '" width="' + GLASS.w + '" height="1.2" fill="#FFFFFF" opacity=".18"/>' +
      '</svg>';
    return s;
  }
  // A crisp 128x64 mirror: the canvas backing store is an exact multiple of 128 x 64 device pixels.
  function OledView(figure, opts) {
    opts = opts || {};
    const mod = figure.querySelector('.oled-module');
    mod.innerHTML = oledPcbSvg();
    const canvas = el('canvas', { class: 'oled-canvas', role: 'img', 'aria-label': 'oled display contents' });
    const glare = el('span', { class: 'oled-glare', 'aria-hidden': 'true' });
    mod.appendChild(canvas);
    mod.appendChild(glare);
    const g = canvas.getContext('2d');
    let fb = null, px = 2, variant = 'white', dpr = 1;
    function layout() {
      if (figure.offsetParent === null && !figure.closest('.fallback')) return;   // hidden tab: later
      const base = opts.avail ? opts.avail() : (figure.parentElement ? figure.parentElement.clientWidth + 24 : 320);
      const avail = Math.max(140, Math.min(base, opts.max || 400));
      dpr = window.devicePixelRatio || 1;
      const aaCss = avail * AA.w / PCB.w;
      px = Math.max(1, Math.floor(aaCss * dpr / 128 + 1e-6));
      const bw = 128 * px, bh = 64 * px;
      if (canvas.width !== bw || canvas.height !== bh) { canvas.width = bw; canvas.height = bh; }
      const cssW = bw / dpr, cssH = bh / dpr;
      const k = cssW / AA.w;
      const snap = v => Math.round(v * dpr) / dpr;
      mod.style.width = snap(PCB.w * k) + 'px';
      canvas.style.width = cssW + 'px';
      canvas.style.height = cssH + 'px';
      canvas.style.left = snap(AA.x * k) + 'px';
      canvas.style.top = snap(AA.y * k) + 'px';
      glare.style.left = (GLASS.x * k) + 'px';
      glare.style.top = (GLASS.y * k) + 'px';
      glare.style.width = (GLASS.w * k) + 'px';
      glare.style.height = (GLASS.h * k) + 'px';
      paint();
    }
    function onColor(row) {
      if (variant === 'blue') return OLED_ON.blue;
      if (variant === 'yellow-blue') return row < 16 ? OLED_ON.yellow : OLED_ON.blue;
      return OLED_ON.white;
    }
    function paint() {
      const R = MC.OledRenderer;
      if (fb && R && typeof R.draw === 'function') {
        // gap is the dark fraction of a pixel pitch; small dots get less of it so text stays bright
        try {
          R.draw(g, fb, { pixel: px, gap: px >= 4 ? 0.14 : px === 3 ? 0.1 : 0.05, variant, off: '#000000', glow: 0.5, grid: px >= 5 ? 0.016 : 0 });
          return;
        } catch (err) { console.error('[ui] MC.OledRenderer.draw', err); }
      }
      // own painter, used when the renderer is missing
      g.fillStyle = '#000000';
      g.fillRect(0, 0, canvas.width, canvas.height);
      if (!fb) return;
      const d = px - (px >= 4 ? Math.max(1, Math.floor(px / 4)) : 0);
      for (let y = 0; y < 64; y++) {
        g.fillStyle = onColor(y);
        for (let x = 0; x < 128; x++) if (fb[y * 128 + x]) g.fillRect(x * px, y * px, d, d);
      }
    }
    // Layout may put the canvas on a fractional device pixel (centred blocks, odd heights above it):
    // shift it by that fraction so every OLED dot lands on whole device pixels.
    let snapT = 0;
    function snap() {
      snapT = 0;
      if (figure.offsetParent === null && !figure.closest('.fallback')) return;
      canvas.style.transform = '';
      const r = canvas.getBoundingClientRect();
      const k = window.devicePixelRatio || 1;
      const dx = Math.round(r.left * k) / k - r.left, dy = Math.round(r.top * k) / k - r.top;
      if (Math.abs(dx) > 0.001 || Math.abs(dy) > 0.001) canvas.style.transform = 'translate(' + dx.toFixed(3) + 'px,' + dy.toFixed(3) + 'px)';
    }
    const snapSoon = () => { if (!snapT) snapT = raf(snap); };
    const api = {
      layout() { layout(); snapSoon(); },
      draw(f) { if (f) fb = f; paint(); snapSoon(); },
      snap: snapSoon,
      setVariant(v) { variant = v; figure.dataset.variant = v; paint(); },
      canvas
    };
    if (window.ResizeObserver && figure.parentElement) new ResizeObserver(() => { layout(); snapSoon(); }).observe(figure.parentElement);
    layout();
    return api;
  }
  function watchDpr() {
    if (!window.matchMedia) return;
    const m = window.matchMedia('(resolution: ' + (window.devicePixelRatio || 1) + 'dppx)');
    const fn = () => { oledViews.forEach(v => v.layout()); watchDpr(); };
    if (m.addEventListener) m.addEventListener('change', fn, { once: true });
  }

  // ------------------------------------------------------------------ play: session strip
  // write only what changed: the session strip is refreshed four times a second
  function put(node, prop, value) { if (node && node[prop] !== value) node[prop] = value; }
  function putData(node, key, value) { if (node && node.dataset[key] !== value) node.dataset[key] = value; }
  function renderState(s) {
    if (!s) return;
    const sec = $('#session');
    const live = !!s.session;
    const total = sessionSeconds();
    const left = live ? clamp(Number(s.secondsLeft) || 0, 0, total) : 0;
    putData(sec, 'live', live ? 'true' : 'false');
    putData(sec, 'busy', s.busy ? 'true' : 'false');
    putData(sec, 'left', live && left <= 3 ? 'crit' : live && left <= 10 ? 'low' : '');
    const off = live ? String(100 - left / total * 100) : '100';
    const ring = $('#ring-fill');
    if (ring.style.strokeDashoffset !== off) ring.style.strokeDashoffset = off;
    put($('#ring-num'), 'textContent', live ? String(Math.ceil(left)) : '–');
    put($('#session-label'), 'textContent', live ? cardLabel(s.uid) + ' · slot ' + s.slot : 'no session');
    const modeLeft = s.modeSecondsLeft ? ' · ' + s.modeSecondsLeft + ' s' : '';
    const MODES = { stake: 'typing a stake' + (s.input ? ' ' + s.input : ''), logout: 'log out?', help: 'help ' + ((s.helpPage || 0) + 1) + '/3' };
    put($('#session-sub'), 'textContent', !live ? (s.busy ? 'busy' : 'tap a card to log in') : s.busy ? 'spinning …' : MODES[s.mode] ? MODES[s.mode] + modeLeft : (s.uid || ''));
    const bal = $('#stat-balance');
    put(bal, 'textContent', live ? (s.unlimited ? '∞' : money(s.balance)) : '–');
    put(bal, 'title', live && s.unlimited ? 'admin card, unlimited credit (the oled shows inf)' : '');
    put($('#stat-stake'), 'textContent', live ? money(s.stake) : '–');
    const lvl = Number(s.soundLevel) || 0;
    const snd = $('#stat-sound');
    put(snd, 'textContent', SOUND_NAMES[lvl] || '–');
    put(snd, 'title', 'oled: Ton ' + (SOUND_DE[lvl] || ''));
    const uid = String(s.uid || '').toUpperCase();
    $$('#tags .tag').forEach(t => putData(t, 'live', live && t.dataset.uid === uid ? 'true' : 'false'));
  }
  function showResult(r) {
    if (!r) return;
    const d = $('#stat-delta'), v = $('#stat-balance');
    const amount = Math.abs(Number(r.net) || 0);
    d.classList.remove('is-on', 'is-loss');
    void d.offsetWidth;
    d.textContent = (r.win ? '+' : '−') + amount + NBSP + '€';
    d.classList.toggle('is-loss', !r.win);
    d.classList.add('is-on');
    v.classList.remove('is-up', 'is-down');
    v.classList.add(r.win ? 'is-up' : 'is-down');
    setTimeout(() => v.classList.remove('is-up', 'is-down'), 1800);
    const sec = $('#session');
    sec.classList.remove('is-jackpot');
    if (r.jackpot) { void sec.offsetWidth; sec.classList.add('is-jackpot'); setTimeout(() => sec.classList.remove('is-jackpot'), 2600); }
  }

  // ------------------------------------------------------------------ play: transponders
  // Same looks as the 3D transponders in parts_misc.js: white player card, blue fob, paper NTAG
  // sticker, dark coin tag; the black / red / green dots are the card's brand mark.
  function tagIcon(kind) {
    const dots = (x, y, r, s) => '<circle cx="' + x + '" cy="' + y + '" r="' + r + '" fill="#1F2329"/><circle cx="' + (x + s) + '" cy="' + y + '" r="' + r + '" fill="#E5484D"/><circle cx="' + (x + 2 * s) + '" cy="' + y + '" r="' + r + '" fill="#30A46C"/>';
    const waves = (x, y, c) => '<path d="M' + x + ' ' + (y - 2.2) + 'a3 3 0 0 1 0 4.4M' + (x + 1.6) + ' ' + (y - 3.6) + 'a5 5 0 0 1 0 7.2" fill="none" stroke="' + c + '" stroke-width=".9" stroke-linecap="round"/>';
    const svg = {
      card: '<svg viewBox="0 0 26 26" aria-hidden="true"><rect x="1.8" y="5.6" width="22.4" height="14.8" rx="2" fill="#FAFAF9" stroke="#C3C8CF" stroke-width=".7"/>' + dots(5, 9, 0.95, 2.6) + waves(19.4, 9.2, '#7C8592') + '<path d="M4.4 13.2h8.4" stroke="#15171A" stroke-width="1.5" stroke-linecap="round"/><path d="M4.4 17.2h6.2" stroke="#8A929C" stroke-width="1" stroke-linecap="round"/></svg>',
      fob: '<svg viewBox="0 0 26 26" aria-hidden="true"><path d="M13 1.8c2.6 0 4.6 2 4.6 4.6v.7a8.6 8.6 0 1 1-9.2 0v-.7c0-2.6 2-4.6 4.6-4.6z" fill="#2559C6"/><path d="M8.6 8.4a8.6 8.6 0 0 1 8.8 0" fill="none" stroke="#5C86E0" stroke-width=".8"/><circle cx="13" cy="6.4" r="1.9" fill="var(--bg2)"/>' + waves(12.2, 16, '#CFDBF8') + '</svg>',
      sticker: '<svg viewBox="0 0 26 26" aria-hidden="true"><circle cx="13" cy="13" r="10.6" fill="#FAFAF8" stroke="#C3C8CF" stroke-width=".7"/><circle cx="13" cy="13" r="8.2" fill="none" stroke="#D5D9DE" stroke-width=".6"/>' + dots(10.4, 9, 0.9, 2.6) + '<path d="M8.8 13.2h8.4" stroke="#1D2025" stroke-width="1.4" stroke-linecap="round"/><path d="M9.8 16.4h6.4" stroke="#8A929C" stroke-width=".9" stroke-linecap="round"/></svg>',
      coin: '<svg viewBox="0 0 26 26" aria-hidden="true"><circle cx="13" cy="14.1" r="10.2" fill="#0F1012"/><circle cx="13" cy="12.9" r="10.2" fill="#1D1F23"/><circle cx="13" cy="12.9" r="7.4" fill="none" stroke="#3A3E45" stroke-width=".8"/><path d="M5.8 10.6a7.6 7.6 0 0 1 4-4.2" fill="none" stroke="#4E545D" stroke-width=".8" stroke-linecap="round"/>' + waves(12, 12.9, '#B8C0CA') + '</svg>'
    };
    const wrap = el('span', { class: 'tag-icon', 'aria-hidden': 'true' });
    wrap.innerHTML = svg[kind] || svg.card;
    return wrap;
  }
  function buildTags() {
    const host = $('#tags');
    host.textContent = '';
    (MC.CARDS || []).forEach(c => {
      const b = el('button', {
        type: 'button', class: 'tag', role: 'listitem', 'data-uid': c.uid, 'data-live': 'false',
        title: 'uid ' + (MC.formatUid ? MC.formatUid(c.uid) : c.uid),
        onclick: () => { if (ctx.tapCard) ctx.tapCard(c.uid, 'ui'); },
        onmouseenter: () => hover({ part: c.part }),
        onmouseleave: () => hover(null)
      }, [
        tagIcon(c.kind),
        el('span', { class: 'tag-name', text: cardLabel(c.uid) }),
        el('span', { class: 'tag-bal is-new', text: 'new' }),
        el('span', { class: 'tag-uid', text: c.uid })
      ]);
      host.appendChild(b);
    });
    renderTags();
  }
  function renderTags() {
    $$('#tags .tag').forEach(t => {
      const a = accounts.find(x => x.uid === t.dataset.uid);
      const key = a ? a.flag + ':' + a.balance : 'new';
      if (t._key === key) return;
      t._key = key;
      const bal = t.querySelector('.tag-bal');
      bal.textContent = '';
      bal.className = 'tag-bal';
      let status = 'not registered yet';
      if (!a) { bal.textContent = 'new'; bal.classList.add('is-new'); }
      else if (a.flag === 1) { bal.appendChild(el('span', { class: 'badge badge-ban', text: 'banned' })); status = 'banned'; }
      else if (a.flag === 2) { bal.appendChild(el('span', { class: 'badge badge-admin', text: 'admin ∞' })); status = 'admin card'; }
      else { bal.textContent = money(a.balance); status = 'balance ' + money(a.balance); }
      t.setAttribute('aria-label', 'hold the ' + cardLabel(t.dataset.uid) + ' ' + t.dataset.uid + ' to the reader, ' + status);
    });
  }
  function refreshAccounts() {
    if (!ctx.sim || typeof ctx.sim.accounts !== 'function') return;
    try { accounts = (ctx.sim.accounts() || []).map(a => Object.assign({}, a, { uid: String(a.uid).toUpperCase(), flag: Number(a.flag) || 0, balance: Number(a.balance) || 0 })); }
    catch (err) { console.error('[ui] sim.accounts', err); return; }
    renderTags();
  }
  function cardTapping(uid, on) {
    const t = $('#tags .tag[data-uid="' + cssEsc(String(uid).toUpperCase()) + '"]');
    if (t) t.dataset.tapping = on ? 'true' : 'false';
  }

  // ------------------------------------------------------------------ play: keypad + legend
  const KEY_INFO = {
    '1': 'bet on black', '2': 'bet on red', '3': 'bet on green',
    A: 'type a new stake', B: 'log out', C: 'sound loud, quiet, off', D: 'help',
    '*': 'delete, no, back', '#': 'ok, yes',
    '0': 'digit', '4': 'digit', '5': 'digit', '6': 'digit', '7': 'digit', '8': 'digit', '9': 'digit'
  };
  function buildKeypad() {
    const host = $('#keypad');
    host.textContent = '';
    KEYS.split('').forEach(ch => {
      const cls = 'key' + (/[A-D]/.test(ch) ? ' key-fn' : /[*#]/.test(ch) ? ' key-sym' : '');
      const b = el('button', { type: 'button', class: cls, 'data-key': ch, 'aria-label': 'key ' + ch + ', ' + KEY_INFO[ch], text: ch });
      let downAt = 0;
      const release = () => {
        const wait = Math.max(0, 110 - (now() - downAt));
        setTimeout(() => b.classList.remove('is-down'), wait);
      };
      b.addEventListener('pointerdown', e => {
        if (e.button !== 0) return;
        e.preventDefault();               // keeps focus where it is, no text selection
        downAt = now();
        b.classList.add('is-down');
        if (ctx.pressKey) ctx.pressKey(ch, 'ui');
      });
      b.addEventListener('pointerup', release);
      b.addEventListener('pointercancel', release);
      b.addEventListener('pointerleave', () => { if (b.classList.contains('is-down')) release(); });
      b.addEventListener('click', e => { if (e.detail === 0 && ctx.pressKey) { ctx.pressKey(ch, 'ui'); flashKey(ch); } });
      b.addEventListener('mouseenter', () => hover({ part: 'keypad' }));
      b.addEventListener('mouseleave', () => hover(null));
      host.appendChild(b);
    });
    const r = rules();
    const pct = (k, d) => (r[k] !== undefined ? r[k] : d);
    const legend = [
      ['1', 'bet on black · ' + pct('BLACK_PERCENT', 45) + ' % · pays 2×', 'black'],
      ['2', 'bet on red · ' + pct('RED_PERCENT', 45) + ' % · pays 2×', 'red'],
      ['3', 'bet on green · ' + pct('GREEN_PERCENT', 10) + ' % · pays 9×', 'green'],
      ['A', 'type a new stake, # saves it'],
      ['B', 'log out, # yes · * no'],
      ['C', 'sound loud → quiet → off'],
      ['D', 'help, three pages'],
      ['0–9', 'digits while typing a stake'],
      ['#', 'ok · yes'],
      ['*', 'delete · no · back']
    ];
    const dl = $('#legend-list');
    dl.textContent = '';
    legend.forEach(row => {
      const k = row[0];
      const kcls = /^[A-D]$/.test(k) ? 'k k-fn' : /^[*#]$/.test(k) ? 'k k-sym' : 'k';
      dl.appendChild(el('dt', {}, k === '0–9' ? [el('span', { class: 'k', text: '0' }), el('span', { class: 'k', text: '9' })] : el('span', { class: kcls, text: k })));
      dl.appendChild(el('dd', {}, [row[2] ? el('span', { class: 'dot-game', style: { background: 'var(--game-' + row[2] + ')' } }) : null, row[1]]));
    });
    const stake = (r.STAKE || 10) + '–' + (r.STAKE_MAX || 2550) + ' €';
    dl.appendChild(el('dd', { style: { 'grid-column': '1 / -1', color: 'var(--muted)', 'margin-top': '4px' }, text: 'stake ' + stake + ' in steps of ' + (r.STAKE_SCHRITT || 10) + '. the session ends after ' + sessionSeconds() + ' s without a key, menus fall back after ' + Math.round((r.MODUS_MS || 20000) / 1000) + ' s.' }));
  }
  function flashKey(ch) {
    const b = $('#keypad .key[data-key="' + cssEsc(ch) + '"]');
    if (!b) return;
    b.classList.add('is-down');
    clearTimeout(b._t);
    b._t = setTimeout(() => b.classList.remove('is-down'), 130);
  }

  // ------------------------------------------------------------------ serial monitor + admin console log
  const LOG_MAX = 400;
  const t0 = now();
  const queue = [];
  let flushing = false;
  // Every admin command shows up as a 'tx' serial line from the sim, its reply ends with one
  // '#OK' or '#ERR' line (replies come in order). Background polls are muted by marking their
  // command text before sending and dropping that command's '#' reply lines.
  const muteNext = [];
  const outstanding = [];
  function stamp(t) {
    const s = t / 1000, m = Math.floor(s / 60);
    const sec = s - m * 60;
    return pad2(m) + ':' + (sec < 10 ? '0' : '') + sec.toFixed(1);
  }
  function lineClass(l) {
    if (l.dir === 'tx') return 'ln-tx';
    const t = l.text;
    if (/^#ERR/.test(t)) return 'ln-err';
    if (/^#OK/.test(t)) return 'ln-ok';
    if (/^#/.test(t)) return 'ln-row';
    if (/^\[/.test(t)) return 'ln-log';
    if (l.sys) return 'ln-sys';
    return 'ln-rx';
  }
  function serial(line) {
    if (!line || line.text === undefined || line.text === null) return;
    const text = String(line.text);
    const dir = line.dir === 'tx' ? 'tx' : 'rx';
    const t = now();
    while (outstanding.length && t - outstanding[0].t > 15000) outstanding.shift();   // never stay stuck
    if (dir === 'tx') {
      const i = muteNext.indexOf(text);
      const silent = i >= 0;
      if (silent) muteNext.splice(i, 1);
      if (text.trim()) outstanding.push({ silent, t });
      if (silent) return;
    } else if (text.charAt(0) === '#' && outstanding.length) {
      const head = outstanding[0];
      if (/^#(OK|ERR)/.test(text)) outstanding.shift();
      if (head.silent) return;
    }
    pushLine({ text, dir });
  }
  function pushLine(l) {
    l.t = now() - t0;
    queue.push(l);
    if (!flushing) { flushing = true; raf(flush); }
  }
  function flush() {
    flushing = false;
    const mon = $('#monitor'), con = $('#console-log');
    const atBottom = e => e.scrollTop + e.clientHeight >= e.scrollHeight - 28;
    const stick = [atBottom(mon), atBottom(con)];
    const fm = doc.createDocumentFragment(), fc = doc.createDocumentFragment();
    queue.splice(0).forEach(l => {
      const row = () => el('div', { class: 'ln ' + lineClass(l) }, [
        el('span', { class: 'ln-t', text: stamp(l.t) }),
        el('span', { class: 'ln-d', text: l.dir === 'tx' ? '→' : '←' }),
        el('span', { class: 'ln-x', text: l.text })
      ]);
      fm.appendChild(row());
      if (l.dir === 'tx' || /^#/.test(l.text)) fc.appendChild(row());
    });
    [[mon, fm, stick[0]], [con, fc, stick[1]]].forEach(x => {
      const host = x[0];
      if (!x[1].childNodes.length) return;
      const empty = host.querySelector('.monitor-empty');
      if (empty) empty.remove();
      host.appendChild(x[1]);
      while (host.childElementCount > LOG_MAX) host.firstElementChild.remove();
      if (x[2]) host.scrollTop = host.scrollHeight;
    });
  }
  function monitorEmpty(host, text) {
    host.textContent = '';
    host.appendChild(el('div', { class: 'monitor-empty', text }));
  }
  function initMonitor() {
    monitorEmpty($('#monitor'), 'waiting for the uno …');
    monitorEmpty($('#console-log'), 'type a command below or use the controls above.');
    $('#monitor-clear').addEventListener('click', () => monitorEmpty($('#monitor'), 'cleared.'));
    $('#console-clear').addEventListener('click', () => monitorEmpty($('#console-log'), 'cleared.'));
    const dbg = $('#debug-log');
    dbg.checked = settings.debugLog;
    const canDebug = () => ctx.sim && typeof ctx.sim.setDebugLog === 'function';
    dbg.addEventListener('change', () => {
      settings.debugLog = dbg.checked;
      store.set('debugLog', dbg.checked);
      if (canDebug()) { try { ctx.sim.setDebugLog(dbg.checked); } catch (err) { console.error('[ui] sim.setDebugLog', err); } }
      pushLine({ text: dbg.checked ? 'debug log on: the uno prints its [ms] THEMA | text lines' : 'debug log off', dir: 'rx', sys: true });
    });
  }

  // ------------------------------------------------------------------ explore
  function setRangeFill(r) { r.style.setProperty('--p', (Number(r.value) * 100 / (Number(r.max) || 1)) + '%'); }
  // The scene animates the explode itself (a staged assembly sequence); the slider drives it
  // directly while dragged and follows scene:explode otherwise.
  let explodeDragging = false;
  function showExplode(v) {
    const r = $('#explode');
    r.value = String(clamp(v, 0, 1));
    setRangeFill(r);
    const txt = v < 0.005 ? 'assembled' : v > 0.995 ? 'exploded' : 'exploded ' + Math.round(v * 100) + ' %';
    $('#explode-value').textContent = txt;
    r.setAttribute('aria-valuetext', txt);
  }
  function setExplode(v, animate) {
    settings.explode = clamp(v, 0, 1);
    if (!animate || sceneMode !== 'ready') showExplode(settings.explode);
    syncExplodeButton();
    S('setExplode', settings.explode, animate ? undefined : { instant: true });
  }
  function syncExplodeButton() {
    const b = $('#explode-play');
    setIcon(b.querySelector('svg'), 'play');
    b.querySelector('span').textContent = settings.explode > 0.5 ? 'assemble' : 'explode';
    b.setAttribute('aria-label', settings.explode > 0.5 ? 'play the assembly' : 'explode the console');
  }
  function playExplode() { setExplode(settings.explode > 0.5 ? 0 : 1, true); }
  function initExplore() {
    const r = $('#explode');
    r.addEventListener('pointerdown', () => { explodeDragging = true; });
    const endDrag = () => { explodeDragging = false; };
    r.addEventListener('pointerup', endDrag);
    r.addEventListener('pointercancel', endDrag);
    r.addEventListener('change', endDrag);
    r.addEventListener('input', () => setExplode(Number(r.value), false));
    setRangeFill(r);
    syncExplodeButton();
    $('#explode-play').addEventListener('click', playExplode);
    $$('#view-switches [data-view]').forEach(sw => {
      sw.checked = !!settings.view[sw.dataset.view];
      sw.addEventListener('change', () => setView(sw.dataset.view, sw.checked));
    });
    $('#dock-rotate').setAttribute('aria-pressed', settings.view.autoRotate ? 'true' : 'false');
    $$('#cam-seg [data-cam]').forEach(b => b.addEventListener('click', () => setCamera(b.dataset.cam)));

    // case colours
    const sw = $('#swatches');
    caseColors.forEach(c => {
      const b = el('button', { type: 'button', class: 'swatch', role: 'radio', 'aria-checked': 'false', 'data-hex': c.hex, title: c.name },
        [el('span', { class: 'swatch-chip', style: { '--sw': c.hex } }), el('span', { text: c.name })]);
      b.addEventListener('click', () => setCaseColor(c.hex));
      sw.appendChild(b);
    });
    radioKeys(sw, '.swatch');
    setCaseColor(settings.caseColor, true);

    $$('#oled-seg [data-variant]').forEach(b => b.addEventListener('click', () => setOledVariant(b.dataset.variant)));
    radioKeys($('#oled-seg'), '.seg-btn');
    setOledVariant(settings.oledVariant, true);
    $$('#quality-seg [data-quality]').forEach(b => b.addEventListener('click', () => setQuality(b.dataset.quality)));
    radioKeys($('#quality-seg'), '.seg-btn');
    setQuality(settings.quality, true);

    buildPartsList();
    buildNetsList();
  }
  // arrow keys inside radio groups
  function radioKeys(group, sel) {
    group.addEventListener('keydown', e => {
      if (['ArrowRight', 'ArrowDown', 'ArrowLeft', 'ArrowUp'].indexOf(e.key) < 0) return;
      const items = $$(sel, group).filter(b => !b.disabled);
      const i = items.indexOf(doc.activeElement);
      if (i < 0) return;
      e.preventDefault();
      const n = items[(i + (e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1 : items.length - 1)) % items.length];
      n.focus();
      n.click();
    });
  }
  function checkRadio(group, sel, match) {
    $$(sel, group).forEach(b => { const on = match(b); b.setAttribute('aria-checked', on ? 'true' : 'false'); b.tabIndex = on ? 0 : -1; });
  }
  function setCaseColor(hex, silent) {
    const known = caseColors.some(c => c.hex.toLowerCase() === String(hex).toLowerCase());
    settings.caseColor = known ? hex : (caseColors[0] ? caseColors[0].hex : hex);
    checkRadio($('#swatches'), '.swatch', b => b.dataset.hex.toLowerCase() === settings.caseColor.toLowerCase());
    store.set('caseColor', settings.caseColor);
    if (!silent) S('setCaseColor', settings.caseColor);
  }
  function setOledVariant(v, silent) {
    settings.oledVariant = v;
    checkRadio($('#oled-seg'), '.seg-btn', b => b.dataset.variant === v);
    store.set('oledVariant', v);
    oledViews.forEach(o => o.setVariant(v));
    if (!silent) S('setOledVariant', v);
  }
  function setQuality(q, silent) {
    settings.quality = q;
    checkRadio($('#quality-seg'), '.seg-btn', b => b.dataset.quality === q);
    store.set('quality', q);
    if (!silent) S('setQuality', q);
  }
  const PART_ICONS = { uno: 'chip', oled: 'screen', rc522: 'signal', keypad: 'key', breadboard: 'grid', buzzer: 'sound', resistor: 'resistor', case_base: 'cube', case_lid: 'layers' };
  function buildPartsList() {
    const host = $('#parts-list');
    host.textContent = '';
    (MC.PARTS || []).filter(p => !/^card_/.test(p.id)).forEach(p => {
      const b = el('button', { type: 'button', class: 'row-btn', role: 'listitem', 'data-part': p.id, 'aria-pressed': 'false', 'aria-label': p.name + ', click to isolate' }, [
        el('span', { class: 'row-icon' }, icon(PART_ICONS[p.id] || 'cube')),
        el('span', { class: 'row-title', text: p.name }),
        el('span', { class: 'row-sub', text: p.desc }),
        el('span', { class: 'row-end' }, [icon('target')])
      ]);
      b.addEventListener('mouseenter', () => hover({ part: p.id }));
      b.addEventListener('mouseleave', () => hover(null));
      b.addEventListener('focus', () => hover({ part: p.id }));
      b.addEventListener('blur', () => hover(null));
      b.addEventListener('click', () => isolate(p.id));
      host.appendChild(b);
    });
  }
  const GROUP_NAMES = { power: 'power', i2c: 'i2c · oled', spi: 'spi · rc522', sound: 'sound · buzzer', keypad: 'keypad · 4×4 matrix' };
  function buildNetsList() {
    const host = $('#nets-list');
    host.textContent = '';
    const groups = [];
    (MC.NETS || []).forEach(n => { let g = groups.find(x => x.id === n.group); if (!g) groups.push(g = { id: n.group, nets: [] }); g.nets.push(n); });
    groups.forEach(g => {
      const box = el('div', { class: 'net-group', role: 'group', 'aria-label': GROUP_NAMES[g.id] || g.id }, [
        el('div', { class: 'net-group-title' }, [el('span', { text: GROUP_NAMES[g.id] || g.id }), el('span', { text: String(g.nets.reduce((a, n) => a + wiresOfNet(n.id).length, 0)) + ' wires' })])
      ]);
      const list = el('div', { class: 'list' });
      g.nets.forEach(n => {
        const count = wiresOfNet(n.id).length;
        const b = el('button', { type: 'button', class: 'row-btn net-btn', 'data-net': n.id, 'aria-pressed': 'false', 'aria-label': n.label + ', ' + n.desc + ', click to trace' }, [
          el('span', { class: 'row-icon' }, el('span', { class: 'wire', style: { '--wire': n.color } })),
          el('span', { class: 'row-title', text: n.label }),
          el('span', { class: 'row-sub', text: n.desc }),
          el('span', { class: 'row-end' }, [count ? count + (count === 1 ? ' wire' : ' wires') : 'on board'])
        ]);
        b.addEventListener('mouseenter', () => hover({ net: n.id }));
        b.addEventListener('mouseleave', () => hover(null));
        b.addEventListener('click', () => pin({ net: n.id }));
        list.appendChild(b);
      });
      box.appendChild(list);
      host.appendChild(box);
    });
  }

  // ------------------------------------------------------------------ schematic: inline svg with pan / zoom
  const schem = { svg: null, base: null, view: null, themeShown: null, drag: null, pointers: new Map(), hot: [], moved: false };
  function schemHost() { return $('#schem'); }
  function schemShow() {
    schemRender();
    if (schem.svg && !schem.view) schemFit();
  }
  function schemRender() {
    const host = $('#schem-svg');
    if (!host) return;
    const data = window.MC_SCHEMATIC;
    const markup = data && (data[theme] || data.dark || data.light);
    if (!markup) {
      if (!host.querySelector('.schem-empty')) {
        host.innerHTML = '';
        host.appendChild(el('div', { class: 'schem-empty' }, el('div', {}, [
          icon('alert'),
          el('b', { text: 'schematic data missing' }),
          el('span', { html: 'data/schematic.js was not found. run <code>python docs/make_graphics.py</code> to build it. the connection list below has every wire.' })
        ])));
      }
      schem.svg = null;
      $('#schem-zoom').hidden = true;
      return;
    }
    if (schem.themeShown === theme && schem.svg) return;
    const keep = schem.view && schem.base ? { cx: schem.view.x + schem.view.w / 2, cy: schem.view.y + schem.view.h / 2, w: schem.view.w } : null;
    host.innerHTML = markup;
    const svg = host.querySelector('svg');
    if (!svg) { schem.svg = null; return; }
    schem.themeShown = theme;
    let vb = svg.viewBox && svg.viewBox.baseVal && svg.viewBox.baseVal.width ? svg.viewBox.baseVal : null;
    const base = vb ? { x: vb.x, y: vb.y, w: vb.width, h: vb.height }
      : { x: 0, y: 0, w: parseFloat(svg.getAttribute('width')) || 1000, h: parseFloat(svg.getAttribute('height')) || 700 };
    svg.removeAttribute('width');
    svg.removeAttribute('height');
    svg.setAttribute('preserveAspectRatio', 'xMidYMid meet');
    svg.setAttribute('role', 'img');
    if (!svg.getAttribute('aria-label')) svg.setAttribute('aria-label', 'schematic of the mini casino V11');
    schem.svg = svg;
    schem.base = base;
    schem.hot = [];
    $('#schem-zoom').hidden = false;
    if (keep) { schem.view = { x: keep.cx - keep.w / 2, y: 0, w: keep.w, h: 0 }; schemAspect(keep.cx, keep.cy); }
    else schem.view = null;
    if ($('#schem').clientWidth) { if (!schem.view) schemFit(); else schemApply(); }
    schemMark(focus.sceneHover || focus.hover || focus.pinned);
  }
  function schemSize() { const h = schemHost(); return { W: Math.max(1, h.clientWidth), H: Math.max(1, h.clientHeight) }; }
  function schemFit() {
    if (!schem.svg) return;
    const { W, H } = schemSize(), b = schem.base, ca = W / H;
    let w, h;
    if (b.w / b.h > ca) { w = b.w * 1.04; h = w / ca; } else { h = b.h * 1.04; w = h * ca; }
    schem.view = { x: b.x + b.w / 2 - w / 2, y: b.y + b.h / 2 - h / 2, w, h };
    schem.fitW = w;
    schemApply();
  }
  function schemAspect(cx, cy) {     // keep zoom and centre, follow a new container aspect
    const { W, H } = schemSize(), v = schem.view;
    v.h = v.w * H / W;
    v.x = cx - v.w / 2; v.y = cy - v.h / 2;
    const b = schem.base, ca = W / H;
    schem.fitW = b.w / b.h > ca ? b.w * 1.04 : b.h * 1.04 * ca;
  }
  function schemApply() {
    if (!schem.svg || !schem.view) return;
    const v = schem.view;
    schem.svg.setAttribute('viewBox', v.x.toFixed(2) + ' ' + v.y.toFixed(2) + ' ' + v.w.toFixed(2) + ' ' + v.h.toFixed(2));
    $('#schem-zoom').textContent = Math.round((schem.fitW || v.w) / v.w * 100) + ' %';
  }
  function schemZoomAt(f, px, py) {
    if (!schem.svg || !schem.view) return;
    const { W, H } = schemSize(), v = schem.view;
    const sx = v.x + px / W * v.w, sy = v.y + py / H * v.h;
    const fitW = schem.fitW || v.w;
    const nw = clamp(v.w / f, fitW / 14, fitW * 1.25), nh = nw * H / W;
    v.x = sx - px / W * nw; v.y = sy - py / H * nh; v.w = nw; v.h = nh;
    schemApply();
  }
  function schemPan(dx, dy) {
    if (!schem.view) return;
    const { W, H } = schemSize(), v = schem.view;
    v.x -= dx * v.w / W; v.y -= dy * v.h / H;
    schemApply();
  }
  function schemCmd(cmd) {
    const { W, H } = schemSize();
    if (cmd === 'in') schemZoomAt(1.4, W / 2, H / 2);
    else if (cmd === 'out') schemZoomAt(1 / 1.4, W / 2, H / 2);
    else if (cmd === 'fit') schemFit();
    else if (cmd === 'open') schemOpen();
  }
  function initSchematic() {
    const host = schemHost();
    $$('[data-schem]').forEach(b => b.addEventListener('click', () => schemCmd(b.dataset.schem)));
    host.addEventListener('wheel', e => {
      if (!schem.svg) return;
      e.preventDefault();
      const r = host.getBoundingClientRect();
      const dy = e.deltaMode === 1 ? e.deltaY * 18 : e.deltaY;
      schemZoomAt(Math.exp(-dy * 0.0016), e.clientX - r.left, e.clientY - r.top);
    }, { passive: false });
    host.addEventListener('pointerdown', e => {
      if (!schem.svg || (e.pointerType === 'mouse' && e.button !== 0)) return;
      schem.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      schem.moved = false;
      schem.drag = { x: e.clientX, y: e.clientY, d: pinchDist() };
      try { host.setPointerCapture(e.pointerId); } catch (err) { /* ignore */ }
    });
    host.addEventListener('pointermove', e => {
      if (!schem.pointers.has(e.pointerId)) return;
      schem.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      const r = host.getBoundingClientRect();
      if (schem.pointers.size >= 2) {
        const d = pinchDist(), c = pinchCenter();
        if (schem.drag && schem.drag.d) schemZoomAt(d / schem.drag.d, c.x - r.left, c.y - r.top);
        if (schem.drag && schem.drag.c) schemPan(c.x - schem.drag.c.x, c.y - schem.drag.c.y);
        schem.drag = { d, c };
        schem.moved = true;
        return;
      }
      const dx = e.clientX - schem.drag.x, dy = e.clientY - schem.drag.y;
      if (!schem.moved && Math.hypot(dx, dy) < 4) return;
      if (!schem.moved) { schem.moved = true; host.classList.add('is-panning'); }
      schemPan(dx, dy);
      schem.drag.x = e.clientX; schem.drag.y = e.clientY;
    });
    const end = e => {
      schem.pointers.delete(e.pointerId);
      if (schem.pointers.size === 1) { const p = schem.pointers.values().next().value; schem.drag = { x: p.x, y: p.y, d: 0 }; }
      if (!schem.pointers.size) { host.classList.remove('is-panning'); }
    };
    host.addEventListener('pointerup', end);
    host.addEventListener('pointercancel', end);
    host.addEventListener('dblclick', e => {
      if (!schem.svg) return;
      const r = host.getBoundingClientRect();
      schemZoomAt(e.shiftKey ? 1 / 2 : 2, e.clientX - r.left, e.clientY - r.top);
    });
    host.addEventListener('keydown', e => {
      const step = 40;
      const map = { ArrowLeft: [step, 0], ArrowRight: [-step, 0], ArrowUp: [0, step], ArrowDown: [0, -step] };
      if (map[e.key]) { e.preventDefault(); schemPan(map[e.key][0], map[e.key][1]); }
      else if (e.key === '+' || e.key === '=') { e.preventDefault(); schemCmd('in'); }
      else if (e.key === '-' || e.key === '_') { e.preventDefault(); schemCmd('out'); }
      else if (e.key === 'Home') { e.preventDefault(); schemFit(); }
    });
    // hover / click linking with the 3D view
    const svgHost = $('#schem-svg');
    const target = e => (e.target && e.target.closest ? e.target.closest('[data-net],[data-part]') : null);
    svgHost.addEventListener('pointerover', e => {
      if (host.classList.contains('is-panning')) return;
      const t = target(e);
      if (!t || !svgHost.contains(t)) return;
      const n = t.getAttribute('data-net'), p = t.getAttribute('data-part');
      hover(n ? { net: n } : { part: p });
    });
    svgHost.addEventListener('pointerout', e => {
      const t = target(e);
      if (!t) return;
      const to = e.relatedTarget && e.relatedTarget.closest ? e.relatedTarget.closest('[data-net],[data-part]') : null;
      if (to === t) return;
      if (!to) hover(null);
    });
    svgHost.addEventListener('click', e => {
      if (schem.moved) { schem.moved = false; return; }
      const t = target(e);
      if (!t) return;
      const n = t.getAttribute('data-net'), p = t.getAttribute('data-part');
      pin(n ? { net: n } : { part: p });
    });
    if (window.ResizeObserver) {
      new ResizeObserver(() => {
        if (!schem.svg || !schem.view) return;
        const v = schem.view;
        schemAspect(v.x + v.w / 2, v.y + v.h / 2);
        schemApply();
      }).observe(host);
    }
    // modal
    const modal = $('#schem-modal');
    $$('[data-close]', modal).forEach(b => b.addEventListener('click', schemClose));
    modal.addEventListener('keydown', e => {
      if (e.key === 'Escape') { e.preventDefault(); schemClose(); }
      if (e.key === 'Tab') {             // keep focus inside the dialog
        const f = $$('button, [tabindex="0"]', modal).filter(x => !x.disabled && x.offsetParent !== null);
        if (!f.length) return;
        if (e.shiftKey && doc.activeElement === f[0]) { e.preventDefault(); f[f.length - 1].focus(); }
        else if (!e.shiftKey && doc.activeElement === f[f.length - 1]) { e.preventDefault(); f[0].focus(); }
      }
    });
    buildNetlist();
  }
  function pinchDist() { const p = Array.from(schem.pointers.values()); return p.length < 2 ? 0 : Math.hypot(p[0].x - p[1].x, p[0].y - p[1].y); }
  function pinchCenter() { const p = Array.from(schem.pointers.values()); return { x: (p[0].x + p[1].x) / 2, y: (p[0].y + p[1].y) / 2 }; }
  let schemReturnFocus = null;
  function schemOpen() {
    const modal = $('#schem-modal');
    schemReturnFocus = doc.activeElement;
    modal.hidden = false;
    $('#schem-modal-body').appendChild(schemHost());
    doc.body.style.overflow = 'hidden';
    raf(() => { schemFit(); const c = modal.querySelector('[data-close].icon-btn'); if (c) c.focus(); });
  }
  function schemClose() {
    const modal = $('#schem-modal');
    if (modal.hidden) return;
    $('#schem-home').appendChild(schemHost());
    modal.hidden = true;
    doc.body.style.overflow = '';
    raf(schemFit);
    if (schemReturnFocus && schemReturnFocus.focus) schemReturnFocus.focus();
  }
  function schemMark(h) {
    const svg = schem.svg;
    schem.hot.forEach(n => n.classList.remove('is-hot'));
    schem.hot = [];
    if (!svg) return;
    if (h && (h.net || h.part)) {
      const sel = h.net ? '[data-net="' + cssEsc(h.net) + '"]' : '[data-part="' + cssEsc(h.part) + '"]';
      schem.hot = $$(sel, svg);
      schem.hot.forEach(n => n.classList.add('is-hot'));
    }
    svg.classList.toggle('has-hot', schem.hot.length > 0);
  }
  function schemInfo(h) {
    const box = $('#schem-info');
    if (!box) return;
    box.textContent = '';
    if (h && h.net) {
      const n = net(h.net);
      if (n) { append(box, [el('span', { class: 'wire', style: { '--wire': n.color } }), el('span', {}, [el('b', { text: n.label }), ' · ' + n.desc + ' · ' + wiresOfNet(n.id).length + ' wires'])]); return; }
    }
    if (h && h.part) {
      const p = part(h.part);
      if (p) { append(box, el('span', {}, [el('b', { text: p.name }), ' · ' + p.desc + (p.pins ? ' · ' + p.pins : '')])); return; }
    }
    append(box, el('span', { class: 'muted', text: 'hover a net or a part to light it up in 3d · scroll or pinch to zoom, drag to pan' }));
  }
  function buildNetlist() {
    const tbl = $('#netlist');
    tbl.textContent = '';
    tbl.appendChild(el('thead', {}, el('tr', {}, [el('th', { scope: 'col', text: 'net' }), el('th', { scope: 'col', text: 'from' }), el('th', { scope: 'col', text: 'to' })])));
    const body = el('tbody');
    (MC.WIRES || []).forEach(w => {
      const n = net(w.net);
      const tr = el('tr', { 'data-net': w.net, tabindex: '0', 'aria-label': (n ? n.label : w.net) + ' from ' + endText(w.from) + ' to ' + endText(w.to) }, [
        el('td', {}, el('span', { class: 'net-cell' }, [el('span', { class: 'wire', style: { '--wire': n ? n.color : '#888' } }), n ? n.label.split(' · ')[0] : w.net])),
        el('td', { class: 'end' }, [el('b', { text: partShort(w.from.part) }), ' ' + w.from.pin.replace('gnd_lower_inner:', 'gnd ')]),
        el('td', { class: 'end' }, [el('b', { text: partShort(w.to.part) }), ' ' + w.to.pin.replace('gnd_lower_inner:', 'gnd ')])
      ]);
      tr.addEventListener('mouseenter', () => hover({ net: w.net }));
      tr.addEventListener('mouseleave', () => hover(null));
      tr.addEventListener('click', () => pin({ net: w.net }));
      tr.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); pin({ net: w.net }); } });
      body.appendChild(tr);
    });
    tbl.appendChild(body);
    $('#netlist-count').textContent = (MC.WIRES || []).length + ' jumper wires';
  }
  function netlistMark(h) {
    $$('#netlist tbody tr').forEach(tr => tr.classList.toggle('is-hot', !!(h && h.net && tr.dataset.net === h.net)));
  }

  // ------------------------------------------------------------------ build
  const STEP_CAMERA = { 1: 'hero', 2: 'inside', 3: 'inside', 4: 'keypad', 5: 'top', 6: 'top', 7: 'hero' };
  const build = { step: 1, active: false };
  const steps = () => MC.STEPS || [];
  function initBuild() {
    const track = $('#steps-track');
    steps().forEach(s => {
      const li = el('li', {}, el('button', { type: 'button', class: 'step-dot', 'data-step': s.n, 'aria-label': 'step ' + s.n + ': ' + s.title, text: String(s.n), onclick: () => goStep(s.n) }));
      track.appendChild(li);
    });
    $('#step-prev').addEventListener('click', () => goStep(build.step - 1));
    $('#step-next').addEventListener('click', () => goStep(!build.active ? build.step : build.step >= steps().length ? 1 : build.step + 1));
    $('#step-all').addEventListener('click', () => { buildOff(); setCamera('hero'); });
    renderStep(false);

    // bill of materials
    const bom = $('#bom');
    bom.appendChild(el('thead', {}, el('tr', {}, [el('th', { scope: 'col', class: 'c-num', text: 'qty' }), el('th', { scope: 'col', text: 'part' })])));
    const tb = el('tbody');
    (MC.BOM || []).forEach(b => tb.appendChild(el('tr', {}, [el('td', { text: String(b.qty) }), el('td', {}, [el('span', { class: 'item', text: b.item }), b.note ? el('span', { class: 'note-cell', text: b.note }) : null])])));
    bom.appendChild(tb);
    $('#bom-count').textContent = (MC.BOM || []).length + ' lines · ' + (MC.BOM || []).reduce((a, b) => a + b.qty, 0) + ' pieces';

    // print settings
    const caseData = window.MC_CASE || {};
    const print = caseData.print && typeof caseData.print === 'object' ? caseData.print : null;
    const ps = $('#print-specs');
    const rows = print ? Object.keys(print).map(k => [k.replace(/_/g, ' '), String(print[k])]) : [
      ['material', 'PLA (PETG works too)'],
      ['nozzle · layer height', '0.4 · 0.2 mm'],
      ['walls · top / bottom', '3 · 5 / 4 layers'],
      ['infill', '15 % gyroid'],
      ['supports', 'none'],
      ['body', 'open side up'],
      ['lid', 'face down, the stl is already flipped'],
      ['screws', '4 × M3 countersunk (lid), 4 × M3 × 6 (uno)']
    ];
    rows.forEach(r => { ps.appendChild(el('dt', { text: r[0] })); ps.appendChild(el('dd', { text: r[1] })); });

    // dimensions
    renderDims(caseData);

    // downloads
    const files = [
      ['base.stl', 'case body · prints open side up'],
      ['lid.stl', 'lid · prints face down, no supports'],
      ['assembly.stl', 'both parts assembled, for viewing']
    ];
    const host = $('#files');
    files.forEach(f => {
      host.appendChild(el('a', { class: 'file', href: 'https://github.com/BBZ-AIFS51/LF7-MiniCasino/raw/main/case/stl/' + f[0], target: '_blank', rel: 'noopener', 'aria-label': 'download ' + f[0] + ' from github' }, [
        el('span', { class: 'file-icon' }, [icon('file'), el('span', { text: 'STL' })]),
        el('span', { class: 'file-name', text: f[0] }),
        el('span', { class: 'file-desc', text: f[1] }),
        el('span', { class: 'file-dl' }, icon('download'))
      ]));
    });
  }
  const DIM_LABELS = [
    ['W', 'width', 'mm'], ['D', 'depth', 'mm'], ['H_FRONT', 'height at the front', 'mm'], ['H_BACK', 'height at the back', 'mm'],
    ['SLOPE', 'lid slope', '°'], ['LID', 'lid thickness', 'mm'], ['WALL', 'wall', 'mm'], ['FLOOR', 'floor', 'mm'], ['R', 'corner radius', 'mm']
  ];
  function fmtNum(v) { return Math.abs(v - Math.round(v)) < 1e-6 ? String(Math.round(v)) : (Math.round(v * 10) / 10).toString(); }
  function renderDims(caseData) {
    const dims = caseData.dims || null;
    const dl = $('#dims');
    dl.textContent = '';
    if (!dims) {
      dl.appendChild(el('dt', { text: 'case data' }));
      dl.appendChild(el('dd', { text: 'run case/make_case.py' }));
      return;
    }
    const used = {};
    if (dims.W !== undefined && dims.D !== undefined) {
      dl.appendChild(el('dt', { text: 'footprint' }));
      dl.appendChild(el('dd', { text: fmtNum(dims.W) + ' × ' + fmtNum(dims.D) + ' mm' }));
      used.W = used.D = true;
    }
    DIM_LABELS.forEach(d => {
      if (used[d[0]] || typeof dims[d[0]] !== 'number') return;
      used[d[0]] = true;
      dl.appendChild(el('dt', { text: d[1] }));
      dl.appendChild(el('dd', { text: fmtNum(dims[d[0]]) + (d[2] === '°' ? '°' : ' ' + d[2]) }));
    });
    const row = (dt, dd) => { dl.appendChild(el('dt', { text: dt })); dl.appendChild(el('dd', { text: dd })); };
    if (typeof dims.SCREW === 'string') { row('lid screws', dims.SCREW); used.SCREW = true; }
    const stats = caseData.stats && typeof caseData.stats === 'object' ? caseData.stats : {};
    const vol = k => stats[k] && typeof stats[k].volume_cm3 === 'number' ? stats[k].volume_cm3 : null;
    if (vol('base') !== null && vol('lid') !== null) row('volume body · lid', fmtNum(vol('base')) + ' · ' + fmtNum(vol('lid')) + ' cm³');
    if (typeof stats.mass_g_pla_estimate === 'number') row('filament', '≈ ' + fmtNum(stats.mass_g_pla_estimate) + ' g PLA');
    // everything else make_case.py exports, raw, for people who print their own variant
    const all = $('#dims-all');
    all.textContent = '';
    const raw = (k, v) => { all.appendChild(el('dt', { text: k })); all.appendChild(el('dd', { text: typeof v === 'number' ? fmtNum(v) : String(v) })); };
    Object.keys(dims).forEach(k => { if (!used[k] && (typeof dims[k] === 'number' || typeof dims[k] === 'string')) raw(k, dims[k]); });
    Object.keys(stats).forEach(k => {
      const v = stats[k];
      if (typeof v === 'number' || typeof v === 'string') raw('stats.' + k, v);
      else if (v && typeof v === 'object') Object.keys(v).forEach(j => { if (typeof v[j] === 'number') raw(k + '.' + j, v[j]); });
    });
    $('#dims-more').hidden = !all.childElementCount;
  }
  function renderStep(animate) {
    const list = steps();
    const s = list.find(x => x.n === build.step) || list[0];
    if (!s) return;
    $$('#steps-track .step-dot').forEach(b => {
      const n = Number(b.dataset.step);
      if (build.active && n === build.step) b.setAttribute('aria-current', 'step'); else b.removeAttribute('aria-current');
      b.classList.toggle('is-done', build.active && n < build.step);
    });
    const card = $('#step-card');
    card.textContent = '';
    append(card, [
      el('p', { class: 'step-kicker', text: 'step ' + s.n + ' of ' + list.length + (build.active ? '' : ' · preview') }),
      el('h3', { class: 'step-title', text: s.title }),
      el('p', { class: 'step-text', text: s.text }),
      el('div', { class: 'step-parts' }, (s.parts || []).map(id => el('span', { class: 'pill', text: partShort(id) })))
    ]);
    if (animate && !media.reduce.matches) { card.classList.remove('is-anim'); void card.offsetWidth; card.classList.add('is-anim'); }
    $('#step-prev').disabled = build.step <= 1;
    $('#step-next').querySelector('span').textContent = build.active && build.step >= list.length ? 'start over' : build.active ? 'next' : 'start';
    $('#step-count').textContent = build.active ? build.step + ' / ' + list.length : 'finished console';
  }
  function goStep(n) {
    const list = steps();
    if (!list.length) return;
    if (!build.active) {
      // a guided build starts clean: no traced net, no isolated part
      if (focus.pinned) pin(null);
      if (focus.isolated) isolate(null);
    }
    build.step = clamp(n, 1, list.length);
    build.active = true;
    S('setStep', build.step);             // the scene also flies to a camera pose for the step
    markCamera(STEP_CAMERA[build.step] || 'hero');
    hideHint();
    renderStep(true);
    renderChips();
  }
  function buildOff() {
    if (!build.active) return;
    build.active = false;
    S('setStep', null);
    renderStep(false);
    renderChips();
  }
  function buildEnter() { if (build.wasActive) { build.wasActive = false; goStep(build.step); } }
  function buildLeave() { if (build.active) { build.wasActive = true; buildOff(); setCamera('hero'); } }

  // ------------------------------------------------------------------ admin console (sim.admin only)
  const admin = { version: null, slots: (rules().slots || 31), used: 0, sound: 0, session: -1, rows: [], syncedAt: 0, history: [], hIndex: -1, refreshing: null, again: false };
  // One protocol line in, the '#' reply lines out. The sim itself logs the line and the replies on
  // the serial monitor ('serial:line'); silent sends (background polls) are muted there. While the
  // Uno runs a blocking sequence (spin, jingle) the bytes wait in its UART buffer: the reply list
  // is then empty and the answer follows in the console when the CPU gets there.
  function adminSend(line, opts) {
    opts = opts || {};
    line = String(line || '').trim();
    if (!line) return Promise.resolve([]);
    const sim = ctx.sim;
    if (!sim || typeof sim.admin !== 'function') {
      if (!opts.silent) { pushLine({ text: line, dir: 'tx' }); pushLine({ text: 'no simulation loaded (js/sim.js)', dir: 'rx', sys: true }); }
      return Promise.resolve([]);
    }
    if (opts.silent) {
      // like admin/panel.py after opening the port: no polling while the Uno is still booting
      let st = null;
      try { st = typeof sim.state === 'function' ? sim.state() : null; } catch (err) { st = null; }
      if (st && st.booted === false) return Promise.resolve([]);
      muteNext.push(line);
    }
    let r;
    try { r = typeof sim.adminAsync === 'function' ? sim.adminAsync(line) : sim.admin(line); }
    catch (err) {
      console.error('[ui] sim.admin', err);
      const i = muteNext.indexOf(line);
      if (i >= 0) muteNext.splice(i, 1);
      return Promise.resolve(['#ERR ' + (err && err.message ? err.message : 'sim')]);
    }
    return Promise.resolve(r).then(x => (Array.isArray(x) ? x.map(String) : x ? [String(x)] : []), () => []);
  }
  const lastOf = r => (r.length ? r[r.length - 1] : '');
  const isErr = r => /^#ERR/.test(lastOf(r));
  const errText = r => lastOf(r).replace(/^#ERR\s*/, '');
  // Common ending of every action: toast the outcome, flash the row, sync the table.
  function report(r, okText, label, tr) {
    if (!r.length) toast('the uno is busy, the reply follows in the console', 'info');
    else if (isErr(r)) { if (tr) rowFlash(tr, true); toast(label + ': ' + errText(r), 'err'); }
    else { if (tr) rowFlash(tr, false); if (okText) toast(typeof okText === 'function' ? okText(r) : okText, 'ok'); }
    afterAction(!r.length);
    return r.length > 0 && !isErr(r);
  }
  function adminRefresh(opts) {
    opts = opts || {};
    if (admin.refreshing) { admin.again = admin.again || !opts.silent; return admin.refreshing; }
    admin.refreshing = adminSend('PING', opts).then(ping => adminSend('LIST', opts).then(list => {
      const p = ping.map(l => /^#OK PING (\S+)(.*)$/.exec(l)).filter(Boolean)[0];
      if (p) {
        admin.version = p[1];
        const kv = {};
        p[2].trim().split(/\s+/).forEach(x => { const i = x.indexOf('='); if (i > 0) kv[x.slice(0, i)] = x.slice(i + 1); });
        if (kv.slots !== undefined) admin.slots = Number(kv.slots);
        if (kv.used !== undefined) admin.used = Number(kv.used);
        if (kv.sound !== undefined) admin.sound = Number(kv.sound);
        if (kv.session !== undefined) admin.session = Number(kv.session);
      }
      if (/^#OK LIST/.test(lastOf(list))) {
        const rows = [];
        list.forEach(l => {
          const m = /^#ROW (\d+) ([0-9A-Fa-f]+) ([01]) (\d+)(?: (\d+))?(?: (\d+))?/.exec(l);
          if (m) rows.push({ slot: Number(m[1]), uid: m[2].toUpperCase(), funded: m[3] === '1', balance: Number(m[4]), stake: m[5] !== undefined ? Number(m[5]) : 10, flag: m[6] !== undefined ? Number(m[6]) : 0 });
        });
        admin.rows = rows;
        admin.syncedAt = now();
      }
      if (p || list.length) renderAdmin();
    })).catch(err => { console.error('[ui] admin refresh', err); }).then(() => {
      admin.refreshing = null;
      if (admin.again) { admin.again = false; adminRefresh({ silent: true }); }
    });
    return admin.refreshing;
  }
  function renderAdmin() {
    $('#admin-version').textContent = admin.version || '–';
    $('#kpi-slots').textContent = admin.used + ' / ' + admin.slots;
    $('#kpi-meter').style.width = (admin.slots ? admin.used / admin.slots * 100 : 0) + '%';
    $('#kpi-sound').textContent = SOUND_NAMES[admin.sound] || '–';
    $('#kpi-session').textContent = admin.session >= 0 ? 'slot ' + admin.session : 'none';
    checkRadio($('#sound-seg'), '.seg-btn', b => Number(b.dataset.sound) === admin.sound);
    $('#acc-count').textContent = admin.rows.length ? admin.rows.length + (admin.rows.length === 1 ? ' account' : ' accounts') : '';
    syncedLabel();
    const tbody = $('#accounts-body');
    const existing = {};
    $$('tr', tbody).forEach(tr => { existing[tr.dataset.slot] = tr; });
    const keep = {};
    admin.rows.slice().sort((a, b) => a.slot - b.slot).forEach((r, i) => {
      let tr = existing[r.slot];
      if (!tr) tr = accountRow(r.slot);
      keep[r.slot] = true;
      updateRow(tr, r);
      if (tbody.children[i] !== tr) tbody.insertBefore(tr, tbody.children[i] || null);
    });
    Object.keys(existing).forEach(k => { if (!keep[k]) existing[k].remove(); });
    $('#accounts-empty').hidden = admin.rows.length > 0;
    $('#accounts').hidden = admin.rows.length === 0;
  }
  function syncedLabel() {
    const s = $('#admin-synced');
    if (!admin.syncedAt) { s.textContent = 'not synced'; return; }
    const ago = Math.round((now() - admin.syncedAt) / 1000);
    s.textContent = ago < 2 ? 'synced just now' : 'synced ' + ago + ' s ago';
  }
  function accountRow(slot) {
    const tr = el('tr', { 'data-slot': slot });
    const bal = el('input', { class: 'cell-input', type: 'number', inputmode: 'numeric', min: '0', step: '10', 'aria-label': 'balance of slot ' + slot });
    const stake = el('input', { class: 'cell-input is-stake', type: 'number', inputmode: 'numeric', min: '10', max: '2550', step: '10', 'aria-label': 'stake of slot ' + slot });
    const inf = el('span', { class: 'cell-inf', text: 'inf', title: 'admin card: unlimited, nothing is booked', hidden: true });
    const ban = el('button', { type: 'button', class: 'act act-ban', 'aria-pressed': 'false' }, icon('ban'));
    const adm = el('button', { type: 'button', class: 'act act-admin', 'aria-pressed': 'false' }, icon('shield'));
    const free = el('button', { type: 'button', class: 'act act-free', 'aria-label': 'free slot ' + slot, title: 'free the slot (FREE)' }, icon('trash'));
    append(tr, [
      el('td', { class: 'c-slot' }, el('span', { class: 'acc-slot', text: pad2(slot) })),
      el('td', { class: 'c-card' }, el('div', { class: 'acc-card' }, [el('span', { class: 'acc-uid' }), el('span', { class: 'acc-meta' })])),
      el('td', { class: 'c-bal c-num' }, [bal, inf]),
      el('td', { class: 'c-stake c-num' }, stake),
      el('td', { class: 'c-act' }, el('div', { class: 'acc-actions' }, [ban, adm, free]))
    ]);
    const editable = (input, cmd) => {
      input.addEventListener('focus', () => { input.dataset.orig = input.value; setTimeout(() => { try { input.select(); } catch (e) { /* number inputs */ } }, 0); });
      input.addEventListener('keydown', e => {
        if (e.key === 'Enter') { e.preventDefault(); input.blur(); }
        else if (e.key === 'Escape') { e.preventDefault(); input.value = input.dataset.orig || ''; input.blur(); }
      });
      input.addEventListener('blur', () => {
        const v = input.value.trim();
        const orig = input.dataset.orig || '';
        if (v === '' || v === orig) { input.value = orig || input.value; return; }
        adminSend(cmd + ' ' + slot + ' ' + v).then(r => {
          const ok = report(r, (cmd === 'SET' ? 'balance' : 'stake') + ' of slot ' + slot + ' set to ' + money(Number(v)), cmd + ' ' + slot, tr);
          if (!ok && r.length) input.value = orig;
        });
      });
    };
    editable(bal, 'SET');
    editable(stake, 'STAKE');
    ban.addEventListener('click', () => flag(tr, slot, Number(tr.dataset.flag) === 1 ? 0 : 1));
    adm.addEventListener('click', () => flag(tr, slot, Number(tr.dataset.flag) === 2 ? 0 : 2));
    free.addEventListener('click', () => {
      if (!free.classList.contains('is-confirm')) {
        free.classList.add('is-confirm');
        free.textContent = 'free?';
        free.setAttribute('aria-label', 'confirm: free slot ' + slot);
        free._t = setTimeout(() => resetFree(free, slot), 3500);
        return;
      }
      clearTimeout(free._t);
      resetFree(free, slot);
      adminSend('FREE ' + slot).then(r => report(r, 'slot ' + slot + ' freed, the card counts as new again', 'FREE ' + slot, null));
    });
    tr._els = { bal, stake, inf, ban, adm, free };
    return tr;
  }
  function resetFree(free, slot) {
    free.classList.remove('is-confirm');
    free.textContent = '';
    free.appendChild(icon('trash'));
    free.setAttribute('aria-label', 'free slot ' + slot);
  }
  function flag(tr, slot, value) {
    adminSend('FLAG ' + slot + ' ' + value).then(r => report(r, 'slot ' + slot + (value === 1 ? ' banned' : value === 2 ? ' is an admin card now' : ' back to normal'), 'FLAG ' + slot, tr));
  }
  function rowFlash(tr, err) { tr.classList.remove('is-flash', 'is-err'); void tr.offsetWidth; tr.classList.add(err ? 'is-err' : 'is-flash'); }
  function updateRow(tr, r) {
    const e = tr._els;
    tr.dataset.flag = r.flag;
    tr.classList.toggle('is-live', admin.session === r.slot);
    tr.classList.toggle('is-banned', r.flag === 1);
    const uid = tr.querySelector('.acc-uid');
    uid.textContent = r.uid;
    uid.title = MC.formatUid ? MC.formatUid(r.uid) : r.uid;
    const meta = tr.querySelector('.acc-meta');
    meta.textContent = '';
    if (admin.session === r.slot) meta.appendChild(el('span', { class: 'badge badge-ok', text: 'live' }));
    if (r.flag === 1) meta.appendChild(el('span', { class: 'badge badge-ban', text: 'banned' }));
    else if (r.flag === 2) meta.appendChild(el('span', { class: 'badge badge-admin', text: 'admin ∞' }));
    if (!r.funded) meta.appendChild(el('span', { class: 'badge badge-warn', text: 'no credit' }));
    const c = cardOf(r.uid);
    meta.appendChild(el('span', { class: 'acc-kind', text: c ? partShort(c.part) : 'manual' }));
    const isAdmin = r.flag === 2;
    e.bal.hidden = isAdmin;
    e.inf.hidden = !isAdmin;
    if (doc.activeElement !== e.bal) e.bal.value = String(r.balance);
    if (doc.activeElement !== e.stake) e.stake.value = String(r.stake);
    e.ban.setAttribute('aria-pressed', r.flag === 1 ? 'true' : 'false');
    e.ban.setAttribute('aria-label', (r.flag === 1 ? 'unban' : 'ban') + ' slot ' + r.slot);
    e.ban.title = r.flag === 1 ? 'unban (FLAG 0)' : 'ban (FLAG 1)';
    e.adm.setAttribute('aria-pressed', r.flag === 2 ? 'true' : 'false');
    e.adm.setAttribute('aria-label', r.flag === 2 ? 'make slot ' + r.slot + ' a normal card' : 'make slot ' + r.slot + ' an admin card');
    e.adm.title = r.flag === 2 ? 'normal card (FLAG 0)' : 'admin card, unlimited (FLAG 2)';
  }
  function afterAction(later) {
    const sync = () => {
      adminRefresh({ silent: true });
      refreshAccounts();
      if (ctx.sim && typeof ctx.sim.state === 'function') { try { renderState(ctx.sim.state()); } catch (e) { /* ignore */ } }
    };
    sync();
    if (later) setTimeout(sync, 1500);
  }
  function uidCheck() {
    const input = $('#add-uid'), help = $('#add-help');
    const raw = input.value.replace(/[\s:-]/g, '');
    const hex = /^[0-9a-fA-F]*$/.test(raw);
    const n = raw.length;
    help.className = 'help';
    input.removeAttribute('aria-invalid');
    if (!n) { help.textContent = '8, 14 or 20 hex characters (4, 7 or 10 byte uid).'; return raw; }
    if (!hex) { help.textContent = 'only 0–9 and a–f.'; help.classList.add('is-err'); input.setAttribute('aria-invalid', 'true'); return raw; }
    if (n === 8 || n === 14 || n === 20) { help.textContent = (n / 2) + ' byte uid' + (cardOf(raw) ? ' · one of the demo cards' : ''); help.classList.add('is-ok'); return raw; }
    help.textContent = n + ' characters, needs 8, 14 or 20.';
    return raw;
  }
  function initAdmin() {
    $('#admin-refresh').addEventListener('click', () => adminRefresh());
    $('#add-uid').addEventListener('input', uidCheck);
    $('#add-form').addEventListener('submit', e => {
      e.preventDefault();
      const uid = uidCheck();
      if (!uid) { $('#add-uid').focus(); toast('enter a uid first', 'warn'); return; }
      const val = $('#add-balance').value.trim() || '0';
      adminSend('ADD ' + uid.toUpperCase() + ' ' + val).then(r => {
        const ok = report(r, x => { const m = /^#OK ADD (\d+)/.exec(lastOf(x)); return 'added to slot ' + (m ? m[1] : '?') + ' with ' + money(Number(val)); }, 'ADD', null);
        if (ok) { $('#add-uid').value = ''; uidCheck(); }
      });
    });
    $('#add-tap').addEventListener('click', () => {
      const uid = uidCheck();
      if (!uid) { $('#add-uid').focus(); toast('enter a uid first', 'warn'); return; }
      adminSend('CARD ' + uid.toUpperCase()).then(r => report(r, 'card ' + uid.toUpperCase() + ' tapped', 'CARD', null));
    });
    $$('#sound-seg [data-sound]').forEach(b => b.addEventListener('click', () => {
      const lvl = Number(b.dataset.sound);
      adminSend('SOUND ' + lvl).then(r => report(r, 'sound ' + SOUND_NAMES[lvl], 'SOUND', null));
    }));
    radioKeys($('#sound-seg'), '.seg-btn');
    const zone = $('#wipe-zone'), confirmBox = $('#wipe-confirm');
    let wipeT = 0;
    const closeWipe = () => { clearTimeout(wipeT); zone.classList.remove('is-confirm'); confirmBox.hidden = true; };
    $('#wipe-start').addEventListener('click', () => {
      zone.classList.add('is-confirm');
      confirmBox.hidden = false;
      $('#wipe-cancel').focus();
      wipeT = setTimeout(closeWipe, 12000);
    });
    $('#wipe-cancel').addEventListener('click', () => { closeWipe(); $('#wipe-start').focus(); });
    $('#wipe-go').addEventListener('click', () => {
      closeWipe();
      $('#wipe-start').focus();
      adminSend('WIPE JA').then(r => report(r, 'everything wiped, sound back to loud', 'WIPE', null));
    });
    // raw console with history
    admin.history = (store.get('adminHistory', []) || []).filter(x => typeof x === 'string').slice(-30);
    const input = $('#console-cmd');
    $('#console-form').addEventListener('submit', e => {
      e.preventDefault();
      const line = input.value.trim();
      if (!line) return;
      adminSend(line).then(r => afterAction(!r.length));
      if (admin.history[admin.history.length - 1] !== line) admin.history.push(line);
      admin.history = admin.history.slice(-30);
      store.set('adminHistory', admin.history);
      admin.hIndex = -1;
      input.value = '';
    });
    input.addEventListener('keydown', e => {
      if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return;
      const h = admin.history;
      if (!h.length) return;
      e.preventDefault();
      if (e.key === 'ArrowUp') admin.hIndex = admin.hIndex < 0 ? h.length - 1 : Math.max(0, admin.hIndex - 1);
      else admin.hIndex = admin.hIndex < 0 ? -1 : admin.hIndex + 1;
      if (admin.hIndex >= h.length) admin.hIndex = -1;
      input.value = admin.hIndex < 0 ? '' : h[admin.hIndex];
      const n = input.value.length;
      try { input.setSelectionRange(n, n); } catch (err) { /* ignore */ }
    });
    const chips = [['PING', true], ['LIST', true], ['SET ', false], ['STAKE ', false], ['FLAG ', false], ['ADD ', false], ['FREE ', false], ['SOUND ', false], ['CARD ', false], ['WIPE JA', false]];
    const host = $('#console-chips');
    chips.forEach(c => host.appendChild(el('button', {
      type: 'button', class: 'chip-cmd', text: c[0].trim(), title: c[1] ? 'send ' + c[0] : 'type ' + c[0].trim() + ' …',
      onclick: () => {
        if (c[1]) { adminSend(c[0]).then(r => afterAction(!r.length)); return; }
        input.value = c[0];
        input.focus();
        const n = input.value.length;
        try { input.setSelectionRange(n, n); } catch (err) { /* ignore */ }
      }
    })));
    // background sync like admin/panel.py (every 3 s), muted on the serial monitor
    setInterval(() => {
      if (tab !== 'admin' || doc.hidden) return;
      const a = doc.activeElement;
      if (a && a.closest && a.closest('#accounts')) { syncedLabel(); return; }
      adminRefresh({ silent: true });
    }, 3000);
  }

  // ------------------------------------------------------------------ public API
  UI.init = function (opts) {
    opts = opts || {};
    ctx.sim = opts.sim || null;
    ctx.oled = opts.oled || null;
    ctx.audio = opts.audio || null;
    ctx.pressKey = opts.pressKey || null;
    ctx.tapCard = opts.tapCard || null;

    setTheme(storedTheme() || systemTheme(), false);
    listen(media.light, () => { if (!storedTheme()) setTheme(systemTheme(), false); });

    initTabs();
    initTopbar();
    initStage();
    oledViews.push(OledView($('#oled-main')));
    oledViews[0].setVariant(settings.oledVariant);
    watchDpr();
    // scrolling by fractions of a device pixel (phones) moves the mirror off the pixel grid
    let scrollT = 0;
    const resnap = () => { clearTimeout(scrollT); scrollT = setTimeout(() => oledViews.forEach(v => v.snap()), 140); };
    window.addEventListener('scroll', resnap, { passive: true });
    $('#panel-body').addEventListener('scroll', resnap, { passive: true });
    buildTags();
    buildKeypad();
    initMonitor();
    initExplore();
    initSchematic();
    initBuild();
    initAdmin();
    renderChips();

    if (ctx.sim && settings.debugLog && typeof ctx.sim.setDebugLog === 'function') {
      try { ctx.sim.setDebugLog(true); } catch (err) { console.error('[ui] sim.setDebugLog', err); }
    }
    const sb = $('#sb-sim'), dot = $('#sb-dot');
    if (ctx.sim) { sb.textContent = 'firmware simulation running'; }
    else { sb.textContent = 'firmware simulation missing'; dot.classList.add('is-warn'); }
    if (!ctx.sim || typeof ctx.sim.setDebugLog !== 'function') { $('#debug-log').disabled = true; $('#debug-log').closest('label').title = 'needs sim.setDebugLog()'; }

    // session ring and tag balances follow the simulation
    const poll = () => {
      if (!ctx.sim || typeof ctx.sim.state !== 'function' || doc.hidden) return;
      try { renderState(ctx.sim.state()); } catch (err) { /* sim not booted yet */ }
    };
    setInterval(poll, 250);
    poll();
    refreshAccounts();
    adminRefresh({ silent: true });
    setInterval(syncedLabel, 1000);

    const t = store.get('tab', 'play');
    tab = null;
    selectTab(TABS.indexOf(t) >= 0 ? t : 'play');
    raf(() => { moveInk(); oledViews.forEach(v => v.layout()); });
  };

  UI.attachScene = function (scene) {
    ctx.scene = scene || null;
    if (!ctx.scene) return;
    S('setTheme', theme);
    S('setCaseColor', settings.caseColor);
    S('setOledVariant', settings.oledVariant);
    S('setQuality', settings.quality);
    S('setView', Object.assign({}, settings.view));
    if (settings.explode) S('setExplode', settings.explode);
    if (focus.isolated) S('isolate', focus.isolated);
    if (focus.hover || focus.pinned) applyHighlight();
    if (tab === 'build' && build.active) S('setStep', build.step);
    layoutInsets();
    if (window.ResizeObserver) new ResizeObserver(layoutInsets).observe($('#dock'));
  };
  UI.progress = progress;
  UI.ready = ready;
  UI.fallback = fallback;
  let oledTextTimer = 0;
  UI.oledFrame = function (fb) {
    if (!fb) return;
    lastFb = fb;
    oledViews.forEach(v => v.draw(fb));
    // the same screen as text for screen readers (what the sketch believes is on the panel)
    clearTimeout(oledTextTimer);
    oledTextTimer = setTimeout(() => {
      const o = ctx.oled;
      if (!o || typeof o.text !== 'function') return;
      let t;
      try { t = o.text(); } catch (err) { return; }
      const txt = [t.line0, t.line1, t.hint].map(x => String(x || '').replace(/\s+/g, ' ').trim()).filter(Boolean).join(' / ');
      const live = $('#oled-text');
      if (live && live.textContent !== txt) live.textContent = txt;
      oledViews.forEach(v => v.canvas.setAttribute('aria-label', 'oled: ' + (txt || 'dark')));
    }, 350);
  };
  UI.flashKey = flashKey;
  UI.cardTapping = cardTapping;
  let wasBooted = null;
  UI.setState = function (s) {
    renderState(s);
    refreshAccounts();
    if (s && typeof s.booted === 'boolean' && s.booted !== wasBooted) {
      wasBooted = s.booted;
      if (!s.booted) { outstanding.length = 0; muteNext.length = 0; }   // a reset drops the UART buffer
      else adminRefresh({ silent: true });
    }
  };
  UI.result = showResult;
  UI.busy = function (b) { const s = $('#session'); if (s) s.dataset.busy = b ? 'true' : 'false'; };
  UI.serial = serial;
  UI.hover = sceneHover;
  UI.sceneClick = function (c) {
    if (!c) { if (focus.pinned) pin(null); return; }   // a click on empty space clears the trace
    if (c.key || c.card) return;               // handled through scene:key / scene:card
    if (c.net) pin({ net: c.net });
    else if (c.part && !/^(card_|case_)/.test(c.part)) pin({ part: c.part });   // a click on the case is mostly an orbit start
  };
  UI.sceneView = sceneView;
  UI.sceneExplode = sceneExplode;
  let fpsValue = 0, tier = '';
  const perfMeta = () => {
    const m = $('#fps-meta');
    if (m) m.textContent = [fpsValue ? fpsValue + ' fps' : '', tier && settings.quality === 'auto' ? tier + ' tier' : ''].filter(Boolean).join(' · ');
  };
  UI.fps = function (n) {
    fpsValue = Math.round(Number(n) || 0);
    const s = $('#sb-fps');
    if (s) { s.hidden = !fpsValue; s.textContent = fpsValue + ' fps'; }
    perfMeta();
  };
  UI.quality = function (t) { tier = typeof t === 'string' ? t : ''; perfMeta(); };
  UI.toast = toast;
  UI.selectTab = selectTab;
  UI.camera = setCamera;
  UI.admin = adminSend;
  UI.settings = settings;
  Object.defineProperty(UI, 'theme', { get: () => theme, configurable: true });
})();
