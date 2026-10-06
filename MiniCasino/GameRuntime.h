#ifndef CASINO_GAME_RUNTIME_H
#define CASINO_GAME_RUNTIME_H
#include "GameSounds.h"
// Included after RFID and display helpers in MiniCasino.ino.
// 4x4-Folientastatur mit 8 Pins. Jede Taste hat genau eine Funktion:
//   1 2 3 A     1/2/3 = auf Schwarz/Rot/Gruen setzen, A = Einsatz eintippen
//   4 5 6 B     B = abmelden (mit Rueckfrage)
//   7 8 9 C     C = Ton laut/leise/aus
//   * 0 # D     D = Hilfe; im Einsatz: Ziffern, # = OK, * = loeschen
// Die 8 Kabel liegen der Reihe nach auf D3, D4, D5, D6, D7, D8, A0, A1.
// Am Aufbau getestet: so herum sind D3-D6 die Spalten (rechts nach links)
// und D7, D8, A0, A1 die Reihen (unten nach oben). Steckt jemand den Stecker
// andersherum, diese zwei Zeilen tauschen: Reihen {3,4,5,6}, Spalten {7,8,A0,A1}.
const byte KEYPAD_REIHEN[4] = {A1, A0, 8, 7};   // Reihe 1 2 3 A ... Reihe * 0 # D
const byte KEYPAD_SPALTEN[4] = {6, 5, 4, 3};    // Spalte 1 4 7 * ... Spalte A B C D
const char KEYPAD_ZEICHEN[17] = "123A456B789C*0#D";
const byte TON_PIN = 2;
// In MiniCasino.ino einstellen: 0 aus, 1 passiver Buzzer, 2 aktiver Buzzer.
// Testanschluss: D2 -> 330 Ohm -> S, Minus -> GND; unbekannte Mitte offen.
const byte TON_MODUS = CASINO_SOUND_MODE;
static_assert(TON_MODUS <= 2, "TON_MODUS: 0 aus, 1 passiv, 2 aktiv");
const byte TON_AKTIV = HIGH; // Nur Modultyp 2: ggf. laut Datenblatt LOW.
// Eine Sitzung beginnt mit dem kurzen Auflegen der Karte und laeuft danach ohne
// sie weiter. Gespielt wird gegen das Konto im EEPROM; spielGuthaben ist nur
// die Anzeige dazu, massgeblich ist immer uidListe.balance(spielSlot).
bool spielAktiv = false;
Rc522::Uid spielUid;
int spielSlot = -1;
uint32_t spielGuthaben = 0;
bool spielUnbegrenzt = false; // Adminkarte: setzt und gewinnt ohne Buchung.
// Einsatz der laufenden Sitzung. Liegt als Vielfaches von zehn Punkten beim
// Konto im EEPROM und gilt damit beim naechsten Auflegen wieder.
uint32_t spielEinsatz = Casino::STAKE;
unsigned long sitzungSeit = 0;
// Was die Tasten gerade bedeuten. Ausser im Spielmodus kehrt die Anzeige nach
// MODUS_MS ohne Tastendruck von selbst ins Menue zurueck.
const byte MODUS_SPIEL = 0, MODUS_EINSATZ = 1, MODUS_ABMELDEN = 2, MODUS_HILFE = 3;
byte modus = MODUS_SPIEL;
unsigned long modusSeit = 0;
const unsigned long MODUS_MS = 20000UL;
// Einsatz-Eingabe: hoechstens vier Ziffern, der groesste Einsatz hat vier.
uint16_t eingabe = 0;
byte eingabeStellen = 0;
byte hilfeSeite = 0;
// Drei Lautstaerkestufen, beim Start aus dem EEPROM geladen.
// Leise erzeugt denselben Ton mit schmalen Impulsen statt halbe-halbe: der
// Piezo bekommt weniger Energie und wird deutlich leiser. Das geht nur mit
// einem passiven Buzzer (Modus 1); ein aktiver kann nur an oder aus.
const byte TON_LAUT = 0, TON_LEISE = 1, TON_AUS = 2;
byte tonStufe = TON_LAUT;
const byte WAEHRUNG_BREITE = CASINO_EURO ? 1 : 4;

void tonSpiele(unsigned int hz, unsigned int dauer);
// Eigener kleiner Zufallsgenerator (xorshift32) statt random(): spart rund
// 300 Byte. Kein Sicherheits-RNG, aber fuer ein Spiel mit Spielpunkten genug.
uint32_t zufall = 2463534242UL;
uint32_t zufallsZahl() {
  zufall ^= micros();          // Zeitpunkt des Tastendrucks einmischen.
  if (!zufall) zufall = 1;
  zufall ^= zufall << 13;
  zufall ^= zufall >> 17;
  zufall ^= zufall << 5;
  return zufall;
}

const __FlashStringHelper *farbe(byte index) {
  return index == 0 ? F("SCHWARZ") : index == 1 ? F("ROT") : F("GRUEN");
}
// Lauflicht ohne LEDs: die Farben laufen in der unteren Displayzeile durch,
// werden langsamer und bleiben auf dem schon gezogenen Ergebnis stehen.
void lauflichtZeige(byte index) {
  const __FlashStringHelper *name = farbe(index);
  byte laenge = (byte)(strlen_P((PGM_P)name) + 4);   // "> NAME <"
  byte links = (byte)((16 - laenge) / 2);
  anzeige.setCursor(0, 1);
  for (byte i = 0; i < links; ++i) anzeige.print(' ');
  anzeige.print(F("> ")); anzeige.print(name); anzeige.print(F(" <"));
  for (byte i = (byte)(links + laenge); i < 16; ++i) anzeige.print(' ');
}
void lauflicht(byte choice, byte result) {
  byte start = (byte)(zufallsZahl() % 3); // Nur optischer Start; aendert das Ergebnis nicht.
  byte count = Casino::spinSteps(start, result);
  meldung(F(""), F(""));
  anzeige.setCursor(0, 0);
  anzeige.print(F("Tipp: "));
  anzeige.print(farbe(choice));
  for (byte step = 0; step < count; ++step) {
    unsigned long seit = millis();
    byte index = Casino::spinLed(start, step);
    lauflichtZeige(index);
    unsigned int zeit = Casino::spinDelay(step, count);
    // Genau ein kurzer Tick pro Farbwechsel; auch aktive Buzzer werden gestoppt.
    tonSpiele(1200 + index * 250, 18);
    // Gesamte Schrittdauer bleibt 45 bis 500 ms, auch mit der I2C-Uebertragung.
    unsigned long schon = millis() - seit;
    if (schon < zeit) delay(zeit - schon);
  }
  // Die letzte Farbe ist bereits das Ergebnis; kein nachtraeglicher Sprung.
}

// Tastatur abfragen: immer genau eine Reihe auf LOW ziehen und schauen, welche
// Spalte (mit Pullup) dadurch ebenfalls LOW wird. Die anderen Reihen bleiben
// hochohmig, so gibt es auch bei zwei gedrueckten Tasten keinen Kurzschluss.
// Liefert das Zeichen der ersten gedrueckten Taste oder 0.
char leseTaste() {
  char taste = 0;
  for (byte r = 0; r < 4 && !taste; ++r) {
    pinMode(KEYPAD_REIHEN[r], OUTPUT);   // Pegel ist LOW, siehe unten.
    delayMicroseconds(10);               // Leitungen umladen lassen.
    for (byte s = 0; s < 4 && !taste; ++s)
      if (digitalRead(KEYPAD_SPALTEN[s]) == LOW) taste = KEYPAD_ZEICHEN[r * 4 + s];
    pinMode(KEYPAD_REIHEN[r], INPUT);    // Loescht zugleich das Ausgangsbit.
  }
  return taste;
}
// Entprellen: eine Taste zaehlt, wenn sie 35 ms ruhig anliegt, und genau einmal
// pro Druck. Halten wiederholt nichts.
char tasteRoh = 0, tasteStabil = 0;
unsigned long tasteSeit = 0;
char neueTaste(unsigned long now) {
  char taste = leseTaste();
  if (taste != tasteRoh) { tasteRoh = taste; tasteSeit = now; return 0; }
  if (now - tasteSeit < 35UL || taste == tasteStabil) return 0;
  tasteStabil = taste;
  return taste;   // 0 beim Loslassen
}
// Nach blockierenden Ablaeufen (Lauflicht, Jingle): eine noch gehaltene Taste
// gilt nicht als neuer Druck.
void tastenSperren() { tasteRoh = tasteStabil = leseTaste(); tasteSeit = millis(); }

// Ton von Hand takten statt mit tone(): alle Toene warten ohnehin, bis sie
// fertig sind, also braucht es weder Timer noch Interrupt. Laut ist halbe-
// halbe, leise rund 8 Prozent Einschaltdauer. Auch bei stumm wird gewartet,
// damit Lauflicht und Jingle immer gleich lange brauchen.
void tonSpiele(unsigned int hz, unsigned int dauer) {
  if (!TON_MODUS || tonStufe == TON_AUS || !hz) { delay(dauer); return; }
  if (TON_MODUS == 2) {   // Aktiver Buzzer: nur an und aus.
    digitalWrite(TON_PIN, TON_AKTIV);
    delay(dauer);
    digitalWrite(TON_PIN, !TON_AKTIV);
    return;
  }
  unsigned long periode = 1000000UL / hz;      // Mikrosekunden.
  unsigned int an = (unsigned int)(tonStufe == TON_LEISE ? periode / 12 : periode / 2);
  if (an < 3) an = 3;
  unsigned long zyklen = ((unsigned long)dauer * 1000UL) / periode;
  for (unsigned long i = 0; i < zyklen; ++i) {
    digitalWrite(TON_PIN, HIGH);
    delayMicroseconds(an);
    digitalWrite(TON_PIN, LOW);
    delayMicroseconds((unsigned int)(periode - an));
  }
}
// Kurze Rueckmeldungen auf Tastendruck.
void tonKlick() { tonSpiele(1500, 10); }
void tonFehler() { tonSpiele(300, 120); }
void tonQuittung(unsigned int hz) {
  for (byte i = 0; i < 3; ++i) { tonSpiele(hz, 40); delay(100); }
}

void spieleSound(Casino::SoundEffect effect) {
  const Casino::SoundNote *notes;
  byte count;
  if (effect == Casino::SoundEffect::Jackpot) {
    notes = Casino::JACKPOT_SOUND;
    count = sizeof(Casino::JACKPOT_SOUND) / sizeof(Casino::SoundNote);
    logText(F("SOUND"), F("JACKPOT: Fanfare + 8-Bit-Abschluss."));
  } else if (effect == Casino::SoundEffect::Win) {
    notes = Casino::WIN_SOUND;
    count = sizeof(Casino::WIN_SOUND) / sizeof(Casino::SoundNote);
    logText(F("SOUND"), F("WIN: Level-up."));
  } else {
    notes = Casino::LOSS_SOUND;
    count = sizeof(Casino::LOSS_SOUND) / sizeof(Casino::SoundNote);
    logText(F("SOUND"), F("LOSS: Womp-womp."));
  }
  // Erst nach bestaetigter Buchung. Keine RFID-Zugriffe oder Spiele waehrend
  // des Jingles; danach sperrt tastenSperren() eine noch gehaltene Taste.
  for (byte i = 0; i < count; ++i) {
    Casino::SoundNote note;
    memcpy_P(&note, notes + i, sizeof(note));
    tonSpiele(note.hz, note.duration);
    delay(note.gap);
  }
}

// --- Anzeige -------------------------------------------------------------
byte stellen(uint32_t wert) {
  byte n = 1;
  while (wert >= 10) { wert /= 10; ++n; }
  return n;
}
// Zahl ausgeben und die Stellenzahl zurueckgeben, damit der Rest der Zeile
// gefuellt werden kann. Die Anzeige verraet die Spalte nicht von selbst.
byte lcdZahl(uint32_t wert) {
  anzeige.print((unsigned long)wert);
  return stellen(wert);
}
void lcdRest(byte benutzt) { for (byte i = benutzt; i < 16; ++i) anzeige.print(' '); }

// Eine Zeile "Name        123€": Name links, Betrag rechtsbuendig.
// vorzeichen: 0 ohne, '+' oder '-' davor, 'i' zeigt "inf" (Adminkarte).
void zeileWert(byte zeile, const __FlashStringHelper *name, uint32_t wert, char vorzeichen) {
  anzeige.setCursor(0, zeile);
  anzeige.print(name);
  byte breite = vorzeichen == 'i' ? 3
              : (byte)(stellen(wert) + WAEHRUNG_BREITE + (vorzeichen ? 1 : 0));
  for (byte i = (byte)strlen_P((PGM_P)name); i < 16 - breite; ++i) anzeige.print(' ');
  if (vorzeichen == 'i') { anzeige.print(F("inf")); return; }
  if (vorzeichen) anzeige.print(vorzeichen);
  anzeige.print((unsigned long)wert);
  lcdWaehrung();
}
void zeigeGuthabenZeile(byte zeile, uint32_t wert) {
  zeileWert(zeile, F("Guthaben"), wert, spielUnbegrenzt ? 'i' : 0);
}

void spielMenue() {
  modus = MODUS_SPIEL;
  if (!spielAktiv) {
    meldung(F("Bitte Karte"), F("auflegen"));
    anzeige.hinweis(F("D = Hilfe"));
    return;
  }
  zeigeGuthabenZeile(0, spielGuthaben);
  zeileWert(1, F("Einsatz"), spielEinsatz, 0);
  anzeige.hinweis(F("1-3 setzen  D=?"));
  if (DEBUG_LOG) {
    logKopf(F("LCD"));
    Serial.print(F("Guthaben "));
    if (spielUnbegrenzt) Serial.print(F("inf"));
    else Serial.print((unsigned long)spielGuthaben);
    Serial.print(F(" / Einsatz "));
    Serial.println((unsigned long)spielEinsatz);
  }
}
// Fuer Meldungen, die nach ANZEIGEDAUER_MS von selbst ins Menue zurueckgehen.
void zeigeKurz() {
  ergebnisSeit = naechsterScanSeit = millis();
  ergebnisSichtbar = scanPause = true;
}
// Fuer Bildschirme mit eigener Eingabe: nicht vom Ergebnis-Timer ueberschreiben.
void betreteModus(byte neuerModus) {
  modus = neuerModus;
  modusSeit = millis();
  ergebnisSichtbar = false;
}

// Karte wurde erkannt: ab hier reichen die Tasten, die Karte darf weg.
void starteSitzung(const Rc522::Uid &uid, int slot, uint32_t guthaben) {
  spielUid = uid; spielSlot = slot; spielGuthaben = guthaben; spielAktiv = true;
  spielUnbegrenzt = uidListe.unlimited(slot);
  uint8_t einheiten = uidListe.stakeUnits(slot);
  spielEinsatz = einheiten ? (uint32_t)einheiten * Casino::STAKE_SCHRITT : Casino::STAKE;
  // Reicht das Guthaben nicht mehr fuer den gemerkten Einsatz, herunterziehen.
  uint32_t grenze = Casino::stakeLimit(spielUnbegrenzt ? Casino::STAKE_MAX : guthaben);
  if (spielEinsatz > grenze) {
    spielEinsatz = grenze;
    logText(F("EINSATZ"), F("Gemerkter Einsatz ueber dem Guthaben; auf das Maximum gesetzt."));
  }
  sitzungSeit = millis();
  tastenSperren();
  spielMenue();
}
// Nach SITZUNG_MS ohne Tastendruck oder mit B. Das Guthaben bleibt im EEPROM
// stehen, aber weiterspielen darf nur, wer seine Karte erneut auflegt.
void beendeSitzung(bool manuell) {
  spielAktiv = false; spielSlot = -1; spielUnbegrenzt = false;
  logText(F("SITZUNG"), manuell ? F("Von Hand abgemeldet.")
                                : F("Zeit abgelaufen. Zum Weiterspielen Karte erneut kurz auflegen."));
  if (manuell) {
    meldung(F("Abgemeldet"), F("Bis bald!"));
    modus = MODUS_SPIEL;
  } else {
    spielMenue();
  }
}

// Aufloesung erst nach bestaetigter Buchung: Lauflicht, Ton und Klartext.
// Ein Abbruch waehrend des Lauflichts kann den Stand nicht mehr aendern.
void zeigeNetto(byte zeile, bool win, uint32_t netto) {
  zeileWert(zeile, win ? F("Gewinn") : F("Verlust"), netto, win ? '+' : '-');
}
void zeigeAufloesung(byte choice, byte result, uint32_t einsatz,
                     uint32_t auszahlung, uint32_t balance) {
  bool win = choice == result;
  uint32_t netto = win ? auszahlung - einsatz : einsatz;
  Casino::SoundEffect effect = Casino::effectForChoice(win, choice);
  if (DEBUG_LOG) {
    logKopf(F("SPIEL")); Serial.print(F("Wahl=")); Serial.print(farbe(choice));
    Serial.print(F(" Ergebnis=")); Serial.print(farbe(result));
    Serial.print(F(" Einsatz=")); Serial.print((unsigned long)einsatz);
    Serial.print(F(" Auszahlung=")); Serial.print((unsigned long)auszahlung);
    Serial.print(F(" Guthaben=")); Serial.println((unsigned long)balance);
  }
  lauflicht(choice, result);
  anzeige.setCursor(0, 0);
  if (effect == Casino::SoundEffect::Jackpot) { anzeige.print(F("JACKPOT! GRUEN")); lcdRest(14); }
  else { anzeige.print(farbe(result)); lcdRest((byte)strlen_P((PGM_P)farbe(result))); }
  zeigeNetto(1, win, netto);
  spieleSound(effect); // Dauert in jeder Tonstufe gleich lang.
  zeigeNetto(0, win, netto);
  zeigeGuthabenZeile(1, balance);
  anzeige.hinweis(F("1-3 nochmal"));
}
// Eine vollstaendige Runde ohne Karte: Einsatz, Ziehung und Endstand werden in
// einer einzigen EEPROM-Buchung verrechnet. Scheitert sie, bleibt der alte
// Stand unveraendert und es wird kein Ergebnis gezeigt.
// A4/A5 sind der I2C-Bus des OLED. Keine Analogmessung an diesen Pins!
void spiele(byte choice) {
  sitzungSeit = millis();
  uint32_t balance = uidListe.balance(spielSlot);
  spielGuthaben = balance;
  if (!uidListe.funded(spielSlot)) {
    spielAktiv = false;
    logText(F("SPIEL"), F("Konto nicht mehr lesbar. Kein Einsatz."));
    meldung(F("Konto unklar"), F("Karte auflegen")); return;
  }
  // Adminkarten pruefen nur den Einsatz selbst, nie das Guthaben.
  if (!Casino::canPlay(spielUnbegrenzt ? Casino::STAKE_MAX * 10UL : balance,
                       choice, spielEinsatz)) {
    tonFehler();
    meldung(balance < spielEinsatz ? F("Guthaben fehlt") : F("Einsatz zu hoch"),
            F("Mit A aendern"));
    anzeige.hinweis(F("A = Einsatz")); return;
  }
  // Der Tastendruck-Zeitpunkt mischt den Zufall (kein Sicherheits-RNG).
  byte result = Casino::colourForTicket((byte)(zufallsZahl() % 100));
  uint32_t neu = Casino::settled(balance - spielEinsatz, choice, result, spielEinsatz);
  // Adminkarte: Ergebnis zeigen, aber nichts buchen. Der Stand bleibt gleich.
  if (!spielUnbegrenzt) {
    meldung(F("Buche Runde..."), F(""));
    if (!uidListe.setBalance(spielSlot, neu)) {
      logText(F("SPIEL"), F("EEPROM-Buchung nicht bestaetigt. Runde gilt nicht, Stand unveraendert."));
      meldung(F("Nicht gebucht"), F("Kein Einsatz")); return;
    }
  } else {
    neu = balance;
  }
  spielGuthaben = neu;
  zeigeAufloesung(choice, result, spielEinsatz,
                  Casino::payout(choice, result, spielEinsatz), neu);
}

// --- A: Einsatz direkt eintippen -------------------------------------------
// Groesster erlaubter Einsatz: nie mehr als das Guthaben, gedeckelt und auf
// ein Vielfaches des Schritts abgerundet.
uint32_t einsatzGrenze() {
  if (spielUnbegrenzt) return Casino::STAKE_MAX;   // Adminkarte kennt kein Limit.
  return Casino::stakeLimit(spielAktiv ? uidListe.balance(spielSlot) : Casino::STAKE);
}
// Oben Titel oder Fehlermeldung, unten die bisherige Eingabe mit Cursor und
// rechts die Obergrenze: "50_      max 150".
void einsatzAnzeigen(const __FlashStringHelper *titel) {
  anzeige.setCursor(0, 0);
  anzeige.print(titel);
  lcdRest((byte)strlen_P((PGM_P)titel));
  anzeige.setCursor(0, 1);
  byte n = eingabeStellen ? lcdZahl(eingabe) : 0;
  anzeige.print('_');
  uint32_t grenze = einsatzGrenze();
  byte rechts = (byte)(4 + stellen(grenze));
  for (byte i = (byte)(n + 1); i < 16 - rechts; ++i) anzeige.print(' ');
  anzeige.print(F("max "));
  anzeige.print((unsigned long)grenze);
  anzeige.hinweis(eingabeStellen ? F("#=OK  *=Loeschen") : F("Zahl  *=zurueck"));
}
void einsatzStarten() {
  eingabe = 0;
  eingabeStellen = 0;
  betreteModus(MODUS_EINSATZ);
  einsatzAnzeigen(F("Neuer Einsatz:"));
}
void einsatzUebernehmen() {
  spielEinsatz = eingabe;
  uint8_t einheiten = (uint8_t)(spielEinsatz / Casino::STAKE_SCHRITT);
  bool gemerkt = uidListe.setStakeUnits(spielSlot, einheiten);
  if (DEBUG_LOG) {
    logKopf(F("EINSATZ"));
    Serial.print((unsigned long)spielEinsatz);
    Serial.println(gemerkt ? F(" Punkte, beim Konto gespeichert.")
                           : F(" Punkte, nur fuer diese Sitzung."));
  }
  sitzungSeit = millis();
  spielMenue();
  tonQuittung(1400);
  tastenSperren();
}
void einsatzTaste(char taste) {
  if (taste >= '0' && taste <= '9') {
    // Vier Stellen reichen fuer jeden Einsatz; fuehrende Nullen zaehlen nicht.
    if (eingabeStellen < 4 && (eingabeStellen || taste != '0')) {
      eingabe = (uint16_t)(eingabe * 10 + (taste - '0'));
      ++eingabeStellen;
    }
    tonKlick();
    einsatzAnzeigen(F("Neuer Einsatz:"));
    return;
  }
  if (taste == '*') {
    if (!eingabeStellen) { tonKlick(); spielMenue(); return; }  // Leer: abbrechen.
    eingabe /= 10;
    --eingabeStellen;
    tonKlick();
    einsatzAnzeigen(F("Neuer Einsatz:"));
    return;
  }
  if (taste == '#') {
    byte fehler = Casino::checkStake(eingabe, einsatzGrenze());
    if (!fehler) { einsatzUebernehmen(); return; }
    tonFehler();
    einsatzAnzeigen(fehler == 1 ? F("Mindestens 10") : fehler == 2 ? F("Nur 10er-Schritt")
                                : F("Zu hoch!"));
    return;
  }
  tonFehler();   // A-D sind hier ohne Bedeutung.
}

// --- B: abmelden, C: Ton, D: Hilfe ------------------------------------------
void abmeldenFragen() {
  betreteModus(MODUS_ABMELDEN);
  meldung(F("Wirklich"), F("abmelden?"));
  anzeige.hinweis(F("#=Ja    *=Nein"));
}
void abmeldenTaste(char taste) {
  if (taste == '#') { tonQuittung(700); beendeSitzung(true); zeigeKurz(); return; }
  if (taste == '*') { tonKlick(); spielMenue(); return; }
  tonFehler();
}

// Ein aktiver Buzzer kann nur an oder aus, dort entfaellt die Stufe leise.
byte naechsteStufe() {
  if (TON_MODUS == 2) return tonStufe == TON_LAUT ? TON_AUS : TON_LAUT;
  return tonStufe == TON_LAUT ? TON_LEISE : tonStufe == TON_LEISE ? TON_AUS : TON_LAUT;
}
const __FlashStringHelper *stufenName(byte stufe) {
  return stufe == TON_LAUT ? F("Ton laut") : stufe == TON_LEISE ? F("Ton leise") : F("Ton aus");
}
// Bit 0 = aus, Bit 1 = leise. Diese Belegung passt zur frueheren Stummschaltung,
// eine schon gespeicherte 1 bleibt also weiterhin aus.
void tonStufeWeiter() {
  tonStufe = naechsteStufe();
  uint8_t opt = (uint8_t)(uidListe.options() & ~3);
  if (tonStufe == TON_AUS) opt |= 1;
  else if (tonStufe == TON_LEISE) opt |= 2;
  bool gemerkt = uidListe.setOptions(opt);
  if (DEBUG_LOG) {
    logKopf(F("TON"));
    Serial.print(stufenName(tonStufe));
    Serial.println(gemerkt ? F(" | im EEPROM gespeichert.") : F(" | nur bis zum Reset."));
  }
  meldung(stufenName(tonStufe), gemerkt ? F("gespeichert") : F("nur bis Reset"));
  anzeige.hinweis(F("C = weiter"));
  tonQuittung(tonStufe == TON_AUS ? 400 : 1400); // In Stufe aus bleibt es still.
}

// Drei Seiten, D blaettert weiter, nach der letzten geht es zurueck ins Menue.
void hilfeZeigen(byte seite) {
  if (seite > 2) { spielMenue(); return; }
  hilfeSeite = seite;
  betreteModus(MODUS_HILFE);
  if (seite == 0) meldung(F("1 Schwarz  2 Rot"), F("3 Gruen"));
  else if (seite == 1) meldung(F("A Einsatz"), F("B Abmelden"));
  else meldung(F("C Ton  D Hilfe"), F("Gruen zahlt 9x"));
  anzeige.hinweis(F("D=weiter  *=Ende"));
}

// Tastendruck im normalen Spielbildschirm.
void spielTaste(char taste) {
  if (taste == 'D') { tonKlick(); hilfeZeigen(0); return; }
  if (taste == 'C') {
    if (!TON_MODUS) { meldung(F("Kein Buzzer"), F("eingebaut")); zeigeKurz(); return; }
    tonStufeWeiter();
    tastenSperren();
    zeigeKurz();
    return;
  }
  bool funktion = (taste >= '1' && taste <= '3') || taste == 'A' || taste == 'B';
  if (!funktion) { tonFehler(); anzeige.hinweis(F("Tasten: 1-3 A-D")); return; }
  if (!spielAktiv) {
    tonFehler();
    meldung(F("Zuerst Karte"), F("auflegen"));
    anzeige.hinweis(F("D = Hilfe"));
    zeigeKurz();
    return;
  }
  if (taste == 'A') { tonKlick(); einsatzStarten(); return; }
  if (taste == 'B') { tonKlick(); abmeldenFragen(); return; }
  spiele((byte)(taste - '1'));
  tastenSperren();
  zeigeKurz();
}

// Gibt true zurueck, wenn eine Taste verarbeitet wurde und der RFID-Scan in
// diesem Durchlauf ausfallen soll.
bool tastenService(unsigned long now) {
  // Eingabe, Rueckfrage oder Hilfe ohne Tastendruck: zurueck ins Menue.
  if (modus != MODUS_SPIEL && now - modusSeit >= MODUS_MS) spielMenue();
  char taste = neueTaste(now);
  if (!taste) return false;
  sitzungSeit = now;
  modusSeit = now;
  if (modus == MODUS_EINSATZ) einsatzTaste(taste);
  else if (modus == MODUS_ABMELDEN) abmeldenTaste(taste);
  else if (modus == MODUS_HILFE && taste == 'D') { tonKlick(); hilfeZeigen((byte)(hilfeSeite + 1)); }
  else if (modus == MODUS_HILFE && taste == '*') { tonKlick(); spielMenue(); }
  else { modus = MODUS_SPIEL; spielTaste(taste); }   // In der Hilfe wirkt jede andere Taste direkt.
  return true;
}

void spielSetup() {
  for (byte i = 0; i < 4; ++i) {
    pinMode(KEYPAD_REIHEN[i], INPUT);
    digitalWrite(KEYPAD_REIHEN[i], LOW);
    pinMode(KEYPAD_SPALTEN[i], INPUT_PULLUP);
  }
  if (TON_MODUS) {
    digitalWrite(TON_PIN, TON_MODUS == 2 ? !TON_AKTIV : LOW);
    pinMode(TON_PIN, OUTPUT);
  }
  tastenSperren();
}
#endif
