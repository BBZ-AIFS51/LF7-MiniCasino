/* Mini Casino viewer: the 1.3" OLED (SH1106, 128x64, I2C 0x3C).

   MC.Oled is a port of MiniCasino/OledText.h. Same page layout, same glyph bits, same drawing
   rules: page 0 = inverted title bar, pages 2-3 = text line 0, pages 4-5 = text line 1 (the 8x8
   glyph doubled vertically like zeichen2()), page 7 = hint line, pages 1 and 6 stay empty.
   Code 0 is the euro glyph, 255 a full block, everything outside 32..126 prints as '?'.
   The controller RAM is modelled byte by byte (132 columns, the middle 128 visible) and every
   I2C transaction can be stamped with the time it finishes on the 400 kHz bus (see MC.Sim), so a
   screen builds up exactly as fast as on the real module.

   MC.OledRenderer turns the 128x64 framebuffer into real OLED pixels: square dots with dark gaps,
   true black when off, a little light bleed and a blurred glow copy for the 3D bloom plane.
   The glyph table comes from window.MC_FW (data/firmware.js, extracted from OledText.h). */
(function () {
  'use strict';
  const MC = window.MC = window.MC || {};

  const W = 128, H = 64, PAGES = 8, COLS = 132;
  // SH1106: 132 columns, the middle 128 are visible. OLED_SPALTE0 is where the sketch writes
  // (0 with CASINO_OLED_SSD1306 or CASINO_SIM), the panel window is where the glass shows RAM.
  const OLED_SPALTE0 = 2, PANEL_WINDOW = 2;
  // I2C at 400 kHz (TWBR = 12): one byte + ACK = 9 clocks = 22.5 us, plus register handling.
  const BYTE_US = 23, FRAME_US = 6;
  const COST_ZEICHEN1 = 15 * BYTE_US + 2 * FRAME_US;          // position() + daten() + 8 bytes
  const COST_INIT = (2 + 26) * BYTE_US + FRAME_US;            // befehle(OLED_INIT)
  const COST_PAGE = (5 + 2 + 132) * BYTE_US + 2 * FRAME_US;   // position() + 132 zero bytes

  const raf = fn => (typeof window.requestAnimationFrame === 'function'
    ? window.requestAnimationFrame(fn) : setTimeout(fn, 16));

  // ------------------------------------------------------------------ glyph helpers
  function fontData(opts) {
    const fw = (opts && opts.fw) || window.MC_FW;
    if (!fw || !fw.font || fw.font.length !== 95 * 8 || !fw.euro) {
      throw new Error('MC.Oled needs window.MC_FW (data/firmware.js) with the OLED font');
    }
    return fw;
  }

  // Spalten eines Zeichens, Bit 0 ist die oberste Pixelzeile (OledText::spalteVon).
  function spalteVon(fw, c, sp) {
    if (c === 255) return 0xFF;
    if (c === 0) {
      let bits = 0;
      for (let r = 0; r < 8; ++r) if (fw.euro[r] & (0x80 >> sp)) bits |= 1 << r;
      return bits;
    }
    if (c < 32 || c > 126) c = 63;   // '?': die Schrift kennt nur ASCII
    return fw.font[(c - 32) * 8 + sp];
  }
  // Vier Bits auf acht strecken: jede Pixelzeile wird doppelt so hoch (OledText::strecke).
  function strecke(vier) {
    let acht = 0;
    for (let i = 0; i < 4; ++i) if (vier & (1 << i)) acht |= 3 << (2 * i);
    return acht;
  }
  function utf8(code) {
    if (code < 0x800) return [0xC0 | (code >> 6), 0x80 | (code & 63)];
    if (code < 0x10000) return [0xE0 | (code >> 12), 0x80 | ((code >> 6) & 63), 0x80 | (code & 63)];
    return [0xF0 | (code >> 18), 0x80 | ((code >> 12) & 63), 0x80 | ((code >> 6) & 63), 0x80 | (code & 63)];
  }
  const charOf = c => (c === 0 ? '€' : c === 255 ? '█' : c >= 32 && c <= 126 ? String.fromCharCode(c) : '?');

  // ------------------------------------------------------------------ MC.Oled
  class Oled {
    constructor(opts) {
      opts = opts || {};
      this.fw = fontData(opts);
      this.fb = new Uint8Array(W * H);         // what the panel shows right now, 1 = lit
      this.ram = new Uint8Array(PAGES * COLS); // SH1106 display RAM, page by page
      this.displayOn = false;
      this.version = 0;
      this.zeichen = [new Uint8Array(16).fill(32), new Uint8Array(16).fill(32)];
      this.spalte = 0;
      this.zeile = 0;
      this.hinweisSoll = null;
      this.hinweisIst = null;
      this.begun = false;
      this.spalte0 = opts.spalte0 !== undefined ? opts.spalte0 : OLED_SPALTE0;   // OledText: OLED_SPALTE0
      this.fenster0 = opts.fenster0 !== undefined ? opts.fenster0 : PANEL_WINDOW; // first visible RAM column
      this.timeline = opts.timeline || null;   // { stamp(us) -> clock ms when done, clock }
      this.emit = opts.emit !== false;
      this.onChange = null;                     // optional sync hook, called after each change batch
      this._queue = [];
      this._timer = null;
      this._framePending = false;
      this._seed = 0x2F6E2B1 ^ (opts.seed || 0);
    }

    // ---- power and timing (not in OledText.h: the module itself)
    setTimeline(tl) { this.flush(true); this.timeline = tl || null; }
    // Supply on: the SH1106 starts with the display off and random RAM (cold) or keeps it (warm).
    powerOn(cold) {
      this.cancelPending();
      if (cold !== false) {
        let s = this._seed = (this._seed * 1103515245 + 12345) >>> 0;
        for (let i = 0; i < this.ram.length; i++) {
          s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0;
          this.ram[i] = s & 0xFF;
        }
      }
      this._setDisplay(false);
      this.begun = false;
      this._changed();
    }
    powerOff() {
      this.cancelPending();
      this.ram.fill(0);
      this._setDisplay(false);
      this.begun = false;
      this._changed();
    }
    // Drop transactions that have not happened yet (CPU reset while they were scheduled).
    cancelPending() {
      this.flush();
      this._queue.length = 0;
      if (this._timer !== null && this.timeline) this.timeline.clock.clearTimeout(this._timer);
      this._timer = null;
    }
    // Apply every transaction that is due (all of them with force).
    flush(force) {
      if (!this._queue.length) return;
      const now = this.timeline ? this.timeline.clock.now() : Infinity;
      let n = 0;
      while (n < this._queue.length && (force || this._queue[n].at <= now + 1e-6)) {
        this._queue[n].apply();
        n++;
      }
      if (n) {
        this._queue.splice(0, n);
        this._changed();
      }
    }
    get pending() { return this._queue.length; }

    _tx(us, apply) {
      if (!this.timeline) { apply(); this._changed(); return; }
      const at = this.timeline.stamp(us);
      this._queue.push({ at, apply });
      this._schedule();
    }
    _schedule() {
      if (this._timer !== null || !this._queue.length) return;
      const clock = this.timeline.clock;
      const wait = Math.max(0, this._queue[0].at - clock.now());
      this._timer = clock.setTimeout(() => {
        this._timer = null;
        this.flush();
        this._schedule();
      }, wait);
    }
    _changed() {
      this.version++;
      if (this.onChange) this.onChange(this);
      if (this.emit && !this._framePending && MC.bus) {
        this._framePending = true;
        raf(() => { this._framePending = false; MC.bus.emit('oled:frame', this); });
      }
    }
    _setDisplay(on) {
      this.displayOn = on;
      if (!on) this.fb.fill(0);
      else for (let p = 0; p < PAGES; p++) this._pageToFb(p, 0, COLS);
      this.version++;
    }
    _pageToFb(page, from, to) {
      if (!this.displayOn) return;
      for (let col = from; col < to; col++) {
        const x = col - this.fenster0;
        if (x < 0 || x >= W) continue;
        const b = this.ram[page * COLS + col];
        for (let r = 0; r < 8; r++) this.fb[(page * 8 + r) * W + x] = (b >> r) & 1;
      }
    }
    _writeColumns(page, col, bytes) {
      for (let i = 0; i < bytes.length; i++) if (col + i < COLS) this.ram[page * COLS + col + i] = bytes[i];
      this._pageToFb(page, col, Math.min(COLS, col + bytes.length));
    }

    // ---- OledText public interface
    // OledText::begin() without its leading delay(50): MC.Sim waits that time itself.
    begin() {
      this._tx(3 * BYTE_US + FRAME_US, () => this._setDisplay(false));   // 0xAE: display off
      this._tx(COST_INIT - 3 * BYTE_US, () => this._setDisplay(true));    // ... 0xA4 0xA6 0xAF
      for (let seite = 0; seite < 8; ++seite) {                          // alles loeschen, 132 Spalten
        this._tx(COST_PAGE, () => this._writeColumns(seite, 0, new Uint8Array(COLS)));
      }
      const titel = '  MINI  CASINO  ';
      for (let x = 0; x < 16; ++x) this.zeichen1(x, 0, titel.charCodeAt(x), true);
      this.zeichen[0].fill(32);
      this.zeichen[1].fill(32);
      this.spalte = this.zeile = 0;
      this.hinweisSoll = this.hinweisIst = null;
      this.begun = true;
    }

    // Hinweiszeile nur vormerken; gezeichnet wird sie in hinweisAktualisieren() aus loop().
    hinweis(text) { this.hinweisSoll = text === undefined ? null : text; }
    hinweisAktualisieren() {
      if (this.hinweisSoll === this.hinweisIst) return;
      this.hinweisIst = this.hinweisSoll;
      const p = this.hinweisIst;
      let ende = !p;
      for (let x = 0; x < 16; ++x) {
        let c = ende ? 32 : (x < p.length ? p.charCodeAt(x) & 0xFF : 0);
        if (!c) { ende = true; c = 32; }
        this.zeichen1(x, 7, c, false);
      }
    }

    setCursor(neueSpalte, neueZeile) {
      this.spalte = neueSpalte;
      this.zeile = neueZeile ? 1 : 0;
    }

    write(c) {
      c &= 0xFF;
      if (this.spalte >= 16) return 1;   // rechts abschneiden statt umbrechen
      // char zeichen[2][16] is signed on AVR: codes above 127 never compare equal, always redrawn
      if (c > 127 || this.zeichen[this.zeile][this.spalte] !== c) {
        this.zeichen[this.zeile][this.spalte] = c;
        this.zeichen2(this.spalte, this.zeile ? 4 : 2, c);
      }
      ++this.spalte;
      return 1;
    }

    // Print::print for the types the sketch uses: flash strings, unsigned numbers, chars.
    print(v) {
      if (typeof v === 'number') v = String(Math.floor(Math.abs(v)) * (v < 0 ? -1 : 1));
      let n = 0;
      for (const ch of String(v)) {
        const code = ch.codePointAt(0);
        if (code < 128) n += this.write(code);
        else for (const b of utf8(code)) n += this.write(b);   // the sketch would send UTF-8 bytes
      }
      return n;
    }

    // Not in OledText.h: blank both text lines and the hint at once (for demos and the UI).
    clear() {
      for (let z = 0; z < 2; z++) { this.setCursor(0, z); for (let i = 0; i < 16; i++) this.write(32); }
      this.setCursor(0, 0);
      this.hinweis(null);
      this.hinweisAktualisieren();
    }

    zeichen1(x, seite, c, invers) {
      const bytes = new Uint8Array(8);
      for (let sp = 0; sp < 8; ++sp) {
        const b = spalteVon(this.fw, c, sp);
        bytes[sp] = invers ? (~b) & 0xFF : b;
      }
      const col = x * 8 + this.spalte0;
      this._tx(COST_ZEICHEN1, () => this._writeColumns(seite, col, bytes));
    }
    zeichen2(x, seite, c) {
      for (let haelfte = 0; haelfte < 2; ++haelfte) {
        const bytes = new Uint8Array(8);
        for (let sp = 0; sp < 8; ++sp) {
          const b = spalteVon(this.fw, c, sp);
          bytes[sp] = strecke(haelfte ? b >> 4 : b & 0x0F);
        }
        const col = x * 8 + this.spalte0;
        this._tx(COST_ZEICHEN1, () => this._writeColumns(seite + haelfte, col, bytes));
      }
    }

    // ---- read back
    // What the sketch believes is on screen (the 32 remembered characters and the hint).
    lines() { return this.zeichen.map(row => Array.from(row, charOf).join('')); }
    hint() { return ((this.hinweisIst || '') + ' '.repeat(16)).slice(0, 16); }
    text() {
      const [line0, line1] = this.lines();
      return { title: this.begun ? '  MINI  CASINO  ' : '', line0, line1, hint: this.hint() };
    }
    // What the panel really shows: every cell of the visible framebuffer matched against the font.
    decode() {
      const map = glyphMap(this.fw);
      const cell = (y0, x, mode) => {
        let key = '';
        for (let sp = 0; sp < 8; sp++) {
          let b = 0;
          for (let r = 0; r < 8; r++) {
            let on;
            if (mode === 'double') {
              const a = this.fb[(y0 + 2 * r) * W + x * 8 + sp], c = this.fb[(y0 + 2 * r + 1) * W + x * 8 + sp];
              if (a !== c) return '�';
              on = a;
            } else {
              on = this.fb[(y0 + r) * W + x * 8 + sp];
              if (mode === 'inverse') on ^= 1;
            }
            if (on) b |= 1 << r;
          }
          key += String.fromCharCode(b);
        }
        return map.has(key) ? map.get(key) : '�';
      };
      const row = (y0, mode) => { let s = ''; for (let x = 0; x < 16; x++) s += cell(y0, x, mode); return s; };
      const blank = (y0) => { for (let i = y0 * W; i < (y0 + 8) * W; i++) if (this.fb[i]) return false; return true; };
      return {
        on: this.displayOn, title: row(0, 'inverse'), line0: row(16, 'double'), line1: row(32, 'double'),
        hint: row(56, 'plain'), gapsBlank: blank(8) && blank(48)
      };
    }
  }

  let glyphCache = null;
  function glyphMap(fw) {
    if (glyphCache && glyphCache.fw === fw) return glyphCache.map;
    const map = new Map();
    const codes = [0, 255];
    for (let c = 32; c <= 126; c++) codes.push(c);
    for (const c of codes) {
      let key = '';
      for (let sp = 0; sp < 8; sp++) key += String.fromCharCode(spalteVon(fw, c, sp));
      if (!map.has(key)) map.set(key, charOf(c));
    }
    glyphCache = { fw, map };
    return map;
  }

  Oled.W = W;
  Oled.H = H;
  Oled.charOf = charOf;
  Oled.spalteVon = (c, sp) => spalteVon(fontData(), c, sp);
  MC.Oled = Oled;

  // ------------------------------------------------------------------ MC.OledRenderer
  // Emission colours (sRGB) of the module variants. Real monochrome PMOLEDs: white is a cool
  // white, blue is a sky blue, the two-colour panel has yellow rows 0-15 and blue rows 16-63.
  const VARIANTS = {
    white: { on: [236, 244, 255] },
    blue: { on: [64, 186, 255] },
    'yellow-blue': { on: [64, 186, 255], top: [255, 212, 56], split: 16 }
  };
  const variantOf = v => VARIANTS[v] || VARIANTS.white;
  function rowColor(variant, y) {
    const v = variantOf(variant);
    return v.top && y < v.split ? v.top : v.on;
  }
  function parseColor(c) {
    if (Array.isArray(c)) return c;
    const m = /^#?([0-9a-f]{6})$/i.exec(String(c || '').trim());
    if (!m) return null;
    const n = parseInt(m[1], 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  }
  // PMOLED dots are not perfectly even: +-1.5 % per dot, fixed per panel.
  const DOT_GAIN = new Float32Array(W * H);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    let h = (x * 374761393 + y * 668265263) | 0;
    h = Math.imul(h ^ (h >>> 13), 1274126177);
    DOT_GAIN[y * W + x] = 1 + (((h ^ (h >>> 16)) >>> 0) / 4294967295 - 0.5) * 0.03;
  }
  // Rows with many lit pixels are a little dimmer (the row driver shares its current).
  function rowGains(fb, streak) {
    const g = new Float32Array(H);
    for (let y = 0; y < H; y++) {
      let n = 0;
      for (let x = 0; x < W; x++) n += fb[y * W + x];
      g[y] = 1 - streak * n / W;
    }
    return g;
  }
  // erf, Abramowitz & Stegun 7.1.26 (|error| < 1.5e-7)
  function erf(x) {
    const s = x < 0 ? -1 : 1;
    x = Math.abs(x);
    const t = 1 / (1 + 0.3275911 * x);
    const y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x);
    return s * y;
  }
  // Coverage of each texel of one pixel pitch by the lit dot (box, anti-aliased edges).
  function profile(P, gap) {
    const w = P * (1 - gap), a = (P - w) / 2, b = a + w;
    const out = new Float32Array(P);
    for (let i = 0; i < P; i++) out[i] = Math.max(0, Math.min(i + 1, b) - Math.max(i, a));
    return out;
  }
  // One lit pixel as it lands on the texture: the dot itself (dotGain) plus the light that
  // spreads around it (the dot convolved with a Gaussian of sigma pixels, haloGain).
  const kernels = new Map();
  function kernel(P, gap, sigma, dotGain, haloGain) {
    const key = [P, gap, sigma, dotGain, haloGain].join('|');
    if (kernels.has(key)) return kernels.get(key);
    const R = haloGain > 0 ? Math.ceil(2.5 * sigma * P) : 0;
    const size = P + 2 * R;
    const prof = profile(P, gap);
    const w = P * (1 - gap), s2 = Math.max(1e-6, sigma * P) * Math.SQRT2;
    const g = new Float32Array(size);   // separable halo profile, texel centres
    for (let i = 0; i < size; i++) {
      const x = i + 0.5 - R - P / 2;
      g[i] = 0.5 * (erf((x + w / 2) / s2) - erf((x - w / 2) / s2));
    }
    const k = new Float32Array(size * size);
    for (let j = 0; j < size; j++) {
      for (let i = 0; i < size; i++) {
        let v = haloGain * g[i] * g[j];
        const di = i - R, dj = j - R;
        if (di >= 0 && di < P && dj >= 0 && dj < P) v += dotGain * prof[di] * prof[dj];
        k[j * size + i] = v;
      }
    }
    const out = { k, size, R, P, prof };
    kernels.set(key, out);
    return out;
  }

  const WHITEN = 0.45;
  // Halo reach of a kernel in OLED rows: a change in row y repaints rows y - reach .. y + reach.
  const reachOf = o => Math.ceil(kernel(o.P, o.gap, o.sigma, o.glowOnly ? 0 : 1, o.haloGain).R / o.P);
  // OLED rows that differ between two framebuffers: [first, last], last < 0 when equal.
  function changedRows(a, b) {
    let first = H, last = -1;
    for (let y = 0; y < H; y++) {
      for (let x = y * W, e = x + W; x < e; x++) {
        if (a[x] !== b[x]) { if (y < first) first = y; last = y; break; }
      }
    }
    return [first, last];
  }

  // Render OLED rows ya..yb of fb (all rows when ya is undefined) into a Uint32 RGBA view of
  // (128 + 2m)P x (64 + 2m)P texels; m = o.margin is an empty border in OLED pixels that gives
  // the glow room to spread past the edge of the active area.
  // o: P, gap, sigma, haloGain, glowOnly, margin, variant, on (custom colour), off, streak, grid, acc
  function render(px, fb, o, ya, yb) {
    const P = o.P, m = o.margin || 0, w = (W + 2 * m) * P, h = (H + 2 * m) * P;
    const K = kernel(P, o.gap, o.sigma, o.glowOnly ? 0 : 1, o.haloGain), k = K.k, size = K.size, R = K.R;
    if (ya === undefined) { ya = 0; yb = H - 1; }
    // texel rows to repaint; the margins belong to the first and the last row
    const tyA = ya <= 0 ? 0 : (ya + m) * P, tyB = yb >= H - 1 ? h : (yb + 1 + m) * P, reach = Math.ceil(R / P);
    const acc = o.acc;
    acc.fill(0, tyA * w, tyB * w);
    const rows = rowGains(fb, o.streak);
    for (let y = Math.max(0, ya - reach), ye = Math.min(H - 1, yb + reach); y <= ye; y++) {
      for (let x = 0; x < W; x++) {
        if (!fb[y * W + x]) continue;
        const gain = rows[y] * DOT_GAIN[y * W + x];
        const x0 = (x + m) * P - R, y0 = (y + m) * P - R;
        const i0 = Math.max(0, -x0), i1 = Math.min(size, w - x0);
        const j0 = Math.max(0, -y0, tyA - y0), j1 = Math.min(size, h - y0, tyB - y0);
        for (let j = j0; j < j1; j++) {
          let a = (y0 + j) * w + x0 + i0, b = j * size + i0;
          for (let i = i0; i < i1; i++) acc[a++] += k[b++] * gain;
        }
      }
    }
    const off = o.off, vt = variantOf(o.variant), prof = K.prof, grid = o.grid, gc = o.gridColor;
    const offPacked = (255 << 24) | (off[2] << 16) | (off[1] << 8) | off[0];
    for (let ty = tyA; ty < tyB; ty++) {
      const oy = ((ty / P) | 0) - m, c = o.on || rowColor(o.variant, Math.max(0, Math.min(H - 1, oy)));
      // the two-colour panel has a slightly wider dark seam between its yellow and blue areas
      const seam = !o.on && vt.top && ((oy === vt.split - 1 && ty % P === P - 1) || (oy === vt.split && ty % P === 0)) ? 0.4 : 1;
      const dr = c[0] - off[0], dg = c[1] - off[1], db = c[2] - off[2];
      const py = prof[ty % P], gridRow = grid && oy >= 0 && oy < H;
      let p = ty * w;
      for (let tx = 0; tx < w; tx++, p++) {
        let v = acc[p];
        if (gridRow) {
          const ox = ((tx / P) | 0) - m;
          if (ox >= 0 && ox < W && !fb[oy * W + ox]) {
            const gv = grid * py * prof[tx % P];
            v = Math.min(1, v * seam);
            px[p] = (255 << 24) | (Math.min(255, off[2] + db * v + (gc[2] - off[2]) * gv) << 16)
              | (Math.min(255, off[1] + dg * v + (gc[1] - off[1]) * gv) << 8) | Math.min(255, off[0] + dr * v + (gc[0] - off[0]) * gv);
            continue;
          }
        }
        if (v <= 0.0005) { px[p] = offPacked; continue; }
        v *= seam;
        if (v <= 1) {
          px[p] = (255 << 24) | ((off[2] + db * v) << 16) | ((off[1] + dg * v) << 8) | (off[0] + dr * v);
        } else {
          // more light than the dot alone (dense strokes): the bright core turns whiter, like
          // any strong emitter does to the eye or a camera
          const e = Math.min(1, (v - 1) * WHITEN);
          px[p] = (255 << 24) | ((c[2] + (255 - c[2]) * e) << 16) | ((c[1] + (255 - c[1]) * e) << 8) | (c[0] + (255 - c[0]) * e);
        }
      }
    }
    return [tyA, tyB];
  }

  function makeCanvas(w, h) {
    const c = document.createElement('canvas');
    c.width = w;
    c.height = h;
    return c;
  }
  // ImageData + Uint32 view + accumulation buffer per size, reused between frames
  const buffers = new Map();
  function buffersFor(ctx, w, h) {
    const key = w + 'x' + h;
    let b = buffers.get(key);
    if (!b) {
      const img = ctx.createImageData(w, h);
      b = { img, px: new Uint32Array(img.data.buffer), acc: new Float32Array(w * h) };
      buffers.set(key, b);
    }
    return b;
  }

  const Renderer = {
    W, H, variants: Object.keys(VARIANTS),
    color(variant, y) { return rowColor(variant, y === undefined ? 32 : y).slice(); },

    // Paint fb as OLED pixels onto a 2D context at (x, y): 128*pixel x 64*pixel device pixels.
    // opts: pixel (int, 4), gap (0.14), variant ('white'|'blue'|'yellow-blue'), on (colour
    // override), off ('#000000'), glow (0.4: the halo the cover glass spreads around each dot),
    // streak (0.06), grid (0; 0.02-0.05 shows the unlit matrix like a panel in room light), x, y.
    draw(ctx, fb, opts) {
      opts = opts || {};
      const P = Math.max(1, Math.round(opts.pixel || 4));
      const b = buffersFor(ctx, W * P, H * P);
      render(b.px, fb, {
        P, gap: opts.gap !== undefined ? opts.gap : 0.14, sigma: 0.5,
        haloGain: opts.glow !== undefined ? opts.glow : 0.4, variant: opts.variant || 'white',
        on: opts.on ? parseColor(opts.on) : null, off: parseColor(opts.off || '#000000') || [0, 0, 0],
        streak: opts.streak !== undefined ? opts.streak : 0.06, grid: opts.grid || 0,
        gridColor: [150, 158, 170], acc: b.acc
      });
      ctx.putImageData(b.img, opts.x || 0, opts.y || 0);
    },

    // Canvases for the 3D screen. `canvas` 1024 x 512: 8 texels per OLED pixel, exactly the active
    // area (29.42 x 14.70 mm), for the emissive map, with a little halo in the gaps. `glowCanvas`
    // 256 x 128: the soft bloom for the additive plane over the same active area. With
    // opts.glowMargin = m (OLED pixels) the glow canvas gets an empty border so the light can spread
    // past the edge; the plane must then be glowScale = [(128 + 2m) / 128, (64 + 2m) / 64] times the
    // active area, same centre. update(fb) repaints both; texture / glowTexture are THREE textures.
    createTexture(opts) {
      opts = opts || {};
      const GM = Math.max(0, Math.round(opts.glowMargin || 0));
      const canvas = makeCanvas(W * 8, H * 8);
      const glowCanvas = makeCanvas((W + 2 * GM) * 2, (H + 2 * GM) * 2);
      const ctx = canvas.getContext('2d');
      const gctx = glowCanvas.getContext('2d');
      const main = { img: ctx.createImageData(canvas.width, canvas.height) };
      const glow = { img: gctx.createImageData(glowCanvas.width, glowCanvas.height) };
      main.px = new Uint32Array(main.img.data.buffer); main.acc = new Float32Array(canvas.width * canvas.height);
      glow.px = new Uint32Array(glow.img.data.buffer); glow.acc = new Float32Array(glowCanvas.width * glowCanvas.height);
      let texture = null, glowTexture = null;
      const T = () => window.THREE;
      const obj = {
        canvas, glowCanvas,
        glowScale: [(W + 2 * GM) / W, (H + 2 * GM) / H],
        variant: VARIANTS[opts.variant] ? opts.variant : 'white',
        bleed: opts.bleed !== undefined ? opts.bleed : 0.22,
        version: 0,
        _fb: new Uint8Array(W * H),
        _drawn: false,
        _variantDrawn: null,
        // Repaint from fb (or the last one). Only rows that changed (plus the halo reach) are
        // redrawn: a spin step touches text line 1 only.
        update(fb) {
          let first = 0, last = H - 1;
          if (fb && this._drawn && this._variantDrawn === this.variant) {
            [first, last] = changedRows(this._fb, fb);
            if (last < 0) return this;
          }
          if (fb) this._fb.set(fb);
          const om = { P: 8, gap: 0.16, sigma: 0.5, haloGain: this.bleed, variant: this.variant,
            on: null, off: [0, 0, 0], streak: 0.06, grid: 0, acc: main.acc };
          // bloom: the dot blurred with sigma 1.4 pixels only (no sharp dot)
          const og = { P: 2, gap: 0, sigma: 1.4, haloGain: 1.25, glowOnly: true, margin: GM, variant: this.variant,
            on: null, off: [0, 0, 0], streak: 0.06, grid: 0, acc: glow.acc };
          for (const [o, buf, c2d, cw] of [[om, main, ctx, canvas.width], [og, glow, gctx, glowCanvas.width]]) {
            const r = reachOf(o);
            const [tyA, tyB] = render(buf.px, this._fb, o, Math.max(0, first - r), Math.min(H - 1, last + r));
            c2d.putImageData(buf.img, 0, 0, 0, tyA, cw, tyB - tyA);
          }
          this._drawn = true;
          this._variantDrawn = this.variant;
          this.version++;
          if (texture) texture.needsUpdate = true;
          if (glowTexture) glowTexture.needsUpdate = true;
          return this;
        },
        setVariant(name) {
          if (VARIANTS[name] && name !== this.variant) { this.variant = name; this.update(); }
          return this;
        },
        get texture() {
          if (!texture && T()) {
            texture = new (T().CanvasTexture)(canvas);
            texture.encoding = T().sRGBEncoding;
            texture.anisotropy = (MC.tex && MC.tex.anisotropy) || 4;
          }
          return texture;
        },
        get glowTexture() {
          if (!glowTexture && T()) {
            glowTexture = new (T().CanvasTexture)(glowCanvas);
            glowTexture.encoding = T().sRGBEncoding;
          }
          return glowTexture;
        }
      };
      obj.update(opts.fb || null);
      return obj;
    }
  };
  MC.OledRenderer = Renderer;
})();
