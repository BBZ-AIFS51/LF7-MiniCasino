# Ton im Hauptprogramm V9

Öffnet `MiniCasino/MiniCasino.ino` in der Arduino IDE und ladet diesen Sketch
auf den Uno. Alle sieben Header bleiben im selben Ordner. Es gibt keinen
zusätzlichen Ton-Sketch zum Einfügen und kein ZIP-Archiv.

## Anschluss

| Modul | Uno |
|---|---|
| S | D2 über einen 330-Ω-Widerstand |
| − | GND |
| Unbekannter mittlerer Pin | Offen lassen |

D2 war für Ton reserviert. LCD, RFID, Taster und LEDs behalten ihre Pins.
Die Beschriftung S/− allein identifiziert euer Modul nicht eindeutig. Dieser
vorsichtige Anschluss eignet sich zum Versuch mit einem einfachen Buzzer-Modul;
ob ein anderes Modul zusätzliche Versorgung braucht, lässt sich erst anhand
seines Typs feststellen. Den unbekannten mittleren Pin nicht auf Verdacht speisen.

## Einstellung direkt in der Hauptdatei

Oben in `MiniCasino.ino` steht bereits:

```cpp
#define CASINO_SOUND_MODE 1
```

| Wert | Funktion |
|---|---|
| 1 – Standard, eingeschaltet | Passiver Buzzer: verschiedene Tonhöhen und Melodien |
| 2 | Aktiver Buzzer: gleicher Rhythmus mit seiner festen Tonhöhe |
| 0 | Ton aus |

Ein aktiver Buzzer kann die Melodie nicht nachspielen. Einfache Buzzer geben
keine MP3s oder gesprochenen Meme-Samples wieder; dafür wäre ein Audioplayer
mit geeignetem Lautsprecher nötig. Die eingebauten Sounds sind eigene kurze
Tonfolgen im 8-Bit-/Meme-Stil.

## Wann welcher Sound läuft

| Ereignis | Sound |
|---|---|
| Jeder LED-Wechsel | Kurzer Tick; wird zusammen mit dem Lauflicht langsamer |
| Gewinn auf Schwarz oder Rot | Aufsteigender Level-up-Jingle |
| Verlust | Absteigendes Womp-womp |
| Auf Grün gesetzt und Grün getroffen | Längere Jackpot-Fanfare, LCD zeigt JACKPOT! GRUEN |

Ein grünes Ergebnis bei einer falschen Farbwahl ist ein Verlust und löst keinen
Jackpot aus. Auszahlung bleibt Schwarz/Rot 20, Grün 90 bei 10 Punkten Einsatz.
Der Jackpot bringt daher netto 80 Punkte. Es gibt keinen zusätzlichen Jackpot-Topf.

Die Tonfolgen stehen in `GameSounds.h` im Flash, die Wiedergabe in
`GameRuntime.h`. Einsatz und Auszahlung werden vor Lauflicht und Jingle
gespeichert und bestätigt. Während der kurzen Tonfolge werden keine weiteren
Runden gestartet; anschließend müssen die Tasten erst losgelassen werden.
Jeder Ergebnis-Jingle dauert höchstens drei Sekunden.

Im optionalen seriellen Monitor mit 115200 Baud erscheint `SOUND` mit WIN,
LOSS oder JACKPOT. Bei Tonmodus 0 entfällt diese Ausgabe. Die Funktion `tone()`
verwendet beim Uno Timer 2; LCD-Digitalausgänge und die SPI-Verbindung laufen
weiter. PWM per `analogWrite()` auf D3/D11 wird in diesem Projekt nicht verwendet.
