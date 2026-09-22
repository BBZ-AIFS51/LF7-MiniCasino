# case

a 3d printable console for the whole build. two parts, a body and a top plate, everything else screws or clips onto them. the top plate is tilted by 10° so the lcd faces you and the tap zone sits under your hand.

<p align="center">
  <img src="layout.svg" alt="case layout" width="100%">
</p>

## files

| file | what |
|---|---|
| `stl/base.stl` | the body, print as is |
| `stl/lid.stl` | the top plate, already flipped for printing |
| `stl/assembly.stl` | both in place, just for looking at |
| `stl/fitcheck/` | dummy uno, breadboard, lcd, rc522, buttons, leds and buzzer to check the fit in your slicer |
| `make_case.py` | the model itself, every number is a parameter |
| `dims.json` | the key numbers, written by the script |

## numbers

| | mm |
|---|---|
| footprint | 190 × 130 |
| height front / back | 40 / 62.9 |
| walls / floor / lid | 3.2 / 4 / 4 |
| corner radius | 8 |
| lid screws | 6 × m3 12 countersunk into bosses, holes 2.7 for self tapping (4.0 if you use heat set inserts) |
| button holes | Ø 24.5 for 24 mm arcade buttons (16.2 or 12.2 for smaller panel buttons) |
| led holes | Ø 5.1, press fit |
| lcd window | 72.5 × 25.5, four standoffs on 75 × 31 for m2.5 |
| rc522 | clips into a 40 × 60 frame under the tap zone, reads through the 4 mm lid |
| uno | four standoffs, usb b and dc jack come out on the left side |
| breadboard | half size, sits in a shallow pocket next to the uno |

## printing

* petg if it has to survive a drop, pla works too
* base open side up, lid as exported (top face on the bed), no supports on either
* 0.2 mm layers, 4 walls, 5 top and bottom layers, 30 % gyroid infill
* roughly 250 to 300 g and 12 to 16 h with a 0.4 mm nozzle for both parts

## assembly

1. uno onto its four standoffs with m3 self tapping screws
2. half breadboard into its pocket, leds and resistors get wired there
3. leds pressed into the lid, arcade buttons from the top with their nuts
4. lcd onto the four standoffs under the window with m2.5 screws, bezel ends up flush
5. rc522 clipped into its frame with the pin header toward the front slot, buzzer into its ring
6. lid on, six m3 countersunk screws, four rubber feet into the recesses underneath

## changing it

```bash
pip install manifold3d numpy
python case/make_case.py
```

all sizes and positions are in the parameter block at the top of `make_case.py`. lid features use lid coordinates, u across and v up the slope from the front edge. after a change look at `assembly.stl` together with the `fitcheck` parts before printing.
