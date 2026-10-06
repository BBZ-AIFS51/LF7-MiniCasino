# Umbau V11: OLED statt LCD, Tastatur statt Taster, keine LEDs

Das 16x2-LCD ist durch ein **1,3"-OLED mit I2C** (4 Pins) ersetzt. Die drei LEDs sind
weggefallen: Das Lauflicht läuft jetzt auf dem Display. Statt drei Tastern gibt es
eine **4×4-Folientastatur** mit 8 Pins. Spiel, Konten, Buzzer und RC522 bleiben
unverändert.

Vor dem Umstecken immer USB abziehen.

## Pinbelegung

| Uno | Funktion |
|---|---|
| D0/D1 | USB-Seriell, nicht belegen |
| D2 | Buzzer über 330 Ω |
| D3–D6 | Tastatur Pin 1–4, die Spalten von rechts nach links |
| D7, D8 | Tastatur Pin 5, 6, die Reihen `* 0 # D` und `7 8 9 C` |
| D9–D13 | RC522 |
| A0, A1 | Tastatur Pin 7, 8, die Reihen `4 5 6 B` und `1 2 3 A` |
| A2, A3 | frei |
| A4 | OLED SDA |
| A5 | OLED SCL |

## Breadboard, Loch für Loch

Spalten 1–30, Reihen a–e oben und f–j unten. Eine Spalte mit 5 Löchern ist intern
verbunden. Wenn euer Breadboard anders nummeriert ist, zählen nur die Abstände.
Die untere innere Schiene ist **GND**, die anderen Schienen bleiben frei.

### OLED

Die Pins kommen in **j2 bis j5**: GND, VCC, SCL, SDA. Prüft die Reihenfolge auf
eurem Modul, manche haben VCC und GND vertauscht.

| von | zu |
|---|---|
| f2 | GND |
| g3 | 5V |
| h4 | A5 |
| i5 | A4 |

### Tastatur

Die drei Taster und ihre Kabel kommen raus. Die Tastatur braucht weder Breadboard
noch GND noch Widerstände: 8 Kabel der Reihe nach direkt vom Stecker zum Uno.

| Tastatur-Pin | Uno | Leitung |
|---|---|---|
| 1 | D3 | Spalte `A B C D` |
| 2 | D4 | Spalte `3 6 9 #` |
| 3 | D5 | Spalte `2 5 8 0` |
| 4 | D6 | Spalte `1 4 7 *` |
| 5 | D7 | Reihe `* 0 # D` |
| 6 | D8 | Reihe `7 8 9 C` |
| 7 | A0 | Reihe `4 5 6 B` |
| 8 | A1 | Reihe `1 2 3 A` |

So steht es in `GameRuntime.h`: `KEYPAD_REIHEN = {A1, A0, 8, 7}` und
`KEYPAD_SPALTEN = {6, 5, 4, 3}`. D3–D6 sind also die Spalten von rechts nach
links, D7, D8, A0 und A1 die Reihen von unten nach oben. Schaut man von vorne
auf die Tasten, Folienschwanz unten, ist Pin 1 der rechte Kontakt und Pin 8 der
linke. Die Firmware fragt immer eine Reihe nach der anderen ab, die Spalten
lesen über die internen Pullups mit. Was jede Taste tut, steht unten unter
Bedienung.

Der Code ist auf euren Aufbau eingestellt und dort mit allen 16 Tasten getestet.
Steckt jemand den Stecker andersherum, zeigt `Hardware_Test` bei der 1 ein `D` an.
Dann in `GameRuntime.h` die Zeilen `KEYPAD_REIHEN` und `KEYPAD_SPALTEN`
tauschen, siehe Kommentar dort.

### Buzzer

- Der Buzzer steckt in **c26** (S), **c27** (Mitte, bleibt frei) und **c28** (−).
- Der 330-Ω-Widerstand geht von **e24 nach e26**.
- Ein Kabel geht von **a24 zu D2**.
- Ein Kabel geht von **e28 zur GND-Schiene**.

### Masse

Ein Kabel von der GND-Schiene zum **GND** am Arduino. Die Schiene braucht jetzt
nur noch der Buzzer.

### RC522

Der RC522 hängt direkt am Uno, mit 7 Kabeln:

| RC522 | Uno |
|---|---|
| SDA | D10 |
| SCK | D13 |
| MOSI | D11 |
| MISO | D12 |
| IRQ | frei |
| GND | GND |
| RST | D9 |
| 3.3V | 3.3V, nicht 5V |

Alle Teile müssen dieselbe Masse haben: Uno, OLED, Buzzer und RC522.

## Software

Es muss **keine Bibliothek** installiert werden. Display-Treiber, Schrift und
RC522-Treiber liegen im Sketch-Ordner (`OledText.h`, `Rc522.h`).

1. Zuerst **`Hardware_Test/Hardware_Test.ino`** hochladen und den seriellen Monitor
   auf 115200 Baud stellen:
   - `I2C-Geraet auf 0x3C`: das OLED antwortet. Steht dort `Kein I2C-Geraet`,
     sind SDA/SCL vertauscht oder VCC/GND fehlen.
   - `RC522 Version 0x88` (Originale: `0x91`/`0x92`): der Reader antwortet. Bei
     `0x00` oder `0xFF` stimmt ein Kabel nicht, oft sind MOSI und MISO vertauscht.
   - Jede gedrückte Taste erscheint als `Taste: 1` usw. Kommt bei der 1 ein `D`,
     steckt der Stecker andersherum (siehe Abschnitt Tastatur).
2. Danach `MiniCasino/MiniCasino.ino` hochladen. Ist das Bild um zwei Pixel
   verschoben oder steht am Rand Pixelmüll, `CASINO_OLED_SSD1306` auf `1` setzen.

Das OLED zeigt oben einen festen Balken `MINI CASINO`, darunter zwei große
Textzeilen und ganz unten eine kleine Hinweiszeile mit den Tasten, die gerade
gelten.

## Bedienung

| Taste | Funktion |
|---|---|
| 1 / 2 / 3 | auf Schwarz / Rot / Grün setzen |
| A | Einsatz eintippen: Ziffern, `#` = OK, `*` = letzte Ziffer löschen bzw. abbrechen |
| B | Abmelden, mit Rückfrage (`#` = ja, `*` = nein) |
| C | Ton laut / leise / aus |
| D | Hilfe, blättert durch drei Seiten |

Der Einsatz muss mindestens 10, ein Vielfaches von 10 und höchstens so hoch wie
das Guthaben sein (maximal 2550). Das Display zeigt die Obergrenze gleich mit an.
Ohne Tastendruck geht jede Eingabe nach 20 Sekunden zurück ins Menü, nach
60 Sekunden endet die Sitzung.

## Speicher

Der Sketch belegt rund **18 KB** von den 28 KB, die neben dem großen Bootloader
eures Uno frei sind, und rund 520 Byte RAM. Gespart wurde durch eigene kleine
Treiber statt Bibliotheken:

| Was | gespart |
|---|---|
| eigener OLED-Treiber statt U8g2 und Wire | rund 5 KB Flash, 280 Byte RAM |
| eigener RC522-Treiber statt MFRC522 | rund 1,5 KB |
| Buzzer von Hand getaktet statt `tone()` | rund 1,6 KB |
| Admin-Protokoll ohne `strtoul`/`atoi`, kürzere Texte | rund 1,1 KB |
| eigener Zufallsgenerator statt `random()` | rund 0,3 KB |

`DEBUG_LOG` steht weiter auf `false`. Damit werden die Diagnose-Texte gar nicht
erst mitkompiliert. Mit `true` wären es rund 21 KB, das passt inzwischen auch.

## Gehäuse, 3D-Viewer und Grafiken

Alles zeigt jetzt den Aufbau V11:

- Das Gehäuse in `case/` hat das Fenster für das OLED, die Mulde für die
  Tastatur mit dem Schlitz für das Flachkabel und die Tap-Zone über dem RC522.
  LCD-Ausschnitt, LED- und Tasterlöcher sind weg.
- Der 3D-Viewer in `case/viewer/` zeigt dieselben Teile und Kabel und spielt
  mit der Logik der Firmware.
- Schaltplan, Verdrahtung, Pinbelegung und die Bilder im README erzeugt
  `python docs/make_graphics.py` direkt aus der Firmware (Schrift, Tastatur,
  Spieltakt) und den Kabeln in `case/viewer/js/core.js`.
