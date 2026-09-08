> Historische Anleitung ausschließlich zum alten V5-Archiv. Der aktuelle Sketch ist V6 ohne FORCE. Siehe [BETRIEB_V6.md](BETRIEB_V6.md).

# V5: Überschreiben aktiviert

Den vollständigen Ordner **MiniCasino** mit `MiniCasino.ino` und `EmptyRegion.h`
übernehmen, den Sketch hochladen und den seriellen Monitor auf **115200 Baud**
stellen. Nach RESET erscheint `Mini Casino v5` und `MODUS | FORCE`.

Auf euren ausdrücklichen Wunsch setzt dieser Modus **jede verarbeitete Karte auf
100 Punkte**, unabhängig von vorhandenem Guthaben, fremden Daten oder einer
Teilschreibung. Er schreibt nur **Classic-Block 4** bzw. **Ultralight-Seiten 4–7**.
Herstellerdaten, Schlüssel, Sperr-/Konfigurationsbereiche und alle anderen
Blöcke/Seiten bleiben unverändert. Unbekannte Schlüssel oder Schreibsperren
werden nicht umgangen. Unbekannte Kartentypen werden abgelehnt.

## Was sich geändert hat

- FORCE überspringt Leerheits-, NDEF-, Nachbarblock- und Vorab-Leseprüfungen.
- Lesen und Schreiben haben jeweils höchstens **drei Versuche**. Vor einer
  Wiederholung wird dieselbe UID neu ausgewählt und bei Classic angemeldet.
  UID, UID-Länge und SAK müssen passen, sonst wird nicht weitergeschrieben.
- Nach fehlendem Schreib-ACK wird trotzdem derselbe Tag erneut ausgewählt und
  ausgelesen: Die Daten könnten trotz verlorener Antwort geschrieben worden sein.
- Erfolg erfordert immer gültige Übertragungs-CRC und **16 identische Sollbytes**
  beim Rücklesen. Fehlerhafte Antworten werden nicht als Erfolg behandelt.
- Ultralight schreibt Seiten 5, 6, 7 und zuletzt 4 ohne serielle Pausen dazwischen.
  Die Statusmeldungen folgen danach.
- REQA/Wakeup und SELECT folgen ohne Log-Ausgaben dazwischen aufeinander.
- Nach bestimmten Erkennungs-/Wake-Fehlern wird das Lesefeld kurz aus-/eingeschaltet.
- **115200 statt 9600 Baud** verkürzt die blockierende Logausgabe.

Wiederholungsversuche können mehrere Sekunden dauern. Eine Karte allein ruhig
liegen lassen. Bei endgültigem Fehler erneut auflegen; FORCE kann auch eine
verbliebene Teilschreibung durch einen vollständigen Datensatz ersetzen.
Diese Maßnahmen garantieren keine stabile Funkverbindung bei einem Hardwareproblem.

## Erfolg erkennen

```text
VERIFY | Alle 16 Bytes stimmen. Speicherung bestaetigt.
GUTHABEN | Neu gespeichert und geprueft: 100
```

LCD: `Neu aufgeladen!` / `100 Pkt`. `Nicht bestaetigt` heißt: Die abschließende
Kontrolle ist fehlgeschlagen; trotzdem können Teile oder alle Daten geschrieben sein.

## Nach dem Einrichten: Normalbetrieb

Im Sketch ändern und neu hochladen:

```cpp
#define CASINO_FORCE_OVERWRITE 0
```

`MODUS | NORMAL` bedeutet: Gültiges vorhandenes Guthaben bleibt erhalten, auch 0;
nur freigegebene leere Bereiche erhalten Startguthaben. Die Wiederholungsversuche
bleiben aktiv. `DEBUG_LOG = false` schaltet die Diagnoseausgabe ab.

## In eurem v4-Log bereits bestätigt

- Classic `DF 51 AA 39`: **100 Punkte gelesen**; die Erstellung ist im Ausschnitt
  nicht enthalten.
- Ultralight `04 9F 90 5C 11 01 89`: bei 26,96 Sekunden **100 Punkte geschrieben
  und geprüft**; bei 32,62 und 152,59 Sekunden wieder gelesen.
- Ultralight `04 7C 65 5C 11 01 89`: Teilschreibungen ohne vollständige MCAS-Kennung;
  vollständige Speicherung bisher nicht bestätigt.
- Weiterhin viele Kommunikationsfehler. Die Ursache ist aus dem Log nicht exakt
  bestimmbar. Ein einzelner ruhiger Tag, Abstand zu anderen Tags/NFC-Handys,
  kurze feste Leitungen und korrekte 3,3-V-Versorgung bleiben wichtig.

## Prüfung von v5

`python pruefen.py` kompiliert FORCE; `python pruefen.py --normal` den Normalmodus.
Die bisherigen 27 Prüfungen der Leer-/NDEF-Erkennung laufen mit. Sie prüfen keine
Funkverbindung und keine tatsächliche Retry-/Schreibausführung. V5 muss am Aufbau
getestet werden: FORCE-Erfolg, danach NORMAL mit erneutem Lesen und nach Neustart.
