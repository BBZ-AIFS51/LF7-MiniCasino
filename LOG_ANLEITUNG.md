# Diagnose V9

Die Bedienung erfolgt am LCD. DEBUG_LOG aktiviert zusätzlich die serielle
Ausgabe. Ein geöffneter Monitor ist nicht zum Betrieb erforderlich.

## Sauberen Log aufnehmen

1. Ganzen Sketch-Ordner mit allen sieben Header-Dateien laden.
2. Monitor auf **115200 Baud** stellen, alte Ausgabe leeren und RESET drücken.
3. Erwartet: Mini Casino v10, EINMAL PRO UID, UID-LISTE bereit und Firmware=0x88.
4. Fünf Sekunden ohne Karte warten, dann einen einzelnen Tag ruhig auflegen.
5. Den Abschnitt SCAN bis ENDE einschließlich UID-LISTE betrachten.

V9 meldet nach einer abgeschlossenen Buchung und dem Lauflicht zusätzlich
`SOUND | WIN: Level-up.`, `SOUND | LOSS: Womp-womp.` oder
`SOUND | JACKPOT: Fanfare + 8-Bit-Abschluss.`. JACKPOT gilt nur für einen
Gewinn auf Grün mit 90 Punkten Auszahlung. In Tonmodus 0 gibt es kein SOUND-Log.

Euer letzter Log mischt alte v4-Ausgaben mit 9600 Baud, Neustarts und unlesbare
Zeichen. Eine falsche Monitor-Baudrate kann diese Zeichen erklären. V9 benötigt
115200. BOOT nach Upload, RESET oder Öffnen des Monitors ist erklärbar. Ohne
solche Aktionen wären ungeplante Neustarts beziehungsweise Versorgung zu prüfen.

## Kennungen

| Kennung | Bedeutung |
|---|---|
| BOOT / MODUS | Version, Betriebsart und Millisekunden seit Start |
| UID-LISTE | EEPROM bereit, UID registriert/reserviert oder Sperrgrund |
| RFID | Reader-Firmware; 0x88 ist euer Clone |
| LIVE | Abfragen, REQA-Timeouts, Scans, Erkennungsfehler und Firmware alle fünf Sekunden |
| SCAN | Anfrage mit anderer Antwort als Timeout; noch kein erfolgreicher Scan |
| REQA / ATQA | Status der Anfrage / Antwortbytes |
| SELECT UID / UID | Auswahlstatus / Kennung der ausgewählten Karte |
| RF RECOVERY | Antennenfeld nach mehreren Fehlern kurz neu gestartet |
| TYPE / AUTH | Kartentyp / Classic-Anmeldung mit Standard- oder öffentlichem NDEF-Key |
| RETRY WAKE / RETRY SELECT | Neue Sitzung mit derselben UID; Kartenwechsel wird abgelehnt |
| READ / READ RETRY / DATA 16 Bytes | Lesen, Wiederholungsversuch, fehlerfrei gelesene Nutzbytes |
| FORMAT / BELEGT / NDEF / NDEF REST | Formatprüfung und Leerheitsentscheidung |
| PRECHECK | Ausgangsdaten nicht stabil lesbar; kein Schreiben |
| WRITE VERSUCH / WRITE Soll-Daten / WRITE | Versuch, gewünschte Daten und Schreibstatus |
| VERIFY | Nur „Alle 16 Bytes stimmen“ bestätigt die Speicherung durch Rücklesen |
| GUTHABEN / LCD | Vorhandener oder bestätigter neuer Stand / angezeigte Textzeilen |
| KONTO | Konto geladen, neu angelegt, gesperrt abgewiesen oder als unklar gemeldet |
| SPIEL | Auflösung mit Wahl, Ergebnis, Auszahlung und neuem Guthaben |
| SITZUNG | Sitzung beendet: Zeit abgelaufen oder von Hand über Rot halten |
| TON | Lautstärkestufe laut/leise/aus und ob sie im EEPROM gespeichert wurde |
| EINSATZ | Einsatz geändert, gespeichert oder wegen zu wenig Guthaben gekürzt |
| NACHLADEN / EEPROM | Konten aufgefüllt / gesamter EEPROM-Bereich gelöscht |
| HALT / ENDE | Abschluss; zum erneuten Lesen Karte entfernen und auflegen |

## Funkqualität beurteilen

`REQA | Status=3 (Timeout)` heißt **keine Karte im Feld** und ist der Normalfall.
`Status=1 (Error in communication.)` ist etwas anderes: da antwortet eine Karte,
aber zu schwach für eine saubere Übertragung. Viele solcher Zeilen bedeuten ein
Reichweiten- oder Versorgungsproblem, kein Software-Problem.

Seit V10 gegengesteuert wird so:

- **Volle Empfangsverstärkung** (48 dB statt 33 dB). Der Start meldet
  `RFID | Antennengewinn=0x70`.
- **Drei schnelle Versuche je Durchlauf** statt einem. Ein einzelner Funkfehler
  übersieht keine aufliegende Karte mehr.
- **WUPA statt REQA.** Damit wird auch eine Karte erkannt, die nach dem letzten
  Lesen angehalten wurde und einfach liegen geblieben ist.
- **Nach einem Funkfehler nur 120 ms Pause** statt einer vollen Sekunde. Die
  Sekunde gilt nur noch nach einer erfolgreich gelesenen Karte.

Bleibt es trotzdem zäh, ist es Hardware: siehe Versorgung und Verkabelung in
[ANLEITUNG.md](ANLEITUNG.md).

REQA-Timeouts sind ohne neue Karte und bei angehaltenen Karten normal. Sie sind
**keine Funkfehlerquote**. Erkennungsfehler zählt unerwartete REQA-/SELECT-Fehler;
READ-/WRITE-Fehler stehen separat im Log. Einzelne Erkennungsfehler ändern das
LCD nicht. Erst eine Serie führt zur Felderholung und gegebenenfalls zum Hinweis
Karte ruhig / auflegen. Alle Datenprüfungen bleiben aktiv.

## Eine Runde im Log

Nur das erste Auflegen erzeugt überhaupt RFID-Zeilen. Danach laufen Runden ohne
Karte und erzeugen je genau eine Zeile:

```text
SCAN 1 ... SELECT UID ... UID | DF 51 AA 39
KONTO | Bekannte UID; Guthaben aus dem EEPROM geladen.
GUTHABEN | Vorhanden: 100
SPIEL | Wahl=ROT Ergebnis=ROT Einsatz=10 Auszahlung=20 Guthaben=110
SPIEL | Wahl=GRUEN Ergebnis=SCHWARZ Einsatz=10 Auszahlung=0 Guthaben=100
SITZUNG | Zeit abgelaufen. Zum Weiterspielen Karte erneut kurz auflegen.
```

Es gibt keine READ-, WRITE- oder VERIFY-Zeilen mehr: der Kartenspeicher wird
nicht angefasst. Die frühere Classic-Anmeldung (`AUTH`) entfällt ebenfalls.

`SPIEL | EEPROM-Buchung nicht bestaetigt.` heißt, dass die Runde nicht gilt und
der alte Stand unverändert steht. `KONTO | UID bekannt, aber kein lesbares
Konto.` deutet auf einen abgebrochenen allerersten Buchungsversuch hin; das
nächste Auflegen holt die Erstgutschrift nach.

## Einmaliges Startguthaben erkennen

Schon aufgeladene Karten: **UID dauerhaft registriert** und **GUTHABEN | Vorhanden**,
ohne WRITE. Erst nach erfolgreicher Registrierung schützt die Liste eine UID
auch nach Löschen der Karte. Bei neuer leerer Karte muss vor WRITE die dauerhafte
Reservierung stehen. VERIFY bestätigt die Speicherung. Bei unklarem Ausgang
bleibt die Reservierung bestehen; spätere Scans dürfen lesen, aber keine zweite
Erstaufladung beginnen. Liste voll/Fehler bedeutet, dass Registrierung scheiterte.

## Verbleibende Funkfehler

Ihr habt inzwischen das Aufladen aller Karten bestätigt. Die genaue Ursache
der zuvor beobachteten CRC-, Kollisions- und Auswahlfehler steht weiter nicht
fest. Ein Anmeldefehler beweist auch keinen fehlenden Schlüssel.

Einen einzelnen Tag ruhig dicht auflegen, Smartphone und andere Tags entfernen,
kurze feste Leitungen und 3,3-V-Versorgung prüfen; vor Umstecken ausschalten.
Siehe [MFRC522-Fehlersuche](https://github.com/miguelbalboa/rfid#troubleshooting).
Alle Regeln und Grenzen der Liste: [UidRegistry.h](MiniCasino/UidRegistry.h).

## Spiel-Logzeilen in V7

| Kennung | Bedeutung |
|---|---|
| SPIELSTART | Frischer Tastendruck, Einsatz 10, Ergebnis einmalig festgelegt |
| EINSATZ | Abgezogener Einsatz und festes Ergebnis als offene Runde bestätigt |
| SPIEL | Nach bestätigtem Endstand: Wahl, Ergebnis, Einsatz, Auszahlung, Guthaben |
| RUNDE OFFEN | Zielwerte bleiben fest; gleiche Karte erneut auflegen oder Taste drücken |
| RECOVER | Gültige offene Runde auf Karte erkannt; kein neuer Einsatz/keine neue Ziehung |

Das WRITE/Rücklesen-Protokoll gilt sowohl für Erstaufladung als auch für
Spielbuchungen. Beim bloßen Lesen einer abgeschlossenen Karte gibt es weiterhin
kein WRITE. Bei einer offenen Runde kann bereits das Auflegen deren ausstehende
Auszahlung abschließen. Ein bestätigter Gewinn steht erst nach VERIFY im Log.

Im Hexdump einer offenen Runde stehen auch die Ergebnisbytes. Der Diagnosemodus
ist transparent und kein manipulationsgeschützter Casinobetrieb.

## Lauflicht in V8

Die SPIEL-Zeile bestätigt den gebuchten Endstand vor der LED-Animation.
Während der ungefähr fünf Sekunden werden keine weiteren Spiele angenommen.
Neue Ziehungen verwenden Schwarz/Rot/Grün mit 45/45/10 Prozent.
