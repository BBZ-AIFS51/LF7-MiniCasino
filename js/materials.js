/* Mini Casino viewer: physically based materials and procedural canvas textures.
   Every part builder takes its materials from here so the whole scene shares one look.
   Builders get fresh materials per call (safe to tint for highlighting) unless they ask
   for MC.mat.shared.* which is cached and must not be modified. */
(function () {
  'use strict';
  const MC = window.MC;
  const T = window.THREE;

  // ------------------------------------------------------------------ textures
  const tex = MC.tex = {};
  tex.anisotropy = 8;   // the scene lowers this on weak GPUs before parts are built

  // A canvas texture drawn by draw(ctx, w, h). opts: { srgb = true, repeat, wrap, flipY }
  tex.canvas = function (w, h, draw, opts) {
    opts = opts || {};
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    const ctx = c.getContext('2d');
    draw(ctx, w, h);
    const t = new T.CanvasTexture(c);
    t.encoding = opts.srgb === false ? T.LinearEncoding : T.sRGBEncoding;
    t.anisotropy = tex.anisotropy;
    if (opts.repeat) {
      t.wrapS = t.wrapT = T.RepeatWrapping;
      t.repeat.set(opts.repeat[0], opts.repeat[1]);
    }
    if (opts.flipY === false) t.flipY = false;
    t.needsUpdate = true;
    return t;
  };

  // Text on a texture canvas. o: { size, weight, color, align, baseline, font, spacing }
  tex.text = function (ctx, str, x, y, o) {
    o = o || {};
    ctx.save();
    ctx.fillStyle = o.color || '#FFFFFF';
    ctx.textAlign = o.align || 'left';
    ctx.textBaseline = o.baseline || 'middle';
    ctx.font = (o.weight || 600) + ' ' + (o.size || 16) + 'px ' + (o.font || 'Arial, Helvetica, sans-serif');
    if (o.spacing && 'letterSpacing' in ctx) ctx.letterSpacing = o.spacing + 'px';
    if (o.rotate) { ctx.translate(x, y); ctx.rotate(o.rotate); ctx.fillText(str, 0, 0); }
    else ctx.fillText(str, x, y);
    ctx.restore();
  };

  // Tangent-space normal map from a height function h(u, v) in 0..1 (u, v in 0..1).
  tex.normalFromHeight = function (size, height, strength, opts) {
    const c = document.createElement('canvas');
    c.width = c.height = size;
    const ctx = c.getContext('2d');
    const img = ctx.createImageData(size, size);
    const H = new Float32Array(size * size);
    for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) H[y * size + x] = height(x / size, y / size);
    const at = (x, y) => H[((y + size) % size) * size + ((x + size) % size)];
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const dx = (at(x + 1, y) - at(x - 1, y)) * strength;
        const dy = (at(x, y + 1) - at(x, y - 1)) * strength;
        const len = Math.hypot(dx, dy, 1);
        const i = (y * size + x) * 4;
        img.data[i] = Math.round((-dx / len * 0.5 + 0.5) * 255);
        img.data[i + 1] = Math.round((dy / len * 0.5 + 0.5) * 255);
        img.data[i + 2] = Math.round((1 / len * 0.5 + 0.5) * 255);
        img.data[i + 3] = 255;
      }
    }
    ctx.putImageData(img, 0, 0);
    const t = new T.CanvasTexture(c);
    t.encoding = T.LinearEncoding;
    t.wrapS = t.wrapT = T.RepeatWrapping;
    t.anisotropy = tex.anisotropy;
    if (opts && opts.repeat) t.repeat.set(opts.repeat[0], opts.repeat[1]);
    return t;
  };

  // Deterministic value noise so every load looks the same.
  function hash(x, y) {
    let h = (x * 374761393 + y * 668265263) | 0;
    h = (h ^ (h >>> 13)) * 1274126177 | 0;
    return ((h ^ (h >>> 16)) >>> 0) / 4294967295;
  }
  tex.noise = function (u, v, cells) {
    const x = u * cells, y = v * cells;
    const xi = Math.floor(x), yi = Math.floor(y);
    const xf = x - xi, yf = y - yi;
    const s = t => t * t * (3 - 2 * t);
    const w = i => ((i % cells) + cells) % cells;
    const a = hash(w(xi), w(yi)), b = hash(w(xi + 1), w(yi));
    const c = hash(w(xi), w(yi + 1)), d = hash(w(xi + 1), w(yi + 1));
    return MC.lerp(MC.lerp(a, b, s(xf)), MC.lerp(c, d, s(xf)), s(yf));
  };

  // FDM layer lines: one texture tile = 4 mm = 20 layers of 0.2 mm, lines run along u.
  let layerNormal = null;
  tex.layerLines = function () {
    if (layerNormal) return layerNormal;
    layerNormal = tex.normalFromHeight(256, (u, v) => {
      const layer = Math.abs(Math.sin(v * Math.PI * 20));
      return Math.pow(layer, 0.6) * 0.8 + tex.noise(u, v, 32) * 0.12 + tex.noise(u, v, 8) * 0.08;
    }, 2.2);
    return layerNormal;
  };
  tex.LAYER_TILE_MM = 4;

  // Fine bed texture for surfaces printed face down (lid top): satin, almost smooth.
  let bedNormal = null;
  tex.bedTexture = function () {
    if (bedNormal) return bedNormal;
    bedNormal = tex.normalFromHeight(256, (u, v) => tex.noise(u, v, 64) * 0.6 + tex.noise(u, v, 16) * 0.4, 0.9);
    return bedNormal;
  };

  // Box-projected UVs in millimetres / tileMm, so layer lines stay horizontal (along world Y
  // = print Z) on walls and normal maps work on meshes without UVs (STL data).
  tex.boxUV = function (geometry, tileMm) {
    const pos = geometry.getAttribute('position');
    if (!geometry.getAttribute('normal')) geometry.computeVertexNormals();
    const nor = geometry.getAttribute('normal');
    const uv = new Float32Array(pos.count * 2);
    const s = 1 / (tileMm || tex.LAYER_TILE_MM);
    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
      const nx = Math.abs(nor.getX(i)), ny = Math.abs(nor.getY(i)), nz = Math.abs(nor.getZ(i));
      let u, v;
      if (ny >= nx && ny >= nz) { u = x; v = z; }       // top / bottom faces
      else if (nx >= nz) { u = z; v = y; }               // left / right walls: lines along Z
      else { u = x; v = y; }                             // front / back walls: lines along X
      uv[i * 2] = u * s; uv[i * 2 + 1] = v * s;
    }
    geometry.setAttribute('uv', new T.BufferAttribute(uv, 2));
    return geometry;
  };

  // A PCB texture: solder mask colour, optional copper traces under the mask, then draw(ctx)
  // adds pads, silkscreen and so on. pxPerMm decides the resolution.
  tex.board = function (wMm, hMm, maskHex, draw, pxPerMm) {
    const k = pxPerMm || 16;
    return tex.canvas(Math.round(wMm * k), Math.round(hMm * k), (ctx, w, h) => {
      ctx.fillStyle = maskHex;
      ctx.fillRect(0, 0, w, h);
      // faint mask variation so large areas do not look like plastic
      const g = ctx.createLinearGradient(0, 0, w, h);
      g.addColorStop(0, 'rgba(255,255,255,0.035)');
      g.addColorStop(1, 'rgba(0,0,0,0.05)');
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, w, h);
      ctx.save();
      ctx.scale(k, k);   // draw in millimetres
      if (draw) draw(ctx, wMm, hMm, k);
      ctx.restore();
    });
  };

  // Traces under the solder mask: slightly lighter than the mask.
  tex.trace = function (ctx, pts, widthMm, maskHex, amount) {
    ctx.save();
    ctx.strokeStyle = shade(maskHex, amount === undefined ? 0.12 : amount);
    ctx.lineWidth = widthMm;
    ctx.lineCap = ctx.lineJoin = 'round';
    ctx.beginPath();
    pts.forEach((p, i) => (i ? ctx.lineTo(p[0], p[1]) : ctx.moveTo(p[0], p[1])));
    ctx.stroke();
    ctx.restore();
  };

  // lighten (amount > 0) or darken (amount < 0) a hex colour
  function shade(hex, amount) {
    const c = new T.Color(hex);
    const hsl = {};
    c.getHSL(hsl);
    c.setHSL(hsl.h, hsl.s, MC.clamp(hsl.l + amount, 0, 1));
    return '#' + c.getHexString();
  }
  tex.shade = shade;

  // ------------------------------------------------------------------ materials
  const mat = MC.mat = {};
  const std = p => new T.MeshStandardMaterial(p);
  const phys = p => new T.MeshPhysicalMaterial(p);

  // Matte PLA with layer lines; call tex.boxUV on the geometry first.
  mat.pla = function (hex, opts) {
    opts = opts || {};
    const m = phys({
      color: hex,
      roughness: opts.roughness !== undefined ? opts.roughness : 0.58,
      metalness: 0,
      sheen: 0.25, sheenRoughness: 0.8, sheenColor: new T.Color(hex).lerp(new T.Color('#FFFFFF'), 0.4),
      clearcoat: 0.04, clearcoatRoughness: 0.6,
      normalMap: opts.bed ? tex.bedTexture() : tex.layerLines(),
      normalScale: new T.Vector2(opts.normal || 0.22, opts.normal || 0.22)
    });
    m.userData.kind = 'pla';
    return m;
  };

  // Solder mask over FR4. map = texture from tex.board().
  mat.pcb = function (map, opts) {
    opts = opts || {};
    return phys({
      map, color: '#FFFFFF',
      roughness: opts.roughness || 0.42, metalness: 0,
      clearcoat: 0.55, clearcoatRoughness: 0.32
    });
  };
  // Bare board edge (FR4 core)
  mat.fr4Edge = () => std({ color: '#C8C29A', roughness: 0.7 });

  mat.gold = () => std({ color: '#E7B962', metalness: 1, roughness: 0.24 });
  mat.tin = () => std({ color: '#D3D7DC', metalness: 1, roughness: 0.32 });            // HASL pads, solder
  mat.solder = () => std({ color: '#BFC4CA', metalness: 1, roughness: 0.22 });
  mat.copper = () => std({ color: '#C8784A', metalness: 1, roughness: 0.3 });
  mat.steel = () => std({ color: '#C3C8CE', metalness: 1, roughness: 0.28 });          // USB shell, crystal can
  mat.brushed = () => std({ color: '#AEB4BB', metalness: 1, roughness: 0.42 });
  mat.blackPlastic = () => std({ color: '#141518', roughness: 0.52 });                  // headers, housings
  mat.darkPlastic = () => std({ color: '#26282C', roughness: 0.48 });
  mat.whitePlastic = () => phys({ color: '#F1F1EE', roughness: 0.55, sheen: 0.2, sheenRoughness: 0.9, sheenColor: new T.Color('#FFFFFF') }); // breadboard
  mat.epoxy = () => std({ color: '#1B1C1F', roughness: 0.42 });                         // IC packages
  mat.ceramic = hex => std({ color: hex || '#B9A47A', roughness: 0.6 });
  mat.rubber = () => std({ color: '#1E1F21', roughness: 0.92 });

  // Jumper insulation: soft PVC with a slight sheen.
  mat.wire = hex => phys({ color: hex, roughness: 0.4, clearcoat: 0.35, clearcoatRoughness: 0.45 });

  // Membrane keypad overlay: printed polyester, satin gloss.
  mat.membrane = (map, hex) => phys({ map: map || null, color: map ? '#FFFFFF' : (hex || '#202226'), roughness: 0.34, clearcoat: 0.7, clearcoatRoughness: 0.22 });

  // OLED: the pixels are an emissive map (set by the scene), the panel is black glass.
  mat.oledPixels = () => {
    const m = std({ color: '#000000', emissive: '#FFFFFF', emissiveIntensity: 1, roughness: 0.25, metalness: 0 });
    m.toneMapped = false;
    return m;
  };
  mat.oledGlow = () => new T.MeshBasicMaterial({ color: '#FFFFFF', transparent: true, opacity: 0.55, blending: T.AdditiveBlending, depthWrite: false, toneMapped: false });
  mat.blackGlass = () => phys({ color: '#050607', roughness: 0.05, metalness: 0, clearcoat: 1, clearcoatRoughness: 0.03, reflectivity: 0.6 });
  // Clear cover over something lit (OLED pixels): mostly reflections.
  mat.glassCover = () => phys({ color: '#FFFFFF', roughness: 0.04, metalness: 0, transparent: true, opacity: 0.16, clearcoat: 1, clearcoatRoughness: 0.02, depthWrite: false });

  // X-ray look for the lid and body
  mat.xray = hex => phys({ color: hex || '#DDE3EA', roughness: 0.15, transparent: true, opacity: 0.14, depthWrite: false, side: T.DoubleSide });

  // Cached shared materials for many small identical meshes (pins, holes). Do not tint these.
  const cache = {};
  mat.shared = new Proxy({}, {
    get(_, name) {
      if (!cache[name]) {
        if (typeof mat[name] !== 'function') return undefined;
        cache[name] = mat[name]();
      }
      return cache[name];
    }
  });

  // Highlight helpers used by the scene: tint any standard/physical material.
  mat.setHighlight = function (material, on, hex) {
    if (!material || !material.emissive) return;
    if (!material.userData.baseEmissive) {
      material.userData.baseEmissive = material.emissive.clone();
      material.userData.baseEmissiveIntensity = material.emissiveIntensity;
    }
    if (on) {
      material.emissive.set(hex || '#3DD68C');
      material.emissiveIntensity = 0.35;
    } else {
      material.emissive.copy(material.userData.baseEmissive);
      material.emissiveIntensity = material.userData.baseEmissiveIntensity;
    }
  };
})();
