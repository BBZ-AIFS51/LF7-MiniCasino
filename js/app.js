/* Mini Casino viewer: bootstrap (SPEC §6).
   1. creates the OLED, the audio and the firmware simulation and starts the UI at once, so the
      panel (2D OLED, keypad, cards, admin) works while the 3D scene is still being built;
   2. initialises MC.Scene behind a loading overlay with progress, or shows the fallback when
      WebGL or the scene is missing (the game stays playable with the 2D OLED and keypad);
   3. wires the events: simulation -> UI and scene, scene -> UI and simulation, keyboard ->
      keypad, first gesture -> audio unlock. */
(function () {
  'use strict';
  const MC = window.MC = window.MC || {};
  const app = MC.app = {};
  const KEYS = '0123456789ABCD*#';
  const TAP_TIMEOUT_MS = 2600;

  let sim = null, oled = null, audio = null, oledTex = null, sceneOk = false;
  let tapBusy = false;

  function sceneCall(method) {
    if (!sceneOk || !MC.Scene || typeof MC.Scene[method] !== 'function') return undefined;
    const args = Array.prototype.slice.call(arguments, 1);
    try { return MC.Scene[method].apply(MC.Scene, args); } catch (err) { console.error('[app] MC.Scene.' + method, err); return undefined; }
  }

  // ------------------------------------------------------------------ audio unlock on the first gesture
  let unlocked = false;
  function unlockAudio() {
    if (unlocked || !audio || typeof audio.unlock !== 'function') return;
    try { const r = audio.unlock(); unlocked = true; if (r && r.catch) r.catch(() => { unlocked = false; }); }
    catch (err) { /* stays locked, next gesture tries again */ }
  }
  function armUnlock() {
    const types = ['pointerdown', 'keydown', 'touchend'];
    const once = () => {
      unlockAudio();
      if (unlocked) types.forEach(t => window.removeEventListener(t, once, true));
    };
    types.forEach(t => window.addEventListener(t, once, true));
  }

  // ------------------------------------------------------------------ input -> simulation
  function pressKey(ch, source) {
    ch = String(ch || '').toUpperCase();
    if (ch.length !== 1 || KEYS.indexOf(ch) < 0) return;
    unlockAudio();
    if (MC.UI && source !== 'ui') MC.UI.flashKey(ch);
    if (source !== 'scene') sceneCall('pressKey', ch);   // a 3D click animates its key itself
    if (sim) { try { sim.pressKey(ch); } catch (err) { console.error('[app] sim.pressKey', err); } }
  }
  app.pressKey = pressKey;

  // The scene moves the card onto the tap zone; the read happens when it arrives there.
  function tapCard(uid, source) {
    uid = String(uid || '').toUpperCase();
    if (!uid || tapBusy) return Promise.resolve(false);
    tapBusy = true;
    unlockAudio();
    if (MC.UI) MC.UI.cardTapping(uid, true);
    let anim = null;
    if (sceneOk) anim = sceneCall('tapCard', uid);
    const arrive = anim && typeof anim.then === 'function'
      ? Promise.race([anim.catch(() => null), new Promise(r => setTimeout(r, TAP_TIMEOUT_MS))])
      : Promise.resolve();
    return arrive.then(() => {
      if (sim) { try { sim.tapCard(uid); } catch (err) { console.error('[app] sim.tapCard', err); } }
      return true;
    }).finally(() => {
      tapBusy = false;
      if (MC.UI) MC.UI.cardTapping(uid, false);
    });
  }
  app.tapCard = tapCard;

  // ------------------------------------------------------------------ keyboard: 0-9 A-D * #
  function isTyping(t) {
    if (!t || !t.tagName) return false;
    if (t.isContentEditable) return true;
    const tag = t.tagName;
    if (tag === 'TEXTAREA' || tag === 'SELECT') return true;
    if (tag !== 'INPUT') return false;
    const type = (t.getAttribute('type') || 'text').toLowerCase();
    return ['checkbox', 'radio', 'range', 'button', 'submit', 'reset', 'color', 'file', 'image'].indexOf(type) < 0;
  }
  function onKeyDown(e) {
    if (e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey) return;
    if (isTyping(e.target)) return;
    const modal = document.getElementById('schem-modal');
    if (modal && !modal.hidden) return;
    const k = e.key && e.key.length === 1 ? e.key.toUpperCase() : '';
    if (!k || KEYS.indexOf(k) < 0) return;
    e.preventDefault();
    if (e.repeat) return;                   // the firmware counts one action per press
    pressKey(k, 'keyboard');
  }

  // ------------------------------------------------------------------ bus wiring
  function wire() {
    const bus = MC.bus;
    if (!bus) return;
    bus.on('oled:frame', o => {
      const fb = (o && o.fb) || (oled && oled.fb);
      if (!fb) return;
      MC.UI.oledFrame(fb);
      if (oledTex && typeof oledTex.update === 'function') {
        try { oledTex.update(fb); } catch (err) { console.error('[app] oled texture', err); }
        sceneCall('oledChanged');
      }
    });
    bus.on('sim:state', s => MC.UI.setState(s));
    bus.on('serial:line', l => MC.UI.serial(l));
    bus.on('sim:result', r => MC.UI.result(r));
    bus.on('sim:busy', b => MC.UI.busy(b));
    bus.on('scene:hover', h => MC.UI.hover(h));
    bus.on('scene:click', c => MC.UI.sceneClick(c));
    bus.on('scene:key', ch => pressKey(ch, 'scene'));
    bus.on('scene:card', uid => tapCard(uid, 'scene'));
    bus.on('scene:fps', n => MC.UI.fps(n));
    bus.on('scene:quality', t => MC.UI.quality(t));
    bus.on('scene:view', v => MC.UI.sceneView(v));
    bus.on('scene:explode', ex => MC.UI.sceneExplode(ex));
    bus.on('scene:progress', p => {
      if (!p) return;
      const v = typeof p === 'number' ? p : p.p;
      if (typeof v === 'number') sceneProgress = Math.max(sceneProgress, 0.12 + 0.84 * Math.min(1, v));
      if (p.label) sceneLabel = p.label;
    });
  }

  // ------------------------------------------------------------------ scene start
  let sceneProgress = 0, sceneLabel = '';
  function webgl() {
    try {
      const c = document.createElement('canvas');
      const gl = c.getContext('webgl2') || c.getContext('webgl');
      if (!gl) return false;
      const lose = gl.getExtension('WEBGL_lose_context');
      if (lose) lose.loseContext();
      return true;
    } catch (err) { return false; }
  }
  function startScene() {
    const UI = MC.UI;
    const canvas = document.getElementById('scene-canvas');
    UI.progress(0.04, 'checking webgl');
    if (!window.THREE) { UI.fallback('three.js did not load (vendor/three.min.js). the simulation runs anyway: tap a card and use the keypad in the play tab or your keyboard.'); return; }
    if (!webgl()) { UI.fallback('this browser has no webgl. the firmware simulation runs anyway: tap a card and use the keypad in the play tab or your keyboard.'); return; }
    if (!MC.Scene || typeof MC.Scene.init !== 'function') { UI.fallback('the 3d scene (js/scene.js) is missing. the simulation runs anyway: tap a card and use the keypad in the play tab.'); return; }
    if (!window.MC_CASE) console.warn('[app] data/case_geo.js missing, the scene builds without the case');

    // eased progress while the scene builds (it may report real progress via scene:progress)
    sceneProgress = 0.08;
    let shown = 0.04;
    const labels = [[0.1, 'building the case'], [0.3, 'placing the parts'], [0.55, 'routing the wires'], [0.75, 'lighting the studio'], [0.88, 'compiling shaders']];
    const timer = setInterval(() => {
      sceneProgress = Math.min(0.94, sceneProgress + (0.94 - sceneProgress) * 0.035);
      shown += (sceneProgress - shown) * 0.25;
      let label = sceneLabel;
      if (!label) labels.forEach(l => { if (shown >= l[0]) label = l[1]; });
      UI.progress(shown, label || 'starting');
    }, 60);

    // let the loader paint before the heavy synchronous work starts
    setTimeout(() => {
      let p;
      try { p = MC.Scene.init(canvas, { theme: UI.theme, quality: UI.settings.quality }); }
      catch (err) { p = Promise.reject(err); }
      Promise.resolve(p).then(() => {
        clearInterval(timer);
        sceneOk = true;
        if (MC.OledRenderer && typeof MC.OledRenderer.createTexture === 'function') {
          try {
            oledTex = MC.OledRenderer.createTexture();
            sceneCall('setOledTexture', oledTex);
            if (oled && oled.fb) { oledTex.update(oled.fb); sceneCall('oledChanged'); }
          } catch (err) { console.error('[app] oled texture', err); }
        }
        UI.attachScene(MC.Scene);
        UI.ready();
      }, err => {
        clearInterval(timer);
        console.error('[app] MC.Scene.init failed', err);
        sceneOk = false;
        UI.fallback('the 3d view could not start (' + (err && err.message ? err.message : 'unknown error') + '). the simulation runs anyway: tap a card and use the keypad in the play tab.');
      });
    }, 30);
  }

  // ------------------------------------------------------------------ boot
  function boot() {
    const UI = MC.UI;
    if (!UI) { console.error('[app] js/ui.js missing'); return; }
    const fw = window.MC_FW;
    if (!fw) console.warn('[app] data/firmware.js missing');

    audio = MC.Audio || null;
    try { if (MC.Oled) oled = new MC.Oled(); } catch (err) { console.error('[app] MC.Oled', err); }
    try { if (MC.Sim && fw) sim = new MC.Sim({ fw, oled, audio }); } catch (err) { console.error('[app] MC.Sim', err); sim = null; }
    app.sim = sim; app.oled = oled; app.audio = audio;

    wire();
    UI.init({ sim, oled, audio, pressKey, tapCard });
    window.addEventListener('keydown', onKeyDown);
    armUnlock();

    if (sim) {
      try { sim.boot(); } catch (err) { console.error('[app] sim.boot', err); }
      if (oled && oled.fb) UI.oledFrame(oled.fb);
    }
    startScene();

    // small handle for tests and the console
    window.miniCasino = {
      app, sim, oled, ui: UI,
      scene: () => (sceneOk ? MC.Scene : null),
      press: ch => pressKey(ch, 'test'),
      tap: uid => tapCard(uid, 'test'),
      admin: line => UI.admin(line),
      tab: name => UI.selectTab(name)
    };
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
