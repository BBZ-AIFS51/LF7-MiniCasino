# Arduino Uno – Mini Casino V10

**Jetzt mit Farbspiel:** Schwarz, Rot oder Grün drücken. Einsatz 10 Punkte,
bei Treffer auf Schwarz/Rot Auszahlung 20 (netto +10), auf Grün 90 (netto +80),
sonst netto -10. Chancen: Schwarz 45 %, Rot 45 %, Grün 10 %.
Drei LEDs laufen schnell los, bremsen ab und halten auf dem Ergebnis an. Guthaben liegen ab V10 im EEPROM des Uno;
jede UID bekommt genau einmal ein Startguthaben.

**Ton ist im Hauptsketch aktiviert:** Lauflicht-Ticks, Level-up bei Gewinn,
Womp-womp bei Verlust und Jackpot-Fanfare bei einem Gewinn mit Grün.
Das sind eigene kurze Buzzer-Tonfolgen im Meme-Stil. Anschluss und Einstellung:
[SOUND_V9.md](SOUND_V9.md).

## Anschluss und Start

| Anschluss | Verbindung |
|---|---|
| Schwarz | Schließertaste zwischen A0 und GND |
| Rot | Schließertaste zwischen A1 und GND |
| Grün | Schließertaste zwischen A2 und GND |
| LED Schwarz / Rot / Grün | A3 / A4 / A5, jeweils über 330 Ω zur Anode; Kathode an GND |
| Ton | D2 über 330 Ω an S; Minus an GND; unbekannte Mitte offen lassen |

Die Tasten verwenden INPUT_PULLUP, keine zusätzlichen Tasterwiderstände.
LCD-Pins 8,7,6,5,4,3 und RFID-Pins 10,9 sowie SPI bleiben unverändert.
Details zu vierbeinigen Tastern, COM/NO, freien Pins und Buzzer:
[SPIELPLAN_V8.md](SPIELPLAN_V8.md).

1. Den vollständigen Ordner **MiniCasino mit allen 13 Dateien** behalten.
2. MiniCasino/MiniCasino.ino in der Arduino IDE öffnen, Uno und Port wählen, laden.
3. Karte kurz auflegen. Das LCD zeigt `10 Pkt: S/R/G` und dein Guthaben.
4. Karte weglegen und eine Taste tippen. So oft du willst.
5. Nach 60 Sekunden Pause Karte erneut kurz auflegen. Details: unten.

Bibliotheken: **MFRC522 1.4.12 liegt als Kopie im Sketch-Ordner** und muss nicht
mehr über den Bibliotheksverwalter installiert werden. LiquidCrystal, SPI und
EEPROM kommen mit dem Arduino-Core. Falls eine **alte MFRC522-Installation** im
Bibliotheksordner Fehler wie „multiple definition of …“ auslöst: dort löschen.
Diagnose-Monitor: **115200 Baud**, BOOT Mini Casino v10. Der Betrieb benötigt
keine geöffnete Konsole. Standard ist ein passiver Buzzer; ein aktiver benötigt
Modus 2 und kann nur den Rhythmus wiedergeben.

Direkt die Hauptdatei in der Arduino IDE öffnen und hochladen. Auf Nutzerwunsch
keine ZIP-Archive erstellen oder bereitstellen; die bisherigen Projekt-ZIPs wurden entfernt.

## Ablauf: einmal kurz auflegen, dann spielen

**Das Guthaben liegt ab V10 im EEPROM des Uno, nicht mehr auf der Karte.** Die
Karte wird nur noch an ihrer UID erkannt — der Kartenspeicher wird weder
gelesen noch beschrieben. Deshalb reicht ein kurzes Antippen.

1. **Karte kurz auflegen.** Unbekannte UID wird einmalig registriert und mit
   100 Punkten angelegt, bekannte UID lädt ihren Stand aus dem EEPROM.
2. **Spielen.** `10 Pkt: S/R/G` steht auf dem LCD, ab jetzt nur noch Tasten.
   Beliebig viele Runden hintereinander, ganz ohne Karte.
3. Nach **60 Sekunden ohne Tastendruck** endet die Sitzung. Zum Weiterspielen
   Karte erneut kurz auflegen. Das schützt dein Guthaben, wenn du weggehst.

Jede Runde ist genau eine EEPROM-Buchung: Einsatz, Ziehung und Endstand werden
zusammen verrechnet, zurückgelesen und erst dann laufen Lauflicht und Ton.
Schlägt die Buchung fehl, bleibt der alte Stand stehen und es wird kein
Ergebnis gezeigt.

### Tasten: tippen spielt, halten macht mehr

Der Einsatz wird jetzt beim **Loslassen** ausgelöst — nur so kann dieselbe Taste
zwei Dinge können. Kurz antippen fühlt sich unverändert direkt an.

| Taste | kurz tippen | ca. 1,2 s halten |
|---|---|---|
| Schwarz | Setzen auf Schwarz | **Einsatz ändern** |
| Rot | Setzen auf Rot | **Logout** — Sitzung sofort beenden |
| Grün | Setzen auf Grün | **Lautstärke weiterschalten**: laut → leise → aus |

Beim Halten zeigt das LCD ab ca. 0,25 s an, was passieren wird (`Logout`,
`Ton aus`, `Abbrechen`), darunter läuft ein Balken voll. Gleichzeitig blinkt die
gehaltene LED immer schneller — von rund 260 ms Periode auf 60 ms kurz vor dem
Auslösen. Lässt du vorher los, passiert die Halte-Aktion nicht.

### Einsatz frei wählen

**Schwarz gedrückt halten**, kein Admin-Panel nötig. Das läuft in zwei Phasen,
damit man nicht auf den Millimeter genau loslassen muss.

**1. Grob: halten und laufen lassen**

```
Einsatz 250 Pkt
Loslassen = stop
```

Nach dem üblichen Haltebalken läuft der Einsatz hoch, solange du hältst — mit
festen 320 ms pro Schritt, bewusst ohne Beschleunigung. Die LEDs laufen im Takt
mit, dazu ein kurzer Tick. Am oberen Ende geht es wieder bei 10 los, du kommst
also mit der einen Taste überall hin.

**2. Fein: genau einstellen**

```
Einsatz 250 Pkt
S-10  R+10  G ok
```

Loslassen **hält nur an**, gebucht wird noch nichts. Jetzt:

- **Schwarz tippen** = −10, **Rot tippen** = +10 — so triffst du jeden Wert exakt
- **Taste liegen lassen** (etwa 0,7 s) = die Rampe läuft weiter
- **Grün** übernimmt, ebenso 6 Sekunden ohne Eingabe

Die Schrittweite der Rampe wächst mit dem Betrag: 10 unter 100, 50 unter 500,
darüber 100. Erlaubt sind Vielfache von 10 bis höchstens 2550, und nie mehr als
dein Guthaben.

**Der Einsatz gehört zur Karte**, nicht zur Sitzung: er liegt beim Konto im
EEPROM und gilt beim nächsten Auflegen wieder. Reicht das Guthaben nicht mehr,
wird er beim Anmelden automatisch auf das Maximum heruntergezogen.

Die Auszahlung skaliert mit: Schwarz und Rot zahlen den doppelten Einsatz, Grün
den neunfachen. Bei 250 Punkten Einsatz sind das netto +250 beziehungsweise +2000.

### Lautstärke

Grün halten schaltet **laut → leise → aus → laut**. Auf dem LCD steht beim
Halten schon, welche Stufe als nächstes kommt. Die Einstellung überlebt Reset
und Stromausfall: sie liegt in einem Einstellungs-Byte im EEPROM-Header und hat
mit den Konten nichts zu tun.

`tone()` gibt immer volle 5 V aus, an der Lautstärke lässt sich darüber nichts
drehen. **Leise** erzeugt denselben Ton deshalb von Hand mit rund 8 % statt 50 %
Einschaltdauer — der Piezo bekommt weniger Energie und wird spürbar leiser, der
Klang wird dabei etwas dünner. Das funktioniert nur mit einem **passiven**
Buzzer (`CASINO_SOUND_MODE 1`); ein aktiver kann nur an oder aus, dort entfällt
die Stufe leise.

Alle drei Stufen brauchen exakt gleich lang — auch bei „aus" wird die Jingle-
Dauer abgewartet, damit Lauflicht und Ergebnisanzeige immer gleich wirken.

Wenn es dir **immer noch** zu laut ist, hilft Hardware am meisten: den 330-Ω-
Widerstand an D2 gegen einen größeren tauschen (1 kΩ ist deutlich leiser,
10 kΩ fast nur noch ein Flüstern). Ein 10-kΩ-Trimmpoti an der Stelle gibt dir
einen echten Lautstärkeregler zum Drehen.

### LED-Rückmeldung

- **Keine Sitzung:** langsames Lauflicht über die drei LEDs — der Automat
  wartet auf eine Karte.
- **Sitzung läuft:** LEDs aus, damit klar ist, dass nichts offen ist.
- **Letzte 10 Sekunden der Sitzung:** alle drei blinken langsam als Vorwarnung,
  die letzten 3 Sekunden deutlich schneller.
- **Halten:** die gehaltene Farbe blinkt beschleunigt bis zum Auslösen.
- **Logout und Ton-Umschalten:** dreimal kurz alle LEDs als Quittung.

### Grenzen, die ihr kennen solltet

- **31 Konten.** Der EEPROM des Uno hat 1 KB. Ist er voll, meldet der Automat
  `UID-Liste voll` — alte Konten werden nie verdrängt.
- **Das Konto hängt am Automaten.** Geht der Uno kaputt oder wird der EEPROM
  gelöscht, sind alle Guthaben weg. Die Karte ist kein Backup mehr.
- **Stromausfall während einer Buchung** kostet höchstens die laufende Runde.
  Jedes Konto liegt in zwei Kopien mit eigener CRC, geschrieben wird immer in
  die ältere. Die andere Kopie bleibt dabei unberührt.
- **EEPROM-Lebensdauer:** rund 100.000 Schreibzyklen je Zelle. Eine Runde
  schreibt etwa 8 Byte, abwechselnd in zwei Kopien. Für Zehntausende Runden
  völlig unkritisch.
- Es ist ein Spielzeug, kein manipulationssicheres Bezahlsystem. Wer an den
  Uno kommt, kommt an die Guthaben.

## Umstieg von der alten Merkliste

Nichts zu tun. Erkennt der Automat beim Start die alte Merkliste (Format 06),
hebt er den EEPROM automatisch auf Format 07. Die alte Liste enthielt nur UIDs
und keine Guthaben, es geht also nichts verloren; jede Karte bekommt beim ersten
Auflegen ihre 100 Punkte. Ein **fremder** EEPROM-Inhalt wird weiterhin nie
angetastet — dann meldet der Automat `UID-Liste Fehler` und bleibt gesperrt.

Für diesen Fall (und nur dafür) gibt es den Notschalter:

```cpp
#define CASINO_EEPROM_LOESCHEN 1
```

Er verwirft den **gesamten** EEPROM-Bereich, also alle UIDs und alle Guthaben.
Hochladen, Reset abwarten, sofort zurück auf `0` und neu hochladen.

## Alles verspielt? Nachlade-Modus

`CASINO_NACHLADEN 1` hebt beim Start jedes bekannte Konto unter 100 Punkten
wieder auf 100 an. Es wird nichts gelöscht und keine Karte beschrieben.

```cpp
#define CASINO_NACHLADEN 1
```

Hochladen, Reset, der Monitor meldet `NACHLADEN | Konten auf Startguthaben
angehoben: N`. Danach zurück auf `0` und neu hochladen — sonst füllt jeder
Neustart alle Konten wieder auf.

## Ohne Hardware: Simulation im Browser

Der ganze Automat läuft in [Wokwi](https://wokwi.com) — LCD, Taster, LEDs,
Buzzer, EEPROM. Kein Uno, kein RFID-Modul nötig.

```bash
python simulation/build_sim.py
```

Erzeugt die Dateien zum Einfügen. Anleitung und Verdrahtung:
[simulation/README.md](simulation/README.md).

Wokwi kennt kein RFID-Modul, deshalb stehen dort **vier Taster an D9–D12** für
vier Karten — genau die Pins, an denen sonst der RC522 hängt. Drücken heißt
auflegen. Weitere Karten gehen über den seriellen Monitor mit `CARD <uidhex>`.

Umgeschaltet wird über `CASINO_SIM` in `MiniCasino.ino` (`0` = echte Hardware).
Der Sketch bleibt in beiden Fällen derselbe.

## Kartenzustände: normal, gesperrt, Admin

Jede Karte hat im Adminpanel einen Zustand:

| Zustand | Wirkung |
|---|---|
| **normal** | wie gehabt |
| **gesperrt** | wird am Automaten abgewiesen (`Karte gesperrt` / `Siehe Admin`). Es startet keine Sitzung, das Guthaben bleibt aber gespeichert und kommt beim Entsperren unverändert zurück. |
| **Admin ∞** | spielt mit unbegrenztem Guthaben. Auf dem LCD steht `inf`, es wird nichts abgebucht und nichts gutgeschrieben. |

Sperren wirkt sofort — auch mitten in einer laufenden Sitzung wird der Spieler
abgemeldet. Der Zustand liegt im Statusbyte des Eintrags und überlebt Neustarts.
Guthaben und Einsatz bleiben davon unberührt, auch beim Sperren.

Eine Adminkarte darf bis zum Höchsteinsatz von 2550 setzen, unabhängig vom
angezeigten Guthaben. Rundenergebnisse werden ganz normal ausgespielt, nur eben
nicht gebucht — praktisch zum Vorführen ohne das eigene Konto zu plündern.

## Währung auf dem Display

Der HD44780 hat kein Euro-Zeichen im Zeichensatz. Es wird deshalb als eigenes
Zeichen (5×8 Punkte) definiert und liegt auf Zeichencode 0. Umschalten in
`MiniCasino.ino`:

```cpp
#define CASINO_EURO 1   // 1 = Euro-Zeichen, 0 = "Pkt"
```

Am Spiel ändert das nichts — es bleiben Spielpunkte ohne jeden Gegenwert, nur
die Beschriftung wechselt. Sieht das Zeichen auf eurem Display komisch aus, ist
es eine andere Zeichensatzvariante; dann einfach auf `0` stellen.

## Web-Adminpanel

Konten ansehen und bearbeiten, ohne Karten aufzulegen. Unter Windows genügt ein
Doppelklick auf **`Panel starten.bat`** im Projektordner: das Skript beendet bei
Bedarf den seriellen Monitor der IDE, startet das Panel in einem eigenen Fenster
und öffnet den Browser. Zusätzliche Argumente werden durchgereicht, etwa
`"Panel starten.bat" --serial COM6`.

Von Hand geht es genauso:

```bash
python admin/panel.py
```

Dann [http://127.0.0.1:8080](http://127.0.0.1:8080) öffnen. Der serielle Anschluss
wird automatisch gesucht, sonst `--serial COM6` bzw. `--serial /dev/ttyACM0`.

Das Panel zeigt alle Konten mit UID, Guthaben und Einsatz; die laufende Sitzung
ist hervorgehoben. Guthaben und Einsatz lassen sich direkt in der Tabelle ändern,
Karten von Hand anlegen und Plätze freigeben. Dazu die Tonstufe und der Live-Log
vom Automaten.

Es läuft mit der Python-Standardbibliothek — kein `pip install` nötig. Ist
pyserial installiert, wird es benutzt, sonst spricht das Panel die Schnittstelle
direkt an (Win32 bzw. `termios`). Damit läuft es genauso auf einem Raspberry Pi,
an dem der Uno per USB hängt.

### Auf dem Raspberry Pi

```bash
python3 admin/panel.py --serial /dev/ttyACM0 --host 0.0.0.0
```

`--host 0.0.0.0` macht das Panel im Netz erreichbar. **Es hat kein Passwort** —
wer die Adresse kennt, kann sich Guthaben ausstellen. Ohne diese Option hört es
nur auf dem Gerät selbst zu, und dabei sollte es in einem fremden Netz bleiben.
Ist der Benutzer nicht in der Gruppe `dialout`, fehlt der Zugriff auf
`/dev/ttyACM0`: `sudo usermod -aG dialout $USER`, danach neu anmelden.

### Was ihr wissen solltet

- **Das Öffnen der Schnittstelle setzt den Uno zurück.** Die Guthaben liegen im
  EEPROM und überstehen das, eine laufende Sitzung nicht.
- **Solange das Panel läuft, ist der Anschluss belegt.** Der serielle Monitor der
  Arduino IDE und jeder Upload scheitern dann mit „Zugriff verweigert". Panel mit
  Strg+C beenden, bevor ihr neu flasht.
- **Freigeben ist kein Löschen des Guthabens, sondern des Eintrags.** Die Karte
  gilt danach als unbekannt und bekommt beim nächsten Auflegen wieder 100 Punkte.
- Das Protokoll auf dem Uno steht in [AdminSerial.h](MiniCasino/AdminSerial.h) und
  ist auch von Hand bedienbar: Monitor auf 115200, `PING` oder `LIST` eintippen.

## Dateien

| Datei | Zweck |
|---|---|
| SPIELPLAN_V8.md | Vollständiger Plan, Regeln, Anschlüsse, Speicherablauf, Grenzen |
| SOUND_V9.md | Aktuelle Tonintegration; ersetzt die alte Einstellung „Ton aus“ |
| ANLEITUNG.md | Bestätigte LCD-/RFID-Verdrahtung, Erstaufladung und Kartenformat |
| BETRIEB_V6.md | Altes Kartenformat und Merkliste 06; von V10 abgelöst |
| LOG_ANLEITUNG.md | RFID-Diagnose und neue Spiel-Logzeilen |
| TESTPLAN.md | Prüfstand und Tests am Aufbau |
| MiniCasino/ | Hauptsketch, Projekt-Header und die mitgelieferte MFRC522 1.4.12 |
| LCD_Test/ | Separater LCD-Test; ersetzt beim Upload den Hauptsketch |
| tests/ und pruefen.py | C++-Prüfungen und lokaler Uno-Build ohne Upload |
| admin/panel.py | Web-Adminpanel; spricht über USB mit dem Uno |
| Panel starten.bat | Startet das Panel unter Windows per Doppelklick |
| simulation/ | Wokwi-Schaltung und Skript für die Simulation ohne Hardware |

V8 speichert einen abgezogenen Einsatz mit festem Ergebnis vor der Auszahlung. Der bestätigte Endstand wird vor dem Lauflicht gespeichert.
Eine gültige offene Runde wird nach Reset fortgesetzt. Eine zugleich durch
Stromausfall unterbrochene Mehrseiten-Schreibung kann einen beschädigten
Datensatz hinterlassen; die Grenzen sind im Spielplan dokumentiert.

Ihr habt das Spiel mit LEDs und Tastern als funktionierend bestätigt.
Die neue Tonintegration wurde lokal kompiliert und geprüft; das tatsächliche
Tonmodul wurde hier nicht am Aufbau getestet.
