/*
 * Mini Casino - Startguthaben auf RFID, Ausgabe auf QAPASS 1602A
 *
 * Hardware: Arduino Uno (ATmega328P), RC522, 16x2-LCD ohne I2C-Adapter.
 * Bestaetigte LCD-Belegung: RS->D8, E->D7, D4->D6, D5->D5, D6->D4, D7->D3.
 * LCD: VSS/RW->GND, VDD->5V, VO->10-kOhm-Poti, A->200 Ohm->5V, K->GND.
 * RC522: SS/SDA->D10, RST->D9, MOSI->D11, MISO->D12, SCK->D13, VCC->3.3V.
 * Vollstaendige Stromversorgung/Pegelwandlung: siehe ../ANLEITUNG.md.
 *
 * Ablauf:
 * 1. Karte erkennen, Typ pruefen und bei Classic mit Key A anmelden.
 * 2. Vorhandenes gueltiges Casino-Guthaben nur anzeigen (auch 0 Punkte).
 * 3. Nur einen leeren Projektbereich mit einmalig 100 Punkten initialisieren.
 * 4. Geschriebene Daten zur Bestaetigung erneut lesen und vergleichen.
 * 5. Ergebnis/Fehler auf dem LCD anzeigen; fuer erneutes Lesen Karte entfernen.
 *
 * Speicher: Classic Block 4 (Sektor 1), Ultralight Seiten 4-7.
 * Fremde/ungueltige Daten werden nicht geloescht. Diagnose optional ueber Serial.
 * Guthaben sind ganze Spielpunkte, kein manipulationsgeschuetztes Bezahlsystem.
 * Bibliotheken: SPI (Arduino Core), MFRC522 und LiquidCrystal (Arduino).
 */

#include <Arduino.h>
#include <SPI.h>
#include <MFRC522.h>
#include <LiquidCrystal.h>
#include <string.h>
#include "EmptyRegion.h"

// LCD: RS, E, D4, D5, D6, D7 (jeweils Arduino-Pins).
LiquidCrystal lcd(8, 7, 6, 5, 4, 3);
MFRC522 rfid(10, 9);
MFRC522::MIFARE_Key key;

const uint32_t STARTGUTHABEN = 100;  // Ganze Spielpunkte.
const bool DEBUG_LOG = true;       // Nach der Fehlersuche auf false setzen.
const bool LEERE_NDEF_TAGS_NUTZEN = true; // Leere NFC-Tools-Strukturen uebernehmen.
const unsigned long LOG_BAUD = 9600UL;
const unsigned long ANZEIGEDAUER_MS = 5000UL;
const unsigned long SCAN_PAUSE_MS = 1000UL;
const byte SPEICHER = 4;            // Classic: Block 4; Ultralight: Seiten 4-7.
const byte TRAILER = 7;             // Nur zur Classic-Anmeldung, nie beschreiben!
const byte MAGIC[4] = {'M', 'C', 'A', 'S'};
// Diese Zustandswerte liegen im Arduino-RAM; das Guthaben liegt auf der Karte.
bool readerBereit = false;
bool ergebnisSichtbar = false;
unsigned long ergebnisSeit = 0;
unsigned long letzterLog = 0;
unsigned long letzteAbfrage = 0;
unsigned long naechsterScanSeit = 0;
bool scanPause = false;
unsigned long scanNummer = 0;
unsigned long abfragen = 0;
unsigned long keineAntwort = 0;

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

// Nach einer fehlgeschlagenen Classic-Anmeldung dieselbe Karte neu auswaehlen.
// Niemals mit einer versehentlich ausgetauschten Karte weiterarbeiten.
bool waehleDieselbeKarte(const MFRC522::Uid &erwartet) {
  rfid.PCD_StopCrypto1();
  rfid.PICC_HaltA();
  byte atqa[2];
  byte laenge = sizeof(atqa);
  MFRC522::StatusCode status = rfid.PICC_WakeupA(atqa, &laenge);
  logStatus(F("AUTH WAKE"), status, 0xFF);
  if (status != MFRC522::STATUS_OK && status != MFRC522::STATUS_COLLISION) return false;
  status = rfid.PICC_Select(&rfid.uid);
  logStatus(F("AUTH RESELECT"), status, 0xFF);
  if (status != MFRC522::STATUS_OK) return false;
  if (rfid.uid.size != erwartet.size || rfid.uid.sak != erwartet.sak ||
      memcmp(rfid.uid.uidByte, erwartet.uidByte, erwartet.size) != 0) {
    logText(F("AUTH"), F("Karte gewechselt: Abbruch ohne Schreiben."));
    return false;
  }
  return true;
}

// Zwei bekannte Standardkonfigurationen, keine Schluesselsuche oder Aenderung.
bool meldeClassicAn() {
  const MFRC522::Uid erwartet = rfid.uid;
  for (byte versuch = 0; versuch < 2; ++versuch) {
    if (versuch && !waehleDieselbeKarte(erwartet)) return false;
    for (byte i = 0; i < MFRC522::MF_KEY_SIZE; ++i) {
      key.keyByte[i] = versuch == 0 ? 0xFF : (i % 2 == 0 ? 0xD3 : 0xF7);
    }
    logText(F("AUTH"), versuch == 0
      ? F("Classic Sektor 1, Key A, Werksschluessel FF x6.")
      : F("Classic Sektor 1, Key A, oeffentlicher NDEF-Key D3 F7 D3 F7 D3 F7."));
    MFRC522::StatusCode status = rfid.PCD_Authenticate(
      MFRC522::PICC_CMD_MF_AUTH_KEY_A, TRAILER, &key, &rfid.uid);
    logStatus(F("AUTH"), status, TRAILER);
    if (status == MFRC522::STATUS_OK) {
      logText(F("AUTH"), F("Anmeldung erfolgreich; Schreibrechte noch nicht bestaetigt."));
      return true;
    }
  }
  return false;
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
  Serial.print(F(" Firmware=0x"));
  logHex(rfid.PCD_ReadRegister(MFRC522::VersionReg));
  Serial.println();
}

// Zwei kurze Zeilen aus dem Flash ausgeben. Texte passen in 16 Zeichen.
void meldung(const __FlashStringHelper *oben,
             const __FlashStringHelper *unten) {
  lcd.clear();
  lcd.print(oben);
  lcd.setCursor(0, 1);
  lcd.print(unten);
  if (DEBUG_LOG) {
    logKopf(F("LCD"));
    Serial.print(oben);
    Serial.print(F(" / "));
    Serial.println(unten);
  }
}

// Bereitschaft anzeigen, ohne die Karte oder ihr Guthaben zu veraendern.
void startAnzeige() {
  meldung(F("Mini Casino"), F("Karte auflegen"));
  ergebnisSichtbar = false;
}

// CRC-16/CCITT-FALSE: Start 0xFFFF, Polynom 0x1021, ueber Bytes 0-13.
// Erkennt versehentlich beschaedigte Daten; keine Verschluesselung.
uint16_t pruefsumme(const byte *daten) {
  uint16_t crc = 0xFFFF;
  for (byte i = 0; i < 14; ++i) {
    crc ^= (uint16_t)daten[i] << 8;
    for (byte bit = 0; bit < 8; ++bit) {
      crc = (crc & 0x8000) ? (uint16_t)((crc << 1) ^ 0x1021)
                           : (uint16_t)(crc << 1);
    }
  }
  return crc;
}

// Nur 16 Nullbytes gelten als leer; unbekannte Muster werden nicht freigegeben.
bool istLeer(const byte *daten) {
  for (byte i = 0; i < 16; ++i) {
    if (daten[i] != 0) return false;
  }
  return true;
}

// Baut den Datensatz im RAM. Diese Funktion schreibt noch nichts auf die Karte.
// Bytes 0-3: MCAS; 4: Version; 5-8: Punkte; 9-13: 0; 14-15: CRC.
// Mehrbyte-Werte werden mit dem niedrigsten Byte zuerst gespeichert.
void erstelleGuthaben(byte *daten, uint32_t guthaben) {
  memset(daten, 0, 16);
  memcpy(daten, MAGIC, 4);
  daten[4] = 1; // Formatversion.
  for (byte i = 0; i < 4; ++i) daten[5 + i] = (byte)(guthaben >> (8 * i));
  uint16_t crc = pruefsumme(daten);
  daten[14] = (byte)crc;
  daten[15] = (byte)(crc >> 8);
}

// Nur bei gueltigem Format/CRC wird der Ausgabeparameter guthaben gesetzt.
bool leseGuthaben(const byte *daten, uint32_t &guthaben) {
  if (memcmp(daten, MAGIC, 4) != 0) {
    logText(F("FORMAT"), F("Keine MCAS-Kennung; pruefe Leerheit."));
    return false;
  }
  if (daten[4] != 1) {
    logText(F("FORMAT"), F("Unbekannte Datensatzversion."));
    return false;
  }
  for (byte i = 9; i < 14; ++i) {
    if (daten[i] != 0) {
      logText(F("FORMAT"), F("Reservierte Bytes sind nicht Null."));
      return false;
    }
  }
  uint16_t gespeichert = (uint16_t)daten[14] | ((uint16_t)daten[15] << 8);
  if (gespeichert != pruefsumme(daten)) {
    logText(F("FORMAT"), F("CRC stimmt nicht; keine automatische Reparatur."));
    return false;
  }
  guthaben = 0;
  for (byte i = 0; i < 4; ++i) guthaben |= (uint32_t)daten[5 + i] << (8 * i);
  return true;
}

// MIFARE_Read liefert 16 Nutzbytes und zwei CRC-Bytes.
// Classic: ein Block; Ultralight: vier aufeinanderfolgende Seiten.
bool leseSpeicher(byte adresse, byte *daten) {
  byte puffer[18];
  byte groesse = sizeof(puffer);
  MFRC522::StatusCode status = rfid.MIFARE_Read(adresse, puffer, &groesse);
  logStatus(F("READ"), status, adresse);
  if (status != MFRC522::STATUS_OK) return false;
  if (groesse != 18) {
    if (DEBUG_LOG) {
      logKopf(F("READ"));
      Serial.print(F("Falsche Antwortlaenge: "));
      Serial.println(groesse);
    }
    return false;
  }
  memcpy(daten, puffer, 16);
  logBytes(F("DATA 16 Bytes"), daten, 16);
  return true;
}

// Nur nach erfolgreicher Leerheitspruefung aus bearbeiteKarte() aufrufen.
// Rueckgabe true bestaetigt die Schreibbefehle; danach folgt noch das Ruecklesen.
bool schreibeStartguthaben(bool classic, byte *daten) {
  logBytes(F("WRITE Soll-Daten"), daten, 16);
  if (classic) {
    MFRC522::StatusCode status = rfid.MIFARE_Write(SPEICHER, daten, 16);
    logStatus(F("WRITE Classic Block"), status, SPEICHER);
    return status == MFRC522::STATUS_OK;
  }
  // Ultralight schreibt vier Bytes pro Seite. Kennung auf Seite 4 zuletzt.
  // Sobald Nutzdaten gespeichert sind, gilt ein unvollstaendiger Satz nicht als leer.
  for (byte seite = 1; seite < 4; ++seite) {
    MFRC522::StatusCode status = rfid.MIFARE_Ultralight_Write(
      SPEICHER + seite, daten + 4 * seite, 4);
    logStatus(F("WRITE UL Seite"), status, SPEICHER + seite);
    if (status != MFRC522::STATUS_OK) return false;
  }
  MFRC522::StatusCode status = rfid.MIFARE_Ultralight_Write(SPEICHER, daten, 4);
  logStatus(F("WRITE UL Kennung"), status, SPEICHER);
  return status == MFRC522::STATUS_OK;
}

// Bis zu zehn Ziffern plus " Pkt" passen auch beim groessten uint32_t auf das LCD.
void zeigeGuthaben(uint32_t guthaben, bool neu) {
  lcd.clear();
  lcd.print(neu ? F("Neu aufgeladen!") : F("Guthaben:"));
  lcd.setCursor(0, 1);
  lcd.print((unsigned long)guthaben);
  lcd.print(F(" Pkt"));
  if (DEBUG_LOG) {
    logKopf(F("GUTHABEN"));
    Serial.print(neu ? F("Neu gespeichert und geprueft: ") : F("Vorhanden: "));
    Serial.println((unsigned long)guthaben);
  }
}

// Verarbeitet genau die durch PICC_Select ausgewaehlte Karte.
// Jeder Fehler beendet die Verarbeitung vor weiteren Schreibversuchen.
// Halt/StopCrypto erfolgen anschliessend zentral in loop().
void bearbeiteKarte() {
  MFRC522::PICC_Type typ = rfid.PICC_GetType(rfid.uid.sak);
  if (DEBUG_LOG) {
    logKopf(F("TYPE"));
    Serial.print(rfid.PICC_GetTypeName(typ));
    Serial.print(F(" SAK=0x"));
    logHex(rfid.uid.sak);
    Serial.println();
  }
  bool classic = typ == MFRC522::PICC_TYPE_MIFARE_MINI
              || typ == MFRC522::PICC_TYPE_MIFARE_1K
              || typ == MFRC522::PICC_TYPE_MIFARE_4K;
  if (!classic && typ != MFRC522::PICC_TYPE_MIFARE_UL) {
    meldung(F("Kartentyp passt"), F("leider nicht"));
    return;
  }

  if (classic) {
    if (!meldeClassicAn()) {
      logText(F("AUTH"), F("Anderer Schluessel ODER Funk/Versorgung; nichts geschrieben."));
      meldung(F("Anmeldung fehlg."), DEBUG_LOG ? F("Siehe Log") : F("Neu auflegen"));
      return;
    }
  } else {
    logText(F("AUTH"), F("Ultralight: keine Classic-Anmeldung. Lese Seiten 4-7."));
  }

  byte daten[16];
  if (!leseSpeicher(SPEICHER, daten)) {
    meldung(F("Lesefehler"), F("Neu auflegen"));
    return;
  }

  uint32_t guthaben = 0;
  if (leseGuthaben(daten, guthaben)) {
    // Auch ein Guthaben von 0 ist gueltig und wird NICHT neu aufgeladen.
    zeigeGuthaben(guthaben, false);
    return;
  }

  Casino::Region bereich = Casino::classify(daten);
  bool leerNdef = !classic && LEERE_NDEF_TAGS_NUTZEN && bereich == Casino::Region::EmptyNdef;
  if (bereich != Casino::Region::Zero && !leerNdef) {
    logText(F("BELEGT"), F("Keine freigegebene Leerstruktur. Nutzdaten bleiben unveraendert."));
    if (memcmp(daten, MAGIC, 4) == 0) {
      meldung(F("Daten ungueltig"), F("Nicht geaendert"));
    } else {
      meldung(F("Speicher belegt"), F("Nicht geaendert"));
    }
    return;
  }

  if (leerNdef) {
    logText(F("NDEF"), F("Leere NDEF-Struktur erkannt, keine aktive Nutzlast."));
    byte cc[16];
    if (!leseSpeicher(3, cc)) {
      meldung(F("NDEF Lesefehler"), F("Neu auflegen"));
      return;
    }
    if (!Casino::writableType2(cc)) {
      logText(F("NDEF"), F("CC fehlt, unbekannt oder nicht frei schreibbar; kein Schreiben."));
      meldung(F("NDEF nicht frei"), DEBUG_LOG ? F("Siehe Log") : F("Nicht geaendert"));
      return;
    }
    logText(F("NDEF"), F("Uebernehme Seiten 4-7 inkl. Restbytes hinter FE fuer Casino."));
  }

  // Bei Classic vor der Erstbelegung auch die anderen Datenbloecke
  // desselben Sektors pruefen. Block 7 enthaelt Schluessel/Zugriffsrechte.
  if (classic) {
    byte andereDaten[16];
    for (byte block = 5; block <= 6; ++block) {
      if (!leseSpeicher(block, andereDaten)) {
        meldung(F("Lesefehler"), F("Neu auflegen"));
        return;
      }
      if (!istLeer(andereDaten)) {
        logText(F("BELEGT"), F("Classic-Nachbarblock belegt; siehe letzte READ-Adresse."));
        meldung(F("Sektor belegt"), F("Nicht geaendert"));
        return;
      }
    }
  }

  // Gerade bei den beobachteten Funkfehlern vor dem Schreiben erneut bestaetigen.
  byte nochmal[16];
  if (!leseSpeicher(SPEICHER, nochmal) || memcmp(daten, nochmal, 16) != 0) {
    logText(F("PRECHECK"), F("Speicher nicht stabil lesbar; nichts geschrieben."));
    meldung(F("Lesen instabil"), F("Neu auflegen"));
    return;
  }
  logText(F("LEER"), F("Leerer Projektbereich bestaetigt; initialisiere Startguthaben."));
  meldung(F("Speichere..."), F("Karte liegenlass"));
  erstelleGuthaben(daten, STARTGUTHABEN);
  if (!schreibeStartguthaben(classic, daten)) {
    meldung(F("Schreibfehler"), F("Neu auflegen"));
    return;
  }

  byte kontrolle[16];
  if (!leseSpeicher(SPEICHER, kontrolle) || memcmp(daten, kontrolle, 16) != 0) {
    logText(F("VERIFY"), F("Ruecklesen fehlgeschlagen oder Daten abweichend."));
    meldung(F("Pruefung fehlg."), F("Neu auflegen"));
    return;
  }
  zeigeGuthaben(STARTGUTHABEN, true);
}

// Einmal nach Einschalten/Reset: LCD und Reader starten, Standardschluessel setzen.
void setup() {
  if (DEBUG_LOG) {
    Serial.begin(LOG_BAUD);
    Serial.println();
    logText(F("BOOT"), F("Mini Casino Diagnose v2 | 9600 Baud | LCD 8,7,6,5,4,3"));
    logText(F("BOOT"), F("Wiederholtes BOOT im laufenden Betrieb: Reset/Versorgung pruefen."));
  }
  lcd.begin(16, 2);
  meldung(F("Mini Casino"), F("Starte Reader..."));
  SPI.begin();
  rfid.PCD_Init();
  delay(50);
  for (byte i = 0; i < MFRC522::MF_KEY_SIZE; ++i) key.keyByte[i] = 0xFF;

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
  readerBereit = true; // Auch euer Clone mit Version 0x88 wird akzeptiert.
  startAnzeige();
}

// Wiederholt Karten abfragen. millis()-Differenz funktioniert auch beim Ueberlauf.
// Eine Sekunde Scan-Abstand verhindert schnelle Fehler-/LCD-Wiederholungen.
void loop() {
  logLebenszeichen();
  if (!readerBereit) return;
  if (ergebnisSichtbar && millis() - ergebnisSeit >= ANZEIGEDAUER_MS) startAnzeige();
  if (scanPause && millis() - naechsterScanSeit < SCAN_PAUSE_MS) return;
  scanPause = false;
  if (millis() - letzteAbfrage < 100UL) return;
  letzteAbfrage = millis();

  // Gleiche Registervorbereitung wie PICC_IsNewCardPresent in MFRC522.
  // Direkte Aufrufe liefern den Fehlercode, den die bool-Wrapper verbergen.
  rfid.PCD_WriteRegister(MFRC522::TxModeReg, 0x00);
  rfid.PCD_WriteRegister(MFRC522::RxModeReg, 0x00);
  rfid.PCD_WriteRegister(MFRC522::ModWidthReg, 0x26);
  byte atqa[2];
  byte laenge = sizeof(atqa);
  MFRC522::StatusCode status = rfid.PICC_RequestA(atqa, &laenge);
  ++abfragen;
  if (status == MFRC522::STATUS_TIMEOUT) {
    ++keineAntwort; // Keine neue Karte oder bereits angehaltene Karte: normal.
    return;
  }
  scanPause = true;
  naechsterScanSeit = millis();
  ++scanNummer;
  if (DEBUG_LOG) {
    logKopf(F("SCAN"));
    Serial.println(scanNummer);
  }
  logStatus(F("REQA"), status, 0xFF);
  if (status != MFRC522::STATUS_OK && status != MFRC522::STATUS_COLLISION) {
    meldung(F("RFID Funkfehler"), F("Neu auflegen"));
    rfid.PCD_StopCrypto1();
    ergebnisSeit = millis();
    ergebnisSichtbar = true;
    return;
  }
  if (status == MFRC522::STATUS_OK && laenge == 2) logBytes(F("ATQA"), atqa, 2);
  status = rfid.PICC_Select(&rfid.uid);
  logStatus(F("SELECT UID"), status, 0xFF);
  if (status != MFRC522::STATUS_OK) {
    meldung(F("UID Lesefehler"), F("Neu auflegen"));
    rfid.PCD_StopCrypto1();
    ergebnisSeit = millis();
    ergebnisSichtbar = true;
    return;
  }
  logBytes(F("UID"), rfid.uid.uidByte, rfid.uid.size);

  bearbeiteKarte();
  // Auf jedem Verarbeitungspfad aufraeumen, auch nach Fehlern.
  status = rfid.PICC_HaltA();
  logStatus(F("HALT"), status, 0xFF);
  rfid.PCD_StopCrypto1();
  logText(F("ENDE"), F("Karte zum erneuten Lesen entfernen und wieder auflegen."));
  naechsterScanSeit = millis();
  ergebnisSeit = millis();
  ergebnisSichtbar = true;
}
