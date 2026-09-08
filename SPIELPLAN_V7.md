> Historischer V7-Plan. Aktuell gilt [SPIELPLAN_V8.md](SPIELPLAN_V8.md): LEDs an A3–A5 und Chancen 45/45/10.

# Mini Casino V7 – Farbspiel mit 10 Punkten Einsatz

## Spielregeln und Bedienung

Jede der drei Tasten wählt ihre Farbe und startet genau eine Runde.
Schwarz, Rot und Grün werden gleich häufig gezogen: je ungefähr ein Drittel.
Ein Treffer zahlt den doppelten **Einsatz**, also 20 Punkte insgesamt, aus.
Der gesamte Kartenstand wird nicht verdoppelt.

| Beispiel mit 100 Punkten | Buchung | Endstand |
|---|---|---|
| Farbe stimmt | 10 abziehen, 20 auszahlen | 110 |
| Andere Farbe | 10 abziehen, keine Auszahlung | 90 |
| Weniger als 10 Punkte | Keine Runde und keine Buchung | Unverändert |

Es ist ein einfaches Farbspiel. Bei drei gleich wahrscheinlichen Farben gewinnt
eine Wahl im Mittel jede dritte Runde. Die Auszahlung beträgt bei allen Farben
20 Punkte. Es gibt keine besondere Grün-Auszahlung.

1. Karte auflegen und **auf dem Reader liegen lassen**.
2. Das LCD zeigt `10 Pkt: S/R/G` und den gespeicherten Kartenstand.
3. Genau eine Taste kurz drücken: Schwarz, Rot oder Grün.
4. Während `Einsatz -10 Pkt` und `Buche Ergebnis` die Karte liegen lassen.
5. Das LCD zeigt zuerst die gezogene Farbe und Gewinn/Verlust, danach den neuen
   Kartenstand. Nach fünf Sekunden erscheint wieder die Farbauswahl.
6. Für eine weitere Runde die Taste vollständig loslassen und erneut drücken.
   Es ist kein erneutes Abheben der Karte zwischen normalen Runden erforderlich.

Auch während der Ergebnisanzeige kann ein neuer, bewusst ausgeführter Tastendruck
eine weitere Runde starten. Gedrückthalten erzeugt keine Folge von Einsätzen.
Gleichzeitig gedrückte Tasten werden verworfen; danach alle loslassen.
Ohne erfolgreich eingelesene Karte startet keine Runde. Vor jeder Runde wird
die ausgewählte UID erneut geprüft und das Guthaben frisch von der Karte gelesen.

## Aufbau der Tasten

Vor dem Verdrahten Strom/USB trennen. Verwendet pro Farbe einen **Schließer**:
Der Kontakt ist normalerweise offen und schließt beim Drücken.

| Bauteil | Kontakt 1 | Kontakt 2 |
|---|---|---|
| Schwarze Taste | A0 | GND |
| Rote Taste | A1 | GND |
| Grüne Taste | A2 | GND |

```text
A0 -----[ Taste SCHWARZ ]----- GND
A1 -----[ Taste ROT     ]----- GND
A2 -----[ Taste GRUEN   ]----- GND
```

Der Code verwendet `INPUT_PULLUP`. Daher sind keine zusätzlichen Widerstände
für die Taster nötig: offen = HIGH, gedrückt = LOW. Die Tasten werden nicht
zwischen 5V und GND angeschlossen.

Bei einem vierbeinigen kleinen Taster sind jeweils zwei Beine intern verbunden.
Benutzt zwei Kontakte, die **erst beim Drücken** miteinander verbunden werden.
Das lässt sich stromlos mit einem Durchgangsprüfer feststellen. Nicht allein
nach der Blickrichtung auf den Taster entscheiden. Bei Breadboard-Tastern hilft
die Platzierung über der Mittelrille; die Kontaktpaare trotzdem prüfen.
Bei Tastern mit COM/NO/NC: COM an GND, NO an den Eingang, NC frei.
Falls die farbigen Taster zusätzlich beleuchtet sind, gehören deren LED-Anschlüsse
nicht zum Schaltkontakt; ihre Versorgung ist in diesem Aufbau nicht vorgesehen.

## Reichen die Uno-Pins?

**Ja. A0–A5 können beim klassischen Uno auch digitale Ein-/Ausgänge sein.**
Die funktionierenden LCD- und RFID-Kabel bleiben bestehen.

| Uno-Pins | Verwendung |
|---|---|
| D0/D1 | USB-Seriell/Upload; frei von zusätzlicher Beschaltung lassen |
| D2 | Für das Ton-Signal vorbereitet; standardmäßig deaktiviert |
| D3–D8 | LCD wie in V6 |
| D9–D13 | RC522 wie in V6 |
| A0/A1/A2 | Schwarz/Rot/Grün |
| A3 | Unbeschaltet als zusätzliche Quelle für den Zufallsstartwert |
| A4/A5 | Frei, auch für einen späteren I2C-Bus verfügbar |

A3 lässt sich später ebenfalls für ein anderes Bauteil nutzen; dann die beiden
`analogRead(A3)`-Stellen in GameRuntime.h anpassen. Ein zusätzlicher Expander
oder ein größeres Board ist für diesen Aufbau nicht erforderlich.
Die Zuordnung der Analogpins als digitale Pins steht im
[Arduino-Uno-Core](https://github.com/arduino/ArduinoCore-avr/blob/master/variants/standard/pins_arduino.h).

## Lautsprecher/Buzzer mit drei Pins

Der Modultyp ist noch unbekannt. **Drei Pins allein legen Versorgung, Pinfolge
und Ansteuerung nicht fest.** Bis die Beschriftung/Modellnummer bekannt ist,
bleibt das Modul unverbunden und `CASINO_SOUND_MODE` auf 0.

Ein bestätigtes kompatibles Buzzer-Modul mit separatem Logikeingang könnte so
angeschlossen werden: Signaleingang an D2, GND an gemeinsame Masse, VCC an die
für genau dieses Modul zulässige Versorgung. Nicht nach vermuteter Pinposition
verdrahten. Ein roher Lautsprecher darf nicht direkt an D2 betrieben werden;
dafür wäre eine passende Treiber-/Verstärkerschaltung nötig.

In `MiniCasino/GameRuntime.h` ist vorbereitet:

```cpp
#define CASINO_SOUND_MODE 0  // 0 aus, 1 passives Piezo-Modul, 2 aktiver Buzzer
```

Modus 1 erzeugt einen kurzen hohen Gewinnton bzw. tiefen Verlustton über `tone()`.
Modus 2 schaltet einen aktiven Buzzer zeitlich ein/aus; seine Tonhöhe ist fest.
`TON_AKTIV` muss dabei zur aktiven Logik des identifizierten Moduls passen.
Ohne Ton arbeitet das vollständige Spiel bereits.

Der Uno-Core verwendet für `tone()` Timer 2. PWM auf D3/D11 wäre davon betroffen;
dieser Sketch verwendet dort LCD-Digitalausgabe bzw. SPI, **keine PWM**.
Die vorhandene Beschaltung kann deshalb bestehen bleiben. Siehe
[Arduino Tone.cpp](https://github.com/arduino/ArduinoCore-avr/blob/master/cores/arduino/Tone.cpp).

## Speichern und offene Runden

Die V6-UID-Liste und das einmalige Startguthaben bleiben erhalten. Der Sketch
ändert deren EEPROM-Format nicht und löscht keine Einträge. 0 Punkte führen
weiterhin nicht zu einer neuen Startaufladung.

Eine Runde schreibt zwei geprüfte Datensätze an die bisherige Guthabenstelle:

1. **Offene Runde:** Guthaben nach Abzug von 10, gewählte Farbe und einmalig
   festgelegte Ergebnisfarbe. Das Rücklesen muss diesen Datensatz bestätigen.
2. **Abgeschlossene Runde:** Absoluter Endstand nach Auszahlung von 20 oder 0.
   Auch dieser wird zurückgelesen. Erst danach erscheint ein bestätigtes Ergebnis.

Bei einer Übertragungsstörung bleiben die Zielwerte im RAM fest. Erneut dieselbe
Karte auflegen oder eine Taste drücken setzt genau diese Runde fort. Es wird
derselbe absolute Endstand geschrieben; nicht nochmals 20 zum gelesenen Stand
addiert. Solange die Runde offen ist, können andere UIDs keine neue Runde starten.

Nach einem Neustart kann V7 eine **vollständig und gültig gespeicherte offene
Runde** ebenfalls beenden: Der Einsatz wurde bereits abgezogen und das Ergebnis
steht schon fest. Es gibt weder einen weiteren Einsatz noch eine neue Ziehung.

**Eine abgebrochene Mehrseiten-Schreibung ist nicht atomar.** Solange der Uno
eingeschaltet bleibt, kann er sie mit der gespeicherten RAM-Transaktion erneut
schreiben. Wenn zugleich Strom/Reset eintritt und nur ein beschädigter Datensatz
auf der Karte übrig bleibt, kann V7 den Stand nicht automatisch rekonstruieren.
Dann bleibt die Karte gesperrt statt kostenlos neu aufgeladen zu werden. Deshalb
die Karte bis zum bestätigten Endstand liegen lassen. Die CRC erkennt viele
Übertragungs-/Speicherfehler, ersetzt aber kein manipulationssicheres Bezahlsystem.

Die Ziehung verwendet einen Pseudozufallsgenerator mit Tastendruck-Zeitpunkt und
dem unbeschalteten A3 als zusätzlichen Startwertquellen. Das ist für das
Spielpunkte-Projekt gedacht und kein geprüfter Zufallsgenerator für Echtgeldeinsätze.

## Kartenformat und Dateien

Abgeschlossene Guthaben behalten das 16-Byte-MCAS-Format Version 1 aus V6.
Offene Runden verwenden Version 2 im selben Speicherbereich, ohne zusätzliche
Seiten/Blöcke oder zusätzliche EEPROM-Bereiche zu beanspruchen:

| Bytes | Bedeutung der offenen Runde |
|---|---|
| 0–3 | MCAS |
| 4 | Version 2 |
| 5–8 | Guthaben nach Einsatzabzug, uint32 little-endian |
| 9 | 1 = offene Runde |
| 10 | Gewählte Farbe: 0 Schwarz, 1 Rot, 2 Grün |
| 11 | Festes Ergebnis, gleiche Farbcodes |
| 12 | Einsatz 10 |
| 13 | Reserviert, 0 |
| 14–15 | CRC-16/CCITT-FALSE über Bytes 0–13 |

V6 kann Version 2 nicht fortsetzen. Für offene Runden V7 verwenden; alte
FORCE-Sketches würden den Stand zurücksetzen und gehören nicht zum Spielbetrieb.

Alle sieben Dateien im Ordner **MiniCasino** zusammen übernehmen:

| Datei | Aufgabe |
|---|---|
| MiniCasino.ino | LCD, RFID, Startguthaben, Hauptschleife |
| EmptyRegion.h | Prüfung leerer Kartenbereiche |
| UidRegistry.h | Unveränderte dauerhafte V6-UID-Liste |
| GameRules.h | Einsatz, Auszahlung und Zahlenbereichsprüfung |
| CardRecord.h | MCAS-Versionen 1/2, CRC, Kodierung und Prüfung |
| ButtonBank.h | Entprellen und Freigabe erst nach Loslassen |
| GameRuntime.h | Bedienablauf, feste Rundentransaktion, Wiederaufnahme, optionaler Ton |

## Installation und Test

1. ZIP entpacken, MiniCasino/MiniCasino.ino öffnen, Arduino Uno wählen und laden.
   MFRC522 und LiquidCrystal bleiben die benötigten Zusatzbibliotheken.
2. Monitor bei Bedarf auf 115200 Baud stellen; BOOT muss Mini Casino v7 zeigen.
3. Bestehende Karte lesen und eine Runde testen. Die UID-Liste nicht löschen.
4. Wiederholte Tastendrücke, Gedrückthalten, zu wenig Guthaben und Neustart nach
   abgeschlossenem Spiel prüfen. Testfälle: [TESTPLAN.md](TESTPLAN.md).

Lokal wird mit `python pruefen.py` kompiliert und gelinkt. Die Tests prüfen
Spielrechnung, Überlauf/Unterdeckung, alte Kartenformate, offene Runden,
Prüfsummen, Entprellen und die bestehende UID-Liste. V7 ist noch nicht auf dem
realen Aufbau geprüft. V6 wurde von euch als deutlich stabiler bestätigt.
