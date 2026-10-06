"""Parametric 3d printable case for the mini casino, V11 hardware.

    pip install manifold3d numpy
    python case/make_case.py

Writes:
    case/stl/base.stl            the body, print as is (floor on the bed)
    case/stl/lid.stl             the top plate, already flipped for printing (face down)
    case/stl/assembly.stl        both parts in place, for looking at
    case/stl/fitcheck/*.stl      honest dummies of oled, keypad, rc522, uno, breadboard, buzzer,
                                 in place, incl. headers and dupont housings
    case/dims.json               the key numbers, the lid features and the fit check
    case/layout.svg              dimensioned drawing, light and dark
    case/viewer/data/case_geo.js window.MC_CASE for the 3d viewer: compact meshes, part placements

Every number lives in the parameter block below. Change it, run again. The script ends with a
fit check: every dummy part and every wire bend envelope against the body, the lid and each
other. It prints the clearances and exits with status 1 on any collision.

Coordinates: x runs left to right, y front to back, z up, origin at the front left bottom
corner. The top plate is tilted by SLOPE degrees and rises toward the back. Lid features are
given in lid coordinates: u across (= x), v up the slope from the front edge, n out of the top
surface (n = 0 is the top, n = -LID the underside). The viewer uses three.js world
coordinates: X = x - W/2, Y = z, Z = D/2 - y (the front faces +Z).
"""
from pathlib import Path
import base64
import json
import math
import struct
import sys

import numpy as np
import manifold3d as mf
from manifold3d import CrossSection, Manifold

HERE = Path(__file__).resolve().parent
OUT = HERE / "stl"
VIEWER_DATA = HERE / "viewer" / "data" / "case_geo.js"

# ================================================================== parameters, mm
# ---------------------------------------------------------------- shell
W, D = 200.0, 148.0        # footprint
H_FRONT = 34.0             # total height at the front edge, lid included
SLOPE = 10.0               # degrees, the top rises toward the back
R = 10.0                   # outer corner radius, plan view
WALL = 2.4                 # 6 perimeters with a 0.4 nozzle
FLOOR = 3.0
LID = 3.0                  # lid plate, measured normal to the top surface
EDGE_R = 1.8               # rounded top edge of the lid
PARTING = 0.4              # chamfer on both sides of the lid/body joint, gives a crisp shadow line
FOOT_CHAMFER = 0.8         # bottom edge, also hides the elephant foot
CLEAR = 0.3                # lid skirt to wall
SKIRT_H, SKIRT_T = 3.0, 1.6
SEG = 96                   # segments per full circle, large round things
SEG_S = 24                 # small holes
FILLET_STEPS = 6

# ---------------------------------------------------------------- screws
BOSS_IN = 8.5              # corner boss centre, from both outer faces
BOSS_D = 7.2               # boss, merged into the corner walls
BOSS_HOLE = 2.7            # m3 self tapping in pla or petg. use 4.0 for heat set inserts
BOSS_HOLE_DEPTH = 12.0
SCREW_D = 3.4              # m3 clearance
CSK_D = 6.6                # 90 degree countersink, din 7991 / iso 10642 head
BOSSES = [(BOSS_IN, BOSS_IN), (W - BOSS_IN, BOSS_IN), (BOSS_IN, D - BOSS_IN), (W - BOSS_IN, D - BOSS_IN)]

# ---------------------------------------------------------------- reference parts (sources in brackets)
PITCH = 2.54
DUPONT = (2.54, 14.0)      # dupont crimp housing section and length (generic 2.54 jumper wires)
WIRE_KEEP = 6.5            # room behind a housing for the wire to bend: r 5 + 1.5 insulation

# arduino uno r3 [arduino A000066 reference design, shield layout in mil]
UNO = (68.58, 53.34, 1.6)                     # 2.7 x 2.1 in
UNO_HOLES = [(13.97, 2.54), (15.24, 50.8), (66.04, 7.62), (66.04, 35.56)]   # (550,100) (600,2000) (2600,300) (2600,1400) mil
UNO_HOLE_D = 3.2
UNO_USB = dict(y=38.1, w=12.0, l=16.0, h=10.9, over=6.3)   # usb-b receptacle, wurth 61729 class
UNO_JACK = dict(y=7.62, w=9.0, l=13.7, h=11.0, over=1.8, hole_z=6.5)   # dc-005 class barrel jack
UNO_HEADER_H = 8.5
UNO_HEADERS = [            # first pin x in inch, y in inch, pin names (same as js/parts_boards.js)
    (0.84, 2.0, ["SCL", "SDA", "AREF", "GND3", "D13", "D12", "D11", "D10", "D9", "D8"]),
    (1.90, 2.0, ["D7", "D6", "D5", "D4", "D3", "D2", "D1", "D0"]),
    (0.90, 0.1, ["NC", "IOREF", "RESET", "3V3", "5V", "GND1", "GND2", "VIN"]),
    (2.00, 0.1, ["A0", "A1", "A2", "A3", "A4", "A5"]),
]
UNO_USED = ["D2", "D3", "D4", "D5", "D6", "D7", "D8", "D9", "D10", "D11", "D12", "D13",
            "A0", "A1", "A4", "A5", "GND1", "GND2", "GND3", "5V", "3V3"]
UNO_TALL = [               # (x0, y0, x1, y1, height above the pcb) envelopes of the taller parts
    (26.0, 9.8, 63.0, 20.8, 8.0),      # atmega328p-pu in its dip-28 socket
    (61.4, 22.6, 68.2, 30.8, 8.5),     # icsp 2 x 3 of the 328p
    (21.4, 42.4, 29.4, 49.0, 8.5),     # icsp 3 x 2 of the 16u2
    (11.6, 13.0, 25.6, 20.2, 6.1),     # two 47 uf electrolytics
    (2.2, 45.2, 8.6, 51.6, 5.0),       # reset button
]
UNO_STUBS = 3.0            # header pins below the pcb (the icsp pins are the longest)

# 1.3" oled, sh1106, i2c [common 4 pin module drawing, er-oled013-1 panel]
OLED_PCB = (35.4, 33.5, 1.2)
OLED_HOLE_IN = 2.0                            # 4 x d2.0, 2.0 from the edges
OLED_GLASS = (34.5, 23.0)                     # panel outline
OLED_GLASS_TOP = 5.0                          # panel top edge from the pcb top edge (header side)
OLED_STACK = 1.7                              # foam tape 0.25 + panel 1.45 above the pcb
OLED_AA = (29.42, 14.70)                      # active area, 128 x 64 at 0.23 pitch
OLED_AA_TOP = 2.35                            # active area top edge from the panel top edge
OLED_PIN_Y = 1.6                              # pin row from the pcb top edge
OLED_PIN_UP, OLED_PIN_BODY, OLED_PIN_DOWN = 1.4, 2.5, 6.0
OLED_FPC_W = 12.6                             # flex from the panel ledge around the bottom edge
OLED_BACK_PARTS = 1.4                         # tallest part on the back (sot-23 ldo)

# rc522 [blue rfid-rc522 module, nxp mfrc522 hvqfn32, hc-49/s crystal]
RC522_PCB = (39.0, 60.0, 1.6)                 # across, along (header on a short edge)
RC522_HOLES = [(3.6, 3.6), (35.4, 3.6), (3.6, 42.6), (35.4, 42.6)]   # d3.0, from the antenna end
RC522_HOLE_D = 3.0
RC522_PIN_ROW = 58.0                          # through holes, from the antenna end
RC522_STUB = 1.5                              # pin ends through the back
RC522_COIL = (2.6, 2.6, 36.4, 37.6, 11.0)     # antenna coil x0 y0 x1 y1 corner radius
RC522_PARTS = 3.5                             # tallest part on the component side (crystal can)
RC522_PARTS_ZONE = (38.0, 57.0)               # parts between the coil and the header (from the antenna end)
RC522_XTAL = (28.6, 47.4)                     # 27.12 mhz crystal, its two leads are soldered on the back
RC522_RA = dict(body=2.54, axis=1.27, out=6.0, body_from=58.75)   # 90 degree header

# 4x4 membrane keypad [generic listings 69 x 77 x 0.8, 8 pin tail]
KEYPAD = (69.2, 76.9, 0.8)
KEYPAD_R = 1.6
KEYPAD_TAIL_W = 20.3
KEYPAD_CONN = (20.6, 2.6, 10.0)               # 1 x 8 female crimp housing at the tail end

# half size breadboard, 400 points [sparkfun prt-12002 / generic]
BB = (82.5, 54.5, 8.5)
BB_RAIL_IN = 20.7                             # rail rows from the centre line
# passive buzzer module ky-006, stands upright in the breadboard [joy-it ky-006]
BUZ_PCB = (15.0, 18.5, 1.6)
BUZ_CAN = (12.0, 8.5, 11.0)                   # diameter, height, centre height above the board
RESISTOR = (2.4, 6.3)                         # 1/4 w body, stands upright between e24 and e26

# ---------------------------------------------------------------- lid layout (u, v)
MARGIN = 20.0              # outer margin to the keypad recess, sides and front
KEYPAD_CLEAR = 0.4         # total, on each axis
KEYPAD_REC = (KEYPAD[0] + KEYPAD_CLEAR, KEYPAD[1] + KEYPAD_CLEAR)
KEYPAD_DEPTH = 0.8         # the overlay ends flush with the lid
KEYPAD_REC_R = KEYPAD_R + KEYPAD_CLEAR / 2
KEYPAD_EDGE = 0.3          # chamfer around the recess and the slot
COL_L = MARGIN + KEYPAD_REC[0] / 2           # keypad and oled axis
COL_R = W - COL_L                            # tap zone and grille axis, mirrored about the centre
KEYPAD_V0 = MARGIN                           # front edge of the recess
ROW_FRONT = KEYPAD_V0 + KEYPAD_REC[1] / 2    # keypad centre = tap zone centre
SLOT = (22.0, 3.8, 1.2)    # ribbon slot w x h, corner radius: passes the 20.6 x 2.6 connector
SLOT_BEHIND = 1.2          # the slot reaches this far under the keypad edge

WINDOW_MARGIN = 0.4        # opening around the active area
WINDOW = (OLED_AA[0] + 2 * WINDOW_MARGIN, OLED_AA[1] + 2 * WINDOW_MARGIN)
WINDOW_R = 0.6
WINDOW_GAP = 14.0          # keypad recess to the chamfered window edge
LID_OVER_GLASS = LID - OLED_STACK - 0.1      # the panel sits 0.1 below the pocket floor
WINDOW_CHAMFER = LID_OVER_GLASS - 0.4        # 45 degrees on the outside, 0.4 straight wall left
WINDOW_TOP = (WINDOW[0] + 2 * WINDOW_CHAMFER, WINDOW[1] + 2 * WINDOW_CHAMFER)
ROW_BACK = KEYPAD_V0 + KEYPAD_REC[1] + WINDOW_GAP + WINDOW_TOP[1] / 2   # window centre = grille centre
OLED_CLEAR = 0.25          # around the oled pcb
OLED_FRAME_T = 1.2
M2_PILOT, M2_DEPTH = 1.6, 2.2                # m2 x 4 self tapping, optional, the clips hold it

TAP_RING_D = 52.0          # engraved ring, centre line
TAP_RING_W = 0.8
ENGRAVE = 0.5
TAP_ARCS = [4.6, 8.4, 12.2, 16.0]            # contactless symbol, four arcs
TAP_ARC_W = 1.6
TAP_ARC_SPAN = 42.0        # degrees each side
RC522_THIN = 1.6           # lid left over the antenna coil
RC522_STUB_RELIEF = RC522_STUB + 0.3
RC522_JOINT_RELIEF = 1.2   # crystal solder joints on the back, 0.9 high
RC522_CLEAR = 0.3
RC522_FRAME_T = 1.4
PEG_D = 2.6                # locating pegs through the rc522 holes

GRILLE_HOLE = 1.8
GRILLE_RINGS = [(0.0, 1), (3.4, 6), (6.8, 12), (10.2, 18)]   # radius, holes

WORDMARK = "mini casino"   # engraved, single line geometric lowercase
WORDMARK_X = 3.6           # x-height
WORDMARK_STROKE = 0.7
WORDMARK_DEPTH = 0.4
WORDMARK_V = None          # v of the baseline centre, None = centred in the back margin

CLIP_W, CLIP_T, CLIP_NOSE = 6.0, 1.2, 0.6
FIT_TOL = 0.05             # mm3, contact slivers of touching faces stay below this
PLA_DENSITY = 1.24         # g/cm3
FILL_FACTOR = 0.85         # 2.4 mm walls and 3 mm plates print almost solid with 3 walls, 15 % infill
FIT_SEARCH = 25.0

# ---------------------------------------------------------------- base layout
UNO_STANDOFF = 5.0         # clears the 3 mm pin ends under the board
UNO_STANDOFF_D = 6.0
UNO_PILOT = 2.6            # m3 x 6 self tapping
USB_RECESS = 0.5           # usb-b face behind the outer back face
UNO_X0 = 15.5              # case x of the board edge on the power header side
UNO_Y_BACK = D - USB_RECESS - UNO_USB["over"]   # case y of the usb edge of the board
USB_OPEN = (UNO_USB["w"] + 1.2, UNO_USB["h"] + 1.3, 1.2)   # w, h, corner radius
JACK_OPEN_D = 11.5         # passes the plug of a 5.5/2.1 barrel lead
OPEN_CHAMFER = 0.6
BB_POCKET = 0.6            # breadboard pocket depth, 0.4 clearance around
BB_CX = COL_R - 11.5 * PITCH                 # column 27 (the buzzer can) under the grille axis
BB_CAN_Z = -(3.81 + 2 * PITCH) - (BUZ_CAN[1] / 2 + 0.15 - PITCH / 2)   # row c plus the can, breadboard z (row a = -z)
FEET_D, FEET_DEPTH, FEET_IN = 10.5, 0.8, 15.0

# ---------------------------------------------------------------- transponders on the table
CARDS = [                  # world x, z of the centre, yaw in degrees (counter-clockwise seen from above)
    ("card_DF51AA39", "card", 158.0, 30.0, 24.0),
    ("card_0885B1A8", "fob", 117.0, 106.0, 38.0),
    ("card_049F905C110189", "sticker", 160.0, 112.0, 10.0),
    ("card_04CABD5C110189", "coin", 199.0, 95.0, 0.0),
]

# ---------------------------------------------------------------- derived
TAN = math.tan(math.radians(SLOPE))
SIN = math.sin(math.radians(SLOPE))
COS = math.cos(math.radians(SLOPE))
Z_LID = H_FRONT - LID / COS          # height of the lid underside plane at the front
L_LID = D / COS                      # lid length on the slope
V_GRILLE = ROW_BACK
BB_CY = V_GRILLE * COS + BB_CAN_Z    # breadboard centre so that the can sits under the grille
OLED_AA_DZ = OLED_PCB[1] / 2 - (OLED_GLASS_TOP + OLED_AA_TOP + OLED_AA[1] / 2)   # aa centre from the pcb centre, toward the header (+v)
OLED_V = ROW_BACK - OLED_AA_DZ       # oled pcb centre on the lid (v)
RC522_ANT_OFF = RC522_PCB[1] / 2 - (RC522_COIL[1] + RC522_COIL[3]) / 2    # antenna centre from the pcb centre, away from the header
RC522_U = COL_R - RC522_ANT_OFF      # rc522 pcb centre (u); the antenna under the ring, the header points to -u


# ================================================================== helpers
def rrect(w, d, r, seg=SEG):
    """rounded rectangle with its corner at the origin."""
    r = max(min(r, w / 2 - 1e-3, d / 2 - 1e-3), 0.01)
    return CrossSection.square((w - 2 * r, d - 2 * r)).translate((r, r)).offset(r, mf.JoinType.Round, 2.0, seg)


def crect(w, d, r, seg=SEG):
    """rounded rectangle centred on the origin."""
    return rrect(w, d, r, seg).translate((-w / 2, -d / 2))


def cyl(d, h, at=(0.0, 0.0, 0.0), seg=SEG):
    return Manifold.cylinder(h, d / 2, d / 2, seg).translate(at)


def box(x0, y0, z0, x1, y1, z1):
    return Manifold.cube((x1 - x0, y1 - y0, z1 - z0)).translate((x0, y0, z0))


def outline_pts(inset, n_corner=24):
    """points of the footprint outline offset inward by inset, ccw, in the xy plane."""
    w, d, r = W - 2 * inset, D - 2 * inset, max(R - inset, 0.05)
    pts = []
    for cx, cy, a0 in ((inset + w - r, inset + r, -90), (inset + w - r, inset + d - r, 0),
                       (inset + r, inset + d - r, 90), (inset + r, inset + r, 180)):
        for k in range(n_corner + 1):
            a = math.radians(a0 + 90 * k / n_corner)
            pts.append((cx + r * math.cos(a), cy + r * math.sin(a)))
    return np.array(pts)


def ring(inset, z_front, slope=True):
    """outline at a given inset, lifted onto the plane z = z_front + y * tan(slope)."""
    p = outline_pts(inset)
    z = z_front + (p[:, 1] * TAN if slope else 0.0)
    return np.column_stack([p, np.broadcast_to(z, (len(p),))])


def below(part, z_front):
    """keep everything under the plane z = z_front + y * tan(slope)."""
    return part.trim_by_plane((0.0, SIN, -COS), -COS * z_front)


def above(part, z_front):
    return part.trim_by_plane((0.0, -SIN, COS), COS * z_front)


def lid_point(u, v, n=0.0):
    """lid coordinates to case coordinates."""
    return (u, v * COS - n * SIN, H_FRONT + v * SIN + n * COS)


def on_lid(part, u, v, n=0.0):
    """place a part built in lid coordinates (x = u, y = v, z = n, z = 0 is the top surface)."""
    return part.rotate((SLOPE, 0.0, 0.0)).translate(lid_point(u, v, n))


def lid_prism(cs, n0, n1):
    """a 2d shape in (u, v) extruded from n0 to n1 in lid coordinates, still unplaced."""
    return cs.extrude(n1 - n0).translate((0, 0, n0))


def at_world_on_lid(part, x, y, top=True):
    """a part built with z along the lid normal, put at a footprint point x, y on the lid surface."""
    z = (H_FRONT if top else Z_LID) + y * TAN
    return part.rotate((SLOPE, 0.0, 0.0)).translate((x, y, z))


def frustum(cs0, z0, cs1, z1):
    """convex hull of two convex 2d shapes at two heights: a clean frustum without slabs."""
    pts = [np.column_stack([np.asarray(poly, dtype=np.float64), np.full(len(poly), z)])
           for cs, z in ((cs0, z0), (cs1, z1)) for poly in cs.to_polygons()]
    return Manifold.hull_points(np.vstack(pts))


def chamfered_cut(w, d, r, depth, chamfer, seg=SEG):
    """a rounded rectangular cutter for the lid top: straight down to -depth, a 45 degree chamfer
    that meets the top surface (n = 0) at w + 2 chamfer. the flare runs straight on above the
    surface, so the cut leaves no micro step at the edge."""
    straight = crect(w, d, r, seg).extrude(depth + 2.0).translate((0, 0, -depth))
    up = 1.0
    flare = frustum(crect(w, d, r, seg), -chamfer, crect(w + 2 * (chamfer + up), d + 2 * (chamfer + up), r + chamfer + up, seg), up)
    return straight + flare


def snap_clip(width, catch_n, inward):
    """cantilever snap hook hanging from the lid underside (lid coordinates, unplaced, centred
    at the arm's inner face). inward: 'u+', 'u-', 'v+', 'v-' = direction toward the board.
    the flat catch face sits at n = catch_n, the 45 degree lead-in below it."""
    top = -LID + 0.2
    arm = box(-width / 2, -CLIP_T, catch_n - 1.6, width / 2, 0.0, top)
    nose = CrossSection([[(0.0, catch_n), (0.0, catch_n - 1.4), (CLIP_NOSE, catch_n)]]).extrude(width)
    nose = nose.transform([[0, 0, 1, -width / 2], [1, 0, 0, 0], [0, 1, 0, 0]])
    clip = arm + nose
    angle = {"v+": 0.0, "u-": 90.0, "v-": 180.0, "u+": -90.0}[inward]
    return clip.rotate((0.0, 0.0, angle))


def to_world(p):
    return [round(p[0] - W / 2, 4), round(p[2], 4), round(D / 2 - p[1], 4)]


def dir_world(v):
    n = math.sqrt(sum(c * c for c in v)) or 1.0
    return [round(v[0] / n, 6), round(v[2] / n, 6), round(-v[1] / n, 6)]


LID_U = (1.0, 0.0, 0.0)
LID_V = (0.0, COS, SIN)
LID_N = (0.0, -SIN, COS)


def neg(v):
    return tuple(-c for c in v)


# ---------------------------------------------------------------- export mesh clean up
# The boolean results triangulate big flat faces with needles between far apart vertices.
# Quantised to int16 for the viewer, the thinnest of them can tilt or turn over. Flipping the
# edge between two coplanar triangles wherever that raises the smallest angle removes them
# without moving a single vertex.
def _sub(a, b):
    return (a[0] - b[0], a[1] - b[1], a[2] - b[2])


def _cross(a, b):
    return (a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0])


def _dot(a, b):
    return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]


def _min_angle(p0, p1, p2):
    """smallest interior angle of a triangle, radians."""
    a, b, c = math.dist(p1, p2), math.dist(p0, p2), math.dist(p0, p1)
    if min(a, b, c) < 1e-12:
        return 0.0
    ang = lambda x, y, z: math.acos(max(-1.0, min(1.0, (y * y + z * z - x * x) / (2 * y * z))))
    return min(ang(a, b, c), ang(b, a, c), ang(c, a, b))


def _unit_normal(V, t):
    n = _cross(_sub(V[t[1]], V[t[0]]), _sub(V[t[2]], V[t[0]]))
    size = math.sqrt(_dot(n, n))
    return (n[0] / size, n[1] / size, n[2] / size) if size > 0 else n, size


class _Mesh:
    """indexed triangle mesh with a directed edge map, for edge flips."""

    def __init__(self, V, T):
        self.V, self.T = V, T
        self.E = {}
        for f, t in enumerate(T):
            self._link(f)

    def _link(self, f):
        a, b, c = self.T[f]
        self.E[(a, b)] = self.E[(b, c)] = self.E[(c, a)] = f

    def _unlink(self, f):
        a, b, c = self.T[f]
        for e in ((a, b), (b, c), (c, a)):
            self.E.pop(e, None)

    def _apex(self, f, p, q):
        t = self.T[f]
        return t[0] if t[0] not in (p, q) else (t[1] if t[1] not in (p, q) else t[2])

    def flip(self, p, q):
        """max-min angle flip of edge p-q between two coplanar triangles. returns True if done."""
        V, E = self.V, self.E
        f1, f2 = E.get((p, q)), E.get((q, p))
        if f1 is None or f2 is None:
            return False
        r, s = self._apex(f1, p, q), self._apex(f2, p, q)
        if r == s or (r, s) in E or (s, r) in E:
            return False
        (n1, l1), (n2, l2) = _unit_normal(V, self.T[f1]), _unit_normal(V, self.T[f2])
        nref, other = (n1, V[s]) if l1 >= l2 else (n2, V[r])
        if max(l1, l2) == 0 or abs(_dot(nref, _sub(other, V[p]))) > 1e-6:
            return False                              # not in one plane
        P, Q, Rr, S = V[p], V[q], V[r], V[s]
        if _dot(_cross(_sub(S, P), _sub(Rr, P)), nref) <= 1e-14 or _dot(_cross(_sub(Q, S), _sub(Rr, S)), nref) <= 1e-14:
            return False                              # the quad is not convex, a flip would fold
        if min(_min_angle(P, S, Rr), _min_angle(S, Q, Rr)) <= min(_min_angle(P, Q, Rr), _min_angle(Q, P, S)) + 1e-9:
            return False
        self._unlink(f1)
        self._unlink(f2)
        self.T[f1], self.T[f2] = [p, s, r], [s, q, r]  # f1 = (p, q, r), f2 = (q, p, s) keep their winding
        self._link(f1)
        self._link(f2)
        return True

    def flip_all(self, queue):
        """lawson flips until no edge in the queue (and the edges they touch) improves."""
        while queue:
            p, q = queue.pop()
            f1 = self.E.get((p, q))
            if f1 is None:
                continue
            f2 = self.E.get((q, p))
            r = self._apex(f1, p, q)
            s = self._apex(f2, p, q) if f2 is not None else None
            if s is not None and self.flip(p, q):
                queue += [(p, s), (s, q), (q, r), (r, p)]


def tidy_mesh(part):
    """(vertices float64, triangles) of a manifold with slivers in flat faces flipped away."""
    mesh = part.to_mesh64()
    V = [tuple(p) for p in np.asarray(mesh.vert_properties, dtype=np.float64)[:, :3].tolist()]
    T = [list(t) for t in np.asarray(mesh.tri_verts, dtype=np.int64).tolist()]
    m = _Mesh(V, T)
    m.flip_all([e for e in m.E])
    return np.array(m.V, dtype=np.float64), np.array(m.T, dtype=np.int64)


def write_stl(part, path):
    """binary stl from a manifold or a (vertices, triangles) pair."""
    if isinstance(part, tuple):
        verts, tris = part
    else:
        mesh = part.to_mesh()
        verts = np.asarray(mesh.vert_properties, dtype=np.float64)[:, :3]
        tris = np.asarray(mesh.tri_verts, dtype=np.int64)
    a, b, c = verts[tris[:, 0]], verts[tris[:, 1]], verts[tris[:, 2]]
    n = np.cross(b - a, c - a)
    length = np.linalg.norm(n, axis=1)
    length[length == 0] = 1
    n = n / length[:, None]
    path.parent.mkdir(parents=True, exist_ok=True)
    with open(path, "wb") as f:
        f.write(b"mini casino v11, generated by case/make_case.py".ljust(80, b"\0"))
        f.write(struct.pack("<I", len(tris)))
        data = np.zeros(len(tris), dtype=[("n", "<f4", 3), ("v", "<f4", (3, 3)), ("attr", "<u2")])
        data["n"] = n
        data["v"][:, 0], data["v"][:, 1], data["v"][:, 2] = a, b, c
        f.write(data.tobytes())
    return len(tris)


def bounds(part):
    return [round(float(x), 2) for x in part.bounding_box()]


# ================================================================== base
def corner_boss_2d(cx, cy):
    """boss circle merged into the corner of the walls, clipped to the outline."""
    sx = 0.0 if cx < W / 2 else W
    sy = 0.0 if cy < D / 2 else D
    corner = CrossSection.square((abs(cx - sx), abs(cy - sy))).translate((min(cx, sx), min(cy, sy)))
    boss = CrossSection.circle(BOSS_D / 2, SEG).translate((cx, cy))
    return CrossSection.batch_hull([boss, corner]) ^ rrect(W, D, R)


def build_base():
    body = Manifold.hull_points(np.vstack([
        ring(FOOT_CHAMFER, 0.0, slope=False), ring(0.0, FOOT_CHAMFER, slope=False),
        ring(0.0, Z_LID - PARTING / COS), ring(PARTING, Z_LID)]))
    cavity = rrect(W - 2 * WALL, D - 2 * WALL, R - WALL).extrude(300).translate((WALL, WALL, FLOOR))
    body = body - cavity

    # corner bosses up to the lid underside, pilot hole along the lid normal
    for x, y in BOSSES:
        body = body + below(corner_boss_2d(x, y).extrude(300), Z_LID)
        body = body - at_world_on_lid(cyl(BOSS_HOLE, BOSS_HOLE_DEPTH + 1, (0, 0, -BOSS_HOLE_DEPTH), SEG_S + 8), x, y, top=False)

    # arduino standoffs
    z_pcb = FLOOR + UNO_STANDOFF
    for bx, by in UNO_HOLES:
        x, y = uno_xy(bx, by)
        body = body + cyl(UNO_STANDOFF_D, UNO_STANDOFF + 0.5, (x, y, FLOOR - 0.5), SEG_S + 8)
        body = body - cyl(UNO_PILOT, UNO_STANDOFF + 1, (x, y, FLOOR), SEG_S)

    # usb-b and barrel jack through the back wall, chamfered on the outside
    usb_x, _ = uno_xy(0.0, UNO_USB["y"])
    usb_z = z_pcb + UNO[2] + UNO_USB["h"] / 2
    w, h, r = USB_OPEN
    g = OPEN_CHAMFER + 2.0
    body = body - back_wall_cut(crect(w, h, r, SEG_S + 8), crect(w + 2 * g, h + 2 * g, r + g, SEG_S + 8), usb_x, usb_z)
    jack_x, _ = uno_xy(0.0, UNO_JACK["y"])
    jack_z = z_pcb + UNO[2] + UNO_JACK["hole_z"]
    body = body - back_wall_cut(CrossSection.circle(JACK_OPEN_D / 2, SEG), CrossSection.circle(JACK_OPEN_D / 2 + g, SEG), jack_x, jack_z)

    # breadboard pocket, so it cannot slide
    body = body - crect(BB[0] + 0.8, BB[1] + 0.8, 1.5).extrude(BB_POCKET + 1).translate((BB_CX, BB_CY, FLOOR - BB_POCKET))

    # rubber feet
    for x, y in ((FEET_IN, FEET_IN), (W - FEET_IN, FEET_IN), (FEET_IN, D - FEET_IN), (W - FEET_IN, D - FEET_IN)):
        body = body - cyl(FEET_D, FEET_DEPTH + 1, (x, y, -1), SEG)
    return body


def back_wall_cut(cs, cs_outer, x, z):
    """an opening through the back wall: cs in (x, z) around (0, 0). cs_outer is cs grown by
    OPEN_CHAMFER + 2: the 45 degree flare starts OPEN_CHAMFER inside the outer face."""
    t = WALL + 2.0
    straight = cs.extrude(t + 4).translate((0, 0, -2))
    flare = frustum(cs, t - OPEN_CHAMFER, cs_outer, t + 2.0)
    cut = straight + flare
    # local z runs outward through the wall (case +y); local y is up
    cut = cut.transform([[1, 0, 0, 0], [0, 0, 1, 0], [0, 1, 0, 0]])
    return cut.translate((x, D - t, z))


def uno_xy(bx, by):
    """uno board coordinates (bx from the usb edge, by from the power header edge) to case x, y.
    the board lies with its usb edge against the back wall: bx runs to the front, by to the right."""
    return UNO_X0 + by, UNO_Y_BACK - bx


# ================================================================== lid
def build_lid():
    steps = []
    for k in range(FILLET_STEPS + 1):
        a = math.radians(90.0 * k / FILLET_STEPS)
        steps.append(ring(EDGE_R * (1 - math.sin(a)), H_FRONT - EDGE_R * (1 - math.cos(a))))
    plate = Manifold.hull_points(np.vstack(steps + [ring(0.0, Z_LID + PARTING / COS), ring(PARTING, Z_LID)]))

    # skirt: keeps the lid from shifting, interrupted around the corner bosses
    inset = WALL + CLEAR
    band = rrect(W - 2 * inset, D - 2 * inset, R - inset).translate((inset, inset))
    band = band - band.offset(-SKIRT_T, mf.JoinType.Round, 2.0, SEG)
    for x, y in BOSSES:
        band = band - corner_boss_2d(x, y).offset(0.8, mf.JoinType.Round, 2.0, SEG)
    skirt = below(above(band.extrude(300), Z_LID - SKIRT_H / COS), Z_LID + 0.01)
    lid = plate + skirt

    lid = lid + oled_mount_add()
    lid = lid + rc522_mount_add()
    lid = lid - oled_mount_cut()
    lid = lid - rc522_mount_cut()
    lid = lid - keypad_cut()
    lid = lid - tap_zone_cut()
    lid = lid - grille_cut()
    lid = lid - wordmark_cut()

    # countersunk screw holes
    csk_h = (CSK_D - SCREW_D) / 2
    up = 1.0                   # the 90 degree cone runs on above the surface: no step at the rim
    csk = Manifold.cylinder(csk_h + up, SCREW_D / 2, CSK_D / 2 + up, SEG_S + 16).translate((0, 0, -csk_h))
    cutter = cyl(SCREW_D, 30, (0, 0, -25), SEG_S + 16) + csk
    for x, y in BOSSES:
        lid = lid - at_world_on_lid(cutter, x, y, top=True)
    return lid


def oled_mount_add():
    """frame around the oled pcb and two snap clips on its left and right edge."""
    w, h = OLED_PCB[0] + 2 * OLED_CLEAR, OLED_PCB[1] + 2 * OLED_CLEAR
    catch = -LID - OLED_PCB[2] - 0.05
    ring2d = crect(w + 2 * OLED_FRAME_T, h + 2 * OLED_FRAME_T, 1.4, SEG_S + 8) - crect(w, h, 0.4, SEG_S + 8)
    frame = lid_prism(ring2d, catch - 0.3, -LID + 0.2)
    gaps = [box(-w / 2 - 3, -CLIP_W / 2 - 1.2, -20, w / 2 + 3, CLIP_W / 2 + 1.2, 0)]      # clip windows
    gaps.append(box(-OLED_FPC_W / 2 - 1.0, -h / 2 - 3, -20, OLED_FPC_W / 2 + 1.0, -h / 2 + 0.5, 0))  # flex wraps the bottom edge
    for g in gaps:
        frame = frame - g
    clips = snap_clip(CLIP_W, catch, "u+").translate((-w / 2, 0, 0)) + snap_clip(CLIP_W, catch, "u-").translate((w / 2, 0, 0))
    return on_lid(frame + clips, COL_L, OLED_V)


def oled_mount_cut():
    """window with the outer chamfer, panel pocket, flex and header reliefs, m2 pilots.
    module frame: local z toward the reader = -v, so a point y mm below the pcb top edge sits at
    v = OLED_V + OLED_PCB[1] / 2 - y."""
    ph = OLED_PCB[1]
    v_of = lambda y: ph / 2 - y               # pcb y (from the header edge) to v, relative to the pcb centre
    cut = chamfered_cut(WINDOW[0], WINDOW[1], WINDOW_R, LID + 1, WINDOW_CHAMFER, SEG_S + 8).translate((0, OLED_AA_DZ, 0))
    gw, gh = OLED_GLASS[0] + 0.6, OLED_GLASS[1] + 0.6
    gv = v_of(OLED_GLASS_TOP + OLED_GLASS[1] / 2)
    cut = cut + lid_prism(crect(gw, gh, 0.6, SEG_S), -LID - 1, -LID + OLED_STACK + 0.1).translate((0, gv, 0))
    fv0, fv1 = v_of(OLED_GLASS_TOP + OLED_GLASS[1] - 0.5), v_of(ph + 0.6)
    cut = cut + lid_prism(crect(OLED_FPC_W + 1.0, fv0 - fv1, 0.4, SEG_S), -LID - 1, -LID + 0.5).translate((0, (fv0 + fv1) / 2, 0))
    pv = v_of(OLED_PIN_Y)
    cut = cut + lid_prism(crect(4 * PITCH + 1.4, 4.0, 0.6, SEG_S), -LID - 1, -LID + OLED_PIN_UP + 0.3).translate((0, pv, 0))
    for sx in (-1, 1):
        for sy in (OLED_HOLE_IN, ph - OLED_HOLE_IN):
            cut = cut + cyl(M2_PILOT, M2_DEPTH + 1, (sx * (OLED_PCB[0] / 2 - OLED_HOLE_IN), v_of(sy), -LID - 1), 16)
    return on_lid(cut, COL_L, OLED_V)


def rc522_frame_local(u, v):
    """rc522 board coordinates (x across, y from the antenna end) to lid (u, v) offsets from
    the pcb centre. the board lies component side down, its header points to -u."""
    return RC522_PCB[1] / 2 - v, u - RC522_PCB[0] / 2


def rc522_mount_add():
    """low frame around three sides of the board, open toward the header, two snap clips, pegs."""
    L, Wd = RC522_PCB[1] + 2 * RC522_CLEAR, RC522_PCB[0] + 2 * RC522_CLEAR   # along u, along v
    catch = -LID - RC522_PCB[2] - 0.05
    ring2d = crect(L + 2 * RC522_FRAME_T, Wd + 2 * RC522_FRAME_T, 1.6, SEG_S + 8) - crect(L, Wd, 0.4, SEG_S + 8)
    ring2d = ring2d - CrossSection.square((20, Wd + 20)).translate((-L / 2 - 20 + 6.0, -Wd / 2 - 10))
    frame = lid_prism(ring2d, catch - 0.3, -LID + 0.2)
    cu, _ = rc522_frame_local(0, 30.0)
    frame = frame - box(cu - CLIP_W / 2 - 1.2, -Wd / 2 - 3, -20, cu + CLIP_W / 2 + 1.2, Wd / 2 + 3, 0)
    clips = (snap_clip(CLIP_W, catch, "v+").translate((cu, -Wd / 2, 0)) +
             snap_clip(CLIP_W, catch, "v-").translate((cu, Wd / 2, 0)))
    pegs = Manifold()
    for hx, hy in RC522_HOLES:
        pu, pv = rc522_frame_local(hx, hy)
        pegs = pegs + cyl(PEG_D, RC522_PCB[2], (pu, pv, -LID - RC522_PCB[2] + 0.2), 20)
    return on_lid(frame + clips + pegs, RC522_U, ROW_FRONT)


def rc522_mount_cut():
    """thin the lid to RC522_THIN over the antenna coil, relief for the header pin ends."""
    x0, y0, x1, y1, r = RC522_COIL
    u0, v0 = rc522_frame_local(x0, y1)
    u1, v1 = rc522_frame_local(x1, y0)
    cu, cv = (u0 + u1) / 2, (v0 + v1) / 2
    pocket = lid_prism(crect(abs(u1 - u0) + 1.0, abs(v1 - v0) + 1.0, r + 0.5), -LID - 1, -RC522_THIN).translate((cu, cv, 0))
    su, _ = rc522_frame_local(0, RC522_PIN_ROW)
    relief = lid_prism(crect(3.4, 8 * PITCH + 1.4, 0.6, SEG_S), -LID - 1, -LID + RC522_STUB_RELIEF).translate((su, 0, 0))
    # crystal leads come through the back as small solder joints
    xu, xv = rc522_frame_local(*RC522_XTAL)
    relief = relief + lid_prism(crect(8.0, 3.2, 0.6, SEG_S), -LID - 1, -LID + RC522_JOINT_RELIEF).translate((xu, xv, 0))
    return on_lid(pocket + relief, RC522_U, ROW_FRONT)


def keypad_cut():
    """0.8 deep recess for the membrane, chamfered edge, ribbon slot through the lid."""
    w, h = KEYPAD_REC
    rec = chamfered_cut(w, h, KEYPAD_REC_R, KEYPAD_DEPTH, KEYPAD_EDGE, SEG)
    rec = rec ^ box(-200, -200, -KEYPAD_DEPTH, 200, 200, 5)
    sw, sh, sr = SLOT
    sv = -h / 2 + SLOT_BEHIND - sh / 2
    slot = chamfered_cut(sw, sh, sr, LID + 1, KEYPAD_EDGE, SEG_S + 8).translate((0, sv, 0))
    return on_lid(rec + slot, COL_L, ROW_FRONT)


def keypad_slot_centre():
    return KEYPAD_V0 + SLOT_BEHIND - SLOT[1] / 2


def arc_stroke(radius, width, span, seg=SEG):
    """an arc of a circle as a 2d stroke with round caps, symmetric about +x, built as one
    polygon (outer arc, cap, inner arc, cap) so its outline has no near tangent seams."""
    a = math.radians(span)
    n = max(8, int(seg * 2 * span / 360))
    ro, ri, rc = radius + width / 2, radius - width / 2, width / 2
    pts = [(ro * math.cos(-a + 2 * a * k / n), ro * math.sin(-a + 2 * a * k / n)) for k in range(n + 1)]
    cx, cy = radius * math.cos(a), radius * math.sin(a)
    pts += [(cx + rc * math.cos(a + math.pi * k / 12), cy + rc * math.sin(a + math.pi * k / 12)) for k in range(1, 12)]
    pts += [(ri * math.cos(a - 2 * a * k / n), ri * math.sin(a - 2 * a * k / n)) for k in range(n + 1)]
    cx, cy = radius * math.cos(-a), radius * math.sin(-a)
    pts += [(cx + rc * math.cos(-a + math.pi + math.pi * k / 12), cy + rc * math.sin(-a + math.pi + math.pi * k / 12)) for k in range(1, 12)]
    return CrossSection([pts])


def tap_symbol():
    """contactless indicator: four arcs opening to the right, centred in the ring."""
    shape = CrossSection()
    for rr in TAP_ARCS:
        shape = shape + arc_stroke(rr, TAP_ARC_W, TAP_ARC_SPAN)
    b = shape.bounds()
    return shape.translate((-(b[0] + b[2]) / 2, -(b[1] + b[3]) / 2))


def tap_zone_cut():
    ring2d = CrossSection.circle(TAP_RING_D / 2 + TAP_RING_W / 2, SEG * 2) - CrossSection.circle(TAP_RING_D / 2 - TAP_RING_W / 2, SEG * 2)
    cut = lid_prism(ring2d + tap_symbol(), -ENGRAVE, 1.0)
    return on_lid(cut, COL_R, ROW_FRONT)


def grille_holes():
    pts = []
    for rr, n in GRILLE_RINGS:
        for k in range(n):
            a = math.radians(90 + 360 * k / n + (180 / n if n == 12 else 0))
            pts.append((rr * math.cos(a), rr * math.sin(a)))
    return pts


def grille_cut():
    cut = Manifold()
    for x, y in grille_holes():
        cut = cut + cyl(GRILLE_HOLE, LID + 2, (x, y, -LID - 1), 20)
    return on_lid(cut, COL_R, V_GRILLE)


# ---------------------------------------------------------------- engraved wordmark
def _arc(cx, cy, r, a0, a1, step=12.0):
    n = max(2, int(abs(a1 - a0) / step) + 1)
    return [(cx + r * math.cos(math.radians(a0 + (a1 - a0) * k / (n - 1))),
             cy + r * math.sin(math.radians(a0 + (a1 - a0) * k / (n - 1)))) for k in range(n)]


def glyph(ch):
    """centre lines of a geometric single stroke lowercase, x-height 1. returns (strokes, dots, advance)."""
    if ch == "i":
        return [[(0, 0), (0, 1)]], [(0, 1.42)], 0.0
    if ch == "n":
        r = 0.42
        return [[(0, 0), (0, 1)], [(0, 1 - r)] + _arc(r, 1 - r, r, 180, 0) + [(2 * r, 0)]], [], 2 * r
    if ch == "m":
        r = 0.36
        return [[(0, 0), (0, 1)], [(0, 1 - r)] + _arc(r, 1 - r, r, 180, 0) + [(2 * r, 0)],
                [(2 * r, 1 - r)] + _arc(3 * r, 1 - r, r, 180, 0) + [(4 * r, 0)]], [], 4 * r
    if ch == "c":
        return [_arc(0.5, 0.5, 0.5, 48, 312)], [], 0.86
    if ch == "a":
        return [_arc(0.5, 0.5, 0.5, 0, 360), [(1.0, 1.0), (1.0, 0.0)]], [], 1.0
    if ch == "o":
        return [_arc(0.5, 0.5, 0.5, 0, 360)], [], 1.0
    if ch == "s":
        r, cx = 0.265, 0.32
        top = _arc(cx, 1 - r, r, 32, 200)
        bot = _arc(cx, r, r, 20, -152)
        return [top + bot], [], 0.64
    return [], [], 0.82     # word space


def wordmark_lines(text, xh):
    """glyph centre lines set on one baseline and centred on x = 0: (strokes, dots) in mm."""
    pen, strokes, dots = 0.0, [], []
    gap = 0.34
    for k, ch in enumerate(text):
        st, dt, adv = glyph(ch)
        strokes += [[(pen + x, y) for x, y in line] for line in st]
        dots += [(pen + x, y) for x, y in dt]
        pen += adv + (gap if ch != " " and k + 1 < len(text) and text[k + 1] != " " else 0.0)
    mid = pen / 2
    strokes = [[((x - mid) * xh, y * xh) for x, y in line] for line in strokes]
    dots = [((x - mid) * xh, y * xh) for x, y in dots]
    return strokes, dots


def wordmark_v():
    return WORDMARK_V if WORDMARK_V is not None else (ROW_BACK + WINDOW_TOP[1] / 2 + L_LID) / 2 - WORDMARK_X / 2


def wordmark_shape(text, xh, stroke):
    """the wordmark as a 2d shape: round capped strokes, baseline centre at the origin."""
    strokes, dots = wordmark_lines(text, xh)
    dot = lambda p, d: CrossSection.circle(d / 2, 20).translate(p)
    shape = CrossSection()
    for line in strokes:
        for a, b in zip(line, line[1:]):
            shape = shape + CrossSection.batch_hull([dot(a, stroke), dot(b, stroke)])
    for p in dots:
        shape = shape + dot(p, stroke * 1.25)
    return shape


def wordmark_cut():
    if not WORDMARK:
        return Manifold()
    v = wordmark_v()
    cut = lid_prism(wordmark_shape(WORDMARK, WORDMARK_X, WORDMARK_STROKE), -WORDMARK_DEPTH, 1.0)
    return on_lid(cut, W / 2, v)


# ================================================================== part placement
def place(origin, x, y):
    """placement in viewer world coordinates. origin is a case point, x and y case directions."""
    return {"origin": to_world(origin), "x": dir_world(x), "y": dir_world(y)}


def bb_point(cx, cz, h=BB[2]):
    """breadboard local (x along the columns, z toward row j / the front) to case."""
    return (BB_CX + cx, BB_CY - cz, FLOOR - BB_POCKET + h)


def bb_col(c):
    return (c - 15.5) * PITCH


def bb_row(r):
    i = "abcdefghij".index(r)
    return -3.81 - (4 - i) * PITCH if i < 5 else 3.81 + (i - 5) * PITCH


def placements():
    z_pcb = FLOOR + UNO_STANDOFF
    ux, uy = uno_xy(UNO[0] / 2, UNO[1] / 2)
    p = {
        # board x (away from the usb edge) runs to the front, board y to the right
        "uno": place((ux, uy, z_pcb), (0, -1, 0), (0, 0, 1)),
        "breadboard": place(bb_point(0, 0, 0), (1, 0, 0), (0, 0, 1)),
        # ky-006 origin: middle pin entry c27, pins along the columns
        "buzzer": place(bb_point(bb_col(27), bb_row("c")), (1, 0, 0), (0, 0, 1)),
        # 330 ohm: midway between e24 and e26 on the surface
        "resistor": place(bb_point(bb_col(25), bb_row("e")), (1, 0, 0), (0, 0, 1)),
        # glass up, header toward the back (local -z = +v)
        "oled": place(lid_point(COL_L, OLED_V, -LID - OLED_PCB[2]), LID_U, LID_N),
        # component side down, header toward the case centre (local +z = -u)
        "rc522": place(lid_point(RC522_U, ROW_FRONT, -LID), LID_V, neg(LID_N)),
        # adhesive side on the recess floor, legends readable from the front
        "keypad": place(lid_point(COL_L, ROW_FRONT, -KEYPAD_DEPTH), LID_U, LID_N),
    }
    for pid, kind, x, z, yaw in CARDS:
        a = math.radians(yaw)
        p[pid] = {"origin": [x, 0.02, z], "x": [round(math.cos(a), 6), 0.0, round(-math.sin(a), 6)], "y": [0.0, 1.0, 0.0], "kind": kind}
    return p


# ================================================================== fit check dummies
def uno_part(bx0, by0, bx1, by1, z0, z1):
    """a box in uno board coordinates (z from the pcb top face) to case coordinates."""
    x0, y1 = uno_xy(bx0, by0)
    x1, y0 = uno_xy(bx1, by1)
    zt = FLOOR + UNO_STANDOFF + UNO[2]
    return box(min(x0, x1), min(y0, y1), zt + z0, max(x0, x1), max(y0, y1), zt + z1)


def uno_pins():
    pins = {}
    for x0, y, names in UNO_HEADERS:
        for i, n in enumerate(names):
            pins[n] = ((x0 + 0.1 * i) * 25.4, y * 25.4)
    return pins


def fit_uno():
    t = UNO[2]
    pcb = uno_part(0, 0, UNO[0], UNO[1], -t, 0)
    for bx, by in UNO_HOLES:
        x, y = uno_xy(bx, by)
        pcb = pcb - cyl(UNO_HOLE_D, 40, (x, y, 0), 20)
    parts = Manifold()
    u = UNO_USB
    parts += uno_part(-u["over"], u["y"] - u["w"] / 2, u["l"] - u["over"], u["y"] + u["w"] / 2, 0, u["h"])
    j = UNO_JACK
    parts += uno_part(-j["over"], j["y"] - j["w"] / 2, j["l"] - j["over"], j["y"] + j["w"] / 2, 0, j["h"])
    for x0, y, names in UNO_HEADERS:
        a, b = (x0 - 0.05) * 25.4, (x0 + 0.1 * (len(names) - 1) + 0.05) * 25.4
        parts += uno_part(a, y * 25.4 - 1.27, b, y * 25.4 + 1.27, 0, UNO_HEADER_H)
        parts += uno_part(a, y * 25.4 - 1.27, b, y * 25.4 + 1.27, -t - UNO_STUBS, -t)
    for x0, y0, x1, y1, h in UNO_TALL:
        parts += uno_part(x0, y0, x1, y1, 0, h)
    for bx, by in UNO_HOLES:                   # m3 pan heads
        x, y = uno_xy(bx, by)
        parts += cyl(5.6, 2.2, (x, y, FLOOR + UNO_STANDOFF + t), 24)
    housings, keep = Manifold(), Manifold()
    pins = uno_pins()
    for n in UNO_USED:
        bx, by = pins[n]
        housings += uno_part(bx - 1.27, by - 1.27, bx + 1.27, by + 1.27, UNO_HEADER_H, UNO_HEADER_H + DUPONT[1])
        keep += uno_part(bx - 1.27, by - 1.27, bx + 1.27, by + 1.27, UNO_HEADER_H + DUPONT[1], UNO_HEADER_H + DUPONT[1] + WIRE_KEEP)
    return {"mount": pcb, "free": parts + housings, "keep": keep}


def fit_breadboard():
    zb = FLOOR - BB_POCKET
    body = box(BB_CX - BB[0] / 2, BB_CY - BB[1] / 2, zb, BB_CX + BB[0] / 2, BB_CY + BB[1] / 2, zb + BB[2])
    holes = ["j2", "j3", "j4", "j5", "f2", "g3", "h4", "i5", "a24", "e28"]
    pts = [(bb_col(int(h[1:])), bb_row(h[0])) for h in holes]
    pts += [(bb_col(28.5), BB_RAIL_IN), (bb_col(3.5), BB_RAIL_IN)]           # lower inner rail, gnd
    housings, keep = Manifold(), Manifold()
    for cx, cz in pts:
        x, y, z = bb_point(cx, cz)
        housings += box(x - 1.27, y - 1.27, z, x + 1.27, y + 1.27, z + DUPONT[1])
        keep += box(x - 1.27, y - 1.27, z + DUPONT[1], x + 1.27, y + 1.27, z + DUPONT[1] + WIRE_KEEP)
    x, y, z = bb_point(bb_col(24), bb_row("e"))
    resistor = cyl(RESISTOR[0], RESISTOR[1] + 1.5, (x, y, z + 1.0), 16) + box(x - 0.4, y - 0.4, z, x + 3.0, y + 0.4, z + RESISTOR[1] + 3.2)
    return {"mount": body, "free": housings + resistor, "keep": keep}


def fit_buzzer():
    """ky-006 upright in c26..c28, the can facing row a (the back)."""
    x, y, z = bb_point(bb_col(27), bb_row("c"))
    hdr = box(x - 3 * 1.27, y - 1.27, z, x + 3 * 1.27, y + 1.27, z + PITCH)
    pcb = box(x - BUZ_PCB[0] / 2, y - 1.27 - BUZ_PCB[2], z, x + BUZ_PCB[0] / 2, y - 1.27, z + BUZ_PCB[1])
    can = Manifold.cylinder(BUZ_CAN[1], BUZ_CAN[0] / 2, BUZ_CAN[0] / 2, 48).rotate((-90, 0, 0)).translate((x, y - 1.27 + 0.15, z + BUZ_CAN[2]))
    return {"mount": Manifold(), "free": hdr + pcb + can, "keep": Manifold()}


def fit_oled():
    """in lid coordinates around the pcb centre, then placed. local v grows toward the header."""
    pw, ph, pt = OLED_PCB
    v_of = lambda y: ph / 2 - y
    top = -LID
    pcb = box(-pw / 2, -ph / 2, top - pt, pw / 2, ph / 2, top)
    for sx in (-1, 1):
        for sy in (OLED_HOLE_IN, ph - OLED_HOLE_IN):
            pcb = pcb - cyl(2.0, 20, (sx * (pw / 2 - OLED_HOLE_IN), v_of(sy), -10), 16)
    g0, g1 = v_of(OLED_GLASS_TOP + OLED_GLASS[1]), v_of(OLED_GLASS_TOP)
    parts = box(-OLED_GLASS[0] / 2, g0, top, OLED_GLASS[0] / 2, g1, top + OLED_STACK)          # panel on its foam tape
    pv = v_of(OLED_PIN_Y)
    hw = 2 * PITCH
    parts += box(-hw, pv - 1.27, top, hw, pv + 1.27, top + OLED_PIN_UP)                      # pin ends + solder
    parts += box(-hw, pv - 1.27, top - pt - OLED_PIN_BODY, hw, pv + 1.27, top - pt)           # header body
    parts += box(-pw / 2 + 4, v_of(26.0), top - pt - OLED_BACK_PARTS, pw / 2 - 4, v_of(6.5), top - pt)   # back parts
    hb = top - pt - OLED_PIN_BODY
    hl = max(DUPONT[1], OLED_PIN_DOWN)                                                    # female housings over the pins
    housings = box(-hw, pv - 1.27, hb - hl, hw, pv + 1.27, hb)
    keep = box(-hw, pv - 1.27, hb - hl - WIRE_KEEP, hw, pv + 1.27, hb - hl)
    put = lambda m: on_lid(m, COL_L, OLED_V)
    return {"mount": put(pcb), "free": put(parts + housings), "keep": put(keep)}


def fit_rc522():
    L, Wd, t = RC522_PCB[1], RC522_PCB[0], RC522_PCB[2]
    top = -LID
    pcb = box(-L / 2, -Wd / 2, top - t, L / 2, Wd / 2, top)
    for hx, hy in RC522_HOLES:
        pu, pv = rc522_frame_local(hx, hy)
        pcb = pcb - cyl(RC522_HOLE_D, 20, (pu, pv, -10), 20)
    z0, z1 = RC522_PARTS_ZONE
    a, _ = rc522_frame_local(0, z1)
    b, _ = rc522_frame_local(0, z0)
    parts = box(a, -Wd / 2 + 2, top - t - RC522_PARTS, b, Wd / 2 - 2, top - t)                # chip, crystal, passives
    su, _ = rc522_frame_local(0, RC522_PIN_ROW)
    hw = 4 * PITCH
    parts += box(su - 1.2, -hw, top, su + 1.2, hw, top + RC522_STUB)                          # pin ends through the back
    ra = RC522_RA
    e0, _ = rc522_frame_local(0, ra["body_from"])
    e1, _ = rc522_frame_local(0, ra["body_from"] + ra["body"])
    zc = top - t - ra["axis"]
    parts += box(e1, -hw, zc - 1.27, e0, hw, zc + 1.27)                                       # 90 degree header body
    housings = box(e1 - 0.2 - DUPONT[1], -hw, zc - 1.27, e1 - 0.2, hw, zc + 1.27)
    keep = box(e1 - 0.2 - DUPONT[1] - WIRE_KEEP, -hw, zc - 1.27 - 2.0, e1 - 0.2 - DUPONT[1], hw, zc + 1.27)
    put = lambda m: on_lid(m, RC522_U, ROW_FRONT)
    return {"mount": put(pcb), "free": put(parts + housings), "keep": put(keep)}


def fit_keypad():
    """membrane in the recess, the tail down through the slot."""
    w, h, t = KEYPAD
    membrane = lid_prism(crect(w, h, KEYPAD_R, SEG), -KEYPAD_DEPTH, -KEYPAD_DEPTH + t)
    sv = keypad_slot_centre() - ROW_FRONT
    tw = KEYPAD_TAIL_W / 2
    tail = box(-tw, sv - 0.2, -KEYPAD_DEPTH + 0.05, tw, -h / 2 + 0.01, -KEYPAD_DEPTH + 0.35)   # leaving the bottom edge
    tail += box(-tw, sv - 0.2, -LID - 12.0, tw, sv + 0.2, -KEYPAD_DEPTH + 0.35)              # down through the slot
    put = lambda m: on_lid(m, COL_L, ROW_FRONT)
    return {"mount": put(membrane), "free": put(tail), "keep": Manifold()}


def fit_parts():
    return {"uno": fit_uno(), "breadboard": fit_breadboard(), "buzzer": fit_buzzer(),
            "oled": fit_oled(), "rc522": fit_rc522(), "keypad": fit_keypad()}


def fit_check(base, lid, parts):
    """every dummy against the body and the lid, then against each other.
    mount: the board or body that rests on the case (contact allowed, no overlap),
    free: components, headers and dupont housings, keep: room for the wires to bend.
    an overlap above FIT_TOL mm3 is a collision. returns (report, ok)."""
    report, ok = {}, True
    print(f"\nfit check, minimum clearance to body and lid in mm (search {FIT_SEARCH:g})")
    print(f"  {'part':10} {'board/body':>12} {'parts':>10} {'wire bends':>11}")
    for name, p in parts.items():
        row = {}
        for kind in ("mount", "free", "keep"):
            solid = p[kind]
            if solid.is_empty():
                continue
            vol = max((solid ^ base).volume(), (solid ^ lid).volume())
            gap = min(solid.min_gap(base, FIT_SEARCH), solid.min_gap(lid, FIT_SEARCH))
            row[kind] = {"overlap_mm3": round(vol, 4), "clearance_mm": round(gap, 2)}
            if vol > FIT_TOL:
                ok = False
        report[name] = row
        cells = []
        for kind, width in (("mount", 12), ("free", 10), ("keep", 11)):
            c = row.get(kind)
            cell = "-" if c is None else ("COLLISION" if c["overlap_mm3"] > FIT_TOL else
                                          ("rests" if kind == "mount" and c["clearance_mm"] < 0.01 else f"{c['clearance_mm']:.2f}"))
            cells.append(cell.rjust(width))
        print(f"  {name:10} {' '.join(cells)}")
    names = list(parts)
    pairs = {}
    for i, a in enumerate(names):
        for b in names[i + 1:]:
            if {a, b} == {"buzzer", "breadboard"}:
                continue               # the buzzer stands in the breadboard by design
            sa = parts[a]["mount"] + parts[a]["free"] + parts[a]["keep"]
            sb = parts[b]["mount"] + parts[b]["free"] + parts[b]["keep"]
            vol = (sa ^ sb).volume()
            pairs[f"{a}/{b}"] = {"overlap_mm3": round(vol, 4), "clearance_mm": round(sa.min_gap(sb, FIT_SEARCH), 2)}
            if vol > FIT_TOL:
                ok = False
                print(f"  COLLISION {a} / {b}: {vol:.2f} mm3")
    close = sorted(pairs.items(), key=lambda kv: kv[1]["clearance_mm"])[:4]
    print("  closest part pairs, wire room included: " + ", ".join(f"{k} {v['clearance_mm']:.2f}" for k, v in close))
    free = min(r["free"]["clearance_mm"] for r in report.values() if "free" in r)
    wires = min(r["keep"]["clearance_mm"] for r in report.values() if "keep" in r)
    slot_ok = SLOT[0] >= KEYPAD_CONN[0] + 0.8 and SLOT[1] >= KEYPAD_CONN[1] + 0.8
    if not slot_ok:
        ok = False
    print(f"  smallest clearance: parts {free:.2f}, wire bends {wires:.2f}")
    print(f"  ribbon slot {SLOT[0]:g} x {SLOT[1]:g} passes the {KEYPAD_CONN[0]:g} x {KEYPAD_CONN[1]:g} connector: {'yes' if slot_ok else 'NO'}")
    report["pairs"] = pairs
    report["min_clearance_parts_mm"] = free
    report["min_clearance_wires_mm"] = wires
    report["slot_passes_connector"] = slot_ok
    report["ok"] = ok
    print("  result:", "ok, no collisions" if ok else "COLLISION")
    return report, ok


def print_orientation(lid):
    """lid flipped face down for printing. also returns the shift that was applied, so lid.stl
    can be put back in place: undo the shift, rotate 180 then SLOPE about x."""
    flat = lid.rotate((-SLOPE, 0, 0)).rotate((180, 0, 0))
    bb = flat.bounding_box()
    return flat.translate((-bb[0], -bb[1], -bb[2])), [round(float(v), 3) for v in bb[:3]]


# ================================================================== viewer data
def mesh_world(part):
    """manifold or (vertices, triangles) in case coordinates to world positions and indices."""
    v, t = part if isinstance(part, tuple) else tidy_mesh(part)
    world = np.column_stack([v[:, 0] - W / 2, v[:, 2], D / 2 - v[:, 1]])
    return world, t


def pack_mesh(part):
    """quantised mesh for case_geo.js: world = int16 * scale + offset per axis."""
    pos, tri = mesh_world(part)
    lo, hi = pos.min(axis=0), pos.max(axis=0)
    offset = (lo + hi) / 2
    scale = np.maximum((hi - lo) / 65534.0, 1e-9)
    q = np.clip(np.round((pos - offset) / scale), -32767, 32767).astype("<i2")
    idx32 = len(pos) > 65535
    idx = tri.astype("<u4" if idx32 else "<u2")
    err = float(np.abs(q * scale + offset - pos).max())
    return {
        "pos": base64.b64encode(q.tobytes()).decode("ascii"),
        "idx": base64.b64encode(idx.tobytes()).decode("ascii"),
        "idx32": idx32,
        "scale": [float(f"{s:.9g}") for s in scale],
        "offset": [round(float(o), 6) for o in offset],
        "vertices": int(len(pos)), "triangles": int(len(tri)), "max_error_mm": round(err, 5),
    }


def lid_features():
    """world coordinate anchors the viewer needs besides the meshes."""
    sv = keypad_slot_centre()
    usb_x, _ = uno_xy(0.0, UNO_USB["y"])
    jack_x, _ = uno_xy(0.0, UNO_JACK["y"])
    z_top = FLOOR + UNO_STANDOFF + UNO[2]
    return {
        "lid": {"origin": to_world(lid_point(0, 0)), "u": dir_world(LID_U), "v": dir_world(LID_V), "n": dir_world(LID_N),
                "length": round(L_LID, 3), "thickness": LID, "frame": "u from the left edge, v up the slope from the front edge, n out of the top"},
        "tapZone": {"origin": to_world(lid_point(COL_R, ROW_FRONT)), "radius": TAP_RING_D / 2, "n": dir_world(LID_N),
                    "uv": [round(COL_R, 3), round(ROW_FRONT, 3)]},
        "keypadSlot": {"origin": to_world(lid_point(COL_L, sv)), "size": [SLOT[0], SLOT[1]],
                       "under": to_world(lid_point(COL_L, sv, -LID)), "uv": [round(COL_L, 3), round(sv, 3)],
                       "u": dir_world(LID_U), "v": dir_world(LID_V), "n": dir_world(LID_N)},
        "oledWindow": {"origin": to_world(lid_point(COL_L, ROW_BACK)), "size": [round(WINDOW[0], 3), round(WINDOW[1], 3)],
                       "top": [round(WINDOW_TOP[0], 3), round(WINDOW_TOP[1], 3)], "chamfer": round(WINDOW_CHAMFER, 3),
                       "glassDepth": round(LID_OVER_GLASS, 3), "uv": [round(COL_L, 3), round(ROW_BACK, 3)]},
        "keypadRecess": {"origin": to_world(lid_point(COL_L, ROW_FRONT)), "size": [round(KEYPAD_REC[0], 3), round(KEYPAD_REC[1], 3)],
                         "depth": KEYPAD_DEPTH, "uv": [round(COL_L, 3), round(ROW_FRONT, 3)]},
        "grille": {"origin": to_world(lid_point(COL_R, V_GRILLE)), "radius": round(GRILLE_RINGS[-1][0] + GRILLE_HOLE / 2, 3),
                   "holes": sum(n for _, n in GRILLE_RINGS), "hole": GRILLE_HOLE, "uv": [round(COL_R, 3), round(V_GRILLE, 3)]},
        "usb": {"origin": to_world((usb_x, D, z_top + UNO_USB["h"] / 2)), "dir": [0.0, 0.0, -1.0], "size": [USB_OPEN[0], USB_OPEN[1]]},
        "jack": {"origin": to_world((jack_x, D, z_top + UNO_JACK["hole_z"])), "dir": [0.0, 0.0, -1.0], "size": [JACK_OPEN_D, JACK_OPEN_D]},
        "screws": [to_world(lid_point(x, y / COS)) for x, y in BOSSES],
        "feet": [to_world((x, y, 0)) for x, y in ((FEET_IN, FEET_IN), (W - FEET_IN, FEET_IN), (FEET_IN, D - FEET_IN), (W - FEET_IN, D - FEET_IN))],
        "ground": 0.0,
    }


def parts_summary():
    """where every part sits, in case coordinates (x, y on the floor) or lid coordinates (u, v)."""
    ux, uy = uno_xy(UNO[0] / 2, UNO[1] / 2)
    usb_x, _ = uno_xy(0, UNO_USB["y"])
    return {
        "uno": {"pcb_centre_xy": [round(ux, 2), round(uy, 2)], "pcb_bottom_z": FLOOR + UNO_STANDOFF,
                "orientation": "usb-b edge against the back wall, digital header toward the breadboard", "usb_b_x": round(usb_x, 2)},
        "breadboard": {"centre_xy": [round(BB_CX, 2), round(BB_CY, 2)], "bottom_z": FLOOR - BB_POCKET,
                       "orientation": "column 1 on the left, rows a-e toward the back"},
        "buzzer": {"holes": "c26 c27 c28, upright, can toward row a, under the grille"},
        "resistor": {"holes": "e24 e26, upright"},
        "oled": {"pcb_centre_uv": [round(COL_L, 2), round(OLED_V, 2)], "active_area_centre_uv": [round(COL_L, 2), round(ROW_BACK, 2)],
                 "orientation": "glass up, header toward the back"},
        "keypad": {"centre_uv": [round(COL_L, 2), round(ROW_FRONT, 2)], "orientation": "legends readable from the front, tail to the front"},
        "rc522": {"pcb_centre_uv": [round(RC522_U, 2), round(ROW_FRONT, 2)], "antenna_centre_uv": [round(COL_R, 2), round(ROW_FRONT, 2)],
                  "orientation": "component side down, 90 degree header toward the case centre"},
    }


def compact_json(obj, indent=0):
    """json with an indent per object level, short lists kept on one line."""
    pad, inner = "  " * indent, "  " * (indent + 1)
    if isinstance(obj, dict):
        if not obj:
            return "{}"
        items = [f"{inner}{json.dumps(k)}: {compact_json(v, indent + 1)}" for k, v in obj.items()]
        return "{\n" + ",\n".join(items) + "\n" + pad + "}"
    if isinstance(obj, (list, tuple)):
        flat = json.dumps(obj)
        if len(flat) <= 96 and not any(isinstance(v, dict) for v in obj):
            return flat
        return "[\n" + ",\n".join(inner + compact_json(v, indent + 1) for v in obj) + "\n" + pad + "]"
    return json.dumps(obj)


def write_viewer_data(base, lid, dims, report):
    data = {"version": 11, "generator": "case/make_case.py", "units": "mm",
            "dims": {"W": W, "D": D, "H_FRONT": H_FRONT, "H_BACK": round(H_FRONT + D * TAN, 3), "SLOPE": SLOPE,
                     "LID": LID, "WALL": WALL, "FLOOR": FLOOR, "R": R, "EDGE_R": EDGE_R, "CLEAR": CLEAR,
                     "Z_LID": round(Z_LID, 4), "L_LID": round(L_LID, 3), "COL_L": round(COL_L, 3), "COL_R": round(COL_R, 3),
                     "ROW_FRONT": round(ROW_FRONT, 3), "ROW_BACK": round(ROW_BACK, 3), "MARGIN": MARGIN,
                     "UNO_STANDOFF": UNO_STANDOFF, "BB_POCKET": BB_POCKET, "KEYPAD_DEPTH": KEYPAD_DEPTH,
                     "RC522_THIN": RC522_THIN, "SCREW": "m3 x 12 countersunk"}}
    data.update(lid_features())
    data["place"] = placements()
    data["meshes"] = {"base": pack_mesh(base), "lid": pack_mesh(lid)}
    data["stats"] = dims["stats"]
    data["fit"] = {k: v for k, v in report.items() if k not in ("pairs",)}
    text = ("/* Mini Casino V11 case geometry, generated by case/make_case.py. Do not edit.\n"
            "   World coordinates in mm (three.js: X right, Y up, front = +Z), assembled position.\n"
            "   Positions are Int16: world = q * scale + offset per axis. Indices Uint16 or Uint32 (idx32). */\n"
            "window.MC_CASE = " + json.dumps(data, separators=(",", ":")) + ";\n")
    VIEWER_DATA.parent.mkdir(parents=True, exist_ok=True)
    VIEWER_DATA.write_text(text, encoding="utf-8")
    return len(text.encode("utf-8")), data


# ================================================================== drawing
# ---------------------------------------------------------------- design tokens (same values as js/core.js MC.tokens)
TOKENS = {
    "font": "Inter, ui-sans-serif, system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif",
    "mono": "'JetBrains Mono', ui-monospace, 'Cascadia Code', Consolas, monospace",
    "radius": 18,
    "light": {"bg": "#F5F6F8", "surface": "#FFFFFF", "surface2": "#F3F5F8", "surface3": "#E7EAEF",
              "line": "rgba(15,17,21,0.08)", "line2": "rgba(15,17,21,0.14)", "ink": "#0F1115", "ink2": "#3A4250",
              "muted": "#6B7480", "accent": "#0E9F6E", "info": "#2F6FEB", "warn": "#B7791F"},
    "dark": {"bg": "#0B0D10", "surface": "#14181E", "surface2": "#1B2027", "surface3": "#232932",
             "line": "rgba(255,255,255,0.08)", "line2": "rgba(255,255,255,0.14)", "ink": "#E9ECF1", "ink2": "#B4BCC8",
             "muted": "#7D8794", "accent": "#3DD68C", "info": "#5B9DFF", "warn": "#F5A524"},
}


def _fmt(v):
    s = f"{v:.1f}"
    return s[:-2] if s.endswith(".0") else s


class Drawing:
    """tiny svg builder for the technical drawing: numbers in, crisp elements out."""

    def __init__(self):
        self.el = []

    def add(self, s):
        self.el.append(s)

    def line(self, x1, y1, x2, y2, cls):
        self.add(f'<line x1="{x1:.2f}" y1="{y1:.2f}" x2="{x2:.2f}" y2="{y2:.2f}" class="{cls}"/>')

    def path(self, d, cls, extra=""):
        self.add(f'<path d="{d}" class="{cls}"{extra}/>')

    def rect(self, x, y, w, h, rx, cls, ry=None):
        ry = rx if ry is None else ry
        self.add(f'<rect x="{x:.2f}" y="{y:.2f}" width="{w:.2f}" height="{h:.2f}" rx="{rx:.2f}" ry="{ry:.2f}" class="{cls}"/>')

    def circle(self, x, y, r, cls):
        self.add(f'<circle cx="{x:.2f}" cy="{y:.2f}" r="{r:.2f}" class="{cls}"/>')

    def text(self, x, y, s, cls, anchor="start", rot=None):
        tr = f' transform="rotate({rot} {x:.2f} {y:.2f})"' if rot else ""
        self.add(f'<text x="{x:.2f}" y="{y:.2f}" class="{cls}" text-anchor="{anchor}"{tr}>{s}</text>')

    def arrow(self, x, y, dx, dy):
        """filled arrow head with its tip at x, y pointing along (dx, dy)."""
        n = math.hypot(dx, dy) or 1.0
        dx, dy = dx / n, dy / n
        L, Wd = 7.0, 2.3
        bx, by = x - dx * L, y - dy * L
        self.path(f"M{x:.2f},{y:.2f} L{bx - dy * Wd:.2f},{by + dx * Wd:.2f} L{bx + dy * Wd:.2f},{by - dx * Wd:.2f} Z", "arr")

    def dim_h(self, x1, x2, y, label, y_ext=None, above=True):
        """horizontal dimension between x1 and x2 on the line y; extension lines from y_ext."""
        if y_ext is not None:
            for x in (x1, x2):
                self.line(x, y_ext + (3 if y > y_ext else -3), x, y + (5 if y > y_ext else -5), "ext")
        self.line(x1, y, x2, y, "dim")
        if x2 - x1 > 18:
            self.arrow(x1, y, -1, 0)
            self.arrow(x2, y, 1, 0)
        else:
            self.arrow(x1, y, 1, 0)
            self.arrow(x2, y, -1, 0)
        self.text((x1 + x2) / 2, y - 6 if above else y + 15, label, "dt", "middle")

    def dim_v(self, x, y1, y2, label, x_ext=None, left=True):
        if x_ext is not None:
            for y in (y1, y2):
                self.line(x_ext + (3 if x > x_ext else -3), y, x + (5 if x > x_ext else -5), y, "ext")
        self.line(x, y1, x, y2, "dim")
        self.arrow(x, min(y1, y2), 0, -1)
        self.arrow(x, max(y1, y2), 0, 1)
        tx = x - 7 if left else x + 15
        self.text(tx, (y1 + y2) / 2, label, "dt", "middle", rot=-90)

    def balloon(self, x, y, n, tx, ty):
        """item number in a circle at x, y with a leader to the feature at tx, ty."""
        d = math.hypot(tx - x, ty - y) or 1.0
        self.line(x + (tx - x) / d * 10, y + (ty - y) / d * 10, tx, ty, "leader")
        self.circle(tx, ty, 1.8, "dot")
        self.circle(x, y, 10, "ball")
        self.text(x, y + 4.2, str(n), "bt", "middle")


def _polys(cs):
    return [[(float(a), float(b)) for a, b in poly] for poly in cs.to_polygons()]


def _section(man, x):
    """polygons of the cut at case x = const, as (y, z)."""
    t = man.transform([[0, 1, 0, 0], [0, 0, 1, 0], [1, 0, 0, 0]])
    return _polys(t.slice(x))


def write_layout_svg(path, base, lid, parts):
    """dimensioned lid top view and two sections, design tokens from js/core.js, light and dark."""
    t = TOKENS
    VW, VH = 1720, 1150
    d = Drawing()

    # ------------------------------------------------ top view, true shape of the lid (u across, v up the slope)
    s = 3.5
    X0, Y0 = 232.0, 214.0
    X = lambda u: X0 + u * s
    Y = lambda v: Y0 + (L_LID - v) * s
    d.add('<g id="top">')
    d.rect(X(0), Y(L_LID), W * s, L_LID * s, R * s, "part", R / COS * s)
    d.rect(X(EDGE_R), Y(L_LID - EDGE_R / COS), (W - 2 * EDGE_R) * s, (L_LID - 2 * EDGE_R / COS) * s, (R - EDGE_R) * s, "tangent", (R - EDGE_R) / COS * s)
    # centre lines of the grid: keypad + oled axis, tap + grille axis, front and back row
    for u in (COL_L, COL_R):
        d.line(X(u), Y(L_LID - 4), X(u), Y(4), "axis")
    for v in (ROW_FRONT, ROW_BACK):
        d.line(X(4), Y(v), X(W - 4), Y(v), "axis")
    # keypad recess, key field, ribbon slot
    kw, kh = KEYPAD_REC
    d.rect(X(COL_L - kw / 2), Y(ROW_FRONT + kh / 2), kw * s, kh * s, KEYPAD_REC_R * s, "feat")
    rows = ["123A", "456B", "789C", "*0#D"]
    for r_, row in enumerate(rows):
        for c, ch in enumerate(row):
            cx, cz = (c - 1.5) * 16.6, (r_ - 1.5) * 17.4
            d.rect(X(COL_L + cx - 6.5), Y(ROW_FRONT - cz + 6.5), 13 * s, 13 * s, 1.7 * s, "key")
            d.text(X(COL_L + cx), Y(ROW_FRONT - cz) + 5, ch, "kt", "middle")
    sv = keypad_slot_centre()
    d.rect(X(COL_L - SLOT[0] / 2), Y(sv + SLOT[1] / 2), SLOT[0] * s, SLOT[1] * s, SLOT[2] * s, "through")
    # oled: window at the panel, chamfer edge at the top, module and panel under the lid
    pw, ph = OLED_PCB[0], OLED_PCB[1]
    d.rect(X(COL_L - pw / 2), Y(OLED_V + ph / 2), pw * s, ph * s, 0.6 * s, "hidden")
    gv = OLED_V + ph / 2 - (OLED_GLASS_TOP + OLED_GLASS[1] / 2)
    d.rect(X(COL_L - OLED_GLASS[0] / 2), Y(gv + OLED_GLASS[1] / 2), OLED_GLASS[0] * s, OLED_GLASS[1] * s, 0.4 * s, "hidden")
    d.rect(X(COL_L - WINDOW_TOP[0] / 2), Y(ROW_BACK + WINDOW_TOP[1] / 2), WINDOW_TOP[0] * s, WINDOW_TOP[1] * s, (WINDOW_R + WINDOW_CHAMFER) * s, "feat")
    d.rect(X(COL_L - WINDOW[0] / 2), Y(ROW_BACK + WINDOW[1] / 2), WINDOW[0] * s, WINDOW[1] * s, WINDOW_R * s, "glass")
    d.text(X(COL_L), Y(ROW_BACK) + 4, "128 × 64", "gt", "middle")
    # rc522 under the tap zone: board outline, thinned zone over the coil
    rl, rw = RC522_PCB[1], RC522_PCB[0]
    d.rect(X(RC522_U - rl / 2), Y(ROW_FRONT + rw / 2), rl * s, rw * s, 0.6 * s, "hidden")
    x0, y0, x1, y1, rr = RC522_COIL
    pu0, pv0 = rc522_frame_local(x0, y1)
    pu1, pv1 = rc522_frame_local(x1, y0)
    cu, cv = RC522_U + (pu0 + pu1) / 2, ROW_FRONT + (pv0 + pv1) / 2
    aw, ah = abs(pu1 - pu0) + 1.0, abs(pv1 - pv0) + 1.0
    d.rect(X(cu - aw / 2), Y(cv + ah / 2), aw * s, ah * s, (rr + 0.5) * s, "thin")
    # tap ring and contactless symbol, as engraved
    d.circle(X(COL_R), Y(ROW_FRONT), TAP_RING_D / 2 * s, "engrave")
    sym = tap_symbol()
    b = sym.bounds()
    off = -(b[0] + b[2]) / 2
    for rr_ in TAP_ARCS:
        a = math.radians(TAP_ARC_SPAN)
        cx0 = COL_R + off
        p0 = (X(cx0 + rr_ * math.cos(-a)), Y(ROW_FRONT + rr_ * math.sin(-a)))
        p1 = (X(cx0 + rr_ * math.cos(a)), Y(ROW_FRONT + rr_ * math.sin(a)))
        d.path(f"M{p0[0]:.2f},{p0[1]:.2f} A{rr_ * s:.2f},{rr_ * s:.2f} 0 0 0 {p1[0]:.2f},{p1[1]:.2f}", "sym", f' stroke-width="{TAP_ARC_W * s:.2f}"')
    # grille
    for gx, gy in grille_holes():
        d.circle(X(COL_R + gx), Y(V_GRILLE + gy), GRILLE_HOLE / 2 * s, "hole")
    # countersunk screws
    for bx, by in BOSSES:
        d.circle(X(bx), Y(by / COS), CSK_D / 2 * s, "csk")
        d.circle(X(bx), Y(by / COS), SCREW_D / 2 * s, "hole")
    # engraved wordmark, the same strokes the model uses
    if WORDMARK:
        wv = wordmark_v()
        strokes, dots = wordmark_lines(WORDMARK, WORDMARK_X)
        for line in strokes:
            pts = " ".join(f"{X(W / 2 + x):.2f},{Y(wv + y):.2f}" for x, y in line)
            d.add(f'<polyline points="{pts}" class="word" stroke-width="{WORDMARK_STROKE * s:.2f}"/>')
        for x, y in dots:
            d.circle(X(W / 2 + x), Y(wv + y), WORDMARK_STROKE * 0.62 * s, "wdot")
    d.add("</g>")

    # dimensions of the top view
    d.dim_h(X(0), X(W), Y(0) + 46, _fmt(W), y_ext=Y(0), above=False)
    yt = Y(L_LID) - 30
    d.dim_h(X(0), X(COL_L), yt, _fmt(COL_L), y_ext=Y(L_LID))
    d.dim_h(X(COL_L), X(COL_R), yt, _fmt(COL_R - COL_L))
    d.dim_h(X(COL_R), X(W), yt, _fmt(W - COL_R), y_ext=Y(L_LID))
    d.line(X(COL_L), yt - 4, X(COL_L), Y(L_LID) - 3, "ext")
    d.line(X(COL_R), yt - 4, X(COL_R), Y(L_LID) - 3, "ext")
    d.dim_v(X(0) - 44, Y(0), Y(L_LID), _fmt(L_LID) + " on the slope", x_ext=X(0))
    xr = X(W) + 34
    d.dim_v(xr, Y(0), Y(ROW_FRONT), _fmt(ROW_FRONT), x_ext=X(W), left=False)
    d.dim_v(xr, Y(ROW_FRONT), Y(ROW_BACK), _fmt(ROW_BACK - ROW_FRONT), left=False)
    d.dim_v(xr, Y(ROW_BACK), Y(L_LID), _fmt(L_LID - ROW_BACK), x_ext=X(W), left=False)
    for v in (ROW_FRONT, ROW_BACK):
        d.line(X(W) + 3, Y(v), xr + 5, Y(v), "ext")
    d.dim_h(X(0), X(COL_L - kw / 2), Y(ROW_FRONT - 20), _fmt(MARGIN), y_ext=None)
    d.dim_v(X(COL_L - kw / 2) + 0, Y(0), Y(KEYPAD_V0), "", x_ext=None)
    d.text(X(COL_L - kw / 2) - 7, (Y(0) + Y(KEYPAD_V0)) / 2 + 4, _fmt(KEYPAD_V0), "dt", "end")

    # section indicators on the top view
    for u, letter in ((COL_L, "A"), (COL_R, "B")):
        for v_, sgn in ((L_LID + 7, -1), (-7, 1)):
            x_, y_ = X(u), Y(v_)
            d.line(x_, y_ - 8 * sgn, x_, y_ + 6 * sgn, "cutline")
            d.line(x_, y_, x_ + 16, y_, "cutline")
            d.arrow(x_ + 18, y_, 1, 0)
            d.text(x_ + 30, y_ + 5, letter, "cut", "middle")

    # balloons
    bl = [
        (1, X(COL_L - WINDOW_TOP[0] / 2 - 26), Y(ROW_BACK + 16), X(COL_L - WINDOW_TOP[0] / 2), Y(ROW_BACK + 4)),
        (2, X(COL_L - kw / 2 - 30) + 0, Y(ROW_FRONT + 22), X(COL_L - kw / 2), Y(ROW_FRONT + 22)),
        (3, X(COL_L - kw / 2 - 30), Y(sv - 2), X(COL_L - SLOT[0] / 2), Y(sv)),
        (4, X(COL_R + TAP_RING_D / 2 + 16), Y(ROW_FRONT + 26), X(COL_R + TAP_RING_D / 2 * 0.72), Y(ROW_FRONT + TAP_RING_D / 2 * 0.69)),
        (5, X(COL_R + TAP_RING_D / 2 + 16), Y(ROW_FRONT - 22), X(RC522_U + rl / 2), Y(ROW_FRONT - 12)),
        (6, X(COL_R + 26), Y(V_GRILLE + 14), X(COL_R + 9.4), Y(V_GRILLE + 4.2)),
        (7, X(W - BOSS_IN - 16), Y(L_LID - BOSS_IN - 14), X(W - BOSS_IN - 2.3), Y((D - BOSS_IN) / COS - 2.3)),
        (8, X(W / 2 + 34), Y(L_LID - 4.5), X(W / 2 + 17.5), Y(L_LID - 10.4)),
    ]
    for n, bx, by, tx, ty in bl:
        d.balloon(bx, by, n, tx, ty)

    # ------------------------------------------------ sections A-A (keypad axis) and B-B (tap axis)
    s2 = 3.2
    SX0 = 1112.0
    for k, (xcut, letter, names) in enumerate(((COL_L, "A", ("uno", "oled", "keypad")), (COL_R, "B", ("breadboard", "buzzer", "rc522")))):
        base_y = 468.0 + k * 330.0
        SX = lambda y: SX0 + y * s2
        SY = lambda z: base_y - z * s2
        d.text(SX0, base_y - (H_FRONT + D * TAN) * s2 - 40, f"section {letter}–{letter}", "h2")
        d.text(SX0 + 128, base_y - (H_FRONT + D * TAN) * s2 - 40,
               "keypad and oled axis, front on the left" if letter == "A" else "tap zone and grille axis, front on the left", "sub")
        for name in names:
            p = parts[name]
            for poly in _section(p["mount"] + p["free"], xcut):
                dd = "M" + " L".join(f"{SX(a):.2f},{SY(b):.2f}" for a, b in poly) + " Z"
                d.path(dd, "pcut")
            if not p["keep"].is_empty():
                for poly in _section(p["keep"], xcut):
                    dd = "M" + " L".join(f"{SX(a):.2f},{SY(b):.2f}" for a, b in poly) + " Z"
                    d.path(dd, "keep")
        for man in (base, lid):
            for poly in _section(man, xcut):
                dd = "M" + " L".join(f"{SX(a):.2f},{SY(b):.2f}" for a, b in poly) + " Z"
                d.path(dd, "scut")
        d.line(SX(-12), SY(0), SX(D + 12), SY(0), "ground")
        if letter == "A":
            hb = H_FRONT + D * TAN
            d.dim_v(SX(0) - 26, SY(0), SY(H_FRONT), _fmt(H_FRONT), x_ext=SX(0))
            d.dim_v(SX(D) + 26, SY(0), SY(hb), _fmt(hb), x_ext=SX(D), left=False)
            d.dim_h(SX(0), SX(D), SY(0) + 34, _fmt(D), y_ext=SY(0), above=False)
            # slope angle at the back top edge, measured against a horizontal above the lid
            ax, ay, rad = SX(D), SY(hb), 92
            d.line(ax - rad - 22, ay, ax + 4, ay, "ext")
            a = math.radians(SLOPE)
            d.path(f"M{ax - rad:.2f},{ay:.2f} A{rad},{rad} 0 0 0 {ax - rad * math.cos(a):.2f},{ay + rad * math.sin(a):.2f}", "dimarc")
            d.text(ax - rad - 28, ay + 9, f"{SLOPE:g}°", "dt", "end")
            # callouts in the section
            usb_z = FLOOR + UNO_STANDOFF + UNO[2] + UNO_USB["h"] / 2
            d.balloon(SX(D) - 40, SY(usb_z) + 48, 9, SX(D - 1.2), SY(usb_z))
        else:
            d.balloon(SX(V_GRILLE * COS) + 34, SY(H_FRONT + V_GRILLE * SIN) - 28, 6, SX(V_GRILLE * COS), SY(H_FRONT + V_GRILLE * SIN) - 1)
            d.balloon(SX(ROW_FRONT * COS) - 36, SY(H_FRONT + ROW_FRONT * SIN) - 30, 4, SX(ROW_FRONT * COS) - 6, SY(H_FRONT + ROW_FRONT * SIN) - 1)
            d.text(SX(D / 2), SY(0) + 26, f"wall {_fmt(WALL)} · floor {_fmt(FLOOR)} · lid {_fmt(LID)}, {_fmt(RC522_THIN)} over the antenna", "sub", "middle")

    # ------------------------------------------------ legend
    items = [
        (1, "oled window", [f"{_fmt(WINDOW[0])} × {_fmt(WINDOW[1])} at the panel, 45° chamfer to {_fmt(WINDOW_TOP[0])} × {_fmt(WINDOW_TOP[1])}",
                            f"module flush under the lid: frame, 2 snap clips, 4 × m2 optional"]),
        (2, "keypad recess", [f"{_fmt(KEYPAD_REC[0])} × {_fmt(KEYPAD_REC[1])}, {_fmt(KEYPAD_DEPTH)} deep, corners r {_fmt(KEYPAD_REC_R)}",
                              "the 0.8 mm membrane ends flush with the lid"]),
        (3, "ribbon slot", [f"{_fmt(SLOT[0])} × {_fmt(SLOT[1])} through, half under the keypad edge",
                            f"passes the {_fmt(KEYPAD_CONN[0])} × {_fmt(KEYPAD_CONN[1])} 8 pin connector"]),
        (4, "tap zone", [f"ring ø{_fmt(TAP_RING_D)} and contactless mark, engraved {_fmt(ENGRAVE)}",
                         "centred over the rc522 antenna coil"]),
        (5, "rc522 pocket", [f"lid thinned to {_fmt(RC522_THIN)} over the coil, board flush underneath",
                             "4 pegs, 2 snap clips, 90° header toward the centre"]),
        (6, "buzzer grille", [f"{sum(n for _, n in GRILLE_RINGS)} × ø{_fmt(GRILLE_HOLE)} in four rings",
                              "right above the ky-006 in breadboard column 26–28"]),
        (7, "lid screws", ["4 × m3 × 12 countersunk into corner bosses",
                           f"pilot ø{_fmt(BOSS_HOLE)}, ø4.0 for heat set inserts"]),
        (8, "wordmark", [f"engraved {_fmt(WORDMARK_DEPTH)}, single line, x-height {_fmt(WORDMARK_X)}",
                         "prints crisp on the bed side"]),
        (9, "usb-b and dc jack", [f"through the back wall, {_fmt(USB_OPEN[0])} × {_fmt(USB_OPEN[1])} and ø{_fmt(JACK_OPEN_D)}",
                                  "with a 0.6 chamfer outside"]),
    ]
    lx, ly = 72.0, 924.0
    colw = 548.0
    for i, (n, title, desc) in enumerate(items):
        cx_, cy_ = lx + (i % 3) * colw, ly + (i // 3) * 66
        d.circle(cx_ + 10, cy_ - 5, 10, "ball")
        d.text(cx_ + 10, cy_ - 0.8, str(n), "bt", "middle")
        d.text(cx_ + 30, cy_ - 1, title, "lt")
        for j, line in enumerate(desc):
            d.text(cx_ + 30, cy_ + 17 + j * 16, line, "ld")
    d.line(72, ly - 38, VW - 72, ly - 38, "ground")

    # line style key
    kx, ky = 72.0, VH - 38.0
    keys = [("feat", "edge"), ("hidden", "under the lid"), ("engrave", "engraved"), ("thin", "thinned from below")]
    for i, (cls, lab) in enumerate(keys):
        x_ = kx + i * 132
        d.line(x_, ky, x_ + 26, ky, cls + " key-sample")
        d.text(x_ + 34, ky + 4, lab, "ld")

    light, dark = t["light"], t["dark"]

    def css(c):
        return f"""
  .card{{fill:{c['surface']};stroke:{c['line2']};stroke-width:1}}
  .h1{{font:650 26px {t['font']};fill:{c['ink']};letter-spacing:-0.3px}}
  .h2{{font:600 17px {t['font']};fill:{c['ink']}}}
  .sub{{font:400 13px {t['font']};fill:{c['muted']}}}
  .dt{{font:500 12.5px {t['font']};fill:{c['ink2']};font-variant-numeric:tabular-nums}}
  .lt{{font:600 13.5px {t['font']};fill:{c['ink']}}}
  .ld{{font:400 12.5px {t['font']};fill:{c['muted']}}}
  .kt{{font:600 13px {t['font']};fill:{c['muted']}}}
  .gt{{font:500 10.5px {t['mono']};fill:{c['accent']}}}
  .bt{{font:650 12px {t['font']};fill:{c['surface']}}}
  .cut{{font:700 15px {t['font']};fill:{c['ink']}}}
  .part{{fill:{c['surface2']};stroke:{c['ink']};stroke-width:1.6}}
  .tangent{{fill:none;stroke:{c['line2']};stroke-width:0.8}}
  .axis{{stroke:{c['muted']};stroke-width:0.7;stroke-dasharray:14 3 2 3;fill:none;opacity:.8}}
  .feat{{fill:none;stroke:{c['ink']};stroke-width:1.2}}
  .key{{fill:none;stroke:{c['line2']};stroke-width:0.8}}
  .through{{fill:{c['ink']};stroke:{c['ink']};stroke-width:1}}
  .glass{{fill:#07090C;stroke:{c['ink']};stroke-width:1}}
  .hidden{{fill:none;stroke:{c['info']};stroke-width:1;stroke-dasharray:5 3}}
  .thin{{fill:none;stroke:{c['info']};stroke-width:1;stroke-dasharray:1.5 2.5}}
  .engrave{{fill:none;stroke:{c['accent']};stroke-width:{TAP_RING_W * 3.5:.2f}}}
  .sym{{fill:none;stroke:{c['accent']};stroke-linecap:round}}
  .word{{fill:none;stroke:{c['ink2']};stroke-linecap:round;stroke-linejoin:round}}
  .wdot{{fill:{c['ink2']}}}
  .hole{{fill:{c['ink']}}}
  .csk{{fill:{c['surface3']};stroke:{c['ink']};stroke-width:1}}
  .dim{{stroke:{c['ink2']};stroke-width:0.8}}
  .dimarc{{fill:none;stroke:{c['ink2']};stroke-width:0.8}}
  .ext{{stroke:{c['muted']};stroke-width:0.6}}
  .arr{{fill:{c['ink2']}}}
  .leader{{stroke:{c['ink2']};stroke-width:0.8}}
  .dot{{fill:{c['ink2']}}}
  .ball{{fill:{c['ink']}}}
  .cutline{{stroke:{c['ink']};stroke-width:2.2}}
  .scut{{fill:url(#hatch);stroke:{c['ink']};stroke-width:1.1;stroke-linejoin:round}}
  .hl{{stroke:{c['muted']};stroke-width:0.7}}
  .pcut{{fill:{c['surface3']};stroke:{c['info']};stroke-width:0.9;stroke-linejoin:round}}
  .keep{{fill:none;stroke:{c['warn']};stroke-width:0.8;stroke-dasharray:3 2}}
  .ground{{stroke:{c['line2']};stroke-width:1}}
  .key-sample{{stroke-width:1.6}}"""

    hb = H_FRONT + D * TAN
    body = "\n".join(d.el)
    svg = f"""<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {VW} {VH}" width="{VW}" height="{VH}" role="img" aria-labelledby="t d">
<title id="t">mini casino case V11, dimensioned drawing</title>
<desc id="d">lid top view with the oled window, keypad recess, ribbon slot, rfid tap zone, buzzer grille and screws, plus sections through both axes. all dimensions in mm.</desc>
<style>{css(light)}
  @media (prefers-color-scheme: dark) {{{css(dark)}
  }}
</style>
<defs>
  <pattern id="hatch" width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><rect width="6" height="6" class="card" style="stroke:none"/><line x1="0" y1="0" x2="0" y2="6" class="hl"/></pattern>
</defs>
<rect x="0.5" y="0.5" width="{VW - 1}" height="{VH - 1}" rx="{t['radius']}" class="card"/>
<text x="72" y="74" class="h1">printable case, V11</text>
<text x="72" y="100" class="sub">{_fmt(W)} × {_fmt(D)} × {_fmt(H_FRONT)}–{_fmt(hb)} mm, lid tilted {SLOPE:g}°. top view normal to the lid, all dimensions in mm. generated by case/make_case.py</text>
{body}
<text x="{VW - 72}" y="{VH - 34}" class="ld" text-anchor="end">pla or petg · 0.2 mm layers · no supports · the lid prints face down</text>
</svg>
"""
    path.write_text(svg, encoding="utf-8")


# ================================================================== main
def main():
    base = build_base()
    lid = build_lid()
    for name, part in (("base", base), ("lid", lid)):
        if part.is_empty() or part.genus() < 0:
            raise SystemExit(f"{name} is not a valid solid")
    assembly = Manifold.compose([base, lid])
    stats = {}
    lid_print, lid_shift = print_orientation(lid)
    base_mesh, lid_mesh = tidy_mesh(base), tidy_mesh(lid)
    for name, part, mesh in (("base", base, base_mesh), ("lid", lid_print, tidy_mesh(lid_print)), ("assembly", assembly, None)):
        tris = write_stl(mesh if mesh is not None else part, OUT / f"{name}.stl")
        stats[name] = {"triangles": tris, "bounds_mm": bounds(part), "volume_cm3": round(part.volume() / 1000, 1)}
        print(f"{name:9} {tris:7} tris  bounds {stats[name]['bounds_mm']}  volume {stats[name]['volume_cm3']} cm3")
    stats["mass_g_pla_estimate"] = round((base.volume() + lid.volume()) / 1000 * PLA_DENSITY * FILL_FACTOR)

    parts = fit_parts()
    fitdir = OUT / "fitcheck"
    for old in ("lcd", "leds", "buttons"):
        (fitdir / f"{old}.stl").unlink(missing_ok=True)
    for name, p in parts.items():
        write_stl(p["mount"] + p["free"], fitdir / f"{name}.stl")
    report, ok = fit_check(base, lid, parts)

    dims = {
        "version": 11,
        "outer_mm": [W, D, H_FRONT, round(H_FRONT + D * TAN, 1)],
        "slope_deg": SLOPE, "wall_mm": WALL, "floor_mm": FLOOR, "lid_mm": LID, "corner_radius_mm": R, "lid_edge_radius_mm": EDGE_R,
        "screws": {"count": len(BOSSES), "type": "m3 x 12 countersunk", "boss_hole_mm": BOSS_HOLE, "positions_xy": BOSSES},
        "lid_layout_uv": {"keypad_axis_u": round(COL_L, 2), "tap_axis_u": round(COL_R, 2), "front_row_v": round(ROW_FRONT, 2),
                          "back_row_v": round(ROW_BACK, 2), "margin": MARGIN, "lid_length_on_slope": round(L_LID, 2)},
        "oled_window": {"opening_mm": [round(WINDOW[0], 2), round(WINDOW[1], 2)], "at_top_mm": [round(WINDOW_TOP[0], 2), round(WINDOW_TOP[1], 2)],
                        "chamfer_45_mm": round(WINDOW_CHAMFER, 2), "lid_over_panel_mm": round(LID_OVER_GLASS, 2),
                        "active_area_mm": list(OLED_AA), "mount": "pcb flush under the lid, frame + 2 snap clips, 4 x m2 pilots d1.6 optional"},
        "keypad_recess": {"size_mm": [round(KEYPAD_REC[0], 2), round(KEYPAD_REC[1], 2)], "depth_mm": KEYPAD_DEPTH, "corner_radius_mm": KEYPAD_REC_R,
                          "ribbon_slot_mm": [SLOT[0], SLOT[1]], "slot_note": "straddles the front edge of the recess, passes the 8 pin connector"},
        "tap_zone": {"ring_d_mm": TAP_RING_D, "engrave_mm": ENGRAVE, "lid_over_antenna_mm": RC522_THIN,
                     "rc522": "component side down, back flush under the lid, frame + 2 clips + 4 pegs, 90 degree header toward the centre"},
        "grille": {"holes": sum(n for _, n in GRILLE_RINGS), "hole_d_mm": GRILLE_HOLE, "pattern_d_mm": round(2 * GRILLE_RINGS[-1][0] + GRILLE_HOLE, 1)},
        "back_wall": {"usb_b_opening_mm": [round(USB_OPEN[0], 2), round(USB_OPEN[1], 2)], "dc_jack_opening_d_mm": JACK_OPEN_D},
        "uno": {"standoffs_mm": UNO_STANDOFF, "screws": "4 x m3 x 6 self tapping"},
        "breadboard_pocket_mm": [round(BB[0] + 0.8, 2), round(BB[1] + 0.8, 2), BB_POCKET],
        "parts": parts_summary(),
        "feet": {"count": 4, "recess_d_mm": FEET_D, "depth_mm": FEET_DEPTH},
        "lid_print_shift": lid_shift,
        "stats": stats,
    }
    dims["fit_check"] = {k: v for k, v in report.items()}
    size, _ = write_viewer_data(base_mesh, lid_mesh, dims, report)
    dims["stats"]["viewer_case_geo_kb"] = round(size / 1024, 1)
    (HERE / "dims.json").write_text(compact_json(dims) + "\n", encoding="utf-8")
    write_layout_svg(HERE / "layout.svg", base, lid, parts)
    print(f"viewer data {size / 1024:.0f} kB -> {VIEWER_DATA.relative_to(HERE.parent)}")
    print("wrote", OUT)
    old_models = HERE / "viewer" / "models.js"
    if old_models.exists():
        old_models.unlink()
    if not ok:
        sys.exit(1)


if __name__ == "__main__":
    main()
