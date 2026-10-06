/*
 * Mini Casino - Konten im EEPROM, Karte als Ausweis, Ausgabe auf 1,3"-OLED
 *
 * Hardware: Arduino Uno (ATmega328P), RC522, 128x64-OLED mit I2C (4 Pins).
 * OLED: GND->GND, VCC->5V, SCL->A5, SDA->A4. Mehr Leitungen gibt es nicht.
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
 * Keine LEDs mehr: das Lauflicht laeuft auf dem OLED.
 * Tasten: 4x4-Folientastatur an D3-D8, A0, A1. 1/2/3 setzen auf Schwarz/Rot/Gruen,
 * A Einsatz eintippen, B abmelden, C Ton, D Hilfe. Details: GameRuntime.h.
 * Spielplan/Taster: ../SPIELPLAN_V8.md; Ton D2: ../SOUND_V9.md. Kein FORCE.
 * Guthaben sind ganze Spielpunkte, kein manipulationsgeschuetztes Bezahlsystem.
 * Bibliotheken: nur EEPROM aus dem Arduino Core. Display-Treiber und
 * Schrift (CC0) liegen in OledText.h, es muss nichts installiert werden.
 * Der RC522 laeuft ueber einen eigenen kleinen Treiber (Rc522.h) statt der
 * MFRC522-Bibliothek; er liest nur die UID.
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

// Waehrung auf dem Display. 1 = Euro-Zeichen, 0 = "Pkt".
// Die Schrift kennt kein Euro-Zeichen; es ist in OledText.h selbst gezeichnet
// und liegt auf Code 0. Am Spiel aendert das nichts, es sind weiterhin
// reine Spielpunkte ohne jeden Gegenwert.
#ifndef CASINO_EURO
#define CASINO_EURO 1
#endif

// Display-Chip. Fast alle 1,3-Zoll-OLEDs haben einen SH1106 (0), die
// 0,96-Zoll-Module meist einen SSD1306 (1). Ist das Bild um zwei Pixel
// verschoben oder steht am Rand Pixelmuell, auf die andere Einstellung gehen.
#ifndef CASINO_OLED_SSD1306
#define CASINO_OLED_SSD1306 0
#endif

// Simulationsbetrieb ohne RC522 (z.B. Wokwi). 1 = statt des Readers stehen
// vier Taster an D9 bis D12 fuer vier Karten. Sonst ist alles identisch:
// gleiche Pins, gleiches Spiel, gleicher EEPROM, gleiche Verwaltung.
#ifndef CASINO_SIM
#define CASINO_SIM 0
#endif

#include <Arduino.h>
#include "Rc522.h"
#include <EEPROM.h>
#include <string.h>
#include "OledText.h"
#include "UidRegistry.h"
#include "GameRules.h"
// EmptyRegion.h und CardRecord.h gehoeren nicht mehr zum Sketch: Guthaben
// liegen im EEPROM, der Kartenspeicher wird nicht mehr angefasst. Die Dateien
// und ihre Tests bleiben als Beleg fuer das alte Kartenformat liegen.

void spielMenue();

// OLED am Hardware-I2C des Uno: SDA = A4, SCL = A5. Kein Reset-Pin.
// Wokwi kennt nur den SSD1306, deshalb gilt der in der Simulation immer.
OledText anzeige;
Rc522 rfid;   // SS D10, RST D9, SPI D11-D13.
Casino::UidRegistry<EEPROMClass> uidListe(EEPROM);

const uint32_t STARTGUTHABEN = 100;  // Ganze Spielpunkte.
// Diagnose-Log auf der seriellen Schnittstelle. Mit false werden die Texte gar
// nicht erst mitkompiliert (rund 3 KB). Euer Uno hat einen 4-KB-Bootloader und
// damit nur 28 KB fuer den Sketch; mit true sind es rund 21 KB, das passt auch.
const bool DEBUG_LOG = false;
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

// Status: 0 OK, 1 Timeout, 2 Fehler, 3 Kollision (siehe Rc522.h).
void logStatus(const __FlashStringHelper *schritt, byte status) {
  if (!DEBUG_LOG) return;
  logKopf(schritt);
  Serial.print(F("Status="));
  Serial.println(status);
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
  logHex(rfid.version());
  Serial.println();
}

// Zwei kurze Zeilen aus dem Flash ausgeben. Texte passen in 16 Zeichen.
void meldung(const __FlashStringHelper *oben,
             const __FlashStringHelper *unten) {
  anzeige.setCursor(0, 0);
  anzeige.print(oben);
  for (byte i = strlen_P((PGM_P)oben); i < 16; ++i) anzeige.print(' ');
  anzeige.setCursor(0, 1);
  anzeige.print(unten);
  for (byte i = strlen_P((PGM_P)unten); i < 16; ++i) anzeige.print(' ');
  anzeige.hinweis(nullptr);   // Jeder Bildschirm setzt seinen Hinweis selbst.
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
  if (fehlerFolge % 3 == 0) {
    logText(F("RF RECOVERY"), F("Drei weitere Erkennungsfehler; Antennenfeld kurz neu starten."));
    rfid.antenne(false);
    delay(20);
    rfid.antenne(true);
    delay(20);
  }
  if (fehlerFolge >= 3 && !funkHinweisGezeigt && !ergebnisSichtbar) {
    meldung(F("Karte ruhig"), F("auflegen"));
    funkHinweisGezeigt = true;
    ergebnisSeit = millis();
    ergebnisSichtbar = true;
  }
}
// Waehrung anhaengen und die belegten Stellen zurueckgeben.
byte lcdWaehrung() {
#if CASINO_EURO
  anzeige.write((uint8_t)0);   // Direkt an die Zahl, ohne Leerzeichen: 250<euro>
  return 1;
#else
  anzeige.print(F(" Pkt"));
  return 4;
#endif
}

// Bis zu zehn Ziffern plus Waehrung passen auch beim groessten uint32_t aufs LCD.
void zeigeGuthaben(uint32_t guthaben, bool neu) {
  meldung(neu ? F("Neu aufgeladen!") : F("Guthaben:"), F(""));
  anzeige.setCursor(0, 1);
  anzeige.print((unsigned long)guthaben);
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

// Verarbeitet genau die durch rfid.auswaehlen() ausgewaehlte Karte.
// Ab Format 07 liegt das Guthaben im EEPROM des Uno. Der Kartenspeicher wird
// weder gelesen noch beschrieben: es gibt keine Classic-Anmeldung, keine
// Leerheits-/NDEF-Pruefung und keinen Schreibvorgang mehr. Die Karte dient nur
// noch als Ausweis fuer ihre UID, deshalb reicht kurzes Auflegen.
// Das Anhalten der Karte erfolgt anschliessend zentral in loop().
void bearbeiteKarte() {
  const Rc522::Uid erwartet = rfid.uid;
  if (DEBUG_LOG) {
    logKopf(F("TYPE"));
    Serial.print(F("SAK=0x"));
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
    logText(F("BOOT"), F("Mini Casino v11 | 115200 Baud | OLED I2C A4/A5"));
    logText(F("MODUS"), F("Konten im EEPROM. Karte nur als Ausweis, Spiel ueber Tasten."));
    logText(F("BOOT"), F("Wiederholtes BOOT im laufenden Betrieb: Reset/Versorgung pruefen."));
  }
  spielSetup();
  anzeige.begin();
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
    Serial.println(F(" | Taste C schaltet weiter: laut, leise, aus."));
  }
#if CASINO_SIM
  simSetup();
  readerBereit = true;
  logText(F("SIM"), F("Ohne RC522. Taster D9-D12 stehen fuer vier Karten."));
  meldung(F("Mini Casino v11"), F("Karte auflegen"));
  startAnzeige();
  return;
#endif
  meldung(F("Mini Casino"), F("Starte Reader..."));
  rfid.begin();   // Mit voller Empfangsverstaerkung fuer die Clone-Antennen.
  byte version = rfid.version();
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
  readerBereit = true; // Auch euer Clone mit Version 0x88 wird akzeptiert.
  startAnzeige();
}

// Wiederholt Karten abfragen. millis()-Differenz funktioniert auch beim Ueberlauf.
// Eine Sekunde Scan-Abstand verhindert schnelle Fehler-/LCD-Wiederholungen.
void loop() {
  anzeige.hinweisAktualisieren();
  adminService(); // Verwaltungsbefehle haben nie Vorrang vor dem Spiel.
  unsigned long jetzt = millis();
  // Jede Taste hat eine feste Funktion (GameRuntime.h). Im Durchlauf mit
  // einem Tastendruck wird nicht nach Karten gesucht. Bewusst unabhaengig vom
  // Reader: ohne RC522 (Simulation, defektes Modul) bleiben Tasten, LCD und
  // das Verwaltungsprotokoll trotzdem bedienbar.
  if (tastenService(jetzt)) return;
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
  byte status = Rc522::TIMEOUT;
  byte auswahl = Rc522::FEHLER;
  for (byte versuch = 0; versuch < SCAN_VERSUCHE; ++versuch) {
    status = rfid.wecken();
    ++abfragen;
    if (status == Rc522::OK || status == Rc522::KOLLISION) {
      auswahl = rfid.auswaehlen(); // Sofort, vor allen Logs zur Anfrage.
      if (auswahl == Rc522::OK) break;
    }
    // Gar keine Antwort heisst: da liegt nichts. Nicht weiter probieren.
    if (status == Rc522::TIMEOUT) break;
    delay(8);
  }
  if (status == Rc522::TIMEOUT) {
    ++keineAntwort; // Keine Karte im Feld: normal, keine Pause.
    return;
  }
  // Nach einem Fehler nur kurz warten, nach einer gelesenen Karte laenger.
  scanPause = true;
  scanPauseDauer = (auswahl == Rc522::OK) ? SCAN_PAUSE_MS : FEHLER_PAUSE_MS;
  naechsterScanSeit = millis();
  ++scanNummer;
  if (DEBUG_LOG) {
    logKopf(F("SCAN"));
    Serial.println(scanNummer);
  }
  logStatus(F("WUPA"), status);
  if (status != Rc522::OK && status != Rc522::KOLLISION) {
    erkennungsfehler();
    return;
  }
  logStatus(F("SELECT UID"), auswahl);
  if (auswahl != Rc522::OK) {
    erkennungsfehler();
    return;
  }
  logBytes(F("UID"), rfid.uid.uidByte, rfid.uid.size);
  fehlerFolge = 0;
  funkHinweisGezeigt = false;

  // Liegt die Karte der laufenden Sitzung noch auf, nur die Sitzung frisch
  // halten. Sonst wuerde WUPA sie im Sekundentakt neu anmelden.
  bool neueKarte = !(spielAktiv && rfid.uid.size == spielUid.size
      && memcmp(rfid.uid.uidByte, spielUid.uidByte, rfid.uid.size) == 0);
  if (neueKarte) bearbeiteKarte();
  else sitzungSeit = millis();
  // Auf jedem Verarbeitungspfad aufraeumen, auch nach Fehlern.
  rfid.anhalten();
  logText(F("ENDE"), F("Karte kann weg. Gespielt wird ueber die Tasten."));
  naechsterScanSeit = millis();
  scanPauseDauer = SCAN_PAUSE_MS;
  // Nur eine neu verarbeitete Karte zeigt ein Ergebnis an. Die liegen gebliebene
  // Karte der Sitzung darf Einsatz-Eingabe oder Hilfe nicht unterbrechen.
  if (neueKarte) {
    ergebnisSeit = millis();
    ergebnisSichtbar = true;
  }
}
