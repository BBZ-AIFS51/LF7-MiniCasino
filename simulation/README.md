# Simulation mit Wokwi

Der komplette Automat im Browser, ohne jede Hardware: OLED, Tastatur, Buzzer
und der EEPROM mit allen Konten. **[wokwi.com](https://wokwi.com)** aufrufen,
*New Project* → *Arduino Uno*.

## Der Kartenleser

Wokwi hat **kein RFID-Modul** im Teilekatalog — den RC522 kann man dort nicht
nachbauen. Das fällt aber kaum ins Gewicht, weil die Karte seit V10 nur noch
ihre UID liefert; der Kartenspeicher wird gar nicht mehr gelesen.

Ersatz sind **vier Taster an D9 bis D12**, also genau den Pins, an denen sonst
der Reader hängt. Jeder steht fest für eine Karte:

| Taster | UID | Typ |
|---|---|---|
| Karte 1 | `DF51AA39` | MIFARE Classic, 4 Byte |
| Karte 2 | `0885B1A8` | MIFARE Classic, 4 Byte |
| Karte 3 | `049F905C110189` | Ultralight, 7 Byte |
| Karte 4 | `04CABD5C110189` | Ultralight, 7 Byte |

Drücken heißt auflegen. Der Sketch geht denselben Weg wie nach einem echten
Scan: Konto suchen, unbekannte UID anlegen und aufladen, Sitzung starten.

Wer mehr als vier Spieler braucht, nimmt den seriellen Monitor:

```
CARD 11223344
```

Jede Hexfolge mit 8, 14 oder 20 Zeichen gilt als UID. Auch alle anderen
Verwaltungsbefehle funktionieren dort (`PING`, `LIST`, `SET`, `STAKE`, `FLAG`,
`FREE`, `SOUND`, `WIPE JA`) — Übersicht in
[AdminSerial.h](../MiniCasino/AdminSerial.h). Das Web-Adminpanel läuft **nicht**
mit Wokwi: es braucht eine echte serielle Schnittstelle.

## Einrichten

```bash
python simulation/build_sim.py
```

Das erzeugt `simulation/wokwi/` mit den Dateien für Wokwi. In Wokwi dann:

1. Inhalt von **`sketch.ino`** in den vorhandenen Reiter *sketch.ino* kopieren
   (eine Zeile — der Rest steckt in `casino.h`).
2. Inhalt von **`diagram.json`** in den vorhandenen Reiter *diagram.json*.
3. Über das **+** eine neue Datei **`casino.h`** anlegen und befüllen.
4. **Start** drücken, unten den seriellen Monitor aufklappen.

Bibliotheken braucht es keine: Display- und RFID-Treiber stecken in
`casino.h`, `EEPROM` bringt Wokwi mit. Wokwi kennt nur den OLED-Chip
SSD1306; in der Simulation wird er deshalb automatisch benutzt.

Warum die Umleitung über `casino.h`: die Arduino-Toolchain setzt automatisch
Funktionsprototypen an den Anfang jeder `.ino`, also noch vor die eingebetteten
Enums — das übersetzt nicht. Steht in der `.ino` nur ein `#include`, gibt es
nichts zu ergänzen.

**Der Sketch in `MiniCasino/` bleibt die einzige Quelle.** `build_sim.py` fügt
nur zusammen und schaltet `CASINO_SIM` ein. Nach jeder Änderung am Projekt das
Skript erneut laufen lassen und `casino.h` in Wokwi ersetzen.

## Verdrahtung

| Bauteil | Anschluss |
|---|---|
| OLED GND / VCC / SCL / SDA | GND / 5 V / A5 / A4 |
| Tastatur R1–R4 / C1–C4 | A1, A0, D8, D7 / D6, D5, D4, D3 |
| Buzzer | D2 gegen GND |
| Karte 1–4 (nur Simulation) | D9 / D10 / D11 / D12 gegen GND |

Die Tastatur braucht keine Widerstände, der Sketch nutzt `INPUT_PULLUP`.

Am echten Aufbau kommt statt der Kartentaster der RC522 an dieselben Pins:
SDA→D10, RST→D9, MOSI→D11, MISO→D12, SCK→D13, VCC→**3,3 V** (nicht 5 V),
GND→GND. Dann `CASINO_SIM` in `MiniCasino.ino` wieder auf `0`.

## Bedienung

1. **Karte 1** drücken → `100€` Startguthaben, OLED zeigt `10€ 1S 2R 3G`
2. Auf der Tastatur 1 (Schwarz), 2 (Rot) oder 3 (Grün) tippen → Lauflicht, Ergebnis, neuer Stand
3. **1 halten** → Einsatz einstellen
4. **2 halten** → Logout · **3 halten** → Ton laut/leise/aus

## Was sich gut ausprobieren lässt

- Spielablauf, Auszahlungen und die Chancen über viele Runden
- Einsatz einstellen, Sitzungsablauf nach 60 Sekunden, Logout
- Sperren und Adminkarten über `FLAG`
- Wie sich der EEPROM füllt — bis 31 Karten, danach `UID-Liste voll`

Nicht simulierbar ist alles rund um die Funkstrecke: Reichweite,
Erkennungsfehler, Versorgungseinbrüche. Dafür braucht es echte Hardware.
