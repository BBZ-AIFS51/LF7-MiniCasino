#ifndef CASINO_ADMIN_SERIAL_H
#define CASINO_ADMIN_SERIAL_H
// Zeilenbasiertes Verwaltungsprotokoll auf derselben seriellen Schnittstelle.
//
// Antworten beginnen immer mit '#', die normalen Logzeilen mit '['. Ein Host
// filtert also einfach nach dem ersten Zeichen und kann den Diagnoselog
// unveraendert mitlaufen lassen.
//
// Befehle (Grossschreibung egal, mit Zeilenumbruch abschliessen):
//   PING                 Version, Plaetze, Belegung, Tonstufe
//   LIST                 je belegtem Platz eine #ROW-Zeile
//   SET <platz> <wert>   Guthaben setzen
//   STAKE <platz> <wert> Einsatz setzen, Vielfaches von 10
//   ADD <uidhex> <wert>  Unbekannte UID anlegen und gutschreiben
//   FLAG <platz> <0|1|2> 0 normal, 1 gesperrt, 2 unbegrenzt (Admin)
//   FREE <platz>         Platz freigeben; die UID gilt danach als unbekannt
//   SOUND <0|1|2>        0 laut, 1 leise, 2 aus
//   CARD <uidhex>        Auflegen einer Karte vortaeuschen
//   WIPE JA              Alles loeschen, UIDs und Guthaben
//
// Achtung: Wer hier schreiben darf, kann Guthaben frei vergeben. Das Protokoll
// hat bewusst keine Zugangskontrolle; wer am USB-Kabel haengt, ist Admin.
#include <string.h>
#include <ctype.h>

const byte ADMIN_MAX = 48;
char adminZeile[ADMIN_MAX];
byte adminLen = 0;

void adminFehler(const __FlashStringHelper *grund) {
  Serial.print(F("#ERR "));
  Serial.println(grund);
}

void adminUidAusgeben(const uint8_t *uid, uint8_t size) {
  for (uint8_t i = 0; i < size; ++i) {
    if (uid[i] < 0x10) Serial.print('0');
    Serial.print(uid[i], HEX);
  }
}

// Belegte Plaetze zaehlen; dient auch als Kurzstatus fuer PING.
int adminBelegt() {
  int belegt = 0;
  uint8_t uid[10]; uint8_t size = 0;
  for (int slot = 0; slot < uidListe.capacity(); ++slot)
    if (uidListe.entry(slot, uid, size)) ++belegt;
  return belegt;
}

void adminZeileAusgeben(int slot, const uint8_t *uid, uint8_t size) {
  Serial.print(F("#ROW "));
  Serial.print(slot);
  Serial.print(' ');
  adminUidAusgeben(uid, size);
  Serial.print(' ');
  Serial.print(uidListe.funded(slot) ? 1 : 0);
  Serial.print(' ');
  Serial.print((unsigned long)uidListe.balance(slot));
  Serial.print(' ');
  uint8_t einheiten = uidListe.stakeUnits(slot);
  Serial.print((unsigned long)(einheiten ? einheiten * Casino::STAKE_SCHRITT
                                         : Casino::STAKE));
  Serial.print(' ');
  Serial.println(uidListe.flag(slot));
}

// Hexpaare in Bytes wandeln. Liefert die Laenge oder 0 bei Unsinn.
uint8_t adminUidLesen(const char *text, uint8_t *uid) {
  uint8_t n = 0;
  while (text[0] && text[1]) {
    if (n >= 10) return 0;
    uint8_t hoch = 0, tief = 0;
    for (uint8_t i = 0; i < 2; ++i) {
      char c = text[i];
      uint8_t wert;
      if (c >= '0' && c <= '9') wert = (uint8_t)(c - '0');
      else if (c >= 'a' && c <= 'f') wert = (uint8_t)(c - 'a' + 10);
      else if (c >= 'A' && c <= 'F') wert = (uint8_t)(c - 'A' + 10);
      else return 0;
      if (i == 0) hoch = wert; else tief = wert;
    }
    uid[n++] = (uint8_t)((hoch << 4) | tief);
    text += 2;
  }
  if (text[0]) return 0; // Ungerade Anzahl Zeichen.
  return (n == 4 || n == 7 || n == 10) ? n : 0;
}

void adminBefehl(char *zeile) {
  char *cmd = strtok(zeile, " ");
  if (!cmd) return;
  for (char *p = cmd; *p; ++p) *p = (char)toupper(*p);

  if (!strcmp(cmd, "PING")) {
    Serial.print(F("#OK PING v10 slots="));
    Serial.print(uidListe.capacity());
    Serial.print(F(" used="));
    Serial.print(adminBelegt());
    Serial.print(F(" sound="));
    Serial.print(tonStufe);
    Serial.print(F(" session="));
    Serial.println(spielAktiv ? spielSlot : -1);
    return;
  }
  if (!strcmp(cmd, "LIST")) {
    uint8_t uid[10]; uint8_t size = 0;
    int n = 0;
    for (int slot = 0; slot < uidListe.capacity(); ++slot) {
      if (uidListe.entry(slot, uid, size)) { adminZeileAusgeben(slot, uid, size); ++n; }
    }
    Serial.print(F("#OK LIST "));
    Serial.println(n);
    return;
  }
  if (!strcmp(cmd, "SET")) {
    char *a1 = strtok(NULL, " "), *a2 = strtok(NULL, " ");
    if (!a1 || !a2) { adminFehler(F("SET <platz> <wert>")); return; }
    int slot = atoi(a1);
    uint32_t wert = (uint32_t)strtoul(a2, NULL, 10);
    if (!uidListe.confirmed(slot)) { adminFehler(F("Platz nicht belegt")); return; }
    if (!uidListe.setBalance(slot, wert)) { adminFehler(F("EEPROM-Buchung fehlgeschlagen")); return; }
    // Eine laufende Sitzung auf diesem Platz sofort nachziehen.
    if (spielAktiv && spielSlot == slot) { spielGuthaben = wert; spielMenue(); }
    Serial.print(F("#OK SET "));
    Serial.print(slot);
    Serial.print(' ');
    Serial.println((unsigned long)wert);
    return;
  }
  if (!strcmp(cmd, "STAKE")) {
    char *a1 = strtok(NULL, " "), *a2 = strtok(NULL, " ");
    if (!a1 || !a2) { adminFehler(F("STAKE <platz> <wert>")); return; }
    int slot = atoi(a1);
    uint32_t wert = (uint32_t)strtoul(a2, NULL, 10);
    if (wert < Casino::STAKE_SCHRITT || wert > Casino::STAKE_MAX
        || wert % Casino::STAKE_SCHRITT) {
      adminFehler(F("Vielfaches von 10, hoechstens 2550"));
      return;
    }
    if (!uidListe.funded(slot)) { adminFehler(F("Platz ohne Konto")); return; }
    if (!uidListe.setStakeUnits(slot, (uint8_t)(wert / Casino::STAKE_SCHRITT))) {
      adminFehler(F("EEPROM-Buchung fehlgeschlagen"));
      return;
    }
    if (spielAktiv && spielSlot == slot) { spielEinsatz = wert; spielMenue(); }
    Serial.print(F("#OK STAKE "));
    Serial.print(slot);
    Serial.print(' ');
    Serial.println((unsigned long)wert);
    return;
  }
  if (!strcmp(cmd, "FLAG")) {
    char *a1 = strtok(NULL, " "), *a2 = strtok(NULL, " ");
    if (!a1 || !a2) { adminFehler(F("FLAG <platz> <0|1|2>")); return; }
    int slot = atoi(a1);
    int art = atoi(a2);
    if (art < 0 || art > 2) { adminFehler(F("0 normal, 1 gesperrt, 2 unbegrenzt")); return; }
    if (!uidListe.confirmed(slot)) { adminFehler(F("Platz nicht belegt")); return; }
    if (!uidListe.setFlag(slot, (uint8_t)art)) { adminFehler(F("Nicht gesetzt")); return; }
    // Sperre wirkt sofort, auch mitten in einer laufenden Sitzung.
    if (spielAktiv && spielSlot == slot) {
      if (art == 1) beendeSitzung(true);
      else { spielUnbegrenzt = (art == 2); spielMenue(); }
    }
    Serial.print(F("#OK FLAG "));
    Serial.print(slot);
    Serial.print(' ');
    Serial.println(art);
    return;
  }
  if (!strcmp(cmd, "ADD")) {
    char *a1 = strtok(NULL, " "), *a2 = strtok(NULL, " ");
    if (!a1 || !a2) { adminFehler(F("ADD <uidhex> <wert>")); return; }
    uint8_t uid[10]; uint8_t size = adminUidLesen(a1, uid);
    if (!size) { adminFehler(F("UID braucht 8, 14 oder 20 Hexzeichen")); return; }
    int slot = uidListe.reserve(uid, size);
    if (slot < 0) { adminFehler(slot == -3 ? F("Liste voll") : F("Liste gesperrt")); return; }
    uint32_t wert = (uint32_t)strtoul(a2, NULL, 10);
    if (!uidListe.confirm(slot) || !uidListe.setBalance(slot, wert)) {
      adminFehler(F("Eintrag angelegt, Gutschrift fehlgeschlagen"));
      return;
    }
    Serial.print(F("#OK ADD "));
    Serial.print(slot);
    Serial.print(' ');
    Serial.println((unsigned long)wert);
    return;
  }
  if (!strcmp(cmd, "FREE")) {
    char *a1 = strtok(NULL, " ");
    if (!a1) { adminFehler(F("FREE <platz>")); return; }
    int slot = atoi(a1);
    if (spielAktiv && spielSlot == slot) beendeSitzung(true);
    if (!uidListe.clearSlot(slot)) { adminFehler(F("Platz nicht freigegeben")); return; }
    Serial.print(F("#OK FREE "));
    Serial.println(slot);
    return;
  }
  if (!strcmp(cmd, "SOUND")) {
    char *a1 = strtok(NULL, " ");
    if (!a1) { adminFehler(F("SOUND <0|1|2>")); return; }
    int stufe = atoi(a1);
    if (stufe < 0 || stufe > 2) { adminFehler(F("0 laut, 1 leise, 2 aus")); return; }
    tonStufe = (byte)stufe;
    uint8_t opt = (uint8_t)(uidListe.options() & ~3);
    if (tonStufe == TON_AUS) opt |= 1;
    else if (tonStufe == TON_LEISE) opt |= 2;
    uidListe.setOptions(opt);
    Serial.print(F("#OK SOUND "));
    Serial.println(tonStufe);
    return;
  }
  if (!strcmp(cmd, "CARD")) {
    // Genau derselbe Weg wie nach einem echten Scan. Gedacht fuer die
    // Simulation ohne RC522 und zum Testen ohne Karte in der Hand.
    char *a1 = strtok(NULL, " ");
    uint8_t uid[10];
    uint8_t size = adminUidLesen(a1 ? a1 : "", uid);
    if (!size) { adminFehler(F("CARD <uidhex>, 8/14/20 Hexzeichen")); return; }
    legeKarteAuf(uid, size);
    Serial.println(F("#OK CARD"));
    return;
  }
  if (!strcmp(cmd, "WIPE")) {
    char *a1 = strtok(NULL, " ");
    if (!a1 || strcmp(a1, "JA")) { adminFehler(F("WIPE JA zum Bestaetigen")); return; }
    if (spielAktiv) beendeSitzung(true);
    uidListe.wipe();
    bool ok = uidListe.begin();
    tonStufe = TON_LAUT;
    Serial.println(ok ? F("#OK WIPE") : F("#ERR WIPE fehlgeschlagen"));
    return;
  }
  adminFehler(F("Unbekannt: PING LIST SET STAKE FLAG ADD FREE CARD SOUND WIPE"));
}

// Nichtblockierend aus loop() aufrufen. Zeilen laenger als ADMIN_MAX werden
// abgeschnitten und dann als unbekannter Befehl abgewiesen.
void adminService() {
  while (Serial.available()) {
    char c = (char)Serial.read();
    if (c == '\r') continue;
    if (c == '\n') {
      adminZeile[adminLen] = 0;
      if (adminLen) adminBefehl(adminZeile);
      adminLen = 0;
      continue;
    }
    if (adminLen < ADMIN_MAX - 1) adminZeile[adminLen++] = c;
  }
}
#endif
