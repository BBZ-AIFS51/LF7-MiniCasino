/* Mini Casino viewer: the passive buzzer on D2, in WebAudio.

   The firmware toggles D2 by hand (tonSpiele() in GameRuntime.h): laut = square wave with 50 %
   duty, leise = the same note with narrow pulses (on-time = period / 12, about 8 %), aus = silent
   but the same time passes. Here every note is an oscillator with a PeriodicWave of exactly that
   pulse shape, without normalisation, so leise really carries less energy, plus a further
   level step so the difference is as clear as on the real piezo. Short attack/release ramps
   avoid clicks. MC.Sim decides what plays and when; this file only makes the sound.

   The AudioContext is created on the first user gesture (pointer, key or touch) or by
   MC.Audio.unlock(); before that every call is a silent no-op. Nothing here ever throws. */
(function () {
  'use strict';
  const MC = window.MC = window.MC || {};
  const AC = window.AudioContext || window.webkitAudioContext || null;

  const HARMONICS = 48;
  const DUTY = [0.5, 1 / 12];          // TON_LAUT: periode / 2, TON_LEISE: periode / 12
  const LEVEL_GAIN = [1, 0.6, 0];      // laut, leise, aus
  const ATTACK = 0.0012, RELEASE = 0.0025, LOOKAHEAD = 0.004;

  let ctx = null, master = null, filter = null;
  const waves = [];
  const live = new Set();

  function graph() {
    master = ctx.createGain();
    master.gain.value = A._muted ? 0 : A.volume;
    filter = ctx.createBiquadFilter();       // takes the edge off the highest harmonics
    filter.type = 'lowpass';
    filter.frequency.value = 9000;
    filter.Q.value = 0.5;
    master.connect(filter);
    filter.connect(ctx.destination);
  }

  // Fourier series of a 0/1 pulse train with the given duty (DC removed): a_n = 2 sin(n pi d) / (n pi)
  function wave(level) {
    if (waves[level]) return waves[level];
    const d = DUTY[level];
    const real = new Float32Array(HARMONICS + 1), imag = new Float32Array(HARMONICS + 1);
    for (let n = 1; n <= HARMONICS; n++) real[n] = 2 * Math.sin(n * Math.PI * d) / (n * Math.PI);
    let w;
    try { w = ctx.createPeriodicWave(real, imag, { disableNormalization: true }); }
    catch (e) { w = ctx.createPeriodicWave(real, imag); }
    waves[level] = w;
    return w;
  }

  function ready() { return !!ctx && ctx.state === 'running'; }

  function schedule(hz, ms, level, at) {
    const dur = ms / 1000;
    const peak = LEVEL_GAIN[level];
    if (!(hz > 0) || !(dur > 0) || !peak) return;
    const osc = ctx.createOscillator();
    osc.setPeriodicWave(wave(level));
    osc.frequency.setValueAtTime(hz, at);
    const env = ctx.createGain();
    const g = env.gain;
    const attack = Math.min(ATTACK, dur / 3), release = Math.min(RELEASE, dur / 3);
    g.setValueAtTime(0, at);
    g.linearRampToValueAtTime(peak, at + attack);
    g.setValueAtTime(peak, at + dur - release);
    g.linearRampToValueAtTime(0, at + dur);
    osc.connect(env);
    env.connect(master);
    osc.start(at);
    osc.stop(at + dur + 0.01);
    live.add(osc);
    osc.onended = () => { live.delete(osc); try { osc.disconnect(); env.disconnect(); } catch (e) { /* gone */ } };
  }

  const A = MC.Audio = {
    supported: !!AC,
    level: 0,           // default level when a call passes none: 0 laut, 1 leise, 2 aus
    volume: 0.22,       // master gain for laut
    _muted: false,

    get context() { return ctx; },
    get unlocked() { return ready(); },
    get muted() { return A._muted; },
    set muted(v) {
      A._muted = !!v;
      if (master) {
        try { master.gain.setTargetAtTime(A._muted ? 0 : A.volume, ctx.currentTime, 0.01); }
        catch (e) { master.gain.value = A._muted ? 0 : A.volume; }
      }
    },
    setVolume(v) {
      A.volume = Math.max(0, Math.min(1, +v || 0));
      A.muted = A._muted;
    },
    setLevel(level) { A.level = level === 1 || level === 2 ? level : 0; },

    // Create or resume the AudioContext. Call from a user gesture. Resolves true when running.
    unlock() {
      try {
        if (!AC) return Promise.resolve(false);
        if (!ctx) { ctx = new AC(); graph(); }
        if (ctx.state === 'suspended') return ctx.resume().then(() => ready(), () => false);
        return Promise.resolve(ready());
      } catch (e) {
        return Promise.resolve(false);
      }
    },

    // One note: hz for ms milliseconds at level (0 laut, 1 leise, 2 aus). Starts now.
    tone(hz, ms, level) {
      try {
        if (!ready()) return false;
        schedule(hz, ms, level === undefined ? A.level : level, ctx.currentTime + LOOKAHEAD);
        return true;
      } catch (e) {
        return false;
      }
    },

    // A sequence [[hz, ms, gap], ...] (hz 0 = rest). Scheduled on the audio clock so the rhythm
    // stays exact; resolves when it has finished (also when muted or without audio).
    play(notes, level) {
      let total = 0;
      try {
        const lv = level === undefined ? A.level : level;
        let t = ready() ? ctx.currentTime + LOOKAHEAD : 0;
        for (const n of notes || []) {
          const hz = Array.isArray(n) ? n[0] : n.hz, ms = Array.isArray(n) ? n[1] : n.ms, gap = (Array.isArray(n) ? n[2] : n.gap) || 0;
          if (ready()) schedule(hz, ms, lv, t);
          t += (ms + gap) / 1000;
          total += ms + gap;
        }
      } catch (e) { /* keep timing */ }
      return new Promise(resolve => setTimeout(resolve, total));
    },

    // Silence everything that is still scheduled.
    stop() {
      for (const osc of live) { try { osc.stop(); } catch (e) { /* already stopped */ } }
      live.clear();
    }
  };

  // Unlock on the first gesture anywhere on the page.
  const events = ['pointerdown', 'keydown', 'touchend', 'click'];
  function onGesture() {
    A.unlock().then(ok => {
      if (ok) events.forEach(ev => window.removeEventListener(ev, onGesture, true));
    });
  }
  if (AC && typeof window.addEventListener === 'function') {
    events.forEach(ev => window.addEventListener(ev, onGesture, true));
  }
})();
