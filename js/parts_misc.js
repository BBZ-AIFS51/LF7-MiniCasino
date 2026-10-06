/* Mini Casino viewer: membrane keypad, breadboard, buzzer module, 330 Ω resistor, RFID
   transponders, jumper wires, ribbon bundles and pin headers.

   Part local frame (SPEC §3): millimetres, origin at the centre of the footprint on the bottom
   face, +Y = the side a person looks at, +X = reading direction, +Z = toward the reader.
   Every builder returns { group, pins, size, extra } and tags every mesh with userData.part.
   Reference dimensions are named constants, each with its source. Materials come from MC.mat,
   canvas textures from MC.tex. Small connector parts (Dupont plugs, pins, header plastic,
   solder) share one palette material so a full set stays well under 150 draw calls. */
(function () {
  'use strict';
  const MC = window.MC;
  const T = window.THREE;
  const parts = MC.parts = MC.parts || {};

  // ------------------------------------------------------------------ reference dimensions
  const PITCH = 2.54;                                  // 0.1" grid
  const KP = {                                         // 4x4 membrane keypad
    W: 69.2, H: 76.9, T: 0.8,                          // generic 4x4 membrane keypad listings: 69 x 77 x 0.8 mm
                                                       // (bitsandparts.nl #101109: 70 x 78 x 1 incl. adhesive)
    R: 1.6,                                            // corner radius of the overlay
    KEY: 13.0, KEY_R: 1.7, PX: 16.6, PZ: 17.4,         // key field 13 mm, ~17 mm grid (photos of the common part)
    EMBOSS: 0.24,                                      // height of the embossed key field
    TAIL_W: 20.3, TAIL_L: 75.0,                        // flat tail, 8 x 2.54 wide, 85 mm incl. connector
    CONN_W: 20.6, CONN_T: 2.6, CONN_L: 10.0            // 1x8 female 2.54 crimp housing
  };
  const BB = {                                         // half-size breadboard, 400 tie points
    L: 82.5, D: 54.5, H: 8.5,                          // SparkFun PRT-12002 / generic 400-point: 82.5 x 54.5 x 8.5
    FOAM: 0.5,                                         // adhesive foam back
    CH_W: 2.8, CH_D: 2.6,                              // centre channel (DIP spacing 7.62 between rows e and f)
    COLS: 30,
    RAIL_IN: 20.7, RAIL_OUT: 23.24                     // rail rows from the centre line (two rails per side, 2.54 apart)
  };
  const BZ = {                                         // KY-006 passive buzzer module
    PCB_W: 15.0, PCB_H: 18.5, PCB_T: 1.6,              // Joy-IT KY-006 drawing ~18.5 x 15 mm
    CAN_D: 12.0, CAN_H: 8.5, CAN_Y: 12.0,              // 12085 magnetic transducer: Ø12 x 8.5
    PIN_DEPTH: 6.0                                     // 90° header, mating pins 6 mm into the breadboard
  };
  const RS = { D: 2.4, L: 6.3, LEAD: 0.6 };            // ¼ W carbon film (Yageo CFR-25 class): Ø2.4 x 6.3, lead Ø0.6
  const DP = { W: 2.54, HOUSING: 14.0, PIN: 6.0, PIN_W: 0.64 };  // Dupont crimp housing + 0.64 square pin
  const CARD = { W: 85.6, H: 53.98, T: 0.76, R: 3.18 }; // ISO/IEC 7810 ID-1
  const FOB = { W: 31.0, L: 39.5, T: 4.5, HOLE: 5.2 }; // generic 13.56 MHz ABS key fob
  const NTAG = { D: 25.0, T: 0.22, LINER: 31.0, LINER_T: 0.1 };  // Ø25 NTAG213 paper sticker on its liner
  const COIN = { D: 25.0, T: 2.5 };                    // NTAG coin tag
  parts.DUPONT = DP;
  parts.MISC_DIMS = { PITCH, KP, BB, BZ, RS, DP, CARD, FOB, NTAG, COIN };

  const V3 = (x, y, z) => new T.Vector3(x, y, z);
  const toV3 = p => (p && p.isVector3 ? p : V3(p[0], p[1], p[2]));
  const UP = V3(0, 1, 0);
  const smooth = (a, b, x) => { const t = MC.clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };
  const UI_FONT = '"Segoe UI", "Helvetica Neue", Arial, sans-serif';
  const MONO = MC.tokens ? MC.tokens.mono : 'Consolas, monospace';

  // three r147 defaults to ColorManagement.legacyMode = true, which takes hex material colours as
  // linear values (everything turns pastel). Convert once so the parts look the same in both modes.
  function fixColour(m) {
    if (!m || m.userData.srgbFixed) return;
    m.userData.srgbFixed = true;
    if (!(T.ColorManagement && T.ColorManagement.legacyMode)) return;
    ['color', 'sheenColor', 'specularColor', 'emissive', 'attenuationColor'].forEach(k => { if (m[k] && m[k].isColor) m[k].convertSRGBToLinear(); });
  }

  function tag(root, partId, extra) {
    root.traverse(o => {
      if (!o.isMesh) return;
      (Array.isArray(o.material) ? o.material : [o.material]).forEach(fixColour);
      if (partId) o.userData.part = partId;
      if (extra) Object.assign(o.userData, extra);
      o.castShadow = true;
      o.receiveShadow = true;
    });
    return root;
  }

  // ------------------------------------------------------------------ palette material
  // One tiny texture atlas: every connector/pin/solder mesh points its UVs at one texel and
  // gets colour, roughness and metalness from there. One material = one draw call per mesh.
  const PAL = { black: 0, gold: 1, hole: 2, tin: 3, white: 4, grey: 5, brass: 6, gloss: 7 };
  const PAL_DEF = [
    ['#141518', 0.46, 0],   // black housing plastic
    ['#E2B661', 0.24, 1],   // gold flash
    ['#030304', 0.95, 0],   // hole / cavity
    ['#D2D6DB', 0.30, 1],   // tin, HASL
    ['#ECECE7', 0.55, 0],   // white plastic
    ['#383B40', 0.50, 0],   // dark grey plastic
    ['#C99F62', 0.32, 1],   // brass
    ['#0A0B0D', 0.28, 0]    // glossy black
  ];
  let palTex = null;
  function palTextures() {
    if (palTex) return palTex;
    const n = PAL_DEF.length;
    const make = fill => {
      const c = document.createElement('canvas');
      c.width = n; c.height = 1;
      const x = c.getContext('2d');
      PAL_DEF.forEach((d, i) => { x.fillStyle = fill(d); x.fillRect(i, 0, 1, 1); });
      const t = new T.CanvasTexture(c);
      t.magFilter = t.minFilter = T.NearestFilter;
      t.generateMipmaps = false;
      return t;
    };
    const map = make(d => d[0]);
    map.encoding = T.sRGBEncoding;
    const orm = make(d => 'rgb(255,' + Math.round(d[1] * 255) + ',' + Math.round(d[2] * 255) + ')');
    orm.encoding = T.LinearEncoding;
    palTex = { map, orm };
    return palTex;
  }
  const palUV = i => [(i + 0.5) / PAL_DEF.length, 0.5];
  function palMaterial() {
    const t = palTextures();
    const m = new T.MeshStandardMaterial({ map: t.map, roughnessMap: t.orm, metalnessMap: t.orm, roughness: 1, metalness: 1 });
    m.userData.kind = 'palette';
    return m;
  }
  parts.paletteMaterial = palMaterial;

  // ------------------------------------------------------------------ mesh builder
  // Flat-shaded quads, prisms and frustums with optional transform; output one indexed geometry.
  function MB() { this.p = []; this.n = []; this.u = []; this.ix = []; this.m = null; this.nm = null; }
  MB.prototype.setMatrix = function (m) {
    this.m = m || null;
    this.nm = m ? new T.Matrix3().getNormalMatrix(m) : null;
    return this;
  };
  MB.prototype.vert = function (x, y, z, nx, ny, nz, u, v) {
    if (this.m) {
      const e = this.m.elements;
      const X = e[0] * x + e[4] * y + e[8] * z + e[12];
      const Y = e[1] * x + e[5] * y + e[9] * z + e[13];
      const Z = e[2] * x + e[6] * y + e[10] * z + e[14];
      const f = this.nm.elements;
      const NX = f[0] * nx + f[3] * ny + f[6] * nz;
      const NY = f[1] * nx + f[4] * ny + f[7] * nz;
      const NZ = f[2] * nx + f[5] * ny + f[8] * nz;
      const l = Math.hypot(NX, NY, NZ) || 1;
      x = X; y = Y; z = Z; nx = NX / l; ny = NY / l; nz = NZ / l;
    }
    this.p.push(x, y, z); this.n.push(nx, ny, nz); this.u.push(u, v);
    return this.p.length / 3 - 1;
  };
  // a, b, c, d counter-clockwise seen from the front side
  MB.prototype.quad = function (a, b, c, d, uv) {
    const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2];
    const vx = d[0] - a[0], vy = d[1] - a[1], vz = d[2] - a[2];
    let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const l = Math.hypot(nx, ny, nz) || 1;
    nx /= l; ny /= l; nz /= l;
    const i0 = this.vert(a[0], a[1], a[2], nx, ny, nz, uv[0], uv[1]);
    this.vert(b[0], b[1], b[2], nx, ny, nz, uv[0], uv[1]);
    this.vert(c[0], c[1], c[2], nx, ny, nz, uv[0], uv[1]);
    this.vert(d[0], d[1], d[2], nx, ny, nz, uv[0], uv[1]);
    this.ix.push(i0, i0 + 1, i0 + 2, i0, i0 + 2, i0 + 3);
  };
  // convex polygon cap (points CCW seen from the front side)
  MB.prototype.fan = function (pts, uv) {
    const a = pts[0], b = pts[1], c = pts[2];
    const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2];
    const vx = c[0] - a[0], vy = c[1] - a[1], vz = c[2] - a[2];
    let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const l = Math.hypot(nx, ny, nz) || 1;
    nx /= l; ny /= l; nz /= l;
    const i0 = this.p.length / 3;
    pts.forEach(q => this.vert(q[0], q[1], q[2], nx, ny, nz, uv[0], uv[1]));
    for (let i = 1; i < pts.length - 1; i++) this.ix.push(i0, i0 + i, i0 + i + 1);
  };
  // polygon [[x,y]...] CCW seen from +Z, extruded from z0 to z1
  MB.prototype.prism = function (poly, z0, z1, uv, cap0, cap1) {
    const n = poly.length;
    for (let i = 0; i < n; i++) {
      const a = poly[i], b = poly[(i + 1) % n];
      this.quad([a[0], a[1], z0], [b[0], b[1], z0], [b[0], b[1], z1], [a[0], a[1], z1], uv);
    }
    if (cap1 !== false) this.fan(poly.map(q => [q[0], q[1], z1]), uv);
    if (cap0 !== false) this.fan(poly.slice().reverse().map(q => [q[0], q[1], z0]), uv);
  };
  // square frustum along z: half size a0 at z0, a1 at z1; optional caps
  MB.prototype.frustum = function (a0, a1, z0, z1, uv, cap0, cap1) {
    const s0 = [[a0, -a0], [a0, a0], [-a0, a0], [-a0, -a0]];
    const s1 = [[a1, -a1], [a1, a1], [-a1, a1], [-a1, -a1]];
    for (let i = 0; i < 4; i++) {
      const j = (i + 1) % 4;
      this.quad([s0[i][0], s0[i][1], z0], [s0[j][0], s0[j][1], z0], [s1[j][0], s1[j][1], z1], [s1[i][0], s1[i][1], z1], uv);
    }
    if (cap0 !== false) this.fan(s0.slice().reverse().map(q => [q[0], q[1], z0]), uv);
    if (cap1) this.fan(s1.map(q => [q[0], q[1], z1]), uv);
  };
  // round frustum along z (smooth sides): radius r0 at z0, r1 at z1, optional top cap
  MB.prototype.cone = function (r0, r1, z0, z1, uv, segs, cap1) {
    segs = segs || 12;
    const i0 = this.p.length / 3;
    const k = (r0 - r1) / (z1 - z0), nl = Math.hypot(1, k);
    for (let i = 0; i <= segs; i++) {
      const a = (i / segs) * Math.PI * 2, c = Math.cos(a), s = Math.sin(a);
      this.vert(c * r0, s * r0, z0, c / nl, s / nl, k / nl, uv[0], uv[1]);
      this.vert(c * r1, s * r1, z1, c / nl, s / nl, k / nl, uv[0], uv[1]);
    }
    for (let i = 0; i < segs; i++) { const a = i0 + i * 2; this.ix.push(a, a + 2, a + 3, a, a + 3, a + 1); }
    if (cap1 && r1 > 0) {
      const pts = [];
      for (let i = 0; i < segs; i++) { const a = (i / segs) * Math.PI * 2; pts.push([Math.cos(a) * r1, Math.sin(a) * r1, z1]); }
      this.fan(pts, uv);
    }
  };
  MB.prototype.box = function (x0, y0, z0, x1, y1, z1, uv) {
    this.prism([[x1, y0], [x1, y1], [x0, y1], [x0, y0]], z0, z1, uv);
  };
  MB.prototype.geometry = function () {
    const g = new T.BufferGeometry();
    g.setAttribute('position', new T.Float32BufferAttribute(this.p, 3));
    g.setAttribute('normal', new T.Float32BufferAttribute(this.n, 3));
    g.setAttribute('uv', new T.Float32BufferAttribute(this.u, 2));
    g.setIndex(this.ix);
    g.computeBoundingSphere();
    return g;
  };
  const rectPoly = (hw, hh) => [[hw, -hh], [hw, hh], [-hw, hh], [-hw, -hh]];
  const chamferPoly = (hw, hh, c) => [
    [hw - c, -hh], [hw, -hh + c], [hw, hh - c], [hw - c, hh], [-hw + c, hh], [-hw, hh - c], [-hw, -hh + c], [-hw + c, -hh]
  ];

  // ------------------------------------------------------------------ 2D outlines (x, z)
  function roundRect(w, h, r, seg, cx, cz) {
    cx = cx || 0; cz = cz || 0; seg = seg || 6;
    r = Math.max(0.001, Math.min(r, w / 2 - 0.001, h / 2 - 0.001));
    const pts = [];
    const corners = [[w / 2 - r, -h / 2 + r, -Math.PI / 2], [w / 2 - r, h / 2 - r, 0], [-w / 2 + r, h / 2 - r, Math.PI / 2], [-w / 2 + r, -h / 2 + r, Math.PI]];
    corners.forEach(([x, z, a0]) => {
      for (let i = 0; i <= seg; i++) {
        const a = a0 + (i / seg) * Math.PI / 2;
        pts.push([cx + x + Math.cos(a) * r, cz + z + Math.sin(a) * r]);
      }
    });
    return pts;
  }
  // axis-aligned rectangle with an individual radius per corner: [x1z0, x1z1, x0z1, x0z0]
  function cornerRect(x0, z0, x1, z1, rs, seg) {
    seg = seg || 5;
    const pts = [];
    const c = [[x1, z0, -Math.PI / 2, -1, 1], [x1, z1, 0, -1, -1], [x0, z1, Math.PI / 2, 1, -1], [x0, z0, Math.PI, 1, 1]];
    c.forEach(([x, z, a0, sx, sz], i) => {
      const r = rs[i];
      if (!r) { pts.push([x, z]); return; }
      const cx = x + sx * r, cz = z + sz * r;
      for (let j = 0; j <= seg; j++) { const a = a0 + (j / seg) * Math.PI / 2; pts.push([cx + Math.cos(a) * r, cz + Math.sin(a) * r]); }
    });
    return pts;
  }
  function circle(r, n, cx, cz) {
    const pts = [];
    for (let i = 0; i < n; i++) { const a = (i / n) * Math.PI * 2; pts.push([(cx || 0) + Math.cos(a) * r, (cz || 0) + Math.sin(a) * r]); }
    return pts;
  }
  function signedArea(pts) {
    let a = 0;
    for (let i = 0; i < pts.length; i++) { const p = pts[i], q = pts[(i + 1) % pts.length]; a += p[0] * q[1] - q[0] * p[1]; }
    return a / 2;
  }
  function orient(pts, ccw) { return (signedArea(pts) > 0) === ccw ? pts.slice() : pts.slice().reverse(); }
  function convexHull(points) {
    const p = points.slice().sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    const cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
    const lower = [], upper = [];
    for (const q of p) { while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], q) <= 0) lower.pop(); lower.push(q); }
    for (let i = p.length - 1; i >= 0; i--) { const q = p[i]; while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], q) <= 0) upper.pop(); upper.push(q); }
    upper.pop(); lower.pop();
    return lower.concat(upper);
  }

  // ------------------------------------------------------------------ slab geometry
  // A flat body in the XZ plane from y = 0 to y = t with rounded top/bottom edges.
  // o: { outline:[[x,z]...], holes:[[[x,z]...]], t, bevelTop, bevelBottom, seg,
  //      uvTop(x,z)->[u,v], uvBottom(x,z)->[u,v], sideUV:[u,v], capTop, capBottom }
  function slab(o) {
    const t = o.t, bt = o.bevelTop || 0, bb = o.bevelBottom || 0, seg = o.seg || 3;
    const contours = [orient(o.outline, true)].concat((o.holes || []).map(h => orient(h, false)));
    let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
    contours[0].forEach(p => { minX = Math.min(minX, p[0]); maxX = Math.max(maxX, p[0]); minZ = Math.min(minZ, p[1]); maxZ = Math.max(maxZ, p[1]); });
    const planar = (x, z) => [(x - minX) / (maxX - minX), 1 - (z - minZ) / (maxZ - minZ)];
    const uvTop = o.uvTop || planar;
    const uvBottom = o.uvBottom || planar;
    const sideUV = o.sideUV || [0.5, 0.5];
    // edge profile rows from the top cap edge to the bottom cap edge: [offset, y, nOut, nY]
    const rows = [];
    if (bt > 0) for (let k = 0; k <= seg; k++) { const a = (k / seg) * Math.PI / 2; rows.push([-bt + bt * Math.sin(a), t - bt + bt * Math.cos(a), Math.sin(a), Math.cos(a)]); }
    else rows.push([0, t, 1, 0]);
    if (bb > 0) for (let k = 0; k <= seg; k++) { const a = (k / seg) * Math.PI / 2; rows.push([-bb + bb * Math.cos(a), bb - bb * Math.sin(a), Math.cos(a), -Math.sin(a)]); }
    else rows.push([0, 0, 1, 0]);
    const P = [], N = [], U = [], I = [];
    const vert = (x, y, z, nx, ny, nz, uv) => { P.push(x, y, z); N.push(nx, ny, nz); U.push(uv[0], uv[1]); return P.length / 3 - 1; };
    // per contour: miter offsets and smooth 2D normals
    const geo2d = contours.map(c => {
      const n = c.length, miter = [], nrm = [];
      for (let i = 0; i < n; i++) {
        const p0 = c[(i - 1 + n) % n], p1 = c[i], p2 = c[(i + 1) % n];
        let e1x = p1[0] - p0[0], e1z = p1[1] - p0[1]; const l1 = Math.hypot(e1x, e1z) || 1; e1x /= l1; e1z /= l1;
        let e2x = p2[0] - p1[0], e2z = p2[1] - p1[1]; const l2 = Math.hypot(e2x, e2z) || 1; e2x /= l2; e2z /= l2;
        const n1x = e1z, n1z = -e1x, n2x = e2z, n2z = -e2x;
        const d = 1 + n1x * n2x + n1z * n2z;
        miter.push([(n1x + n2x) / Math.max(d, 0.2), (n1z + n2z) / Math.max(d, 0.2)]);
        const l = Math.hypot(n1x + n2x, n1z + n2z) || 1;
        nrm.push([(n1x + n2x) / l, (n1z + n2z) / l]);
      }
      return { c, miter, nrm };
    });
    // side walls
    geo2d.forEach(({ c, miter, nrm }) => {
      const n = c.length, base = P.length / 3;
      rows.forEach(r => {
        for (let i = 0; i < n; i++) {
          const x = c[i][0] + miter[i][0] * r[0], z = c[i][1] + miter[i][1] * r[0];
          vert(x, r[1], z, nrm[i][0] * r[2], r[3], nrm[i][1] * r[2], sideUV);
        }
      });
      for (let k = 0; k < rows.length - 1; k++) {
        for (let i = 0; i < n; i++) {
          const j = (i + 1) % n;
          const a = base + k * n + i, b = base + k * n + j, c2 = base + (k + 1) * n + j, d = base + (k + 1) * n + i;
          I.push(a, b, c2, a, c2, d);
        }
      }
    });
    // caps
    const cap = (y, inset, up, uvf) => {
      const all = [];
      const rings = geo2d.map(({ c, miter }) => c.map((p, i) => [p[0] - miter[i][0] * inset, p[1] - miter[i][1] * inset]));
      rings.forEach(r => r.forEach(p => all.push(p)));
      const outer = rings[0].map(p => new T.Vector2(p[0], p[1]));
      const holes = rings.slice(1).map(r => r.map(p => new T.Vector2(p[0], p[1])));
      const tris = T.ShapeUtils.triangulateShape(outer, holes);
      const base = P.length / 3;
      all.forEach(p => vert(p[0], y, p[1], 0, up ? 1 : -1, 0, uvf(p[0], p[1])));
      tris.forEach(([a, b, c]) => {
        const A = all[a], B = all[b], C = all[c];
        const ny = (B[1] - A[1]) * (C[0] - A[0]) - (B[0] - A[0]) * (C[1] - A[1]);
        if ((ny > 0) === up) I.push(base + a, base + b, base + c); else I.push(base + a, base + c, base + b);
      });
    };
    if (o.capTop !== false) cap(t, bt, true, uvTop);
    if (o.capBottom !== false) cap(0, bb, false, uvBottom);
    const g = new T.BufferGeometry();
    g.setAttribute('position', new T.Float32BufferAttribute(P, 3));
    g.setAttribute('normal', new T.Float32BufferAttribute(N, 3));
    g.setAttribute('uv', new T.Float32BufferAttribute(U, 2));
    g.setIndex(I);
    g.computeBoundingSphere();
    return g;
  }
  parts.slabGeometry = slab;

  // ------------------------------------------------------------------ tube (wires, leads)
  // Rebuildable tube with parallel-transport frames; set() rewrites the buffers in place.
  function Tube(radial) {
    this.radial = radial || 10;
    this.cap = 0;
    this.geo = new T.BufferGeometry();
    this.pts = [];
  }
  Tube.prototype.ensure = function (rings) {
    if (rings <= this.cap) return;
    const R = this.radial, cap = Math.ceil(rings * 1.25) + 8;
    const pos = new Float32Array(cap * R * 3), nor = new Float32Array(cap * R * 3);
    const idx = new (cap * R > 65000 ? Uint32Array : Uint16Array)((cap - 1) * R * 6);
    let o = 0;
    for (let i = 0; i < cap - 1; i++) {
      for (let j = 0; j < R; j++) {
        const a = i * R + j, b = i * R + (j + 1) % R, c = (i + 1) * R + (j + 1) % R, d = (i + 1) * R + j;
        idx[o++] = a; idx[o++] = b; idx[o++] = c; idx[o++] = a; idx[o++] = c; idx[o++] = d;
      }
    }
    if (this.cap) this.geo.dispose();
    this.cap = cap;
    this.geo.setAttribute('position', new T.BufferAttribute(pos, 3));
    this.geo.setAttribute('normal', new T.BufferAttribute(nor, 3));
    this.geo.setIndex(new T.BufferAttribute(idx, 1));
  };
  // pts: Vector3[] (>= 2), r: radius, ref: Vector3 hint for the first normal
  Tube.prototype.set = function (pts, r, ref, count) {
    const n = count || pts.length, R = this.radial;
    this.ensure(n);
    const pos = this.geo.attributes.position.array, nor = this.geo.attributes.normal.array;
    const t = new T.Vector3(), nv = new T.Vector3(), b = new T.Vector3(), tmp = new T.Vector3();
    if (!this.cosT) {
      this.cosT = []; this.sinT = [];
      for (let j = 0; j < R; j++) { this.cosT.push(Math.cos(j / R * Math.PI * 2)); this.sinT.push(Math.sin(j / R * Math.PI * 2)); }
    }
    const cosT = this.cosT, sinT = this.sinT;
    let minX = Infinity, minY = Infinity, minZ = Infinity, maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
    for (let i = 0; i < n; i++) {
      const p = pts[i];
      if (i === 0) t.subVectors(pts[1], pts[0]);
      else if (i === n - 1) t.subVectors(pts[n - 1], pts[n - 2]);
      else t.subVectors(pts[i + 1], pts[i - 1]);
      if (t.lengthSq() < 1e-12) t.set(0, 0, 1);
      t.normalize();
      if (i === 0) {
        nv.copy(ref || UP);
        nv.addScaledVector(t, -nv.dot(t));
        if (nv.lengthSq() < 1e-6) { nv.set(1, 0, 0).addScaledVector(t, -t.x); if (nv.lengthSq() < 1e-6) nv.set(0, 0, 1).addScaledVector(t, -t.z); }
        nv.normalize();
      } else {
        tmp.copy(nv).addScaledVector(t, -nv.dot(t));
        if (tmp.lengthSq() > 1e-10) nv.copy(tmp.normalize());
      }
      b.crossVectors(t, nv);
      for (let j = 0; j < R; j++) {
        const ox = nv.x * cosT[j] + b.x * sinT[j], oy = nv.y * cosT[j] + b.y * sinT[j], oz = nv.z * cosT[j] + b.z * sinT[j];
        const k = (i * R + j) * 3;
        nor[k] = ox; nor[k + 1] = oy; nor[k + 2] = oz;
        pos[k] = p.x + ox * r; pos[k + 1] = p.y + oy * r; pos[k + 2] = p.z + oz * r;
      }
      if (p.x < minX) minX = p.x; if (p.y < minY) minY = p.y; if (p.z < minZ) minZ = p.z;
      if (p.x > maxX) maxX = p.x; if (p.y > maxY) maxY = p.y; if (p.z > maxZ) maxZ = p.z;
    }
    this.geo.attributes.position.needsUpdate = true;
    this.geo.attributes.normal.needsUpdate = true;
    this.geo.setDrawRange(0, (n - 1) * R * 6);
    if (!this.geo.boundingSphere) this.geo.boundingSphere = new T.Sphere();
    const bs = this.geo.boundingSphere;
    bs.center.set((minX + maxX) / 2, (minY + maxY) / 2, (minZ + maxZ) / 2);
    bs.radius = Math.hypot(maxX - minX, maxY - minY, maxZ - minZ) / 2 + r;
    if (!this.geo.boundingBox) this.geo.boundingBox = new T.Box3();
    this.geo.boundingBox.min.set(minX - r, minY - r, minZ - r);
    this.geo.boundingBox.max.set(maxX + r, maxY + r, maxZ + r);
  };

  // Points along a polyline made of straight runs and arcs (for bent component leads).
  function leadPath(segments, step) {
    const out = [];
    segments.forEach(s => {
      if (s.arc) {
        const { c, r, a0, a1 } = s;          // arc in the XY plane around c
        const n = Math.max(4, Math.ceil(Math.abs(a1 - a0) * r / (step || 0.25)));
        for (let i = 0; i <= n; i++) {
          const a = a0 + (a1 - a0) * i / n;
          out.push(V3(c[0] + Math.cos(a) * r, c[1] + Math.sin(a) * r, c[2]));
        }
      } else {
        const n = Math.max(1, Math.ceil(s.from.distanceTo(s.to) / (step || 1.0)));
        for (let i = 0; i <= n; i++) out.push(s.from.clone().lerp(s.to, i / n));
      }
    });
    return out.filter((p, i) => i === 0 || p.distanceToSquared(out[i - 1]) > 1e-8);
  }

  // ------------------------------------------------------------------ canvas helpers
  // text in mm on a canvas that is scaled by k px/mm (drawn unscaled for crisp small sizes)
  function text(ctx, k, str, x, y, size, o) {
    o = o || {};
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = o.color || '#FFFFFF';
    ctx.font = (o.weight || 600) + ' ' + (size * k).toFixed(2) + 'px ' + (o.font || UI_FONT);
    if (o.spacing !== undefined && 'letterSpacing' in ctx) ctx.letterSpacing = (o.spacing * k).toFixed(2) + 'px';
    ctx.textBaseline = 'alphabetic';
    ctx.textAlign = 'left';
    const m = ctx.measureText(str);
    const w = m.actualBoundingBoxRight + m.actualBoundingBoxLeft;
    let px = x * k, py = y * k;
    const align = o.align || 'left';
    if (align === 'center') px -= (m.actualBoundingBoxRight - m.actualBoundingBoxLeft) / 2;
    else if (align === 'right') px -= m.actualBoundingBoxRight;
    else px += m.actualBoundingBoxLeft;
    const vb = o.baseline || 'middle';
    if (vb === 'middle') py -= (m.actualBoundingBoxDescent - m.actualBoundingBoxAscent) / 2;
    else if (vb === 'top') py += m.actualBoundingBoxAscent;
    if (o.rotate) {
      ctx.translate(x * k, y * k);
      ctx.rotate(o.rotate);
      ctx.translate(-x * k, -y * k);
    }
    if (o.shadow) { ctx.shadowColor = o.shadow; ctx.shadowBlur = (o.shadowBlur || 0.2) * k; }
    ctx.fillText(str, px, py);
    ctx.restore();
    return w / k;
  }
  function rrPath(ctx, x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }
  function noiseSpeckle(ctx, w, h, k, amount, seed) {
    // fine deterministic speckle so large printed areas do not look like flat CG colour
    const img = ctx.getImageData(0, 0, w, h);
    const d = img.data;
    let s = seed || 1;
    for (let i = 0; i < d.length; i += 4) {
      s = (s * 1664525 + 1013904223) >>> 0;
      const n = ((s >>> 24) / 255 - 0.5) * amount;
      d[i] = MC.clamp(d[i] + n, 0, 255); d[i + 1] = MC.clamp(d[i + 1] + n, 0, 255); d[i + 2] = MC.clamp(d[i + 2] + n, 0, 255);
    }
    ctx.putImageData(img, 0, 0);
  }

  // ==================================================================================== WIRES
  // End templates in end-local space: origin = male pin tip / female opening, +Z toward the cable.
  const endTemplates = {};
  function endTemplate(kind) {
    if (endTemplates[kind]) return endTemplates[kind];
    const mb = new MB();
    const K = palUV(PAL.black), G = palUV(PAL.gold), H = palUV(PAL.hole), S = palUV(PAL.tin);
    const hw = DP.W / 2, oct = chamferPoly(hw, hw, 0.22);
    if (kind === 'male') {
      const a = DP.PIN_W / 2;
      mb.frustum(0.12, a, 0, 0.55, G, true);                         // pointed tip
      mb.prism(rectPoly(a, a), 0.55, DP.PIN + 0.8, G, false, false);   // pin
      mb.prism(oct, DP.PIN, DP.PIN + DP.HOUSING, K, true, true);       // housing
      const y = hw + 0.004;                                            // latch window on the +Y face
      mb.quad([-0.55, y, DP.PIN + 6.2], [0.55, y, DP.PIN + 6.2], [0.55, y, DP.PIN + 3.0], [-0.55, y, DP.PIN + 3.0], H);
      mb.quad([-0.36, y + 0.003, DP.PIN + 5.8], [0.36, y + 0.003, DP.PIN + 5.8], [0.36, y + 0.003, DP.PIN + 3.4], [-0.36, y + 0.003, DP.PIN + 3.4], S);
    } else if (kind === 'female') {
      mb.prism(oct, 0, DP.HOUSING, K, true, true);
      const z = -0.004, o = 0.5;                                        // square opening, contact visible inside
      mb.quad([o, -o, z], [-o, -o, z], [-o, o, z], [o, o, z], H);
      mb.quad([0.3, -0.46, z - 0.003], [-0.3, -0.46, z - 0.003], [-0.3, -0.3, z - 0.003], [0.3, -0.3, z - 0.003], G);
      const y = hw + 0.004;
      mb.quad([-0.5, y, 5.6], [0.5, y, 5.6], [0.5, y, 2.4], [-0.5, y, 2.4], H);
      mb.quad([-0.32, y + 0.003, 5.2], [0.32, y + 0.003, 5.2], [0.32, y + 0.003, 2.8], [-0.32, y + 0.003, 2.8], S);
    }
    const tpl = {
      pos: new Float32Array(mb.p), nor: new Float32Array(mb.n), uv: new Float32Array(mb.u), idx: mb.ix,
      count: mb.p.length / 3,
      length: kind === 'male' ? DP.PIN + DP.HOUSING : kind === 'female' ? DP.HOUSING : 0
    };
    endTemplates[kind] = tpl;
    return tpl;
  }

  // Jumper wire. o: { points:[Vector3...], color, endA, endB:'male'|'female'|'none', net, id,
  //   seatA, seatB (mm the plug is pushed into its mate along the end axis, default 0),
  //   dirA, dirB (optional exit directions, otherwise taken from the first/last segment),
  //   radius (0.8), roll (Vector3 hint for the plug's latch side) }
  // points live in the space of the group's parent (usually world). points[0] is the tip of a
  // male pin or the opening of a female housing; the first segment gives the plug axis, so
  // make points[1] lie along the pin's exit direction (e.g. p + d * 20).
  parts.wire = function (o) {
    const endA = o.endA || 'male', endB = o.endB || 'male';
    const r = o.radius || 0.8;
    const group = new T.Group();
    group.name = 'wire' + (o.id ? ':' + o.id : '');
    const tube = new Tube(o.radial || 9);
    const insul = MC.mat.wire(o.color || '#888888');
    const tubeMesh = new T.Mesh(tube.geo, insul);
    tubeMesh.name = 'insulation';
    const ta = endTemplate(endA), tb = endTemplate(endB);
    const eg = new T.BufferGeometry();
    const nv = ta.count + tb.count;
    const epos = new Float32Array(nv * 3), enor = new Float32Array(nv * 3), euv = new Float32Array(nv * 2);
    euv.set(ta.uv, 0); euv.set(tb.uv, ta.count * 2);
    eg.setAttribute('position', new T.BufferAttribute(epos, 3));
    eg.setAttribute('normal', new T.BufferAttribute(enor, 3));
    eg.setAttribute('uv', new T.BufferAttribute(euv, 2));
    eg.setIndex(ta.idx.concat(tb.idx.map(i => i + ta.count)));
    const endsMesh = new T.Mesh(eg, palMaterial());
    endsMesh.name = 'plugs';
    group.add(tubeMesh, endsMesh);
    const ud = { net: o.net || null, wire: true, wireId: o.id || null };
    tag(group, null, ud);
    tubeMesh.receiveShadow = false;

    const st = { curve: null, length: 0, tipA: V3(), tipB: V3(), axisA: V3(), axisB: V3() };
    const pool = [];
    const poolAt = i => pool[i] || (pool[i] = V3());
    const tmpX = V3(), tmpY = V3();
    function frame(axis) {
      // y = latch side: roll hint or world up, projected perpendicular to the axis
      const ref = o.roll || (Math.abs(axis.y) > 0.9 ? V3(0, 0, 1) : UP);
      tmpY.copy(ref).addScaledVector(axis, -ref.dot(axis)).normalize();
      tmpX.crossVectors(tmpY, axis).normalize();
    }
    function writeEnd(tpl, offset, tip, axis) {
      if (!tpl.count) return;
      frame(axis);
      const X = tmpX, Y = tmpY, Z = axis;
      for (let i = 0; i < tpl.count; i++) {
        const px = tpl.pos[i * 3], py = tpl.pos[i * 3 + 1], pz = tpl.pos[i * 3 + 2];
        const nx = tpl.nor[i * 3], ny = tpl.nor[i * 3 + 1], nz = tpl.nor[i * 3 + 2];
        const k = (offset + i) * 3;
        epos[k] = tip.x + X.x * px + Y.x * py + Z.x * pz;
        epos[k + 1] = tip.y + X.y * px + Y.y * py + Z.y * pz;
        epos[k + 2] = tip.z + X.z * px + Y.z * py + Z.z * pz;
        enor[k] = X.x * nx + Y.x * ny + Z.x * nz;
        enor[k + 1] = X.y * nx + Y.y * ny + Z.y * nz;
        enor[k + 2] = X.z * nx + Y.z * ny + Z.z * nz;
      }
    }
    function axisFrom(points, fromEnd, dir) {
      if (dir) return dir.clone().normalize();
      const n = points.length, p0 = fromEnd ? points[n - 1] : points[0];
      for (let i = 1; i < n; i++) {
        const q = fromEnd ? points[n - 1 - i] : points[i];
        if (q.distanceTo(p0) > 1.0) return q.clone().sub(p0).normalize();
      }
      return UP.clone();
    }
    function update(points, dirA, dirB) {
      if (!points || points.length < 2) return;
      points = points.map(toV3);
      if (dirA) dirA = toV3(dirA);
      if (dirB) dirB = toV3(dirB);
      const n = points.length;
      const aA = axisFrom(points, false, dirA || (o.dirA ? toV3(o.dirA) : null));
      const aB = axisFrom(points, true, dirB || (o.dirB ? toV3(o.dirB) : null));
      const tipA = points[0].clone().addScaledVector(aA, -(o.seatA || 0));
      const tipB = points[n - 1].clone().addScaledVector(aB, -(o.seatB || 0));
      const backA = tipA.clone().addScaledVector(aA, ta.length), backB = tipB.clone().addScaledVector(aB, tb.length);
      const lead = 3.5;
      const inA = ta.length ? -1.2 : 0, inB = tb.length ? -1.2 : 0;
      const ctrl = [backA.clone().addScaledVector(aA, inA), backA.clone().addScaledVector(aA, lead * 0.5), backA.clone().addScaledVector(aA, lead)];
      const keepA = ta.length + lead + 1.5, keepB = tb.length + lead + 1.5;
      for (let i = 1; i < n - 1; i++) {
        const q = points[i];
        if (q.distanceTo(tipA) > keepA && q.distanceTo(tipB) > keepB) ctrl.push(q);
      }
      ctrl.push(backB.clone().addScaledVector(aB, lead), backB.clone().addScaledVector(aB, lead * 0.5), backB.clone().addScaledVector(aB, inB));
      const curve = new T.CatmullRomCurve3(ctrl, false, 'centripetal');
      // sample every control span in proportion to its length (no arc-length tables: this runs
      // for every wire on every frame while the explode slider moves)
      const l = ctrl.length;
      let total = 0;
      for (let j = 1; j < l; j++) total += ctrl[j].distanceTo(ctrl[j - 1]);
      const step = Math.max(1.25, total / 320);
      let k = 0, len = 0;
      for (let j = 0; j < l - 1; j++) {
        const n = Math.max(1, Math.ceil(ctrl[j].distanceTo(ctrl[j + 1]) / step));
        for (let q = 0; q < n; q++) curve.getPoint((j + q / n) / (l - 1), poolAt(k++));
      }
      curve.getPoint(1, poolAt(k++));
      for (let j = 1; j < k; j++) len += pool[j].distanceTo(pool[j - 1]);
      frame(aA);
      tube.set(pool, r, tmpY, k);
      writeEnd(ta, 0, tipA, aA);
      writeEnd(tb, ta.count, tipB, aB);
      eg.attributes.position.needsUpdate = true;
      eg.attributes.normal.needsUpdate = true;
      eg.computeBoundingSphere();
      st.curve = curve; st.length = len;
      st.tipA.copy(tipA); st.tipB.copy(tipB); st.axisA.copy(aA); st.axisB.copy(aB);
    }
    update(o.points, o.dirA, o.dirB);
    return {
      group, tube: tubeMesh, ends: endsMesh, update,
      net: o.net || null, id: o.id || null,
      curve: () => st.curve, length: () => st.length, state: st,
      dispose() { tube.geo.dispose(); eg.dispose(); insul.dispose(); endsMesh.material.dispose(); }
    };
  };

  // Ribbon bundle: n jumpers that run side by side in the middle and fan out at both ends.
  // o: { paths:[[Vector3...] x n], colors:[..], nets:[..], ids:[..], endA, endB (string or array),
  //      seatA, seatB, fan (mm of free wire at each end, default 26), blend (mm, default 22), pitch }
  parts.ribbon = function (o) {
    const n = o.paths.length;
    const pick = (v, i) => (Array.isArray(v) ? v[i] : v);
    const pitch = o.pitch || ((o.radius || 0.8) * 2 + 0.06);
    const group = new T.Group();
    group.name = 'ribbon';
    o.paths = o.paths.map(p => p.map(toV3));
    const wires = o.paths.map((p, i) => parts.wire({
      points: p, color: pick(o.colors, i), net: pick(o.nets, i), id: pick(o.ids, i),
      endA: pick(o.endA, i), endB: pick(o.endB, i), seatA: pick(o.seatA, i), seatB: pick(o.seatB, i), radius: o.radius
    }));
    wires.forEach(w => group.add(w.group));
    const M = 72;
    function bundle(paths) {
      const samples = paths.map(p => {
        const c = new T.CatmullRomCurve3(p, false, 'centripetal');
        return c.getSpacedPoints(M);
      });
      const C = [];
      for (let k = 0; k <= M; k++) {
        const c = V3();
        samples.forEach(s => c.add(s[k]));
        C.push(c.multiplyScalar(1 / n));
      }
      const arc = [0];
      for (let k = 1; k <= M; k++) arc.push(arc[k - 1] + C[k].distanceTo(C[k - 1]));
      const L = arc[M];
      // side axis from the spread at end A, transported along the centre line
      const side = [];
      let s = samples[n - 1][0].clone().sub(samples[0][0]);
      const t = V3();
      for (let k = 0; k <= M; k++) {
        t.subVectors(C[Math.min(M, k + 1)], C[Math.max(0, k - 1)]).normalize();
        s.addScaledVector(t, -s.dot(t));
        if (s.lengthSq() < 1e-8) s.set(1, 0, 0).addScaledVector(t, -t.x);
        s.normalize();
        side.push(s.clone());
      }
      const fan = o.fan || 26, blend = o.blend || 22;
      return paths.map((p, i) => {
        const off = (i - (n - 1) / 2) * pitch;
        const out = [];
        for (let k = 0; k <= M; k++) {
          const w = smooth(fan, fan + blend, arc[k]) * smooth(fan, fan + blend, L - arc[k]);
          const target = C[k].clone().addScaledVector(side[k], off);
          out.push(samples[i][k].clone().lerp(target, w));
        }
        out[0].copy(p[0]); out[M].copy(p[p.length - 1]);
        return out;
      });
    }
    function update(paths) {
      paths = paths.map(p => p.map(toV3));
      const b = bundle(paths);
      wires.forEach((w, i) => w.update(b[i], paths[i].length > 1 ? paths[i][1].clone().sub(paths[i][0]) : null,
        paths[i].length > 1 ? paths[i][paths[i].length - 2].clone().sub(paths[i][paths[i].length - 1]) : null));
    }
    update(o.paths);
    return { group, wires, update };
  };

  // ==================================================================================== HEADERS
  // header(n, kind): 'male' | 'female' | 'male90'. Origin at the PCB top under the middle of the
  // row, pins along +X (pin 1 at -X), mating side +Y ('male90': mating pins along +Z).
  // pins['1'..n]: male = pin tip, female = top of the opening; d = mating direction.
  parts.header = function (n, kind, opts) {
    opts = opts || {};
    kind = kind || 'male';
    const mb = new MB();
    const K = palUV(PAL.black), G = palUV(opts.tin ? PAL.tin : PAL.gold), H = palUV(PAL.hole);
    const pins = {};
    const a = DP.PIN_W / 2, x0 = -(n - 1) * PITCH / 2;
    const tail = opts.tail === undefined ? 3.0 : opts.tail;
    const len = opts.length || 6.0;
    const down = new T.Matrix4().makeRotationX(Math.PI / 2);    // +Z -> -Y
    const up = new T.Matrix4().makeRotationX(-Math.PI / 2);     // +Z -> +Y
    const at = (x, y, z, r) => { const m = new T.Matrix4().makeTranslation(x, y, z); if (r) m.multiply(r); return m; };
    for (let i = 0; i < n; i++) {
      const x = x0 + i * PITCH;
      if (kind === 'female') {
        const h = opts.height || 8.5;
        mb.setMatrix(at(x, 0, 0));
        mb.box(-PITCH / 2 + 0.02, 0, -PITCH / 2, PITCH / 2 - 0.02, h, PITCH / 2, K);
        const y = h + 0.004;
        mb.quad([-0.5, y, 0.5], [0.5, y, 0.5], [0.5, y, -0.5], [-0.5, y, -0.5], H);
        mb.quad([-0.3, y + 0.002, 0.46], [0.3, y + 0.002, 0.46], [0.3, y + 0.002, 0.3], [-0.3, y + 0.002, 0.3], G);
        if (tail > 0) { mb.setMatrix(at(x, 0, 0, down)); mb.prism(rectPoly(a * 0.8, a * 0.8), 0, tail, G, false, true); }
        pins[String(i + 1)] = { p: V3(x, h, 0), d: V3(0, 1, 0) };
      } else if (kind === 'male90') {
        const yc = PITCH / 2, zb = -PITCH / 2 - 1.1;
        mb.setMatrix(at(x, 0, 0));
        mb.box(-PITCH / 2 + 0.06, 0, -PITCH / 2, PITCH / 2 - 0.06, PITCH, PITCH / 2, K);
        mb.setMatrix(at(x, yc, 0));
        mb.prism(rectPoly(a, a), zb, PITCH / 2 + len - 0.5, G, true, false);
        mb.setMatrix(at(x, yc, PITCH / 2 + len - 0.5));
        mb.frustum(a, 0.13, 0, 0.5, G, false, true);
        if (tail > 0) { mb.setMatrix(at(x, yc + a, zb + a, down)); mb.prism(rectPoly(a, a), 0, yc + a + tail, G, false, true); }
        pins[String(i + 1)] = { p: V3(x, yc, PITCH / 2 + len), d: V3(0, 0, 1) };
      } else {
        const base = 2.5;
        mb.setMatrix(at(x, 0, 0, up));
        mb.prism(chamferPoly(PITCH / 2 - 0.05, PITCH / 2, 0.3), 0, base, K, true, true);
        mb.prism(rectPoly(a, a), -tail, base + len - 0.5, G, true, false);
        mb.setMatrix(at(x, base + len - 0.5, 0, up));
        mb.frustum(a, 0.13, 0, 0.5, G, false, true);
        pins[String(i + 1)] = { p: V3(x, base + len, 0), d: V3(0, 1, 0) };
      }
    }
    mb.setMatrix(null);
    const mesh = new T.Mesh(mb.geometry(), palMaterial());
    mesh.name = 'header_' + kind + '_' + n;
    const group = new T.Group();
    group.add(mesh);
    tag(group, opts.part || null);
    const size = kind === 'female' ? [n * PITCH, opts.height || 8.5, PITCH] : kind === 'male90' ? [n * PITCH, PITCH, PITCH + len] : [n * PITCH, 2.5 + len, PITCH];
    return { group, pins, size, extra: { mesh } };
  };

  // ==================================================================================== KEYPAD
  const KEY_ROWS = ['123A', '456B', '789C', '*0#D'];
  const KEY_COLOURS = { digit: '#2556B9', func: '#C9323A' };   // the common part: blue digit keys, red A-D * #
  const isFunc = ch => 'ABCD*#'.indexOf(ch) >= 0;
  function keyCentre(r, c) {
    return [(c - 1.5) * KP.PX, (r - 1.5) * KP.PZ];
  }
  function keypadTexture() {
    const k = 19, W = KP.W, H = KP.H;
    return MC.tex.canvas(Math.round(W * k), Math.round(H * k), (ctx, w, h) => {
      ctx.fillStyle = '#0F1013';
      ctx.fillRect(0, 0, w, h);
      ctx.save();
      ctx.scale(k, k);
      // faint printed frame around the key matrix
      ctx.strokeStyle = 'rgba(255,255,255,0.045)';
      ctx.lineWidth = 0.18;
      rrPath(ctx, 1.6, 1.6, W - 3.2, H - 3.2, 1.2);
      ctx.stroke();
      for (let r = 0; r < 4; r++) {
        for (let c = 0; c < 4; c++) {
          const ch = KEY_ROWS[r][c];
          const [kx, kz] = keyCentre(r, c);
          const x = kx + W / 2 - KP.KEY / 2, y = kz + H / 2 - KP.KEY / 2;
          const base = isFunc(ch) ? KEY_COLOURS.func : KEY_COLOURS.digit;
          // soft print shadow ring (the key field is embossed, the ink thins at the edge)
          ctx.fillStyle = 'rgba(0,0,0,0.35)';
          rrPath(ctx, x - 0.25, y - 0.25, KP.KEY + 0.5, KP.KEY + 0.5, KP.KEY_R + 0.25);
          ctx.fill();
          const g = ctx.createLinearGradient(0, y, 0, y + KP.KEY);
          g.addColorStop(0, MC.tex.shade(base, 0.05));
          g.addColorStop(1, MC.tex.shade(base, -0.05));
          ctx.fillStyle = g;
          rrPath(ctx, x, y, KP.KEY, KP.KEY, KP.KEY_R);
          ctx.fill();
        }
      }
      ctx.restore();
      for (let r = 0; r < 4; r++) {
        for (let c = 0; c < 4; c++) {
          const ch = KEY_ROWS[r][c];
          const [kx, kz] = keyCentre(r, c);
          const size = ch === '*' ? 9.6 : ch === '#' ? 6.4 : 6.6;
          text(ctx, k, ch, kx + W / 2, kz + H / 2 + (ch === '*' ? 1.0 : 0), size, { weight: 700, color: '#F7F8FA', align: 'center', font: '"Helvetica Neue", Arial, "Segoe UI", sans-serif' });
        }
      }
      noiseSpeckle(ctx, w, h, k, 5, 7);
    });
  }
  // tail texture: clear film with 8 printed silver conductors (u across, v along)
  let tailTex = null;
  function tailTextures() {
    if (tailTex) return tailTex;
    const k = 16, W = KP.TAIL_W, L = 32;
    const map = MC.tex.canvas(Math.round(W * k), Math.round(L * k), (ctx, w, h) => {
      ctx.clearRect(0, 0, w, h);
      ctx.fillStyle = 'rgba(214,220,226,0.34)';
      ctx.fillRect(0, 0, w, h);
      ctx.fillStyle = 'rgba(232,236,240,0.55)';
      ctx.fillRect(0, 0, 0.5 * k, h); ctx.fillRect(w - 0.5 * k, 0, 0.5 * k, h);
      for (let i = 0; i < 8; i++) {
        const x = (W / 2 + (i - 3.5) * PITCH) * k;
        ctx.fillStyle = 'rgba(196,201,207,1)';
        ctx.fillRect(x - 0.6 * k, 0, 1.2 * k, h);
        ctx.fillStyle = 'rgba(232,235,238,0.9)';
        ctx.fillRect(x - 0.2 * k, 0, 0.25 * k, h);
      }
    }, { repeat: [1, 1] });
    map.wrapS = T.ClampToEdgeWrapping;
    const metal = MC.tex.canvas(64, 16, (ctx, w, h) => {
      ctx.fillStyle = 'rgb(0,80,0)';         // film: rough 0.31, metal 0
      ctx.fillRect(0, 0, w, h);
      for (let i = 0; i < 8; i++) {
        const x = (W / 2 + (i - 3.5) * PITCH) / W * w;
        ctx.fillStyle = 'rgb(255,120,205)';   // silver ink: rough 0.47, metal 0.8
        ctx.fillRect(x - 0.6 / W * w, 0, 1.2 / W * w, h);
      }
    }, { srgb: false });
    tailTex = { map, metal };
    return tailTex;
  }
  // key field: pillow-shaped rounded square, UVs into the overlay texture
  function keyGeometry(cx, cz) {
    const s = KP.KEY, r = KP.KEY_R, seg = 7;
    const insets = [0, 0.25, 0.55, 0.9, 1.3, 1.75, 2.25, 2.8];
    // corner radius grows inward so the pillow has no creases at the corners
    const rings = insets.map(d => roundRect(s - 2 * d, s - 2 * d, Math.min(s / 2 - d - 0.3, r + d * 0.55), seg));
    const n = rings[0].length;
    const P = [], U = [], I = [];
    const uv = (x, z) => [(x + cx + KP.W / 2) / KP.W, 1 - (z + cz + KP.H / 2) / KP.H];
    const hOf = d => KP.EMBOSS * smooth(0, insets[insets.length - 1], d);
    rings.forEach((ring, k) => ring.forEach(p => { P.push(p[0], hOf(insets[k]), p[1]); U.push(...uv(p[0], p[1])); }));
    const centre = P.length / 3;
    P.push(0, KP.EMBOSS, 0); U.push(...uv(0, 0));
    for (let k = 0; k < rings.length - 1; k++) {
      for (let i = 0; i < n; i++) {
        const j = (i + 1) % n;
        const a = k * n + i, b = k * n + j, c = (k + 1) * n + j, d = (k + 1) * n + i;
        I.push(a, c, b, a, d, c);
      }
    }
    const last = (rings.length - 1) * n;
    for (let i = 0; i < n; i++) I.push(last + i, centre, last + (i + 1) % n);
    const g = new T.BufferGeometry();
    g.setAttribute('position', new T.Float32BufferAttribute(P, 3));
    g.setAttribute('uv', new T.Float32BufferAttribute(U, 2));
    g.setIndex(I);
    g.computeVertexNormals();
    // keep the rim normals exactly up so the key blends into the overlay
    const nor = g.attributes.normal;
    for (let i = 0; i < n; i++) nor.setXYZ(i, 0, 1, 0);
    return g;
  }
  function connectorTemplate() {
    const mb = new MB();
    const K = palUV(PAL.black), H = palUV(PAL.hole), G = palUV(PAL.gold), S = palUV(PAL.tin);
    const hw = KP.CONN_W / 2, ht = KP.CONN_T / 2, L = KP.CONN_L;
    mb.prism(chamferPoly(hw, ht, 0.25), -L, 0, K, true, true);
    for (let i = 0; i < 8; i++) {
      const x = (3.5 - i) * PITCH;   // P1 at +X (index 0)
      const z = 0.004, o = 0.5;
      mb.quad([x - o, -o, z], [x + o, -o, z], [x + o, o, z], [x - o, o, z], H);
      mb.quad([x - 0.3, -0.46, z + 0.003], [x + 0.3, -0.46, z + 0.003], [x + 0.3, -0.3, z + 0.003], [x - 0.3, -0.3, z + 0.003], G);
      // crimp claws pressed through the film, visible on the top face near the back
      const y = ht + 0.004;
      mb.quad([x - 0.55, y, -L + 3.6], [x + 0.55, y, -L + 3.6], [x + 0.55, y, -L + 0.9], [x - 0.55, y, -L + 0.9], S);
    }
    // pin 1 mark: small triangle moulded on the top face
    const y = ht + 0.006, xm = 3.5 * PITCH;
    mb.fan([[xm, y, -1.6], [xm - 0.7, y, -2.9], [xm + 0.7, y, -2.9]].reverse(), palUV(PAL.white));
    return mb;
  }

  parts.keypad = function (opts) {
    opts = opts || {};
    const group = new T.Group();
    group.name = 'keypad';
    const W = KP.W, H = KP.H;
    // lower layers: adhesive + spacer + circuit sheet (milky white edge)
    const lower = new T.Mesh(slab({ outline: roundRect(W - 0.3, H - 0.3, KP.R - 0.15, 6), t: 0.42, bevelTop: 0, bevelBottom: 0.08, seg: 2 }),
      new T.MeshPhysicalMaterial({ color: '#D9DDE0', roughness: 0.62, sheen: 0.3, sheenRoughness: 0.8, sheenColor: new T.Color('#FFFFFF') }));
    lower.name = 'layers';
    group.add(lower);
    // printed overlay
    const map = keypadTexture();
    const overlayGeo = slab({
      outline: roundRect(W, H, KP.R, 6), t: KP.T - 0.42, bevelTop: 0.14, bevelBottom: 0, seg: 2,
      uvTop: (x, z) => [(x + W / 2) / W, 1 - (z + H / 2) / H], sideUV: [0.003, 0.997], capBottom: false
    });
    overlayGeo.translate(0, 0.42, 0);
    const overlayMat = MC.mat.membrane(map);
    overlayMat.roughness = 0.42;
    overlayMat.clearcoat = 0.55;
    overlayMat.clearcoatRoughness = 0.32;
    const overlay = new T.Mesh(overlayGeo, overlayMat);
    overlay.name = 'overlay';
    group.add(overlay);
    // embossed keys
    const keys = {};
    for (let r = 0; r < 4; r++) {
      for (let c = 0; c < 4; c++) {
        const ch = KEY_ROWS[r][c];
        const [kx, kz] = keyCentre(r, c);
        const m = MC.mat.membrane(map);
        m.roughness = 0.4;
        m.clearcoat = 0.5;
        m.clearcoatRoughness = 0.3;
        m.polygonOffset = true; m.polygonOffsetFactor = -1; m.polygonOffsetUnits = -1;
        const mesh = new T.Mesh(keyGeometry(kx, kz), m);
        mesh.position.set(kx, KP.T + 0.003, kz);
        mesh.name = 'key_' + ch;
        mesh.userData.key = ch;
        mesh.userData.baseY = mesh.position.y;
        keys[ch] = mesh;
        group.add(mesh);
      }
    }
    // tail: clear film with silver conductors, rebuilt by setTailPath
    const tt = tailTextures();
    const tailMat = new T.MeshStandardMaterial({
      map: tt.map, transparent: true, side: T.DoubleSide, roughness: 1, metalness: 1,
      roughnessMap: tt.metal, metalnessMap: tt.metal, depthWrite: false
    });
    const SEG = 120;
    const tailGeo = new T.BufferGeometry();
    const tpos = new Float32Array((SEG + 1) * 2 * 3), tnor = new Float32Array((SEG + 1) * 2 * 3), tuv = new Float32Array((SEG + 1) * 2 * 2);
    const tix = [];
    for (let i = 0; i < SEG; i++) { const a = i * 2; tix.push(a, a + 2, a + 1, a + 1, a + 2, a + 3); }
    tailGeo.setAttribute('position', new T.BufferAttribute(tpos, 3));
    tailGeo.setAttribute('normal', new T.BufferAttribute(tnor, 3));
    tailGeo.setAttribute('uv', new T.BufferAttribute(tuv, 2));
    tailGeo.setIndex(tix);
    const tail = new T.Mesh(tailGeo, tailMat);
    tail.name = 'tail';
    tail.renderOrder = 2;
    group.add(tail);
    // connector (geometry in connector space, placed by setTailPath)
    const connTpl = connectorTemplate();
    const connGeo = connTpl.geometry();
    const connector = new T.Mesh(connGeo, palMaterial());
    connector.name = 'connector';
    group.add(connector);

    const pins = {};
    for (let i = 1; i <= 8; i++) pins['P' + i] = { p: V3(), d: V3(0, 0, 1) };
    const rootZ = H / 2 - 5;
    const tailY = 0.21;

    // points: Vector3[] in the keypad's local frame, from the tail root at the bottom edge
    // (0, ~0.2, ~33.5) to the FRONT FACE of the connector (where the jumpers plug in). The film
    // is a flat strip whose width stays along local +X (or opts.widthAxis), optionally turning
    // to opts.endWidthAxis at the connector. Pins P1..P8 are updated in place.
    function setTailPath(points, o2) {
      o2 = o2 || {};
      points = points.map(toV3);
      if (o2.widthAxis) o2.widthAxis = toV3(o2.widthAxis);
      if (o2.endWidthAxis) o2.endWidthAxis = toV3(o2.endWidthAxis);
      const curve = new T.CatmullRomCurve3(points.map(p => p.clone()), false, 'centripetal');
      curve.arcLengthDivisions = 300;
      const L = curve.getLength();
      const filmL = Math.max(1, L - KP.CONN_L + 1.5);   // film runs 1.5 mm into the connector
      const w0 = (o2.widthAxis || V3(1, 0, 0)).clone().normalize();
      const w1 = (o2.endWidthAxis || w0).clone().normalize();
      const t = V3(), w = V3(), nrm = V3(), c = V3();
      for (let i = 0; i <= SEG; i++) {
        const s = (i / SEG) * filmL;
        const u = curve.getUtoTmapping(s / L);
        curve.getPoint(u, c);
        curve.getTangent(u, t).normalize();
        w.copy(w0).lerp(w1, smooth(0, 1, s / filmL)).normalize();
        w.addScaledVector(t, -w.dot(t)).normalize();
        nrm.crossVectors(t, w).normalize();
        const k = i * 6;
        for (let side = 0; side < 2; side++) {
          const sg = side ? 1 : -1;
          tpos[k + side * 3] = c.x + w.x * sg * KP.TAIL_W / 2;
          tpos[k + side * 3 + 1] = c.y + w.y * sg * KP.TAIL_W / 2;
          tpos[k + side * 3 + 2] = c.z + w.z * sg * KP.TAIL_W / 2;
          tnor[k + side * 3] = nrm.x; tnor[k + side * 3 + 1] = nrm.y; tnor[k + side * 3 + 2] = nrm.z;
          tuv[i * 4 + side * 2] = side;
          tuv[i * 4 + side * 2 + 1] = s / 32;
        }
      }
      tailGeo.attributes.position.needsUpdate = true;
      tailGeo.attributes.normal.needsUpdate = true;
      tailGeo.attributes.uv.needsUpdate = true;
      tailGeo.computeBoundingSphere();
      // connector at the end, openings facing along the end tangent
      const front = curve.getPoint(1);
      const te = curve.getTangent(1).normalize();
      const we = w1.clone().addScaledVector(te, -w1.dot(te)).normalize();
      const ne = V3().crossVectors(te, we).normalize();
      connector.matrixAutoUpdate = false;
      connector.matrix.makeBasis(we, ne, te).setPosition(front);
      connector.matrixWorldNeedsUpdate = true;
      for (let i = 1; i <= 8; i++) {
        pins['P' + i].p.copy(front).addScaledVector(we, (4.5 - i) * PITCH);
        pins['P' + i].d.copy(te);
      }
      MC.bus.emit('scene:dirty');
      return pins;
    }
    const defaultPath = () => [V3(0, tailY, rootZ), V3(0, tailY, H / 2 + KP.TAIL_L * 0.5), V3(0, tailY, H / 2 + KP.TAIL_L + KP.CONN_L)];
    setTailPath(defaultPath());

    // key press: 0.15 s, dome flattens and sinks slightly
    const anim = new Map();
    let raf = 0;
    function applyPress(mesh, p) {
      mesh.scale.y = 1 - 0.82 * p;
      mesh.position.y = mesh.userData.baseY - 0.05 * p;
      const m = mesh.material;
      if (!m.userData.baseColor) m.userData.baseColor = m.color.clone();
      m.color.copy(m.userData.baseColor).multiplyScalar(1 - 0.12 * p);
    }
    function step() {
      raf = 0;
      let active = false;
      const now = performance.now();   // not the rAF stamp: it can be older than the press
      anim.forEach((t0, ch) => {
        const t = Math.max(0, (now - t0) / 150);
        let p;
        if (t >= 1) { p = 0; anim.delete(ch); }
        else { p = t < 0.3 ? MC.ease(t / 0.3) : t < 0.45 ? 1 : 1 - MC.ease((t - 0.45) / 0.55); active = true; }
        applyPress(keys[ch], p);
      });
      MC.bus.emit('scene:dirty');
      if (active) raf = requestAnimationFrame(step);
    }
    function press(ch) {
      ch = String(ch).toUpperCase();
      if (!keys[ch]) return;
      anim.set(ch, performance.now());
      if (!raf) raf = requestAnimationFrame(step);
    }

    tag(group, 'keypad');
    tail.castShadow = false;
    Object.keys(keys).forEach(ch => { keys[ch].userData.key = ch; });
    return {
      group, pins, size: [W, KP.T, H],
      extra: {
        keys, press, tail, connector, overlay, setTailPath, defaultTailPath: defaultPath,
        isAnimating: () => anim.size > 0,
        tailLength: KP.TAIL_L, connectorLength: KP.CONN_L, tailRoot: V3(0, tailY, rootZ),
        layout: KEY_ROWS.slice()
      }
    };
  };

  // ==================================================================================== BREADBOARD
  const ROWS = 'abcdefghij';
  const colX = c => (c - (BB.COLS + 1) / 2) * PITCH;
  const rowZ = i => (i < 5 ? -3.81 - (4 - i) * PITCH : 3.81 + (i - 5) * PITCH);
  const RAILS = {
    rail_upper_outer: -BB.RAIL_OUT, rail_upper_inner: -BB.RAIL_IN,
    rail_lower_inner: BB.RAIL_IN, rail_lower_outer: BB.RAIL_OUT
  };
  const RAIL_POL = { rail_upper_outer: '+', rail_upper_inner: '-', rail_lower_inner: '-', rail_lower_outer: '+' };
  // rail holes: 25 per rail in groups of five, half a pitch off the terminal columns
  const railCols = [];
  for (let g = 0; g < 5; g++) for (let i = 0; i < 5; i++) railCols.push(1.5 + g * 6 + i);
  function railColFor(n) {
    if (railCols.indexOf(n + 0.5) >= 0) return n + 0.5;
    if (railCols.indexOf(n - 0.5) >= 0) return n - 0.5;
    let best = railCols[0];
    railCols.forEach(c => { if (Math.abs(c - n) < Math.abs(best - n)) best = c; });
    return best;
  }
  function holeLocal(name) {
    if (typeof name !== 'string') return null;
    let m = /^([a-j])([0-9]{1,2})$/.exec(name);
    if (m) {
      const c = +m[2];
      if (c < 1 || c > BB.COLS) return null;
      return V3(colX(c), BB.H, rowZ(ROWS.indexOf(m[1])));
    }
    m = /^(rail_upper_outer|rail_upper_inner|rail_lower_inner|rail_lower_outer|gnd_lower_inner):([0-9]{1,2})$/.exec(name);
    if (m) {
      const n = +m[2];
      if (n < 1 || n > BB.COLS) return null;
      const rail = m[1] === 'gnd_lower_inner' ? 'rail_lower_inner' : m[1];
      return V3(colX(railColFor(n)), BB.H, RAILS[rail]);
    }
    return null;
  }

  function breadboardTextures() {
    const k = 17, L = BB.L, D = BB.D;
    const W = Math.round(L * k), H = Math.round(D * k);
    const cx = x => x + L / 2, cy = z => z + D / 2;
    const terminal = [], rail = [];
    for (let c = 1; c <= BB.COLS; c++) for (let i = 0; i < 10; i++) terminal.push([colX(c), rowZ(i)]);
    Object.keys(RAILS).forEach(r => railCols.forEach(c => rail.push([colX(c), RAILS[r]])));
    const map = MC.tex.canvas(W, H, (ctx) => {
      ctx.fillStyle = '#F1EFE9';
      ctx.fillRect(0, 0, W, H);
      ctx.save();
      ctx.scale(k, k);
      // very soft moulding variation
      const g = ctx.createRadialGradient(L * 0.45, D * 0.4, 5, L / 2, D / 2, L * 0.7);
      g.addColorStop(0, 'rgba(255,255,255,0.25)');
      g.addColorStop(1, 'rgba(120,110,95,0.06)');
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, L, D);
      // channel: the floor sits in the shadow of its walls
      const cg = ctx.createLinearGradient(0, D / 2 - BB.CH_W / 2, 0, D / 2 + BB.CH_W / 2);
      cg.addColorStop(0, '#CFCBC3'); cg.addColorStop(0.5, '#DEDAD3'); cg.addColorStop(1, '#CFCBC3');
      ctx.fillStyle = cg;
      ctx.fillRect(0, D / 2 - BB.CH_W / 2, L, BB.CH_W);
      // rail lines: red outside the + rail, blue inside the - rail
      const line = (z, col) => { ctx.fillStyle = col; ctx.fillRect(cx(-37.4), cy(z) - 0.2, 74.8, 0.4); };
      line(-BB.RAIL_OUT - 2.05, '#D8383E'); line(BB.RAIL_OUT + 2.05, '#D8383E');
      line(-BB.RAIL_IN + 2.0, '#2F64C9'); line(BB.RAIL_IN - 2.0, '#2F64C9');
      const hole = (x, z, isRail) => {
        const X = cx(x), Y = cy(z);
        const og = ctx.createLinearGradient(X - 0.8, Y - 0.8, X + 0.8, Y + 0.8);
        og.addColorStop(0, '#D7D3CB'); og.addColorStop(1, '#E6E3DD');
        ctx.fillStyle = og;
        ctx.fillRect(X - 0.78, Y - 0.78, 1.56, 1.56);
        ctx.fillStyle = '#1B1C1F';
        ctx.fillRect(X - 0.47, Y - 0.47, 0.94, 0.94);
        // the spring contact just inside the opening
        ctx.fillStyle = 'rgba(160,166,173,0.8)';
        if (!isRail) { ctx.fillRect(X - 0.45, Y - 0.33, 0.13, 0.66); ctx.fillRect(X + 0.32, Y - 0.33, 0.13, 0.66); }
        else { ctx.fillRect(X - 0.33, Y - 0.45, 0.66, 0.13); ctx.fillRect(X - 0.33, Y + 0.32, 0.66, 0.13); }
        ctx.fillStyle = 'rgba(0,0,0,0.6)';
        ctx.fillRect(X - 0.26, Y - 0.26, 0.52, 0.52);
      };
      terminal.forEach(p => hole(p[0], p[1], false));
      rail.forEach(p => hole(p[0], p[1], true));
      ctx.restore();
      // printed numbers and letters
      const ink = '#4B5059';
      [1, 5, 10, 15, 20, 25, 30].forEach(c => {
        text(ctx, k, String(c), cx(colX(c)), cy(-16.55), 1.45, { color: ink, weight: 500, align: 'center' });
        text(ctx, k, String(c), cx(colX(c)), cy(16.55), 1.45, { color: ink, weight: 500, align: 'center' });
      });
      for (let i = 0; i < 10; i++) {
        text(ctx, k, ROWS[i], cx(-39.4), cy(rowZ(i)), 1.5, { color: ink, weight: 500, align: 'center' });
        text(ctx, k, ROWS[i], cx(39.4), cy(rowZ(i)), 1.5, { color: ink, weight: 500, align: 'center' });
      }
      Object.keys(RAILS).forEach(r => {
        const pol = RAIL_POL[r], col = pol === '+' ? '#D8383E' : '#2F64C9';
        const sym = pol === '+' ? '+' : '\u2212';
        text(ctx, k, sym, cx(-38.7), cy(RAILS[r]), 2.2, { color: col, weight: 700, align: 'center' });
        text(ctx, k, sym, cx(38.7), cy(RAILS[r]), 2.2, { color: col, weight: 700, align: 'center' });
      });
    });
    // normal map: chamfered funnels around every hole (four flat faces each)
    const enc = (x, y, z) => 'rgb(' + Math.round((x * 0.5 + 0.5) * 255) + ',' + Math.round((y * 0.5 + 0.5) * 255) + ',' + Math.round((z * 0.5 + 0.5) * 255) + ')';
    const sa = Math.sin(0.72), ca = Math.cos(0.72);
    const nmap = MC.tex.canvas(W, H, (ctx) => {
      ctx.fillStyle = enc(0, 0, 1);
      ctx.fillRect(0, 0, W, H);
      ctx.save();
      ctx.scale(k, k);
      const a = 0.78, b = 0.47;
      const poly = (pts, col) => { ctx.fillStyle = col; ctx.beginPath(); pts.forEach((p, i) => (i ? ctx.lineTo(p[0], p[1]) : ctx.moveTo(p[0], p[1]))); ctx.closePath(); ctx.fill(); };
      const funnel = (x, z) => {
        const X = cx(x), Y = cy(z);
        poly([[X - a, Y - a], [X - b, Y - b], [X - b, Y + b], [X - a, Y + a]], enc(sa, 0, ca));     // left face
        poly([[X + a, Y - a], [X + a, Y + a], [X + b, Y + b], [X + b, Y - b]], enc(-sa, 0, ca));    // right face
        poly([[X - a, Y - a], [X + a, Y - a], [X + b, Y - b], [X - b, Y - b]], enc(0, -sa, ca));    // upper face (canvas)
        poly([[X - a, Y + a], [X - b, Y + b], [X + b, Y + b], [X + a, Y + a]], enc(0, sa, ca));     // lower face
      };
      terminal.forEach(p => funnel(p[0], p[1]));
      rail.forEach(p => funnel(p[0], p[1]));
      ctx.restore();
    }, { srgb: false });
    return { map, nmap };
  }

  parts.breadboard = function () {
    const group = new T.Group();
    group.name = 'breadboard';
    const L = BB.L, D = BB.D, Ht = BB.H, F = BB.FOAM;
    const tex = breadboardTextures();
    const mat = MC.mat.whitePlastic();
    mat.map = tex.map;
    mat.normalMap = tex.nmap;
    mat.normalScale = new T.Vector2(1, 1);
    mat.color.set('#FFFFFF');
    mat.roughness = 0.5;
    const uvTop = (x, z) => [(x + L / 2) / L, 1 - (z + D / 2) / D];
    const plain = [0.5, 0.5];   // texel in the channel: plain plastic for walls
    const bodyH = Ht - F - BB.CH_D;
    const lower = slab({ outline: roundRect(L, D, 1.0, 5), t: bodyH, bevelTop: 0, bevelBottom: 0.35, seg: 2, uvTop, uvBottom: () => plain, sideUV: plain });
    lower.translate(0, F, 0);
    const halfD = (D - BB.CH_W) / 2;
    const halves = [-1, 1].map(s => {
      // round corners on the board edge, crisp corners at the channel
      const outline = s < 0
        ? cornerRect(-L / 2, -D / 2, L / 2, -BB.CH_W / 2, [1.0, 0, 0, 1.0], 5)
        : cornerRect(-L / 2, BB.CH_W / 2, L / 2, D / 2, [0, 1.0, 1.0, 0], 5);
      const g = slab({ outline, t: BB.CH_D, bevelTop: 0.3, bevelBottom: 0, seg: 3, uvTop, sideUV: plain, capBottom: false });
      g.translate(0, F + bodyH, 0);
      return g;
    });
    const bodyGeo = T.BufferGeometryUtils.mergeBufferGeometries([lower, halves[0], halves[1]]);
    const body = new T.Mesh(bodyGeo, mat);
    body.name = 'body';
    group.add(body);
    const foam = new T.Mesh(slab({ outline: roundRect(L - 1.2, D - 1.2, 0.8, 4), t: F, bevelTop: 0, bevelBottom: 0.12, seg: 2 }),
      new T.MeshStandardMaterial({ color: '#E9E6DE', roughness: 0.92 }));
    foam.name = 'adhesive';
    group.add(foam);
    tag(group, 'breadboard');

    // pins: every hole by name (lazy), enumerable only for the holes the build uses
    const used = {};
    const want = [];
    (MC.WIRES || []).forEach(w => [w.from, w.to].forEach(e => { if (e.part === 'breadboard') want.push(e.pin); }));
    const bp = MC.BREADBOARD_PARTS || {};
    Object.keys(bp).forEach(p => Object.keys(bp[p]).forEach(n => want.push(bp[p][n])));
    want.forEach(n => { const p = holeLocal(n); if (p) used[n] = { p, d: V3(0, 1, 0) }; });
    const pins = new Proxy(used, {
      get(target, key) {
        if (typeof key !== 'string') return target[key];
        if (Object.prototype.hasOwnProperty.call(target, key)) return target[key];
        const p = holeLocal(key);
        return p ? { p, d: V3(0, 1, 0) } : Reflect.get(target, key);
      },
      has(target, key) { return Object.prototype.hasOwnProperty.call(target, key) || !!holeLocal(key); }
    });
    return {
      group, pins, size: [L, Ht, D],
      extra: {
        hole: name => { const p = holeLocal(name); return p ? p.clone() : null; },
        holeNames: () => {
          const out = [];
          for (let c = 1; c <= BB.COLS; c++) for (let i = 0; i < 10; i++) out.push(ROWS[i] + c);
          return out;
        },
        railColumn: railColFor,
        // Matrix4 (breadboard local) for a part standing in two holes: origin midway on the
        // surface, +X from hole a to hole b, +Y up. buzzer: mount('c26', 'c28'), resistor: mount('e24', 'e26').
        mount(a, b) {
          const pa = holeLocal(a), pb = holeLocal(b || a);
          if (!pa || !pb) return null;
          const x = pb.clone().sub(pa);
          if (x.lengthSq() < 1e-9) x.set(1, 0, 0);
          x.normalize();
          const z = V3().crossVectors(x, UP).normalize();
          return new T.Matrix4().makeBasis(x, UP.clone(), z).setPosition(pa.add(pb).multiplyScalar(0.5));
        },
        pitch: PITCH, body, mat
      }
    };
  };

  // ==================================================================================== BUZZER
  // KY-006 stands upright in the breadboard (straight module, 90° header): origin = where the
  // middle pin enters the breadboard (bottom of the header plastic), pins along X
  // (S at -X, middle at 0, MINUS at +X, i.e. c26/c27/c28), PCB vertical in the XY plane,
  // buzzer facing -Z (toward row a). Pin ends 6 mm below the origin, d = -Y.
  function buzzerPcbTexture() {
    const k = 28, W = BZ.PCB_W, Hh = BZ.PCB_H;
    const mask = '#16181C';
    return MC.tex.canvas(Math.round(W * k), Math.round(2 * Hh * k), (ctx, w, h) => {
      ctx.fillStyle = mask;
      ctx.fillRect(0, 0, w, h);
      ctx.save();
      ctx.scale(k, k);
      // front (component side) in the top half: canvas (7.5 - x, 18.5 - y)
      const F = (x, y) => [W / 2 - x, Hh - y];
      const B = (x, y) => [x + W / 2, 2 * Hh - y];
      const ring = (p, ro, ri, col) => {
        ctx.fillStyle = col; ctx.beginPath(); ctx.arc(p[0], p[1], ro, 0, Math.PI * 2); ctx.fill();
        ctx.fillStyle = '#050506'; ctx.beginPath(); ctx.arc(p[0], p[1], ri, 0, Math.PI * 2); ctx.fill();
      };
      // traces under the mask
      [[F(-2.54, 3.5), F(-3.25, 8.0)], [F(2.54, 3.5), F(3.25, 8.0)]].forEach(([a, b]) => {
        ctx.strokeStyle = '#22252A'; ctx.lineWidth = 0.5; ctx.beginPath(); ctx.moveTo(a[0], a[1]); ctx.lineTo(a[0], b[1] + 1.5); ctx.lineTo(b[0], b[1]); ctx.stroke();
      });
      // silkscreen outline of the buzzer
      ctx.strokeStyle = '#E9ECEF'; ctx.lineWidth = 0.16;
      ctx.beginPath(); const cc = F(0, BZ.CAN_Y); ctx.arc(cc[0], cc[1], BZ.CAN_D / 2 + 0.35, 0, Math.PI * 2); ctx.stroke();
      [-2.54, 0, 2.54].forEach(x => ring(F(x, 3.5), 0.62, 0.36, '#C9CDD2'));
      // back (solder side) in the bottom half
      [-2.54, 0, 2.54].forEach(x => ring(B(x, 3.5), 0.75, 0.36, '#C9CDD2'));
      [-3.25, 3.25].forEach(x => ring(B(x, BZ.CAN_Y), 0.8, 0.38, '#C9CDD2'));
      ctx.strokeStyle = '#22252A'; ctx.lineWidth = 0.55;
      ctx.beginPath(); let a = B(-2.54, 3.5), b = B(-3.25, BZ.CAN_Y); ctx.moveTo(a[0], a[1]); ctx.lineTo(a[0], a[1] - 2.5); ctx.lineTo(b[0], b[1]); ctx.stroke();
      ctx.beginPath(); a = B(2.54, 3.5); b = B(3.25, BZ.CAN_Y); ctx.moveTo(a[0], a[1]); ctx.lineTo(a[0], a[1] - 2.5); ctx.lineTo(b[0], b[1]); ctx.stroke();
      ctx.restore();
      // labels: front S (right as seen from the front) and minus (left), back the module name
      const f1 = F(-2.54, 4.9), f2 = F(2.54, 4.9);
      text(ctx, k, 'S', f1[0] + 1.7, f1[1], 1.35, { color: '#F1F3F5', weight: 700, align: 'center' });
      text(ctx, k, '\u2212', f2[0] - 1.7, f2[1], 1.5, { color: '#F1F3F5', weight: 700, align: 'center' });
      const bb = B(0, 16.4);
      text(ctx, k, 'KY-006', bb[0], bb[1], 1.25, { color: '#F1F3F5', weight: 700, align: 'center', spacing: 0.04 });
      const bs = B(-2.54, 5.3), bm = B(2.54, 5.3);
      text(ctx, k, 'S', bs[0], bs[1], 1.2, { color: '#F1F3F5', weight: 700, align: 'center' });
      text(ctx, k, '\u2212', bm[0], bm[1], 1.4, { color: '#F1F3F5', weight: 700, align: 'center' });
    });
  }
  parts.buzzerModule = function () {
    const group = new T.Group();
    group.name = 'buzzer';
    const W = BZ.PCB_W, Hh = BZ.PCB_H, t = BZ.PCB_T;
    const zFace = PITCH / 2;               // PCB component face (header plastic lies on it)
    // PCB: slab in its own frame, rotated so slab +Y faces -Z
    const tex = buzzerPcbTexture();
    const pcbGeo = slab({
      outline: roundRect(W, Hh, 0.9, 4, 0, Hh / 2), t, bevelTop: 0.12, bevelBottom: 0.12, seg: 2,
      uvTop: (x, z) => [(W / 2 - x) / W, 0.5 + 0.5 * (z / Hh)],
      uvBottom: (x, z) => [(x + W / 2) / W, 0.5 * (z / Hh)],
      sideUV: [0.01, 0.01]
    });
    pcbGeo.applyMatrix4(new T.Matrix4().makeRotationX(-Math.PI / 2));
    pcbGeo.translate(0, 0, zFace + t);
    const pcbMat = MC.mat.pcb(tex);
    const pcb = new T.Mesh(pcbGeo, pcbMat);
    pcb.name = 'pcb';
    group.add(pcb);
    // buzzer can: lathe around Y, then turned to face -Z
    const prof = [[0.001, 0], [5.55, 0], [6.0, 0.3], [6.0, 7.95], [5.85, 8.32], [5.5, 8.5], [1.35, 8.5], [1.15, 8.3], [1.05, 7.7], [0.001, 7.7]]
      .map(p => new T.Vector2(p[0], p[1] * BZ.CAN_H / 8.5));
    let can = new T.LatheGeometry(prof, 40);
    can = T.BufferGeometryUtils.toCreasedNormals(can, 0.5);
    can.applyMatrix4(new T.Matrix4().makeRotationX(-Math.PI / 2));
    can.translate(0, BZ.CAN_Y, zFace - 0.15);
    const canMat = new T.MeshPhysicalMaterial({ color: '#141518', roughness: 0.5, clearcoat: 0.15, clearcoatRoughness: 0.5 });
    const canMesh = new T.Mesh(can, canMat);
    canMesh.name = 'buzzer';
    group.add(canMesh);
    // header (90°, plastic on the component face), pins, solder joints on the back
    const mb = new MB();
    const K = palUV(PAL.black), G = palUV(PAL.gold), S = palUV(PAL.tin);
    const a = DP.PIN_W / 2, yb = 3.5;
    mb.box(-1.5 * PITCH + 0.03, 0, -PITCH / 2, 1.5 * PITCH - 0.03, PITCH, PITCH / 2 - 0.02, K);
    for (let i = -1; i <= 1; i++) {
      const x = i * PITCH;
      const m = new T.Matrix4();
      // mating pin straight down with a pointed tip
      mb.setMatrix(m.makeTranslation(x, 0, 0).multiply(new T.Matrix4().makeRotationX(Math.PI / 2)));
      mb.prism(rectPoly(a, a), -0.3, BZ.PIN_DEPTH - 0.5, G, false, false);
      mb.setMatrix(m.makeTranslation(x, -(BZ.PIN_DEPTH - 0.5), 0).multiply(new T.Matrix4().makeRotationX(Math.PI / 2)));
      mb.frustum(a, 0.13, 0, 0.5, G, false);
      // up out of the plastic, then 90° into the PCB
      mb.setMatrix(m.makeTranslation(x, 0, 0).multiply(new T.Matrix4().makeRotationX(-Math.PI / 2)));
      mb.prism(rectPoly(a, a), PITCH - 0.1, yb + a, G, false, true);
      mb.setMatrix(m.makeTranslation(x, yb, 0));
      mb.prism(rectPoly(a, a), -a, zFace + t + 0.55, G, false, true);
      // solder cone on the back
      mb.setMatrix(m.makeTranslation(x, yb, zFace + t));
      mb.cone(0.78, 0.36, 0.0, 0.5, S, 14, true);
    }
    [-3.25, 3.25].forEach(x => {
      mb.setMatrix(new T.Matrix4().makeTranslation(x, BZ.CAN_Y, zFace + t));
      mb.cone(0.85, 0.3, 0.0, 0.62, S, 14, true);
    });
    mb.setMatrix(null);
    const hdr = new T.Mesh(mb.geometry(), palMaterial());
    hdr.name = 'header';
    group.add(hdr);
    tag(group, 'buzzer');
    const pins = {
      S: { p: V3(-PITCH, -BZ.PIN_DEPTH, 0), d: V3(0, -1, 0) },
      M: { p: V3(0, -BZ.PIN_DEPTH, 0), d: V3(0, -1, 0) },
      MINUS: { p: V3(PITCH, -BZ.PIN_DEPTH, 0), d: V3(0, -1, 0) }
    };
    return {
      group, pins, size: [W, Hh, t + 0.15 + BZ.CAN_H],
      extra: { can: canMesh, pcb, soundPort: V3(0, BZ.CAN_Y, zFace - 0.15 - BZ.CAN_H), pinEntry: { S: V3(-PITCH, 0, 0), M: V3(0, 0, 0), MINUS: V3(PITCH, 0, 0) } }
    };
  };

  // ==================================================================================== RESISTOR
  // resistor(spanMm = 5.08): origin on the breadboard surface midway between the two holes,
  // legs enter the board at x = ±span/2 and end 5 mm below. A span shorter than the body
  // (e24 to e26 = 5.08 mm) is built the way it is done on the bench: standing upright over
  // hole a, the upper lead bent over into hole b. Longer spans lie flat, legs bent 90° down.
  const BAND = { orange: '#E2702A', brown: '#6A3B1F', gold: '#C8A04A', black: '#1A1A1A', red: '#C62F2A' };
  let resistorTex = null;
  function resistorTexture() {
    if (resistorTex) return resistorTex;
    resistorTex = MC.tex.canvas(64, 512, (ctx, w, h) => {
      const g = ctx.createLinearGradient(0, 0, 0, h);
      g.addColorStop(0, '#D9BF92'); g.addColorStop(0.5, '#E2CBA1'); g.addColorStop(1, '#D6BB8D');
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, w, h);
      const L = RS.L;
      // v = 0 at the bottom of the body (canvas bottom); bands from v
      const band = (v0, v1, col) => { ctx.fillStyle = col; ctx.fillRect(0, h - v1 / L * h, w, (v1 - v0) / L * h); };
      band(0.72, 1.22, BAND.orange);
      band(1.86, 2.34, BAND.orange);
      band(2.86, 3.34, BAND.brown);
      band(4.84, 5.32, BAND.gold);
      noiseSpeckle(ctx, w, h, 1, 6, 3);
    });
    return resistorTex;
  }
  parts.resistor = function (spanMm) {
    const span = spanMm || 2 * PITCH;
    const group = new T.Group();
    group.name = 'resistor';
    const prof = [[0.001, 0], [0.5, 0.0], [0.92, 0.1], [1.14, 0.36], [1.2, 0.7], [1.2, 1.55], [1.12, 1.84], [1.04, 2.1],
      [1.04, 4.2], [1.12, 4.46], [1.2, 4.75], [1.2, 5.6], [1.14, 5.94], [0.92, 6.2], [0.5, 6.3], [0.001, 6.3]]
      .map(p => new T.Vector2(p[0] * RS.D / 2.4, p[1] * RS.L / 6.3));
    let body = new T.LatheGeometry(prof, 28);
    body = T.BufferGeometryUtils.toCreasedNormals(body, 1.2);
    const pos = body.attributes.position, uv = body.attributes.uv;
    for (let i = 0; i < pos.count; i++) uv.setY(i, pos.getY(i) / RS.L);
    const mat = new T.MeshPhysicalMaterial({ map: resistorTexture(), roughness: 0.42, clearcoat: 0.35, clearcoatRoughness: 0.4 });
    const bodyMesh = new T.Mesh(body, mat);
    bodyMesh.name = 'body';
    const leadR = RS.LEAD / 2, depth = 5.0;
    let path;
    const xa = -span / 2, xb = span / 2;
    if (span < RS.L + 3.0) {
      const y0 = 1.1;                                     // body bottom above the board
      bodyMesh.position.set(xa, y0, 0);
      const top = y0 + RS.L, bendY = top + 0.9, rr = span / 2;
      path = [
        leadPath([{ from: V3(xa, y0 + 0.2, 0), to: V3(xa, -depth, 0) }]),
        leadPath([
          { from: V3(xa, top - 0.2, 0), to: V3(xa, bendY, 0) },
          { arc: true, c: [0, bendY, 0], r: rr, a0: Math.PI, a1: 0 },
          { from: V3(xb, bendY, 0), to: V3(xb, -depth, 0) }
        ], 0.2)
      ];
    } else {
      const yc = 1.0 + RS.D / 2, br = 0.9;                // axis height, bend radius
      body.applyMatrix4(new T.Matrix4().makeRotationZ(-Math.PI / 2));
      bodyMesh.position.set(-RS.L / 2, yc, 0);
      const side = s => leadPath([
        { from: V3(s * (RS.L / 2 - 0.2), yc, 0), to: V3(s * (span / 2 - br), yc, 0) },
        { arc: true, c: [s * (span / 2 - br), yc - br, 0], r: br, a0: Math.PI / 2, a1: s > 0 ? 0 : Math.PI },
        { from: V3(s * span / 2, yc - br, 0), to: V3(s * span / 2, -depth, 0) }
      ], 0.2);
      path = [side(-1), side(1)];
    }
    // leads in one mesh
    const tubes = path.map(p => { const tb = new Tube(8); tb.set(p, leadR, V3(0, 0, 1)); return tb.geo; });
    const leadGeo = T.BufferGeometryUtils.mergeBufferGeometries(tubes.map(g => {
      const c = new T.BufferGeometry();
      const n = g.drawRange.count;
      c.setAttribute('position', g.attributes.position);
      c.setAttribute('normal', g.attributes.normal);
      c.setIndex(Array.from(g.index.array.slice(0, n)));
      return c;
    }));
    const leads = new T.Mesh(leadGeo, MC.mat.tin());
    leads.name = 'leads';
    group.add(bodyMesh, leads);
    tag(group, 'resistor');
    const pins = { a: { p: V3(xa, 0, 0), d: V3(0, -1, 0) }, b: { p: V3(xb, 0, 0), d: V3(0, -1, 0) } };
    const height = span < RS.L + 3.0 ? 1.1 + RS.L + 0.9 + span / 2 + leadR : 1.0 + RS.D;
    return { group, pins, size: [span + RS.LEAD, height, RS.D], extra: { body: bodyMesh, leads, upright: span < RS.L + 3.0, ohms: 330, bands: ['orange', 'orange', 'brown', 'gold'] } };
  };

  // ==================================================================================== TRANSPONDERS
  function contactless(ctx, x, y, s, col, lw) {
    ctx.save();
    ctx.strokeStyle = col;
    ctx.lineWidth = lw;
    ctx.lineCap = 'round';
    for (let i = 0; i < 4; i++) {
      ctx.beginPath();
      ctx.arc(x - s * 0.9, y, s * (0.35 + i * 0.32), -0.62, 0.62);
      ctx.stroke();
    }
    ctx.restore();
  }
  function cardTexture(uid) {
    const k = 15, W = CARD.W, H = CARD.H;
    return MC.tex.canvas(Math.round(W * k), Math.round(2 * H * k), (ctx, w, h) => {
      // front: top half
      const g = ctx.createLinearGradient(0, 0, w, h / 2);
      g.addColorStop(0, '#FBFBFA'); g.addColorStop(1, '#EEF0F2');
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, w, h / 2);
      ctx.fillStyle = '#F7F7F6';
      ctx.fillRect(0, h / 2, w, h / 2);
      ctx.save();
      ctx.scale(k, k);
      // roulette wheel motif, right side, hairlines
      ctx.save();
      ctx.beginPath(); ctx.rect(0, 0, W, H); ctx.clip();
      const wx = 70, wy = 27;
      ctx.strokeStyle = 'rgba(30,40,55,0.10)';
      ctx.lineWidth = 0.18;
      [9, 16.5, 21, 27, 33].forEach(r => { ctx.beginPath(); ctx.arc(wx, wy, r, 0, Math.PI * 2); ctx.stroke(); });
      for (let i = 0; i < 37; i++) {
        const a = (i / 37) * Math.PI * 2;
        ctx.beginPath();
        ctx.moveTo(wx + Math.cos(a) * 16.5, wy + Math.sin(a) * 16.5);
        ctx.lineTo(wx + Math.cos(a) * 21, wy + Math.sin(a) * 21);
        ctx.stroke();
      }
      // one green pocket
      ctx.fillStyle = 'rgba(48,164,108,0.55)';
      ctx.beginPath();
      ctx.arc(wx, wy, 21, -Math.PI / 2 - 0.085, -Math.PI / 2 + 0.085);
      ctx.arc(wx, wy, 16.5, -Math.PI / 2 + 0.085, -Math.PI / 2 - 0.085, true);
      ctx.closePath(); ctx.fill();
      ctx.restore();
      // brand mark: a roulette ring in the three game colours
      const ring = (cx, cy, r, w) => {
        const cols = [MC.tokens.game.black, MC.tokens.game.red, MC.tokens.game.green];
        const span = [0.45, 0.45, 0.10];
        let a0 = -Math.PI / 2;
        ctx.lineWidth = w;
        ctx.lineCap = 'butt';
        cols.forEach((c, i) => {
          const a1 = a0 + span[i] * Math.PI * 2;
          ctx.strokeStyle = c;
          ctx.beginPath(); ctx.arc(cx, cy, r, a0 + 0.06, a1 - 0.06); ctx.stroke();
          a0 = a1;
        });
        ctx.fillStyle = '#15171A';
        ctx.beginPath(); ctx.arc(cx, cy, r * 0.28, 0, Math.PI * 2); ctx.fill();
      };
      ring(10.2, 10.6, 3.4, 1.25);
      contactless(ctx, 79.4, 10.4, 2.9, 'rgba(70,80,92,0.6)', 0.3);
      // hairline under the lockup
      ctx.fillStyle = 'rgba(21,23,26,0.10)';
      ctx.fillRect(6.8, 18.6, 34, 0.12);
      ctx.restore();
      text(ctx, k, 'mini casino', 15.8, 9.6, 4.3, { color: '#15171A', weight: 700, spacing: -0.06 });
      text(ctx, k, 'player card', 15.95, 14.0, 1.95, { color: '#6B7480', weight: 600, spacing: 0.34 });
      text(ctx, k, 'UID', 7.0, 41.4, 1.6, { color: '#8A929C', weight: 700, spacing: 0.32 });
      text(ctx, k, MC.formatUid(uid), 6.9, 46.4, 3.4, { color: '#1D2025', weight: 600, font: MONO, spacing: 0.1 });
      text(ctx, k, 'V11 \u00B7 13.56 MHz', 78.6, 46.4, 1.7, { color: '#8A929C', weight: 600, align: 'right', spacing: 0.1 });
      // back: bottom half, readable after turning the card over sideways
      const by = H;
      text(ctx, k, 'mini casino', W / 2, by + 22.5, 3.0, { color: '#2A2E35', weight: 700, align: 'center' });
      text(ctx, k, 'hold the card on the reader mark to sign in', W / 2, by + 28.0, 1.7, { color: '#7D8794', weight: 500, align: 'center' });
      text(ctx, k, 'UID ' + MC.formatUid(uid) + '  \u00B7  lf7 \u00B7 bbz aifs51', W / 2, by + 44.5, 1.5, { color: '#9AA1AA', weight: 500, align: 'center', font: MONO });
      noiseSpeckle(ctx, w, h, k, 3, 11);
    });
  }
  function fobOutline() {
    const pts = [];
    circle(FOB.W / 2, 64, 0, FOB.L / 2 - FOB.W / 2).forEach(p => pts.push(p));
    circle(7.0, 40, 0, -FOB.L / 2 + 7.0).forEach(p => pts.push(p));
    const hull = convexHull(pts);
    // resample for even spacing so the rounded edge is smooth on the long straight sides
    const out = [];
    for (let i = 0; i < hull.length; i++) {
      const a = hull[i], b = hull[(i + 1) % hull.length];
      const n = Math.max(1, Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1]) / 1.6));
      for (let j = 0; j < n; j++) out.push([a[0] + (b[0] - a[0]) * j / n, a[1] + (b[1] - a[1]) * j / n]);
    }
    return out;
  }
  function fobTexture(uid) {
    const k = 22, W = FOB.W, L = FOB.L;
    return MC.tex.canvas(Math.round(W * k), Math.round(L * k), (ctx, w, h) => {
      const base = '#2559C6';
      ctx.fillStyle = base;
      ctx.fillRect(0, 0, w, h);
      ctx.save();
      ctx.scale(k, k);
      // moulded face panel: slightly darker inset with a highlight rim
      const cy = L - W / 2;
      const g = ctx.createRadialGradient(W / 2, cy - 2, 2, W / 2, cy, 12);
      g.addColorStop(0, 'rgba(255,255,255,0.05)'); g.addColorStop(1, 'rgba(0,0,0,0.10)');
      ctx.fillStyle = g;
      ctx.beginPath(); ctx.arc(W / 2, cy, 11.2, 0, Math.PI * 2); ctx.fill();
      ctx.strokeStyle = 'rgba(255,255,255,0.18)'; ctx.lineWidth = 0.22;
      ctx.beginPath(); ctx.arc(W / 2, cy, 11.4, Math.PI * 1.05, Math.PI * 1.95); ctx.stroke();
      ctx.strokeStyle = 'rgba(0,0,0,0.22)';
      ctx.beginPath(); ctx.arc(W / 2, cy, 11.4, Math.PI * 0.05, Math.PI * 0.95); ctx.stroke();
      contactless(ctx, W / 2 + 0.9, cy - 4.2, 2.2, 'rgba(205,220,250,0.7)', 0.3);
      ctx.restore();
      // laser marked UID
      const s = MC.formatUid(uid);
      text(ctx, k, s, W / 2, L - W / 2 + 3.0, 2.25, { color: 'rgba(214,226,250,0.92)', weight: 600, align: 'center', font: MONO });
      text(ctx, k, '13.56 MHz', W / 2, L - W / 2 + 6.2, 1.35, { color: 'rgba(200,214,245,0.7)', weight: 600, align: 'center' });
      noiseSpeckle(ctx, w, h, k, 4, 5);
    });
  }
  function stickerTexture(uid) {
    const k = 30, D = NTAG.D;
    return MC.tex.canvas(Math.round(D * k), Math.round(D * k), (ctx, w, h) => {
      ctx.fillStyle = '#FAFAF8';
      ctx.fillRect(0, 0, w, h);
      ctx.save();
      ctx.scale(k, k);
      // antenna coil showing faintly through the paper
      ctx.strokeStyle = 'rgba(120,128,138,0.11)';
      ctx.lineWidth = 0.32;
      for (let i = 0; i < 6; i++) { ctx.beginPath(); ctx.arc(D / 2, D / 2, 10.6 - i * 0.62, 0, Math.PI * 2); ctx.stroke(); }
      ctx.fillStyle = 'rgba(120,128,138,0.10)';
      ctx.fillRect(D / 2 + 6.4, D / 2 - 0.9, 4.6, 1.8);
      ctx.fillRect(D / 2 + 6.9, D / 2 - 0.55, 1.1, 1.1);
      ctx.restore();
      [MC.tokens.game.black, MC.tokens.game.red, MC.tokens.game.green].forEach((c, i) => {
        ctx.fillStyle = c; ctx.beginPath(); ctx.arc((D / 2 - 2.6 + i * 2.6) * k, 7.2 * k, 0.85 * k, 0, Math.PI * 2); ctx.fill();
      });
      text(ctx, k, 'mini casino', D / 2, 11.0, 2.2, { color: '#1D2025', weight: 700, align: 'center' });
      text(ctx, k, 'nfc tag', D / 2, 13.6, 1.25, { color: '#7D8794', weight: 600, align: 'center', spacing: 0.15 });
      const u = MC.formatUid(uid).split(' ');
      text(ctx, k, u.slice(0, 4).join(' '), D / 2, 17.1, 1.55, { color: '#2A2E35', weight: 600, align: 'center', font: MONO });
      text(ctx, k, u.slice(4).join(' '), D / 2, 19.3, 1.55, { color: '#2A2E35', weight: 600, align: 'center', font: MONO });
      noiseSpeckle(ctx, w, h, k, 3, 9);
    });
  }
  function coinTexture(uid) {
    const k = 30, D = COIN.D;
    return MC.tex.canvas(Math.round(D * k), Math.round(D * k), (ctx, w, h) => {
      ctx.fillStyle = '#1D1F23';
      ctx.fillRect(0, 0, w, h);
      ctx.save();
      ctx.scale(k, k);
      const g = ctx.createRadialGradient(D / 2, D / 2, 2, D / 2, D / 2, 12.5);
      g.addColorStop(0, 'rgba(255,255,255,0.03)'); g.addColorStop(1, 'rgba(0,0,0,0.12)');
      ctx.fillStyle = g; ctx.fillRect(0, 0, D, D);
      // moulded ring step
      ctx.lineWidth = 0.22;
      ctx.strokeStyle = 'rgba(255,255,255,0.10)';
      ctx.beginPath(); ctx.arc(D / 2, D / 2, 9.6, Math.PI, Math.PI * 2); ctx.stroke();
      ctx.strokeStyle = 'rgba(0,0,0,0.35)';
      ctx.beginPath(); ctx.arc(D / 2, D / 2, 9.6, 0, Math.PI); ctx.stroke();
      contactless(ctx, D / 2 + 0.8, 7.4, 1.9, 'rgba(190,198,208,0.55)', 0.26);
      ctx.restore();
      const u = MC.formatUid(uid).split(' ');
      text(ctx, k, u.slice(0, 4).join(' '), D / 2, 12.9, 1.55, { color: '#C9CED6', weight: 600, align: 'center', font: MONO });
      text(ctx, k, u.slice(4).join(' '), D / 2, 15.2, 1.55, { color: '#C9CED6', weight: 600, align: 'center', font: MONO });
      text(ctx, k, 'mini casino', D / 2, 18.6, 1.3, { color: 'rgba(170,178,190,0.75)', weight: 600, align: 'center', spacing: 0.12 });
      noiseSpeckle(ctx, w, h, k, 4, 13);
    });
  }

  // transponder(kind, uid): 'card' | 'fob' | 'sticker' | 'coin'. Lies flat, printed side +Y.
  parts.transponder = function (kind, uid) {
    uid = String(uid || 'DF51AA39').toUpperCase();
    const group = new T.Group();
    group.name = 'card_' + uid;
    let size, face;
    if (kind === 'fob') {
      const outline = fobOutline();
      const hole = circle(FOB.HOLE / 2, 36, 0, -FOB.L / 2 + 7.0);
      let minZ = Infinity, maxZ = -Infinity;
      outline.forEach(p => { minZ = Math.min(minZ, p[1]); maxZ = Math.max(maxZ, p[1]); });
      const geo = slab({
        outline, holes: [hole], t: FOB.T, bevelTop: 1.5, bevelBottom: 1.1, seg: 5,
        uvTop: (x, z) => [(x + FOB.W / 2) / FOB.W, 1 - (z - minZ) / (maxZ - minZ)], sideUV: [0.02, 0.02]
      });
      const mat = new T.MeshPhysicalMaterial({ map: fobTexture(uid), roughness: 0.34, clearcoat: 0.35, clearcoatRoughness: 0.3, sheen: 0.2, sheenColor: new T.Color('#9DBBFF') });
      face = new T.Mesh(geo, mat);
      size = [FOB.W, FOB.T, FOB.L];
    } else if (kind === 'sticker') {
      const liner = new T.Mesh(slab({ outline: roundRect(NTAG.LINER, NTAG.LINER, 2.5, 5), t: NTAG.LINER_T, bevelTop: 0.03, bevelBottom: 0, seg: 1 }),
        new T.MeshPhysicalMaterial({ color: '#EDE3C8', roughness: 0.3, clearcoat: 0.5, clearcoatRoughness: 0.2 }));
      liner.name = 'liner';
      group.add(liner);
      const geo = slab({ outline: circle(NTAG.D / 2, 96), t: NTAG.T, bevelTop: 0.08, bevelBottom: 0, seg: 2,
        uvTop: (x, z) => [(x + NTAG.D / 2) / NTAG.D, 1 - (z + NTAG.D / 2) / NTAG.D], sideUV: [0.02, 0.5] });
      geo.translate(0, NTAG.LINER_T, 0);
      face = new T.Mesh(geo, new T.MeshPhysicalMaterial({ map: stickerTexture(uid), roughness: 0.48, clearcoat: 0.2, clearcoatRoughness: 0.5 }));
      size = [NTAG.LINER, NTAG.LINER_T + NTAG.T, NTAG.LINER];
    } else if (kind === 'coin') {
      const geo = slab({ outline: circle(COIN.D / 2, 96), t: COIN.T, bevelTop: 0.7, bevelBottom: 0.5, seg: 4,
        uvTop: (x, z) => [(x + COIN.D / 2) / COIN.D, 1 - (z + COIN.D / 2) / COIN.D], sideUV: [0.02, 0.5] });
      face = new T.Mesh(geo, new T.MeshPhysicalMaterial({ map: coinTexture(uid), roughness: 0.46, clearcoat: 0.25, clearcoatRoughness: 0.45 }));
      size = [COIN.D, COIN.T, COIN.D];
    } else {
      kind = 'card';
      const W = CARD.W, H = CARD.H;
      const geo = slab({
        outline: roundRect(W, H, CARD.R, 8), t: CARD.T, bevelTop: 0.2, bevelBottom: 0.2, seg: 2,
        uvTop: (x, z) => [(x + W / 2) / W, 0.5 + 0.5 * (1 - (z + H / 2) / H)],
        uvBottom: (x, z) => [1 - (x + W / 2) / W, 0.5 * (1 - (z + H / 2) / H)],
        sideUV: [0.5, 0.25]
      });
      face = new T.Mesh(geo, new T.MeshPhysicalMaterial({ map: cardTexture(uid), roughness: 0.2, clearcoat: 1, clearcoatRoughness: 0.07 }));
      size = [W, CARD.T, H];
    }
    face.name = kind;
    group.add(face);
    tag(group, 'card_' + uid, { card: uid });
    return { group, pins: {}, size, extra: { uid, kind, face } };
  };
})();
