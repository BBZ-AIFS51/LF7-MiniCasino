/* Mini Casino viewer: shared core. Namespace, events, design tokens, the V11 net list,
   every physical wire, the parts, the build steps and the coordinate helpers.
   The wiring here is the single source for the 3D scene, the UI and the schematic links. */
(function () {
  'use strict';
  const MC = window.MC = window.MC || {};
  MC.version = 'V11';

  // ------------------------------------------------------------------ events
  const handlers = Object.create(null);
  MC.bus = {
    on(name, fn) { (handlers[name] = handlers[name] || []).push(fn); return () => MC.bus.off(name, fn); },
    off(name, fn) {
      const list = handlers[name];
      if (!list) return;
      const i = list.indexOf(fn);
      if (i >= 0) list.splice(i, 1);
    },
    emit(name, data) {
      const list = handlers[name];
      if (!list) return;
      for (const fn of list.slice()) {
        try { fn(data); } catch (err) { console.error('[MC.bus] ' + name, err); }
      }
    }
  };

  // ------------------------------------------------------------------ design tokens
  // Same values in css/app.css (custom properties), docs/make_graphics.py and case/make_case.py.
  MC.tokens = {
    font: 'Inter, ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif',
    mono: '"JetBrains Mono", ui-monospace, "Cascadia Code", Consolas, monospace',
    radius: { s: 8, m: 12, l: 18 },
    dark: {
      bg: '#0B0D10', bg2: '#11141A', surface: '#14181E', surface2: '#1B2027', surface3: '#232932',
      line: 'rgba(255,255,255,0.08)', line2: 'rgba(255,255,255,0.14)',
      ink: '#E9ECF1', ink2: '#B4BCC8', muted: '#7D8794',
      accent: '#3DD68C', accentInk: '#06140D', accentSoft: 'rgba(61,214,140,0.14)',
      warn: '#F5A524', danger: '#F2555A', info: '#5B9DFF',
      stageTop: '#1A1F27', stageBottom: '#07080A'
    },
    light: {
      bg: '#F5F6F8', bg2: '#ECEEF2', surface: '#FFFFFF', surface2: '#F3F5F8', surface3: '#E7EAEF',
      line: 'rgba(15,17,21,0.08)', line2: 'rgba(15,17,21,0.14)',
      ink: '#0F1115', ink2: '#3A4250', muted: '#6B7480',
      accent: '#0E9F6E', accentInk: '#FFFFFF', accentSoft: 'rgba(14,159,110,0.10)',
      warn: '#B7791F', danger: '#D93036', info: '#2F6FEB',
      stageTop: '#F4F5F7', stageBottom: '#D9DDE3'
    },
    game: { black: '#1F2329', red: '#E5484D', green: '#30A46C' },
    caseColors: [
      { id: 'arctic', name: 'arctic white', hex: '#E4E6EA' },
      { id: 'graphite', name: 'graphite', hex: '#2C3036' },
      { id: 'sage', name: 'sage', hex: '#9DB5A5' },
      { id: 'signal', name: 'signal red', hex: '#C8373D' }
    ]
  };

  // ------------------------------------------------------------------ nets
  // color = physical wire insulation, used in 3D, schematic and docs alike.
  MC.NETS = [
    { id: 'GND',  label: 'GND',        color: '#202328', group: 'power', desc: 'common ground of Uno, OLED, RC522 and buzzer' },
    { id: 'V5',   label: '5V',         color: '#E5484D', group: 'power', desc: '5 V supply for the OLED' },
    { id: 'V3V3', label: '3.3V',       color: '#F08C2E', group: 'power', desc: '3.3 V for the RC522, never 5 V' },
    { id: 'SDA',  label: 'SDA · A4',   color: '#3B82F6', group: 'i2c',   desc: 'I2C data to the OLED (0x3C)' },
    { id: 'SCL',  label: 'SCL · A5',   color: '#EAB308', group: 'i2c',   desc: 'I2C clock to the OLED, 400 kHz' },
    { id: 'SS',   label: 'SDA/SS · D10', color: '#9AA4B2', group: 'spi', desc: 'SPI chip select of the RC522 (labelled SDA on the module)' },
    { id: 'SCK',  label: 'SCK · D13',  color: '#22C55E', group: 'spi',   desc: 'SPI clock' },
    { id: 'MOSI', label: 'MOSI · D11', color: '#F1F3F6', group: 'spi',   desc: 'SPI data Uno to RC522' },
    { id: 'MISO', label: 'MISO · D12', color: '#A855F7', group: 'spi',   desc: 'SPI data RC522 to Uno' },
    { id: 'RST',  label: 'RST · D9',   color: '#14B8A6', group: 'spi',   desc: 'reset of the RC522' },
    { id: 'BUZ',  label: 'D2',         color: '#9A6A3A', group: 'sound', desc: 'buzzer signal, D2 to the 330 Ω resistor' },
    { id: 'BUZ_S', label: 'buzzer S',  color: '#9A6A3A', group: 'sound', desc: 'between the 330 Ω resistor and the buzzer S pin (breadboard column 26)' },
    { id: 'KP1', label: 'D3 · col ABCD', color: '#8B5A2B', group: 'keypad', desc: 'keypad pin 1, column A B C D' },
    { id: 'KP2', label: 'D4 · col 369#', color: '#DC2626', group: 'keypad', desc: 'keypad pin 2, column 3 6 9 #' },
    { id: 'KP3', label: 'D5 · col 2580', color: '#EA580C', group: 'keypad', desc: 'keypad pin 3, column 2 5 8 0' },
    { id: 'KP4', label: 'D6 · col 147*', color: '#FACC15', group: 'keypad', desc: 'keypad pin 4, column 1 4 7 *' },
    { id: 'KP5', label: 'D7 · row *0#D', color: '#16A34A', group: 'keypad', desc: 'keypad pin 5, row * 0 # D' },
    { id: 'KP6', label: 'D8 · row 789C', color: '#2563EB', group: 'keypad', desc: 'keypad pin 6, row 7 8 9 C' },
    { id: 'KP7', label: 'A0 · row 456B', color: '#7C3AED', group: 'keypad', desc: 'keypad pin 7, row 4 5 6 B' },
    { id: 'KP8', label: 'A1 · row 123A', color: '#9CA3AF', group: 'keypad', desc: 'keypad pin 8, row 1 2 3 A' }
  ];
  MC.net = id => MC.NETS.find(n => n.id === id) || null;

  // ------------------------------------------------------------------ parts
  MC.PARTS = [
    { id: 'uno', name: 'Arduino Uno R3', short: 'uno', desc: 'ATmega328P, runs the game, admin protocol over USB at 115200 baud',
      pins: 'D2 buzzer · D3–D8, A0, A1 keypad · D9–D13 RC522 · A4/A5 OLED · A2, A3 free · D0/D1 USB' },
    { id: 'oled', name: '1.3" OLED 128×64', short: 'oled', desc: 'SH1106, I2C 0x3C, 4 pins, title bar, two big text lines and a hint line',
      pins: 'GND · VCC 5V · SCL A5 · SDA A4' },
    { id: 'rc522', name: 'RC522 RFID reader', short: 'rc522', desc: '13.56 MHz, reads the card UID through the lid, 3.3 V only',
      pins: 'SDA D10 · SCK D13 · MOSI D11 · MISO D12 · RST D9 · 3.3V · GND · IRQ free' },
    { id: 'keypad', name: '4×4 membrane keypad', short: 'keypad', desc: '1/2/3 bet black/red/green, A stake, B logout, C sound, D help',
      pins: 'P1–P8 to D3, D4, D5, D6, D7, D8, A0, A1' },
    { id: 'breadboard', name: 'half-size breadboard', short: 'breadboard', desc: 'carries the buzzer, the 330 Ω resistor and the GND rail',
      pins: 'OLED lead j2–j5 · buzzer c26–c28 · resistor e24–e26' },
    { id: 'buzzer', name: 'passive buzzer module', short: 'buzzer', desc: 'plays the win, loss and jackpot jingles, three volume levels',
      pins: 'S via 330 Ω to D2 · middle unused · − to GND' },
    { id: 'resistor', name: '330 Ω resistor', short: '330 Ω', desc: 'limits the buzzer current (orange, orange, brown, gold)', pins: 'e24 ↔ e26' },
    { id: 'case_base', name: 'case body', short: 'body', desc: 'printed in PLA, holds Uno and breadboard, USB opening on the side', pins: '' },
    { id: 'case_lid', name: 'case lid', short: 'lid', desc: 'printed face down, OLED window, keypad recess, RFID tap zone, 10° slope', pins: '' },
    { id: 'card_DF51AA39', name: 'card DF51AA39', short: 'card', desc: 'MIFARE Classic card, 4 byte UID', pins: '' },
    { id: 'card_0885B1A8', name: 'key fob 0885B1A8', short: 'fob', desc: 'MIFARE key fob, 4 byte UID', pins: '' },
    { id: 'card_049F905C110189', name: 'sticker 049F905C110189', short: 'sticker', desc: 'NTAG sticker, 7 byte UID', pins: '' },
    { id: 'card_04CABD5C110189', name: 'coin tag 04CABD5C110189', short: 'coin', desc: 'NTAG coin tag, 7 byte UID', pins: '' }
  ];
  MC.part = id => MC.PARTS.find(p => p.id === id) || null;

  MC.CARDS = [
    { uid: 'DF51AA39', kind: 'card', part: 'card_DF51AA39' },
    { uid: '0885B1A8', kind: 'fob', part: 'card_0885B1A8' },
    { uid: '049F905C110189', kind: 'sticker', part: 'card_049F905C110189' },
    { uid: '04CABD5C110189', kind: 'coin', part: 'card_04CABD5C110189' }
  ];

  // ------------------------------------------------------------------ physical wires
  // from/to: { part, pin } with pin names as exposed by MC.parts builders.
  // Breadboard holes are pins of part 'breadboard' named like 'j2' or 'gnd_lower_inner:28'.
  // kind: MM, MF (male at 'from'... see ends), FF; ends: what sits on each end of the jumper.
  const W = (id, net, from, to, endA, endB, step) => ({ id, net, from, to, endA, endB, step });
  const P = (part, pin) => ({ part, pin });
  MC.WIRES = [
    // OLED lead from the lid into the breadboard (step 5)
    W('oled_gnd', 'GND', P('oled', 'GND'), P('breadboard', 'j2'), 'female', 'male', 5),
    W('oled_vcc', 'V5',  P('oled', 'VCC'), P('breadboard', 'j3'), 'female', 'male', 5),
    W('oled_scl', 'SCL', P('oled', 'SCL'), P('breadboard', 'j4'), 'female', 'male', 5),
    W('oled_sda', 'SDA', P('oled', 'SDA'), P('breadboard', 'j5'), 'female', 'male', 5),
    W('bb_gnd',   'GND', P('breadboard', 'f2'), P('uno', 'GND1'), 'male', 'male', 5),
    W('bb_5v',    'V5',  P('breadboard', 'g3'), P('uno', '5V'),   'male', 'male', 5),
    W('bb_scl',   'SCL', P('breadboard', 'h4'), P('uno', 'A5'),   'male', 'male', 5),
    W('bb_sda',   'SDA', P('breadboard', 'i5'), P('uno', 'A4'),   'male', 'male', 5),
    // RC522 straight to the Uno (step 6)
    W('rc_sda',  'SS',   P('rc522', 'SDA'),  P('uno', 'D10'),  'female', 'male', 6),
    W('rc_sck',  'SCK',  P('rc522', 'SCK'),  P('uno', 'D13'),  'female', 'male', 6),
    W('rc_mosi', 'MOSI', P('rc522', 'MOSI'), P('uno', 'D11'),  'female', 'male', 6),
    W('rc_miso', 'MISO', P('rc522', 'MISO'), P('uno', 'D12'),  'female', 'male', 6),
    W('rc_gnd',  'GND',  P('rc522', 'GND'),  P('uno', 'GND2'), 'female', 'male', 6),
    W('rc_rst',  'RST',  P('rc522', 'RST'),  P('uno', 'D9'),   'female', 'male', 6),
    W('rc_3v3',  'V3V3', P('rc522', '3V3'),  P('uno', '3V3'),  'female', 'male', 6),
    // keypad: 8 jumpers from its female connector to the Uno (step 4)
    W('kp1', 'KP1', P('keypad', 'P1'), P('uno', 'D3'), 'male', 'male', 4),
    W('kp2', 'KP2', P('keypad', 'P2'), P('uno', 'D4'), 'male', 'male', 4),
    W('kp3', 'KP3', P('keypad', 'P3'), P('uno', 'D5'), 'male', 'male', 4),
    W('kp4', 'KP4', P('keypad', 'P4'), P('uno', 'D6'), 'male', 'male', 4),
    W('kp5', 'KP5', P('keypad', 'P5'), P('uno', 'D7'), 'male', 'male', 4),
    W('kp6', 'KP6', P('keypad', 'P6'), P('uno', 'D8'), 'male', 'male', 4),
    W('kp7', 'KP7', P('keypad', 'P7'), P('uno', 'A0'), 'male', 'male', 4),
    W('kp8', 'KP8', P('keypad', 'P8'), P('uno', 'A1'), 'male', 'male', 4),
    // buzzer and ground (step 3)
    W('buz_d2',   'BUZ', P('breadboard', 'a24'), P('uno', 'D2'), 'male', 'male', 3),
    W('buz_gnd',  'GND', P('breadboard', 'e28'), P('breadboard', 'gnd_lower_inner:28'), 'male', 'male', 3),
    W('rail_gnd', 'GND', P('breadboard', 'gnd_lower_inner:3'), P('uno', 'GND3'), 'male', 'male', 3)
  ];
  // Parts sitting in the breadboard (not wires): buzzer S/M/− in c26/c27/c28, resistor e24-e26.
  MC.BREADBOARD_PARTS = {
    buzzer: { S: 'c26', M: 'c27', MINUS: 'c28' },
    resistor: { a: 'e24', b: 'e26' }
  };

  // ------------------------------------------------------------------ build steps
  MC.STEPS = [
    { n: 1, title: 'print the case', parts: ['case_base', 'case_lid'],
      text: 'body and lid in PLA, 0.2 mm layers, 3 walls, 15 % infill, no supports. the lid prints face down.' },
    { n: 2, title: 'mount the uno', parts: ['uno'],
      text: 'four M3 screws into the standoffs, USB-B lines up with the opening in the side wall.' },
    { n: 3, title: 'breadboard, buzzer, 330 Ω', parts: ['breadboard', 'buzzer', 'resistor'],
      text: 'breadboard into its pocket. buzzer S/middle/− into c26/c27/c28, resistor e24 to e26, a24 to D2, e28 to the lower inner rail, rail to GND.' },
    { n: 4, title: 'keypad', parts: ['keypad'],
      text: 'stick the keypad into the recess, feed the tail through the slot, eight jumpers in order to D3, D4, D5, D6, D7, D8, A0, A1.' },
    { n: 5, title: 'oled', parts: ['oled'],
      text: 'OLED behind the window, glass facing out. 4-wire lead to j2–j5, then f2 GND, g3 5V, h4 A5, i5 A4.' },
    { n: 6, title: 'rc522', parts: ['rc522'],
      text: 'reader under the tap zone, 7 wires: SDA D10, SCK D13, MOSI D11, MISO D12, RST D9, GND, 3.3V. never 5 V.' },
    { n: 7, title: 'close and play', parts: ['card_DF51AA39', 'card_0885B1A8', 'card_049F905C110189', 'card_04CABD5C110189'],
      text: 'lid on, four M3 countersunk screws, USB in, upload MiniCasino.ino, tap a card. new cards get 100.' }
  ];

  // ------------------------------------------------------------------ bill of materials
  MC.BOM = [
    { qty: 1, item: 'Arduino Uno R3 (ATmega328P)', note: 'plus USB-B cable' },
    { qty: 1, item: '1.3" OLED 128×64, I2C, SH1106', note: '4 pins: GND VCC SCL SDA' },
    { qty: 1, item: 'RC522 RFID module', note: 'with the 90° header from the kit' },
    { qty: 4, item: 'MIFARE / NTAG transponders', note: 'any 4 or 7 byte UID works' },
    { qty: 1, item: '4×4 membrane keypad', note: '8-pin tail' },
    { qty: 1, item: 'passive buzzer module (3 pins)', note: 'KY-006 type' },
    { qty: 1, item: 'resistor 330 Ω, ¼ W', note: 'orange orange brown gold' },
    { qty: 1, item: 'half-size breadboard, 400 points', note: 'self-adhesive' },
    { qty: 11, item: 'jumper wires female–male', note: '4 OLED, 7 RC522' },
    { qty: 15, item: 'jumper wires male–male', note: '8 keypad, 4 breadboard–Uno, 3 buzzer/GND' },
    { qty: 4, item: 'M3 screws for the Uno standoffs', note: '6 mm' },
    { qty: 1, item: 'printed case: body + lid', note: 'see case/stl' }
  ];

  // ------------------------------------------------------------------ coordinates
  function dims() { return (window.MC_CASE && window.MC_CASE.dims) || { W: 190, D: 130 }; }
  // case (x right, y back, z up, origin front-left-bottom) -> world (three.js, Y up, front = +Z)
  MC.caseToWorld = function (x, y, z) {
    const d = dims();
    return [x - d.W / 2, z, d.D / 2 - y];
  };
  // placement { origin, x, y } -> THREE.Matrix4; local Z = x × y
  MC.placeMatrix = function (place) {
    const T = window.THREE;
    const x = new T.Vector3().fromArray(place.x).normalize();
    const y = new T.Vector3().fromArray(place.y).normalize();
    const z = new T.Vector3().crossVectors(x, y).normalize();
    const m = new T.Matrix4().makeBasis(x, y, z);
    m.setPosition(new T.Vector3().fromArray(place.origin));
    return m;
  };

  // small helpers shared by everyone
  MC.clamp = (v, a, b) => Math.min(b, Math.max(a, v));
  MC.lerp = (a, b, t) => a + (b - a) * t;
  MC.ease = t => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
  MC.formatUid = uid => uid.replace(/(..)/g, '$1 ').trim();
  MC.storage = {
    get(key, fallback) {
      try { const v = window.localStorage.getItem('mc11.' + key); return v === null ? fallback : JSON.parse(v); }
      catch (e) { return fallback; }
    },
    set(key, value) {
      try { window.localStorage.setItem('mc11.' + key, JSON.stringify(value)); } catch (e) { /* private mode */ }
    }
  };
})();
