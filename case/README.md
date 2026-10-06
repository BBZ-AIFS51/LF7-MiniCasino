# case

a 3d printable console for the V11 build. two parts, a body and a lid, everything else screws, clips or sticks onto them. the lid is tilted by 10°: the oled sits behind a chamfered window right above the keypad, the rfid tap zone and the buzzer grille are on the right, the usb-b cable leaves at the back.

**[open the interactive model](https://bbz-aifs51.github.io/LF7-MiniCasino/)** on github pages, or open [viewer/index.html](viewer/index.html) straight from the folder, no server needed. it shows this case with every part and wire inside and plays the game like the firmware.

the page on github pages comes from the `gh-pages` branch. after changing the viewer, publish it again with

```bash
git subtree push --prefix case/viewer origin gh-pages
```

<p align="center">
  <img src="layout.svg" alt="case layout: lid top view and two sections, all dimensions in mm" width="100%">
</p>

## what goes where

| part | where | how it is held |
|---|---|---|
| arduino uno | back left, usb-b and dc jack through the back wall | four standoffs, 4 × m3 × 6 self tapping |
| half breadboard | back right, the ky-006 buzzer (c26–c28) stands right under the grille | shallow pocket, its own adhesive |
| 1.3" oled | lid, behind the window above the keypad, header to the back | flush under the lid in a frame with 2 snap clips, 4 × m2 optional |
| 4x4 keypad | lid, in a 0.8 mm recess so the membrane ends flush | its adhesive, tail through the slot at the front edge |
| rc522 | lid, under the tap zone, component side down | 4 pegs in its holes, 2 snap clips, 90° header toward the centre |

wires: oled lead to j2–j5, rc522 straight to the uno with 7 wires, keypad with 8 jumpers to d3–d8, a0, a1. all hole by hole in [UMBAU_OLED.md](../UMBAU_OLED.md).

## files

| file | what |
|---|---|
| `stl/base.stl` | the body, print as is |
| `stl/lid.stl` | the lid, already flipped for printing (face down) |
| `stl/assembly.stl` | both in place, just for looking at |
| `stl/fitcheck/` | dummy oled, keypad, rc522, uno, breadboard and buzzer, in place, with headers and dupont housings. load them with `assembly.stl` to check the fit in your slicer |
| `make_case.py` | the model itself, every number is a named parameter with its source |
| `dims.json` | the key numbers, the lid features and the last fit check, written by the script |
| `layout.svg` | the dimensioned drawing above, light and dark |
| `viewer/data/case_geo.js` | the meshes and part positions for the viewer, written by the script (about 280 kb) |

## numbers

| | mm |
|---|---|
| footprint | 200 × 148 |
| height front / back | 34 / 60.1 |
| walls / floor / lid | 2.4 / 3 / 3 |
| corners | r 10 in plan, r 1.8 on the lid edge, 0.4 chamfers at the lid joint |
| oled window | 30.2 × 15.5 at the panel, 45° chamfer to 31.8 × 17.1, panel 1.2 below the top |
| keypad recess | 69.6 × 77.3, 0.8 deep, ribbon slot 22 × 3.8 (the 8 pin connector passes) |
| tap zone | engraved ring ø52 and contactless mark, lid thinned to 1.6 over the antenna |
| buzzer grille | 37 × ø1.8 in four rings |
| lid screws | 4 × m3 × 12 countersunk into corner bosses, holes 2.7 for self tapping (4.0 for heat set inserts) |
| back wall | usb-b 13.2 × 12.2, dc jack ø11.5, both chamfered |
| uno standoffs | 5 high, clear the pin ends under the board |
| breadboard pocket | 83.3 × 55.3 × 0.6 |
| rubber feet | 4 × ø10.5 recesses, 0.8 deep |

the lid is laid out on a grid: keypad and oled on one axis 54.8 from the left edge, tap zone and grille on the mirrored axis, the keypad and the tap zone share one row, the window and the grille the other. margins are 20 to the keypad on the sides and the front.

## fit check

`make_case.py` ends with an automatic check. every dummy part, every dupont housing and the room each wire needs to bend (6.5 behind the housing) is tested against the body, the lid and the other parts. any overlap stops the script with an error. the last run:

| part | resting on | smallest gap to the case | wire bends |
|---|---|---|---|
| uno | standoffs | 0.38, usb-b corner in its opening | 5.7 to the lid |
| breadboard | pocket floor | 8.5 | 12.5 |
| buzzer | breadboard | 8.5 | |
| oled | lid underside | 0.1, panel under the window | 8.7 |
| rc522 | lid underside | 0.2 | 1.6 |
| keypad | recess floor | 0.8, tail in the slot | |

there is room for 14 mm dupont housings plus the bend above the uno headers and the breadboard everywhere under the lid.

## printing

* pla or petg, 0.2 mm layers, 3 walls, 15 % infill, no supports on either part
* body open side up. lid as exported, top face on the bed: the bed gives the top its finish, the window chamfer, the countersinks and the engravings print as 45° overhangs or tiny bridges
* the keypad recess floor is one wide bridge on the first layers. it ends up under the keypad, slow bridges keep it flat
* roughly 260 g and 12 to 14 h for both parts with a 0.4 mm nozzle

## assembly

1. print body and lid
2. uno onto the four standoffs with m3 × 6 screws, usb-b and the dc jack line up with the back wall
3. breadboard into its pocket. buzzer s / middle / − into c26 / c27 / c28, 330 Ω from e24 to e26, a24 to d2, e28 to the lower inner rail, rail to gnd
4. keypad: feed the connector through the slot first, then stick the keypad into the recess. 8 jumpers to d3, d4, d5, d6, d7, d8, a0, a1
5. oled from below into its frame, glass up into the window, it snaps in. 4 wire lead to j2–j5, then f2 gnd, g3 5v, h4 a5, i5 a4
6. rc522 component side down onto the pegs under the tap zone until both clips catch, pin ends on the back no longer than 1.5. 7 wires straight to the uno, 3.3 v only
7. lid on, 4 × m3 × 12 countersunk, rubber feet into the recesses underneath. usb in, upload `MiniCasino.ino`, tap a card

## changing it

```bash
pip install manifold3d numpy
python case/make_case.py
```

all sizes and positions are in the parameter block at the top of `make_case.py`. lid features use lid coordinates: u across, v up the slope from the front edge. the script rewrites the stl files, `dims.json`, `layout.svg` and the viewer geometry, so the 3d model shows the change right away.
