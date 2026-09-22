"""Generates the animated svg graphics for the readme.

    python docs/make_graphics.py

Writes banner.svg, how-it-works.svg and wiring.svg next to this file.
Everything is plain svg with css keyframes and smil, no scripts, so github
renders the animations straight from the readme.
"""
from pathlib import Path
import math

OUT = Path(__file__).resolve().parent
S3 = math.sqrt(3) / 2

FONT = ("ui-sans-serif, system-ui, -apple-system, 'Segoe UI', Roboto, "
        "Helvetica, Arial, sans-serif")
MONO = "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace"
INK = "#3E3A4F"
MUTED = "#8B87A3"
BG = "#F8F6FC"

# pastel triplets: top, left face, right face
C = {
    "mint":     ("#CDEFE0", "#A9DEC6", "#8FCFB3"),
    "lavender": ("#DDD4F7", "#C4B6F0", "#AB9BE6"),
    "peach":    ("#FFDCC4", "#FFC6A3", "#F5AC85"),
    "blue":     ("#CBE2F9", "#A9CDF2", "#8DB9E9"),
    "pink":     ("#FBD0DB", "#F6B0C2", "#EE93A9"),
    "green":    ("#D2EFD0", "#B0E2AE", "#93D391"),
    "red":      ("#F9C4C0", "#F3A39D", "#EA857E"),
    "slate":    ("#C9D1E0", "#A9B4C9", "#8D9AB4"),
    "dark":     ("#5B5878", "#4A4763", "#3E3B54"),
    "white":    ("#FFFFFF", "#ECEAF3", "#DDDAE8"),
    "yellow":   ("#FFF0C2", "#FFE39B", "#F7D37B"),
}
LED_COLOURS = ["#8D9AB4", "#EA857E", "#93D391"]   # black, red, green


# ---------------------------------------------------------------- iso helpers
def iso(ox, oy, x, y, z=0.0):
    return ox + (x - y) * S3, oy + (x + y) * 0.5 - z


def pts(points):
    return " ".join(f"{x:.1f},{y:.1f}" for x, y in points)


def box(ox, oy, x, y, z, w, d, h, colour, cls=""):
    top, left, right = C[colour]
    P = lambda a, b, c: iso(ox, oy, a, b, c)
    c = f' class="{cls}"' if cls else ""
    return (
        f'<g{c}>'
        f'<polygon points="{pts([P(x, y + d, z), P(x + w, y + d, z), P(x + w, y + d, z + h), P(x, y + d, z + h)])}" fill="{left}"/>'
        f'<polygon points="{pts([P(x + w, y, z), P(x + w, y + d, z), P(x + w, y + d, z + h), P(x + w, y, z + h)])}" fill="{right}"/>'
        f'<polygon points="{pts([P(x, y, z + h), P(x + w, y, z + h), P(x + w, y + d, z + h), P(x, y + d, z + h)])}" fill="{top}"/>'
        f'</g>'
    )


def flat(ox, oy, x, y, z, w, d, fill, extra=""):
    P = lambda a, b: iso(ox, oy, a, b, z)
    return f'<polygon points="{pts([P(x, y), P(x + w, y), P(x + w, y + d), P(x, y + d)])}" fill="{fill}" {extra}/>'


def plane(ox, oy, x, y, z):
    """transform that maps local 2d coords onto the iso ground plane."""
    e, f = iso(ox, oy, x, y, z)
    return f"matrix({S3:.4f},0.5,{-S3:.4f},0.5,{e:.1f},{f:.1f})"


def iso_ellipse(ox, oy, x, y, z, r, fill, extra=""):
    cx, cy = iso(ox, oy, x, y, z)
    return f'<ellipse cx="{cx:.1f}" cy="{cy:.1f}" rx="{r:.1f}" ry="{r * 0.5:.1f}" fill="{fill}" {extra}/>'


# ---------------------------------------------------------------- scene parts
def led(ox, oy, x, y, i, cls, size=12):
    """small slate base with a glowing dome on top."""
    col = LED_COLOURS[i]
    cx, cy = iso(ox, oy, x + size / 2, y + size / 2, 10)
    return (
        box(ox, oy, x, y, 0, size, size, 10, "slate")
        + f'<circle cx="{cx:.1f}" cy="{cy - 3:.1f}" r="15" fill="{col}" filter="url(#blur)" class="{cls}"/>'
        + f'<circle cx="{cx:.1f}" cy="{cy - 3:.1f}" r="7.5" fill="{col}"/>'
        + f'<circle cx="{cx - 2.5:.1f}" cy="{cy - 5.5:.1f}" r="2.2" fill="#fff" opacity=".8"/>'
    )


def button(ox, oy, x, y, i, cls):
    colour = ["slate", "red", "green"][i]
    base = box(ox, oy, x, y, 0, 20, 20, 6, "white")
    cap = box(ox, oy, x + 4, y + 4, 6, 12, 12, 7, colour, cls=cls)
    return base + cap


def reader_and_card(ox, oy, x, y, tag="rd"):
    """rc522 with a floating card and pulse rings."""
    out = box(ox, oy, x, y, 0, 60, 80, 4, "blue")
    coil = (f'<g transform="{plane(ox, oy, x, y, 4.2)}">'
            f'<rect x="9" y="12" width="42" height="56" rx="10" fill="none" stroke="#fff" stroke-width="2.4" opacity=".9"/>'
            f'<rect x="15" y="18" width="30" height="44" rx="8" fill="none" stroke="#fff" stroke-width="1.6" opacity=".6"/>'
            f'</g>')
    rings = ""
    for k, begin in enumerate(("0s", "1.1s")):
        cx, cy = iso(ox, oy, x + 30, y + 40, 4.5)
        rings += (f'<ellipse cx="{cx:.1f}" cy="{cy:.1f}" rx="4" ry="2" fill="none" stroke="#fff" stroke-width="2">'
                  f'<animate attributeName="rx" from="4" to="46" dur="2.2s" begin="{begin}" repeatCount="indefinite"/>'
                  f'<animate attributeName="ry" from="2" to="23" dur="2.2s" begin="{begin}" repeatCount="indefinite"/>'
                  f'<animate attributeName="opacity" from=".9" to="0" dur="2.2s" begin="{begin}" repeatCount="indefinite"/>'
                  f'</ellipse>')
    shadow = iso_ellipse(ox, oy, x + 30, y + 40, 4.4, 22, "#3E3B54", 'opacity=".12" class="cardshadow"')
    card = (f'<g class="float">'
            + box(ox, oy, x + 11, y + 12, 26, 38, 56, 3, "peach")
            + f'<g transform="{plane(ox, oy, x + 11, y + 12, 29.2)}">'
              f'<rect x="7" y="9" width="10" height="8" rx="2" fill="#F7D37B"/>'
              f'<rect x="7" y="36" width="24" height="3" rx="1.5" fill="#fff" opacity=".8"/>'
              f'<rect x="7" y="43" width="16" height="3" rx="1.5" fill="#fff" opacity=".8"/>'
              f'</g></g>')
    return out + coil + rings + shadow + card


def buzzer(ox, oy, x, y):
    out = box(ox, oy, x, y, 0, 26, 26, 16, "dark")
    cx, cy = iso(ox, oy, x + 13, y + 13, 16)
    out += f'<ellipse cx="{cx:.1f}" cy="{cy:.1f}" rx="7" ry="3.5" fill="#2E2B40"/>'
    for k in range(3):
        r = 14 + k * 9
        out += (f'<path d="M{cx + r * 0.55:.1f},{cy - r * 0.9:.1f} a{r},{r} 0 0 1 {r * 0.1:.1f},{r * 1.25:.1f}" '
                f'fill="none" stroke="#EE93A9" stroke-width="2.4" stroke-linecap="round" '
                f'class="wave" style="animation-delay:{k * 0.28:.2f}s"/>')
    return out


def board(ox, oy, x, y):
    out = box(ox, oy, x, y, 0, 150, 100, 8, "mint")
    out += box(ox, oy, x + 70, y + 40, 8, 26, 26, 5, "dark")           # mcu
    out += box(ox, oy, x - 4, y + 34, 8, 18, 22, 11, "white")           # usb
    out += box(ox, oy, x - 4, y + 66, 8, 12, 12, 9, "dark")             # power jack
    out += flat(ox, oy, x + 8, y + 8, 8.2, 128, 5, "#3E3B54", 'opacity=".55"')   # digital header
    out += flat(ox, oy, x + 70, y + 88, 8.2, 66, 5, "#3E3B54", 'opacity=".55"')  # analog header
    out += flat(ox, oy, x + 26, y + 88, 8.2, 30, 5, "#3E3B54", 'opacity=".55"')  # power header
    cx, cy = iso(ox, oy, x + 118, y + 62, 8)
    out += f'<circle cx="{cx:.1f}" cy="{cy:.1f}" r="4" fill="#F7D37B" class="blink"/>'
    return out


def lcd(ox, oy, x, y, line1="MINI CASINO", line2="tap a card"):
    out = box(ox, oy, x, y, 0, 118, 46, 10, "lavender")
    out += flat(ox, oy, x + 8, y + 7, 10.2, 102, 32, "#3E3B54")
    out += (f'<g transform="{plane(ox, oy, x + 8, y + 7, 10.4)}" font-family="{MONO}" font-size="11" fill="#C6EBC5" font-weight="700">'
            f'<text x="8" y="14">{line1}</text><text x="8" y="28" opacity=".8">{line2}</text></g>')
    return out


def wires_note(x, y, text, fill):
    return (f'<rect x="{x}" y="{y}" width="{len(text) * 7.2 + 18:.0f}" height="22" rx="11" fill="{fill}"/>'
            f'<text x="{x + 9}" y="{y + 15}" font-size="12" fill="{INK}" font-family="{FONT}">{text}</text>')


STYLE_COMMON = f"""
  text {{ font-family: {FONT}; }}
  .float {{ animation: float 3s ease-in-out infinite; }}
  .cardshadow {{ animation: shade 3s ease-in-out infinite; transform-box: fill-box; transform-origin: center; }}
  @keyframes float {{ 0%,100% {{ transform: translateY(0) }} 50% {{ transform: translateY(-14px) }} }}
  @keyframes shade {{ 0%,100% {{ opacity:.16; transform: scale(1) }} 50% {{ opacity:.07; transform: scale(.75) }} }}
  .wave {{ opacity: 0; animation: wave 1.8s ease-out infinite; }}
  @keyframes wave {{ 0% {{ opacity: 0 }} 25% {{ opacity: .95 }} 70%,100% {{ opacity: 0 }} }}
  .blink {{ animation: blink 1.6s steps(1) infinite; }}
  @keyframes blink {{ 0%,60% {{ opacity: 1 }} 60.1%,100% {{ opacity: .25 }} }}
  .press {{ animation: press 4.5s ease-in-out infinite; }}
  @keyframes press {{ 0%,8% {{ transform: translateY(0) }} 12%,30% {{ transform: translateY(4px) }} 34%,100% {{ transform: translateY(0) }} }}
"""


def svg(width, height, style, body):
    return (f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {width} {height}" width="{width}" height="{height}" '
            f'font-family="{FONT}">\n<style>{style}</style>\n'
            f'<defs><filter id="blur" x="-60%" y="-60%" width="220%" height="220%"><feGaussianBlur stdDeviation="4.5"/></filter>'
            f'<filter id="soft" x="-10%" y="-10%" width="120%" height="130%"><feDropShadow dx="0" dy="6" stdDeviation="8" flood-color="#5B5878" flood-opacity=".14"/></filter>'
            f'<linearGradient id="bg" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#FBF9FF"/><stop offset="1" stop-color="#F1F6FA"/></linearGradient></defs>\n'
            f'<rect width="{width}" height="{height}" rx="28" fill="url(#bg)"/>\n{body}\n</svg>\n')


# ---------------------------------------------------------------- 1. banner
def banner():
    W, H = 1200, 460
    style = STYLE_COMMON + """
  .led { opacity: .12; animation: chase 1.35s steps(1) infinite; }
  @keyframes chase { 0% { opacity: 1 } 33.3% { opacity: .12 } }
"""
    ox, oy = 880, 100
    scene = f'<g filter="url(#soft)" transform="translate({ox},{oy}) scale(1.18) translate({-ox},{-oy})">'
    scene += flat(ox, oy, -20, -20, -2, 330, 250, "#ECE7FA")
    scene += board(ox, oy, 20, 20)
    scene += reader_and_card(ox, oy, 195, 22)
    scene += lcd(ox, oy, 25, 140)
    for i in range(3):
        scene += button(ox, oy, 160 + i * 28, 138, i, "press") if False else button(ox, oy, 160 + i * 28, 138, i, "")
    scene += buzzer(ox, oy, 262, 118)
    for i in range(3):
        scene += led(ox, oy, 170 + i * 26, 176, i, "led")
    scene += "</g>"
    # per led phase offsets
    scene = scene.replace('class="led"', 'class="led" style="animation-delay:0s"', 1)
    scene = scene.replace('class="led"/>', 'class="led" style="animation-delay:.45s"/>', 1)
    scene = scene.replace('class="led"/>', 'class="led" style="animation-delay:.9s"/>', 1)

    text = (f'<text x="72" y="150" font-size="76" font-weight="800" fill="{INK}" letter-spacing="-2">mini casino</text>'
            f'<text x="76" y="196" font-size="23" fill="{MUTED}">an arduino uno, one rfid card and three lucky colours</text>')
    chips = [("tap a card", "peach"), ("pick a colour", "lavender"), ("watch the spin", "mint")]
    x = 76
    for label, colour in chips:
        w = len(label) * 10.2 + 30
        text += (f'<rect x="{x}" y="232" width="{w:.0f}" height="36" rx="18" fill="{C[colour][0]}"/>'
                 f'<text x="{x + 15}" y="256" font-size="16.5" font-weight="600" fill="{INK}">{label}</text>')
        x += w + 12
    text += (f'<text x="76" y="326" font-size="15" fill="{MUTED}">stake 10 points · black and red pay 2x · green pays 9x · balances live in the eeprom</text>'
             f'<rect x="76" y="346" width="52" height="24" rx="12" fill="{C["dark"][0]}"/>'
             f'<text x="90" y="363" font-size="13" font-weight="700" fill="#fff">v10</text>'
             f'<text x="140" y="363" font-size="13" fill="{MUTED}">lf7 project by felix and nikita, bbz aifs51</text>')
    return svg(W, H, style, text + scene)


# ---------------------------------------------------------------- 2. how it works
def spin_keyframes():
    """timeline of a chase that slows down and stops on green."""
    steps = [0.11] * 6 + [0.15] * 3 + [0.2, 0.26, 0.33, 0.42, 0.55, 0.72]
    hold, gap = 1.7, 0.5
    n = len(steps)
    start = (2 - (n - 1)) % 3          # so the last step lands on led 2 (green)
    total = sum(steps) + hold + gap
    on = {0: [], 1: [], 2: []}
    t = 0.0
    for k, d in enumerate(steps):
        i = (start + k) % 3
        end = t + d + (hold if k == n - 1 else 0)
        on[i].append((t, end))
        t = end
    css = ""
    for i in range(3):
        frames = ["0% { opacity: .12 }"]
        for a, b in on[i]:
            frames.append(f"{a / total * 100:.2f}% {{ opacity: 1 }}")
            frames.append(f"{b / total * 100:.2f}% {{ opacity: .12 }}")
        frames.append("100% { opacity: .12 }")
        css += f"  @keyframes spin{i} {{ {' '.join(frames)} }}\n  .spin{i} {{ opacity:.12; animation: spin{i} {total:.2f}s steps(1) infinite; }}\n"
    win_a = (total - hold - gap) / total * 100
    win_b = (total - gap) / total * 100
    css += (f"  @keyframes win {{ 0%,{win_a:.2f}% {{ opacity:0; transform: scale(.6) }} {win_a + 3:.2f}% {{ opacity:.9; transform: scale(1) }} "
            f"{win_b:.2f}% {{ opacity:0; transform: scale(1.9) }} 100% {{ opacity:0 }} }}\n"
            f"  .win {{ animation: win {total:.2f}s ease-out infinite; transform-box: fill-box; transform-origin: center; }}\n")
    return css


def how_it_works():
    W, H = 1200, 330
    style = STYLE_COMMON + spin_keyframes()
    body = ""
    panels = [
        ("1", "tap your card", "any mifare card works. new cards start with 100 points, then the session runs without the card."),
        ("2", "pick a colour", "press black, red or green to bet 10 points. hold black to change the stake, hold red to log out."),
        ("3", "watch the spin", "three leds race, slow down and stop. black or red pays 2x, green is rare and pays 9x."),
    ]
    for p, (num, title, blurb) in enumerate(panels):
        x0 = 30 + p * 385
        body += f'<rect x="{x0}" y="26" width="360" height="278" rx="22" fill="#fff" opacity=".7"/>'
        body += (f'<circle cx="{x0 + 34}" cy="228" r="15" fill="{C["dark"][0]}"/>'
                 f'<text x="{x0 + 34}" y="233.5" font-size="15" font-weight="800" fill="#fff" text-anchor="middle">{num}</text>'
                 f'<text x="{x0 + 60}" y="234" font-size="21" font-weight="700" fill="{INK}">{title}</text>')
        # wrap blurb into two lines
        words, lines, cur = blurb.split(), [], ""
        for w in words:
            if len(cur) + len(w) > 52:
                lines.append(cur.strip()); cur = ""
            cur += w + " "
        lines.append(cur.strip())
        for k, ln in enumerate(lines):
            body += f'<text x="{x0 + 22}" y="{264 + k * 19}" font-size="13.5" fill="{MUTED}">{ln}</text>'
        ox, oy = x0 + 180, 78
        scene = f'<g filter="url(#soft)">' + flat(ox, oy, -10, -10, -2, 150, 130, "#ECE7FA")
        if p == 0:
            scene += reader_and_card(ox, oy, 35, 20)
        elif p == 1:
            for i in range(3):
                scene += button(ox, oy, 8 + i * 42, 46, i, "press")
            scene = scene.replace('class="press"', 'class="press" style="animation-delay:0s"', 1)
            scene = scene.replace('class="press">', 'class="press" style="animation-delay:1.5s">', 1)
            scene = scene.replace('class="press">', 'class="press" style="animation-delay:3s">', 1)
        else:
            for i in range(3):
                scene += led(ox, oy, 14 + i * 40, 50, i, f"spin{i}", size=16)
            cx, cy = iso(ox, oy, 14 + 2 * 40 + 8, 58, 10)
            scene += f'<circle cx="{cx:.1f}" cy="{cy - 3:.1f}" r="22" fill="none" stroke="{LED_COLOURS[2]}" stroke-width="3" class="win"/>'
        scene += "</g>"
        body += scene
    return svg(W, H, style, body)


# ---------------------------------------------------------------- 3. wiring
def rounded_path(points, r=12):
    d = f"M{points[0][0]:.1f},{points[0][1]:.1f}"
    for i in range(1, len(points) - 1):
        (x0, y0), (x1, y1), (x2, y2) = points[i - 1], points[i], points[i + 1]
        dx0, dy0 = x1 - x0, y1 - y0
        dx1, dy1 = x2 - x1, y2 - y1
        l0, l1 = math.hypot(dx0, dy0), math.hypot(dx1, dy1)
        rr = min(r, l0 / 2, l1 / 2)
        ax, ay = x1 - dx0 / l0 * rr, y1 - dy0 / l0 * rr
        bx, by = x1 + dx1 / l1 * rr, y1 + dy1 / l1 * rr
        d += f" L{ax:.1f},{ay:.1f} Q{x1:.1f},{y1:.1f} {bx:.1f},{by:.1f}"
    d += f" L{points[-1][0]:.1f},{points[-1][1]:.1f}"
    return d


def card(x, y, w, h, colour, title):
    return (f'<rect x="{x}" y="{y}" width="{w}" height="{h}" rx="20" fill="{C[colour][0]}" filter="url(#soft)"/>'
            f'<text x="{x + 22}" y="{y + 32}" font-size="17" font-weight="700" fill="{INK}">{title}</text>')


def pin(x, y, colour, label, side):
    tx = x + 12 if side == "right" else x - 12
    anchor = "start" if side == "right" else "end"
    return (f'<circle cx="{x}" cy="{y}" r="5" fill="{colour}" stroke="#fff" stroke-width="2"/>'
            f'<text x="{tx}" y="{y + 4.5}" font-size="12.5" font-weight="600" fill="{INK}" text-anchor="{anchor}">{label}</text>')


def tag(x, y, text, fill, tx=None):
    w = len(text) * 6.6 + 16
    return (f'<rect x="{x}" y="{y - 10}" width="{w:.0f}" height="20" rx="10" fill="{fill}"/>'
            f'<text x="{x + 8}" y="{y + 4}" font-size="12" fill="{tx or INK}">{text}</text>')


def resistor(x, y, colour):
    """horizontal resistor centred at x,y."""
    return (f'<rect x="{x - 14}" y="{y - 6}" width="28" height="12" rx="6" fill="#F3EFE6" stroke="{colour}" stroke-width="1.5"/>'
            f'<rect x="{x - 7}" y="{y - 6}" width="3" height="12" fill="#F5AC85"/>'
            f'<rect x="{x - 1.5}" y="{y - 6}" width="3" height="12" fill="#F5AC85"/>'
            f'<rect x="{x + 4}" y="{y - 6}" width="3" height="12" fill="#8D9AB4"/>')


def wiring():
    W, H = 1200, 830
    style = STYLE_COMMON + """
  .led { animation: chase 1.35s steps(1) infinite; opacity: .15; }
  @keyframes chase { 0% { opacity: 1 } 33.3% { opacity: .15 } }
  .dot { opacity: .95 }
"""
    wire = {"rfid": "#8DB9E9", "lcd": "#AB9BE6", "btn": "#F5AC85", "buz": "#EE93A9",
            "5v": "#EA857E", "3v3": "#F7D37B", "gnd": "#8D9AB4"}
    body = (f'<text x="60" y="66" font-size="30" font-weight="800" fill="{INK}" letter-spacing="-1">wiring</text>'
            f'<text x="172" y="66" font-size="14" fill="{MUTED}">signal wires only. power pins are tagged, they go to the 5 v, 3.3 v and gnd rails.</text>')

    # ---- uno
    ux, uy, uw, uh = 440, 120, 260, 540
    body += card(ux, uy, uw, uh, "mint", "arduino uno")
    body += (f'<rect x="{ux + 96}" y="{uy + 230}" width="68" height="68" rx="10" fill="{C["dark"][0]}"/>'
             f'<text x="{ux + 130}" y="{uy + 269}" font-size="11" fill="#fff" text-anchor="middle" font-family="{MONO}">328p</text>'
             f'<rect x="{ux + 92}" y="{uy + 400}" width="76" height="26" rx="6" fill="#fff" opacity=".7"/>'
             f'<text x="{ux + 130}" y="{uy + 417}" font-size="11" fill="{MUTED}" text-anchor="middle">usb</text>')
    digital = {f"d{13 - i}": uy + 60 + i * 30 for i in range(12)}      # d13 .. d2 on the right edge
    analog = {f"a{i}": uy + 210 + i * 30 for i in range(6)}            # a0 .. a5 on the left edge
    power = {"5v": uy + 60, "3v3": uy + 90, "gnd": uy + 120}
    for name, y in digital.items():
        colour = wire["rfid"] if name in ("d13", "d12", "d11", "d10", "d9") else wire["buz"] if name == "d2" else wire["lcd"]
        body += pin(ux + uw, y, colour, name, "left")
    for name, y in analog.items():
        colour = wire["btn"] if name in ("a0", "a1", "a2") else LED_COLOURS[int(name[1]) - 3]
        body += pin(ux, y, colour, name, "right")
    for name, y in power.items():
        body += pin(ux, y, wire[name], name, "right")
        body += tag(ux + 52, y, {"5v": "to the 5 v rail", "3v3": "to the 3.3 v rail", "gnd": "to the gnd rail"}[name], "#fff")

    # ---- rc522 (top right)
    rx, ry = 820, 100
    body += card(rx, ry, 320, 240, "blue", "rc522 rfid reader")
    rpins = [("sck", "d13"), ("miso", "d12"), ("mosi", "d11"), ("sda", "d10"), ("rst", "d9")]
    rpy = {lbl: ry + 62 + i * 27 for i, (lbl, _) in enumerate(rpins)}
    for lbl, _ in rpins:
        body += pin(rx, rpy[lbl], wire["rfid"], lbl, "right")
    body += pin(rx, ry + 62 + 5 * 27, wire["3v3"], "vcc", "right") + tag(rx + 50, ry + 62 + 5 * 27, "3.3 v, never 5 v", C["yellow"][0])
    body += pin(rx, ry + 62 + 6 * 27, wire["gnd"], "gnd", "right") + tag(rx + 50, ry + 62 + 6 * 27, "gnd", C["slate"][0])
    # reader graphic with pulse
    gx, gy = rx + 208, ry + 128
    body += (f'<rect x="{gx - 52}" y="{gy - 62}" width="104" height="124" rx="14" fill="#fff" opacity=".85"/>'
             f'<rect x="{gx - 34}" y="{gy - 44}" width="68" height="88" rx="12" fill="none" stroke="{wire["rfid"]}" stroke-width="3"/>'
             f'<rect x="{gx - 22}" y="{gy - 32}" width="44" height="64" rx="9" fill="none" stroke="{wire["rfid"]}" stroke-width="2" opacity=".6"/>')
    for begin in ("0s", "1.1s"):
        body += (f'<circle cx="{gx}" cy="{gy}" r="4" fill="none" stroke="{wire["rfid"]}" stroke-width="2.5">'
                 f'<animate attributeName="r" from="4" to="60" dur="2.2s" begin="{begin}" repeatCount="indefinite"/>'
                 f'<animate attributeName="opacity" from=".9" to="0" dur="2.2s" begin="{begin}" repeatCount="indefinite"/></circle>')
    body += (f'<g class="float"><rect x="{gx - 26}" y="{gy - 18}" width="52" height="36" rx="6" fill="{C["peach"][1]}"/>'
             f'<rect x="{gx - 18}" y="{gy - 10}" width="10" height="8" rx="2" fill="#F7D37B"/></g>')

    # ---- lcd (bottom right)
    lx, ly = 820, 380
    body += card(lx, ly, 320, 270, "lavender", "lcd 16x2")
    lpins = [("rs", "d8"), ("e", "d7"), ("d4", "d6"), ("d5", "d5"), ("d6", "d4"), ("d7", "d3")]
    lpy = {lbl: ly + 62 + i * 25 for i, (lbl, _) in enumerate(lpins)}
    for lbl, _ in lpins:
        body += pin(lx, lpy[lbl], wire["lcd"], lbl, "right")
    body += (f'<rect x="{lx + 96}" y="{ly + 54}" width="200" height="74" rx="10" fill="{C["dark"][0]}"/>'
             f'<rect x="{lx + 106}" y="{ly + 64}" width="180" height="54" rx="6" fill="#2E2B40"/>'
             f'<text x="{lx + 118}" y="{ly + 88}" font-size="15" fill="#C6EBC5" font-family="{MONO}" font-weight="700">10€: S/R/G</text>'
             f'<text x="{lx + 118}" y="{ly + 108}" font-size="15" fill="#C6EBC5" font-family="{MONO}" opacity=".8">100€</text>')
    notes = [("vss  rw  k", "gnd", "slate"), ("vdd", "5 v", "red"), ("a", "200 Ω to 5 v", "red"), ("v0", "10k pot wiper", "yellow")]
    for i, (p, t, colour) in enumerate(notes):
        yy = ly + 150 + i * 26
        body += (f'<text x="{lx + 108}" y="{yy + 4}" font-size="12.5" font-weight="600" fill="{INK}">{p}</text>'
                 + tag(lx + 184, yy, t, C[colour][0]))
    body += f'<text x="{lx + 24}" y="{ly + 258}" font-size="12.5" fill="{MUTED}">parallel hd44780, no i2c backpack. turn the pot until text shows.</text>'

    # ---- buzzer (bottom right, below lcd)
    bx, by = 820, 680
    body += card(bx, by, 320, 110, "pink", "buzzer")
    body += pin(bx, by + 62, wire["buz"], "", "right")
    body += f'<text x="{bx + 14}" y="{by + 50}" font-size="12.5" font-weight="600" fill="{INK}">s</text>'
    body += resistor(bx + 74, by + 62, wire["buz"]) + f'<line x1="{bx + 5}" y1="{by + 62}" x2="{bx + 60}" y2="{by + 62}" stroke="{wire["buz"]}" stroke-width="3"/>'
    body += f'<text x="{bx + 60}" y="{by + 84}" font-size="11" fill="{MUTED}">330 Ω</text>'
    body += f'<line x1="{bx + 88}" y1="{by + 62}" x2="{bx + 130}" y2="{by + 62}" stroke="{wire["buz"]}" stroke-width="3"/>'
    body += (f'<circle cx="{bx + 152}" cy="{by + 62}" r="22" fill="{C["dark"][0]}"/><circle cx="{bx + 152}" cy="{by + 62}" r="5" fill="#2E2B40"/>')
    for k in range(3):
        r = 30 + k * 9
        body += (f'<path d="M{bx + 152 + r * 0.55:.1f},{by + 62 - r * 0.85:.1f} a{r},{r} 0 0 1 0,{r * 1.7:.1f}" fill="none" '
                 f'stroke="{wire["buz"]}" stroke-width="2.4" stroke-linecap="round" class="wave" style="animation-delay:{k * 0.28:.2f}s"/>')
    body += tag(bx + 220, by + 62, "− to gnd", C["slate"][0])
    body += f'<text x="{bx + 24}" y="{by + 98}" font-size="12.5" fill="{MUTED}">passive buzzer, plays the jingles</text>'

    # ---- buttons (top left)
    tx_, ty_ = 60, 100
    body += card(tx_, ty_, 320, 250, "peach", "buttons")
    bpins = ["a0", "a1", "a2"]
    bpy = {p: ty_ + 70 + i * 55 for i, p in enumerate(bpins)}
    names = ["black", "red", "green"]
    for i, p in enumerate(bpins):
        y = bpy[p]
        body += pin(tx_ + 320, y, wire["btn"], "", "left")
        body += f'<line x1="{tx_ + 250}" y1="{y}" x2="{tx_ + 315}" y2="{y}" stroke="{wire["btn"]}" stroke-width="3"/>'
        body += (f'<rect x="{tx_ + 208}" y="{y - 20}" width="42" height="40" rx="8" fill="#fff"/>'
                 f'<g class="press" style="animation-delay:{i * 1.5}s"><circle cx="{tx_ + 229}" cy="{y - 2}" r="13" fill="{LED_COLOURS[i]}"/></g>')
        body += f'<line x1="{tx_ + 150}" y1="{y}" x2="{tx_ + 208}" y2="{y}" stroke="{wire["gnd"]}" stroke-width="3"/>'
        body += tag(tx_ + 96, y, "gnd", C["slate"][0])
        body += f'<text x="{tx_ + 24}" y="{y + 4}" font-size="13" font-weight="600" fill="{INK}">{names[i]}</text>'
    body += f'<text x="{tx_ + 24}" y="{ty_ + 234}" font-size="12.5" fill="{MUTED}">input_pullup in the sketch, so no resistors at all</text>'

    # ---- leds (bottom left)
    ex, ey = 60, 400
    body += card(ex, ey, 320, 290, "white", "leds")
    epins = ["a3", "a4", "a5"]
    epy = {p: ey + 70 + i * 60 for i, p in enumerate(epins)}
    for i, p in enumerate(epins):
        y = epy[p]
        col = LED_COLOURS[i]
        body += pin(ex + 320, y, col, "", "left")
        body += f'<line x1="{ex + 262}" y1="{y}" x2="{ex + 315}" y2="{y}" stroke="{col}" stroke-width="3"/>'
        body += resistor(ex + 248, y, col) + f'<text x="{ex + 234}" y="{y - 12}" font-size="10.5" fill="{MUTED}">330 Ω</text>'
        body += f'<line x1="{ex + 190}" y1="{y}" x2="{ex + 234}" y2="{y}" stroke="{col}" stroke-width="3"/>'
        body += (f'<circle cx="{ex + 172}" cy="{y}" r="22" fill="{col}" filter="url(#blur)" class="led" style="animation-delay:{i * 0.45}s"/>'
                 f'<circle cx="{ex + 172}" cy="{y}" r="12" fill="{col}"/><circle cx="{ex + 168}" cy="{y - 4}" r="3.5" fill="#fff" opacity=".8"/>')
        body += f'<line x1="{ex + 112}" y1="{y}" x2="{ex + 160}" y2="{y}" stroke="{wire["gnd"]}" stroke-width="3"/>'
        body += tag(ex + 60, y, "gnd", C["slate"][0])
        body += f'<text x="{ex + 24}" y="{y + 4}" font-size="13" font-weight="600" fill="{INK}">{names[i]}</text>'
    body += (f'<text x="{ex + 24}" y="{ey + 246}" font-size="12.5" fill="{MUTED}">long leg to the resistor, short leg to gnd.</text>'
             f'<text x="{ex + 24}" y="{ey + 266}" font-size="12.5" fill="{MUTED}">any led colour works for black, we use blue.</text>')

    # ---- wires: uno right edge -> rc522 (going up, channels grow with index)
    wires = ""
    for i, (lbl, dpin) in enumerate(rpins):
        ch = 740 + i * 12
        path_id = f"w_{dpin}"
        d = rounded_path([(ux + uw + 5, digital[dpin]), (ch, digital[dpin]), (ch, rpy[lbl]), (rx - 5, rpy[lbl])])
        wires += f'<path id="{path_id}" d="{d}" fill="none" stroke="{wire["rfid"]}" stroke-width="3" stroke-linecap="round"/>'
        if i < 4:
            wires += (f'<circle r="4" fill="#fff" stroke="{wire["rfid"]}" stroke-width="2" class="dot">'
                      f'<animateMotion dur="{2.6 + i * 0.4:.1f}s" begin="{i * 0.5:.1f}s" repeatCount="indefinite"><mpath href="#{path_id}"/></animateMotion></circle>')
    # uno -> lcd (going down, channels shrink with index)
    for i, (lbl, dpin) in enumerate(lpins):
        ch = 800 - i * 11
        d = rounded_path([(ux + uw + 5, digital[dpin]), (ch, digital[dpin]), (ch, lpy[lbl]), (lx - 5, lpy[lbl])])
        wires += f'<path d="{d}" fill="none" stroke="{wire["lcd"]}" stroke-width="3" stroke-linecap="round"/>'
    # uno -> buzzer
    d = rounded_path([(ux + uw + 5, digital["d2"]), (728, digital["d2"]), (728, by + 62), (bx - 5, by + 62)])
    wires += (f'<path id="w_d2" d="{d}" fill="none" stroke="{wire["buz"]}" stroke-width="3" stroke-linecap="round"/>'
              f'<circle r="4" fill="#fff" stroke="{wire["buz"]}" stroke-width="2"><animateMotion dur="3.4s" repeatCount="indefinite"><mpath href="#w_d2"/></animateMotion></circle>')
    # buttons -> uno (going down to the right, channels shrink with index)
    for i, p in enumerate(bpins):
        ch = 412 - i * 11
        d = rounded_path([(tx_ + 325, bpy[p]), (ch, bpy[p]), (ch, analog[p]), (ux - 5, analog[p])])
        wires += f'<path d="{d}" fill="none" stroke="{wire["btn"]}" stroke-width="3" stroke-linecap="round"/>'
    # leds -> uno (going up to the right, channels grow with index)
    for i, p in enumerate(epins):
        ch = 392 + i * 11
        d = rounded_path([(ex + 325, epy[p]), (ch, epy[p]), (ch, analog[p]), (ux - 5, analog[p])])
        wires += f'<path d="{d}" fill="none" stroke="{LED_COLOURS[i]}" stroke-width="3" stroke-linecap="round"/>'
    body = wires + body   # wires under the cards' pins but cards are drawn first... keep pins on top
    # legend
    lgx, lgy = 440, 700
    body += f'<rect x="{lgx}" y="{lgy}" width="260" height="90" rx="20" fill="#fff" opacity=".75"/>'
    items = [("rfid, spi", wire["rfid"]), ("lcd data", wire["lcd"]), ("buttons", wire["btn"]), ("buzzer", wire["buz"]), ("5 v", wire["5v"]), ("3.3 v", wire["3v3"]), ("gnd", wire["gnd"])]
    for k, (name, colour) in enumerate(items):
        cx = lgx + 22 + (k % 2) * 125
        cy = lgy + 24 + (k // 2) * 20
        body += f'<circle cx="{cx}" cy="{cy}" r="5" fill="{colour}"/><text x="{cx + 12}" y="{cy + 4}" font-size="12" fill="{INK}">{name}</text>'
    return svg(W, H, style, body)


def main():
    for name, fn in (("banner.svg", banner), ("how-it-works.svg", how_it_works), ("wiring.svg", wiring)):
        (OUT / name).write_text(fn(), encoding="utf-8")
        print("wrote", OUT / name)


if __name__ == "__main__":
    main()
