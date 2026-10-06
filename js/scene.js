/* Mini Casino viewer: the 3D scene (MC.Scene, contract in SPEC §6).
   Renderer and studio light, the printed case, every part, the 26 jumper wires, explode,
   x-ray, camera presets, picking, build steps and the card tap animation.
   Units are millimetres. World = three.js, Y up, the front of the console faces +Z.
   Renders on demand: a frame is drawn only when something changed or an animation runs. */
(function () {
  'use strict';
  const MC = window.MC = window.MC || {};
  const T = window.THREE;
  const DEG = Math.PI / 180;
  const S = MC.Scene = {};

  // Hex colours are sRGB design values (tokens, net colours, PLA swatches): convert them to linear
  // on input so the render shows them as specified. three r147 keeps the old pass-through as its
  // default, which washes saturated and dark colours out (signal red turned pink, graphite grey).
  // Set at load: every material is created later, inside the builders called by init().
  if (T && T.ColorManagement && 'legacyMode' in T.ColorManagement) T.ColorManagement.legacyMode = false;

  // ------------------------------------------------------------------ constants
  const HOUSING = 14.0;        // Dupont housing length (SPEC §4)
  const PIN_EXPOSED = 6.0;     // a female housing slides over a module's male pin up to its root
  const MALE_PIN = 6.0;        // a male Dupont pin goes this deep into a header or breadboard hole
  const LEAD = 3.5;            // straight wire behind the housing before it may bend (as parts.wire)
  const STEP_MM = 5.0;         // node spacing of the wire solver
  const END_STIFF = 1.35;      // > 1: the wire keeps its exit direction longer (stiff insulation near the crimp)
  const WIRE_GAP = 1.9;        // wire pitch inside a bundle
  const CLEAR = 2.0;           // wire clearance over boards and housings, under the lid
  const LID_PARTS = ['oled', 'rc522', 'keypad'];
  const BASE_PARTS = ['uno', 'breadboard', 'buzzer', 'resistor'];
  const MERGE_PARTS = ['uno', 'breadboard', 'rc522', 'oled', 'buzzer', 'resistor'];
  const BUNDLES = [['kp', /^kp\d$/], ['rc', /^rc_/], ['oled', /^oled_/], ['bb', /^bb_/]];
  const LIFT = 108, LIFT_BACK = 22, TILT = -12 * DEG;   // lid in the explode view
  const OPEN = -72 * DEG;      // build guide: the lid swings open so its underside faces the viewer
  const EXPLODE = {            // per part: direction ('up' world, 'n' lid normal, 'out' sideways), distance, stage
    uno: ['up', 10, 0.30, 0.85], breadboard: ['up', 20, 0.36, 0.92],
    buzzer: ['up', 44, 0.46, 1.0], resistor: ['up', 38, 0.46, 1.0],
    oled: ['n', -16, 0.40, 1.0], rc522: ['n', -26, 0.40, 1.0], keypad: ['n', 12, 0.40, 1.0],
    card: ['out', 46, 0.05, 0.65]
  };
  const BUILDERS = {
    uno: () => MC.parts.uno(), oled: () => MC.parts.oledModule(), rc522: () => MC.parts.rc522(),
    keypad: () => MC.parts.keypad(), breadboard: () => MC.parts.breadboard(),
    buzzer: () => MC.parts.buzzerModule()
  };
  const BUILDER_NAMES = { uno: 'uno', oled: 'oledModule', rc522: 'rc522', keypad: 'keypad', breadboard: 'breadboard', buzzer: 'buzzerModule', resistor: 'resistor' };
  const THEMES = {
    dark:  { exposure: 0.72, shadow: 0.38, contact: 0.85, key: 2.7, fill: 0.35, rim: 2.2, env: 0.45 },
    light: { exposure: 0.72, shadow: 0.26, contact: 0.6,  key: 2.6, fill: 0.35, rim: 1.8, env: 0.5 }
  };
  const OLED_TINT = {
    white: ['#F2F7FF', '#F2F7FF'], blue: ['#56C2FF', '#56C2FF'], 'yellow-blue': ['#FFD23F', '#56C2FF']
  };

  const v3 = (x, y, z) => new T.Vector3(x, y, z);
  const vfa = a => new T.Vector3().fromArray(a);
  const smooth = (e, a, b) => { const t = MC.clamp((e - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };
  const easeOut = t => 1 - Math.pow(1 - t, 3);
  const easeOutBack = t => { const c = 0.8; return 1 + (c + 1) * Math.pow(t - 1, 3) + c * Math.pow(t - 1, 2); };
  const now = () => performance.now();
  const emit = (n, d) => MC.bus && MC.bus.emit(n, d);

  // ------------------------------------------------------------------ state
  const st = {
    ready: false, canvas: null, renderer: null, scene: null, camera: null, controls: null,
    root: null, baseRig: null, lidRig: null, cardRig: null, wireRig: null, stage: null,
    caseData: null, caseFallback: false, caseMeshes: [], caseColor: null,
    lid: null, inner: null, lidPlane: { p: v3(0, 0, 0), n: v3(0, 1, 0) },
    parts: {}, wires: [], bundles: new Map(), fallbacks: [],
    ex: 0, exTarget: 0, lidOpen: 0, explodeDirty: true, wiresDirty: true, routeQuality: 1, routeFinal: false, frameNo: 0, shadowLate: false,
    view: { xray: false, body: true, lid: true, wires: true, parts: true, labels: false, autoRotate: true },
    focus: null, isolated: null, step: null, stepCamUntil: 0, hover: null, preset: 'hero', userMoved: false,
    theme: 'dark', quality: 'auto', tier: 'high', insets: { left: 0, right: 0, top: 0, bottom: 0 },
    oledObj: null, oledTex: null, glowTex: null, oledVariant: 'white',
    dirty: true, raf: 0, hidden: false, last: 0, keepAlive: 0, pickDirty: true, pickables: [],
    fps: { frames: 0, t0: 0, value: 0 }, probe: null, reduced: false, cardQueue: Promise.resolve(),
    pointer: { x: 0, y: 0, inside: false, down: null, pending: false, lastPick: 0, type: 'mouse' }
  };
  S._state = st;   // for tests and the integrator, not part of the contract

  // ------------------------------------------------------------------ animation
  const tweens = new Map();   // channel -> tween
  let tweenId = 0;
  function animate(channel, duration, onUpdate, ease) {
    const old = tweens.get(channel);
    if (old) { tweens.delete(channel); old.resolve(false); }
    return new Promise(resolve => {
      const tw = { start: now(), duration: Math.max(1, duration), onUpdate, ease: ease || MC.ease, resolve };
      tweens.set(channel || ('t' + (++tweenId)), tw);
      requestRender();
    });
  }
  function stopTween(channel) {
    const tw = tweens.get(channel);
    if (tw) { tweens.delete(channel); tw.resolve(false); }
  }
  function runTweens(t) {
    if (!tweens.size) return false;
    for (const [key, tw] of Array.from(tweens)) {
      const k = MC.clamp((t - tw.start) / tw.duration, 0, 1);
      tw.onUpdate(tw.ease(k), k);
      if (k >= 1 && tweens.get(key) === tw) { tweens.delete(key); tw.resolve(true); }
    }
    return true;
  }
  const dur = ms => (st.reduced ? Math.min(ms, 180) : ms);

  // ------------------------------------------------------------------ render loop
  function requestRender() { st.dirty = true; schedule(); }
  function keepAlive(ms) { st.keepAlive = Math.max(st.keepAlive, now() + ms); schedule(); }
  function schedule() {
    if (st.raf || st.hidden || !st.renderer) return;
    st.raf = requestAnimationFrame(frame);
  }
  function frame(t) {
    st.raf = 0;
    if (!st.ready || st.hold) return;   // no frame while the shaders compile
    let active = runTweens(t);
    // wires: a quick pass on every frame of a move, one full pass when it ends
    const moving = tweens.has('explode') || tweens.has('lidOpen') || tweens.has('drop');
    if (st.explodeDirty) { applyExplode(); st.explodeDirty = false; st.wiresDirty = true; shadowsDirty(); }
    if (moving) st.routeFinal = true;
    else if (st.routeFinal) { st.routeFinal = false; st.wiresDirty = true; }
    if (st.wiresDirty) {
      const t0 = st.profile ? now() : 0;
      st.routeQuality = moving ? 0.4 : 1;
      routeWires();
      st.wiresDirty = false;
      shadowsDirty();
      if (st.profile) st.profile.route += now() - t0;
    }
    if (st.pointer.pending && t - st.pointer.lastPick > 33) { st.pointer.pending = false; st.pointer.lastPick = t; pickHover(); }
    else if (st.pointer.pending) active = true;
    if (st.controls.update()) active = true;
    clampTarget();
    if (st.dirty || active || st.keepAlive > t) {
      // while things move, the shadow map is redrawn on every second frame only
      const sm = st.renderer.shadowMap;
      if (moving && sm.needsUpdate && (st.frameNo & 1)) { sm.needsUpdate = false; st.shadowLate = true; }
      else if (st.shadowLate) { sm.needsUpdate = true; st.shadowLate = false; }
      st.frameNo = (st.frameNo + 1) | 0;
      render(); st.dirty = false; trackFps(t);
      if (st.shadowLate && !moving) { st.dirty = true; schedule(); }
    }
    if (st.probe) runProbe(t);
    if (active || st.controls.autoRotate || st.keepAlive > t) schedule();
    else st.fps.t0 = 0;
  }
  function render() {
    const t0 = st.profile ? now() : 0;
    st.renderer.render(st.scene, st.camera);
    if (st.profile) { st.profile.render += now() - t0; st.profile.frames++; }
    if (st.labels && (st.view.labels || st.labels.items.some(i => i.on))) updateLabels();
    emit('scene:frame');
  }
  function shadowsDirty() { if (st.renderer) st.renderer.shadowMap.needsUpdate = true; }
  function trackFps(t) {
    const f = st.fps;
    if (!f.t0 || t - f.prev > 250) { f.t0 = t; f.frames = 0; f.prev = t; return; }
    f.frames++; f.prev = t;
    if (t - f.t0 >= 1000) {
      f.value = Math.round(f.frames * 1000 / (t - f.t0));
      f.t0 = t; f.frames = 0;
      emit('scene:fps', f.value);
    }
  }

  // ------------------------------------------------------------------ quality
  function runProbe(t) {
    const p = st.probe;
    if (!p.start) { p.start = t; p.prev = t; return; }
    p.times.push(t - p.prev); p.prev = t;
    if (t - p.start < (p.round ? 1600 : 2400)) { keepAlive(100); return; }
    st.probe = null;
    const sorted = p.times.slice(4).sort((a, b) => a - b);
    const med = sorted.length ? sorted[sorted.length >> 1] : 16;
    const fps = 1000 / med;
    // step down one tier at a time and measure again, until it holds ~50 fps or is at 'low'
    if (fps < 50 && st.tier !== 'low') {
      const next = st.tier === 'high' ? (fps < 24 ? 'low' : 'medium') : 'low';
      applyTier(next);
      if (next !== 'low') { st.probe = { times: [], round: (p.round || 0) + 1 }; keepAlive(2200); }
    } else emit('scene:quality', st.tier);
  }
  function applyTier(tier) {
    st.tier = tier;
    const r = st.renderer, key = st.lights.key;
    const dpr = window.devicePixelRatio || 1;
    r.setPixelRatio(tier === 'high' ? Math.min(dpr, 2) : tier === 'medium' ? Math.min(dpr, 1.5) : 1);
    const shadows = tier !== 'low';
    const size = tier === 'high' ? 2048 : 1024;
    if (r.shadowMap.enabled !== shadows) {
      r.shadowMap.enabled = shadows;
      st.scene.traverse(o => { if (o.material) (Array.isArray(o.material) ? o.material : [o.material]).forEach(m => { m.needsUpdate = true; }); });
    }
    if (key.shadow.mapSize.x !== size) {
      key.shadow.mapSize.set(size, size);
      if (key.shadow.map) { key.shadow.map.dispose(); key.shadow.map = null; }
    }
    st.wires.forEach(W => W.obj.group.traverse(o => { if (o.isMesh) o.castShadow = tier === 'high'; }));
    st.ground.visible = shadows;
    for (const C of st.caseMeshes) {
      for (const m of C.solid) {
        if (m.userData.layers === undefined) m.userData.layers = [m.sheen || 0, m.clearcoat || 0];
        const cheap = tier === 'low';
        const sh = cheap ? 0 : m.userData.layers[0], cc = cheap ? 0 : m.userData.layers[1];
        if (m.sheen !== sh || m.clearcoat !== cc) { m.sheen = sh; m.clearcoat = cc; m.needsUpdate = true; }
      }
    }
    resize();
    shadowsDirty();
    requestRender();
    emit('scene:quality', tier);
  }

  // ------------------------------------------------------------------ renderer, light, ground
  function initRenderer(canvas) {
    const r = new T.WebGLRenderer({ canvas, antialias: true, alpha: true, powerPreference: 'high-performance' });
    r.setClearColor(0x000000, 0);
    r.outputEncoding = T.sRGBEncoding;
    r.toneMapping = T.ACESFilmicToneMapping;
    r.toneMappingExposure = 1.0;
    r.physicallyCorrectLights = true;
    r.shadowMap.enabled = true;
    r.shadowMap.type = T.PCFSoftShadowMap;
    r.shadowMap.autoUpdate = false;     // the light never moves: redraw shadows only when objects do
    r.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    MC.tex.anisotropy = Math.min(8, r.capabilities.getMaxAnisotropy());
    st.renderer = r;

    const scene = st.scene = new T.Scene();
    const pm = new T.PMREMGenerator(r);
    const room = new T.RoomEnvironment();
    st.envMap = pm.fromScene(room, 0.04).texture;
    room.dispose(); pm.dispose();
    scene.environment = st.envMap;

    st.camera = new T.PerspectiveCamera(30, 1, 4, 6000);
    st.root = new T.Group(); st.root.name = 'root';
    scene.add(st.root);
    for (const name of ['baseRig', 'lidRig', 'cardRig', 'wireRig']) {
      const g = st[name] = new T.Group();
      g.name = name;
      st.root.add(g);
    }
    st.lidRig.matrixAutoUpdate = false;
  }

  function initLights() {
    // Key: a large soft spot from the upper left front. Its falloff paints a gentle gradient over
    // the flat PLA faces, which a directional light cannot do.
    const key = new T.SpotLight('#FFFFFF', 1, 0, 34 * DEG, 1.0, 2);
    key.position.set(-150, 610, 200);
    key.castShadow = true;
    key.shadow.mapSize.set(2048, 2048);
    key.shadow.camera.near = 250;
    key.shadow.camera.far = 1400;
    key.shadow.bias = -0.0002;
    key.shadow.normalBias = 0.3;
    key.shadow.focus = 1;
    const fill = new T.DirectionalLight('#E8EEFF', 0.35);
    fill.position.set(320, 110, 170);
    const rim = new T.DirectionalLight('#FFFFFF', 2.0);
    rim.position.set(140, 200, -330);
    st.scene.add(key, key.target, fill, rim);
    st.lights = { key, fill, rim };
    st.keyDist = key.position.length();
  }

  // Environment strength per material: dielectrics get less of the (bright, even) room so the
  // directional lights shape them; metals and glass keep the full reflection.
  function applyEnv() {
    const k = THEMES[st.theme].env;
    st.scene.traverse(o => {
      if (!o.material) return;
      for (const m of Array.isArray(o.material) ? o.material : [o.material]) {
        if (!('envMapIntensity' in m)) continue;
        if (m.userData.envBase === undefined) m.userData.envBase = m.envMapIntensity;
        // metals and glass keep the full room, coated dielectrics (PCBs, membrane) a part of it
        if (m.userData.envShiny === undefined) m.userData.envShiny = (m.metalness || 0) > 0.5 || m.transparent ? 2 : (m.clearcoat || 0) > 0.3 ? 1 : 0;
        const kind = m.userData.envShiny;
        m.envMapIntensity = m.userData.envBase * (kind === 2 ? Math.max(0.9, k) : kind === 1 ? Math.max(0.62, k) : k);
      }
    });
  }

  function initGround() {
    const stage = st.stage = new T.Group();
    stage.name = 'stage';
    // only as large as the shadows can reach: a full-screen shadow receiver costs ~4 ms on an iGPU
    const ground = new T.Mesh(new T.PlaneGeometry(660, 560), new T.ShadowMaterial({ opacity: 0.5, depthWrite: false }));
    ground.rotation.x = -Math.PI / 2;
    ground.position.set(45, 0, -10);
    ground.receiveShadow = true;
    ground.renderOrder = -3;
    ground.userData.noPick = true;
    stage.add(ground);
    st.ground = ground;
    st.scene.add(stage);
  }

  // Soft baked contact shadow: blurred rounded rectangles (ambient occlusion of a box on a table).
  function contactShadow(w, d, r) {
    const m = 46;
    const PW = w + 2 * m, PD = d + 2 * m;
    const k = 512 / PW;
    const cw = 512, ch = Math.round(PD * k);
    const tex = MC.tex.canvas(cw, ch, ctx => {
      const rr = (x, y, ww, hh, rad) => {
        ctx.beginPath();
        ctx.moveTo(x + rad, y);
        ctx.arcTo(x + ww, y, x + ww, y + hh, rad); ctx.arcTo(x + ww, y + hh, x, y + hh, rad);
        ctx.arcTo(x, y + hh, x, y, rad); ctx.arcTo(x, y, x + ww, y, rad);
        ctx.closePath();
      };
      // the shadow-offset trick blurs in every browser (ctx.filter is not everywhere)
      const layer = (inset, blurMm, alpha) => {
        ctx.save();
        ctx.shadowColor = 'rgba(0,0,0,' + alpha + ')';
        ctx.shadowBlur = blurMm * k;
        ctx.shadowOffsetX = 4000;
        ctx.fillStyle = '#000';
        rr(m * k + inset * k - 4000, m * k + inset * k, (w - 2 * inset) * k, (d - 2 * inset) * k, Math.max(1, (r - inset)) * k);
        ctx.fill();
        ctx.restore();
      };
      layer(-6, 30, 0.42);
      layer(0, 10, 0.55);
      layer(2, 3.2, 0.75);
    });
    const mat = new T.MeshBasicMaterial({ color: '#000000', map: tex, transparent: true, depthWrite: false, opacity: 0.85 });
    const mesh = new T.Mesh(new T.PlaneGeometry(PW, PD), mat);
    mesh.rotation.x = -Math.PI / 2;
    mesh.position.y = 0.06;
    mesh.renderOrder = -2;
    mesh.userData.noPick = true;
    return mesh;
  }

  // ------------------------------------------------------------------ case data
  function fallbackCase() {
    const W = 190, D = 130, H_FRONT = 40, SLOPE = 10, LID = 4, WALL = 3.2, FLOOR = 4, R = 8;
    const sin = Math.sin(SLOPE * DEG), cos = Math.cos(SLOPE * DEG);
    const c2w = (x, y, z) => [x - W / 2, z, D / 2 - y];
    const U = [1, 0, 0], V = [0, sin, -cos], N = [0, cos, sin];
    const O = c2w(0, 0, H_FRONT);
    const onLid = (u, v, n) => [0, 1, 2].map(i => O[i] + u * U[i] + v * V[i] + n * N[i]);
    const neg = a => a.map(x => -x);
    const place = {
      uno: { origin: c2w(42, 93, FLOOR + 5), x: [1, 0, 0], y: [0, 1, 0] },
      breadboard: { origin: c2w(140, 80, FLOOR), x: [1, 0, 0], y: [0, 1, 0] },
      keypad: { origin: onLid(50, 58, 0.85), x: U, y: N },
      oled: { origin: onLid(140, 104, -LID - 1.2), x: U, y: N },
      rc522: { origin: onLid(140, 40, -LID - 0.4), x: U, y: neg(N) },
      card_DF51AA39: { origin: [168, 0.38, 22], x: [Math.cos(-14 * DEG), 0, -Math.sin(-14 * DEG)], y: [0, 1, 0] },
      card_0885B1A8: { origin: [150, 2.2, -50], x: [Math.cos(28 * DEG), 0, -Math.sin(28 * DEG)], y: [0, 1, 0] },
      card_049F905C110189: { origin: [128, 0.15, 88], x: [1, 0, 0], y: [0, 1, 0] },
      card_04CABD5C110189: { origin: [172, 1.25, 84], x: [1, 0, 0], y: [0, 1, 0] }
    };
    return {
      version: 11, fallback: true,
      dims: { W, D, H_FRONT, SLOPE, LID, WALL, FLOOR, R },
      lid: { origin: O, u: U, v: V, n: N, length: D / cos, thickness: LID },
      place,
      tapZone: { origin: onLid(140, 40, 0), radius: 22 },
      keypadSlot: { origin: onLid(50, 14, 0), size: [22, 2.6] }
    };
  }

  function b64(s) {
    const bin = atob(s);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }
  function decodeMesh(m) {
    const pb = b64(m.pos);
    const q = new Int16Array(pb.buffer, 0, pb.byteLength >> 1);
    const sc = m.scale || [1, 1, 1], of = m.offset || [0, 0, 0];
    const pos = new Float32Array(q.length);
    for (let i = 0; i < q.length; i += 3) {
      pos[i] = q[i] * sc[0] + of[0];
      pos[i + 1] = q[i + 1] * sc[1] + of[1];
      pos[i + 2] = q[i + 2] * sc[2] + of[2];
    }
    const ib = b64(m.idx);
    const idx = m.idx32 ? new Uint32Array(ib.buffer, 0, ib.byteLength >> 2) : new Uint16Array(ib.buffer, 0, ib.byteLength >> 1);
    const g = new T.BufferGeometry();
    g.setAttribute('position', new T.BufferAttribute(pos, 3));
    g.setIndex(new T.BufferAttribute(idx, 1));
    return g;
  }

  // Split the triangles of a non-indexed geometry into group 0 (layer lines) and group 1
  // (bed side: the lid top, printed face down).
  function splitBedSide(geo, planeP, planeN) {
    const pos = geo.getAttribute('position');
    const triCount = pos.count / 3;
    const a = v3(), b = v3(), c = v3(), n = v3(), e1 = v3(), e2 = v3();
    const bed = new Uint8Array(triCount);
    let bedCount = 0;
    for (let t = 0; t < triCount; t++) {
      a.fromBufferAttribute(pos, t * 3); b.fromBufferAttribute(pos, t * 3 + 1); c.fromBufferAttribute(pos, t * 3 + 2);
      n.crossVectors(e1.subVectors(b, a), e2.subVectors(c, a));
      const len = n.length();
      if (len < 1e-9) continue;
      n.divideScalar(len);
      if (n.dot(planeN) < 0.985) continue;
      const cx = (a.x + b.x + c.x) / 3 - planeP.x, cy = (a.y + b.y + c.y) / 3 - planeP.y, cz = (a.z + b.z + c.z) / 3 - planeP.z;
      if (Math.abs(cx * planeN.x + cy * planeN.y + cz * planeN.z) > 0.3) continue;
      bed[t] = 1; bedCount++;
    }
    if (!bedCount) return geo;
    const out = new T.BufferGeometry();
    for (const name of Object.keys(geo.attributes)) {
      const src = geo.getAttribute(name), size = src.itemSize;
      const arr = new src.array.constructor(src.array.length);
      let w = 0;
      for (const want of [0, 1]) {
        for (let t = 0; t < triCount; t++) {
          if (bed[t] !== want) continue;
          arr.set(src.array.subarray(t * 3 * size, (t + 1) * 3 * size), w);
          w += 3 * size;
        }
      }
      out.setAttribute(name, new T.BufferAttribute(arr, size, src.normalized));
    }
    out.addGroup(0, (triCount - bedCount) * 3, 0);
    out.addGroup((triCount - bedCount) * 3, bedCount * 3, 1);
    return out;
  }

  // Fallback case: a sloped box with an OLED window, used only while data/case_geo.js is missing.
  function fallbackCaseGeometry(kind) {
    const d = st.caseData.dims, W = d.W, D = d.D, R = d.R, WALL = d.WALL, LID = d.LID;
    const tan = Math.tan(d.SLOPE * DEG), cos = Math.cos(d.SLOPE * DEG);
    const rr = (shape, x, y, w, h, r) => {
      shape.moveTo(x + r, y); shape.lineTo(x + w - r, y); shape.quadraticCurveTo(x + w, y, x + w, y + r);
      shape.lineTo(x + w, y + h - r); shape.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
      shape.lineTo(x + r, y + h); shape.quadraticCurveTo(x, y + h, x, y + h - r);
      shape.lineTo(x, y + r); shape.quadraticCurveTo(x, y, x + r, y);
    };
    const under = z => d.H_FRONT - LID / cos + (D / 2 - z) * tan;   // lid underside at world z
    if (kind === 'base') {
      const outer = new T.Shape(); rr(outer, -W / 2, -D / 2, W, D, R);
      const hole = new T.Path(); rr(hole, -W / 2 + WALL, -D / 2 + WALL, W - 2 * WALL, D - 2 * WALL, R - WALL);
      outer.holes.push(hole);
      const hMax = under(-D / 2) + 0.01;
      const walls = new T.ExtrudeGeometry(outer, { depth: hMax, bevelEnabled: false, curveSegments: 6 });
      const floorShape = new T.Shape(); rr(floorShape, -W / 2 + 0.5, -D / 2 + 0.5, W - 1, D - 1, R - 0.5);
      const floor = new T.ExtrudeGeometry(floorShape, { depth: d.FLOOR, bevelEnabled: false, curveSegments: 6 });
      const geos = [walls, floor].map(g => {
        g.rotateX(-Math.PI / 2);   // extrude along +Y, shape y -> -z
        const p = g.getAttribute('position');
        for (let i = 0; i < p.count; i++) p.setY(i, Math.min(p.getY(i), under(p.getZ(i))));
        return g.index ? g.toNonIndexed() : g;
      });
      geos.forEach(g => { g.deleteAttribute('uv'); g.deleteAttribute('normal'); });
      return T.BufferGeometryUtils.mergeBufferGeometries(geos);
    }
    const shape = new T.Shape(); rr(shape, -W / 2, -D / 2, W, D, R);
    // holes in lid coordinates (u across, v up the slope): OLED window, keypad slot
    const L = st.lid;
    const hole = (u, v, w, h) => {
      const p = L.O.clone().addScaledVector(L.U, u).addScaledVector(L.V, v);
      const path = new T.Path(); rr(path, p.x - w / 2, -p.z - (h * cos) / 2, w, h * cos, 1);
      shape.holes.push(path);
    };
    const pl = st.caseData.place.oled;
    if (pl) {
      const o = vfa(pl.origin).sub(L.O);
      hole(o.dot(L.U), o.dot(L.V) + 2, 31.5, 17);
    }
    const ks = st.caseData.keypadSlot;
    if (ks) { const o = vfa(ks.origin).sub(L.O); hole(o.dot(L.U), o.dot(L.V), ks.size[0], ks.size[1] * 1.6); }
    const g = new T.ExtrudeGeometry(shape, { depth: LID, bevelEnabled: true, bevelThickness: 0.8, bevelSize: 0.8, bevelSegments: 2, curveSegments: 6 });
    g.rotateX(-Math.PI / 2);
    const p = g.getAttribute('position');
    for (let i = 0; i < p.count; i++) p.setY(i, under(p.getZ(i)) + p.getY(i) / cos);
    g.deleteAttribute('uv'); g.deleteAttribute('normal');
    return g.index ? g.toNonIndexed() : g;
  }

  function buildCase() {
    const cd = st.caseData;
    st.caseColor = st.caseColor || (MC.tokens.caseColors[0] && MC.tokens.caseColors[0].hex) || '#E4E6EA';
    for (const kind of ['base', 'lid']) {
      let geo;
      const src = cd.meshes && cd.meshes[kind];
      try { geo = src ? decodeMesh(src) : fallbackCaseGeometry(kind); }
      catch (err) { console.error('[scene] case mesh ' + kind, err); geo = fallbackCaseGeometry(kind); }
      if (!geo.index) geo = T.BufferGeometryUtils.mergeVertices(geo, 1e-3);
      geo = T.BufferGeometryUtils.toCreasedNormals(geo, 35 * DEG);
      if (kind === 'lid') geo = splitBedSide(geo, st.lid.O, st.lid.N);
      MC.tex.boxUV(geo, MC.tex.LAYER_TILE_MM);
      geo.computeBoundingBox(); geo.computeBoundingSphere();
      const solid = [MC.mat.pla(st.caseColor), MC.mat.pla(st.caseColor, { bed: true, normal: 0.12 })];
      const mesh = new T.Mesh(geo, geo.groups.length ? solid : solid[0]);
      mesh.castShadow = mesh.receiveShadow = true;
      mesh.name = 'case_' + kind;
      mesh.userData.part = kind === 'base' ? 'case_base' : 'case_lid';
      const xray = MC.mat.xray(st.theme === 'light' ? '#9AA6B4' : '#DDE3EA');
      xray.opacity = 0.075;
      xray.side = T.FrontSide;        // one layer per wall reads cleaner than front + back
      xray.roughness = 0.32;
      xray.clearcoat = 0;
      const rec = { kind, id: mesh.userData.part, mesh, solid, xray, edges: null, mats: new Set(solid), ghost: false };
      solid.forEach(trackBase);
      trackBase(xray);
      rec.mats.add(xray);
      (kind === 'base' ? st.baseRig : st.lidRig).add(mesh);
      st.caseMeshes.push(rec);
      // other meshes the case file may carry (feet, inserts) go with the base
    }
    if (cd.meshes) {
      for (const name of Object.keys(cd.meshes)) {
        if (name === 'base' || name === 'lid') continue;
        try {
          let geo = T.BufferGeometryUtils.toCreasedNormals(decodeMesh(cd.meshes[name]), 35 * DEG);
          MC.tex.boxUV(geo);
          const mesh = new T.Mesh(geo, MC.mat.pla(st.caseColor));
          mesh.castShadow = mesh.receiveShadow = true;
          mesh.userData.part = /^lid/.test(name) ? 'case_lid' : 'case_base';
          const rec = st.caseMeshes.find(r => r.id === mesh.userData.part);
          if (rec) { rec.extra = rec.extra || []; rec.extra.push(mesh); trackBase(mesh.material); rec.mats.add(mesh.material); }
          (/^lid/.test(name) ? st.lidRig : st.baseRig).add(mesh);
        } catch (err) { console.error('[scene] case mesh ' + name, err); }
      }
    }
    const d = cd.dims;
    st.contact = contactShadow(d.W, d.D, d.R || 8);
    st.stage.add(st.contact);
  }

  function readCaseFrame() {
    const cd = st.caseData, d = cd.dims;
    const L = cd.lid || {};
    const sin = Math.sin((d.SLOPE || 10) * DEG), cos = Math.cos((d.SLOPE || 10) * DEG);
    st.lid = {
      O: L.origin ? vfa(L.origin) : v3(-d.W / 2, d.H_FRONT, d.D / 2),
      U: L.u ? vfa(L.u).normalize() : v3(1, 0, 0),
      V: L.v ? vfa(L.v).normalize() : v3(0, sin, -cos),
      N: L.n ? vfa(L.n).normalize() : v3(0, cos, sin),
      length: L.length || d.D / cos,
      thick: L.thickness || d.LID || 4
    };
    const lidTopBack = st.lid.O.clone().addScaledVector(st.lid.V, st.lid.length);
    st.lidPivot = v3(0, lidTopBack.y, lidTopBack.z);
    const wall = d.WALL || 3.2;
    st.inner = {
      x0: -d.W / 2 + wall + 2.2, x1: d.W / 2 - wall - 2.2,
      z0: -d.D / 2 + wall + 2.2, z1: d.D / 2 - wall - 2.2,
      floor: (d.FLOOR || 4) + 1.4
    };
  }

  // ------------------------------------------------------------------ stand-in parts
  // Clearly simple stand-ins of the SPEC size, used only while a builder is missing.
  const STAND = {};
  function sbox(w, h, d, mat, x, y, z) {
    const m = new T.Mesh(new T.BoxGeometry(w, h, d), mat);
    m.position.set(x || 0, y || 0, z || 0);
    return m;
  }
  function finish(part, built) {
    built.group.traverse(o => { if (o.isMesh) o.userData.part = part; });
    built.extra = built.extra || {};
    built.standIn = true;
    return built;
  }
  STAND.uno = function () {
    const g = new T.Group(), W = 68.6, D = 53.3, TH = 1.6;
    const pcbTex = MC.tex.board(W, D, '#00838C', ctx => {
      ctx.fillStyle = 'rgba(255,255,255,0.85)';
      ctx.font = '700 5px Arial'; ctx.fillText('UNO', 34, 32);
      ctx.font = '600 2.2px Arial'; ctx.fillText('stand-in', 34, 36);
    }, 8);
    const top = sbox(W, TH, D, MC.mat.pcb(pcbTex), 0, TH / 2, 0);
    g.add(top);
    const pins = {};
    const P = (name, bx, by) => { pins[name] = { p: v3(bx * 0.0254 - W / 2, TH + 8.5, D / 2 - by * 0.0254), d: v3(0, 1, 0) }; };
    for (let i = 0; i <= 7; i++) P('D' + i, 2600 - 100 * i, 2000);
    for (let i = 8; i <= 13; i++) P('D' + i, 1740 - 100 * (i - 8), 2000);
    P('GND3', 1140, 2000); P('AREF', 1040, 2000); P('SDA', 940, 2000); P('SCL', 840, 2000);
    P('IOREF', 1300, 100); P('RESET', 1400, 100); P('3V3', 1500, 100); P('5V', 1600, 100);
    P('GND1', 1700, 100); P('GND2', 1800, 100); P('VIN', 1900, 100);
    for (let i = 0; i <= 5; i++) P('A' + i, 2100 + 100 * i, 100);
    const hdr = MC.mat.blackPlastic();
    const strip = (x0, x1, by) => g.add(sbox((x1 - x0) * 0.0254 + 2.54, 8.5, 2.54, hdr, ((x0 + x1) / 2) * 0.0254 - W / 2, TH + 4.25, D / 2 - by * 0.0254));
    strip(1900, 2600, 2000); strip(840, 1740, 2000); strip(1200, 1900, 100); strip(2100, 2600, 100);
    const usbZ = D / 2 - 38.1, jackZ = D / 2 - 7.6;
    g.add(sbox(16, 10.9, 12, MC.mat.steel(), -W / 2 - 6.3 + 8, TH + 5.45, usbZ));
    g.add(sbox(13.7, 11, 9, MC.mat.blackPlastic(), -W / 2 - 1.8 + 6.85, TH + 5.5, jackZ));
    g.add(sbox(35, 3.5, 7.6, MC.mat.epoxy(), 10, TH + 5, D / 2 - 18));
    return finish('uno', { group: g, pins, size: [W, TH + 11, D],
      extra: { usb: v3(-W / 2 - 6.3, TH + 5.45, usbZ), jack: v3(-W / 2 - 1.8, TH + 5.5, jackZ) } });
  };
  STAND.oled = function () {
    const g = new T.Group(), W = 35.4, D = 33.5, TH = 1.2;
    g.add(sbox(W, TH, D, MC.mat.pcb(MC.tex.board(W, D, '#1B2F7A', null, 6)), 0, TH / 2, 0));
    g.add(sbox(34.5, 1.45, 23, MC.mat.blackGlass(), 0, TH + 0.725, 2.2));
    const screen = new T.Mesh(new T.PlaneGeometry(29.42, 14.7), MC.mat.oledPixels());
    screen.rotation.x = -Math.PI / 2; screen.position.set(0, TH + 1.46, 1.6);
    const glow = new T.Mesh(new T.PlaneGeometry(36, 21), MC.mat.oledGlow());
    glow.rotation.x = -Math.PI / 2; glow.position.set(0, TH + 1.6, 1.6);
    g.add(screen, glow);
    const pins = {};
    ['GND', 'VCC', 'SCL', 'SDA'].forEach((n, i) => {
      const x = (i - 1.5) * 2.54, z = -D / 2 + 1.6;
      g.add(sbox(0.64, 8.5, 0.64, MC.mat.gold(), x, -3.25, z));
      g.add(sbox(2.54, 2.5, 2.54, MC.mat.blackPlastic(), x, -1.25, z));
      pins[n] = { p: v3(x, -7.5, z), d: v3(0, -1, 0) };
    });
    return finish('oled', { group: g, pins, size: [W, TH + 1.45, D], extra: { screen, glow } });
  };
  STAND.rc522 = function () {
    const g = new T.Group(), W = 39, D = 60, TH = 1.6;
    const tex = MC.tex.board(W, D, '#1C4FA6', ctx => {
      ctx.strokeStyle = 'rgba(210,225,255,0.55)'; ctx.lineWidth = 0.9;
      for (let i = 0; i < 4; i++) ctx.strokeRect(3 + i * 1.6, 3 + i * 1.6, W - 6 - i * 3.2, 34 - i * 3.2);
    }, 8);
    g.add(sbox(W, TH, D, MC.mat.pcb(tex), 0, TH / 2, 0));
    g.add(sbox(7, 1.2, 7, MC.mat.epoxy(), 0, TH + 0.6, 14));
    const pins = {};
    ['SDA', 'SCK', 'MOSI', 'MISO', 'IRQ', 'GND', 'RST', '3V3'].forEach((n, i) => {
      const x = (i - 3.5) * 2.54;
      g.add(sbox(0.64, 0.64, 9, MC.mat.gold(), x, TH + 1.27, D / 2 + 2.5));
      pins[n] = { p: v3(x, TH + 1.27, D / 2 + 7), d: v3(0, 0, 1) };
    });
    g.add(sbox(20.3, 2.54, 2.54, MC.mat.blackPlastic(), 0, TH + 1.27, D / 2 - 0.2));
    return finish('rc522', { group: g, pins, size: [W, TH + 2.5, D], extra: { antennaCentre: v3(0, TH, -11) } });
  };
  STAND.keypad = function () {
    const g = new T.Group(), W = 69.2, D = 76.9, TH = 0.8;
    const chars = '123A456B789C*0#D';
    const face = MC.tex.canvas(512, 568, (ctx, w, h) => { ctx.fillStyle = '#1D1F24'; ctx.fillRect(0, 0, w, h); });
    g.add(sbox(W, TH, D, MC.mat.membrane(face), 0, TH / 2, 0));
    const keys = {};
    for (let i = 0; i < 16; i++) {
      const ch = chars[i], r = Math.floor(i / 4), c = i % 4;
      const lt = MC.tex.canvas(128, 112, (ctx, w, h) => {
        ctx.fillStyle = /[ABCD]/.test(ch) ? '#C9353B' : (/[*#]/.test(ch) ? '#2F6FEB' : '#F2F3F5');
        ctx.fillRect(0, 0, w, h);
        MC.tex.text(ctx, ch, w / 2, h / 2 + 4, { size: 70, weight: 700, color: /[ABCD*#]/.test(ch) ? '#FFFFFF' : '#1D1F24', align: 'center' });
      });
      const key = sbox(14, 0.5, 12, MC.mat.membrane(lt), (c - 1.5) * 16.6, TH + 0.25, (r - 1.5) * 16.6 - 3.5);
      key.material.map = lt;
      g.add(key);
      keys[ch] = key;
    }
    const tailMat = MC.mat.membrane(null, '#C9CCD2');
    const tail = new T.Mesh(new T.BufferGeometry(), tailMat);
    const conn = sbox(20.3, 2.6, 8, MC.mat.blackPlastic());
    g.add(tail, conn);
    const pins = {};
    for (let i = 1; i <= 8; i++) pins['P' + i] = { p: v3(), d: v3(0, 0, 1) };
    const setTailPath = pts => {
      const curve = new T.CatmullRomCurve3(pts, false, 'centripetal');
      const n = 48, pos = [], idx = [];
      const side0 = v3(1, 0, 0);
      for (let i = 0; i <= n; i++) {
        const p = curve.getPoint(i / n), t = curve.getTangent(i / n);
        const s = side0.clone().addScaledVector(t, -side0.dot(t)).normalize().multiplyScalar(10);
        pos.push(p.x - s.x, p.y - s.y, p.z - s.z, p.x + s.x, p.y + s.y, p.z + s.z);
        if (i) { const k = i * 2; idx.push(k - 2, k - 1, k, k - 1, k + 1, k); }
      }
      const geo = new T.BufferGeometry();
      geo.setAttribute('position', new T.Float32BufferAttribute(pos, 3));
      geo.setIndex(idx); geo.computeVertexNormals();
      tail.geometry.dispose(); tail.geometry = geo;
      tail.material.side = T.DoubleSide;
      const end = curve.getPoint(1), dir = curve.getTangent(1);
      conn.position.copy(end).addScaledVector(dir, 4);
      conn.quaternion.setFromUnitVectors(v3(0, 0, 1), dir);
      const side = side0.clone().addScaledVector(dir, -side0.dot(dir)).normalize();
      for (let i = 1; i <= 8; i++) {
        pins['P' + i].p.copy(end).addScaledVector(dir, 8).addScaledVector(side, (4.5 - i) * 2.54);
        pins['P' + i].d.copy(dir);
      }
    };
    setTailPath([v3(0, 0.4, D / 2), v3(0, 0.4, D / 2 + 30), v3(0, 0.4, D / 2 + 85)]);
    const press = ch => {
      const k = keys[ch]; if (!k) return;
      const y0 = TH + 0.25;
      animate('key' + ch, 160, (e, raw) => { k.position.y = y0 - 0.35 * Math.sin(Math.PI * raw); }, t => t);
    };
    return finish('keypad', { group: g, pins, size: [W, TH, D], extra: { keys, press, tail, setTailPath, tailStart: v3(0, 0.4, D / 2) } });
  };
  STAND.breadboard = function () {
    const g = new T.Group(), W = 82.5, D = 54.5, H = 8.5, P = 2.54;
    const rowZ = {};
    'edcba'.split('').forEach((r, i) => { rowZ[r] = 3.81 + P * (4 - i); });
    'fghij'.split('').forEach((r, i) => { rowZ[r] = -3.81 - P * i; });
    const colX = c => (c - 15.5) * P;
    const rails = { gnd_lower_inner: 20.3, pwr_lower_outer: 22.9, gnd_upper_inner: -20.3, pwr_upper_outer: -22.9 };
    const tex = MC.tex.canvas(1024, 676, (ctx, w, h) => {
      ctx.fillStyle = '#F3F3F0'; ctx.fillRect(0, 0, w, h);
      const k = w / W;
      ctx.fillStyle = '#3A3C40';
      const hole = (x, z) => ctx.fillRect((x + W / 2) * k - 4, (z + D / 2) * k - 4, 8, 8);
      for (let c = 1; c <= 30; c++) for (const r in rowZ) hole(colX(c), rowZ[r]);
      for (const name in rails) for (let c = 2; c <= 29; c++) if ((c - 2) % 6 !== 5) hole(colX(c), rails[name]);
      ctx.fillStyle = '#D8DADD'; ctx.fillRect(0, (D / 2 - 1.4) * k, w, 2.8 * k);
    });
    g.add(sbox(W, H, D, MC.mat.whitePlastic(), 0, H / 2, 0));
    const top = new T.Mesh(new T.PlaneGeometry(W, D), new T.MeshStandardMaterial({ map: tex, roughness: 0.6 }));
    top.rotation.x = -Math.PI / 2; top.position.y = H + 0.02;
    g.add(top);
    const hole = name => {
      const m = /^([a-j])(\d+)$/.exec(name);
      if (m) return v3(colX(+m[2]), H, rowZ[m[1]]);
      const r = /^(\w+):(\d+)$/.exec(name);
      if (r && rails[r[1]] !== undefined) return v3(colX(+r[2]), H, rails[r[1]]);
      return null;
    };
    return finish('breadboard', { group: g, pins: {}, size: [W, H, D], extra: { hole } });
  };
  STAND.buzzer = function () {
    const g = new T.Group();
    g.add(sbox(15, 1.6, 18.5, MC.mat.pcb(MC.tex.board(15, 18.5, '#1A1C20', null, 6)), 0, 6.8, -5));
    const cyl = new T.Mesh(new T.CylinderGeometry(6, 6, 8.5, 32), MC.mat.epoxy());
    cyl.position.set(0, 7.6 + 4.25, -5);
    g.add(cyl);
    g.add(sbox(7.62, 2.5, 2.54, MC.mat.blackPlastic(), 0, 4.75, 0));
    const pins = {};
    const pinEntry = {};
    g.children.forEach(c => { c.position.y -= 3.5; });
    [['S', -2.54], ['M', 0], ['MINUS', 2.54]].forEach(([n, x]) => {
      g.add(sbox(0.64, 9, 0.64, MC.mat.gold(), x, -1.5, 0));
      pins[n] = { p: v3(x, -6, 0), d: v3(0, -1, 0) };
      pinEntry[n] = v3(x, 0, 0);
    });
    return finish('buzzer', { group: g, pins, size: [15, 16, 18.5], extra: { pinEntry } });
  };
  STAND.resistor = function (span) {
    const g = new T.Group();
    const body = new T.Mesh(new T.CylinderGeometry(1.2, 1.2, 6.3, 20), MC.mat.ceramic('#C9B48A'));
    body.position.set(0, 5, 0);
    g.add(body);
    g.add(sbox(0.5, 10, 0.5, MC.mat.tin(), -span / 2, 0, 0), sbox(0.5, 10, 0.5, MC.mat.tin(), span / 2, 0, 0));
    return finish('resistor', { group: g, pins: { a: { p: v3(-span / 2, 0, 0), d: v3(0, -1, 0) }, b: { p: v3(span / 2, 0, 0), d: v3(0, -1, 0) } }, size: [span, 10, 2.4], extra: {} });
  };
  STAND.transponder = function (kind, uid) {
    const g = new T.Group();
    const label = MC.tex.canvas(512, 324, (ctx, w, h) => {
      ctx.fillStyle = kind === 'fob' ? '#2456C9' : kind === 'coin' ? '#202226' : '#F4F5F7';
      ctx.fillRect(0, 0, w, h);
      MC.tex.text(ctx, MC.formatUid(uid), w / 2, h / 2, { size: 40, color: kind === 'card' || kind === 'sticker' ? '#20242A' : '#FFFFFF', align: 'center', font: 'Consolas, monospace' });
    });
    let m;
    if (kind === 'card') m = sbox(85.6, 0.76, 54, MC.mat.pcb(label), 0, 0.38, 0);
    else if (kind === 'fob') m = sbox(31, 4.5, 40, MC.mat.pcb(label), 0, 2.25, 0);
    else { m = new T.Mesh(new T.CylinderGeometry(12.5, 12.5, kind === 'coin' ? 2.5 : 0.3, 40), MC.mat.pcb(label)); m.position.y = kind === 'coin' ? 1.25 : 0.15; }
    g.add(m);
    return finish('card_' + uid, { group: g, pins: {}, size: [85.6, 1, 54], extra: {} });
  };
  STAND.wire = function (o) {
    const group = new T.Group();
    const mat = MC.mat.wire(o.color || '#888888');
    const tube = new T.Mesh(new T.BufferGeometry(), mat);
    const ends = [o.endA || 'male', o.endB || 'male'].map(kind => {
      const g = new T.Group();
      const h = sbox(2.5, 2.5, HOUSING, MC.mat.shared.blackPlastic);
      h.position.z = (kind === 'male' ? MALE_PIN : 0) + HOUSING / 2;
      g.add(h);
      if (kind === 'male') { const pin = sbox(0.64, 0.64, MALE_PIN, MC.mat.shared.gold); pin.position.z = MALE_PIN / 2; g.add(pin); }
      group.add(g);
      return { g, kind, len: (kind === 'male' ? MALE_PIN : 0) + HOUSING };
    });
    group.add(tube);
    const update = (pts, dirA, dirB) => {
      const n = pts.length;
      const aA = (dirA || pts[1].clone().sub(pts[0])).clone().normalize();
      const aB = (dirB || pts[n - 2].clone().sub(pts[n - 1])).clone().normalize();
      const tipA = pts[0].clone().addScaledVector(aA, -(o.seatA || 0));
      const tipB = pts[n - 1].clone().addScaledVector(aB, -(o.seatB || 0));
      [[ends[0], tipA, aA], [ends[1], tipB, aB]].forEach(([e, tip, ax]) => {
        e.g.position.copy(tip);
        e.g.quaternion.setFromUnitVectors(v3(0, 0, 1), ax);
      });
      const backA = tipA.clone().addScaledVector(aA, ends[0].len), backB = tipB.clone().addScaledVector(aB, ends[1].len);
      const ctrl = [backA, backA.clone().addScaledVector(aA, 3)];
      for (let i = 1; i < n - 1; i++) if (pts[i].distanceTo(tipA) > ends[0].len + 4 && pts[i].distanceTo(tipB) > ends[1].len + 4) ctrl.push(pts[i]);
      ctrl.push(backB.clone().addScaledVector(aB, 3), backB);
      const curve = new T.CatmullRomCurve3(ctrl, false, 'centripetal');
      tube.geometry.dispose();
      tube.geometry = new T.TubeGeometry(curve, Math.min(220, Math.max(24, Math.round(curve.getLength() / 1.6))), 0.8, 8, false);
      group.userData.curve = curve;
    };
    update(o.points);
    return { group, update, curve: () => group.userData.curve };
  };

  // ------------------------------------------------------------------ parts
  function hasBuilder(name) { return !!(MC.parts && typeof MC.parts[name] === 'function'); }
  function makePart(id, builder, stand) {
    let built = null;
    const t0 = now();
    if (builder) {
      try { built = builder(); } catch (err) { console.error('[scene] builder for ' + id + ' failed', err); built = null; }
    }
    if (st.timings) st.timings['build_' + id] = Math.round(now() - t0);
    if (!built || !built.group) { built = stand(); st.fallbacks.push(id); }
    built.pins = built.pins || {};
    built.extra = built.extra || {};
    built.group.traverse(o => { if (o.isMesh && !o.userData.part) o.userData.part = id; });
    return built;
  }

  function addPart(id, built, rig, place, kind) {
    const holder = new T.Group();
    holder.name = 'part:' + id;
    holder.matrixAutoUpdate = false;
    holder.add(built.group);
    rig.add(holder);
    const P = {
      id, built, holder, rig: kind, place: place.clone(), drop: 0, dropDir: v3(0, 1, 0),
      mats: new Set(), keyMats: {}, localBox: new T.Box3(), standIn: !!built.standIn
    };
    if (MERGE_PARTS.indexOf(id) >= 0) compactPart(P);
    adoptMaterials(P);
    built.group.updateMatrixWorld(true);
    P.localBox.setFromObject(built.group);
    holder.matrix.copy(P.place);
    st.parts[id] = P;
    return P;
  }

  // Merge static meshes of one part by material: far fewer draw calls. Everything that the
  // builder exposes in `extra` (keys, screen, glow, tail ...) and their subtrees stay untouched.
  function compactPart(P) {
    const g = P.built.group, ex = P.built.extra || {};
    const keep = new Set();
    const keepTree = o => { if (o && o.isObject3D) o.traverse(c => keep.add(c)); };
    for (const k of Object.keys(ex)) {
      const v = ex[k];
      if (!v || typeof v !== 'object') continue;
      if (v.isObject3D) keepTree(v);
      else if (Array.isArray(v)) v.forEach(keepTree);
      else if (!v.isVector3) for (const kk of Object.keys(v)) keepTree(v[kk]);
    }
    g.updateMatrixWorld(true);
    const inv = new T.Matrix4().copy(g.matrixWorld).invert();
    const buckets = new Map();
    g.traverse(o => {
      if (!o.isMesh || o.isInstancedMesh || o.isSkinnedMesh || keep.has(o) || Array.isArray(o.material)) return;
      if (o.children.length || o.userData.noMerge || o.userData.dynamic || !o.visible) return;
      for (let a = o.parent; a && a !== g; a = a.parent) if (keep.has(a) || a.userData.noMerge || a.userData.dynamic) return;
      const geo = o.geometry;
      if (!geo || !geo.attributes.position || (geo.morphAttributes && Object.keys(geo.morphAttributes).length)) return;
      if (o.matrixWorld.determinant() < 0) return;
      const sig = Object.keys(geo.attributes).sort().map(n => { const a = geo.attributes[n]; return n + a.itemSize + (a.normalized ? 'n' : '') + a.array.constructor.name; }).join(',');
      const key = o.material.uuid + '|' + sig + '|' + (o.castShadow ? 1 : 0) + (o.receiveShadow ? 1 : 0) + '|' + o.renderOrder + '|' + (o.userData.part || '');
      if (!buckets.has(key)) buckets.set(key, []);
      buckets.get(key).push(o);
    });
    for (const list of buckets.values()) {
      if (list.length < 2) continue;
      const geos = list.map(o => {
        const ge = o.geometry.index ? o.geometry.toNonIndexed() : o.geometry.clone();
        ge.clearGroups();
        ge.applyMatrix4(new T.Matrix4().multiplyMatrices(inv, o.matrixWorld));
        return ge;
      });
      const merged = T.BufferGeometryUtils.mergeBufferGeometries(geos, false);
      if (!merged) continue;
      const m = new T.Mesh(merged, list[0].material);
      m.castShadow = list[0].castShadow; m.receiveShadow = list[0].receiveShadow;
      m.renderOrder = list[0].renderOrder;
      m.userData = Object.assign({}, list[0].userData, { merged: list.length });
      m.name = 'merged';
      list.forEach(o => o.parent.remove(o));
      g.add(m);
    }
  }

  function trackBase(m) {
    if (!m || m.userData.mcBase) return;
    m.userData.mcBase = {
      color: m.color ? m.color.clone() : null,
      emissive: m.emissive ? m.emissive.clone() : null,
      emissiveIntensity: m.emissiveIntensity,
      opacity: m.opacity, transparent: m.transparent, depthWrite: m.depthWrite
    };
  }

  // Each part gets its own material copies so hover and focus tint only that part.
  // Keypad keys get one copy per key so a single key can light up.
  function adoptMaterials(P) {
    const map = new Map(), keyOf = new Map();
    const ex = P.built.extra || {};
    if (ex.keys) for (const ch of Object.keys(ex.keys)) { const k = ex.keys[ch]; if (k && k.isObject3D) k.traverse(o => keyOf.set(o, ch)); }
    const special = new Set();
    for (const name of ['screen', 'glow']) if (ex[name] && ex[name].isObject3D) ex[name].traverse(o => special.add(o));
    P.built.group.traverse(o => {
      if (!o.material) return;
      const ch = keyOf.get(o);
      const swap = m => {
        let c;
        if (ch !== undefined) { c = m.clone(); (P.keyMats[ch] = P.keyMats[ch] || []).push(c); }
        else { c = map.get(m); if (!c) { c = m.clone(); map.set(m, c); } }
        if (special.has(o)) c.userData.noTint = true;
        trackBase(c);
        P.mats.add(c);
        return c;
      };
      o.material = Array.isArray(o.material) ? o.material.map(swap) : swap(o.material);
      if (o.isMesh) {
        const tr = (Array.isArray(o.material) ? o.material : [o.material]).some(m => m.transparent || m.blending === T.AdditiveBlending);
        o.castShadow = !tr && !special.has(o);
        o.receiveShadow = !special.has(o);
      }
    });
  }

  function buildParts() {
    const place = st.caseData.place || {};
    const lidSet = new Set(LID_PARTS);
    for (const id of ['uno', 'breadboard', 'keypad', 'oled', 'rc522']) {
      const pl = place[id];
      const built = makePart(id, hasBuilder(BUILDER_NAMES[id]) ? BUILDERS[id] : null, STAND[id]);
      const M = pl ? MC.placeMatrix(pl) : new T.Matrix4();
      addPart(id, built, lidSet.has(id) ? st.lidRig : st.baseRig, M, lidSet.has(id) ? 'lid' : 'base');
    }
    st.root.updateMatrixWorld(true);
    // buzzer and resistor sit in breadboard holes
    const bb = st.parts.breadboard;
    const holeW = name => { const h = bbHole(name); return h ? h.applyMatrix4(bb.built.group.matrixWorld) : null; };
    {
      const built = makePart('buzzer', hasBuilder('buzzerModule') ? BUILDERS.buzzer : null, STAND.buzzer);
      const map = MC.BREADBOARD_PARTS.buzzer;
      const M = seatInHoles(built, [['S', holeW(map.S)], ['MINUS', holeW(map.MINUS)]], place.buzzer);
      addPart('buzzer', built, st.baseRig, M, 'base');
    }
    {
      const map = MC.BREADBOARD_PARTS.resistor;
      const a = holeW(map.a), b = holeW(map.b);
      const span = a && b ? a.distanceTo(b) : 5.08;
      let built = null;
      if (hasBuilder('resistor')) { try { built = MC.parts.resistor(span); } catch (err) { console.error('[scene] builder for resistor failed', err); } }
      if (!built || !built.group) { built = STAND.resistor(span); st.fallbacks.push('resistor'); }
      built.pins = built.pins || {}; built.extra = built.extra || {};
      built.group.traverse(o => { if (o.isMesh && !o.userData.part) o.userData.part = 'resistor'; });
      let M;
      if (a && b) {
        const x = b.clone().sub(a).normalize();
        const up = bb.built.group.localToWorld(v3(0, 1, 0)).sub(bb.built.group.localToWorld(v3(0, 0, 0))).normalize();
        const z = v3().crossVectors(x, up).normalize();
        M = new T.Matrix4().makeBasis(x, up, z);
        const mid = a.clone().add(b).multiplyScalar(0.5);
        M.setPosition(mid);
      } else M = place.resistor ? MC.placeMatrix(place.resistor) : new T.Matrix4();
      addPart('resistor', built, st.baseRig, M, 'base');
    }
    // transponders
    for (const c of MC.CARDS) {
      let built = null;
      if (hasBuilder('transponder')) { try { built = MC.parts.transponder(c.kind, c.uid); } catch (err) { console.error('[scene] transponder ' + c.uid, err); } }
      if (!built || !built.group) { built = STAND.transponder(c.kind, c.uid); st.fallbacks.push(c.part); }
      built.pins = built.pins || {}; built.extra = built.extra || {};
      built.group.traverse(o => { if (o.isMesh && !o.userData.part) o.userData.part = c.part; });
      const pl = place[c.part];
      const P = addPart(c.part, built, st.cardRig, pl ? MC.placeMatrix(pl) : new T.Matrix4(), 'card');
      P.uid = c.uid;
    }
    st.root.updateMatrixWorld(true);
  }

  function bbHole(name) {
    const bb = st.parts.breadboard;
    if (!bb) return null;
    const ex = bb.built.extra;
    if (bb.built.pins[name]) return bb.built.pins[name].p.clone();
    if (typeof ex.hole === 'function') { const h = ex.hole(name); return h ? h.clone() : null; }
    return null;
  }

  // Place a part whose pins point down so that two of its pins sit INSERT mm deep in two holes.
  function seatInHoles(built, pairs, fallbackPlace) {
    // pin entry points (where a leg meets the board surface); builders give them as
    // extra.pinEntry, otherwise the pin points themselves are the entry points
    const entry = name => (built.extra.pinEntry && built.extra.pinEntry[name]) || (built.pins[name] && built.pins[name].p);
    const ok = pairs.every(([pin, w]) => w && entry(pin));
    if (!ok) return fallbackPlace ? MC.placeMatrix(fallbackPlace) : new T.Matrix4();
    const [p0, w0] = [entry(pairs[0][0]), pairs[0][1]];
    const [p1, w1] = [entry(pairs[1][0]), pairs[1][1]];
    const bb = st.parts.breadboard.built.group;
    const up = bb.localToWorld(v3(0, 1, 0)).sub(bb.localToWorld(v3(0, 0, 0))).normalize();
    // local frame of the pin row
    const lx = p1.clone().sub(p0); lx.y = 0; lx.normalize();
    const ly = v3(0, 1, 0), lz = v3().crossVectors(lx, ly).normalize();
    const L = new T.Matrix4().makeBasis(lx, ly, lz);
    const wx = w1.clone().sub(w0).normalize();
    const wz = v3().crossVectors(wx, up).normalize();
    const Wm = new T.Matrix4().makeBasis(wx, up, wz);
    const R = Wm.multiply(L.clone().transpose());   // rotation local -> world
    const tip = p0.clone().applyMatrix4(R);
    R.setPosition(w0.clone().sub(tip));
    return R;
  }

  // ------------------------------------------------------------------ keypad tail
  // The flat tail leaves the keypad's front edge, goes down through the slot in the lid and hangs
  // in a soft loop under the lid; its 8-pin connector ends in front of the Uno, facing the pins
  // the eight jumpers go to. The loop is sized so the film keeps its real length.
  function bendKeypadTail() {
    const P = st.parts.keypad;
    if (!P || typeof P.built.extra.setTailPath !== 'function') return;
    const ex = P.built.extra, size = P.built.size || [69.2, 0.8, 76.9];
    const M = P.place, inv = M.clone().invert();
    const toL = w => w.clone().applyMatrix4(inv);
    const H = size[2];
    const root = ex.tailRoot ? ex.tailRoot.clone() : (ex.tailStart ? ex.tailStart.clone() : v3(0, 0.21, H / 2 - 5));
    const tailLen = ex.tailLength || 85, connLen = ex.connectorLength || 8;
    const film = (H / 2 - root.z) + tailLen;                   // root -> connector back
    const y0 = root.y;
    const L = st.lid, cd = st.caseData;
    const ks = cd.keypadSlot;
    const slotTop = ks ? vfa(ks.origin) : root.clone().setZ(H / 2 + 2).applyMatrix4(M);
    const slotUnder = ks && ks.under ? vfa(ks.under) : slotTop.clone().addScaledVector(L.N, -L.thick);
    // where the jumpers go: the Uno pins of the keypad wires
    const uno = st.parts.uno;
    const targets = MC.WIRES.filter(w => w.from.part === 'keypad').map(w => uno && uno.built.pins[w.to.pin] ? uno.built.pins[w.to.pin].p.clone().applyMatrix4(uno.built.group.matrixWorld) : null).filter(Boolean);
    const Q = v3();
    if (targets.length) { targets.forEach(t => Q.add(t)); Q.multiplyScalar(1 / targets.length); }
    else Q.set(slotUnder.x, 16, slotUnder.z - 80);
    const under = z => L.O.y - L.thick + (L.O.z - z) * (-L.V.y / L.V.z);   // assembled lid underside
    // connector: horizontally between the slot and the Uno pins, about 46 mm in front of them,
    // tilted up toward the plugs on the Uno headers
    const flat = v3(slotUnder.x - Q.x, 0, slotUnder.z - Q.z);
    const span = flat.length();
    if (span < 1) flat.set(0, 0, 1); else flat.multiplyScalar(1 / span);
    const reach = MC.clamp(span * 0.75, 30, 58);
    const E = Q.clone().addScaledVector(flat, reach);           // connector front face
    const floor = st.inner.floor;
    E.y = MC.clamp(Q.y + 12, floor + 10, under(E.z) - 6);
    const dirC = Q.clone().add(v3(0, 16, 0)).sub(E).normalize(); // toward the plug tops
    const C0 = E.clone().addScaledVector(dirC, -connLen);        // connector back
    // film from the slot: straight down through the lid, then a hanging loop into the connector
    const X = slotUnder.clone().addScaledVector(L.N, -2.2);
    const down = L.N.clone().negate();
    const lenTo = pts => { let l = 0; for (let i = 1; i < pts.length; i++) l += pts[i].distanceTo(pts[i - 1]); return l; };
    const head = [root.applyMatrix4(M), v3(0, y0, H / 2 - 0.6).applyMatrix4(M), slotTop.clone().addScaledVector(L.N, 0.25), slotUnder, X];
    const need = film - lenTo(head);
    const sample = arm => {
      const c1 = X.clone().addScaledVector(down, arm), c2 = C0.clone().addScaledVector(dirC, -arm * 0.8);
      const out = [];
      for (let i = 1; i <= 18; i++) {
        const t = i / 18, u = 1 - t;
        const p = v3().addScaledVector(X, u * u * u).addScaledVector(c1, 3 * u * u * t).addScaledVector(c2, 3 * u * t * t).addScaledVector(C0, t * t * t);
        p.y = Math.max(p.y, floor + 3);
        out.push(p);
      }
      return out;
    };
    let lo = 1, hi = 160, loop = sample(lo);
    for (let k = 0; k < 24; k++) {
      const mid = (lo + hi) / 2;
      loop = sample(mid);
      if (lenTo([X].concat(loop)) < need) lo = mid; else hi = mid;
    }
    const world = head.concat(loop, [E]);
    const pts = world.map(toL);
    try {
      const res = ex.setTailPath(pts, { widthAxis: v3(1, 0, 0) });
      if (res && typeof res === 'object' && res.P1) Object.keys(res).forEach(k => { P.built.pins[k] = res[k]; });
    } catch (err) { console.error('[scene] keypad tail', err); }
  }

  // ------------------------------------------------------------------ wires
  function buildWires() {
    for (const def of MC.WIRES) {
      const net = MC.net(def.net);
      const color = net ? net.color : '#888888';
      const W = { def, id: def.id, net: def.net, step: def.step, color, mats: new Set(), points: null, obj: null, bundle: null, glow: new T.Color(color) };
      for (const [name, re] of BUNDLES) if (re.test(def.id)) W.bundle = name;
      st.wires.push(W);
      if (W.bundle) { if (!st.bundles.has(W.bundle)) st.bundles.set(W.bundle, []); st.bundles.get(W.bundle).push(W); }
    }
    computeRoutes();
    for (const W of st.wires) {
      let obj = null;
      const e = W.ends || {};
      if (hasBuilder('wire')) {
        try {
          obj = MC.parts.wire({
            points: W.points, color: W.color, endA: W.def.endA, endB: W.def.endB, net: W.net, id: W.id,
            seatA: e.a ? e.a.seat : 0, seatB: e.b ? e.b.seat : 0, dirA: e.a ? e.a.d : null, dirB: e.b ? e.b.d : null
          });
        } catch (err) { console.error('[scene] wire builder', err); obj = null; }
      }
      if (!obj || !obj.group) {
        obj = STAND.wire({ points: W.points, color: W.color, endA: W.def.endA, endB: W.def.endB, seatA: e.a ? e.a.seat : 0, seatB: e.b ? e.b.seat : 0 });
        if (st.fallbacks.indexOf('wire') < 0) st.fallbacks.push('wire');
      }
      W.obj = obj;
      obj.group.name = 'wire:' + W.id;
      const cache = new Map();
      obj.group.traverse(o => {
        o.userData.wire = W.id; o.userData.net = W.net;
        if (o.userData.part) delete o.userData.part;
        if (!o.material) return;
        const swap = m => { let c = cache.get(m); if (!c) { c = m.clone(); cache.set(m, c); trackBase(c); W.mats.add(c); } return c; };
        o.material = Array.isArray(o.material) ? o.material.map(swap) : swap(o.material);
        if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; }
      });
      st.wireRig.add(obj.group);
    }
  }

  function endPoint(ref, kind) {
    const P = st.parts[ref.part];
    if (!P) return null;
    let pin = P.built.pins[ref.pin];
    if (!pin && ref.part === 'breadboard') { const h = bbHole(ref.pin); if (h) pin = { p: h, d: v3(0, 1, 0) }; }
    if (!pin) return null;
    const M = P.built.group.matrixWorld;
    const p = pin.p.clone().applyMatrix4(M);
    const d = (pin.d || v3(0, 1, 0)).clone().transformDirection(M).normalize();
    // parts.wire contract: points[0] = the mating point, seat = how far the plug's own origin
    // (male pin tip / female opening) is pushed back along -d from there.
    const female = kind === 'female';
    const seat = female ? PIN_EXPOSED : MALE_PIN;
    const tip = p.clone().addScaledVector(d, -seat);
    const back = p.clone().addScaledVector(d, female ? HOUSING - PIN_EXPOSED : HOUSING);
    return {
      p, d, seat, kind, tip, h0: female ? tip : p.clone(), h1: back,
      lead: back.clone().addScaledVector(d, LEAD), part: ref.part, onLid: P.rig === 'lid'
    };
  }

  // ---- constraints: walls, floor, lid, parts and the plugs of other wires
  function updateLidPlane() {
    const M = st.lidRig.matrix;
    st.lidPlane.p.copy(st.lid.O).addScaledVector(st.lid.N, -st.lid.thick).applyMatrix4(M);
    st.lidPlane.n.copy(st.lid.N).transformDirection(M);
  }
  function ceilingAt(x, z) {
    const { p, n } = st.lidPlane;
    if (!st.view.lid && st.ex > 0.5) return Infinity;
    if (n.y < 0.25) return Infinity;
    const d = st.caseData.dims;
    if (x < -d.W / 2 - 4 || x > d.W / 2 + 4) return Infinity;
    // outside the lid's footprint (it moves back and up in the explode view)
    const back = st.lid.O.clone().addScaledVector(st.lid.V, st.lid.length).applyMatrix4(st.lidRig.matrix);
    const front = st.lid.O.clone().applyMatrix4(st.lidRig.matrix);
    if (z > front.z + 2 || z < back.z - 2) return Infinity;
    return p.y - (n.x * (x - p.x) + n.z * (z - p.z)) / n.y;
  }
  // top of the base walls at z (the assembled lid underside), wires stay inside below it
  function wallTopAt(z) {
    const L = st.lid;
    return L.O.y - L.thick + (L.O.z - z) * (-L.V.y / L.V.z);
  }

  // Height field of a part in its own frame (2 mm cells): the highest and the lowest surface over
  // each cell, from every triangle's footprint. Wires pass over base parts and under lid parts
  // along the real outline (headers, glass, pins) instead of a bounding box.
  const HF_CELL = 2.0;
  function heightField(P) {
    const g = P.built.group;
    g.updateMatrixWorld(true);
    const inv = new T.Matrix4().copy(g.matrixWorld).invert();
    const b = P.localBox, C = HF_CELL;
    const x0 = b.min.x - 2 * C, z0 = b.min.z - 2 * C;
    const nx = Math.ceil((b.max.x - b.min.x) / C) + 5, nz = Math.ceil((b.max.z - b.min.z) / C) + 5;
    if (!isFinite(nx) || !isFinite(nz) || nx * nz > 40000) return null;
    const hi = new Float32Array(nx * nz).fill(-Infinity), lo = new Float32Array(nx * nz).fill(Infinity);
    const M = new T.Matrix4(), a = v3(), bb = v3(), c = v3();
    g.traverse(o => {
      if (!o.isMesh || !o.visible || !o.geometry || !o.geometry.attributes.position) return;
      const m = Array.isArray(o.material) ? o.material[0] : o.material;
      if (m && (m.blending === T.AdditiveBlending || (m.transparent && m.opacity < 0.5))) return;
      M.multiplyMatrices(inv, o.matrixWorld);
      const pos = o.geometry.attributes.position, idx = o.geometry.index;
      const n = idx ? idx.count : pos.count;
      for (let t = 0; t + 2 < n; t += 3) {
        const i0 = idx ? idx.getX(t) : t, i1 = idx ? idx.getX(t + 1) : t + 1, i2 = idx ? idx.getX(t + 2) : t + 2;
        a.fromBufferAttribute(pos, i0).applyMatrix4(M);
        bb.fromBufferAttribute(pos, i1).applyMatrix4(M);
        c.fromBufferAttribute(pos, i2).applyMatrix4(M);
        const ia = Math.max(0, Math.floor((Math.min(a.x, bb.x, c.x) - x0) / C)), ib = Math.min(nx - 1, Math.floor((Math.max(a.x, bb.x, c.x) - x0) / C));
        const ka = Math.max(0, Math.floor((Math.min(a.z, bb.z, c.z) - z0) / C)), kb = Math.min(nz - 1, Math.floor((Math.max(a.z, bb.z, c.z) - z0) / C));
        const yMax = Math.max(a.y, bb.y, c.y), yMin = Math.min(a.y, bb.y, c.y);
        for (let k = ka; k <= kb; k++) for (let i = ia; i <= ib; i++) {
          const j = k * nx + i;
          if (yMax > hi[j]) hi[j] = yMax;
          if (yMin < lo[j]) lo[j] = yMin;
        }
      }
    });
    // grow by one cell: room for the wire radius
    const dil = (src, pick) => {
      const out = src.slice();
      for (let k = 0; k < nz; k++) for (let i = 0; i < nx; i++) {
        let v = src[k * nx + i];
        for (let dk = -1; dk <= 1; dk++) for (let di = -1; di <= 1; di++) {
          const kk = k + dk, ii = i + di;
          if (kk < 0 || ii < 0 || kk >= nz || ii >= nx) continue;
          v = pick(v, src[kk * nx + ii]);
        }
        out[k * nx + i] = v;
      }
      return out;
    };
    return { x0, z0, nx, nz, hi: dil(hi, Math.max), lo: dil(lo, Math.min) };
  }
  function buildFields() {
    for (const id of BASE_PARTS.concat(['oled', 'rc522'])) {
      const P = st.parts[id];
      if (P) { try { P.field = heightField(P); } catch (err) { P.field = null; } }
    }
  }

  function collectObstacles(ends) {
    const list = [];
    for (const id of BASE_PARTS.concat(['oled', 'rc522'])) {
      const P = st.parts[id];
      if (!P || !P.holder.visible || !P.field) continue;
      const M = P.built.group.matrixWorld;
      const up = v3(0, 1, 0).transformDirection(M);
      const wb = P.localBox.clone().applyMatrix4(M).expandByScalar(HF_CELL * 2 + CLEAR);
      list.push({ id, wire: null, kind: P.rig === 'lid' ? 'high' : 'low', field: P.field, inv: M.clone().invert(), up, s: up.y >= 0 ? 1 : -1, wb });
    }
    // other wires' plugs: world boxes, wires go over the ones in the base and under the ones on lid parts
    for (const [wid, e] of ends) {
      for (const s of [e.a, e.b]) {
        if (!s) continue;
        const wb = new T.Box3().setFromPoints([s.h0, s.h1]).expandByScalar(1.3 + 1.0);
        list.push({ id: 'plug', wire: wid, kind: s.onLid ? 'high' : 'low', wb, box: true });
      }
    }
    return list;
  }

  const _q = v3(), _dv = v3();
  function project(p, obst, skip, assembledWalls) {
    const I = st.inner;
    for (const o of obst) {
      if (skip && o.wire && skip.has(o.wire)) continue;
      if (o.box) {
        const b = o.wb;
        if (p.x < b.min.x || p.x > b.max.x || p.z < b.min.z || p.z > b.max.z) continue;
        if (o.kind === 'low') { if (p.y < b.max.y + CLEAR && p.y > b.min.y - 4) p.y = b.max.y + CLEAR; }
        else if (p.y > b.min.y - CLEAR && p.y < b.max.y + 4) p.y = b.min.y - CLEAR;
        continue;
      }
      if (!o.wb.containsPoint(p)) continue;
      const F = o.field;
      _q.copy(p).applyMatrix4(o.inv);
      const i = Math.floor((_q.x - F.x0) / HF_CELL), k = Math.floor((_q.z - F.z0) / HF_CELL);
      if (i < 0 || k < 0 || i >= F.nx || k >= F.nz) continue;
      const top = F.hi[k * F.nx + i], bot = F.lo[k * F.nx + i];
      if (top === -Infinity) continue;
      let target = null;
      // 'low': stay on the world-up side of the part; 'high': on the world-down side
      const wantUp = o.kind === 'low' ? o.s > 0 : o.s < 0;
      if (wantUp) { if (_q.y < top + CLEAR) target = top + CLEAR; }
      else if (_q.y > bot - CLEAR) target = bot - CLEAR;
      if (target === null) continue;
      _dv.copy(o.up).multiplyScalar(target - _q.y);
      p.add(_dv);
    }
    if (assembledWalls && p.y < wallTopAt(p.z) + 1) {
      p.x = MC.clamp(p.x, I.x0, I.x1);
      p.z = MC.clamp(p.z, I.z0, I.z1);
    }
    const c = ceilingAt(p.x, p.z) - CLEAR;
    if (p.y > c) p.y = c;
    if (p.y < I.floor) p.y = I.floor;
  }

  function hermite(P0, t0, P3, t3, n, sag) {
    const dist = P0.distanceTo(P3);
    const arm = MC.clamp(dist * 0.35 + 6, 8, 50);
    const C1 = P0.clone().addScaledVector(t0, arm), C2 = P3.clone().addScaledVector(t3, arm);
    const out = [];
    for (let i = 1; i <= n; i++) {
      const t = i / (n + 1), u = 1 - t;
      const p = v3().addScaledVector(P0, u * u * u).addScaledVector(C1, 3 * u * u * t).addScaledVector(C2, 3 * u * t * t).addScaledVector(P3, t * t * t);
      p.y -= sag * Math.sin(Math.PI * t);
      out.push(p);
    }
    return out;
  }
  function midCount(a, b) {
    return MC.clamp(Math.round(a.distanceTo(b) * 1.2 / STEP_MM), 3, 40);
  }
  // clamped ends: a virtual node one spacing behind each lead fixes the exit direction
  function chainOf(a, b, mids) {
    let len = 0, prev = a.lead;
    for (const m of mids) { len += m.distanceTo(prev); prev = m; }
    len += prev.distanceTo(b.lead);
    const h = len / (mids.length + 1) * END_STIFF;
    return [a.lead.clone().addScaledVector(a.d, -h), a.lead].concat(mids, [b.lead, b.lead.clone().addScaledVector(b.d, -h)]);
  }

  // Elastic rod: bi-Laplacian smoothing between two clamped ends (back of the plug + lead) with
  // a little gravity, projected onto the constraints every few steps.
  function relax(chain, obst, skip, iters, gravity) {
    const n = chain.length;
    const walls = st.ex < 0.02 && st.lidOpen < 0.02;
    const f = v3();
    // only the obstacles near this wire
    const reach = new T.Box3().setFromPoints(chain).expandByScalar(12);
    obst = obst.filter(o => (!skip || !o.wire || !skip.has(o.wire)) && o.wb.intersectsBox(reach));
    skip = null;
    iters = Math.max(4, Math.round(iters * st.routeQuality));
    for (let it = 0; it < iters; it++) {
      for (let i = 2; i < n - 2; i++) {
        f.copy(chain[i - 2]).addScaledVector(chain[i - 1], -4).addScaledVector(chain[i], 6).addScaledVector(chain[i + 1], -4).add(chain[i + 2]);
        chain[i].addScaledVector(f, -0.1);
        chain[i].y -= gravity;
      }
      if (it % 3 === 2 || it === iters - 1) for (let i = 2; i < n - 2; i++) project(chain[i], obst, skip, walls);
    }
    return chain;
  }

  function computeRoutes() {
    st.root.updateMatrixWorld(true);
    updateLidPlane();
    const ends = new Map();
    for (const W of st.wires) { const e = { a: endPoint(W.def.from, W.def.endA), b: endPoint(W.def.to, W.def.endB) }; ends.set(W.id, e); W.ends = e; }
    const obst = collectObstacles(ends);
    const done = new Set();
    for (const [, list] of st.bundles) {
      const ok = list.filter(W => { const e = ends.get(W.id); return e.a && e.b; });
      if (ok.length < 2) continue;
      routeBundle(ok, ends, obst);
      ok.forEach(W => done.add(W));
    }
    for (const W of st.wires) {
      if (done.has(W)) continue;
      const e = ends.get(W.id);
      if (!e.a || !e.b) { W.points = W.points || [v3(0, 10, 0), v3(0, 30, 0), v3(0, 50, 0), v3(0, 70, 0)]; continue; }
      const n = midCount(e.a.lead, e.b.lead);
      const sag = Math.min(e.a.lead.distanceTo(e.b.lead) * 0.05, 5);
      const chain = chainOf(e.a, e.b, hermite(e.a.lead, e.a.d, e.b.lead, e.b.d, n, sag));
      relax(chain, obst, new Set([W.id]), 40, 0.012);
      W.points = [e.a.p].concat(chain.slice(1, -1), [e.b.p]);
    }
  }

  // Wires of one connector run side by side: a common spine, each wire offset across it,
  // fanning out to its own pins near both ends.
  function routeBundle(list, ends, obst) {
    const nW = list.length;
    const A = v3(), B = v3();
    list.forEach(W => { A.add(ends.get(W.id).a.lead); B.add(ends.get(W.id).b.lead); });
    A.multiplyScalar(1 / nW); B.multiplyScalar(1 / nW);
    const skip = new Set(list.map(W => W.id));
    const n = midCount(A, B);
    // every wire's own free path, then their average is the spine of the bundle
    const own = new Map();
    list.forEach(W => {
      const e = ends.get(W.id);
      const sag = Math.min(e.a.lead.distanceTo(e.b.lead) * 0.05, 5);
      own.set(W, relax(chainOf(e.a, e.b, hermite(e.a.lead, e.a.d, e.b.lead, e.b.d, n, sag)), obst, skip, 30, 0.012).slice(2, -2));
    });
    const spine = [];
    for (let i = 0; i < n; i++) { const c = v3(); list.forEach(W => c.add(own.get(W)[i])); spine.push(c.multiplyScalar(1 / nW)); }
    // spread direction at the A end (along the connector row), carried along the spine
    const a0 = ends.get(list[0].id).a.lead;
    let far = list[0];
    list.forEach(W => { if (ends.get(W.id).a.lead.distanceTo(a0) > ends.get(far.id).a.lead.distanceTo(a0)) far = W; });
    const s0 = ends.get(far.id).a.lead.clone().sub(a0);
    if (s0.lengthSq() < 1e-6) s0.set(1, 0, 0);
    s0.normalize();
    const order = list.slice().sort((w1, w2) => ends.get(w1.id).a.lead.dot(s0) - ends.get(w2.id).a.lead.dot(s0));
    const sides = [];
    const s = s0.clone(), tan = v3();
    for (let i = 0; i < n; i++) {
      tan.copy(i + 1 < n ? spine[i + 1] : B).sub(i > 0 ? spine[i - 1] : A).normalize();
      s.addScaledVector(tan, -s.dot(tan));
      if (s.lengthSq() < 1e-6) s.set(-tan.z, 0, tan.x);
      s.normalize();
      sides.push(s.clone());
    }
    order.forEach((W, rank) => {
      const e = ends.get(W.id);
      const off = (rank - (nW - 1) / 2) * WIRE_GAP;
      const mids = own.get(W).map((p, i) => {
        const t = (i + 1) / (n + 1);
        const w = smooth(t, 0.12, 0.36) * smooth(1 - t, 0.18, 0.42);
        return p.clone().lerp(spine[i].clone().addScaledVector(sides[i], off), w);
      });
      const chain = relax(chainOf(e.a, e.b, mids), obst, skip, 20, 0.0);
      W.points = [e.a.p].concat(chain.slice(1, -1), [e.b.p]);
    });
  }

  S._internals = () => ({ hermite, relax, chainOf, collectObstacles, endPoint, midCount, project, routeWires, computeRoutes, applyExplode });   // tests only
  function routeWires() {
    const P = st.profile, t0 = P ? now() : 0;
    computeRoutes();
    const t1 = P ? now() : 0;
    const quick = st.routeQuality < 1;
    for (const W of st.wires) {
      if (!W.obj || !W.points) continue;
      // hidden wires (build guide, wires off) are only rebuilt when they show again
      if (!W.obj.group.visible && quick) { W.stale = true; continue; }
      W.stale = false;
      W.obj.update(W.points, W.ends && W.ends.a ? W.ends.a.d : undefined, W.ends && W.ends.b ? W.ends.b.d : undefined);
      W.samples = null;   // picking samples, rebuilt lazily by pickAt()
    }
    if (P) { P.compute = (P.compute || 0) + t1 - t0; P.tubes = (P.tubes || 0) + now() - t1; }
    if (st.focus || st.hover) applyLooks();
  }
  function wireSamples(W) {
    if (W.samples) return W.samples;
    let c = typeof W.obj.curve === 'function' ? W.obj.curve() : null;
    if (!c && W.points) c = new T.CatmullRomCurve3(W.points, false, 'centripetal');
    W.samples = c ? c.getSpacedPoints(Math.max(8, Math.round(c.getLength() / 4))) : [];
    return W.samples;
  }

  // ------------------------------------------------------------------ explode
  function applyExplode() {
    const e = st.ex;
    const sL = smooth(e, 0.0, 0.72), sT = smooth(e, 0.12, 0.9), o = st.lidOpen;
    const pv = st.lidPivot;
    const M = st.lidRig.matrix;
    M.makeTranslation(0, LIFT * sL - 30 * o, -LIFT_BACK * sL - 26 * o)
      .multiply(new T.Matrix4().makeTranslation(pv.x, pv.y, pv.z))
      .multiply(new T.Matrix4().makeRotationX(TILT * sT * (1 - o) + OPEN * o))
      .multiply(new T.Matrix4().makeTranslation(-pv.x, -pv.y, -pv.z));
    st.lidRig.matrixWorldNeedsUpdate = true;
    const off = v3();
    for (const id of Object.keys(st.parts)) {
      const P = st.parts[id];
      const cfg = EXPLODE[P.rig === 'card' ? 'card' : id];
      off.set(0, 0, 0);
      if (cfg) {
        const s = smooth(e, cfg[2], cfg[3]) * cfg[1];
        if (cfg[0] === 'up') off.set(0, s, 0);
        else if (cfg[0] === 'n') off.copy(st.lid.N).multiplyScalar(s);
        else if (cfg[0] === 'out') {
          const c = v3().setFromMatrixPosition(P.place); c.y = 0;
          if (c.lengthSq() < 1) c.set(1, 0, 0);
          off.copy(c.normalize().multiplyScalar(s));
        }
      }
      if (P.drop) off.addScaledVector(P.dropDir, P.drop);
      P.holder.matrix.makeTranslation(off.x, off.y, off.z).multiply(P.place);
      if (P.cardPose) P.holder.matrix.copy(P.cardPose);
      P.holder.matrixWorldNeedsUpdate = true;
    }
    st.root.updateMatrixWorld(true);
    emit('scene:explode', st.ex);
  }

  // ------------------------------------------------------------------ looks (hover, focus, ghost)
  function setLook(m, fade, glowHex, glowI, hover) {
    const b = m.userData.mcBase;
    if (!b) return;
    const wantT = b.transparent || fade < 0.999;
    if (m.transparent !== wantT) { m.transparent = wantT; m.needsUpdate = true; }
    m.opacity = b.opacity * fade;
    m.depthWrite = fade < 0.999 ? false : b.depthWrite;
    if (m.emissive && b.emissive && !m.userData.noTint) {
      m.emissive.copy(b.emissive);
      m.emissiveIntensity = b.emissiveIntensity;
      if (hover) MC.mat.setHighlight(m, true, hover);
      else if (glowHex) { m.emissive.set(glowHex); m.emissiveIntensity = glowI; }
    }
  }

  function focusSets() {
    const f = st.focus;
    if (!f) return null;
    const parts = new Set(), wires = new Set();
    if (f.part) {
      parts.add(f.part);
      for (const W of st.wires) if (W.def.from.part === f.part || W.def.to.part === f.part) wires.add(W.id);
    }
    if (f.net) {
      for (const W of st.wires) {
        if (W.net !== f.net && !(f.net === 'BUZ' && W.net === 'BUZ_S')) continue;
        wires.add(W.id);
        parts.add(W.def.from.part); parts.add(W.def.to.part);
      }
      if (f.net === 'BUZ' || f.net === 'BUZ_S') { parts.add('resistor'); parts.add('buzzer'); }
    }
    if (f.wire) { wires.add(f.wire); const W = st.wires.find(w => w.id === f.wire); if (W) { parts.add(W.def.from.part); parts.add(W.def.to.part); } }
    return { parts, wires };
  }

  function applyLooks() {
    const fs = focusSets();
    const accent = MC.tokens[st.theme].accent;
    const hv = st.hover;
    for (const id of Object.keys(st.parts)) {
      const P = st.parts[id];
      const inF = !fs || fs.parts.has(id);
      const fade = inF ? 1 : (P.rig === 'card' ? 0.35 : 0.14);
      const hoverPart = hv && hv.part === id && !hv.key && !hv.wire;
      const glow = fs && inF && st.focus.part === id ? accent : null;
      for (const m of P.mats) setLook(m, fade, glow, 0.16, hoverPart ? accent : null);
      for (const ch of Object.keys(P.keyMats)) {
        const kh = hv && hv.part === id && hv.key === ch;
        for (const m of P.keyMats[ch]) setLook(m, fade, glow, 0.16, kh || hoverPart ? accent : null);
      }
    }
    for (const W of st.wires) {
      const inF = !fs || fs.wires.has(W.id);
      const fade = inF ? 1 : 0.09;
      const hover = hv && hv.wire === W.id;
      const glow = (fs && inF) || hover ? W.color : null;
      for (const m of W.mats) setLook(m, fade, glow, hover ? 0.75 : 0.45, null);
    }
    const ghostCase = st.view.xray || (fs && !(st.focus.part === 'case_base' || st.focus.part === 'case_lid'));
    for (const C of st.caseMeshes) setCaseGhost(C, ghostCase, hv && hv.part === C.id ? accent : null);
    shadowsDirty();
    requestRender();
  }

  function setCaseGhost(C, ghost, hover) {
    if (C.ghost !== ghost) {
      C.ghost = ghost;
      const solid = C.solid.length > 1 && C.mesh.geometry.groups.length ? C.solid : C.solid[0];
      C.mesh.material = ghost ? C.xray : solid;
      C.mesh.castShadow = !ghost;
      if (ghost && !C.edges) {
        const eg = new T.EdgesGeometry(C.mesh.geometry, 32);
        C.edges = new T.LineSegments(eg, new T.LineBasicMaterial({ color: st.theme === 'light' ? '#5B6573' : '#C9D2DD', transparent: true, opacity: 0.3, depthWrite: false }));
        C.edges.userData.noPick = true;
        C.mesh.add(C.edges);
      }
      if (C.edges) C.edges.visible = ghost;
      shadowsDirty();
    }
    for (const m of C.solid) setLook(m, 1, null, 0, hover);
  }

  // ------------------------------------------------------------------ visibility
  function stepOf(partId) {
    for (const s of MC.STEPS) if (s.parts.indexOf(partId) >= 0) return s.n;
    return 1;
  }
  function applyVisibility() {
    if (st.wires.some(W => W.stale)) st.wiresDirty = true;
    const v = st.view, step = st.step, iso = st.isolated;
    const stepOk = id => step === null || stepOf(id) <= step;
    for (const C of st.caseMeshes) {
      let vis = (C.kind === 'base' ? v.body : v.lid) && stepOk(C.id);
      if (iso) vis = iso === C.id;
      C.mesh.visible = vis;
      if (C.extra) C.extra.forEach(m => { m.visible = vis; });
    }
    if (st.contact) {
      const base = st.caseMeshes.find(C => C.kind === 'base');
      st.contact.visible = !!(base && base.mesh.visible);
    }
    for (const id of Object.keys(st.parts)) {
      const P = st.parts[id];
      let vis = (P.rig === 'card' || v.parts) && stepOk(id);
      if (iso) vis = iso === id;
      P.holder.visible = vis;
    }
    for (const W of st.wires) {
      let vis = v.wires && (step === null || W.step <= step) && !W.hiddenByDrop;
      if (iso) vis = false;
      W.obj.group.visible = vis;
    }
    st.pickDirty = true;
    shadowsDirty();
    requestRender();
  }

  // ------------------------------------------------------------------ camera
  function initCamera() {
    const c = st.controls = new T.OrbitControls(st.camera, st.canvas);
    c.enableDamping = true;
    c.dampingFactor = 0.075;
    c.rotateSpeed = 0.62;
    c.zoomSpeed = 0.85;
    c.panSpeed = 0.75;
    c.screenSpacePanning = true;
    c.minDistance = 70;
    c.maxDistance = 1300;
    c.minPolarAngle = 1 * DEG;
    c.maxPolarAngle = 86 * DEG;
    c.autoRotateSpeed = 0.55;
    c.addEventListener('change', () => requestRender());
    c.addEventListener('start', () => {
      stopTween('camera');
      st.userMoved = true;
      if (c.autoRotate) { c.autoRotate = false; st.view.autoRotate = false; emit('scene:view', S.getView()); }
    });
  }
  function clampTarget() {
    const t = st.controls.target;
    const x = MC.clamp(t.x, -260, 260), y = MC.clamp(t.y, -10, 220), z = MC.clamp(t.z, -220, 220);
    if (x !== t.x || y !== t.y || z !== t.z) { t.set(x, y, z); }
  }

  function dirFrom(az, el) {
    return v3(Math.sin(az * DEG) * Math.cos(el * DEG), Math.sin(el * DEG), Math.cos(az * DEG) * Math.cos(el * DEG));
  }
  function viewSize() {
    const r = st.canvas.getBoundingClientRect();
    return { w: Math.max(1, r.width || st.canvas.clientWidth || 1), h: Math.max(1, r.height || st.canvas.clientHeight || 1) };
  }
  // Distance so that every corner of box fits into the free part of the view.
  function fitDistance(box, target, dir, margin) {
    const { w, h } = viewSize();
    const ins = st.insets;
    const aw = Math.max(80, w - ins.left - ins.right), ah = Math.max(80, h - ins.top - ins.bottom);
    const tanV = Math.tan(st.camera.fov * DEG / 2) * (ah / h) * margin;
    const tanH = Math.tan(st.camera.fov * DEG / 2) * (w / h) * (aw / w) * margin;
    const f = dir.clone().negate();
    const right = v3().crossVectors(f, v3(0, 1, 0));
    if (right.lengthSq() < 1e-6) right.set(1, 0, 0);
    right.normalize();
    const up = v3().crossVectors(right, f).normalize();
    let dist = 0;
    const c = v3();
    for (let i = 0; i < 8; i++) {
      c.set(i & 1 ? box.max.x : box.min.x, i & 2 ? box.max.y : box.min.y, i & 4 ? box.max.z : box.min.z).sub(target);
      const x = Math.abs(c.dot(right)), y = Math.abs(c.dot(up)), z = c.dot(dir);
      dist = Math.max(dist, z + x / tanH, z + y / tanV);
    }
    return dist;
  }

  function sceneBox(opts) {
    const box = new T.Box3();
    const d = st.caseData.dims;
    box.set(v3(-d.W / 2, 0, -d.D / 2), v3(d.W / 2, st.lidPivot.y, d.D / 2));
    if (opts && opts.cards) for (const id of Object.keys(st.parts)) {
      const P = st.parts[id];
      if (P.rig === 'card' && P.holder.visible) box.union(P.localBox.clone().applyMatrix4(P.built.group.matrixWorld));
    }
    if (opts && opts.lid) {
      for (const C of st.caseMeshes) if (C.kind === 'lid' && C.mesh.visible) box.union(new T.Box3().setFromObject(C.mesh));
      for (const id of LID_PARTS) { const P = st.parts[id]; if (P && P.holder.visible) box.union(P.localBox.clone().applyMatrix4(P.built.group.matrixWorld)); }
    }
    return box;
  }
  function partBox(id) {
    const P = st.parts[id];
    if (P) {
      // the body of the part (size from the builder, centred on the footprint), so a long keypad
      // tail or a lead does not pull the framing away from the part itself
      const sz = P.built.size;
      if (sz && sz[0] && sz[2] && id !== 'buzzer' && id !== 'resistor') {
        const lb = new T.Box3(v3(-sz[0] / 2, 0, -sz[2] / 2), v3(sz[0] / 2, Math.max(sz[1], 0.5), sz[2] / 2));
        return lb.applyMatrix4(P.built.group.matrixWorld);
      }
      return P.localBox.clone().applyMatrix4(P.built.group.matrixWorld);
    }
    const C = st.caseMeshes.find(c => c.id === id);
    if (C) return new T.Box3().setFromObject(C.mesh);
    return null;
  }

  // Camera pose that frames box from direction dir: distance from the corners, then the target
  // nudged so the box's projected outline sits in the middle of the free part of the view.
  const _fitCam = new T.PerspectiveCamera();
  function fitPose(box, dir, margin, target) {
    target = target ? target.clone() : box.getCenter(v3());
    const { w, h } = viewSize();
    if (w / h < 0.95) margin = Math.min(0.97, margin + 0.06);   // portrait phones: use the width
    const ins = st.insets;
    const freeX = ins.left + (w - ins.left - ins.right) / 2, freeY = ins.top + (h - ins.top - ins.bottom) / 2;
    const cam = _fitCam.copy(st.camera);
    const c = v3(), right = v3(), up = v3();
    let dist = 0;
    for (let k = 0; k < 3; k++) {
      dist = Math.max(fitDistance(box, target, dir, margin), st.controls.minDistance);
      cam.position.copy(target).addScaledVector(dir, dist);
      cam.lookAt(target);
      cam.updateMatrixWorld(true);
      let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
      for (let i = 0; i < 8; i++) {
        c.set(i & 1 ? box.max.x : box.min.x, i & 2 ? box.max.y : box.min.y, i & 4 ? box.max.z : box.min.z).project(cam);
        const px = (c.x * 0.5 + 0.5) * w, py = (-c.y * 0.5 + 0.5) * h;
        x0 = Math.min(x0, px); x1 = Math.max(x1, px); y0 = Math.min(y0, py); y1 = Math.max(y1, py);
      }
      const dx = (x0 + x1) / 2 - freeX, dy = (y0 + y1) / 2 - freeY;
      if (Math.abs(dx) < 0.5 && Math.abs(dy) < 0.5) break;
      const wpp = 2 * dist * Math.tan(cam.fov * DEG / 2) / h;
      right.setFromMatrixColumn(cam.matrixWorld, 0);
      up.setFromMatrixColumn(cam.matrixWorld, 1);
      target.addScaledVector(right, dx * wpp).addScaledVector(up, -dy * wpp);
    }
    return { target, pos: target.clone().addScaledVector(dir, dist) };
  }

  function currentPose() {
    const f = st.framing || { kind: 'preset', name: st.preset };
    if (f.kind === 'step' && st.step !== null) return stepPose(st.step, st.exTarget);
    if (f.kind === 'isolate' && st.isolated) return isolatePose(st.isolated);
    return presetPose(st.preset);
  }
  function presetPose(name) {
    const cd = st.caseData, d = cd.dims;
    const exploded = st.ex > 0.05;
    const box = sceneBox({ cards: true, lid: exploded });
    let dir, margin = 0.86;
    switch (name) {
      case 'front':
        dir = dirFrom(0, 12); box.copy(sceneBox({ lid: exploded })); margin = 0.8;
        break;
      case 'top':
        dir = dirFrom(0, 76); box.copy(sceneBox({ lid: exploded })); margin = 0.84;
        break;
      case 'keypad': {
        // the play view: keypad and OLED together, seen square to the lid from the front
        const kb = partBox('keypad') || box;
        box.copy(kb);
        const ob = partBox('oled');
        if (ob) box.union(ob);
        const n = st.lid.N.clone().transformDirection(st.lidRig.matrix);
        dir = n.multiplyScalar(0.9).add(v3(0.1, 0.0, 0.42)).normalize();
        margin = 0.84;
        break;
      }
      case 'inside': {
        const I = st.inner;
        // low enough to look under the raised lid into the body
        box.set(v3(I.x0, 0, I.z0), v3(I.x1, 40, I.z1));
        dir = dirFrom(-16, 50); margin = 0.94;
        break;
      }
      case 'back': {
        // the USB-B and DC jack openings in the back wall, from outside at a 3/4 angle
        let at = cd.usb && cd.usb.origin ? vfa(cd.usb.origin) : null;
        let out = cd.usb && cd.usb.dir ? vfa(cd.usb.dir) : null;
        const P = st.parts.uno;
        if (!at && P && P.built.extra.usb) at = P.built.extra.usb.clone().applyMatrix4(P.built.group.matrixWorld);
        if (!at) at = v3(-d.W / 2, 15, 0);
        if (!out) { out = at.clone(); out.y = 0; if (out.lengthSq() < 1) out.set(0, 0, -1); }
        out.y = 0; out.normalize();
        // turn toward the side of the wall the ports sit on
        const side = v3(out.z, 0, -out.x);                  // along the wall
        const turn = at.dot(side) >= 0 ? 1 : -1;
        const az = Math.atan2(out.x, out.z) / DEG + 34 * turn * (out.z < 0 ? -1 : 1);
        dir = dirFrom(az, 20);
        box.copy(sceneBox({ lid: exploded }));
        margin = 0.84;
        break;
      }
      default:   // hero
        dir = dirFrom(34, 26);
        margin = 0.9;
    }
    return fitPose(box, dir, margin);
  }

  function flyTo(pose, ms) {
    const c = st.controls, cam = st.camera;
    const t0 = c.target.clone(), t1 = pose.target.clone();
    const s0 = new T.Spherical().setFromVector3(cam.position.clone().sub(t0));
    const s1 = new T.Spherical().setFromVector3(pose.pos.clone().sub(t1));
    let dTheta = s1.theta - s0.theta;
    if (dTheta > Math.PI) dTheta -= 2 * Math.PI;
    if (dTheta < -Math.PI) dTheta += 2 * Math.PI;
    const sp = new T.Spherical(), off = v3();
    if (ms <= 0) {
      c.target.copy(t1); cam.position.copy(pose.pos); c.update(); requestRender();
      return Promise.resolve(true);
    }
    return animate('camera', ms, e => {
      c.target.lerpVectors(t0, t1, e);
      sp.radius = MC.lerp(s0.radius, s1.radius, e);
      sp.phi = MC.lerp(s0.phi, s1.phi, e);
      sp.theta = s0.theta + dTheta * e;
      off.setFromSpherical(sp);
      cam.position.copy(c.target).add(off);
      cam.lookAt(c.target);
    });
  }

  // ------------------------------------------------------------------ picking
  function rebuildPickables() {
    const list = [];
    const visible = o => { for (let a = o; a; a = a.parent) if (!a.visible) return false; return true; };
    st.root.traverse(o => {
      if (!o.isMesh || o.userData.noPick) return;
      if (!visible(o)) return;
      const m = Array.isArray(o.material) ? o.material[0] : o.material;
      if (m && m.blending === T.AdditiveBlending) return;
      const isCase = o.userData.part === 'case_base' || o.userData.part === 'case_lid';
      if (isCase && st.caseMeshes.some(C => C.mesh === o && C.ghost)) return;
      list.push(o);
    });
    st.pickables = list;
    st.pickDirty = false;
  }
  const ray = new T.Raycaster();
  function pickAt(cx, cy) {
    if (st.pickDirty) rebuildPickables();
    const r = st.canvas.getBoundingClientRect();
    const ndc = new T.Vector2(((cx - r.left) / r.width) * 2 - 1, -((cy - r.top) / r.height) * 2 + 1);
    ray.setFromCamera(ndc, st.camera);
    const hits = ray.intersectObjects(st.pickables, false);
    let hit = hits[0] || null;
    // thin wires: accept a near miss of a few pixels
    const dist = hit ? hit.distance : Infinity;
    const px = 4.5 * (2 * Math.tan(st.camera.fov * DEG / 2)) / r.height;
    let best = null;
    if (st.view.wires && !st.isolated) {
      const a = v3(), b = v3(), onRay = v3(), onSeg = v3();
      for (const W of st.wires) {
        if (!W.obj.group.visible) continue;
        const smp = wireSamples(W);
        for (let i = 1; i < smp.length; i++) {
          a.copy(smp[i - 1]); b.copy(smp[i]);
          const d2 = ray.ray.distanceSqToSegment(a, b, onRay, onSeg);
          const along = onRay.distanceTo(ray.ray.origin);
          const tol = px * along;
          if (d2 < tol * tol && along < dist - 0.5 && (!best || along < best.along)) best = { W, along, point: onSeg.clone() };
        }
      }
    }
    if (best) return { wire: best.W, point: best.point, object: null };
    if (!hit) return null;
    return { object: hit.object, point: hit.point };
  }

  function describe(hit, cx, cy) {
    if (!hit) return null;
    const r = st.canvas.getBoundingClientRect();
    const out = { part: null, net: null, pin: null, key: null, card: null, wire: null, x: cx - r.left, y: cy - r.top, clientX: cx, clientY: cy };
    if (hit.wire) {
      const W = hit.wire;
      out.wire = W.id; out.net = W.net;
      out.pin = W.def.to.part === 'uno' ? W.def.to.pin : W.def.from.part === 'uno' ? W.def.from.pin : W.def.to.pin;
      return out;
    }
    const o = hit.object;
    if (o.userData.wire) {
      const W = st.wires.find(w => w.id === o.userData.wire);
      if (W) return describe({ wire: W }, cx, cy);
    }
    let part = null;
    for (let a = o; a; a = a.parent) if (a.userData && a.userData.part) { part = a.userData.part; break; }
    out.part = part;
    const P = st.parts[part];
    if (P) {
      if (P.uid) out.card = P.uid;
      const keys = P.built.extra.keys;
      if (keys) for (const ch of Object.keys(keys)) {
        let k = false;
        for (let a = o; a; a = a.parent) if (a === keys[ch]) { k = true; break; }
        if (k) { out.key = ch; break; }
      }
      if (!out.key) {
        const pin = nearestPin(part, hit.point);
        if (pin) { out.pin = pin.name; out.net = pin.net; }
      }
    }
    return out;
  }

  function pinNames(part) {
    const P = st.parts[part];
    const names = new Set(Object.keys(P.built.pins));
    if (part === 'breadboard') {
      for (const W of MC.WIRES) for (const e of [W.from, W.to]) if (e.part === 'breadboard') names.add(e.pin);
      for (const k of Object.keys(MC.BREADBOARD_PARTS)) for (const h of Object.values(MC.BREADBOARD_PARTS[k])) names.add(h);
    }
    return names;
  }
  function netOfPin(part, pin) {
    for (const W of MC.WIRES) if ((W.from.part === part && W.from.pin === pin) || (W.to.part === part && W.to.pin === pin)) return W.net;
    if (part === 'breadboard') {
      const m = /^([a-j])(\d+)$/.exec(pin);
      if (m) {
        const half = 'abcde'.indexOf(m[1]) >= 0 ? 'abcde' : 'fghij';
        for (const W of MC.WIRES) for (const e of [W.from, W.to]) {
          const q = e.part === 'breadboard' && /^([a-j])(\d+)$/.exec(e.pin);
          if (q && q[2] === m[2] && half.indexOf(q[1]) >= 0) return W.net;
        }
        if (+m[2] === 26 && half === 'abcde') return 'BUZ_S';
      }
      if (/^gnd_lower_inner/.test(pin)) return 'GND';
    }
    if (part === 'buzzer') return { S: 'BUZ_S', MINUS: 'GND' }[pin] || null;
    if (part === 'resistor') return { a: 'BUZ', b: 'BUZ_S' }[pin] || null;
    if (/^GND/.test(pin)) return 'GND';
    return null;
  }
  function nearestPin(part, point) {
    const P = st.parts[part];
    if (!P || !point) return null;
    const M = P.built.group.matrixWorld;
    let best = null;
    for (const name of pinNames(part)) {
      let p = P.built.pins[name] && P.built.pins[name].p;
      if (!p && part === 'breadboard') p = bbHole(name);
      if (!p) continue;
      const w = p.clone().applyMatrix4(M);
      const d = w.distanceTo(point);
      if (d < 4.2 && (!best || d < best.d)) best = { name, d };
    }
    return best ? { name: best.name, net: netOfPin(part, best.name) } : null;
  }

  function sameHover(a, b) {
    if (!a || !b) return a === b;
    return a.part === b.part && a.wire === b.wire && a.key === b.key && a.pin === b.pin;
  }
  function pickHover() {
    const p = st.pointer;
    if (!p.inside || p.down || p.type === 'touch') return setHover(null);
    const info = describe(pickAt(p.x, p.y), p.x, p.y);
    setHover(info);
  }
  function setHover(info) {
    const changed = !sameHover(st.hover, info);
    st.hover = info;
    if (changed) {
      st.canvas.style.cursor = info ? 'pointer' : '';
      applyLooks();
    }
    if (changed || info) emit('scene:hover', info);
  }

  function initPointer() {
    const cv = st.canvas, p = st.pointer;
    cv.addEventListener('pointermove', ev => {
      p.x = ev.clientX; p.y = ev.clientY; p.inside = true; p.type = ev.pointerType;
      if (ev.pointerType === 'touch') return;
      p.pending = true;
      schedule();
    });
    cv.addEventListener('pointerleave', () => { p.inside = false; if (st.hover) setHover(null); });
    cv.addEventListener('pointerdown', ev => {
      p.down = { x: ev.clientX, y: ev.clientY, t: now() };
      p.type = ev.pointerType;
    });
    const up = ev => {
      const d = p.down;
      p.down = null;
      if (!d || ev.type === 'pointercancel') return;
      if (Math.hypot(ev.clientX - d.x, ev.clientY - d.y) > 6 || now() - d.t > 650) return;
      const info = describe(pickAt(ev.clientX, ev.clientY), ev.clientX, ev.clientY);
      if (!info) { emit('scene:click', null); return; }
      emit('scene:click', info);
      if (info.key) { S.pressKey(info.key); emit('scene:key', info.key); }
      else if (info.card) emit('scene:card', info.card);
    };
    cv.addEventListener('pointerup', up);
    cv.addEventListener('pointercancel', up);
  }

  // ------------------------------------------------------------------ labels
  // Part names with leader lines, drawn as a DOM overlay over the canvas (crisp text at any
  // pixel ratio, no extra draw calls). Positions follow the camera on every rendered frame.
  const LABEL_PARTS = ['uno', 'breadboard', 'buzzer', 'resistor', 'keypad', 'oled', 'rc522',
    'card_DF51AA39', 'card_0885B1A8', 'card_049F905C110189', 'card_04CABD5C110189'];
  const ON_TOP = new Set(['keypad', 'oled']);
  function initLabels() {
    const host = st.canvas.parentElement;
    if (!host) return;
    const box = document.createElement('div');
    box.className = 'mc-scene-labels';
    box.setAttribute('aria-hidden', 'true');
    box.style.cssText = 'position:absolute;pointer-events:none;overflow:hidden;z-index:1;left:0;top:0;width:0;height:0;';
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;overflow:visible;';
    box.appendChild(svg);
    host.appendChild(box);
    st.labels = { box, svg, items: [] };
    for (const id of LABEL_PARTS) {
      const info = MC.part(id);
      if (!info || !st.parts[id]) continue;
      const el = document.createElement('div');
      el.textContent = st.parts[id].uid ? info.short + ' ' + MC.formatUid(st.parts[id].uid) : info.name;
      el.style.cssText = 'position:absolute;left:0;top:0;white-space:nowrap;padding:4px 9px;border-radius:999px;' +
        'font:500 12px/1.2 ' + MC.tokens.font + ';letter-spacing:.01em;opacity:0;transition:opacity .25s ease;' +
        'backdrop-filter:blur(8px);-webkit-backdrop-filter:blur(8px);will-change:transform;';
      const line = document.createElementNS('http://www.w3.org/2000/svg', 'line');
      const dot = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
      dot.setAttribute('r', '2.5');
      svg.appendChild(line); svg.appendChild(dot);
      box.appendChild(el);
      st.labels.items.push({ id, el, line, dot, on: false });
    }
    styleLabels();
  }
  function styleLabels() {
    if (!st.labels) return;
    const tk = MC.tokens[st.theme];
    const light = st.theme === 'light';
    for (const it of st.labels.items) {
      it.el.style.color = tk.ink;
      it.el.style.background = light ? 'rgba(255,255,255,0.78)' : 'rgba(20,24,30,0.72)';
      it.el.style.border = '1px solid ' + tk.line2;
      it.el.style.boxShadow = light ? '0 2px 10px rgba(15,17,21,0.08)' : '0 2px 12px rgba(0,0,0,0.35)';
      it.line.setAttribute('stroke', light ? 'rgba(15,17,21,0.45)' : 'rgba(233,236,241,0.5)');
      it.line.setAttribute('stroke-width', '1');
      it.dot.setAttribute('fill', tk.accent);
      it.dot.setAttribute('stroke', light ? '#FFFFFF' : '#0B0D10');
      it.dot.setAttribute('stroke-width', '1.5');
    }
  }
  // Is the anchor behind the solid lid slab or a solid base wall? Analytic, no ray casts.
  function hiddenByCase(id, a) {
    const cam = st.camera.position;
    const lidC = st.caseMeshes.find(C => C.kind === 'lid'), baseC = st.caseMeshes.find(C => C.kind === 'base');
    if (lidC && lidC.mesh.visible && !lidC.ghost) {
      const M = st.lidRig.matrix, L = st.lid;
      const O = L.O.clone().applyMatrix4(M), U = L.U.clone().transformDirection(M), V = L.V.clone().transformDirection(M), N = L.N.clone().transformDirection(M);
      const loc = q => { const d = q.clone().sub(O); return [d.dot(U), d.dot(V), d.dot(N)]; };
      const c = loc(cam), p = loc(a);
      const onTop = ON_TOP.has(id) && c[2] > 0;
      if (!onTop) {
        // segment parameter range inside the slab -thick <= n <= 0
        const dn = p[2] - c[2];
        let t0 = 0, t1 = 1;
        if (Math.abs(dn) < 1e-6) { if (c[2] < -L.thick || c[2] > 0) t0 = 2; }
        else {
          const ta = (-L.thick - c[2]) / dn, tb = (0 - c[2]) / dn;
          t0 = Math.max(0, Math.min(ta, tb)); t1 = Math.min(0.995, Math.max(ta, tb));
        }
        if (t0 < t1) {
          const tm = (t0 + t1) / 2;
          const u = c[0] + (p[0] - c[0]) * tm, v = c[1] + (p[1] - c[1]) * tm;
          const W = st.caseData.dims.W;
          if (u > 1 && u < W - 1 && v > 1 && v < L.length - 1) return true;
        }
      }
    }
    if (baseC && baseC.mesh.visible && !baseC.ghost) {
      const d = st.caseData.dims;
      const x0 = -d.W / 2, x1 = d.W / 2, z0 = -d.D / 2, z1 = d.D / 2;
      if (a.x > x0 && a.x < x1 && a.z > z0 && a.z < z1) {
        const under = st.lid.O.y - st.lid.thick;
        const wallTop = z => under + (st.lid.O.z - z) * Math.tan((d.SLOPE || 10) * DEG);
        const dir = a.clone().sub(cam);
        const planes = [['x', x0], ['x', x1], ['z', z0], ['z', z1]];
        for (const [ax, val] of planes) {
          const dd = dir[ax];
          if (Math.abs(dd) < 1e-6) continue;
          const t = (val - cam[ax]) / dd;
          if (t <= 0 || t >= 1) continue;
          const q = cam.clone().addScaledVector(dir, t);
          const other = ax === 'x' ? q.z : q.x, lo = ax === 'x' ? z0 : x0, hi = ax === 'x' ? z1 : x1;
          if (other > lo && other < hi && q.y > 0 && q.y < wallTop(q.z)) return true;
        }
      }
    }
    return false;
  }
  function updateLabels() {
    const L = st.labels;
    if (!L) return;
    const { w, h } = viewSize();
    const cv = st.canvas;
    L.box.style.left = cv.offsetLeft + 'px'; L.box.style.top = cv.offsetTop + 'px';
    L.box.style.width = w + 'px'; L.box.style.height = h + 'px';
    const show = st.view.labels;
    const centre = S.project(st.root.localToWorld(v3(0, st.lidPivot.y * 0.4, 0)));
    const placed = [];
    for (const it of L.items) {
      const P = st.parts[it.id];
      let on = show && P && P.holder.visible;
      if (on && st.isolated && st.isolated !== it.id) on = false;
      let a = null;
      if (on) {
        const w = S.anchor(it.id);
        if (!st.isolated && hiddenByCase(it.id, w)) on = false;
        else {
          a = S.project(w);
          if (!a.visible) on = false;
        }
      }
      if (on !== it.on) {
        it.on = on;
        it.el.style.opacity = on ? '1' : '0';
        it.line.style.display = it.dot.style.display = on ? '' : 'none';
      }
      if (!on) continue;
      let dx = a.x - centre.x, dy = a.y - centre.y;
      const len = Math.hypot(dx, dy) || 1;
      dx /= len; dy /= len;
      const reach = P.rig === 'card' ? 26 : 46;
      const bw = it.el.offsetWidth || 90, bh = it.el.offsetHeight || 22;
      let lx = a.x + dx * reach + (dx >= 0 ? 6 : -6 - bw);
      let ly = a.y + dy * reach * 0.6 - 30 - bh / 2;
      // keep clear of labels placed before, and inside the view
      for (let k = 0; k < 6; k++) {
        const hit = placed.find(r => lx < r.x + r.w + 6 && lx + bw + 6 > r.x && ly < r.y + r.h + 4 && ly + bh + 4 > r.y);
        if (!hit) break;
        ly = hit.y - bh - 6;
      }
      lx = MC.clamp(lx, 8, w - bw - 8); ly = MC.clamp(ly, 8, h - bh - 8);
      placed.push({ x: lx, y: ly, w: bw, h: bh });
      it.el.style.transform = 'translate(' + Math.round(lx) + 'px,' + Math.round(ly) + 'px)';
      const ex = lx + (lx + bw / 2 < a.x ? bw : 0), ey = ly + bh / 2;
      it.line.setAttribute('x1', a.x.toFixed(1)); it.line.setAttribute('y1', a.y.toFixed(1));
      it.line.setAttribute('x2', ex.toFixed(1)); it.line.setAttribute('y2', ey.toFixed(1));
      it.dot.setAttribute('cx', a.x.toFixed(1)); it.dot.setAttribute('cy', a.y.toFixed(1));
    }
  }

  // ------------------------------------------------------------------ sizing
  function resize() {
    if (!st.renderer) return;
    const { w, h } = viewSize();
    st.renderer.setSize(w, h, false);
    st.camera.aspect = w / h;
    const ins = st.insets;
    const ox = (ins.right - ins.left) / 2, oy = (ins.bottom - ins.top) / 2;
    if (ox || oy) st.camera.setViewOffset(w, h, ox, oy, w, h);
    else st.camera.clearViewOffset();
    st.camera.updateProjectionMatrix();
    if (!st.userMoved && st.ready && !tweens.has('camera')) flyTo(currentPose(), 0);
    requestRender();
  }

  // ------------------------------------------------------------------ OLED
  function patchOled(m) {
    if (m.userData.oledTint) return;
    const tint = m.userData.oledTint = {
      uOledTop: { value: new T.Color(OLED_TINT.white[0]) },
      uOledBottom: { value: new T.Color(OLED_TINT.white[1]) },
      uOledSplit: { value: 0.75 }
    };
    m.onBeforeCompile = sh => {
      Object.assign(sh.uniforms, tint);
      sh.fragmentShader = 'uniform vec3 uOledTop;\nuniform vec3 uOledBottom;\nuniform float uOledSplit;\n' +
        sh.fragmentShader.replace('#include <emissivemap_fragment>',
          '#include <emissivemap_fragment>\n#ifdef USE_EMISSIVEMAP\n\ttotalEmissiveRadiance *= ( vUv.y > uOledSplit ? uOledTop : uOledBottom );\n#endif');
    };
    m.customProgramCacheKey = () => 'mc-oled-tint';
    m.needsUpdate = true;
  }
  function applyOledTexture() {
    const P = st.parts.oled, o = st.oledObj;
    if (!P) return;
    const ex = P.built.extra;
    const screen = ex.screen, glow = ex.glow;
    if (o && !st.oledTex && o.texture && o.texture.isTexture) {
      st.oledTex = o.texture;
      st.glowTex = o.glowTexture || null;
    }
    if (o && !st.oledTex) {
      const mk = c => {
        const t = c.isTexture ? c : new T.CanvasTexture(c);
        t.encoding = T.sRGBEncoding;
        t.anisotropy = MC.tex.anisotropy;
        t.needsUpdate = true;
        return t;
      };
      st.oledTex = o.isTexture ? o : mk(o.canvas || o);
      if (o.glowCanvas) st.glowTex = mk(o.glowCanvas);
    }
    if (screen && screen.material) {
      const m = screen.material;
      if (st.oledTex) {
        m.emissiveMap = st.oledTex;
        m.emissive.set('#FFFFFF');
        m.userData.mcBase.emissive = m.emissive.clone();
        patchOled(m);
        m.needsUpdate = true;
      } else {
        m.emissive.set('#000000');
        m.userData.mcBase.emissive = m.emissive.clone();
      }
    }
    if (glow && glow.material) {
      if (st.glowTex) { glow.material.map = st.glowTex; glow.material.needsUpdate = true; glow.visible = true; }
      else glow.visible = false;
      if (screen && screen.geometry && glow.geometry && !glow.userData.fitted) {
        screen.geometry.computeBoundingBox(); glow.geometry.computeBoundingBox();
        const a = screen.geometry.boundingBox.getSize(v3()).multiply(screen.scale);
        const b = glow.geometry.boundingBox.getSize(v3()).multiply(glow.scale);
        const k = i => (b.getComponent(i) > 1e-6 && a.getComponent(i) > 1e-6 ? a.getComponent(i) / b.getComponent(i) : 1);
        glow.scale.multiply(v3(k(0), k(1), k(2)));
        glow.position.x = screen.position.x; glow.position.z = screen.position.z;
        glow.userData.fitted = true;
        if (glow.material.userData.mcBase) glow.material.userData.mcBase.opacity = Math.min(glow.material.opacity, 0.4);
        glow.material.opacity = Math.min(glow.material.opacity, 0.4);
      }
    }
    applyOledVariant();
    requestRender();
  }
  function applyOledVariant() {
    const P = st.parts.oled;
    if (!P) return;
    const name = st.oledVariant;
    let tint = OLED_TINT[name] || OLED_TINT.white;
    if (st.oledObj && typeof st.oledObj.setVariant === 'function') {
      try { st.oledObj.setVariant(name); tint = ['#FFFFFF', '#FFFFFF']; } catch (err) { /* keep our tint */ }
    }
    const scr = P.built.extra.screen;
    if (scr && scr.material && scr.material.userData.oledTint) {
      const u = scr.material.userData.oledTint;
      u.uOledTop.value.set(tint[0]); u.uOledBottom.value.set(tint[1]);
    }
    const gl = P.built.extra.glow;
    if (gl && gl.material && gl.material.color) gl.material.color.set(name === 'white' ? '#FFFFFF' : tint[1]);
    S.oledChanged();
  }

  // Compile every program before the first visible frame. three r147 compiles synchronously and
  // on ANGLE / D3D11 a physical material takes a few hundred ms, ~7 s for the whole scene on an
  // iGPU. So a throw-away renderer on a second context first issues every compile and link
  // without waiting for any of them (its uniform queries are stubbed); with
  // KHR_parallel_shader_compile the driver links them on its own threads while the page stays
  // responsive, and the real compile afterwards hits the GPU process' program cache.
  async function compileShaders(onProgress) {
    const r = st.renderer;
    try { await prewarmShaders(onProgress); } catch (err) { /* plain compile below */ }
    try { r.compile(st.scene, st.camera); } catch (err) { /* compiled on the first render instead */ }
  }
  async function prewarmShaders(onProgress) {
    const main = st.renderer, gl = main.getContext();
    if (!gl.getExtension('KHR_parallel_shader_compile')) return;
    const cv = document.createElement('canvas');
    cv.width = cv.height = 4;
    const isGL2 = main.capabilities.isWebGL2;
    const raw = cv.getContext(isGL2 ? 'webgl2' : 'webgl', { antialias: false, alpha: true, depth: true, stencil: false });
    const ext = raw && raw.getExtension('KHR_parallel_shader_compile');
    if (!ext) return;
    const programs = [];
    const fast = {
      getProgramParameter(p, name) {
        if (name === raw.ACTIVE_UNIFORMS || name === raw.ACTIVE_ATTRIBUTES) return 0;
        if (name === raw.LINK_STATUS) return true;
        return raw.getProgramParameter(p, name);
      },
      getShaderParameter() { return true; },
      getProgramInfoLog() { return ''; }, getShaderInfoLog() { return ''; },
      getUniformLocation() { return null; }, getAttribLocation() { return -1; },
      linkProgram(p) { programs.push(p); return raw.linkProgram(p); }
    };
    const proxy = new Proxy(raw, {
      get(t, k) {
        if (Object.prototype.hasOwnProperty.call(fast, k)) return fast[k];
        const v = t[k];
        return typeof v === 'function' ? v.bind(t) : v;
      }
    });
    let warm = null;
    try {
      warm = new T.WebGLRenderer({ canvas: cv, context: proxy, antialias: false });
      warm.debug.checkShaderErrors = false;
      warm.outputEncoding = main.outputEncoding;
      warm.toneMapping = main.toneMapping;
      warm.physicallyCorrectLights = main.physicallyCorrectLights;
      warm.shadowMap.enabled = main.shadowMap.enabled;
      warm.shadowMap.type = main.shadowMap.type;
      warm.compile(st.scene, st.camera);
      const t0 = now();
      while (programs.length && now() - t0 < 30000) {
        let done = 0;
        for (const p of programs) if (raw.getProgramParameter(p, ext.COMPLETION_STATUS_KHR)) done++;
        if (onProgress) onProgress(done / programs.length);
        if (done >= programs.length) break;
        await new Promise(res => setTimeout(res, 30));
      }
    } finally {
      if (warm) { try { warm.dispose(); } catch (err) { /* ignore */ } }
      const lose = raw.getExtension('WEBGL_lose_context');
      if (lose) lose.loseContext();
    }
  }

  // ------------------------------------------------------------------ public API
  S.init = async function (canvas, opts) {
    if (st.ready) return S;
    opts = opts || {};
    st.canvas = canvas;
    st.theme = opts.theme === 'light' ? 'light' : 'dark';
    st.reduced = !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
    if (opts.caseColor) st.caseColor = opts.caseColor;
    if (st.reduced) st.view.autoRotate = false;
    if (opts.autoRotate === false) st.view.autoRotate = false;

    const tm = st.timings = {};
    let tPrev = now();
    const lap = name => { const t = now(); tm[name] = Math.round(t - tPrev); tPrev = t; };
    const step = async (p, label) => { emit('scene:progress', { p, label }); await new Promise(r => setTimeout(r, 0)); tPrev = now(); };
    initRenderer(canvas); lap('renderer');
    initLights();
    initGround(); lap('lights');
    await step(0.1, 'building the case');
    st.caseData = window.MC_CASE && window.MC_CASE.dims ? window.MC_CASE : fallbackCase();
    st.caseFallback = !(window.MC_CASE && window.MC_CASE.meshes);
    if (!st.caseData.place) st.caseData.place = fallbackCase().place;
    readCaseFrame();
    buildCase(); lap('case');
    await step(0.3, 'placing the parts');
    buildParts(); lap('parts');
    bendKeypadTail(); lap('tail');
    buildFields(); lap('fields');
    st.root.updateMatrixWorld(true);
    await step(0.6, 'routing the wires');
    buildWires(); lap('wires');
    initCamera();
    initPointer();
    initLabels(); lap('ui');
    MC.bus.on('scene:dirty', () => keepAlive(40));
    await step(0.8, 'lighting the studio');

    st.ready = true;
    st.hold = true;
    tPrev = now();
    applyExplode();
    routeWires();
    S.setTheme(st.theme);
    applyOledTexture();
    applyVisibility();
    applyLooks();
    resize();
    st.preset = 'hero';
    flyTo(presetPose('hero'), 0);
    st.controls.autoRotate = st.view.autoRotate;

    if (typeof ResizeObserver !== 'undefined') new ResizeObserver(() => resize()).observe(canvas);
    else window.addEventListener('resize', resize);
    document.addEventListener('visibilitychange', () => {
      st.hidden = document.hidden;
      if (st.hidden) { if (st.raf) cancelAnimationFrame(st.raf); st.raf = 0; }
      else { st.fps.t0 = 0; requestRender(); }
    });
    if (window.matchMedia) {
      const mq = window.matchMedia('(prefers-reduced-motion: reduce)');
      const onRM = () => { st.reduced = mq.matches; if (st.reduced) S.setView({ autoRotate: false }); };
      if (mq.addEventListener) mq.addEventListener('change', onRM);
    }
    S.setQuality(opts.quality || 'auto');
    shadowsDirty();
    // compile every shader before the first visible frame so the opening shot does not stutter
    lap('looks');
    await step(0.86, 'compiling shaders');
    await compileShaders(p => emit('scene:progress', { p: 0.86 + 0.12 * p, label: 'compiling shaders' }));
    lap('compile');
    st.hold = false;
    requestRender();
    await step(0.98, 'first frame');
    await new Promise(r => requestAnimationFrame(() => r()));
    emit('scene:progress', { p: 1, label: 'ready' });
    emit('scene:ready', { fallbacks: st.fallbacks.slice(), caseFallback: st.caseFallback, timings: st.timings });
    return S;
  };

  S.setOledTexture = function (obj) {
    st.oledObj = obj;
    st.oledTex = null; st.glowTex = null;
    if (st.ready) applyOledTexture();
  };
  S.oledChanged = function () {
    if (st.oledTex) st.oledTex.needsUpdate = true;
    if (st.glowTex) st.glowTex.needsUpdate = true;
    requestRender();
  };

  S.pressKey = function (ch) {
    const P = st.parts.keypad;
    if (!P) return;
    ch = String(ch).toUpperCase();
    try { if (typeof P.built.extra.press === 'function') P.built.extra.press(ch); } catch (err) { console.error('[scene] key press', err); }
    keepAlive(320);
  };

  // The card glides to the tap zone, hovers, and returns. Resolves at the tap moment.
  S.tapCard = function (uid) {
    const P = st.parts['card_' + uid] || Object.values(st.parts).find(p => p.uid === uid);
    if (!P) return Promise.resolve(false);
    let atTap;
    const tapped = new Promise(r => { atTap = r; });
    st.cardQueue = st.cardQueue.then(() => runCardTap(P, atTap)).catch(() => atTap(false));
    return tapped;
  };
  function runCardTap(P, atTap) {
    const tz = st.caseData.tapZone;
    const lidM = st.lidRig.matrix;
    const centre = (tz ? vfa(tz.origin) : st.lid.O.clone().addScaledVector(st.lid.U, 140).addScaledVector(st.lid.V, 40)).applyMatrix4(lidM);
    const n = st.lid.N.clone().transformDirection(lidM);
    const u = st.lid.U.clone().transformDirection(lidM);
    const z = v3().crossVectors(u, n).normalize();
    const restM = P.holder.matrix.clone();
    const p0 = v3(), q0 = new T.Quaternion(), s0 = v3();
    restM.decompose(p0, q0, s0);
    // centre of the card body over the mark
    const lc = P.localBox.getCenter(v3()); lc.y = 0;
    const qT = new T.Quaternion().setFromRotationMatrix(new T.Matrix4().makeBasis(u, n, z));
    qT.multiply(new T.Quaternion().setFromAxisAngle(v3(0, 1, 0), -8 * DEG));
    const hoverH = 5.5;
    const pT = centre.clone().addScaledVector(n, hoverH).sub(lc.clone().applyQuaternion(qT));
    const lift = p0.clone().add(v3(0, 34, 0));
    const above = pT.clone().addScaledVector(n, 34);
    const path = new T.CatmullRomCurve3([p0, lift, above.clone().lerp(lift, 0.35).add(v3(0, 18, 0)), above, pT], false, 'centripetal');
    const q = new T.Quaternion(), pos = v3(), M = new T.Matrix4(), one = v3(1, 1, 1);
    P.cardPose = M;
    const pose = (e, back) => {
      path.getPoint(e, pos);
      q.copy(q0).slerp(qT, smooth(e, 0.15, 0.85));
      M.compose(pos, q, one);
      P.holder.matrix.copy(M);
      P.holder.matrixWorldNeedsUpdate = true;
      shadowsDirty();
    };
    const go = dur(900), hold = st.reduced ? 500 : 950, ret = dur(800);
    return animate('card', go, e => pose(e), MC.ease)
      .then(() => { atTap(true); keepAlive(hold + 60); })
      .then(() => animate('card', hold, (e, raw) => {
        pos.copy(pT).addScaledVector(n, -1.2 * Math.sin(Math.PI * raw));
        M.compose(pos, qT, one); P.holder.matrix.copy(M); P.holder.matrixWorldNeedsUpdate = true; shadowsDirty();
      }, t => t))
      .then(() => animate('card', ret, e => pose(1 - e), MC.ease))
      .then(() => { P.cardPose = null; st.explodeDirty = true; requestRender(); });
  }

  S.setExplode = function (t, opts) {
    t = MC.clamp(+t || 0, 0, 1);
    st.exTarget = t;
    const from = st.ex;
    const ms = opts && opts.instant ? 0 : dur(1100 * Math.max(0.35, Math.abs(t - from)));
    const refit = !st.userMoved && !st.isolated && st.step === null && !(opts && opts.camera === false);
    if (ms <= 0) { stopTween('explode'); st.ex = t; applyExplode(); st.explodeDirty = true; requestRender(); }
    else animate('explode', ms, e => { st.ex = MC.lerp(from, t, e); st.explodeDirty = true; });
    if (refit) {
      const keep = st.ex;
      st.ex = t; applyExplode();
      const pose = currentPose();
      st.ex = keep; applyExplode();
      // a slider drag sends many instant steps: the camera glides after them
      flyTo(pose, ms > 0 ? ms : dur(520));
    }
    return st.exTarget;
  };
  S.getExplode = () => st.exTarget;

  S.setView = function (patch) {
    patch = patch || {};
    const v = st.view;
    for (const k of Object.keys(patch)) if (k in v) v[k] = !!patch[k];
    if ('autoRotate' in patch) {
      st.controls.autoRotate = v.autoRotate && !st.reduced;
      if (v.autoRotate) st.userMoved = false;
    }
    applyVisibility();
    applyLooks();
    if ('lid' in patch) st.wiresDirty = true;
    emit('scene:view', S.getView());
    requestRender();
    return S.getView();
  };
  S.getView = () => Object.assign({}, st.view, { explode: st.exTarget, step: st.step, isolated: st.isolated, preset: st.preset });

  S.camera = function (name, opts) {
    name = name || 'hero';
    // the build guide frames each step itself; a preset requested together with setStep is ignored
    if (st.step !== null && now() < st.stepCamUntil && !(opts && opts.force)) return Promise.resolve(true);
    if (['hero', 'front', 'top', 'keypad', 'inside', 'back'].indexOf(name) < 0) name = 'hero';
    st.preset = name;
    st.framing = { kind: 'preset' };
    st.userMoved = false;
    if (name !== 'hero' && st.controls.autoRotate) { st.controls.autoRotate = false; st.view.autoRotate = false; emit('scene:view', S.getView()); }
    if (name === 'inside' && st.step === null && st.exTarget < 0.85 && st.view.lid && !st.view.xray) {
      S.setExplode(1);
      return Promise.resolve(true);
    }
    return flyTo(presetPose(name), opts && opts.instant ? 0 : dur(1150));
  };

  S.highlight = function (sel) {
    st.focus = sel && (sel.part || sel.net || sel.wire) ? { part: sel.part || null, net: sel.net || null, wire: sel.wire || null } : null;
    applyLooks();
  };

  S.isolate = function (id) {
    id = id || null;
    if (id && !st.parts[id] && !st.caseMeshes.some(C => C.id === id)) id = null;
    if (id === st.isolated) return;
    if (id && !st.isolated) st.beforeIsolate = { target: st.controls.target.clone(), pos: st.camera.position.clone() };
    st.isolated = id;
    applyVisibility();
    if (id) {
      st.framing = { kind: 'isolate' };
      st.userMoved = false;
      flyTo(isolatePose(id), dur(900));
    } else if (st.beforeIsolate) {
      st.framing = { kind: 'preset' };
      flyTo(st.beforeIsolate, dur(900));
      st.beforeIsolate = null;
    }
    emit('scene:view', S.getView());
  };

  function isolatePose(id) {
    const box = partBox(id);
    const P = st.parts[id];
    let dir = dirFrom(32, 34);
    if (P && P.rig === 'lid') {
      const n = st.lid.N.clone().transformDirection(st.lidRig.matrix);
      if (id === 'rc522') n.negate();
      dir = n.add(v3(0.35, 0.25, 0.45)).normalize();
      if (dir.y < 0.2) { dir.y = 0.35; dir.normalize(); }
    }
    return fitPose(box, dir, 0.62);
  }

  S.setStep = function (n, opts) {
    opts = opts || {};
    if (n === null || n === undefined || n === false) {
      const was = st.step;
      st.step = null;
      st.framing = { kind: 'preset' };
      for (const W of st.wires) W.hiddenByDrop = false;
      applyVisibility();
      setLidOpen(0);
      if (was !== null && st.exBeforeSteps !== undefined) { S.setExplode(st.exBeforeSteps); st.exBeforeSteps = undefined; }
      emit('scene:view', S.getView());
      return;
    }
    n = MC.clamp(Math.round(n), 1, MC.STEPS.length);
    if (st.step === null) st.exBeforeSteps = st.exTarget;
    const prev = st.step;
    st.step = n;
    // the lid floats above while the inside is built, swings open for the modules mounted under
    // it (oled, rc522) and closes for the last step
    const ex = n === 1 ? 0.75 : n >= MC.STEPS.length ? 0 : 1;
    const open = n === 5 || n === 6 ? 1 : 0;
    if (Math.abs(st.exTarget - ex) > 0.01) S.setExplode(ex, { camera: false });
    setLidOpen(open);
    const fresh = MC.STEPS[n - 1].parts.filter(id => st.parts[id]);
    const forward = prev === null || n > prev;
    for (const W of st.wires) W.hiddenByDrop = forward && W.step === n && !st.reduced;
    applyVisibility();
    if (forward && !st.reduced) {
      for (const id of fresh) {
        const P = st.parts[id];
        P.dropDir = P.rig === 'lid' ? st.lid.N.clone().negate() : v3(0, 1, 0);
        if (P.rig === 'lid' && id === 'keypad') P.dropDir = st.lid.N.clone();
      }
      animate('drop', 750, (e, raw) => {
        for (const id of fresh) st.parts[id].drop = (1 - easeOutBack(raw)) * 46;
        st.explodeDirty = true;
      }, t => t).then(() => {
        for (const id of fresh) st.parts[id].drop = 0;
        st.explodeDirty = true;
        let any = false;
        for (const W of st.wires) if (W.hiddenByDrop) { W.hiddenByDrop = false; any = true; }
        if (any) applyVisibility();
      });
    }
    if (opts.camera !== false) {
      st.stepCamUntil = now() + 250;
      const presets = { 1: 'hero', 2: 'inside', 3: 'inside', 4: 'keypad', 5: 'hero', 6: 'hero', 7: 'hero' };
      const name = presets[n] || 'hero';
      st.preset = name; st.userMoved = false;
      st.framing = { kind: 'step' };
      flyTo(stepPose(n, ex), dur(1150));
    }
    emit('scene:view', S.getView());
  };
  function setLidOpen(o) {
    const from = st.lidOpen;
    if (Math.abs(from - o) < 1e-3) return;
    animate('lidOpen', dur(1000), e => { st.lidOpen = MC.lerp(from, o, e); st.explodeDirty = true; });
  }
  function stepPose(n, ex) {
    const keep = st.ex, keepO = st.lidOpen;
    st.ex = ex; st.lidOpen = n === 5 || n === 6 ? 1 : 0; applyExplode();
    let pose;
    if (n === 2 || n === 3) {
      const ids = n === 2 ? ['uno'] : ['breadboard', 'buzzer', 'resistor'];
      const box = sceneBox({});
      box.max.y = 46;
      const fb = new T.Box3();
      ids.forEach(id => { const b = partBox(id); if (b) fb.union(b); });
      box.min.lerp(fb.min, 0.3); box.max.lerp(fb.max, 0.3);
      pose = fitPose(box, dirFrom(14, 44), 0.9);
    } else if (n === 4) {
      pose = fitPose(sceneBox({ lid: true }), dirFrom(-30, 24), 0.9);
    } else if (n === 5 || n === 6) {
      pose = fitPose(sceneBox({ lid: true }), dirFrom(n === 5 ? 24 : 16, 20), 0.9);
    } else pose = presetPose('hero');
    st.ex = keep; st.lidOpen = keepO; applyExplode();
    return pose;
  }

  S.setTheme = function (name) {
    st.theme = name === 'light' ? 'light' : 'dark';
    const th = THEMES[st.theme];
    if (!st.renderer) return;
    st.renderer.toneMappingExposure = th.exposure;
    st.lights.key.intensity = th.key * st.keyDist * st.keyDist;   // candela: key lux at the console
    st.lights.fill.intensity = th.fill;
    st.lights.rim.intensity = th.rim;
    st.ground.material.opacity = th.shadow;
    applyEnv();
    if (st.contact) st.contact.material.opacity = th.contact;
    for (const C of st.caseMeshes) {
      C.xray.color.set(st.theme === 'light' ? '#9AA6B4' : '#DDE3EA');
      C.xray.userData.mcBase.color = C.xray.color.clone();
      if (C.edges) C.edges.material.color.set(st.theme === 'light' ? '#5B6573' : '#C9D2DD');
    }
    applyLooks();
    styleLabels();
    requestRender();
  };

  S.setCaseColor = function (hex) {
    st.caseColor = hex;
    const c = new T.Color(hex);
    for (const C of st.caseMeshes) {
      const mats = C.solid.concat(C.extra ? C.extra.map(m => m.material) : []);
      for (const m of mats) {
        m.color.copy(c);
        if (m.sheenColor) m.sheenColor.copy(c).lerp(new T.Color('#FFFFFF'), 0.4);
        if (m.userData.mcBase) m.userData.mcBase.color = c.clone();
      }
    }
    requestRender();
  };

  S.setOledVariant = function (name) {
    st.oledVariant = OLED_TINT[name] ? name : 'white';
    applyOledVariant();
  };

  S.setQuality = function (q) {
    st.quality = q === 'high' || q === 'low' || q === 'medium' ? q : 'auto';
    if (!st.renderer) return;
    if (st.quality === 'auto') {
      applyTier('high');
      st.probe = { times: [] };
      keepAlive(3000);
    } else { st.probe = null; applyTier(st.quality); }
  };

  S.screenshot = function (scale) {
    const k = scale || 2;
    const r = st.renderer;
    const { w, h } = viewSize();
    const prev = r.getPixelRatio();
    r.setPixelRatio(k);
    r.setSize(w, h, false);
    shadowsDirty();
    r.render(st.scene, st.camera);
    const out = document.createElement('canvas');
    out.width = Math.round(w * k); out.height = Math.round(h * k);
    const ctx = out.getContext('2d');
    const tk = MC.tokens[st.theme];
    const g = ctx.createLinearGradient(0, 0, 0, out.height);
    g.addColorStop(0, tk.stageTop); g.addColorStop(1, tk.stageBottom);
    ctx.fillStyle = g; ctx.fillRect(0, 0, out.width, out.height);
    ctx.drawImage(r.domElement, 0, 0, out.width, out.height);
    r.setPixelRatio(prev);
    r.setSize(w, h, false);
    requestRender();
    return out.toDataURL('image/png');
  };

  S.project = function (vec) {
    const p = vec.clone().project(st.camera);
    const { w, h } = viewSize();
    return { x: (p.x * 0.5 + 0.5) * w, y: (-p.y * 0.5 + 0.5) * h, visible: p.z > -1 && p.z < 1 && Math.abs(p.x) <= 1.05 && Math.abs(p.y) <= 1.05 };
  };

  // Extras beyond the contract, used by the UI for labels and layout.
  S.anchor = function (id) {
    const P = st.parts[id];
    if (P) {
      const sz = P.built.size || [0, 0, 0];
      const top = Math.max(sz[1] || 0, 0.5);
      return v3(0, top, 0).applyMatrix4(P.built.group.matrixWorld);
    }
    const b = partBox(id);
    if (!b) return null;
    const c = b.getCenter(v3());
    c.y = b.max.y;
    return c;
  };
  S.pinPosition = function (part, pin) {
    const P = st.parts[part];
    if (!P) return null;
    let p = P.built.pins[pin] && P.built.pins[pin].p;
    if (!p && part === 'breadboard') p = bbHole(pin);
    return p ? p.clone().applyMatrix4(P.built.group.matrixWorld) : null;
  };
  S.setInsets = function (ins) {
    st.insets = Object.assign({ left: 0, right: 0, top: 0, bottom: 0 }, ins || {});
    resize();
  };
  S.resize = resize;
  S.requestRender = requestRender;
  S.info = function () {
    const i = st.renderer.info;
    return {
      calls: i.render.calls, triangles: i.render.triangles, geometries: i.memory.geometries, textures: i.memory.textures,
      programs: i.programs ? i.programs.length : 0, tier: st.tier, fps: st.fps.value,
      fallbacks: st.fallbacks.slice(), caseFallback: st.caseFallback, explode: st.ex
    };
  };

})();
