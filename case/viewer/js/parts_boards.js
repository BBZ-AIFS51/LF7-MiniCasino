/* Mini Casino viewer: the three circuit boards, built procedurally with three.js r147.

     MC.parts.uno(opts)         Arduino Uno R3 (A000066)
     MC.parts.oledModule(opts)  1.3" 128x64 OLED module, SH1106, I2C, 4-pin header
     MC.parts.rc522(opts)       RC522 RFID reader module with the 90 degree header from the kit

   Units are millimetres. Every builder returns { group, pins, size, extra } in the part local
   frame of SPEC section 3: origin = centre of the PCB outline on the PCB bottom face, +Y = the
   component side, +X = reading direction of the silkscreen, +Z = toward the reader.
   Every mesh carries userData.part. Repeated geometry is merged per material, so one board costs
   about 15-20 draw calls. opts: { quality: 'high' | 'low' } ('low' halves the texture resolution).

   Dimension sources (all named constants below carry their source):
   - Uno R3: Arduino UNO Rev3 reference design (Eagle board A000066, 2.7 x 2.1 in) and the
     Arduino shield layout in mil: digital header y = 2000, D0..D7 at x = 2600..1900,
     D8..D13 at 1740..1240, GND 1140, AREF 1040, SDA 940, SCL 840 (the 160 mil gap D7/D8);
     power header y = 100, NC 900, IOREF 1000 .. VIN 1600; analog A0..A5 x = 2000..2500;
     holes (550,100) (600,2000) (2600,300) (2600,1400) Ø3.2; board outline with the stepped
     right edge. USB-B: 12.0 x 16.0 x 10.9, 6.3 overhang (Wurth 61729-0010BA class);
     DC jack 9.0 x 13.7 x 11.0, 1.8 overhang (DC-005 class); female headers 8.5 high.
   - OLED: 1.3" SH1106 module 35.4 x 33.5 x 1.2 (common 4-pin I2C module drawing),
     COG panel 34.5 x 23.0 x 1.45, active area 29.42 x 14.70, pixel pitch 0.23 (ER-OLED013-1
     class datasheet), holes 4 x Ø2.0 at 2.0 from the edges, header 2.54 centred on the top edge.
   - RC522: blue "RFID-RC522" module 60.0 x 39.0 x 1.6, 8-pin header 2.54 on a short edge
     (SDA SCK MOSI MISO IRQ GND RST 3.3V), MFRC522 HVQFN32 5 x 5 x 0.85 (NXP datasheet),
     27.12 MHz HC-49/S crystal 11.05 x 4.65 x 3.5, right angle header 2.54 body, 6.0 pin.
   The positions of the small parts inside the boards follow photos of the real boards. */
(function () {
  'use strict';
  const MC = window.MC;
  const T = window.THREE;
  if (!MC || !T) return;
  MC.parts = MC.parts || {};

  const PI = Math.PI;
  const D2R = PI / 180;
  const IN = 25.4;
  const V3 = (x, y, z) => new T.Vector3(x, y, z);

  // ================================================================== geometry kit
  // Translation + rotation (Euler order YXZ: tilt first, heading last), degrees.
  const _q = new T.Quaternion();
  const _e = new T.Euler();
  const ONE = V3(1, 1, 1);
  function TR(x, y, z, ry, rx, rz) {
    _e.set((rx || 0) * D2R, (ry || 0) * D2R, (rz || 0) * D2R, 'YXZ');
    _q.setFromEuler(_e);
    return new T.Matrix4().compose(V3(x, y, z), _q, ONE);
  }
  function mul() {
    const m = new T.Matrix4();
    for (let i = 0; i < arguments.length; i++) if (arguments[i]) m.multiply(arguments[i]);
    return m;
  }

  // Shared source geometry (never rendered directly, only copied into merged meshes).
  const geoCache = new Map();
  function cached(key, make) {
    let g = geoCache.get(key);
    if (!g) { g = make(); geoCache.set(key, g); }
    return g;
  }
  const box = (w, h, d) => cached('box' + [w, h, d], () => new T.BoxGeometry(w, h, d).translate(0, h / 2, 0));
  const rbox = (w, h, d, r, seg) => cached('rbox' + [w, h, d, r, seg], () =>
    new T.RoundedBoxGeometry(w, h, d, seg || 2, Math.min(r, w / 2 - 1e-3, h / 2 - 1e-3, d / 2 - 1e-3)).translate(0, h / 2, 0));
  const cyl = (r0, r1, h, seg, open) => cached('cyl' + [r0, r1, h, seg, open], () =>
    new T.CylinderGeometry(r1, r0, h, seg || 16, 1, !!open).translate(0, h / 2, 0));
  const lathe = (key, pts, seg) => cached('lathe' + key, () =>
    new T.LatheGeometry(pts.map(p => new T.Vector2(p[0], p[1])), seg || 16));

  // Extrude a 2D shape (sx = X, sy = -Z) upward to height h; bevel rounds the edges inside the outline.
  function extrudeY(shape, h, bevel, curveSegments) {
    const b = bevel || 0;
    const g = new T.ExtrudeGeometry(shape, {
      depth: Math.max(1e-3, h - 2 * b), bevelEnabled: b > 0, bevelThickness: b, bevelSize: b,
      bevelOffset: -b, bevelSegments: 2, curveSegments: curveSegments || 12
    });
    g.rotateX(-PI / 2);
    g.translate(0, b, 0);
    return g;
  }
  function rectShape(w, d, r) {
    const s = new T.Shape();
    const x0 = -w / 2, y0 = -d / 2;
    r = r || 0;
    if (!r) { s.moveTo(x0, y0); s.lineTo(-x0, y0); s.lineTo(-x0, -y0); s.lineTo(x0, -y0); s.closePath(); return s; }
    s.moveTo(x0 + r, y0);
    s.lineTo(-x0 - r, y0); s.quadraticCurveTo(-x0, y0, -x0, y0 + r);
    s.lineTo(-x0, -y0 - r); s.quadraticCurveTo(-x0, -y0, -x0 - r, -y0);
    s.lineTo(x0 + r, -y0); s.quadraticCurveTo(x0, -y0, x0, -y0 - r);
    s.lineTo(x0, y0 + r); s.quadraticCurveTo(x0, y0, x0 + r, y0);
    return s;
  }
  function stadiumShape(len, w) {
    const s = new T.Shape();
    const r = w / 2, a = len / 2 - r;
    s.moveTo(-a, -r); s.lineTo(a, -r);
    s.absarc(a, 0, r, -PI / 2, PI / 2, false);
    s.lineTo(-a, r);
    s.absarc(-a, 0, r, PI / 2, PI * 1.5, false);
    return s;
  }

  // Triangle soup builder with face normals; the hint vector decides which side is the front.
  const _a = new T.Vector3(), _b = new T.Vector3();
  class Poly {
    constructor() { this.p = []; this.n = []; this.t = []; }
    tri(a, b, c, hint, uv) {
      const n = _a.subVectors(b, a).cross(_b.subVectors(c, a));
      if (n.lengthSq() < 1e-14) return this;
      n.normalize();
      if (hint && n.dot(hint) < 0) { const t = b; b = c; c = t; n.negate(); if (uv) uv = [uv[0], uv[2], uv[1]]; }
      const v = [a, b, c];
      for (let i = 0; i < 3; i++) {
        this.p.push(v[i].x, v[i].y, v[i].z);
        this.n.push(n.x, n.y, n.z);
        if (uv) this.t.push(uv[i][0], uv[i][1]); else this.t.push(0, 0);
      }
      return this;
    }
    quad(a, b, c, d, hint, uv) {
      this.tri(a, b, c, hint, uv && [uv[0], uv[1], uv[2]]);
      this.tri(a, c, d, hint, uv && [uv[0], uv[2], uv[3]]);
      return this;
    }
    // horizontal rectangle at height y, facing up (dir 1) or down (dir -1)
    rectY(x0, z0, x1, z1, y, dir) {
      if (x1 - x0 < 1e-6 || z1 - z0 < 1e-6) return this;
      return this.quad(V3(x0, y, z0), V3(x0, y, z1), V3(x1, y, z1), V3(x1, y, z0), V3(0, dir || 1, 0));
    }
    geo() {
      const g = new T.BufferGeometry();
      g.setAttribute('position', new T.Float32BufferAttribute(this.p, 3));
      g.setAttribute('normal', new T.Float32BufferAttribute(this.n, 3));
      g.setAttribute('uv', new T.Float32BufferAttribute(this.t, 2));
      return g;
    }
  }

  // Merge many (geometry, matrix) pairs into one non-indexed geometry (position, normal, uv).
  // Raw array loop: this runs over ~100k vertices per board, so no Vector3 calls in here.
  const _nm = new T.Matrix3();
  function mergeList(list) {
    let count = 0;
    const src = [];
    for (const [g, m] of list) {
      let ng = g;
      if (g.index) ng = g.userData.flat || (g.userData.flat = g.toNonIndexed());
      if (!ng.attributes.normal) ng.computeVertexNormals();
      src.push([ng, m]);
      count += ng.attributes.position.count;
    }
    const pos = new Float32Array(count * 3), nor = new Float32Array(count * 3), uv = new Float32Array(count * 2);
    let o = 0;
    for (const [g, m] of src) {
      const P = g.attributes.position.array, N = g.attributes.normal.array;
      const U = g.attributes.uv ? g.attributes.uv.array : null;
      const n = g.attributes.position.count;
      const e = m ? m.elements : null;
      let ne = null, flip = false;
      if (m) { _nm.getNormalMatrix(m); ne = _nm.elements; flip = m.determinant() < 0; }
      for (let i = 0; i < n; i++) {
        const j = flip ? (i % 3 === 1 ? i + 1 : i % 3 === 2 ? i - 1 : i) : i;   // keep the winding
        const j3 = j * 3, k = (o + i) * 3;
        const x = P[j3], y = P[j3 + 1], z = P[j3 + 2];
        const nx = N[j3], ny = N[j3 + 1], nz = N[j3 + 2];
        if (e) {
          pos[k] = e[0] * x + e[4] * y + e[8] * z + e[12];
          pos[k + 1] = e[1] * x + e[5] * y + e[9] * z + e[13];
          pos[k + 2] = e[2] * x + e[6] * y + e[10] * z + e[14];
          const a = ne[0] * nx + ne[3] * ny + ne[6] * nz, b = ne[1] * nx + ne[4] * ny + ne[7] * nz, c = ne[2] * nx + ne[5] * ny + ne[8] * nz;
          const l = 1 / (Math.sqrt(a * a + b * b + c * c) || 1);
          nor[k] = a * l; nor[k + 1] = b * l; nor[k + 2] = c * l;
        } else {
          pos[k] = x; pos[k + 1] = y; pos[k + 2] = z;
          nor[k] = nx; nor[k + 1] = ny; nor[k + 2] = nz;
        }
        if (U) { uv[(o + i) * 2] = U[j * 2]; uv[(o + i) * 2 + 1] = U[j * 2 + 1]; }
      }
      o += n;
    }
    const out = new T.BufferGeometry();
    out.setAttribute('position', new T.BufferAttribute(pos, 3));
    out.setAttribute('normal', new T.BufferAttribute(nor, 3));
    out.setAttribute('uv', new T.BufferAttribute(uv, 2));
    out.computeBoundingBox();
    out.computeBoundingSphere();
    return out;
  }

  // Collects geometry per material key and turns every bucket into one mesh.
  class Kit {
    constructor(part) {
      this.part = part;
      this.buckets = new Map();
      this.group = new T.Group();
      this.group.name = part;
      this.group.userData.part = part;
    }
    add(key, geo, m) {
      let l = this.buckets.get(key);
      if (!l) this.buckets.set(key, l = []);
      l.push([geo, m ? m.clone() : null]);
      return this;
    }
    mesh(key, material, o) {
      const l = this.buckets.get(key);
      if (!l || !l.length) return null;
      return this.addMesh(mergeList(l), material, key, o);
    }
    addMesh(geometry, material, name, o) {
      o = o || {};
      const m = new T.Mesh(geometry, material);
      m.name = this.part + ':' + name;
      m.userData.part = this.part;
      m.castShadow = o.cast !== false;
      m.receiveShadow = o.receive !== false;
      if (o.renderOrder) m.renderOrder = o.renderOrder;
      this.group.add(m);
      return m;
    }
  }

  // ================================================================== part library (local, y = 0 on the PCB surface)
  // Square pin 0.64 along +Y from 0 to len, tapered ends.
  function pinGeo(len, tTop, tBot) {
    return cached('pin' + [len, tTop, tBot], () => {
      const p = new Poly(), s = 0.32, ts = 0.15, tl = 0.42;
      const lv = [[0, tBot ? ts : s], [tBot ? tl : 0, s], [tTop ? len - tl : len, s], [len, tTop ? ts : s]];
      const ring = (y, h) => [V3(-h, y, -h), V3(h, y, -h), V3(h, y, h), V3(-h, y, h)];
      for (let i = 0; i < lv.length - 1; i++) {
        const A = ring(lv[i][0], lv[i][1]), B = ring(lv[i + 1][0], lv[i + 1][1]);
        if (lv[i + 1][0] - lv[i][0] < 1e-6) continue;
        for (let k = 0; k < 4; k++) {
          const k2 = (k + 1) % 4;
          const hint = V3((A[k].x + A[k2].x) / 2, 0, (A[k].z + A[k2].z) / 2);
          p.quad(A[k], A[k2], B[k2], B[k], hint);
        }
      }
      const top = ring(len, tTop ? ts : s), bot = ring(0, tBot ? ts : s);
      p.quad(top[0], top[1], top[2], top[3], V3(0, 1, 0));
      p.quad(bot[0], bot[1], bot[2], bot[3], V3(0, -1, 0));
      return p.geo();
    });
  }

  // Female header (n pins along X, centred, bottom at y = 0): body, dark hole bottoms, contacts.
  function femaleHeaderGeo(n, height) {
    return cached('fh' + n + ',' + height, () => {
      const P = 2.54, L = n * P, Wd = 2.54, Hh = height, ch = 0.2, a = 0.74, b = 0.42, fd = 0.8, td = 3.4;
      const body = new Poly(), dark = new Poly(), cont = new Poly();
      const x0 = -L / 2, x1 = L / 2, z0 = -Wd / 2, z1 = Wd / 2, yC = Hh - ch;
      body.quad(V3(x0, 0, z1), V3(x1, 0, z1), V3(x1, yC, z1), V3(x0, yC, z1), V3(0, 0, 1));
      body.quad(V3(x0, 0, z0), V3(x1, 0, z0), V3(x1, yC, z0), V3(x0, yC, z0), V3(0, 0, -1));
      body.quad(V3(x0, 0, z0), V3(x0, 0, z1), V3(x0, yC, z1), V3(x0, yC, z0), V3(-1, 0, 0));
      body.quad(V3(x1, 0, z0), V3(x1, 0, z1), V3(x1, yC, z1), V3(x1, yC, z0), V3(1, 0, 0));
      const ix0 = x0 + ch, ix1 = x1 - ch, iz0 = z0 + ch, iz1 = z1 - ch;
      body.quad(V3(x0, yC, z1), V3(x1, yC, z1), V3(ix1, Hh, iz1), V3(ix0, Hh, iz1), V3(0, 1, 1));
      body.quad(V3(x0, yC, z0), V3(x1, yC, z0), V3(ix1, Hh, iz0), V3(ix0, Hh, iz0), V3(0, 1, -1));
      body.quad(V3(x0, yC, z0), V3(x0, yC, z1), V3(ix0, Hh, iz1), V3(ix0, Hh, iz0), V3(-1, 1, 0));
      body.quad(V3(x1, yC, z0), V3(x1, yC, z1), V3(ix1, Hh, iz1), V3(ix1, Hh, iz0), V3(1, 1, 0));
      const yF = Hh - fd, yB = Hh - td;
      const sq = (cx, h, y) => [V3(cx - h, y, -h), V3(cx + h, y, -h), V3(cx + h, y, h), V3(cx - h, y, h)];
      for (let i = 0; i < n; i++) {
        const cx = x0 + P / 2 + i * P;
        const cx0 = Math.max(ix0, cx - P / 2), cx1 = Math.min(ix1, cx + P / 2);
        body.rectY(cx0, iz0, cx - a, iz1, Hh);
        body.rectY(cx + a, iz0, cx1, iz1, Hh);
        body.rectY(cx - a, iz0, cx + a, -a, Hh);
        body.rectY(cx - a, a, cx + a, iz1, Hh);
        const A = sq(cx, a, Hh), B = sq(cx, b, yF), C = sq(cx, b, yB);
        for (let k = 0; k < 4; k++) {
          const k2 = (k + 1) % 4;
          const mx = (A[k].x + A[k2].x) / 2, mz = (A[k].z + A[k2].z) / 2;
          body.quad(A[k], A[k2], B[k2], B[k], V3(cx - mx, 0.8, -mz));
          body.quad(B[k], B[k2], C[k2], C[k], V3(cx - mx, 0, -mz));
        }
        dark.rectY(cx - b, -b, cx + b, b, yB);
        // the two springs of the contact, seen through the hole
        for (const sx of [-1, 1]) {
          const x = cx + sx * (b - 0.03);
          cont.quad(V3(x, yB + 0.25, -0.27), V3(x, yB + 0.25, 0.27), V3(x - sx * 0.12, yF - 0.25, 0.27), V3(x - sx * 0.12, yF - 0.25, -0.27), V3(-sx, 0.2, 0));
        }
      }
      return { body: body.geo(), dark: dark.geo(), cont: cont.geo() };
    });
  }

  // Concave solder fillet around a through-hole pin, y = 0 on the copper.
  // (profiles run bottom to top so the lathe faces point outward)
  const solderGeo = () => lathe('solder', [[1.0, 0], [0.78, 0.1], [0.52, 0.34], [0.4, 0.7], [0.32, 1.02], [0, 1.08]], 10);
  const smallSolderGeo = () => lathe('ssolder', [[0.72, 0], [0.55, 0.1], [0.42, 0.28], [0.34, 0.55], [0.3, 0.85], [0, 0.9]], 10);

  // Gull wing lead seen from the side, extruded across its width; starts at the body edge (x = 0).
  function gullGeo(len, w, h, t) {
    return cached('gull' + [len, w, h, t], () => {
      t = t || 0.18;
      const s = new T.Shape();
      const k = Math.min(0.5, len * 0.35);
      s.moveTo(0, h + t / 2); s.lineTo(k * 0.45, h + t / 2); s.lineTo(k + t * 0.3, t); s.lineTo(len, t);
      s.lineTo(len, 0); s.lineTo(k - t * 0.3, 0); s.lineTo(k * 0.45 - t * 0.5, h - t / 2); s.lineTo(0, h - t / 2);
      s.closePath();
      const g = new T.ExtrudeGeometry(s, { depth: w, bevelEnabled: false });
      g.translate(0, 0, -w / 2);
      return g;
    });
  }

  // ================================================================== textures
  // Board painter: records drawing ops once, replays them into the colour map and the data map
  // (R = height for the bump map, G = roughness, B = metalness; linear).
  const DATA = {
    mask: [70, 104, 0], pour: [88, 100, 0], trace: [112, 98, 0], via: [124, 98, 0], viaHole: [40, 140, 0],
    hole: [30, 200, 0], tin: [136, 64, 255], gold: [136, 54, 255], silk: [168, 205, 0], fr4: [52, 190, 0]
  };
  const rgb = a => 'rgb(' + a[0] + ',' + a[1] + ',' + a[2] + ')';
  const SILK_FONT = 'Arial, Helvetica, sans-serif';

  function roundRect(ctx, x, y, w, h, r) {
    r = Math.min(r || 0, w / 2, h / 2);
    ctx.beginPath();
    if (!r) { ctx.rect(x, y, w, h); return; }
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }

  class Painter {
    // map(x, y) -> canvas millimetres; mirror = the board is seen from below
    constructor(W, H, map, mask) { this.W = W; this.H = H; this.map = map; this.mask = mask; this.ops = []; }
    style(kind, L) {
      if (L === 'data') return rgb(DATA[kind] || DATA.mask);
      const sh = MC.tex.shade;
      switch (kind) {
        case 'pour': return sh(this.mask, 0.03);
        case 'trace': return sh(this.mask, 0.07);
        case 'via': return sh(this.mask, 0.1);
        case 'viaHole': return sh(this.mask, -0.16);
        case 'hole': return '#0E1011';
        case 'tin': return '#C9CDD2';
        case 'gold': return '#D9AB55';
        case 'silk': return '#F1F1EB';
        case 'fr4': return '#B6AD86';
        default: return this.mask;
      }
    }
    at(ctx, x, y, rot) {
      const p = this.map(x, y);
      ctx.translate(p[0], p[1]);
      if (rot) ctx.rotate(-rot * D2R);
    }
    op(fn) { this.ops.push(fn); return this; }
    pad(x, y, w, h, o) {
      o = o || {};
      return this.op((ctx, L) => {
        ctx.save(); this.at(ctx, x, y, o.rot);
        ctx.fillStyle = this.style(o.fin || 'tin', L);
        roundRect(ctx, -w / 2, -h / 2, w, h, o.r || 0); ctx.fill();
        ctx.restore();
      });
    }
    circ(x, y, r, kind) {
      return this.op((ctx, L) => {
        const p = this.map(x, y);
        ctx.fillStyle = this.style(kind || 'tin', L);
        ctx.beginPath(); ctx.arc(p[0], p[1], r, 0, PI * 2); ctx.fill();
      });
    }
    ring(x, y, ro, ri, fin) { this.circ(x, y, ro, fin || 'tin'); return this.circ(x, y, ri, 'hole'); }
    trace(pts, w, kind) {
      return this.op((ctx, L) => {
        ctx.strokeStyle = this.style(kind || 'trace', L);
        ctx.lineWidth = w || 0.3; ctx.lineCap = ctx.lineJoin = 'round';
        ctx.beginPath();
        pts.forEach((q, i) => { const p = this.map(q[0], q[1]); if (i) ctx.lineTo(p[0], p[1]); else ctx.moveTo(p[0], p[1]); });
        ctx.stroke();
      });
    }
    via(x, y, r) { r = r || 0.38; this.circ(x, y, r, 'via'); return this.circ(x, y, r * 0.42, 'viaHole'); }
    poly(pts, kind) {
      return this.op((ctx, L) => {
        ctx.fillStyle = this.style(kind || 'pour', L);
        ctx.beginPath();
        pts.forEach((q, i) => { const p = this.map(q[0], q[1]); if (i) ctx.lineTo(p[0], p[1]); else ctx.moveTo(p[0], p[1]); });
        ctx.closePath(); ctx.fill();
      });
    }
    // silkscreen text; o: { size, rot, align, weight, base }; parts may contain {tri:'r'|'l'}
    text(str, x, y, o) {
      o = o || {};
      return this.op((ctx, L) => {
        ctx.save(); this.at(ctx, x, y, o.rot);
        ctx.fillStyle = this.style(o.kind || 'silk', L);
        const size = o.size || 1;
        ctx.font = (o.weight || 700) + ' ' + size + 'px ' + (o.font || SILK_FONT);
        ctx.textBaseline = o.base || 'middle';
        const parts = Array.isArray(str) ? str : [str];
        const widths = parts.map(p => typeof p === 'string' ? ctx.measureText(p).width : size * 0.62);
        const total = widths.reduce((s, w) => s + w, 0) + (parts.length - 1) * size * 0.06;
        let cx = o.align === 'right' ? -total : o.align === 'left' ? 0 : -total / 2;
        ctx.textAlign = 'left';
        parts.forEach((p, i) => {
          if (typeof p === 'string') ctx.fillText(p, cx, 0);
          else {
            const s = size * 0.3, mx = cx + widths[i] / 2;
            ctx.beginPath();
            if (p.tri === 'r') { ctx.moveTo(mx - s, -s); ctx.lineTo(mx + s, 0); ctx.lineTo(mx - s, s); }
            else { ctx.moveTo(mx + s, -s); ctx.lineTo(mx - s, 0); ctx.lineTo(mx + s, s); }
            ctx.closePath(); ctx.fill();
          }
          cx += widths[i] + size * 0.06;
        });
        ctx.restore();
      });
    }
    line(pts, w, kind) { return this.trace(pts, w || 0.15, kind || 'silk'); }
    rect(x, y, w, h, o) {
      o = o || {};
      return this.op((ctx, L) => {
        ctx.save(); this.at(ctx, x, y, o.rot);
        ctx.strokeStyle = ctx.fillStyle = this.style(o.kind || 'silk', L);
        ctx.lineWidth = o.lw || 0.15;
        roundRect(ctx, -w / 2, -h / 2, w, h, o.r || 0);
        if (o.fill) ctx.fill(); else ctx.stroke();
        ctx.restore();
      });
    }
    circle(x, y, r, o) {
      o = o || {};
      return this.op((ctx, L) => {
        const p = this.map(x, y);
        ctx.strokeStyle = ctx.fillStyle = this.style(o.kind || 'silk', L);
        ctx.lineWidth = o.lw || 0.15;
        ctx.beginPath(); ctx.arc(p[0], p[1], r, 0, PI * 2);
        if (o.fill) ctx.fill(); else ctx.stroke();
      });
    }
    custom(x, y, rot, fn) {
      return this.op((ctx, L) => { ctx.save(); this.at(ctx, x, y, rot); fn(ctx, kind => this.style(kind, L), L); ctx.restore(); });
    }
    // colour map and data map at k px/mm
    textures(k) {
      const W = this.W, H = this.H;
      const color = MC.tex.board(W, H, this.mask, ctx => this.ops.forEach(op => op(ctx, 'color')), k);
      const data = MC.tex.canvas(Math.round(W * k), Math.round(H * k), ctx => {
        ctx.fillStyle = rgb(DATA.mask); ctx.fillRect(0, 0, ctx.canvas.width, ctx.canvas.height);
        ctx.save(); ctx.scale(k, k);
        this.ops.forEach(op => op(ctx, 'data'));
        ctx.restore();
      }, { srgb: false });
      return { color, data };
    }
  }

  // PCB material: solder mask colour map + data map (bump, roughness, metalness).
  function pcbMaterial(t, bump) {
    const m = MC.mat.pcb(t.color);
    m.roughness = 1; m.metalness = 1;
    m.roughnessMap = t.data; m.metalnessMap = t.data; m.bumpMap = t.data;
    m.bumpScale = bump === undefined ? 0.06 : bump;
    m.clearcoat = 0.35; m.clearcoatRoughness = 0.38;
    return m;
  }
  // Black parts read as black under a bright studio environment: darker base, softer reflections.
  function blackPlastic() { const m = MC.mat.blackPlastic(); m.color.set('#0A0B0D'); m.roughness = 0.5; m.envMapIntensity = 0.55; return m; }
  function fr4() { const m = MC.mat.fr4Edge(); m.color.set('#A8A07A'); m.roughness = 0.75; return m; }
  function satinSteel() { const m = MC.mat.steel(); m.roughness = 0.36; m.color.set('#C9CDD2'); return m; }
  function epoxy() { const m = MC.mat.epoxy(); m.color.set('#101113'); m.roughness = 0.48; m.envMapIntensity = 0.6; return m; }

  // Atlas for laser markings and printed tops of the small parts (one transparent mesh per board).
  class Atlas {
    constructor(w) { this.w = w; this.x = 0; this.y = 0; this.row = 0; this.items = []; }
    add(wMm, hMm, ppm, draw) {
      const pw = Math.ceil(wMm * ppm), ph = Math.ceil(hMm * ppm);
      if (this.x + pw + 4 > this.w) { this.x = 0; this.y += this.row + 4; this.row = 0; }
      const r = { x: this.x + 2, y: this.y + 2, w: pw, h: ph, wMm, hMm, draw };
      this.x += pw + 4; this.row = Math.max(this.row, ph);
      this.items.push(r);
      return r;
    }
    texture() {
      const h = Math.max(16, Math.ceil(this.y + this.row + 4));
      this.h = h;
      const t = MC.tex.canvas(this.w, h, ctx => {
        for (const r of this.items) {
          ctx.save(); ctx.translate(r.x, r.y);
          ctx.beginPath(); ctx.rect(0, 0, r.w, r.h); ctx.clip();
          ctx.scale(r.w / r.wMm, r.h / r.hMm);    // draw in millimetres
          r.draw(ctx, r.wMm, r.hMm);
          ctx.restore();
        }
      });
      return t;
    }
    // quad facing +Y, size of the item, uv into the atlas (call after all add())
    quad(r) {
      const g = new T.PlaneGeometry(r.wMm, r.hMm);
      g.rotateX(-PI / 2);
      const uv = g.attributes.uv;
      for (let i = 0; i < uv.count; i++) {
        const u = uv.getX(i), v = uv.getY(i);
        uv.setXY(i, (r.x + u * r.w) / this.w, 1 - (r.y + (1 - v) * r.h) / this.h);
      }
      return g;
    }
  }
  function markText(ctx, lines, wMm, hMm, o) {
    o = o || {};
    ctx.fillStyle = o.color || 'rgba(176,181,188,0.62)';
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    const n = lines.length, lh = hMm / (n + 0.4);
    lines.forEach((s, i) => {
      const size = (o.size || lh * 0.72) * (Array.isArray(o.scale) ? o.scale[i] || 1 : 1);
      ctx.font = (o.weight || 600) + ' ' + size + 'px ' + (o.font || 'Arial, Helvetica, sans-serif');
      const w = ctx.measureText(s).width, max = wMm * 0.92;
      ctx.save();
      ctx.translate(wMm / 2, (i + 0.7) * lh);
      if (w > max) ctx.scale(max / w, 1);
      ctx.fillText(s, 0, 0);
      ctx.restore();
    });
  }
  function markMaterial(atlasTex) {
    const m = MC.mat.epoxy();
    m.map = atlasTex; m.color.set('#FFFFFF'); m.envMapIntensity = 0.5;
    m.roughness = 0.6; m.transparent = true; m.depthWrite = false;
    m.polygonOffset = true; m.polygonOffsetFactor = -2; m.polygonOffsetUnits = -2;
    return m;
  }

  // ================================================================== PCB slab
  // outline: [[X, Z], ...] local; holes: [{x, z, r}]; returns a mesh with groups top/bottom/edge/plated.
  function pcbMesh(kit, outline, holes, th, W, H, mats) {
    const s = new T.Shape();
    outline.forEach((p, i) => (i ? s.lineTo(p[0], -p[1]) : s.moveTo(p[0], -p[1])));
    s.closePath();
    for (const h of holes) {
      const path = new T.Path();
      path.absarc(h.x, -h.z, h.r, 0, PI * 2, true);
      s.holes.push(path);
    }
    const g = new T.ExtrudeGeometry(s, { depth: th, bevelEnabled: false, curveSegments: 28 });
    g.rotateX(-PI / 2);
    const P = g.attributes.position;
    const buckets = [[], [], [], []];
    const a = new T.Vector3(), b = new T.Vector3(), c = new T.Vector3(), n = new T.Vector3();
    for (let i = 0; i < P.count; i += 3) {
      a.fromBufferAttribute(P, i); b.fromBufferAttribute(P, i + 1); c.fromBufferAttribute(P, i + 2);
      n.subVectors(b, a).cross(_b.subVectors(c, a)).normalize();
      let k;
      if (n.y > 0.5) k = 0; else if (n.y < -0.5) k = 1;
      else {
        const cx = (a.x + b.x + c.x) / 3, cz = (a.z + b.z + c.z) / 3;
        k = holes.some(h => Math.hypot(cx - h.x, cz - h.z) < h.r + 0.05) ? 3 : 2;
      }
      buckets[k].push(i);
    }
    const count = P.count;
    const pos = new Float32Array(count * 3), nor = new Float32Array(count * 3), uv = new Float32Array(count * 2);
    const out = new T.BufferGeometry();
    let o = 0;
    buckets.forEach((list, k) => {
      const start = o;
      for (const i of list) {
        a.fromBufferAttribute(P, i); b.fromBufferAttribute(P, i + 1); c.fromBufferAttribute(P, i + 2);
        n.subVectors(b, a).cross(_b.subVectors(c, a)).normalize();
        [a, b, c].forEach(v => {
          v.toArray(pos, o * 3); n.toArray(nor, o * 3);
          const u = (v.x + W / 2) / W, w = 1 - (v.z + H / 2) / H;
          uv[o * 2] = k === 1 ? 1 - u : k >= 2 ? (v.x + v.z) * 0.1 : u;
          uv[o * 2 + 1] = k >= 2 ? v.y * 0.1 : w;
          o++;
        });
      }
      if (o > start) out.addGroup(start, o - start, k);
    });
    out.setAttribute('position', new T.BufferAttribute(pos, 3));
    out.setAttribute('normal', new T.BufferAttribute(nor, 3));
    out.setAttribute('uv', new T.BufferAttribute(uv, 2));
    out.computeBoundingBox(); out.computeBoundingSphere();
    g.dispose();
    return kit.addMesh(out, mats, 'pcb');
  }

  // ================================================================== common component builders
  // Every builder adds geometry to the kit at matrix `base` (component origin on the PCB surface).
  // SMD passive: type '0603' | '0805' | '1206', kind 'cap' | 'res' | 'ind'
  const SMD = {
    '0402': [1.0, 0.5, 0.35], '0603': [1.6, 0.8, 0.45], '0805': [2.0, 1.25, 0.55], '1206': [3.2, 1.6, 0.6], '1210': [3.2, 2.5, 1.2]
  };
  function passive(ctx, size, kind, base, mark, rot) {
    const d = SMD[size], L = d[0], W = d[1], H = kind === 'cap' ? d[2] * 1.5 : d[2];
    const tl = L * 0.2;
    const bodyKey = kind === 'cap' ? 'ceramic' : kind === 'ind' ? 'ind' : 'epoxy';
    ctx.kit.add(bodyKey, kind === 'cap' ? rbox(L - 0.04, H - 0.02, W - 0.02, 0.06, 1) : box(L - 2 * tl + 0.02, H, W), base);
    for (const s of [-1, 1]) ctx.kit.add('tin', box(tl, H + 0.02, W + 0.02), mul(base, TR(s * (L / 2 - tl / 2), 0, 0)));
    if (mark && kind !== 'cap') ctx.mark(L - 2 * tl - 0.1, W * 0.8, mul(base, TR(0, H + 0.003, 0)), (c, w, h) => markText(c, [mark], w, h, { color: '#E9E9E4', size: h * 0.62, weight: 700 }), 60);
    return { L, W, H };
  }

  // Pads under an SMD passive in the board painter.
  function passivePads(painter, size, x, y, rot) {
    const d = SMD[size], L = d[0], W = d[1];
    const r = rot || 0, c = Math.cos(r * D2R), s = Math.sin(r * D2R);
    for (const sd of [-1, 1]) {
      const ox = sd * (L / 2 - L * 0.12);
      painter.pad(x + ox * c, y + ox * s, L * 0.42, W * 1.08, { rot: r, r: 0.05 });
    }
  }

  // Chip epoxy body with marking.
  function icBody(ctx, L, H, W, base, lines, o) {
    o = o || {};
    ctx.kit.add('epoxy', rbox(L, H, W, o.r || Math.min(0.2, H * 0.3), 2), base);
    if (lines) ctx.mark(L * 0.9, W * 0.82, mul(base, TR(0, H + 0.003, 0, o.markRot || 0)), (c, w, h) => {
      markText(c, lines, w, h, { scale: o.scale, weight: 600 });
      if (o.dot) {   // pin 1 dimple
        c.fillStyle = 'rgba(0,0,0,0.55)';
        c.beginPath(); c.arc(o.dot[0] * w, o.dot[1] * h, Math.min(w, h) * 0.07, 0, PI * 2); c.fill();
        c.strokeStyle = 'rgba(160,165,172,0.35)'; c.lineWidth = Math.min(w, h) * 0.012; c.stroke();
      }
    }, o.ppm || 40);
  }

  // Gull wing legs along both long sides (SOIC/SOT); n per side, pitch p, body W across.
  function gullRow(ctx, n, pitch, W, base, len, legW, legH, sides) {
    for (const sd of sides || [-1, 1]) {
      for (let i = 0; i < n; i++) {
        const x = (i - (n - 1) / 2) * pitch;
        ctx.kit.add('tin', gullGeo(len, legW, legH), mul(base, TR(x, 0, sd * W / 2, sd > 0 ? -90 : 90)));
      }
    }
  }

  // Straight male header (rows x n), pins along local X, base on the surface, pins up.
  function maleHeader(ctx, n, rows, base, o) {
    o = o || {};
    const P = 2.54, baseH = o.baseH || 2.5, up = o.up || 6.0, below = o.below || 3.0;
    ctx.kit.add('plastic', rbox(n * P - 0.06, baseH, rows * P - 0.06, 0.22, 1), base);
    const len = below + baseH + up;
    for (let r = 0; r < rows; r++) for (let i = 0; i < n; i++) {
      const x = (i - (n - 1) / 2) * P, z = (r - (rows - 1) / 2) * P;
      ctx.kit.add(o.pinKey || 'gold', pinGeo(len, true, true), mul(base, TR(x, -below, z)));
    }
    return { len, top: baseH + up };
  }

  function femaleHeader(ctx, n, base, height) {
    const g = femaleHeaderGeo(n, height);
    ctx.kit.add('plastic', g.body, base);
    ctx.kit.add('dark', g.dark, base);
    ctx.kit.add('gold', g.cont, base);
  }

  function crystalCan(ctx, base, label) {
    const len = 11.05, w = 4.65, h = 3.5;
    ctx.kit.add('steel', extrudeY(stadiumShape(len, w), h - 0.3, 0.35, 16), mul(base, TR(0, 0.3, 0)));
    ctx.kit.add('plastic', extrudeY(stadiumShape(len - 0.6, w - 0.6), 0.3, 0, 12), base);
    ctx.mark(7.6, 2.6, mul(base, TR(0, h + 0.003, 0)), (c, ww, hh) => markText(c, label, ww, hh, { color: 'rgba(40,43,48,0.82)', weight: 700 }), 40);
  }

  // Board frame helper: painter maps and local placement. coords 'up' = y up from the bottom edge
  // (Uno drawing), 'down' = y down from the top edge (canvas, OLED and RC522).
  function frame(W, H, th, coords) {
    const up = coords === 'up';
    const toLocalZ = y => up ? H / 2 - y : y - H / 2;
    return {
      W, H, th,
      X: x => x - W / 2,
      Z: toLocalZ,
      top: (x, y) => [x, up ? H - y : y],
      bottom: (x, y) => [W - x, up ? H - y : y],
      // component base on the top surface; rot in degrees, counter-clockwise seen from above
      onTop: (x, y, rot, lift) => TR(x - W / 2, th + (lift || 0), toLocalZ(y), rot || 0),
      // component base on the bottom surface (hanging down, its +Y pointing to -Y)
      onBottom: (x, y, rot, lift) => mul(TR(x - W / 2, -(lift || 0), toLocalZ(y), rot || 0), new T.Matrix4().makeRotationZ(PI)),
      local: (x, y, h) => V3(x - W / 2, h, toLocalZ(y))
    };
  }

  function makeCtx(part) {
    const ctx = { kit: new Kit(part), atlas: new Atlas(1024), marks: [] };
    ctx.mark = (wMm, hMm, m, draw, ppm) => { ctx.marks.push([ctx.atlas.add(wMm, hMm, ppm || 40, draw), m]); };
    ctx.finishMarks = () => {
      if (!ctx.marks.length) return null;
      const t = ctx.atlas.texture();
      for (const [r, m] of ctx.marks) ctx.kit.add('mark', ctx.atlas.quad(r), m);
      const mesh = ctx.kit.mesh('mark', markMaterial(t), { cast: false, renderOrder: 1 });
      return mesh;
    };
    return ctx;
  }

  function resScale(opts) { return opts && opts.quality === 'low' ? 0.55 : 1; }

  // ================================================================== Arduino Uno R3
  const UNO = {
    W: 2.7 * IN, H: 2.1 * IN, TH: 1.6,                         // 68.58 x 53.34 x 1.6
    OUTLINE_IN: [[0, 0], [2.6, 0], [2.6, 0.1], [2.7, 0.2], [2.7, 1.49], [2.6, 1.59], [2.6, 2.04], [2.54, 2.1], [0, 2.1]],
    HOLES_IN: [[0.55, 0.1], [0.6, 2.0], [2.6, 0.3], [2.6, 1.4]], HOLE_D: 3.2,
    HEADER_H: 8.5,
    // [first pin x in inch, y in inch, names, top silkscreen labels]
    HEADERS: [
      { x0: 0.84, y: 2.0, names: ['SCL', 'SDA', 'AREF', 'GND3', 'D13', 'D12', 'D11', 'D10', 'D9', 'D8'],
        labels: ['SCL', 'SDA', 'AREF', 'GND', '13', '12', '~11', '~10', '~9', '8'] },
      { x0: 1.9, y: 2.0, names: ['D7', 'D6', 'D5', 'D4', 'D3', 'D2', 'D1', 'D0'],
        labels: ['7', '~6', '~5', '4', '~3', '2', ['TX', { tri: 'r' }, '1'], ['RX', { tri: 'l' }, '0']] },
      { x0: 0.9, y: 0.1, names: ['NC', 'IOREF', 'RESET', '3V3', '5V', 'GND1', 'GND2', 'VIN'],
        labels: ['', 'IOREF', 'RESET', '3.3V', '5V', 'GND', 'GND', 'Vin'] },
      { x0: 2.0, y: 0.1, names: ['A0', 'A1', 'A2', 'A3', 'A4', 'A5'], labels: ['A0', 'A1', 'A2', 'A3', 'A4', 'A5'] }
    ],
    USB: { y: 38.1, w: 12.0, l: 16.0, h: 10.9, over: 6.3 },    // centre 1.5 in from the bottom edge
    JACK: { y: 7.62, w: 9.0, l: 13.7, h: 11.0, over: 1.8, holeY: 6.5, holeD: 6.3, pinD: 2.0 },
    DIP: { x: 1.75 * IN, y: 0.6 * IN, rows: 0.3 * IN },         // ATmega328P-PU, pin 1 notch toward +x
    ICSP1: { x: 2.55 * IN, y: 1.05 * IN },                    // 2 x 3, 3 along y (328P)
    ICSP2: { x: 1.0 * IN, y: 1.8 * IN },                      // 3 x 2, 3 along x (16U2)
    MASK: '#00747E'
  };

  MC.parts.uno = function (opts) {
    const t0 = performance.now();
    const U = UNO, W = U.W, H = U.H, TH = U.TH;
    const f = frame(W, H, TH, 'up');
    const ctx = makeCtx('uno');
    const kit = ctx.kit;
    const top = new Painter(W, H, f.top, U.MASK);
    const bot = new Painter(W, H, f.bottom, U.MASK);
    const pins = {};
    const k = resScale(opts);

    // ---------- outline, holes
    const outline = U.OUTLINE_IN.map(p => [f.X(p[0] * IN), f.Z(p[1] * IN)]);
    const holes = U.HOLES_IN.map(p => ({ x: f.X(p[0] * IN), z: f.Z(p[1] * IN), r: U.HOLE_D / 2, bx: p[0] * IN, by: p[1] * IN }));
    for (const h of holes) { top.ring(h.bx, h.by, 2.75, 1.7); bot.ring(h.bx, h.by, 2.75, 1.7); }

    // ---------- traces under the mask (top layer), drawn first so pads and silk sit on top
    const route = (x1, y1, x2, y2, yTurn, w) => {
      const dx = x2 - x1, dy = Math.abs(dx) * Math.sign(y2 - y1);
      const pts = [[x1, y1], [x1, yTurn], [x2, yTurn + dy], [x2, y2]];
      top.trace(pts, w || 0.3);
    };
    const DIPX = i => U.DIP.x + (i - 6.5) * 2.54;   // column 0..13 from left to right
    const rowTop = U.DIP.y + U.DIP.rows / 2, rowBot = U.DIP.y - U.DIP.rows / 2;
    // pins 1..14 along the top row from right to left, 15..28 along the bottom row from left to right
    const dipPin = n => n <= 14 ? [DIPX(14 - n), rowTop] : [DIPX(n - 15), rowBot];
    const hdr = (h, i) => [(U.HEADERS[h].x0 + i * 0.1) * IN, U.HEADERS[h].y * IN];
    // D0..D7 -> PD0..PD7 (pins 2..6, 11..13), D8 -> PB0 (pin 14)
    const dPins = [2, 3, 4, 5, 6, 11, 12, 13];
    for (let d = 0; d < 8; d++) {
      const [hx, hy] = hdr(1, 7 - d), [px, py] = dipPin(dPins[d]);
      route(hx, hy - 1.6, px, py + 1.3, 44.2 - d * 0.55 - (d >= 5 ? 1.0 : 0), 0.3);
    }
    { const [hx, hy] = hdr(0, 9), [px, py] = dipPin(14); route(hx, hy - 1.6, px, py + 1.3, 38.5, 0.3); }
    for (let a = 0; a < 6; a++) {             // A0..A5 -> PC0..PC5 (pins 23..28)
      const [hx, hy] = hdr(3, a), [px, py] = dipPin(23 + a);
      route(hx, hy + 1.6, px, py - 1.3, 5.2 + a * 0.18, 0.3);
    }
    // RESET (pin 1) to the ICSP header, power traces, USB data pair, crystal
    top.trace([[U.ICSP1.x - 1.27, U.ICSP1.y - 2.54], [U.ICSP1.x - 1.27, 22.4], [dipPin(1)[0], 21.4], [dipPin(1)[0], rowTop + 1.3]], 0.3);
    top.trace([[9.7, 37.3], [15.2, 37.3], [16.6, 36.9], [18.0, 36.9]], 0.3);
    top.trace([[9.7, 38.9], [15.2, 38.9], [16.6, 38.3], [18.0, 38.3]], 0.3);
    top.trace([[18.56, 29.6], [18.56, 32.6], [19.2, 35.0]], 0.3);
    top.trace([[23.44, 29.6], [23.44, 32.6], [22.0, 35.0]], 0.3);
    top.trace([[3.0, 12.6], [3.0, 15.0], [5.2, 15.6]], 0.9);
    top.trace([[5.2, 20.2], [5.2, 23.0]], 0.9);
    top.trace([[5.2, 27.8], [5.2, 31.4]], 0.9);
    top.trace([[24.5, 40.5], [29.0, 40.5], [31.0, 41.8]], 0.25);
    top.trace([[24.5, 39.4], [28.5, 39.4], [30.0, 39.0]], 0.25);
    top.trace([[U.ICSP2.x - 2.54, U.ICSP2.y - 1.27], [U.ICSP2.x - 2.54, 41.8], [21.8, 40.3]], 0.25);
    top.trace([[37.4, 23.2], [38.1, rowTop + 1.3]], 0.3);
    top.trace([[41.4, 23.2], [40.64, rowTop + 1.3]], 0.3);
    top.trace([[56.4, 31.0], [52.0, 31.0], [48.5, 27.5], [45.72, 27.5], [45.72, rowTop + 1.3]], 0.5);
    [[27.0, 33.5], [36.2, 30.5], [45.72, 31.8], [57.2, 26.0], [11.8, 33.0], [12.4, 41.0], [24.0, 32.6], [35.0, 22.0], [53.6, 23.4],
      [8.6, 30.0], [26.6, 13.0], [43.0, 3.8], [60.0, 33.0], [20.2, 43.5], [48.5, 31.0]].forEach(p => top.via(p[0], p[1]));

    // ---------- female headers + pins + pads + labels
    U.HEADERS.forEach(hd => {
      const n = hd.names.length, cx = (hd.x0 + (n - 1) * 0.05) * IN, cy = hd.y * IN;
      femaleHeader(ctx, n, f.onTop(cx, cy), U.HEADER_H);
      const topSide = hd.y > 1;
      hd.names.forEach((name, i) => {
        const x = (hd.x0 + i * 0.1) * IN;
        pins[name] = { p: f.local(x, cy, TH + U.HEADER_H), d: V3(0, 1, 0) };
        bot.circ(x, cy, 0.9, 'tin');
        kit.add('tin', solderGeo(), f.onBottom(x, cy));
        const lab = hd.labels[i];
        if (lab) {
          if (topSide) top.text(lab, name === 'D0' ? x - 0.75 : x, 48.4, { size: 1.0, rot: 90, align: 'right' });
          else top.text(lab, x, 4.75, { size: 1.0, rot: 90, align: 'left' });
          const bl = Array.isArray(lab) ? lab.filter(s => typeof s === 'string').join('') : lab;
          bot.text(bl, x, topSide ? 47.0 : 6.3, { size: 0.9, rot: 90, align: 'center' });
        }
      });
    });
    top.text('DIGITAL (PWM~)', 51.0, 42.4, { size: 1.15 });
    top.text('POWER', 31.75, 9.05, { size: 1.0 });
    top.text('ANALOG IN', 57.15, 9.05, { size: 1.0 });

    // ---------- ICSP headers
    maleHeader(ctx, 3, 2, f.onTop(U.ICSP1.x, U.ICSP1.y, 90));
    maleHeader(ctx, 3, 2, f.onTop(U.ICSP2.x, U.ICSP2.y, 0));
    for (let i = 0; i < 3; i++) for (let r = 0; r < 2; r++) {
      const p1 = [U.ICSP1.x + (r - 0.5) * 2.54, U.ICSP1.y + (i - 1) * 2.54];
      const p2 = [U.ICSP2.x + (i - 1) * 2.54, U.ICSP2.y + (r - 0.5) * 2.54];
      for (const p of [p1, p2]) { bot.circ(p[0], p[1], 0.85, 'tin'); kit.add('tin', solderGeo(), f.onBottom(p[0], p[1])); }
    }
    top.text('ICSP', U.ICSP1.x - 3.6, U.ICSP1.y, { size: 0.95, rot: 90 });
    top.circle(U.ICSP1.x - 1.27, U.ICSP1.y + 4.3, 0.28, { fill: true });
    top.text('ICSP', U.ICSP2.x, U.ICSP2.y - 3.55, { size: 0.9 });
    top.circle(U.ICSP2.x - 4.25, U.ICSP2.y + 1.27, 0.28, { fill: true });
    bot.text('ICSP', U.ICSP1.x - 4.4, U.ICSP1.y, { size: 0.9, rot: 90 });

    // ---------- ATmega328P-PU in a DIP-28 socket (300 mil)
    {
      const cx = U.DIP.x, cy = U.DIP.y, rows = U.DIP.rows;
      const base = f.onTop(cx, cy);
      const SL = 14 * 2.54 + 1.0, SW = rows + 2.6, SH = 3.0;
      // socket: two rails and two end bars, open middle
      const railW = 2.5;
      for (const s of [-1, 1]) kit.add('plastic', rbox(SL, SH, railW, 0.25, 1), mul(base, TR(0, 0, s * rows / 2)));
      for (const s of [-1, 1]) kit.add('plastic', rbox(1.6, SH - 0.6, SW - 2 * railW + 0.4, 0.2, 1), mul(base, TR(s * (SL / 2 - 0.8), 0, 0)));
      // socket contacts (dark slots) and the legs of the socket at the board
      for (let i = 0; i < 14; i++) for (const s of [-1, 1]) {
        const x = (i - 6.5) * 2.54;
        kit.add('dark', box(1.1, 0.02, 0.9), mul(base, TR(x, SH, s * rows / 2)));
        kit.add('tin', box(0.5, 0.5, 0.25), mul(base, TR(x, 0, s * (rows / 2 + railW / 2 + 0.1))));
      }
      // chip body with the pin 1 notch at +x
      const BL = 34.7, BW = 6.35, BH = 3.3, by0 = SH + 0.45;
      // one DIP lead seen from the side of the chip: wide shoulder, taper, narrow tip into the socket
      const leadGeo = cached('dipLead', () => {
        const top = by0 + 1.2, sh = new T.Shape();
        sh.moveTo(-0.73, top); sh.lineTo(0.73, top); sh.lineTo(0.73, SH + 0.32); sh.lineTo(0.25, SH + 0.02);
        sh.lineTo(0.25, SH - 0.7); sh.lineTo(-0.25, SH - 0.7); sh.lineTo(-0.25, SH + 0.02); sh.lineTo(-0.73, SH + 0.32);
        sh.closePath();
        return new T.ExtrudeGeometry(sh, { depth: 0.25, bevelEnabled: false }).translate(0, 0, -0.125);
      });
      const sh = new T.Shape();
      const nr = 0.85;
      sh.moveTo(-BL / 2, -BW / 2); sh.lineTo(BL / 2, -BW / 2); sh.lineTo(BL / 2, -nr);
      sh.absarc(BL / 2, 0, nr, -PI / 2, PI / 2, true);
      sh.lineTo(BL / 2, BW / 2); sh.lineTo(-BL / 2, BW / 2); sh.closePath();
      kit.add('epoxy', extrudeY(sh, BH, 0.32, 14), mul(base, TR(0, by0, 0)));
      // legs: shoulder out of the body, down into the socket
      for (let i = 0; i < 14; i++) for (const s of [-1, 1]) {
        const x = (i - 6.5) * 2.54;
        kit.add('tin', box(1.45, 0.25, 0.8), mul(base, TR(x, by0 + 0.95, s * (BW / 2 + 0.32))));
        kit.add('tin', leadGeo, mul(base, TR(x, 0, s * (rows / 2 + 0.12))));
        bot.circ(cx + x, cy + s * rows / 2, 0.85, 'tin');
        kit.add('tin', solderGeo(), f.onBottom(cx + x, cy + s * rows / 2));
      }
      ctx.mark(BL - 3.2, BW - 0.5, mul(base, TR(0, by0 + BH + 0.004, 0, 180)), (c, w, h) => {
        markText(c, ['ATMEL', 'ATMEGA328P-PU', '1952    AU8K3W'], w, h, { scale: [0.8, 1.0, 0.7], weight: 600 });
        c.fillStyle = 'rgba(0,0,0,0.5)';
        c.beginPath(); c.arc(1.1, h - 1.2, 0.75, 0, PI * 2); c.fill();          // pin 1 dimple
        c.fillStyle = 'rgba(255,255,255,0.05)';
        c.beginPath(); c.arc(w - 1.6, h / 2, 1.0, 0, PI * 2); c.fill();          // ejector mark
      }, 30);
      top.rect(cx, cy, SL + 0.8, SW + 0.6, { lw: 0.16 });
    }

    // ---------- USB-B receptacle (opening toward -X)
    {
      const u = U.USB, x0 = -u.over, base = f.onTop(x0, u.y);   // front face at x0
      const pw = 8.45 / 2, py0 = (u.h - 7.78) / 2, py1 = py0 + 7.78, chm = 1.35;
      const profile = [[-pw, py0], [pw, py0], [pw, py1 - chm], [pw - chm, py1], [-pw + chm, py1], [-pw, py1 - chm]];
      // front plate: shape in (sx = Z, sy = Y), extruded along +X
      const fs = rectShape(u.w, u.h, 0.4);
      fs.holes.push(new T.Path(profile.map(p => new T.Vector2(p[0], p[1] - u.h / 2))));
      const front = new T.ExtrudeGeometry(fs, { depth: 0.4, bevelEnabled: false, curveSegments: 4 });
      const orient = new T.Matrix4().makeBasis(V3(0, 0, -1), V3(0, 1, 0), V3(1, 0, 0));
      kit.add('steel', front, mul(base, TR(0, u.h / 2, 0), orient));
      // shell walls
      const t = 0.3;
      kit.add('steel', box(u.l - 0.4, t, u.w), mul(base, TR(0.4 + (u.l - 0.4) / 2, u.h - t, 0)));
      kit.add('steel', box(u.l - 0.4, t, u.w), mul(base, TR(0.4 + (u.l - 0.4) / 2, 0.05, 0)));
      for (const s of [-1, 1]) kit.add('steel', box(u.l - 0.4, u.h - 0.1, t), mul(base, TR(0.4 + (u.l - 0.4) / 2, 0.05, s * (u.w / 2 - t / 2))));
      kit.add('steel', box(t, u.h, u.w), mul(base, TR(u.l - t / 2, 0, 0)));
      // spring tabs on the top and the sides
      for (const s of [-1, 1]) kit.add('steel', box(2.4, 0.12, 1.1), mul(base, TR(3.2, u.h - 0.04, s * 3.0), TR(0, 0, 0, 0, 0, 3)));
      for (const s of [-1, 1]) kit.add('steel', box(2.4, 1.2, 0.1), mul(base, TR(3.4, 4.6, s * (u.w / 2 + 0.03))));
      // inner B-shaped tunnel
      const tun = new Poly(), depth = 9.0;
      for (let i = 0; i < profile.length; i++) {
        const a = profile[i], b = profile[(i + 1) % profile.length];
        const mz = (a[0] + b[0]) / 2, my = (a[1] + b[1]) / 2;
        tun.quad(V3(0.4, a[1], -a[0]), V3(0.4, b[1], -b[0]), V3(depth, b[1], -b[0]), V3(depth, a[1], -a[0]), V3(0, u.h / 2 - my, mz));
      }
      kit.add('steelDark', tun.geo(), base);
      // insert back face and tongue with contacts
      const back = new T.ShapeGeometry(new T.Shape(profile.map(p => new T.Vector2(p[0], p[1]))));
      kit.add('white', back, mul(base, TR(depth, 0, 0), new T.Matrix4().makeBasis(V3(0, 0, -1), V3(0, 1, 0), V3(-1, 0, 0))));
      const tw = 5.6, tht = 2.5, tyy = u.h / 2 - tht / 2 - 0.1;
      kit.add('white', rbox(depth - 1.9, tht, tw, 0.2, 1), mul(base, TR(1.9 + (depth - 1.9) / 2, tyy, 0)));
      for (const sy of [0, 1]) for (const s of [-1, 1]) {
        kit.add('gold', box(depth - 3.4, 0.06, 0.95), mul(base, TR(2.9 + (depth - 3.4) / 2, sy ? tyy + tht : tyy - 0.06, s * 1.25)));
      }
      // through-hole pins of the connector on the bottom
      for (const p of [[x0 + 13.7, u.y - 1.25], [x0 + 13.7, u.y + 1.25], [x0 + 11.7, u.y - 1.25], [x0 + 11.7, u.y + 1.25]]) {
        bot.circ(p[0], p[1], 0.75, 'tin'); kit.add('tin', smallSolderGeo(), f.onBottom(p[0], p[1]));
      }
      for (const s of [-1, 1]) { const p = [x0 + 9.0, u.y + s * 6.0]; bot.circ(p[0], p[1], 1.3, 'tin'); kit.add('tin', solderGeo(), f.onBottom(p[0], p[1])); }
      top.pad(x0 + 9.0, u.y - 6.6, 2.4, 1.2, { r: 0.3 });
      top.pad(x0 + 9.0, u.y + 6.6, 2.4, 1.2, { r: 0.3 });
    }

    // ---------- DC barrel jack (opening toward -X)
    {
      const j = U.JACK, x0 = -j.over, base = f.onTop(x0, j.y);
      const fl = 3.2;   // front block length
      kit.add('plastic', rbox(j.l - fl + 0.2, j.h, j.w, 0.45, 2), mul(base, TR(fl - 0.2 + (j.l - fl + 0.2) / 2, 0, 0)));
      const fs = rectShape(j.w, j.h, 0.6);
      const hole = new T.Path(); hole.absarc(0, j.holeY - j.h / 2, j.holeD / 2, 0, PI * 2, true);
      fs.holes.push(hole);
      const front = new T.ExtrudeGeometry(fs, { depth: fl, bevelEnabled: true, bevelThickness: 0.25, bevelSize: 0.25, bevelOffset: -0.25, bevelSegments: 2, curveSegments: 28 });
      const orient = new T.Matrix4().makeBasis(V3(0, 0, -1), V3(0, 1, 0), V3(1, 0, 0));
      kit.add('plastic', front, mul(base, TR(0.25, j.h / 2, 0), orient));
      // cavity, centre pin, ribs
      const cav = cached('jackCav', () => new T.CylinderGeometry(j.holeD / 2 - 0.02, j.holeD / 2 - 0.02, 9.5, 28, 1, true).rotateZ(PI / 2).translate(9.5 / 2 + 0.3, 0, 0));
      kit.add('darkIn', cav, mul(base, TR(0, j.holeY, 0)));
      kit.add('dark', cyl(j.holeD / 2, j.holeD / 2, 0.05, 28), mul(base, TR(9.6, j.holeY, 0, 0, 0, 90)));
      kit.add('tin', cyl(j.pinD / 2, j.pinD / 2 * 0.85, 8.2, 18), mul(base, TR(9.7, j.holeY, 0, 0, 0, 90)));
      // solder lugs
      for (const p of [[x0 + 12.9, j.y], [x0 + 7.1, j.y], [x0 + 9.8, j.y + 4.6]]) {
        bot.pad(p[0], p[1], 3.2, 1.6, { r: 0.6, rot: p[1] > j.y ? 0 : 90 });
        kit.add('tin', rbox(2.4, 0.9, 0.8, 0.3, 1), f.onBottom(p[0], p[1], p[1] > j.y ? 0 : 90));
      }
    }

    // ---------- reset button (6 x 6 tact switch, top left)
    {
      const bx = 5.4, by = 48.4, base = f.onTop(bx, by);
      kit.add('plastic', rbox(6.0, 3.1, 6.0, 0.3, 2), base);
      kit.add('steel', box(5.6, 0.2, 5.6), mul(base, TR(0, 3.1, 0)));
      for (const s of [-1, 1]) kit.add('steel', box(0.15, 1.6, 1.8), mul(base, TR(s * 2.85, 1.6, 0)));
      kit.add('button', cyl(1.75, 1.7, 1.6, 28), mul(base, TR(0, 3.3, 0)));
      kit.add('steel', cyl(2.1, 2.1, 0.08, 28), mul(base, TR(0, 3.3, 0)));
      for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
        kit.add('tin', gullGeo(0.9, 0.7, 0.35, 0.15), mul(base, TR(sx * 3.0, 0, sz * 2.25, sx > 0 ? 0 : 180)));
        top.pad(bx + sx * 3.6, by + sz * 2.25, 1.4, 1.0, { r: 0.15 });
      }
      top.text('RESET', 10.4, 49.1, { size: 0.95, rot: 90 });
      top.rect(bx, by, 7.6, 6.8, { lw: 0.14 });
    }

    // ---------- ATmega16U2 (QFN-32) and its 16 MHz crystal
    {
      const qx = 20.6, qy = 37.6, base = f.onTop(qx, qy, 0);
      for (let s = 0; s < 4; s++) for (let i = 0; i < 8; i++) {
        const o = (i - 3.5) * 0.5, a = s * 90 * D2R;
        const px = Math.cos(a) * 2.55 - Math.sin(a) * o, py = Math.sin(a) * 2.55 + Math.cos(a) * o;
        top.pad(qx + px, qy + py, s % 2 ? 0.28 : 0.75, s % 2 ? 0.75 : 0.28, {});
      }
      icBody(ctx, 5.0, 0.9, 5.0, base, ['ATMEL', 'MEGA16U2', 'MU 1951'], { r: 0.08, dot: [0.13, 0.17], scale: [0.85, 1, 0.8], ppm: 70 });
      top.rect(qx, qy, 6.4, 6.4, { lw: 0.12 });
      top.circle(qx - 3.6, qy + 3.6, 0.25, { fill: true });
      crystalCan(ctx, f.onTop(21.0, 29.6), ['16.000', 'T  1D9']);
      for (const s of [-1, 1]) { bot.circ(21.0 + s * 2.44, 29.6, 0.8, 'tin'); kit.add('tin', smallSolderGeo(), f.onBottom(21.0 + s * 2.44, 29.6)); }
      top.text('Y1', 15.6, 32.7, { size: 0.75 });
    }

    // ---------- power section
    {
      // NCP1117ST50 5 V regulator, SOT-223, tab toward +y
      const rx = 18.6, ry = 8.4, base = f.onTop(rx, ry);
      icBody(ctx, 6.5, 1.65, 3.5, base, ['1117', '50 G'], { scale: [1, 0.8], ppm: 40 });
      kit.add('tin', box(3.0, 0.22, 2.0), mul(base, TR(0, 0.6, -2.5)));
      kit.add('tin', box(3.0, 0.22, 0.8), mul(base, TR(0, 0.0, -3.1)));
      for (let i = -1; i <= 1; i++) kit.add('tin', gullGeo(1.6, 0.7, 0.75, 0.2), mul(base, TR(i * 2.3, 0, 1.75, -90)));
      top.pad(rx, ry + 3.3, 3.4, 2.2, { r: 0.1 });
      for (let i = -1; i <= 1; i++) top.pad(rx + i * 2.3, ry - 3.1, 1.0, 1.8, { r: 0.1 });
      top.text('U1', rx + 4.3, ry, { size: 0.75, rot: 90 });
      // two 47 uF aluminium electrolytics on plastic bases
      for (const [ex, ey, lab] of [[15.2, 16.6, 'C6'], [21.9, 16.6, 'C7']]) {
        const eb = f.onTop(ex, ey);
        const bs = new T.Shape();
        const s2 = 3.3, cc = 1.0;
        bs.moveTo(-s2, -s2); bs.lineTo(s2 - cc, -s2); bs.lineTo(s2, -s2 + cc); bs.lineTo(s2, s2 - cc); bs.lineTo(s2 - cc, s2); bs.lineTo(-s2, s2); bs.closePath();
        kit.add('plastic', cached('ecapBase', () => extrudeY(bs, 1.0, 0.1, 4)), eb);
        kit.add('alu', lathe('ecap', [[0, 0], [3.1, 0], [3.15, 0.15], [3.15, 0.65], [3.0, 0.85], [3.0, 1.05], [3.15, 1.25], [3.15, 4.75], [3.05, 4.95], [2.85, 5.05], [0, 5.05]], 36), mul(eb, TR(0, 1.0, 0)));
        ctx.mark(6.0, 6.0, mul(eb, TR(0, 6.06, 0)), (c, w, h) => {
          c.save(); c.translate(w / 2, h / 2);
          c.beginPath(); c.arc(0, 0, 2.8, 0, PI * 2); c.clip();
          c.fillStyle = 'rgba(16,18,22,0.92)'; c.fillRect(-3, -3, 1.55, 6);           // negative stripe
          c.strokeStyle = 'rgba(60,64,70,0.55)'; c.lineWidth = 0.12;
          c.beginPath(); c.moveTo(-0.0, -2.2); c.lineTo(0, 2.2); c.moveTo(-1.2, 0); c.lineTo(2.2, 0); c.stroke(); // vent cross
          c.fillStyle = 'rgba(20,22,26,0.85)'; c.font = '700 0.95px Arial, sans-serif'; c.textAlign = 'center'; c.textBaseline = 'middle';
          c.fillText('47', 1.0, -1.2); c.fillText('25V', 1.0, 1.2);
          c.restore();
        }, 50);
        top.pad(ex - 2.5, ey, 2.0, 2.4, { r: 0.1 }); top.pad(ex + 2.5, ey, 2.0, 2.4, { r: 0.1 });
        top.text(lab, ex, ey - 4.3, { size: 0.75 });
      }
      // M7 diode (SMA), polyfuse (1812), LP2985-33 (SOT-23-5), LM358 (SOIC-8)
      {
        const b = f.onTop(5.2, 17.8, 90);
        icBody(ctx, 4.3, 2.1, 2.6, b, ['M7'], { ppm: 40 });
        kit.add('silkBand', box(0.6, 0.02, 2.3), mul(b, TR(-1.5, 2.1, 0)));
        for (const s of [-1, 1]) kit.add('tin', box(1.0, 0.25, 1.4), mul(b, TR(s * 2.5, 0, 0)));
        top.pad(5.2, 17.8 - 2.6, 1.8, 1.8, { r: 0.1 }); top.pad(5.2, 17.8 + 2.6, 1.8, 1.8, { r: 0.1 });
        top.text('D1', 7.8, 17.8, { size: 0.75, rot: 90 });
      }
      {
        const b = f.onTop(5.2, 26.2, 90);
        kit.add('fuse', rbox(3.6, 1.0, 3.2, 0.12, 1), b);
        for (const s of [-1, 1]) kit.add('tin', rbox(0.6, 1.04, 3.22, 0.1, 1), mul(b, TR(s * 2.0, 0, 0)));
        top.pad(5.2, 26.2 - 2.0, 3.6, 1.3, { r: 0.1 }); top.pad(5.2, 26.2 + 2.0, 3.6, 1.3, { r: 0.1 });
        ctx.mark(2.2, 2.0, mul(b, TR(0, 1.003, 0, 90)), (c, w, h) => markText(c, ['050', 'F'], w, h, { color: 'rgba(30,32,30,0.8)' }), 60);
        top.text('F1', 7.8, 26.2, { size: 0.75, rot: 90 });
      }
      {
        const b = f.onTop(9.4, 22.0, 90);
        icBody(ctx, 2.9, 1.1, 1.6, b, ['LPG'], { ppm: 70 });
        gullRow(ctx, 3, 0.95, 1.6, b, 0.5, 0.4, 0.55, [1]);
        gullRow(ctx, 2, 1.9, 1.6, b, 0.5, 0.4, 0.55, [-1]);
        top.text('U2', 11.6, 22.0, { size: 0.7, rot: 90 });
      }
      {
        const b = f.onTop(22.2, 23.2, 0);
        icBody(ctx, 4.9, 1.5, 3.9, b, ['LM358', 'TI 9C'], { dot: [0.1, 0.78], scale: [1, 0.75], ppm: 50 });
        gullRow(ctx, 4, 1.27, 3.9, b, 1.0, 0.42, 0.75);
        for (let i = 0; i < 4; i++) for (const s of [-1, 1]) top.pad(22.2 + (i - 1.5) * 1.27, 23.2 + s * 2.75, 0.6, 1.4, { r: 0.08 });
        top.text('U5', 25.9, 20.9, { size: 0.7 });
      }
    }

    // ---------- 16 MHz resonator for the 328P, passives
    {
      const b = f.onTop(39.4, 23.2, 0);
      kit.add('resonator', rbox(3.2, 0.95, 1.3, 0.12, 1), b);
      for (const s of [-1, 0, 1]) kit.add('tin', box(0.45, 0.3, 1.32), mul(b, TR(s * 1.2, 0, 0)));
      ctx.mark(2.4, 1.0, mul(b, TR(0, 0.953, 0)), (c, w, h) => markText(c, ['16.00'], w, h, { color: 'rgba(40,40,40,0.8)', weight: 700 }), 80);
      for (const s of [-1, 0, 1]) top.pad(39.4 + s * 1.2, 23.2, 0.6, 1.8, {});
      top.text('Y2', 39.4, 21.6, { size: 0.65 });
    }
    const passives = [
      // x, y, size, kind, rot, marking, designator
      [24.4, 37.6, '0603', 'cap', 90, null, 'C8'], [24.4, 40.0, '0603', 'res', 90, '22', 'R1'], [17.0, 41.4, '0603', 'cap', 0, null, 'C9'],
      [17.0, 34.0, '0603', 'res', 0, '1M', 'R2'], [20.6, 33.4, '0603', 'cap', 0, null, 'C11'], [13.4, 36.6, '0805', 'cap', 90, null, 'C10'],
      [16.8, 24.6, '0603', 'cap', 0, null, 'C12'], [13.5, 29.0, '0603', 'cap', 90, null, 'C13'], [27.2, 29.0, '0603', 'cap', 90, null, 'C14'],
      [42.8, 22.6, '0603', 'cap', 0, null, 'C2'], [35.6, 22.6, '0603', 'cap', 0, null, 'C3'], [27.8, 22.8, '0805', 'cap', 90, null, 'C4'],
      [60.4, 22.4, '0603', 'res', 90, '103', 'R3'], [57.6, 22.4, '0603', 'cap', 90, null, 'C5'], [55.0, 31.0, '0603', 'res', 0, '102', 'R4'],
      [12.7, 45.2, '0603', 'cap', 90, null, 'C15'], [10.8, 19.4, '0805', 'cap', 90, null, 'C16'], [10.8, 25.6, '0805', 'cap', 90, null, 'C17'],
      [13.8, 12.6, '0805', 'cap', 0, null, 'C18'], [24.6, 11.8, '0603', 'cap', 90, null, 'C19'], [28.8, 25.6, '0603', 'res', 90, '103', 'R5'],
      [48.0, 23.6, '0603', 'cap', 0, null, 'C20'], [52.6, 23.6, '0603', 'res', 0, '103', 'R6'], [17.2, 44.2, '0603', 'res', 0, '103', 'R7'],
      [35.3, 28.0, '0603', 'cap', 0, null, 'C21'], [26.4, 34.0, '0603', 'res', 90, '471', 'R8']
    ];
    for (const [x, y, size, kind, rot, mark, des] of passives) {
      passive(ctx, size, kind, f.onTop(x, y, rot), mark, rot);
      passivePads(top, size, x, y, rot);
      const off = rot === 90 ? [1.25, 0] : [0, -1.15];
      top.text(des, x + off[0], y + off[1], { size: 0.55, rot: rot === 90 ? 90 : 0 });
    }
    // resistor networks (4 x 0603 in one 3.2 x 1.6 package)
    for (const [x, y, rot, mark, des] of [[31.0, 36.0, 0, '102', 'RN1'], [13.4, 41.0, 90, '220', 'RN2'], [53.4, 37.0, 0, '103', 'RN3']]) {
      const b = f.onTop(x, y, rot);
      kit.add('epoxy', box(2.6, 0.45, 1.3), b);
      for (let i = 0; i < 4; i++) for (const s of [-1, 1]) {
        const ox = (i - 1.5) * 0.8;
        kit.add('tin', box(0.42, 0.47, 0.3), mul(b, TR(ox, 0, s * 0.72)));
        const c = Math.cos(rot * D2R), sn = Math.sin(rot * D2R), oz = s * 0.8;
        top.pad(x + ox * c + oz * sn, y + ox * sn - oz * c, rot ? 0.8 : 0.45, rot ? 0.45 : 0.8, {});
      }
      ctx.mark(2.2, 0.8, mul(b, TR(0, 0.453, 0)), (c, w, h) => markText(c, [mark], w, h, { color: '#E9E9E4', weight: 700 }), 70);
      top.text(des, x + (rot ? 1.8 : 0), y + (rot ? 0 : -1.5), { size: 0.55, rot });
    }

    // ---------- LEDs (0805): L, TX, RX (yellow) and ON (green); each its own mesh to switch it on
    const ledDefs = { L: [31.0, 45.4, '#FF9A10', 'L'], TX: [31.0, 41.8, '#FF9A10', 'TX'], RX: [31.0, 39.2, '#FF9A10', 'RX'], ON: [58.4, 31.0, '#18E048', 'ON'] };
    const ledMeshes = {};
    for (const name of Object.keys(ledDefs)) {
      const [x, y, hex, lab] = ledDefs[name];
      const b = f.onTop(x, y, 0);
      kit.add('white', box(2.0, 0.32, 1.25), b);
      for (const s of [-1, 1]) kit.add('tin', box(0.45, 0.34, 1.27), mul(b, TR(s * 0.8, 0, 0)));
      const lens = mergeList([[rbox(1.5, 0.42, 1.15, 0.12, 2), TR(x - W / 2, TH + 0.32, f.Z(y))]]);
      const m = MC.mat.epoxy();
      m.color.set(name === 'ON' ? '#5E8A68' : '#B89A52');
      m.roughness = 0.18; m.envMapIntensity = 0.8;
      m.emissive.set(hex); m.emissiveIntensity = 0;
      m.userData.onColor = hex;
      ledMeshes[name] = kit.addMesh(lens, m, 'led-' + name, { cast: false });
      passivePads(top, '0805', x, y, 0);
      top.text(lab, x + 2.2, y, { size: 0.95, align: 'left' });
    }

    // ---------- logo and big labels
    top.custom(37.5, 33.6, 0, (c, st) => {
      c.strokeStyle = c.fillStyle = st('silk');
      c.lineWidth = 0.75;
      for (const s of [-1, 1]) { c.beginPath(); c.ellipse(s * 2.05, 0, 2.05, 1.65, 0, 0, PI * 2); c.stroke(); }
      c.lineWidth = 0.42;
      c.beginPath(); c.moveTo(-2.9, 0); c.lineTo(-1.25, 0); c.moveTo(1.25, 0); c.lineTo(2.85, 0); c.moveTo(2.05, -0.82); c.lineTo(2.05, 0.82); c.stroke();
    });
    top.text('ARDUINO', 48.6, 33.6, { size: 2.5, weight: 800 });
    top.text('UNO', 46.2, 27.0, { size: 5.6, weight: 800 });
    top.line([[54.6, 25.0], [54.6, 29.6]], 0.16);
    top.text('R3', 56.4, 27.0, { size: 1.4, weight: 700 });
    // component outlines
    top.rect(21.0, 29.6, 12.2, 5.6, { lw: 0.14, r: 2.6 });
    top.rect(31.0, 42.6, 2.8, 8.4, { lw: 0.12 });

    // ---------- bottom layer: traces, pads, labels
    {
      const r = (pts, w) => bot.trace(pts, w || 0.3);
      for (let d = 9; d <= 13; d++) {   // D9..D13 down to the bottom row, between the pads of the top row
        const [hx, hy] = hdr(0, 17 - d), [px, py] = dipPin(15 + d - 9);
        const vx = px + 1.27, yt = 33 - (d - 9) * 0.8;
        r([[hx, hy - 1.4], [hx, yt], [vx, yt - Math.abs(vx - hx)], [vx, py + 2.2], [px, py + 0.9]]);
      }
      r([[33.02, 4.0], [33.02, 6.4], [45.72, 6.4], [45.72, 9.8]], 0.6);
      r([[35.56, 4.0], [35.56, 7.4], [43.18, 7.4], [43.18, 9.8]], 0.6);
      r([[9.7, 7.6], [16.0, 7.6], [18.6, 10.2]], 1.0);
      r([[18.6, 6.0], [18.6, 3.6], [33.02, 3.6]], 0.8);
      r([[4.0, 38.1], [4.0, 30.0], [5.2, 28.0]], 0.6);
      r([[60.0, 26.67], [52.0, 18.0], [52.0, 13.6]], 0.3);
      r([[62.5, 24.13], [62.5, 13.0], [60.96, 12.6]], 0.3);
      bot.poly([[1.5, 14.0], [12.0, 14.0], [12.0, 30.0], [1.5, 30.0]], 'pour');
      bot.poly([[36.0, 40.0], [58.0, 40.0], [58.0, 46.5], [36.0, 46.5]], 'pour');
      [[24.0, 32.6], [36.2, 30.5], [45.72, 31.8], [57.2, 26.0], [11.8, 33.0], [12.4, 41.0], [27.0, 33.5], [35.0, 22.0], [53.6, 23.4],
        [8.6, 30.0], [26.6, 13.0], [43.0, 3.8], [60.0, 33.0], [20.2, 43.5], [48.5, 31.0]].forEach(p => bot.via(p[0], p[1]));
      bot.text('UNO', 30.0, 26.0, { size: 6.0, weight: 800 });
      bot.text('R3', 30.0, 20.4, { size: 1.6 });
      bot.text('ARDUINO', 30.0, 33.0, { size: 2.2, weight: 800 });
      bot.text('DIGITAL (PWM~)', 51.0, 43.0, { size: 1.0 });
      bot.text('POWER', 31.75, 9.6, { size: 0.9 });
      bot.text('ANALOG IN', 57.15, 9.6, { size: 0.9 });
    }

    // ---------- PCB with textures
    const tTop = top.textures(26 * k);
    const tBot = bot.textures(12 * k);
    const mats = [pcbMaterial(tTop, 0.55), pcbMaterial(tBot, 0.5), fr4(), MC.mat.tin()];
    pcbMesh(kit, outline, holes, TH, W, H, mats);

    // ---------- materials -> meshes
    const steelDark = MC.mat.steel(); steelDark.color.set('#7E848B'); steelDark.roughness = 0.45; steelDark.side = T.DoubleSide;
    const darkIn = MC.mat.rubber(); darkIn.color.set('#08090A'); darkIn.side = T.DoubleSide;
    const dark = MC.mat.rubber(); dark.color.set('#050506');
    const button = MC.mat.darkPlastic(); button.color.set('#2A2C30'); button.roughness = 0.6;
    const fuse = MC.mat.ceramic('#B49A3C');
    const resonator = MC.mat.ceramic('#C8B48A');
    const silkBand = MC.mat.ceramic('#B8BCC2');
    const ind = epoxy();
    kit.mesh('plastic', blackPlastic());
    kit.mesh('dark', dark, { cast: false });
    kit.mesh('darkIn', darkIn, { cast: false });
    kit.mesh('gold', MC.mat.gold());
    kit.mesh('tin', MC.mat.tin());
    kit.mesh('steel', satinSteel());
    kit.mesh('steelDark', steelDark, { cast: false });
    kit.mesh('epoxy', epoxy());
    kit.mesh('ceramic', MC.mat.ceramic('#B49A74'));
    kit.mesh('ind', ind);
    kit.mesh('white', MC.mat.whitePlastic());
    kit.mesh('alu', MC.mat.brushed());
    kit.mesh('button', button);
    kit.mesh('fuse', fuse);
    kit.mesh('resonator', resonator);
    kit.mesh('silkBand', silkBand);
    ctx.finishMarks();

    const ledOn = { ON: true, L: false, TX: false, RX: false };
    const setLed = (name, on) => {
      const m = ledMeshes[name];
      if (!m) return;
      m.material.emissiveIntensity = on ? 1.0 : 0;
      m.material.toneMapped = !on;           // a lit LED keeps its saturated colour
      m.material.envMapIntensity = on ? 0.25 : 0.8;
      m.material.needsUpdate = true;
      ledOn[name] = !!on;
    };
    setLed('ON', true);

    const u = U.USB, j = U.JACK;
    const extra = {
      usb: f.local(-u.over, u.y, TH + u.h / 2),
      jack: f.local(-j.over, j.y, TH + j.holeY),
      usbSize: [u.w, u.h], jackSize: [j.w, j.h],
      holes: holes.map(h => V3(h.x, 0, h.z)),
      holeDiameter: U.HOLE_D,
      leds: ledMeshes,
      setLed,
      bounds: new T.Box3(V3(-W / 2 - u.over, 0, -H / 2), V3(W / 2, TH + Math.max(u.h, j.h), H / 2)),
      buildMs: 0
    };
    extra.buildMs = performance.now() - t0;
    return { group: kit.group, pins, size: [W, TH + j.h, H], extra };
  };

  // ================================================================== 1.3" OLED module (SH1106)
  const OLED = {
    W: 35.4, H: 33.5, TH: 1.2,
    HOLE_D: 2.0, HOLE_IN: 2.0,
    PIN_Y: 1.6,                         // pin row, from the top edge
    PINS: ['GND', 'VCC', 'SCL', 'SDA'],
    GLASS: { w: 34.5, h: 23.0, t: 1.45, top: 5.0, tape: 0.25, sub: 0.7, ledge: 3.4 },
    AA: { w: 29.42, h: 14.70, top: 2.35 },  // active area, offset from the glass top edge
    VA: { w: 31.42, h: 16.70 },
    PIN_UP: 1.4, PIN_BODY: 2.5, PIN_DOWN: 6.0,
    MASK: '#16418F'
  };

  MC.parts.oledModule = function (opts) {
    const t0 = performance.now();
    const O = OLED, W = O.W, H = O.H, TH = O.TH, G = O.GLASS;
    const f = frame(W, H, TH, 'down');
    const ctx = makeCtx('oled');
    const kit = ctx.kit;
    const top = new Painter(W, H, f.top, O.MASK);
    const bot = new Painter(W, H, f.bottom, O.MASK);
    const pins = {};
    const k = resScale(opts);

    const hi = O.HOLE_IN;
    const holePos = [[hi, hi], [W - hi, hi], [hi, H - hi], [W - hi, H - hi]];
    const holes = holePos.map(p => ({ x: f.X(p[0]), z: f.Z(p[1]), r: O.HOLE_D / 2 }));
    for (const p of holePos) { top.ring(p[0], p[1], 1.85, 1.05); bot.ring(p[0], p[1], 1.85, 1.05); }

    // traces on the front (mostly hidden by the glass) and the back
    for (let i = 0; i < 4; i++) {
      const x = W / 2 + (i - 1.5) * 2.54;
      top.trace([[x, O.PIN_Y], [x, 4.6], [x + (i - 1.5) * 1.6, 6.0], [x + (i - 1.5) * 1.6, 9.0]], 0.35);
    }
    top.trace([[3.6, 6.0], [3.6, 29.0], [11.0, 29.0]], 0.5);
    top.trace([[31.8, 6.0], [31.8, 29.0], [24.4, 29.0]], 0.5);

    // header: plastic on the back, pins pointing away from the glass (-Y), solder on the front
    const py = O.PIN_Y;
    const hx0 = W / 2 - 1.5 * 2.54;
    kit.add('plastic', rbox(4 * 2.54 - 0.06, O.PIN_BODY, 2.48, 0.22, 1), mul(f.onBottom(W / 2, py)));
    O.PINS.forEach((name, i) => {
      const x = hx0 + i * 2.54;
      const len = O.PIN_UP + TH + O.PIN_BODY + O.PIN_DOWN;
      kit.add('gold', pinGeo(len, true, true), TR(f.X(x), TH + O.PIN_UP - len, f.Z(py)));
      kit.add('tin', smallSolderGeo(), f.onTop(x, py));
      top.circ(x, py, 0.95, 'tin');
      bot.circ(x, py, 0.95, 'tin');
      pins[name] = { p: f.local(x, py, -(O.PIN_BODY + O.PIN_DOWN)), d: V3(0, -1, 0) };
      top.text(name, x, 3.75, { size: 0.95 });
      bot.text(name, x, 4.4, { size: 0.85, rot: 90 });
    });
    top.rect(W / 2, py, 4 * 2.54 + 0.4, 2.8, { lw: 0.12 });

    // glass stack: foam tape, substrate with the COG ledge, encapsulation glass on top
    const gx = W / 2, gTop = G.top, gBot = G.top + G.h;
    const encH = G.h - G.ledge;
    const yTape = TH, ySub = TH + G.tape, yEnc = ySub + G.sub, yTop = ySub + G.t;
    kit.add('foam', box(G.w - 2.0, G.tape, G.h - 3.0), f.onTop(gx, gTop + G.h / 2 - 0.5, 0, 0));
    kit.add('glass', rbox(G.w, G.sub, G.h, 0.12, 1), TR(f.X(gx), ySub, f.Z(gTop + G.h / 2)));
    kit.add('glass', rbox(G.w, G.t - G.sub, encH, 0.12, 1), TR(f.X(gx), yEnc, f.Z(gTop + encH / 2)));
    // encapsulation top: printed frame around the active area
    const aaCx = gx, aaCy = gTop + O.AA.top + O.AA.h / 2;
    const encTex = MC.tex.canvas(Math.round(G.w * 24 * k), Math.round(encH * 24 * k), (c, w, h) => {
      const s = w / G.w;
      c.scale(s, s);
      c.fillStyle = '#0A0B0D'; c.fillRect(0, 0, G.w, encH);
      // seal band along the edges
      c.strokeStyle = 'rgba(70,74,80,0.35)'; c.lineWidth = 0.45;
      c.strokeRect(0.55, 0.55, G.w - 1.1, encH - 1.1);
      // viewing area frame and active area
      const ax = (G.w - O.AA.w) / 2, ay = O.AA.top;
      const vx = (G.w - O.VA.w) / 2, vy = ay - (O.VA.h - O.AA.h) / 2;
      c.fillStyle = '#121418'; c.fillRect(vx, vy, O.VA.w, O.VA.h);
      c.fillStyle = '#030304'; c.fillRect(ax - 0.12, ay - 0.12, O.AA.w + 0.24, O.AA.h + 0.24);
      c.strokeStyle = 'rgba(120,126,134,0.25)'; c.lineWidth = 0.06;
      c.strokeRect(vx, vy, O.VA.w, O.VA.h);
    });
    const encMat = MC.mat.blackGlass(); encMat.map = encTex; encMat.color.set('#FFFFFF');
    encMat.polygonOffset = true; encMat.polygonOffsetFactor = -1; encMat.polygonOffsetUnits = -1;
    encMat.envMapIntensity = 0.05; encMat.clearcoat = 0; encMat.roughness = 0.3;   // the cover above reflects
    {
      const g = new T.PlaneGeometry(G.w - 0.24, encH - 0.24); g.rotateX(-PI / 2);
      kit.add('enc', g, TR(f.X(gx), yTop + 0.01, f.Z(gTop + encH / 2)));
    }
    // ledge: substrate traces fanning into the driver IC, the COG chip, and the FPC bond
    const ledgeTex = MC.tex.canvas(Math.round(G.w * 24 * k), Math.round(G.ledge * 24 * k), (c, w, h) => {
      const s = w / G.w; c.scale(s, s);
      c.fillStyle = '#16181B'; c.fillRect(0, 0, G.w, G.ledge);
      c.strokeStyle = 'rgba(150,156,164,0.42)'; c.lineWidth = 0.035;
      for (let i = 0; i <= 120; i++) {
        const x0 = 1.2 + i * (G.w - 2.4) / 120, x1 = G.w / 2 - 8.5 + i * 17 / 120;
        c.beginPath(); c.moveTo(x0, 0); c.lineTo(x0, 0.25); c.lineTo(x1, 1.0); c.stroke();
      }
      for (let i = 0; i <= 40; i++) {
        const x0 = G.w / 2 - 6.5 + i * 13 / 40, x1 = G.w / 2 - 5.6 + i * 11.2 / 40;
        c.beginPath(); c.moveTo(x0, 1.9); c.lineTo(x1, G.ledge); c.stroke();
      }
      c.fillStyle = 'rgba(200,170,90,0.35)'; c.fillRect(G.w / 2 - 6.0, G.ledge - 1.2, 12.0, 1.2);
    });
    const ledgeMat = MC.mat.blackGlass(); ledgeMat.map = ledgeTex; ledgeMat.color.set('#FFFFFF'); ledgeMat.roughness = 0.12;
    ledgeMat.envMapIntensity = 0.35; ledgeMat.clearcoat = 0.5;
    ledgeMat.polygonOffset = true; ledgeMat.polygonOffsetFactor = -1; ledgeMat.polygonOffsetUnits = -1;
    {
      const g = new T.PlaneGeometry(G.w - 0.24, G.ledge - 0.1); g.rotateX(-PI / 2);
      kit.add('ledge', g, TR(f.X(gx), yEnc + 0.01, f.Z(gBot - G.ledge / 2)));
      kit.add('epoxy', rbox(17.0, 0.28, 0.9, 0.06, 1), TR(f.X(gx), yEnc, f.Z(gTop + encH + 1.45)));
    }
    // FPC: from the ledge over the PCB front, around the bottom edge, onto the back
    {
      const fw = 12.6, ft = 0.11, zE = H / 2, rw = TH / 2 + 0.07;
      const zL = f.Z(gBot - 1.1), zEdge = f.Z(gBot);
      const path = [[yEnc + 0.02, zL], [yEnc + 0.04, zEdge - 0.1]];
      for (let i = 1; i <= 8; i++) {          // gentle S from the glass ledge down onto the PCB
        const t = i / 8, e = 0.5 - 0.5 * Math.cos(PI * t);
        path.push([yEnc + 0.04 - (yEnc + 0.04 - (TH + 0.07)) * e, zEdge + 0.15 + t * 1.8]);
      }
      for (let i = 0; i <= 14; i++) {         // around the bottom edge of the board
        const a = PI / 2 - PI * i / 14;
        path.push([TH / 2 + Math.sin(a) * rw, zE - 0.02 + Math.cos(a) * rw]);
      }
      path.push([-0.07, zE - 1.2], [-0.07, zE - 5.4]);
      const poly = new Poly();
      let acc = 0;
      const vs = [];
      for (let i = 0; i < path.length; i++) {
        if (i) acc += Math.hypot(path[i][0] - path[i - 1][0], path[i][1] - path[i - 1][1]);
        vs.push(acc);
      }
      const total = acc;
      for (let i = 0; i < path.length - 1; i++) {
        const [y0, z0] = path[i], [y1, z1] = path[i + 1];
        const dy = y1 - y0, dz = z1 - z0, l = Math.hypot(dy, dz) || 1;
        const ny = dz / l, nz = -dy / l;           // outward normal of the strip (left of travel)
        const off = ft / 2;
        const v0 = vs[i] / total, v1 = vs[i + 1] / total;
        for (const s of [1, -1]) {
          const a = V3(-fw / 2, y0 + s * ny * off, z0 + s * nz * off), b = V3(fw / 2, y0 + s * ny * off, z0 + s * nz * off);
          const c = V3(fw / 2, y1 + s * ny * off, z1 + s * nz * off), d = V3(-fw / 2, y1 + s * ny * off, z1 + s * nz * off);
          poly.quad(a, b, c, d, V3(0, s * ny, s * nz), [[0, v0], [1, v0], [1, v1], [0, v1]]);
        }
        for (const sx of [-1, 1]) {
          poly.quad(V3(sx * fw / 2, y0 + ny * off, z0 + nz * off), V3(sx * fw / 2, y0 - ny * off, z0 - nz * off),
            V3(sx * fw / 2, y1 - ny * off, z1 - nz * off), V3(sx * fw / 2, y1 + ny * off, z1 + nz * off), V3(sx, 0, 0));
        }
      }
      kit.add('fpc', poly.geo(), TR(0, 0, 0));
    }
    const fpcTex = MC.tex.canvas(256, 512, (c, w, h) => {
      c.fillStyle = '#B66F1C'; c.fillRect(0, 0, w, h);
      c.fillStyle = 'rgba(96,44,8,0.6)';
      for (let i = 0; i < 26; i++) c.fillRect(20 + i * (w - 40) / 26, 0, 3.2, h);
      c.fillStyle = 'rgba(255,220,150,0.18)'; c.fillRect(0, 0, 10, h); c.fillRect(w - 10, 0, 10, h);
      c.fillStyle = 'rgba(230,190,90,0.6)'; c.fillRect(14, h - 26, w - 28, 26);
    });
    const fpcMat = MC.mat.membrane(fpcTex); fpcMat.roughness = 0.36; fpcMat.side = T.DoubleSide;
    fpcMat.clearcoat = 0.35; fpcMat.envMapIntensity = 0.7;

    // back side parts: XC6206 3.3 V LDO ("662K"), pull-ups, charge pump caps
    {
      const b = f.onBottom(9.0, 9.5, 0);
      icBody(ctx, 2.9, 1.1, 1.3, b, ['662K'], { ppm: 70 });
      gullRow(ctx, 2, 1.9, 1.3, b, 0.45, 0.4, 0.55, [-1]);
      gullRow(ctx, 1, 1.9, 1.3, b, 0.45, 0.4, 0.55, [1]);
      bot.pad(9.0 - 0.95, 9.5 - 1.25, 0.8, 0.9, {}); bot.pad(9.0 + 0.95, 9.5 - 1.25, 0.8, 0.9, {}); bot.pad(9.0, 9.5 + 1.25, 0.8, 0.9, {});
      bot.text('U2', 9.0, 7.3, { size: 0.75 });
    }
    const back = [
      [13.5, 9.5, '0805', 'cap', 90, null, 'C1'], [5.4, 13.2, '0805', 'cap', 0, null, 'C2'], [24.5, 8.0, '0603', 'res', 0, '472', 'R1'],
      [24.5, 10.6, '0603', 'res', 0, '472', 'R2'], [28.6, 9.3, '0603', 'res', 90, '103', 'R3'],
      [10.4, 22.6, '0603', 'cap', 90, null, 'C3'], [13.0, 22.6, '0603', 'cap', 90, null, 'C4'], [15.6, 22.6, '0603', 'cap', 90, null, 'C5'],
      [18.2, 22.6, '0603', 'cap', 90, null, 'C6'], [20.8, 22.6, '0603', 'cap', 90, null, 'C7'], [23.4, 22.6, '0603', 'res', 90, '913', 'R4'],
      [26.0, 22.6, '0805', 'cap', 90, null, 'C8']
    ];
    for (const [x, y, size, kind, rot, mark, des] of back) {
      passive(ctx, size, kind, f.onBottom(x, y, rot), mark, rot);
      passivePads(bot, size, x, y, rot);
      bot.text(des, x, y + (rot === 90 ? 1.9 : -1.25), { size: 0.6 });
    }
    // bottom silkscreen and traces (mirrored painter takes front-view coordinates)
    bot.trace([[9.0, 9.5], [9.0, 14.0], [17.7, 14.0], [17.7, 26.5]], 0.45);
    bot.trace([[24.5, 9.3], [24.5, 15.6], [20.0, 20.0]], 0.3);
    bot.trace([[13.5, 9.5], [13.5, 4.5]], 0.45);
    bot.pad(W / 2, 30.6, 13.2, 2.8, { fin: 'gold', r: 0.2 });
    bot.text('1.3" OLED  I2C', W / 2, 17.4, { size: 1.15 });
    bot.text('SH1106  128X64', W / 2, 19.2, { size: 0.9 });
    bot.rect(W / 2, 30.6, 14.0, 3.6, { lw: 0.12 });

    // PCB
    const tTop = top.textures(22 * k), tBot = bot.textures(16 * k);
    pcbMesh(kit, [[-W / 2, -H / 2], [W / 2, -H / 2], [W / 2, H / 2], [-W / 2, H / 2]], holes, TH, W, H,
      [pcbMaterial(tTop, 0.5), pcbMaterial(tBot, 0.5), fr4(), MC.mat.tin()]);

    // active area (emissive), glow and cover glass
    const blank = MC.tex.canvas(8, 4, c => { c.fillStyle = '#000'; c.fillRect(0, 0, 8, 4); });
    const sMat = MC.mat.oledPixels();
    sMat.emissiveMap = blank;
    sMat.envMapIntensity = 0;            // the cover glass above carries the reflections
    sMat.polygonOffset = true; sMat.polygonOffsetFactor = -2; sMat.polygonOffsetUnits = -2;
    const sGeo = new T.PlaneGeometry(O.AA.w, O.AA.h); sGeo.rotateX(-PI / 2);
    const aaY = yTop + 0.03;
    const screen = kit.addMesh(sGeo, sMat, 'screen', { cast: false });
    screen.position.set(f.X(aaCx), aaY, f.Z(aaCy));
    const gMat = MC.mat.oledGlow(); gMat.map = blank;
    const glGeo = new T.PlaneGeometry(O.AA.w * 1.15, O.AA.h * 1.15); glGeo.rotateX(-PI / 2);   // same 2:1 aspect as the screen
    const glow = kit.addMesh(glGeo, gMat, 'glow', { cast: false, receive: false, renderOrder: 2 });
    glow.position.set(f.X(aaCx), aaY + 0.04, f.Z(aaCy));
    const cMat = MC.mat.glassCover();     // reflections only: black base, added on top of the pixels
    cMat.color.set('#000000'); cMat.blending = T.AdditiveBlending; cMat.opacity = 1;
    // circular polariser film on the panel: satin, one soft reflection lobe
    cMat.envMapIntensity = 0.1; cMat.clearcoat = 0; cMat.roughness = 0.12;
    const cGeo = new T.PlaneGeometry(G.w - 0.3, encH - 0.3); cGeo.rotateX(-PI / 2);
    const cover = kit.addMesh(cGeo, cMat, 'cover', { cast: false, receive: false, renderOrder: 3 });
    cover.position.set(f.X(gx), yTop + 0.09, f.Z(gTop + encH / 2));

    const foam = MC.mat.rubber(); foam.color.set('#2A2C30');
    const glass = MC.mat.blackGlass(); glass.envMapIntensity = 0.45;
    kit.mesh('glass', glass);
    kit.mesh('enc', encMat, { cast: false });
    kit.mesh('ledge', ledgeMat, { cast: false });
    kit.mesh('foam', foam, { cast: false });
    kit.mesh('fpc', fpcMat);
    kit.mesh('plastic', blackPlastic());
    kit.mesh('gold', MC.mat.gold());
    kit.mesh('tin', MC.mat.tin());
    kit.mesh('epoxy', epoxy());
    kit.mesh('ceramic', MC.mat.ceramic('#B49A74'));
    ctx.finishMarks();

    const extra = {
      screen, glow, cover,
      // pixels: the 1024 x 512 OLED canvas (flipY true: canvas row 0 = top of the screen, the header side)
      setTexture(pixels, glowTex) {
        if (pixels) { sMat.emissiveMap = pixels; sMat.needsUpdate = true; }
        if (glowTex) { gMat.map = glowTex; gMat.needsUpdate = true; }
      },
      activeArea: { w: O.AA.w, h: O.AA.h, centre: V3(f.X(aaCx), aaY, f.Z(aaCy)) },
      glass: { w: G.w, h: G.h, top: yTop, centre: V3(f.X(gx), yTop, f.Z(gTop + G.h / 2)) },
      holes: holes.map(h => V3(h.x, 0, h.z)),
      bounds: new T.Box3(V3(-W / 2, -(O.PIN_BODY + O.PIN_DOWN), -H / 2), V3(W / 2, yTop + 0.1, H / 2 + 0.2)),
      buildMs: 0
    };
    extra.buildMs = performance.now() - t0;
    return { group: kit.group, pins, size: [W, yTop, H], extra };
  };

  // ================================================================== RC522 RFID reader
  const RC = {
    W: 39.0, H: 60.0, TH: 1.6,
    HOLE_D: 3.0,
    HOLES: [[3.6, 3.6], [35.4, 3.6], [3.6, 42.6], [35.4, 42.6]],
    PINS: ['SDA', 'SCK', 'MOSI', 'MISO', 'IRQ', 'GND', 'RST', '3V3'],
    LABELS: ['SDA', 'SCK', 'MOSI', 'MISO', 'IRQ', 'GND', 'RST', '3.3V'],
    PIN_ROW: 58.0,                  // through holes, from the antenna end
    RA: { body: 2.54, axis: 1.27, out: 6.0, bodyFrom: 58.75 },
    COIL: { x0: 2.6, y0: 2.6, x1: 36.4, y1: 37.6, r: 11.0, turns: 4, w: 0.85, pitch: 1.55 },
    MASK: '#17489C'
  };

  MC.parts.rc522 = function (opts) {
    const t0 = performance.now();
    const R = RC, W = R.W, H = R.H, TH = R.TH;
    const f = frame(W, H, TH, 'down');
    const ctx = makeCtx('rc522');
    const kit = ctx.kit;
    const top = new Painter(W, H, f.top, R.MASK);
    const bot = new Painter(W, H, f.bottom, R.MASK);
    const pins = {};
    const k = resScale(opts);

    const holes = R.HOLES.map(p => ({ x: f.X(p[0]), z: f.Z(p[1]), r: R.HOLE_D / 2 }));
    for (const p of R.HOLES) { top.ring(p[0], p[1], 2.3, 1.55); bot.ring(p[0], p[1], 2.3, 1.55); }

    // antenna coil: rounded rectangle spiral, copper under the mask
    const C = R.COIL;
    const coilPath = i => {
      const o = i * C.pitch, x0 = C.x0 + o, y0 = C.y0 + o, x1 = C.x1 - o, y1 = C.y1 - o, r = Math.max(1.5, C.r - o);
      return { x0, y0, x1, y1, r };
    };
    top.custom(0, 0, 0, (c, st) => {
      c.strokeStyle = st('trace'); c.lineWidth = C.w; c.lineJoin = 'round'; c.lineCap = 'round';
      for (let i = 0; i < C.turns; i++) {
        const q = coilPath(i), gap = 2.6 + i * 0;
        const mx = W / 2;
        c.beginPath();
        c.moveTo(mx + gap / 2 + (i ? 0 : 0), q.y1);
        c.arcTo(q.x1, q.y1, q.x1, q.y0, q.r);
        c.arcTo(q.x1, q.y0, q.x0, q.y0, q.r);
        c.arcTo(q.x0, q.y0, q.x0, q.y1, q.r);
        c.arcTo(q.x0, q.y1, q.x1, q.y1, q.r);
        c.lineTo(mx - gap / 2, q.y1);
        c.stroke();
        // step to the next turn across the gap
        if (i < C.turns - 1) {
          const n = coilPath(i + 1);
          c.beginPath(); c.moveTo(mx - gap / 2, q.y1); c.lineTo(mx + gap / 2, n.y1); c.stroke();
        }
      }
      // feeds down to the matching network
      const inner = coilPath(C.turns - 1), outer = coilPath(0);
      c.beginPath(); c.moveTo(W / 2 + 1.3, outer.y1); c.lineTo(W / 2 + 1.3, 40.2); c.lineTo(24.6, 40.2); c.stroke();
      c.beginPath(); c.moveTo(W / 2 - 1.3, outer.y1 + 1.6); c.lineTo(W / 2 - 1.3, 40.2); c.lineTo(14.4, 40.2); c.stroke();
    });
    top.via(W / 2 - 1.3, coilPath(C.turns - 1).y1 + 0.0, 0.55);
    top.via(W / 2 - 1.3, coilPath(0).y1 + 1.6, 0.55);
    bot.trace([[W / 2 - 1.3, coilPath(C.turns - 1).y1], [W / 2 - 1.3, coilPath(0).y1 + 1.6]], 0.8);
    // traces from the chip to the header
    const pinX = i => W / 2 + (i - 3.5) * 2.54;
    for (let i = 0; i < 8; i++) {
      const px = pinX(i);
      top.trace([[px, R.PIN_ROW], [px, 52.6], [15.0 + (i - 3.5) * 0.65, 50.0], [15.0 + (i - 3.5) * 0.65, 49.2]], 0.3);
    }
    top.trace([[3.6, 46.6], [3.6, 54.5], [10.6, 56.0]], 0.6);
    top.trace([[24.0, 44.0], [24.0, 50.0]], 0.35);
    [[8.0, 47.0], [21.6, 52.0], [33.0, 47.5], [12.0, 43.6], [27.5, 41.6]].forEach(p => top.via(p[0], p[1]));

    // 90 degree header on the component side, pins out over the +Z edge
    const ra = R.RA, axisY = TH + ra.axis;
    kit.add('plastic', rbox(8 * 2.54 - 0.06, ra.body, ra.body, 0.22, 1), f.onTop(W / 2, ra.bodyFrom + ra.body / 2));
    const tipBy = ra.bodyFrom + ra.body + ra.out;
    R.PINS.forEach((name, i) => {
      const x = pinX(i);
      const legLen = 1.5 + TH + ra.axis + 0.32;
      kit.add('gold', pinGeo(legLen, false, true), TR(f.X(x), -1.5, f.Z(R.PIN_ROW)));
      const armLen = tipBy - (R.PIN_ROW - 0.32);
      kit.add('gold', pinGeo(armLen, true, false), mul(TR(f.X(x), axisY, f.Z(R.PIN_ROW - 0.32)), new T.Matrix4().makeRotationX(PI / 2)));
      kit.add('tin', smallSolderGeo(), f.onTop(x, R.PIN_ROW));
      kit.add('tin', solderGeo(), f.onBottom(x, R.PIN_ROW));
      top.circ(x, R.PIN_ROW, 0.95, 'tin'); bot.circ(x, R.PIN_ROW, 0.95, 'tin');
      pins[name] = { p: f.local(x, tipBy, axisY), d: V3(0, 0, 1) };
      top.text(R.LABELS[i], x, 56.7, { size: 1.0, rot: 90, align: 'left' });   // reads upward from the pin
      bot.text(R.LABELS[i], x, 54.0, { size: 0.9, rot: 90, align: 'center' });
    });

    // MFRC522 (HVQFN32, 5 x 5) rotated 45 degrees like on the module, crystal, matching network
    {
      const qx = 15.0, qy = 46.6, rot = 45;
      for (let s = 0; s < 4; s++) for (let i = 0; i < 8; i++) {
        const o = (i - 3.5) * 0.5, a = (s * 90 + rot) * D2R;
        const ux = 2.55, px = Math.cos(a) * ux - Math.sin(a) * o, pyy = Math.sin(a) * ux + Math.cos(a) * o;
        top.pad(qx + px, qy - pyy, 0.75, 0.28, { rot: s * 90 + rot });
      }
      top.pad(qx, qy, 3.4, 3.4, { rot });
      icBody(ctx, 5.0, 0.85, 5.0, f.onTop(qx, qy, rot), ['NXP', 'MFRC522', '02  W1L'], { r: 0.08, dot: [0.14, 0.18], scale: [0.85, 1, 0.75], ppm: 70 });
      top.rect(qx, qy, 6.6, 6.6, { rot, lw: 0.12 });
      top.text('U1', qx - 5.4, qy + 0.2, { size: 0.75 });
    }
    crystalCan(ctx, f.onTop(28.6, 47.4, 90), ['27.120', 'J  2D']);
    for (const s of [-1, 1]) { bot.circ(28.6, 47.4 + s * 2.44, 0.8, 'tin'); kit.add('tin', smallSolderGeo(), f.onBottom(28.6, 47.4 + s * 2.44)); }
    top.rect(28.6, 47.4, 5.4, 12.0, { lw: 0.12, r: 2.4 });
    top.text('Y1', 32.4, 47.4, { size: 0.75, rot: 90 });
    const parts = [
      [12.2, 41.0, '0805', 'ind', 0, '1R0', 'L1'], [26.6, 41.0, '0805', 'ind', 0, '1R0', 'L2'],
      [16.6, 41.0, '0603', 'cap', 0, null, 'C1'], [22.4, 41.0, '0603', 'cap', 0, null, 'C2'], [19.5, 43.0, '0603', 'cap', 90, null, 'C3'],
      [16.6, 39.0, '0603', 'cap', 0, null, 'C4'], [22.4, 39.0, '0603', 'cap', 0, null, 'C5'], [9.4, 44.6, '0603', 'cap', 90, null, 'C6'],
      [9.4, 49.6, '0603', 'res', 90, '103', 'R1'], [20.6, 47.0, '0603', 'cap', 90, null, 'C7'], [22.4, 50.6, '0603', 'cap', 0, null, 'C8'],
      [7.0, 51.4, '0805', 'cap', 90, null, 'C9'], [22.0, 52.4, '0603', 'res', 0, '000', 'R2'], [34.6, 51.0, '0603', 'cap', 90, null, 'C10'],
      [34.6, 46.6, '0603', 'cap', 90, null, 'C11'], [6.2, 47.2, '0603', 'res', 90, '472', 'R3']
    ];
    for (const [x, y, size, kind, rot, mark, des] of parts) {
      passive(ctx, size, kind, f.onTop(x, y, rot), mark, rot);
      passivePads(top, size, x, y, rot);
    }
    top.text('RFID-RC522', 4.2, 53.0, { size: 1.0, rot: 90 });
    bot.text('RC522', W / 2, 30.0, { size: 2.6, weight: 800 });
    bot.text('13.56MHz', W / 2, 34.0, { size: 1.2 });

    const tTop = top.textures(24 * k), tBot = bot.textures(8 * k);
    pcbMesh(kit, [[-W / 2, -H / 2], [W / 2, -H / 2], [W / 2, H / 2], [-W / 2, H / 2]], holes, TH, W, H,
      [pcbMaterial(tTop, 0.55), pcbMaterial(tBot, 0.5), fr4(), MC.mat.tin()]);

    kit.mesh('plastic', blackPlastic());
    kit.mesh('gold', MC.mat.gold());
    kit.mesh('tin', MC.mat.tin());
    kit.mesh('steel', MC.mat.steel());
    kit.mesh('epoxy', epoxy());
    kit.mesh('ind', MC.mat.darkPlastic());
    kit.mesh('ceramic', MC.mat.ceramic('#B49A74'));
    ctx.finishMarks();

    const coil = coilPath(0);
    const extra = {
      antennaCentre: f.local((coil.x0 + coil.x1) / 2, (coil.y0 + coil.y1) / 2, TH),
      antennaSize: [coil.x1 - coil.x0, coil.y1 - coil.y0],
      holes: holes.map(h => V3(h.x, 0, h.z)),
      bounds: new T.Box3(V3(-W / 2, -1.5, -H / 2), V3(W / 2, TH + 3.5, f.Z(tipBy))),
      buildMs: 0
    };
    extra.buildMs = performance.now() - t0;
    return { group: kit.group, pins, size: [W, TH + 3.5, H], extra };
  };

  // Reference values for other modules (case fit, labels).
  MC.parts.BOARD_DIMS = { uno: UNO, oled: OLED, rc522: RC };
})();
