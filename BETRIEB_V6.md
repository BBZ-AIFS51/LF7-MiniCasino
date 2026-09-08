> Hintergrund zur weiterhin unveränderten UID-Merkliste. Aktueller Hauptsketch: **V7 mit Farbspiel**, siehe [SPIELPLAN_V7.md](SPIELPLAN_V7.md). Die Spielbuchungen sind zusätzlich zur hier beschriebenen Erstaufladung möglich.

# V6: Einmaliges Startguthaben pro UID

V6 ersetzt den FORCE-Sketch. Eine neue, noch nicht registrierte Karte mit leerem
Projektbereich erhält einmal 100 Punkte. Vorhandenes gültiges Guthaben wird nur
angezeigt, auch bei 0 Punkten. Der FORCE-Zweig ist aus dem Programm entfernt.

## Umstieg mit euren bereits aufgeladenen Karten

1. Den ganzen Ordner `MiniCasino` übernehmen. `MiniCasino.ino`, `EmptyRegion.h`
   und `UidRegistry.h` müssen zusammenbleiben. Die INO-Datei öffnen und auf den Uno laden.
2. Seriellen Monitor auf **115200 Baud** stellen, alte Ausgabe leeren, RESET drücken.
   Erwartet: `BOOT | Mini Casino v6` und `MODUS | EINMAL PRO UID`.
3. **Jede bereits aufgeladene Karte einmal erfolgreich lesen lassen.** Auf dem
   LCD bleibt ihr Guthaben erhalten. Im Log muss `UID dauerhaft registriert`
   stehen. Es darf keine `WRITE`-Zeile für diese Karte geben.
4. Karte entfernen, wieder auflegen und nach einem Neustart erneut prüfen.
   Das Guthaben bleibt unverändert; auch die UID-Merkliste bleibt erhalten.

Die Übernahme funktioniert nur, wenn ein gültiger Casino-Datensatz gelesen wird.
V6 kennt keine früheren Aufladungen einer Karte, die schon vor ihrer ersten
Registrierung gelöscht wurde. Eure Karten deshalb zuerst mit vorhandenem Guthaben
einlesen. Die UID selbst wird nicht verändert.

## Dauerhafte Merkliste

Das Guthaben liegt auf dem Transponder. Im internen EEPROM des Uno steht zusätzlich,
welche UID bereits verwendet wurde. Es passen **63 UIDs** mit 4, 7 oder 10 Bytes
hinein. Die Länge gehört zum Vergleich. Es werden keine Einträge verdrängt.

Vor einem ersten Schreibbefehl wird die UID dauerhaft reserviert und zurückgelesen.
Erst danach schreibt der Reader den Datensatz. Nach identischem Rücklesen aller
16 Bytes wird der Eintrag bestätigt. Bis zu drei Schreibversuche innerhalb dieses
Vorgangs betreffen denselben Datensatz und dieselbe UID.

Nach einem Abbruch bleibt die Reservierung bestehen. Beim nächsten Auflegen:

| Karteninhalt / Liste | Verhalten |
|---|---|
| Gültiger Casino-Datensatz | Guthaben anzeigen; Reservierung bestätigen. |
| Kein gültiger Datensatz, UID bereits bestätigt | `Schon aufgeladen` / `Keine Neuauflad.` |
| Kein gültiger Datensatz, UID noch reserviert | `Aufladung offen` / `Keine Neuauflad.` |
| Neue UID, freigegebener leerer Bereich, Listenplatz vorhanden | Reservieren, 100 schreiben, zurücklesen. |
| Neue UID, Liste voll | `UID-Liste voll` / `Nicht aufgeladen` |
| Unbekannter/beschädigter EEPROM-Inhalt | Neue Aufladungen sperren; gültiges Kartenguthaben weiterhin lesen. |

**Eine fehlgeschlagene Erstaufladung kann damit gesperrt bleiben, obwohl keine
vollständigen 100 Punkte gespeichert wurden.** Das ist die bewusste Entscheidung
gegen doppelte Startaufladungen bei unklarem Ausgang. Der Sketch enthält keine
automatische Reparatur oder Freigabe solcher UIDs. Die Merkliste ist kein Backup
des Guthabens; ein mit NFC Tools gelöschter Punktestand wird nicht wiederhergestellt.

Die Zusage gilt für diesen Uno mit erhaltener Merkliste. Ein anderer Arduino,
gelöschtes EEPROM oder ein alter FORCE-Sketch können sie umgehen. Die Liste ist
keine gemeinsame Datenbank mehrerer Reader und kein Schutz gegen gefälschte UIDs.

## EEPROM-Aufbau

Der Sketch beansprucht den gesamten 1024-Byte-EEPROM des klassischen Uno.
Bytes 0–15 enthalten eine Formatkennung. Danach folgen 63 Einträge zu je 16 Bytes:

| Offset im Eintrag | Inhalt |
|---|---|
| 0 | Gültigkeitsmarker `C6`, zuletzt geschrieben |
| 1 | UID-Länge: 4, 7 oder 10 |
| 2–11 | UID, verbleibende Bytes mit 0 aufgefüllt |
| 12–13 | CRC-16/CCITT-FALSE über Offset 1–11, niedrigstes Byte zuerst |
| 14 | `5A` reserviert oder `A5` bestätigt |
| 15 | Eintragsversion 1 |

Ein fehlender Header wird nur bei vollständig `FF` oder vollständig `00`
gefülltem EEPROM neu angelegt. Fremder Inhalt wird nicht automatisch gelöscht.
Beschädigte Einträge verhindern neue Reservierungen. Bereits bekannte, intakte
Einträge bleiben erkennbar. Wiederholtes Lesen einer bereits bestätigten Karte
ändert keine EEPROM-Zellen: `EEPROM.update()` schreibt nur geänderte Werte.
Siehe [Arduino-EEPROM-Dokumentation](https://github.com/arduino/ArduinoCore-avr/blob/master/libraries/EEPROM/README.md).

## Ruhigere Erkennung und Log

- Einzelne REQA-/UID-Auswahlfehler bleiben im Log und lassen die LCD-Anzeige stehen.
- Nach drei Fehlern mit höchstens fünf Sekunden Abstand wird das Antennenfeld
  kurz neu gestartet. Bei weiterlaufender Serie wiederholt sich diese Erholung
  nach jeweils drei Fehlern.
- Ein Hinweis `Karte ruhig` / `auflegen` erscheint höchstens einmal pro Fehlerfolge,
  sobald keine Ergebnisanzeige mehr läuft. Ein erfolgreicher Scan oder mehr als
  fünf Sekunden Abstand zwischen Fehlern beginnt eine neue Folge.
- Die LCD-Zeilen werden überschrieben und mit Leerzeichen aufgefüllt; der
  Hauptsketch verwendet kein `lcd.clear()` mehr.
- `LIVE` zeigt alle fünf Sekunden zusätzlich `Erkennungsfehler`. Das zählt Fehler
  bei REQA und UID-Auswahl, nicht fehlgeschlagene Speicherzugriffe.
- Lese-/Schreibfehler werden weiter gemeldet. Fehlerhafte CRCs werden niemals
  als gültige Daten oder leere Karten akzeptiert.

REQA-Timeouts entstehen auch ohne neue Karte oder bei einer bereits angehaltenen
Karte im Feld. Die Zahl allein beschreibt daher keine Funkfehlerquote.
V6 verbessert Fehlerbehandlung und Anzeige; eine elektrische Ursache ist damit
nicht nachweislich behoben. Bei anhaltenden Fehlern einen einzelnen Tag ruhig
auflegen, Smartphone/weitere Tags aus dem Feld nehmen und kurze feste Leitungen
sowie die 3,3-V-Versorgung prüfen. Diese Punkte nennt auch die
[MFRC522-Fehlersuche](https://github.com/miguelbalboa/rfid#troubleshooting).

Euer letzter Log mischt v4 mit 9600 Baud und spätere Ausgaben. V6 verwendet
**115200 Baud**. Eine abweichende Monitor-Einstellung kann die Sonderzeichen
erklären; sie beweisen allein keinen Kartenfehler. Wiederholtes `BOOT` kann durch
Upload, RESET oder Öffnen des Monitors entstehen. Ohne solche Aktionen wäre ein
ungeplanter Neustart weiter zu untersuchen.

## Prüfstand

V6 wurde für den ATmega328P kompiliert und gelinkt. Zusätzlich laufen die Tests
in `tests/empty_region_test.cpp` und `tests/uid_registry_test.cpp` gegen die
tatsächlich verwendeten C++-Funktionen. Sie prüfen unter anderem Neustart,
Reservierung, Bestätigung, volle Liste, verschiedene UID-Längen, beschädigte
Einträge und unterbrochenes EEPROM-Schreiben. Sie ersetzen keinen Hardwaretest.
Eure erfolgreiche Aufladung aller Karten ist bestätigt; die neue V6 ist noch
nicht auf euren Uno geladen oder am Aufbau geprüft worden.
