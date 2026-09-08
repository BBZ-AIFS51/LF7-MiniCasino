# Mini Casino V8 – Lauflicht und seltenes Grün

**Ergänzung V9:** Die Spielregeln und Pins hier gelten weiter. Ton ist jetzt
im Hauptsketch eingeschaltet. Für den aktuellen Anschluss und Modus gilt
[SOUND_V9.md](SOUND_V9.md); die frühere Angabe „deaktiviert“ weiter unten ist überholt.

## Spiel und Animation

Eine Taste wählt Schwarz, Rot oder Grün und setzt 10 Punkte. Die neue Ziehung
verwendet 100 mögliche Lose:

| Farbe | Lose | Chance | Auszahlung bei Treffer |
|---|---|---|---|
| Schwarz | 0–44 | 45 % | 20 Punkte |
| Rot | 45–89 | 45 % | 20 Punkte |
| Grün | 90–99 | 10 % | 90 Punkte |

Grün ist seltener und zahlt den neunfachen Einsatz aus. Bei 100 Punkten führt
ein Treffer auf Schwarz/Rot zu 110, ein Treffer auf Grün zu 180 und eine
Niederlage zu 90. Die Auszahlung enthält den zuvor abgezogenen Einsatz:
Grün bedeutet also 80 Punkte Nettogewinn, Schwarz/Rot je 10 Punkte.
Unter 10 Punkten startet keine Runde.
Die Auszahlungen sind auf denselben durchschnittlichen Rückfluss abgestimmt:
45 % × 20 = 10 % × 90 = 9 Punkte je 10 Punkte Einsatz.
Die Prozente beschreiben die vorgesehene Zufallsverteilung; kurze Serien können
stark davon abweichen.

Die LED-Reihenfolge lautet Schwarz → Rot → Grün → Schwarz. Das Lauflicht
beginnt an einer zufälligen Position, läuft 24–26 Schritte und bremst von
45 auf 500 Millisekunden pro Schritt ab. Es dauert ungefähr fünf Sekunden.
Die letzte LED entspricht immer dem bereits gezogenen Ergebnis. Sie bleibt
an, bis eine neue Runde beginnt oder eine Karte neu eingelesen wird.
Es leuchtet immer höchstens eine LED. Ein neues Ergebnis wird während des
Lauflichts nicht gezogen; zusätzliche Tastendrücke werden nicht angenommen.

## Drei einzelne LEDs anschließen

Diese Verdrahtung gilt für gewöhnliche **zweibeinige Einzel-LEDs**.
Vor dem Umstecken USB/Strom trennen. Jede LED braucht einen eigenen
**330-Ohm-Vorwiderstand**. Den vorhandenen LCD-Widerstand unverändert lassen.

| Anzeige | Anschluss |
|---|---|
| LED für Schwarz | A3 → 330 Ω → Anode (+); Kathode (−) → GND |
| LED für Rot | A4 → 330 Ω → Anode (+); Kathode (−) → GND |
| LED für Grün | A5 → 330 Ω → Anode (+); Kathode (−) → GND |

```text
Uno A3 ──[330 Ω]── Anode  LED „Schwarz“  Kathode ── GND
Uno A4 ──[330 Ω]── Anode  LED Rot        Kathode ── GND
Uno A5 ──[330 Ω]── Anode  LED Grün       Kathode ── GND
```

Bei üblichen neuen LEDs ist das lange Bein die Anode; das kurze Bein und die
abgeflachte Gehäuseseite kennzeichnen normalerweise die Kathode. Bei gekürzten
Beinen die Kennzeichnung beziehungsweise einen Diodentest verwenden.
Für das Feld Schwarz könnt ihr beispielsweise eine weiße oder gelbe LED benutzen;
die Zuordnung wird durch A3 festgelegt. Eine „schwarz leuchtende LED“ braucht ihr nicht.

Nicht alle drei LEDs an einen gemeinsamen Widerstand anschließen. Die Kathoden
dürfen sich dieselbe GND-Schiene teilen. Diese Schiene mit Arduino GND und den
bisherigen GND-Schienen verbinden. Drei LEDs bedeuten nicht drei separate GND-Pins.
Das grundsätzliche Prinzip LED plus Vorwiderstand zeigt auch
[Arduinos Blink-Beispiel](https://docs.arduino.cc/built-in-examples/basics/Blink/).

Falls eure LEDs mehr als zwei Pins oder bereits eine Modulplatine haben, gilt
diese Pinbelegung nicht automatisch; dann zuerst deren Beschriftung prüfen.

## Vollständige Uno-Belegung

| Uno-Pins | Funktion |
|---|---|
| D0/D1 | USB-Seriell und Upload; keine zusätzliche Beschaltung |
| D2 | Speaker-/Buzzer-Signal reserviert, weiterhin deaktiviert |
| D3–D8 | LCD wie bisher |
| D9–D13 | RC522 wie bisher |
| A0 | Schwarze Schließertaste nach GND, INPUT_PULLUP |
| A1 | Rote Schließertaste nach GND, INPUT_PULLUP |
| A2 | Grüne Schließertaste nach GND, INPUT_PULLUP |
| A3 | LED für Schwarz über eigenen 330-Ω-Widerstand |
| A4 | Rote LED über eigenen 330-Ω-Widerstand |
| A5 | Grüne LED über eigenen 330-Ω-Widerstand |

**Der Aufbau passt genau auf den Uno.** Mit dem reservierten Ton-Ausgang sind
jetzt alle zusätzlichen Ein-/Ausgänge verplant. A4/A5 stehen deshalb nicht
gleichzeitig für ein weiteres I2C-Gerät zur Verfügung. Für spätere Erweiterungen
müsste man Pins neu aufteilen oder zusätzliche Hardware nutzen; für V8 ist das
nicht nötig.

A3 ist nun ein LED-Ausgang. Die bisherige Zufallsstartwert-Abfrage über
`analogRead(A3)` wurde vollständig entfernt. Der Pseudozufallszustand wird mit
dem Zeitpunkt des Tastendrucks gemischt. Dieser Generator ist nicht für einen
manipulationssicheren Echtgeldbetrieb ausgelegt.

Der 3-Pin-Speaker bleibt unverbunden, bis Modell, Pinbeschriftung und passende
Versorgung feststehen. D2 bleibt frei von LEDs, damit sein geplanter Anschluss
möglich bleibt. `CASINO_SOUND_MODE` ist weiterhin 0.

## Ablauf und Guthabenschutz

1. Karte auflegen und liegen lassen; Farbtaste kurz drücken.
2. Guthaben und UID frisch prüfen. Ohne mindestens 10 Punkte kein Spiel.
3. Ergebnis einmalig gewichtet ziehen.
4. Einsatz und festes Ergebnis als offene Runde auf der Karte speichern und
   zurücklesen; anschließend den endgültigen Kartenstand speichern und prüfen.
5. **Erst nach bestätigter Buchung** das Lauflicht abspielen und auf dem
   gezogenen Ergebnis anhalten. Anschließend zeigt das LCD Gewinn/Verlust und Guthaben.

Damit findet während des Lauflichts keine Guthabenbuchung statt. Ein Reset
während der Animation macht die bereits bestätigte Buchung nicht rückgängig
und erzeugt auch keine zweite Auszahlung. Die Animation wird nach Reset nicht
nachträglich abgespielt; die Karte enthält ihren fertigen Endstand.

Schlägt das Schreiben davor fehl, erscheint Runde offen. Dieselbe Karte erneut
auflegen oder eine Taste drücken setzt den bestehenden Vorgang fort, ohne neue
Ziehung oder zusätzlichen Einsatz. Eine gültige offene Runde überlebt auch
einen Neustart. Eine beschädigte Mehrseiten-Schreibung zusammen mit Stromausfall
kann dagegen weiterhin nicht automatisch wiederhergestellt werden. Diese Grenze
der Kartenspeicherung bleibt bestehen.

V6-/V7-Guthaben und die einmalige Aufladung pro UID bleiben kompatibel. Die
EEPROM-Liste bleibt unverändert. Abgeschlossene Guthaben behalten MCAS-Version 1.
Neue offene Runden verwenden MCAS-Version 3 und speichern in Byte 13 zusätzlich
den Auszahlungsfaktor: 2 bei Schwarz/Rot, 9 bei Grün. Die übrigen Felder stimmen
mit der offenen Version 2 überein; der Faktor gehört zur CRC-Prüfung.
Beim Fortsetzen wird dieser gespeicherte Faktor verwendet.

Eine noch offene V7-Runde (Kartenformat Version 2) behält das bisherige Ergebnis
und die bisherige Auszahlung von 20 Punkten auch für Grün. Nur neue Runden
verwenden 45/45/10 und die höhere Grün-Auszahlung. V7 kann neue offene
Version-3-Runden nicht fortsetzen; dafür V8 benutzen.

## Installation, Dateien und Prüfung

Den vollständigen Ordner MiniCasino mit allen sieben Dateien übernehmen und
MiniCasino.ino auf den Uno laden. Monitor bei Bedarf auf **115200 Baud** stellen;
BOOT muss **Mini Casino v8** zeigen. Die bestehenden Bibliotheken bleiben gleich.

Die Chancen und die Berechnung des Lauflichts stehen in `GameRules.h`, die
LED-Pins und Ausgabe in `GameRuntime.h`. Die übrigen Dateien bleiben zuständig
für RFID, Kartenformat, Tasten und UID-Merkliste. LCD-/RFID-Anschlüsse stehen in
[ANLEITUNG.md](ANLEITUNG.md), die Merkliste in [BETRIEB_V6.md](BETRIEB_V6.md).

Lokal geprüft: Uno kompiliert und gelinkt; alle bisherigen Logikprüfungen plus
sämtliche 100 Lose und alle neun Kombinationen aus Start- und Zielfarbe des
Lauflichts. Die Tests prüfen auch zunehmende Verzögerungen und das passende
letzte Licht ohne nachträglichen Sprung. Zusätzlich werden die 90-Punkte-Auszahlung,
Überlaufgrenzen und die unveränderte Auszahlung alter offener Runden geprüft.
Programm: 20.172 Byte, statischer RAM:
465 Byte. Der neue LED-Aufbau wurde nicht am realen Arduino getestet.

Am Aufbau prüfen: LED-Polarität, passende LED zum LCD-Ergebnis, Gedrückthalten
ohne Folgerunden, Guthaben nach Gewinn/Verlust und unveränderten Stand nach Reset.
