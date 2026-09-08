# Prüfung V8

Aktueller Build: Uno kompiliert/gelinkt, 20.172 Byte Programm und 465 Byte
statischer RAM. Zusätzlich bestehen die Tests für alle 100 gewichteten Lose,
alle neun Start-/Zielkombinationen des Lauflichts, zunehmende Wartezeiten und
das passende letzte Licht. Die bisherigen Karten-, UID- und Tastentests bestehen.
Grün zahlt nun 90 aus; Tests prüfen neue Version-3-Runden und die weiterhin
20 auszahlenden alten Version-2-Runden. Der LED-Aufbau ist noch nicht auf Hardware geprüft.

Aktuelle Beispiele: 100 Startpunkte → Schwarz/Rot gewonnen: 110, Grün gewonnen:
180, verloren: 90. Bei Einsatz des letzten Guthabens von 10 → Grün gewonnen: 90.
Die weiter unten dokumentierten V7-Grün-Auszahlungen gelten nur für alte Runden.

Am Aufbau: jede LED am vorgesehenen Pin mit eigenem Vorwiderstand, passende
Endfarbe, kein Folgespiel durch Halten, Guthaben unverändert nach Reset während
der Animation. Neue Verteilung: Schwarz 45 %, Rot 45 %, Grün 10 %; keine Garantie
für entsprechende Häufigkeiten in einer kurzen Testserie.

## Weitergeltende Tests / dokumentierter V7-Prüfstand

# Testplan V7

Vom Nutzer bestätigt: LCD, Reader-Firmware 0x88 und inzwischen Aufladung aller
verwendeten Transponder. V7 ist lokal für den Uno kompiliert und gelinkt,
aber noch nicht hochgeladen oder am Aufbau geprüft.

## Am Aufbau prüfen

Den ganzen Ordner MiniCasino laden. Monitor: **115200 Baud**.

| Fall | Erwartung |
|---|---|
| Ohne Karte starten | BOOT v7, UID-LISTE bereit, Karte auflegen, LIVE alle fünf Sekunden |
| Aufgeladene Karte erstmals mit V7 lesen | Guthaben unverändert; UID dauerhaft registriert; keine WRITE-Zeile |
| Dieselbe Karte erneut lesen, auch nach Reset | Guthaben unverändert; keine WRITE-Zeile |
| Gültige Testkarte mit 0 oder 42 Punkten | Vorhandenen Stand anzeigen, keine Aufladung auf 100 |
| Neue UID, freigegebener leerer Bereich | Reservierung, WRITE, VERIFY, 100 Punkte |
| Registrierte UID mit anschließend gelöschtem Kartenbereich | Schon aufgeladen / Keine Neuauflad.; kein WRITE |
| Abgebrochene Erstaufladung | Reservierung bleibt; nächster Scan liest gültigen Stand oder meldet Aufladung offen |
| Unbekannte UID mit fremden aktiven Daten | Speicher belegt; kein WRITE |
| Classic: Nullbytes in Block 4, Daten in Block 5/6 | Sektor belegt; kein WRITE |
| Anmeldung oder READ fehlgeschlagen | Fehlermeldung; keine Aufladung auf Verdacht |
| Einzelner REQA-/SELECT-Fehler | Logeintrag; LCD bleibt unverändert |
| Drei Erkennungsfehler mit höchstens fünf Sekunden Abstand | RF RECOVERY; einmaliger Hinweis, sobald keine Ergebnisanzeige läuft |
| Keine neue Karte oder bereits angehaltene Karte | REQA-Timeouts ohne LCD-Fehlermeldung |
| DEBUG_LOG false | LCD bleibt funktionsfähig; keine serielle Ausgabe |

Lösch-/Abbruchfälle nur mit entbehrlichen eigenen Testkarten prüfen. Die Liste
stellt verlorenes Guthaben nicht wieder her und gibt reservierte UIDs nicht
automatisch frei. Das gilt auch bei noch intakter leerer NDEF-Struktur nach Abbruch.

## Automatisierte Prüfungen

`python pruefen.py` kompiliert Hauptsketch, Bibliotheken und Core und linkt für
den Uno. Zusätzlich prüfen 27 static_assert-Fälle in empty_region_test.cpp die
tatsächliche Leerheits-/NDEF-/CC-Erkennung. Sechs Szenarien in uid_registry_test.cpp
führen die Registry-Methoden mit einem EEPROM-Modell aus: Reservierung,
Bestätigung, Neustart, keine weiteren EEPROM-Schreibzugriffe bei Wiederholung,
UID-Längen, volle Liste ohne Verdrängung, unbekannte Daten, beschädigter Eintrag,
unterbrochener Commit und werkseitig gelöschter Speicher.

Die Registry-Tests nutzen C++14 zur Compilezeit-Ausführung; das Produktionsprogramm
bleibt C++11. Sie simulieren keine Funkübertragung oder sämtliche elektrischen
Folgen einer instabilen Versorgung. V7 muss nach Upload am Aufbau geprüft werden.

## Zusätzliche Spieltests V7

| Aktion | Erwartung |
|---|---|
| Karte mit 100 lesen, Taste drücken, Verlust | Karte enthält 90 |
| Karte mit 100 lesen, Taste drücken, Treffer | Karte enthält 110: 10 Einsatz, 20 Auszahlung |
| 10 Punkte, Verlust / Gewinn | 0 / 20 Punkte |
| Weniger als 10 Punkte | Zu wenig Punkte; kein WRITE |
| Taste beim Start oder lange während/nach Spiel halten | Keine automatischen Folgerunden |
| Zwei Tasten gemeinsam drücken | Keine Runde; erst alle loslassen |
| Karte nach Lesen entfernen, Taste drücken | Kein Einsatz ohne bestätigte gleiche Karte |
| Andere UID vor einer Spielbuchung auflegen | Kein Schreiben auf die andere UID |
| Funkunterbrechung während Runde, gleiche Karte erneut auflegen | Gleiche Zielwerte; keine erneute Ziehung/kein zusätzlicher Einsatz |
| Andere Karte während offener Runde | Keine neue Runde; zuerst offene Runde abschließen |
| Neustart mit gültigem offenem V2-Datensatz auf Karte | RECOVER beendet dieselbe Runde |
| Gültiger abgeschlossener Endstand, erneut auflegen | Keine erneute Auszahlung |
| Beschädigter V2-Datensatz nach Reset | Gesperrt; keine neue Startaufladung |

Gezielte Abbruchtests nur auf entbehrlichen Testkarten. Bei beschädigter
Mehrseiten-Schreibung plus Reset kann automatische Wiederherstellung unmöglich
sein. Eine physische Kartenverbindung wurde durch die lokalen Tests nicht simuliert.

`tests/game_test.cpp` prüft zusätzlich Gewinn/Verlust, Unterdeckung/Überlauf,
gleiche Regeln für alle Farben, V6-Formatkompatibilität, offenen Gewinn/Verlust,
beschädigte Datensätze, Tasterprellen, Gedrückthalten, Mehrfachtasten und millis-
Überlauf. Die Methoden werden tatsächlich zur Compilezeit ausgeführt.

Alle drei Builds wurden erfolgreich kompiliert/gelinkt: ohne Ton, passives
Piezo-Modul und aktiver Buzzer. Standard ohne Ton: 19.620 Byte Programmspeicher,
461 Byte statischer RAM. Stack/Laufzeitspitzen sind darin nicht enthalten.
Das ist keine Bestätigung der Kompatibilität des noch unbekannten Tonmoduls.

## Tonintegration V9

Der Hauptsketch schaltet Ton standardmäßig für einen passiven Buzzer ein.
`python pruefen.py` übernimmt diese Einstellung aus der Hauptdatei; die
Optionen `--sound 0` und `--sound 2` prüfen die alternativen Modi.

`tests/sound_test.cpp` prüft zur Compilezeit gültige Tonhöhen, positive
Notendauern, eine maximale Jingle-Dauer von drei Sekunden und die Zuordnung
von Gewinn, Verlust und Jackpot. Die vorhandenen Karten-, Registry- und
Spieltests laufen mit. Der Standardbuild belegt 22.190 Byte Flash und
488 Byte statischen RAM, der aktive Buzzer-Modus 20.676 Byte und 471 Byte.
Alle drei Tonmodi wurden erfolgreich kompiliert und gelinkt. Ton aus belegt
20.246 Byte Flash und 465 Byte statischen RAM.
Stack und Laufzeitspitzen sind nicht enthalten. Kein Upload oder Hörtest
wurde von Codex durchgeführt.

Am echten Aufbau noch prüfen:

| Aktion | Erwartung |
|---|---|
| Runde starten | Ein kurzer Tick je LED-Wechsel; Abstände werden länger |
| Schwarz/Rot gewonnen | Level-up nach bestätigter Auszahlung |
| Verloren, auch bei grünem Ergebnis und falscher Wahl | Womp-womp, kein Jackpot |
| Grün gewählt und gewonnen | JACKPOT! GRUEN und Fanfare; netto +80 |
| Taste während des Jingles halten | Keine zusätzliche Runde; erst loslassen |
| Funkfehler vor bestätigter Buchung | Kein Ergebnis-Jingle für unbestätigte Auszahlung |
