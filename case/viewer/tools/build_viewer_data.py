#!/usr/bin/env python3
"""Extract the firmware data the viewer needs into case/viewer/data/firmware.js.

The firmware in MiniCasino/ is the only source of truth and is only read here. The script writes
`window.MC_FW` (a classic script, works from file://): the OLED font OLED_SCHRIFT (Chroma48, CC0)
and the euro glyph, the title bar, every string the firmware puts on the display, the serial log
and admin protocol texts, the sound tables, the tone parameters, the rule constants and timings,
the four SIM UIDs and the keypad mapping.

    python case/viewer/tools/build_viewer_data.py            # (re)write data/firmware.js
    python case/viewer/tools/build_viewer_data.py --check    # exit 1 if data/firmware.js is stale

Standard library only. Every pattern that is not found stops the script with a clear message, so a
changed firmware never produces a silently wrong viewer.
"""
from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path

VIEWER = Path(__file__).resolve().parents[1]
ROOT = VIEWER.parents[1]
FIRMWARE = ROOT / 'MiniCasino'
OUT = VIEWER / 'data' / 'firmware.js'

# ATmega328P: E2END = 0x3FF, i.e. 1024 bytes of EEPROM (hardware constant, not in the sketch).
EEPROM_BYTES = 1024


class FirmwareError(RuntimeError):
    pass


# --------------------------------------------------------------------------- C source helpers
def strip_comments(src: str) -> str:
    """Remove // and /* */ comments, keep string and char literals untouched."""
    out, i, n = [], 0, len(src)
    while i < n:
        c = src[i]
        if c in '"\'':
            j = i + 1
            while j < n and src[j] != c:
                j += 2 if src[j] == '\\' else 1
            out.append(src[i:j + 1])
            i = j + 1
        elif src.startswith('//', i):
            j = src.find('\n', i)
            i = n if j < 0 else j
        elif src.startswith('/*', i):
            j = src.find('*/', i + 2)
            i = n if j < 0 else j + 2
            out.append(' ')
        else:
            out.append(c)
            i += 1
    return ''.join(out)


def c_string(literal: str) -> str:
    """Decode a C string/char literal body (only the escapes the firmware could use)."""
    body = literal[1:-1]
    return re.sub(r'\\(.)', lambda m: {'n': '\n', 't': '\t', '0': '\0'}.get(m.group(1), m.group(1)), body)


TOKEN = re.compile(r'''\s+|(?P<str>"(?:\\.|[^"\\])*")|(?P<chr>'(?:\\.|[^'\\])*')|(?P<id>[A-Za-z_]\w*)'''
                   r'''|(?P<num>\d[\w.]*)|(?P<op>::|->|.)''', re.S)


def tokens(src: str):
    for m in TOKEN.finditer(src):
        kind = m.lastgroup
        if kind:
            yield kind, m.group(kind)


def string_uses(path: Path):
    """Every string/char literal with its context: (literal, kind, callee, function, statement).

    callee is the innermost named call around the literal, skipping the F() wrapper and plain
    parentheses ('meldung', 'anzeige.print', 'Serial.println', 'strcmp', ...). function is the
    function definition the literal sits in. statement is the first token of the statement.
    """
    src = strip_comments(path.read_text(encoding='utf-8'))
    toks = list(tokens(src))
    uses = []
    stack = []            # one entry per open '(' : callee name or None
    brace = 0
    function = None
    pending_function = None
    statement = None
    last_closed = None    # callee of the last ')' at paren depth 0
    for i, (kind, text) in enumerate(toks):
        if statement is None and kind != 'op':
            statement = text
        if kind == 'op' and text == '(':
            name = None
            j = i - 1
            if j >= 0 and toks[j][0] == 'id':
                name = toks[j][1]
                while j >= 2 and toks[j - 1][1] in ('.', '::', '->') and toks[j - 2][0] == 'id':
                    name = toks[j - 2][1] + ('.' if toks[j - 1][1] != '::' else '::') + name
                    j -= 2
            stack.append(name)
        elif kind == 'op' and text == ')':
            last_closed = stack.pop() if stack else None
        elif kind == 'op' and text == '{':
            if brace == 0 and not stack:
                pending_function = last_closed
                function = pending_function
            brace += 1
            statement = None
        elif kind == 'op' and text == '}':
            brace = max(0, brace - 1)
            if brace == 0:
                function = None
            statement = None
        elif kind == 'op' and text == ';' and not stack:
            statement = None
        elif kind in ('str', 'chr'):
            callee = None
            for name in reversed(stack):
                if name and name != 'F':
                    callee = name
                    break
            wrapped = bool(stack) and stack[-1] == 'F'
            uses.append({'value': c_string(text), 'kind': 'F' if wrapped else kind,
                         'callee': callee, 'function': function, 'statement': statement,
                         'file': path.name})
    return uses


def need(pattern: str, text: str, what: str, flags=re.S):
    m = re.search(pattern, text, flags)
    if not m:
        raise FirmwareError(f'not found in firmware: {what} (pattern {pattern!r})')
    return m


def number(text: str) -> int:
    text = text.strip()
    m = re.fullmatch(r'(0x[0-9A-Fa-f]+|\d+)[uUlL]*', text)
    if not m:
        raise FirmwareError(f'not a number: {text!r}')
    return int(m.group(1), 0)


def byte_table(src: str, name: str, count: int):
    m = need(rf'{name}\s*\[[^\]]*\]\s*PROGMEM\s*=\s*\{{(.*?)\}};', src, name)
    values = [int(v, 16) for v in re.findall(r'0x([0-9A-Fa-f]{2})', m.group(1))]
    if len(values) != count:
        raise FirmwareError(f'{name}: expected {count} bytes, found {len(values)}')
    return values


# --------------------------------------------------------------------------- extraction
DISPLAY_CALLS = {'meldung', 'anzeige.print', 'anzeige.hinweis', 'anzeige.write', 'zeileWert', 'einsatzAnzeigen'}
DISPLAY_RETURNS = {'farbe', 'stufenName'}
LOG_CALLS = {'logText', 'logKopf', 'logStatus', 'logBytes', 'Serial.print', 'Serial.println'}


def unique(seq):
    seen, out = set(), []
    for s in seq:
        if s not in seen:
            seen.add(s)
            out.append(s)
    return out


def classify(uses):
    display, display_chars, log, admin_replies, admin_errors, admin_words = [], [], [], [], [], []
    for u in uses:
        v, callee, fn, f = u['value'], u['callee'], u['function'], u['file']
        if f == 'AdminSerial.h':
            if callee == 'adminFehler':
                admin_errors.append(v)
            elif callee in ('Serial.print', 'Serial.println') and u['kind'] == 'F':
                admin_replies.append(v)
            elif callee == 'strcmp':
                admin_words.append(v)
            continue
        if u['kind'] == 'F' and (callee in DISPLAY_CALLS or (callee is None and fn in DISPLAY_RETURNS
                                                              and u['statement'] == 'return')):
            display.append(v)
        elif u['kind'] == 'chr' and callee in ('anzeige.print', 'anzeige.write') and v != ' ':
            display_chars.append(v)
        elif u['kind'] == 'F' and callee in LOG_CALLS:
            log.append(v)
    return {
        'display': unique(s for s in display if s != ''),
        'displayChars': unique(display_chars),
        'log': unique(s for s in log if s != ''),
        'adminReplies': unique(admin_replies),
        'adminErrors': unique(admin_errors),
        'adminWords': unique(admin_words),
    }


def extract() -> dict:
    files = {name: (FIRMWARE / name) for name in
             ('MiniCasino.ino', 'GameRuntime.h', 'GameRules.h', 'GameSounds.h', 'OledText.h',
              'AdminSerial.h', 'UidRegistry.h', 'Rc522.h')}
    for p in files.values():
        if not p.exists():
            raise FirmwareError(f'missing firmware file {p}')
    raw = {k: p.read_text(encoding='utf-8') for k, p in files.items()}
    src = {k: strip_comments(v) for k, v in raw.items()}
    ino, rt, rules_h, snd, oled, adm, reg = (src['MiniCasino.ino'], src['GameRuntime.h'], src['GameRules.h'],
                                             src['GameSounds.h'], src['OledText.h'], src['AdminSerial.h'],
                                             src['UidRegistry.h'])

    # ---- build configuration (#define defaults in MiniCasino.ino)
    config = {}
    for name in ('CASINO_SOUND_MODE', 'CASINO_NACHLADEN', 'CASINO_EEPROM_LOESCHEN', 'CASINO_EURO',
                 'CASINO_OLED_SSD1306', 'CASINO_SIM'):
        config[name] = number(need(rf'#define\s+{name}\s+(\w+)', ino, name).group(1))
    config['DEBUG_LOG'] = need(r'const\s+bool\s+DEBUG_LOG\s*=\s*(true|false)\s*;', ino, 'DEBUG_LOG').group(1) == 'true'
    config['LOG_BAUD'] = number(need(r'LOG_BAUD\s*=\s*([^;]+);', ino, 'LOG_BAUD').group(1))

    # ---- OLED
    font = byte_table(oled, 'OLED_SCHRIFT', 95 * 8)
    euro = byte_table(oled, 'OLED_EURO', 8)
    title = c_string(need(r'const\s+char\s*\*\s*titel\s*=\s*("(?:\\.|[^"\\])*")', oled, 'title').group(1))
    if len(title) != 16:
        raise FirmwareError(f'title must be 16 characters, is {len(title)}')
    oled_begin_ms = number(need(r'void\s+begin\s*\(\s*\)\s*\{\s*delay\((\d+)\)', oled, 'OledText::begin delay').group(1))

    # ---- rules (GameRules.h) and timings (MiniCasino.ino, GameRuntime.h)
    rules = {}
    for name in ('STAKE', 'STAKE_SCHRITT', 'STAKE_MAX', 'BLACK_PERCENT', 'RED_PERCENT', 'GREEN_PERCENT'):
        rules[name] = number(need(rf'constexpr\s+uint\d+_t\s+{name}\s*=\s*([^;]+);', rules_h, name).group(1))
    for name in ('STARTGUTHABEN', 'ANZEIGEDAUER_MS', 'SCAN_PAUSE_MS', 'FEHLER_PAUSE_MS', 'SCAN_VERSUCHE', 'SITZUNG_MS'):
        rules[name] = number(need(rf'const\s+[\w ]+?\s+{name}\s*=\s*([^;]+);', ino, name).group(1))
    rules['MODUS_MS'] = number(need(r'const\s+unsigned\s+long\s+MODUS_MS\s*=\s*([^;]+);', rt, 'MODUS_MS').group(1))
    rules['ENTPRELL_MS'] = number(need(r'now\s*-\s*tasteSeit\s*<\s*(\w+)', rt, 'debounce time').group(1))
    rules['ABFRAGE_MS'] = number(need(r'millis\(\)\s*-\s*letzteAbfrage\s*<\s*(\w+)', ino, 'poll interval').group(1))
    rules['LEBENSZEICHEN_MS'] = number(need(r'millis\(\)\s*-\s*letzterLog\s*<\s*(\w+)', ino, 'LIVE interval').group(1))
    rules['SIM_ENTPRELL_MS'] = number(need(r'millis\(\)\s*-\s*simEntprellt\s*<\s*(\w+)', ino, 'SIM debounce').group(1))
    rules['OLED_BEGIN_MS'] = oled_begin_ms
    rules['ADMIN_MAX'] = number(need(r'const\s+byte\s+ADMIN_MAX\s*=\s*(\d+)\s*;', adm, 'ADMIN_MAX').group(1))
    entry = number(need(r'EINTRAG\s*=\s*(\d+)', reg, 'UidRegistry EINTRAG').group(1))
    header = need(r"header\[16\]\s*=\s*\{'M','C','U','I','D','0','(\d)'", reg, 'EEPROM header').group(1)
    rules['slots'] = (EEPROM_BYTES - 16) // entry
    if rules['BLACK_PERCENT'] + rules['RED_PERCENT'] + rules['GREEN_PERCENT'] != 100:
        raise FirmwareError('odds do not add up to 100')

    # ---- sounds (GameSounds.h) and tones (GameRuntime.h)
    sounds = {}
    for key, name in (('win', 'WIN_SOUND'), ('loss', 'LOSS_SOUND'), ('jackpot', 'JACKPOT_SOUND')):
        body = need(rf'{name}\s*\[\]\s*SOUND_STORAGE\s*=\s*\{{(.*?)\}};', snd, name).group(1)
        sounds[key] = [[int(a), int(b), int(c)] for a, b, c in re.findall(r'\{\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*\}', body)]
        if not sounds[key]:
            raise FirmwareError(f'{name} is empty')
    klick = need(r'void\s+tonKlick\s*\(\s*\)\s*\{\s*tonSpiele\(\s*(\d+)\s*,\s*(\d+)\s*\)', rt, 'tonKlick')
    fehler = need(r'void\s+tonFehler\s*\(\s*\)\s*\{\s*tonSpiele\(\s*(\d+)\s*,\s*(\d+)\s*\)', rt, 'tonFehler')
    quitt = need(r'void\s+tonQuittung\s*\([^)]*\)\s*\{\s*for\s*\(\s*byte\s+i\s*=\s*0\s*;\s*i\s*<\s*(\d+)\s*;\s*\+\+i\s*\)'
                 r'\s*\{\s*tonSpiele\(\s*hz\s*,\s*(\d+)\s*\)\s*;\s*delay\(\s*(\d+)\s*\)', rt, 'tonQuittung')
    tick = need(r'tonSpiele\(\s*(\d+)\s*\+\s*index\s*\*\s*(\d+)\s*,\s*(\d+)\s*\)', rt, 'spin tick')
    duty = need(r'tonStufe\s*==\s*TON_LEISE\s*\?\s*periode\s*/\s*(\d+)\s*:\s*periode\s*/\s*(\d+)', rt, 'tone duty')
    min_on = need(r'if\s*\(\s*an\s*<\s*(\d+)\s*\)', rt, 'minimum pulse')
    q_einsatz = need(r'void\s+einsatzUebernehmen\s*\(\s*\)\s*\{.*?tonQuittung\(\s*(\d+)\s*\)', rt, 'tonQuittung in einsatzUebernehmen')
    q_abmelden = need(r"taste\s*==\s*'#'\s*\)\s*\{\s*tonQuittung\(\s*(\d+)\s*\)", rt, 'tonQuittung in abmeldenTaste')
    q_ton = need(r'tonQuittung\(\s*tonStufe\s*==\s*TON_AUS\s*\?\s*(\d+)\s*:\s*(\d+)\s*\)', rt, 'tonQuittung in tonStufeWeiter')
    tones = {
        'klick': [int(klick.group(1)), int(klick.group(2))],
        'fehler': [int(fehler.group(1)), int(fehler.group(2))],
        'quittung': {'count': int(quitt.group(1)), 'ms': int(quitt.group(2)), 'gap': int(quitt.group(3)),
                     'einsatz': int(q_einsatz.group(1)), 'abmelden': int(q_abmelden.group(1)),
                     'tonAus': int(q_ton.group(1)), 'tonAn': int(q_ton.group(2))},
        'tick': {'base': int(tick.group(1)), 'step': int(tick.group(2)), 'ms': int(tick.group(3))},
        'leiseTeiler': int(duty.group(1)), 'lautTeiler': int(duty.group(2)), 'minAnUs': int(min_on.group(1)),
        'pin': 'D' + need(r'const\s+byte\s+TON_PIN\s*=\s*(\d+)', rt, 'TON_PIN').group(1),
    }

    # ---- SIM UIDs (MiniCasino.ino)
    lens = [int(v) for v in re.findall(r'\d+', need(r'SIM_LEN\s*\[\s*4\s*\]\s*=\s*\{([^}]*)\}', ino, 'SIM_LEN').group(1))]
    rows = re.findall(r'\{([^{}]*)\}', need(r'SIM_UIDS\s*\[\s*4\s*\]\s*\[\s*7\s*\]\s*=\s*\{(.*?)\};', ino, 'SIM_UIDS').group(1))
    sim_uids = []
    for row, n in zip(rows, lens):
        b = [int(v, 16) for v in re.findall(r'0x([0-9A-Fa-f]{2})', row)]
        sim_uids.append(''.join(f'{x:02X}' for x in b[:n]))
    if len(sim_uids) != 4:
        raise FirmwareError('expected four SIM UIDs')

    # ---- keypad (GameRuntime.h)
    def pin_name(p):
        p = p.strip()
        return p if p.startswith('A') else f'D{int(p)}'
    keypad = {
        'rows': [pin_name(p) for p in need(r'KEYPAD_REIHEN\s*\[\s*4\s*\]\s*=\s*\{([^}]*)\}', rt, 'KEYPAD_REIHEN').group(1).split(',')],
        'cols': [pin_name(p) for p in need(r'KEYPAD_SPALTEN\s*\[\s*4\s*\]\s*=\s*\{([^}]*)\}', rt, 'KEYPAD_SPALTEN').group(1).split(',')],
        'chars': c_string(need(r'KEYPAD_ZEICHEN\s*\[\s*17\s*\]\s*=\s*("[^"]*")', rt, 'KEYPAD_ZEICHEN').group(1)),
    }
    if len(keypad['chars']) != 16:
        raise FirmwareError('keypad needs 16 characters')

    # ---- strings with their context
    uses = []
    for name in ('MiniCasino.ino', 'GameRuntime.h', 'AdminSerial.h'):
        uses += string_uses(files[name])
    strings = classify(uses)
    version = need(r'#OK PING (v\d+) ', adm, 'protocol version').group(1)
    rc_missing = [number(v) for v in need(r'if\s*\(\s*version\s*==\s*(0x[0-9A-Fa-f]+)\s*\|\|\s*version\s*==\s*(0x[0-9A-Fa-f]+)\s*\)',
                                          ino, 'RFID version check').groups()]

    return {
        'generator': 'case/viewer/tools/build_viewer_data.py',
        'firmware': version,
        'config': config,
        'title': title,
        'font': font,
        'euro': euro,
        'strings': strings['display'],
        'displayChars': strings['displayChars'],
        'log': strings['log'],
        'admin': {'commands': [w for w in strings['adminWords'] if w != 'JA'],
                  'confirm': 'JA' if 'JA' in strings['adminWords'] else None,
                  'replies': strings['adminReplies'], 'errors': strings['adminErrors']},
        'sounds': sounds,
        'tones': tones,
        'rules': rules,
        'eeprom': {'bytes': EEPROM_BYTES, 'format': '0' + header, 'entry': entry, 'slots': rules['slots']},
        'simUids': sim_uids,
        'keypad': keypad,
        'rfidMissing': rc_missing,
    }


# --------------------------------------------------------------------------- output
def js_value(v) -> str:
    return json.dumps(v, ensure_ascii=False, separators=(', ', ': '))


def render(data: dict) -> str:
    lines = [
        '/* Mini Casino V11: data extracted from the firmware (MiniCasino/*.h, MiniCasino.ino).',
        '   GENERATED by case/viewer/tools/build_viewer_data.py, do not edit by hand.',
        '   OLED font: "Chroma48 medium 8" from U8g2 (u8x8_font_chroma48medium8_r), CC0. */',
        'window.MC_FW = {',
    ]
    keys = list(data)
    for k_i, key in enumerate(keys):
        value = data[key]
        comma = ',' if k_i < len(keys) - 1 else ''
        if key == 'font':
            lines.append('  font: [')
            for c in range(95):
                row = ', '.join(f'0x{b:02X}' for b in value[c * 8:c * 8 + 8])
                ch = chr(32 + c)
                label = {'\\': 'backslash', ' ': 'space'}.get(ch, ch)
                end = ',' if c < 94 else ''
                lines.append(f'    {row}{end}  // {label}')
            lines.append('  ]' + comma)
        elif key == 'euro':
            lines.append('  euro: [' + ', '.join(f'0x{b:02X}' for b in value) + ']' + comma)
        elif key in ('strings', 'log'):
            lines.append(f'  {key}: [')
            for s_i, s in enumerate(value):
                lines.append('    ' + js_value(s) + (',' if s_i < len(value) - 1 else ''))
            lines.append('  ]' + comma)
        elif isinstance(value, dict):
            lines.append(f'  {key}: {{')
            items = list(value.items())
            for i_i, (k, v) in enumerate(items):
                kk = k if re.fullmatch(r'[A-Za-z_]\w*', k) else js_value(k)
                lines.append(f'    {kk}: {js_value(v)}' + (',' if i_i < len(items) - 1 else ''))
            lines.append('  }' + comma)
        else:
            lines.append(f'  {key}: {js_value(value)}' + comma)
    lines.append('};')
    return '\n'.join(lines) + '\n'


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.split('\n\n')[0])
    ap.add_argument('--check', action='store_true', help='only compare, do not write')
    args = ap.parse_args()
    try:
        text = render(extract())
    except FirmwareError as e:
        print(f'build_viewer_data: {e}', file=sys.stderr)
        return 1
    current = OUT.read_text(encoding='utf-8') if OUT.exists() else None
    if args.check:
        if current != text:
            print(f'{OUT.relative_to(ROOT)} is stale: run python case/viewer/tools/build_viewer_data.py')
            return 1
        print(f'{OUT.relative_to(ROOT)} is up to date')
        return 0
    OUT.parent.mkdir(parents=True, exist_ok=True)
    if current != text:
        OUT.write_text(text, encoding='utf-8', newline='\n')
        print(f'wrote {OUT.relative_to(ROOT)} ({len(text.encode("utf-8"))} bytes)')
    else:
        print(f'{OUT.relative_to(ROOT)} unchanged')
    return 0


if __name__ == '__main__':
    sys.exit(main())
