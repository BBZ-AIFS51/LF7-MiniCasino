# Mini Casino: LCD und Guthaben auf RFID

**Aktuell V10: Die Guthaben liegen im EEPROM des Uno, nicht mehr auf der Karte. Einmal kurz auflegen, danach beliebig viele Runden nur mit den Tasten. Der Kartenspeicher wird nicht mehr gelesen oder beschrieben.** Tasten, Regeln und offene Runden: [SPIELPLAN_V8.md](SPIELPLAN_V8.md). Aktueller Tonanschluss und Jackpot: [SOUND_V9.md](SOUND_V9.md). Die V6-Erstaufladung und UID-Merkliste bleiben erhalten.

Der Sketch `MiniCasino/MiniCasino.ino` zeigt seine Ergebnisse auf dem LCD. Zur
Fehlersuche ist aktuell zusätzlich `DEBUG_LOG = true` mit **115200 Baud** aktiviert;
ein geöffneter serieller Monitor ist nicht zum Betrieb erforderlich. Er ist
für euren klassischen Arduino Uno (ATmega328P), RC522 und das **QAPASS 1602A**
mit 16 Pins und 16×2 Zeichen ausgelegt. Der separate LCD-Test wurde mit der
unten dokumentierten Pinbelegung von euch erfolgreich durchgeführt.

## Bauteile und belegte Pins

| Bauteil | Anzahl / Ausführung |
|---|---|
| Arduino Uno | 1, ATmega328P |
| Breadboards | 2 |
| LCD | 1, QAPASS 1602A ohne I2C-Adapter |
| RFID-Reader | 1, RC522, Firmware 0x88 bei eurem Modul |
| Potentiometer | 1, 10 kΩ, für LCD-Kontrast |
| Widerstand | 1, 200 Ω, für LCD-Hintergrundbeleuchtung |
| Transponder | Eigene MIFARE-Classic- und Ultralight-kompatible Projekt-Tags |
| Verbindungsmaterial | Jumperkabel, USB-Kabel, für die RC522-Eingänge passende Pegelwandlung |

Arduino **D3–D8** sind durch das LCD belegt, **D9–D13** durch den Reader.
**A0–A2** sind in V7 Tastereingänge, **D2** ist für Ton vorbereitet. **A3/A4/A5** treiben die drei LEDs, jeweils mit eigenem 330-Ω-Widerstand. Damit sind alle weiteren Pins verplant. D0/D1 werden vom Sketch nicht
genutzt; diese Pins gehören beim Uno auch zur seriellen Upload-Verbindung.
Die beiden Geräte verwenden unterschiedliche Signalpins und gemeinsame Masse.

## LCD anschließen

Vor dem Umstecken USB/Stromversorgung trennen. Nach den Anschlussbeschriftungen
gehen: Die Nummerierung nicht von der Betrachtungsrichtung erraten.

| LCD-Pin | Beschriftung | Verbindung |
|---|---|---|
| 1 | VSS / GND | Arduino GND |
| 2 | VDD / VCC | Arduino 5V |
| 3 | VO / V0 | Mittlerer Anschluss eines 10-kOhm-Potentiometers |
| 4 | RS | Arduino D8 |
| 5 | RW / R/W | GND |
| 6 | E / Enable | Arduino D7 |
| 7–10 | D0–D3 | Nicht anschließen |
| 11 | D4 | Arduino D6 |
| 12 | D5 | Arduino D5 |
| 13 | D6 | Arduino D4 |
| 14 | D7 | Arduino D3 |
| 15 | A / LED+ | Über euren 200-Ohm-Widerstand an 5V |
| 16 | K / LED- | GND |

Die äußeren Potentiometeranschlüsse kommen an 5V und GND. Am Potentiometer drehen,
bis die Schrift sichtbar ist. Ein beleuchtetes Display oder schwarze Kästchen
allein bedeuten noch nicht, dass die Datenverbindung funktioniert. Ohne Poti
kann VO für einen ersten Test direkt an GND liegen; der Kontrast ist dann maximal
und je nach Modul zu stark. Den Pin nicht offen lassen.

Im Code bedeutet `LiquidCrystal lcd(8, 7, 6, 5, 4, 3)` die Arduino-Pinfolge
RS, E, LCD-D4, LCD-D5, LCD-D6, LCD-D7. Nicht die physischen LCD-Pinnummern!

## RC522

Die funktionierende Signalbelegung bleibt:

| RC522 | Arduino Uno |
|---|---|
| 3.3V | 3.3V, nicht 5V |
| GND | GND |
| SDA / SS | D10 |
| RST | D9 |
| MOSI | D11 |
| MISO | D12 |
| SCK | D13 |
| IRQ | Frei |

Der RC522 arbeitet mit 3,3-V-Logik. Für die Uno-Ausgänge SS, RST, MOSI und SCK
einen für SPI geeigneten 5V-auf-3,3V-Pegelwandler verwenden. Das LCD nutzt 5V.
5V und 3,3V dürfen nicht dieselbe Versorgungsschiene speisen. Alle verwendeten
GND-Schienen mit Arduino GND verbinden. Bei zwei Breadboards auch mögliche
Unterbrechungen der Versorgungsschienen beachten.

## Hochladen und testen

1. `MiniCasino/MiniCasino.ino` in der Arduino IDE öffnen. Hauptprogramm und
   LCD-Test sind getrennte Sketches: nicht in dieselbe Datei oder als zusätzliche
   IDE-Tabs zusammenkopieren, sonst wären `setup()` und `loop()` doppelt vorhanden.
2. Bibliotheken: **MFRC522 liegt fertig im Sketch-Ordner** (Version 1.4.12,
   Public Domain) und braucht keine Installation. Zusätzlich nötig ist nur
   **LiquidCrystal von Arduino**. Hier wird keine I2C-LCD-Bibliothek verwendet.
3. Arduino Uno und dessen Port auswählen, mit dem Upload-Pfeil hochladen.
4. Das LCD sollte `Mini Casino` / `Karte auflegen` zeigen.
5. Einen eigenen leeren Projekt-Transponder auflegen und während des Schreibens
   liegen lassen. Erwartet: `Neu aufgeladen!` / `100 Pkt`.
6. Transponder entfernen und erneut auflegen. Erwartet: `Guthaben:` / `100 Pkt`.
7. Arduino aus- und wieder einschalten, dieselbe Karte auflegen. Weiterhin 100:
   Der Wert liegt dauerhaft auf dem Transponder.
8. Eine zweite leere Karte erhält ihr eigenes Startguthaben von 100.

Das Ergebnis bleibt fünf Sekunden sichtbar, danach erscheint wieder die
Aufforderung zum Auflegen. Für einen neuen Scan die Karte kurz entfernen.

## Was gespeichert wird

Unterstützt werden MIFARE Classic Mini/1K/4K mit Key A `FF FF FF FF FF FF`
oder dem öffentlichen NDEF-Key A `D3 F7 D3 F7 D3 F7`, sowie Ultralight-kompatible Tags mit frei les-/schreibbaren
Seiten 4–7. Die Anzeige `MIFARE Ultralight or Ultralight C` identifiziert das
genaue Modell nicht. Geschützte Ultralight-C-Karten werden nicht entsperrt;
3DES-Authentifizierung ist nicht implementiert. Euer Reader-Clone mit
Firmwareversion 0x88 wird akzeptiert.

- **Classic:** Guthaben in Datenblock 4, Sektor 1. Zur Erstbelegung müssen
  Block 4 Nullbytes oder eine freigegebene leere NDEF-Struktur enthalten;
  ohne NDEF-Struktur müssen die Datenblöcke 5 und 6 vollständig `00` enthalten.
  Endet ein erkannter leerer NDEF-Strom bereits in Block 4, dürfen Block 5/6
  Restdaten enthalten und bleiben unverändert. Geschrieben wird nur
  Block 4. Block 0 (Herstellerdaten) und Block 7 (Schlüssel/Zugriffsrechte)
  werden nicht beschrieben.
- **Ultralight:** Guthaben auf den vier Seiten 4–7, jeweils vier Bytes. Zur
  Erstbelegung müssen diese 16 Bytes vollständig `00` enthalten oder eine der
  unten beschriebenen leeren NDEF-Strukturen bilden. Seiten 0–3 und spätere
  Konfigurations-/Sperrseiten werden nicht beschrieben.

"Leer" bezieht sich auf diese festgelegten Projektbereiche, nicht auf den
gesamten Transponder. Andere Speicherbereiche werden nicht auf Leerheit geprüft.
Ein Tag mit tatsächlichen NDEF-Nutzdaten oder unbekannter Struktur wird weiter
als belegt abgelehnt. Fremde aktive Nutzdaten werden nicht automatisch gelöscht.

### Leere NFC-Tools-Tags (Ultralight ab v2, Classic ab v3)

Bei Ultralight-kompatiblen Tags und Classic erkennt `EmptyRegion.h` zusätzlich exakt:

- `03 00 FE`: NDEF-TLV ohne Nachricht.
- `03 03 D0 00 00 FE`: einzelner leerer NDEF-Record.
- `03 04 D8 00 00 00 FE`: einzelner leerer NDEF-Record mit leerem ID-Längenfeld.

Die Struktur muss am Anfang des gelesenen Bereichs stehen. `FE` beendet den
NDEF-TLV-Strom; nachfolgende Bytes sind keine aktive NDEF-Nutzlast. Innerhalb
der Seiten 4–7 (Classic: Block 4) werden auch solche Restbytes bei der Übernahme ersetzt. Das
betrifft den im Nutzerlog beobachteten Tag mit dem Rest `6E 30 34 3A ...`.
Andere Records/TLVs, fehlende Abschlussmarker und nichtleere Nutzdaten bleiben
gesperrt. Dies ist eine begrenzte Erkennung, kein allgemeiner NDEF-Parser.

Bei Ultralight wird vor der NDEF-Übernahme Seite 3 gelesen: Der Capability-Container muss
Type-2-Mapping-Version 1, mindestens 16 Nutzbytes und freien Lese-/Schreibzugriff
angeben. Physische Sperrbits können trotzdem einen späteren Schreibfehler
verursachen. Es werden keine Sperren aufgehoben. Vor jedem Initialisieren muss
außerdem eine zweite Lesung dieselben 16 Ausgangsbytes liefern.

Danach liegt dort das eigene MCAS-Format; NFC Tools zeigt dessen Guthaben nicht
als normalen NDEF-Datensatz an. Nicht erneut mit NFC Tools löschen, wenn das
Guthaben erhalten bleiben soll. Mit `LEERE_NDEF_TAGS_NUTZEN = false` lässt sich
die NDEF-Übernahme abschalten. Bei Classic gilt die strenge Nullbyte-Regel für
die Nachbarblöcke 5 und 6 nur ohne erkannte leere NDEF-Struktur in Block 4.
Ab v4 werden Restdaten hinter dem bereits in Block 4 liegenden Abschlussmarker
in den Nachbarblöcken akzeptiert und unverändert belassen. Dort wird kein Type-2-Capability-
Container gelesen; die erfolgreiche Sektoranmeldung ist Voraussetzung.

Bei einem fehlgeschlagenen Classic-Standardkey-Versuch wird die Karte neu
ausgewählt und ihre UID/SAK geprüft, bevor der öffentliche NDEF-Key versucht
wird. Ein Kartenwechsel bricht den Vorgang ab. Die Anmeldung ändert keine
Schlüssel/Zugriffsrechte und garantiert noch keine Schreibberechtigung.

| Byteposition, ab 0 | Inhalt | Zweck |
|---|---|---|
| 0–3 | ASCII `MCAS` | Kennung des Casino-Datensatzes |
| 4 | `01` | Formatversion |
| 5–8 | `uint32_t`, niedrigstes Byte zuerst | Ganze Spielpunkte, 0 bis 4.294.967.295 |
| 9–13 | Fünf Nullbytes | Reserviert; müssen für Version 1 Null sein |
| 14–15 | CRC-16, niedrigstes Byte zuerst | Prüfsumme über Bytes 0–13 |

Die CRC-16/CCITT-FALSE verwendet Startwert `0xFFFF`, Polynom `0x1021`,
keine Bitspiegelung und kein abschließendes XOR. 100 Punkte stehen in den
Guthabenbytes als `64 00 00 00` (hexadezimal).

Beim bloßen Einlesen wird ein gültiges abgeschlossenes Guthaben angezeigt; erst ein Tastendruck startet eine neue kostenpflichtige Spielrunde.
Auch 0 Punkte gelten als gültiger Stand und erzeugen keine neue Aufladung.
V7 ergänzt das Farbspiel mit Einsatzabzug und Gewinnauszahlung; die Erstaufladung bleibt einmalig pro UID. Die Spielpunkte haben keinen Manipulationsschutz.

Die UID wird außerdem in der dauerhaften EEPROM-Merkliste registriert. Vor
jeder Erstaufladung muss sie dort unbekannt und ein Platz verfügbar sein.
Reservierung, Datenformat, Übernahme vorhandener Karten und Grenzen stehen in
[UidRegistry.h](MiniCasino/UidRegistry.h). Der Wert auf der Karte bleibt die Quelle des Guthabens.

## Erstaufladung und vorhandene Funktionen

V7 ergänzt diesen Ablauf durch GameRuntime.h und die Tastenabfrage. Eine gültige
offene Runde wird vor der normalen Guthabenanzeige abgeschlossen. Das LCD zeigt
bei Spielbereitschaft `10 Pkt: S/R/G`. Details: [SPIELPLAN_V8.md](SPIELPLAN_V8.md).

1. `setup()` startet LCD, EEPROM-Liste, SPI und Reader. Der Clone 0x88 wird akzeptiert.
2. `loop()` fragt Karten ab; `erkennungsfehler()` zählt Fehler und steuert die
   seltenere LCD-Meldung. `logLebenszeichen()` gibt alle fünf Sekunden Status aus.
3. `bearbeiteKarte()` prüft den Typ und meldet Classic über `meldeClassicAn()` an.
4. `leseSpeicher()` liest gültige Daten mit begrenzten Wiederholungen.
   `waehleDieselbeKarte()` und `erneuereSitzung()` verhindern Schreiben auf eine
   während einer Wiederholung ausgetauschte Karte.
5. `leseGuthaben()` validiert Kennung, Version, reservierte Bytes und CRC.
   Gültige Guthaben werden angezeigt; `UidRegistry::reserve()` und `confirm()`
   übernehmen eine vorhandene Karte in die Liste, ohne Kartendaten zu ändern.
6. Bei fehlendem gültigem Guthaben prüft `UidRegistry::find()` die UID.
   Bekannte/reservierte UIDs erhalten keine erneute Erstaufladung.
7. Für eine unbekannte UID folgen Leerheitsprüfung und erneutes Lesen der
   Ausgangsdaten. Erst nach dauerhafter Reservierung darf geschrieben werden.
8. `erstelleGuthaben()` erzeugt den Datensatz mit den Funktionen in `CardRecord.h`. `speichern()`
   führt höchstens drei Versuche aus; `schreibeStartguthaben()` schreibt Classic-
   Block 4 bzw. Ultralight-Seiten 5, 6, 7 und zuletzt 4. Identisches Rücklesen aller
   16 Bytes ist Voraussetzung für `Neu aufgeladen!` und Bestätigung der Reservierung.
9. `zeigeGuthaben()` und `meldung()` beschriften das LCD. Nach fünf Sekunden
   erscheint wieder `Karte auflegen`. Die Kartenkommunikation wird beendet.

Die Reservierung bleibt nach unklarer Speicherung bestehen. Erneutes Auflegen
liest den tatsächlichen Stand, löst aber keine zweite Aufladung aus. Eine
Teilschreibung kann deshalb manuelle Klärung erfordern. Es gibt keine automatische
Reparatur oder Rücksetzung der Liste.

## Einstellungen

| Einstellung | Wert | Zweck |
|---|---|---|
| `STARTGUTHABEN` | 100 | Nur für neue, unbekannte UIDs mit leerem Projektbereich |
| `DEBUG_LOG` | true | Zusätzlicher Diagnose-Log; LCD funktioniert auch ohne Konsole |
| `LOG_BAUD` | 115200 | Muss der Einstellung des seriellen Monitors entsprechen |
| `LEERE_NDEF_TAGS_NUTZEN` | true | Beschriebene leere NFC-Tools-Strukturen übernehmen |
| `MAX_VERSUCHE` | 3 | Begrenzte Lese- und Schreibwiederholungen |
| `SCAN_PAUSE_MS` | 1000 | Pause nach einem Erkennungsversuch mit Antwort |
| `ANZEIGEDAUER_MS` | 5000 | Ergebnisanzeige |

Die bestätigte Pinbelegung bleibt erhalten. Alle 13 Dateien aus `MiniCasino`
zusammen übernehmen, MFRC522 eingeschlossen.
EEPROM, SPI und LiquidCrystal kommen mit dem Arduino-Core, MFRC522 liegt
im Ordner. Es muss also nichts mehr nachinstalliert werden. Ein geöffneter
serieller Monitor ist nicht zum Betrieb erforderlich.

## Meldungen und Diagnose

`Guthaben:` zeigt einen bereits gültigen Stand; `Neu aufgeladen!` bestätigt eine
neue, zurückgelesene Speicherung. `Schon aufgeladen` und `Aufladung offen` sind
Sperren gegen erneutes Startguthaben. `UID-Liste voll` oder `UID-Liste Fehler`
verhindern neue Aufladungen. `Karte ruhig` erscheint erst nach mehreren
Erkennungsfehlern. Speicher-, Anmelde- und NDEF-Fehler bleiben sichtbar.

Alle Logkennungen und die Baudrate sind in [LOG_ANLEITUNG.md](LOG_ANLEITUNG.md)
beschrieben; Bedienfälle und Prüfstand in [TESTPLAN.md](TESTPLAN.md).

## Quellen

- [Arduino LiquidCrystal HelloWorld](https://github.com/arduino-libraries/LiquidCrystal/blob/master/examples/HelloWorld/HelloWorld.ino)
- [Arduino EEPROM](https://github.com/arduino/ArduinoCore-avr/blob/master/libraries/EEPROM/README.md)
- [MFRC522 API und Speicherbefehle](https://github.com/miguelbalboa/rfid/blob/master/src/MFRC522.cpp)
- [NXP MIFARE Ultralight C](https://www.nxp.com/docs/en/data-sheet/MF0ICU2.pdf)
