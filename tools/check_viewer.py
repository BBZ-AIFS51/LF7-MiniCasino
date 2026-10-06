#!/usr/bin/env python3
"""Offline check of the viewer's firmware simulation (no browser needed).

    python case/viewer/tools/check_viewer.py

(a) data/firmware.js is up to date: the firmware is extracted again and compared byte for byte.
(b) every string the firmware puts on the display (meldung, hinweis, print, zeileWert,
    einsatzAnzeigen, farbe, stufenName), every serial log text and every admin protocol text
    appears verbatim as a string literal in the viewer JS.
(c) Node plays scripted sessions against core.js + oled.js + audio.js + admin.js + sim.js with a
    fake window/document and the virtual clock: boot, idle, every key in every mode, cards
    (new, known, banned, admin, list full, re-tap, scan pause), spins on every colour, A-entry with
    all errors, B yes/no, C all levels, D all pages, the 20 s and 60 s timeouts, every admin command.
    Screens are asserted as exact 16-character lines, both from the sketch's character memory and
    decoded back from the OLED framebuffer pixels.
(d) the JS port of GameRules.h (MC.Rules) equals a Python port over all inputs; the C expressions
    the Python port mirrors are checked against GameRules.h, and if the Arduino AVR toolchain is
    installed, avr-g++ evaluates the same values as constexpr static_asserts.

Prints a PASS/FAIL summary, exit code 1 on any failure. Standard library + node only.
"""
from __future__ import annotations

import glob
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

TOOLS = Path(__file__).resolve().parent
VIEWER = TOOLS.parent
ROOT = VIEWER.parents[1]
sys.path.insert(0, str(TOOLS))
import build_viewer_data as bvd  # noqa: E402

RESULTS: list[tuple[str, bool, str]] = []


def record(section: str, name: str, ok: bool, detail: str = '') -> None:
    RESULTS.append((f'{section} {name}', bool(ok), detail))


# ============================================================================ (a)
def check_generated() -> dict:
    data = bvd.extract()
    text = bvd.render(data)
    out = bvd.OUT
    current = out.read_text(encoding='utf-8') if out.exists() else ''
    record('(a)', 'data/firmware.js matches the firmware', current == text,
           'stale: run python case/viewer/tools/build_viewer_data.py')
    return data


# ============================================================================ (b)
def js_literals(src: str) -> set[str]:
    out, i, n = set(), 0, len(src)
    esc = {'n': '\n', 't': '\t', 'r': '\r', '0': '\0', 'b': '\b', 'f': '\f', 'v': '\v'}
    while i < n:
        if src.startswith('//', i):
            j = src.find('\n', i)
            i = n if j < 0 else j
            continue
        if src.startswith('/*', i):
            j = src.find('*/', i + 2)
            i = n if j < 0 else j + 2
            continue
        c = src[i]
        if c in '\'"`':
            j, buf = i + 1, []
            while j < n and src[j] != c:
                if src[j] == '\\' and j + 1 < n:
                    e = src[j + 1]
                    if e == 'u' and src[j + 2:j + 3] != '{':
                        buf.append(chr(int(src[j + 2:j + 6], 16)))
                        j += 6
                        continue
                    if e == 'x':
                        buf.append(chr(int(src[j + 2:j + 4], 16)))
                        j += 4
                        continue
                    buf.append(esc.get(e, e))
                    j += 2
                    continue
                buf.append(src[j])
                j += 1
            out.add(''.join(buf))
            i = j + 1
            continue
        i += 1
    return out


def check_strings(data: dict) -> None:
    js = {name: (VIEWER / 'js' / name).read_text(encoding='utf-8') for name in ('sim.js', 'oled.js', 'admin.js')}
    lits = {name: js_literals(src) for name, src in js.items()}
    display = lits['sim.js'] | lits['oled.js']
    groups = [
        ('display string', data['strings'] + data['displayChars'] + [data['title']], display, 'sim.js/oled.js'),
        ('serial log text', data['log'], lits['sim.js'], 'sim.js'),
        ('admin reply', data['admin']['replies'], lits['admin.js'], 'admin.js'),
        ('admin error', data['admin']['errors'], lits['admin.js'], 'admin.js'),
        ('admin command', data['admin']['commands'] + [data['admin']['confirm']], lits['admin.js'], 'admin.js'),
    ]
    for label, strings, pool, where in groups:
        missing = [s for s in strings if s not in pool]
        record('(b)', f'{len(strings)} firmware {label}s found in {where}', not missing,
               'missing: ' + ', '.join(repr(s) for s in missing))


# ============================================================================ (d) Python port
U32_MAX = 0xFFFFFFFF


def c_mod(a: int, b: int) -> int:
    r = abs(a) % abs(b)
    return -r if a < 0 else r


class PyRules:
    """GameRules.h in Python with AVR integer semantics (int 16 bit, unsigned long 32 bit)."""

    def __init__(self, r: dict):
        self.STAKE, self.STEP, self.MAX = r['STAKE'], r['STAKE_SCHRITT'], r['STAKE_MAX']
        self.B, self.R = r['BLACK_PERCENT'], r['RED_PERCENT']

    def colourForTicket(self, t):
        t &= 0xFF
        return 3 if t >= 100 else 0 if t < self.B else 1 if t < self.B + self.R else 2

    def spinSteps(self, start, result):
        return (24 + c_mod((result & 0xFF) + 4 - (start & 0xFF), 3)) & 0xFF

    def spinLed(self, start, step):
        return (((start & 0xFF) + (step & 0xFF)) % 3) & 0xFF

    def spinDelay(self, step, count):
        step &= 0xFF
        count &= 0xFF
        c1 = (count - 1) & U32_MAX
        d = (c1 * c1) & U32_MAX
        num = (455 * step * step) & U32_MAX
        q = U32_MAX if d == 0 else num // d
        return (45 + q) & 0xFFFF

    def payoutMultiplier(self, choice):
        choice &= 0xFF
        return 0 if choice >= 3 else 9 if choice == 2 else 2

    def canPlay(self, balance, choice, stake):
        balance &= U32_MAX
        stake &= U32_MAX
        choice &= 0xFF
        return (choice < 3 and stake >= self.STEP and stake <= self.MAX and balance >= stake
                and balance <= U32_MAX - ((stake * (self.payoutMultiplier(choice) - 1)) & U32_MAX))

    def payout(self, choice, result, stake):
        choice &= 0xFF
        result &= 0xFF
        return (self.payoutMultiplier(choice) * (stake & U32_MAX)) & U32_MAX if choice < 3 and choice == result else 0

    def settled(self, debited, choice, result, stake):
        return ((debited & U32_MAX) + self.payout(choice, result, stake)) & U32_MAX

    def stakeLimit(self, balance):
        balance &= U32_MAX
        return self.STEP if balance < self.STEP else ((balance if balance < self.MAX else self.MAX) // self.STEP) * self.STEP

    def checkStake(self, value, limit):
        value &= U32_MAX
        limit &= U32_MAX
        return 1 if value < self.STEP else 2 if value % self.STEP else 3 if value > limit else 0


# The C source each Python method mirrors; if GameRules.h changes, the ports must be revisited.
C_EXPRESSIONS = [
    'return ticket >= 100 ? 3 : ticket < BLACK_PERCENT ? 0 : ticket < BLACK_PERCENT + RED_PERCENT ? 1 : 2;',
    'return 24 + (result + 4 - start) % 3;',
    'return (start + step) % 3;',
    'return 45 + (455UL * step * step) / ((count - 1UL) * (count - 1UL));',
    'return choice >= 3 ? 0 : choice == 2 ? 9 : 2;',
    'return choice < 3 && stake >= STAKE_SCHRITT && stake <= STAKE_MAX && balance >= stake '
    '&& balance <= UINT32_MAX - stake * (payoutMultiplier(choice) - 1);',
    'return choice < 3 && choice == result ? payoutMultiplier(choice) * stake : 0;',
    'return debited + payout(choice, result, stake);',
    'return balance < STAKE_SCHRITT ? STAKE_SCHRITT : ((balance < STAKE_MAX ? balance : STAKE_MAX) / STAKE_SCHRITT) * STAKE_SCHRITT;',
    'return value < STAKE_SCHRITT ? 1 : value % STAKE_SCHRITT ? 2 : value > limit ? 3 : 0;',
]
C_SOUND_EXPRESSION = 'return !win ? SoundEffect::Loss : choice == 2 ? SoundEffect::Jackpot : SoundEffect::Win;'


def rule_domains() -> dict:
    edges = [U32_MAX, U32_MAX - 1, U32_MAX - 9, U32_MAX - 10, U32_MAX - 79, U32_MAX - 80, 2 ** 31, 2 ** 31 - 1,
             477218588, 477218589, 536870911, 536870912, 99999, 25500, 25499]
    stakes = list(range(0, 2601)) + edges
    balances = list(range(0, 3001, 1)) + [U32_MAX - k for k in range(0, 200, 3)] + edges
    limits = sorted(set([0, 5, 9, 10, 11, 15, 20, 99, 100, 101, 150, 155, 2540, 2549, 2550, 2551, 2560, U32_MAX]
                        + list(range(10, 2551, 10))))
    return {
        'colourForTicket': [[t] for t in range(256)],
        'spinSteps': [[a, b] for a in range(256) for b in range(256)],
        'spinLed': [[a, b] for a in range(256) for b in range(256)],
        'spinDelay': [[s, c] for s in range(256) for c in range(256) if c != 1],
        'payoutMultiplier': [[c] for c in range(256)],
        'payout': [[c, r, s] for c in range(5) for r in range(5) for s in stakes],
        'settled': [[d, c, r, s] for d in (0, 1, 90, 2550, U32_MAX - 90, U32_MAX - 20) for c in range(4) for r in range(4)
                    for s in (0, 10, 20, 50, 2550, 2560, U32_MAX)],
        'canPlay': [[b, c, s] for b in balances for c in range(4)
                    for s in (0, 5, 9, 10, 11, 20, 50, 100, 2540, 2550, 2551, 2560)],
        'stakeLimit': [[b] for b in list(range(0, 30001)) + edges],
        'checkStake': [[v, l] for v in range(0, 2601) for l in limits],
    }


# ============================================================================ (c) + (d) node harness
HARNESS = r"""
'use strict';
const vm = require('vm'), fs = require('fs'), path = require('path');
const V = process.env.MC_VIEWER;
const FILES = ['data/firmware.js', 'js/core.js', 'js/oled.js', 'js/audio.js', 'js/admin.js', 'js/sim.js'];
const out = o => process.stdout.write(JSON.stringify(o) + '\n');
const pad = s => (s + ' '.repeat(16)).slice(0, 16);
let current = 'setup';
function check(name, ok, detail) { out({ t: 'check', name: current + ': ' + name, ok: !!ok, detail: ok ? undefined : detail }); }
function eq(name, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  check(name, ok, ok ? undefined : { got, want });
  return ok;
}

function load(store) {
  store = store || {};
  const ctx = {
    console, setTimeout, clearTimeout, setImmediate, performance,
    localStorage: {
      getItem: k => (Object.prototype.hasOwnProperty.call(store, k) ? store[k] : null),
      setItem: (k, v) => { store[k] = String(v); },
      removeItem: k => { delete store[k]; }
    },
    document: { createElement() { throw new Error('no canvas in the harness'); } }
  };
  ctx.window = ctx;
  vm.createContext(ctx);
  for (const f of FILES) vm.runInContext(fs.readFileSync(path.join(V, f), 'utf8'), ctx, { filename: f });
  ctx._store = store;
  return ctx;
}

function rig(opts) {
  opts = opts || {};
  const ctx = load(opts.store);
  const MC = ctx.MC;
  const clock = opts.clock ? opts.clock(MC) : MC.SimClock.virtual(1000);
  const oled = new MC.Oled({ emit: false });
  const sounds = [];
  const audio = {
    tone(hz, ms, level) { sounds.push({ t: clock.now(), notes: [[hz, ms, 0]], level }); return true; },
    play(notes, level) { sounds.push({ t: clock.now(), notes, level }); return Promise.resolve(); },
    stop() {}
  };
  const rngQ = [];
  const simOpts = Object.assign({ oled, audio, clock, storage: !!opts.store, rng: () => (rngQ.length ? rngQ.shift() : 0x2545F491) }, opts.sim || {});
  const sim = new MC.Sim(simOpts);
  const frames = [];
  let last = '';
  oled.onChange = () => {
    const d = oled.decode();
    const k = d.line0 + '|' + d.line1 + '|' + d.hint;
    if (k.indexOf('�') >= 0 || k === last) return;
    last = k;
    frames.push({ t: clock.now(), line0: d.line0, line1: d.line1, hint: d.hint, title: d.title, on: d.on });
  };
  const serial = [], events = [];
  MC.bus.on('serial:line', l => serial.push(l));
  ['sim:result', 'sim:busy', 'sim:spin', 'sim:sound', 'sim:scan', 'sim:key', 'sim:state', 'sim:boot'].forEach(n =>
    MC.bus.on(n, d => events.push({ n, d, t: clock.now() })));
  const r = {
    ctx, MC, clock, oled, sim, sounds, rngQ, frames, serial, events,
    run: ms => clock.advance(ms),
    async boot() { sim.boot(); await clock.advance(1500); },
    async key(ch, after) { sim.pressKey(ch); await clock.advance(after === undefined ? 400 : after); },
    async keys(s, after) { for (const ch of s) await r.key(ch, after); },
    async tap(uid, after) { sim.tapCard(uid); await clock.advance(after === undefined ? 1500 : after); },
    mark: () => frames.length,
    saw(from, l0, l1, hint) {
      return frames.slice(from).some(f => f.line0 === pad(l0) && f.line1 === pad(l1) && (hint === undefined || f.hint === pad(hint)));
    },
    admin(line) { return sim.admin(line); },
    MC_FW: ctx.MC_FW,
    spins: () => events.filter(e => e.n === 'sim:spin').length,
    runUntil: t => clock.advance(Math.max(0, t - clock.now())),
    firstFrame(from, l0, l1, hint) {
      const f = frames.slice(from).find(x => x.line0 === pad(l0) && x.line1 === pad(l1) && (hint === undefined || x.hint === pad(hint)));
      return f ? f.t : NaN;
    },
    expect(name, l0, l1, hint) {
      const d = oled.decode();
      const logical = oled.lines().concat([oled.hint()]);
      const want = [pad(l0), pad(l1), pad(hint === undefined ? '' : hint)];
      const a = eq(name, logical, want);
      const b = eq(name + ' [pixels]', [d.line0, d.line1, d.hint], want);
      return a && b;
    },
    spin(ticket, start) { rngQ.push(ticket, start); }
  };
  return r;
}

// The sim hands the audio the cycle-exact tone of tonSpiele(): period = floor(1e6 / hz) us plus the
// loop overhead, as many whole cycles as fit. Compare against the firmware table with that in mind.
function sameNotes(got, table) {
  if (!got || got.length !== table.length) return false;
  return got.every((n, i) => {
    const [hz, ms, gap] = table[i];
    const periode = Math.floor(1e6 / hz), cycle = periode + 7.5;
    return Math.abs(n[0] - 1e6 / cycle) < 0.01 && Math.abs(n[1] - Math.floor(ms * 1000 / periode) * cycle / 1000) < 0.01 && n[2] === gap;
  });
}

const SPIN_LINE = { '  > SCHWARZ <   ': 0, '    > ROT <     ': 1, '   > GRUEN <    ': 2 };

async function suiteBootAndIdle() {
  current = 'boot';
  const r = rig();
  r.sim.boot();
  await r.run(5);
  eq('display dark right after power-on', r.oled.decode().on, false);
  await r.run(1500);
  check('boot screen Mini Casino / Starte Reader...', r.saw(0, 'Mini Casino', 'Starte Reader...'), r.frames);
  const d = r.oled.decode();
  eq('title bar inverted on page 0', d.title, '  MINI  CASINO  ');
  eq('pages 1 and 6 stay empty', d.gapsBlank, true);
  r.expect('idle screen', 'Bitte Karte', 'auflegen', 'D = Hilfe');
  eq('EEPROM header written (format 07)', Array.from(r.sim.eeprom.mem.slice(0, 8)), [77, 67, 85, 73, 68, 48, 55, 1]);
  eq('PING after boot', r.admin('PING'), ['#OK PING v11 slots=31 used=0 sound=0 session=-1']);
  eq('no serial output without DEBUG_LOG', r.serial.filter(l => l.dir === 'rx' && l.kind === 'log').length, 0);

  current = 'idle keys';
  let n = r.sounds.length;
  await r.key('*');
  r.expect('unused key: only the hint changes', 'Bitte Karte', 'auflegen', 'Tasten: 1-3 A-D');
  const s = r.sounds.slice(n);
  check('unused key plays tonFehler 300 Hz / 120 ms', s.length === 1 && Math.abs(s[0].notes[0][0] - 300) < 2 && Math.abs(s[0].notes[0][1] - 120) < 1.5, s);
  await r.key('1');
  r.expect('1 without a session', 'Zuerst Karte', 'auflegen', 'D = Hilfe');
  await r.run(4300);
  r.expect('still shown after 4.7 s', 'Zuerst Karte', 'auflegen', 'D = Hilfe');
  await r.run(600);
  r.expect('back to idle after ANZEIGEDAUER_MS', 'Bitte Karte', 'auflegen', 'D = Hilfe');
  await r.key('A');
  r.expect('A without a session', 'Zuerst Karte', 'auflegen', 'D = Hilfe');
  await r.run(5200);
  await r.key('B');
  r.expect('B without a session', 'Zuerst Karte', 'auflegen', 'D = Hilfe');
  await r.run(5200);

  current = 'help without session';
  n = r.sounds.length;
  await r.key('D');
  r.expect('page 1', '1 Schwarz  2 Rot', '3 Gruen', 'D=weiter  *=Ende');
  check('D plays tonKlick 1500 Hz / 10 ms', r.sounds.length === n + 1 && Math.abs(r.sounds[n].notes[0][0] - 1500) < 20, r.sounds.slice(n));
  await r.key('D');
  r.expect('page 2', 'A Einsatz', 'B Abmelden', 'D=weiter  *=Ende');
  await r.key('D');
  r.expect('page 3', 'C Ton  D Hilfe', 'Gruen zahlt 9x', 'D=weiter  *=Ende');
  await r.key('D');
  r.expect('D after the last page: menu', 'Bitte Karte', 'auflegen', 'D = Hilfe');
  await r.key('D');
  await r.key('*');
  r.expect('* ends the help', 'Bitte Karte', 'auflegen', 'D = Hilfe');
  await r.key('D');
  await r.run(19400);
  r.expect('help still open after 19.8 s', '1 Schwarz  2 Rot', '3 Gruen', 'D=weiter  *=Ende');
  await r.run(400);
  r.expect('help closes after MODUS_MS', 'Bitte Karte', 'auflegen', 'D = Hilfe');
  await r.key('D');
  await r.key('2');
  r.expect('other key in the help acts directly', 'Zuerst Karte', 'auflegen', 'D = Hilfe');
  return r;
}

function spinCheck(r, from, label, choice, result) {
  const spin = r.events.filter(e => e.n === 'sim:spin').slice(-1)[0];
  if (!check(label + ': spin started', !!spin, null)) return;
  const R = r.MC.Rules, start = spin.d.start, count = spin.d.steps;
  eq(label + ': spinSteps', count, R.spinSteps(start, result));
  const seq = [];
  for (const f of r.frames.slice(from)) {
    if (!(f.line1 in SPIN_LINE)) continue;
    const i = SPIN_LINE[f.line1];
    if (!seq.length || seq[seq.length - 1] !== i) seq.push(i);
  }
  const want = [];
  for (let s = 0; s < count; s++) want.push(R.spinLed(start, s));
  eq(label + ': OLED runs through spinLed() and stops on the result', seq, want);
  eq(label + ': last colour is the result', seq[seq.length - 1], result);
  const ticks = r.events.filter(e => e.n === 'sim:sound' && e.d.kind === 'tick' && e.t >= spin.t);
  eq(label + ': one tick per step', ticks.length, count);
  let worst = 0;
  for (let s = 0; s + 1 < ticks.length; s++) worst = Math.max(worst, Math.abs(ticks[s + 1].t - ticks[s].t - R.spinDelay(s, count)));
  check(label + ': step times equal spinDelay() (+-1 ms)', worst <= 1.01, { worst });
  const nominal = ticks.map((e, s) => Math.round(1e6 / (1e6 / e.d.notes[0][0] - 7.5)));
  const wantHz = want.map(i => 1200 + i * 250);
  check(label + ': tick 1200 + index * 250 Hz', nominal.every((hz, i) => Math.abs(hz - wantHz[i]) <= 3), { nominal, wantHz });
  const tipp = 'Tipp: ' + ['SCHWARZ', 'ROT', 'GRUEN'][choice];
  check(label + ': line 0 shows ' + tipp, r.frames.slice(from).some(f => f.line0 === pad(tipp) && f.line1 in SPIN_LINE), null);
}

async function suiteGame(r) {
  current = 'new card';
  let m = r.mark();
  await r.tap('DF51AA39');
  check('zeigeGuthaben flashes Neu aufgeladen! / 100€', r.saw(m, 'Neu aufgeladen!', '100€'), r.frames.slice(m));
  r.expect('menu', 'Guthaben    100€', 'Einsatz      10€', '1-3 setzen  D=?');
  eq('LIST', r.admin('LIST'), ['#ROW 0 DF51AA39 1 100 10 0', '#OK LIST 1']);
  eq('PING', r.admin('PING'), ['#OK PING v11 slots=31 used=1 sound=0 session=0']);
  eq('state', (s => [s.session, s.slot, s.uid, s.balance, s.stake, s.mode])(r.sim.state()), [true, 0, 'DF51AA39', 100, 10, 'play']);

  current = 'black wins';
  m = r.mark();
  const spins0 = r.spins();
  r.spin(10, 0);
  await r.key('1', 1200);
  r.sim.pressKey('2');   // during the spin: must be ignored
  await r.run(8500);
  check('Buche Runde... before the spin', r.saw(m, 'Buche Runde...', ''), null);
  spinCheck(r, m, 'black', 0, 0);
  check('result + Gewinn while the jingle plays, old hint kept', r.saw(m, 'SCHWARZ', 'Gewinn      +10€', '1-3 setzen  D=?'), r.frames.slice(-12));
  r.expect('final screen', 'Gewinn      +10€', 'Guthaben    110€', '1-3 nochmal');
  const res = r.events.filter(e => e.n === 'sim:result').slice(-1)[0];
  eq('sim:result', res && [res.d.choice, res.d.result, res.d.win, res.d.net, res.d.jackpot], [0, 0, true, 10, false]);
  const win = r.sounds.filter(s => s.notes.length === 4).slice(-1)[0];
  check('WIN_SOUND notes and durations', win && sameNotes(win.notes, r.MC_FW.sounds.win), win);
  eq('only one spin although 2 was pressed during it', r.spins() - spins0, 1);
  eq('busy reported', r.events.filter(e => e.n === 'sim:busy').slice(-2).map(e => e.d), [true, false]);
  const shown = r.firstFrame(m, 'Gewinn      +10€', 'Guthaben    110€', '1-3 nochmal');
  await r.runUntil(shown + 4900);
  r.expect('result still shown after 4.9 s', 'Gewinn      +10€', 'Guthaben    110€', '1-3 nochmal');
  await r.runUntil(shown + 5200);
  r.expect('menu after ANZEIGEDAUER_MS', 'Guthaben    110€', 'Einsatz      10€', '1-3 setzen  D=?');

  current = 'red loses';
  m = r.mark();
  r.spin(10, 1);
  await r.key('2', 9000);
  spinCheck(r, m, 'red', 1, 0);
  check('result screen', r.saw(m, 'SCHWARZ', 'Verlust     -10€'), null);
  r.expect('final screen', 'Verlust     -10€', 'Guthaben    100€', '1-3 nochmal');
  const loss = r.sounds.filter(s => s.notes.length === 4).slice(-1)[0];
  check('LOSS_SOUND notes and durations', loss && sameNotes(loss.notes, r.MC_FW.sounds.loss), loss);

  current = 'green jackpot';
  m = r.mark();
  r.spin(95, 2);
  await r.key('3', 9500);
  spinCheck(r, m, 'green', 2, 2);
  check('JACKPOT! GRUEN / Gewinn +80€', r.saw(m, 'JACKPOT! GRUEN', 'Gewinn      +80€'), null);
  r.expect('final screen', 'Gewinn      +80€', 'Guthaben    180€', '1-3 nochmal');
  const jp = r.sounds.filter(s => s.notes.length === 12).slice(-1)[0];
  check('JACKPOT_SOUND notes and durations', jp && sameNotes(jp.notes, r.MC_FW.sounds.jackpot), jp);
  const res2 = r.events.filter(e => e.n === 'sim:result').slice(-1)[0];
  eq('sim:result jackpot', res2 && [res2.d.net, res2.d.jackpot], [80, true]);

  current = 'green loses, red wins, 1-3 nochmal';
  r.spin(50, 0);
  await r.key('3', 9500);
  r.expect('green lost', 'Verlust     -10€', 'Guthaben    170€', '1-3 nochmal');
  r.spin(60, 1);
  await r.key('2', 9500);
  r.expect('red won, played again from the result screen', 'Gewinn      +10€', 'Guthaben    180€', '1-3 nochmal');
  eq('balance booked in the EEPROM', r.admin('LIST')[0], '#ROW 0 DF51AA39 1 180 10 0');
  await r.run(5500);

  current = 'stake entry (A)';
  await r.key('A');
  r.expect('A opens the entry', 'Neuer Einsatz:', '_        max 180', 'Zahl  *=zurueck');
  let n = r.sounds.length;
  await r.key('#');
  r.expect('# on empty input', 'Mindestens 10', '_        max 180', 'Zahl  *=zurueck');
  check('error tone', r.sounds.length === n + 1 && Math.abs(r.sounds[n].notes[0][0] - 300) < 2, r.sounds.slice(n));
  await r.key('0');
  r.expect('leading zero ignored', 'Neuer Einsatz:', '_        max 180', 'Zahl  *=zurueck');
  await r.key('5');
  r.expect('5', 'Neuer Einsatz:', '5_       max 180', '#=OK  *=Loeschen');
  await r.key('#');
  r.expect('5 is below the minimum', 'Mindestens 10', '5_       max 180', '#=OK  *=Loeschen');
  await r.key('5');
  r.expect('55', 'Neuer Einsatz:', '55_      max 180', '#=OK  *=Loeschen');
  await r.key('#');
  r.expect('55 is not a step of 10', 'Nur 10er-Schritt', '55_      max 180', '#=OK  *=Loeschen');
  await r.key('*');
  r.expect('* deletes a digit', 'Neuer Einsatz:', '5_       max 180', '#=OK  *=Loeschen');
  await r.key('*');
  r.expect('* deletes the last digit', 'Neuer Einsatz:', '_        max 180', 'Zahl  *=zurueck');
  await r.keys('200');
  r.expect('200', 'Neuer Einsatz:', '200_     max 180', '#=OK  *=Loeschen');
  await r.key('#');
  r.expect('200 is above the limit', 'Zu hoch!', '200_     max 180', '#=OK  *=Loeschen');
  await r.keys('01');
  r.expect('four digits at most', 'Neuer Einsatz:', '2000_    max 180', '#=OK  *=Loeschen');
  n = r.sounds.length;
  await r.key('C');
  r.expect('A-D mean nothing here', 'Neuer Einsatz:', '2000_    max 180', '#=OK  *=Loeschen');
  check('... only an error tone', r.sounds.length === n + 1 && Math.abs(r.sounds[n].notes[0][0] - 300) < 2, null);
  await r.keys('****');
  await r.key('*');
  r.expect('* on empty input cancels', 'Guthaben    180€', 'Einsatz      10€', '1-3 setzen  D=?');
  await r.keys('A50');
  n = r.sounds.length;
  r.sim.pressKey('#');
  await r.run(250);
  r.expect('# accepts: menu at once, hint follows after tonQuittung', 'Guthaben    180€', 'Einsatz      50€', '#=OK  *=Loeschen');
  await r.run(500);
  r.expect('new stake in the menu', 'Guthaben    180€', 'Einsatz      50€', '1-3 setzen  D=?');
  const q = r.sounds.slice(n)[0];
  check('tonQuittung 3 x 1400 Hz (40 ms, gap 100 ms)', q && q.notes.length === 3 && q.notes.every(x => Math.abs(1e6 / (1e6 / x[0] - 7.5) - 1400) < 3 && x[2] === 100), q);
  eq('stake stored per account', r.admin('LIST')[0], '#ROW 0 DF51AA39 1 180 50 0');
  await r.key('A');
  await r.run(19500);
  r.expect('entry still open after 19.9 s', 'Neuer Einsatz:', '_        max 180', 'Zahl  *=zurueck');
  await r.run(300);
  r.expect('entry closes after MODUS_MS', 'Guthaben    180€', 'Einsatz      50€', '1-3 setzen  D=?');

  current = 'logout (B)';
  await r.key('B');
  r.expect('B asks', 'Wirklich', 'abmelden?', '#=Ja    *=Nein');
  await r.key('1');
  r.expect('other keys only beep', 'Wirklich', 'abmelden?', '#=Ja    *=Nein');
  await r.key('*');
  r.expect('* = no', 'Guthaben    180€', 'Einsatz      50€', '1-3 setzen  D=?');
  await r.key('B');
  await r.run(20200);
  r.expect('question closes after MODUS_MS', 'Guthaben    180€', 'Einsatz      50€', '1-3 setzen  D=?');
  await r.key('B');
  await r.key('#', 800);
  r.expect('# = yes', 'Abgemeldet', 'Bis bald!', '');
  eq('session ended', r.admin('PING'), ['#OK PING v11 slots=31 used=1 sound=0 session=-1']);
  await r.run(5200);
  r.expect('idle after the goodbye', 'Bitte Karte', 'auflegen', 'D = Hilfe');

  current = 'known card, stake memory';
  m = r.mark();
  await r.tap('DF51AA39');
  check('Guthaben: / 180€ flashes', r.saw(m, 'Guthaben:', '180€'), r.frames.slice(m));
  r.expect('stake remembered', 'Guthaben    180€', 'Einsatz      50€', '1-3 setzen  D=?');

  current = 'sound (C)';
  n = r.sounds.length;
  await r.key('C', 800);
  r.expect('laut -> leise', 'Ton leise', 'gespeichert', 'C = weiter');
  const ql = r.sounds.slice(n)[0];
  check('quittung played leise (narrow pulses)', ql && ql.level === 1 && ql.notes.length === 3, ql);
  eq('sound level in PING', r.admin('PING')[0].split(' ')[5], 'sound=1');
  eq('options byte bit 1', r.sim.eeprom.mem[8] & 3, 2);
  n = r.sounds.length;
  await r.key('C', 800);
  r.expect('leise -> aus', 'Ton aus', 'gespeichert', 'C = weiter');
  eq('aus is silent', r.sounds.length, n);
  eq('options byte bit 0', r.sim.eeprom.mem[8] & 3, 1);
  r.spin(10, 0);
  await r.key('1', 9500);
  eq('a whole round in aus: no sound at all', r.sounds.length, n);
  r.expect('round still runs', 'Gewinn      +50€', 'Guthaben    230€', '1-3 nochmal');
  await r.key('C', 800);
  r.expect('aus -> laut', 'Ton laut', 'gespeichert', 'C = weiter');
  await r.run(5200);
  r.expect('menu after ANZEIGEDAUER_MS', 'Guthaben    230€', 'Einsatz      50€', '1-3 setzen  D=?');

  current = 'help with session';
  await r.key('D');
  r.expect('page 1', '1 Schwarz  2 Rot', '3 Gruen', 'D=weiter  *=Ende');
  await r.keys('DD');
  r.expect('page 3', 'C Ton  D Hilfe', 'Gruen zahlt 9x', 'D=weiter  *=Ende');
  await r.key('D');
  r.expect('back to the menu', 'Guthaben    230€', 'Einsatz      50€', '1-3 setzen  D=?');
  await r.key('D');
  r.spin(60, 0);
  await r.key('2', 9500);
  r.expect('2 in the help bets directly', 'Gewinn      +50€', 'Guthaben    280€', '1-3 nochmal');
  await r.run(5500);

  current = 'session timeout';
  await r.key('D');
  await r.key('*');
  await r.run(59000);
  check('session alive after 59 s', r.sim.state().session, null);
  await r.run(1500);
  r.expect('SITZUNG_MS ends the session', 'Bitte Karte', 'auflegen', 'D = Hilfe');
  r.sim.placeCard('DF51AA39');
  await r.run(70000);
  check('a card lying on the reader keeps the session alive', r.sim.state().session, null);
  r.sim.removeCard();
  await r.run(61000);
  check('session ends once the card is gone', !r.sim.state().session, null);

  current = 'scan pause';
  await r.tap('DF51AA39', 300);
  await r.tap('0885B1A8', 400);
  eq('a second card within the 1 s scan pause is not read', r.admin('PING')[0].split(' ').slice(4), ['used=1', 'sound=0', 'session=0']);
  await r.run(1500);
  await r.tap('0885B1A8');
  r.expect('after the pause the new card gets its account', 'Guthaben    100€', 'Einsatz      10€', '1-3 setzen  D=?');
  eq('two accounts', r.admin('LIST').slice(-1), ['#OK LIST 2']);

  current = 'held key';
  const before = r.spins();
  r.spin(10, 0);
  r.sim.keyDown('1');
  await r.run(12000);
  r.sim.keyUp('1');
  await r.run(500);
  eq('a key held through the spin plays once (tastenSperren)', r.spins() - before, 1);
  r.spin(10, 0);
  await r.key('1', 9000);
  eq('pressed again after release: next round', r.spins() - before, 2);
  return r;
}

async function suiteMoney(r) {
  current = 'not enough credit';
  // session on slot 1 (0885B1A8, 110 after the held-key round)
  eq('SET while playing', r.admin('SET 1 5'), ['#OK SET 1 5']);
  await r.run(150);
  r.expect('menu follows SET at once', 'Guthaben      5€', 'Einsatz      10€', '1-3 setzen  D=?');
  await r.key('1');
  r.expect('Guthaben fehlt', 'Guthaben fehlt', 'Mit A aendern', 'A = Einsatz');
  await r.key('A');
  r.expect('limit is one step', 'Neuer Einsatz:', '_         max 10', 'Zahl  *=zurueck');
  await r.key('*');
  eq('STAKE while playing', r.admin('STAKE 1 50'), ['#OK STAKE 1 50']);
  await r.run(150);
  r.expect('stake follows', 'Guthaben      5€', 'Einsatz      50€', '1-3 setzen  D=?');
  await r.key('B');
  await r.key('#', 800);
  await r.run(5500);
  await r.tap('0885B1A8');
  r.expect('remembered stake clamped to stakeLimit()', 'Guthaben      5€', 'Einsatz      10€', '1-3 setzen  D=?');

  current = 'admin card';
  eq('FLAG 2', r.admin('FLAG 1 2'), ['#OK FLAG 1 2']);
  await r.run(150);
  r.expect('unlimited shows inf', 'Guthaben     inf', 'Einsatz      10€', '1-3 setzen  D=?');
  let m = r.mark();
  r.spin(10, 0);
  await r.key('1', 9000);
  check('no booking for the admin card', !r.saw(m, 'Buche Runde...', ''), null);
  r.expect('result with inf', 'Gewinn      +10€', 'Guthaben     inf', '1-3 nochmal');
  eq('balance unchanged, stored stake untouched by the clamp', r.admin('LIST')[1], '#ROW 1 0885B1A8 1 5 50 2');
  await r.key('A');
  r.expect('admin card limit 2550', 'Neuer Einsatz:', '_       max 2550', 'Zahl  *=zurueck');
  await r.keys('2550');
  await r.key('#', 800);
  r.expect('2550 accepted', 'Guthaben     inf', 'Einsatz    2550€', '1-3 setzen  D=?');

  current = 'banned card';
  eq('FLAG 1 ends the running session', r.admin('FLAG 1 1'), ['#OK FLAG 1 1']);
  await r.run(150);
  r.expect('logged out at once', 'Abgemeldet', 'Bis bald!', '');
  await r.run(300);
  await r.tap('0885B1A8');
  r.expect('banned', 'Karte gesperrt', 'Siehe Admin', '');
  check('no session for a banned card', !r.sim.state().session, null);
  await r.run(5200);
  r.expect('idle afterwards', 'Bitte Karte', 'auflegen', 'D = Hilfe');
  eq('FLAG 0', r.admin('FLAG 1 0'), ['#OK FLAG 1 0']);
}

async function suiteAdmin(r) {
  current = 'admin protocol';
  const A = (line, want) => eq(JSON.stringify(line), r.admin(line), want);
  A('ping', ['#OK PING v11 slots=31 used=2 sound=0 session=-1']);
  A('  PING  ', ['#OK PING v11 slots=31 used=2 sound=0 session=-1']);
  A('', []);
  A('   ', []);
  A('HELLO', ['#ERR PING LIST SET STAKE FLAG ADD FREE CARD SOUND WIPE']);
  A('PING\tx', ['#ERR PING LIST SET STAKE FLAG ADD FREE CARD SOUND WIPE']);
  A('SET', ['#ERR SET <platz> <wert>']);
  A('SET 0', ['#ERR SET <platz> <wert>']);
  A('SET 0 x', ['#ERR SET <platz> <wert>']);
  A('SET -1 5', ['#ERR SET <platz> <wert>']);
  A('SET 0 1234567890', ['#ERR SET <platz> <wert>']);
  A('SET 9 100', ['#ERR Platz nicht belegt']);
  A('SET 0 999999999', ['#OK SET 0 999999999']);
  A('SET 65536 7', ['#OK SET 0 7']);
  A('set 0 280', ['#OK SET 0 280']);
  A('STAKE 0 55', ['#ERR STAKE <platz> <10..2550, 10er>']);
  A('STAKE 0 5', ['#ERR STAKE <platz> <10..2550, 10er>']);
  A('STAKE 0 2560', ['#ERR STAKE <platz> <10..2550, 10er>']);
  A('STAKE 7 30', ['#ERR Platz ohne Konto']);
  A('STAKE 0 30', ['#OK STAKE 0 30']);
  A('FLAG 0 3', ['#ERR FLAG <platz> <0|1|2>']);
  A('FLAG 0', ['#ERR FLAG <platz> <0|1|2>']);
  A('FLAG 9 1', ['#ERR Platz nicht belegt']);
  A('ADD 049F905C110189', ['#ERR ADD <uid 8/14/20 hex> <wert>']);
  A('ADD 049F905C11018 5', ['#ERR ADD <uid 8/14/20 hex> <wert>']);
  A('ADD 049F90 5', ['#ERR ADD <uid 8/14/20 hex> <wert>']);
  A('ADD ZZ9F905C110189 5', ['#ERR ADD <uid 8/14/20 hex> <wert>']);
  A('ADD 049f905c110189 250', ['#OK ADD 2 250']);
  A('ADD 049F905C110189 300', ['#OK ADD 2 300']);
  A('ADD 0102030405060708090A 1', ['#OK ADD 3 1']);
  A('LIST', ['#ROW 0 DF51AA39 1 280 30 0', '#ROW 1 0885B1A8 1 5 2550 0', '#ROW 2 049F905C110189 1 300 10 0',
    '#ROW 3 0102030405060708090A 1 1 10 0', '#OK LIST 4']);
  A('FREE', ['#ERR FREE <platz>']);
  A('FREE 40', ['#ERR Nicht freigegeben']);
  A('FREE 3', ['#OK FREE 3']);
  A('FREE 3', ['#OK FREE 3']);
  A('SOUND', ['#ERR SOUND <0|1|2>']);
  A('SOUND 3', ['#ERR SOUND <0|1|2>']);
  A('SOUND 1', ['#OK SOUND 1']);
  A('PING', ['#OK PING v11 slots=31 used=3 sound=1 session=-1']);
  A('SOUND 0', ['#OK SOUND 0']);
  await r.run(1000);   // the commands above kept the CPU busy with EEPROM writes for a while
  A('CARD', ['#ERR CARD <uid 8/14/20 hex>']);
  A('CARD 12', ['#ERR CARD <uid 8/14/20 hex>']);
  A('CARD 04CABD5C110189', ['#OK CARD']);
  eq('CARD takes the scan path: new account', r.oled.lines(), ['Guthaben    100€', 'Einsatz      10€']);
  await r.run(150);
  r.expect('CARD: menu with its hint', 'Guthaben    100€', 'Einsatz      10€', '1-3 setzen  D=?');
  A('PING', ['#OK PING v11 slots=31 used=4 sound=0 session=3']);
  A('SET 3 77', ['#OK SET 3 77']);
  await r.run(150);
  r.expect('SET on the session slot', 'Guthaben     77€', 'Einsatz      10€', '1-3 setzen  D=?');
  A('FREE 3', ['#OK FREE 3']);
  await r.run(150);
  r.expect('FREE on the session slot logs out', 'Abgemeldet', 'Bis bald!', '');
  A('PING ' + 'x'.repeat(60), ['#OK PING v11 slots=31 used=3 sound=0 session=-1']);
  A('X'.repeat(60), ['#ERR PING LIST SET STAKE FLAG ADD FREE CARD SOUND WIPE']);
  A('WIPE', ['#ERR WIPE JA']);
  A('WIPE ja', ['#ERR WIPE JA']);
  A('wipe JA', ['#OK WIPE']);
  A('PING', ['#OK PING v11 slots=31 used=0 sound=0 session=-1']);
  A('LIST', ['#OK LIST 0']);
  const t0 = r.clock.now();
  await r.run(4000);
  const wipeLine = r.serial.filter(l => l.text === '#OK WIPE').slice(-1)[0];
  check('serial reply leaves after the EEPROM time (WIPE about 3.5 s)', !!wipeLine, null);

  current = 'list full';
  for (let i = 0; i < 31; i++) {
    const uid = 'A1B2C3' + (i < 16 ? '0' : '') + i.toString(16).toUpperCase();
    if (!eq('ADD ' + uid, r.admin('ADD ' + uid + ' 10'), ['#OK ADD ' + i + ' 10'])) break;
  }
  eq('ADD on a full list', r.admin('ADD 0BADCAFE 10'), ['#ERR Liste voll']);
  await r.run(1500);
  await r.tap('0BADCAFE');
  r.expect('tap on a full list', 'UID-Liste voll', 'Nicht aufgeladen', '');
  await r.run(5200);
  r.expect('idle afterwards', 'Bitte Karte', 'auflegen', 'D = Hilfe');
  r.admin('WIPE JA');
  await r.run(4000);

  current = 'busy CPU';
  await r.tap('DF51AA39');
  r.spin(10, 0);
  await r.key('1', 1000);
  eq('admin() during the spin waits in the UART buffer', r.admin('PING'), []);
  let got = null;
  r.sim.adminAsync('LIST').then(v => { got = v; });
  await r.run(9000);
  const pings = r.serial.filter(l => l.text.indexOf('#OK PING') === 0);
  eq('queued PING answered after the round', pings.slice(-1)[0] && pings.slice(-1)[0].text, '#OK PING v11 slots=31 used=1 sound=0 session=0');
  eq('adminAsync resolves with the LIST reply', got, ['#ROW 0 DF51AA39 1 110 10 0', '#OK LIST 1']);
}

async function suiteDebugLog() {
  current = 'debug log';
  const r = rig({ sim: { debugLog: true } });
  await r.boot();
  const texts = () => r.serial.filter(l => l.dir === 'rx').map(l => l.text);
  const has = (re, label) => check(label || String(re), texts().some(t => re.test(t)), texts().slice(-30));
  eq('boot starts with an empty line', texts()[0], '');
  has(/^\[0 ms\] BOOT \| Mini Casino v11 \| 115200 Baud \| OLED I2C A4\/A5$/);
  has(/^\[0 ms\] MODUS \| Konten im EEPROM\. Karte nur als Ausweis, Spiel ueber Tasten\.$/);
  has(/^\[\d+ ms\] UID-LISTE \| Bereit: Uno fuehrt bis zu 31 Konten dauerhaft\.$/);
  has(/^\[\d+ ms\] TON \| Ton laut \| Taste C schaltet weiter: laut, leise, aus\.$/);
  has(/^\[\d+ ms\] LCD \| Mini Casino \/ Starte Reader\.\.\.$/);
  has(/^\[\d+ ms\] RFID \| Firmware=0x88$/);
  has(/^\[\d+ ms\] LCD \| Bitte Karte \/ auflegen$/);
  await r.tap('DF51AA39');
  has(/^\[\d+ ms\] SCAN \| 1$/);
  has(/^\[\d+ ms\] WUPA \| Status=0$/);
  has(/^\[\d+ ms\] SELECT UID \| Status=0$/);
  has(/^\[\d+ ms\] UID \| DF 51 AA 39$/);
  has(/^\[\d+ ms\] TYPE \| SAK=0x08$/);
  has(/^\[\d+ ms\] UID-LISTE \| Neue UID dauerhaft registriert\.$/);
  has(/^\[\d+ ms\] KONTO \| Einmaliges Startguthaben gutgeschrieben\.$/);
  has(/^\[\d+ ms\] LCD \| Neu aufgeladen! \/ $/);
  has(/^\[\d+ ms\] GUTHABEN \| Neu gespeichert und geprueft: 100$/);
  has(/^\[\d+ ms\] LCD \| Guthaben 100 \/ Einsatz 10$/);
  has(/^\[\d+ ms\] ENDE \| Karte kann weg\. Gespielt wird ueber die Tasten\.$/);
  r.spin(10, 0);
  await r.key('1', 9000);
  has(/^\[\d+ ms\] SPIEL \| Wahl=SCHWARZ Ergebnis=SCHWARZ Einsatz=10 Auszahlung=20 Guthaben=110$/);
  has(/^\[\d+ ms\] SOUND \| WIN: Level-up\.$/);
  await r.key('C', 800);
  has(/^\[\d+ ms\] TON \| Ton leise \| im EEPROM gespeichert\.$/);
  await r.run(6000);
  has(/^\[\d+ ms\] LIVE \| ReaderBereit=1 Abfragen=\d+ REQA-Timeouts=\d+ Scans=\d+ Erkennungsfehler=0 Firmware=0x88$/);
  await r.keys('A20');
  await r.key('#', 800);
  has(/^\[\d+ ms\] EINSATZ \| 20 Punkte, beim Konto gespeichert\.$/);
  await r.key('B');
  await r.key('#', 800);
  has(/^\[\d+ ms\] SITZUNG \| Von Hand abgemeldet\.$/);
  r.sim.setDebugLog(false);
  const n = r.serial.length;
  await r.tap('DF51AA39');
  eq('debug off: silent again', r.serial.length, n);
}

async function suiteHardware() {
  current = 'no reader';
  let r = rig({ sim: { reader: false } });
  await r.boot();
  r.expect('RFID fehlt', 'RFID fehlt', 'Kabel pruefen', '');
  await r.tap('DF51AA39');
  r.expect('cards are not read', 'RFID fehlt', 'Kabel pruefen', '');
  await r.key('D');
  r.expect('keys still work', '1 Schwarz  2 Rot', '3 Gruen', 'D=weiter  *=Ende');
  eq('admin still works', r.admin('PING'), ['#OK PING v11 slots=31 used=0 sound=0 session=-1']);

  current = 'persistence';
  const store = {};
  r = rig({ store });
  await r.boot();
  await r.tap('DF51AA39');
  await r.key('C', 800);
  r.spin(10, 0);
  await r.key('1', 9000);
  check('EEPROM saved to localStorage', typeof store['mc11.eeprom'] === 'string', Object.keys(store));
  const r2 = rig({ store });
  await r2.boot();
  eq('accounts survive a reload', r2.admin('LIST'), ['#ROW 0 DF51AA39 1 110 10 0', '#OK LIST 1']);
  eq('sound level survives (options byte)', r2.admin('PING'), ['#OK PING v11 slots=31 used=1 sound=1 session=-1']);
  r2.sim.reboot();
  await r2.run(400);
  r2.expect('reset button: the OLED keeps its picture during Optiboot', 'Bitte Karte', 'auflegen', 'D = Hilfe');
  await r2.run(1500);
  eq('rebooted', r2.sim.state().booted, true);
  r2.sim.reset();
  await r2.run(1500);
  eq('reset() wipes the EEPROM', r2.admin('LIST'), ['#OK LIST 0']);

  current = 'audio without AudioContext';
  const MC = r.MC;
  eq('MC.Audio.supported', MC.Audio.supported, false);
  eq('tone() is a no-op', MC.Audio.tone(440, 50, 0), false);
  let resolved = false;
  MC.Audio.play([[440, 5, 0]]).then(() => { resolved = true; });
  const ok = await MC.Audio.unlock();
  await new Promise(res => setTimeout(res, 30));
  check('unlock() resolves false, play() resolves', ok === false && resolved, { ok, resolved });

  current = 'oled port';
  const o = new MC.Oled({ emit: false });
  o.powerOn(false);
  o.begin();
  o.setCursor(0, 0); o.print('Guthaben'); o.print(1234); o.write(0); o.write(255);
  o.setCursor(14, 1); o.print('abcdef');
  o.hinweis('0123456789ABCDEFGH'); o.hinweisAktualisieren();
  eq('16 columns, clipped on the right', o.lines(), ['Guthaben1234€█  ', '              ab']);
  eq('framebuffer decodes to the same text', (d => [d.title, d.line0, d.line1, d.hint])(o.decode()),
    ['  MINI  CASINO  ', 'Guthaben1234€█  ', '              ab', '0123456789ABCDEF']);
  o.setCursor(0, 1); o.print('ä');
  eq('non-ASCII prints as ? (UTF-8 bytes)', o.lines()[1].slice(0, 3), '?? ');
  const fbBits = Array.from(o.fb).reduce((a, b) => a + b, 0);
  check('framebuffer has lit pixels', fbBits > 500, fbBits);
  // euro glyph: bit 7 = left column, doubled vertically
  const e = [];
  for (let y = 16; y < 32; y += 2) { let row = ''; for (let x = 96; x < 104; x++) row += o.fb[y * 128 + x] ? '#' : '.'; e.push(row); }
  eq('euro glyph rows', e, ['...###..', '..#.....', '.####...', '..#.....', '.####...', '..#.....', '...###..', '........']);
}

// A main thread that is blocked for `chunk` ms at a time (heavy 3D frames on a slow phone):
// timers only run at the end of each block, all late.
class JankyClock {
  constructor(t, chunk) { this.t = t; this.chunk = chunk; this.q = []; this.seq = 0; }
  now() { return this.t; }
  setTimeout(fn, ms) { const id = ++this.seq; this.q.push({ at: this.t + Math.max(0, +ms || 0), id, fn }); return id; }
  clearTimeout(id) { const i = this.q.findIndex(e => e.id === id); if (i >= 0) this.q.splice(i, 1); }
  async advance(ms) {
    const end = this.t + ms;
    while (this.t < end) {
      this.t = Math.min(end, this.t + this.chunk);
      for (;;) {
        this.q.sort((a, b) => a.at - b.at || a.id - b.id);
        if (!this.q.length || this.q[0].at > this.t) break;
        this.q.shift().fn();
        await new Promise(r => setImmediate(r));
      }
      await new Promise(r => setImmediate(r));
    }
  }
}

async function suiteJank() {
  current = 'busy main thread (timers 400 ms late)';
  const r = rig({ clock: c => new JankyClock(1000, 400) });
  await r.boot();
  r.expect('boots', 'Bitte Karte', 'auflegen', 'D = Hilfe');
  await r.tap('DF51AA39', 2000);
  r.expect('card read', 'Guthaben    100€', 'Einsatz      10€', '1-3 setzen  D=?');
  r.spin(10, 0);
  const t0 = r.clock.now();
  r.sim.pressKey('1');   // 100 ms press, shorter than one blocked chunk
  let end = 0;
  r.MC.bus.on('sim:busy', b => { if (!b && !end) end = r.clock.now(); });
  await r.run(8000);
  eq('the short press is not lost', r.spins(), 1);
  r.expect('round result', 'Gewinn      +10€', 'Guthaben    110€', '1-3 nochmal');
  await r.run(4000);
  check('the round keeps the firmware timing (ends within one blocked chunk of ~6 s)', end - t0 > 5000 && end - t0 < 7200, { ms: end - t0 });
  await r.keys('A50#', 400);
  await r.run(1000);
  r.expect('typing four keys in a row works', 'Guthaben    110€', 'Einsatz      50€', '1-3 setzen  D=?');
}

async function suiteBuildOptions() {
  current = 'CASINO_SIM build';
  let r = rig({ sim: { config: { CASINO_SIM: 1 } } });
  await r.boot();
  check('boot screen Mini Casino v11 / Karte auflegen', r.saw(0, 'Mini Casino v11', 'Karte auflegen'), r.frames.slice(0, 40));
  r.expect('idle', 'Bitte Karte', 'auflegen', 'D = Hilfe');
  await r.tap('0BADCAFE');
  r.expect('only the four SIM cards exist', 'Bitte Karte', 'auflegen', 'D = Hilfe');
  await r.tap('049F905C110189');
  r.expect('SIM button for the 7-byte card', 'Guthaben    100€', 'Einsatz      10€', '1-3 setzen  D=?');
  eq('LIST', r.admin('LIST'), ['#ROW 0 049F905C110189 1 100 10 0', '#OK LIST 1']);

  current = 'CASINO_SOUND_MODE 0, CASINO_EURO 0';
  r = rig({ sim: { config: { CASINO_SOUND_MODE: 0, CASINO_EURO: 0 } } });
  await r.boot();
  let m = r.mark();
  await r.tap('DF51AA39');
  check('Neu aufgeladen! / 100 Pkt', r.saw(m, 'Neu aufgeladen!', '100 Pkt'), null);
  r.expect('Pkt instead of the euro sign', 'Guthaben 100 Pkt', 'Einsatz   10 Pkt', '1-3 setzen  D=?');
  const n = r.sounds.length;
  await r.key('C');
  r.expect('C without a buzzer', 'Kein Buzzer', 'eingebaut', '');
  await r.run(5200);
  r.spin(10, 0);
  await r.key('1', 9000);
  r.expect('round without sound', 'Gewinn   +10 Pkt', 'Guthaben 110 Pkt', '1-3 nochmal');
  eq('nothing played at all', r.sounds.length, n);

  current = 'CASINO_SOUND_MODE 2 (active buzzer)';
  r = rig({ sim: { config: { CASINO_SOUND_MODE: 2 } } });
  await r.boot();
  await r.tap('DF51AA39');
  await r.key('C', 800);
  r.expect('laut -> aus, no leise', 'Ton aus', 'gespeichert', 'C = weiter');
  await r.key('C', 800);
  r.expect('aus -> laut', 'Ton laut', 'gespeichert', 'C = weiter');
  const beep = r.sounds.slice(-1)[0];
  check('an active buzzer only knows its own tone', beep && beep.notes.every(x => x[0] === 2300), beep);

  current = 'radio errors';
  r = rig({ sim: { rfErrorRate: 1, debugLog: true } });
  await r.boot();
  r.sim.placeCard('DF51AA39');
  await r.run(1500);
  r.expect('three failed scans in a row', 'Karte ruhig', 'auflegen', '');
  check('RF RECOVERY logged', r.serial.some(l => / RF RECOVERY \| Drei weitere Erkennungsfehler; Antennenfeld kurz neu starten\.$/.test(l.text)), null);
  r.sim.removeCard();
  await r.run(5500);
  r.expect('idle again', 'Bitte Karte', 'auflegen', 'D = Hilfe');

  current = 'foreign EEPROM';
  const foreign = {};
  foreign['mc11.eeprom'] = JSON.stringify('12'.repeat(1024));   // MC.storage keeps JSON
  r = rig({ store: foreign });
  await r.boot();
  eq('accounts locked: nothing listed', r.admin('LIST'), ['#OK LIST 0']);
  await r.tap('DF51AA39');
  r.expect('UID-Liste Fehler', 'UID-Liste Fehler', 'Siehe Log', '');
  await r.run(5200);
  await r.key('C', 800);
  r.expect('sound level not stored', 'Ton leise', 'nur bis Reset', 'C = weiter');
  eq('ADD refused', r.admin('ADD 0BADCAFE 5'), ['#ERR Liste gesperrt']);
  eq('the foreign data stays untouched', foreign['mc11.eeprom'], JSON.stringify('12'.repeat(1024)));
}

async function rules() {
  current = 'rules';
  const r = rig();
  const R = r.MC.Rules;
  const doms = JSON.parse(fs.readFileSync(0, 'utf8'));
  for (const name of Object.keys(doms)) {
    const f = R[name];
    const vals = doms[name].map(args => { const v = f.apply(R, args); return typeof v === 'boolean' ? (v ? 1 : 0) : v; });
    out({ t: 'rules', name, values: vals });
  }
}

(async () => {
  try {
    await rules();
    const r = await suiteBootAndIdle();
    await suiteGame(r);
    await suiteMoney(r);
    await suiteAdmin(r);
    await suiteDebugLog();
    await suiteHardware();
    await suiteBuildOptions();
    await suiteJank();
  } catch (e) {
    out({ t: 'check', name: current + ': exception', ok: false, detail: String(e && e.stack || e) });
  }
  out({ t: 'done' });
  process.exit(0);
})();
"""


def run_node(domains: dict):
    node = shutil.which('node')
    if not node:
        record('(c)', 'node is installed', False, 'node not found on PATH')
        return None
    env = dict(os.environ, MC_VIEWER=str(VIEWER))
    with tempfile.TemporaryDirectory() as tmp:
        script = Path(tmp) / 'harness.js'
        script.write_text(HARNESS, encoding='utf-8')
        proc = subprocess.run([node, str(script)], input=json.dumps(domains), capture_output=True, text=True,
                              encoding='utf-8', env=env, timeout=600)
    lines = []
    for raw in proc.stdout.splitlines():
        try:
            lines.append(json.loads(raw))
        except json.JSONDecodeError:
            lines.append({'t': 'check', 'name': 'harness output', 'ok': False, 'detail': raw[:300]})
    if proc.returncode != 0 or not any(l.get('t') == 'done' for l in lines):
        record('(c)', 'harness ran to the end', False, (proc.stderr or '')[-2000:])
    return lines


def check_rules(lines, domains: dict, data: dict) -> None:
    rules_h = bvd.strip_comments((ROOT / 'MiniCasino' / 'GameRules.h').read_text(encoding='utf-8'))
    sounds_h = bvd.strip_comments((ROOT / 'MiniCasino' / 'GameSounds.h').read_text(encoding='utf-8'))
    norm = lambda s: re.sub(r'\s+', ' ', s)
    missing = [e for e in C_EXPRESSIONS if norm(e) not in norm(rules_h)]
    record('(d)', 'GameRules.h still has the expressions the ports mirror', not missing, 'changed: ' + '; '.join(missing))
    record('(d)', 'GameSounds.h effectForChoice unchanged', norm(C_SOUND_EXPRESSION) in norm(sounds_h), C_SOUND_EXPRESSION)
    py = PyRules(data['rules'])
    got = {l['name']: l['values'] for l in lines or [] if l.get('t') == 'rules'}
    for name, args in domains.items():
        want = [int(v) if isinstance(v, bool) else v for v in (getattr(py, name)(*a) for a in args)]
        js = got.get(name)
        if js is None:
            record('(d)', f'{name}: JS values', False, 'no output from node')
            continue
        bad = next((i for i, (a, b) in enumerate(zip(js, want)) if a != b), None)
        ok = bad is None and len(js) == len(want)
        record('(d)', f'{name}: JS == Python over {len(args)} inputs', ok,
               '' if ok else f'first difference at {name}{tuple(args[bad])}: js={js[bad]} py={want[bad]}' if bad is not None else 'length differs')
    avr_cross_check(py, domains)


def avr_cross_check(py: PyRules, domains: dict) -> None:
    base = Path(os.environ.get('LOCALAPPDATA', '')) / 'Arduino15' / 'packages' / 'arduino' / 'tools' / 'avr-gcc'
    cands = sorted(glob.glob(str(base / '*' / 'bin' / 'avr-g++.exe')) + glob.glob(str(base / '*' / 'bin' / 'avr-g++')))
    if not cands:
        record('(d)', 'avr-g++ cross-check (skipped: Arduino AVR toolchain not found)', True)
        return
    gpp = cands[-1]
    lines = ['#define __STDC_LIMIT_MACROS', '#include <stdint.h>', '#include "GameRules.h"', 'using namespace Casino;']
    picks = {
        'spinSteps': [(s, r) for s in range(0, 256, 7) for r in range(0, 256, 9)] + [(0, 0), (2, 1), (255, 0)],
        'spinLed': [(s, t) for s in (0, 1, 2, 200) for t in range(0, 256, 5)],
        'spinDelay': [(s, c) for c in (0, 2, 3, 24, 25, 26, 100, 255) for s in range(0, 256, 3)],
        'colourForTicket': [(t,) for t in range(256)],
        'payout': [(c, r, s) for c in range(4) for r in range(4) for s in (0, 10, 50, 2550, 477218589, U32_MAX)],
        'canPlay': [(b, c, s) for b in (0, 9, 10, 100, 2550, U32_MAX - 80, U32_MAX - 79, U32_MAX - 10, U32_MAX - 9, U32_MAX)
                    for c in range(4) for s in (5, 10, 50, 2550, 2560)],
        'stakeLimit': [(b,) for b in (0, 9, 10, 11, 99, 100, 155, 2549, 2550, 2551, 25500, U32_MAX)],
        'checkStake': [(v, l) for v in (0, 5, 9, 10, 15, 55, 100, 110, 2550, 2560, 9999) for l in (10, 100, 150, 2550, U32_MAX)],
        'settled': [(d, c, r, s) for d in (0, 90, U32_MAX - 90) for c in range(3) for r in range(3) for s in (10, 50)],
    }
    count = 0
    for name, args in picks.items():
        for a in args:
            want = getattr(py, name)(*a)
            if isinstance(want, bool):
                want = 'true' if want else 'false'
            else:
                want = f'{want}UL'
            call = f'{name}(' + ', '.join(f'{x}UL' for x in a) + ')'
            lines.append(f'static_assert({call} == {want}, "{name}{a}");')
            count += 1
    with tempfile.TemporaryDirectory() as tmp:
        src = Path(tmp) / 'rules_check.cpp'
        src.write_text('\n'.join(lines) + '\n', encoding='utf-8')
        proc = subprocess.run([gpp, '-std=gnu++14', '-mmcu=atmega328p', '-fsyntax-only', '-Wno-overflow',
                               f'-I{ROOT / "MiniCasino"}', str(src)], capture_output=True, text=True)
    err = (proc.stderr or '').strip().splitlines()
    record('(d)', f'avr-g++ evaluates GameRules.h like the Python port ({count} constexpr asserts)', proc.returncode == 0,
           '\n'.join(err[:12]))


# ============================================================================ main
def main() -> int:
    try:
        data = check_generated()
    except bvd.FirmwareError as e:
        record('(a)', 'firmware extraction', False, str(e))
        data = None
    if data:
        check_strings(data)
        domains = rule_domains()
        lines = run_node(domains)
        if lines is not None:
            for l in lines:
                if l.get('t') == 'check':
                    detail = l.get('detail')
                    record('(c)', l['name'], l['ok'], json.dumps(detail, ensure_ascii=False)[:1500] if detail is not None else '')
        check_rules(lines, domains, data)

    failed = [r for r in RESULTS if not r[1]]
    width = 100
    for name, ok, detail in RESULTS:
        if not ok:
            print(f'FAIL  {name}'[:width])
            if detail:
                for d in str(detail).splitlines()[:20]:
                    print('      ' + d)
    sections = {}
    for name, ok, _ in RESULTS:
        sec = name.split(' ', 1)[0]
        a, b = sections.get(sec, (0, 0))
        sections[sec] = (a + (1 if ok else 0), b + 1)
    print()
    for sec in sorted(sections):
        a, b = sections[sec]
        label = {'(a)': 'generated data', '(b)': 'firmware strings', '(c)': 'scripted sessions', '(d)': 'game rules'}.get(sec, sec)
        print(f'{sec} {label:20s} {a:4d}/{b:<4d} {"PASS" if a == b else "FAIL"}')
    print(f'\n{"PASS" if not failed else "FAIL"}: {len(RESULTS) - len(failed)} of {len(RESULTS)} checks passed')
    return 1 if failed else 0


if __name__ == '__main__':
    sys.exit(main())
