#ifndef CASINO_GAME_RUNTIME_H
#define CASINO_GAME_RUNTIME_H
#include "GameSounds.h"
// Included after RFID and LCD helpers in MiniCasino.ino.
// Buttons: normally-open contact from A0/A1/A2 to GND, internal pullups.
const byte TASTEN[3] = {A0, A1, A2}; // Schwarz, Rot, Gruen.
const byte LEDS[3] = {A3, A4, A5};   // Je Pin -> 330 Ohm -> LED-Anode; Kathode -> GND.
const byte TON_PIN = 2;
// In MiniCasino.ino einstellen: 0 aus, 1 passiver Buzzer, 2 aktiver Buzzer.
// Testanschluss: D2 -> 330 Ohm -> S, Minus -> GND; unbekannte Mitte offen.
const byte TON_MODUS = CASINO_SOUND_MODE;
static_assert(TON_MODUS <= 2, "TON_MODUS: 0 aus, 1 passiv, 2 aktiv");
const byte TON_AKTIV = HIGH; // Nur Modultyp 2: ggf. laut Datenblatt LOW.
Casino::ButtonBank tasten;
// Eine Sitzung beginnt mit dem kurzen Auflegen der Karte und laeuft danach ohne
// sie weiter. Gespielt wird gegen das Konto im EEPROM; spielGuthaben ist nur
// die Anzeige dazu, massgeblich ist immer uidListe.balance(spielSlot).
bool spielAktiv = false;
MFRC522::Uid spielUid;
int spielSlot = -1;
uint32_t spielGuthaben = 0;
bool spielUnbegrenzt = false; // Adminkarte: setzt und gewinnt ohne Buchung.
// Einsatz der laufenden Sitzung. Liegt als Vielfaches von zehn Punkten beim
// Konto im EEPROM und gilt damit beim naechsten Auflegen wieder.
uint32_t spielEinsatz = Casino::STAKE;
unsigned long sitzungSeit = 0;
// Einsatz einstellen: Schwarz gedrueckt halten laesst den Wert im Kreis
// hochlaufen, immer schneller. Loslassen uebernimmt. Am oberen Ende geht es
// wieder bei zehn los, man kommt also ohne zweite Taste ueberall hin.
bool einsatzLoop = false;     // Laeuft hoch, solange die Taste gehalten wird.
bool einsatzFein = false;     // Danach: genau nachjustieren und bestaetigen.
byte einsatzTaste = 0;        // Taste, die die Rampe gestartet hat.
uint32_t einsatzWahl = 0;
unsigned long einsatzSchrittZeit = 0;
unsigned long einsatzLetzte = 0;
unsigned long einsatzHalteSeit = 0;
byte einsatzLed = 0;
// Bewusst konstant und ruhig: beschleunigt liesse sich nicht gezielt stoppen.
const unsigned long EINSATZ_SCHRITT_MS = 320UL;
const unsigned long EINSATZ_HALTEN_MS = 700UL;  // Erneut halten setzt die Rampe fort.
const unsigned long EINSATZ_FEIN_MS = 6000UL;   // Ohne Eingabe uebernehmen.
bool tonLaeuft = false;
unsigned long tonSeit = 0;
unsigned int tonDauer = 0;
// Drei Lautstaerkestufen, beim Start aus dem EEPROM geladen.
// Leise erzeugt denselben Ton mit schmalen Impulsen statt halbe-halbe: der
// Piezo bekommt weniger Energie und wird deutlich leiser. Das geht nur mit
// einem passiven Buzzer (Modus 1); ein aktiver kann nur an oder aus.
const byte TON_LAUT = 0, TON_LEISE = 1, TON_AUS = 2;
byte tonStufe = TON_LAUT;

// Eine Taste laenger als HALTEN_MS halten loest die zweite Funktion aus:
// Rot = abmelden, Gruen = Ton an/aus, Schwarz = Einsatz abbrechen.
// Kurz tippen loest beim Loslassen den Einsatz aus.
const unsigned long HALTEN_MS = 1200UL;
// Erst ab hier zeigt das LCD das Halten an. Ein kurzer Tipp laesst so weder
// Text noch LED aufblitzen, der Einsatz fuehlt sich unveraendert direkt an.
const unsigned long HALTE_ANZEIGE_MS = 250UL;
byte halteMaske = 0;
unsigned long halteSeit = 0;
bool halteAusgefuehrt = false;
byte halteBalken = 255;
unsigned long haltePuls = 0;
bool halteHell = false;
// Leerlauf-Animation, laeuft nichtblockierend aus loop().
unsigned long ledSeit = 0;
byte ledSchritt = 0;
bool ledHell = false;

void tonStart(unsigned int hz, unsigned int dauer);
void tonStop();
void tonSpiele(unsigned int hz, unsigned int dauer);

// Muster 0/1/2 = genau diese LED, 3 = alle aus, 4 = alle an.
// Der zuletzt gesetzte Zustand wird gemerkt, damit die Leerlauf-Animation
// nicht bei jedem Schleifendurchlauf dieselben Pins neu schreibt.
byte ledIst = 255;
void ledZeige(byte muster) {
  if (muster == ledIst) return;
  ledIst = muster;
  for (byte i = 0; i < 3; ++i)
    digitalWrite(LEDS[i], (muster == 4 || muster == i) ? HIGH : LOW);
}
void ledLauf(byte result) {
  byte start = (byte)random(3); // Nur optischer Start; aendert das Ergebnis nicht.
  byte count = Casino::spinSteps(start, result);
  meldung(F("Lauflicht..."), F("Viel Glueck!"));
  for (byte step = 0; step < count; ++step) {
    byte index = Casino::spinLed(start, step);
    ledZeige(index);
    unsigned int zeit = Casino::spinDelay(step, count);
    // Genau ein kurzer Tick pro LED-Wechsel; auch aktive Buzzer werden gestoppt.
    tonSpiele(1200 + index * 250, 18);
    delay(zeit - 18); // Gesamte Schrittdauer bleibt 45 bis 500 ms.
  }
  // Die letzte LED ist bereits das Ergebnis; kein nachtraeglicher Farbsprung.
}

byte tastenMaske() {
  byte mask = 0;
  for (byte i = 0; i < 3; ++i) if (digitalRead(TASTEN[i]) == LOW) mask |= (1 << i);
  return mask;
}
void tonStop() {
  if (TON_MODUS == 1) noTone(TON_PIN);
  if (TON_MODUS == 2) digitalWrite(TON_PIN, !TON_AKTIV);
  tonLaeuft = false;
}
void tonStart(unsigned int hz, unsigned int dauer) {
  if (!TON_MODUS || tonStufe == TON_AUS) return;
  if (TON_MODUS == 1) tone(TON_PIN, hz, dauer);
  else digitalWrite(TON_PIN, TON_AKTIV);
  tonSeit = millis(); tonDauer = dauer; tonLaeuft = true;
}
void tonService() {
  if (tonLaeuft && millis() - tonSeit >= tonDauer) tonStop();
}

// Leise: Rechteck von Hand takten, rund 8 Prozent Einschaltdauer.
// Blockiert fuer dauer Millisekunden, genau wie der laute Pfad mit delay().
void tonLeise(unsigned int hz, unsigned int dauer) {
  if (!hz || !dauer) { delay(dauer); return; }
  unsigned long periode = 1000000UL / hz;      // Mikrosekunden, min. 165 Hz.
  unsigned long an = periode / 12;
  if (an < 3) an = 3;
  if (an > periode - 3) an = periode - 3;
  unsigned long zyklen = ((unsigned long)dauer * 1000UL) / periode;
  for (unsigned long i = 0; i < zyklen; ++i) {
    digitalWrite(TON_PIN, HIGH);
    delayMicroseconds((unsigned int)an);
    digitalWrite(TON_PIN, LOW);
    delayMicroseconds((unsigned int)(periode - an));
  }
}

// Einen Ton vollstaendig abspielen und dabei dauer Millisekunden warten.
// Auch bei stumm wird gewartet, damit Lauflicht und Jingle immer gleich
// lange brauchen, egal welche Stufe eingestellt ist.
void tonSpiele(unsigned int hz, unsigned int dauer) {
  if (!TON_MODUS || tonStufe == TON_AUS) { delay(dauer); return; }
  if (TON_MODUS == 1 && tonStufe == TON_LEISE) { tonLeise(hz, dauer); return; }
  tonStart(hz, dauer);
  delay(dauer);
  tonStop();
}

void spieleSound(Casino::SoundEffect effect) {
  tonStop();
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
  // des Jingles; danach erzwingt die Tastenlogik erneutes Loslassen.
  for (byte i = 0; i < count; ++i) {
    Casino::SoundNote note;
    memcpy_P(&note, notes + i, sizeof(note));
    tonSpiele(note.hz, note.duration);
    delay(note.gap);
  }
}
// Zahl ausgeben und die Stellenzahl zurueckgeben, damit der Rest der Zeile
// gefuellt werden kann. LiquidCrystal verraet die Spalte nicht von selbst.
byte lcdZahl(uint32_t wert) {
  lcd.print((unsigned long)wert);
  byte stellen = 1;
  while (wert >= 10) { wert /= 10; ++stellen; }
  return stellen;
}
void lcdRest(byte benutzt) { for (byte i = benutzt; i < 16; ++i) lcd.print(' '); }

// Guthaben ausgeben. Adminkarten zeigen statt einer Zahl "inf".
byte lcdGuthaben(uint32_t wert) {
  if (spielUnbegrenzt) { lcd.print(F("inf")); return 3; }
  byte n = lcdZahl(wert);
  return (byte)(n + lcdWaehrung());
}

const __FlashStringHelper *farbe(byte index) {
  return index == 0 ? F("SCHWARZ") : index == 1 ? F("ROT") : F("GRUEN");
}
void spielMenue() {
  if (!spielAktiv) { meldung(F("Mini Casino v10"), F("Karte auflegen")); return; }
  lcd.setCursor(0, 0);
  byte n = lcdZahl(spielEinsatz);
  n = (byte)(n + lcdWaehrung());
  lcd.print(F(": S/R/G"));
  lcdRest((byte)(n + 7));
  lcd.setCursor(0, 1);
  lcdRest(lcdGuthaben(spielGuthaben));
  if (DEBUG_LOG) {
    logKopf(F("LCD"));
    Serial.print((unsigned long)spielEinsatz);
    Serial.print(F(": S/R/G / "));
    if (spielUnbegrenzt) Serial.println(F("inf"));
    else Serial.println((unsigned long)spielGuthaben);
  }
}
// Karte wurde erkannt: ab hier reichen die Tasten, die Karte darf weg.
void starteSitzung(const MFRC522::Uid &uid, int slot, uint32_t guthaben) {
  ledZeige(3);
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
  tasten.reset(tastenMaske(), millis());
  spielMenue();
}
// Nach SITZUNG_MS ohne Tastendruck. Das Guthaben bleibt im EEPROM stehen,
// aber weiterspielen darf nur, wer seine Karte erneut auflegt.
void beendeSitzung(bool manuell) {
  spielAktiv = false; spielSlot = -1; spielUnbegrenzt = false;
  ledZeige(3);
  logText(F("SITZUNG"), manuell ? F("Von Hand abgemeldet.")
                                : F("Zeit abgelaufen. Zum Weiterspielen Karte erneut kurz auflegen."));
  if (manuell) meldung(F("Abgemeldet"), F("Karte auflegen"));
  else spielMenue();
}

// Nichtblockierende LED-Rueckmeldung ausserhalb von Runden und Halten.
// Ohne Sitzung laeuft ein langsames Lauflicht, damit man sieht, dass der
// Automat wartet. Laeuft eine Sitzung, bleibt es ruhig - bis auf die letzten
// zehn Sekunden, die mit Blinken vorwarnen, und die letzten drei schneller.
void ledService(unsigned long now) {
  if (halteMaske || ergebnisSichtbar) return; // Halte-Rampe bzw. Ergebnis hat Vorrang.
  if (!spielAktiv) {
    if (now - ledSeit < 420UL) return;
    ledSeit = now;
    ledSchritt = (byte)((ledSchritt + 1) % 6);
    ledZeige(ledSchritt < 3 ? ledSchritt : 3);
    return;
  }
  unsigned long alt = now - sitzungSeit;
  if (SITZUNG_MS <= 10000UL || alt < SITZUNG_MS - 10000UL) { ledZeige(3); return; }
  unsigned long rest = alt >= SITZUNG_MS ? 0 : SITZUNG_MS - alt;
  unsigned long periode = rest > 3000UL ? 450UL : 130UL;
  if (now - ledSeit < periode) return;
  ledSeit = now;
  ledHell = !ledHell;
  ledZeige(ledHell ? 4 : 3);
}
// Aufloesung erst nach bestaetigter Buchung: Lauflicht, Ton und Klartext.
// Ein Abbruch waehrend des Lauflichts kann den Stand nicht mehr aendern.
// Netto-Ergebnis in eine Zeile schreiben. Ohne " Pkt", damit auch der groesste
// moegliche Gewinn (achtfacher Hoechsteinsatz) in 16 Zeichen passt.
void zeigeNetto(byte zeile, bool win, uint32_t netto) {
  lcd.setCursor(0, zeile);
  lcd.print(win ? F("Gewinn +") : F("Verlust -"));
  lcdRest((byte)((win ? 8 : 9) + lcdZahl(netto)));
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
  ledLauf(result);
  lcd.setCursor(0, 0);
  if (effect == Casino::SoundEffect::Jackpot) { lcd.print(F("JACKPOT! GRUEN")); lcdRest(14); }
  else { lcd.print(farbe(result)); lcdRest((byte)strlen_P((PGM_P)farbe(result))); }
  zeigeNetto(1, win, netto);
  spieleSound(effect); // Dauert in jeder Tonstufe gleich lang.
  zeigeNetto(0, win, netto);
  lcd.setCursor(0, 1);
  lcdRest(lcdGuthaben(balance));
  tasten.reset(tastenMaske(), millis());
}
// Eine vollstaendige Runde ohne Karte: Einsatz, Ziehung und Endstand werden in
// einer einzigen EEPROM-Buchung verrechnet. Scheitert sie, bleibt der alte
// Stand unveraendert und es wird kein Ergebnis gezeigt.
// A3 ist ein LED-Ausgang. Keine Analogmessung an diesem Pin!
void spiele(byte choice) {
  if (!spielAktiv) { meldung(F("Zuerst Karte"), F("kurz auflegen")); return; }
  sitzungSeit = millis();
  tonStop();
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
    meldung(balance < spielEinsatz ? F("Zu wenig Guthaben") : F("Einsatz zu hoch"),
            F("Schwarz halten")); return;
  }
  // Tastendruck-Zeitpunkt mischt den Pseudozufallszustand (kein Sicherheits-RNG).
  randomSeed((unsigned long)random(1L, 2147483647L) ^ micros());
  byte result = Casino::colourForTicket((byte)random(100));
  uint32_t neu = Casino::settled(balance - spielEinsatz, choice, result, spielEinsatz);
  ledZeige(3);
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

// --- Einsatz einstellen ---------------------------------------------------
// Groesster erlaubter Einsatz: nie mehr als das Guthaben, gedeckelt und auf
// ein Vielfaches des Schritts abgerundet.
uint32_t einsatzGrenze() {
  if (spielUnbegrenzt) return Casino::STAKE_MAX;   // Adminkarte kennt kein Limit.
  return Casino::stakeLimit(spielAktiv ? uidListe.balance(spielSlot) : Casino::STAKE);
}
// Der Schritt waechst mit der Hoehe, damit man auch grosse Einsaetze in
// wenigen Sekunden erreicht, unten aber fein bleibt.
uint32_t einsatzSchrittweite(uint32_t wert) {
  return wert < 100 ? 10UL : wert < 500 ? 50UL : 100UL;
}
void einsatzAnzeigen() {
  lcd.setCursor(0, 0);
  lcd.print(F("Einsatz "));
  byte n = (byte)(8 + lcdZahl(einsatzWahl));
  lcdRest((byte)(n + lcdWaehrung()));
  lcd.setCursor(0, 1);
  lcd.print(einsatzLoop ? F("Loslassen = stop") : F("S-10  R+10  G ok"));
}
// Ein Schritt der Rampe. Laeuft am oberen Ende wieder bei zehn los.
void einsatzLoopSchritt(unsigned long now) {
  if (now - einsatzSchrittZeit < EINSATZ_SCHRITT_MS) return;
  einsatzSchrittZeit = now;
  uint32_t grenze = einsatzGrenze();
  uint32_t schritt = einsatzSchrittweite(einsatzWahl);
  einsatzWahl = (einsatzWahl + schritt > grenze) ? Casino::STAKE_SCHRITT
                                                 : einsatzWahl + schritt;
  einsatzLed = (byte)((einsatzLed + 1) % 3);          // Lauflicht als Rueckmeldung
  ledZeige(einsatzLed);
  einsatzAnzeigen();
  tonSpiele((unsigned int)(1100 + einsatzLed * 220), 8);
}
// Rampe anhalten, aber noch nicht buchen: jetzt kann genau nachjustiert werden.
void einsatzLoopStoppen(unsigned long now) {
  einsatzLoop = false;
  einsatzFein = true;
  einsatzLetzte = now;
  einsatzHalteSeit = 0;
  ledZeige(3);
  einsatzAnzeigen();
}
// Genau ein Schritt von zehn Punkten, damit jeder Wert erreichbar ist.
void einsatzFeinSchritt(bool hoch, unsigned long now) {
  uint32_t grenze = einsatzGrenze();
  if (hoch) einsatzWahl = (einsatzWahl + Casino::STAKE_SCHRITT > grenze)
    ? grenze : einsatzWahl + Casino::STAKE_SCHRITT;
  else einsatzWahl = (einsatzWahl > Casino::STAKE_SCHRITT * 2 - 1)
    ? einsatzWahl - Casino::STAKE_SCHRITT : Casino::STAKE_SCHRITT;
  einsatzLetzte = now;
  einsatzAnzeigen();
  tonSpiele(hoch ? 1500 : 900, 10);
}
void einsatzUebernehmen() {
  einsatzLoop = false;
  einsatzFein = false;
  ledZeige(3);
  spielEinsatz = einsatzWahl;
  uint8_t einheiten = (uint8_t)(spielEinsatz / Casino::STAKE_SCHRITT);
  bool gemerkt = uidListe.setStakeUnits(spielSlot, einheiten);
  if (DEBUG_LOG) {
    logKopf(F("EINSATZ"));
    Serial.print((unsigned long)spielEinsatz);
    Serial.println(gemerkt ? F(" Punkte, beim Konto gespeichert.")
                           : F(" Punkte, nur fuer diese Sitzung."));
  }
  sitzungSeit = millis();
  tasten.reset(tastenMaske(), millis());
  spielMenue();
}
void einsatzWeiter(byte taste, unsigned long now) {
  einsatzLoop = true;
  einsatzFein = false;
  einsatzTaste = taste;
  einsatzSchrittZeit = now;
  einsatzHalteSeit = 0;
  einsatzAnzeigen();
}
void einsatzStarten() {
  einsatzWahl = spielEinsatz;
  uint32_t grenze = einsatzGrenze();
  if (einsatzWahl > grenze) einsatzWahl = grenze;
  einsatzLed = 0;
  // Die Halte-Erkennung ist erledigt; ab hier fuehrt der Einsatz die Tasten.
  halteMaske = 0;
  halteBalken = 255;
  logText(F("EINSATZ"), F("Laeuft hoch, solange gehalten. Loslassen haelt an, dann S/R fein, G ok."));
  einsatzWeiter(1, millis());
}
// Solange Rampe oder Feinphase laufen, gehoeren die Tasten dem Einsatz.
bool einsatzService(byte maske, byte start, unsigned long now) {
  if (einsatzLoop) {
    if (maske == einsatzTaste) { einsatzLoopSchritt(now); return true; }
    einsatzLoopStoppen(now);
    return true;
  }
  if (start == 4) { einsatzUebernehmen(); return true; }
  if (start == 1 || start == 2) {
    einsatzFeinSchritt(start == 2, now);
    einsatzHalteSeit = now;   // Bleibt die Taste liegen, laeuft die Rampe weiter.
    return true;
  }
  if (maske == 1 || maske == 2) {
    if (!einsatzHalteSeit) einsatzHalteSeit = now;
    else if (now - einsatzHalteSeit >= EINSATZ_HALTEN_MS) einsatzWeiter(maske, now);
    return true;
  }
  einsatzHalteSeit = 0;
  if (now - einsatzLetzte >= EINSATZ_FEIN_MS) einsatzUebernehmen();
  return true;
}

// --- Tasten: kurz tippen spielt, halten loest die zweite Funktion aus ------

byte halteIndex(byte maske) { return maske == 1 ? 0 : maske == 2 ? 1 : 2; }
// Ein aktiver Buzzer kann nur an oder aus, dort entfaellt die Stufe leise.
byte naechsteStufe() {
  if (TON_MODUS == 2) return tonStufe == TON_LAUT ? TON_AUS : TON_LAUT;
  return tonStufe == TON_LAUT ? TON_LEISE : tonStufe == TON_LEISE ? TON_AUS : TON_LAUT;
}
const __FlashStringHelper *stufenName(byte stufe) {
  return stufe == TON_LAUT ? F("Ton laut") : stufe == TON_LEISE ? F("Ton leise") : F("Ton aus");
}
const __FlashStringHelper *halteTitel(byte maske) {
  if (maske == 2) return spielAktiv ? F("Logout") : F("Keine Sitzung");
  if (maske == 4) return TON_MODUS ? stufenName(naechsteStufe()) : F("Kein Buzzer");
  return spielAktiv ? F("Einsatz aendern") : F("Keine Sitzung");
}

// Waehrend des Haltens: Balken auf dem LCD und Blinken, das immer schneller
// wird, je naeher die Aktion rueckt. Der Balken wird nur bei Aenderung neu
// gezeichnet, sonst flimmert das Display.
void zeigeHaltefortschritt(byte maske, unsigned long dauer, unsigned long now) {
  if (dauer < HALTE_ANZEIGE_MS) return;
  byte fuell = (byte)(((dauer - HALTE_ANZEIGE_MS) * 16UL) / (HALTEN_MS - HALTE_ANZEIGE_MS));
  if (fuell > 16) fuell = 16;
  if (fuell != halteBalken) {
    halteBalken = fuell;
    lcd.setCursor(0, 0);
    lcd.print(halteTitel(maske));
    for (byte i = strlen_P((PGM_P)halteTitel(maske)); i < 16; ++i) lcd.print(' ');
    lcd.setCursor(0, 1);
    for (byte i = 0; i < 16; ++i) {
      if (i < fuell) lcd.write((uint8_t)255); else lcd.print(' ');
    }
  }
  // 260 ms Blinkperiode zu Beginn, 60 ms kurz vor dem Ausloesen.
  unsigned long periode = 260UL - (200UL * dauer) / HALTEN_MS;
  if (periode < 60UL) periode = 60UL;
  if (now - haltePuls < periode / 2) return;
  haltePuls = now;
  halteHell = !halteHell;
  ledZeige(halteHell ? halteIndex(maske) : 3);
}

// Kurze Bestaetigung: dreimal alle LEDs, dazu ein kurzer Ton.
void halteQuittung(unsigned int hz) {
  for (byte i = 0; i < 3; ++i) {
    ledZeige(4); tonSpiele(hz, 40); delay(30);
    ledZeige(3); delay(70);
  }
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
  halteQuittung(tonStufe == TON_AUS ? 400 : 1400); // In Stufe aus bleibt es still.
}

// Wird erreicht, sobald HALTEN_MS voll sind.
void halteAktion(byte maske) {
  if (maske == 4) {
    if (!TON_MODUS) { meldung(F("Kein Buzzer"), F("CASINO_SOUND_MODE")); return; }
    tonStufeWeiter();
    return;
  }
  if (maske == 2) {
    if (!spielAktiv) { meldung(F("Keine Sitzung"), F("Karte auflegen")); return; }
    halteQuittung(700);
    beendeSitzung(true);
    return;
  }
  if (!spielAktiv) { meldung(F("Keine Sitzung"), F("Karte auflegen")); return; }
  einsatzStarten();
}

// Gibt true zurueck, wenn die Tasten diesen Durchlauf belegen und der
// RFID-Scan uebersprungen werden soll.
bool tastenService(unsigned long now) {
  byte maske = tastenMaske();
  byte start = tasten.update(maske, now);
  if (einsatzLoop || einsatzFein) return einsatzService(maske, start, now);
  if (start) {
    halteMaske = start; halteSeit = now; halteAusgefuehrt = false;
    halteBalken = 255; haltePuls = now; halteHell = false;
    return true;
  }
  if (!halteMaske) return false;
  if (maske == halteMaske) {
    if (halteAusgefuehrt) return true; // Aktion lief schon, nur noch loslassen.
    unsigned long dauer = now - halteSeit;
    if (dauer >= HALTEN_MS) {
      halteAusgefuehrt = true;
      halteAktion(halteMaske);
      ergebnisSeit = naechsterScanSeit = millis();
      ergebnisSichtbar = scanPause = true;
      return true;
    }
    zeigeHaltefortschritt(halteMaske, dauer, now);
    return true;
  }
  // Losgelassen oder zweite Taste dazugekommen.
  byte war = halteMaske;
  bool erledigt = halteAusgefuehrt;
  halteMaske = 0; halteBalken = 255;
  if (maske != 0) { ledZeige(3); startAnzeige(); return true; }
  if (erledigt) { ledZeige(3); return true; }
  spiele(halteIndex(war));
  tasten.reset(tastenMaske(), millis());
  ergebnisSeit = naechsterScanSeit = millis();
  ergebnisSichtbar = scanPause = true;
  return true;
}

void spielSetup() {
  for (byte i = 0; i < 3; ++i) pinMode(TASTEN[i], INPUT_PULLUP);
  for (byte i = 0; i < 3; ++i) {
    digitalWrite(LEDS[i], LOW);
    pinMode(LEDS[i], OUTPUT);
  }
  if (TON_MODUS) {
    digitalWrite(TON_PIN, TON_MODUS == 2 ? !TON_AKTIV : LOW);
    pinMode(TON_PIN, OUTPUT);
  }
  tasten.reset(tastenMaske(), millis());
  randomSeed(micros());
}
#endif
