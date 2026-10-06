/* Mini Casino viewer: the firmware, simulated.

   A line-by-line port of MiniCasino.ino, GameRuntime.h, GameRules.h and UidRegistry.h (V11, the
   real build: RC522 present, passive buzzer, euro sign, DEBUG_LOG false). Port, not a remake:
   the same functions in the same order, the same strings, the same timers, the same quirks.

   How it runs: one simulated CPU executes setup() and then loop() over and over, exactly like the
   Uno. Inputs are physical states (a key is down, a card lies in the RF field, bytes sit in the
   UART buffer) that loop() polls. delay() and the hand-clocked tones block the CPU, so a key
   pressed and released during the spin or a jingle is simply never seen, and tastenSperren()
   swallows one that is still held afterwards. Time comes from a clock object (real or virtual,
   see MC.SimClock); the CPU keeps its own exact timeline, including the I2C time of every OLED
   transaction and 3.4 ms for every EEPROM byte it really writes, so screens build up and change
   as fast as on the real console. Inputs carry the time they happened and the CPU replays them at
   that time, so a busy page (heavy 3D frames, a background tab) delays the picture but never
   changes what the firmware sees. The simulated EEPROM (1 KB, format 07) is persisted in
   localStorage through MC.storage (key 'mc11.eeprom'), and works without it.

   Serial direction is seen from the PC, like a serial monitor: dir 'tx' = sent to the Uno (the
   typed command), dir 'rx' = received from the Uno (replies and log lines); kind is 'cmd',
   'reply', 'err' or 'log'.

   Public API: new MC.Sim({ fw, oled, audio, clock, rng, storage, debugLog, ... }), boot(),
   pressKey(), keyDown(), keyUp(), tapCard(), placeCard(), removeCard(), admin(), adminAsync(),
   state(), accounts(), setDebugLog(), reboot(), reset(), serialHistory(), destroy().
   Events on MC.bus: 'sim:state', 'sim:busy', 'sim:result', 'serial:line' and a few extras
   ('sim:boot', 'sim:key', 'sim:card', 'sim:scan', 'sim:spin', 'sim:sound', 'sim:led'). */
(function () {
  'use strict';
  const MC = window.MC = window.MC || {};

  // =================================================================== GameRules.h
  const DEFAULT_RULES = { STAKE: 10, STAKE_SCHRITT: 10, STAKE_MAX: 2550, BLACK_PERCENT: 45, RED_PERCENT: 45, GREEN_PERCENT: 10 };
  const u8 = v => v & 0xFF, u16 = v => v & 0xFFFF, u32 = v => v >>> 0;

  function makeRules(r) {
    const STAKE = r.STAKE, STAKE_SCHRITT = r.STAKE_SCHRITT, STAKE_MAX = r.STAKE_MAX;
    const BLACK_PERCENT = r.BLACK_PERCENT, RED_PERCENT = r.RED_PERCENT, GREEN_PERCENT = r.GREEN_PERCENT;
    const R = {
      STAKE, STAKE_SCHRITT, STAKE_MAX, BLACK_PERCENT, RED_PERCENT, GREEN_PERCENT,
      // Input is uniformly drawn from 0..99. 3 denotes an invalid ticket.
      colourForTicket(ticket) {
        ticket = u8(ticket);
        return ticket >= 100 ? 3 : ticket < BLACK_PERCENT ? 0 : ticket < BLACK_PERCENT + RED_PERCENT ? 1 : 2;
      },
      // Consecutive steps, 8+ turns, the last step always equals the already drawn result.
      spinSteps(start, result) { return u8(24 + (u8(result) + 4 - u8(start)) % 3); },
      spinLed(start, step) { return u8((u8(start) + u8(step)) % 3); },
      // 45 + (455UL * step * step) / ((count - 1UL) * (count - 1UL)), 32-bit unsigned long, uint16_t result
      spinDelay(step, count) {
        step = u8(step); count = u8(count);
        const d = u32(Math.imul(u32(count - 1), u32(count - 1)));
        const q = d === 0 ? 0xFFFFFFFF : Math.floor(u32(455 * step * step) / d);   // AVR libgcc: x / 0 = all ones
        return u16(45 + q);
      },
      payoutMultiplier(choice) { choice = u8(choice); return choice >= 3 ? 0 : choice === 2 ? 9 : 2; },
      canPlay(balance, choice, stake) {
        balance = u32(balance); choice = u8(choice === undefined ? 0 : choice); stake = u32(stake === undefined ? STAKE : stake);
        return choice < 3 && stake >= STAKE_SCHRITT && stake <= STAKE_MAX && balance >= stake
          && balance <= 0xFFFFFFFF - u32(stake * (R.payoutMultiplier(choice) - 1));
      },
      payout(choice, result, stake) {
        choice = u8(choice); result = u8(result); stake = u32(stake === undefined ? STAKE : stake);
        return choice < 3 && choice === result ? u32(R.payoutMultiplier(choice) * stake) : 0;
      },
      canSettle(debited, choice, result, stake) {
        return u8(choice) < 3 && u8(result) < 3 && u32(debited) <= 0xFFFFFFFF - R.payout(choice, result, stake);
      },
      settled(debited, choice, result, stake) { return u32(u32(debited) + R.payout(choice, result, stake)); },
      // Groesster erlaubter Einsatz zu einem Guthaben, immer ein Vielfaches des Schritts.
      stakeLimit(balance) {
        balance = u32(balance);
        return balance < STAKE_SCHRITT ? STAKE_SCHRITT
          : Math.floor((balance < STAKE_MAX ? balance : STAKE_MAX) / STAKE_SCHRITT) * STAKE_SCHRITT;
      },
      // 0 = gueltig, 1 = kleiner als ein Schritt, 2 = kein Vielfaches, 3 = ueber der Grenze.
      checkStake(value, limit) {
        value = u32(value); limit = u32(limit);
        return value < STAKE_SCHRITT ? 1 : value % STAKE_SCHRITT ? 2 : value > limit ? 3 : 0;
      },
      // GameSounds.h: Jackpot ist ein Treffer auf Gruen, unabhaengig von der Hoehe.
      effectForChoice(win, choice) { return !win ? 'loss' : u8(choice) === 2 ? 'jackpot' : 'win'; },
      effectForRound(win, payout) { return !win ? 'loss' : payout === 90 ? 'jackpot' : 'win'; }
    };
    return R;
  }
  MC.Rules = makeRules(Object.assign({}, DEFAULT_RULES, (window.MC_FW && window.MC_FW.rules) || {}));
  MC.makeRules = makeRules;

  // =================================================================== clocks
  let macrotask = null;
  function nextMacrotask() {
    if (!macrotask) {
      if (typeof setImmediate === 'function') macrotask = () => new Promise(r => setImmediate(r));
      else if (typeof MessageChannel === 'function') {
        const ch = new MessageChannel(), waiting = [];
        ch.port1.onmessage = () => { const r = waiting.shift(); if (r) r(); };
        macrotask = () => new Promise(r => { waiting.push(r); ch.port2.postMessage(0); });
      } else macrotask = () => new Promise(r => setTimeout(r, 0));
    }
    return macrotask();
  }

  // Deterministic clock for tests and offline rendering: time moves only with advance().
  class VirtualClock {
    constructor(start) { this.t = start || 0; this.q = []; this.seq = 0; }
    now() { return this.t; }
    setTimeout(fn, ms) {
      const id = ++this.seq;
      this.q.push({ at: this.t + Math.max(0, +ms || 0), id, fn });
      return id;
    }
    clearTimeout(id) {
      const i = this.q.findIndex(e => e.id === id);
      if (i >= 0) this.q.splice(i, 1);
    }
    async advance(ms) {
      const end = this.t + Math.max(0, +ms || 0);
      await nextMacrotask();
      for (;;) {
        let best = -1;
        for (let i = 0; i < this.q.length; i++) {
          const e = this.q[i], b = this.q[best];
          if (e.at <= end && (best < 0 || e.at < b.at || (e.at === b.at && e.id < b.id))) best = i;
        }
        if (best < 0) break;
        const e = this.q.splice(best, 1)[0];
        if (e.at > this.t) this.t = e.at;
        e.fn();
        await nextMacrotask();
      }
      this.t = end;
      await nextMacrotask();
    }
    advanceTo(t) { return this.advance(t - this.t); }
  }
  const realClock = {
    now: () => (typeof performance !== 'undefined' ? performance.now() : Date.now()),
    setTimeout: (fn, ms) => setTimeout(fn, ms),
    clearTimeout: id => clearTimeout(id)
  };
  MC.SimClock = { real: () => realClock, virtual: start => new VirtualClock(start), VirtualClock };

  // =================================================================== EEPROM + UidRegistry.h
  const EEPROM_WRITE_MS = 3.4;   // ATmega328P: 3.3 ms per erase+write, EEPROM.update writes only changes

  class Eeprom {
    constructor(bytes, onWrite) { this.mem = bytes; this.onWrite = onWrite || null; this.writes = 0; }
    length() { return this.mem.length; }
    read(a) { return this.mem[a]; }
    update(a, v) {
      v &= 0xFF;
      if (this.mem[a] === v) return;
      this.mem[a] = v;
      this.writes++;
      if (this.onWrite) this.onWrite(a);
    }
  }

  // Format 07: 16 Byte Header + 32 Byte je Konto, also 31 Konten im 1-KiB-EEPROM.
  // Eintrag: Marker, Laenge, UID[10], CRC[2], Status, Formatversion, dann zwei 8-Byte-Kontokopien
  // (Sequenz, Guthaben[4], Einsatz, CRC[2]).
  const EINTRAG = 32, KONTO_A = 16, KONTO_B = 24;
  const ST_RESERVIERT = 0x5A, ST_NORMAL = 0xA5, ST_GESPERRT = 0xB4, ST_ADMIN = 0xC3;
  const NORMAL = 0, GESPERRT = 1, ADMIN = 2;
  const HEADER = [0x4D, 0x43, 0x55, 0x49, 0x44, 0x30, 0x37, 1, 0, 0, 0, 0, 0, 0, 0, 0xA5];   // 'MCUID07'
  const VORHER = [0x4D, 0x43, 0x55, 0x49, 0x44, 0x30, 0x36];                                   // 'MCUID06'

  class UidRegistry {
    constructor(memory) { this.memory = memory; this.ready = false; }
    bekannterStatus(st) { return st === ST_RESERVIERT || st === ST_NORMAL || st === ST_GESPERRT || st === ST_ADMIN; }
    adresse(slot) { return 16 + slot * EINTRAG; }
    blank(address, count) {
      let zeros = true, erased = true;
      for (let i = 0; i < count; ++i) {
        const b = this.memory.read(address + i);
        zeros = zeros && b === 0;
        erased = erased && b === 0xFF;
      }
      return zeros || erased;
    }
    crc16(address, count) {
      let crc = 0xFFFF;
      for (let i = 0; i < count; ++i) {
        crc ^= this.memory.read(address + i) << 8;
        for (let b = 0; b < 8; ++b) crc = (crc & 0x8000) ? ((crc << 1) ^ 0x1021) & 0xFFFF : (crc << 1) & 0xFFFF;
      }
      return crc;
    }
    checksum(address) { return this.crc16(address + 1, 11); }
    valid(slot) {
      const m = this.memory, a = this.adresse(slot);
      const n = m.read(a + 1), state = m.read(a + 14);
      return m.read(a) === 0xC6 && (n === 4 || n === 7 || n === 10) && m.read(a + 15) === 1 && this.bekannterStatus(state)
        && this.checksum(a) === (m.read(a + 12) | (m.read(a + 13) << 8));
    }
    kopieOk(c) { return this.crc16(c, 6) === (this.memory.read(c + 6) | (this.memory.read(c + 7) << 8)); }
    kopieSeq(c) { return this.memory.read(c); }
    kopieEinsatz(c) { return this.memory.read(c + 5); }
    kopieWert(c) {
      let value = 0;
      for (let i = 0; i < 4; ++i) value |= this.memory.read(c + 1 + i) << (8 * i);
      return value >>> 0;
    }
    // Sequenz zuerst, CRC zuletzt: erst damit gilt die Kopie ueberhaupt als lesbar.
    kopieSchreiben(c, seq, value, einsatz) {
      const m = this.memory;
      m.update(c, seq);
      for (let i = 0; i < 4; ++i) m.update(c + 1 + i, (value >>> (8 * i)) & 0xFF);
      m.update(c + 5, einsatz);
      const crc = this.crc16(c, 6);
      m.update(c + 6, crc & 0xFF);
      m.update(c + 7, crc >> 8);
    }
    aktuelleKopie(slot) {
      const a = this.adresse(slot) + KONTO_A, b = this.adresse(slot) + KONTO_B;
      const okA = this.kopieOk(a), okB = this.kopieOk(b);
      if (okA && okB) return ((this.kopieSeq(a) - this.kopieSeq(b)) & 0xFF) < 128 ? a : b;
      if (okA) return a;
      if (okB) return b;
      return -1;
    }
    capacity() { return Math.floor((this.memory.length() - 16) / EINTRAG); }
    begin() {
      const m = this.memory;
      this.ready = false;
      if (this.capacity() < 1) return false;
      let matches = true;
      for (let i = 0; i < 16; ++i) if (i < 8 || i === 15) matches = matches && m.read(i) === HEADER[i];
      if (!matches) {
        let vorgaenger = true;
        for (let i = 0; i < 7; ++i) vorgaenger = vorgaenger && m.read(i) === VORHER[i];
        if (vorgaenger) this.wipe();
        else if (!this.blank(0, m.length())) return false;
        for (let i = 0; i < 16; ++i) m.update(i, HEADER[i]);
        for (let i = 0; i < 16; ++i) if (m.read(i) !== HEADER[i]) return false;
      }
      this.ready = true;
      return true;
    }
    wipe() {
      const bytes = this.memory.length();
      for (let i = 0; i < bytes; ++i) this.memory.update(i, 0);
      this.ready = false;
    }
    // >=0: reserviert/bekannt, -1: unbekannt, -2: EEPROM/Eintrag fehlerhaft.
    find(uid, size) {
      if (!this.ready || (size !== 4 && size !== 7 && size !== 10)) return -2;
      let damaged = false;
      for (let slot = 0; slot < this.capacity(); ++slot) {
        const a = this.adresse(slot);
        if (!this.blank(a, EINTRAG)) {
          if (!this.valid(slot)) damaged = true;
          else {
            let same = this.memory.read(a + 1) === size;
            for (let i = 0; i < size; ++i) same = same && this.memory.read(a + 2 + i) === uid[i];
            if (same) return slot;
          }
        }
      }
      return damaged ? -2 : -1;
    }
    reserve(uid, size) {
      const previous = this.find(uid, size);
      if (previous !== -1) return previous;
      const m = this.memory;
      for (let slot = 0; slot < this.capacity(); ++slot) {
        const a = this.adresse(slot);
        if (this.blank(a, EINTRAG)) {
          m.update(a, 0);                       // ungueltig bis zum letzten Schreibschritt
          m.update(a + 1, size);
          for (let i = 0; i < 10; ++i) m.update(a + 2 + i, i < size ? uid[i] : 0);
          const crc = this.checksum(a);
          m.update(a + 12, crc & 0xFF);
          m.update(a + 13, crc >> 8);
          m.update(a + 14, ST_RESERVIERT);
          m.update(a + 15, 1);
          m.update(a, 0xC6);                    // Commit-Marker zuletzt
          return this.valid(slot) && this.find(uid, size) === slot ? slot : -2;
        }
      }
      return -3;   // voll: nie alte Eintraege verdraengen
    }
    confirmed(slot) {
      if (slot < 0 || slot >= this.capacity() || !this.valid(slot)) return false;
      const st = this.memory.read(this.adresse(slot) + 14);
      return st === ST_NORMAL || st === ST_GESPERRT || st === ST_ADMIN;
    }
    confirm(slot) {
      if (slot < 0 || slot >= this.capacity() || !this.valid(slot)) return false;
      if (!this.confirmed(slot)) this.memory.update(this.adresse(slot) + 14, ST_NORMAL);
      return this.confirmed(slot);
    }
    flag(slot) {
      if (!this.confirmed(slot)) return NORMAL;
      const st = this.memory.read(this.adresse(slot) + 14);
      return st === ST_GESPERRT ? GESPERRT : st === ST_ADMIN ? ADMIN : NORMAL;
    }
    setFlag(slot, art) {
      if (!this.confirmed(slot) || art > ADMIN) return false;
      this.memory.update(this.adresse(slot) + 14, art === GESPERRT ? ST_GESPERRT : art === ADMIN ? ST_ADMIN : ST_NORMAL);
      return this.flag(slot) === art;
    }
    banned(slot) { return this.flag(slot) === GESPERRT; }
    unlimited(slot) { return this.flag(slot) === ADMIN; }
    // Belegter Eintrag: die UID-Bytes, sonst null (frei/ungueltig).
    entry(slot) {
      if (!this.ready || slot < 0 || slot >= this.capacity()) return null;
      const a = this.adresse(slot);
      if (this.blank(a, EINTRAG) || !this.valid(slot)) return null;
      const size = this.memory.read(a + 1), uid = [];
      for (let i = 0; i < size; ++i) uid.push(this.memory.read(a + 2 + i));
      return uid;
    }
    clearSlot(slot) {
      if (!this.ready || slot < 0 || slot >= this.capacity()) return false;
      const a = this.adresse(slot);
      for (let i = 0; i < EINTRAG; ++i) this.memory.update(a + i, 0);
      return this.blank(a, EINTRAG);
    }
    options() { return this.ready ? this.memory.read(8) : 0; }
    setOptions(value) {
      if (!this.ready) return false;
      this.memory.update(8, value);
      return this.memory.read(8) === (value & 0xFF);
    }
    funded(slot) { return this.confirmed(slot) && this.aktuelleKopie(slot) >= 0; }
    balance(slot) {
      if (!this.confirmed(slot)) return 0;
      const c = this.aktuelleKopie(slot);
      return c < 0 ? 0 : this.kopieWert(c);
    }
    stakeUnits(slot) {
      if (!this.confirmed(slot)) return 0;
      const c = this.aktuelleKopie(slot);
      return c < 0 ? 0 : this.kopieEinsatz(c);
    }
    writeAccount(slot, value, einsatz) {
      if (!this.confirmed(slot)) return false;
      const a = this.adresse(slot) + KONTO_A, b = this.adresse(slot) + KONTO_B;
      const current = this.aktuelleKopie(slot);
      const seq = current < 0 ? 1 : (this.kopieSeq(current) + 1) & 0xFF;
      const target = current === a ? b : a;
      value >>>= 0;
      this.kopieSchreiben(target, seq, value, einsatz & 0xFF);
      return this.aktuelleKopie(slot) === target && this.kopieWert(target) === value && this.kopieEinsatz(target) === (einsatz & 0xFF);
    }
    setBalance(slot, value) { return this.writeAccount(slot, value, this.stakeUnits(slot)); }
    setStakeUnits(slot, einsatz) {
      if (!this.funded(slot)) return false;
      return this.writeAccount(slot, this.balance(slot), einsatz);
    }
  }
  MC.Eeprom = Eeprom;
  MC.UidRegistry = UidRegistry;

  // =================================================================== helpers
  const MODUS_SPIEL = 0, MODUS_EINSATZ = 1, MODUS_ABMELDEN = 2, MODUS_HILFE = 3;
  const MODE_NAMES = ['play', 'stake', 'logout', 'help'];
  const TON_LAUT = 0, TON_LEISE = 1, TON_AUS = 2;
  const SOUND_NAMES = ['laut', 'leise', 'aus'];
  const RC_OK = 0, RC_TIMEOUT = 1, RC_FEHLER = 2, RC_KOLLISION = 3;   // Rc522.h
  const KEYPAD_ZEICHEN_DEFAULT = '123A456B789C*0#D';
  const ABORT = { abort: true };
  // Estimated cost of one hand-clocked buzzer cycle beyond the two delayMicroseconds() calls:
  // two digitalWrite() (about 3.4 us each on a 16 MHz Uno) and the loop counter.
  const CYCLE_OVERHEAD_US = 7.5;
  const ACTIVE_BUZZER_HZ = 2300;    // TON_MODUS 2: an active buzzer only knows its own tone
  // RF timings of the RC522 driver: WUPA answer, anticollision + select per cascade level,
  // and HLTA, which waits for the 25 ms timer because a halted card does not answer.
  const RF_WUPA_MS = 1.0, RF_SELECT_MS = 2.2, RF_HALT_MS = 25;
  const RX_BUFFER = 64;             // HardwareSerial receive buffer of the Uno
  const OPTIBOOT_MS = 1000;         // reset button: Optiboot waits about 1 s before the sketch runs
  const HISTORY = 500;

  function defaultRng() {
    try {
      const c = window.crypto || (typeof crypto !== 'undefined' ? crypto : null);
      if (c && c.getRandomValues) return c.getRandomValues(new Uint32Array(1))[0];
    } catch (e) { /* fall back */ }
    return Math.floor(Math.random() * 4294967296) >>> 0;
  }
  function parseUid(text) {
    const hex = String(text || '').replace(/[\s:]/g, '').toUpperCase();
    if (!/^([0-9A-F]{2})+$/.test(hex)) return null;
    const bytes = hex.match(/../g).map(h => parseInt(h, 16));
    if (bytes.length !== 4 && bytes.length !== 7 && bytes.length !== 10) return null;
    return { uid: hex, bytes, size: bytes.length };
  }
  const uidHex = bytes => Array.from(bytes, b => (b < 16 ? '0' : '') + b.toString(16).toUpperCase()).join('');
  // tonSpiele(): period in whole microseconds, as many whole cycles as fit into the duration.
  function toneTiming(hz, dauer, stufe) {
    const periode = Math.floor(1000000 / hz);
    let an = stufe === TON_LEISE ? Math.floor(periode / 12) : Math.floor(periode / 2);
    if (an < 3) an = 3;
    const zyklen = Math.floor(dauer * 1000 / periode);
    const cycle = periode + CYCLE_OVERHEAD_US;
    return { hz: 1000000 / cycle, ms: zyklen * cycle / 1000, duty: an / periode };
  }
  function loadEeprom(bytes, key, persist) {
    const mem = new Uint8Array(bytes).fill(0xFF);   // a new ATmega328P: erased EEPROM
    if (!persist || !MC.storage) return mem;
    const hex = MC.storage.get(key, null);
    if (typeof hex === 'string' && hex.length === bytes * 2 && /^[0-9a-f]+$/i.test(hex)) {
      for (let i = 0; i < bytes; i++) mem[i] = parseInt(hex.substr(i * 2, 2), 16);
    }
    return mem;
  }

  // =================================================================== the sketch
  class Sim {
    constructor(opts) {
      opts = opts || {};
      const fw = this.fw = opts.fw || window.MC_FW;
      if (!fw || !fw.rules) throw new Error('MC.Sim needs window.MC_FW (data/firmware.js)');
      const r = fw.rules;
      this.Rules = opts.rules || makeRules(Object.assign({}, DEFAULT_RULES, r));
      this.clock = opts.clock || realClock;
      this.oled = opts.oled || new MC.Oled({ fw });
      this.audio = opts.audio !== undefined ? opts.audio : (MC.Audio || null);
      this.rng = opts.rng || defaultRng;
      this.persist = opts.storage !== false;
      this.storageKey = opts.storageKey || 'eeprom';
      this.cfg = Object.assign({}, fw.config, opts.config || {});
      this.debugLog = opts.debugLog !== undefined ? !!opts.debugLog : !!this.cfg.DEBUG_LOG;
      this.readerVersion = opts.readerVersion !== undefined ? opts.readerVersion : 0x88;   // the team's clone
      this.readerOk = opts.reader !== false;
      this.rfErrorRate = +opts.rfErrorRate || 0;
      this.bootHoldMs = +opts.bootHoldMs || 0;
      this.keyHoldMs = opts.keyHoldMs || 100;
      // A tap lasts about a second: long enough to be read even right after a scan pause
      // (SCAN_PAUSE_MS + one poll), short enough not to be read twice as a new card.
      this.cardHoldMs = opts.cardHoldMs || 1200;

      // constants of the sketch (MiniCasino.ino, GameRuntime.h)
      this.STARTGUTHABEN = r.STARTGUTHABEN;
      this.ANZEIGEDAUER_MS = r.ANZEIGEDAUER_MS;
      this.SCAN_PAUSE_MS = r.SCAN_PAUSE_MS;
      this.FEHLER_PAUSE_MS = r.FEHLER_PAUSE_MS;
      this.SCAN_VERSUCHE = r.SCAN_VERSUCHE;
      this.SITZUNG_MS = r.SITZUNG_MS;
      this.MODUS_MS = r.MODUS_MS;
      this.ENTPRELL_MS = r.ENTPRELL_MS;
      this.ABFRAGE_MS = r.ABFRAGE_MS;
      this.LEBENSZEICHEN_MS = r.LEBENSZEICHEN_MS;
      this.SIM_ENTPRELL_MS = r.SIM_ENTPRELL_MS;
      this.OLED_BEGIN_MS = r.OLED_BEGIN_MS;
      this.TON_MODUS = this.cfg.CASINO_SOUND_MODE;
      this.WAEHRUNG_BREITE = this.cfg.CASINO_EURO ? 1 : 4;
      this.KEYPAD_ZEICHEN = (fw.keypad && fw.keypad.chars) || KEYPAD_ZEICHEN_DEFAULT;
      this.TON_LAUT = TON_LAUT; this.TON_LEISE = TON_LEISE; this.TON_AUS = TON_AUS;
      this.SIM_UIDS = (fw.simUids || []).map(parseUid);

      // hardware
      this.eeprom = new Eeprom(loadEeprom((fw.eeprom && fw.eeprom.bytes) || 1024, this.storageKey, this.persist), () => {
        this.cpuT += EEPROM_WRITE_MS;
        this._eepromDirty = true;
      });
      this.uidListe = new UidRegistry(this.eeprom);
      this.protocol = new MC.AdminProtocol(this);
      this.Serial = { print: v => this._serPrint(v), println: v => this._serPrintln(v) };
      this.cpuT = this.clock.now();
      this.t0 = this.cpuT;
      this.oled.setTimeline({ stamp: us => (this.cpuT += us / 1000), clock: this.clock });
      // OledText.h: OLED_SPALTE0 = (CASINO_OLED_SSD1306 || CASINO_SIM) ? 0 : 2. The real console has
      // an SH1106 (window from column 2); Wokwi, which the SIM build targets, an SSD1306 (from 0).
      this.oled.spalte0 = (this.cfg.CASINO_OLED_SSD1306 || this.cfg.CASINO_SIM) ? 0 : 2;
      if (this.cfg.CASINO_SIM) this.oled.fenster0 = 0;

      // Physical inputs are time-stamped and replayed at their time by the simulated CPU, so a
      // short press is seen exactly as on the Uno even when the page's main thread is busy.
      this._inputs = [];            // { t: clock ms, fn } in time order, not yet seen by the CPU
      this._held = new Set();       // keys down, as far as the CPU has seen
      this._field = null;           // card in the RF field, as far as the CPU has seen
      this._catchUp = 0;
      this._rx = [];                // UART receive buffer (bytes)
      this._rxWaiting = [];         // adminAsync resolvers for queued lines
      this._serLine = '';
      this._serOut = [];            // lines waiting for their transmit time
      this._serTimer = null;
      this._capture = null;
      this._history = [];
      this._gen = 0;
      this._idle = false;
      this._wake = null;
      this._wakeRequested = false;
      this._busy = 0;
      this._setupDone = false;
      this._powered = false;
      this._lastState = '';
      this._eepromDirty = false;
      this._bootWaiters = [];
      this._resetRam();
    }

    // ---------------------------------------------------------------- RAM of the sketch
    _resetRam() {
      // MiniCasino.ino
      this.readerBereit = false;
      this.ergebnisSichtbar = false;
      this.ergebnisSeit = 0;
      this.letzterLog = 0;
      this.letzteAbfrage = 0;
      this.naechsterScanSeit = 0;
      this.scanPause = false;
      this.scanPauseDauer = this.SCAN_PAUSE_MS;
      this.scanNummer = 0;
      this.abfragen = 0;
      this.keineAntwort = 0;
      this.funkfehler = 0;
      this.letzterFunkfehler = 0;
      this.fehlerFolge = 0;
      this.funkHinweisGezeigt = false;
      this.rfid = { size: 0, bytes: [], sak: 0 };
      this.simGedrueckt = 0;
      this.simEntprellt = 0;
      // GameRuntime.h
      this.spielAktiv = false;
      this.spielUid = { size: 0, bytes: [], sak: 0 };
      this.spielSlot = -1;
      this.spielGuthaben = 0;
      this.spielUnbegrenzt = false;
      this.spielEinsatz = this.Rules.STAKE;
      this.sitzungSeit = 0;
      this.modus = MODUS_SPIEL;
      this.modusSeit = 0;
      this.eingabe = 0;
      this.eingabeStellen = 0;
      this.hilfeSeite = 0;
      this.tonStufe = TON_LAUT;
      this.tasteRoh = 0;
      this.tasteStabil = 0;
      this.tasteSeit = 0;
      // AdminSerial.h
      this.protocol.adminZeile = [];
    }

    // ---------------------------------------------------------------- time
    millis() { return Math.floor(this.cpuT - this.t0 + 1e-7); }
    _check(gen) { if (gen !== this._gen) throw ABORT; }
    // Let real time catch up with the CPU (I2C, EEPROM and delay() time already spent).
    // When the CPU is behind (late timers on a busy main thread, a background tab) it runs on
    // without yielding until it is ahead again, so a round never takes longer than on the Uno.
    _sync() {
      const gen = this._gen;
      const wait = this.cpuT - this.clock.now();
      if (wait <= 0) return gen === this._gen ? Promise.resolve() : Promise.reject(ABORT);
      return new Promise((resolve, reject) => {
        this.clock.setTimeout(() => (gen === this._gen ? resolve() : reject(ABORT)), wait);
      });
    }
    // Arduino delay(): the CPU does nothing else.
    async delay(ms) {
      this.cpuT += ms;
      await this._sync();
    }
    _setBusy(d) {
      const before = this._busy > 0;
      this._busy = Math.max(0, this._busy + d);
      if (before !== this._busy > 0) this._emit('sim:busy', this._busy > 0);
    }
    async _blocking(fn) {
      const gen = this._gen;
      this._setBusy(1);
      try { return await fn(); }
      finally { if (gen === this._gen) this._setBusy(-1); }
    }

    // ---------------------------------------------------------------- events, serial
    _emit(name, data) { if (MC.bus) MC.bus.emit(name, data); }
    _serPrint(v) {
      if (v === undefined || v === null) return;
      this._serLine += typeof v === 'boolean' ? (v ? '1' : '0') : String(v);
    }
    _serPrintln(v) {
      this._serPrint(v);
      const text = this._serLine;
      this._serLine = '';
      if (this._capture && text.charAt(0) === '#') this._capture.push(text);
      // 115200 baud: the line leaves the Uno when the CPU gets there
      this._serOut.push({ at: this.cpuT, text });
      this._pumpSerial();
    }
    _pumpSerial() {
      const now = this.clock.now();
      while (this._serOut.length && this._serOut[0].at <= now + 1e-6) {
        const { text } = this._serOut.shift();
        const kind = text.charAt(0) === '#' ? (text.indexOf('#ERR') === 0 ? 'err' : 'reply') : 'log';
        const line = { text, dir: 'rx', kind, ms: this.millis() };
        this._history.push(line);
        if (this._history.length > HISTORY) this._history.shift();
        this._emit('serial:line', line);
        this._emit('sim:led', { led: 'tx' });
      }
      if (this._serOut.length && this._serTimer === null) {
        this._serTimer = this.clock.setTimeout(() => { this._serTimer = null; this._pumpSerial(); },
          Math.max(0, this._serOut[0].at - now));
      }
    }

    // MiniCasino.ino: logKopf, logText, logHex, logBytes, logStatus, logLebenszeichen
    logKopf(thema) {
      if (!this.debugLog) return;
      const S = this.Serial;
      S.print('[');
      S.print(this.millis());
      S.print(' ms] ');
      S.print(thema);
      S.print(' | ');
    }
    logText(thema, text) {
      if (!this.debugLog) return;
      this.logKopf(thema);
      this.Serial.println(text);
    }
    logHex(wert) {
      if (!this.debugLog) return;
      if (wert < 0x10) this.Serial.print('0');
      this.Serial.print(wert.toString(16).toUpperCase());
    }
    logBytes(thema, daten, anzahl) {
      if (!this.debugLog) return;
      this.logKopf(thema);
      for (let i = 0; i < anzahl; ++i) {
        if (i) this.Serial.print(' ');
        this.logHex(daten[i]);
      }
      this.Serial.println();
    }
    logStatus(schritt, status) {
      if (!this.debugLog) return;
      this.logKopf(schritt);
      this.Serial.print('Status=');
      this.Serial.println(status);
    }
    logLebenszeichen() {
      if (!this.debugLog || this.millis() - this.letzterLog < this.LEBENSZEICHEN_MS) return;
      this.letzterLog = this.millis();
      const S = this.Serial;
      this.logKopf('LIVE');
      S.print('ReaderBereit=');
      S.print(this.readerBereit);
      S.print(' Abfragen=');
      S.print(this.abfragen);
      S.print(' REQA-Timeouts=');
      S.print(this.keineAntwort);
      S.print(' Scans=');
      S.print(this.scanNummer);
      S.print(' Erkennungsfehler=');
      S.print(this.funkfehler);
      S.print(' Firmware=0x');
      this.logHex(this.rfidVersion());
      S.println();
    }

    // ---------------------------------------------------------------- display helpers (MiniCasino.ino)
    // Zwei kurze Zeilen ausgeben. Texte passen in 16 Zeichen.
    meldung(oben, unten) {
      const anzeige = this.oled;
      anzeige.setCursor(0, 0);
      anzeige.print(oben);
      for (let i = oben.length; i < 16; ++i) anzeige.print(' ');
      anzeige.setCursor(0, 1);
      anzeige.print(unten);
      for (let i = unten.length; i < 16; ++i) anzeige.print(' ');
      anzeige.hinweis(null);   // Jeder Bildschirm setzt seinen Hinweis selbst.
      if (this.debugLog) {
        this.logKopf('LCD');
        this.Serial.print(oben);
        this.Serial.print(' / ');
        this.Serial.println(unten);
      }
    }
    startAnzeige() {
      this.spielMenue();
      this.ergebnisSichtbar = false;
    }
    async erkennungsfehler() {
      ++this.funkfehler;
      if (this.millis() - this.letzterFunkfehler > 5000) {
        this.fehlerFolge = 0;
        this.funkHinweisGezeigt = false;
      }
      this.letzterFunkfehler = this.millis();
      if (this.fehlerFolge < 249) ++this.fehlerFolge;
      else this.fehlerFolge = 3;
      if (this.fehlerFolge % 3 === 0) {
        this.logText('RF RECOVERY', 'Drei weitere Erkennungsfehler; Antennenfeld kurz neu starten.');
        await this.delay(20);   // rfid.antenne(false)
        await this.delay(20);   // rfid.antenne(true)
      }
      if (this.fehlerFolge >= 3 && !this.funkHinweisGezeigt && !this.ergebnisSichtbar) {
        this.meldung('Karte ruhig', 'auflegen');
        this.funkHinweisGezeigt = true;
        this.ergebnisSeit = this.millis();
        this.ergebnisSichtbar = true;
      }
    }
    // Waehrung anhaengen und die belegten Stellen zurueckgeben.
    lcdWaehrung() {
      if (this.cfg.CASINO_EURO) {
        this.oled.write(0);   // direkt an die Zahl, ohne Leerzeichen: 250<euro>
        return 1;
      }
      this.oled.print(' Pkt');
      return 4;
    }
    zeigeGuthaben(guthaben, neu) {
      this.meldung(neu ? 'Neu aufgeladen!' : 'Guthaben:', '');
      this.oled.setCursor(0, 1);
      this.oled.print(guthaben);
      this.lcdWaehrung();
      if (this.debugLog) {
        this.logKopf('GUTHABEN');
        this.Serial.print(neu ? 'Neu gespeichert und geprueft: ' : 'Vorhanden: ');
        this.Serial.println(guthaben);
      }
    }

    // ---------------------------------------------------------------- GameRuntime.h
    zufallsZahl() { return this.rng() >>> 0; }   // the firmware's xorshift32; here crypto randomness
    farbe(index) { return index === 0 ? 'SCHWARZ' : index === 1 ? 'ROT' : 'GRUEN'; }
    lauflichtZeige(index) {
      const anzeige = this.oled;
      const name = this.farbe(index);
      const laenge = name.length + 4;   // "> NAME <"
      const links = Math.floor((16 - laenge) / 2);
      anzeige.setCursor(0, 1);
      for (let i = 0; i < links; ++i) anzeige.print(' ');
      anzeige.print('> '); anzeige.print(name); anzeige.print(' <');
      for (let i = links + laenge; i < 16; ++i) anzeige.print(' ');
    }
    async lauflicht(choice, result) {
      const R = this.Rules, T = this.fw.tones.tick;
      const start = this.zufallsZahl() % 3;   // nur optischer Start; aendert das Ergebnis nicht
      const count = R.spinSteps(start, result);
      this._emit('sim:spin', { choice, start, steps: count });
      this.meldung('', '');
      this.oled.setCursor(0, 0);
      this.oled.print('Tipp: ');
      this.oled.print(this.farbe(choice));
      for (let step = 0; step < count; ++step) {
        const seit = this.millis();
        const index = R.spinLed(start, step);
        this.lauflichtZeige(index);
        const zeit = R.spinDelay(step, count);
        // genau ein kurzer Tick pro Farbwechsel
        await this.tonSpiele(T.base + index * T.step, T.ms, 'tick');
        const schon = this.millis() - seit;
        if (schon < zeit) await this.delay(zeit - schon);
      }
      // Die letzte Farbe ist bereits das Ergebnis; kein nachtraeglicher Sprung.
    }

    // Keypad: one row low at a time, the first pressed key in scan order wins.
    leseTaste() {
      this._inputsUpTo();
      for (let i = 0; i < 16; i++) {
        const ch = this.KEYPAD_ZEICHEN.charAt(i);
        if (this._held.has(ch)) return ch;
      }
      return 0;
    }
    // Entprellen: eine Taste zaehlt, wenn sie 35 ms ruhig anliegt, und genau einmal pro Druck.
    neueTaste(now) {
      const taste = this.leseTaste();
      if (taste !== this.tasteRoh) { this.tasteRoh = taste; this.tasteSeit = now; return 0; }
      if (now - this.tasteSeit < this.ENTPRELL_MS || taste === this.tasteStabil) return 0;
      this.tasteStabil = taste;
      return taste;   // 0 beim Loslassen
    }
    // Nach blockierenden Ablaeufen: eine noch gehaltene Taste gilt nicht als neuer Druck.
    tastenSperren() {
      this.tasteRoh = this.tasteStabil = this.leseTaste();
      this.tasteSeit = this.millis();
    }

    // Ton von Hand takten. Laut halbe-halbe, leise rund 8 %, bei stumm wird trotzdem gewartet.
    async tonSpiele(hz, dauer, kind) {
      await this._melodie([[hz, dauer, 0]], kind || 'tone');
    }
    // tonSpiele(hz, ms) + delay(gap) for each note, scheduled as one batch so the rhythm is exact.
    async _melodie(notes, kind) {
      const stufe = this.tonStufe;
      const laut = this.TON_MODUS && stufe !== TON_AUS;
      let total = 0;
      const eff = notes.map(([hz, ms, gap]) => {
        let n;
        if (!laut || !hz) n = [0, ms, gap];
        else if (this.TON_MODUS === 2) n = [ACTIVE_BUZZER_HZ, ms, gap];
        else { const t = toneTiming(hz, ms, stufe); n = [t.hz, t.ms, gap]; }
        total += n[1] + n[2];
        return n;
      });
      const long = total >= 100;
      if (long) this._setBusy(1);
      const gen = this._gen;
      try {
        await this._sync();   // the CPU starts toggling D2 now
        const level = this.TON_MODUS === 2 ? TON_LAUT : stufe;
        this._emit('sim:sound', { kind, notes: eff, level: laut ? level : TON_AUS, ms: total });
        if (laut && this.audio && this.audio.play) {
          if (eff.length === 1 && !eff[0][2] && this.audio.tone) this.audio.tone(eff[0][0], eff[0][1], level);
          else this.audio.play(eff, level);
        }
        await this.delay(total);
      } finally {
        if (long && gen === this._gen) this._setBusy(-1);
      }
    }
    tonKlick() { const t = this.fw.tones.klick; return this.tonSpiele(t[0], t[1], 'click'); }
    tonFehler() { const t = this.fw.tones.fehler; return this.tonSpiele(t[0], t[1], 'error'); }
    tonQuittung(hz) {
      const q = this.fw.tones.quittung, notes = [];
      for (let i = 0; i < q.count; ++i) notes.push([hz, q.ms, q.gap]);
      return this._melodie(notes, 'confirm');
    }
    async spieleSound(effect) {
      const S = this.fw.sounds;
      let notes;
      if (effect === 'jackpot') {
        notes = S.jackpot;
        this.logText('SOUND', 'JACKPOT: Fanfare + 8-Bit-Abschluss.');
      } else if (effect === 'win') {
        notes = S.win;
        this.logText('SOUND', 'WIN: Level-up.');
      } else {
        notes = S.loss;
        this.logText('SOUND', 'LOSS: Womp-womp.');
      }
      await this._melodie(notes, effect);
    }

    // --- Anzeige
    stellen(wert) {
      let n = 1;
      while (wert >= 10) { wert = Math.floor(wert / 10); ++n; }
      return n;
    }
    lcdZahl(wert) {
      this.oled.print(wert);
      return this.stellen(wert);
    }
    lcdRest(benutzt) { for (let i = benutzt; i < 16; ++i) this.oled.print(' '); }
    // Eine Zeile "Name        123€": Name links, Betrag rechtsbuendig.
    // vorzeichen: 0 ohne, '+' oder '-' davor, 'i' zeigt "inf" (Adminkarte).
    zeileWert(zeile, name, wert, vorzeichen) {
      const anzeige = this.oled;
      anzeige.setCursor(0, zeile);
      anzeige.print(name);
      const breite = vorzeichen === 'i' ? 3 : (this.stellen(wert) + this.WAEHRUNG_BREITE + (vorzeichen ? 1 : 0)) & 0xFF;
      for (let i = name.length; i < 16 - breite; ++i) anzeige.print(' ');
      if (vorzeichen === 'i') { anzeige.print('inf'); return; }
      if (vorzeichen) anzeige.print(vorzeichen);
      anzeige.print(wert);
      this.lcdWaehrung();
    }
    zeigeGuthabenZeile(zeile, wert) {
      this.zeileWert(zeile, 'Guthaben', wert, this.spielUnbegrenzt ? 'i' : 0);
    }
    spielMenue() {
      this.modus = MODUS_SPIEL;
      if (!this.spielAktiv) {
        this.meldung('Bitte Karte', 'auflegen');
        this.oled.hinweis('D = Hilfe');
        return;
      }
      this.zeigeGuthabenZeile(0, this.spielGuthaben);
      this.zeileWert(1, 'Einsatz', this.spielEinsatz, 0);
      this.oled.hinweis('1-3 setzen  D=?');
      if (this.debugLog) {
        this.logKopf('LCD');
        this.Serial.print('Guthaben ');
        if (this.spielUnbegrenzt) this.Serial.print('inf');
        else this.Serial.print(this.spielGuthaben);
        this.Serial.print(' / Einsatz ');
        this.Serial.println(this.spielEinsatz);
      }
    }
    // Fuer Meldungen, die nach ANZEIGEDAUER_MS von selbst ins Menue zurueckgehen.
    zeigeKurz() {
      this.ergebnisSeit = this.naechsterScanSeit = this.millis();
      this.ergebnisSichtbar = this.scanPause = true;
    }
    // Fuer Bildschirme mit eigener Eingabe: nicht vom Ergebnis-Timer ueberschreiben.
    betreteModus(neuerModus) {
      this.modus = neuerModus;
      this.modusSeit = this.millis();
      this.ergebnisSichtbar = false;
    }

    // Karte wurde erkannt: ab hier reichen die Tasten, die Karte darf weg.
    starteSitzung(uid, slot, guthaben) {
      const R = this.Rules, L = this.uidListe;
      this.spielUid = uid; this.spielSlot = slot; this.spielGuthaben = guthaben; this.spielAktiv = true;
      this.spielUnbegrenzt = L.unlimited(slot);
      const einheiten = L.stakeUnits(slot);
      this.spielEinsatz = einheiten ? einheiten * R.STAKE_SCHRITT : R.STAKE;
      // Reicht das Guthaben nicht mehr fuer den gemerkten Einsatz, herunterziehen.
      const grenze = R.stakeLimit(this.spielUnbegrenzt ? R.STAKE_MAX : guthaben);
      if (this.spielEinsatz > grenze) {
        this.spielEinsatz = grenze;
        this.logText('EINSATZ', 'Gemerkter Einsatz ueber dem Guthaben; auf das Maximum gesetzt.');
      }
      this.sitzungSeit = this.millis();
      this.tastenSperren();
      this.spielMenue();
    }
    // Nach SITZUNG_MS ohne Tastendruck oder mit B.
    beendeSitzung(manuell) {
      this.spielAktiv = false; this.spielSlot = -1; this.spielUnbegrenzt = false;
      this.logText('SITZUNG', manuell ? 'Von Hand abgemeldet.'
        : 'Zeit abgelaufen. Zum Weiterspielen Karte erneut kurz auflegen.');
      if (manuell) {
        this.meldung('Abgemeldet', 'Bis bald!');
        this.modus = MODUS_SPIEL;
      } else {
        this.spielMenue();
      }
    }

    zeigeNetto(zeile, win, netto) {
      this.zeileWert(zeile, win ? 'Gewinn' : 'Verlust', netto, win ? '+' : '-');
    }
    async zeigeAufloesung(choice, result, einsatz, auszahlung, balance) {
      const win = choice === result;
      const netto = win ? u32(auszahlung - einsatz) : einsatz;
      const effect = this.Rules.effectForChoice(win, choice);
      if (this.debugLog) {
        const S = this.Serial;
        this.logKopf('SPIEL'); S.print('Wahl='); S.print(this.farbe(choice));
        S.print(' Ergebnis='); S.print(this.farbe(result));
        S.print(' Einsatz='); S.print(einsatz);
        S.print(' Auszahlung='); S.print(auszahlung);
        S.print(' Guthaben='); S.println(balance);
      }
      await this.lauflicht(choice, result);
      const anzeige = this.oled;
      anzeige.setCursor(0, 0);
      if (effect === 'jackpot') { anzeige.print('JACKPOT! GRUEN'); this.lcdRest(14); }
      else { anzeige.print(this.farbe(result)); this.lcdRest(this.farbe(result).length); }
      this.zeigeNetto(1, win, netto);
      this._emit('sim:result', {
        choice, result, win, net: win ? netto : -netto, jackpot: effect === 'jackpot', effect,
        stake: einsatz, payout: auszahlung, balance, unlimited: this.spielUnbegrenzt,
        choiceName: this.farbe(choice), resultName: this.farbe(result)
      });
      await this.spieleSound(effect);   // dauert in jeder Tonstufe gleich lang
      this.zeigeNetto(0, win, netto);
      this.zeigeGuthabenZeile(1, balance);
      anzeige.hinweis('1-3 nochmal');
    }
    // Eine vollstaendige Runde: Einsatz, Ziehung und Endstand in einer einzigen EEPROM-Buchung.
    async spiele(choice) {
      const R = this.Rules, L = this.uidListe;
      this.sitzungSeit = this.millis();
      const balance = L.balance(this.spielSlot);
      this.spielGuthaben = balance;
      if (!L.funded(this.spielSlot)) {
        this.spielAktiv = false;
        this.logText('SPIEL', 'Konto nicht mehr lesbar. Kein Einsatz.');
        this.meldung('Konto unklar', 'Karte auflegen');
        return;
      }
      // Adminkarten pruefen nur den Einsatz selbst, nie das Guthaben.
      if (!R.canPlay(this.spielUnbegrenzt ? R.STAKE_MAX * 10 : balance, choice, this.spielEinsatz)) {
        await this.tonFehler();
        this.meldung(balance < this.spielEinsatz ? 'Guthaben fehlt' : 'Einsatz zu hoch', 'Mit A aendern');
        this.oled.hinweis('A = Einsatz');
        return;
      }
      const result = R.colourForTicket(this.zufallsZahl() % 100);
      let neu = R.settled(u32(balance - this.spielEinsatz), choice, result, this.spielEinsatz);
      // Adminkarte: Ergebnis zeigen, aber nichts buchen.
      if (!this.spielUnbegrenzt) {
        this.meldung('Buche Runde...', '');
        if (!L.setBalance(this.spielSlot, neu)) {
          this.logText('SPIEL', 'EEPROM-Buchung nicht bestaetigt. Runde gilt nicht, Stand unveraendert.');
          this.meldung('Nicht gebucht', 'Kein Einsatz');
          return;
        }
      } else {
        neu = balance;
      }
      this.spielGuthaben = neu;
      await this.zeigeAufloesung(choice, result, this.spielEinsatz, R.payout(choice, result, this.spielEinsatz), neu);
    }

    // --- A: Einsatz direkt eintippen
    einsatzGrenze() {
      const R = this.Rules;
      if (this.spielUnbegrenzt) return R.STAKE_MAX;   // Adminkarte kennt kein Limit.
      return R.stakeLimit(this.spielAktiv ? this.uidListe.balance(this.spielSlot) : R.STAKE);
    }
    // Oben Titel oder Fehlermeldung, unten die Eingabe mit Cursor und rechts die Obergrenze.
    einsatzAnzeigen(titel) {
      const anzeige = this.oled;
      anzeige.setCursor(0, 0);
      anzeige.print(titel);
      this.lcdRest(titel.length);
      anzeige.setCursor(0, 1);
      const n = this.eingabeStellen ? this.lcdZahl(this.eingabe) : 0;
      anzeige.print('_');
      const grenze = this.einsatzGrenze();
      const rechts = 4 + this.stellen(grenze);
      for (let i = n + 1; i < 16 - rechts; ++i) anzeige.print(' ');
      anzeige.print('max ');
      anzeige.print(grenze);
      anzeige.hinweis(this.eingabeStellen ? '#=OK  *=Loeschen' : 'Zahl  *=zurueck');
    }
    einsatzStarten() {
      this.eingabe = 0;
      this.eingabeStellen = 0;
      this.betreteModus(MODUS_EINSATZ);
      this.einsatzAnzeigen('Neuer Einsatz:');
    }
    async einsatzUebernehmen() {
      this.spielEinsatz = this.eingabe;
      const einheiten = Math.floor(this.spielEinsatz / this.Rules.STAKE_SCHRITT) & 0xFF;
      const gemerkt = this.uidListe.setStakeUnits(this.spielSlot, einheiten);
      if (this.debugLog) {
        this.logKopf('EINSATZ');
        this.Serial.print(this.spielEinsatz);
        this.Serial.println(gemerkt ? ' Punkte, beim Konto gespeichert.' : ' Punkte, nur fuer diese Sitzung.');
      }
      this.sitzungSeit = this.millis();
      this.spielMenue();
      await this.tonQuittung(this.fw.tones.quittung.einsatz);
      this.tastenSperren();
    }
    async einsatzTaste(taste) {
      if (taste >= '0' && taste <= '9') {
        // Vier Stellen reichen fuer jeden Einsatz; fuehrende Nullen zaehlen nicht.
        if (this.eingabeStellen < 4 && (this.eingabeStellen || taste !== '0')) {
          this.eingabe = (this.eingabe * 10 + (taste.charCodeAt(0) - 48)) & 0xFFFF;
          ++this.eingabeStellen;
        }
        await this.tonKlick();
        this.einsatzAnzeigen('Neuer Einsatz:');
        return;
      }
      if (taste === '*') {
        if (!this.eingabeStellen) { await this.tonKlick(); this.spielMenue(); return; }   // leer: abbrechen
        this.eingabe = Math.floor(this.eingabe / 10);
        --this.eingabeStellen;
        await this.tonKlick();
        this.einsatzAnzeigen('Neuer Einsatz:');
        return;
      }
      if (taste === '#') {
        const fehler = this.Rules.checkStake(this.eingabe, this.einsatzGrenze());
        if (!fehler) { await this.einsatzUebernehmen(); return; }
        await this.tonFehler();
        this.einsatzAnzeigen(fehler === 1 ? 'Mindestens 10' : fehler === 2 ? 'Nur 10er-Schritt' : 'Zu hoch!');
        return;
      }
      await this.tonFehler();   // A-D sind hier ohne Bedeutung.
    }

    // --- B: abmelden, C: Ton, D: Hilfe
    abmeldenFragen() {
      this.betreteModus(MODUS_ABMELDEN);
      this.meldung('Wirklich', 'abmelden?');
      this.oled.hinweis('#=Ja    *=Nein');
    }
    async abmeldenTaste(taste) {
      if (taste === '#') { await this.tonQuittung(this.fw.tones.quittung.abmelden); this.beendeSitzung(true); this.zeigeKurz(); return; }
      if (taste === '*') { await this.tonKlick(); this.spielMenue(); return; }
      await this.tonFehler();
    }
    naechsteStufe() {
      if (this.TON_MODUS === 2) return this.tonStufe === TON_LAUT ? TON_AUS : TON_LAUT;
      return this.tonStufe === TON_LAUT ? TON_LEISE : this.tonStufe === TON_LEISE ? TON_AUS : TON_LAUT;
    }
    stufenName(stufe) { return stufe === TON_LAUT ? 'Ton laut' : stufe === TON_LEISE ? 'Ton leise' : 'Ton aus'; }
    // Bit 0 = aus, Bit 1 = leise.
    async tonStufeWeiter() {
      this.tonStufe = this.naechsteStufe();
      let opt = this.uidListe.options() & ~3 & 0xFF;
      if (this.tonStufe === TON_AUS) opt |= 1;
      else if (this.tonStufe === TON_LEISE) opt |= 2;
      const gemerkt = this.uidListe.setOptions(opt);
      if (this.debugLog) {
        this.logKopf('TON');
        this.Serial.print(this.stufenName(this.tonStufe));
        this.Serial.println(gemerkt ? ' | im EEPROM gespeichert.' : ' | nur bis zum Reset.');
      }
      this.meldung(this.stufenName(this.tonStufe), gemerkt ? 'gespeichert' : 'nur bis Reset');
      this.oled.hinweis('C = weiter');
      const q = this.fw.tones.quittung;
      await this.tonQuittung(this.tonStufe === TON_AUS ? q.tonAus : q.tonAn);   // in Stufe aus bleibt es still
    }
    // Drei Seiten, D blaettert weiter, nach der letzten geht es zurueck ins Menue.
    hilfeZeigen(seite) {
      if (seite > 2) { this.spielMenue(); return; }
      this.hilfeSeite = seite;
      this.betreteModus(MODUS_HILFE);
      if (seite === 0) this.meldung('1 Schwarz  2 Rot', '3 Gruen');
      else if (seite === 1) this.meldung('A Einsatz', 'B Abmelden');
      else this.meldung('C Ton  D Hilfe', 'Gruen zahlt 9x');
      this.oled.hinweis('D=weiter  *=Ende');
    }
    // Tastendruck im normalen Spielbildschirm.
    async spielTaste(taste) {
      if (taste === 'D') { await this.tonKlick(); this.hilfeZeigen(0); return; }
      if (taste === 'C') {
        if (!this.TON_MODUS) { this.meldung('Kein Buzzer', 'eingebaut'); this.zeigeKurz(); return; }
        await this.tonStufeWeiter();
        this.tastenSperren();
        this.zeigeKurz();
        return;
      }
      const funktion = (taste >= '1' && taste <= '3') || taste === 'A' || taste === 'B';
      if (!funktion) { await this.tonFehler(); this.oled.hinweis('Tasten: 1-3 A-D'); return; }
      if (!this.spielAktiv) {
        await this.tonFehler();
        this.meldung('Zuerst Karte', 'auflegen');
        this.oled.hinweis('D = Hilfe');
        this.zeigeKurz();
        return;
      }
      if (taste === 'A') { await this.tonKlick(); this.einsatzStarten(); return; }
      if (taste === 'B') { await this.tonKlick(); this.abmeldenFragen(); return; }
      await this._blocking(() => this.spiele(taste.charCodeAt(0) - 49));
      this.tastenSperren();
      this.zeigeKurz();
    }
    // true, wenn eine Taste verarbeitet wurde und der RFID-Scan ausfallen soll.
    async tastenService(now) {
      // Eingabe, Rueckfrage oder Hilfe ohne Tastendruck: zurueck ins Menue.
      if (this.modus !== MODUS_SPIEL && now - this.modusSeit >= this.MODUS_MS) this.spielMenue();
      const taste = this.neueTaste(now);
      if (!taste) return false;
      this.sitzungSeit = now;
      this.modusSeit = now;
      this._emit('sim:key', { key: taste, mode: MODE_NAMES[this.modus] });
      if (this.modus === MODUS_EINSATZ) await this.einsatzTaste(taste);
      else if (this.modus === MODUS_ABMELDEN) await this.abmeldenTaste(taste);
      else if (this.modus === MODUS_HILFE && taste === 'D') { await this.tonKlick(); this.hilfeZeigen(this.hilfeSeite + 1); }
      else if (this.modus === MODUS_HILFE && taste === '*') { await this.tonKlick(); this.spielMenue(); }
      else { this.modus = MODUS_SPIEL; await this.spielTaste(taste); }   // in der Hilfe wirkt jede andere Taste direkt
      return true;
    }
    spielSetup() {
      // keypad rows INPUT/LOW, columns INPUT_PULLUP, D2 output LOW
      this.tastenSperren();
    }

    // ---------------------------------------------------------------- RC522 (Rc522.h, as seen from the sketch)
    async rfidBegin() {
      await this.delay(2);    // RST low
      await this.delay(50);   // Oszillator anlaufen lassen
      this._emit('sim:led', { led: 'l', ms: 52 });   // D13 is SCK: the L LED flickers with SPI
    }
    rfidVersion() { return this.readerOk ? this.readerVersion & 0xFF : 0x00; }
    _wecken() {
      this._inputsUpTo();
      if (!this.readerOk || !this._field) return RC_TIMEOUT;
      this.cpuT += RF_WUPA_MS;
      if (this.rfErrorRate && this.rng() / 4294967296 < this.rfErrorRate) return RC_FEHLER;
      return RC_OK;
    }
    _auswaehlen() {
      this._inputsUpTo();
      const f = this._field;
      if (!f) return RC_TIMEOUT;
      this.cpuT += RF_SELECT_MS * (f.size === 4 ? 1 : f.size === 7 ? 2 : 3);
      this.rfid = { size: f.size, bytes: f.bytes.slice(), sak: f.size === 4 ? 0x08 : 0x00 };
      return RC_OK;
    }
    _anhalten() { this.cpuT += RF_HALT_MS; }

    // ---------------------------------------------------------------- MiniCasino.ino: card handling
    legeKarteAuf(uid, laenge) {
      this.rfid = { size: laenge, bytes: Array.from(uid).slice(0, laenge), sak: laenge === 4 ? 0x08 : 0x00 };
      this.logBytes('UID', this.rfid.bytes, this.rfid.size);
      this.bearbeiteKarte();
    }
    bearbeiteKarte() {
      const erwartet = { size: this.rfid.size, bytes: this.rfid.bytes.slice(), sak: this.rfid.sak };
      const L = this.uidListe;
      if (this.debugLog) {
        this.logKopf('TYPE');
        this.Serial.print('SAK=0x');
        this.logHex(this.rfid.sak);
        this.Serial.println();
      }
      const scan = r => this._emit('sim:scan', { uid: uidHex(erwartet.bytes), result: r, slot });
      let slot = L.find(erwartet.bytes, erwartet.size);
      if (slot === -2) {
        this.logText('UID-LISTE', 'EEPROM ungueltig/nicht bereit. Kein Konto nutzbar.');
        this.meldung('UID-Liste Fehler', 'Siehe Log');
        scan('error');
        return;
      }
      // Gesperrte Karte: gar nichts tun, auch keine Sitzung starten.
      if (slot >= 0 && L.banned(slot)) {
        this.logText('KONTO', 'Karte ist gesperrt. Keine Sitzung, kein Zugriff aufs Guthaben.');
        this.meldung('Karte gesperrt', 'Siehe Admin');
        scan('banned');
        return;
      }
      let neuesKonto = false;
      if (slot === -1) {
        // Reservierung muss lesbar sein, BEVOR ein Startguthaben gilt.
        slot = L.reserve(erwartet.bytes, erwartet.size);
        if (slot < 0) {
          this.logText('UID-LISTE', 'Keine Reservierung moeglich; Liste voll oder ungueltig.');
          this.meldung(slot === -3 ? 'UID-Liste voll' : 'UID-Liste Fehler', 'Nicht aufgeladen');
          scan(slot === -3 ? 'full' : 'error');
          return;
        }
        if (!L.confirm(slot)) {
          this.logText('UID-LISTE', 'Eintrag nicht bestaetigt. Karte erneut auflegen.');
          this.meldung('Aufladung offen', 'Siehe Log');
          scan('error');
          return;
        }
        neuesKonto = true;
        this.logText('UID-LISTE', 'Neue UID dauerhaft registriert.');
      }
      if (!L.funded(slot)) {
        if (!L.setBalance(slot, this.STARTGUTHABEN)) {
          this.logText('KONTO', 'Erstgutschrift nicht bestaetigt. Karte erneut auflegen.');
          this.meldung('Aufladung offen', 'Siehe Log');
          scan('error');
          return;
        }
        this.logText('KONTO', neuesKonto ? 'Einmaliges Startguthaben gutgeschrieben.'
          : 'Offene Erstgutschrift nachgeholt.');
        neuesKonto = true;
      }
      const guthaben = L.balance(slot);
      if (!neuesKonto) this.logText('KONTO', 'Bekannte UID; Guthaben aus dem EEPROM geladen.');
      this.zeigeGuthaben(guthaben, neuesKonto);
      this.starteSitzung(erwartet, slot, guthaben);
      scan(neuesKonto ? 'new' : 'known');
    }

    // CASINO_SIM: four push buttons on D9-D12 stand for the four cards.
    simSetup() { /* INPUT_PULLUP on D9..D12 */ }
    _simMaske() {
      this._inputsUpTo();
      let maske = 0;
      for (let i = 0; i < 4; ++i) {
        const c = this.SIM_UIDS[i];
        if (c && this._field && this._field.uid === c.uid) maske |= 1 << i;
      }
      return maske;
    }
    simService() {
      const maske = this._simMaske();
      if (maske === this.simGedrueckt) return false;
      if (this.millis() - this.simEntprellt < this.SIM_ENTPRELL_MS) return false;
      this.simEntprellt = this.millis();
      const neu = maske & ~this.simGedrueckt;
      this.simGedrueckt = maske;
      for (let i = 0; i < 4; ++i) {
        if (!(neu & (1 << i))) continue;
        this.legeKarteAuf(this.SIM_UIDS[i].bytes, this.SIM_UIDS[i].size);
        this.ergebnisSeit = this.millis();
        this.ergebnisSichtbar = true;
        return true;   // immer nur eine Karte gleichzeitig
      }
      return true;
    }

    // ---------------------------------------------------------------- setup() and loop()
    async setup() {
      const cfg = this.cfg, L = this.uidListe;
      // Serial.begin(LOG_BAUD): immer, darueber laeuft auch das Verwaltungsprotokoll.
      if (this.debugLog) {
        this.Serial.println();
        this.logText('BOOT', 'Mini Casino v11 | 115200 Baud | OLED I2C A4/A5');
        this.logText('MODUS', 'Konten im EEPROM. Karte nur als Ausweis, Spiel ueber Tasten.');
        this.logText('BOOT', 'Wiederholtes BOOT im laufenden Betrieb: Reset/Versorgung pruefen.');
      }
      this.spielSetup();
      await this.delay(this.OLED_BEGIN_MS);   // OledText::begin(): Display hochkommen lassen
      this.oled.begin();
      if (cfg.CASINO_EEPROM_LOESCHEN) {
        L.wipe();
        this.logText('EEPROM', 'GELOESCHT: alle UIDs UND alle Guthaben verworfen.');
        this.logText('EEPROM', 'Sofort CASINO_EEPROM_LOESCHEN auf 0 setzen und neu hochladen.');
      }
      const listeBereit = L.begin();
      this.logText('UID-LISTE', listeBereit ? 'Bereit: Uno fuehrt bis zu 31 Konten dauerhaft.'
        : 'EEPROM unbekannt/fremd. Konten gesperrt; siehe CASINO_EEPROM_LOESCHEN.');
      if (cfg.CASINO_NACHLADEN && listeBereit) {
        let aufgefuellt = 0;
        for (let slot = 0; slot < L.capacity(); ++slot) {
          if (L.funded(slot) && L.balance(slot) < this.STARTGUTHABEN && L.setBalance(slot, this.STARTGUTHABEN)) ++aufgefuellt;
        }
        if (this.debugLog) {
          this.logKopf('NACHLADEN');
          this.Serial.print('Konten auf Startguthaben angehoben: ');
          this.Serial.println(aufgefuellt);
        }
        this.logText('NACHLADEN', 'Danach CASINO_NACHLADEN auf 0 setzen und neu hochladen.');
      }
      const tonOpt = listeBereit ? L.options() : 0;
      this.tonStufe = (tonOpt & 1) ? TON_AUS : ((tonOpt & 2) ? TON_LEISE : TON_LAUT);
      if (this.TON_MODUS && this.debugLog) {
        this.logKopf('TON');
        this.Serial.print(this.stufenName(this.tonStufe));
        this.Serial.println(' | Taste C schaltet weiter: laut, leise, aus.');
      }
      if (cfg.CASINO_SIM) {
        this.simSetup();
        this.readerBereit = true;
        this.logText('SIM', 'Ohne RC522. Taster D9-D12 stehen fuer vier Karten.');
        this.meldung('Mini Casino v11', 'Karte auflegen');
        this.startAnzeige();
        return;
      }
      this.meldung('Mini Casino', 'Starte Reader...');
      await this.rfidBegin();   // mit voller Empfangsverstaerkung fuer die Clone-Antennen
      if (this.bootHoldMs) await this.delay(this.bootHoldMs);   // viewer option, not in the firmware
      const version = this.rfidVersion();
      if (this.debugLog) {
        this.logKopf('RFID');
        this.Serial.print('Firmware=0x');
        this.logHex(version);
        this.Serial.println();
      }
      if (version === 0x00 || version === 0xFF) {
        this.meldung('RFID fehlt', 'Kabel pruefen');
        return;
      }
      this.readerBereit = true;   // auch der Clone mit Version 0x88 wird akzeptiert
      this.startAnzeige();
    }

    // Polls that happened while nothing was in the field (only counted, for the LIVE line).
    _idlePolls() {
      if (!this.letzteAbfrage) return;
      const missed = Math.floor((this.millis() - this.letzteAbfrage) / this.ABFRAGE_MS) - 1;
      if (missed > 0) { this.abfragen += missed; this.keineAntwort += missed; }
    }

    async loop() {
      this._inputsUpTo();
      this.oled.hinweisAktualisieren();
      let active = this.adminService() > 0;   // Verwaltungsbefehle haben nie Vorrang vor dem Spiel.
      const jetzt = this.millis();
      if (await this.tastenService(jetzt)) return true;
      this.logLebenszeichen();
      if (this.spielAktiv && this.millis() - this.sitzungSeit >= this.SITZUNG_MS) { this.beendeSitzung(false); active = true; }
      if (!this.readerBereit) return active;
      if (this.ergebnisSichtbar && this.millis() - this.ergebnisSeit >= this.ANZEIGEDAUER_MS) { this.startAnzeige(); active = true; }
      if (this.cfg.CASINO_SIM) return this.simService() || active;   // kein Funk: die Karten kommen von den Tastern
      if (this.scanPause && this.millis() - this.naechsterScanSeit < this.scanPauseDauer) return active;
      this.scanPause = false;
      if (this.millis() - this.letzteAbfrage < this.ABFRAGE_MS) return active;
      this._idlePolls();
      this.letzteAbfrage = this.millis();

      // Mehrere schnelle Versuche pro Durchlauf; WUPA weckt auch eine angehaltene Karte.
      let status = RC_TIMEOUT, auswahl = RC_FEHLER;
      for (let versuch = 0; versuch < this.SCAN_VERSUCHE; ++versuch) {
        status = this._wecken();
        ++this.abfragen;
        if (status === RC_OK || status === RC_KOLLISION) {
          auswahl = this._auswaehlen();   // sofort, vor allen Logs zur Anfrage
          if (auswahl === RC_OK) break;
        }
        if (status === RC_TIMEOUT) break;   // gar keine Antwort heisst: da liegt nichts
        await this.delay(8);
      }
      if (status === RC_TIMEOUT) {
        ++this.keineAntwort;   // keine Karte im Feld: normal, keine Pause
        return active;
      }
      this._emit('sim:led', { led: 'l', ms: 30 });
      // Nach einem Fehler nur kurz warten, nach einer gelesenen Karte laenger.
      this.scanPause = true;
      this.scanPauseDauer = auswahl === RC_OK ? this.SCAN_PAUSE_MS : this.FEHLER_PAUSE_MS;
      this.naechsterScanSeit = this.millis();
      ++this.scanNummer;
      if (this.debugLog) {
        this.logKopf('SCAN');
        this.Serial.println(this.scanNummer);
      }
      this.logStatus('WUPA', status);
      if (status !== RC_OK && status !== RC_KOLLISION) { await this.erkennungsfehler(); return true; }
      this.logStatus('SELECT UID', auswahl);
      if (auswahl !== RC_OK) { await this.erkennungsfehler(); return true; }
      this.logBytes('UID', this.rfid.bytes, this.rfid.size);
      this.fehlerFolge = 0;
      this.funkHinweisGezeigt = false;
      // Liegt die Karte der laufenden Sitzung noch auf, nur die Sitzung frisch halten.
      const neueKarte = !(this.spielAktiv && this.rfid.size === this.spielUid.size
        && this.rfid.bytes.every((b, i) => b === this.spielUid.bytes[i]));
      if (neueKarte) this.bearbeiteKarte();
      else { this.sitzungSeit = this.millis(); this._emit('sim:scan', { uid: uidHex(this.rfid.bytes), result: 'refresh', slot: this.spielSlot }); }
      this._anhalten();   // auf jedem Verarbeitungspfad aufraeumen
      this.logText('ENDE', 'Karte kann weg. Gespielt wird ueber die Tasten.');
      this.naechsterScanSeit = this.millis();
      this.scanPauseDauer = this.SCAN_PAUSE_MS;
      // Nur eine neu verarbeitete Karte zeigt ein Ergebnis an.
      if (neueKarte) {
        this.ergebnisSeit = this.millis();
        this.ergebnisSichtbar = true;
      }
      return true;
    }

    // AdminSerial.h adminService(): every complete line in the receive buffer.
    adminService() {
      if (!this._rx.length) return 0;
      const bytes = this._rx;
      this._rx = [];
      this._emit('sim:led', { led: 'rx' });
      this._capture = [];
      const n = this.protocol.service(bytes, () => {
        const replies = this._capture;
        this._capture = [];
        const w = this._rxWaiting.shift();
        if (w) w(replies);
      });
      this._capture = null;
      if (!this.protocol.adminZeile.length) this._flushWaiting();   // bytes lost in a full buffer
      return n || 1;
    }
    _flushWaiting() {
      const waiting = this._rxWaiting;
      this._rxWaiting = [];
      waiting.forEach(w => w([]));
    }

    // ---------------------------------------------------------------- the CPU
    async _main(gen) {
      try {
        await this.setup();
        this._check(gen);
        this._setupDone = true;
        this._emit('sim:boot', { ok: this.readerBereit });
        const waiters = this._bootWaiters;
        this._bootWaiters = [];
        waiters.forEach(w => w(this.state()));
        for (;;) {
          this._check(gen);
          const active = await this.loop();
          this._check(gen);
          this._persist();
          if (active) { await this._sync(); continue; }
          await this._idleWait(this._nextDeadline(), gen);
        }
      } catch (e) {
        if (e !== ABORT) throw e;
      }
    }
    _nextDeadline() {
      const m = this.millis();
      if (this.leseTaste() !== this.tasteRoh || this._rx.length || this.oled.hinweisSoll !== this.oled.hinweisIst) return m;
      let t = Infinity;
      const at = v => { if (v < t) t = v; };
      if (this.tasteRoh !== this.tasteStabil) at(this.tasteSeit + this.ENTPRELL_MS);
      if (this.modus !== MODUS_SPIEL) at(this.modusSeit + this.MODUS_MS);
      if (this.spielAktiv) {
        at(this.sitzungSeit + this.SITZUNG_MS);
        at(m + 1000 - ((m - this.sitzungSeit) % 1000));   // let 'sim:state' count the seconds down
      }
      if (this.debugLog) at(this.letzterLog + this.LEBENSZEICHEN_MS);
      if (this.readerBereit) {
        if (this.ergebnisSichtbar) at(this.ergebnisSeit + this.ANZEIGEDAUER_MS);
        if (this.cfg.CASINO_SIM) {
          if (this._simMaske() !== this.simGedrueckt) at(this.simEntprellt + this.SIM_ENTPRELL_MS);
        } else if (this._field) {
          let p = this.letzteAbfrage + this.ABFRAGE_MS;
          if (this.scanPause) p = Math.max(p, this.naechsterScanSeit + this.scanPauseDauer);
          at(p);
        }
      }
      return Math.max(t, m);
    }
    // Sleep until the next deadline or the next input. The CPU resumes at that moment, even when
    // the page wakes it late; if that moment has already passed it goes on at once (catching up).
    _idleWait(nextMillis, gen) {
      return new Promise((resolve, reject) => {
        let timer = null, done = false;
        const wakeAt = () => Math.min(nextMillis === Infinity ? Infinity : this.t0 + nextMillis,
          this._inputs.length ? this._inputs[0].t : Infinity);
        const finish = () => {
          if (done) return;
          done = true;
          if (timer !== null) this.clock.clearTimeout(timer);
          this._wake = null;
          this._idle = false;
          this.cpuT = Math.max(this.cpuT, Math.min(wakeAt(), this.clock.now()));
          if (gen === this._gen) resolve(); else reject(ABORT);
        };
        this._wake = finish;
        this._idle = true;
        this._emitState();   // safe point: listeners may call admin(), pressKey() ...
        if (done) return;
        if (this._wakeRequested) { this._wakeRequested = false; timer = this.clock.setTimeout(finish, 0); return; }
        const at = wakeAt();
        if (at === Infinity) return;
        const wait = at - this.clock.now();
        if (wait <= 0 && this._catchUp++ < 1000) { finish(); return; }
        this._catchUp = 0;
        timer = this.clock.setTimeout(finish, Math.max(0, wait));
      });
    }
    _input(t, fn) {
      let i = this._inputs.length;
      while (i > 0 && this._inputs[i - 1].t > t) i--;
      this._inputs.splice(i, 0, { t, fn });
      this._wakeUp();
    }
    _inputsUpTo() {
      const limit = this.cpuT + 1e-6;
      while (this._inputs.length && this._inputs[0].t <= limit) this._inputs.shift().fn();
    }
    _setField(card) {
      if (this._field === card) return;
      const was = this._field;
      this._field = card;
      if (was && (!card || card.uid !== was.uid)) this._emit('sim:card', { uid: was.uid, present: false });
      if (card && (!was || card.uid !== was.uid)) this._emit('sim:card', { uid: card.uid, present: true });
    }
    _wakeUp() {
      if (this._wake) {
        const w = this._wake;
        this.clock.setTimeout(() => { if (this._wake === w) w(); }, 0);
      } else {
        this._wakeRequested = true;
      }
    }
    _persist() {
      if (!this._eepromDirty) return;
      this._eepromDirty = false;
      if (!this.persist || !MC.storage) return;
      let hex = '';
      const mem = this.eeprom.mem;
      for (let i = 0; i < mem.length; i++) hex += (mem[i] < 16 ? '0' : '') + mem[i].toString(16);
      MC.storage.set(this.storageKey, hex);
    }
    _emitState() {
      if (this.audio && this.audio.setLevel && this.audio.level !== this.tonStufe) this.audio.setLevel(this.tonStufe);
      const s = this.state();
      const key = JSON.stringify(Object.assign({}, s, { millis: 0 }));
      if (key === this._lastState) return;
      this._lastState = key;
      this._emit('sim:state', s);
    }
    _stopCpu() {
      this._gen++;
      this._idle = false;
      this._wake = null;
      this._setupDone = false;
      if (this._busy) { this._busy = 0; this._emit('sim:busy', false); }
      if (this.audio && this.audio.stop) { try { this.audio.stop(); } catch (e) { /* ignore */ } }
      this._flushWaiting();
      this._rx = [];
      this._serOut = [];          // bytes still in the UART are lost with the reset
      this._serLine = '';
      if (this._serTimer !== null) { this.clock.clearTimeout(this._serTimer); this._serTimer = null; }
    }
    // Start the sketch after delayMs (Optiboot); millis() counts from the start of setup().
    _start(delayMs) {
      const gen = this._gen;
      this.t0 = this.clock.now() + (delayMs || 0);
      this.cpuT = this.t0;
      this._resetRam();
      const done = new Promise(resolve => this._bootWaiters.push(resolve));
      this._main(gen).catch(err => {
        this._emit('sim:error', err);
        if (typeof console !== 'undefined') console.error('[MC.Sim]', err);
      });
      return done;
    }

    // ================================================================ public API
    // Power on (cold start): the OLED shows nothing until its init, then random RAM is cleared.
    boot() {
      this._stopCpu();
      this._powered = true;
      this.oled.powerOn(true);
      return this._start(0);
    }
    // Reset button: RAM is lost, the EEPROM stays, the OLED keeps its picture through Optiboot.
    reboot() {
      if (!this._powered) return this.boot();
      this._stopCpu();
      this.oled.cancelPending();
      this._emit('sim:led', { led: 'l', ms: OPTIBOOT_MS, pattern: 'bootloader' });
      return this._start(OPTIBOOT_MS);
    }
    // Factory state: erased EEPROM (0xFF), storage cleared, then a cold boot.
    reset() {
      this._stopCpu();
      this.eeprom.mem.fill(0xFF);
      this._eepromDirty = true;
      this._persist();
      return this.boot();
    }
    powerOff() {
      this._stopCpu();
      this._powered = false;
      this.oled.powerOff();
      this._emitState();
    }
    destroy() {
      this._stopCpu();
      this._inputs = [];
    }

    // Keys: '0'-'9', 'A'-'D', '*', '#'. keyDown/keyUp follow a finger (pointer down/up);
    // pressKey is a whole press of holdMs (default 100 ms).
    _key(ch) {
      ch = String(ch || '').toUpperCase();
      return ch.length === 1 && this.KEYPAD_ZEICHEN.indexOf(ch) >= 0 ? ch : null;
    }
    keyDown(ch) {
      const key = this._key(ch);
      if (!key) return false;
      this._input(this.clock.now(), () => this._held.add(key));
      return true;
    }
    keyUp(ch) {
      const key = this._key(ch);
      if (!key) return false;
      this._input(this.clock.now(), () => this._held.delete(key));
      return true;
    }
    pressKey(ch, holdMs) {
      const key = this._key(ch);
      if (!key) return false;
      const now = this.clock.now();
      this._input(now, () => this._held.add(key));
      this._input(now + (holdMs === undefined ? this.keyHoldMs : holdMs), () => this._held.delete(key));
      return true;
    }
    // Cards: tapCard holds the card in the field for holdMs (default 1.2 s), placeCard leaves it
    // there until removeCard(). A tap only removes its own card.
    tapCard(uid, holdMs) {
      const card = parseUid(uid);
      if (!card) return false;
      const now = this.clock.now();
      this._input(now, () => this._setField(card));
      this._input(now + (holdMs === undefined ? this.cardHoldMs : holdMs), () => { if (this._field === card) this._setField(null); });
      return true;
    }
    placeCard(uid) {
      const card = parseUid(uid);
      if (!card) return false;
      this._input(this.clock.now(), () => this._setField(card));
      return true;
    }
    removeCard() {
      this._input(this.clock.now(), () => this._setField(null));
    }

    // Admin protocol: one line in, the '#' reply lines out (exact firmware text). While the CPU is
    // in a blocking sequence the bytes wait in the 64-byte UART buffer like on the Uno: then the
    // call returns [] and the replies follow as 'serial:line' events (adminAsync waits for them).
    admin(line) { return this._admin(line, null); }
    adminAsync(line) { return new Promise(resolve => this._admin(line, resolve)); }
    _admin(line, resolve) {
      const text = String(line === undefined || line === null ? '' : line).replace(/\r?\n$/, '');
      const sent = { text, dir: 'tx', kind: 'cmd', ms: this.millis() };
      this._history.push(sent);
      if (this._history.length > HISTORY) this._history.shift();
      this._emit('serial:line', sent);
      const bytes = [];
      for (const ch of text + '\n') {
        const c = ch.codePointAt(0);
        if (c < 128) bytes.push(c);
        else for (const b of unescapeUtf8(c)) bytes.push(b);
      }
      const inputsDue = this._inputs.length && this._inputs[0].t <= this.clock.now();
      if (this._idle && this._setupDone && !this._rx.length && !inputsDue) {
        this.cpuT = Math.max(this.cpuT, this.clock.now());
        this._capture = [];
        this._emit('sim:led', { led: 'rx' });
        this.protocol.service(bytes);
        const replies = this._capture;
        this._capture = null;
        this._persist();
        this._wakeUp();
        if (resolve) resolve(replies);
        return replies;
      }
      // one place in the reply queue per line that will run (empty lines run nothing)
      if (text.split(' ').some(w => w.length)) this._rxWaiting.push(resolve || (() => {}));
      else if (resolve) resolve([]);
      for (const b of bytes) if (this._rx.length < RX_BUFFER) this._rx.push(b);
      this._wakeUp();
      return [];
    }
    setDebugLog(on) {
      this.debugLog = !!on;
      this._wakeUp();
      this._emitState();
      return this.debugLog;
    }
    serialHistory() { return this._history.slice(); }

    state() {
      const now = Math.max(0, Math.floor(Math.max(this.cpuT, this.clock.now()) - this.t0));
      const s = this.spielAktiv;
      return {
        powered: this._powered,
        booted: this._setupDone,
        readerReady: this.readerBereit,
        session: s,
        slot: s ? this.spielSlot : -1,
        uid: s ? uidHex(this.spielUid.bytes) : null,
        balance: s ? this.spielGuthaben : null,
        unlimited: s ? this.spielUnbegrenzt : false,
        stake: s ? this.spielEinsatz : null,
        mode: MODE_NAMES[this.modus],
        input: this.modus === MODUS_EINSATZ && this.eingabeStellen ? String(this.eingabe) : '',
        helpPage: this.modus === MODUS_HILFE ? this.hilfeSeite : -1,
        soundLevel: this.tonStufe,
        sound: SOUND_NAMES[this.tonStufe],
        busy: this._busy > 0,
        secondsLeft: s ? Math.max(0, Math.ceil((this.SITZUNG_MS - (now - this.sitzungSeit)) / 1000)) : 0,
        modeSecondsLeft: this.modus !== MODUS_SPIEL ? Math.max(0, Math.ceil((this.MODUS_MS - (now - this.modusSeit)) / 1000)) : 0,
        resultVisible: this.ergebnisSichtbar,
        card: this._field ? this._field.uid : null,
        debugLog: this.debugLog,
        millis: now
      };
    }
    accounts() {
      const L = this.uidListe, R = this.Rules, out = [];
      for (let s = 0; s < L.capacity(); ++s) {
        const e = L.entry(s);
        if (!e) continue;
        const units = L.stakeUnits(s);
        out.push({
          slot: s, uid: uidHex(e), funded: L.funded(s), balance: L.balance(s),
          stake: units ? units * R.STAKE_SCHRITT : R.STAKE, flag: L.flag(s),
          session: this.spielAktiv && this.spielSlot === s
        });
      }
      return out;
    }
    screen() { return this.oled.text(); }
  }

  function unescapeUtf8(code) {
    if (code < 0x800) return [0xC0 | (code >> 6), 0x80 | (code & 63)];
    if (code < 0x10000) return [0xE0 | (code >> 12), 0x80 | ((code >> 6) & 63), 0x80 | (code & 63)];
    return [0xF0 | (code >> 18), 0x80 | ((code >> 12) & 63), 0x80 | ((code >> 6) & 63), 0x80 | (code & 63)];
  }

  Sim.toneTiming = toneTiming;
  Sim.parseUid = parseUid;
  Sim.uidHex = uidHex;
  Sim.VirtualClock = VirtualClock;
  MC.Sim = Sim;
})();
