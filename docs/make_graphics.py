"""Generates every svg graphic of the readme and the schematic for the 3d viewer.

    python docs/make_graphics.py

Standard library only. Everything is read from the sources, nothing is typed twice:

* design tokens, nets, wire colours and the physical wires from case/viewer/js/core.js
* the oled font, the euro glyph and the title bar from MiniCasino/OledText.h
* keypad rows and columns from MiniCasino/GameRuntime.h, spin timing from GameRules.h,
  the jingles from GameSounds.h, start credit and timeouts from MiniCasino.ino
* the case (size, slope, lid features) from case/viewer/data/case_geo.js or case/dims.json

Writes docs/<name>-light.svg and docs/<name>-dark.svg for banner, how-it-works, schematic,
wiring and pinout, stacked phone layouts banner-narrow-* and how-it-works-narrow-*, and
case/viewer/data/schematic.js (window.MC_SCHEMATIC) for the viewer.
Every svg is plain markup with css, no scripts, no external resources, motion only where it
helps and none under prefers-reduced-motion.
"""
from __future__ import annotations

import colorsys
import json
import math
import re
import sys
import xml.etree.ElementTree as ET
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DOCS = ROOT / "docs"
FW = ROOT / "MiniCasino"
CORE_JS = ROOT / "case" / "viewer" / "js" / "core.js"
CASE_GEO = ROOT / "case" / "viewer" / "data" / "case_geo.js"
DIMS_JSON = ROOT / "case" / "dims.json"
SCHEMATIC_JS = ROOT / "case" / "viewer" / "data" / "schematic.js"

PROJECT = "Mini Casino"
REVISION = "V11"
DATE = "2026-10-06"
ORG = "lf7 · bbz aifs51"
AUTHORS = "felix grad, nikita lupalo"
OLD_FILES = ("banner.svg", "how-it-works.svg", "wiring.svg")


def read(path):
    return Path(path).read_text(encoding="utf-8")


def fail(msg):
    raise SystemExit("make_graphics: " + msg)


# =====================================================================================
# sources
# =====================================================================================
def load_core():
    """MC.tokens, MC.NETS, MC.WIRES and MC.BREADBOARD_PARTS from core.js."""
    src = read(CORE_JS)
    tok = {}
    for theme in ("dark", "light", "game"):
        m = re.search(r"\b%s:\s*\{(.*?)\}" % theme, src, re.S)
        if not m:
            fail(f"core.js: tokens.{theme} not found")
        tok[theme] = dict(re.findall(r"(\w+):\s*'([^']*)'", m.group(1)))
    for key in ("font", "mono"):
        m = re.search(r"\b%s:\s*'([^']*)'" % key, src)
        tok[key] = m.group(1)
    m = re.search(r"radius:\s*\{\s*s:\s*(\d+),\s*m:\s*(\d+),\s*l:\s*(\d+)", src)
    tok["radius"] = {"s": int(m.group(1)), "m": int(m.group(2)), "l": int(m.group(3))}
    tok["caseColors"] = {i: h for i, _, h in re.findall(r"id:\s*'(\w+)',\s*name:\s*'([^']*)',\s*hex:\s*'(#\w{6})'", src)}

    nets = {}
    for nid, label, color, group, desc in re.findall(
            r"\{\s*id:\s*'(\w+)',\s*label:\s*'([^']*)',\s*color:\s*'(#[0-9A-Fa-f]{6})',\s*group:\s*'(\w+)',\s*desc:\s*'([^']*)'\s*\}", src):
        nets[nid] = {"id": nid, "label": label, "color": color.upper(), "group": group, "desc": desc}
    wires = []
    for wid, net, pa, pina, pb, pinb, ea, eb, step in re.findall(
            r"W\('(\w+)',\s*'(\w+)',\s*P\('(\w+)',\s*'([\w:]+)'\),\s*P\('(\w+)',\s*'([\w:]+)'\),\s*'(\w+)',\s*'(\w+)',\s*(\d+)\)", src):
        wires.append({"id": wid, "net": net, "a": (pa, pina), "b": (pb, pinb), "endA": ea, "endB": eb, "step": int(step)})
    m = re.search(r"buzzer:\s*\{\s*S:\s*'(\w+)',\s*M:\s*'(\w+)',\s*MINUS:\s*'(\w+)'", src)
    r = re.search(r"resistor:\s*\{\s*a:\s*'(\w+)',\s*b:\s*'(\w+)'", src)
    bb = {"buzzer": {"S": m.group(1), "M": m.group(2), "MINUS": m.group(3)}, "resistor": (r.group(1), r.group(2))}
    if len(nets) < 20 or len(wires) < 26:
        fail(f"core.js: expected 20 nets and 26 wires, found {len(nets)} and {len(wires)}")
    for w in wires:
        if w["net"] not in nets:
            fail(f"core.js: wire {w['id']} uses unknown net {w['net']}")
    return tok, nets, wires, bb


def load_firmware():
    oled = read(FW / "OledText.h")
    body = re.search(r"OLED_SCHRIFT\[95 \* 8\] PROGMEM = \{(.*?)\};", oled, re.S).group(1)
    font = [int(h, 16) for h in re.findall(r"0x([0-9A-Fa-f]{2})", body)]
    euro = [int(h, 16) for h in re.findall(r"0x([0-9A-Fa-f]{2})",
                                           re.search(r"OLED_EURO\[8\] PROGMEM = \{(.*?)\};", oled, re.S).group(1))]
    title = re.search(r'const char \*titel = "([^"]*)";', oled).group(1)
    if len(font) != 95 * 8 or len(euro) != 8 or len(title) != 16:
        fail("OledText.h: font table, euro glyph or title not as expected")

    rt = read(FW / "GameRuntime.h")

    def pins(name):
        raw = re.search(r"%s\[4\] = \{([^}]*)\}" % name, rt).group(1)
        return [p.strip() if p.strip().startswith("A") else "D" + p.strip() for p in raw.split(",")]

    keypad = {"rows": pins("KEYPAD_REIHEN"), "cols": pins("KEYPAD_SPALTEN"),
              "chars": re.search(r'KEYPAD_ZEICHEN\[17\] = "([^"]*)"', rt).group(1),
              "buzzer": "D" + re.search(r"TON_PIN = (\d+);", rt).group(1)}

    rules_src = read(FW / "GameRules.h")
    rules = {k: int(v) for k, v in re.findall(r"constexpr uint\d+_t (\w+) = (\d+);", rules_src)}
    # The spin formulas are ported below; stop if the firmware changed them.
    for expr in ("24 + (result + 4 - start) % 3", "(start + step) % 3",
                 "45 + (455UL * step * step) / ((count - 1UL) * (count - 1UL))"):
        if expr not in rules_src:
            fail("GameRules.h changed, update spin_steps/spin_led/spin_delay: " + expr)

    snd_src = read(FW / "GameSounds.h")
    sounds = {}
    for name in ("WIN_SOUND", "LOSS_SOUND", "JACKPOT_SOUND"):
        block = re.search(r"%s\[\] SOUND_STORAGE = \{(.*?)\};" % name, snd_src, re.S).group(1)
        sounds[name] = [tuple(map(int, t)) for t in re.findall(r"\{(\d+),(\d+),(\d+)\}", block)]

    ino = read(FW / "MiniCasino.ino")
    rules["STARTGUTHABEN"] = int(re.search(r"STARTGUTHABEN = (\d+);", ino).group(1))
    rules["SITZUNG_MS"] = int(re.search(r"SITZUNG_MS = (\d+)UL;", ino).group(1))
    rules["ANZEIGEDAUER_MS"] = int(re.search(r"ANZEIGEDAUER_MS = (\d+)UL;", ino).group(1))
    rules["MODUS_MS"] = int(re.search(r"MODUS_MS = (\d+)UL;", rt).group(1))
    m = re.search(r"also (\d+) Konten", read(FW / "UidRegistry.h"))
    rules["slots"] = int(m.group(1)) if m else 31
    return {"font": font, "euro": euro, "title": title, "keypad": keypad, "rules": rules, "sounds": sounds}


def spin_steps(start, result):
    return 24 + (result + 4 - start) % 3


def spin_led(start, step):
    return (start + step) % 3


def spin_delay(step, count):
    return 45 + (455 * step * step) // ((count - 1) * (count - 1))




def load_case():
    """Case size and lid layout in lid coordinates (u across from the left edge, v up the slope from
    the front edge). Reads case/viewer/data/case_geo.js (written by case/make_case.py) and
    case/dims.json; falls back to the V11 reference numbers so the graphics always build."""
    cm = {"W": 200.0, "D": 148.0, "H_FRONT": 34.0, "SLOPE": 10.0, "LID": 3.0, "R": 10.0, "EDGE_R": 1.8,
          "source": "defaults"}
    geo, dims = None, {}
    if CASE_GEO.exists():
        txt = read(CASE_GEO)
        try:
            geo = json.loads(txt[txt.index("{"): txt.rindex("}") + 1])
        except (ValueError, json.JSONDecodeError):
            geo = None
    if DIMS_JSON.exists():
        try:
            dims = json.loads(read(DIMS_JSON))
        except json.JSONDecodeError:
            dims = {}
    # ---- size
    outer = dims.get("outer_mm")
    if isinstance(outer, list) and len(outer) >= 3:
        cm["W"], cm["D"], cm["H_FRONT"] = map(float, outer[:3])
    for key, name in (("SLOPE", "slope_deg"), ("LID", "lid_mm"), ("R", "corner_radius_mm"), ("EDGE_R", "lid_edge_radius_mm")):
        if isinstance(dims.get(name), (int, float)):
            cm[key] = float(dims[name])
    g = (geo or {}).get("dims", {})
    for key in ("W", "D", "H_FRONT", "SLOPE", "LID", "R", "EDGE_R"):
        if isinstance(g.get(key), (int, float)):
            cm[key] = float(g[key])
    cm["source"] = " + ".join(s for s, ok in (("case_geo.js", geo), ("dims.json", dims)) if ok) or "defaults"
    s = math.radians(cm["SLOPE"])
    cm["L"] = cm["D"] / math.cos(s)
    W, L = cm["W"], cm["L"]

    # ---- lid layout: reference, then dims.json, then case_geo.js (most exact)
    cm["oled"] = {"u": W * 0.274, "v": L * 0.80, "w": 30.22, "h": 15.5, "tw": 31.82, "th": 17.1}
    cm["keypad"] = {"u": W * 0.274, "v": L * 0.39, "w": 69.6, "h": 77.3}
    cm["tap"] = {"u": W * 0.726, "v": L * 0.39, "r": 26.0}
    cm["grille"] = {"u": W * 0.726, "v": L * 0.80, "r": 11.1, "holes": 37, "hole": 1.8}
    cm["slot"] = {"u": W * 0.274, "v": L * 0.39 - 38.65, "w": 22.0, "h": 3.8}
    cm["screws"] = [(8.5, 8.5), (W - 8.5, 8.5), (8.5, cm["D"] - 8.5), (W - 8.5, cm["D"] - 8.5)]
    lay = dims.get("lid_layout_uv") or {}
    if lay:
        ku, tu = lay.get("keypad_axis_u"), lay.get("tap_axis_u")
        fv, bv = lay.get("front_row_v"), lay.get("back_row_v")
        if None not in (ku, tu, fv, bv):
            cm["oled"].update(u=ku, v=bv)
            cm["keypad"].update(u=ku, v=fv)
            cm["tap"].update(u=tu, v=fv)
            cm["grille"].update(u=tu, v=bv)
            cm["slot"].update(u=ku, v=fv - cm["keypad"]["h"] / 2)
    ow = dims.get("oled_window") or {}
    if ow.get("opening_mm"):
        cm["oled"].update(w=ow["opening_mm"][0], h=ow["opening_mm"][1])
    if ow.get("at_top_mm"):
        cm["oled"].update(tw=ow["at_top_mm"][0], th=ow["at_top_mm"][1])
    kr = dims.get("keypad_recess") or {}
    if kr.get("size_mm"):
        cm["keypad"].update(w=kr["size_mm"][0], h=kr["size_mm"][1])
    if kr.get("ribbon_slot_mm"):
        cm["slot"].update(w=kr["ribbon_slot_mm"][0], h=kr["ribbon_slot_mm"][1])
    tz = dims.get("tap_zone") or {}
    if tz.get("ring_d_mm"):
        cm["tap"]["r"] = tz["ring_d_mm"] / 2
    gr = dims.get("grille") or {}
    if gr.get("holes"):
        cm["grille"].update(holes=gr["holes"], hole=gr.get("hole_d_mm", 1.8), r=gr.get("pattern_d_mm", 22.2) / 2)
    sc = (dims.get("screws") or {}).get("positions_xy")
    if sc:
        cm["screws"] = [tuple(map(float, p)) for p in sc]
    if geo:
        def uv(block):
            return block.get("uv") if isinstance(block, dict) else None
        o = geo.get("oledWindow") or {}
        if uv(o):
            cm["oled"].update(u=o["uv"][0], v=o["uv"][1])
            if o.get("size"):
                cm["oled"].update(w=o["size"][0], h=o["size"][1])
            if o.get("top"):
                cm["oled"].update(tw=o["top"][0], th=o["top"][1])
        k = geo.get("keypadRecess") or {}
        if uv(k):
            cm["keypad"].update(u=k["uv"][0], v=k["uv"][1])
            if k.get("size"):
                cm["keypad"].update(w=k["size"][0], h=k["size"][1])
        tzg = geo.get("tapZone") or {}
        if uv(tzg):
            cm["tap"].update(u=tzg["uv"][0], v=tzg["uv"][1], r=float(tzg.get("radius", cm["tap"]["r"])))
        gg = geo.get("grille") or {}
        if uv(gg):
            cm["grille"].update(u=gg["uv"][0], v=gg["uv"][1], r=float(gg.get("radius", 11.1)),
                                holes=int(gg.get("holes", 37)), hole=float(gg.get("hole", 1.8)))
        sl = geo.get("keypadSlot") or {}
        if uv(sl):
            cm["slot"].update(u=sl["uv"][0], v=sl["uv"][1])
            if sl.get("size"):
                cm["slot"].update(w=sl["size"][0], h=sl["size"][1])
        if isinstance(geo.get("screws"), list) and geo["screws"]:
            cm["screws"] = [tuple(_world_to_case(p, cm)[:2]) for p in geo["screws"]]
    return cm


def _world_to_case(p, cm):
    X, Y, Z = p
    return [X + cm["W"] / 2, cm["D"] / 2 - Z, Y]




# =====================================================================================
# svg helpers
# =====================================================================================
def fmt(v):
    if isinstance(v, str):
        return v
    if isinstance(v, bool):
        return "true" if v else "false"
    s = f"{v:.2f}".rstrip("0").rstrip(".")
    return "0" if s in ("-0", "", "-") else s


def esc(s):
    return str(s).replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;").replace('"', "&quot;")


def el(tag, content=None, **attrs):
    parts = []
    for k, v in attrs.items():
        if v is None:
            continue
        name = k.rstrip("_").replace("__", ":").replace("_", "-")
        parts.append(f' {name}="{esc(fmt(v))}"')
    a = "".join(parts)
    if content is None:
        return f"<{tag}{a}/>"
    return f"<{tag}{a}>{content}</{tag}>"


def tesc(s):
    return str(s).replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")


def pts(points):
    return " ".join(f"{fmt(x)},{fmt(y)}" for x, y in points)


def path_d(points, close=True):
    d = "M" + " L".join(f"{fmt(x)} {fmt(y)}" for x, y in points)
    return d + ("Z" if close else "")




# ------------------------------------------------------------------ colours
def rgb(hexstr):
    h = hexstr.lstrip("#")
    return tuple(int(h[i:i + 2], 16) / 255 for i in (0, 2, 4))


def hexc(c):
    return "#" + "".join(f"{max(0, min(255, round(v * 255))):02X}" for v in c)


def mix(a, b, t):
    ca, cb = rgb(a), rgb(b)
    return hexc(tuple(ca[i] + (cb[i] - ca[i]) * t for i in range(3)))


def shade(hexstr, amount):
    """lighten (amount > 0) or darken (< 0) in HLS lightness, like MC.tex.shade."""
    h, l, s = colorsys.rgb_to_hls(*rgb(hexstr))
    return hexc(colorsys.hls_to_rgb(h, max(0, min(1, l + amount)), s))


def scale_c(hexstr, f):
    return hexc(tuple(v * f for v in rgb(hexstr)))


def luminance(hexstr):
    def lin(c):
        return c / 12.92 if c <= 0.03928 else ((c + 0.055) / 1.055) ** 2.4
    r, g, b = (lin(v) for v in rgb(hexstr))
    return 0.2126 * r + 0.7152 * g + 0.0722 * b


def on_color(hexstr):
    """readable text colour on a filled pill."""
    return "#0F1115" if luminance(hexstr) > 0.32 else "#FFFFFF"


def rgba_split(c):
    """'rgba(r,g,b,a)' -> ('#RRGGBB', a); hex passes through with alpha 1."""
    m = re.match(r"rgba\((\d+),\s*(\d+),\s*(\d+),\s*([\d.]+)\)", c)
    if not m:
        return c, 1.0
    return hexc(tuple(int(m.group(i)) / 255 for i in (1, 2, 3))), float(m.group(4))


# ------------------------------------------------------------------ text metrics
_ADV = {}
for chars, w in (("il.,:;'|!", 0.24), ("fjt/()[]-", 0.31), ("r ", 0.30), ("*\"", 0.40), ("Ilj", 0.25),
                 ("cksvxyz", 0.50), ("abdeghnopqu0123456789$_#?", 0.56), ("+=<>~×→", 0.58),
                 ("FJLTZ", 0.60), ("ABEKPSVXY€", 0.66), ("CDHNRUw", 0.72), ("GOQ", 0.77),
                 ("mM", 0.84), ("W%", 0.92), ("&", 0.67), ("Ω", 0.76), ("·", 0.30), ("°", 0.40),
                 ("–", 0.56), ("—", 1.0), ("…", 1.0), ("½", 0.84)):
    for ch in chars:
        _ADV[ch] = w


def tw(s, size, weight=400, mono=False):
    """estimated advance width of a string in the system ui font (a little generous)."""
    if mono:
        return len(s) * 0.6 * size
    w = sum(_ADV.get(ch, 0.58) for ch in s) * size * 1.04
    return w * (1.05 if weight >= 600 else 1.0)


# =====================================================================================
# themes and documents
# =====================================================================================
class Theme(dict):
    def __getattr__(self, k):
        try:
            return self[k]
        except KeyError as e:
            raise AttributeError(k) from e


def make_theme(tok, name):
    t = Theme(tok[name])
    t["name"] = name
    t["dark"] = name == "dark"
    t["game"] = tok["game"]
    t["font"] = tok["font"]
    t["mono"] = tok["mono"]
    t["radius"] = tok["radius"]
    t["line_hex"], t["line_a"] = rgba_split(t["line"])
    t["line2_hex"], t["line2_a"] = rgba_split(t["line2"])
    # solid versions of the hairlines for places where alpha stacking would show
    t["hair"] = mix(t["surface"], t["line_hex"], t["line_a"])
    t["hair2"] = mix(t["surface"], t["line2_hex"], t["line2_a"])
    t["case"] = tok["caseColors"].get("arctic", "#E4E6EA")
    t["graphite"] = tok["caseColors"].get("graphite", "#2C3036")
    return t


class Doc:
    """One svg document. key prefixes ids and css classes so several can live in one page."""

    def __init__(self, key, w, h, theme, title, desc):
        self.key, self.w, self.h, self.t = key, w, h, theme
        self.title, self.desc = title, desc
        self.defs, self.body, self.css = [], [], []
        self._ids = set()

    def id(self, name):
        return f"{self.key}-{name}"

    def url(self, name):
        return f"url(#{self.key}-{name})"

    def define(self, name, markup_fn):
        """add a def once; markup_fn(id) returns the element."""
        if name not in self._ids:
            self._ids.add(name)
            self.defs.append(markup_fn(self.id(name)))
        return self.url(name)

    def add(self, *chunks):
        self.body.extend(c for c in chunks if c)

    def style(self, css):
        self.css.append(css.replace(".K", "." + self.key))

    def svg(self, inline=False):
        t = self.t
        size = "" if inline else f' width="{fmt(self.w)}" height="{fmt(self.h)}"'
        base = (f".K{{font-family:{t.font};}}"
                f".K text{{font-family:{t.font};}}"
                f".K .mono,.K .mono text{{font-family:{t.mono};}}"
                "@media (prefers-reduced-motion: reduce){.K *{animation:none!important;transition:none!important;}}")
        css = base.replace(".K", "." + self.key) + "".join(self.css)
        return (f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {fmt(self.w)} {fmt(self.h)}"{size} '
                f'class="{self.key}" role="img" aria-labelledby="{self.key}-t {self.key}-d" '
                f'font-family="{esc(t.font)}">'
                f'<title id="{self.key}-t">{tesc(self.title)}</title><desc id="{self.key}-d">{tesc(self.desc)}</desc>'
                f"<style>{css}</style><defs>{''.join(self.defs)}</defs>{''.join(self.body)}</svg>\n")


def text(x, y, s, size=14, weight=None, fill=None, anchor=None, cls=None, ls=None, opacity=None,
         transform=None, baseline=None, family=None, **extra):
    return el("text", tesc(s), x=x, y=y, font_size=size, font_weight=weight, fill=fill, text_anchor=anchor,
              class_=cls, letter_spacing=ls, opacity=opacity, transform=transform, dominant_baseline=baseline,
              font_family=family, **extra)


def lin_grad(doc, name, stops, x1=0, y1=0, x2=0, y2=1, units=None):
    def mk(i):
        st = "".join(el("stop", offset=o, stop_color=c, stop_opacity=a if a != 1 else None)
                     for o, c, a in [(s + (1,))[:3] if len(s) == 2 else s for s in stops])
        return el("linearGradient", st, id=i, x1=x1, y1=y1, x2=x2, y2=y2, gradientUnits=units)
    return doc.define(name, mk)


def rad_grad(doc, name, stops, cx=0.5, cy=0.5, r=0.5, fx=None, fy=None, units=None, transform=None):
    def mk(i):
        st = "".join(el("stop", offset=o, stop_color=c, stop_opacity=a if a != 1 else None)
                     for o, c, a in [(s + (1,))[:3] if len(s) == 2 else s for s in stops])
        return el("radialGradient", st, id=i, cx=cx, cy=cy, r=r, fx=fx, fy=fy, gradientUnits=units,
                  gradientTransform=transform)
    return doc.define(name, mk)


def blur_filter(doc, name, sd, pad=0.5):
    return doc.define(name, lambda i: el(
        "filter", el("feGaussianBlur", stdDeviation=sd), id=i, x=-pad, y=-pad, width=1 + 2 * pad,
        height=1 + 2 * pad, color_interpolation_filters="sRGB"))


def shadow_filter(doc, name, dy, sd, opacity, color="#000000"):
    return doc.define(name, lambda i: el(
        "filter", el("feDropShadow", dx=0, dy=dy, stdDeviation=sd, flood_color=color, flood_opacity=opacity),
        id=i, x=-0.3, y=-0.3, width=1.6, height=1.8, color_interpolation_filters="sRGB"))


def card_bg(doc, x=0, y=0, w=None, h=None, r=None, kind="card"):
    """the rounded panel every graphic sits on, readable on github light and dark."""
    t = doc.t
    w = doc.w if w is None else w
    h = doc.h if h is None else h
    r = t.radius["l"] * 1.5 if r is None else r
    if kind == "stage":
        top, bot = (t.stageTop, t.stageBottom) if t.dark else ("#FFFFFF", t.bg2)
    else:
        top, bot = (t.bg2, t.bg) if t.dark else (t.surface, t.surface2)
    g = lin_grad(doc, f"bg-{kind}", [(0, top), (1, bot)])
    return (el("rect", x=x + 0.5, y=y + 0.5, width=w - 1, height=h - 1, rx=r, fill=g)
            + el("rect", x=x + 0.5, y=y + 0.5, width=w - 1, height=h - 1, rx=r, fill="none",
                 stroke=t.line2_hex, stroke_opacity=t.line2_a))


# =====================================================================================
# oled: the firmware's text renderer, pixel for pixel
# =====================================================================================
class Oled:
    """Port of OledText.h: page 0 inverted title, pages 2-3 line 0, 4-5 line 1 (8x16),
    page 7 hint (8x8). Strings use '€' for the euro glyph (char 0)."""

    def __init__(self, fw):
        self.font, self.euro, self.title = fw["font"], fw["euro"], fw["title"]

    def col(self, c, sp):
        if c == 255:
            return 0xFF
        if c == 0:
            bits = 0
            for r in range(8):
                if self.euro[r] & (0x80 >> sp):
                    bits |= 1 << r
            return bits
        if c < 32 or c > 126:
            c = ord("?")
        return self.font[(c - 32) * 8 + sp]

    @staticmethod
    def stretch(four):
        out = 0
        for i in range(4):
            if four & (1 << i):
                out |= 3 << (2 * i)
        return out

    @staticmethod
    def codes(s):
        s = (s + " " * 16)[:16]
        return [0 if ch == "€" else ord(ch) for ch in s]

    def frame(self, line0="", line1="", hint=None):
        fb = [[0] * 128 for _ in range(64)]

        def put(page, x, b):
            for bit in range(8):
                fb[page * 8 + bit][x] = (b >> bit) & 1
        for x, c in enumerate(self.codes(self.title)):
            for sp in range(8):
                put(0, x * 8 + sp, (~self.col(c, sp)) & 0xFF)
        for page, line in ((2, line0), (4, line1)):
            for x, c in enumerate(self.codes(line)):
                for sp in range(8):
                    b = self.col(c, sp)
                    put(page, x * 8 + sp, self.stretch(b & 0x0F))
                    put(page + 1, x * 8 + sp, self.stretch(b >> 4))
        if hint:
            for x, c in enumerate(self.codes(hint)):
                for sp in range(8):
                    put(7, x * 8 + sp, self.col(c, sp))
        return fb


def fb_path(fb, rows=None):
    """lit pixels as one path of horizontal runs, in pixel units."""
    out = []
    for y in (rows if rows is not None else range(len(fb))):
        row = fb[y]
        x = 0
        while x < 128:
            if row[x]:
                x0 = x
                while x < 128 and row[x]:
                    x += 1
                out.append(f"M{x0} {y}h{x - x0}v1h{x0 - x}z")
            else:
                x += 1
    return "".join(out)


def oled_defs(doc, on):
    """pixel gap pattern and bloom filter, in oled pixel units."""
    t = doc.t
    grid = doc.define("pxgrid", lambda i: el(
        "pattern", el("path", d="M0.86 0h0.14v1h-0.14zM0 0.86h1v0.14h-1z", fill="#000000", fill_opacity=0.82),
        id=i, width=1, height=1, patternUnits="userSpaceOnUse"))
    bloom = doc.define("bloom", lambda i: el(
        "filter", el("feGaussianBlur", stdDeviation=1.1), id=i, x=-0.2, y=-0.3, width=1.4, height=1.6,
        color_interpolation_filters="sRGB"))
    return grid, bloom


OLED_ON = "#F4F8FF"
OLED_GLOW = "#CFE3FF"


def oled_screen(doc, fb, transform, glass=True, glow=0.55, grid=True, extra_layers="", margin=2.5, radius=1.6):
    """an oled panel in pixel units (128 x 64) placed by an svg transform."""
    grid_url, bloom = oled_defs(doc, OLED_ON)
    d = fb_path(fb)
    out = []
    if glass:
        out.append(el("rect", x=-margin, y=-margin, width=128 + 2 * margin, height=64 + 2 * margin, rx=radius,
                      fill="#030405"))
    if glow:
        out.append(el("path", d=d, fill=OLED_GLOW, opacity=glow, filter=bloom))
    out.append(el("path", d=d, fill=OLED_ON))
    out.append(extra_layers)
    if grid:
        out.append(el("rect", width=128, height=64, fill=grid_url))
    if glass:
        sheen = lin_grad(doc, "sheen", [(0, "#FFFFFF", 0.10), (0.45, "#FFFFFF", 0.025), (0.46, "#FFFFFF", 0), (1, "#FFFFFF", 0)],
                         x1=0, y1=0, x2=1, y2=1)
        out.append(el("rect", x=-margin, y=-margin, width=128 + 2 * margin, height=64 + 2 * margin, rx=radius, fill=sheen))
    return el("g", "".join(out), transform=transform)


# =====================================================================================
# 3d: a small orthographic camera for the product renders
# =====================================================================================
def v_add(a, b):
    return (a[0] + b[0], a[1] + b[1], a[2] + b[2])


def v_sub(a, b):
    return (a[0] - b[0], a[1] - b[1], a[2] - b[2])


def v_mul(a, s):
    return (a[0] * s, a[1] * s, a[2] * s)


def v_dot(a, b):
    return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]


def v_cross(a, b):
    return (a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0])


def v_norm(a):
    n = math.sqrt(v_dot(a, a)) or 1.0
    return (a[0] / n, a[1] / n, a[2] / n)


class Cam:
    """orthographic camera. Case coordinates: x right, y back, z up. az turns the camera from the
    front toward +x, el lifts it."""

    def __init__(self, az, el_, scale, ox, oy, light=(-0.45, -0.75, 1.0)):
        a, e = math.radians(az), math.radians(el_)
        self.d = (math.sin(a) * math.cos(e), -math.cos(a) * math.cos(e), math.sin(e))   # toward camera
        self.R = (math.cos(a), math.sin(a), 0.0)
        f = v_mul(self.d, -1)
        self.U = v_cross(self.R, f)
        self.s, self.ox, self.oy = scale, ox, oy
        self.L = v_norm(light)

    def p(self, P):
        return (self.ox + self.s * v_dot(P, self.R), self.oy - self.s * v_dot(P, self.U))

    def depth(self, P):
        return -v_dot(P, self.d)

    def visible(self, n):
        return v_dot(n, self.d) > 1e-6

    def poly(self, P3):
        return [self.p(P) for P in P3]

    def plane(self, O, ex, ey):
        """svg matrix mapping local (a, b) to O + a*ex + b*ey (ex, ey are 3d vectors)."""
        o = self.p(O)
        a = self.p(v_add(O, ex))
        b = self.p(v_add(O, ey))
        return f"matrix({fmt4(a[0] - o[0])} {fmt4(a[1] - o[1])} {fmt4(b[0] - o[0])} {fmt4(b[1] - o[1])} {fmt(o[0])} {fmt(o[1])})"

    def lit(self, base, n, amb=0.62, dif=0.48, spec=0.0):
        k = amb + dif * max(0.0, v_dot(v_norm(n), self.L))
        c = rgb(base)
        out = tuple(min(1.0, v * k) for v in c)
        if spec:
            out = tuple(min(1.0, v + spec) for v in out)
        return hexc(out)


def fmt4(v):
    s = f"{v:.4f}".rstrip("0").rstrip(".")
    return "0" if s in ("-0", "") else s


def convex_hull(points):
    pts_ = sorted(set((round(x, 3), round(y, 3)) for x, y in points))
    if len(pts_) <= 2:
        return pts_

    def cross(o, a, b):
        return (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0])
    lower, upper = [], []
    for p in pts_:
        while len(lower) >= 2 and cross(lower[-2], lower[-1], p) <= 0:
            lower.pop()
        lower.append(p)
    for p in reversed(pts_):
        while len(upper) >= 2 and cross(upper[-2], upper[-1], p) <= 0:
            upper.pop()
        upper.append(p)
    return lower[:-1] + upper[:-1]


def convex_overlap(a, b):
    """separating axis test for two convex polygons (screen points)."""
    for poly in (a, b):
        n = len(poly)
        for i in range(n):
            (x0, y0), (x1, y1) = poly[i], poly[(i + 1) % n]
            ax, ay = y1 - y0, x0 - x1
            pa = [ax * x + ay * y for x, y in a]
            pb = [ax * x + ay * y for x, y in b]
            if max(pa) < min(pb) or max(pb) < min(pa):
                return False
    return True


def box3(cam, x, y, z, w, d, h, base, stroke=None, faces_out=None, top_fill=None, amb=0.62, dif=0.48, sw=0.6):
    """axis-aligned box, visible faces only, lambert shaded."""
    P = [(x, y, z), (x + w, y, z), (x + w, y + d, z), (x, y + d, z),
         (x, y, z + h), (x + w, y, z + h), (x + w, y + d, z + h), (x, y + d, z + h)]
    faces = [((4, 5, 6, 7), (0, 0, 1)), ((0, 1, 5, 4), (0, -1, 0)), ((1, 2, 6, 5), (1, 0, 0)),
             ((2, 3, 7, 6), (0, 1, 0)), ((3, 0, 4, 7), (-1, 0, 0)), ((3, 2, 1, 0), (0, 0, -1))]
    out = []
    for idx, n in faces:
        if not cam.visible(n):
            continue
        poly = cam.poly([P[i] for i in idx])
        fill = top_fill if (n == (0, 0, 1) and top_fill) else cam.lit(base, n, amb, dif)
        out.append(el("polygon", points=pts(poly), fill=fill, stroke=stroke or fill, stroke_width=sw,
                      stroke_linejoin="round"))
        if faces_out is not None:
            faces_out[n] = poly
    return "".join(out)


def rounded_rect_pts(x, y, w, d, r, n=8):
    """footprint polygon of a rounded rectangle, counter-clockwise seen from above."""
    r = min(r, w / 2, d / 2)
    out = []
    for cx, cy, a0 in ((x + w - r, y + r, -90), (x + w - r, y + d - r, 0), (x + r, y + d - r, 90), (x + r, y + r, 180)):
        for i in range(n + 1):
            a = math.radians(a0 + 90 * i / n)
            out.append((cx + r * math.cos(a), cy + r * math.sin(a)))
    return out


def prism(cam, foot, z0, ztop, base, amb=0.62, dif=0.48, sw=0.7):
    """vertical walls of an extruded footprint; ztop(x, y) gives the top height. returns
    (wall svg, top 3d polygon)."""
    n = len(foot)
    walls = []
    for i in range(n):
        (x0, y0), (x1, y1) = foot[i], foot[(i + 1) % n]
        nx, ny = (y1 - y0), -(x1 - x0)       # outward for ccw footprint
        nn = math.hypot(nx, ny) or 1
        nrm = (nx / nn, ny / nn, 0.0)
        if not cam.visible(nrm):
            continue
        quad = [(x0, y0, z0), (x1, y1, z0), (x1, y1, ztop(x1, y1)), (x0, y0, ztop(x0, y0))]
        c = cam.lit(base, nrm, amb, dif)
        walls.append((cam.depth(((x0 + x1) / 2, (y0 + y1) / 2, z0)),
                      el("polygon", points=pts(cam.poly(quad)), fill=c, stroke=c, stroke_width=sw, stroke_linejoin="round")))
    walls.sort(key=lambda w: -w[0])
    top = [(x, y, ztop(x, y)) for x, y in foot]
    return "".join(w for _, w in walls), top


def cylinder3(cam, c, axis, r, length, base, cap=None, n=40, amb=0.6, dif=0.5, cap_fill=None):
    """cylinder from centre c along axis (unit) with radius r. silhouette = hull of both caps."""
    axis = v_norm(axis)
    tmp = (1, 0, 0) if abs(axis[0]) < 0.9 else (0, 1, 0)
    e1 = v_norm(v_cross(axis, tmp))
    e2 = v_cross(axis, e1)
    end = v_add(c, v_mul(axis, length))
    ring0, ring1 = [], []
    for i in range(n):
        a = 2 * math.pi * i / n
        off = v_add(v_mul(e1, r * math.cos(a)), v_mul(e2, r * math.sin(a)))
        ring0.append(v_add(c, off))
        ring1.append(v_add(end, off))
    hull = convex_hull(cam.poly(ring0) + cam.poly(ring1))
    # side shading: gradient across the silhouette would be nicer; use the lit colour of the
    # side facing the light
    side_n = v_norm(v_sub(cam.L, v_mul(axis, v_dot(cam.L, axis))))
    side = cam.lit(base, side_n, amb, dif * 0.6)
    out = [el("polygon", points=pts(hull), fill=side, stroke=side, stroke_width=0.5)]
    top_ring = ring1 if v_dot(axis, cam.d) > 0 else ring0
    top_n = axis if v_dot(axis, cam.d) > 0 else v_mul(axis, -1)
    out.append(el("polygon", points=pts(cam.poly(top_ring)), fill=cap_fill or cam.lit(cap or base, top_n, amb, dif)))
    return "".join(out), hull, cam.poly(top_ring)


# =====================================================================================
# shared product drawings (lid features, keypad, card)
# =====================================================================================
# 4x4 membrane keypad, same numbers as MC.parts.keypad (parts_misc.js): key field 13 mm square on a
# 16.6 x 17.4 mm grid centred on the 69.2 x 76.9 overlay, blue digit keys, red A-D * #.
KEY_PITCH = (16.6, 17.4)
KEY_SIZE = 13.0
KEY_COLOURS = {"digit": "#2556B9", "func": "#C9323A", "base": "#0F1013"}


def keypad_face(doc, w=69.2, h=76.9, pressed=None, press_cls=None, ring=None):
    """membrane keypad in its own 2d frame (mm, origin top-left, legends upright)."""
    chars = "123A456B789C*0#D"
    out = [el("rect", width=w, height=h, rx=1.6, fill=KEY_COLOURS["base"]),
           el("rect", x=1.6, y=1.6, width=w - 3.2, height=h - 3.2, rx=1.2, fill="none", stroke="#FFFFFF",
              stroke_opacity=0.06, stroke_width=0.25)]
    g_d = lin_grad(doc, "key-d", [(0, shade(KEY_COLOURS["digit"], 0.06)), (1, shade(KEY_COLOURS["digit"], -0.06))])
    g_f = lin_grad(doc, "key-f", [(0, shade(KEY_COLOURS["func"], 0.06)), (1, shade(KEY_COLOURS["func"], -0.06))])
    for r in range(4):
        for c in range(4):
            ch = chars[r * 4 + c]
            cx = w / 2 + (c - 1.5) * KEY_PITCH[0]
            cy = h / 2 + (r - 1.5) * KEY_PITCH[1]
            x, y = cx - KEY_SIZE / 2, cy - KEY_SIZE / 2
            fill = g_f if ch in "ABCD*#" else g_d
            size = 9.6 if ch == "*" else 6.4 if ch == "#" else 6.6
            g = [el("rect", x=x - 0.25, y=y - 0.25, width=KEY_SIZE + 0.5, height=KEY_SIZE + 0.5, rx=1.95, fill="#000000", opacity=0.35),
                 el("rect", x=x, y=y, width=KEY_SIZE, height=KEY_SIZE, rx=1.7, fill=fill),
                 el("rect", x=x + 0.35, y=y + 0.35, width=KEY_SIZE - 0.7, height=KEY_SIZE - 0.7, rx=1.4, fill="none",
                    stroke="#FFFFFF", stroke_opacity=0.14, stroke_width=0.3),
                 text(cx, cy + size * 0.36 + (2.6 if ch == "*" else 0), ch, size=size, weight=700, fill="#F7F8FA", anchor="middle")]
            if pressed == ch and ring:
                g.append(el("rect", x=x - 1.1, y=y - 1.1, width=KEY_SIZE + 2.2, height=KEY_SIZE + 2.2, rx=2.6,
                            fill="none", stroke=ring, stroke_width=0.8))
            out.append(el("g", "".join(g), class_=press_cls if pressed == ch else None))
    return "".join(out)


def nfc_arcs(cx, cy, size, stroke, sw, opacity=1.0):
    """contactless symbol: four concentric arcs opening to the right."""
    out = []
    base_x = cx - size * 0.42
    for i in range(4):
        r = size * (0.22 + 0.2 * i)
        a = math.radians(48)
        x0 = base_x + r * math.cos(a)
        y0 = cy - r * math.sin(a)
        y1 = cy + r * math.sin(a)
        out.append(el("path", d=f"M{fmt(x0)} {fmt(y0)}A{fmt(r)} {fmt(r)} 0 0 1 {fmt(x0)} {fmt(y1)}",
                      fill="none", stroke=stroke, stroke_width=sw, stroke_linecap="round", opacity=opacity))
    return "".join(out)


def card_face(doc, uid, w=85.6, h=54.0):
    """white iso card, front print as in MC.parts.transponder('card'): roulette hairlines, three
    chips, wordmark and the uid. 2d frame in mm."""
    t = doc.t
    g = lin_grad(doc, "cardface", [(0, "#FBFBFA"), (1, "#EEF0F2")], x1=0, y1=0, x2=1, y2=1)
    clip = doc.define("cardclip", lambda i: el("clipPath", el("rect", width=w, height=h, rx=3.2), id=i))
    wheel = []
    for r in (9, 16.5, 21, 27, 33):
        wheel.append(el("circle", cx=70, cy=27, r=r, fill="none", stroke="#1E2837", stroke_opacity=0.09, stroke_width=0.22))
    ticks = []
    for i in range(37):
        a = i / 37 * 2 * math.pi
        ticks.append(f"M{fmt(70 + math.cos(a) * 16.5)} {fmt(27 + math.sin(a) * 16.5)}L{fmt(70 + math.cos(a) * 21)} {fmt(27 + math.sin(a) * 21)}")
    wheel.append(el("path", d="".join(ticks), stroke="#1E2837", stroke_opacity=0.09, stroke_width=0.22))
    a0, a1 = -math.pi / 2 - 0.085, -math.pi / 2 + 0.085
    wheel.append(el("path", d=f"M{fmt(70 + 21 * math.cos(a0))} {fmt(27 + 21 * math.sin(a0))}A21 21 0 0 1 {fmt(70 + 21 * math.cos(a1))} {fmt(27 + 21 * math.sin(a1))}"
                              f"L{fmt(70 + 16.5 * math.cos(a1))} {fmt(27 + 16.5 * math.sin(a1))}A16.5 16.5 0 0 0 {fmt(70 + 16.5 * math.cos(a0))} {fmt(27 + 16.5 * math.sin(a0))}Z",
                    fill=t.game["green"], fill_opacity=0.55))
    chips = "".join(el("circle", cx=8.6 + i * 3.4, cy=8.6, r=1.25, fill=c)
                    for i, c in enumerate((t.game["black"], t.game["red"], t.game["green"])))
    return "".join([
        el("rect", width=w, height=h, rx=3.2, fill=g),
        el("g", "".join(wheel), clip_path=clip),
        chips,
        nfc_arcs(80.2, 8.8, 7.2, "#465060", 0.4, 0.6),
        text(7.3, 19.8, "mini casino", size=5.6, weight=700, fill="#15171A", ls=-0.12),
        text(7.5, 24.0, "player card", size=2.3, weight=600, fill="#6B7480", ls=0.32),
        text(7.5, 42.3, "UID", size=1.7, weight=700, fill="#8A929C", ls=0.3),
        text(7.4, 47.8, " ".join(uid[i:i + 2] for i in range(0, len(uid), 2)), size=3.3, weight=600, fill="#1D2025",
             cls="mono", ls=0.08),
        text(78.2, 47.2, "V11 · 13.56 MHz", size=1.75, weight=600, fill="#8A929C", anchor="end", ls=0.1),
        el("rect", x=0.2, y=0.2, width=w - 0.4, height=h - 0.4, rx=3.0, fill="none", stroke="#0F1115",
           stroke_opacity=0.12, stroke_width=0.4)])


def kf(doc, css):
    """add css, renaming keyframes so several documents can share a page."""
    doc.style(re.sub(r"\bK-", doc.key + "-", css))


# =====================================================================================
# 1. banner: the closed console as a product render
# =====================================================================================
def console_render(doc, cm, fw, cam_az=36.0, cam_el=29.0, box=(640, 150, 600, 360), card=True, pulse=True,
                   menu=None, shadows=True, key_pressed=None):
    """the closed console, data driven from the case dims. returns (svg, info)."""
    t = doc.t
    W, D, HF, LID, R = cm["W"], cm["D"], cm["H_FRONT"], cm["LID"], cm["R"]
    s = math.radians(cm["SLOPE"])
    L = cm["L"]
    tan = math.tan(s)

    def ztop(x, y):
        return HF + y * tan

    # fit the camera into the box
    probe = Cam(cam_az, cam_el, 1, 0, 0)
    corners = [(x, y, z) for x in (0, W) for y in (0, D) for z in (0, ztop(0, y))]
    pp = [probe.p(c) for c in corners]
    bx0, bx1 = min(p[0] for p in pp), max(p[0] for p in pp)
    by0, by1 = min(p[1] for p in pp), max(p[1] for p in pp)
    sc = min(box[2] / (bx1 - bx0), box[3] / (by1 - by0))
    ox = box[0] + (box[2] - (bx1 - bx0) * sc) / 2 - bx0 * sc
    oy = box[1] + (box[3] - (by1 - by0) * sc) / 2 - by0 * sc
    cam = Cam(cam_az, cam_el, sc, ox, oy, light=(-0.5, -0.8, 1.05))
    base = t.case
    amb, dif = (0.70, 0.34) if not t.dark else (0.62, 0.40)
    out = []
    foot = rounded_rect_pts(0, 0, W, D, R, n=10)

    if shadows:
        soft = blur_filter(doc, "gshadow", 16 * sc / 3, pad=0.6)
        contact = blur_filter(doc, "cshadow", 2.6 * sc / 3, pad=0.3)
        far = [(x + 9, y + 14, 0) for x, y in foot]
        out.append(el("polygon", points=pts(cam.poly(far)), fill="#000000",
                      opacity=0.34 if t.dark else 0.20, filter=soft))
        near = [(x + 0.8, y + 1.2, 0) for x, y in rounded_rect_pts(1.5, 1.5, W - 3, D - 3, R, n=10)]
        out.append(el("polygon", points=pts(cam.poly(near)), fill="#000000",
                      opacity=0.55 if t.dark else 0.42, filter=contact))

    walls, top = prism(cam, foot, 0, ztop, base, amb, dif)
    out.append(walls)
    wall_polys = re.findall(r'points="([^"]+)"', walls)
    clip = doc.define("wallclip", lambda i: el("clipPath", "".join(el("polygon", points=p) for p in wall_polys), id=i))
    ytop = min(cam.p((x, y, ztop(x, y)))[1] for x, y in foot)
    ybot = max(cam.p((x, y, 0))[1] for x, y in foot)
    fall = lin_grad(doc, "wallfall", [(0, "#FFFFFF", 0.10 if not t.dark else 0.05), (0.55, "#FFFFFF", 0),
                                      (1, "#000000", 0.16 if not t.dark else 0.22)],
                    x1=0, y1=ytop, x2=0, y2=ybot, units="userSpaceOnUse")
    out.append(el("rect", x=0, y=ytop - 10, width=doc.w, height=ybot - ytop + 20, fill=fall, clip_path=clip))

    # visible outline segments (for the parting line and the edge highlight)
    zl = LID / math.cos(s)
    vis, seg = [], []
    n = len(foot)
    for i in range(n):
        (x0, y0), (x1, y1) = foot[i], foot[(i + 1) % n]
        if cam.visible(v_norm(((y1 - y0), -(x1 - x0), 0))):
            if not seg:
                seg.append(foot[i])
            seg.append(foot[(i + 1) % n])
        elif seg:
            vis.append(seg)
            seg = []
    if seg:
        vis.append(seg)
    lw = max(0.8, 0.2 * sc)
    for sg in vis:
        line = [cam.p((x, y, ztop(x, y) - zl)) for x, y in sg]
        out.append(el("polyline", points=pts(line), fill="none", stroke="#000000", stroke_opacity=0.30,
                      stroke_width=lw, stroke_linejoin="round"))
        out.append(el("polyline", points=pts([(x, y + lw) for x, y in line]), fill="none", stroke="#FFFFFF",
                      stroke_opacity=0.35 if not t.dark else 0.18, stroke_width=0.8, stroke_linejoin="round"))

    # lid top
    n_lid = (0, -math.sin(s), math.cos(s))
    top_c = cam.lit(base, n_lid, amb, dif)
    top_poly = cam.poly(top)
    out.append(el("polygon", points=pts(top_poly), fill=top_c, stroke=top_c, stroke_width=0.6))
    p_bl, p_fr = cam.p((0, D, ztop(0, D))), cam.p((W, 0, ztop(W, 0)))
    sheen = lin_grad(doc, "lidsheen", [(0, "#FFFFFF", 0.22 if not t.dark else 0.10), (0.6, "#FFFFFF", 0),
                                       (1, "#000000", 0.05)],
                     x1=p_bl[0], y1=p_bl[1], x2=p_fr[0], y2=p_fr[1], units="userSpaceOnUse")
    out.append(el("polygon", points=pts(top_poly), fill=sheen))
    for sg in vis:
        line = [cam.p((x, y, ztop(x, y))) for x, y in sg]
        out.append(el("polyline", points=pts(line), fill="none", stroke="#FFFFFF", stroke_opacity=0.8,
                      stroke_width=max(0.9, 0.24 * sc), stroke_linejoin="round", stroke_linecap="round"))

    # lid frame: local (u, b), b runs down the slope from the back edge, so text reads from the front
    O_back = (0.0, D, ztop(0, D))
    ex = (1.0, 0.0, 0.0)
    eb = (0.0, -math.cos(s), -math.sin(s))
    en = (0.0, -math.sin(s), math.cos(s))

    def P(u, b, h=0.0):
        return v_add(v_add(v_add(O_back, v_mul(ex, u)), v_mul(eb, b)), v_mul(en, h))
    lid_m = cam.plane(O_back, ex, eb)
    lid = []
    engr = shade(base, -0.30)

    # keypad recess with the membrane, the ribbon slot in front of it
    kp = cm["keypad"]
    kx, kb = kp["u"] - kp["w"] / 2, (L - kp["v"]) - kp["h"] / 2
    sl = cm["slot"]
    sx_, sb_ = sl["u"] - sl["w"] / 2, (L - sl["v"]) - sl["h"] / 2
    lid.append(el("rect", x=sx_, y=sb_, width=sl["w"], height=sl["h"], rx=sl["h"] / 2, fill="#0B0C0E"))
    lid.append(el("rect", x=kx, y=kb, width=kp["w"], height=kp["h"], rx=1.8, fill=shade(base, -0.14)))
    lid.append(el("rect", x=kx, y=kb, width=kp["w"], height=1.0, rx=0.5, fill="#000000", opacity=0.20))
    mx_, mb_ = kp["u"] - 69.2 / 2, (L - kp["v"]) - 76.9 / 2
    tail_w = 20.3
    lid.append(el("rect", x=kp["u"] - tail_w / 2, y=mb_ + 76.0, width=tail_w, height=max(0.5, sb_ + sl["h"] / 2 - mb_ - 76.0),
                  fill="#B9C0C8", opacity=0.8))
    lid.append(el("g", keypad_face(doc, pressed=key_pressed), transform=f"translate({fmt(mx_)} {fmt(mb_)})"))

    # rfid tap zone, engraved ring with the contactless mark
    tp = cm["tap"]
    tu, tb = tp["u"], L - tp["v"]
    r = tp["r"]
    for dy, col, op in ((0.42, "#FFFFFF", 0.6), (0, engr, 0.85)):
        lid.append(el("circle", cx=tu, cy=tb + dy, r=r, fill="none", stroke=col, stroke_opacity=op, stroke_width=0.7))
        lid.append(nfc_arcs(tu + r * 0.06, tb + dy - r * 0.04, r * 0.55, col, 0.8, op))
        lid.append(text(tu, tb + dy + r * 0.62, "TAP CARD", size=3.0, weight=700, fill=col, anchor="middle", ls=1.2, opacity=op))

    # buzzer grille: hex pattern of round holes
    gr = cm["grille"]
    gu, gb = gr["u"], L - gr["v"]
    holes, ring_ = [(0.0, 0.0)], 1
    pitch = (gr["r"] - gr["hole"] / 2) / 3
    while len(holes) < gr["holes"] and ring_ < 6:
        for side in range(6):
            a0, a1 = math.radians(60 * side), math.radians(60 * (side + 1))
            for j in range(ring_):
                f = j / ring_
                hx = ring_ * pitch * ((1 - f) * math.cos(a0) + f * math.cos(a1))
                hy = ring_ * pitch * ((1 - f) * math.sin(a0) + f * math.sin(a1))
                holes.append((hx, hy))
        ring_ += 1
    hd = "".join(f"M{fmt(gu + hx - gr['hole'] / 2)} {fmt(gb + hy)}a{fmt(gr['hole'] / 2)} {fmt(gr['hole'] / 2)} 0 1 0 {fmt(gr['hole'])} 0"
                 f"a{fmt(gr['hole'] / 2)} {fmt(gr['hole'] / 2)} 0 1 0 {fmt(-gr['hole'])} 0z" for hx, hy in holes[:gr["holes"]])
    lid.append(el("path", d=hd, fill="#FFFFFF", opacity=0.6, transform="translate(0 0.35)"))
    lid.append(el("path", d=hd, fill="#16181B"))

    # countersunk m3 screws in the corners
    for sxw, syw in cm["screws"]:
        su, sb = sxw, L - syw / math.cos(s)
        lid.append(el("circle", cx=su, cy=sb, r=3.2, fill=shade(base, -0.12)))
        lid.append(el("circle", cx=su, cy=sb, r=2.75, fill=lin_grad(doc, "screw", [(0, "#E4E7EB"), (1, "#9AA1AA")], x1=0, y1=0, x2=1, y2=1)))
        lid.append(el("path", d=f"M{fmt(su - 0.9)} {fmt(sb - 0.52)}h1.8l0.9 0.52-0.9 0.52h-1.8l-0.9-0.52z", fill="#4A5059"))

    # oled window: 45 degree chamfer from the top opening down to the window, then the glass
    ol = cm["oled"]
    ow, oh, tw_, th_ = ol["w"], ol["h"], ol["tw"], ol["th"]
    wx, wb = ol["u"] - ow / 2, (L - ol["v"]) - oh / 2
    tx0, tb0 = ol["u"] - tw_ / 2, (L - ol["v"]) - th_ / 2
    for a_, b_, c_, d_, col in (
            ((tx0, tb0), (tx0 + tw_, tb0), (wx + ow, wb), (wx, wb), shade(base, -0.05)),
            ((tx0 + tw_, tb0), (tx0 + tw_, tb0 + th_), (wx + ow, wb + oh), (wx + ow, wb), shade(base, -0.11)),
            ((tx0, tb0 + th_), (tx0 + tw_, tb0 + th_), (wx + ow, wb + oh), (wx, wb + oh), shade(base, -0.26)),
            ((tx0, tb0), (tx0, tb0 + th_), (wx, wb + oh), (wx, wb), shade(base, -0.18))):
        lid.append(el("polygon", points=pts([a_, b_, c_, d_]), fill=col))
    lid.append(el("rect", x=wx, y=wb, width=ow, height=oh, fill="#030405"))
    out.append(el("g", "".join(lid), transform=lid_m))

    if menu:
        fb = fw["oled"].frame(*menu)
        ax0, ab0 = ol["u"] - 29.42 / 2, (L - ol["v"]) - 14.70 / 2
        m = cam.plane(P(ax0, ab0, -0.05), v_mul(ex, 29.42 / 128), v_mul(eb, 14.70 / 64))
        out.append(oled_screen(doc, fb, m, glass=False, glow=0.6))
    info = {"cam": cam, "P": P, "oled_centre": cam.p(P(ol["u"], L - ol["v"])), "tap_centre": cam.p(P(tu, tb)),
            "lid_m": lid_m, "en": en, "ex": ex, "eb": eb, "sc": sc}

    if pulse:
        rings = "".join(el("circle", r=r, fill="none", stroke=t.accent, stroke_width=0.9, class_="pulse",
                           style=f"animation-delay:{i * 1.3:.1f}s", opacity=0) for i in range(2))
        out.append(el("g", rings, transform=f"{lid_m} translate({fmt(tu)} {fmt(tb)})"))
        kf(doc, ".K .pulse{transform-box:view-box;transform-origin:0 0;animation:K-pulse 2.6s cubic-bezier(.2,.7,.3,1) infinite;}"
                "@keyframes K-pulse{0%{transform:scale(.35);opacity:0}15%{opacity:.75}100%{transform:scale(1.45);opacity:0}}")
    if card:
        cw, ch = 85.6, 54.0

        def quad(x0, b0, w_, h_, m=0.0):
            return [cam.p(P(a_, b_)) for a_, b_ in ((x0 - m, b0 - m), (x0 + w_ + m, b0 - m), (x0 + w_ + m, b0 + h_ + m), (x0 - m, b0 + h_ + m))]
        kp_ = cm["keypad"]
        avoid = [quad(wx, wb, ow, oh, 4), quad(kx, kb, kp_["w"], kp_["h"], 2)]
        # hover over the tap zone, tipped toward the viewer; nudged until nothing important is hidden
        for du, db, lift, thd, phid in ((0, 0, 26, -14, -12), (4, 4, 24, -12, -12), (6, 8, 22, -10, -10),
                                        (8, 14, 20, -8, -8), (10, 20, 18, -6, -8), (12, 28, 14, 0, -6)):
            th, phi = math.radians(thd), math.radians(phid)
            e1 = v_add(v_mul(ex, math.cos(th)), v_mul(eb, math.sin(th)))
            e2f = v_add(v_mul(ex, -math.sin(th)), v_mul(eb, math.cos(th)))
            e2 = v_sub(v_mul(e2f, math.cos(phi)), v_mul(en, math.sin(phi)))
            centre = P(tu + du, tb + db, lift)
            o = v_sub(centre, v_add(v_mul(e1, cw / 2), v_mul(e2, ch / 2)))
            q = [cam.p(v_add(o, v_add(v_mul(e1, a_), v_mul(e2, b_)))) for a_, b_ in ((0, 0), (cw, 0), (cw, ch), (0, ch))]
            if not any(convex_overlap(q, av) for av in avoid):
                break
        out.append(floating_card(doc, cam, centre, e1, e2, P(tu + du + 4, tb + db + 6, 0.1), e1, v_mul(e2f, math.cos(phi))))
    return "".join(out), info


BANNER_MENU = ("Guthaben    150€", "Einsatz      10€", "1-3 setzen  D=?")


def oled_callout(doc, fw, x0, y0, px, anchor_pt, leader_to):
    """floating panel with the real menu screen, a dashed leader to the oled on the console."""
    t = doc.t
    pw, ph = 128 * px + 36, 64 * px + 62
    ocx, ocy = anchor_pt
    if leader_to:
        lx, ly = leader_to(x0, y0, pw, ph)
        doc.add(el("path", d=f"M{fmt(ocx)} {fmt(ocy)}L{fmt(lx)} {fmt(ly)}", stroke=t.ink2, stroke_opacity=0.6,
                   stroke_width=1, fill="none", stroke_dasharray="2 3"))
        doc.add(el("circle", cx=ocx, cy=ocy, r=3.4, fill=t.accent, stroke="#FFFFFF", stroke_width=1.5))
    sh = shadow_filter(doc, "panelshadow", 10, 16, 0.16 if not t.dark else 0.5)
    panel = lin_grad(doc, "panel", [(0, t.surface if not t.dark else t.surface3), (1, t.surface2 if not t.dark else t.surface)])
    doc.add(el("rect", x=x0, y=y0, width=pw, height=ph, rx=16, fill=panel, filter=sh))
    doc.add(el("rect", x=x0 + 0.5, y=y0 + 0.5, width=pw - 1, height=ph - 1, rx=15.5, fill="none",
               stroke=t.line2_hex, stroke_opacity=t.line2_a))
    doc.add(text(x0 + 18, y0 + 26, "oled · 128×64", size=12.5, weight=600, fill=t.ink))
    doc.add(text(x0 + pw - 18, y0 + 26, "drawn from OledText.h", size=11.5, fill=t.muted, anchor="end", cls="mono"))
    fb = fw["oled"].frame(*BANNER_MENU)
    doc.add(oled_screen(doc, fb, f"translate({fmt(x0 + 18)} {fmt(y0 + 42)}) scale({px})", margin=2.6, radius=1.2))


def banner_text(doc, x, y, scale=1.0, lines=None):
    """eyebrow, wordmark, tagline and the three colour chips; y is the top of the eyebrow."""
    t = doc.t
    k = scale
    doc.add(el("rect", x=x, y=y, width=46 * k, height=24 * k, rx=12 * k, fill=t.accent, fill_opacity=0.14 if not t.dark else 0.18))
    doc.add(text(x + 23 * k, y + 16.5 * k, REVISION, size=12.5 * k, weight=700, fill=t.accent, anchor="middle", ls=0.4))
    doc.add(text(x + 58 * k, y + 16.5 * k, "lf7 project · bbz aifs51", size=14 * k, fill=t.muted))
    doc.add(text(x - 4 * k, y + 112 * k, "mini casino", size=94 * k, weight=700, fill=t.ink, ls=-3.4 * k))
    doc.add(text(x, y + 164 * k, "a tiny casino on an arduino uno.", size=25 * k, fill=t.ink2, ls=-0.2))
    doc.add(text(x, y + 198 * k, "tap a card, pick a colour, watch the spin.", size=25 * k, fill=t.ink2, ls=-0.2))
    cx = x
    cy = y + 257 * k
    for key, name, mult, col in (("1", "black", "2×", t.game["black"]), ("2", "red", "2×", t.game["red"]),
                                 ("3", "green", "9×", t.game["green"])):
        w = (34 + tw(name, 15, 600) + 6 + tw(mult, 15) + 16) * k
        doc.add(el("rect", x=cx, y=cy - 19 * k, width=w, height=38 * k, rx=19 * k, fill=t.surface if not t.dark else t.surface2,
                   stroke=t.line2_hex, stroke_opacity=t.line2_a))
        doc.add(el("circle", cx=cx + 19 * k, cy=cy, r=9 * k, fill=col, stroke="#FFFFFF" if t.dark else "#0F1115",
                   stroke_opacity=0.22 if col == t.game["black"] and t.dark else 0))
        doc.add(text(cx + 19 * k, cy + 4 * k, key, size=10.5 * k, weight=700, fill="#FFFFFF", anchor="middle"))
        doc.add(text(cx + 34 * k, cy + 5.5 * k, name, size=15 * k, weight=600, fill=t.ink))
        doc.add(text(cx + (34 + tw(name, 15, 600) + 6) * k, cy + 5.5 * k, mult, size=15 * k, fill=t.muted))
        cx += w + 10 * k
    for i, line in enumerate(lines or ()):
        doc.add(text(x, y + (322 + 26 * i) * k, line, size=15 * k, fill=t.muted))


def banner(doc, fw, cm):
    t = doc.t
    doc.add(card_bg(doc, kind="stage", r=24))
    spot = rad_grad(doc, "spot", [(0, "#FFFFFF", 0.95 if not t.dark else 0.09), (1, "#FFFFFF", 0)])
    doc.add(el("ellipse", cx=930, cy=340, rx=440, ry=250, fill=spot))
    svg, info = console_render(doc, cm, fw, box=(584, 206, 650, 334), menu=BANNER_MENU)
    doc.add(svg)
    px = 2.25
    oled_callout(doc, fw, doc.w - (128 * px + 36) - 40, 34, px, info["oled_centre"], lambda x, y, w, h: (x + 40, y + h))
    banner_text(doc, 72, 124, lines=(f"1.3″ oled · rc522 rfid · 4×4 keypad · buzzer · {fw['rules']['slots']} accounts in the eeprom",
                                     "every screen and every wire here is generated from the firmware."))


def banner_narrow(doc, fw, cm):
    """the same hero stacked for phones: text on top, console below, the screen underneath."""
    t = doc.t
    doc.add(card_bg(doc, kind="stage", r=24))
    spot = rad_grad(doc, "spot", [(0, "#FFFFFF", 0.95 if not t.dark else 0.09), (1, "#FFFFFF", 0)])
    doc.add(el("ellipse", cx=doc.w / 2, cy=560, rx=360, ry=230, fill=spot))
    banner_text(doc, 48, 56, scale=0.92)
    svg, info = console_render(doc, cm, fw, box=(30, 360, doc.w - 60, 330), menu=BANNER_MENU)
    doc.add(svg)
    px = 3.2
    pw = 128 * px + 36
    oled_callout(doc, fw, (doc.w - pw) / 2, 720, px, info["oled_centre"], None)


# =====================================================================================
# 2. how it works: five steps, each a small render plus the real oled frame
# =====================================================================================
def fit_cam(points, box, az, el_, light=(-0.5, -0.8, 1.05)):
    probe = Cam(az, el_, 1, 0, 0)
    pp = [probe.p(P) for P in points]
    bx0, bx1 = min(p[0] for p in pp), max(p[0] for p in pp)
    by0, by1 = min(p[1] for p in pp), max(p[1] for p in pp)
    sc = min(box[2] / (bx1 - bx0), box[3] / (by1 - by0))
    ox = box[0] + (box[2] - (bx1 - bx0) * sc) / 2 - bx0 * sc
    oy = box[1] + (box[3] - (by1 - by0) * sc) / 2 - by0 * sc
    return Cam(az, el_, sc, ox, oy, light)


def ground_shadow(doc, cam, foot, spread=(4, 7), blur=6.0, opacity=0.22):
    t = doc.t
    f = blur_filter(doc, f"gs{int(blur * 10)}", blur, pad=0.6)
    poly = [(x + spread[0], y + spread[1], 0) for x, y in foot]
    return el("polygon", points=pts(cam.poly(poly)), fill="#000000", opacity=opacity * (1.6 if t.dark else 1), filter=f)


def slab(doc, cam, w, d, h, r, base, amb=0.70, dif=0.34):
    """rounded slab of case material, returns (svg, top plane matrix with origin at the back-left)."""
    foot = rounded_rect_pts(0, 0, w, d, r, n=8)
    walls, top = prism(cam, foot, 0, lambda x, y: h, base, amb, dif)
    tc = cam.lit(base, (0, 0, 1), amb, dif)
    out = [ground_shadow(doc, cam, foot), walls,
           el("polygon", points=pts(cam.poly(top)), fill=tc, stroke=tc, stroke_width=0.5)]
    a, b = cam.p((0, d, h)), cam.p((w, 0, h))
    sheen = lin_grad(doc, f"slabsheen", [(0, "#FFFFFF", 0.18), (1, "#000000", 0.04)], x1=0, y1=0, x2=1, y2=1)
    out.append(el("polygon", points=pts(cam.poly(top)), fill=sheen))
    # bright rim on the visible top edges
    n = len(foot)
    for i in range(n):
        (x0, y0), (x1, y1) = foot[i], foot[(i + 1) % n]
        if cam.visible(v_norm(((y1 - y0), -(x1 - x0), 0))):
            out.append(el("line", x1=cam.p((x0, y0, h))[0], y1=cam.p((x0, y0, h))[1], x2=cam.p((x1, y1, h))[0],
                          y2=cam.p((x1, y1, h))[1], stroke="#FFFFFF", stroke_opacity=0.7, stroke_width=0.9,
                          stroke_linecap="round"))
    return "".join(out), cam.plane((0, d, h), (1, 0, 0), (0, -1, 0))


def floating_card(doc, cam, centre, e1, e2, shadow_centre, se1=None, se2=None, uid="DF51AA39"):
    """iso card hovering at centre (e1 along the card, e2 down the face), soft shadow below."""
    t = doc.t
    cw, ch = 85.6, 54.0
    se1, se2 = se1 or e1, se2 or e2
    o = v_sub(centre, v_add(v_mul(e1, cw / 2), v_mul(e2, ch / 2)))
    m = cam.plane(o, e1, e2)
    sh_o = v_sub(shadow_centre, v_add(v_mul(se1, cw / 2), v_mul(se2, ch / 2)))
    op_hi, op_lo = (0.22, 0.14) if not t.dark else (0.42, 0.28)
    shadow = el("g", el("rect", width=cw, height=ch, rx=4, fill="#000000", filter=blur_filter(doc, "cardshadow", 3.2, pad=0.4)),
                transform=cam.plane(sh_o, se1, se2), opacity=op_hi, class_="cshade")
    en = v_norm(v_cross(e2, e1))
    edge = v_mul(en, -0.76)
    rim = [cam.p(v_add(o, v_add(v_mul(e1, a), v_mul(e2, b)))) for a, b in ((0, ch), (cw, ch), (cw, 0))]
    rim2 = [cam.p(v_add(v_add(o, edge), v_add(v_mul(e1, a), v_mul(e2, b)))) for a, b in ((cw, 0), (cw, ch), (0, ch))]
    card_svg = el("polygon", points=pts(rim + rim2), fill="#BFC4CB") + el("g", card_face(doc, uid), transform=m)
    kf(doc, ".K .float{animation:K-float 4.2s ease-in-out infinite;}"
            "@keyframes K-float{0%,100%{transform:translateY(0)}50%{transform:translateY(-6px)}}"
            ".K .cshade{animation:K-shade 4.2s ease-in-out infinite;}"
            f"@keyframes K-shade{{0%,100%{{opacity:{op_hi}}}50%{{opacity:{op_lo}}}}}")
    return shadow + el("g", card_svg, class_="float")


def pulse_rings(doc, transform, r, n=2):
    t = doc.t
    kf(doc, ".K .pulse{transform-box:view-box;transform-origin:0 0;animation:K-pulse 2.6s cubic-bezier(.2,.7,.3,1) infinite;}"
            "@keyframes K-pulse{0%{transform:scale(.35);opacity:0}15%{opacity:.75}100%{transform:scale(1.45);opacity:0}}")
    rings = "".join(el("circle", r=r, fill="none", stroke=t.accent, stroke_width=0.9, class_="pulse",
                       style=f"animation-delay:{i * 1.3:.1f}s", opacity=0) for i in range(n))
    return el("g", rings, transform=transform)


def vig_tap(doc, box):
    t = doc.t
    W, D, H = 92.0, 70.0, 5.0
    cu, cv = 40.0, 30.0           # tap centre on the slab (x, y)
    th, phi = math.radians(-12), math.radians(24)
    e1 = (math.cos(th), math.sin(th), 0.0)
    e2 = (math.sin(th) * math.cos(phi), -math.cos(th) * math.cos(phi), -math.sin(phi))
    se2 = (math.sin(th) * math.cos(phi), -math.cos(th) * math.cos(phi), 0.0)
    c3 = (cu + 16, cv + 26, H + 40)
    corners = [(x, y, z) for x in (0, W) for y in (0, D) for z in (0, H)]
    corners += [v_add(c3, v_add(v_mul(e1, a), v_mul(e2, b))) for a in (-43, 43) for b in (-27, 27)]
    cam = fit_cam(corners, box, 34, 30)
    svg, top_m = slab(doc, cam, W, D, H, 6, t.case)
    engr = shade(t.case, -0.30)
    lb = D - cv
    marks = []
    for dy, col, op in ((0.4, "#FFFFFF", 0.6), (0, engr, 0.9)):
        marks.append(el("circle", cx=cu, cy=lb + dy, r=20, fill="none", stroke=col, stroke_opacity=op, stroke_width=0.8))
        marks.append(nfc_arcs(cu + 1.2, lb + dy - 1.2, 12.4, col, 0.9, op))
    out = [svg, el("g", "".join(marks), transform=top_m),
           pulse_rings(doc, f"{top_m} translate({fmt(cu)} {fmt(lb)})", 20),
           floating_card(doc, cam, c3, e1, e2, (cu + 22, cv + 18, H + 0.05), e1, se2)]
    return "".join(out)


def vig_keypad(doc, box):
    t = doc.t
    W, D, H = 86.0, 94.0, 5.0
    corners = [(x, y, z) for x in (0, W) for y in (0, D) for z in (0, H)]
    cam = fit_cam(corners, box, 34, 36)
    svg, top_m = slab(doc, cam, W, D, H, 6, t.case)
    kx, ky = (W - 69.2) / 2, (D - 76.9) / 2
    rec = (el("rect", x=kx - 0.9, y=ky - 0.9, width=71, height=78.7, rx=2.4, fill=shade(t.case, -0.16))
           + el("g", keypad_face(doc, pressed="2", press_cls="kpress", ring=t.game["red"]),
                transform=f"translate({fmt(kx)} {fmt(ky)})"))
    kf(doc, ".K .kpress{transform-box:fill-box;transform-origin:center;animation:K-key 2.4s ease-in-out infinite;}"
            "@keyframes K-key{0%,55%,100%{transform:scale(1);opacity:1}62%,70%{transform:scale(.94);opacity:.82}}")
    return svg + el("g", rec, transform=top_m)


def vig_oled(doc, box, frames):
    """the oled module, the spin running on its glass."""
    t = doc.t
    W, D, T = 35.4, 33.5, 1.2
    corners = [(x, y, z) for x in (0, W) for y in (0, D) for z in (0, T + 1.45)]
    cam = fit_cam(corners, box, 30, 40)
    mask = "#1A4C9C"
    out = [ground_shadow(doc, cam, rounded_rect_pts(0, 0, W, D, 0.8, 2), spread=(2, 4), blur=4)]
    out.append(box3(cam, 0, 0, 0, W, D, T, mask, amb=0.7, dif=0.36))
    top = cam.plane((0, D, T), (1, 0, 0), (0, -1, 0))
    silk = []
    for hx, hy in ((2, 2), (W - 2, 2), (2, D - 2), (W - 2, D - 2)):
        silk.append(el("circle", cx=hx, cy=hy, r=1.6, fill="#D3D7DC"))
        silk.append(el("circle", cx=hx, cy=hy, r=1.0, fill="#0B0C0E"))
    for i, name in enumerate(("GND", "VCC", "SCL", "SDA")):
        x = W / 2 + (i - 1.5) * 2.54
        silk.append(el("circle", cx=x, cy=1.6, r=0.85, fill="#D3D7DC"))
        silk.append(el("circle", cx=x, cy=1.6, r=0.42, fill="#B08A3E"))
        silk.append(text(x, 4.3, name, size=1.05, weight=700, fill="#FFFFFF", anchor="middle", opacity=0.9))
    out.append(el("g", "".join(silk), transform=top))
    out.append(box3(cam, 0.45, D - 28.0, T, 34.5, 23.0, 1.45, "#101215", amb=0.8, dif=0.3))
    gtop = cam.plane((0.45, D - 5.0, T + 1.45), (1, 0, 0), (0, -1, 0))
    out.append(el("g", el("rect", x=0, y=19.5, width=34.5, height=3.5, fill="#1A1C20")
                  + el("rect", x=0, y=0, width=34.5, height=23, fill="none", stroke="#FFFFFF", stroke_opacity=0.08, stroke_width=0.2),
                  transform=gtop))
    aa_o = (0.45 + (34.5 - 29.42) / 2, D - 5.0 - 2.35, T + 1.46)
    m = cam.plane(aa_o, (29.42 / 128, 0, 0), (0, -14.70 / 64, 0))
    out.append(spin_screen(doc, frames, m, glow=0.5, margin=0.8))
    return "".join(out)


def vig_buzzer(doc, box):
    """KY-006 passive buzzer standing in a breadboard, playing the jingle."""
    t = doc.t
    BW, BD, BH = 44.0, 22.0, 8.5
    pcb_w, pcb_h, pcb_t = 15.0, 18.5, 1.6
    x0 = (BW - pcb_w) / 2
    y0 = 11.0
    z0 = BH + 2.5
    corners = [(x, y, z) for x in (0, BW) for y in (0, BD) for z in (0, BH)] + [(x0, y0, z0 + pcb_h), (x0 + pcb_w, y0, z0 + pcb_h)]
    cam = fit_cam(corners + [(-16, y0 - 10, z0 + pcb_h + 4)], box, 30, 26)
    bb_c = "#F1F1EE"
    out = [ground_shadow(doc, cam, rounded_rect_pts(0, 0, BW, BD, 1, 2), spread=(3, 5), blur=5)]
    out.append(box3(cam, 0, 0, 0, BW, BD, BH, bb_c, amb=0.72, dif=0.32))
    top = cam.plane((0, BD, BH), (1, 0, 0), (0, -1, 0))
    holes = []
    for r in range(7):
        for c in range(16):
            hx, hy = 2.2 + c * 2.54, 3.4 + r * 2.54
            holes.append(f"M{fmt(hx - 0.5)} {fmt(hy - 0.5)}h1v1h-1z")
    out.append(el("g", el("path", d="".join(holes), fill="#3A3D42", opacity=0.75), transform=top))
    # header and pcb standing in row c
    out.append(box3(cam, x0 + pcb_w / 2 - 3.81, y0 - 0.45, BH, 7.62, 2.5, 2.5, "#141518", amb=0.7, dif=0.3))
    out.append(box3(cam, x0, y0, z0, pcb_w, pcb_t, pcb_h, "#16181C", amb=0.75, dif=0.35))
    face = cam.plane((x0, y0, z0 + pcb_h), (1, 0, 0), (0, 0, -1))
    out.append(el("g", text(2.0, 16.6, "S", size=1.6, weight=700, fill="#F1F3F5")
                  + text(pcb_w - 2.0, 16.6, "−", size=1.9, weight=700, fill="#F1F3F5", anchor="end")
                  + text(pcb_w / 2, 2.6, "KY-006", size=1.3, weight=700, fill="#F1F3F5", anchor="middle"),
                  transform=face))
    can_c = (x0 + pcb_w / 2, y0, z0 + 11.0 - 2.5)
    cyl, hull, cap = cylinder3(cam, can_c, (0, -1, 0), 6.0, 8.5, "#141518", amb=0.75, dif=0.4)
    out.append(cyl)
    cc = cam.p(v_add(can_c, (0, -8.5, 0)))
    out.append(el("circle", cx=cc[0], cy=cc[1], r=0.9 * cam.s, fill="#050506"))
    # sound: arcs and notes, the jingle playing (the can faces the front left)
    out.append(el("circle", cx=cc[0], cy=cc[1], r=5.4 * cam.s, fill="none", stroke="#FFFFFF", stroke_opacity=0.10,
                  stroke_width=0.8))
    sx, sy = cc[0] - 2.0 * cam.s, cc[1] + 0.5 * cam.s
    waves = []
    for i in range(3):
        r = (7 + i * 5.5) * cam.s / 1.6
        a = math.radians(42)
        waves.append(el("path", d=f"M{fmt(sx - r * math.cos(a))} {fmt(sy - r * math.sin(a))}"
                        f"A{fmt(r)} {fmt(r)} 0 0 0 {fmt(sx - r * math.cos(a))} {fmt(sy + r * math.sin(a))}",
                        fill="none", stroke=t.accent, stroke_width=2.2, stroke_linecap="round", class_="wave",
                        style=f"animation-delay:{i * 0.22:.2f}s"))
    out.append("".join(waves))
    for i, (dx, dy, s_) in enumerate(((-34, -12, 1.0), (-24, -24, 0.8))):
        out.append(el("g", note_glyph(sx + dx * cam.s / 1.6, sy + dy * cam.s / 1.6, 11 * s_, t.accent),
                      class_="note", style=f"animation-delay:{i * 0.6:.1f}s"))
    kf(doc, ".K .wave{animation:K-wave 1.6s ease-out infinite;}"
            "@keyframes K-wave{0%{opacity:0}25%{opacity:.95}80%,100%{opacity:0}}"
            ".K .note{animation:K-note 2.4s ease-in-out infinite;}"
            "@keyframes K-note{0%{opacity:0;transform:translateY(6px)}30%{opacity:1}100%{opacity:0;transform:translateY(-10px)}}")
    return "".join(out)


def note_glyph(x, y, s, fill):
    """eighth note, (x, y) = centre of the note head."""
    return (el("ellipse", cx=x, cy=y, rx=s * 0.34, ry=s * 0.25, fill=fill, transform=f"rotate(-22 {fmt(x)} {fmt(y)})")
            + el("rect", x=x + s * 0.24, y=y - s * 1.05, width=s * 0.11, height=s * 1.05, fill=fill)
            + el("path", d=f"M{fmt(x + s * 0.35)} {fmt(y - s * 1.05)}q{fmt(s * 0.05)} {fmt(s * 0.35)} {fmt(s * 0.42)} {fmt(s * 0.5)}"
                 f"q{fmt(-s * 0.18)} {fmt(-s * 0.05)} {fmt(-s * 0.42)} {fmt(-s * 0.22)}z", fill=fill))


def vig_eeprom(doc, box, uid, balance, slots=31):
    """ATmega328P in its socket, the account record in two crc copies above it."""
    t = doc.t
    SW, SD, SH = 37.6, 10.2, 2.6
    CW, CD, CH = 35.2, 6.6, 3.2
    corners = [(x, y, z) for x in (0, SW) for y in (-2, SD + 2) for z in (0, SH + CH)] + [(2, -10, 30), (SW - 2, 20, 30)]
    cam = fit_cam(corners, box, 32, 30)
    out = [ground_shadow(doc, cam, rounded_rect_pts(0, 0, SW, SD, 0.6, 2), spread=(2, 4), blur=4)]
    out.append(box3(cam, 0, 0, 0, SW, SD, SH, "#2A2C31", amb=0.7, dif=0.35))
    cx0, cy0 = (SW - CW) / 2, (SD - CD) / 2
    legs = []
    for i in range(14):
        lx = cx0 + 1.2 + i * 2.54
        legs.append(box3(cam, lx, cy0 - 1.0, SH, 0.5, 1.0, 1.6, "#C3C8CE", amb=0.8, dif=0.4))
    out.append("".join(legs))
    out.append(box3(cam, cx0, cy0, SH + 0.6, CW, CD, CH, "#1B1C1F", amb=0.72, dif=0.35))
    ctop = cam.plane((cx0, cy0 + CD, SH + 0.6 + CH), (1, 0, 0), (0, -1, 0))
    out.append(el("g", el("path", d=f"M0 {fmt(CD / 2 - 1.1)}A1.1 1.1 0 0 1 0 {fmt(CD / 2 + 1.1)}Z", fill="#0B0B0D")
                  + text(CW / 2, CD / 2 - 0.2, "ATMEGA328P-PU", size=2.1, weight=600, fill="#C9CDD3", anchor="middle", ls=0.3)
                  + text(CW / 2, CD / 2 + 2.3, f"eeprom 1 KB · {slots} accounts", size=1.35, fill="#9AA1AA", anchor="middle"),
                  transform=ctop))
    # two record copies floating above
    for k, z in enumerate((14.0, 23.0)):
        pw, pd = 34.0, 15.0
        px, py = (SW - pw) / 2 + 1.0, SD / 2 - pd / 2 + 1
        out.append(box3(cam, px, py, z, pw, pd, 1.0, t.surface if not t.dark else t.surface3, amb=0.85, dif=0.2))
        ptop = cam.plane((px, py + pd, z + 1.0), (1, 0, 0), (0, -1, 0))
        out.append(el("g", text(2.4, 4.6, f"record {'ab'[k]}", size=2.2, weight=600, fill=t.muted, ls=0.2)
                      + text(pw - 2.4, 4.6, "crc ok", size=2.2, weight=600, fill=t.accent, anchor="end", ls=0.2)
                      + text(2.4, 10.6, uid, size=3.0, weight=600, fill=t.ink, cls="mono")
                      + text(pw - 2.4, 10.8, f"{balance}€", size=3.6, weight=700, fill=t.ink, anchor="end")
                      + el("rect", width=pw, height=pd, rx=0.8, fill="none", stroke=t.accent, stroke_width=0.4,
                           class_="write", style=f"animation-delay:{k * 0.25:.2f}s"),
                      transform=ptop))
    kf(doc, ".K .write{animation:K-write 3.2s ease-in-out infinite;opacity:.25}"
            "@keyframes K-write{0%,100%{opacity:.25}12%{opacity:1}40%{opacity:.25}}")
    return "".join(out)


def spin_plan(start=2, result=1):
    """the firmware's spin as [(index, ms)], ending on the drawn result."""
    count = spin_steps(start, result)
    return [(spin_led(start, s), spin_delay(s, count)) for s in range(count)]


SPIN_HOLD_MS = 2600
COLOUR_NAMES = ("SCHWARZ", "ROT", "GRUEN")


def spin_line(i):
    name = COLOUR_NAMES[i]
    n = len(name) + 4
    left = (16 - n) // 2
    return (" " * left + "> " + name + " <").ljust(16)


def spin_screen(doc, frames, transform, glow=0.55, margin=2.4, radius=1.2):
    """oled with the spin animation: base frame plus one layer per colour, timed like lauflicht()."""
    base_fb, layers = frames
    plan = spin_plan()
    total = sum(ms for _, ms in plan) + SPIN_HOLD_MS
    css = []
    extra = []
    for idx in range(3):
        # visible intervals of this colour
        t0, keys = 0, []
        for j, (i, ms) in enumerate(plan):
            end = t0 + ms + (SPIN_HOLD_MS if j == len(plan) - 1 else 0)
            if i == idx:
                keys.append((t0, end))
            t0 += ms
        stops = ["0%{opacity:0}"]
        for a, b in keys:
            stops.append(f"{a / total * 100:.3f}%{{opacity:1}}")
            stops.append(f"{min(b / total * 100, 100):.3f}%{{opacity:0}}")
        if keys and keys[-1][1] >= total:
            stops[-1] = "100%{opacity:1}"
        css.append(f".K .spin{idx}{{opacity:{1 if idx == plan[-1][0] else 0};animation:K-spin{idx} {total / 1000:.3f}s steps(1,end) infinite;}}"
                   f"@keyframes K-spin{idx}{{{''.join(stops)}}}")
        d = fb_path(layers[idx], range(32, 48))
        extra.append(el("g", el("path", d=d, fill=OLED_GLOW, opacity=glow, filter=oled_defs(doc, OLED_ON)[1])
                        + el("path", d=d, fill=OLED_ON), class_=f"spin{idx}"))
    kf(doc, "".join(css))
    return oled_screen(doc, base_fb, transform, glow=glow, extra_layers="".join(extra), margin=margin, radius=radius)


def wrap(s, size, width, weight=400):
    words, lines, cur = s.split(), [], ""
    for w in words:
        trial = (cur + " " + w).strip()
        if tw(trial, size, weight) > width and cur:
            lines.append(cur)
            cur = w
        else:
            cur = trial
    if cur:
        lines.append(cur)
    return lines


def hiw_steps(doc, fw):
    """the five steps: (title, caption, vignette(box), oled frame or None for the spin), plus the spin frames."""
    o = fw["oled"]
    r = fw["rules"]
    start, stake = r["STARTGUTHABEN"], r["STAKE"]
    win = start + stake            # bet on red, red comes up: pays 2x, net +stake
    menu_hint = "1-3 setzen  D=?"
    tipp = o.frame("Tipp: ROT", "", menu_hint)   # the hint line is only redrawn in loop(), so it stays
    spin_frames = (tipp, [o.frame("Tipp: ROT", spin_line(i), menu_hint) for i in range(3)])

    def amount_line(name, value, sign=""):
        v = f"{sign}{value}€"
        return name + " " * (16 - len(name) - len(v)) + v
    steps = [
        ("tap your card", f"the rc522 reads the uid through the lid. a new card starts with {start}€.",
         lambda b: vig_tap(doc, b), o.frame(amount_line("Guthaben", start), amount_line("Einsatz", stake), menu_hint)),
        ("pick a colour", "1 black, 2 red, 3 green. the round is drawn and booked before anything spins.",
         lambda b: vig_keypad(doc, b), o.frame("Buche Runde...", "", menu_hint)),
        ("watch the spin", "the colours run on the oled, slow down and stop on the drawn result.",
         lambda b: vig_oled(doc, b, spin_frames), None),
        ("hear the result", "black and red pay 2×, green pays 9×. the buzzer plays the win, loss or jackpot jingle.",
         lambda b: vig_buzzer(doc, b), o.frame("ROT", amount_line("Gewinn", stake, "+"), menu_hint)),
        ("kept on the uno", "the balance lives in the eeprom in two crc copies. the card is only the key.",
         lambda b: vig_eeprom(doc, b, "DF51AA39", win, r["slots"]),
         o.frame(amount_line("Gewinn", stake, "+"), amount_line("Guthaben", win), "1-3 nochmal")),
    ]
    return steps, spin_frames


def hiw_card(doc, x, y, w, h, i, title):
    t = doc.t
    sh = shadow_filter(doc, "cardshadow2", 6, 10, 0.07 if not t.dark else 0.0)
    doc.add(el("rect", x=x, y=y, width=w, height=h, rx=18, fill=t.surface, filter=sh if not t.dark else None))
    doc.add(el("rect", x=x + 0.5, y=y + 0.5, width=w - 1, height=h - 1, rx=17.5, fill="none",
               stroke=t.line2_hex, stroke_opacity=t.line2_a))
    doc.add(el("circle", cx=x + 28, cy=y + 30, r=12, fill=t.accent, fill_opacity=0.14 if not t.dark else 0.2))
    doc.add(text(x + 28, y + 34.5, str(i + 1), size=12.5, weight=700, fill=t.accent, anchor="middle"))
    doc.add(text(x + 48, y + 35.5, title, size=16, weight=650, fill=t.ink, ls=-0.2))


def hiw_screen(doc, frame, spin_frames, ox, oy, px):
    tr = f"translate({fmt(ox)} {fmt(oy)}) scale({px})"
    if frame is None:
        doc.add(spin_screen(doc, spin_frames, tr, margin=2.6))
    else:
        doc.add(oled_screen(doc, frame, tr, margin=2.6, radius=1.2))


def hiw_chevron(doc, ax, ay, down=False):
    t = doc.t
    doc.add(el("circle", cx=ax, cy=ay, r=13, fill=t.surface if not t.dark else t.surface2, stroke=t.line2_hex,
               stroke_opacity=t.line2_a))
    d = f"M{fmt(ax - 5)} {fmt(ay - 2.5)}l5 5 5-5" if down else f"M{fmt(ax - 2.5)} {fmt(ay - 5)}l5 5-5 5"
    doc.add(el("path", d=d, fill="none", stroke=t.muted, stroke_width=1.8, stroke_linecap="round", stroke_linejoin="round"))


def how_it_works(doc, fw):
    t = doc.t
    doc.add(card_bg(doc, r=24))
    doc.add(text(36, 44, "how a round works", size=17, weight=650, fill=t.ink, ls=-0.2))
    doc.add(text(doc.w - 36, 44, "every screen is a real oled frame, rendered from the firmware font", size=13,
                 fill=t.muted, anchor="end"))
    steps, spin_frames = hiw_steps(doc, fw)
    n = len(steps)
    x0, gap, y0, ch = 28, 22, 70, doc.h - 70 - 26
    cw = (doc.w - 2 * x0 - (n - 1) * gap) / n
    for i, (title, caption, vig, frame) in enumerate(steps):
        x = x0 + i * (cw + gap)
        hiw_card(doc, x, y0, cw, ch, i, title)
        doc.add(vig((x + 14, y0 + 58, cw - 28, 136)))
        px = 1.42
        ox, oy = x + (cw - 128 * px) / 2, y0 + 216
        hiw_screen(doc, frame, spin_frames, ox, oy, px)
        for k, line in enumerate(wrap(caption, 13.5, cw - 36)):
            doc.add(text(x + 18, oy + 64 * px + 34 + k * 19.5, line, size=13.5, fill=t.ink2))
        if i < n - 1:
            hiw_chevron(doc, x + cw + gap / 2, y0 + 126)


def how_it_works_narrow(doc, fw):
    """phones: the five steps as a vertical list, render left, screen and text right."""
    t = doc.t
    doc.add(card_bg(doc, r=24))
    doc.add(text(32, 46, "how a round works", size=20, weight=650, fill=t.ink, ls=-0.2))
    doc.add(text(32, 70, "real oled frames, rendered from the firmware font", size=14, fill=t.muted))
    steps, spin_frames = hiw_steps(doc, fw)
    x, y, w, h, gap = 20, 96, doc.w - 40, 300, 18
    for i, (title, caption, vig, frame) in enumerate(steps):
        yy = y + i * (h + gap)
        hiw_card(doc, x, yy, w, h, i, title)
        doc.add(vig((x + 12, yy + 58, 220, 186)))
        px = 2.25
        ox, oy = x + w - 128 * px - 22, yy + 56
        hiw_screen(doc, frame, spin_frames, ox, oy, px)
        for k, line in enumerate(wrap(caption, 16, 128 * px + 4)):
            doc.add(text(ox - 2, oy + 64 * px + 34 + k * 22, line, size=16, fill=t.ink2))
        if i < len(steps) - 1:
            hiw_chevron(doc, x + w / 2, yy + h + gap / 2, down=True)


# =====================================================================================
# 3. schematic
# =====================================================================================
AVR = {  # Uno pin -> (ATmega328P port, DIP-28 pin, alternate function)
    "D0": ("PD0", 2, "RX"), "D1": ("PD1", 3, "TX"), "D2": ("PD2", 4, ""), "D3": ("PD3", 5, ""),
    "D4": ("PD4", 6, ""), "D5": ("PD5", 11, ""), "D6": ("PD6", 12, ""), "D7": ("PD7", 13, ""),
    "D8": ("PB0", 14, ""), "D9": ("PB1", 15, ""), "D10": ("PB2", 16, "SS"), "D11": ("PB3", 17, "MOSI"),
    "D12": ("PB4", 18, "MISO"), "D13": ("PB5", 19, "SCK"), "A0": ("PC0", 23, ""), "A1": ("PC1", 24, ""),
    "A2": ("PC2", 25, ""), "A3": ("PC3", 26, ""), "A4": ("PC4", 27, "SDA"), "A5": ("PC5", 28, "SCL"),
}


def keypad_roles(fw, wires):
    """keypad pin -> (uno pin, 'row'|'col', index 1..4, the four keys), from the firmware tables."""
    kp = fw["keypad"]
    chars = kp["chars"]
    out = {}
    for w in wires:
        if w["a"][0] == "keypad":
            pin, uno = w["a"][1], w["b"][1]
            if uno in kp["rows"]:
                r = kp["rows"].index(uno)
                out[pin] = (uno, "row", r + 1, chars[r * 4:r * 4 + 4], w["net"])
            elif uno in kp["cols"]:
                c = kp["cols"].index(uno)
                out[pin] = (uno, "col", c + 1, "".join(chars[r * 4 + c] for r in range(4)), w["net"])
            else:
                fail(f"keypad wire {w['id']} goes to {uno}, which is neither a row nor a column in GameRuntime.h")
    return out


class Sch:
    """tiny schematic toolkit: wires per net, pins, power symbols, labels, junctions."""

    def __init__(self, doc, nets):
        self.doc, self.t, self.nets = doc, doc.t, nets
        self.bands, self.parts, self.wires, self.labels, self.dots, self.over = [], [], [], [], [], []
        t = self.t
        self.case_c, self.case_a = ("#0F1115", 0.30) if not t.dark else ("#FFFFFF", 0.20)
        self.ink = t.ink
        self.pin_c = t.ink2
        self.body_fill = t.surface2 if not t.dark else t.surface2
        self.body_stroke = t.ink2

    def wire(self, net, points, extra=""):
        d = path_d(points, close=False)
        col = self.nets[net]["color"]
        self.wires.append(el("g", el("path", d=d, fill="none", stroke=self.case_c, stroke_opacity=self.case_a, stroke_width=4.4,
                                     stroke_linejoin="round", stroke_linecap="round")
                             + el("path", d=d, fill="none", stroke=col, stroke_width=2.2, stroke_linejoin="round",
                                  stroke_linecap="round") + extra,
                             class_="net", data_net=net))

    def dot(self, net, x, y):
        self.dots.append(el("g", el("circle", cx=x, cy=y, r=4.2, fill=self.case_c, fill_opacity=self.case_a + 0.2)
                            + el("circle", cx=x, cy=y, r=3.1, fill=self.nets[net]["color"]), class_="net", data_net=net))

    def label(self, net, x, y, s, anchor="start", rotate=False, size=11.5, color=None):
        tr = f"rotate(-90 {fmt(x)} {fmt(y)})" if rotate else None
        self.labels.append(el("g", text(x, y, s, size=size, fill=color or self.t.ink2, anchor=anchor, cls="mono",
                                         transform=tr), class_="net", data_net=net))

    def nc(self, x, y):
        s = 4.5
        self.over.append(el("path", d=f"M{fmt(x - s)} {fmt(y - s)}L{fmt(x + s)} {fmt(y + s)}M{fmt(x + s)} {fmt(y - s)}L{fmt(x - s)} {fmt(y + s)}",
                            stroke=self.t.ink2, stroke_width=1.5, stroke_linecap="round", class_="nc"))

    def power(self, net, x, y, kind, label=None):
        """power symbol whose connection point is (x, y). kind: 'up' (supply) or 'gnd'."""
        t = self.t
        c = t.ink2
        if kind == "up":
            g = (el("path", d=f"M{fmt(x)} {fmt(y)}V{fmt(y - 16)}M{fmt(x - 9)} {fmt(y - 16)}H{fmt(x + 9)}", stroke=c,
                    stroke_width=1.6, stroke_linecap="round", fill="none")
                 + text(x, y - 23, label, size=12, weight=650, fill=t.ink, anchor="middle"))
        else:
            g = (el("path", d=f"M{fmt(x)} {fmt(y)}V{fmt(y + 12)}M{fmt(x - 10)} {fmt(y + 12)}H{fmt(x + 10)}"
                                 f"M{fmt(x - 6.5)} {fmt(y + 16.5)}H{fmt(x + 6.5)}M{fmt(x - 3)} {fmt(y + 21)}H{fmt(x + 3)}",
                    stroke=c, stroke_width=1.6, stroke_linecap="round", fill="none")
                 + text(x, y + 36, label or "GND", size=10.5, weight=600, fill=t.muted, anchor="middle"))
        self.labels.append(el("g", g, class_="net power", data_net=net))

    def part(self, pid, body, pins_svg, texts):
        self.parts.append(el("g", body + pins_svg + texts, class_="part", data_part=pid))

    def render(self):
        return "".join(self.bands + self.parts + self.wires + self.over + self.dots + self.labels)


def sch_pin(s, x, y, side, length, name, num=None, sub=None, name_size=12.5, inside=True):
    """pin from the body edge (x, y) outward; returns (svg, tip)."""
    t = s.t
    dx, dy = {"l": (-1, 0), "r": (1, 0), "t": (0, -1), "b": (0, 1)}[side]
    tip = (x + dx * length, y + dy * length)
    out = [el("line", x1=x, y1=y, x2=tip[0], y2=tip[1], stroke=s.pin_c, stroke_width=1.5)]
    if side in "lr":
        a = "start" if side == "l" else "end"
        ix = x + (8 if side == "l" else -8)
        out.append(text(ix, y + 4.3, name, size=name_size, weight=550, fill=t.ink, anchor=a))
        if sub:
            sx = ix + (1 if side == "l" else -1) * (tw(name, name_size, 550) + 7)
            out.append(text(sx, y + 4.0, sub, size=10.5, fill=t.muted, anchor=a, cls="mono"))
        if num is not None:
            nx = x + dx * 6
            out.append(text(nx, y - 4.5, str(num), size=10, fill=t.muted, anchor="end" if side == "l" else "start", cls="mono"))
    else:
        rot = f"rotate(-90 {fmt(x)} {fmt(y)})"
        if side == "b":
            out.append(text(x + 8, y + 4.3, name, size=name_size, weight=550, fill=t.ink, anchor="start", transform=rot))
            if sub:
                out.append(text(x + 8 + tw(name, name_size, 550) + 6, y + 4.0, sub, size=10.5, fill=t.muted, cls="mono",
                                transform=rot))
            if num is not None:
                out.append(text(x - 5, y + 6 + 4, str(num), size=10, fill=t.muted, anchor="end", cls="mono",
                                transform=f"rotate(-90 {fmt(x - 5)} {fmt(y + 10)})"))
        else:
            out.append(text(x - 8, y + 4.3, name, size=name_size, weight=550, fill=t.ink, anchor="end", transform=rot))
            if num is not None:
                out.append(text(x - 5, y - 6, str(num), size=10, fill=t.muted, anchor="start", cls="mono",
                                transform=f"rotate(-90 {fmt(x - 5)} {fmt(y - 6)})"))
    return "".join(out), tip


def sch_body(s, x, y, w, h):
    return el("rect", x=x, y=y, width=w, height=h, rx=3, fill=s.body_fill, stroke=s.body_stroke, stroke_width=1.6)


def schematic(doc, fw, nets, wires):
    t = doc.t
    s = Sch(doc, nets)
    roles = keypad_roles(fw, wires)
    W, H = doc.w, doc.h
    paper = t.surface if not t.dark else t.bg2
    doc.add(el("rect", x=0.5, y=0.5, width=W - 1, height=H - 1, rx=20, fill=paper, stroke=t.line2_hex,
               stroke_opacity=t.line2_a))
    ix0, iy0, ix1, iy1 = sheet_frame(doc, 7, 5)
    G = 20  # pin pitch, 0.1 inch

    # ---------------------------------------------------------------- A1 arduino uno r3
    ux, uy, uw, uh = 520, 170, 300, 400
    right = ["D0", "D1", "D2", "D3", "D4", "D5", "D6", "D7", "D8", "D9", "D10", "D11", "D12", "D13"]
    left = [("5V", 0), ("3V3", 1), ("VIN", 2), ("GND", 4), ("GND", 5), ("GND", 6), ("IOREF", 8), ("RESET", 9), ("AREF", 10)]
    bottom = ["A5", "A4", "A3", "A2", "A1", "A0"]
    pins, tips = [], {}
    for i, name in enumerate(right):
        port, num, alt = AVR[name]
        sub = port + (f" · {alt}" if alt else "") + (" · usb" if name in ("D0", "D1") else "")
        svg, tip = sch_pin(s, ux + uw, uy + 40 + i * G, "r", 30, name, num, sub)
        pins.append(svg)
        tips[name] = tip
    gi = 0
    for name, slot in left:
        svg, tip = sch_pin(s, ux, uy + 40 + slot * G, "l", 30, name)
        pins.append(svg)
        if name == "GND":
            gi += 1
            name = f"GND{gi}"
        tips[name] = tip
    for i, name in enumerate(bottom):
        port, num, alt = AVR[name]
        sub = port + (f" · {alt}" if alt else "")
        svg, tip = sch_pin(s, ux + 30 + i * G, uy + uh, "b", 30, name, num, sub, name_size=12)
        pins.append(svg)
        tips[name] = tip
    mx = ux + uw / 2 + 4
    texts = (text(ux, uy - 12, "A1", size=14, weight=700, fill=t.ink)
             + text(ux + 26, uy - 12, "Arduino Uno R3", size=12.5, fill=t.muted)
             + text(mx, uy + 230, "ARDUINO", size=13, weight=700, fill=t.ink, anchor="middle", ls=1.2)
             + text(mx, uy + 247, "UNO R3", size=13, weight=700, fill=t.ink, anchor="middle", ls=1.2)
             + text(mx, uy + 266, "ATmega328P", size=11, fill=t.muted, anchor="middle")
             + text(mx, uy + 281, "16 MHz", size=11, fill=t.muted, anchor="middle")
             + el("rect", x=mx - 26, y=uy + 300, width=52, height=24, rx=3, fill="none", stroke=t.muted, stroke_width=1)
             + text(mx, uy + 316, "USB-B", size=10, weight=600, fill=t.muted, anchor="middle")
             + text(mx, uy + 340, "pc · 115200 baud", size=10, fill=t.muted, anchor="middle"))
    s.part("uno", sch_body(s, ux, uy, uw, uh), "".join(pins), texts)
    for name in ("D0", "D1", "VIN", "IOREF", "RESET", "AREF", "A2", "A3"):
        s.nc(*tips[name])

    x5, y5 = tips["5V"]
    s.wire("V5", [(x5, y5), (x5 - 40, y5)])
    s.power("V5", x5 - 40, y5, "up", "+5V")
    x3, y3 = tips["3V3"]
    s.wire("V3V3", [(x3, y3), (x3 - 90, y3)])
    s.power("V3V3", x3 - 90, y3, "up", "+3V3")
    gx = tips["GND1"][0] - 30
    ys = [tips[f"GND{i}"][1] for i in (1, 2, 3)]
    for yy in ys:
        s.wire("GND", [(tips["GND1"][0], yy), (gx, yy)])
    s.wire("GND", [(gx, ys[0]), (gx, ys[-1] + 20)])
    s.dot("GND", gx, ys[1])
    s.dot("GND", gx, ys[2])
    s.power("GND", gx, ys[-1] + 20, "gnd")

    # ---------------------------------------------------------------- R1 and BZ1 on D2
    tx, ty = tips["D2"]
    bzx, bzy = 1090, 76
    s_y = bzy + 30
    rx0 = tx + 60
    s.wire("BUZ", [(tx, ty), (tx + 30, ty), (tx + 30, s_y), (rx0, s_y)])
    s.label("BUZ", tx + 38, s_y - 7, "D2")
    res = (el("path", d=f"M{rx0} {s_y}h8l3-7 6 14 6-14 6 14 6-14 6 14 6-14 3 7h8", fill="none", stroke=s.pin_c,
              stroke_width=1.6, stroke_linejoin="round")
           + text(rx0 + 37, s_y - 17, "R1", size=13, weight=700, fill=t.ink, anchor="middle")
           + text(rx0 + 37, s_y + 27, "330 Ω", size=12, fill=t.muted, anchor="middle"))
    s.part("resistor", res, "", "")
    bz_pins = []
    sv, tip_s = sch_pin(s, bzx, s_y, "l", 30, "S", 1)
    bz_pins.append(sv)
    sv, tip_m = sch_pin(s, bzx, s_y + G, "l", 30, "mid", 2)
    bz_pins.append(sv)
    sv, tip_g = sch_pin(s, bzx, s_y + 2 * G, "l", 30, "−", 3)
    bz_pins.append(sv)
    s.wire("BUZ_S", [(rx0 + 74, s_y), tip_s])
    s.label("BUZ_S", rx0 + 84, s_y - 7, "S")
    s.nc(*tip_m)
    s.wire("GND", [tip_g, (tip_g[0] - 20, tip_g[1]), (tip_g[0] - 20, tip_g[1] + 22)])
    s.power("GND", tip_g[0] - 20, tip_g[1] + 22, "gnd")
    bcx, bcy = bzx + 86, s_y + 10
    bsym = (el("path", d=f"M{bcx - 15} {bcy + 12}h30M{bcx - 15} {bcy + 12}a15 15 0 0 1 30 0", fill="none", stroke=s.pin_c,
               stroke_width=1.5)
            + el("path", d=f"M{bcx - 6} {bcy + 12}v10M{bcx + 6} {bcy + 12}v10", stroke=s.pin_c, stroke_width=1.5))
    s.part("buzzer", sch_body(s, bzx, bzy, 130, 92) + bsym, "".join(bz_pins),
           text(bzx, bzy - 12, "BZ1", size=14, weight=700, fill=t.ink)
           + text(bzx + 36, bzy - 12, "passive buzzer KY-006", size=12, fill=t.muted))

    # ---------------------------------------------------------------- DS1 oled, i2c
    ox, oy, ow, oh = 240, 640, 150, 110
    o_pins = []
    sv, t_scl = sch_pin(s, ox + ow, oy + 40, "r", 30, "SCL", 3)
    o_pins.append(sv)
    sv, t_sda = sch_pin(s, ox + ow, oy + 40 + G, "r", 30, "SDA", 4)
    o_pins.append(sv)
    sv, t_vcc = sch_pin(s, ox + 110, oy, "t", 30, "VCC", 2, name_size=11.5)
    o_pins.append(sv)
    sv, t_gnd = sch_pin(s, ox + 110, oy + oh, "b", 30, "GND", 1, name_size=11.5)
    o_pins.append(sv)
    scr = (el("rect", x=ox + 16, y=oy + 22, width=56, height=30, rx=2, fill="#030405")
           + el("rect", x=ox + 18, y=oy + 24, width=52, height=5, fill=OLED_ON, opacity=0.85)
           + el("rect", x=ox + 20, y=oy + 33, width=30, height=4, fill=OLED_ON, opacity=0.6)
           + el("rect", x=ox + 20, y=oy + 41, width=22, height=4, fill=OLED_ON, opacity=0.6))
    s.part("oled", sch_body(s, ox, oy, ow, oh) + scr, "".join(o_pins),
           text(ox, oy - 12, "DS1", size=14, weight=700, fill=t.ink)
           + text(ox + 38, oy - 12, "1.3″ OLED", size=12, fill=t.muted)
           + text(ox + 16, oy + 72, "128×64 SH1106", size=11, fill=t.muted)
           + text(ox + 16, oy + 88, "I2C 0x3C", size=11, fill=t.muted))
    a5, a4 = tips["A5"], tips["A4"]
    s.wire("SCL", [a5, (a5[0], t_scl[1]), t_scl])
    s.wire("SDA", [a4, (a4[0], t_sda[1]), t_sda])
    s.label("SCL", t_scl[0] + 14, t_scl[1] - 6, "SCL")
    s.label("SDA", t_sda[0] + 14, t_sda[1] - 6, "SDA")
    s.power("V5", t_vcc[0], t_vcc[1], "up", "+5V")
    s.power("GND", t_gnd[0], t_gnd[1], "gnd")
    s.bands.append(band(s, t_scl[0] + 6, t_scl[1] - 24, a4[0] - t_scl[0] + 4, 52, "I2C · 400 kHz"))

    # ---------------------------------------------------------------- U1 rc522, spi, 3.3 V
    spi = [("D9", "RST", 7, "RST"), ("D10", "SDA", 1, "SS"), ("D11", "MOSI", 3, "MOSI"), ("D12", "MISO", 4, "MISO"),
           ("D13", "SCK", 2, "SCK")]
    rx, ry, rw, rh = 1010, 560, 190, 180
    r_pins, rtips = [], {}
    for i, (uno, name, num, net) in enumerate(spi):
        sv, tip = sch_pin(s, rx, ry + 40 + i * G, "l", 30, name, num)
        r_pins.append(sv)
        rtips[name] = tip
    sv, t_irq = sch_pin(s, rx, ry + 40 + 5 * G, "l", 30, "IRQ", 5)
    r_pins.append(sv)
    sv, t_33 = sch_pin(s, rx + rw - 30, ry, "t", 30, "3.3V", 8, name_size=11.5)
    r_pins.append(sv)
    sv, t_rg = sch_pin(s, rx + rw - 30, ry + rh, "b", 30, "GND", 6, name_size=11.5)
    r_pins.append(sv)
    acx, acy = rx + 112, ry + 82
    ant = "".join(el("rect", x=acx - 28 + k * 6, y=acy - 28 + k * 6, width=56 - k * 12, height=56 - k * 12, rx=9 - k * 2,
                     fill="none", stroke=s.pin_c, stroke_width=1.1, stroke_opacity=0.7) for k in range(3))
    s.part("rc522", sch_body(s, rx, ry, rw, rh) + ant, "".join(r_pins),
           text(rx, ry - 12, "U1", size=14, weight=700, fill=t.ink) + text(rx + 26, ry - 12, "RC522 RFID", size=12, fill=t.muted)
           + text(acx, ry + rh - 26, "MFRC522", size=11, fill=t.muted, anchor="middle")
           + text(acx, ry + rh - 11, "13.56 MHz", size=11, fill=t.muted, anchor="middle"))
    s.nc(*t_irq)
    jx0 = tips["D9"][0] + 30
    for i, (uno, name, num, net) in enumerate(spi):
        a, b = tips[uno], rtips[name]
        jx = jx0 + (len(spi) - 1 - i) * 16
        s.wire(net, [a, (jx, a[1]), (jx, b[1]), b])
    s.power("V3V3", t_33[0], t_33[1], "up", "+3V3")
    s.power("GND", t_rg[0], t_rg[1], "gnd")
    s.bands.append(band(s, jx0 - 10, rtips["RST"][1] - 22, rtips["RST"][0] - jx0 + 4,
                        rtips["SCK"][1] - rtips["RST"][1] + 44, "SPI", below=True))

    # ---------------------------------------------------------------- SW1 keypad with its connector J1
    kx, ky, kw, kh = 560, 930, 400, 180
    order = sorted(roles, key=lambda p: -int(p[1:]))     # P8 .. P1, left to right as seen from the front
    jtips, k_pins = {}, []
    for i, p in enumerate(order):
        uno, kind, idx, keys, net = roles[p]
        sv, tip = sch_pin(s, kx + 30 + i * G, ky, "t", 30, ("R" if kind == "row" else "C") + str(idx), p[1:], name_size=11)
        k_pins.append(sv)
        jtips[p] = tip
    rows_y = [ky + 46 + r * 26 for r in range(4)]
    cols_x = [kx + 236 + c * 46 for c in range(4)]
    mat = []
    for p in order:
        uno, kind, idx, keys, net = roles[p]
        x = jtips[p][0]
        if kind == "row":
            yv = rows_y[idx - 1]
            seg = [(x, ky), (x, yv), (cols_x[-1] + 10, yv)]
            lab = text(cols_x[0] - 34, yv - 4, f"R{idx} {keys}", size=9.5, fill=t.muted, cls="mono", anchor="end")
        else:
            xc = cols_x[idx - 1]
            jy = ky + 12 + (4 - idx) * 6
            seg = [(x, ky), (x, jy), (xc, jy), (xc, rows_y[-1] + 24)]
            lab = text(xc + 4, rows_y[-1] + 36, f"C{idx}", size=9.5, fill=t.muted, cls="mono", anchor="middle")
        col = nets[net]["color"]
        d = path_d(seg, False)
        mat.append(el("g", el("path", d=d, fill="none", stroke=s.case_c, stroke_opacity=s.case_a, stroke_width=3.4,
                              stroke_linejoin="round")
                      + el("path", d=d, fill="none", stroke=col, stroke_width=1.6, stroke_linejoin="round") + lab,
                      class_="net", data_net=net))
    chars = fw["keypad"]["chars"]
    for r in range(4):
        for c in range(4):
            xc, yr = cols_x[c], rows_y[r]
            ax = xc - 14
            mat.append(el("path", d=f"M{fmt(ax)} {fmt(yr)}V{fmt(yr + 5)}M{fmt(ax)} {fmt(yr + 13)}V{fmt(yr + 18)}H{fmt(xc)}"
                                    f"M{fmt(ax - 1)} {fmt(yr + 5.5)}L{fmt(ax + 5)} {fmt(yr + 12.5)}", fill="none", stroke=s.pin_c,
                          stroke_width=1.2, stroke_linecap="round")
                       + el("circle", cx=ax, cy=yr, r=2.2, fill=s.pin_c) + el("circle", cx=xc, cy=yr + 18, r=2.2, fill=s.pin_c)
                       + text(ax - 6, yr + 15, chars[r * 4 + c], size=11, weight=700, fill=t.ink, anchor="end"))
    s.part("keypad", sch_body(s, kx, ky, kw, kh) + "".join(mat), "".join(k_pins),
           text(kx + 16, ky + kh - 30, "SW1", size=14, weight=700, fill=t.ink)
           + text(kx + 56, ky + kh - 30, "4×4 membrane keypad", size=12, fill=t.muted)
           + text(kx + 16, ky + kh - 13, "J1: pin 1 = right contact, tail down", size=11, fill=t.muted))
    # D3..D8 run down the right edge, A0 and A1 come straight down from the uno
    d_pins = sorted([p for p in roles if roles[p][0].startswith("D")], key=lambda p: int(p[1:]))   # P1 (D3) first
    for i, p in enumerate(d_pins):
        uno, kind, idx, keys, net = roles[p]
        a, tip = tips[uno], jtips[p]
        xt = 1320 - i * 18
        hy = ky - 76 + (len(d_pins) - 1 - i) * 12
        s.wire(net, [a, (xt, a[1]), (xt, hy), (tip[0], hy), tip])
        s.label(net, a[0] + 10, a[1] - 5, f"{kind} {keys}", size=10.5)
    for p in sorted([p for p in roles if roles[p][0].startswith("A")], key=lambda p: int(p[1:])):
        uno, kind, idx, keys, net = roles[p]
        a, tip = tips[uno], jtips[p]
        hy = ky - 96 - (int(p[1:]) - 7) * 14      # A1 (pin 8) above A0 (pin 7)
        s.wire(net, [a, (a[0], hy), (tip[0], hy), tip])
        s.label(net, a[0] + 7, hy - 40, f"{kind} {keys}", size=10.5, rotate=True)
    s.bands.append(band(s, 1320 - 5 * 18 - 14, tips["D3"][1] - 24, 5 * 18 + 28, ky - 76 - tips["D3"][1] + 6, "KEYPAD"))

    # ---------------------------------------------------------------- notes, title block
    notes = ["all grounds are common: uno, oled, rc522 and buzzer.",
             "the rc522 runs on 3.3 V only, never on 5 V.",
             "keypad: one row at a time is driven low, the columns",
             "read it through the internal pull-ups. no resistors.",
             "i2c pull-ups sit on the oled module.",
             "d0 and d1 stay free for usb, a2 and a3 are spare.",
             "wire colours are the jumper colours of the build."]
    nx, ny = 64, 880
    out = [text(nx, ny, "notes", size=12.5, weight=700, fill=t.ink)]
    for i, line in enumerate(notes):
        out.append(text(nx, ny + 22 + i * 17, line, size=11.5, fill=t.ink2))
    doc.add("".join(out))
    # net legend, top left: the jumper colours used in the build and in 3d
    lx, ly = 64, 78
    doc.add(text(lx, ly, "nets", size=12.5, weight=700, fill=t.ink))
    groups = [("GND", "V5", "V3V3"), ("SDA", "SCL", "BUZ"), ("SS", "SCK", "MOSI"), ("MISO", "RST")]
    for gi_, grp in enumerate(groups):
        for k, nid in enumerate(grp):
            x = lx + k * 96
            y = ly + 20 + gi_ * 19
            n = nets[nid]
            lab = {"V5": "5V", "V3V3": "3.3V", "BUZ": "D2 buzzer", "SS": "SS D10", "SCK": "SCK D13", "MOSI": "MOSI D11",
                   "MISO": "MISO D12", "RST": "RST D9", "SDA": "SDA A4", "SCL": "SCL A5"}.get(nid, n["label"])
            doc.add(el("g", el("rect", x=x, y=y - 7, width=16, height=6, rx=3, fill=n["color"], stroke=s.case_c,
                               stroke_opacity=s.case_a, stroke_width=0.8)
                       + text(x + 22, y, lab, size=10.5, fill=t.ink2), class_="net", data_net=nid))
    y = ly + 20 + 4 * 19
    kp = [n for n in nets.values() if n["group"] == "keypad"]
    for k, n in enumerate(kp):
        doc.add(el("g", el("rect", x=lx + k * 10, y=y - 7, width=8, height=6, rx=2, fill=n["color"], stroke=s.case_c,
                           stroke_opacity=s.case_a, stroke_width=0.8), class_="net", data_net=n["id"]))
    doc.add(text(lx + len(kp) * 10 + 8, y, "keypad 1–8, rainbow ribbon", size=10.5, fill=t.ink2))
    doc.add(s.render())
    doc.add(title_block(doc, ix1 - 380, iy1 - 120, 380, 120))


def sheet_frame(doc, ncol, nrow):
    t = doc.t
    W, H = doc.w, doc.h
    fx0, fy0, fx1, fy1 = 22, 22, W - 22, H - 22
    ix0, iy0, ix1, iy1 = 40, 40, W - 40, H - 40
    fr = [el("rect", x=fx0, y=fy0, width=fx1 - fx0, height=fy1 - fy0, fill="none", stroke=t.ink2, stroke_width=1.2,
             stroke_opacity=0.7),
          el("rect", x=ix0, y=iy0, width=ix1 - ix0, height=iy1 - iy0, fill="none", stroke=t.ink2, stroke_width=0.9,
             stroke_opacity=0.7)]
    for i in range(ncol):
        x = ix0 + (ix1 - ix0) * (i + 0.5) / ncol
        for yy in ((fy0 + iy0) / 2 + 4, (fy1 + iy1) / 2 + 4):
            fr.append(text(x, yy, str(i + 1), size=10.5, fill=t.muted, anchor="middle", cls="mono"))
        if i:
            xx = ix0 + (ix1 - ix0) * i / ncol
            fr.append(el("path", d=f"M{fmt(xx)} {fy0}V{iy0}M{fmt(xx)} {iy1}V{fy1}", stroke=t.ink2, stroke_opacity=0.5, stroke_width=0.8))
    for i in range(nrow):
        y = iy0 + (iy1 - iy0) * (i + 0.5) / nrow
        for xx in ((fx0 + ix0) / 2, (fx1 + ix1) / 2):
            fr.append(text(xx, y + 4, "ABCDEFGH"[i], size=10.5, fill=t.muted, anchor="middle", cls="mono"))
        if i:
            yy = iy0 + (iy1 - iy0) * i / nrow
            fr.append(el("path", d=f"M{fx0} {fmt(yy)}H{ix0}M{ix1} {fmt(yy)}H{fx1}", stroke=t.ink2, stroke_opacity=0.5, stroke_width=0.8))
    doc.add("".join(fr))
    return ix0, iy0, ix1, iy1


def band(s, x, y, w, h, label, below=False):
    t = s.t
    return (el("rect", x=x, y=y, width=w, height=h, rx=8, fill=t.ink, fill_opacity=0.035 if not t.dark else 0.05,
               stroke=t.ink, stroke_opacity=0.16, stroke_dasharray="4 4")
            + text(x + 8, y + h + 15 if below else y - 6, label, size=10.5, weight=700, fill=t.muted, ls=0.8))


def title_block(doc, x, y, w, h):
    t = doc.t
    c = t.ink2
    rows = [y, y + 50, y + 85, y + h]
    out = [el("rect", x=x, y=y, width=w, height=h, fill=t.surface2 if not t.dark else t.surface, stroke=c, stroke_width=1.1),
           el("path", d=f"M{x} {rows[1]}H{x + w}M{x} {rows[2]}H{x + w}M{x + 150} {rows[1]}V{y + h}M{x + 260} {rows[1]}V{rows[2]}",
              stroke=c, stroke_width=0.8, fill="none")]

    def cell(cx, cy, lab, val, size=12.5, weight=600):
        return (text(cx, cy, lab, size=9, weight=600, fill=t.muted, ls=0.8)
                + text(cx, cy + 17, val, size=size, weight=weight, fill=t.ink))
    out.append(text(x + 12, y + 22, PROJECT, size=17, weight=700, fill=t.ink))
    out.append(text(x + 12, y + 40, "schematic · uno, oled, rc522, keypad, buzzer", size=11.5, fill=t.muted))
    out.append(text(x + w - 12, y + 22, f"rev {REVISION}", size=14, weight=700, fill=t.accent, anchor="end"))
    out.append(cell(x + 12, rows[1] + 14, "DATE", DATE))
    out.append(cell(x + 162, rows[1] + 14, "SHEET", "1 / 1"))
    out.append(cell(x + 272, rows[1] + 14, "SIZE", "A4"))
    out.append(cell(x + 12, rows[2] + 14, "PROJECT", ORG, size=12))
    out.append(cell(x + 162, rows[2] + 14, "DRAWN", AUTHORS, size=12, weight=500))
    return "".join(out)


# =====================================================================================
# bench toolkit: a tilted top view (camera tipped toward the viewer), hole exact
# =====================================================================================
class Tilt:
    """bench coordinates in mm: x right, y toward the viewer, z up. deg tips the camera."""

    def __init__(self, k, deg, ox, oy):
        a = math.radians(deg)
        self.k, self.c, self.s, self.ox, self.oy = k, math.cos(a), math.sin(a), ox, oy

    def p(self, x, y, z=0.0):
        return (self.ox + self.k * x, self.oy + self.k * (y * self.c - z * self.s))

    @staticmethod
    def shadow(z):
        return (0.07 * z, 0.13 * z)        # light from the back left, high above


def poly_area(poly):
    return sum(poly[i][0] * poly[(i + 1) % len(poly)][1] - poly[(i + 1) % len(poly)][0] * poly[i][1]
               for i in range(len(poly))) / 2


class Place:
    """a part frame on the bench: local (lx, ly) in mm, rotation in degrees around the origin."""

    def __init__(self, tv, px, py, rot=0.0):
        self.tv, self.px, self.py = tv, px, py
        a = math.radians(rot)
        self.ca, self.sa = math.cos(a), math.sin(a)

    def w(self, lx, ly):
        return (self.px + lx * self.ca - ly * self.sa, self.py + lx * self.sa + ly * self.ca)

    def p(self, lx, ly, z=0.0):
        x, y = self.w(lx, ly)
        return self.tv.p(x, y, z)

    def p3(self, lx, ly, z=0.0):
        x, y = self.w(lx, ly)
        return (x, y, z)

    def top(self, z):
        tv = self.tv
        k, c, s = tv.k, tv.c, tv.s
        return (f"matrix({fmt4(k * self.ca)} {fmt4(k * c * self.sa)} {fmt4(-k * self.sa)} {fmt4(k * c * self.ca)} "
                f"{fmt(tv.ox + k * self.px)} {fmt(tv.oy + k * c * self.py - k * s * z)})")

    def g(self, z, content, **kw):
        return el("g", content, transform=self.top(z), **kw)

    def sides(self, poly, z0, h, fill):
        if h <= 0 or self.tv.s <= 0:
            return ""
        if poly_area(poly) < 0:
            poly = poly[::-1]
        out = []
        n = len(poly)
        for i in range(n):
            wa, wb = self.w(*poly[i]), self.w(*poly[(i + 1) % n])
            nx, ny = (wb[1] - wa[1]), -(wb[0] - wa[0])
            if ny > 1e-6:
                ln = math.hypot(nx, ny)
                f = scale_c(fill, 0.80 + 0.20 * (ny / ln)) if fill.startswith("#") else fill
                q = [self.tv.p(*wa, z0), self.tv.p(*wb, z0), self.tv.p(*wb, z0 + h), self.tv.p(*wa, z0 + h)]
                out.append(el("polygon", points=pts(q), fill=f, stroke=f, stroke_width=0.4, stroke_linejoin="round"))
        return "".join(out)

    def box(self, x, y, w, d, z0, h, top, side=None, rx=0.0, extra="", stroke=None, sw=0.25):
        side = side or scale_c(top, 0.72)
        body = el("rect", x=x, y=y, width=w, height=d, rx=rx or None, fill=top, stroke=stroke, stroke_width=sw if stroke else None)
        return self.sides([(x, y), (x + w, y), (x + w, y + d), (x, y + d)], z0, h, side) + self.g(z0 + h, body + extra)

    def cyl(self, cx, cy, r, z0, h, top, side=None, extra=""):
        side = side or scale_c(top, 0.75)
        pts_ = []
        for i in range(25):
            a = math.pi * i / 24
            pts_.append(self.p(cx + r * math.cos(a), cy + r * math.sin(a), z0))
        for i in range(25):
            a = math.pi * (24 - i) / 24
            pts_.append(self.p(cx + r * math.cos(a), cy + r * math.sin(a), z0 + h))
        return (el("polygon", points=pts(pts_), fill=side)
                + self.g(z0 + h, el("circle", cx=cx, cy=cy, r=r, fill=top) + extra))


def soft_shadow(doc, tv, poly_world, z, blur=2.2, opacity=0.28):
    """blurred footprint on the bench, pushed away from the light by the height."""
    dx, dy = tv.shadow(z)
    f = blur_filter(doc, f"bs{int(blur * 10)}", blur, pad=0.3)
    pts_ = [tv.p(x + dx, y + dy, 0) for x, y in poly_world]
    return el("polygon", points=pts(pts_), fill="#000000", opacity=opacity * (1.5 if doc.t.dark else 1), filter=f)


def smooth_path(points3, tv):
    """catmull-rom through 3d points, projected (exact under the affine view)."""
    P = points3
    if len(P) == 2:
        a, b = tv.p(*P[0]), tv.p(*P[1])
        return f"M{fmt(a[0])} {fmt(a[1])}L{fmt(b[0])} {fmt(b[1])}"
    d = []
    a = tv.p(*P[0])
    d.append(f"M{fmt(a[0])} {fmt(a[1])}")
    for i in range(len(P) - 1):
        p0 = P[i - 1] if i > 0 else P[i]
        p1, p2 = P[i], P[i + 1]
        p3 = P[i + 2] if i + 2 < len(P) else P[i + 1]
        c1 = tuple(p1[j] + (p2[j] - p0[j]) / 6 for j in range(3))
        c2 = tuple(p2[j] - (p3[j] - p1[j]) / 6 for j in range(3))
        q1, q2, q3 = tv.p(*c1), tv.p(*c2), tv.p(*p2)
        d.append(f"C{fmt(q1[0])} {fmt(q1[1])} {fmt(q2[0])} {fmt(q2[1])} {fmt(q3[0])} {fmt(q3[1])}")
    return "".join(d)


def wire3d(doc, tv, points3, color, net, width_mm=1.45):
    t = doc.t
    w = width_mm * tv.k
    d = smooth_path(points3, tv)
    sh_pts = [(x + tv.shadow(z)[0], y + tv.shadow(z)[1], 0) for x, y, z in points3]
    ds = smooth_path(sh_pts, tv)
    edge = shade(color, -0.22) if luminance(color) > 0.05 else ("#4A505A" if t.dark else "#08090A")
    hi = shade(color, 0.28) if luminance(color) < 0.75 else "#FFFFFF"
    f = blur_filter(doc, "wshadow", 1.6, pad=0.2)
    return el("g", "".join([
        el("path", d=ds, fill="none", stroke="#000000", stroke_opacity=0.16 * (1.6 if t.dark else 1), stroke_width=w * 0.9,
           stroke_linecap="round", filter=f),
        el("path", d=d, fill="none", stroke=edge, stroke_width=w, stroke_linecap="round", stroke_linejoin="round"),
        el("path", d=d, fill="none", stroke=color, stroke_width=w - 1.3, stroke_linecap="round", stroke_linejoin="round"),
        el("path", d=d, fill="none", stroke=hi, stroke_opacity=0.55, stroke_width=w * 0.26, stroke_linecap="round",
           transform=f"translate(0 {fmt(-w * 0.17)})")]), class_="net", data_net=net)


def housing_up(tv, x, y, z0, h=14.0, s=2.5):
    """male dupont housing standing in a hole; returns (svg, top centre)."""
    pl = Place(tv, x - s / 2, y - s / 2)
    svg = pl.box(0, 0, s, s, z0, h, "#2A2C31", "#141518", rx=0.25)
    svg += pl.g(z0 + h, el("rect", x=0.75, y=0.75, width=1.0, height=1.0, fill="#0A0A0B"))
    return svg, (x, y, z0 + h)


def housing_flat(tv, x, y, z, dx, dy, length=14.0, s=2.5):
    """dupont housing lying flat from (x, y) along (dx, dy); returns (svg, far end)."""
    if abs(dx) > abs(dy):
        x0 = x if dx > 0 else x - length
        pl = Place(tv, x0, y - s / 2)
        svg = pl.box(0, 0, length, s, z - s / 2, s, "#2A2C31", "#141518", rx=0.3)
    else:
        y0 = y if dy > 0 else y - length
        pl = Place(tv, x - s / 2, y0)
        svg = pl.box(0, 0, s, length, z - s / 2, s, "#2A2C31", "#141518", rx=0.3)
    return svg, (x + dx * length, y + dy * length, z)


# ------------------------------------------------------------------ arduino uno r3 (top view)
IN = 25.4
UNO_W, UNO_H = 2.7 * IN, 2.1 * IN
UNO_OUTLINE = [(x * IN, (2.1 - y) * IN) for x, y in
               [(0, 0), (2.6, 0), (2.6, 0.1), (2.7, 0.2), (2.7, 1.49), (2.6, 1.59), (2.6, 2.04), (2.54, 2.1), (0, 2.1)]]
UNO_HEADERS = [  # (first pin x in inch, y in inch from the bottom edge, names, silkscreen labels)
    (0.84, 2.0, ["SCL", "SDA", "AREF", "GND3", "D13", "D12", "D11", "D10", "D9", "D8"],
     ["SCL", "SDA", "AREF", "GND", "13", "12", "~11", "~10", "~9", "8"]),
    (1.9, 2.0, ["D7", "D6", "D5", "D4", "D3", "D2", "D1", "D0"], ["7", "~6", "~5", "4", "~3", "2", "TX→1", "RX←0"]),
    (0.9, 0.1, ["NC", "IOREF", "RESET", "3V3", "5V", "GND1", "GND2", "VIN"],
     ["", "IOREF", "RESET", "3.3V", "5V", "GND", "GND", "Vin"]),
    (2.0, 0.1, ["A0", "A1", "A2", "A3", "A4", "A5"], ["A0", "A1", "A2", "A3", "A4", "A5"]),
]
UNO_MASK = "#00838E"          # same as MC.parts.uno
UNO_PCB_Z = 2.0               # board bottom above the bench (solder tails)


def uno_pins():
    """pin name -> local (x, y) in mm, y down from the digital header edge."""
    out = {}
    for x0, y, names, _ in UNO_HEADERS:
        for i, n in enumerate(names):
            out[n] = ((x0 + i * 0.1) * IN, (2.1 - y) * IN)
    return out


def uno_draw(doc, pl, label_size=1.05, detail=True, pin_marks=None):
    """the Uno on the bench at Place pl. pin_marks: {pin: colour} rings on the header holes."""
    t = doc.t
    z0, th = UNO_PCB_Z, 1.6
    zt = z0 + th
    out = [pl.sides(UNO_OUTLINE, z0, th, "#0B5E66")]
    g = lin_grad(doc, "unomask", [(0, shade(UNO_MASK, 0.05)), (1, shade(UNO_MASK, -0.05))], x1=0, y1=0, x2=1, y2=1)
    top = [el("polygon", points=pts(UNO_OUTLINE), fill=g)]
    # copper under the mask, a few long runs
    tr = shade(UNO_MASK, 0.07)
    for d in ("M24 30L30 24L30 14", "M33 36L44 36L50 30", "M8 34L14 34L18 30", "M58 12L58 26L62 30",
              "M12 22L22 22L26 26L40 26", "M48 6L48 12L54 18", "M30 46L40 46L44 42L56 42"):
        top.append(el("path", d=d, fill="none", stroke=tr, stroke_width=0.45, stroke_linecap="round", stroke_linejoin="round"))
    for hx, hy in ((0.55, 0.1), (0.6, 2.0), (2.6, 0.3), (2.6, 1.4)):
        cx, cy = hx * IN, (2.1 - hy) * IN
        top.append(el("circle", cx=cx, cy=cy, r=2.75, fill="#D3D7DC") + el("circle", cx=cx, cy=cy, r=1.6, fill="#0A0B0C"))
    silk = "#F2F4F5"
    pins = uno_pins()
    for x0, y, names, labels in UNO_HEADERS:
        for i, (n, lab) in enumerate(zip(names, labels)):
            if not lab:
                continue
            x, yy = pins[n]
            if y > 1:
                top.append(text(x + label_size * 0.36, yy + 2.55, lab, size=label_size, weight=600, fill=silk, anchor="end",
                                transform=f"rotate(-90 {fmt(x + label_size * 0.36)} {fmt(yy + 2.55)})"))
            else:
                top.append(text(x + label_size * 0.36, yy - 2.6, lab, size=label_size, weight=600, fill=silk, anchor="start",
                                transform=f"rotate(-90 {fmt(x + label_size * 0.36)} {fmt(yy - 2.6)})"))
    top.append(text(51.0, 10.9, "DIGITAL (PWM~)", size=1.15, weight=600, fill=silk, anchor="middle"))
    top.append(text(31.75, 44.7, "POWER", size=1.05, weight=600, fill=silk, anchor="middle"))
    top.append(text(57.15, 44.7, "ANALOG IN", size=1.05, weight=600, fill=silk, anchor="middle"))
    top.append(text(37.0, 22.2, "UNO", size=6.4, weight=800, fill=silk, anchor="middle", ls=0.2))
    top.append(text(37.0, 25.6, "ARDUINO", size=1.9, weight=700, fill=silk, anchor="middle", ls=0.4))
    # leds and small parts (positions from MC.parts.uno)
    for x, y, col, lab in ((31.0, 45.4, "#F2C46B", "L"), (31.0, 41.8, "#F2C46B", "TX"), (31.0, 39.2, "#F2C46B", "RX"),
                           (58.4, 31.0, "#8EE0A5", "ON")):
        yy = UNO_H - y
        top.append(el("rect", x=x - 1.0, y=yy - 0.62, width=2.0, height=1.25, rx=0.2, fill=col))
        top.append(text(x + 1.6, yy + 0.45, lab, size=1.0, weight=600, fill=silk))
    for x, y, w_, h_ in ((31.0, 36.0, 3.2, 1.6), (13.4, 41.0, 1.6, 3.2), (53.4, 37.0, 3.2, 1.6), (5.2, 17.8, 4.2, 2.6),
                         (5.2, 26.2, 3.6, 4.6), (9.4, 22.0, 2.0, 3.2), (26.0, 30.5, 1.6, 0.8), (36.0, 31.0, 1.6, 0.8),
                         (44.0, 4.0, 1.6, 0.8), (61.0, 18.0, 0.8, 1.6), (47.0, 26.5, 1.6, 0.8)):
        top.append(el("rect", x=x - w_ / 2, y=UNO_H - y - h_ / 2, width=w_, height=h_, rx=0.15, fill="#1B1C1F"))
    # 16U2 (QFN) and the regulator pad
    top.append(el("rect", x=20.6 - 2.5, y=UNO_H - 37.6 - 2.5, width=5, height=5, rx=0.3, fill="#17181B"))
    top.append(el("rect", x=18.6 - 3.3, y=UNO_H - 8.4 - 1.8, width=6.6, height=3.6, rx=0.2, fill="#17181B"))
    out.append(pl.g(zt, "".join(top)))

    # raised parts, back to front
    raised = []
    # headers
    hh = 8.5
    for x0, y, names, _ in UNO_HEADERS:
        n = len(names)
        xa = x0 * IN - 1.27
        ya = (2.1 - y) * IN - 1.27
        holes = "".join(el("rect", x=1.27 + i * 2.54 - 0.5, y=1.27 - 0.5, width=1.0, height=1.0, fill="#050506")
                        for i in range(n))
        for i, nm in enumerate(names):
            if pin_marks and nm in pin_marks:
                holes += el("circle", cx=1.27 + i * 2.54, cy=1.27, r=0.78, fill=pin_marks[nm], stroke="#FFFFFF",
                            stroke_opacity=0.55, stroke_width=0.18)
        raised.append((ya + 2.54, pl.box(xa, ya, n * 2.54, 2.54, zt, hh, "#1E1F23", "#121316", rx=0.2,
                                          extra=el("g", holes, transform=f"translate({fmt(xa)} {fmt(ya)})"))))
    # usb-b
    uy = UNO_H - 38.1
    usb = (el("rect", x=-6.3, y=uy - 6, width=16, height=12, rx=0.4, fill=lin_grad(doc, "steel", [(0, "#E3E6EA"), (1, "#A9AFB7")], x1=0, y1=0, x2=0, y2=1))
           + el("path", d=f"M-6.3 {fmt(uy - 4)}h16M-6.3 {fmt(uy + 4)}h16", stroke="#8E959E", stroke_width=0.25)
           + el("rect", x=1.4, y=uy - 1.6, width=3.2, height=3.2, rx=0.4, fill="none", stroke="#8E959E", stroke_width=0.25))
    raised.append((uy + 6, pl.sides([(-6.3, uy - 6), (9.7, uy - 6), (9.7, uy + 6), (-6.3, uy + 6)], zt, 10.9, "#8E959E")
                   + pl.g(zt + 10.9, usb)))
    # dc jack
    jy = UNO_H - 7.62
    raised.append((jy + 4.5, pl.box(-1.8, jy - 4.5, 13.7, 9.0, zt, 11.0, "#1B1C20", "#0E0F11", rx=0.6,
                                    extra=el("circle", cx=1.2, cy=jy, r=2.6, fill="#0A0A0B", opacity=0.0))))
    # reset button
    ry = UNO_H - 48.4
    raised.append((ry + 3, pl.box(5.4 - 3, ry - 3, 6, 6, zt, 3.1, "#C9CDD3", "#8E959E", rx=0.4,
                                  extra=el("circle", cx=5.4, cy=ry, r=1.75, fill="#2A2C30"))))
    # crystal, caps
    cy_ = UNO_H - 29.0
    raised.append((cy_ + 2.3, pl.box(21.0 - 5.5, cy_ - 2.3, 11.0, 4.6, zt, 3.5, "#DCE0E5", "#9AA1A9", rx=2.2)))
    for ex, ey in ((15.2, 16.6), (21.9, 16.6)):
        yy = UNO_H - ey
        cap_top = el("circle", cx=ex, cy=yy, r=3.1, fill="#C7CCD2") + el("path", d=f"M{fmt(ex - 1.6)} {fmt(yy)}h3.2M{fmt(ex)} {fmt(yy - 1.6)}v3.2",
                                                                       stroke="#8E959E", stroke_width=0.3)
        raised.append((yy + 3.1, pl.cyl(ex, yy, 3.15, zt, 6.0, "#C7CCD2", "#9DA4AC", extra=cap_top)))
    # icsp headers
    for (cx, cyy), (nx, ny) in (((2.55 * IN, (2.1 - 1.05) * IN), (2, 3)), ((1.0 * IN, (2.1 - 1.8) * IN), (3, 2))):
        w_, h_ = nx * 2.54, ny * 2.54
        pins_ = "".join(el("rect", x=cx - w_ / 2 + 1.27 + i * 2.54 - 0.35, y=cyy - h_ / 2 + 1.27 + j * 2.54 - 0.35, width=0.7,
                           height=0.7, fill="#D9B45F") for i in range(nx) for j in range(ny))
        raised.append((cyy + h_ / 2, pl.box(cx - w_ / 2, cyy - h_ / 2, w_, h_, zt, 2.5, "#1E1F23", "#111214", extra=pins_)))
    # atmega328p in its socket, notch toward +x
    dx, dyy = 1.75 * IN, UNO_H - 0.6 * IN
    chip = (el("path", d=f"M{fmt(dx + 17.6)} {fmt(dyy - 1.0)}a1 1 0 0 0 0 2z", fill="#0B0B0D")
            + text(dx, dyy + 0.55, "ATMEGA328P-PU", size=1.55, weight=600, fill="#B7BCC4", anchor="middle", ls=0.2))
    legs = "".join(el("rect", x=dx - 16.51 + i * 2.54 - 0.3, y=dyy + s_ * 3.81 - 0.5, width=0.6, height=1.0, fill="#C3C8CE")
                   for i in range(14) for s_ in (-1, 1))
    raised.append((dyy + 5.1, pl.box(dx - 18.4, dyy - 5.1, 36.8, 10.2, zt, 3.0, "#2B2D32", "#1A1B1E", rx=0.3, extra=legs)
                   + pl.box(dx - 17.8, dyy - 3.3, 35.6, 6.6, zt + 3.0, 3.2, "#1B1C1F", "#0F1012", rx=0.3, extra=chip)))
    raised.sort(key=lambda r: r[0])
    out.extend(r[1] for r in raised)
    return "".join(out)


# ------------------------------------------------------------------ half-size breadboard
BB_W, BB_D, BB_H = 82.5, 54.5, 8.5
BB_ROWS = "abcdefghij"
BB_RAILS = {"upper_outer": 27.25 - 23.24, "upper_inner": 27.25 - 20.7, "lower_inner": 27.25 + 20.7, "lower_outer": 27.25 + 23.24}
BB_RAIL_COLS = [1.5 + g * 6 + i for g in range(5) for i in range(5)]


def bb_col_x(c):
    return BB_W / 2 + (c - 15.5) * 2.54


def bb_row_y(r):
    i = BB_ROWS.index(r)
    return 27.25 + (-3.81 - (4 - i) * 2.54 if i < 5 else 3.81 + (i - 5) * 2.54)


def bb_hole(name):
    """'j2' or 'gnd_lower_inner:28' -> local (x, y), same rules as MC.parts.breadboard."""
    m = re.match(r"^([a-j])(\d+)$", name)
    if m:
        return bb_col_x(int(m.group(2))), bb_row_y(m.group(1))
    m = re.match(r"^(?:rail_)?(upper_outer|upper_inner|lower_inner|lower_outer|gnd_lower_inner):(\d+)$", name)
    rail = m.group(1).replace("gnd_", "")
    n = int(m.group(2))
    col = n + 0.5 if (n + 0.5) in BB_RAIL_COLS else n - 0.5 if (n - 0.5) in BB_RAIL_COLS else min(BB_RAIL_COLS, key=lambda c: abs(c - n))
    return bb_col_x(col), BB_RAILS[rail]


def breadboard_draw(doc, pl, used=None):
    """used: {hole name: colour} draws a coloured ring around the hole."""
    t = doc.t
    top = [el("rect", width=BB_W, height=BB_D, rx=1.2, fill="#F3F2EE")]
    top.append(el("rect", x=0, y=27.25 - 1.4, width=BB_W, height=2.8, fill="#E2E0DA"))
    holes = []
    for c in range(1, 31):
        for r in BB_ROWS:
            x, y = bb_col_x(c), bb_row_y(r)
            holes.append(f"M{fmt(x - 0.5)} {fmt(y - 0.5)}h1v1h-1z")
    for rail, y in BB_RAILS.items():
        for c in BB_RAIL_COLS:
            x = bb_col_x(c)
            holes.append(f"M{fmt(x - 0.5)} {fmt(y - 0.5)}h1v1h-1z")
    top.append(el("path", d="".join(holes), fill="#2E3034"))
    for y, col in ((27.25 - 23.24 - 2.05, "#D8383E"), (27.25 + 23.24 + 2.05, "#D8383E"), (27.25 - 20.7 + 2.0, "#2F64C9"),
                   (27.25 + 20.7 - 2.0, "#2F64C9")):
        top.append(el("rect", x=3.2, y=y - 0.22, width=BB_W - 6.4, height=0.44, fill=col, opacity=0.85))
    ink = "#7B7F86"
    for c in (1, 5, 10, 15, 20, 25, 30):
        for y in (27.25 - 16.55, 27.25 + 16.55):
            top.append(text(bb_col_x(c), y + 0.55, str(c), size=1.5, weight=600, fill=ink, anchor="middle"))
    for r in BB_ROWS:
        for x in (BB_W / 2 - 39.4, BB_W / 2 + 39.4):
            top.append(text(x, bb_row_y(r) + 0.55, r, size=1.6, weight=600, fill=ink, anchor="middle"))
    for rail, y in BB_RAILS.items():
        sym = "+" if "outer" in rail else "−"
        col = "#D8383E" if sym == "+" else "#2F64C9"
        for x in (BB_W / 2 - 38.7, BB_W / 2 + 38.7):
            top.append(text(x, y + 0.8, sym, size=2.3, weight=700, fill=col, anchor="middle"))
    if used:
        for name, col in used.items():
            x, y = bb_hole(name)
            top.append(el("circle", cx=x, cy=y, r=1.35, fill="none", stroke=col, stroke_width=0.4))
    return pl.sides([(0, 0), (BB_W, 0), (BB_W, BB_D), (0, BB_D)], 0, BB_H, "#D9D7D0") + pl.g(BB_H, "".join(top))


# ------------------------------------------------------------------ rc522 (component side up, header toward +y)
RC_W, RC_H = 39.0, 60.0
RC_PINS = ["SDA", "SCK", "MOSI", "MISO", "IRQ", "GND", "RST", "3V3"]
RC_LABELS = ["SDA", "SCK", "MOSI", "MISO", "IRQ", "GND", "RST", "3.3V"]


def rc522_pin_x(i):
    return RC_W / 2 + (i - 3.5) * 2.54


def rc522_draw(doc, pl):
    mask = "#1D55AE"
    trace = shade(mask, 0.07)
    top = [el("rect", width=RC_W, height=RC_H, rx=0.8, fill=lin_grad(doc, "rcmask", [(0, shade(mask, 0.04)), (1, shade(mask, -0.04))], x2=1, y2=1))]
    for i in range(4):
        o = i * 1.55
        top.append(el("rect", x=2.6 + o, y=2.6 + o, width=33.8 - 2 * o, height=35.0 - 2 * o, rx=max(1.5, 11 - o), fill="none",
                      stroke=trace, stroke_width=0.85))
    for hx, hy in ((3.6, 3.6), (35.4, 3.6), (3.6, 42.6), (35.4, 42.6)):
        top.append(el("circle", cx=hx, cy=hy, r=2.3, fill="#D3D7DC") + el("circle", cx=hx, cy=hy, r=1.5, fill="#0A0B0C"))
    # MFRC522 rotated 45 degrees, crystal, passives
    top.append(el("rect", x=-2.5, y=-2.5, width=5, height=5, rx=0.3, fill="#17181B", transform="translate(15 47) rotate(45)"))
    top.append(el("rect", x=23, y=44.2, width=11, height=4.6, rx=2.2, fill="#D5D9DE"))
    for x, y in ((8, 44), (9, 50), (27, 51), (31, 51), (20, 40.5), (12, 40.5)):
        top.append(el("rect", x=x, y=y, width=1.6, height=0.8, fill="#B9A47A"))
    for i, lab in enumerate(RC_LABELS):
        x = rc522_pin_x(i)
        top.append(el("circle", cx=x, cy=58.0, r=0.95, fill="#D3D7DC"))
        top.append(text(x + 0.36, 56.6, lab, size=1.0, weight=600, fill="#F2F4F5", anchor="end",
                        transform=f"rotate(-90 {fmt(x + 0.36)} 56.6)"))
    top.append(text(RC_W / 2, 30, "RFID-RC522", size=2.4, weight=700, fill="#F2F4F5", anchor="middle", opacity=0.9))
    out = [pl.sides([(0, 0), (RC_W, 0), (RC_W, RC_H), (0, RC_H)], 0, 1.6, "#13417F"), pl.g(1.6, "".join(top))]
    # 90 degree header body and pins toward +y
    out.append(pl.box(RC_W / 2 - 10.16, 58.75, 20.32, 2.54, 1.6, 2.54, "#1E1F23", "#121316"))
    pins = "".join(el("rect", x=rc522_pin_x(i) - 0.32, y=61.3, width=0.64, height=6.0, fill="#D9B45F") for i in range(8))
    out.append(pl.g(1.6 + 1.27, pins))
    return "".join(out)


# ------------------------------------------------------------------ 1.3" oled module (glass up, header on top edge)
OL_W, OL_H = 35.4, 33.5


def oled_module_draw(doc, pl, fb, z0=0.0):
    mask = "#1A4C9C"
    top = [el("rect", width=OL_W, height=OL_H, rx=0.6, fill=mask)]
    for hx, hy in ((2, 2), (OL_W - 2, 2), (2, OL_H - 2), (OL_W - 2, OL_H - 2)):
        top.append(el("circle", cx=hx, cy=hy, r=1.6, fill="#D3D7DC") + el("circle", cx=hx, cy=hy, r=1.0, fill="#0A0B0C"))
    for i, lab in enumerate(("GND", "VCC", "SCL", "SDA")):
        x = OL_W / 2 + (i - 1.5) * 2.54
        top.append(el("circle", cx=x, cy=1.6, r=0.85, fill="#D3D7DC") + el("circle", cx=x, cy=1.6, r=0.4, fill="#B08A3E"))
        top.append(text(x, 4.3, lab, size=1.0, weight=700, fill="#F2F4F5", anchor="middle"))
    out = [pl.sides([(0, 0), (OL_W, 0), (OL_W, OL_H), (0, OL_H)], z0, 1.2, "#123873"), pl.g(z0 + 1.2, "".join(top))]
    gx, gy = (OL_W - 34.5) / 2, 5.0
    glass = (el("rect", x=gx, y=gy, width=34.5, height=23.0, rx=0.3, fill="#0C0D10")
             + el("rect", x=gx, y=gy + 19.6, width=34.5, height=3.4, fill="#17191D"))
    out.append(pl.sides([(gx, gy), (gx + 34.5, gy), (gx + 34.5, gy + 23), (gx, gy + 23)], z0 + 1.2, 1.45, "#050607"))
    out.append(pl.g(z0 + 2.65, glass))
    if fb:
        ax, ay = (OL_W - 29.42) / 2, gy + 2.35
        m = pl.top(z0 + 2.66)
        out.append(el("g", oled_screen(doc, fb, f"translate({fmt(ax)} {fmt(ay)}) scale({fmt4(29.42 / 128)} {fmt4(14.70 / 64)})",
                                       glow=0.45, margin=0.5 / 0.23, radius=0.3 / 0.23), transform=m))
    return "".join(out)


# ------------------------------------------------------------------ membrane keypad with tail and connector
def keypad_draw(doc, pl):
    out = [pl.g(0.8, keypad_face(doc))]
    out.insert(0, pl.sides([(0, 0), (69.2, 0), (69.2, 76.9), (0, 76.9)], 0, 0.8, "#0B0C0E"))
    tx = 69.2 / 2 - 20.3 / 2
    tail = [el("rect", x=tx, y=76.9, width=20.3, height=75.0, fill="#C9CFD6", opacity=0.55),
            el("rect", x=tx, y=76.9, width=20.3, height=75.0, fill="none", stroke="#AEB5BE", stroke_width=0.25)]
    for i in range(8):
        x = 69.2 / 2 + (i - 3.5) * 2.54
        tail.append(el("rect", x=x - 0.6, y=76.9, width=1.2, height=75.0, fill="#9CA3AC"))
    out.append(pl.g(0.15, "".join(tail)))
    # 1x8 female crimp housing, P1 at +x
    out.append(pl.box(69.2 / 2 - 10.3, 151.9, 20.6, 10.0, 0, 2.6, "#232428", "#121316", rx=0.3,
                      extra="".join(el("rect", x=69.2 / 2 + (3.5 - i) * 2.54 - 0.5, y=160.6, width=1.0, height=1.0, fill="#050506")
                                    for i in range(8))
                      + el("path", d=f"M{fmt(69.2 / 2 + 3.5 * 2.54)} 153l-0.7 1.3h1.4z", fill="#E6E8EB")))
    return "".join(out)


def keypad_pin_x(n):
    """keypad connector pin n (1..8) local x: P1 at the right."""
    return 69.2 / 2 + (3.5 - (n - 1)) * 2.54


# ------------------------------------------------------------------ ky-006 buzzer standing in the breadboard, resistor
def buzzer_draw(doc, tv, s_x, m_x, n_x, row_y):
    """module standing on the breadboard, pins S/M/- in one row, can facing the back (-y)."""
    out = []
    cx = (s_x + n_x) / 2
    pl = Place(tv, cx - 7.5, row_y - 0.8)
    out.append(pl.box(15.0 / 2 - 3.81, -0.45, 7.62, 2.5, BB_H, 2.5, "#1E1F23", "#121316"))
    # can behind the pcb (toward -y), seen from above: a dark disc rim
    out.append(Place(tv, cx, row_y - 0.8).cyl(0, -4.25, 6.0, BB_H + 2.5 + 11.0 - 6.0, 0.01, "#141518"))
    can = Place(tv, cx - 6, row_y - 9.3)
    out.append(can.box(0, 0, 12, 8.5, BB_H + 2.5 + 5.0, 12.0, "#1A1B1E", "#101113", rx=0.6))
    face = el("rect", width=15.0, height=1.6, fill="#1F2125")
    out.append(pl.sides([(0, 0), (15, 0), (15, 1.6), (0, 1.6)], BB_H + 2.5, 18.5, "#17191C"))
    out.append(pl.g(BB_H + 2.5 + 18.5, face))
    # silkscreen on the front face of the standing pcb
    fx0, fz = pl.p(0, 1.6, BB_H + 2.5 + 18.5)
    k = tv.k
    m = f"matrix({fmt4(k)} 0 0 {fmt4(k * tv.s)} {fmt(fx0)} {fmt(fz)})"
    out.append(el("g", text(2.6, 16.6, "S", size=1.6, weight=700, fill="#F1F3F5", anchor="middle")
                  + text(12.4, 16.8, "−", size=1.9, weight=700, fill="#F1F3F5", anchor="middle")
                  + text(7.5, 3.4, "KY-006", size=1.35, weight=700, fill="#F1F3F5", anchor="middle"), transform=m))
    return "".join(out)


def resistor_draw(doc, tv, xa, xb, y):
    """330 ohm standing (the hole span is shorter than the body): body above hole a, lead bent over to b."""
    zb = BB_H
    out = []
    lead = "#C3C8CE"
    body_h = 6.3
    z0 = zb + 1.5
    out.append(el("path", d=smooth_path([(xb, y, zb), (xb, y, z0 + body_h + 2.2), (xa + 0.8, y, z0 + body_h + 3.2), (xa, y, z0 + body_h + 1.0)], tv),
                  fill="none", stroke=lead, stroke_width=0.6 * tv.k, stroke_linecap="round"))
    pl = Place(tv, xa, y)
    bands = [("#E2702A", 0.72), ("#E2702A", 1.86), ("#6A3B1F", 2.86), ("#C8A04A", 4.84)]
    body = pl.cyl(0, 0, 1.2, z0, body_h, "#DCC59A", "#D2B88A")
    out.append(el("path", d=smooth_path([(xa, y, zb), (xa, y, z0)], tv), stroke=lead, stroke_width=0.6 * tv.k))
    out.append(body)
    for col, v in bands:
        a = tv.p(xa - 1.2, y, z0 + body_h - v)
        b = tv.p(xa + 1.2, y, z0 + body_h - v)
        out.append(el("path", d=f"M{fmt(a[0])} {fmt(a[1])}L{fmt(b[0])} {fmt(b[1])}", stroke=col, stroke_width=0.5 * tv.k))
    return "".join(out)


# =====================================================================================
# 4. wiring: the bench, hole by hole
# =====================================================================================
def net_color(nets, nid):
    return nets[nid]["color"]


def wiring(doc, fw, nets, wires, bb):
    t = doc.t
    doc.add(card_bg(doc, r=24))
    tv = Tilt(4.1, 28, 30, 22)
    o = fw["oled"]
    # --- placement on the bench (mm)
    rc = Place(tv, 22, 6)
    kp = Place(tv, 128, 4)
    un = Place(tv, 40, 100)
    bbp = Place(tv, 24, 172)
    olp = Place(tv, 34.7 - OL_W / 2 + 7, 236)
    upins = uno_pins()
    z_hdr = UNO_PCB_Z + 1.6 + 8.5

    def uno_hole(name):
        x, y = upins[name]
        return un.w(x, y)

    def bb_w(name):
        return bbp.w(*bb_hole(name))
    # a soft mat with a 10 mm grid under the bench
    mat_c = "#EEF0F3" if not t.dark else "#151A21"
    x0m, y0m, x1m, y1m = 8, -1, 201, 276
    a, b = tv.p(x0m, y0m), tv.p(x1m, y1m)
    grid = []
    for gx in range(int(x0m) + 2, int(x1m), 10):
        p0, p1 = tv.p(gx, y0m), tv.p(gx, y1m)
        grid.append(f"M{fmt(p0[0])} {fmt(p0[1])}V{fmt(p1[1])}")
    for gy in range(int(y0m) + 2, int(y1m), 10):
        p0, p1 = tv.p(x0m, gy), tv.p(x1m, gy)
        grid.append(f"M{fmt(p0[0])} {fmt(p0[1])}H{fmt(p1[0])}")
    doc.add(el("rect", x=a[0], y=a[1], width=b[0] - a[0], height=b[1] - a[1], rx=14, fill=mat_c)
            + el("path", d="".join(grid), stroke=t.ink, stroke_opacity=0.045 if not t.dark else 0.05, stroke_width=1)
            + el("rect", x=a[0] + 0.5, y=a[1] + 0.5, width=b[0] - a[0] - 1, height=b[1] - a[1] - 1, rx=14, fill="none",
                 stroke=t.line_hex, stroke_opacity=t.line_a))
    doc.add(text(a[0] + 14, b[1] - 12, "grid 10 mm", size=11, fill=t.muted))
    # shadows
    sh = []
    sh.append(soft_shadow(doc, tv, [kp.w(0, 0), kp.w(69.2, 0), kp.w(69.2, 76.9), kp.w(0, 76.9)], 1.5))
    sh.append(soft_shadow(doc, tv, [rc.w(0, 0), rc.w(RC_W, 0), rc.w(RC_W, RC_H), rc.w(0, RC_H)], 2.0))
    sh.append(soft_shadow(doc, tv, [un.w(x, y) for x, y in UNO_OUTLINE], 7.0, blur=3.0))
    sh.append(soft_shadow(doc, tv, [bbp.w(0, 0), bbp.w(BB_W, 0), bbp.w(BB_W, BB_D), bbp.w(0, BB_D)], 6.0, blur=3.0))
    sh.append(soft_shadow(doc, tv, [olp.w(0, 0), olp.w(OL_W, 0), olp.w(OL_W, OL_H), olp.w(0, OL_H)], 3.0))
    doc.add("".join(sh))

    marks = {}
    for w in wires:
        for part, pin in (w["a"], w["b"]):
            if part == "uno":
                marks[pin] = net_color(nets, w["net"])
    used = {}
    for w in wires:
        for part, pin in (w["a"], w["b"]):
            if part == "breadboard":
                used[pin] = net_color(nets, w["net"])
    doc.add(keypad_draw(doc, kp))
    doc.add(rc522_draw(doc, rc))
    doc.add(uno_draw(doc, un, pin_marks=marks))
    doc.add(breadboard_draw(doc, bbp, used))
    menu = ("Guthaben    150€", "Einsatz      10€", "1-3 setzen  D=?")
    doc.add(oled_module_draw(doc, olp, o.frame(*menu), z0=1.0))

    # buzzer and resistor in the breadboard
    bz = bb["buzzer"]
    sx, sy = bb_w(bz["S"])
    nx, _ = bb_w(bz["MINUS"])
    mx, _ = bb_w(bz["M"])
    ra, rb = (bb_w(h) for h in bb["resistor"])

    # ------------------------------------------------------------- wires
    parts_out = []
    wire_out = []

    def male_at(x, y, z):
        svg, top = housing_up(tv, x, y, z)
        parts_out.append(svg)
        return top

    paths = []
    for w in wires:      # endpoints from MC.WIRES, bends placed by hand per kind of wire
        net = w["net"]
        (pa, na), (pb, nb) = w["a"], w["b"]
        col = net_color(nets, net)
        if pa == "oled":
            # 4-wire lead: female on the oled header (under the pcb edge), male into j2..j5
            i = ("GND", "VCC", "SCL", "SDA").index(na)
            x0, y0 = olp.w(OL_W / 2 + (i - 1.5) * 2.54, 1.0)
            hx, hy = bb_w(nb)
            top = male_at(hx, hy, BB_H)
            pts3 = [(x0, y0, 1.6), (x0, y0 - 6, 3.0), (hx, hy + 2, top[2] + 6), top]
        elif pa == "rc522":
            i = RC_PINS.index(na)
            px_ = rc522_pin_x(i)
            hx0, hy0 = rc.w(px_, 61.0)
            svg, far = housing_flat(tv, hx0, hy0, 1.6 + 1.27, 0, 1)
            parts_out.append(svg)
            ux, uy = uno_hole(nb)
            top = male_at(ux, uy, z_hdr)
            mid_y = far[1] + 7 + (7 - i) * 0.0
            if nb in ("3V3", "GND2"):
                pts3 = [far, (far[0], far[1] + 6, 4.5), (far[0] + (ux - far[0]) * 0.5, (far[1] + uy) / 2, z_hdr + 22 + i),
                        (ux, uy - 6, top[2] + 10), top]
            else:
                pts3 = [far, (far[0], far[1] + 5, 4.0), ((far[0] + ux) / 2, (far[1] + uy) / 2 - 1, top[2] + 6 + i * 0.6), top]
        elif pa == "keypad":
            n = int(na[1:])
            cx_, cy_ = kp.w(keypad_pin_x(n), 161.9)
            svg, far = housing_flat(tv, cx_, cy_, 1.3, 0, 1)
            parts_out.append(svg)
            ux, uy = uno_hole(nb)
            top = male_at(ux, uy, z_hdr)
            k8 = 8 - n                                    # P8 innermost of the loop
            lane_x = 112.0 + (n - 1) * 2.3               # corridor between uno and tail
            if nb.startswith("A"):
                pts3 = [far, (far[0], far[1] + 6 + k8 * 0.6, 2.0), (far[0] - 10, far[1] + 9 + k8 * 0.6, 4.0),
                        (lane_x + 6, far[1] + 4, 8.0), (lane_x, uy + 14, 10.0), (ux + 2, uy + 9, top[2] + 6), top]
            else:
                pts3 = [far, (far[0], far[1] + 6 + k8 * 0.6, 2.0), (far[0] - 10, far[1] + 9 + k8 * 0.6, 4.0),
                        (lane_x + 6, far[1] + 4, 8.0), (lane_x, 150, 14.0), (lane_x - 1, 96 - (8 - n) * 1.4, top[2] + 8),
                        (ux + 1.5, uy - 6, top[2] + 7), top]
        elif pa == "breadboard" and pb == "uno":
            hx, hy = bb_w(na)
            b0 = male_at(hx, hy, BB_H)
            ux, uy = uno_hole(nb)
            top = male_at(ux, uy, z_hdr)
            if nb == "D2":
                pts3 = [b0, (hx + 2, hy - 8, b0[2] + 14), (ux + 8, uy + 20, top[2] + 22), (ux + 1, uy - 5, top[2] + 9), top]
            elif nb == "GND3":
                pts3 = [b0, (hx - 4, hy - 10, b0[2] + 16), (ux - 6, uy + 26, top[2] + 26), (ux - 1, uy - 5, top[2] + 9), top]
            else:
                pts3 = [b0, (hx, hy - 7, b0[2] + 9), ((hx + ux) / 2, (hy + uy) / 2, top[2] + 12), (ux, uy + 5, top[2] + 7), top]
        else:   # breadboard to breadboard: e28 to the gnd rail
            ax_, ay_ = bb_w(na)
            bx_, by_ = bb_w(nb)
            a0 = male_at(ax_, ay_, BB_H)
            b0 = male_at(bx_, by_, BB_H)
            pts3 = [a0, (ax_ + 3, (ay_ + by_) / 2, a0[2] + 8), b0]
        paths.append((max(p[2] for p in pts3), wire3d(doc, tv, pts3, col, net)))

    # the parts that sit in the breadboard, then the housings, then the wires (low to high)
    doc.add(resistor_draw(doc, tv, ra[0], rb[0], ra[1]))
    doc.add(buzzer_draw(doc, tv, sx, mx, nx, sy))
    doc.add("".join(parts_out))
    paths.sort(key=lambda p: p[0])
    doc.add("".join(p[1] for p in paths))

    # ------------------------------------------------------------- the legend on the right
    lx = 884
    doc.add(text(lx, 70, "wiring", size=30, weight=700, fill=t.ink, ls=-0.8))
    doc.add(text(lx, 96, "hole by hole, the same jumpers and colours as in the 3d model", size=14, fill=t.muted))
    roles = keypad_roles(fw, wires)

    def row_for(w):
        (pa, na), (pb, nb) = w["a"], w["b"]
        gnd = lambda s: "GND" if s.startswith("GND") else s
        if pa == "oled":
            return f"oled {na}", nb
        if pa == "breadboard" and pb == "breadboard":
            return na, "gnd rail"
        if pa == "breadboard":
            return ("gnd rail" if na.startswith("gnd_") else na), "uno " + gnd(nb)
        if pa == "keypad":
            r_ = roles[na]
            return f"pin {na[1:]}", f"{nb:<3} {r_[1]} {r_[3]}"
        return na.replace("3V3", "3.3V"), gnd(nb).replace("3V3", "3.3V")
    by = {w["id"]: w for w in wires}
    col1 = [("oled lead, lid → breadboard", [by[i] for i in ("oled_gnd", "oled_vcc", "oled_scl", "oled_sda")]),
            ("breadboard → uno", [by[i] for i in ("bb_gnd", "bb_5v", "bb_scl", "bb_sda")]),
            ("buzzer and 330 Ω", [("buzzer S·mid·−", "c26·c27·c28", "BUZ_S"), ("330 Ω", "e24 – e26", "BUZ_S"),
                                 by["buz_d2"], by["buz_gnd"], by["rail_gnd"]])]
    col2 = [("rc522 → uno, 3.3 V only", [w for w in wires if w["a"][0] == "rc522"]),
            ("keypad → uno, pin 1 = right contact", [w for w in wires if w["a"][0] == "keypad"])]
    tab = 118
    for ci, column in enumerate((col1, col2)):
        x = lx + ci * 282
        y = 140
        for title, items in column:
            doc.add(text(x, y, title, size=13, weight=700, fill=t.ink))
            y += 8
            for it in items:
                if isinstance(it, tuple):
                    left, right, net = it
                    col = None
                else:
                    left, right = row_for(it)
                    net = it["net"]
                    col = net_color(nets, net)
                y += 20
                g = []
                if col:
                    g.append(el("rect", x=x, y=y - 8.5, width=18, height=8, rx=4, fill=col,
                                stroke="#000000" if not t.dark else "#FFFFFF", stroke_opacity=0.28 if not t.dark else 0.22,
                                stroke_width=0.8))
                else:
                    g.append(el("circle", cx=x + 9, cy=y - 4.5, r=2.6, fill=t.muted))
                g.append(text(x + 26, y, left, size=12, fill=t.ink2, cls="mono"))
                g.append(text(x + 26 + tab, y, "→", size=12, fill=t.muted))
                g.append(text(x + 26 + tab + 18, y, right, size=12, fill=t.ink, cls="mono"))
                doc.add(el("g", "".join(g), class_="net", data_net=net))
            y += 30

    # ------------------------------------------------------------- hole map of the breadboard
    mk = 6.2
    mx0, my0 = lx + 4, 600
    doc.add(text(lx, my0 - 26, "breadboard, top view", size=13, weight=700, fill=t.ink))
    doc.add(text(lx + 172, my0 - 26, "rows a–e top, f–j bottom, lower inner rail = gnd", size=12, fill=t.muted))
    hm = [el("rect", width=BB_W, height=BB_D, rx=1.4, fill="#F3F2EE" if not t.dark else "#E9E7E1")]
    holes = []
    for c in range(1, 31):
        for r in BB_ROWS:
            x, y = bb_col_x(c), bb_row_y(r)
            holes.append(f"M{fmt(x - 0.45)} {fmt(y - 0.45)}h0.9v0.9h-0.9z")
    for rail, y in BB_RAILS.items():
        for c in BB_RAIL_COLS:
            x = bb_col_x(c)
            holes.append(f"M{fmt(x - 0.45)} {fmt(y - 0.45)}h0.9v0.9h-0.9z")
    hm.append(el("path", d="".join(holes), fill="#5A5E65"))
    for y, col in ((27.25 - 23.24 - 2.05, "#D8383E"), (27.25 + 23.24 + 2.05, "#D8383E"), (27.25 - 20.7 + 2.0, "#2F64C9"),
                   (27.25 + 20.7 - 2.0, "#2F64C9")):
        hm.append(el("rect", x=3.2, y=y - 0.18, width=BB_W - 6.4, height=0.36, fill=col))
    for c in (1, 5, 10, 15, 20, 25, 30):
        hm.append(text(bb_col_x(c), 27.25 - 16.3, str(c), size=1.6, weight=600, fill="#7B7F86", anchor="middle"))
    for r in BB_ROWS:
        hm.append(text(BB_W / 2 - 39.4, bb_row_y(r) + 0.6, r, size=1.7, weight=600, fill="#7B7F86", anchor="middle"))
    # parts in the board
    bz = bb["buzzer"]
    s_, n_ = bb_hole(bz["S"]), bb_hole(bz["MINUS"])
    hm.append(el("rect", x=s_[0] - 1.6, y=s_[1] - 3.1, width=n_[0] - s_[0] + 3.2, height=4.6, rx=0.7, fill="#16181C", opacity=0.94))
    for key, lab in (("S", "S"), ("M", "·"), ("MINUS", "−")):
        x, y = bb_hole(bz[key])
        hm.append(el("circle", cx=x, cy=y, r=0.55, fill="#D9B45F"))
        hm.append(text(x, y - 1.25, lab, size=1.3, weight=700, fill="#F1F3F5", anchor="middle"))
    ra_, rb_ = (bb_hole(h) for h in bb["resistor"])
    hm.append(el("path", d=f"M{fmt(ra_[0])} {fmt(ra_[1])}H{fmt(rb_[0])}", stroke="#9AA1AA", stroke_width=0.45))
    hm.append(el("rect", x=(ra_[0] + rb_[0]) / 2 - 1.8, y=ra_[1] - 0.9, width=3.6, height=1.8, rx=0.8, fill="#DCC59A"))
    for i, (col, dx) in enumerate((("#E2702A", -1.0), ("#E2702A", -0.35), ("#6A3B1F", 0.3), ("#C8A04A", 1.1))):
        hm.append(el("rect", x=(ra_[0] + rb_[0]) / 2 + dx - 0.18, y=ra_[1] - 0.9, width=0.36, height=1.8, fill=col))
    # jumper inside the board and the used holes
    a_, b_ = bb_hole("e28"), bb_hole("gnd_lower_inner:28")
    hm.append(el("path", d=f"M{fmt(a_[0])} {fmt(a_[1])}C{fmt(a_[0] + 3)} {fmt(a_[1] + 8)} {fmt(b_[0] + 3)} {fmt(b_[1] - 8)} {fmt(b_[0])} {fmt(b_[1])}",
                 fill="none", stroke=net_color(nets, "GND"), stroke_width=0.9, stroke_linecap="round"))
    labels = {"j2": ("j2", 0, 3.6), "j3": ("j3", 0, 3.6), "j4": ("j4", 0, 3.6), "j5": ("j5", 0, 3.6),
              "f2": ("f2", 1.5, -1.1), "g3": ("g3", 1.5, -1.1), "h4": ("h4", 1.5, -1.1), "i5": ("i5", 1.5, -1.1),
              "a24": ("a24", -1.7, -1.1), "e28": ("e28", 2.8, 0.6), "gnd_lower_inner:28": ("rail", 0, 3.6),
              "gnd_lower_inner:3": ("rail", 0, 3.6)}
    for w in wires:
        for part, pin in (w["a"], w["b"]):
            if part != "breadboard":
                continue
            x, y = bb_hole(pin)
            col = net_color(nets, w["net"])
            g = el("circle", cx=x, cy=y, r=0.95, fill=col, stroke="#0F1115", stroke_width=0.22)
            lab, dx, dy = labels.get(pin, (pin, 0, -2))
            g += text(x + dx, y + dy, lab, size=1.55, weight=700, fill="#2A2E35", anchor="middle" if not dx else ("end" if dx < 0 else "start"),
                      stroke="#F3F2EE", stroke_width=0.55, paint_order="stroke")
            hm.append(el("g", g, class_="net", data_net=w["net"]))
    doc.add(el("g", "".join(hm), transform=f"translate({fmt(mx0)} {fmt(my0)}) scale({mk})",
               filter=shadow_filter(doc, "mapshadow", 3, 6, 0.10 if not t.dark else 0.4)))
    doc.add(text(lx, doc.h - 34, "the oled sits in the lid and reaches j2–j5 on a 4-wire lead. on the bench it plugs straight in.",
                 size=12, fill=t.muted))


# =====================================================================================
# 5. pinout: which part sits on which uno pin
# =====================================================================================
def pin_uses(nets, wires, fw):
    """uno pin -> (net id, text) from MC.WIRES; plus free and reserved pins."""
    roles = keypad_roles(fw, wires)
    by_end = {}
    for w in wires:
        (pa, na), (pb, nb) = w["a"], w["b"]
        if pb != "uno":
            continue
        if pa == "breadboard":
            src = {"f2": "oled GND", "g3": "oled VCC", "h4": "oled SCL", "i5": "oled SDA"}.get(na)
            if src:
                by_end[nb] = (w["net"], f"{src}  via {na}")
            elif na.startswith("gnd_"):
                by_end[nb] = (w["net"], "buzzer −  via gnd rail")
            else:
                by_end[nb] = (w["net"], f"buzzer S  via 330 Ω, {na}")
        elif pa == "rc522":
            by_end[nb] = (w["net"], "rc522 " + ("SDA (SS)" if na == "SDA" else na.replace("3V3", "3.3V")))
        elif pa == "keypad":
            r = roles[na]
            by_end[nb] = (w["net"], f"keypad {na[1:]}  {r[1]} {r[3]}")
    return by_end


def pill(x, y, label, fill, color, size=12, h=19, mono=True, weight=600, anchor="start", stroke=None, dash=None,
         hatch=None, pad=9):
    w = tw(label, size, weight, mono=mono) + 2 * pad
    x0 = x if anchor == "start" else x - w
    if not stroke and fill.startswith("#") and (luminance(fill) > 0.75 or luminance(fill) < 0.03):
        stroke = "#8B94A1"
    out = el("rect", x=x0, y=y - h / 2, width=w, height=h, rx=h / 2, fill=fill, stroke=stroke, stroke_width=1 if stroke else None,
             stroke_opacity=0.6 if stroke == "#8B94A1" else None, stroke_dasharray=dash)
    if hatch:
        out += el("rect", x=x0, y=y - h / 2, width=w, height=h, rx=h / 2, fill=hatch)
    out += text(x0 + pad, y + size * 0.36, label, size=size, weight=weight, fill=color, cls="mono" if mono else None)
    return out, w


def pinout(doc, fw, nets, wires):
    t = doc.t
    doc.add(card_bg(doc, r=24))
    doc.add(text(48, 64, "pinout", size=30, weight=700, fill=t.ink, ls=-0.8))
    doc.add(text(48, 90, "arduino uno r3, seen from above, usb on top. every used pin, the part on it and its wire colour.",
                 size=14, fill=t.muted))
    k = 8.0
    tv = Tilt(k, 0, 0, 0)
    ox, oy = doc.w / 2 - UNO_H * k / 2, 168
    pl = Place(tv, (ox / k) + UNO_H, oy / k, 90)
    uses = pin_uses(nets, wires, fw)
    marks = {p: nets[n]["color"] for p, (n, _) in uses.items()}
    sh = shadow_filter(doc, "unoshadow", 10, 14, 0.18 if not t.dark else 0.55)
    doc.add(el("g", uno_draw(doc, pl, label_size=1.15, pin_marks=marks), filter=sh))
    hatch = doc.define("hatch", lambda i: el("pattern", el("path", d="M0 6L6 0", stroke=t.muted, stroke_width=1.2, stroke_opacity=0.5),
                                            id=i, width=6, height=6, patternUnits="userSpaceOnUse"))
    pins = uno_pins()
    right_x = ox + UNO_H * k
    for name, (lx, ly) in pins.items():
        sx, sy = pl.p(lx, ly)
        right = sx > ox + UNO_H * k / 2
        disp = {"GND1": "GND", "GND2": "GND", "GND3": "GND", "3V3": "3.3V", "NC": "NC"}.get(name, name)
        if name in uses:
            net, label = uses[name]
            col = nets[net]["color"]
            use = (label, col, on_color(col), None, None)
        elif name in ("A2", "A3"):
            use = ("free", "none", t.accent, t.accent, None)
        elif name in ("D0", "D1"):
            use = ("usb serial, keep free", t.surface2 if not t.dark else t.surface3, t.ink2, t.line2_hex, hatch)
        elif name in ("SCL", "SDA"):
            use = (f"same line as {'A5' if name == 'SCL' else 'A4'}", None, t.muted, None, None)
        else:
            use = ("not used", None, t.muted, None, None)
        sub = ""
        if name in AVR:
            p_, _, alt = AVR[name]
            sub = p_ + (f" {alt}" if alt else "")
        gap = 34
        base_x = right_x + gap if right else ox - gap
        anchor = "start" if right else "end"
        sgn = 1 if right else -1
        g = [el("path", d=f"M{fmt(sx + sgn * 6)} {fmt(sy)}H{fmt(base_x - sgn * 4)}", stroke=t.line2_hex, stroke_opacity=0.9,
                stroke_width=1)]
        name_fill = t.ink if name in uses or name in ("A2", "A3") else (t.surface3 if not t.dark else t.surface3)
        name_col = t.surface if name in uses or name in ("A2", "A3") else t.muted
        svg, w1 = pill(base_x, sy, disp, name_fill, name_col, size=12, anchor=anchor, pad=8)
        g.append(svg)
        x2 = base_x + sgn * (w1 + 8)
        w2 = 0
        if sub:
            w2 = tw(sub, 11, mono=True)
            g.append(text(x2, sy + 4, sub, size=11, fill=t.muted, cls="mono", anchor=anchor))
        x3 = x2 + sgn * ((w2 + 10) if sub else 0)
        x3 = base_x + sgn * 132
        label, fill, color, stroke, hat = use
        if fill:
            svg, _ = pill(x3, sy, label, fill if fill != "none" else (t.surface if not t.dark else t.bg2), color, size=11.5,
                          anchor=anchor, stroke=stroke, dash="3 3" if label == "free" else None, hatch=hat, mono=False,
                          weight=600)
        else:
            svg = text(x3 + sgn * 9, sy + 4, label, size=11.5, fill=color, anchor=anchor)
        g.append(svg)
        net_attr = uses[name][0] if name in uses else None
        doc.add(el("g", "".join(g), class_="net" if net_attr else None, data_net=net_attr))
    # ------------------------------------------------------------- keypad matrix and legend underneath
    roles = keypad_roles(fw, wires)
    kx0, ky0 = 60, 800
    doc.add(text(kx0, ky0, "keypad matrix", size=14, weight=700, fill=t.ink))
    rows_fw = ", ".join(fw["keypad"]["rows"]).replace("D", "")
    cols_fw = ", ".join(fw["keypad"]["cols"]).replace("D", "")
    doc.add(text(kx0, ky0 + 20, f"GameRuntime.h: KEYPAD_REIHEN = {{{rows_fw}}}, KEYPAD_SPALTEN = {{{cols_fw}}}", size=11.5,
                 fill=t.muted, cls="mono"))
    chars = fw["keypad"]["chars"]
    cell = 34
    by_role = {(r[1], r[2]): (p, r) for p, r in roles.items()}
    out = []
    gx0, gy0 = kx0 + 250, ky0 + 76
    for r in range(4):
        for c in range(4):
            ch = chars[r * 4 + c]
            fill = KEY_COLOURS["func"] if ch in "ABCD*#" else KEY_COLOURS["digit"]
            out.append(el("rect", x=gx0 + c * cell, y=gy0 + r * cell, width=cell - 6, height=cell - 6, rx=5, fill=fill))
            out.append(text(gx0 + c * cell + (cell - 6) / 2, gy0 + r * cell + (cell - 6) / 2 + 5, ch, size=14, weight=700,
                            fill="#FFFFFF", anchor="middle"))
    ring = "#000000" if not t.dark else "#FFFFFF"
    for r in range(4):
        p, role = by_role[("row", r + 1)]
        col = nets[role[4]]["color"]
        y = gy0 + r * cell + (cell - 6) / 2
        out.append(el("g", el("circle", cx=gx0 - 14, cy=y, r=5, fill=col, stroke=ring, stroke_opacity=0.25)
                      + text(gx0 - 26, y + 4, f"{role[0]:<3} row {r + 1} · pin {p[1:]}", size=11.5, fill=t.ink2, anchor="end", cls="mono"),
                      class_="net", data_net=role[4]))
    for c in range(4):
        p, role = by_role[("col", c + 1)]
        col = nets[role[4]]["color"]
        x = gx0 + c * cell + (cell - 6) / 2
        out.append(el("g", el("circle", cx=x, cy=gy0 - 14, r=5, fill=col, stroke=ring, stroke_opacity=0.25)
                      + text(x, gy0 - 26, role[0], size=11.5, weight=700, fill=t.ink2, anchor="middle", cls="mono"),
                      class_="net", data_net=role[4]))
    cols_txt = " · ".join(f"{by_role[('col', c + 1)][1][0]} = pin {by_role[('col', c + 1)][0][1:]}" for c in range(4))
    out.append(text(gx0 + 4 * cell + 10, gy0 + 10, "columns, right to left", size=11.5, weight=600, fill=t.ink2))
    out.append(text(gx0 + 4 * cell + 10, gy0 + 28, "on the keypad connector:", size=11.5, fill=t.muted))
    for c in range(4):
        p, role = by_role[("col", 4 - c)]
        out.append(text(gx0 + 4 * cell + 10, gy0 + 52 + c * 18, f"pin {p[1:]} → {role[0]} {role[3]}", size=11.5, fill=t.muted, cls="mono"))
    doc.add("".join(out))
    # legend
    lx, ly = doc.w - 420, 836
    doc.add(text(lx, ly - 36, "legend", size=14, weight=700, fill=t.ink))
    items = [("used, wire colour", nets["SCK"]["color"], None, None), ("free", "none", t.accent, "3 3"),
             ("reserved for usb", t.surface2 if not t.dark else t.surface3, None, "hatch"), ("not used", None, None, None)]
    for i, (lab, fill, stroke, extra) in enumerate(items):
        y = ly + i * 28
        if fill == "none":
            doc.add(el("rect", x=lx, y=y - 9, width=34, height=18, rx=9, fill="none", stroke=t.accent, stroke_dasharray="3 3"))
        elif fill:
            doc.add(el("rect", x=lx, y=y - 9, width=34, height=18, rx=9, fill=fill, stroke=t.line2_hex if extra else None))
            if extra == "hatch":
                doc.add(el("rect", x=lx, y=y - 9, width=34, height=18, rx=9, fill=hatch))
        else:
            doc.add(el("rect", x=lx + 10, y=y - 1, width=14, height=2, fill=t.muted))
        doc.add(text(lx + 46, y + 4.5, lab, size=12.5, fill=t.ink2))
    doc.add(text(lx + 200, ly + 4.5, "a4/a5 are the i2c bus,", size=12.5, fill=t.muted))
    doc.add(text(lx + 200, ly + 32.5, "no analogRead there.", size=12.5, fill=t.muted))
    doc.add(text(lx + 200, ly + 60.5, "the keypad needs no", size=12.5, fill=t.muted))
    doc.add(text(lx + 200, ly + 88.5, "resistors and no gnd.", size=12.5, fill=t.muted))


#@@END@@


# =====================================================================================
# output
# =====================================================================================
GRAPHICS = {
    "banner": (1280, 560, banner, "mini casino",
               "the mini casino console with oled, 4x4 keypad and rfid tap zone, a card hovering over the reader"),
    "banner-narrow": (600, 1010, banner_narrow, "mini casino",
                      "the mini casino console with oled, 4x4 keypad and rfid tap zone, and its menu screen"),
    "how-it-works": (1280, 520, how_it_works, "how a round works",
                     "tap a card, pick a colour on the keypad, watch the spin on the oled, hear the jingle, "
                     "the balance stays in the eeprom"),
    "how-it-works-narrow": (600, 1694, how_it_works_narrow, "how a round works",
                            "tap a card, pick a colour on the keypad, watch the spin on the oled, hear the jingle, "
                            "the balance stays in the eeprom"),
    "schematic": (1400, 1160, schematic, "mini casino schematic",
                  "arduino uno r3 with the 1.3 inch i2c oled, the rc522 rfid reader on spi and 3.3 v, "
                  "the 4x4 keypad matrix on d3 to d8, a0 and a1, and the passive buzzer with 330 ohm on d2"),
    "wiring": (1440, 1040, wiring, "mini casino wiring",
               "breadboard view: uno, half size breadboard with buzzer and 330 ohm, oled lead in j2 to j5, rc522 and "
               "keypad wired straight to the uno"),
    "pinout": (1280, 1040, pinout, "arduino uno pinout of the mini casino",
               "every uno pin with the part on it: keypad on d3 to d8, a0, a1, rc522 on d9 to d13, oled on a4 a5, "
               "buzzer on d2, a2 and a3 free, d0 and d1 reserved for usb"),
}


def build_all():
    tok, nets, wires, bb = load_core()
    fw = load_firmware()
    fw["oled"] = Oled(fw)
    cm = load_case()
    ctx = {"tok": tok, "nets": nets, "wires": wires, "bb": bb, "fw": fw, "cm": cm}
    short = {"banner": "bn", "banner-narrow": "bnn", "how-it-works": "hw", "how-it-works-narrow": "hwn",
             "schematic": "sc", "wiring": "wr", "pinout": "po"}
    written, docs = [], {}
    for name, (w, h, fn, title, desc) in GRAPHICS.items():
        for theme in ("light", "dark"):
            t = make_theme(tok, theme)
            doc = Doc(f"mc{short[name]}{theme[0]}", w, h, t, title, desc)
            args = fn.__code__.co_varnames[1:fn.__code__.co_argcount]
            fn(doc, *[ctx[a] for a in args])
            out = DOCS / f"{name}-{theme}.svg"
            out.write_text(doc.svg(), encoding="utf-8")
            docs[(name, theme)] = doc
            written.append(out)
    # the viewer gets the same schematic inline: no fixed size, hover hooks for MC.UI
    hooks = (".K .net,.K .part{cursor:pointer}")
    inline = {}
    for theme in ("light", "dark"):
        d = docs[("schematic", theme)]
        d.style(hooks)
        inline[theme] = d.svg(inline=True).strip()
    js = ("/* generated by docs/make_graphics.py, do not edit. the same drawing as docs/schematic-*.svg.\n"
          "   every wire and label group has data-net (an MC.NETS id), every part block data-part. */\n"
          "window.MC_SCHEMATIC = " + json.dumps(inline, indent=1) + ";\n")
    SCHEMATIC_JS.parent.mkdir(parents=True, exist_ok=True)
    SCHEMATIC_JS.write_text(js, encoding="utf-8")
    written.append(SCHEMATIC_JS)
    return written, docs, ctx


def check(written, ctx):
    """well-formed xml, every net and part present in the schematic, no external references."""
    for p in written:
        if p.suffix == ".svg":
            root = ET.parse(p).getroot()
            txt = p.read_text(encoding="utf-8")
            if re.search(r"(href|src)=\"(https?:|//)", txt) or "@import" in txt or "url(http" in txt:
                fail(f"{p.name}: external reference")
            if p.name.startswith("schematic"):
                found = {e.get("data-net") for e in root.iter() if e.get("data-net")}
                missing = set(ctx["nets"]) - found
                if missing:
                    fail(f"{p.name}: nets without a data-net group: {sorted(missing)}")
                parts = {e.get("data-part") for e in root.iter() if e.get("data-part")}
                need = {"uno", "oled", "rc522", "keypad", "buzzer", "resistor"}
                if need - parts:
                    fail(f"{p.name}: parts without a data-part block: {sorted(need - parts)}")
    src = SCHEMATIC_JS.read_text(encoding="utf-8")
    data = json.loads(src[src.index("{"):src.rindex("}") + 1])
    for theme in ("light", "dark"):
        ET.fromstring(data[theme])


def main():
    written, docs, ctx = build_all()
    check(written, ctx)
    for p in written:
        print(f"wrote {p.relative_to(ROOT).as_posix()}  ({max(1, p.stat().st_size // 1024)} KB)")
    for name in OLD_FILES:
        old = DOCS / name
        if old.exists():
            old.unlink()
            print(f"removed docs/{name} (replaced by the -light/-dark pair)")
    cm = ctx["cm"]
    print(f"case from {cm['source']}: {cm['W']:g} x {cm['D']:g} mm, front {cm['H_FRONT']:g} mm, slope {cm['SLOPE']:g} deg")


if __name__ == "__main__":
    main()
