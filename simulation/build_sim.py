"""Erzeugt aus dem Projekt eine Wokwi-taugliche Fassung.

    python simulation/build_sim.py

Ergebnis in simulation/wokwi/:

    sketch.ino    nur ein include auf casino.h
    casino.h      alle Projekt-Header eingebettet, CASINO_SIM aktiviert
    diagram.json  die Schaltung

Der Sketch braucht keine Bibliotheken ausser dem Arduino-Core, in Wokwi ist
also nur casino.h neu anzulegen. Der Sketch in MiniCasino/
bleibt die einzige Quelle: das Skript baut nur zusammen, es aendert keine Logik.
"""
from pathlib import Path
import re
import shutil
import sys

WURZEL = Path(__file__).resolve().parent.parent
QUELLE = WURZEL / "MiniCasino"
ZIEL = Path(__file__).resolve().parent / "wokwi"

# Header, die der Sketch selbst einbindet. Was diese wiederum einbinden, holt
# einbetten() rekursiv nach (GameRuntime.h zieht zum Beispiel GameSounds.h).
PROJEKT_HEADER = ["Rc522.h", "OledText.h", "UidRegistry.h", "GameRules.h",
                  "GameRuntime.h", "AdminSerial.h"]

INCLUDE = re.compile(r'^[ \t]*#include\s+"([^"]+)"[ \t]*$', re.M)
_gesehen = set()


def ohne_waechter(text: str, name: str) -> str:
    """include-Waechter entfernen; in einer Sammeldatei stoeren sie nur."""
    zeilen = text.split("\n")
    raus = []
    for zeile in zeilen:
        gestutzt = zeile.strip()
        if gestutzt.startswith("#ifndef ") and "_H" in gestutzt.upper():
            continue
        if (gestutzt.startswith("#define ") and "_H" in gestutzt.upper()
                and len(gestutzt.split()) == 2):
            continue
        raus.append(zeile)
    for i in range(len(raus) - 1, -1, -1):   # das letzte #endif gehoerte dazu
        if raus[i].strip() == "#endif":
            del raus[i]
            break
    balken = "=" * max(3, 60 - len(name))
    return f"// ===== {name} {balken}\n" + "\n".join(raus)


def einbetten(name: str) -> str:
    """Header laden und seine eigenen Projekt-includes gleich mit aufloesen."""
    if name in _gesehen:
        return ""                     # steht schon weiter oben
    _gesehen.add(name)
    pfad = QUELLE / name
    if not pfad.is_file():
        sys.exit(f"fehlt: {pfad}")
    text = ohne_waechter(pfad.read_text(encoding="utf-8"), name)

    return INCLUDE.sub(lambda treffer: einbetten(treffer.group(1)), text)


def main() -> int:
    if not QUELLE.is_dir():
        sys.exit(f"Sketch-Ordner nicht gefunden: {QUELLE}")
    ZIEL.mkdir(parents=True, exist_ok=True)

    ino = (QUELLE / "MiniCasino.ino").read_text(encoding="utf-8")

    # Simulationsbetrieb fest einschalten.
    if "#define CASINO_SIM 0" not in ino:
        sys.exit("CASINO_SIM nicht gefunden - wurde der Sketch umgebaut?")
    ino = ino.replace("#define CASINO_SIM 0", "#define CASINO_SIM 1", 1)

    # Header an genau der Stelle einsetzen, an der sie eingebunden werden.
    for name in PROJEKT_HEADER:
        muster = f'#include "{name}"'
        if muster not in ino:
            sys.exit(f"{muster} steht nicht im Sketch")
        ino = ino.replace(muster, einbetten(name), 1)

    # Was jetzt noch an Projekt-includes uebrig ist, gehoert nicht mehr dazu
    # und wuerde in Wokwi nur fehlschlagen.
    ino = INCLUDE.sub("", ino)

    kopf = ("// Automatisch erzeugt von simulation/build_sim.py.\n"
            "// Nicht hier aendern, sondern in MiniCasino/ und neu erzeugen.\n\n")
    (ZIEL / "casino.h").write_text(kopf + ino, encoding="utf-8")
    # Die .ino bleibt absichtlich leer bis auf das include: die Arduino-
    # Toolchain setzt sonst Funktionsprototypen vor die eingebetteten Enums.
    (ZIEL / "sketch.ino").write_text(kopf + '#include "casino.h"\n',
                                     encoding="utf-8")

    shutil.copy2(Path(__file__).resolve().parent / "diagram.json",
                 ZIEL / "diagram.json")
    for alt in ("MFRC522.h", "MFRC522.cpp", "libraries.txt"):   # aus frueheren Laeufen
        (ZIEL / alt).unlink(missing_ok=True)

    print(f"Erzeugt in {ZIEL}:")
    for datei in sorted(ZIEL.iterdir()):
        print(f"  {datei.name:14} {datei.stat().st_size // 1024:4} KB")
    print("\nIn Wokwi neu anlegen: casino.h")
    print("In die vorhandenen Reiter: sketch.ino und diagram.json")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
