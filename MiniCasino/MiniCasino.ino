/*
 * Mini Casino - Konten im EEPROM, Karte als Ausweis, Ausgabe auf QAPASS 1602A
 *
 * Hardware: Arduino Uno (ATmega328P), RC522, 16x2-LCD ohne I2C-Adapter.
 * Bestaetigte LCD-Belegung: RS->D8, E->D7, D4->D6, D5->D5, D6->D4, D7->D3.
 * LCD: VSS/RW->GND, VDD->5V, VO->10-kOhm-Poti, A->200 Ohm->5V, K->GND.
 * RC522: SS/SDA->D10, RST->D9, MOSI->D11, MISO->D12, SCK->D13, VCC->3.3V.
 * Vollstaendige Stromversorgung/Pegelwandlung: siehe ../ANLEITUNG.md.
 *
 * Ablauf:
 * 1. Karte kurz auflegen. Erkannt wird nur die UID.
 * 2. Konto im EEPROM suchen; unbekannte UID einmalig mit 100 Punkten anlegen.
 * 3. Sitzung laeuft ohne Karte: Farbe druecken, so lange und so oft gewuenscht.
 * 4. Jede Runde wird in einer EEPROM-Buchung verrechnet und zurueckgelesen.
 * 5. Nach SITZUNG_MS ohne Tastendruck endet die Sitzung; Karte neu auflegen.
 *
 * Der Kartenspeicher wird NICHT mehr gelesen oder beschrieben. Es gibt keine
 * Classic-Anmeldung, keine Leerheits-/NDEF-Pruefung und keinen Schreibvorgang.
 * Jede Karte taugt als Ausweis, auch eine voll belegte.
 * Speicher: EEPROM-Format 07, 16 Byte Header + 32 Byte je Konto, 31 Konten.
 * Jedes Konto haelt zwei Kopien mit eigener CRC; geschrieben wird abwechselnd,
 * damit ein Stromausfall waehrend einer Buchung nie ein Konto zerstoert.
 * V10: Guthaben im EEPROM statt auf der Karte. Einmal kurz auflegen genuegt.
 * V9: Farbspiel mit Tasten A0/A1/A2, 10 Punkten Einsatz und Buzzer-Sounds.
 * Einmaliges Startguthaben pro UID. Die alte Merkliste (Format 06) wird nicht
 * uebernommen und nicht ueberschrieben: siehe CASINO_EEPROM_LOESCHEN.
 * Auszahlung Schwarz/Rot 20, Gruen 90, Verlust 0. Chancen: 45/45/10 Prozent.
 * LEDs: A3/A4/A5 mit je 330 Ohm nach GND.
 * Spielplan/Taster: ../SPIELPLAN_V8.md; Ton D2: ../SOUND_V9.md. Kein FORCE.
 * Guthaben sind ganze Spielpunkte, kein manipulationsgeschuetztes Bezahlsystem.
 * Bibliotheken: SPI/EEPROM (Arduino Core) und LiquidCrystal (Arduino Core).
 * MFRC522 1.4.12 liegt als Kopie im Sketch-Ordner (Public Domain, Unlicense),
 * damit der Sketch ohne Bibliotheksverwalter kompiliert.
 */

// Ton ist eingeschaltet. 1 = passiver Buzzer (Melodien), 2 = aktiver Buzzer
// (nur Piepsrhythmus), 0 = aus. Der Modultyp ist bisher nicht bestaetigt.
// D2 -> 330 Ohm -> S; Minus -> GND; unbekannten mittleren Pin offen lassen.
#ifndef CASINO_SOUND_MODE
#define CASINO_SOUND_MODE 1
#endif

// Nachlade-Modus: nur voruebergehend einschalten, wenn alle Punkte verspielt
// sind. 1 = beim Start jedes bekannte Konto unter STARTGUTHABEN auf
// STARTGUTHABEN anheben. Es wird nichts geloescht und keine Karte beschrieben.
// Danach zurueck auf 0 setzen und neu hochladen, sonst fuellt jeder Neustart
// alle Konten wieder auf.
#ifndef CASINO_NACHLADEN
#define CASINO_NACHLADEN 0
#endif

// ACHTUNG, unwiderruflich: 1 verwirft beim Start den gesamten EEPROM-Bereich,
// also ALLE UIDs UND ALLE GUTHABEN. Genau einmal noetig beim Wechsel von der
// alten Merkliste (Format 06) auf die Konten (Format 07), weil vorhandene
// Fremddaten nie automatisch ueberschrieben werden. Sofort danach wieder auf 0
// setzen und neu hochladen.
#ifndef CASINO_EEPROM_LOESCHEN
#define CASINO_EEPROM_LOESCHEN 0
#endif

// Waehrung auf dem LCD. 1 = Euro-Zeichen, 0 = "Pkt".
// Der HD44780 kennt kein Euro-Zeichen; es wird als eigenes Zeichen definiert
// und liegt dann auf Code 0. Am Spiel aendert das nichts, es sind weiterhin
// reine Spielpunkte ohne jeden Gegenwert.
#ifndef CASINO_EURO
#define CASINO_EURO 1
#endif

// Simulationsbetrieb ohne RC522 (z.B. Wokwi). 1 = statt des Readers stehen
// vier Taster an D9 bis D12 fuer vier Karten. Sonst ist alles identisch:
// gleiche Pins, gleiches Spiel, gleicher EEPROM, gleiche Verwaltung.
#ifndef CASINO_SIM
#define CASINO_SIM 0
#endif

#include <Arduino.h>
#include <SPI.h>
#include "MFRC522.h"   // Liegt im Sketch-Ordner, kein Bibliotheksverwalter noetig.
#include <LiquidCrystal.h>
#include <EEPROM.h>
#include <string.h>
#include "UidRegistry.h"
#include "GameRules.h"
#include "ButtonBank.h"
// EmptyRegion.h und CardRecord.h gehoeren nicht mehr zum Sketch: Guthaben
// liegen im EEPROM, der Kartenspeicher wird nicht mehr angefasst. Die Dateien
// und ihre Tests bleiben als Beleg fuer das alte Kartenformat liegen.

void spielMenue();

// LCD: RS, E, D4, D5, D6, D7 (jeweils Arduino-Pins).
LiquidCrystal lcd(8, 7, 6, 5, 4, 3);
MFRC522 rfid(10, 9);
Casino::UidRegistry<EEPROMClass> uidListe(EEPROM);

const uint32_t STARTGUTHABEN = 100;  // Ganze Spielpunkte.
const bool DEBUG_LOG = true;       // Nach der Fehlersuche auf false setzen.
const unsigned long LOG_BAUD = 115200UL;
const unsigned long ANZEIGEDAUER_MS = 5000UL;
const unsigned long SCAN_PAUSE_MS = 1000UL;   // Nach erfolgreich gelesener Karte.
// Nach einem Funkfehler darf es sofort weitergehen: eine Sekunde Zwangspause
// fuehlt sich an, als wuerde die Karte gar nicht erkannt.
const unsigned long FEHLER_PAUSE_MS = 120UL;
const byte SCAN_VERSUCHE = 3;  // Schnelle Wiederholungen je Durchlauf.
// Nach so langer Tastenruhe endet die Sitzung. Sonst koennte jemand anderes
// einfach weiterdruecken und das Guthaben des letzten Spielers verbrauchen.
const unsigned long SITZUNG_MS = 60000UL;
// Diese Zustandswerte liegen im Arduino-RAM; das Guthaben liegt im EEPROM.
bool readerBereit = false;
bool ergebnisSichtbar = false;
unsigned long ergebnisSeit = 0;
unsigned long letzterLog = 0;
unsigned long letzteAbfrage = 0;
unsigned long naechsterScanSeit = 0;
bool scanPause = false;
unsigned long scanPauseDauer = SCAN_PAUSE_MS;
unsigned long scanNummer = 0;
unsigned long abfragen = 0;
unsigned long keineAntwort = 0;
unsigned long funkfehler = 0;
unsigned long letzterFunkfehler = 0;
byte fehlerFolge = 0;
bool funkHinweisGezeigt = false;

void logKopf(const __FlashStringHelper *thema) {
  if (!DEBUG_LOG) return;
  Serial.print('[');
  Serial.print(millis());
  Serial.print(F(" ms] "));
  Serial.print(thema);
  Serial.print(F(" | "));
}

void logText(const __FlashStringHelper *thema, const __FlashStringHelper *text) {
  if (!DEBUG_LOG) return;
  logKopf(thema);
  Serial.println(text);
}

void logHex(byte wert) {
  if (!DEBUG_LOG) return;
  if (wert < 0x10) Serial.print('0');
  Serial.print(wert, HEX);
}

void logBytes(const __FlashStringHelper *thema, const byte *daten, byte anzahl) {
  if (!DEBUG_LOG) return;
  logKopf(thema);
  for (byte i = 0; i < anzahl; ++i) {
    if (i) Serial.print(' ');
    logHex(daten[i]);
  }
  Serial.println();
}

void logStatus(const __FlashStringHelper *schritt, MFRC522::StatusCode status,
               byte adresse) {
  if (!DEBUG_LOG) return;
  logKopf(schritt);
  if (adresse != 0xFF) {
    Serial.print(F("Adresse="));
    Serial.print(adresse);
    Serial.print(' ');
  }
  Serial.print(F("Status="));
  Serial.print((byte)status);
  Serial.print(F(" ("));
  Serial.print(rfid.GetStatusCodeName(status));
  Serial.println(')');
}
// Lebenszeichen ohne Logflut: Timeouts bei REQA sind ohne neue Karte normal.
void logLebenszeichen() {
  if (!DEBUG_LOG || millis() - letzterLog < 5000UL) return;
  letzterLog = millis();
  logKopf(F("LIVE"));
  Serial.print(F("ReaderBereit="));
  Serial.print(readerBereit);
  Serial.print(F(" Abfragen="));
  Serial.print(abfragen);
  Serial.print(F(" REQA-Timeouts="));
  Serial.print(keineAntwort);
  Serial.print(F(" Scans="));
  Serial.print(scanNummer);
  Serial.print(F(" Erkennungsfehler="));
  Serial.print(funkfehler);
  Serial.print(F(" Firmware=0x"));
  logHex(rfid.PCD_ReadRegister(MFRC522::VersionReg));
  Serial.println();
}

// Zwei kurze Zeilen aus dem Flash ausgeben. Texte passen in 16 Zeichen.
void meldung(const __FlashStringHelper *oben,
             const __FlashStringHelper *unten) {
  lcd.setCursor(0, 0);
  lcd.print(oben);
  for (byte i = strlen_P((PGM_P)oben); i < 16; ++i) lcd.print(' ');
  lcd.setCursor(0, 1);
  lcd.print(unten);
  for (byte i = strlen_P((PGM_P)unten); i < 16; ++i) lcd.print(' ');
  if (DEBUG_LOG) {
    logKopf(F("LCD"));
    Serial.print(oben);
    Serial.print(F(" / "));
    Serial.println(unten);
  }
}

// Bereitschaft anzeigen, ohne die Karte oder ihr Guthaben zu veraendern.
void startAnzeige() {
  spielMenue();
  ergebnisSichtbar = false;
}

// Einzelne Erkennungsfehler nur protokollieren. Erst eine Serie meldet das LCD.
// REQA-Timeouts ohne neue Karte werden hier bewusst nicht mitgezaehlt.
void erkennungsfehler() {
  ++funkfehler;
  if (millis() - letzterFunkfehler > 5000UL) {
    fehlerFolge = 0;
    funkHinweisGezeigt = false;
  }
  letzterFunkfehler = millis();
  if (fehlerFolge < 249) ++fehlerFolge;
  else fehlerFolge = 3;
  rfid.PCD_StopCrypto1();
  if (fehlerFolge % 3 == 0) {
    logText(F("RF RECOVERY"), F("Drei weitere Erkennungsfehler; Antennenfeld kurz neu starten."));
    rfid.PCD_AntennaOff();
    delay(20);
    rfid.PCD_AntennaOn();
    delay(20);
  }
  if (fehlerFolge >= 3 && !funkHinweisGezeigt && !ergebnisSichtbar) {
    meldung(F("Karte ruhig"), F("auflegen"));
    funkHinweisGezeigt = true;
    ergebnisSeit = millis();
    ergebnisSichtbar = true;
  }
}
// Eigenes Zeichen fuer den Euro, 5x8 Punkte auf Code 0.
// Nicht const: createChar() erwartet einen beschreibbaren Zeiger. Acht Byte RAM.
byte EURO_ZEICHEN[8] = {
  0b00111, 0b01000, 0b11110, 0b01000, 0b11110, 0b01000, 0b00111, 0b00000
};
// Waehrung anhaengen und die belegten Stellen zurueckgeben.
byte lcdWaehrung() {
#if CASINO_EURO
  lcd.write((uint8_t)0);   // Direkt an die Zahl, ohne Leerzeichen: 250<euro>
  return 1;
#else
  lcd.print(F(" Pkt"));
  return 4;
#endif
}

// Bis zu zehn Ziffern plus Waehrung passen auch beim groessten uint32_t aufs LCD.
void zeigeGuthaben(uint32_t guthaben, bool neu) {
  meldung(neu ? F("Neu aufgeladen!") : F("Guthaben:"), F(""));
  lcd.setCursor(0, 1);
  lcd.print((unsigned long)guthaben);
  lcdWaehrung();
  if (DEBUG_LOG) {
    logKopf(F("GUTHABEN"));
    Serial.print(neu ? F("Neu gespeichert und geprueft: ") : F("Vorhanden: "));
    Serial.println((unsigned long)guthaben);
  }
}

#include "GameRuntime.h"
void bearbeiteKarte(); // Wird auch vom CARD-Befehl der Verwaltung genutzt.

// Eine UID in den Leser legen, als haette er sie gerade erkannt.
void legeKarteAuf(const byte *uid, byte laenge) {
  rfid.uid.size = laenge;
  for (byte i = 0; i < laenge; ++i) rfid.uid.uidByte[i] = uid[i];
  // 4 Byte: MIFARE Classic 1K, 7 Byte: Ultralight. Beides akzeptiert der Sketch.
  rfid.uid.sak = laenge == 4 ? 0x08 : 0x00;
  logBytes(F("UID"), rfid.uid.uidByte, rfid.uid.size);
  bearbeiteKarte();
}
#include "AdminSerial.h"

// Verarbeitet genau die durch PICC_Select ausgewaehlte Karte.
// Ab Format 07 liegt das Guthaben im EEPROM des Uno. Der Kartenspeicher wird
// weder gelesen noch beschrieben: es gibt keine Classic-Anmeldung, keine
// Leerheits-/NDEF-Pruefung und keinen Schreibvorgang mehr. Die Karte dient nur
// noch als Ausweis fuer ihre UID, deshalb reicht kurzes Auflegen.
// Halt/StopCrypto erfolgen anschliessend zentral in loop().
void bearbeiteKarte() {
  const MFRC522::Uid erwartet = rfid.uid;
  MFRC522::PICC_Type typ = rfid.PICC_GetType(rfid.uid.sak);
  if (DEBUG_LOG) {
    logKopf(F("TYPE"));
    Serial.print(rfid.PICC_GetTypeName(typ));
    Serial.print(F(" SAK=0x"));
    logHex(rfid.uid.sak);
    Serial.println();
  }
  int slot = uidListe.find(erwartet.uidByte, erwartet.size);
  if (slot == -2) {
    logText(F("UID-LISTE"), F("EEPROM ungueltig/nicht bereit. Kein Konto nutzbar."));
    meldung(F("UID-Liste Fehler"), F("Siehe Log"));
    return;
  }
  // Gesperrte Karte: gar nichts tun, auch keine Sitzung starten.
  if (slot >= 0 && uidListe.banned(slot)) {
    logText(F("KONTO"), F("Karte ist gesperrt. Keine Sitzung, kein Zugriff aufs Guthaben."));
    meldung(F("Karte gesperrt"), F("Siehe Admin"));
    return;
  }
  bool neuesKonto = false;
  if (slot == -1) {
    // Reservierung muss lesbar sein, BEVOR ein Startguthaben gilt.
    slot = uidListe.reserve(erwartet.uidByte, erwartet.size);
    if (slot < 0) {
      logText(F("UID-LISTE"), F("Keine Reservierung moeglich; Liste voll oder ungueltig."));
      meldung(slot == -3 ? F("UID-Liste voll") : F("UID-Liste Fehler"), F("Nicht aufgeladen"));
      return;
    }
    if (!uidListe.confirm(slot)) {
      logText(F("UID-LISTE"), F("Eintrag nicht bestaetigt. Karte erneut auflegen."));
      meldung(F("Aufladung offen"), F("Siehe Log"));
      return;
    }
    neuesKonto = true;
    logText(F("UID-LISTE"), F("Neue UID dauerhaft registriert."));
  }
  if (!uidListe.funded(slot)) {
    // Ohne lesbare Kontokopie wurde nie ein Startguthaben gebucht. Das
    // Nachholen ist deshalb kein zweites Startguthaben fuer dieselbe UID.
    if (!uidListe.setBalance(slot, STARTGUTHABEN)) {
      logText(F("KONTO"), F("Erstgutschrift nicht bestaetigt. Karte erneut auflegen."));
      meldung(F("Aufladung offen"), F("Siehe Log"));
      return;
    }
    logText(F("KONTO"), neuesKonto ? F("Einmaliges Startguthaben gutgeschrieben.")
                                   : F("Offene Erstgutschrift nachgeholt."));
    neuesKonto = true;
  }
  uint32_t guthaben = uidListe.balance(slot);
  if (!neuesKonto) logText(F("KONTO"), F("Bekannte UID; Guthaben aus dem EEPROM geladen."));
  zeigeGuthaben(guthaben, neuesKonto);
  starteSitzung(erwartet, slot, guthaben);
}


// Einmal nach Einschalten/Reset: LCD und Reader starten, Standardschluessel setzen.
#if CASINO_SIM
// Kartenleser-Ersatz: vier Taster gegen GND, auf den Pins des RC522.
// Jeder steht fest fuer eine Karte, zwei Classic und zwei Ultralight.
const byte SIM_PINS[4] = {9, 10, 11, 12};
const byte SIM_LEN[4] = {4, 4, 7, 7};
const byte SIM_UIDS[4][7] = {
  {0xDF, 0x51, 0xAA, 0x39, 0x00, 0x00, 0x00},
  {0x08, 0x85, 0xB1, 0xA8, 0x00, 0x00, 0x00},
  {0x04, 0x9F, 0x90, 0x5C, 0x11, 0x01, 0x89},
  {0x04, 0xCA, 0xBD, 0x5C, 0x11, 0x01, 0x89}
};
byte simGedrueckt = 0;
unsigned long simEntprellt = 0;

void simSetup() {
  for (byte i = 0; i < 4; ++i) pinMode(SIM_PINS[i], INPUT_PULLUP);
}
// Nur die neu hinzugekommene Taste zaehlt, wie ein einzelnes Auflegen.
void simService() {
  byte maske = 0;
  for (byte i = 0; i < 4; ++i)
    if (digitalRead(SIM_PINS[i]) == LOW) maske |= (byte)(1 << i);
  if (maske == simGedrueckt) return;
  if (millis() - simEntprellt < 40UL) return;
  simEntprellt = millis();
  byte neu = (byte)(maske & ~simGedrueckt);
  simGedrueckt = maske;
  for (byte i = 0; i < 4; ++i) {
    if (!(neu & (byte)(1 << i))) continue;
    legeKarteAuf(SIM_UIDS[i], SIM_LEN[i]);
    ergebnisSeit = millis();
    ergebnisSichtbar = true;
    return;   // Immer nur eine Karte gleichzeitig.
  }
}
#endif

void setup() {
  // Immer starten: darueber laeuft auch das Verwaltungsprotokoll (AdminSerial.h).
  Serial.begin(LOG_BAUD);
  if (DEBUG_LOG) {
    Serial.println();
    logText(F("BOOT"), F("Mini Casino v10 | 115200 Baud | LCD 8,7,6,5,4,3"));
    logText(F("MODUS"), F("Konten im EEPROM. Karte nur als Ausweis, Spiel ueber Tasten."));
    logText(F("BOOT"), F("Wiederholtes BOOT im laufenden Betrieb: Reset/Versorgung pruefen."));
  }
  spielSetup();
  lcd.begin(16, 2);
#if CASINO_EURO
  lcd.createChar(0, EURO_ZEICHEN); // Euro liegt danach auf Zeichencode 0.
#endif
#if CASINO_EEPROM_LOESCHEN
  uidListe.wipe();
  logText(F("EEPROM"), F("GELOESCHT: alle UIDs UND alle Guthaben verworfen."));
  logText(F("EEPROM"), F("Sofort CASINO_EEPROM_LOESCHEN auf 0 setzen und neu hochladen."));
#endif
  bool listeBereit = uidListe.begin();
  logText(F("UID-LISTE"), listeBereit ? F("Bereit: Uno fuehrt bis zu 31 Konten dauerhaft.")
                                      : F("EEPROM unbekannt/fremd. Konten gesperrt; siehe CASINO_EEPROM_LOESCHEN."));
#if CASINO_NACHLADEN
  if (listeBereit) {
    int aufgefuellt = 0;
    for (int slot = 0; slot < uidListe.capacity(); ++slot) {
      if (uidListe.funded(slot) && uidListe.balance(slot) < STARTGUTHABEN
          && uidListe.setBalance(slot, STARTGUTHABEN)) ++aufgefuellt;
    }
    if (DEBUG_LOG) {
      logKopf(F("NACHLADEN"));
      Serial.print(F("Konten auf Startguthaben angehoben: "));
      Serial.println(aufgefuellt);
    }
    logText(F("NACHLADEN"), F("Danach CASINO_NACHLADEN auf 0 setzen und neu hochladen."));
  }
#endif
  uint8_t tonOpt = listeBereit ? uidListe.options() : 0;
  tonStufe = (tonOpt & 1) ? TON_AUS : ((tonOpt & 2) ? TON_LEISE : TON_LAUT);
  if (TON_MODUS && DEBUG_LOG) {
    logKopf(F("TON"));
    Serial.print(stufenName(tonStufe));
    Serial.println(F(" | Gruen halten schaltet weiter: laut, leise, aus."));
  }
#if CASINO_SIM
  simSetup();
  readerBereit = true;
  logText(F("SIM"), F("Ohne RC522. Taster D9-D12 stehen fuer vier Karten."));
  meldung(F("Mini Casino v10"), F("Karte auflegen"));
  startAnzeige();
  return;
#endif
  meldung(F("Mini Casino"), F("Starte Reader..."));
  SPI.begin();
  rfid.PCD_Init();
  delay(50);
  byte version = rfid.PCD_ReadRegister(MFRC522::VersionReg);
  if (DEBUG_LOG) {
    logKopf(F("RFID"));
    Serial.print(F("Firmware=0x"));
    logHex(version);
    Serial.println();
  }
  if (version == 0x00 || version == 0xFF) {
    meldung(F("RFID fehlt"), F("Kabel pruefen"));
    return;
  }
  // Volle Empfangsverstaerkung (48 dB statt der ueblichen 33 dB). Kostet nichts
  // und bringt bei den schwachen Clone-Antennen deutlich mehr Reichweite.
  rfid.PCD_SetAntennaGain(MFRC522::RxGain_max);
  rfid.PCD_AntennaOff();
  delay(5);
  rfid.PCD_AntennaOn();
  delay(5);
  if (DEBUG_LOG) {
    logKopf(F("RFID"));
    Serial.print(F("Antennengewinn=0x"));
    logHex(rfid.PCD_GetAntennaGain());
    Serial.println();
  }
  readerBereit = true; // Auch euer Clone mit Version 0x88 wird akzeptiert.
  startAnzeige();
}

// Wiederholt Karten abfragen. millis()-Differenz funktioniert auch beim Ueberlauf.
// Eine Sekunde Scan-Abstand verhindert schnelle Fehler-/LCD-Wiederholungen.
void loop() {
  tonService();
  adminService(); // Verwaltungsbefehle haben nie Vorrang vor dem Spiel.
  unsigned long jetzt = millis();
  // Kurz tippen spielt, halten loest die zweite Funktion aus. Solange eine
  // Taste liegt, wird nicht nach Karten gesucht. Bewusst unabhaengig vom
  // Reader: ohne RC522 (Simulation, defektes Modul) bleiben Tasten, LCD und
  // das Verwaltungsprotokoll trotzdem bedienbar.
  if (tastenService(jetzt)) return;
  ledService(jetzt);
  logLebenszeichen();
  if (spielAktiv && millis() - sitzungSeit >= SITZUNG_MS) beendeSitzung(false);
  if (!readerBereit) return;
  if (ergebnisSichtbar && millis() - ergebnisSeit >= ANZEIGEDAUER_MS) startAnzeige();
#if CASINO_SIM
  simService();   // Kein Funk: die Karten kommen von den Tastern.
  return;
#endif
  if (scanPause && millis() - naechsterScanSeit < scanPauseDauer) return;
  scanPause = false;
  if (millis() - letzteAbfrage < 100UL) return;
  letzteAbfrage = millis();

  // Mehrere schnelle Versuche pro Durchlauf. Ein einzelner Funkfehler darf
  // nicht dazu fuehren, dass eine aufliegende Karte uebersehen wird.
  // WUPA statt REQA: das weckt auch eine Karte, die nach dem letzten Lesen
  // angehalten wurde und einfach liegen geblieben ist.
  byte atqa[2];
  byte laenge = sizeof(atqa);
  MFRC522::StatusCode status = MFRC522::STATUS_TIMEOUT;
  MFRC522::StatusCode auswahl = MFRC522::STATUS_ERROR;
  for (byte versuch = 0; versuch < SCAN_VERSUCHE; ++versuch) {
    // Gleiche Registervorbereitung wie PICC_IsNewCardPresent in MFRC522.
    // Direkte Aufrufe liefern den Fehlercode, den die bool-Wrapper verbergen.
    rfid.PCD_WriteRegister(MFRC522::TxModeReg, 0x00);
    rfid.PCD_WriteRegister(MFRC522::RxModeReg, 0x00);
    rfid.PCD_WriteRegister(MFRC522::ModWidthReg, 0x26);
    laenge = sizeof(atqa);
    status = rfid.PICC_WakeupA(atqa, &laenge);
    ++abfragen;
    if (status == MFRC522::STATUS_OK || status == MFRC522::STATUS_COLLISION) {
      auswahl = rfid.PICC_Select(&rfid.uid); // Sofort, vor allen Logs zur Anfrage.
      if (auswahl == MFRC522::STATUS_OK) break;
    }
    // Gar keine Antwort heisst: da liegt nichts. Nicht weiter probieren.
    if (status == MFRC522::STATUS_TIMEOUT) break;
    delay(8);
  }
  if (status == MFRC522::STATUS_TIMEOUT) {
    ++keineAntwort; // Keine Karte im Feld: normal, keine Pause.
    return;
  }
  // Nach einem Fehler nur kurz warten, nach einer gelesenen Karte laenger.
  scanPause = true;
  scanPauseDauer = (auswahl == MFRC522::STATUS_OK) ? SCAN_PAUSE_MS : FEHLER_PAUSE_MS;
  naechsterScanSeit = millis();
  ++scanNummer;
  if (DEBUG_LOG) {
    logKopf(F("SCAN"));
    Serial.println(scanNummer);
  }
  logStatus(F("REQA"), status, 0xFF);
  if (status != MFRC522::STATUS_OK && status != MFRC522::STATUS_COLLISION) {
    erkennungsfehler();
    return;
  }
  if (status == MFRC522::STATUS_OK && laenge == 2) logBytes(F("ATQA"), atqa, 2);
  status = auswahl;
  logStatus(F("SELECT UID"), status, 0xFF);
  if (status != MFRC522::STATUS_OK) {
    erkennungsfehler();
    return;
  }
  logBytes(F("UID"), rfid.uid.uidByte, rfid.uid.size);
  fehlerFolge = 0;
  funkHinweisGezeigt = false;

  // Liegt die Karte der laufenden Sitzung noch auf, nur die Sitzung frisch
  // halten. Sonst wuerde WUPA sie im Sekundentakt neu anmelden.
  if (spielAktiv && rfid.uid.size == spielUid.size
      && memcmp(rfid.uid.uidByte, spielUid.uidByte, rfid.uid.size) == 0) {
    sitzungSeit = millis();
  } else {
    bearbeiteKarte();
  }
  // Auf jedem Verarbeitungspfad aufraeumen, auch nach Fehlern.
  status = rfid.PICC_HaltA();
  logStatus(F("HALT"), status, 0xFF);
  rfid.PCD_StopCrypto1();
  logText(F("ENDE"), F("Karte kann weg. Gespielt wird ueber die Tasten."));
  naechsterScanSeit = millis();
  scanPauseDauer = SCAN_PAUSE_MS;
  ergebnisSeit = millis();
  ergebnisSichtbar = true;
}
